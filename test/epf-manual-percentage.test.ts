import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createBatch,generatePayslips} from '../core/payroll';
import {getStatutoryProfileMY,setStatutoryProfileMY,InvalidEpfElectionError} from '../localization/my/statutory';
import {mapEpfUiMode,retainLegacyTotalTopup} from '../lib/epf-mode-map';
import {clientPackFor} from '../localization/registry.client';
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
 it.each(['14','11','14.5','14.01'])('d670e4d6 keeps %s stable through persisted percentage save/reopen cycles',async value=>{
  const a=adminCtx(base),employee=await hire(),display=clientPackFor('MY')!.payroll.epfRateToPercent!;
  let employeeInput=value,employerInput=value;
  for(let round=0;round<3;round++){
   await setStatutoryProfileMY(a,{personId:employee.personId,icNumber:'900101011234',...mapEpfUiMode('manual_percentage',employeeInput,employerInput)});
   const saved=await getStatutoryProfileMY(a,employee.personId);
   expect(saved).toMatchObject({epfMode:'manual_percentage',epfEmployeeRate:(Number(value)/100).toFixed(4),epfEmployerRate:(Number(value)/100).toFixed(4)});
   employeeInput=String(display(saved!.epfEmployeeRate));employerInput=String(display(saved!.epfEmployerRate));
   expect(employeeInput).toBe(value);expect(employerInput).toBe(value);
  }
 });
 it('d670e4d6 preserves persisted Semi-Auto employee decimals without adding an employer election',async()=>{
  const a=adminCtx(base),employee=await hire(),display=clientPackFor('MY')!.payroll.epfRateToPercent!;
  let value='14.01';
  for(let round=0;round<3;round++){
   await setStatutoryProfileMY(a,{personId:employee.personId,icNumber:'900101011234',...mapEpfUiMode('semi_auto',value,null)});
   const saved=await getStatutoryProfileMY(a,employee.personId);
   expect(saved).toMatchObject({epfMode:'voluntary_excess',epfEmployeeRate:'0.1401',epfEmployerRate:null});
   value=String(display(saved!.epfEmployeeRate));expect(value).toBe('14.01');
  }
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
  // b6dbadc5 — the writers re-post a stored legacy total-rate row through retainLegacyTotalTopup: the same
  // figures keep the legacy election; any other figure is saved as an additive top-up.
  let current=await getStatutoryProfileMY(a,employee.personId);
  await setStatutoryProfileMY(a,{personId:employee.personId,icNumber:'900101011234',...retainLegacyTotalTopup(mapEpfUiMode('voluntary_percentage','15','16'),current)});
  expect(await getStatutoryProfileMY(a,employee.personId)).toMatchObject({epfMode:'voluntary_excess',epfEmployeeRate:'0.1500',epfEmployerRate:'0.1600'});
  current=await getStatutoryProfileMY(a,employee.personId);
  await setStatutoryProfileMY(a,{personId:employee.personId,icNumber:'900101011234',...retainLegacyTotalTopup(mapEpfUiMode('voluntary_percentage','1','0'),current)});
  expect(await getStatutoryProfileMY(a,employee.personId)).toMatchObject({epfMode:'topup_percentage',epfEmployeeRate:'0.0100',epfEmployerRate:'0.0000'});
  await expect(setStatutoryProfileMY(a,{personId:employee.personId,icNumber:'900101011234',...mapEpfUiMode('voluntary_percentage','90','')})).rejects.toBeInstanceOf(InvalidEpfElectionError);
  expect(await getStatutoryProfileMY(a,employee.personId)).toMatchObject({epfMode:'topup_percentage',epfEmployeeRate:'0.0100',epfEmployerRate:'0.0000'});
 });
});
