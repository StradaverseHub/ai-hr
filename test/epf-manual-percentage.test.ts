import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createAdditionalRun,createBatch,generatePayslips,setPayrollInput} from '../core/payroll';
import {getStatutoryProfileMY,setStatutoryProfileMY,InvalidEpfElectionError} from '../localization/my/statutory';
import {mapEpfUiMode,retainLegacyTotalTopup} from '../lib/epf-mode-map';
import {clientPackFor} from '../localization/registry.client';
import {todayInKualaLumpur} from '../lib/hr-date';
import {payslip} from '../db/schema';
import {explainStatutory} from '../core/statutory-explain';
import {epfWorkingRows} from '../app/payroll/statutory-detail/epf-working';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

describe('5e204d56 manual percentage persistence and payroll',()=>{
 let base:Base;
 const today=todayInKualaLumpur(),period=today.slice(0,7),start=today.slice(0,4)+'-01-01';
 beforeAll(migrateTestDb);
 beforeEach(async()=>{await resetDb();base=await seedBase();});
 afterAll(closeAll);
 const hire=()=>hireEmployee(adminCtx(base),{person:{fullName:'Manual percentage fixture',primaryEmail:'manual-percentage@example.invalid'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:start});
 it('saves, reopens and generates the independently expected below-schedule contributions',async()=>{
  const a=adminCtx(base),employee=await hire();
  await setCompensation(a,{employmentId:employee.employmentId,basicSalary:6001.10,monthlyAllowance:35.75,effectiveFrom:start});
  await setStatutoryProfileMY(a,{personId:employee.personId,icNumber:'900101011234',...mapEpfUiMode('manual_percentage','5.5','6.5')});
  const saved=await getStatutoryProfileMY(a,employee.personId);
  expect(saved).toMatchObject({epfMode:'manual_percentage',epfEmployeeRate:'0.0550',epfEmployerRate:'0.0650'});
  const {batchId}=await createBatch(a,{companyId:base.companyId,payPeriod:period});
  await generatePayslips(a,{batchId});
  const rows=await owner.db.select().from(payslip).where(eq(payslip.batchId,batchId)).orderBy(payslip.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].statutory).toMatchObject({
   epfMode:'manual_percentage',epfEmployee:336,epfEmployer:397,
   epfWorking:{
    actualWage:6036.85,roundedWage:6100,increment:100,
    items:[{label:'Basic salary',amount:6001.10},{label:'Allowance',amount:35.75}],
    employee:{method:'entered_rate',rate:0.055,amount:336},
    employer:{method:'entered_rate',rate:0.065,amount:397},
    employeeThisRun:336,employerThisRun:397,
   },
  });
  expect(rows[0].statutory).not.toHaveProperty('epfWorking.employeeEarlierRuns');
 });
 it('1058ced1 saves employee 0% / employer 4%, reopens 0 as 0 (not blank) and pays exactly those percentages',async()=>{
  const a=adminCtx(base),employee=await hire(),display=clientPackFor('MY')!.payroll.epfRateToPercent!;
  await setCompensation(a,{employmentId:employee.employmentId,basicSalary:6000,monthlyAllowance:0,effectiveFrom:start});
  await setStatutoryProfileMY(a,{personId:employee.personId,icNumber:'900101011234',...mapEpfUiMode('manual_percentage','0','4')});
  const saved=await getStatutoryProfileMY(a,employee.personId);
  expect(saved).toMatchObject({epfMode:'manual_percentage',epfEmployeeRate:'0.0000',epfEmployerRate:'0.0400'});
  expect(String(display(saved!.epfEmployeeRate))).toBe('0');expect(String(display(saved!.epfEmployerRate))).toBe('4');
  const {batchId}=await createBatch(a,{companyId:base.companyId,payPeriod:period});
  await generatePayslips(a,{batchId});
  const rows=await owner.db.select().from(payslip).where(eq(payslip.batchId,batchId)).orderBy(payslip.id);
  expect(rows).toHaveLength(1);
  expect(rows[0].statutory).toMatchObject({epfMode:'manual_percentage',epfEmployee:0,epfEmployer:240});
 });
 it('records earlier paid EPF separately from the additional run, including a genuine zero',async()=>{
  await setModule(base.tenantId,'multi_cycle_payroll','active');
  const a=await entitledCtx(base),employee=await hire();
  await setCompensation(a,{employmentId:employee.employmentId,basicSalary:6000,effectiveFrom:start});
  await setStatutoryProfileMY(a,{personId:employee.personId,icNumber:'900101011234',...mapEpfUiMode('manual_percentage','0','4')});
  const regular=await createBatch(a,{companyId:base.companyId,payPeriod:period});
  await generatePayslips(a,{batchId:regular.batchId});
  const additional=await createAdditionalRun(a,{companyId:base.companyId,payPeriod:period,runType:'bonus'});
  await setPayrollInput(a,{batchId:additional.batchId,employmentId:employee.employmentId,overtimeAmount:0,bonusAmount:250});
  await generatePayslips(a,{batchId:additional.batchId});
  const [slip]=await owner.db.select().from(payslip).where(eq(payslip.batchId,additional.batchId));
  expect(slip.statutory).toMatchObject({
   epfEmployee:0,epfEmployer:12,
   epfWorking:{actualWage:6250,roundedWage:6300,employeeEarlierRuns:0,employerEarlierRuns:240,
    employeeThisRun:0,employerThisRun:12},
  });
 });
 it('keeps the saved Top-up formula and prior charges together for the screen and export', async () => {
  await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
  const a = await entitledCtx(base), employee = await hire();
  await setCompensation(a, { employmentId: employee.employmentId, basicSalary: 6000, effectiveFrom: start });
  await setStatutoryProfileMY(a, {
   personId: employee.personId, icNumber: '900101011234',
   ...mapEpfUiMode('voluntary_percentage', '5', ''),
  });
  const regular = await createBatch(a, { companyId: base.companyId, payPeriod: period });
  await generatePayslips(a, { batchId: regular.batchId });
  const additional = await createAdditionalRun(a, { companyId: base.companyId, payPeriod: period, runType: 'bonus' });
  await setPayrollInput(a, { batchId: additional.batchId, employmentId: employee.employmentId, overtimeAmount: 0, bonusAmount: 250 });
  await generatePayslips(a, { batchId: additional.batchId });
  const [slip] = await owner.db.select().from(payslip).where(eq(payslip.batchId, additional.batchId));
  const { epfWorking } = explainStatutory(slip.statutory, 'bonus');
  expect(epfWorking).toMatchObject({
   category: 'topup_percentage', actualWage: 6250,
   employee: { savedRate: 0.05, rate: 0.16, amount: 1000 },
   employer: { savedRate: null, statutoryAmount: 756, amount: 756 },
   employeeEarlierRuns: 960, employerEarlierRuns: 720,
   employeeThisRun: 40, employerThisRun: 36, finalEmployee: 40, finalEmployer: 36,
  });
  const rows = epfWorkingRows(epfWorking!, key => key, amount => String(amount), 'en-MY');
  expect(rows).toContainEqual({ label: 'epfTopupFormula', value: '6250 × 16% → 1000' });
  expect(rows.some(row => row.label === 'epfRoundedWage')).toBe(false);
 });
 it('1058ced1 the database rule accepts 0 and 100% and still refuses below 0, above 100% and blank',async()=>{
  const a=adminCtx(base),employee=await hire();
  await setStatutoryProfileMY(a,{personId:employee.personId,icNumber:'900101011234',...mapEpfUiMode('manual_percentage','5','5')});
  const write=(employeeRate:string|null,employerRate:string|null)=>owner.db.execute(sql`update employee_statutory_my set epf_employee_rate=${employeeRate}::numeric,epf_employer_rate=${employerRate}::numeric where person_id=${employee.personId}`);
  const refusal=async(employeeRate:string|null,employerRate:string|null)=>{
   try{await write(employeeRate,employerRate);return 'accepted';}
   catch(e){const err=e as {message?:string;constraint_name?:string;cause?:{message?:string;constraint_name?:string}};return [err.constraint_name,err.cause?.constraint_name,err.message,err.cause?.message].join(' ');}
  };
  expect(await refusal('0','0')).toBe('accepted');expect(await refusal('1','0')).toBe('accepted');
  for(const [employeeRate,employerRate] of [['-0.0001','0'],['0','1.0001'],[null,'0.04'],['0.04',null]] as const)
   expect(await refusal(employeeRate,employerRate)).toMatch(/employee_statutory_my_manual_percentage_rates/);
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
  for(const [ee,er]of[[null,.1],[.1,null],[null,null],[-.0001,.1],[.1,1.0001],[NaN,.1]] as const){
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
