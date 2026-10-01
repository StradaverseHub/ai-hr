import fs from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe,it,expect,vi,beforeAll,afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { pcbMonth } from '../localization/my/payroll';
import { explainPcb,pcbMtdStep1Section,pcbClosingSections,type PcbExplanation } from '../core/pcb-explain';
import { pcbNormalMtdStep1Blocks,pcbFormulaBlocks } from '../app/payroll/pcb-detail/formulas';
import { PcbDetailView } from '../app/payroll/pcb-detail/pcb-detail-view';
import { pcbDetailPdfResponse } from '../app/payroll/pcb-detail/shared';
import { extractedText } from './helpers/pcb-pdf-text';
import { adminCtx,owner,migrateTestDb,seedBase,closeAll } from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch,generatePayslips,setPayrollInput } from '../core/payroll';
import { payslipForReview } from '../core/payroll-view';
import * as schema from '../db/schema';
const state=vi.hoisted(()=>({locale:'en',auth:null as any}));
vi.mock('../lib/scope',async(importOriginal)=>({...await importOriginal<any>(),scopedAdmin:async()=>state.auth}));
vi.mock('next-intl/server',async()=>{const {createTranslator}=await import('next-intl');const fs=await import('node:fs');return {getTranslations:async(arg:any)=>{const locale=typeof arg==='string'?state.locale:arg.locale??state.locale;return createTranslator({locale,messages:JSON.parse(fs.readFileSync(`messages/${locale}.json`,'utf8')),namespace:typeof arg==='string'?arg:arg.namespace})}}});
const f={b2:(n:number)=>n.toLocaleString('en-MY',{minimumFractionDigits:2,maximumFractionDigits:2}),pct:(n:number)=>`${(n*100).toFixed(2)}%`,int:String};
const input={monthlyWage:14000.37,epfMonthly:1540,month:7,profile:{category:2 as const,children:3},acc:{netRemuneration:63000,epfClaimed:800,pcbPaid:4100,zakatPaid:250,lpAccumulated:480},lpCurrent:90};
function readRun(options:Partial<Parameters<typeof pcbMonth>[0]>={},override:Record<string,unknown>={}){
 const r=pcbMonth({...input,...options});const x=explainPcb({pcb:r.total,pcbBonus:r.additional,epfEmployee:input.epfMonthly,zakat:options.zakatCurrent??0,pcbMeta:r.snapshot,...override},null);
 if(x.kind!=='mtd')throw Error('Expected real resident trace');return {r,x};
}
const amount=(x:Extract<PcbExplanation,{kind:'mtd'}>,caption:string)=>pcbMtdStep1Section(x).rows.find(row=>row.caption===caption)!.first;
describe('454d79a9 saved normal MTD Step 1 contract',()=>{
 it('reads all seven saved variables and reuses the existing monthly block without mutating the global sequence',()=>{
  const {x,r}=readRun();const sec=pcbMtdStep1Section(x);expect(sec.normalMtdWorking).toBe(true);
  expect(sec.rows.map(row=>row.line)).toEqual(['P','M','R','B','Z','X','n','1','Z1','A','']);
  expect(amount(x,'worksheetP')).toEqual({kind:'money',amount:r.snapshot.P1});expect(amount(x,'bracketR')).toEqual({kind:'rate',rate:x.trace!.R});
  expect(amount(x,'bracketM')).toEqual({kind:'money',amount:x.trace!.M});expect(amount(x,'bracketB')).toEqual({kind:'money',amount:x.trace!.B});expect(amount(x,'worksheetN')).toEqual({kind:'count',count:x.remainingMonths});
  expect(amount(x,'worksheetZ')).toEqual({kind:'money',amount:250});expect(amount(x,'worksheetX')).toEqual({kind:'money',amount:4100});
  const before=pcbFormulaBlocks(x,f);const blocks=pcbNormalMtdStep1Blocks(x,f);expect(blocks[0]).toEqual(before.find(b=>b.key==='mtd'));expect(pcbFormulaBlocks(x,f)).toEqual(before);
  expect(blocks[1].result).toBe(r.normal);expect(blocks[1].substituted).toContain(f.b2(x.trace!.mtdNormalFloored));
 });
 it('keeps current rebate separate from accumulated rebate and preserves the normal result in a bonus month',()=>{
  const {x,r}=readRun({additional:26000,epfOnAdditional:600,zakatCurrent:60});expect(r.additional).toBeGreaterThan(0);
  expect(amount(x,'slipStep1CurrentRebate')).toEqual({kind:'money',amount:60});expect(amount(x,'worksheetZ')).toEqual({kind:'money',amount:250});
  expect(pcbNormalMtdStep1Blocks(x,f)[1].result).toBe(r.normal);expect(pcbNormalMtdStep1Blocks(x,f)[1].result).not.toBe(r.total);
  expect(pcbFormulaBlocks(x,f).find(b=>b.key==='net')!.result).toBe(r.total);
 });
 it('excess current rebate clamps normal to zero and leaves recorded additional treatment separate',()=>{
  const noRebate=readRun({additional:26000,epfOnAdditional:600});
  const {x,r}=readRun({additional:26000,epfOnAdditional:600,zakatCurrent:noRebate.r.normal+125});
  expect(r.normal).toBe(0);expect(r.additional).toBeGreaterThan(0);expect(x.trace!.zakatLeftover).toBe(125);
  expect(pcbNormalMtdStep1Blocks(x,f)[1].result).toBe(0);expect(pcbNormalMtdStep1Blocks(x,f)[1].substituted).toMatch(/^max\( 0,/);
 });
 it('shows saved fractional rounding and the low-deduction floor instead of a new UI calculation',()=>{
  const rounded=readRun();expect(rounded.x.trace!.mtdNormalCalc).toBe(rounded.r.snapshot.trace!.mtdNormalCalc);
  expect(pcbNormalMtdStep1Blocks(rounded.x,f)[0].result).toBe(rounded.r.snapshot.trace!.mtdNormalCalc);
  expect(rounded.x.trace!.mtdNormalCalc.toFixed(2)).toMatch(/[05]$/);
  const low=readRun({monthlyWage:3500,epfMonthly:385,month:1,profile:{category:1,children:0},acc:{netRemuneration:0,epfClaimed:0,pcbPaid:0,zakatPaid:0}});
  expect(low.x.trace!.mtdNormalCalc).toBeGreaterThan(0);expect(low.x.trace!.mtdNormalCalc).toBeLessThan(10);expect(low.x.trace!.mtdNormalFloored).toBe(0);expect(pcbNormalMtdStep1Blocks(low.x,f)[1].result).toBe(0);
 });
 it('manual override and additional-run delta retain the cumulative normal working rather than the applied deduction',()=>{
  const {r}=readRun({additional:26000,epfOnAdditional:600,zakatCurrent:60});
  const manual=readRun({additional:26000,epfOnAdditional:600,zakatCurrent:60},{pcb:123.47,adjustment:{reason:'Synthetic approved adjustment',lines:{pcb:{system:r.total,applied:123.47}}}}).x;
  expect(manual.pcb).toBe(123.47);expect(pcbNormalMtdStep1Blocks(manual,f)[1].result).toBe(r.normal);
  const delta=readRun({additional:26000,epfOnAdditional:600,zakatCurrent:60},{pcb:45.35,pcbBonus:45.35,pcbMeta:{...r.snapshot,delta:{cumulative:r.total,prior:r.total-45.35,cumulativeBonus:r.additional}}}).x;
  expect(delta.pcb).toBe(45.35);expect(pcbNormalMtdStep1Blocks(delta,f)[1].result).toBe(r.normal);
 });
 it('missing or incomplete historical trace never fabricates zero variables, rebate, or normal net',()=>{
  const {r}=readRun();for(const trace of [undefined,{}, {M:0,R:0,mtdNormalCalc:0}]){
   const x=explainPcb({pcb:402.65,pcbMeta:{...r.snapshot,trace}},null);if(x.kind!=='mtd')throw Error('Missing metadata shape');
   expect(x.trace).toBeNull();expect(pcbMtdStep1Section(x).rows.every(row=>row.first.kind==='notRecorded')).toBe(true);
   expect(pcbNormalMtdStep1Blocks(x,f).every(block=>block.result===null&&block.substituted===null)).toBe(true);
  }
 });
});
describe('454d79a9 actual processed screen/PDF content',()=>{
 beforeAll(migrateTestDb);afterAll(closeAll);
 it('real generated payslip carries identical Step 1 captions, substitution and normal result on screen and PDF, with selected-scope isolation',async()=>{
  const base=await seedBase();const ctx=adminCtx(base);state.auth={s:ctx,scopeIds:[base.companyId]};
  const e=await hireEmployee(ctx,{person:{fullName:'Synthetic Step One',primaryEmail:'synthetic-step-one@example.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
  await setCompensation(ctx,{employmentId:e.employmentId,basicSalary:14000.37,monthlyAllowance:0,effectiveFrom:'2026-01-01'});await setStatutoryProfileMY(ctx,{personId:e.personId,icNumber:'900101011234'});
  const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:'2026-07'});await setPayrollInput(ctx,{batchId,employmentId:e.employmentId,overtimeAmount:0,bonusAmount:26000,zakat:60});await generatePayslips(ctx,{batchId});
  const [slip]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));const row=await payslipForReview(ctx,{companyIds:[base.companyId],payslipId:slip.id});expect(row).toBeTruthy();
  const x=explainPcb(row!.statutory,null);if(x.kind!=='mtd')throw Error('Expected generated trace');const block=pcbNormalMtdStep1Blocks(x,f)[1];
  for(const locale of ['en','ms','zh','ta','th','vi']){
   state.locale=locale;const captions=JSON.parse(fs.readFileSync(`messages/${locale}.json`,'utf8')).payroll.pcbDetail;
   const html=renderToStaticMarkup(await PcbDetailView({ctx:{employeeCode:'SYNTH',employeeName:'Synthetic Step One',company:'Synthetic Company',periodLabel:'July 2026',payPeriod:'2026-07',runType:'regular',runSeq:1,currency:'MYR',rulesetVersion:null,identityNumber:null,identityIsPassport:false,taxNumber:null,taxCategory:1},explanation:x,worksheet:null,slip:[],closing:pcbClosingSections(x)}));
   expect(html).toContain(captions.slipStep1CombinedHeading);expect(html).toContain(captions.slipStep1PMeaning);expect(html).toContain(block.substituted!);expect(html).toContain(captions.slipStep1CurrentRebate);
   if(locale==='en'||locale==='ms'){
    const response=await pcbDetailPdfResponse(new Request(`http://example.test/payroll/pcb-detail/pdf?payslipId=${slip.id}&lang=${locale}`),'attachment');expect(response.status).toBe(200);
    const bytes=new Uint8Array(await response.arrayBuffer());fs.writeFileSync(`scratchpad/r378-payroll/step1-${locale}.pdf`,bytes);const text=await extractedText(bytes);
    expect(text).toContain(captions.slipStep1CombinedHeading);expect(text).toContain(captions.slipStep1PMeaning);expect(text).toContain(block.substituted!);expect(text).toContain(captions.slipStep1CurrentRebate);
    const step1=text.slice(text.indexOf(captions.slipStep1CombinedHeading),text.indexOf(captions.slipStep2Heading));
    expect(step1).toContain(f.b2(x.pcbNormal));expect(step1).not.toContain(f.b2(x.pcbSystem));
   }
  }
  state.auth={s:ctx,scopeIds:[]};expect((await pcbDetailPdfResponse(new Request(`http://example.test/payroll/pcb-detail/pdf?payslipId=${slip.id}`),'inline')).status).toBe(404);
 });
});
