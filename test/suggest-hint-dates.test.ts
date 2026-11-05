/** The overtime card's native hint check sees a date, never the person's words for a day (eval on ef479b55c, run
 * 41959520636, mgr-overtime-1: "plan overtime for me this Saturday from 9am to 1pm" passed date "this saturday" to
 * suggest_action, which the hint schema refused as a missing date, so both passes asked for the date and the hours).
 * core/harness/tools.ts suggestHint works the day out with the HR date owner's rule first, the same rule the overtime
 * preparer runs. Expected dates are written out by hand: Thursday 5 November 2026, noon in Kuala Lumpur. Pure. */
import {describe,expect,it} from 'vitest';
import {suggestHint} from '../core/harness/tools';
import {checkProposal} from '../core/product-context/tools';

const now=new Date('2026-11-05T04:00:00.000Z'),words='plan overtime for me this Saturday from 9am to 1pm for the stock take';

describe('the overtime hint',()=>{
 it('turns the person\'s day into a date the hint check accepts, and leaves the reason out',()=>{
  const hint=suggestHint('attendance.overtime.request',{date:'this saturday',plannedStartTime:'09:00',plannedEndTime:'13:00',reason:'stock take'},words,now);
  expect(hint).toEqual({date:'2026-11-07',plannedStartTime:'09:00',plannedEndTime:'13:00'});
  expect(checkProposal('attendance.overtime.request',hint)).toEqual({valid:true,action:'attendance.overtime.request'});
  // Before the fix the words went to the check unchanged, and it refused every detail.
  expect(checkProposal('attendance.overtime.request',{date:'this saturday',plannedStartTime:'09:00',plannedEndTime:'13:00'})).toEqual({valid:false,missing:['date','plannedStartTime','plannedEndTime']});
 });
 it('follows the person\'s words over a date the model worked out, and keeps a date the person wrote',()=>{
  expect(suggestHint('attendance.overtime.request',{date:'2026-11-14',plannedStartTime:'09:00',plannedEndTime:'13:00'},words,now)).toMatchObject({date:'2026-11-07'});
  expect(suggestHint('attendance.overtime.request',{date:'2026-11-14',plannedStartTime:'09:00',plannedEndTime:'13:00'},'overtime on 14 November from 9am to 1pm',now)).toMatchObject({date:'2026-11-14'});
 });
 it('leaves words that name no day for the check to refuse, and every other action\'s details unchanged',()=>{
  expect(suggestHint('attendance.overtime.request',{date:'soon',plannedStartTime:'09:00',plannedEndTime:'13:00'},'overtime soon',now)).toEqual({date:'soon',plannedStartTime:'09:00',plannedEndTime:'13:00'});
  const details={startDate:'next friday',reason:'family day'};
  expect(suggestHint('leave.apply',details,'annual leave next friday',now)).toBe(details);
  expect(suggestHint('attendance.overtime.request',undefined,words,now)).toBeUndefined();
 });
});
