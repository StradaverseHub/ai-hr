import {describe,it,expect} from 'vitest';
import {resignationNotice} from '../lib/resignation-policy';
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
