import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {todayInKualaLumpur} from '../lib/hr-date';
import {requirePackFor} from '../localization/registry';
import {DEFAULT_MY_STATUTORY} from '../localization/my/statutory-tables';
import {saveStatutoryRulesetMY} from '../localization/my/statutory-config';
import {hireEmployee} from '../core/org';
import {isModuleEnabled} from '../core/entitlements';
import {setCompensation} from '../core/comp';
import {createBatch,createAdditionalRun,generatePayslips,upsertPayComponent,setEmploymentPayComponent,setPayrollBatchComponent} from '../packs/payroll/service';
import {readPcbExemptions} from '../core/pcb-exemptions';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import * as schema from '../db/schema';
const year=Number(todayInKualaLumpur().slice(0,4));
const period=`${year}-01`;
const pack=requirePackFor('MY');
const benefitFlags={kind:'non_payable' as const,isNonPayable:true,prorates:false,includedInPcb:true,includedInEpf:false,includedInSocsoEis:false,includedInHrdfBase:false,pcbRemunerationType:'normal' as const,epfBonus2012:false};
const bonusFlags={kind:'allowance' as const,isNonPayable:false,prorates:false,includedInPcb:true,includedInEpf:true,includedInSocsoEis:false,includedInHrdfBase:false,pcbRemunerationType:'additional' as const,pcbExemptionCode:'PCB_TAXABLE',epfBonus2012:true};
describe('r387 retained one-off noncash exemption assessment',()=>{
 let base:Base;
 beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();base=await seedBase();await setModule(base.tenantId,'typed_pay_components','active');await setModule(base.tenantId,'multi_cycle_payroll','active');});afterAll(closeAll);
 async function setup(){
  const ctx=await entitledCtx(base);
  const employee=await hireEmployee(ctx,{person:{fullName:'Synthetic Retained Benefit',primaryEmail:`${randomUUID()}@test.local`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:`${year-1}-01-01`});
  await pack.statutory.set(ctx,{personId:employee.personId,icNumber:'900101145678',taxCategory:1});
  await setCompensation(ctx,{employmentId:employee.employmentId,basicSalary:10000,effectiveFrom:`${year-1}-01-01`});
  const bonus=await upsertPayComponent(ctx,{...bonusFlags,code:'SYNTH_RETAIN_BONUS',name:'Synthetic Bonus'});
  const slip=async(batchId:string)=>{const rows=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));const row=rows.find(r=>r.employmentId===employee.employmentId);expect(row).toBeTruthy();return row!;};
  const addBonus=async(batchId:string)=>setPayrollBatchComponent(ctx,{batchId,employmentId:employee.employmentId,componentId:bonus.id,amount:1000});
  return {ctx,employee,slip,addBonus};
 }
 it('retains distinct earlier one-off BIK and VOLA rows in subsequent additional and restated regular working',async()=>{
  const {ctx,employee,slip,addBonus}=await setup();
  const bik=await upsertPayComponent(ctx,{...benefitFlags,code:'SYNTH_ONEOFF_BIK',name:'Saved One-off Car',displayCategory:'bik',eaFormLine:'EA_B3',pcbExemptionCode:'PCB_PERQUISITE'});
  const vola=await upsertPayComponent(ctx,{...benefitFlags,code:'SYNTH_ONEOFF_VOLA',name:'Saved One-off Home',displayCategory:'vola',eaFormLine:'EA_B4',pcbExemptionCode:'PCB_CHILD_CARE'});
  // No recurring assignments: these codes can only come from the first run's saved one-off ownership.
  const first=await createAdditionalRun(ctx,{companyId:base.companyId,payPeriod:period,runType:'bonus'});await addBonus(first.batchId);
  await setPayrollBatchComponent(ctx,{batchId:first.batchId,employmentId:employee.employmentId,componentId:bik.id,amount:100});
  await setPayrollBatchComponent(ctx,{batchId:first.batchId,employmentId:employee.employmentId,componentId:vola.id,amount:150});
  await generatePayslips(ctx,{batchId:first.batchId});
  const issued=await slip(first.batchId),initial=issued.statutory as any;
  const saved=readPcbExemptions(initial.pcbExemptions);expect(saved).not.toBeNull();
  for(const [code,amount] of [['PCB_PERQUISITE',100],['PCB_CHILD_CARE',150]] as const){
   expect(saved!.rows.find(r=>r.code===code)).toMatchObject({annualLimit:pack.payroll.pcbExemptionTables.pcb[code],accumulated:0,thisMonth:amount,reused:false});
   expect(initial.exemptionUsed[code]).toBe(amount);
  }
  expect(initial.pcbNonCash.ownedEaEntries.filter((x:any)=>x.source==='one_off')).toHaveLength(2);
  const second=await createAdditionalRun(ctx,{companyId:base.companyId,payPeriod:period,runType:'bonus'});await addBonus(second.batchId);await generatePayslips(ctx,{batchId:second.batchId});
  // Module entitlement is captured in the session: refresh it to exercise the genuine legacy early return.
  await setModule(base.tenantId,'typed_pay_components','disabled');
  const legacyCtx=await entitledCtx(base);
  expect(isModuleEnabled(legacyCtx,'typed_pay_components')).toBe(false);
  expect(isModuleEnabled(legacyCtx,'multi_cycle_payroll')).toBe(true);
  const regular=await createBatch(legacyCtx,{companyId:base.companyId,payPeriod:period});await generatePayslips(legacyCtx,{batchId:regular.batchId});
  for(const batchId of [second.batchId,regular.batchId]){
   const current=await slip(batchId),st=current.statutory as any;
   const evidence=readPcbExemptions(st.pcbExemptions);expect(evidence).not.toBeNull();
   // The existing cumulative working proves these assessments remain relevant even though this run owns none.
   expect(st.pcbNonCash.eaEntries.filter((x:any)=>x.source==='one_off')).toHaveLength(2);
   expect(st.pcbNonCash.ownedEaEntries).toEqual([]);
   for(const [code,amount] of [['PCB_PERQUISITE',100],['PCB_CHILD_CARE',150]] as const){
    expect(evidence!.rows.find(r=>r.code===code),`retained ${code} is visible in selected cumulative working`).toMatchObject({annualLimit:pack.payroll.pcbExemptionTables.pcb[code],accumulated:amount,thisMonth:amount,reused:true});
    expect(st.exemptionUsed?.[code]??0).toBe(0);
   }
  }
  expect(await slip(first.batchId)).toEqual(issued);
 });
 it('shows unknown annual cap when reused and fresh same-code assessments used different saved limits',async()=>{
  const {ctx,employee,slip,addBonus}=await setup();
  const code='PCB_CHILD_CARE';
  const car=await upsertPayComponent(ctx,{...benefitFlags,code:'SYNTH_CAP_CONFLICT',name:'Saved Recurring Car',displayCategory:'bik',eaFormLine:'EA_B3',pcbExemptionCode:code});
  await setEmploymentPayComponent(ctx,{employmentId:employee.employmentId,componentId:car.id,amount:40,effectiveFrom:`${year}-01-01`});
  const first=await createBatch(ctx,{companyId:base.companyId,payPeriod:period});await generatePayslips(ctx,{batchId:first.batchId});
  const issued=await slip(first.batchId),saved=readPcbExemptions((issued.statutory as any).pcbExemptions);expect(saved).not.toBeNull();
  const oldCap=saved!.rows.find(r=>r.code===code)!.annualLimit;expect(oldCap).toBe(pack.payroll.pcbExemptionTables.pcb[code]);
  const rules=JSON.parse(JSON.stringify(DEFAULT_MY_STATUTORY));const newCap=Number(oldCap)/2;
  rules.pcbExemptions.pcb[code]=newCap;
  await saveStatutoryRulesetMY(ctx,{effectiveFrom:`${period}-15`,version:'r387-cap-conflict',data:rules});
  const extra=await createAdditionalRun(ctx,{companyId:base.companyId,payPeriod:period,runType:'bonus'});await addBonus(extra.batchId);
  await setPayrollBatchComponent(ctx,{batchId:extra.batchId,employmentId:employee.employmentId,componentId:car.id,amount:60});await generatePayslips(ctx,{batchId:extra.batchId});
  const current=await slip(extra.batchId),st=current.statutory as any;expect(st.version).toBe('r387-cap-conflict');
  const evidence=readPcbExemptions(st.pcbExemptions);expect(evidence).not.toBeNull();
  expect(evidence!.rows.find(r=>r.code===code)).toMatchObject({annualLimit:null,accumulated:40,thisMonth:100,reused:true});
  expect(st.pcbNonCash.eaEntries.filter((x:any)=>x.exemptionCode===code).map((x:any)=>x.exemptAmount).sort((a:number,b:number)=>a-b)).toEqual([40,60]);
  expect(st.exemptionUsed[code]).toBe(60); // Existing ledger owns only the newly priced one-off benefit.
  expect(await slip(first.batchId)).toEqual(issued);
 });
});
