/**
 * b6dbadc5 — Top-up (existing percentage election) is an ADDITIVE top-up on the normal EPF rate, persisted as
 * its own `topup_percentage` mode. Pure: calculator, validator, mapper, legacy-row retention and the Bank &
 * Statutory import preview. Expected figures are worked by hand from the Third Schedule rates (11% employee;
 * 13% employer at or below RM5,000, 12% above; Part E employer 4%; non-citizen flat 2%/2%).
 */
import {describe,expect,it} from 'vitest';
import {epf,epfContribution,resolveEpfRates,type EpfElection} from '../localization/my/payroll';
import {epfRateInputBounds,InvalidEpfElectionError,resolveEpfElection} from '../localization/my/epf-election';
import {epfUiModeFrom,isLegacyTotalTopup,mapEpfUiMode,retainLegacyTotalTopup} from '../lib/epf-mode-map';
import {bankStatutoryBeforeState,bankStatutoryStateFrom,bankStatutoryTopupBasis} from '../lib/bank-statutory-import';
import {bankStatutoryMergedErrors} from '../core/bank-statutory-import';
import {requirePackFor} from '../localization/registry';

const topup=(employeeRate:number|null,employerRate:number|null):EpfElection=>({mode:'topup_percentage',employeeRate,employerRate});
const NO_AMOUNT={epfEmployeeAmount:null,epfEmployerAmount:null,epfManualReason:null};

describe('b6dbadc5 additive Top-up — calculator',()=>{
 it('adds the top-up to the normal rate on each side (the reporter example: 11%+1% and 12%+1%)',()=>{
  expect(resolveEpfRates(6000,undefined,topup(.01,.01))).toEqual({employeeRate:.12,employerRate:.13});
  // At or below RM5,000 the normal employer rate is 13%, so +1% is 14%.
  expect(resolveEpfRates(4000,undefined,topup(.01,.01))).toEqual({employeeRate:.12,employerRate:.14});
  expect(epf(6000,0,undefined,topup(.01,.01))).toEqual({employee:720,employer:780});
  expect(epf(4000,0,undefined,topup(.01,.01))).toEqual({employee:480,employer:560});
 });
 it('0% and a blank side add nothing: the statutory schedule amount stands',()=>{
  const statutory=epf(4000,0);
  expect(statutory).toEqual({employee:440,employer:520});
  expect(epf(4000,0,undefined,topup(0,0))).toEqual(statutory);
  expect(epf(4000,0,undefined,topup(null,null))).toEqual(statutory);
  expect(epf(4000,0,undefined,topup(.01,null))).toEqual({employee:480,employer:520});
  expect(resolveEpfRates(4000,undefined,topup(null,.02))).toEqual({employeeRate:.11,employerRate:.15});
 });
 it('clamps the combined rate at 100% defensively',()=>{
  expect(resolveEpfRates(4000,undefined,topup(.95,.95))).toEqual({employeeRate:1,employerRate:1});
 });
 it('keeps the combined-month lookup and the bonus-relief split',()=>{
  expect(epfContribution(6000,2000,undefined,topup(.01,.01),{age:30,citizenship:'citizen'})).toEqual({employee:960,employer:1040,employeeOnBonus:240});
  expect(epfContribution(6000,2000,undefined,undefined,{age:30,citizenship:'citizen'})).toEqual({employee:880,employer:960,employeeOnBonus:220});
 });
 it('applies on the non-citizen / PR 60+ flat 2% rate',()=>{
  expect(epfContribution(3000,0,undefined,undefined,{age:30,citizenship:'non_citizen'})).toEqual({employee:60,employer:60,employeeOnBonus:0});
  expect(epfContribution(3000,0,undefined,topup(.01,.01),{age:30,citizenship:'non_citizen'})).toEqual({employee:90,employer:90,employeeOnBonus:0});
  expect(epfContribution(3000,0,undefined,topup(.01,.01),{age:65,citizenship:'pr'})).toEqual({employee:90,employer:90,employeeOnBonus:0});
 });
 it('applies on Part E (citizen 60 to under 75): employee 0% + top-up, employer 4% + top-up',()=>{
  expect(epfContribution(3000,0,undefined,undefined,{age:65,citizenship:'citizen'})).toEqual({employee:0,employer:120,employeeOnBonus:0});
  expect(epfContribution(3000,0,undefined,topup(.01,.01),{age:65,citizenship:'citizen'})).toEqual({employee:30,employer:150,employeeOnBonus:0});
  expect(epfContribution(3000,0,undefined,topup(null,null),{age:65,citizenship:'citizen'})).toEqual({employee:0,employer:120,employeeOnBonus:0});
 });
 it('adds nothing from 75, where there is no contribution',()=>{
  expect(epfContribution(3000,0,undefined,topup(.05,.05),{age:78,citizenship:'citizen'})).toEqual({employee:0,employer:0,employeeOnBonus:0});
 });
 it('leaves Semi-Auto (voluntary_excess, employee only) on its total-rate max(elected, statutory) meaning',()=>{
  expect(epf(4000,0,undefined,{mode:'voluntary_excess',employeeRate:.12,employerRate:null})).toEqual({employee:480,employer:520});
  expect(epf(4000,0,undefined,{mode:'voluntary_excess',employeeRate:.09,employerRate:null})).toEqual({employee:440,employer:520});
  expect(resolveEpfRates(4000,undefined,{mode:'voluntary_excess',employeeRate:.15})).toEqual({employeeRate:.15,employerRate:.13});
 });
});

describe('b6dbadc5 additive Top-up — validation owner',()=>{
 it('accepts 0, blanks and increments up to 100% less the highest statutory rate',()=>{
  expect(resolveEpfElection({epfMode:'topup_percentage',epfEmployeeRate:.01,epfEmployerRate:.01})).toEqual({epfMode:'topup_percentage',epfEmployeeRate:'0.0100',epfEmployerRate:'0.0100',...NO_AMOUNT});
  expect(resolveEpfElection({epfMode:'topup_percentage',epfEmployeeRate:0,epfEmployerRate:null})).toMatchObject({epfEmployeeRate:'0.0000',epfEmployerRate:null});
  expect(resolveEpfElection({epfMode:'topup_percentage',epfEmployeeRate:.89,epfEmployerRate:.87})).toMatchObject({epfEmployeeRate:'0.8900',epfEmployerRate:'0.8700'});
  expect(resolveEpfElection({epfMode:'topup_percentage',epfEmployeeRate:.0125,epfEmployerRate:null}).epfEmployeeRate).toBe('0.0125');
 });
 it.each([
  [.8901,null,'epfEmployeeRate','Top-up Employee Rate %'],
  [null,.8701,'epfEmployerRate','Top-up Employer Rate %'],
  [-.01,null,'epfEmployeeRate','Top-up Employee Rate %'],
  [null,NaN,'epfEmployerRate','not a number'],
  [.01234,null,'epfEmployeeRate','two decimal places'],
 ] as const)('refuses employee %s / employer %s, naming the box',(employee,employer,field,message)=>{
  let caught:unknown;
  try{resolveEpfElection({epfMode:'topup_percentage',epfEmployeeRate:employee,epfEmployerRate:employer});}catch(error){caught=error;}
  expect(caught).toBeInstanceOf(InvalidEpfElectionError);
  expect((caught as InvalidEpfElectionError).field).toBe(field);
  expect((caught as Error).message).toContain(message);
 });
 it('drops amounts and reason for a top-up',()=>{
  expect(resolveEpfElection({epfMode:'topup_percentage',epfEmployeeRate:.01,epfEmployerRate:null,epfEmployeeAmount:500,epfManualReason:'x'})).toMatchObject(NO_AMOUNT);
 });
 it('derives the browser bounds from the same table',()=>{
  expect(epfRateInputBounds('voluntary_percentage','employee')).toEqual({min:0,max:89});
  expect(epfRateInputBounds('voluntary_percentage','employer')).toEqual({min:0,max:87});
  expect(epfRateInputBounds('voluntary_percentage','employer',true)).toEqual({min:0,max:100});
  expect(epfRateInputBounds('semi_auto','employee')).toEqual({min:11,max:100});
  expect(epfRateInputBounds('manual_percentage','employer')).toEqual({min:1,max:100});
 });
});

describe('b6dbadc5 additive Top-up — mapper and unconverted legacy rows',()=>{
 it('round-trips Top-up through its own mode, distinct from Semi-Auto',()=>{
  expect(mapEpfUiMode('voluntary_percentage','1','0')).toEqual({epfMode:'topup_percentage',epfEmployeeRate:.01,epfEmployerRate:0,...NO_AMOUNT});
  expect(mapEpfUiMode('voluntary_percentage','',' ')).toEqual({epfMode:'topup_percentage',epfEmployeeRate:null,epfEmployerRate:null,...NO_AMOUNT});
  expect(mapEpfUiMode('semi_auto','15','99').epfMode).toBe('voluntary_excess');
  // A top-up with only the employee side set must not read back as Semi-Auto.
  expect(epfUiModeFrom('topup_percentage',1,null,null,null)).toBe('voluntary_percentage');
  expect(epfUiModeFrom('topup_percentage',null,null,null,null)).toBe('voluntary_percentage');
  expect(epfUiModeFrom('voluntary_excess',15,null,null,null)).toBe('semi_auto');
  expect(epfUiModeFrom('voluntary_excess',15,16,null,null)).toBe('voluntary_percentage');
 });
 it('keeps a stored legacy total-rate row only when its own figures are re-posted',()=>{
  const legacy={epfMode:'voluntary_excess',epfEmployeeRate:'0.1100',epfEmployerRate:'0.2000'};
  expect(isLegacyTotalTopup(legacy.epfMode,legacy.epfEmployerRate)).toBe(true);
  expect(isLegacyTotalTopup('voluntary_excess',null)).toBe(false);
  expect(retainLegacyTotalTopup(mapEpfUiMode('voluntary_percentage','11','20'),legacy)).toEqual({epfMode:'voluntary_excess',epfEmployeeRate:.11,epfEmployerRate:.2,...NO_AMOUNT});
  expect(retainLegacyTotalTopup(mapEpfUiMode('voluntary_percentage','1','20'),legacy).epfMode).toBe('topup_percentage');
  expect(retainLegacyTotalTopup(mapEpfUiMode('manual_percentage','11','20'),legacy).epfMode).toBe('manual_percentage');
  // Semi-Auto rows and already-additive rows are never legacy top-ups.
  expect(retainLegacyTotalTopup(mapEpfUiMode('voluntary_percentage','12',''),{epfMode:'voluntary_excess',epfEmployeeRate:'0.1200',epfEmployerRate:null}).epfMode).toBe('topup_percentage');
  expect(retainLegacyTotalTopup(mapEpfUiMode('voluntary_percentage','1','1'),{epfMode:'topup_percentage',epfEmployeeRate:'0.0100',epfEmployerRate:'0.0100'}).epfMode).toBe('topup_percentage');
  expect(retainLegacyTotalTopup(mapEpfUiMode('voluntary_percentage','11','20'),null).epfMode).toBe('topup_percentage');
 });
 it('records the import-history basis of a Top-up rate',()=>{
  expect(bankStatutoryTopupBasis({epfMode:'voluntary_excess',epfEmployerRate:'0.2000'})).toBe('total');
  expect(bankStatutoryTopupBasis({epfMode:'voluntary_excess',epfEmployerRate:null})).toBe('additive');
  expect(bankStatutoryTopupBasis({epfMode:'topup_percentage',epfEmployerRate:'0.0100'})).toBe('additive');
  expect(bankStatutoryTopupBasis(null)).toBe('additive');
  // Recorded only on items that changed the EPF election; other items keep their earlier shape.
  const legacy={epfMode:'voluntary_excess',epfEmployerRate:'0.2000'};
  expect(bankStatutoryBeforeState('E1',{epf_employer_rate:'20'},legacy)).toEqual({employeeCode:'E1',fields:{epf_employer_rate:'20'},epfTopupBasis:'total'});
  expect(bankStatutoryBeforeState('E1',{epf_category:'auto'},null)).toEqual({employeeCode:'E1',fields:{epf_category:'auto'},epfTopupBasis:'additive'});
  expect(bankStatutoryBeforeState('E1',{tax_number:'T1'},legacy)).toEqual({employeeCode:'E1',fields:{tax_number:'T1'}});
 });
});

describe('b6dbadc5 Bank & Statutory import preview',()=>{
 const subject={pack:requirePackFor('MY'),country:'MY'} as Parameters<typeof bankStatutoryMergedErrors>[0];
 const extra={taxResidency:'',paymentMethod:null};
 const legacy=bankStatutoryStateFrom({epfMode:'voluntary_excess',epfEmployeeRate:'0.1100',epfEmployerRate:'0.2000',epfCitizenship:'citizen'},extra);
 const auto=bankStatutoryStateFrom({epfMode:'auto',epfCitizenship:'citizen'},extra);
 it('accepts an additive top-up, including 0% and a blank side',()=>{
  expect(bankStatutoryMergedErrors(subject,auto,{epf_category:'voluntary_percentage',epf_employee_rate:'1',epf_employer_rate:'0'})).toEqual([]);
  expect(bankStatutoryMergedErrors(subject,auto,{epf_category:'voluntary_percentage',epf_employee_rate:'',epf_employer_rate:'2'})).toEqual([]);
 });
 it('refuses a top-up above the cap or below 0, naming the box',()=>{
  expect(bankStatutoryMergedErrors(subject,auto,{epf_category:'voluntary_percentage',epf_employee_rate:'89.01'})).toEqual([expect.stringContaining('Top-up Employee Rate % must be from 0% to 89%')]);
  expect(bankStatutoryMergedErrors(subject,auto,{epf_category:'voluntary_percentage',epf_employee_rate:'-1'})).toEqual([expect.stringContaining('Top-up Employee Rate %')]);
 });
 it('lets a stored legacy row be re-posted unchanged, but judges a changed one as additive',()=>{
  expect(legacy).toMatchObject({epf_category:'voluntary_percentage',epf_employee_rate:'11',epf_employer_rate:'20'});
  expect(bankStatutoryMergedErrors(subject,legacy,{epf_category:'voluntary_percentage',epf_employee_rate:'11',epf_employer_rate:'20'})).toEqual([]);
  expect(bankStatutoryMergedErrors(subject,legacy,{epf_employer_rate:'95'})).toEqual([expect.stringContaining('Top-up Employer Rate % must be from 0% to 87%')]);
 });
 it('keeps Semi-Auto on its statutory floor',()=>{
  expect(bankStatutoryMergedErrors(subject,auto,{epf_category:'semi_auto',epf_employee_rate:'10'})).toEqual([expect.stringContaining('at or above the statutory 11%')]);
 });
});
