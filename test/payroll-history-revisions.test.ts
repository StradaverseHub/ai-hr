import {afterAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {previewPayrollHistoryUpload,confirmPayrollHistoryUpload,previewPayrollHistoryRevert,revertPayrollHistoryUpload,listPayrollHistoryAttempts,getPayrollHistoryAttempt,payrollHistorySource} from '../core/payroll-history-revisions';
import {hireEmployee} from '../core/org';
import {createCompany,createDepartment} from '../core/admin';
import {createBatch,myPayslipDetail,listBatches,paymentSummaryForBatch} from '../core/payroll';
import {payrollComparisonSourcesTx} from '../core/payroll-view';
import {myEaSources} from '../core/reporting';
import {myReleasedPayslipRuns,dashboardStats} from '../core/read';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {toCsv} from '../lib/csv';
import {payrollPublicationState} from '../lib/payroll-publication';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,createAppUser,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base,ctx:SessionContext,employeeId:string,employeePersonId:string;
const year=Number(todayInKualaLumpur().slice(0,4))-2,period=`${year}-01`;
const rows=(amount='5000.00',company='000AC',employee='0007')=>[
 [employee,period,'ME','BASIC',company,amount,'1'],[employee,period,'ME','EEEPF',company,'0.00','1'],
 [employee,period,'ME','EESOCSO',company,'0.00','1'],[employee,period,'ME','EEEIS',company,'0.00','1'],[employee,period,'ME','PCB',company,'0.00','1'],
];
const upload=(amount='5000.00')=>previewPayrollHistoryUpload(ctx,{name:'history.csv',content:Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...rows(amount)])),operationKey:randomUUID()});
const confirm=(preview:Awaited<ReturnType<typeof upload>>,replacement=true)=>confirmPayrollHistoryUpload(ctx,{attemptId:preview.attemptId,previewHash:preview.plan.previewHash,confirmReplacement:replacement});
const effective=()=>withTenant(ctx,tx=>tx.select().from(schema.payslip));
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');ctx=await entitledCtx(b);
 await owner.db.update(schema.company).set({companyLabel:'000AC'}).where(eq(schema.company.id,b.companyId));
 await seedPayrollCycleCatalog(ctx,b.companyId);
 await owner.db.insert(schema.payComponent).values({tenantId:b.tenantId,code:'BASIC',name:'Basic salary',kind:'allowance',displayCategory:'basic'});
 const hired=await hireEmployee(ctx,{person:{fullName:'Fictional history employee',primaryEmail:'history@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:'0007',hiredOn:`${year-1}-01-01`});
 employeeId=hired.employmentId;
 const [employee]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,employeeId));employeePersonId=employee.personId;
});
afterAll(closeAll);

describe('immutable payroll history correction and recovery',()=>{
 it('preserves original rows while replacing and reverting the effective money exactly once',async()=>{
  const first=await upload();expect(first.plan.counts).toEqual({created:1,replaced:0,unchanged:0,invalid:0});
  const initial=await confirm(first);expect(payrollPublicationState((await listBatches(ctx,[b.companyId]))[0])).toBe('history');await expect(paymentSummaryForBatch(ctx,(await listBatches(ctx,[b.companyId]))[0].id)).rejects.toThrow(/Imported history/);const original=(await effective())[0];expect(Number(original.grossPay)).toBe(5000);
  expect((await confirm(first)).alreadyCommitted).toBe(true);expect(await owner.db.select().from(schema.payslip)).toHaveLength(1);
  const correction=await upload('6000.00');expect(correction.plan.counts.replaced).toBe(1);expect(correction.plan.rows[0].beforeValues?.grossPay).toBe('5000.00');
  await expect(confirm(correction,false)).rejects.toThrow(/Confirm replacement/);expect(await effective()).toHaveLength(1);
  await confirm(correction);expect((await effective()).map(row=>Number(row.grossPay))).toEqual([6000]);
  expect(await listBatches(ctx,[b.companyId])).toMatchObject([{historyImportCycleName:'Monthly',employeeCount:1,batchDate:null}]);
  expect(await owner.db.select().from(schema.payslip)).toHaveLength(2);
  const dashboard=await dashboardStats(ctx,[b.companyId]);expect(Number(dashboard.latestPayroll?.net)).toBe(6000);
  const recovery=await previewPayrollHistoryRevert(ctx,correction.attemptId);expect(recovery).toMatchObject({attemptId:correction.attemptId,count:1,previewHash:expect.stringMatching(/^[0-9a-f]{64}$/)});
  await revertPayrollHistoryUpload(ctx,correction.attemptId,recovery.previewHash);expect((await effective()).map(row=>Number(row.grossPay))).toEqual([5000]);
  const [unchanged]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.id,original.id));expect(unchanged).toEqual(original);
  await expect(revertPayrollHistoryUpload(ctx,correction.attemptId,recovery.previewHash)).rejects.toThrow(/already been reverted/);
  await expect(owner.db.update(schema.payslip).set({grossPay:'1.00'}).where(eq(schema.payslip.id,initial.changes[0].snapshotId!))).rejects.toMatchObject({cause:{code:'23514',message:expect.stringMatching(/immutable/)}});
  expect((await owner.db.select().from(schema.payslip).where(eq(schema.payslip.id,original.id)))[0]).toEqual(original);
 });
 it('retires a newly created effective entry without erasing its physical snapshot or audit',async()=>{
  const first=await upload();await confirm(first);const recovery=await previewPayrollHistoryRevert(ctx,first.attemptId);await revertPayrollHistoryUpload(ctx,first.attemptId,recovery.previewHash);
  expect(await effective()).toEqual([]);expect(await owner.db.select().from(schema.payslip)).toHaveLength(1);
  expect(await listBatches(ctx,[b.companyId])).toEqual([]);expect((await dashboardStats(ctx,[b.companyId])).latestPayroll).toBeNull();
  const logs=await listPayrollHistoryAttempts(ctx);expect(logs.items[0].events.map(event=>event.kind)).toEqual(['confirmed','reverted']);
  expect((await payrollHistorySource(ctx,first.attemptId))?.content.toString()).toContain('0007');
 });
 it('refuses a stale confirmation and a revert after a later correction',async()=>{
  const first=await upload();await confirm(first);const recovery=await previewPayrollHistoryRevert(ctx,first.attemptId);
  const a=await upload('6000.00'),b=await upload('7000.00');await confirm(a);
  await expect(confirm(b)).rejects.toThrow(/changed/);
  await expect(revertPayrollHistoryUpload(ctx,first.attemptId,recovery.previewHash)).rejects.toThrow(/later correction/);
  expect((await effective()).map(row=>Number(row.grossPay))).toEqual([6000]);
 });
 it('compares only effective imported runs and exact headcounts across correction and recovery',async()=>{
  const first=await upload();await confirm(first);const next=`${year}-02`;
  const second=await previewPayrollHistoryUpload(ctx,{name:'february.csv',content:Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...rows('4000.00').map(row=>row.map((cell,index)=>index===1?next:cell))]))});await confirm(second);
  const compare=()=>withTenant(ctx,tx=>payrollComparisonSourcesTx(tx,ctx,{companyIds:[b.companyId],previousPeriod:period,currentPeriod:next,runType:'all',payItemCode:'BASIC'}));
  expect((await compare()).sources.map(row=>row.amount).sort()).toEqual(['4000.00','5000.00']);
  const correction=await upload('6000.00');await confirm(correction);const changed=await compare();expect(changed.runs).toHaveLength(2);expect(changed.sources.map(row=>row.amount).sort()).toEqual(['4000.00','6000.00']);
  const recovery=await previewPayrollHistoryRevert(ctx,correction.attemptId);await revertPayrollHistoryUpload(ctx,correction.attemptId,recovery.previewHash);
  const restored=await compare();expect(restored.runs).toHaveLength(2);expect(restored.sources.map(row=>row.amount).sort()).toEqual(['4000.00','5000.00']);
 });
 it('removes retired history from own EA eligibility and attendance protection owner reads',async()=>{
  const userId=await createAppUser(b.tenantId,employeePersonId,'employee'),own={...ctx,userId,personId:employeePersonId,roles:['employee'],grants:undefined};
  const protection=()=>withTenant(ctx,tx=>tx.execute(sql`select * from app.attendance_payroll_protection(${employeeId}::uuid)`));
  const first=await upload();await confirm(first);expect(await myEaSources(own)).toMatchObject([{employmentId:employeeId,year:String(year),available:true}]);expect(await protection()).toHaveLength(1);
  const recovery=await previewPayrollHistoryRevert(ctx,first.attemptId);await revertPayrollHistoryUpload(ctx,first.attemptId,recovery.previewHash);
  expect(await myEaSources(own)).toEqual([]);expect(await protection()).toHaveLength(0);
 });
 it('binds immutable snapshot evidence to actual payroll money and its validated attempt',async()=>{
  const first=await upload();await confirm(first);
  const [source]=await owner.db.select().from(schema.payrollHistoryImportAttempt),[batch]=await owner.db.select().from(schema.payrollBatch),[slip]=await owner.db.select().from(schema.payslip),[evidence]=await owner.db.select().from(schema.payrollHistoryImportSnapshot);
  await expect(owner.db.insert(schema.payrollHistoryImportAttempt).values({...source,id:randomUUID(),operationKey:randomUUID(),sourceContent:Buffer.from('different source')})).rejects.toMatchObject({cause:{code:'23514'}});
  const [copyBatch]=await owner.db.insert(schema.payrollBatch).values({...batch,id:randomUUID(),runSeq:batch.runSeq+1}).returning();
  const [copySlip]=await owner.db.insert(schema.payslip).values({...slip,id:randomUUID(),batchId:copyBatch.id}).returning();
  await expect(owner.db.insert(schema.payrollHistoryImportSnapshot).values({...evidence,id:copySlip.id,values:{...evidence.values,grossPay:'1.00'}})).rejects.toMatchObject({cause:{message:expect.stringMatching(/snapshot identity mismatch/)}});
  await expect(owner.db.insert(schema.payrollHistoryImportSnapshot).values({...evidence,id:copySlip.id,valueHash:'0'.repeat(64)})).rejects.toMatchObject({cause:{message:expect.stringMatching(/snapshot identity mismatch/)}});
  expect(await owner.db.select().from(schema.payrollHistoryImportSnapshot)).toEqual([evidence]);
 });
 it('serializes concurrent confirmations with the same expected revision',async()=>{
  const a=await upload(),b=await upload('6000.00');
  const outcomes=await Promise.allSettled([confirm(a),confirm(b)]);
  expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect(await effective()).toHaveLength(1);expect(await owner.db.select().from(schema.payslip)).toHaveLength(1);
 });
 it('imports two authorised companies with same-named cycles into distinct canonical records',async()=>{
  const other=await createCompany(ctx,{legalName:'Fictional second history company',companyLabel:'000BC',country:'MY',currency:'MYR'});
  const department=await createDepartment(ctx,{companyId:other.id,name:'Fixture department'});await seedPayrollCycleCatalog(ctx,other.id);
  const second=await hireEmployee(ctx,{person:{fullName:'Second fictional employee',primaryEmail:'second-history@fixture.test'},companyId:other.id,departmentId:department.id,employmentType:'full_time',employeeCode:'0008',hiredOn:`${year-1}-01-01`});
  const content=Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...rows(),...rows('7000.00','000BC','0008')]));
  const preview=await previewPayrollHistoryUpload(ctx,{name:'two-companies.csv',content});expect(preview.plan.counts).toEqual({created:2,replaced:0,unchanged:0,invalid:0});expect(new Set(preview.plan.rows.map(row=>row.cycleName))).toEqual(new Set(['Monthly']));expect(new Set(preview.plan.rows.map(row=>row.cycleId)).size).toBe(2);
  await confirm(preview);expect(new Set((await effective()).map(row=>row.employmentId))).toEqual(new Set([employeeId,second.employmentId]));
  expect(Number((await dashboardStats(ctx,[b.companyId])).latestPayroll?.net)).toBe(5000);expect(Number((await dashboardStats(ctx,[other.id])).latestPayroll?.net)).toBe(7000);
  const repeated=await previewPayrollHistoryUpload(ctx,{name:'same-file.csv',content});expect(repeated.plan.counts).toEqual({created:0,replaced:0,unchanged:2,invalid:0});await confirm(repeated);expect(await owner.db.select().from(schema.payslip)).toHaveLength(2);
  const recovery=await previewPayrollHistoryRevert(ctx,preview.attemptId);expect(recovery.count).toBe(2);await revertPayrollHistoryUpload(ctx,preview.attemptId,recovery.previewHash);expect(await effective()).toEqual([]);expect(await owner.db.select().from(schema.payslip)).toHaveLength(2);
 });
 it('refuses accumulated batch overflow during preview before any payroll writes',async()=>{
  await hireEmployee(ctx,{person:{fullName:'Second overflow fixture',primaryEmail:'overflow@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:'0008',hiredOn:`${year-1}-01-01`});
  const content=Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...rows('6000000000.00'),...rows('6000000000.00','000AC','0008')]));
  const preview=await previewPayrollHistoryUpload(ctx,{name:'overflow.csv',content});expect(preview.plan.counts.invalid).toBe(2);expect(preview.plan.rows.every(row=>row.reasons.some(reason=>reason.includes('batch total')))).toBe(true);
  await expect(confirm(preview)).rejects.toThrow(/Correct the file/);expect(await owner.db.select().from(schema.payslip)).toEqual([]);expect(await owner.db.select().from(schema.payrollBatch)).toEqual([]);
 });
 it('validates an entire multi-company file before writing any payroll result',async()=>{
  const content=Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...rows(),...rows('100.00','UNKNOWN','0008')]));
  const preview=await previewPayrollHistoryUpload(ctx,{name:'mixed.csv',content});expect(preview.plan.counts.invalid).toBeGreaterThan(0);
  await expect(confirm(preview)).rejects.toThrow(/Correct the file/);expect(await owner.db.select().from(schema.payslip)).toHaveLength(0);
  expect(await listPayrollHistoryAttempts(ctx)).toMatchObject({items:[{sourceName:'mixed.csv'}]});
 });
 it('does not turn imported history into an issued own payslip or change an ordinary payroll run',async()=>{
  const first=await upload();const committed=await confirm(first);
  const userId=await createAppUser(b.tenantId,employeePersonId,'employee');
  const own={...ctx,userId,personId:employeePersonId,roles:['employee'],grants:undefined};
  expect(await myReleasedPayslipRuns(own)).toEqual([]);expect(await myPayslipDetail(own,committed.changes[0].snapshotId!)).toBeNull();
  const next=`${year}-02`;const ordinary=await createBatch(ctx,{companyId:b.companyId,payPeriod:next});
  const content=Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...rows().map(row=>row.map((cell,index)=>index===1?next:cell))]));
  const preview=await previewPayrollHistoryUpload(ctx,{name:'ordinary.csv',content});expect(preview.plan.counts.invalid).toBeGreaterThan(0);
  await expect(confirm(preview)).rejects.toThrow();
  const [batch]=await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,ordinary.batchId));expect(batch.status).toBe('draft');
 });
 it('refuses recovery after a generated statutory artifact and keeps the original effective basis',async()=>{
  const first=await upload();await confirm(first);const recovery=await previewPayrollHistoryRevert(ctx,first.attemptId);
  await owner.db.insert(schema.statutoryReport).values({tenantId:b.tenantId,companyId:b.companyId,jurisdiction:'MY',reportType:'my.contributions',periodKind:'month',periodKey:period,status:'draft',generatedBy:ctx.userId});
  await expect(revertPayrollHistoryUpload(ctx,first.attemptId,recovery.previewHash)).rejects.toThrow(/statutory/);
  expect((await effective()).map(row=>Number(row.grossPay))).toEqual([5000]);
 });
 it('reviews recovery without changing money or audit and binds confirmation to the exact preview',async()=>{
  const first=await upload();await expect(previewPayrollHistoryRevert(ctx,first.attemptId)).rejects.toThrow(/no imported changes/);await confirm(first);
  const revisions=await owner.db.select().from(schema.payrollHistoryImportRevision),events=await owner.db.select().from(schema.payrollHistoryImportEvent),money=await effective();
  const recovery=await previewPayrollHistoryRevert(ctx,first.attemptId);expect(await previewPayrollHistoryRevert(ctx,first.attemptId)).toEqual(recovery);
  expect(await owner.db.select().from(schema.payrollHistoryImportRevision)).toEqual(revisions);expect(await owner.db.select().from(schema.payrollHistoryImportEvent)).toEqual(events);expect(await effective()).toEqual(money);
  await expect(revertPayrollHistoryUpload(ctx,first.attemptId,'0'.repeat(64))).rejects.toThrow(/preview changed/);
  await expect(revertPayrollHistoryUpload(ctx,first.attemptId,'not-a-preview')).rejects.toThrow(/Review the current/);
  expect(await owner.db.select().from(schema.payrollHistoryImportRevision)).toEqual(revisions);expect(await effective()).toEqual(money);
  const other=await seedBase();await setModule(other.tenantId,'payroll','active');const foreign=await entitledCtx(other);
  await expect(previewPayrollHistoryRevert(foreign,first.attemptId)).rejects.toThrow(/unavailable/);
  await expect(revertPayrollHistoryUpload(foreign,first.attemptId,recovery.previewHash)).rejects.toThrow(/unavailable/);expect(await effective()).toEqual(money);
  await revertPayrollHistoryUpload(ctx,first.attemptId,recovery.previewHash);await expect(previewPayrollHistoryRevert(ctx,first.attemptId)).rejects.toThrow(/already been reverted/);
 });
 it('labels recorded audit actors without granting a personnel directory or foreign attempt lookup',async()=>{
  const [actor]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Payroll audit owner',primaryEmail:'payroll-audit-owner@fixture.test'}).returning();await owner.db.update(schema.appUser).set({personId:actor.id}).where(eq(schema.appUser.id,ctx.userId!));ctx={...ctx,personId:actor.id};
  const first=await upload();await confirm(first);const detail=await getPayrollHistoryAttempt(ctx,first.attemptId);
  expect(detail?.createdByName).toBe('Payroll audit owner');expect(detail?.events).toMatchObject([{actorId:ctx.userId,actorName:'Payroll audit owner'}]);expect((await listPayrollHistoryAttempts(ctx)).items[0].createdByName).toBe('Payroll audit owner');
  const unrelated=await createAppUser(b.tenantId,employeePersonId,'employee');
  const [hidden]=await withTenant(ctx,tx=>tx.execute<{name:string|null}>(sql`select app.payroll_history_actor_label(${first.attemptId}::uuid,${unrelated}::uuid) as name`));expect(hidden.name).toBeNull();
  const other=await seedBase();await setModule(other.tenantId,'payroll','active');
  const [foreign]=await withTenant(await entitledCtx(other),tx=>tx.execute<{name:string|null}>(sql`select app.payroll_history_actor_label(${first.attemptId}::uuid,${ctx.userId}::uuid) as name`));expect(foreign.name).toBeNull();
 });
 it('keeps source files private across tenants and retains failed validation attempts',async()=>{
  const invalid=await previewPayrollHistoryUpload(ctx,{name:'invalid.csv',content:Buffer.from('Repeated,Repeated\n1,2')});
  expect(invalid.plan.counts.invalid).toBe(1);expect((await listPayrollHistoryAttempts(ctx)).items).toHaveLength(1);
  const other=await seedBase();await setModule(other.tenantId,'payroll','active');
  expect(await payrollHistorySource(await entitledCtx(other),invalid.attemptId)).toBeNull();
  expect((await listPayrollHistoryAttempts(await entitledCtx(other))).items).toEqual([]);
 });
});
