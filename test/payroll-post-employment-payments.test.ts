import {afterAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import * as S from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {createBatch,createAdditionalRun,generatePayslips,preProcessAdvisory,batchScopeHeadcount,reprocessSelectedEmployees,removeEmployeePayroll} from '../core/payroll';
import {seedPayrollCycleCatalog,listPayrollCycles} from '../core/payroll-cycle';
import {createIndividualTxn} from '../core/payroll-individual-txn';
import {setEmploymentPayComponent} from '../core/pay-components';
import {listEmployeesForPayrollRun} from '../core/read';
import {closeAll,entitledCtx,owner,resetDb,seedBase,setModule,setSetting,type Base} from './harness';
let b:Base,ctx:SessionContext,employmentId:string,personId:string,reimbursement:string,monthly:string;
async function outstanding(cycleId=monthly){
 const overtime=await createIndividualTxn(ctx,{companyId:b.companyId,payPeriod:'2026-11',intendedCycleId:cycleId,employmentId,kind:'overtime',txnDate:'2026-10-10',amount:300});
 const expense=await createIndividualTxn(ctx,{companyId:b.companyId,payPeriod:'2026-11',intendedCycleId:cycleId,employmentId,kind:'earning',componentId:reimbursement,txnDate:'2026-10-12',amount:180});
 return[overtime.id,expense.id];
}
async function result(batchId:string){return(await owner.db.select().from(S.payslip).where(eq(S.payslip.batchId,batchId)))[0];}
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'typed_pay_components','active');await setModule(b.tenantId,'multi_cycle_payroll','active');await setSetting(b.tenantId,'payroll.individual_txn_pay_enabled',true);await setSetting(b.tenantId,'payroll.reset_enabled',true);ctx=await entitledCtx(b);
 await seedPayrollCycleCatalog(ctx,b.companyId);monthly=(await listPayrollCycles(ctx,b.companyId)).find(c=>c.runType==='regular')!.id;
 const e=await hireEmployee(ctx,{person:{fullName:'Fictional former employee',primaryEmail:'former-payment@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:'CHCE0067',hiredOn:'2026-01-01'});employmentId=e.employmentId;personId=e.personId;
 await setCompensation(ctx,{employmentId,basicSalary:5000,monthlyAllowance:900,effectiveFrom:'2026-01-01'});await setStatutoryProfileMY(ctx,{personId,icNumber:'850202025555',taxCategory:1,numChildren:0});
 const [item]=await owner.db.insert(S.payComponent).values({tenantId:b.tenantId,code:'EXPENSE',name:'Fictional reimbursement',kind:'allowance',displayCategory:'allowance',includedInPcb:false,includedInEpf:false,includedInSocsoEis:false,prorates:true}).returning();reimbursement=item.id;
 await setEmploymentPayComponent(ctx,{employmentId,componentId:reimbursement,amount:700,effectiveFrom:'2026-01-01'});
 await owner.db.update(S.employment).set({terminatedOn:'2026-10-13',resignationDate:'2026-10-13',lastWorkingDate:'2026-10-13'}).where(eq(S.employment.id,employmentId));
});
afterAll(closeAll);
describe('source-owned outstanding payments after resignation',()=>{
 it('offers only eligible outstanding payees and pays explicit items without recurring salary or allowance',async()=>{
  expect(await listEmployeesForPayrollRun(ctx,b.companyId,'2026-11',monthly)).toHaveLength(0);
  const sources=await outstanding();const candidates=await listEmployeesForPayrollRun(ctx,b.companyId,'2026-11',monthly);expect(candidates.map(e=>e.employmentId)).toEqual([employmentId]);expect(candidates[0].outstandingOnly).toBe(true);
  const run=await createBatch(ctx,{companyId:b.companyId,payPeriod:'2026-11',payrollCycleId:monthly});expect(await batchScopeHeadcount(ctx,run.batchId)).toBe(1);expect((await preProcessAdvisory(ctx,run.batchId)).missingCompensation).toEqual([]);
  await generatePayslips(ctx,{batchId:run.batchId});const sl=await result(run.batchId);expect(Number(sl.basicSalary)).toBe(0);expect(Number(sl.allowance)).toBe(180);expect(Number(sl.overtimePay)).toBe(300);expect(Number(sl.grossPay)).toBe(480);expect(sl.daysWorked).toBe('0');
  expect(sl.statutory).toMatchObject({postEmploymentPayment:{endedOn:'2026-10-13',sourceTxnIds:expect.arrayContaining(sources)}});
  const txns=await owner.db.select().from(S.payrollIndividualTxn);expect(txns.every(t=>t.consumedBatchId===run.batchId)).toBe(true);
  const [emp]=await owner.db.select().from(S.employment).where(eq(S.employment.id,employmentId));expect(emp.terminatedOn).toBe('2026-10-13');
  const beforeNet=sl.netPay;await reprocessSelectedEmployees(ctx,{batchId:run.batchId,employmentIds:[employmentId],idempotencyKey:randomUUID()});const after=await result(run.batchId);expect(after.version).toBe(2);expect(after.netPay).toBe(beforeNet);expect(Number(after.grossPay)).toBe(480);
  expect(await listEmployeesForPayrollRun(ctx,b.companyId,'2026-11',monthly)).toHaveLength(0);
 });
 it('honours exact named off-cycle identity and still pays overtime/reimbursement rather than ordinary salary',async()=>{
  const cycles=await listPayrollCycles(ctx,b.companyId),off=cycles.find(c=>c.runType==='off_cycle')!,other=cycles.find(c=>c.runType==='off_cycle'&&c.id!==off.id)!;
  await outstanding(off.id);expect(await listEmployeesForPayrollRun(ctx,b.companyId,'2026-11',other.id)).toHaveLength(0);expect(await listEmployeesForPayrollRun(ctx,b.companyId,'2026-11',monthly)).toHaveLength(0);
  const run=await createAdditionalRun(ctx,{companyId:b.companyId,payPeriod:'2026-11',runType:'off_cycle',payrollCycleId:off.id});await generatePayslips(ctx,{batchId:run.batchId});expect(Number((await result(run.batchId)).grossPay)).toBe(480);expect(Number((await result(run.batchId)).basicSalary)).toBe(0);
 });
 it('fails closed on missing historical pay provenance and rolls back attachment and consumption',async()=>{
  const sources=await outstanding();await owner.db.update(S.compensation).set({validFrom:'2026-11-01'}).where(eq(S.compensation.employmentId,employmentId));
  const run=await createBatch(ctx,{companyId:b.companyId,payPeriod:'2026-11',payrollCycleId:monthly});expect((await preProcessAdvisory(ctx,run.batchId)).missingCompensation.map(e=>e.employmentId)).toEqual([employmentId]);await expect(generatePayslips(ctx,{batchId:run.batchId})).rejects.toThrow();
  expect(await result(run.batchId)).toBeUndefined();expect((await owner.db.select().from(S.payrollIndividualTxn)).every(t=>t.batchId===null&&t.consumedBatchId===null)).toBe(true);
 });
 it('does not expose another tenant or treat a record-only or later-period item as payment eligibility',async()=>{
  await createIndividualTxn(ctx,{companyId:b.companyId,payPeriod:'2026-12',intendedCycleId:monthly,employmentId,kind:'overtime',txnDate:'2026-10-10',amount:100});
  expect(await listEmployeesForPayrollRun(ctx,b.companyId,'2026-11',monthly)).toHaveLength(0);
  expect(await listEmployeesForPayrollRun({...ctx,tenantId:randomUUID()},b.companyId,'2026-12',monthly)).toHaveLength(0);
 });
 it('keeps ordinary resignation-month proration while later payments cannot reinstate salary',async()=>{
  const run=await createBatch(ctx,{companyId:b.companyId,payPeriod:'2026-10',payrollCycleId:monthly});await generatePayslips(ctx,{batchId:run.batchId});const sl=await result(run.batchId);expect(Number(sl.basicSalary)).toBe(2096.77);expect(sl.statutory).not.toHaveProperty('postEmploymentPayment');
 });
});
