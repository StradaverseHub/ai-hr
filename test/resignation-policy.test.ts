import {describe,it,expect} from 'vitest';
import {evaluateAutomationCondition} from '../lib/automation/conditions';
import {resignationNotice,resignationBaseIncrement} from '../lib/resignation-policy';
import {defaultSettlementPolicy} from '../lib/lifecycle-v9-calculator';

describe('resignation notice follows the existing Personnel/final-pay policy',()=>{
 it('does not infer probation from missing confirmation and uses employment notice before the grade table',()=>{
  expect(resignationNotice({jobGrade:'M1',employmentType:'full_time'},'2026-11-16')).toEqual({earliestLastDay:'2027-01-16',noticeLabel:'2 months'});
  expect(resignationNotice({jobGrade:'M1',employmentType:'full_time',noticeAfter:{value:3,unit:'week'}},'2026-11-16')).toEqual({earliestLastDay:'2026-12-07',noticeLabel:'3 weeks'});
 });
 it('applies the before-confirmation notice only when final confirmation is after submission',()=>{
  const facts={jobGrade:'M1',employmentType:'full_time',finalConfirmationDate:'2026-12-01',noticeBefore:{value:2,unit:'week'} as const,noticeAfter:{value:3,unit:'month'} as const};
  expect(resignationNotice(facts,'2026-11-16').earliestLastDay).toBe('2026-11-30');
  expect(resignationNotice(facts,'2026-12-01').earliestLastDay).toBe('2027-03-01');
 });
 it('uses contract policy independently of confirmation and respects month-end boundaries',()=>{
  expect(resignationNotice({jobGrade:'M1',employmentType:'contract'},'2026-01-31')).toEqual({earliestLastDay:'2026-02-28',noticeLabel:'1 month'});
 });
 it('uses the policy default for an unknown grade and the existing working-day calculation',()=>{
  const policy=defaultSettlementPolicy();policy.defaultNotice={value:2,unit:'day'};policy.noticeDays='working';
  expect(resignationNotice({jobGrade:'UNKNOWN',employmentType:'full_time'},'2026-11-13',policy)).toEqual({earliestLastDay:'2026-11-17',noticeLabel:'2 days'});
 });
});

describe('retention increment workflow conditions',()=>{
 const matches=(previous:string|null|undefined,next:string|null|undefined,op:'lt'|'lte'|'gte',threshold:string)=>evaluateAutomationCondition({field:'baseIncrement',op,values:[threshold]},resignationBaseIncrement(previous,next)).ok;
 it('keeps exactly ten percent on the boundary instead of leaking floating-point noise into routing',()=>{
  expect(resignationBaseIncrement('5000.00','5500.00')).toBe('10');
  expect(matches('5000.00','5500.00','gte','10')).toBe(true);expect(matches('5000.00','5500.00','lte','10')).toBe(true);expect(matches('5000.00','5500.00','lt','10')).toBe(false);expect(matches('5000.00','5500.00','gte','10.000001')).toBe(false);
 });
 it('distinguishes one-cent increases immediately above and below the threshold under the existing percent precision',()=>{
  expect(resignationBaseIncrement('5000','5500.01')).toBe('10.0002');expect(matches('5000','5500.01','gte','10.000001')).toBe(true);expect(matches('5000','5500.01','lte','10')).toBe(false);
  expect(resignationBaseIncrement('5000','5499.99')).toBe('9.9998');expect(matches('5000','5499.99','lt','10')).toBe(true);expect(matches('5000','5499.99','gte','10')).toBe(false);
  expect(resignationBaseIncrement('3000','3333.33')).toBe('11.111');
 });
 it('supplies no numeric routing fact for a zero, missing or malformed base',()=>{
  for(const base of ['0','0.00',null,undefined,'','not-money']){expect(resignationBaseIncrement(base,'5500.00')).toBeNull();expect(matches(base,'5500.00','gte','0')).toBe(false);expect(matches(base,'5500.00','lte','0')).toBe(false);}
  expect(resignationBaseIncrement('5000.00',null)).toBeNull();expect(resignationBaseIncrement('5000.00','5000.00')).toBe('0');
 });
});
