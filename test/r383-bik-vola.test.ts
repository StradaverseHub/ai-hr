import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { isUnsupportedTaxableComponent } from '../core/pay-components';
import { requirePackFor } from '../localization/registry';
import { classifyNonCashBenefit, NonCashBenefitConfigurationError, readPcbNonCash } from '../localization/noncash-benefits';
import { createBatch, createAdditionalRun, generatePayslips, reprocessSelectedEmployees, getReprocessJob, setPayrollInput, createIndividualTxn, upsertPayComponent, setEmploymentPayComponent, setPayrollBatchComponent, isStatutoryRelevantChange } from '../packs/payroll/service';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

const pack=requirePackFor('MY');
const kindInput={code:'BENEFIT',kind:'non_payable',nonPayable:true,pcb:true,displayCategory:'bik',eaFormLine:'EA_B3',pcbRemunerationType:'normal'};
describe('r383 canonical BIK/VOLA classification and pack cash isolation',()=>{
 it('uses explicit category and narrow legacy EA kind without electing PCB inclusion',()=>{
  expect(classifyNonCashBenefit(kindInput)).toBe('bik');
  expect(classifyNonCashBenefit({...kindInput,displayCategory:null,eaFormLine:'EA_B4'})).toBe('vola');
  expect(classifyNonCashBenefit({...kindInput,pcb:false})).toBe('bik');
  expect(classifyNonCashBenefit({...kindInput,nonPayable:false})).toBeNull();
 });
 it('refuses conflicts, unsupported sign/kind and additional normal-benefit declarations',()=>{
  for(const c of [{...kindInput,eaFormLine:'EA_B4'},{...kindInput,kind:'deduction'},{...kindInput,pcbRemunerationType:'additional'}])expect(()=>classifyNonCashBenefit(c)).toThrow(NonCashBenefitConfigurationError);
 });
 it('unknown PCB-subject nonpayable items remain refused even when a normal stream is declared',()=>{
  expect(isUnsupportedTaxableComponent({code:'UNKNOWN',kind:'non_payable',includedInPcb:true,includedInEpf:false,includedInSocsoEis:false,isNonPayable:true,pcbRemunerationType:'normal'})).toBe(true);
  expect(isUnsupportedTaxableComponent({code:'KNOWN',kind:'non_payable',displayCategory:'vola',includedInPcb:true,includedInEpf:false,includedInSocsoEis:false,isNonPayable:true,pcbRemunerationType:'normal'})).toBe(false);
 });
 it('PCB-only input increases Y1 without increasing any cash agency base',()=>{
  const profile={category:1 as const,children:0};
  const a=pack.payroll.statutory(12000,profile,0,0,{month:7});
  const b=pack.payroll.statutory(12000,profile,0,0,{month:7},{pcbNonCashNormal:{bik:2000,vola:1500}});
  for(const k of ['epfEmployee','epfEmployer','socsoEmployee','socsoEmployer','socsoSkbbk','eisEmployee','eisEmployer'] as const)expect(b[k]).toBe(a[k]);
  expect((b.pcbMeta as any).trace.Y1).toBe(15500);expect(b.pcb).toBeGreaterThan(a.pcb);
 });
 it('nonresident and incentive branches include benefits through their own authoritative formulas',()=>{
  for(const scheme of ['non_resident','rep','knowledge_worker','c_suite'] as const){
   const opts={calculationScheme:scheme,pcbNonCashNormal:{bik:500,vola:800}};
   const s=pack.payroll.statutory(12000,{category:1,children:0},0,0,{month:7},opts);
   expect((s.pcbMeta as any).trace[scheme==='non_resident'?'remuneration':'Y1']).toBe(13300);
  }
 });
 it('malformed saved new ownership stops monetary replay while absent legacy stamps keep the existing fallback',()=>{
  const fresh=()=>({netRemuneration:0,epfClaimed:0,pcbPaid:0,zakatPaid:0,lpAccumulated:0});
  expect(()=>pack.payroll.foldPriorSlipIntoAccumulators(fresh(),{gross:100,statutory:{bases:{pcb:100},pcbNonCash:{version:1}}},4000)).toThrow();
  const legacy=fresh();pack.payroll.foldPriorSlipIntoAccumulators(legacy,{gross:100,statutory:{bases:{pcb:100}}},4000);expect(legacy.netRemuneration).toBe(100);
 });
 it('rejects malformed noncash kernel input and leaves cash display changes presentation-only',()=>{
  expect(()=>pack.payroll.statutory(12000,{category:1,children:0},0,0,{month:7},{pcbNonCashNormal:{bik:-1,vola:0}})).toThrow();
  expect(isStatutoryRelevantChange(['displayCategory'])).toBe(false);expect(isStatutoryRelevantChange(['nonCashClassification'])).toBe(true);
 });
});

describe('r383 generated benefit provenance, month ownership and retained no-pay',()=>{
 let base:Base;let ctx:SessionContext;let counter=0;
 beforeAll(migrateTestDb);
 beforeEach(async()=>{await resetDb();base=await seedBase();await setModule(base.tenantId,'multi_cycle_payroll','active');await setModule(base.tenantId,'typed_pay_components','active');await setSetting(base.tenantId,'payroll.individual_txn_pay_enabled',true);ctx=await entitledCtx(base);counter=0;});
 afterAll(closeAll);
 async function employee(){const e=await hireEmployee(ctx,{person:{fullName:'Synthetic Benefit',primaryEmail:`${randomUUID()}@bik.test`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2025-01-01'});await pack.statutory.set(ctx,{personId:e.personId,icNumber:'900101880001'});await setCompensation(ctx,{employmentId:e.employmentId,basicSalary:12000,monthlyAllowance:0,effectiveFrom:'2025-01-01'});return e;}
 async function benefit(kind:'bik'|'vola',pcb=true,exemption='PCB_TAXABLE',explicit=true){return upsertPayComponent(ctx,{code:`${kind.toUpperCase()}_${++counter}`,name:kind,kind:'non_payable',isNonPayable:true,prorates:false,includedInPcb:pcb,includedInEpf:false,includedInSocsoEis:false,includedInHrdfBase:false,displayCategory:explicit?kind:null,eaFormLine:kind==='bik'?'EA_B3':'EA_B4',pcbRemunerationType:'normal',pcbExemptionCode:pcb?exemption:null,epfBonus2012:false});}
 async function bonus(batchId:string,employmentId:string){const c=await upsertPayComponent(ctx,{code:`BONUS_${++counter}`,name:'Cash bonus',kind:'allowance',isNonPayable:false,prorates:false,includedInPcb:true,includedInEpf:true,includedInSocsoEis:false,includedInHrdfBase:false,pcbRemunerationType:'additional',pcbExemptionCode:'PCB_TAXABLE',epfBonus2012:true});await setPayrollBatchComponent(ctx,{batchId,employmentId,componentId:c.id,amount:3000});}
 async function slip(batchId:string,id:string){return (await owner.db.select().from(schema.payslip).where(and(eq(schema.payslip.batchId,batchId),eq(schema.payslip.employmentId,id))))[0];}
 const meta=(s:any)=>{const x=readPcbNonCash(s.statutory.pcbNonCash);expect(x).not.toBeNull();return x!;};
 it('Transaction Entry VOLA enters Y1 and saved provenance while cash gross and agency bases stay unchanged',async()=>{
  const e=await employee();const b=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-07'});await generatePayslips(ctx,{batchId:b.batchId});const before=await slip(b.batchId,e.employmentId);
  const c=await benefit('vola');const t=await createIndividualTxn(ctx,{batchId:b.batchId,employmentId:e.employmentId,kind:'earning',componentId:c.id,txnDate:'2026-07-15',amount:1500});
  await reprocessSelectedEmployees(ctx,{batchId:b.batchId,employmentIds:[e.employmentId],idempotencyKey:randomUUID()});const after=await slip(b.batchId,e.employmentId);
  expect(after.grossPay).toBe(before.grossPay);expect((after.statutory as any).bases.epf).toBe((before.statutory as any).bases.epf);expect((after.statutory as any).bases.socsoEis).toBe((before.statutory as any).bases.socsoEis);
  expect((after.statutory as any).pcbMeta.trace.Y1).toBe(13500);expect(meta(after).owned.vola).toBe(1500);expect(meta(after).ownedEntries[0].sourceId).toBe(t.id);
  expect(Number(after.netPay)).toBeLessThan(Number(before.netPay));
 });
 it('not subject to PCB remains excluded with independent frozen EA routing and no invented exemption',async()=>{
  const e=await employee();const c=await benefit('bik',false);await setEmploymentPayComponent(ctx,{employmentId:e.employmentId,componentId:c.id,amount:2000,effectiveFrom:'2026-01-01'});const b=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-07'});await generatePayslips(ctx,{batchId:b.batchId});const s=await slip(b.batchId,e.employmentId),nc=meta(s);
  expect((s.statutory as any).pcbMeta.trace.Y1).toBe(12000);expect(nc.owned.bik).toBe(0);expect(nc.ownedEntries).toEqual([]);expect(nc.ownedEaEntries[0]).toMatchObject({entered:2000,reportableAmount:2000,exemptAmount:0,subjectPCB:false,eaFormLine:'EA_B3'});
 });
 it('legacy EA-only kind mapping supports VOLA without treating EA category as taxability',async()=>{
  const e=await employee();const c=await benefit('vola',true,'PCB_TAXABLE',false);await setEmploymentPayComponent(ctx,{employmentId:e.employmentId,componentId:c.id,amount:900,effectiveFrom:'2026-01-01'});const b=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-07'});await generatePayslips(ctx,{batchId:b.batchId});expect(meta(await slip(b.batchId,e.employmentId)).owned.vola).toBe(900);
 });
 it('existing exemption owner applies partial/full benefits without paying exempt portions as cash',async()=>{
  const e=await employee();const c=await benefit('bik',true,'PCB_CHILD_CARE');await setEmploymentPayComponent(ctx,{employmentId:e.employmentId,componentId:c.id,amount:2000,effectiveFrom:'2026-01-01'});
  for(const [period,exempt,taxable] of [['2026-01',2000,0],['2026-02',1000,1000]] as const){const b=await createBatch(ctx,{companyId:base.companyId,payPeriod:period});await generatePayslips(ctx,{batchId:b.batchId});const s=await slip(b.batchId,e.employmentId);expect(s.grossPay).toBe('12000.00');expect(meta(s).current.bik).toEqual({entered:2000,exempt,taxable});expect(meta(s).ownedEaEntries[0].reportableAmount).toBe(taxable);}
 });
 it('regular plus bonus reuses saved recurring exemption and accumulates monthly benefits once',async()=>{
  const e=await employee();const c=await benefit('bik',true,'PCB_CHILD_CARE');await setEmploymentPayComponent(ctx,{employmentId:e.employmentId,componentId:c.id,amount:2000,effectiveFrom:'2026-01-01'});
  const r=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-01'});await generatePayslips(ctx,{batchId:r.batchId});
  const a=await createAdditionalRun(ctx,{companyId:base.companyId,payPeriod:'2026-01',runType:'bonus'});await bonus(a.batchId,e.employmentId);await generatePayslips(ctx,{batchId:a.batchId});const sm=meta(await slip(a.batchId,e.employmentId));expect(sm.current.bik).toEqual({entered:2000,exempt:2000,taxable:0});expect(sm.ownedEntries).toEqual([]);expect(sm.ownedEaEntries).toEqual([]);
  const feb=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-02'});await generatePayslips(ctx,{batchId:feb.batchId});expect(meta(await slip(feb.batchId,e.employmentId)).current.bik).toEqual({entered:2000,exempt:1000,taxable:1000});
 });
 it('oneoff extra-cycle benefit is owned once, monthly delta includes it, retry keeps exact version and transactions',async()=>{
  const e=await employee();const c=await benefit('vola');const r=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-07'});await generatePayslips(ctx,{batchId:r.batchId});const sr=await slip(r.batchId,e.employmentId);
  const a=await createAdditionalRun(ctx,{companyId:base.companyId,payPeriod:'2026-07',runType:'bonus'});await bonus(a.batchId,e.employmentId);await createIndividualTxn(ctx,{batchId:a.batchId,employmentId:e.employmentId,kind:'earning',componentId:c.id,txnDate:'2026-07-15',amount:1000});await generatePayslips(ctx,{batchId:a.batchId});const sa=await slip(a.batchId,e.employmentId),nc=meta(sa);expect(sa.grossPay).toBe('3000.00');expect(nc.owned.vola).toBe(1000);expect(nc.cumulative.vola).toBe(1000);
  const monthly=pack.payroll.statutory(12000,{category:1,children:0},3000,0,{month:7},{pcbNonCashNormal:{bik:0,vola:1000}});expect(Number((sr.statutory as any).pcb)+Number((sa.statutory as any).pcb)).toBeCloseTo(monthly.pcb,2);
  const key=randomUUID();await reprocessSelectedEmployees(ctx,{batchId:a.batchId,employmentIds:[e.employmentId],idempotencyKey:key});const once=await slip(a.batchId,e.employmentId);await reprocessSelectedEmployees(ctx,{batchId:a.batchId,employmentIds:[e.employmentId],idempotencyKey:key});expect(await slip(a.batchId,e.employmentId)).toEqual(once);
  const next=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-08'});await generatePayslips(ctx,{batchId:next.batchId});expect(meta(await slip(next.batchId,e.employmentId)).accumulated.vola).toBe(1000);
 });
 it('bonus before regular projects monthly benefits but gives recurring ownership only to regular',async()=>{
  const e=await employee();const c=await benefit('bik');await setEmploymentPayComponent(ctx,{employmentId:e.employmentId,componentId:c.id,amount:1000,effectiveFrom:'2026-01-01'});
  const a=await createAdditionalRun(ctx,{companyId:base.companyId,payPeriod:'2026-07',runType:'bonus'});await bonus(a.batchId,e.employmentId);await generatePayslips(ctx,{batchId:a.batchId});expect(meta(await slip(a.batchId,e.employmentId)).owned.bik).toBe(0);
  const r=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-07'});await generatePayslips(ctx,{batchId:r.batchId});expect(meta(await slip(r.batchId,e.employmentId)).owned.bik).toBe(1000);
  const monthly=pack.payroll.statutory(12000,{category:1,children:0},3000,0,{month:7},{pcbNonCashNormal:{bik:1000,vola:0}});expect(Number(((await slip(a.batchId,e.employmentId)).statutory as any).pcb)+Number(((await slip(r.batchId,e.employmentId)).statutory as any).pcb)).toBeCloseTo(monthly.pcb,2);
 });
 it('no cash has priority over taxable noncash and preserves old result and pending transaction',async()=>{
  const e=await employee();const b=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-07'});await generatePayslips(ctx,{batchId:b.batchId});const before=await slip(b.batchId,e.employmentId);const c=await benefit('bik');await createIndividualTxn(ctx,{batchId:b.batchId,employmentId:e.employmentId,kind:'earning',componentId:c.id,txnDate:'2026-07-15',amount:1000});await createIndividualTxn(ctx,{batchId:b.batchId,employmentId:e.employmentId,kind:'unpaid',txnDate:'2026-07-15',amount:12000});const txns=await owner.db.select().from(schema.payrollIndividualTxn);const run=await reprocessSelectedEmployees(ctx,{batchId:b.batchId,employmentIds:[e.employmentId],idempotencyKey:randomUUID()});const job=await getReprocessJob(ctx,run.jobId);expect((job!.result as any).outcomes[0]).toMatchObject({status:'skipped',resultRetained:true});expect(await slip(b.batchId,e.employmentId)).toEqual(before);expect(await owner.db.select().from(schema.payrollIndividualTxn)).toEqual(txns);
 });
 it('shared exemption headroom is consumed once across cash and noncash rather than creating exempt cash benefits',async()=>{
  const e=await employee(),noncash=await benefit('bik',true,'PCB_CHILD_CARE');
  const cash=await upsertPayComponent(ctx,{code:'CASH_CHILDCARE',name:'Cash childcare',kind:'allowance',isNonPayable:false,prorates:false,includedInPcb:true,includedInEpf:false,includedInSocsoEis:false,includedInHrdfBase:false,pcbRemunerationType:'normal',pcbExemptionCode:'PCB_CHILD_CARE',epfBonus2012:false});
  for(const c of [noncash,cash])await setEmploymentPayComponent(ctx,{employmentId:e.employmentId,componentId:c.id,amount:2000,effectiveFrom:'2026-01-01'});
  const r=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-01'});await generatePayslips(ctx,{batchId:r.batchId});const s=await slip(r.batchId,e.employmentId),nc=meta(s);
  expect(s.grossPay).toBe('14000.00');expect((s.statutory as any).exemptionUsed.PCB_CHILD_CARE).toBe(3000);expect(nc.current.bik.exempt).toBe(2000);expect((s.statutory as any).pcbMeta.trace.Y1).toBe(13000);
 });
 it('changed or new recurring benefits after a saved regular run refuse and preserve the additional saved result',async()=>{
  const e=await employee(),c=await benefit('vola');await setEmploymentPayComponent(ctx,{employmentId:e.employmentId,componentId:c.id,amount:1000,effectiveFrom:'2026-01-01'});
  const r=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-07'});await generatePayslips(ctx,{batchId:r.batchId});const a=await createAdditionalRun(ctx,{companyId:base.companyId,payPeriod:'2026-07',runType:'bonus'});await bonus(a.batchId,e.employmentId);await generatePayslips(ctx,{batchId:a.batchId});const before=await slip(a.batchId,e.employmentId);
  const changed=await upsertPayComponent(ctx,{code:'VOLA_1',name:'Changed accommodation',kind:'non_payable',isNonPayable:true,prorates:false,includedInPcb:true,includedInEpf:false,includedInSocsoEis:false,includedInHrdfBase:false,displayCategory:'bik',eaFormLine:'EA_B3',pcbRemunerationType:'normal',pcbExemptionCode:'PCB_TAXABLE',epfBonus2012:false});expect(changed.changed).toContain('nonCashClassification');
  const run=await reprocessSelectedEmployees(ctx,{batchId:a.batchId,employmentIds:[e.employmentId],idempotencyKey:randomUUID()});const job=await getReprocessJob(ctx,run.jobId);
  expect((job!.result as any).outcomes[0]).toMatchObject({status:'validation_failed',validationCode:'pcb_non_cash_configuration_invalid',resultRetained:true,validationDetails:[{gap:'month_baseline_unavailable'}]});expect(await slip(a.batchId,e.employmentId)).toEqual(before);
 });
 it('recurring taxable benefits accumulate once across same-month cycles and stamp genuine zero next-month absence',async()=>{
  const e=await employee(),c=await benefit('bik');await setEmploymentPayComponent(ctx,{employmentId:e.employmentId,componentId:c.id,amount:1000,effectiveFrom:'2026-07-01',effectiveTo:'2026-07-31'});
  const r=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-07'});await generatePayslips(ctx,{batchId:r.batchId});const a=await createAdditionalRun(ctx,{companyId:base.companyId,payPeriod:'2026-07',runType:'bonus'});await bonus(a.batchId,e.employmentId);await generatePayslips(ctx,{batchId:a.batchId});const rnc=meta(await slip(r.batchId,e.employmentId)),anc=meta(await slip(a.batchId,e.employmentId));expect(rnc.owned.bik).toBe(1000);expect(anc.owned.bik).toBe(0);expect(anc.cumulative.bik).toBe(1000);
  const next=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-08'});await generatePayslips(ctx,{batchId:next.batchId});const nc=meta(await slip(next.batchId,e.employmentId));expect(nc.accumulated).toEqual({bik:1000,vola:0,complete:true});expect(nc.current.bik).toEqual({entered:0,exempt:0,taxable:0});
 });
 it('new-year current input stays valid while previous-year accumulation and exemption usage reset',async()=>{
  const e=await employee();const c=await benefit('vola');await setEmploymentPayComponent(ctx,{employmentId:e.employmentId,componentId:c.id,amount:1100,effectiveFrom:'2026-01-01'});
  for(const period of ['2026-12','2027-01']){const b=await createBatch(ctx,{companyId:base.companyId,payPeriod:period});await generatePayslips(ctx,{batchId:b.batchId});const nc=meta(await slip(b.batchId,e.employmentId));expect(nc.current.vola.taxable).toBe(1100);expect(nc.accumulated.vola).toBe(0);}
 });
});
