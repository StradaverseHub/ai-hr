import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import {requirePackFor} from '../localization/registry';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {employeeEaStatement} from '../core/reporting';
import {setEaOverride} from '../core/ea-override';
import {createBatch,createAdditionalRun,generatePayslips,upsertPayComponent,setEmploymentPayComponent,setPayrollBatchComponent,createIndividualTxn} from '../packs/payroll/service';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,setSetting,type Base} from './harness';
import * as schema from '../db/schema';
import {renderToStaticMarkup} from 'react-dom/server';
import EaStatementPage from '../app/payroll/reports/ea/[employmentId]/page';
const sessionState=vi.hoisted(()=>({ctx:null as any}));
vi.mock('../lib/session',()=>({getSession:async()=>sessionState.ctx}));
vi.mock('next-intl/server',async()=>{const {createTranslator}=await import('next-intl');const fs=await import('node:fs');return {getTranslations:async(arg:any)=>createTranslator({locale:'en',messages:JSON.parse(fs.readFileSync('messages/en.json','utf8')),namespace:typeof arg==='string'?arg:arg.namespace})};});
// Client controls are outside this static RSC proof; data retrieval and printed EA rows remain real.
vi.mock('../app/payroll/reports/ea/[employmentId]/ea-amend-panel',()=>({EaAmendPanel:()=>null}));
vi.mock('../components/print-button',()=>({PrintButton:()=>null}));
vi.mock('../components/ui/toast-trigger',()=>({ToastFromQuery:()=>null}));
const pack=requirePackFor('MY');
const flags={kind:'non_payable' as const,isNonPayable:true,prorates:false,includedInPcb:true,includedInEpf:false,includedInSocsoEis:false,includedInHrdfBase:false,pcbRemunerationType:'normal' as const,pcbExemptionCode:'PCB_TAXABLE',epfBonus2012:false};
describe('r383 generated payroll to employee EA statement',()=>{
 let base:Base;
 beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();base=await seedBase();await setModule(base.tenantId,'multi_cycle_payroll','active');await setModule(base.tenantId,'typed_pay_components','active');await setSetting(base.tenantId,'payroll.individual_txn_pay_enabled',true);});afterAll(closeAll);
 async function employee(){
  const ctx=await entitledCtx(base);const e=await hireEmployee(ctx,{person:{fullName:'Synthetic Annual Benefits',primaryEmail:`${randomUUID()}@test.local`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2025-01-01'});
  await pack.statutory.set(ctx,{personId:e.personId,icNumber:'900101145678',taxCategory:3});await setCompensation(ctx,{employmentId:e.employmentId,basicSalary:14000,monthlyAllowance:0,effectiveFrom:'2025-01-01'});return {ctx,e};
 }
 async function regular(ctx:any,period:string){const b=await createBatch(ctx,{companyId:base.companyId,payPeriod:period});await generatePayslips(ctx,{batchId:b.batchId});return b.batchId;}
 async function slip(batchId:string){const [s]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));expect(s).toBeTruthy();return s;}
 it('uses run-owned B3/B4, excludes noncash exemption from cash allowance subtraction, and preserves amendments',async()=>{
  const {ctx,e}=await employee();
  const cashAllowance=await upsertPayComponent(ctx,{code:'EA_CASH_ALLOW',name:'Synthetic cash allowance',kind:'allowance',isNonPayable:false,prorates:false,includedInPcb:true,includedInEpf:true,includedInSocsoEis:true,includedInHrdfBase:true,displayCategory:'allowance',pcbRemunerationType:'normal',pcbExemptionCode:'PCB_TAXABLE',epfBonus2012:false});
  await setEmploymentPayComponent(ctx,{employmentId:e.employmentId,componentId:cashAllowance.id,amount:500,effectiveFrom:'2026-01-01'});
  const bik=await upsertPayComponent(ctx,{...flags,code:'EA_CAR',name:'Synthetic taxable BIK',displayCategory:'bik',eaFormLine:'EA_B3',pcbExemptionCode:'PCB_CHILD_CARE'});
  const info=await upsertPayComponent(ctx,{...flags,code:'EA_INFO_CAR',name:'Synthetic non-PCB BIK',displayCategory:'bik',eaFormLine:'EA_B3',includedInPcb:false,pcbExemptionCode:null});
  const vola=await upsertPayComponent(ctx,{...flags,code:'EA_HOME',name:'Synthetic accommodation',displayCategory:'vola',eaFormLine:'EA_B4'});
  await setEmploymentPayComponent(ctx,{employmentId:e.employmentId,componentId:bik.id,amount:2000,effectiveFrom:'2026-01-01'});
  await setEmploymentPayComponent(ctx,{employmentId:e.employmentId,componentId:info.id,amount:400,effectiveFrom:'2026-01-01'});
  const jan=await regular(ctx,'2026-01');
  const extra=await createAdditionalRun(ctx,{companyId:base.companyId,payPeriod:'2026-01',runType:'bonus'});
  const cash=await upsertPayComponent(ctx,{code:'EA_BONUS',name:'Synthetic cash bonus',kind:'allowance',isNonPayable:false,prorates:false,includedInPcb:true,includedInEpf:true,includedInSocsoEis:false,includedInHrdfBase:false,pcbRemunerationType:'additional',pcbExemptionCode:'PCB_TAXABLE',epfBonus2012:true});
  await setPayrollBatchComponent(ctx,{batchId:extra.batchId,employmentId:e.employmentId,componentId:cash.id,amount:3000});
  await createIndividualTxn(ctx,{batchId:extra.batchId,employmentId:e.employmentId,kind:'earning',componentId:vola.id,txnDate:'2026-01-15',amount:800});await generatePayslips(ctx,{batchId:extra.batchId});
  const feb=await regular(ctx,'2026-02');const saved=[await slip(jan),await slip(extra.batchId),await slip(feb)];
  expect(saved.map(s=>Number(s.allowance))).toEqual([500,0,500]);
  const st=saved.map(s=>s.statutory as any);
  expect(st[0].pcbNonCash.current.bik).toEqual({entered:2000,exempt:2000,taxable:0});
  expect(st[1].pcbNonCash.current.bik.exempt).toBe(2000);expect(st[1].pcbNonCash.owned.bik).toBe(0);
  expect(st[2].pcbNonCash.current.bik).toEqual({entered:2000,exempt:1000,taxable:1000});
  expect(st[0].pcbNonCash.ownedEaEntries.find((x:any)=>x.code==='EA_INFO_CAR')).toMatchObject({subjectPCB:false,reportableAmount:400,exemptAmount:0});
  const ledgerTotal=st.reduce((sum,s)=>sum+Number(s.exemptionUsed?.PCB_CHILD_CARE??0),0);expect(ledgerTotal).toBe(3000);
  const form=await employeeEaStatement(ctx,{employmentId:e.employmentId,year:'2026',companyId:base.companyId});expect(form).toBeTruthy();
  expect(form!.routing?.nonCashComplete).toBe(true);
  expect(form!.partB).toMatchObject({grossSalary:28000,bonus:3000,allowances:1000,benefitsInKind:1800,livingAccommodation:800,exemptAllowances:3000,gross:34600});
  // Change today's catalogue mapping and exemption; the EA remains owned by saved per-run evidence.
  await upsertPayComponent(ctx,{...flags,code:'EA_CAR',name:'Current BIK changed',displayCategory:'bik',eaFormLine:null,pcbExemptionCode:'PCB_TAXABLE'});
  const unchanged=await employeeEaStatement(ctx,{employmentId:e.employmentId,year:'2026',companyId:base.companyId});expect(unchanged!.partB).toEqual(form!.partB);
  await setEaOverride(ctx,{employmentId:e.employmentId,year:'2026',field:'benefitsInKind',amount:4444,reason:'Synthetic authorised EA amendment'});
  await setEaOverride(ctx,{employmentId:e.employmentId,year:'2026',field:'livingAccommodation',amount:777,reason:'Synthetic authorised EA amendment'});
  const amended=await employeeEaStatement(ctx,{employmentId:e.employmentId,year:'2026',companyId:base.companyId});
  expect(amended!.partB).toMatchObject({benefitsInKind:4444,livingAccommodation:777,allowances:1000,exemptAllowances:3000,gross:37221});
  expect(amended!.overrides).toEqual(expect.arrayContaining([{field:'benefitsInKind',original:1800,amended:4444,reason:'Synthetic authorised EA amendment'},{field:'livingAccommodation',original:800,amended:777,reason:'Synthetic authorised EA amendment'}]));
  expect([await slip(jan),await slip(extra.batchId),await slip(feb)]).toEqual(saved);
 });
 it('keeps noncash ownership separate when the existing annual cash-routing mode is active',async()=>{
  const {ctx,e}=await employee();
  const bik=await upsertPayComponent(ctx,{...flags,code:'EA_FUTURE_CAR',name:'Synthetic BIK',displayCategory:'bik',eaFormLine:'EA_B3'});
  const vola=await upsertPayComponent(ctx,{...flags,code:'EA_FUTURE_HOME',name:'Synthetic accommodation',displayCategory:'vola',eaFormLine:'EA_B4'});
  await setEmploymentPayComponent(ctx,{employmentId:e.employmentId,componentId:bik.id,amount:600,effectiveFrom:'2027-01-01'});
  const jan=await regular(ctx,'2027-01');
  const extra=await createAdditionalRun(ctx,{companyId:base.companyId,payPeriod:'2027-01',runType:'bonus'});
  const cash=await upsertPayComponent(ctx,{code:'EA_FUTURE_BONUS',name:'Synthetic cash bonus',kind:'allowance',isNonPayable:false,prorates:false,includedInPcb:true,includedInEpf:true,includedInSocsoEis:false,includedInHrdfBase:false,pcbRemunerationType:'additional',pcbExemptionCode:'PCB_TAXABLE',epfBonus2012:true});
  await setPayrollBatchComponent(ctx,{batchId:extra.batchId,employmentId:e.employmentId,componentId:cash.id,amount:3000});
  await createIndividualTxn(ctx,{batchId:extra.batchId,employmentId:e.employmentId,kind:'earning',componentId:vola.id,txnDate:'2027-01-15',amount:800});await generatePayslips(ctx,{batchId:extra.batchId});
  const regularSaved=await slip(jan),extraSaved=await slip(extra.batchId);
  expect((regularSaved.statutory as any).pcbNonCash.owned.bik).toBe(600);expect((extraSaved.statutory as any).pcbNonCash.owned.bik).toBe(0);
  const form=await employeeEaStatement(ctx,{employmentId:e.employmentId,year:'2027',companyId:base.companyId});
  expect(form!.routing).toMatchObject({active:true,nonCashComplete:true});
  expect(form!.partB).toMatchObject({benefitsInKind:600,livingAccommodation:800,exemptAllowances:0,gross:18400});
 });
 it('keeps an incomplete legacy year unavailable and allows an explicit EA-only amendment',async()=>{
  const {ctx,e}=await employee();const jan=await regular(ctx,'2026-01');const legacy=await slip(jan);
  // A generated cash-only result without the later noncash stamp models old history; no monetary trace is fabricated.
  const old=structuredClone(legacy.statutory as any);delete old.pcbNonCash;
  await owner.db.update(schema.payslip).set({statutory:old}).where(eq(schema.payslip.id,legacy.id));
  const bik=await upsertPayComponent(ctx,{...flags,code:'EA_NEW_CAR',name:'Synthetic later BIK',displayCategory:'bik',eaFormLine:'EA_B3'});
  await setEmploymentPayComponent(ctx,{employmentId:e.employmentId,componentId:bik.id,amount:600,effectiveFrom:'2026-02-01'});
  const feb=await regular(ctx,'2026-02');expect((await slip(feb)).statutory).toMatchObject({pcbNonCash:{owned:{bik:600,vola:0}}});
  const before=await employeeEaStatement(ctx,{employmentId:e.employmentId,year:'2026',companyId:base.companyId});
  expect(before!.routing?.nonCashComplete).toBe(false);expect(before!.partB.benefitsInKind).toBe(0);expect(before!.overrides).toEqual([]);
  await setEaOverride(ctx,{employmentId:e.employmentId,year:'2026',field:'benefitsInKind',amount:888,reason:'Synthetic manual evidence for incomplete legacy year'});
  const after=await employeeEaStatement(ctx,{employmentId:e.employmentId,year:'2026',companyId:base.companyId});expect(after!.routing?.nonCashComplete).toBe(false);
  expect(after!.partB.benefitsInKind).toBe(888);expect(after!.overrides).toContainEqual({field:'benefitsInKind',original:0,amended:888,reason:'Synthetic manual evidence for incomplete legacy year'});
  expect((await slip(jan)).statutory).toEqual(old);
 });
 it('keeps known BIK plus unmapped VOLA unavailable in the actual EA page until explicitly amended',async()=>{
  const {ctx,e}=await employee();sessionState.ctx=ctx;
  const bik=await upsertPayComponent(ctx,{...flags,code:'EA_KNOWN_CAR',name:'Synthetic mapped BIK',displayCategory:'bik',eaFormLine:'EA_B3'});
  const vola=await upsertPayComponent(ctx,{...flags,code:'EA_UNMAPPED_HOME',name:'Synthetic unmapped accommodation',displayCategory:'vola',eaFormLine:null});
  await setEmploymentPayComponent(ctx,{employmentId:e.employmentId,componentId:bik.id,amount:600,effectiveFrom:'2026-01-01'});
  const jan=await regular(ctx,'2026-01');const extra=await createAdditionalRun(ctx,{companyId:base.companyId,payPeriod:'2026-01',runType:'bonus'});
  await createIndividualTxn(ctx,{batchId:extra.batchId,employmentId:e.employmentId,kind:'earning',componentId:vola.id,txnDate:'2026-01-15',amount:800});await generatePayslips(ctx,{batchId:extra.batchId});
  const saved=[await slip(jan),await slip(extra.batchId)];
  expect((saved[0].statutory as any).pcbNonCash.ownedEaEntries).toEqual(expect.arrayContaining([expect.objectContaining({code:'EA_KNOWN_CAR',reportableAmount:600,eaFormLine:'EA_B3'})]));
  expect((saved[1].statutory as any).pcbNonCash.ownedEaEntries).toEqual(expect.arrayContaining([expect.objectContaining({code:'EA_UNMAPPED_HOME',reportableAmount:800,eaFormLine:null})]));
  const form=await employeeEaStatement(ctx,{employmentId:e.employmentId,year:'2026',companyId:base.companyId});
  expect(form!.routing).toMatchObject({nonCashComplete:false,unmapped:expect.arrayContaining([expect.objectContaining({code:'EA_UNMAPPED_HOME'})])});
  expect(form!.partB).toMatchObject({benefitsInKind:0,livingAccommodation:0});
  const render=async()=>renderToStaticMarkup(await EaStatementPage({params:Promise.resolve({employmentId:e.employmentId}),searchParams:Promise.resolve({year:'2026',company:base.companyId})}));
  const row=(html:string,label:string)=>{const start=html.indexOf(label);expect(start).toBeGreaterThan(-1);return html.slice(start,html.indexOf('</div>',start));};
  const before=await render();
  expect(row(before,'3. Benefits in kind')).toContain('>—</span>');expect(row(before,'4. Value of living accommodation provided')).toContain('>—</span>');
  await setEaOverride(ctx,{employmentId:e.employmentId,year:'2026',field:'benefitsInKind',amount:888,reason:'Synthetic manual evidence for incomplete annual mapping'});
  const after=await render();expect(row(after,'3. Benefits in kind')).toContain('RM 888.00');expect(row(after,'3. Benefits in kind')).toContain('Amended');expect(row(after,'4. Value of living accommodation provided')).toContain('>—</span>');
  expect([await slip(jan),await slip(extra.batchId)]).toEqual(saved);
 });

});
