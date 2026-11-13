/**
 * Board 154511c4 — history recorded backwards from the current record (production 13 Nov 2026: employee
 * imported with the latest details, then a transfer on 01 Apr 2026 refused because the system only works
 * forwards). A Create movement whose After values already stand on its date and whose Before values differ
 * from the day before rewrites only the period before the date. Fictional tenant, companies and people.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {and,asc,eq,isNull} from 'drizzle-orm';
import * as schema from '../db/schema';
import {withTenant} from '../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {createMovementEvent,movementHistory,reverseMovementEvent} from '../core/movement';
import {previewMovementImport,commitMovementImport} from '../core/movement-import';
import {classifyHistoryRows,recordHistoryMovementTx} from '../core/movement-history';
import {previewInformationCorrection,correctInformation} from '../core/information-correction';
import {recordHistoryMovement} from '../core/movement-history-command';
import type {MovementImportRecord} from '../lib/movement-import-contract';

let b:Base;let coB:string;let coC:string;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 const [beta]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Beta Fictional Sdn Bhd',country:'MY'}).returning({id:schema.company.id});coB=beta.id;
 const [gamma]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Gamma Fictional Sdn Bhd',country:'MY'}).returning({id:schema.company.id});coC=gamma.id;
 // Shared labels, so the department and position are usable in every company (as in the production case).
 await share('department',b.deptA);await share('position',b.positionId);
});
/** Assigns a label to the two other companies (label_company_assignment), the canonical way to share it. */
async function share(labelKind:'department'|'position',labelId:string){
 await owner.db.insert(schema.labelCompanyAssignment).values([coB,coC].map(companyId=>({tenantId:b.tenantId,labelKind,labelId,companyId})));
}

const HIRED='2025-06-03',TRANSFER='2026-04-01';
async function hire(code:string,departmentId=b.deptA){
 const e=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional '+code,primaryEmail:`${randomUUID().slice(0,8)}@fixture.test`},employeeCode:code,companyId:b.companyId,departmentId,positionId:b.positionId,employmentType:'full_time',hiredOn:HIRED});
 return e.employmentId as string;
}
const versions=(employmentId:string)=>owner.db.select({validFrom:schema.assignment.validFrom,validTo:schema.assignment.validTo,companyId:schema.assignment.companyId}).from(schema.assignment).where(and(eq(schema.assignment.employmentId,employmentId),isNull(schema.assignment.supersededAt))).orderBy(asc(schema.assignment.validFrom));
const record=(id:string,p:{effectiveDate:string;after:Record<string,string|null>;before:Record<string,string|null>})=>withTenant(adminCtx(b),tx=>recordHistoryMovementTx(tx,adminCtx(b),{employmentId:id,kind:'entityTransfer',typeCode:'entityTransfer',...p,remarks:'Fictional history'}));
async function closedPayroll(employmentId:string,companyId:string,period:string){
 const [pp]=await owner.db.insert(schema.payPeriod).values({tenantId:b.tenantId,companyId,period,status:'open'}).returning({id:schema.payPeriod.id});
 const [batch]=await owner.db.insert(schema.payrollBatch).values({tenantId:b.tenantId,companyId,payPeriodId:pp.id,payPeriod:period,runSeq:1,runType:'regular',batchDate:`${period}-28`,status:'closed'}).returning({id:schema.payrollBatch.id});
 await owner.db.insert(schema.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId,basicSalary:'4000.00',grossPay:'4000.00',totalDeductions:'500.00',netPay:'3500.00',employerCost:'4500.00',statutory:{}});
}

describe('classifyHistoryRows',()=>{
 const v=[{id:'v1',validFrom:HIRED,validTo:null,companyId:'A',departmentId:'D',positionId:null,businessUnitId:null,locationId:null}];
 it('recognises a set of history rows in any order, newest first, and leaves ordinary movements alone',()=>{
  const newer={key:2,effectiveDate:TRANSFER,after:{companyId:'A'},before:{companyId:'B'}};
  const older={key:1,effectiveDate:'2025-12-01',after:{companyId:'B'},before:{companyId:'C'}};
  expect([...classifyHistoryRows(v,[older,newer])].sort()).toEqual([1,2]);
  // After differs from the record on its date: an ordinary forward movement.
  expect(classifyHistoryRows(v,[{key:3,effectiveDate:TRANSFER,after:{companyId:'B'},before:{companyId:'A'}}]).size).toBe(0);
  // After already stands and Before equals the record the day before: nothing to change, not history.
  expect(classifyHistoryRows(v,[{key:4,effectiveDate:TRANSFER,after:{companyId:'A'},before:{companyId:'A'}}]).size).toBe(0);
  // A field outside the five dated placement fields is never history.
  expect(classifyHistoryRows(v,[{key:5,effectiveDate:TRANSFER,after:{gradeId:'G'} as never,before:{gradeId:'H'} as never}]).size).toBe(0);
 });
});

describe('recording history before a date',()=>{
 it('rewrites only the period before the date, shows it in Employment History, and rolls back exactly',async()=>{
  const id=await hire('HB-1');
  const result=await record(id,{effectiveDate:TRANSFER,after:{companyId:b.companyId},before:{companyId:coB}});
  expect(result).toMatchObject({spanFrom:HIRED,spanTo:'2026-03-31',fields:['companyId'],closedPayrollPeriods:[]});
  expect(await versions(id)).toEqual([{validFrom:HIRED,validTo:TRANSFER,companyId:coB},{validFrom:TRANSFER,validTo:null,companyId:b.companyId}]);
  const [emp]=await owner.db.select({companyId:schema.employment.companyId}).from(schema.employment).where(eq(schema.employment.id,id));
  expect(emp.companyId).toBe(b.companyId);
  const rows=await movementHistory(adminCtx(b),id);
  const move=rows.find(r=>r.kind==='entityTransfer')!;
  expect(move).toMatchObject({effectiveDate:TRANSFER,history:true,canEdit:false,canReverse:true,company:'Acme Sdn Bhd'});
  expect(rows.find(r=>r.kind==='hired')?.company).toBe('Beta Fictional Sdn Bhd');
  await reverseMovementEvent(adminCtx(b),{employmentId:id,movementId:move.id,reason:'Fictional undo'});
  expect(await versions(id)).toEqual([{validFrom:HIRED,validTo:null,companyId:b.companyId}]);
  expect((await movementHistory(adminCtx(b),id)).find(r=>r.id===move.id)?.reversed).toBeTruthy();
 });

 it('refuses what history cannot mean, with a named reason',async()=>{
  const id=await hire('HB-2');
  await expect(record(id,{effectiveDate:'2099-01-01',after:{companyId:b.companyId},before:{companyId:coB}})).rejects.toThrow('movement_history_future');
  await expect(record(id,{effectiveDate:TRANSFER,after:{companyId:coB},before:{companyId:coC}})).rejects.toThrow('movement_history_after_mismatch:companyId');
  await expect(record(id,{effectiveDate:TRANSFER,after:{companyId:b.companyId},before:{companyId:b.companyId}})).rejects.toThrow('movement_history_no_change');
  await expect(record(id,{effectiveDate:TRANSFER,after:{companyId:b.companyId},before:{}})).rejects.toThrow('movement_history_before_required');
  // An earlier change owns its own period.
  await record(id,{effectiveDate:TRANSFER,after:{companyId:b.companyId},before:{companyId:coB}});
  await expect(record(id,{effectiveDate:'2026-06-01',after:{companyId:b.companyId},before:{companyId:coC}})).rejects.toThrow('movement_history_earlier_change:2026-04-01');
  // Working backwards from there is fine: the period before 01 Apr is uniformly Beta.
  await record(id,{effectiveDate:'2025-12-01',after:{companyId:coB},before:{companyId:coC}});
  expect((await versions(id)).map(v=>[v.validFrom,v.companyId])).toEqual([[HIRED,coC],['2025-12-01',coB],[TRANSFER,b.companyId]]);
 });

 it('never splits a version a recorded movement created, and keeps closed payroll true',async()=>{
  const id=await hire('HB-3');
  const [deptOther]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:b.companyId,name:'Fictional Other'}).returning({id:schema.department.id});
  await share('department',deptOther.id);
  await createMovementEvent(adminCtx(b),{employmentId:id,kind:'transfer',effectiveDate:'2026-05-01',departmentId:deptOther.id});
  await expect(record(id,{effectiveDate:'2026-06-01',after:{companyId:b.companyId},before:{companyId:coB}})).rejects.toThrow('movement_history_splits_movement:2026-05-01');
  const paid=await hire('HB-4');
  await closedPayroll(paid,b.companyId,'2025-08');
  await expect(record(paid,{effectiveDate:TRANSFER,after:{companyId:b.companyId},before:{companyId:coB}})).rejects.toThrow('movement_history_payroll_company:2025-08');
 });

 it('refuses a Before company that cannot use the carried department',async()=>{
  const [local]=await owner.db.insert(schema.department).values({tenantId:b.tenantId,companyId:b.companyId,name:'Fictional Local'}).returning({id:schema.department.id});
  const id=await hire('HB-5',local.id);
  await expect(record(id,{effectiveDate:TRANSFER,after:{companyId:b.companyId},before:{companyId:coB}})).rejects.toThrow('movement_label_other_company:departmentId');
 });
});

describe('the Movement import',()=>{
 const row=(n:number,date:string,after:string,before:string):MovementImportRecord=>({row:n,employeeCode:'HB-IMP',cells:{kind:'entityTransfer',effectiveDate:date,companyId:after},before:{companyId:before},errors:[],importVersion:2,source:{sheet:'Movements',row:n}});
 it('takes ordinary Create rows as history, in any file order, and labels them before anything is saved',async()=>{
  const id=await hire('HB-IMP');const ctx=adminCtx(b);
  // Older row first in the file: still applied newest first, each against the record the newer one leaves.
  const records=[row(2,'2025-12-01',coB,coC),row(3,TRANSFER,b.companyId,coB)];
  const preview=await previewMovementImport(ctx,{companyId:b.companyId,csv:'',records});
  const rows=preview.employees[0].rows;
  expect(rows.map(r=>[r.row,r.status,r.history])).toEqual(expect.arrayContaining([[3,'valid',{from:HIRED,to:'2026-03-31'}],[2,'valid',{from:HIRED,to:'2025-11-30'}]]));
  expect(await versions(id)).toEqual([{validFrom:HIRED,validTo:null,companyId:b.companyId}]);
  const result=await commitMovementImport(ctx,{companyId:b.companyId,csv:'',records,selection:preview.selection,inputHash:preview.inputHash,fingerprints:Object.fromEntries(preview.employees.map(e=>[e.employeeCode,e.fingerprint!])),acknowledgeExcluded:false});
  expect(result.imported).toBe(2);
  expect((await versions(id)).map(v=>[v.validFrom,v.companyId])).toEqual([[HIRED,coC],['2025-12-01',coB],[TRANSFER,b.companyId]]);
 });
 it('names the blocking record instead of the generic refusal',async()=>{
  const id=await hire('HB-IMP');const ctx=adminCtx(b);
  // A forward transfer dated before a correction that started the current record.
  await correctInformation(ctx,{employmentId:id,changes:{companyId:coB},reason:'Fictional correction',fingerprint:(await previewInformationCorrection(ctx,{employmentId:id,changes:{companyId:coB},reason:'Fictional correction'})).fingerprint,method:'manual'});
  const [{validFrom:started}]=(await versions(id)).slice(-1);
  const records=[{...row(2,TRANSFER,coC,coB),before:{}}];
  const preview=await previewMovementImport(ctx,{companyId:coB,csv:'',records});
  expect(preview.employees[0].rows[0].errors).toEqual([`movement_before_current_record:${started}`]);
 });
});

describe('Correct information',()=>{
 it('says from which date the company changes, and can apply a company-only correction from the join date',async()=>{
  const id=await hire('HB-CI');const ctx=adminCtx(b);
  const today=await previewInformationCorrection(ctx,{employmentId:id,changes:{companyId:coB},reason:'Fictional correction'});
  expect(today.warnings?.[0]).toMatchObject({code:'companyFromToday'});
  const whole=await previewInformationCorrection(ctx,{employmentId:id,changes:{companyId:coB},reason:'Fictional correction',fromJoinDate:true});
  expect(whole.warnings?.[0]).toEqual({code:'companyFromJoinDate',date:HIRED});
  expect(whole.fingerprint).not.toBe(today.fingerprint);
  await correctInformation(ctx,{employmentId:id,changes:{companyId:coB},reason:'Fictional correction',fingerprint:whole.fingerprint,method:'manual',fromJoinDate:true});
  expect(await versions(id)).toEqual([{validFrom:HIRED,validTo:null,companyId:coB}]);
  const [emp]=await owner.db.select({companyId:schema.employment.companyId}).from(schema.employment).where(eq(schema.employment.id,id));
  expect(emp.companyId).toBe(coB);
  expect((await movementHistory(ctx,id)).find(r=>r.kind==='hired')?.company).toBe('Beta Fictional Sdn Bhd');
 });
 it('refuses from the join date once the company has changed in the history',async()=>{
  const id=await hire('HB-CJ');const ctx=adminCtx(b);
  await record(id,{effectiveDate:TRANSFER,after:{companyId:b.companyId},before:{companyId:coB}});
  const p=await previewInformationCorrection(ctx,{employmentId:id,changes:{companyId:coC},reason:'Fictional correction',fromJoinDate:true});
  await expect(correctInformation(ctx,{employmentId:id,changes:{companyId:coC},reason:'Fictional correction',fingerprint:p.fingerprint,method:'manual',fromJoinDate:true})).rejects.toThrow(/already changes on 2026-04-01/);
 });
});

describe('the dated records start on the Group Join Date',()=>{
 const pay=(employmentId:string)=>owner.db.select({validFrom:schema.compensation.validFrom}).from(schema.compensation).where(and(eq(schema.compensation.employmentId,employmentId),isNull(schema.compensation.supersededAt))).orderBy(asc(schema.compensation.validFrom));
 it('moves the first company/position and salary records when the join date moves earlier (production 101475)',async()=>{
  const id=await hire('HB-JD');const ctx=adminCtx(b);
  await owner.db.insert(schema.compensation).values({tenantId:b.tenantId,employmentId:id,basicSalary:'0.00',validFrom:HIRED});
  const preview=await previewInformationCorrection(ctx,{employmentId:id,changes:{hiredOn:'2025-03-01',joinDate:'2025-03-01'},reason:'Fictional join date'});
  expect(preview.alignStart).toEqual({from:HIRED,to:'2025-03-01'});
  expect(preview.warnings).toContainEqual({code:'historyStartAligned',date:'2025-03-01',from:HIRED});
  await correctInformation(ctx,{employmentId:id,changes:{hiredOn:'2025-03-01',joinDate:'2025-03-01'},reason:'Fictional join date',fingerprint:preview.fingerprint,method:'manual'});
  expect((await versions(id)).map(v=>v.validFrom)).toEqual(['2025-03-01']);
  expect((await pay(id)).map(v=>v.validFrom)).toEqual(['2025-03-01']);
 });
 it('aligns an existing mismatch on a save with no field changed, and refuses a later start over closed payroll',async()=>{
  const id=await hire('HB-JE');const ctx=adminCtx(b);
  // The production shape: the join date already moved without the dated records.
  await owner.db.update(schema.employment).set({hiredOn:'2025-01-06',joinDate:'2025-01-06'}).where(eq(schema.employment.id,id));
  const preview=await previewInformationCorrection(ctx,{employmentId:id,changes:{},reason:'Fictional alignment'});
  expect(preview.changed).toEqual([]);expect(preview.alignStart).toEqual({from:HIRED,to:'2025-01-06'});
  await correctInformation(ctx,{employmentId:id,changes:{},reason:'Fictional alignment',fingerprint:preview.fingerprint,method:'manual'});
  expect((await versions(id)).map(v=>v.validFrom)).toEqual(['2025-01-06']);
  await closedPayroll(id,b.companyId,'2025-02');
  const later=await previewInformationCorrection(ctx,{employmentId:id,changes:{hiredOn:'2025-04-01',joinDate:'2025-04-01'},reason:'Fictional later join'});
  await expect(correctInformation(ctx,{employmentId:id,changes:{hiredOn:'2025-04-01',joinDate:'2025-04-01'},reason:'Fictional later join',fingerprint:later.fingerprint,method:'manual'})).rejects.toThrow(/Payroll for 2025-02 was closed/);
 });
});

describe('New Event: Record history',()=>{
 it('takes After from the record on the date and writes the period before it',async()=>{
  const id=await hire('HB-NE');
  await recordHistoryMovement(adminCtx(b),{employmentId:id,typeCode:'entityTransfer',effectiveDate:TRANSFER,before:{companyId:coB},remarks:'Fictional'});
  expect(await versions(id)).toEqual([{validFrom:HIRED,validTo:TRANSFER,companyId:coB},{validFrom:TRANSFER,validTo:null,companyId:b.companyId}]);
  await expect(recordHistoryMovement(adminCtx(b),{employmentId:id,typeCode:'entityTransfer',effectiveDate:TRANSFER,before:{gradeId:'x'},remarks:null})).rejects.toThrow('movement_history_fields');
 });
});
