import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {requirePackFor} from '../localization/registry';
import {todayInKualaLumpur} from '../lib/hr-date';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createBatch,createAdditionalRun,generatePayslips,upsertPayComponent,setEmploymentPayComponent,setPayrollBatchComponent} from '../packs/payroll/service';
import {saveTp3} from '../core/tp3';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import * as schema from '../db/schema';
const year=Number(todayInKualaLumpur().slice(0,4));
const pack=requirePackFor('MY');
const flags={kind:'allowance' as const,isNonPayable:false,prorates:false,includedInPcb:true,includedInEpf:true,includedInSocsoEis:true,includedInHrdfBase:false,pcbRemunerationType:'normal' as const,epfBonus2012:false};
describe('r387 complete monetary parity against original calculation',()=>{
 let base:Base;
 beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();base=await seedBase();await setModule(base.tenantId,'typed_pay_components','active');await setModule(base.tenantId,'multi_cycle_payroll','active');});afterAll(closeAll);
 it('preserves every stored money and statutory figure across regular, additional and replay with TP3 headroom',async()=>{
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
  await saveTp3(ctx,{personId:e.personId,assessmentYear:year,sectionC:{c1:{amount:30000},c2:{subItems:{i:pack.payroll.pcbExemptionTables.pcb.PCB_TRA_BUSINESS-50}}}});
  const first=await createBatch(ctx,{companyId:base.companyId,payPeriod:`${year}-01`});await generatePayslips(ctx,{batchId:first.batchId});
  const second=await createBatch(ctx,{companyId:base.companyId,payPeriod:`${year}-02`});await generatePayslips(ctx,{batchId:second.batchId});
  const extra=await createAdditionalRun(ctx,{companyId:base.companyId,payPeriod:`${year}-02`,runType:'bonus'});
  const bonus=await upsertPayComponent(ctx,{...flags,code:'SYNTH_TAXABLE_BONUS',name:'Cash Bonus',includedInSocsoEis:false,pcbRemunerationType:'additional',pcbExemptionCode:'PCB_TAXABLE',epfBonus2012:true});
  await setPayrollBatchComponent(ctx,{batchId:extra.batchId,employmentId:e.employmentId,componentId:bonus.id,amount:1000});await generatePayslips(ctx,{batchId:extra.batchId});
  const snapshots=[];
  const comp=await owner.db.select().from(schema.compensation).where(eq(schema.compensation.employmentId,e.employmentId));
  expect(comp).toHaveLength(1);expect(Number(comp[0].basicSalary)).toBe(10000);
  const ids=new Map([[comp[0].id,'selected-salary-owner'],[bonus.id,'item:SYNTH_TAXABLE_BONUS']]);
  const bonusSources=await owner.db.select().from(schema.payrollBatchComponent).where(eq(schema.payrollBatchComponent.batchId,extra.batchId));
  const ownedBonus=bonusSources.filter(x=>x.employmentId===e.employmentId&&x.componentId===bonus.id);expect(ownedBonus).toHaveLength(1);ids.set(ownedBonus[0].id,'batch-item:SYNTH_TAXABLE_BONUS');
  const assigned=await owner.db.select().from(schema.employmentPayComponent).where(eq(schema.employmentPayComponent.employmentId,e.employmentId));
  for(const assignment of assigned){const [item]=await owner.db.select().from(schema.payComponent).where(eq(schema.payComponent.id,assignment.componentId));ids.set(assignment.id,`assignment:${item.code}`);ids.set(item.id,`item:${item.code}`);}
  const normalized=(value:any,path="slip"):any=>{
    if(typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)){expect(ids.has(value),`saved owner ${value} at ${path} is independently identified`).toBe(true);return ids.get(value);}
    if(typeof value==='string' && value.startsWith(`${year}-`))return value.replace(`${year}-`,'YEAR-');
    if(Array.isArray(value))return value.map((v,i)=>normalized(v,`${path}[${i}]`));
    if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalized(v,`${path}.${k}`)]));
    return value;
  };
  for(const batch of [first,second,extra]){
    const slips=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batch.batchId));
    const row=slips.find(x=>x.employmentId===e.employmentId);expect(row).toBeTruthy();
    const {id,batchId,tenantId,employmentId,createdAt,...saved}=row!;
    const {pcbExemptions,...statutory}=saved.statutory as any;
    snapshots.push(normalized({...saved,statutory}));
  }
  if(process.env.R387_WRITE_BASELINE){writeFileSync(process.env.R387_WRITE_BASELINE,JSON.stringify(snapshots,null,2)+'\n');}
  else expect(snapshots).toEqual(JSON.parse(readFileSync('test/fixtures/r387-exemption-money-golden.json','utf8')));
 });
});
