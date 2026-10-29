/**
 * b6dbadc5 — the one-off conversion of pre-additive Top-up elections, as pure arithmetic. Each fixture is a
 * stored `voluntary_excess` TOTAL-rate row and the wage/age/citizenship it was last charged on; the proof is
 * that the converted additive election computes the same contribution as the old row at that basis. The
 * RM5,000 employer step is the documented exception and is pinned as such. Nothing here touches a database
 * and the operator script is never run (its `main` only runs when executed directly).
 */
import {describe,expect,it} from 'vitest';
import {epfContribution,type EpfCitizenship} from '../localization/my/payroll';
import {epfAgeOn,epfStatutoryRule,LEGACY_TOPUP_CSV_HEADER,legacyTopupConversionCsv,payPeriodEnd,planLegacyTopupConversion,type LegacyTopupBasis} from '../localization/my/epf-topup-conversion';
import {draftTopupReviewRows} from '../scripts/convert-epf-topup-percentage';

const basis=(base:number,age:number|null,citizenship:EpfCitizenship,source:LegacyTopupBasis['source']='payslip'):LegacyTopupBasis=>({source,payPeriod:source==='payslip'?'2026-09':null,base,age,citizenship});
const old=(employeeRate:number|null,employerRate:number|null)=>({mode:'voluntary_excess' as const,employeeRate,employerRate});

describe('b6dbadc5 legacy Top-up conversion — plan',()=>{
 it('reads the statutory rule the month fell under',()=>{
  expect(epfStatutoryRule(5000,{age:30,citizenship:'citizen'})).toEqual({rule:'part_a',employeeRate:.11,employerRate:.13});
  expect(epfStatutoryRule(5000.01,{age:30,citizenship:'citizen'})).toEqual({rule:'part_a',employeeRate:.11,employerRate:.12});
  expect(epfStatutoryRule(3000,{age:null,citizenship:'pr'})).toMatchObject({rule:'part_a'});
  expect(epfStatutoryRule(3000,{age:30,citizenship:'non_citizen'})).toEqual({rule:'flat',employeeRate:.02,employerRate:.02});
  expect(epfStatutoryRule(3000,{age:60,citizenship:'pr'})).toMatchObject({rule:'flat'});
  expect(epfStatutoryRule(3000,{age:60,citizenship:'citizen'})).toEqual({rule:'part_e',employeeRate:0,employerRate:.04});
  expect(epfStatutoryRule(3000,{age:75,citizenship:'citizen'})).toEqual({rule:'none',employeeRate:0,employerRate:0});
 });
 it('converts the staging shapes: 11%/20% and 13%/13% (a saved 13% employer at a 13% normal rate is a 0% top-up)',()=>{
  expect(planLegacyTopupConversion({employeeRate:.11,employerRate:.2},basis(3000,30,'citizen'))).toMatchObject({action:'convert',rule:'part_a',employeeTopup:0,employerTopup:.07});
  expect(planLegacyTopupConversion({employeeRate:.13,employerRate:.13},basis(4800,30,'citizen'))).toMatchObject({action:'convert',employeeTopup:.02,employerTopup:0});
 });
 it('never produces a negative top-up, and keeps a null side null',()=>{
  expect(planLegacyTopupConversion({employeeRate:.05,employerRate:.05},basis(3000,30,'citizen'))).toMatchObject({employeeTopup:0,employerTopup:0});
  expect(planLegacyTopupConversion({employeeRate:null,employerRate:.15},basis(3000,30,'citizen'))).toMatchObject({employeeTopup:null,employerTopup:.02});
 });
 it('gives 0 where the old election had no effect (Part E, 75+) and says so',()=>{
  expect(planLegacyTopupConversion({employeeRate:.13,employerRate:.13},basis(3000,65,'citizen'))).toMatchObject({action:'convert',note:'election_had_no_effect',rule:'part_e',employeeTopup:0,employerTopup:0});
  expect(planLegacyTopupConversion({employeeRate:.13,employerRate:.13},basis(3000,77,'citizen'))).toMatchObject({note:'election_had_no_effect',rule:'none',employeeTopup:0,employerTopup:0});
 });
 it('skips and reports a row with no basis rather than guessing',()=>{
  expect(planLegacyTopupConversion({employeeRate:.13,employerRate:.13},null)).toMatchObject({action:'skip',note:'no_basis',employeeTopup:null,employerTopup:null});
 });
});

describe('b6dbadc5 legacy Top-up conversion — the next payroll equals the previous result at the basis',()=>{
 const cases:[string,number,number,number|null,number|null,number|null,EpfCitizenship][]=[
  ['Part A, 11%/20%',3000,0,.11,.2,30,'citizen'],
  ['Part A at RM4,800, 13%/13%',4800,0,.13,.13,30,'citizen'],
  ['Part A above RM5,000, 13%/13%',5200,0,.13,.13,30,'citizen'],
  ['Part A with a bonus crossing RM5,000',4500,800,.12,.14,30,'citizen'],
  ['employer only',3000,0,null,.15,30,'citizen'],
  ['below the floor (old election inert)',3000,0,.05,.05,30,'citizen'],
  ['non-citizen flat',3000,0,.11,.13,30,'non_citizen'],
  ['PR 60+ flat',3000,0,.13,.13,65,'pr'],
  ['Part E',3000,0,.13,.13,65,'citizen'],
  ['75+',3000,0,.13,.13,77,'citizen'],
 ];
 it.each(cases)('%s',(_name,wage,bonus,employeeRate,employerRate,age,citizenship)=>{
  const plan=planLegacyTopupConversion({employeeRate,employerRate},basis(wage+bonus,age,citizenship));
  expect(plan.action).toBe('convert');
  const before=epfContribution(wage,bonus,undefined,old(employeeRate,employerRate),{age,citizenship});
  const after=epfContribution(wage,bonus,undefined,{mode:'topup_percentage',employeeRate:plan.employeeTopup,employerRate:plan.employerTopup},{age,citizenship});
  expect(after).toEqual(before);
 });
 it('pins the documented exception: a later wage across the RM5,000 step pays the new step rate plus the top-up',()=>{
  const plan=planLegacyTopupConversion({employeeRate:.13,employerRate:.13},basis(4800,30,'citizen'));
  expect(plan.employerTopup).toBe(0);
  const sel={age:30,citizenship:'citizen' as const};
  expect(epfContribution(5200,0,undefined,old(.13,.13),sel)).toEqual({employee:676,employer:676,employeeOnBonus:0});
  expect(epfContribution(5200,0,undefined,{mode:'topup_percentage',employeeRate:plan.employeeTopup,employerRate:plan.employerTopup},sel)).toEqual({employee:676,employer:624,employeeOnBonus:0});
 });
});

describe('b6dbadc5 legacy Top-up conversion — HR review file',()=>{
 it('lists old and new figures in percent, and leaves skipped rows without new figures',()=>{
  const b=basis(3000,30,'citizen');
  const csv=legacyTopupConversionCsv([
   {status:'would_convert',employeeCode:'E001',name:'Aina, "Fictional"',personId:'p1',basis:b,oldEmployeeRate:.11,oldEmployerRate:.2,plan:planLegacyTopupConversion({employeeRate:.11,employerRate:.2},b)},
   {status:'skipped',employeeCode:'E002',name:'Ben',personId:'p2',basis:null,oldEmployeeRate:.13,oldEmployerRate:.13,plan:planLegacyTopupConversion({employeeRate:.13,employerRate:.13},null)},
  ]);
  const [header,first,second,end]=csv.split('\n');
  expect(header).toBe(LEGACY_TOPUP_CSV_HEADER.join(','));
  expect(first).toBe('would_convert,E001,"Aina, ""Fictional""",p1,,payslip,2026-09,3000.00,30,citizen,part_a,voluntary_excess,11,20,11,13,topup_percentage,0,7,11,20,');
  expect(second).toBe('skipped,E002,Ben,p2,,,,,,,,voluntary_excess,13,13,,,,,,,,no_basis');
  expect(end).toBe('');
 });
 it('lists open drafts whose Top-up boxes still hold full rates, and ignores the rest',()=>{
  const rows=draftTopupReviewRows([
   {id:'d1',label:'New hire',data:{statutory:{epfMode:'voluntary_percentage',epfEmployeeRate:'12',epfEmployerRate:''}}},
   {id:'d2',label:null,data:{statutory:{epfMode:'voluntary_percentage',epfEmployeeRate:' ',epfEmployerRate:''}}},
   {id:'d3',label:'Semi',data:{statutory:{epfMode:'semi_auto',epfEmployeeRate:'12'}}},
   {id:'d4',label:'Empty',data:null},
  ]);
  expect(rows).toEqual([{status:'draft_review',employeeCode:null,name:'New hire',personId:null,draftId:'d1',basis:null,oldEmployeeRate:.12,oldEmployerRate:null,plan:null}]);
  expect(legacyTopupConversionCsv(rows).split('\n')[1]).toBe('draft_review,,New hire,,d1,,,,,,,draft,12,,,,,,,,,draft_full_rates_reenter_as_topup');
 });
 it('measures age at the payslip period end the way the payroll kernel does',()=>{
  expect(payPeriodEnd('2026-02')).toBe('2026-02-28');
  expect(payPeriodEnd('2024-02')).toBe('2024-02-29');
  expect(epfAgeOn('1966-09-30','2026-09-30')).toBe(60);
  expect(epfAgeOn('1966-10-01','2026-09-30')).toBe(59);
  expect(epfAgeOn(null,'2026-09-30')).toBeNull();
 });
});
