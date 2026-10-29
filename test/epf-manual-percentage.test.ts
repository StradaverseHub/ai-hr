import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createBatch,generatePayslips} from '../core/payroll';
import {getStatutoryProfileMY,setStatutoryProfileMY,InvalidEpfElectionError} from '../localization/my/statutory';
import {mapEpfUiMode} from '../lib/epf-mode-map';
import {todayInKualaLumpur} from '../lib/hr-date';
import {payslip} from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

describe('5e204d56 manual percentage persistence and payroll',()=>{
 let base:Base;
 const today=todayInKualaLumpur(),period=today.slice(0,7),start=today.slice(0,4)+'-01-01';
 beforeAll(migrateTestDb);
 beforeEach(async()=>{await resetDb();base=await seedBase();});
 afterAll(closeAll);
 const hire=()=>hireEmployee(adminCtx(base),{person:{fullName:'Manual percentage fixture',primaryEmail:'manual-percentage@example.invalid'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:start});
 it('saves, reopens and generates the independently expected below-schedule contributions',async()=>{
  const a=adminCtx(base),employee=await hire();
  await setCompensation(a,{employmentId:employee.employmentId,basicSalary:6000,monthlyAllowance:0,effectiveFrom:start});
  await setStatutoryProfileMY(a,{personId:employee.personId,icNumber:'900101011234',...mapEpfUiMode('manual_percentage','5.5','6.5')});
  const saved=await getStatutoryProfileMY(a,employee.personId);
  expect(saved).toMatchObject({epfMode:'manual_percentage',epfEmployeeRate:'0.0550',epfEmployerRate:'0.0650'});
  const {batchId}=await createBatch(a,{companyId:base.companyId,payPeriod:period});
  await generatePayslips(a,{batchId});
  const rows=await owner.db.select().from(payslip).where(eq(payslip.batchId,batchId)).orderBy(payslip.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].statutory).toMatchObject({epfMode:'manual_percentage',epfEmployee:330,epfEmployer:390});
 });
 it('rejects missing or invalid rates without changing the existing election',async()=>{
  const a=adminCtx(base),employee=await hire();
  await setStatutoryProfileMY(a,{personId:employee.personId,icNumber:'900101011234',epfMode:'voluntary_excess',epfEmployeeRate:.15,epfEmployerRate:.16});
  for(const [ee,er]of[[null,.1],[.1,null],[null,null],[.0099,.1],[.1,1.0001],[NaN,.1]] as const){
   await expect(setStatutoryProfileMY(a,{personId:employee.personId,icNumber:'900101011234',epfMode:'manual_percentage',epfEmployeeRate:ee,epfEmployerRate:er})).rejects.toBeInstanceOf(InvalidEpfElectionError);
  }
  expect(await getStatutoryProfileMY(a,employee.personId)).toMatchObject({epfMode:'voluntary_excess',epfEmployeeRate:'0.1500',epfEmployerRate:'0.1600'});
 });
 it('does not convert an existing top-up when its displayed selection is saved',async()=>{
  const a=adminCtx(base),employee=await hire();
  await setStatutoryProfileMY(a,{personId:employee.personId,icNumber:'900101011234',epfMode:'voluntary_excess',epfEmployeeRate:.15,epfEmployerRate:.16});
  await setStatutoryProfileMY(a,{personId:employee.personId,icNumber:'900101011234',...mapEpfUiMode('voluntary_percentage','15','16')});
  expect(await getStatutoryProfileMY(a,employee.personId)).toMatchObject({epfMode:'voluntary_excess',epfEmployeeRate:'0.1500',epfEmployerRate:'0.1600'});
 });
});
