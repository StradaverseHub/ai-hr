import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {requirePackFor} from '../localization/registry';
import {todayInKualaLumpur} from '../lib/hr-date';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createBatch,createAdditionalRun,generatePayslips,upsertPayComponent,setEmploymentPayComponent,setPayrollBatchComponent} from '../packs/payroll/service';
import {readPcbExemptions,pcbExemptionDetail} from '../core/pcb-exemptions';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import * as schema from '../db/schema';
const year=Number(todayInKualaLumpur().slice(0,4));
const pack=requirePackFor('MY');
const flags={kind:'allowance' as const,isNonPayable:false,prorates:false,includedInPcb:true,includedInEpf:true,includedInSocsoEis:true,includedInHrdfBase:false,pcbRemunerationType:'normal' as const,epfBonus2012:false};
describe('r387 actual payroll exemption metadata capture',()=>{
 let base:Base;
 beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();base=await seedBase();await setModule(base.tenantId,'typed_pay_components','active');await setModule(base.tenantId,'multi_cycle_payroll','active');});afterAll(closeAll);
 it('captures grouped cash, LP, noncash, real zeroes and additional reused ownership without altering saved ledger',async()=>{
  const ctx=await entitledCtx(base);
  const e=await hireEmployee(ctx,{person:{fullName:'Synthetic Exemption Evidence',primaryEmail:`${randomUUID()}@test.local`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:`${year-1}-01-01`});
  await pack.statutory.set(ctx,{personId:e.personId,icNumber:'900101145678',taxCategory:1});
  await setCompensation(ctx,{employmentId:e.employmentId,basicSalary:10000,effectiveFrom:`${year-1}-01-01`});
  const specs=[
   {code:'SYNTH_TRAVEL_A',name:'Travel A',pcbExemptionCode:'PCB_TRA_BUSINESS',amount:100},
   {code:'SYNTH_TRAVEL_B',name:'Travel B',pcbExemptionCode:'PCB_TRA_BUSINESS',amount:50},
   {code:'SYNTH_CHILD_ZERO',name:'Child Care Zero',pcbExemptionCode:'PCB_CHILD_CARE',amount:0},
   {code:'SYNTH_FULL_EXEMPT',name:'Unlimited',pcbExemptionCode:'PCB_NON-TAXABLE',amount:30},
   {code:'SYNTH_DENTAL',name:'Dental',pcbExemptionCode:'LP_DENTAL',amount:20,pcbRemunerationType:'optional_deduction' as const},
   {code:'SYNTH_NONCASH',name:'Recurring Car',pcbExemptionCode:'PCB_PERQUISITE',amount:40,kind:'non_payable' as const,isNonPayable:true,includedInEpf:false,includedInSocsoEis:false,displayCategory:'bik' as const,eaFormLine:'EA_B3'},
  ];
  for(const spec of specs){const {amount,...input}=spec;const c=await upsertPayComponent(ctx,{...flags,...input});await setEmploymentPayComponent(ctx,{employmentId:e.employmentId,componentId:c.id,amount,allowZeroAmount:amount===0,effectiveFrom:`${year}-01-01`});}
  const first=await createBatch(ctx,{companyId:base.companyId,payPeriod:`${year}-01`});await generatePayslips(ctx,{batchId:first.batchId});
  const second=await createBatch(ctx,{companyId:base.companyId,payPeriod:`${year}-02`});await generatePayslips(ctx,{batchId:second.batchId});
  const [regular]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,second.batchId));expect(regular).toBeTruthy();
  const st=regular.statutory as any;const evidence=readPcbExemptions(st.pcbExemptions);expect(evidence).not.toBeNull();
  const row=(code:string)=>evidence!.rows.find(r=>r.code===code)!;
  expect(evidence!.rows).toHaveLength(5);
  expect(row('PCB_TRA_BUSINESS')).toMatchObject({annualLimit:pack.payroll.pcbExemptionTables.pcb.PCB_TRA_BUSINESS,accumulated:150,thisMonth:150,reused:false});
  expect([...row('PCB_TRA_BUSINESS').payItems].sort()).toEqual(['Travel A','Travel B']);
  expect(row('PCB_CHILD_CARE')).toMatchObject({accumulated:0,thisMonth:0});
  expect(row('PCB_NON-TAXABLE')).toMatchObject({annualLimit:-1,accumulated:30,thisMonth:30});
  expect(row('LP_DENTAL')).toMatchObject({accumulated:20,thisMonth:20});
  expect(row('PCB_PERQUISITE')).toMatchObject({accumulated:40,thisMonth:40});
  for(const r of evidence!.rows)expect(r.thisMonth).toBe(st.exemptionUsed?.[r.code]??0);
  const extra=await createAdditionalRun(ctx,{companyId:base.companyId,payPeriod:`${year}-02`,runType:'bonus'});
  const bonus=await upsertPayComponent(ctx,{...flags,code:'SYNTH_TAXABLE_BONUS',name:'Cash Bonus',includedInSocsoEis:false,pcbRemunerationType:'additional',pcbExemptionCode:'PCB_TAXABLE',epfBonus2012:true});
  await setPayrollBatchComponent(ctx,{batchId:extra.batchId,employmentId:e.employmentId,componentId:bonus.id,amount:1000});await generatePayslips(ctx,{batchId:extra.batchId});
  const [additional]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,extra.batchId));const ast=additional.statutory as any;
  const ae=readPcbExemptions(ast.pcbExemptions);expect(ae).not.toBeNull();
  expect(ae!.rows.find(r=>r.code==='PCB_PERQUISITE')).toMatchObject({annualLimit:row('PCB_PERQUISITE').annualLimit,accumulated:80,thisMonth:40,reused:true});
  expect(ae!.rows.find(r=>r.code==='LP_DENTAL')).toMatchObject({accumulated:20,thisMonth:0});
  expect(ast.exemptionUsed?.PCB_PERQUISITE??0).toBe(0);
  const bytes=JSON.stringify(ast);expect(pcbExemptionDetail(ast,`${year}-02`).source).toBe('recorded');expect(JSON.stringify(ast)).toBe(bytes);
  expect((await owner.db.select().from(schema.payslip).where(eq(schema.payslip.id,regular.id)))[0]).toEqual(regular);
 });
});
