import {describe,it,expect} from 'vitest';
import {normalisePostingValues as nativeValues,postingValueChanges,type PersonnelPostingEvent} from '../lib/personnel-posting';
const normalisePostingValues=(event:PersonnelPostingEvent,raw:Record<string,unknown>)=>nativeValues(event,raw,event==='contractRenewal'||event==='contractConversion'?'contract_staff':'probation');
describe('Contract Personnel posting values',()=>{
 const renew={effectiveDate:'2027-01-01',previousEndDate:'2026-12-31',endDate:'2027-06-30',contractNumber:'5'};
 it('keeps a renewal period and native counter together, without monetary fields',()=>{
  expect(normalisePostingValues('contractRenewal',renew)).toEqual({ok:true,values:renew});
  expect(nativeValues('contractRenewal',renew,'probation').ok).toBe(false);
  expect(nativeValues('contractRenewal',renew,'offboarding').ok).toBe(false);
  expect(normalisePostingValues('contractRenewal',{...renew,basicSalary:9000})).toEqual({ok:false,problem:'fields'});
  expect(normalisePostingValues('contractRenewal',{...renew,employmentType:'full_time'})).toEqual({ok:false,problem:'fields'});
 });
 it('requires valid ordered dates and a whole supported counter',()=>{
  expect(normalisePostingValues('contractRenewal',{...renew,effectiveDate:'2027-02-30'}).ok).toBe(false);
  expect(normalisePostingValues('contractRenewal',{...renew,effectiveDate:renew.previousEndDate}).ok).toBe(false);
  expect(normalisePostingValues('contractRenewal',{...renew,endDate:renew.effectiveDate}).ok).toBe(false);
  for(const contractNumber of ['0','-1','4.5','100001','05',5,null])expect(normalisePostingValues('contractRenewal',{...renew,contractNumber}).ok).toBe(false);
 });
 it('a permanent conversion has no new contract end or counter and preserves the previous period boundary',()=>{
  const conversion={effectiveDate:renew.effectiveDate,previousEndDate:renew.previousEndDate};
  expect(normalisePostingValues('contractConversion',conversion)).toEqual({ok:true,values:conversion});
  expect(normalisePostingValues('contractConversion',{...conversion,endDate:renew.endDate}).ok).toBe(false);
  expect(normalisePostingValues('contractConversion',{...conversion,contractNumber:'5'}).ok).toBe(false);
 });
 it('leaves Probation allowlists unchanged and includes Contract corrections in the audit comparison',()=>{
  expect(normalisePostingValues('confirmation',{effectiveDate:'2027-01-01',contractNumber:'5'})).toEqual({ok:false,problem:'fields'});
  expect(normalisePostingValues('probationExtension',{effectiveDate:'2027-01-01',endDate:'2027-03-01'}).ok).toBe(true);
  expect(postingValueChanges(renew,{...renew,contractNumber:'6'})).toEqual([{field:'contractNumber',before:'5',after:'6'}]);
 });
});
