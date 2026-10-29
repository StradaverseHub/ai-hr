import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {seedPayComponentCatalog} from '../core/pay-components';
import {createBatch} from '../core/payroll';
import {validateIndividualImport,confirmIndividualImport,revertIndividualImport,readIndividualImport,listIndividualImports} from '../core/individual-txn-import';
import {INDIVIDUAL_IMPORT_HEADERS,type IndividualImportMethod} from '../lib/payroll-txn-import-schema';
import {toCsv} from '../lib/csv';

describe('durable Individual Transaction import',()=>{
 let base:Base,employeeId:string,employeeCode:string,componentId:string,cycleId:string;
 beforeAll(migrateTestDb);
 beforeEach(async()=>{
  await resetDb();base=await seedBase();const a=adminCtx(base);
  const e=await hireEmployee(a,{person:{fullName:'Import Example',primaryEmail:`import-${randomUUID()}@example.invalid`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});employeeId=e.employmentId;
  await setCompensation(a,{employmentId:employeeId,basicSalary:5000,monthlyAllowance:0,effectiveFrom:'2026-01-01'});await seedPayComponentCatalog(a);
  const [person]=await owner.db.select({code:schema.employment.employeeCode}).from(schema.employment).where(eq(schema.employment.id,employeeId));employeeCode=person.code!;
  const [component]=await owner.db.select({id:schema.payComponent.id}).from(schema.payComponent).where(and(eq(schema.payComponent.tenantId,base.tenantId),eq(schema.payComponent.code,'BONUS')));componentId=component.id;
  const [cycle]=await owner.db.insert(schema.payrollCycle).values({tenantId:base.tenantId,companyId:base.companyId,name:'Import Monthly',code:'IMP',runType:'regular'}).returning();cycleId=cycle.id;
 });
 afterAll(closeAll);
 const csv=(method:IndividualImportMethod,rows:string[][])=>toCsv([[...INDIVIDUAL_IMPORT_HEADERS[method]],...rows]);
 const monthly=(amount='250',date='2026-07-31')=>[employeeCode,'Import Example','2026-08','IMP','BONUS',date,'amount','',amount,'monthly'];
 const validate=(method:IndividualImportMethod,rows:string[][],operationId=randomUUID())=>validateIndividualImport(adminCtx(base),{operationId,sourceName:`${method}.xlsx`,csv:csv(method,rows),method,scopeIds:[base.companyId]});
 const confirm=(id:string)=>confirmIndividualImport(adminCtx(base),{id,scopeIds:[base.companyId]});
 const revert=(id:string)=>revertIndividualImport(adminCtx(base),{id,scopeIds:[base.companyId],confirmProcessed:false});
 it('persists outcomes, independent month/date, exact ownership and retry-safe confirmation',async()=>{
  const op=randomUUID(),input=await validate('monthly',[monthly(),['UNKNOWN','','2026-08','IMP','BONUS','2026-08-03','amount','','20','bad']],op);
  expect(input.preview).toMatchObject({valid:1,invalid:1});const retry=await validate('monthly',[monthly(),['UNKNOWN','','2026-08','IMP','BONUS','2026-08-03','amount','','20','bad']],op);expect(retry.id).toBe(input.id);
  const saved=await confirm(input.id);expect(saved).toMatchObject({state:'completed',written:1});expect(saved.outcomes.map(o=>o.state)).toEqual(['imported','invalid']);
  const [row]=await owner.db.select().from(schema.payrollIndividualTxn).where(eq(schema.payrollIndividualTxn.id,saved.outcomes[0].transactionId!));expect(row).toMatchObject({companyId:base.companyId,payPeriod:'2026-08',txnDate:'2026-07-31',amount:'250.00',intendedCycleId:cycleId});
  expect((await confirm(input.id)).written).toBe(1);expect(await owner.db.select().from(schema.payrollIndividualTxn)).toHaveLength(1);
  expect((await listIndividualImports(adminCtx(base),[base.companyId])).map(r=>r.id)).toContain(input.id);
 });
 it('retains equal-amount daily entries on distinct dates and refuses true duplicates and amount-only items',async()=>{
  await owner.db.update(schema.payComponent).set({rule:{kind:'per_hour',rate:10}}).where(eq(schema.payComponent.id,componentId));
  const row=(date:string)=>[employeeCode,'Import Example','2026-08','IMP','BONUS',date,'2','daily'];
  const input=await validate('daily',[row('2026-07-30'),row('2026-07-31'),row('2026-07-31')]);expect(input.preview).toMatchObject({valid:2,invalid:1});
  const saved=await confirm(input.id);expect(saved.written).toBe(2);const rows=await owner.db.select().from(schema.payrollIndividualTxn);expect(rows.map(r=>r.amount)).toEqual(['20.00','20.00']);expect(new Set(rows.map(r=>r.txnDate)).size).toBe(2);
  const replay=await validate('daily',[row('2026-07-30'),row('2026-07-31')]);expect(replay.preview.valid).toBe(0);
  await owner.db.update(schema.payComponent).set({rule:null}).where(eq(schema.payComponent.id,componentId));const unsupported=await validate('daily',[row('2026-08-10')]);expect(unsupported.preview.rows[0].reason).toBe('dailyItemUnsupported');
 });
 it('atomically refuses edited records, then safely reverses an eligible batch without deleting its log or manual entries',async()=>{
  const input=await validate('monthly',[monthly()]);const saved=await confirm(input.id),id=saved.outcomes[0].transactionId!;
  await owner.db.update(schema.payrollIndividualTxn).set({amount:'251.00'}).where(eq(schema.payrollIndividualTxn.id,id));await expect(revert(input.id)).rejects.toThrow('importRowsChanged');expect((await readIndividualImport(adminCtx(base),input.id,[base.companyId])).state).toBe('completed');
  const another=await validate('monthly',[monthly('500','2026-08-02')]),batch=await confirm(another.id);
  const [manual]=await owner.db.insert(schema.payrollIndividualTxn).values({tenantId:base.tenantId,companyId:base.companyId,payPeriod:'2026-08',employmentId:employeeId,kind:'earning',componentId,txnDate:'2026-08-03',amount:'100.00',source:'manual'}).returning();
  const reversed=await revert(another.id);expect(reversed).toMatchObject({state:'reverted',written:1});expect(reversed.outcomes).toEqual(batch.outcomes);expect(reversed.revertedBy).toBe(base.adminUserId);
  expect((await revert(another.id)).state).toBe('reverted');const remaining=await owner.db.select().from(schema.payrollIndividualTxn);expect(remaining.map(r=>r.id).sort()).toEqual([id,manual.id].sort());
 });
 it('warns on optional name mismatch and rejects ambiguous configured cycles without guessing',async()=>{
  const row=monthly();row[1]='Different name';const input=await validate('monthly',[row]);expect(input.preview.rows[0].warnings?.map(w=>w.reason)).toContain('employeeNameMismatch');
  await owner.db.insert(schema.payrollCycle).values({tenantId:base.tenantId,companyId:base.companyId,name:'Other cycle',code:'OTHER',runType:'off_cycle'});
  row[3]='';const ambiguous=await validate('monthly',[row]);expect(ambiguous.preview.rows[0].reason).toBe('cycleAmbiguous');
 });
 it('denies unauthorized contexts and scope tampering before disclosing a batch',async()=>{
  const input=await validate('monthly',[monthly()]);
  await expect(readIndividualImport({...adminCtx(base),roles:['employee']},input.id,[base.companyId])).rejects.toThrow('importAccessDenied');
  await expect(readIndividualImport(adminCtx(base),input.id,[])).rejects.toThrow('importAccessDenied');
  await expect(readIndividualImport(adminCtx(base),input.id,[randomUUID()])).rejects.toThrow('importAccessDenied');
 });
 it('requires a fresh preview after a pay-rule change instead of silently writing a new amount',async()=>{
  await owner.db.update(schema.payComponent).set({rule:{kind:'per_hour',rate:10}}).where(eq(schema.payComponent.id,componentId));
  const input=await validate('daily',[[employeeCode,'Import Example','2026-08','IMP','BONUS','2026-08-01','2','daily']]);expect(input.preview.rows[0].amount).toBe('20.00');
  await owner.db.update(schema.payComponent).set({rule:{kind:'per_hour',rate:12}}).where(eq(schema.payComponent.id,componentId));
  const result=await confirm(input.id);expect(result.written).toBe(0);expect(result.outcomes[0]).toMatchObject({state:'failed',row:{reason:'previewChanged'}});expect(await owner.db.select().from(schema.payrollIndividualTxn)).toHaveLength(0);
 });
 it('serializes simultaneous confirmations and reversals without duplicate effects',async()=>{
  const input=await validate('monthly',[monthly()]);const results=await Promise.all([confirm(input.id),confirm(input.id)]);expect(results.map(r=>r.written)).toEqual([1,1]);expect(await owner.db.select().from(schema.payrollIndividualTxn)).toHaveLength(1);
  const reversed=await Promise.all([revert(input.id),revert(input.id)]);expect(reversed.map(r=>r.state)).toEqual(['reverted','reverted']);expect(await owner.db.select().from(schema.payrollIndividualTxn)).toHaveLength(0);
 });
 it('requires the processed-payroll acknowledgement, marks recalculation and refuses closed targets atomically',async()=>{
  const a=adminCtx(base),{batchId}=await createBatch(a,{companyId:base.companyId,payPeriod:'2026-08',payrollCycleId:cycleId});
  await owner.db.update(schema.payrollBatch).set({status:'processed'}).where(eq(schema.payrollBatch.id,batchId));
  const input=await validate('monthly',[monthly()]),saved=await confirm(input.id);expect(saved.written).toBe(1);
  await expect(revert(input.id)).rejects.toThrow('confirmProcessedRevert');expect(await owner.db.select().from(schema.payrollIndividualTxn)).toHaveLength(1);
  const reversed=await revertIndividualImport(a,{id:input.id,scopeIds:[base.companyId],confirmProcessed:true});expect(reversed.state).toBe('reverted');
  const [batch]=await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,batchId));expect(batch.needsRecalcAt).not.toBeNull();
  const next=await validate('monthly',[monthly('500','2026-08-02')]),created=await confirm(next.id);expect(created.written).toBe(1);
  await owner.db.update(schema.payrollBatch).set({status:'closed'}).where(eq(schema.payrollBatch.id,batchId));
  await expect(revertIndividualImport(a,{id:next.id,scopeIds:[base.companyId],confirmProcessed:true})).rejects.toThrow();expect(await owner.db.select().from(schema.payrollIndividualTxn)).toHaveLength(1);expect((await readIndividualImport(a,next.id,[base.companyId])).state).toBe('completed');
  const locked=await validate('monthly',[monthly('700','2026-08-04')]);expect(locked.preview.valid).toBe(0);expect(locked.preview.rows[0].reason).toBe('runNotWritable');
 });
 it('retains failed validation attempts and refuses method-mismatched headings before any writes',async()=>{
  const input=await validateIndividualImport(adminCtx(base),{operationId:randomUUID(),sourceName:'wrong.xlsx',csv:csv('monthly',[monthly()]),method:'daily',scopeIds:[base.companyId]});
  expect(input.preview.fileError).toBe('templateMismatch');await expect(confirm(input.id)).rejects.toThrow('templateMismatch');expect(await owner.db.select().from(schema.payrollIndividualTxn)).toHaveLength(0);
 });
});
