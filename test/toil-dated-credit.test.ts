import {describe,it,expect} from 'vitest';
import {calculateDatedToilCredit,toilMeasuredCreditDays,type DatedToilCreditInput} from '../lib/toil-dated-credit';
const policy={extendedHoursEnabled:true,accrualBasis:'premium_equivalent',extendedHalfDayMinutes:240,
 extendedFullDayMinutes:480,extendedBreakMinutes:0,extendedGraceMinutes:0};
const part=(sequence:number,date:string,dayClass:DatedToilCreditInput['dayClass'],minutes:number,afterShiftMinutes:number|null=null)=>
 ({sequence,date,dayClass,minutes,afterShiftMinutes});
describe('dated TOIL credit rule owner',()=>{
 it('keeps each actual class proportional rule and retains PH versus replacement provenance',()=>{
  const rows=[part(0,'2026-10-23','rest',120),part(1,'2026-10-24','replacementHoliday',120)],before=structuredClone(rows);
  const result=calculateDatedToilCredit(rows,policy,'roster');
  expect(result.days).toBe(1.25);expect(result.parts.map(p=>[p.dayClass,p.days])).toEqual([['rest',0.5],['replacementHoliday',0.75]]);
  expect(rows).toEqual(before);
 });
 it('uses ordinary post-shift tiers beside the other dated class rule',()=>{
  const result=calculateDatedToilCredit([part(0,'2026-10-23','normal',300,240),part(1,'2026-10-24','rest',240)],policy,'roster');
  expect(result.days).toBe(1.5);expect(result.parts.map(p=>p.countedMinutes)).toEqual([240,240]);
 });
 it('does not combine two below-threshold claim dates into an earned credit',()=>{
  const result=calculateDatedToilCredit([part(0,'2026-10-23','normal',120,120),part(1,'2026-10-24','off',120)],policy,'claim');
  expect(result.days).toBe(0);expect(result.parts.map(p=>p.days)).toEqual([0,0]);
 });
 it('retains the existing off-day roster refusal while allowing its claim-window rule',()=>{
  const rows=[part(0,'2026-10-23','off',240)];
  expect(()=>calculateDatedToilCredit(rows,policy,'roster')).toThrow('Off-day roster');
  expect(calculateDatedToilCredit(rows,policy,'claim').days).toBe(0.5);
 });
 it('refuses duplicate dated classifications and absent ordinary post-shift evidence',()=>{
  expect(()=>calculateDatedToilCredit([part(0,'2026-10-23','rest',120),part(1,'2026-10-23','publicHoliday',120)],policy,'roster')).toThrow();
  expect(()=>calculateDatedToilCredit([part(0,'2026-10-23','normal',240)],policy,'claim')).toThrow();
 });
 it('keeps the existing uniform measured credit calculation',()=>{
  expect(toilMeasuredCreditDays(120,'rest_day','premium_equivalent')).toBe(0.5);
  expect(toilMeasuredCreditDays(120,'holiday','hours_worked')).toBe(0.25);
 });
});
