/**
 * Payroll Reconciliation's "Comparison results" link opens one employee's comparison of every recorded pay item.
 * Production 16 Nov 2026 (52 companies): that one-row link refused with "This comparison has too many employee and
 * pay item combinations", because the saved results of EVERY employee in scope were read and multiplied by every pay
 * item before the employee filter applied. The employee's own results are now the only detail read; each run's
 * completeness is still checked over the whole run. Fictional companies and employees; real payroll runs.
 */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {type SessionContext,withTenant} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {runPayrollComparisonReport} from '../core/custom-reports';
import {payrollComparisonSourcesTx} from '../core/payroll-view';
import {closeBatch,createBatch,generatePayslips} from '../packs/payroll/service';
import {requirePackFor} from '../localization/registry';
import {todayInKualaLumpur} from '../lib/hr-date';
import {ALL_RECORDED_PAY_ITEMS,previousPayrollComparisonPeriod} from '../lib/payroll-period-comparison';
import {closeAll,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base,ctx:SessionContext,previousPeriod:string,currentPeriod:string,second:string;
const employments:string[]=[],runs:string[]=[];

async function employee(companyId:string,departmentId:string,i:number,basic:number){
 const hired=await hireEmployee(ctx,{person:{fullName:'Fictional Scope '+i,primaryEmail:randomUUID()+'@fixture.test'},companyId,
  departmentId,employmentType:'full_time',employeeCode:'SCOPE-'+i,hiredOn:previousPeriod+'-01'});
 await setCompensation(ctx,{employmentId:hired.employmentId,basicSalary:basic,effectiveFrom:previousPeriod+'-01'});
 await requirePackFor('MY').statutory.set(ctx,{personId:hired.personId,icNumber:'900101011'+String(100+i)});
 employments.push(hired.employmentId);
}
const reconciliation=(filters:Record<string,unknown>)=>
 runPayrollComparisonReport(ctx,[b.companyId,second],{id:'reconciliation',verb:'view',
  filters:{currentPeriod,previousPeriod,payItemCode:ALL_RECORDED_PAY_ITEMS,onlyVariances:'0',pageSize:200,...filters}});

beforeAll(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'typed_pay_components','disabled');
 ctx={...await entitledCtx(b),grants:[{role:'hr_admin',companyId:null}]};
 currentPeriod=previousPayrollComparisonPeriod(todayInKualaLumpur().slice(0,7));previousPeriod=previousPayrollComparisonPeriod(currentPeriod);
 const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional Scope Two Sdn Bhd'}).returning({id:s.company.id});second=company.id;
 const [dept]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:second,name:'Finance'}).returning({id:s.department.id});
 await employee(b.companyId,b.deptA,1,3000);await employee(b.companyId,b.deptA,2,3600);await employee(b.companyId,b.deptA,3,4100);
 await employee(second,dept.id,4,5200);
 await setCompensation(ctx,{employmentId:employments[1],basicSalary:3900,effectiveFrom:currentPeriod+'-01'}); // a real variance
 for(const companyId of [b.companyId,second])for(const period of [previousPeriod,currentPeriod]){
  const created=await createBatch(ctx,{companyId,payPeriod:period});runs.push(created.batchId);
  await generatePayslips(ctx,{batchId:created.batchId});await closeBatch(ctx,{batchId:created.batchId});
 }
},180_000);
afterAll(closeAll);

describe('one employee\'s payroll comparison',()=>{
 it('reads only that employee\'s saved results',async()=>{
  const read=(employmentId?:string)=>withTenant(ctx,tx=>payrollComparisonSourcesTx(tx,ctx,{companyIds:[b.companyId,second],previousPeriod,currentPeriod,
   runType:'regular',payItemCode:ALL_RECORDED_PAY_ITEMS,...(employmentId?{employmentId}:{})}));
  const everyone=await read(),one=await read(employments[1]);
  expect(everyone.sources).toHaveLength(8);                          // 4 employees x 2 periods
  expect(one.sources).toHaveLength(2);
  expect(new Set(one.sources.map(source=>source.employmentId))).toEqual(new Set([employments[1]]));
  expect(one.runs).toEqual(everyone.runs);                            // run facts are not narrowed
  expect(one.sources).toEqual(everyone.sources.filter(source=>source.employmentId===employments[1]));
 });

 it('gives the same rows, totals and counts as the unscoped comparison filtered to the employee',async()=>{
  for(const employmentId of employments){
   const scoped=await reconciliation({employmentId});
   expect(scoped.result.available).toBe(true);
   const rows=scoped.result.rows;
   expect(rows.length).toBeGreaterThan(0);
   expect(new Set(rows.map(row=>row.employmentId))).toEqual(new Set([employmentId]));
   // Independent expectation for BASIC from the stored payslips.
   const basic=rows.find(row=>row.payItemCode==='BASIC');
   const slips=await owner.db.select({period:s.payrollBatch.payPeriod,basic:s.payslip.basicSalary}).from(s.payslip)
    .innerJoin(s.payrollBatch,eq(s.payrollBatch.id,s.payslip.batchId)).where(eq(s.payslip.employmentId,employmentId));
   const at=(period:string)=>slips.find(slip=>slip.period===period)!.basic;
   expect(Number(basic!.current)).toBeCloseTo(Number(at(currentPeriod)),2);
   expect(Number(basic!.previous)).toBeCloseTo(Number(at(previousPeriod)),2);
  }
  // The employee with the salary change has a BASIC variance of 300.00.
  const changed=await reconciliation({employmentId:employments[1]});
  expect(Number(changed.result.rows.find(row=>row.payItemCode==='BASIC')!.variance)).toBeCloseTo(300,2);
 });

 it('still refuses when a run is incomplete, even though the employee\'s own results are all there',async()=>{
  // Remove another employee's current-period payslip from the first company's closed run (fixture only).
  const [current]=await owner.db.select({id:s.payrollBatch.id}).from(s.payrollBatch)
   .where(and(eq(s.payrollBatch.companyId,b.companyId),eq(s.payrollBatch.payPeriod,currentPeriod)));
  await owner.db.execute(`alter table payslip disable trigger user`);
  try{
   await owner.db.delete(s.payslip).where(and(eq(s.payslip.batchId,current.id),eq(s.payslip.employmentId,employments[2])));
  }finally{await owner.db.execute(`alter table payslip enable trigger user`);}
  await expect(withTenant(ctx,tx=>payrollComparisonSourcesTx(tx,ctx,{companyIds:[b.companyId],previousPeriod,currentPeriod,
   runType:'regular',payItemCode:ALL_RECORDED_PAY_ITEMS,employmentId:employments[0]}))).rejects.toThrow(/incomplete/);
 });
});
