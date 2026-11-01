/**
 * 646355e5 slice C — the Movement import's Update and Delete rows (template version 4): a Movement Event ID
 * resolved only within the row's tenant, company and employee; Update through the manual Edit's own path with
 * blank cells kept; Delete as the import rollback; the closed-payroll confirmation; and Import History revert
 * of both, refused when a later change touched the same movement. Real database and RLS, fictional fixtures.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createJobGrade,createPosition} from '../core/admin';
import {createMovementEvent,editMovementEvent,movementCurrentState,movementHistory,reverseMovementEvent} from '../core/movement';
import {previewMovementUpload,confirmMovementUpload} from '../core/movement-import-history';
import {getImportAttempt} from '../core/import-history';
import {previewImportRevertForAttempt,revertImportForAttempt} from '../core/import-history-handlers';
import {toCsv} from '../lib/csv';
import {todayInKualaLumpur} from '../lib/hr-date';
import {personnelImportLabelResolvers} from '../lib/personnel-import-labels.server';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
const day=(offset:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10);
const HEADER=['Company ID','Employee ID','Employee Name','Effective Date','Event Type','System Fields','Before','After','Action','Movement Event ID','Reason'];
const resolve=personnelImportLabelResolvers[0];
const file=(rows:string[][])=>Buffer.from(toCsv([HEADER,...rows]));
describe('Movement import Update and Delete (646355e5 slice C)',()=>{
 let b:Base,a:SessionContext,betaId:string,ac1:string,ac2:string,be1:string,junior:string,senior:string,seniorExec:string;
 const upload=(rows:string[][])=>previewMovementUpload(a,{name:'corrections.csv',content:file(rows),resolve});
 async function importRows(rows:string[][],acknowledgeClosedPayroll=false){
  const checked=await upload(rows);
  const keys=checked.preview.employees.filter(e=>e.fingerprint).map(e=>e.key!);
  const result=await confirmMovementUpload(a,{attemptId:checked.attemptId,previewHash:checked.previewHash,employees:keys,acknowledgeExcluded:true,acknowledgeClosedPayroll,resolve});
  return{checked,result};
 }
 const state=(id:string)=>movementCurrentState(a,id);
 const live=async(id:string,kind:string)=>(await movementHistory(a,id)).filter(row=>row.kind===kind&&!row.reversed);
 async function closedPayrollFor(employmentId:string,period:string){
  const[pp]=await owner.db.insert(s.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period,status:'closed'}).returning({id:s.payPeriod.id});
  const[batch]=await owner.db.insert(s.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:pp.id,payPeriod:period,batchDate:period+'-25',status:'closed'}).returning({id:s.payrollBatch.id});
  await owner.db.insert(s.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId,basicSalary:'3000.00',grossPay:'3000.00',statutory:{},totalDeductions:'0.00',netPay:'3000.00',employerCost:'3000.00'});
 }
 beforeAll(migrateTestDb);
 beforeEach(async()=>{
  await resetDb();b=await seedBase();a=adminCtx(b);
  await owner.db.update(s.company).set({companyLabel:'ACME'}).where(eq(s.company.id,b.companyId));
  const[beta]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Beta Fictional Bhd',companyLabel:'BETA',registrationNo:'202001000002'}).returning();betaId=beta.id;
  const[betaDept]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:betaId,name:'Beta Finance'}).returning();
  junior=(await createJobGrade(a,{code:'JUNIOR',name:'Junior',rank:2})).id;senior=(await createJobGrade(a,{code:'SENIOR',name:'Senior',rank:1})).id;
  seniorExec=(await createPosition(a,{companyId:b.companyId,title:'Senior Executive'})).id;
  const hire=async(code:string,companyId:string,departmentId:string)=>{
   const id=(await hireEmployee(a,{person:{fullName:'Fictional '+code,primaryEmail:`${code.toLowerCase()}@example.test`},companyId,departmentId,positionId:companyId===b.companyId?b.positionId:undefined,employmentType:'full_time',hiredOn:day(-400),employeeCode:code})).employmentId;
   await owner.db.update(s.employment).set({gradeId:junior}).where(eq(s.employment.id,id));
   await setCompensation(a,{employmentId:id,basicSalary:3000,effectiveFrom:day(-400)});return id;
  };
  ac1=await hire('AC001',b.companyId,b.deptA);ac2=await hire('AC002',b.companyId,b.deptA);be1=await hire('BE001',betaId,betaDept.id);
 });
 afterAll(closeAll);

 it('revision 2 updates an exited employee to another event type after the mistaken exit date',async()=>{
  await createMovementEvent(a,{employmentId:ac1,kind:'termination',effectiveDate:day(-3),endDate:day(-3),terminationReasonCode:'resignation',resignationDate:day(-10)});
  const [original]=await live(ac1,'resignation');
  const {result}=await importRows([['ACME','AC001','',day(-1),'Transfer','departmentId','','Operations','Update',original.id,'Fictional incorrect exit type']]);
  expect(result).toMatchObject({imported:1,failed:0});
  expect(await state(ac1)).toMatchObject({departmentId:b.deptB});
  const [employee]=await owner.db.select({terminatedOn:s.employment.terminatedOn}).from(s.employment).where(eq(s.employment.id,ac1));expect(employee.terminatedOn).toBeNull();
  expect((await movementHistory(a,ac1)).find(row=>row.id===original.id)?.status).toBe('reversed');
 });
 it('revision 2 deletes the exact voluntary exit and reverts it through the recorded termination owner',async()=>{
  await createMovementEvent(a,{employmentId:ac1,kind:'termination',effectiveDate:day(-3),endDate:day(-3),terminationReasonCode:'resignation',resignationDate:day(-10)});
  const [original]=await live(ac1,'resignation');
  const {checked,result}=await importRows([['ACME','AC001','','','','','','','Delete',original.id,'Fictional wrong exit']]);
  expect(result).toMatchObject({imported:1,failed:0});
  const preview=await previewImportRevertForAttempt(a,checked.attemptId);expect(preview.blockers).toEqual([]);
  await revertImportForAttempt(a,checked.attemptId,{previewHash:preview.previewHash,reason:'Fictional restore original exit'});
  const [employee]=await owner.db.select({terminatedOn:s.employment.terminatedOn}).from(s.employment).where(eq(s.employment.id,ac1));expect(employee.terminatedOn).toBe(day(-3));
 });

 it('Update by Movement Event ID corrects only the filled cell, keeps the rest, and a revert re-applies the original values',async()=>{
  await createMovementEvent(a,{employmentId:ac1,kind:'promotion',effectiveDate:day(-5),gradeId:senior,positionId:seniorExec,basicSalary:3500});
  const[original]=await live(ac1,'promotion');
  // Effective Date and Event Type left blank: both are kept. Only Basic Salary is corrected.
  const{checked,result}=await importRows([['ACME','AC001','','','','basicSalary','3500','3800','Update',original.id,'Salary keyed wrong']]);
  expect(checked.preview.fileErrors).toEqual([]);
  expect(checked.preview.employees[0].rows[0]).toMatchObject({status:'valid',action:'update',movementId:original.id,eventType:'promotion',effectiveDate:day(-5)});
  expect(result).toMatchObject({imported:1,failed:0});
  expect(await state(ac1)).toMatchObject({gradeId:senior,positionId:seniorExec,basicSalary:'3800.00'});
  const history=await movementHistory(a,ac1);
  expect(history.find(row=>row.id===original.id)?.reversed).toMatchObject({corrected:true,reason:'Salary keyed wrong'});
  const[replacement]=await live(ac1,'promotion');expect(replacement.id).not.toBe(original.id);expect(replacement.effectiveDate).toBe(day(-5));
  const detail=(await getImportAttempt(a,checked.attemptId))!;
  expect(detail.items).toHaveLength(1);
  expect(detail.items[0].before).toMatchObject({action:'update',movementId:original.id,reason:'Salary keyed wrong'});
  expect(detail.items[0].after).toMatchObject({action:'update',movementId:replacement.id,originalMovementId:original.id});
  const review=await previewImportRevertForAttempt(a,checked.attemptId);expect(review.blockers).toEqual([]);expect(review.eligible).toBe(true);
  await revertImportForAttempt(a,checked.attemptId,{previewHash:review.previewHash,reason:'Fictional revert of the salary fix'});
  expect(await state(ac1)).toMatchObject({gradeId:senior,positionId:seniorExec,basicSalary:'3500.00'});
  expect((await movementHistory(a,ac1)).find(row=>row.id===replacement.id)?.reversed).toMatchObject({corrected:true,reason:'Fictional revert of the salary fix'});
  expect(await live(ac1,'promotion')).toHaveLength(1);
 });

 it('Delete by Movement Event ID rolls the movement back with the reason, and a revert re-records it',async()=>{
  await createMovementEvent(a,{employmentId:ac1,kind:'transfer',effectiveDate:day(-3),departmentId:b.deptB});
  const[transfer]=await live(ac1,'transfer');
  const{checked,result}=await importRows([['ACME','AC001','',day(-3),'Transfer','','','','Delete',transfer.id,'Keyed against the wrong employee']]);
  expect(result).toMatchObject({imported:1,failed:0});
  expect((await state(ac1)).departmentId).toBe(b.deptA);
  expect((await movementHistory(a,ac1)).find(row=>row.id===transfer.id)?.reversed).toMatchObject({corrected:false,reason:'Keyed against the wrong employee'});
  const review=await previewImportRevertForAttempt(a,checked.attemptId);expect(review.blockers).toEqual([]);
  await revertImportForAttempt(a,checked.attemptId,{previewHash:review.previewHash,reason:'Fictional undo of the delete'});
  expect((await state(ac1)).departmentId).toBe(b.deptB);
  const again=await live(ac1,'transfer');expect(again).toHaveLength(1);expect(again[0]).toMatchObject({effectiveDate:day(-3)});expect(again[0].id).not.toBe(transfer.id);
 });

 it('refuses unknown, foreign, another employee’s and already rolled-back ids, and a Delete whose date does not match',async()=>{
  await createMovementEvent(a,{employmentId:ac2,kind:'transfer',effectiveDate:day(-3),departmentId:b.deptB});
  await createMovementEvent(a,{employmentId:ac1,kind:'transfer',effectiveDate:day(-4),departmentId:b.deptB});
  const[other]=await live(ac2,'transfer'),[mine]=await live(ac1,'transfer');
  const betaMovement=(await movementHistory(a,be1)).find(row=>row.kind==='hired');
  await reverseMovementEvent(a,{employmentId:ac1,movementId:mine.id,reason:'Fictional earlier rollback'});
  const unknown='0b7c9d2e-3f4a-4b5c-8d6e-7f8091a2b3c4';
  const errorsOf=async(id:string,extra:Partial<Record<'date',string>>={})=>{
   const checked=await upload([['ACME','AC001','',extra.date??'','','','','','Delete',id,'Fictional check']]);
   return checked.preview.employees[0].rows[0];
  };
  expect((await errorsOf(unknown)).errors).toEqual(['movement_id_unknown']);
  expect((await errorsOf(other.id)).errors).toEqual(['movement_id_other_employee']);
  if(betaMovement&&betaMovement.id!=='hired')expect((await errorsOf(betaMovement.id)).errors).toEqual(['movement_id_unknown']);
  expect((await errorsOf(mine.id)).errors).toEqual(['movement_already_rolled_back']);
  await createMovementEvent(a,{employmentId:ac1,kind:'transfer',effectiveDate:day(-2),departmentId:b.deptB});
  const[current]=await live(ac1,'transfer');
  expect((await errorsOf(current.id,{date:day(-9)})).errors).toEqual(['event_mismatch:effectiveDate']);
  // Update or Delete without an id is a row error before anything is looked up.
  const missing=await upload([['ACME','AC001','','','','basicSalary','','3100','Update','','Fictional check']]);
  expect(missing.preview.employees[0].rows[0]).toMatchObject({status:'invalid',errors:['movement_id_required']});
  expect((await state(ac2)).departmentId).toBe(b.deptB);
 });

 it('a correction behind closed payroll fails without the confirmation and saves with it',async()=>{
  const effective=day(-2),period=effective.slice(0,7);
  await createMovementEvent(a,{employmentId:ac1,kind:'transfer',effectiveDate:effective,departmentId:b.deptB});
  const[transfer]=await live(ac1,'transfer');
  await closedPayrollFor(ac1,period);
  const row=['ACME','AC001','','','','','','','Delete',transfer.id,'Fictional closed-payroll correction'];
  const first=await importRows([row],false);
  expect(first.checked.preview.employees[0].rows[0]).toMatchObject({status:'valid',closedPayrollPeriods:[period]});
  expect(first.result).toMatchObject({imported:0,failed:1});
  expect(first.result.employees[0].rows[0].errors.join(' ')).toMatch(/^closed_payroll_acknowledgement_required:/);
  expect((await state(ac1)).departmentId).toBe(b.deptB);
  const second=await importRows([row],true);
  expect(second.result).toMatchObject({imported:1,failed:0});
  expect((await state(ac1)).departmentId).toBe(b.deptA);
  const reversals=await owner.db.select({payload:s.domainEvent.payload}).from(s.domainEvent).where(and(eq(s.domainEvent.subjectEmploymentId,ac1),eq(s.domainEvent.eventType,'employment.movement.reversed')));
  expect(reversals.map(r=>r.payload)).toEqual([expect.objectContaining({movementId:transfer.id,closedPayrollPeriods:[period],closedPayrollAcknowledged:true,reason:'Fictional closed-payroll correction'})]);
  const confirmed=(await getImportAttempt(a,second.checked.attemptId))!.events.find(e=>e.kind==='confirmed');
  expect(confirmed?.detail).toMatchObject({closedPayrollAcknowledged:true});
 });

 it('refuses the revert of an Update or a Delete after a later change touched the same movement, and changes nothing',async()=>{
  await createMovementEvent(a,{employmentId:ac1,kind:'promotion',effectiveDate:day(-6),gradeId:senior,basicSalary:3500});
  await createMovementEvent(a,{employmentId:ac2,kind:'transfer',effectiveDate:day(-6),departmentId:b.deptB});
  const[promotion]=await live(ac1,'promotion'),[transfer]=await live(ac2,'transfer');
  const updated=await importRows([['ACME','AC001','','','','basicSalary','','3700','Update',promotion.id,'Fictional salary fix']]);
  const deleted=await importRows([['ACME','AC002','','','','','','','Delete',transfer.id,'Fictional wrong transfer']]);
  expect(updated.result.imported+deleted.result.imported).toBe(2);
  // A later manual Edit of the movement the Update left.
  const[left]=await live(ac1,'promotion');
  await editMovementEvent(a,{employmentId:ac1,movementId:left.id,kind:'promotion',effectiveDate:day(-6),gradeId:senior,basicSalary:3900,reason:'Fictional later edit'});
  const review=await previewImportRevertForAttempt(a,updated.checked.attemptId);
  expect(review.eligible).toBe(false);expect(review.blockers.map(x=>x.reason).join(' ')).toMatch(/changed or rolled back since|has been changed since this import/);
  await expect(revertImportForAttempt(a,updated.checked.attemptId,{previewHash:review.previewHash,reason:'Fictional revert attempt'})).rejects.toThrow(/cannot be reverted/);
  expect((await state(ac1)).basicSalary).toBe('3900.00');
  // A later movement after the Delete: re-recording the deleted transfer would overwrite it.
  await createMovementEvent(a,{employmentId:ac2,kind:'transfer',effectiveDate:day(-1),departmentId:b.deptB});
  const blocked=await previewImportRevertForAttempt(a,deleted.checked.attemptId);
  expect(blocked.eligible).toBe(false);expect(blocked.blockers.length).toBeGreaterThan(0);
  await expect(revertImportForAttempt(a,deleted.checked.attemptId,{previewHash:blocked.previewHash,reason:'Fictional revert attempt'})).rejects.toThrow(/cannot be reverted/);
  expect(await live(ac2,'transfer')).toHaveLength(1);
  expect((await getImportAttempt(a,deleted.checked.attemptId))!.events.at(-1)?.kind).toBe('revert_failed');
 });

 it('still imports a version 3 (eight-column) file as Create only',async()=>{
  const v3=Buffer.from(toCsv([HEADER.slice(0,8),['ACME','AC001','',day(-1),'transfer','departmentId','Finance','Operations']]));
  const checked=await previewMovementUpload(a,{name:'v3.csv',content:v3,resolve});
  expect(checked.preview.fileErrors).toEqual([]);expect(checked.preview.employees[0].rows[0]).toMatchObject({status:'valid'});
  expect(checked.preview.employees[0].rows[0].action).toBeUndefined();
  const result=await confirmMovementUpload(a,{attemptId:checked.attemptId,previewHash:checked.previewHash,employees:[checked.preview.employees[0].key!],acknowledgeExcluded:true,resolve});
  expect(result.imported).toBe(1);expect((await state(ac1)).departmentId).toBe(b.deptB);
 });
});
