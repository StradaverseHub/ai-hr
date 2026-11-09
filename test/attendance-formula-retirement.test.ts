/** Exercises post-cutover guards against a fictional, already-posted draft contribution. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import * as s from '../db/schema';
import {withTenant} from '../db/client';
import {hireEmployee} from '../core/org';
import {createBatch,generatePayslips,payrollHasRetiredAttendanceFormulaInputs,reverseRetiredAttendanceFormulaInputs} from '../core/payroll';
import {seedPayComponentCatalog} from '../packs/payroll/service';
import {listAttendanceFormulaResults,readAttendanceFormulaResult} from '../packs/attendance/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base;
beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();
 b=await seedBase();
 await setModule(b.tenantId,'attendance','active');
 await setModule(b.tenantId,'payroll','active');
 await setModule(b.tenantId,'typed_pay_components','active');
});

it('keeps a posted result readable, gates the draft, and reverses its existing source without deleting evidence',async()=>{
 const ctx=await entitledCtx(b);
 const {tenantId,companyId,adminUserId:createdBy}=b;
 const year=Number(todayInKualaLumpur().slice(0,4))-1;
 const month=year+'-08',date=month+'-10';
 const {employmentId}=await hireEmployee(ctx,{
  person:{fullName:'Fictional formula history',primaryEmail:'retired-formula@fixture.test'},
  companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:year+'-01-01',
 });
 await seedPayComponentCatalog(ctx);
 const [component]=await owner.db.select({id:s.payComponent.id}).from(s.payComponent)
  .where(sql`tenant_id=${tenantId}::uuid and code='ATTENDANCE'`);
 expect(component).toBeDefined();
 const {batchId}=await createBatch(ctx,{companyId,payPeriod:month});
 const formulaId=randomUUID(),revisionId=randomUUID(),resultId=randomUUID();
 const definition={code:'LEGACY_PAY',description:'Fictional historical formula',period:{method:'daily'},
  companyId,payItemId:component.id,eligibility:{mode:'all'}};
 const readRequirements={financial:true,workforce:false};
 const payload={result:{amount:'15.00',trace:[]},days:[]};

 // Restore only immutable legacy evidence as a fixture. Owner DDL is isolated to this
 // transaction and each trigger is enabled again before any application action is exercised.
 await owner.db.transaction(async tx=>{
  await tx.execute(sql`alter table attendance_formula disable trigger aa_retired_attendance_formula_insert`);
  await tx.execute(sql`alter table attendance_formula_revision disable trigger aa_retired_attendance_formula_insert`);
  await tx.execute(sql`alter table attendance_formula_revision disable trigger attendance_formula_revision_bind`);
  await tx.execute(sql`alter table attendance_formula_result disable trigger aa_retired_attendance_formula_insert`);
  await tx.execute(sql`alter table attendance_formula_result disable trigger attendance_formula_result_guard`);
  await tx.execute(sql`alter table attendance_formula_result_event disable trigger aa_retired_attendance_formula_event`);
  await tx.execute(sql`alter table attendance_formula_result_event disable trigger attendance_formula_result_event_guard`);
  await tx.execute(sql`alter table payroll_attendance_allowance_source disable trigger aa_retired_attendance_formula_allowance_insert`);
  await tx.execute(sql`alter table payroll_attendance_allowance_source disable trigger attendance_formula_contribution_insert`);
  await tx.insert(s.attendanceFormula).values({id:formulaId,tenantId,companyId,code:definition.code,createdBy});
  await tx.insert(s.attendanceFormulaRevision).values({id:revisionId,tenantId,companyId,formulaId,ordinal:1,
   payComponentId:component.id,definition:{...definition,period:{method:'daily'}},registryVersion:'fixture',evaluatorVersion:'fixture',
   contentHash:'0'.repeat(64),readRequirements,createdBy});
  await tx.insert(s.attendanceFormulaResult).values({id:resultId,tenantId,companyId,formulaId,revisionId,
   employmentId,periodFrom:date,periodTo:date,payComponentId:component.id,quantity:'15',unit:'amount',amount:'15.00',
   sourceHash:'0'.repeat(64),readRequirements,payload,createdBy});
  await tx.insert(s.attendanceFormulaResultEvent).values({tenantId,companyId,employmentId,resultId,
   kind:'posted',reason:'Historical fixture',batchId,createdBy});
  await tx.insert(s.payrollAttendanceAllowanceSource).values({tenantId,companyId,batchId,formulaId,
   formulaResultId:resultId,employmentId,componentId:component.id,payMonth:month,periodKey:date,amount:'15.00'});
  await tx.insert(s.payrollBatchComponent).values({tenantId,batchId,employmentId,componentId:component.id,
   amount:'15.00',notes:'Attendance allowance sources'});
  await tx.execute(sql`alter table attendance_formula enable trigger aa_retired_attendance_formula_insert`);
  await tx.execute(sql`alter table attendance_formula_revision enable trigger aa_retired_attendance_formula_insert`);
  await tx.execute(sql`alter table attendance_formula_revision enable trigger attendance_formula_revision_bind`);
  await tx.execute(sql`alter table attendance_formula_result enable trigger aa_retired_attendance_formula_insert`);
  await tx.execute(sql`alter table attendance_formula_result enable trigger attendance_formula_result_guard`);
  await tx.execute(sql`alter table attendance_formula_result_event enable trigger aa_retired_attendance_formula_event`);
  await tx.execute(sql`alter table attendance_formula_result_event enable trigger attendance_formula_result_event_guard`);
  await tx.execute(sql`alter table payroll_attendance_allowance_source enable trigger aa_retired_attendance_formula_allowance_insert`);
  await tx.execute(sql`alter table payroll_attendance_allowance_source enable trigger attendance_formula_contribution_insert`);
 });

 const financial=await entitledCtx(b);
 const retained=await readAttendanceFormulaResult(financial,resultId);
 expect(retained).toMatchObject({id:resultId,amount:'15.00',payload});
 expect(await listAttendanceFormulaResults(financial,{employmentId,date})).toMatchObject([{code:definition.code,state:'posted'}]);
 expect(await payrollHasRetiredAttendanceFormulaInputs(financial,batchId)).toBe(true);
 await expect(generatePayslips(financial,{batchId})).rejects.toThrow(/reverse retired Attendance Formula inputs/i);
 await expect(owner.db.update(s.payrollBatch).set({status:'processed'}).where(eq(s.payrollBatch.id,batchId))).rejects.toThrow();
 await expect(owner.db.insert(s.attendanceFormula).values({tenantId,companyId,code:'RETIRED_NEW',createdBy})).rejects.toThrow();
 await expect(withTenant(financial,tx=>tx.insert(s.attendanceFormulaResultEvent).values({tenantId,companyId,employmentId,resultId,
  kind:'posted',reason:'Blocked writer',batchId,createdBy}))).rejects.toThrow();

 await expect(reverseRetiredAttendanceFormulaInputs(financial,{batchId,scopeIds:[],reason:'Wrong selected company'})).rejects.toThrow();
 expect(await payrollHasRetiredAttendanceFormulaInputs(financial,batchId)).toBe(true);
 await reverseRetiredAttendanceFormulaInputs(financial,{batchId,scopeIds:[companyId],reason:'Retirement review complete'});
 expect(await payrollHasRetiredAttendanceFormulaInputs(financial,batchId)).toBe(false);
 expect(await owner.db.select().from(s.payrollBatchComponent).where(eq(s.payrollBatchComponent.batchId,batchId))).toEqual([]);
 expect(await readAttendanceFormulaResult(financial,resultId)).toEqual(retained);
 expect(await listAttendanceFormulaResults(financial,{employmentId,date})).toMatchObject([{code:definition.code,state:'reversed'}]);
 const events=await owner.db.select().from(s.attendanceFormulaResultEvent).where(eq(s.attendanceFormulaResultEvent.resultId,resultId)).orderBy(s.attendanceFormulaResultEvent.sequence);
 expect(events.map(event=>[event.kind,event.batchId])).toEqual([['posted',batchId],['reversed',batchId]]);
});
