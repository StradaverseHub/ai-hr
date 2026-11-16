import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import * as s from '../db/schema';
import {withTenant} from '../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {lockPayrollInputsTx} from '../core/payroll-inputs-lock';
import {markWorkforcePayrollInputsChangedTx} from '../core/workforce-payroll-invalidation';
let b:Base,subject:string,peer:string;
beforeAll(migrateTestDb);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 const hire=async(name:string)=>(await hireEmployee(adminCtx(b),{person:{fullName:'Fictional '+name,primaryEmail:name+'@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'})).employmentId;
 subject=await hire('subject');peer=await hire('peer');
});
afterAll(closeAll);
async function batch(period:string,status:'processed'|'closed'='processed'){
 const [parent]=await owner.db.insert(s.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period,status:status==='closed'?'closed':'open'}).returning();
 const [run]=await owner.db.insert(s.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:parent.id,payPeriod:period,batchDate:period+'-25',status}).returning();
 await owner.db.insert(s.payslip).values([subject,peer].map(employmentId=>({tenantId:b.tenantId,batchId:run.id,employmentId,basicSalary:'3000.00',grossPay:'3000.00',netPay:'3000.00',totalDeductions:'0.00',employerCost:'3000.00',statutory:{}})));
 return run;
}
describe('Workforce invalidates only affected open payroll inputs',()=>{
 it('marks only the selected employee and date window, with closed payroll byte-identical',async()=>{
  const january=await batch('2026-01'),february=await batch('2026-02'),march=await batch('2026-03'),closed=await batch('2026-04','closed');
  const beforeSlips=await owner.db.select().from(s.payslip).orderBy(s.payslip.id);
  const count=await withTenant(adminCtx(b),async tx=>{
   await lockAccessConfigurationTx(tx,b.tenantId);await lockPayrollInputsTx(tx,{employmentIds:[subject]});
   return markWorkforcePayrollInputsChangedTx(tx,adminCtx(b),{employmentId:subject,from:'2026-02-01',until:'2026-03-01'});
  });
  expect(count).toBe(1);
  const runs=await owner.db.select().from(s.payrollBatch);
  expect(runs.find(row=>row.id===february.id)).toMatchObject({recalcEmploymentIds:[subject],needsRecalcAt:expect.any(Date)});
  for(const original of [january,march,closed])expect(runs.find(row=>row.id===original.id)).toEqual(original);
  expect(await owner.db.select().from(s.payslip).orderBy(s.payslip.id)).toEqual(beforeSlips);
 });
 it('refuses a direct call without the input-lock witness and a foreign tenant without exposing payroll',async()=>{
  const run=await batch('2026-02');
  await expect(withTenant(adminCtx(b),async tx=>{
   await lockAccessConfigurationTx(tx,b.tenantId);
   return tx.execute(sql`select app.workforce_payroll_inputs_changed(${subject}::uuid,'2026-02-01',null,'employment_information')`);
  })).rejects.toThrow();
  const other=await seedBase();
  await expect(withTenant(adminCtx(other),tx=>markWorkforcePayrollInputsChangedTx(tx,adminCtx(other),{employmentId:subject,from:'2026-02-01'}))).rejects.toThrow();
  const [unchanged]=await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,run.id));expect(unchanged).toEqual(run);
 });
});
