import {describe, expect, it} from 'vitest';
import {fireEvent, render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {NextIntlClientProvider} from 'next-intl';
import {EpfElection} from '../components/epf-election';
import {mapEpfUiMode, epfUiModeFrom} from '../lib/epf-mode-map';
import {epf, epfContribution, resolveEpfRates} from '../localization/my/payroll';
import {epfElectionGap, resolveEpfElection} from '../localization/my/epf-election';
import en from '../messages/en.json';

const el = {mode:'manual_percentage' as const, employeeRate:0.055, employerRate:0.065};
const wrap=(mode='manual_percentage',employeeRate:number|null=null,employerRate:number|null=null)=>render(<NextIntlClientProvider locale="en" messages={en}><form><input name="unrelated" defaultValue="Keep this entry"/><EpfElection mode={mode} employeeRate={employeeRate} employerRate={employerRate} employeeAmount={null} employerAmount={null} manualReason={null}/><button>Save</button></form></NextIntlClientProvider>);

describe('5e204d56 manual EPF percentages',()=>{
 it('keeps explicit manual elections distinct from historical top-up elections',()=>{
  expect(mapEpfUiMode('manual_percentage','5.5','6.5')).toMatchObject({epfMode:'manual_percentage',epfEmployeeRate:.055,epfEmployerRate:.065});
  // b6dbadc5 — Top-up now persists as the additive mode; a stored legacy total-rate row still reopens as Top-up.
  expect(mapEpfUiMode('voluntary_percentage','1','1').epfMode).toBe('topup_percentage');
  expect(epfUiModeFrom('topup_percentage',1,1,null,null)).toBe('voluntary_percentage');
  expect(epfUiModeFrom('voluntary_excess',15,16,null,null)).toBe('voluntary_percentage');
  expect(epfUiModeFrom('voluntary_excess',15,null,null,null)).toBe('semi_auto');
  expect(epfUiModeFrom('manual_percentage',5.5,6.5,null,null)).toBe('manual_percentage');
 });
 it.each([['employee',null,.1,'Employee Rate % is required'],['employer',.1,null,'Employer Rate % is required'],['both',null,null,'Employee Rate % is required']])('requires %s rates at the canonical writer',(_side,employee,employer,message)=>{
  expect(()=>resolveEpfElection({epfMode:'manual_percentage',epfEmployeeRate:employee as number|null,epfEmployerRate:employer as number|null})).toThrow(String(message));
 });
 // 1058ced1: the floor is 0%, so 0 and 0.99% are now valid; below 0 and above 100% still fail.
 it.each([-.0001,1.0001,NaN,Infinity,-1])('rejects invalid rate %s on either side',rate=>{
  expect(()=>resolveEpfElection({epfMode:'manual_percentage',epfEmployeeRate:rate,epfEmployerRate:.1})).toThrow();
  expect(()=>resolveEpfElection({epfMode:'manual_percentage',epfEmployeeRate:.1,epfEmployerRate:rate})).toThrow();
 });
 it('accepts exact inclusive boundaries and supported fractional percentages',()=>{
  for(const rate of [0,.0099,.01,.055,.0999,.1,.11,1]) expect(resolveEpfElection({epfMode:'manual_percentage',epfEmployeeRate:rate,epfEmployerRate:rate}).epfEmployeeRate).toBe(rate.toFixed(4));
  expect(()=>resolveEpfElection({epfMode:'manual_percentage',epfEmployeeRate:.01234,epfEmployerRate:.1})).toThrow('two decimal places');
  expect(epfElectionGap('manual_percentage','abc','10',null,null,null)).toBe('epfEmployeeRate');
  expect(epfElectionGap('manual_percentage','5.5','',null,null,null)).toBe('epfEmployerRate');
 });
 // 1058ced1 — the reporter's eight cases, through the same UI mapper and canonical writer the save path uses.
 it.each([
  ['0','4',{epfEmployeeRate:'0.0000',epfEmployerRate:'0.0400'}],
  ['4','0',{epfEmployeeRate:'0.0400',epfEmployerRate:'0.0000'}],
  ['0','0',{epfEmployeeRate:'0.0000',epfEmployerRate:'0.0000'}],
  ['11','12',{epfEmployeeRate:'0.1100',epfEmployerRate:'0.1200'}],
 ] as const)('1058ced1 allows employee %s%% / employer %s%%',(employee,employer,expected)=>{
  expect(resolveEpfElection(mapEpfUiMode('manual_percentage',employee,employer))).toMatchObject({epfMode:'manual_percentage',...expected});
  expect(epfElectionGap('manual_percentage',employee,employer,null,null,null)).toBeNull();
 });
 it.each([
  ['','4','epfEmployeeRate','Employee Rate % is required'],
  ['4','','epfEmployerRate','Employer Rate % is required'],
  ['-1','4','epfEmployeeRate','must be from 0% to 100%'],
  ['4','101','epfEmployerRate','must be from 0% to 100%'],
 ] as const)('1058ced1 rejects employee "%s" / employer "%s" on the named field',(employee,employer,field,message)=>{
  expect(()=>resolveEpfElection(mapEpfUiMode('manual_percentage',employee,employer))).toThrow(message);
  expect(epfElectionGap('manual_percentage',employee,employer,null,null,null)).toBe(field);
 });
 it('1058ced1 pays exactly 0 on a 0% side and the entered rate on the other, with no statutory substitution',()=>{
  const zeroEmployee={mode:'manual_percentage' as const,employeeRate:0,employerRate:.04};
  expect(epf(6000,0,undefined,zeroEmployee)).toEqual({employee:0,employer:240});
  expect(epf(6000,0,undefined,{mode:'manual_percentage',employeeRate:.04,employerRate:0})).toEqual({employee:240,employer:0});
  expect(epf(6000,0,undefined,{mode:'manual_percentage',employeeRate:0,employerRate:0})).toEqual({employee:0,employer:0});
  for(const selection of [{age:30,citizenship:'citizen' as const},{age:65,citizenship:'citizen' as const},{age:30,citizenship:'non_citizen' as const}])
   expect(epfContribution(6000,2000,undefined,zeroEmployee,selection)).toEqual({employee:0,employer:320,employeeOnBonus:0});
 });
 it('uses the saved rates below the schedule, with exact whole-ringgit rounding',()=>{
  expect(resolveEpfRates(6000,undefined,el)).toEqual({employeeRate:.055,employerRate:.065});
  expect(epf(6000,0,undefined,el)).toEqual({employee:330,employer:390});
  expect(epf(1000.01,0,undefined,{mode:'manual_percentage',employeeRate:.01,employerRate:1})).toEqual({employee:11,employer:1020});
  expect(epf(4000,0,undefined,{mode:'voluntary_excess',employeeRate:.09,employerRate:.12})).toEqual({employee:440,employer:520});
  expect(epf(6000,0,undefined,{mode:'manual_amount',employeeAmount:500,employerAmount:650})).toEqual({employee:500,employer:650});
  expect(epf(6000,0,undefined,{mode:'exempt'})).toEqual({employee:0,employer:0});
  expect(epf(100,0,undefined,{mode:'manual_percentage',employeeRate:.55,employerRate:.07})).toEqual({employee:55,employer:7});
  expect(()=>epf(6000,0,undefined,{mode:'manual_percentage',employeeRate:null,employerRate:.1})).toThrow('Employee Rate % is required');
 });
 it.each([{age:30,citizenship:'citizen' as const},{age:65,citizenship:'citizen' as const},{age:78,citizenship:'citizen' as const},{age:30,citizenship:'non_citizen' as const},{age:65,citizenship:'pr' as const}])('applies a manual election consistently for $age $citizenship and reconciles bonus relief',selection=>{
  expect(epfContribution(6000,2000,undefined,el,selection)).toEqual({employee:440,employer:520,employeeOnBonus:110});
 });
 it('shows required manual controls, names missing fields and retains other entries',async()=>{
  wrap();
  const employee=document.querySelector<HTMLInputElement>('input[name="epfEmployeeRate"]')!;
  const employer=document.querySelector<HTMLInputElement>('input[name="epfEmployerRate"]')!;
  expect(employee.required).toBe(true);expect(employer.required).toBe(true);
  expect(employee.min).toBe('0');expect(employer.min).toBe('0');expect(employee.max).toBe('100');
  fireEvent.invalid(employee);fireEvent.invalid(employer);
  expect(screen.getByText(en.people.detail.epfManualEmployeeRateRequired)).toBeVisible();
  expect(screen.getByText(en.people.detail.epfManualEmployerRateRequired)).toBeVisible();
  expect(employee).toHaveAttribute('aria-invalid','true');
  await userEvent.type(employee,'5.5');await userEvent.type(employer,'6.5');
  expect(employee.validity.valid).toBe(true);expect(employer.validity.valid).toBe(true);
  expect(screen.queryByText(en.people.detail.epfManualEmployeeRateRequired)).toBeNull();
  expect(document.querySelector<HTMLInputElement>('input[name="unrelated"]')?.value).toBe('Keep this entry');
 });
 it('b6dbadc5: switching a legacy top-up to Manual (by percentage) shows no adoption message and no tick box',async()=>{
  wrap('voluntary_excess',15,16);
  const category=screen.getByRole('combobox');
  expect(category).toHaveValue('voluntary_percentage');
  // The legacy row shows its stored TOTAL figures; the browser bounds them only to 0–100 (the server decides).
  const employee=document.querySelector<HTMLInputElement>('input[name="epfEmployeeRate"]')!;
  expect(employee.min).toBe('0');expect(employee.max).toBe('100');
  expect(screen.getByText(en.people.detail.epfTopupLegacyHint)).toBeVisible();
  await userEvent.selectOptions(category,'manual_percentage');
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(document.querySelector('[name="epfManualPercentageAdoptionConfirmed"]')).toBeNull();
  expect(en.people.detail).not.toHaveProperty('epfManualAdoptionPreview');
  expect(en.people.detail).not.toHaveProperty('epfManualAdoptionConfirm');
  const form=document.querySelector('form')!;
  expect(form.checkValidity()).toBe(true);
 });
});
