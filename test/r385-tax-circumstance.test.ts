import {describe,expect,it} from 'vitest';
import {TAX_CIRCUMSTANCE_OPTIONS,taxCircumstanceOf,writeTaxCircumstance,savedTaxCircumstance,readSavedTaxCircumstance} from '../localization/my/tax-circumstance';
import {statutory,coordinatedPcbForPerson} from '../localization/my/payroll';
import {DEFAULT_MY_STATUTORY} from '../localization/my/statutory-tables';
import {explainPcb,pcbTaxCategoryIdentity,pcbWorksheet,pcbDetailLayout} from '../core/pcb-explain';
import {applyStatutoryAdjustment,previewStatutoryAdjustment} from '../core/payroll';

describe('r385 detailed circumstance preserves LHDN math and explicit applicability',()=>{
 it('five distinct choices map to precisely the existing three taxable integers',()=>{
  expect(TAX_CIRCUMSTANCE_OPTIONS.map(x=>[x.value,x.category])).toEqual([['single',1],['spouse_not_working',2],['spouse_working',3],['widow_divorced',3],['none',null]]);
  expect(new Set(TAX_CIRCUMSTANCE_OPTIONS.map(x=>x.value)).size).toBe(5);
 });
 it('legacy1 and3 never guess None or widow; contradictory numeric partial edit retires detail',()=>{
  expect(taxCircumstanceOf(null,1)).toMatchObject({key:null,applicable:true,category:1});
  expect(taxCircumstanceOf(null,3)).toMatchObject({key:null,labelKey:'taxCategoryLegacy3'});
  expect(writeTaxCircumstance({beforeKey:'widow_divorced',beforeCategory:3,category:2})).toMatchObject({taxCircumstance:null,taxCategory:2});
  expect(writeTaxCircumstance({beforeKey:'widow_divorced',beforeCategory:3})).toMatchObject({taxCircumstance:'widow_divorced',taxCategory:3});
 });
 it('only genuine applicability crossings bump epoch; None keeps dormant integer and repeated None is stable',()=>{
  const before={beforeCategory:3,beforeKey:'spouse_working',epoch:5};
  expect(writeTaxCircumstance({...before,key:'widow_divorced'})).toMatchObject({taxApplicabilityEpoch:5,taxCategory:3});
  expect(writeTaxCircumstance({...before,key:'none',category:1})).toMatchObject({taxApplicabilityEpoch:6,taxCategory:3});
  expect(writeTaxCircumstance({beforeCategory:3,beforeKey:'none',epoch:6,key:'none'}).taxApplicabilityEpoch).toBe(6);
  expect(writeTaxCircumstance({beforeCategory:3,beforeKey:'none',epoch:6,key:'single'})).toMatchObject({taxApplicabilityEpoch:7,taxCategory:1});
 });
 it.each([1,2,3] as const)('a renamed category%d leaves every taxable result unchanged across all schemes',category=>{
  for(const scheme of ['resident','non_resident','rep','knowledge_worker','c_suite']){
   const opts={calculationScheme:scheme};
   const before=statutory(8000,{category,children:2},1000,200,{month:6},opts);
   const key=category===1?'single':category===2?'spouse_not_working':'widow_divorced';
   const after=statutory(8000,{category,children:2},1000,200,{month:6},{...opts,taxCircumstance:savedTaxCircumstance(key,category)});
   const {pcbMeta:bm,...moneyBefore}=before,{pcbMeta:am,...moneyAfter}=after;
   expect(moneyAfter).toEqual(moneyBefore);
   const {taxCircumstance:ignored,...sameMeta}=am as typeof am&{taxCircumstance?:unknown};
   expect(sameMeta).toEqual(bm);
  }
 });
 it('None returns zero before invalid scheme/formula access while actual EPF SOCSO EIS remain unchanged',()=>{
  const snapshot=savedTaxCircumstance('none',3,1);
  const opts={calculationScheme:'invalid-formula-route',taxCircumstance:snapshot};
  const none=statutory(9000,{category:3},2000,100,{month:6,acc:{pcbPaid:500,netRemuneration:60000,epfClaimed:4000}},opts);
  const ordinary=statutory(9000,{category:3},2000,100,{month:6});
  expect(none).toMatchObject({pcb:0,pcbBonus:0,pcbNormalPreZakat:0,pcbMeta:{notSubjectToIncomeTax:true,taxCircumstance:snapshot}});
  for(const key of ['epfEmployee','epfEmployer','socsoEmployee','socsoEmployer','socsoSkbbk','eisEmployee','eisEmployer'] as const)expect(none[key]).toBe(ordinary[key]);
  expect(()=>statutory(9000,{category:3},2000,100,{month:6},{calculationScheme:'invalid-formula-route'})).toThrow();
 });
 it('None coordinated employments return zero before touching malformed PCB rules and have no fabricated snapshot',()=>{
  const inputs=[{employmentId:'a',monthlyWage:8000,epfMonthly:800},{employmentId:'b',monthlyWage:9000,epfMonthly:900}];
  const coord=coordinatedPcbForPerson(inputs,{month:6,taxApplicable:false,pcb:{} as typeof DEFAULT_MY_STATUTORY.pcb});
  expect([...coord.byEmployment]).toEqual([['a',{pcb:0,pcbBonus:0}],['b',{pcb:0,pcbBonus:0}]]);
  expect(coord).toMatchObject({combinedMtd:0,combinedAdditional:0,snapshot:null});
  expect(()=>coordinatedPcbForPerson(inputs,{month:6,pcb:{} as typeof DEFAULT_MY_STATUTORY.pcb})).toThrow();
 });
 it('saved widow identity and legacy trace survive later unrelated current profile; malformed stamps refuse',()=>{
  const generated=statutory(7000,{category:3},0,0,{month:6},{taxCircumstance:savedTaxCircumstance('widow_divorced',3)});
  const x=explainPcb(generated,null);
  expect(pcbTaxCategoryIdentity(x)).toMatchObject({category:3,labelKey:'taxCategoryDivorcedWithKids'});
  const old=statutory(7000,{category:3},0,0,{month:6});
  expect(pcbTaxCategoryIdentity(explainPcb(old,null))).toMatchObject({category:3,labelKey:'taxCategoryLegacy3'});
  expect(readSavedTaxCircumstance({...savedTaxCircumstance('widow_divorced',3),category:1})).toBeNull();
 });
 it('None explanation contains intentional bypass, not missing working or any worksheet formula',()=>{
  const x=explainPcb(statutory(7000,{category:3},0,0,{month:6},{taxCircumstance:savedTaxCircumstance('none',3)}),null);
  expect(x.kind).toBe('not_subject');expect(pcbTaxCategoryIdentity(x)).toMatchObject({category:null,applicable:false,labelKey:'taxCategoryNone'});
  expect(pcbWorksheet(x)).toMatchObject({sections:[],note:'taxCategoryNoneExplanation'});
 });
 it('contradictory None deductions and recorded system figures are unavailable',()=>{
  const valid=statutory(7000,{category:3},0,0,{month:6},{taxCircumstance:savedTaxCircumstance('none',3)});
  for(const change of [{pcb:1},{pcb:-1},{pcbBonus:1},{pcbBonus:-1},{adjustment:{reason:'Synthetic contradiction',lines:{pcb:{system:2,applied:0}}}}])expect(explainPcb({...valid,...change},null).kind).toBe('unavailable');
  expect(explainPcb({...valid,pcbMeta:{...valid.pcbMeta,delta:{cumulative:2,prior:20,cumulativeBonus:0}}},null).kind).toBe('unavailable');
  // A prior paid deduction is history, not a refund or a newly applied deduction.
  expect(explainPcb({...valid,pcbMeta:{...valid.pcbMeta,delta:{cumulative:0,prior:20,cumulativeBonus:0}}},null).kind).toBe('not_subject');
 });
 it('saved manual PCB override is suppressed truthfully while other legs and original adjustment stay intact',()=>{
  const computed=statutory(7000,{category:3},0,0,{month:6},{taxCircumstance:savedTaxCircumstance('none',3)});
  const adjustment={values:{pcb:300,epfEmployee:123},reason:'Historical synthetic override'};
  const out=applyStatutoryAdjustment(computed,adjustment);
  expect(out.pcb).toBe(0);expect(out.epfEmployee).toBe(123);
  expect(out).toMatchObject({pcbAdjustmentSuppressed:{requested:300,originalReason:adjustment.reason},adjustment:{lines:{epfEmployee:{applied:123}}}});
  expect(out.adjustment?.lines).not.toHaveProperty('pcb');expect(adjustment.values.pcb).toBe(300);
  expect(()=>previewStatutoryAdjustment({statutory:computed,grossPay:7000,totalDeductions:1000,netPay:6000,employerCost:8000,values:{pcb:300}})).toThrow('Tax Category is None');
 });
});
