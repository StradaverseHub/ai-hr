import {describe,expect,it} from 'vitest';
import {validateAttendancePolicyUnclockedWork,type AttendancePolicyUnclockedWork} from '../lib/attendance-policy-unclocked-work';
const midnight=Date.parse('2026-09-20T00:00:00+08:00');
const fixture=():AttendancePolicyUnclockedWork=>({version:1,sourceDate:'2026-09-20',reason:'HR confirms the actual worked interval from a supervisor report.',
 intervals:[{fromEpochMillisecond:midnight+23*3600000+555,toEpochMillisecond:midnight+25*3600000+555}]});
describe('explicit unclocked actual-work submission',()=>{
 it('retains actual overnight milliseconds and the stated reason without inventing a punch or rounding a count',()=>{
  const work=fixture(),result=validateAttendancePolicyUnclockedWork(work,midnight+3*86400000);
  expect(result).toEqual(work);expect(result).not.toBe(work);expect(result.intervals[0]).not.toBe(work.intervals[0]);
  expect(result).not.toHaveProperty('payableMinutes');expect(result).not.toHaveProperty('captureId');
 });
 it.each(['future','outside','overlap','fraction','inverted','missingReason','rolloverDate'] as const)('rejects %s actual-work testimony',kind=>{
  const work=fixture();
  if(kind==='future')work.intervals[0].toEpochMillisecond=midnight+3*86400000;
  if(kind==='outside')work.intervals[0].fromEpochMillisecond=midnight-1;
  if(kind==='overlap')work.intervals.push({...work.intervals[0]});
  if(kind==='fraction')work.intervals[0].fromEpochMillisecond+=0.5;
  if(kind==='inverted')work.intervals[0].toEpochMillisecond=work.intervals[0].fromEpochMillisecond;
  if(kind==='missingReason')work.reason=' ';
  if(kind==='rolloverDate')work.sourceDate='2026-02-30';
  expect(()=>validateAttendancePolicyUnclockedWork(work,midnight+2*86400000)).toThrow();
 });
});
