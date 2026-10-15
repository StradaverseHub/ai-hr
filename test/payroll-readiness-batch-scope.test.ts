/** Actual owner reads, not a second scope implementation. UNRUN until coordinated DB window. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {adminCtx,closeAll,migrateTestDb,resetDb,seedBase,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createCompany,createDepartment} from '../core/admin';
import {createMovementEvent} from '../core/movement';
import {createIndividualTxn} from '../core/payroll-individual-txn';
import {createBatch,preProcessAdvisory,type BatchScope} from '../core/payroll';
import {upsertPayrollCycle} from '../core/payroll-cycle';
import {payrollReadiness,type PayrollReadiness,type ReadinessCheckKey} from '../core/payroll-readiness';
let b:Base;const period='2026-05';
const check=(result:PayrollReadiness,key:ReadinessCheckKey)=>result.checks.find(row=>row.key===key)!;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function hire(name:string,departmentId=b.deptA){return hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@batch-readiness.test'},companyId:b.companyId,departmentId,employmentType:'full_time',hiredOn:'2026-01-01'});}
async function salary(employmentId:string,payMode:'monthly'|'custom_period'='monthly'){await setCompensation(adminCtx(b),{employmentId,basicSalary:3500,effectiveFrom:'2026-01-01',payMode});}
const report=(scope?:BatchScope|null)=>payrollReadiness(adminCtx(b),{companyId:b.companyId,payPeriod:period,scope});
describe('Payroll readiness uses the actual batch population',()=>{
 it('matches scoped pre-checks before/after salary, while Settings still reports excluded defects',async()=>{
  const selected=await hire('Selected recipient'),excluded=await hire('Excluded missing salary'),unsupported=await hire('Excluded unsupported mode');
  await salary(unsupported.employmentId,'custom_period');
  await upsertPayrollCycle(adminCtx(b),{companyId:b.companyId,name:'Monthly',runType:'regular'});
  const scope={employmentIds:[selected.employmentId]},batch=await createBatch(adminCtx(b),{companyId:b.companyId,payPeriod:period,scope});
  expect((await preProcessAdvisory(adminCtx(b),batch.batchId)).missingCompensation.map(row=>row.employmentId)).toEqual([selected.employmentId]);
  expect(check(await report(scope),'masterData').detail).toMatchObject({total:1,missingCompensation:1});
  await salary(selected.employmentId);
  const scoped=await report(scope),actual=await preProcessAdvisory(adminCtx(b),batch.batchId);
  expect(actual.missingCompensation).toEqual([]);expect(actual.unpayablePayMode).toEqual([]);
  expect(check(scoped,'masterData').detail).toMatchObject({total:1,missingCompensation:0});
  expect(check(scoped,'payModes')).toMatchObject({status:'ok',detail:{unpayable:0}});expect(scoped.blockers).toBe(0);expect(check(scoped,'payrollCycle').status).toBe('ok');
  const company=await report();expect(check(company,'masterData').detail).toMatchObject({total:3,missingCompensation:1});
  expect(check(company,'payModes')).toMatchObject({status:'blocker',names:['Excluded unsupported mode']});
  expect(check(company,'payrollCycle')).toEqual(check(scoped,'payrollCycle'));
  expect(excluded.employmentId).not.toBe(selected.employmentId);
 });
 it('shares department/individual union and binds transaction counts to those exact IDs',async()=>{
  const department=await hire('Department recipient'),explicit=await hire('Explicit recipient',b.deptB),excluded=await hire('Excluded recipient',b.deptB);
  await salary(department.employmentId);await salary(explicit.employmentId,'custom_period');
  for(const employee of [department,explicit,excluded])await createIndividualTxn(adminCtx(b),{companyId:b.companyId,payPeriod:period,employmentId:employee.employmentId,kind:'overtime',txnDate:period+'-10',amount:1,quantity:1,unit:'hours'});
  const result=await report({departmentIds:[b.deptA],employmentIds:[explicit.employmentId,department.employmentId]});
  expect(check(result,'masterData').detail).toMatchObject({total:2,missingCompensation:0});
  expect(check(result,'payModes')).toMatchObject({status:'blocker',names:['Explicit recipient'],detail:{unpayable:1}});
  expect(check(result,'transactions').detail.entered).toBe(2);expect(check(await report(),'transactions').detail.entered).toBe(3);
 });
 it('does not broaden an empty department or another company selection to everyone',async()=>{
  const employee=await hire('Company recipient');await createIndividualTxn(adminCtx(b),{companyId:b.companyId,payPeriod:period,employmentId:employee.employmentId,kind:'overtime',txnDate:period+'-10',amount:1,quantity:1,unit:'hours'});
  const other=await createCompany(adminCtx(b),{legalName:'Fictional scope other'}),dept=await createDepartment(adminCtx(b),{companyId:other.id,name:'Other team'});
  const foreign=await hireEmployee(adminCtx(b),{person:{fullName:'Other company employee',primaryEmail:'other-'+randomUUID()+'@batch-readiness.test'},companyId:other.id,departmentId:dept.id,employmentType:'full_time',hiredOn:'2026-01-01'});
  for(const scope of [{departmentIds:[b.deptB]},{employmentIds:[foreign.employmentId]}]){
   const result=await report(scope);expect(check(result,'masterData').detail).toMatchObject({total:0,missingCompensation:0});expect(check(result,'payModes').detail.unpayable).toBe(0);expect(check(result,'transactions').detail.entered).toBe(0);
  }
 });
 it('uses recorded company membership for a transferred employee just as canonical pre-checks do',async()=>{
  const employee=await hire('Transferred selected recipient'),other=await createCompany(adminCtx(b),{legalName:'Fictional receiving company'}),department=await createDepartment(adminCtx(b),{companyId:other.id,name:'Receiving team'});
  await createMovementEvent(adminCtx(b),{employmentId:employee.employmentId,kind:'entityTransfer',effectiveDate:'2026-05-15',companyId:other.id,departmentId:department.id,remarks:'Recorded company membership regression'});
  const scope={employmentIds:[employee.employmentId]},batch=await createBatch(adminCtx(b),{companyId:b.companyId,payPeriod:period,scope});
  expect((await preProcessAdvisory(adminCtx(b),batch.batchId)).missingCompensation.map(row=>row.employmentId)).toEqual([employee.employmentId]);
  expect(check(await report(scope),'masterData').detail).toMatchObject({total:1,missingCompensation:1});
 });
});
