import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,setEmploymentInfo} from '../core/org';
import {createMovementEvent,editMovementEvent,reverseMovementEvent,movementHistory,movementPendingEditInput,applyDueMovementsTx,resignationInformation} from '../core/movement';
import {previewMovementImport,commitMovementImport} from '../core/movement-import';
import {validateEmployeeImport,commitEmployeeImport} from '../core/import';
import {movementFormFields} from '../lib/movement-form-contract';
import {MOVEMENT_IMPORT_COLUMNS,parseMovementImport,movementImportCellIssues} from '../lib/movement-import-contract';
import {movementPendingFormValues} from '../lib/movement-pending-input';
import {movementWorkbookLayout} from '../lib/movement-workbook-layout';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,ctx:SessionContext;
const today=todayInKualaLumpur();
function day(offset:number){const date=new Date(`${today}T00:00:00Z`);date.setUTCDate(date.getUTCDate()+offset);return date.toISOString().slice(0,10);}
beforeAll(async()=>{
 await migrateTestDb();
 const [installed]=await owner.db.execute<{installed:boolean}>(sql`select to_regprocedure('app.people_general_read()') is not null as installed`);
 expect(installed.installed,'The integration journal must install migration0594').toBe(true);
});
beforeEach(async()=>{await resetDb();b=await seedBase();ctx=adminCtx(b);});
afterAll(closeAll);
async function hire(code='EXIT') {return hireEmployee(ctx,{companyId:b.companyId,departmentId:b.deptA,employeeCode:code,person:{fullName:'Resignation fixture',primaryEmail:`${randomUUID()}@resignation-owner.test`},employmentType:'full_time',hiredOn:day(-365)});}
async function row(id:string){return (await owner.db.select().from(schema.employment).where(eq(schema.employment.id,id)))[0];}
const dates=(record:Awaited<ReturnType<typeof row>>)=>({tenderResignationDate:record.tenderResignationDate,resignationDate:record.resignationDate,lastWorkingDate:record.lastWorkingDate});
const input=(employmentId:string,effectiveDate=day(-4))=>({employmentId,kind:'resignation',effectiveDate,tenderResignationDate:day(-20),resignationEffectiveDate:day(-10),endDate:day(-5),remarks:'Fictional resignation information'});
async function resignation(id:string,status='applied'){const rows=await movementHistory(ctx,id);const selected=rows.filter(r=>r.kind==='resignation'&&r.status===status);expect(selected).toHaveLength(1);return selected[0];}
async function closePayroll(id:string,period:string){
 const [p]=await owner.db.insert(schema.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period,status:'closed'}).returning();
 const [batch]=await owner.db.insert(schema.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:p.id,payPeriod:period,batchDate:`${period}-25`,status:'closed'}).returning();
 await owner.db.insert(schema.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId:id,basicSalary:'4000',grossPay:'4000',statutory:{},totalDeductions:'0',netPay:'4000',employerCost:'4000'});
}

describe('884ea42d one resignation information owner',()=>{
 it('generic or forged-tag saves cannot edit exit dates; general notice and probation terms still save',async()=>{
  const {employmentId}=await hire();
  for(const movement of [undefined,{type:'resignation'},{type:'termination'}])await setEmploymentInfo(ctx,{employmentId,tenderResignationDate:day(-20),resignationDate:day(-10),lastWorkingDate:day(-5),probationValue:3,probationUnit:'month',noticeAfterConfirmationValue:30,noticeAfterConfirmationUnit:'day',movement});
  const saved=await row(employmentId);expect(dates(saved)).toEqual({tenderResignationDate:null,resignationDate:null,lastWorkingDate:null});expect(saved.probationValue).toBe(3);expect(saved.noticeAfterConfirmationValue).toBe(30);
 });
 it('Movement records all three dates, actor/before/after provenance and exactly one history row without ending employment',async()=>{
  const {employmentId}=await hire();const before=await row(employmentId);await createMovementEvent(ctx,input(employmentId));
  const saved=await row(employmentId);expect(dates(saved)).toEqual({tenderResignationDate:day(-20),resignationDate:day(-10),lastWorkingDate:day(-5)});expect(saved.terminatedOn).toBe(before.terminatedOn);
  const history=await resignation(employmentId);expect(history.effectiveDate).toBe(day(-4));expect(history.canEdit).toBe(true);expect(history.canReverse).toBe(true);
  const summary=await resignationInformation(ctx,employmentId);for(const field of ['tenderResignationDate','resignationDate','lastWorkingDate'] as const)expect(summary[field].source).toMatchObject({kind:'movement',movementId:history.id});
  const [event]=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.id,history.id));expect(event.actorId).toBe(ctx.userId);expect(event.payload).toMatchObject({before:{resignationDate:null},after:{resignationDate:day(-10)}});
  expect((await movementPendingEditInput(ctx,employmentId,history.id))?.values).toMatchObject({tenderResignationDate:day(-20),resignationEffectiveDate:day(-10)});
 });
 it('future intent preserves legacy dates until due, applies once, and links the completed scheduled event',async()=>{
  const {employmentId}=await hire();const legacy={tenderResignationDate:day(-60),resignationDate:day(-50),lastWorkingDate:day(-40)};
  await owner.db.update(schema.employment).set(legacy).where(eq(schema.employment.id,employmentId));
  for(const value of Object.values(await resignationInformation(ctx,employmentId)))expect(value.source.kind).toBe('legacy');
  const future={...input(employmentId,day(10)),tenderResignationDate:today,resignationEffectiveDate:day(8),endDate:day(9)};await createMovementEvent(ctx,future);
  const pending=await resignation(employmentId,'pending');expect(dates(await row(employmentId))).toEqual(legacy);expect((await resignationInformation(ctx,employmentId)).resignationDate.source.kind).toBe('legacy');
  const intent=await movementPendingEditInput(ctx,employmentId,pending.id);expect(intent?.values).toMatchObject({tenderResignationDate:today,resignationEffectiveDate:day(8)});
  expect((await withTenant(ctx,tx=>applyDueMovementsTx(tx,ctx,employmentId,day(9)))).applied).toBe(0);
  expect((await withTenant(ctx,tx=>applyDueMovementsTx(tx,ctx,employmentId,day(10)))).applied).toBe(1);
  expect((await withTenant(ctx,tx=>applyDueMovementsTx(tx,ctx,employmentId,day(10)))).applied).toBe(0);
  expect((await resignation(employmentId)).id).toBe(pending.id);expect((await resignationInformation(ctx,employmentId)).resignationDate.source).toMatchObject({kind:'movement',movementId:pending.id});expect((await row(employmentId)).terminatedOn).toBeNull();
 });
 it('corrects and cancels pending intent through the existing reversal lifecycle without changing current dates',async()=>{
  const {employmentId}=await hire();await createMovementEvent(ctx,{...input(employmentId,day(10)),tenderResignationDate:today,resignationEffectiveDate:day(8),endDate:day(9)});
  const pending=await resignation(employmentId,'pending');await editMovementEvent(ctx,{employmentId,movementId:pending.id,kind:'resignation',effectiveDate:day(12),endDate:day(11),resignationEffectiveDate:day(10),reason:'Corrected future dates'});
  const corrected=await resignation(employmentId,'pending');expect(corrected.id).not.toBe(pending.id);expect((await row(employmentId)).resignationDate).toBeNull();
  await reverseMovementEvent(ctx,{employmentId,movementId:corrected.id,reason:'Withdraw future record'});
  expect((await withTenant(ctx,tx=>applyDueMovementsTx(tx,ctx,employmentId,day(30)))).applied).toBe(0);expect((await row(employmentId)).resignationDate).toBeNull();
  expect((await movementHistory(ctx,employmentId)).filter(r=>r.kind==='resignation'&&r.reversed)).toHaveLength(2);
 });
 it('correction and permitted rollback restore truthful prior values and retain original events',async()=>{
  const {employmentId}=await hire();const legacy={tenderResignationDate:day(-70),resignationDate:day(-60),lastWorkingDate:day(-50)};await owner.db.update(schema.employment).set(legacy).where(eq(schema.employment.id,employmentId));
  await createMovementEvent(ctx,input(employmentId));const original=await resignation(employmentId);
  await editMovementEvent(ctx,{...input(employmentId),movementId:original.id,resignationEffectiveDate:day(-9),reason:'Correct actual resignation date'});
  const corrected=await resignation(employmentId);expect((await row(employmentId)).resignationDate).toBe(day(-9));expect((await movementHistory(ctx,employmentId)).find(r=>r.id===original.id)?.reversed?.corrected).toBe(true);
  await reverseMovementEvent(ctx,{employmentId,movementId:corrected.id,reason:'Restore prior historical record'});expect(dates(await row(employmentId))).toEqual(legacy);expect((await resignationInformation(ctx,employmentId)).resignationDate.source.kind).toBe('legacy');
 });
 it('blocks a closed-payroll create, correction and rollback while preserving issued financial values',async()=>{
  const {employmentId}=await hire();await createMovementEvent(ctx,input(employmentId));const history=await resignation(employmentId);
  await closePayroll(employmentId,today.slice(0,7));const before=dates(await row(employmentId));
  await expect(reverseMovementEvent(ctx,{employmentId,movementId:history.id,reason:'Forbidden financial change'})).rejects.toThrow(/closed payroll/);
  await expect(editMovementEvent(ctx,{...input(employmentId),movementId:history.id,endDate:day(-3),reason:'Forbidden financial correction'})).rejects.toThrow(/closed payroll/);
  await expect(createMovementEvent(ctx,{...input(employmentId),resignationEffectiveDate:day(-9)})).rejects.toThrow(/closed payroll/);
  expect(dates(await row(employmentId))).toEqual(before);const slips=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.employmentId,employmentId));expect(slips[0].netPay).toBe('4000.00');
 });
 it('a tender-only Movement remains display metadata and can be corrected without repricing closed payroll',async()=>{
  const {employmentId}=await hire();await closePayroll(employmentId,today.slice(0,7));
  await createMovementEvent(ctx,{employmentId,kind:'resignation',effectiveDate:today,tenderResignationDate:day(-1)});
  const event=await resignation(employmentId);expect(event.payrollLocked).toBe(false);expect((await row(employmentId)).resignationDate).toBeNull();
  await reverseMovementEvent(ctx,{employmentId,movementId:event.id,reason:'Correct display metadata'});expect((await row(employmentId)).tenderResignationDate).toBeNull();
 });
 it('a stale concurrent correction cannot replay an already reversed movement',async()=>{
  const {employmentId}=await hire();await createMovementEvent(ctx,input(employmentId));const original=await resignation(employmentId);
  const results=await Promise.allSettled([-8,-7].map(offset=>editMovementEvent(ctx,{...input(employmentId),movementId:original.id,resignationEffectiveDate:day(offset),reason:'Concurrent correction'})));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);expect((await movementHistory(ctx,employmentId)).filter(r=>r.kind==='resignation'&&r.status==='applied')).toHaveLength(1);
 });
 it('an actual company-limited principal cannot mutate a hidden-company employee despite forged role claims',async()=>{
  const {employmentId,personId}=await hire();const [company]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Other company fixture'}).returning();
  const userId=await createAppUser(b.tenantId,personId,'hr_admin');await owner.db.update(schema.roleAssignment).set({companyId:company.id}).where(eq(schema.roleAssignment.appUserId,userId));
  await expect(createMovementEvent({...ctx,userId,roles:['super_admin'],grants:[{role:'super_admin',companyId:null}]},input(employmentId))).rejects.toThrow();expect((await row(employmentId)).resignationDate).toBeNull();
 });
 it('Movement import rehearses and commits the same lifecycle dates without premature preview effects',async()=>{
  const {employmentId}=await hire('MOVE-IMPORT');
  const csv=`employee_code,event_type,effective_date,tender_resignation_date,resignation_effective_date,end_date\nMOVE-IMPORT,resignation,${today},${day(-20)},${day(-10)},${day(-5)}`;
  const preview=await previewMovementImport(ctx,{companyId:b.companyId,csv});expect(preview.valid).toBe(1);expect((await row(employmentId)).resignationDate).toBeNull();
  const fingerprints=Object.fromEntries(preview.employees.filter(employee=>employee.fingerprint).map(employee=>[employee.employeeCode,employee.fingerprint!]));
  const result=await commitMovementImport(ctx,{companyId:b.companyId,csv,inputHash:preview.inputHash,selection:preview.selection,fingerprints,acknowledgeExcluded:true});expect(result.imported).toBe(1);expect((await row(employmentId)).resignationDate).toBe(day(-10));
 });
 it('generic employee imports refuse historical exit columns; Movement transport retains all three exact dates',async()=>{
  const records=[{full_name:'Historical import',email:'history@resignation-owner.test',department:'Finance',hired_on:day(-100),employee_code:'IMPORT-HISTORY',basic_salary:'4000',resignation_date:day(-10)}];
  expect((await validateEmployeeImport(ctx,{companyId:b.companyId,records})).fileErrors.join(' ')).toContain('Movement');expect((await commitEmployeeImport(ctx,{companyId:b.companyId,records})).imported).toBe(0);
  expect(movementFormFields('resignation')).toEqual(expect.arrayContaining(['tenderResignationDate','resignationEffectiveDate','endDate']));expect(MOVEMENT_IMPORT_COLUMNS).toEqual(expect.arrayContaining(['tender_resignation_date','resignation_effective_date']));
  const parsed=parseMovementImport(`employee_code,event_type,effective_date,tender_resignation_date,resignation_effective_date,end_date\nE1,resignation,${today},${day(-20)},${day(-10)},${day(-5)}`);expect(parsed.fileErrors).toEqual([]);expect(movementImportCellIssues(parsed.records[0],'resignation')).toEqual([]);
  expect(movementPendingFormValues(parsed.records[0].cells)).toMatchObject({tenderResignationDate:day(-20),resignationEffectiveDate:day(-10)});
  const columns=movementWorkbookLayout({code:'resignation',label:'Resignation',behaviour:'resignation'},(_key,fallback)=>fallback);expect(columns.filter(column=>column.role==='input').map(column=>column.field)).toEqual(expect.arrayContaining(['tenderResignationDate','resignationEffectiveDate','endDate']));
 });
});
