import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {PDFDocument} from 'pdf-lib';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee,terminateEmployment} from '../core/org';
import {createMovementEvent,movementHistory,reverseMovementEvent} from '../core/movement';
import {payslipForReview} from '../core/payroll-view';
import {buildPayslipPdfData,renderPayslipPdf} from '../lib/payslip-pdf';
import {isDatabaseError} from '../lib/db-error';
import {todayInKualaLumpur} from '../lib/hr-date';
import {labels as pdfLabels} from './fixtures/payslip-pdf-fixture';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const day=(n:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const hire=()=>hireEmployee(adminCtx(b),{person:{fullName:'Fictional closed-payroll exit',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
async function closedSlip(id:string){
 const [period]=await owner.db.insert(s.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period:'2026-06',status:'closed'}).returning();
 const [batch]=await owner.db.insert(s.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:period.id,payPeriod:'2026-06',batchDate:'2026-06-25',status:'closed',releasedAt:new Date('2026-06-25T00:00:00Z')}).returning();
 const [slip]=await owner.db.insert(s.payslip).values({tenantId:b.tenantId,batchId:batch.id,employmentId:id,basicSalary:'3000.00',grossPay:'3000.00',statutory:{epfEmployee:330,epfEmployer:390},totalDeductions:'330.00',netPay:'2670.00',employerCost:'3390.00'}).returning();return{batch,slip};
}
const repair=readFileSync('db/migrations/0729_movement_exit_payroll_preservation.sql','utf8');
async function installRepair(){for(const block of repair.split('--> statement-breakpoint'))if(block.trim())await owner.client.unsafe(block);}
describe('646355e5 — ended employment retains finalised payroll before correction',()=>{
 it('upgrades the populated strict helper and restores the employee while keeping the payslip document byte-identical',async()=>{
  const {employmentId}=await hire(),ctx=adminCtx(b);
  await createMovementEvent(ctx,{employmentId,kind:'termination',effectiveDate:'2026-06-20',endDate:'2026-06-20',terminationReasonCode:'resignation',resignationDate:'2026-06-01'});
  const movement=(await movementHistory(ctx,employmentId)).find(row=>row.kind==='resignation')!;
  const {slip,batch}=await closedSlip(employmentId);
  expect(await owner.db.select().from(s.assignment).where(and(eq(s.assignment.employmentId,employmentId),sql`${s.assignment.validTo} is null`))).toHaveLength(0);
  const before=await payslipForReview(ctx,{companyIds:[b.companyId],payslipId:slip.id});expect(before).toBeTruthy();
  async function document(row:NonNullable<typeof before>){
   const data=buildPayslipPdfData({...row,employee:row.employeeName},{epf:'EPF',socso:'SOCSO',skbbk:'SKBBK',eis:'EIS',tax:'PCB'},{currency:row.currency,jobGrade:row.jobGrade,employmentType:row.employmentType});
   const bytes=await renderPayslipPdf(data,pdfLabels),pdf=await PDFDocument.load(bytes,{updateMetadata:false});pdf.setCreationDate(new Date(0));pdf.setModificationDate(new Date(0));return Buffer.from(await pdf.save({useObjectStreams:false}));
  }
  const pdfBefore=await document(before!);expect(pdfBefore.length).toBeGreaterThan(1000);
  const original=readFileSync('db/migrations/0698_information_only_corrections.sql','utf8'),start=original.indexOf('CREATE FUNCTION app.preserve_information_payroll'),end=original.indexOf('--> statement-breakpoint',start);
  expect(end).toBeGreaterThan(start+1000);
  try{
   await owner.client.unsafe(original.slice(start,end).replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION'));
   let failure:unknown;
   try{await reverseMovementEvent(ctx,{employmentId,movementId:movement.id,reason:'Fictional incorrect exit',acknowledgeClosedPayroll:true});}catch(error){failure=error;}
   expect(isDatabaseError(failure,'P0002')).toBe(true);
   expect(await owner.db.select().from(s.informationPayslipSnapshot).where(eq(s.informationPayslipSnapshot.employmentId,employmentId))).toHaveLength(0);
  }finally{await installRepair();}
  await reverseMovementEvent(ctx,{employmentId,movementId:movement.id,reason:'Fictional incorrect exit',acknowledgeClosedPayroll:true});
  const [employee]=await owner.db.select().from(s.employment).where(eq(s.employment.id,employmentId));expect(employee.terminatedOn).toBeNull();
  expect((await movementHistory(ctx,employmentId)).find(row=>row.id===movement.id)?.status).toBe('reversed');
  expect((await owner.db.select().from(s.payslip).where(eq(s.payslip.id,slip.id)))[0]).toEqual(slip);
  expect((await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batch.id)))[0]).toEqual(batch);
  const after=await payslipForReview(ctx,{companyIds:[b.companyId],payslipId:slip.id});expect(after).toEqual(before);expect(await document(after!)).toEqual(pdfBefore);
 });
 it('refuses to invent original metadata after a legacy primary-only exit changed status after closure',async()=>{
  const {employmentId}=await hire(),ctx=adminCtx(b),{slip}=await closedSlip(employmentId);
  await terminateEmployment(ctx,{employmentId,terminationDate:day(-2),terminationReason:'Fictional legacy direct exit'});
  const [ready]=await withTenant(ctx,tx=>tx.execute<{ready:boolean}>(sql`select app.information_payroll_ready(${employmentId}::uuid) as ready`));expect(ready.ready).toBe(false);
  await expect(withTenant(ctx,tx=>tx.execute(sql`select app.preserve_information_payroll(${employmentId}::uuid)`))).rejects.toThrow();
  expect(await owner.db.select().from(s.informationPayslipSnapshot).where(eq(s.informationPayslipSnapshot.employmentId,employmentId))).toHaveLength(0);
  expect((await owner.db.select().from(s.payslip).where(eq(s.payslip.id,slip.id)))[0]).toEqual(slip);
 });
});
