/**
 * Board 4604dccc revision 3 — payroll history no longer blocks a correction (migration 5690, ADR 2026-11-16).
 * An employee with an earlier payslip and later grade and department changes (the staging EMP-0004 shape) can be
 * corrected. Each payslip's details are fixed first from the recorded history as at that payroll; closed payroll rows
 * are byte-identical afterwards; an existing snapshot is never changed; the screen corrects Department from the
 * Effective Date. Fictional tenant, companies and people.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {and,asc,eq,isNull} from 'drizzle-orm';
import * as schema from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {createMovementEvent} from '../core/movement';
import {previewInformationCorrection,correctInformation} from '../core/information-correction';
import {payrollPreservationRefusal} from '../core/closed-payroll-correction-authority';
import type {InformationChanges} from '../lib/information-correction';

let b:Base;let g1:string;let g2:string;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 [{id:g1},{id:g2}]=await owner.db.insert(schema.jobGrade).values([{tenantId:b.tenantId,code:'G1',name:'Fictional Grade One'},{tenantId:b.tenantId,code:'G2',name:'Fictional Grade Two'}]).returning({id:schema.jobGrade.id});
});

const ctx=()=>adminCtx(b);
const HIRED='2026-01-06';
async function hire(code:string){
 const e=await hireEmployee(ctx(),{person:{fullName:'Fictional '+code,primaryEmail:`${randomUUID().slice(0,8)}@fixture.test`},employeeCode:code,companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:HIRED,gradeId:g1});
 // The hire was keyed in January, before that month's payroll (the fixture runs today).
 await owner.db.update(schema.assignment).set({createdAt:new Date(`${HIRED}T02:00:00Z`)}).where(eq(schema.assignment.employmentId,e.employmentId as string));
 return e.employmentId as string;
}
async function closedSlip(employmentId:string,period:string){
 const [pp]=await owner.db.insert(schema.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period,status:'closed'}).returning({id:schema.payPeriod.id});
 const [batch]=await owner.db.insert(schema.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:pp.id,payPeriod:period,runSeq:1,runType:'regular',batchDate:`${period}-28`,status:'closed',createdAt:new Date(`${period}-25T02:00:00Z`),closedAt:new Date(`${period}-28T02:00:00Z`)}).returning({id:schema.payrollBatch.id});
 await owner.db.insert(schema.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId,basicSalary:'4000.00',grossPay:'4000.00',totalDeductions:'500.00',netPay:'3500.00',employerCost:'4500.00',statutory:{}});
}
async function correct(id:string,changes:InformationChanges,effectiveOn:string){
 const review=await previewInformationCorrection(ctx(),{employmentId:id,changes,reason:'Fictional correction',effectiveOn});
 await correctInformation(ctx(),{employmentId:id,changes,reason:'Fictional correction',fingerprint:review.fingerprint,method:'manual',effectiveOn,...(review.closedPayrollPeriods?.length?{acknowledgeClosedPayroll:true}:{})});
 return review;
}
const payroll=async(id:string)=>({
 slips:await owner.db.select().from(schema.payslip).where(eq(schema.payslip.employmentId,id)).orderBy(asc(schema.payslip.id)),
 batches:await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.companyId,b.companyId)).orderBy(asc(schema.payrollBatch.id)),
});
const snapshots=(id:string)=>owner.db.select().from(schema.informationPayslipSnapshot).where(eq(schema.informationPayslipSnapshot.employmentId,id));
const deptName=async(id:string)=>(await owner.db.select({name:schema.department.name}).from(schema.department).where(eq(schema.department.id,id)))[0].name;

describe('a correction after payroll and later changes',()=>{
 it('is accepted; each payslip keeps the details it was issued with; closed payroll is unchanged',async()=>{
  const id=await hire('PH-1');
  await closedSlip(id,'2026-01');
  // Later changes after that payroll: a grade change and a department transfer.
  await createMovementEvent(ctx(),{employmentId:id,kind:'promotion',effectiveDate:'2026-03-01',gradeId:g2,positionId:b.positionId,remarks:'Fictional promotion'});
  await createMovementEvent(ctx(),{employmentId:id,kind:'transfer',effectiveDate:'2026-04-01',departmentId:b.deptB,remarks:'Fictional transfer'});
  const before=await payroll(id);
  await correct(id,{hiredOn:'2026-01-01',joinDate:'2026-01-01'},'2026-01-01');
  const [emp]=await owner.db.select({hiredOn:schema.employment.hiredOn,joinDate:schema.employment.joinDate}).from(schema.employment).where(eq(schema.employment.id,id));
  expect(emp).toEqual({hiredOn:'2026-01-01',joinDate:'2026-01-01'});
  const [snap]=await snapshots(id);
  // As issued: the grade and department before the later changes, the Group Join Date before this correction.
  expect(snap.grade).toBe('Fictional Grade One');
  expect(snap.hiredOn).toBe(HIRED);
  const meta=snap.documentMetadata as {department?:string;jobGrade?:string;snapshotBasis:{reconstructed:string[];asDisplayed:string[]}};
  expect(meta.department).toBe(await deptName(b.deptA));
  expect(meta.snapshotBasis.reconstructed).toEqual(expect.arrayContaining(['jobGrade','department']));
  expect(await payroll(id)).toEqual(before);
 });
 it('never changes a snapshot that already exists',async()=>{
  const id=await hire('PH-2');
  await closedSlip(id,'2026-01');
  await correct(id,{employmentType:'part_time'},'2026-02-01');
  const first=await snapshots(id);
  await createMovementEvent(ctx(),{employmentId:id,kind:'transfer',effectiveDate:'2026-04-01',departmentId:b.deptB,remarks:'Fictional transfer'});
  await correct(id,{hiredOn:'2026-01-02'},'2026-01-02');
  expect(await snapshots(id)).toEqual(first);
 });
});

describe('the screen corrects Business Unit, Department and Position',()=>{
 it('corrects Department from the Effective Date without the Excel template',async()=>{
  const id=await hire('PH-3');
  await correct(id,{departmentId:b.deptB},'2026-02-01');
  const versions=await owner.db.select({validFrom:schema.assignment.validFrom,departmentId:schema.assignment.departmentId}).from(schema.assignment).where(and(eq(schema.assignment.employmentId,id),isNull(schema.assignment.supersededAt))).orderBy(asc(schema.assignment.validFrom));
  expect(versions.map(v=>[v.validFrom,v.departmentId])).toEqual([[HIRED,b.deptA],['2026-02-01',b.deptB]]);
 });
});

describe('the refusals that remain are named',()=>{
 it('maps the paying-company permission and assignment refusals to plain sentences',()=>{
  const wrapped=(message:string)=>Object.assign(new Error('Failed query'),{cause:new Error(message)});
  expect(payrollPreservationRefusal(wrapped('Historical payroll company permission is required'))).toMatch(/do not have access to a company that paid/);
  expect(payrollPreservationRefusal(wrapped('Historical assignment evidence requires reconciliation'))).toMatch(/needs review in Employment Movement/);
  expect(payrollPreservationRefusal(new Error('something else'))).toBeNull();
 });
});
