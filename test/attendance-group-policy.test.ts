import {describe,expect,it} from 'vitest';
import {ATTENDANCE_POLICY_DAY_CLASSES,attendanceGroupPolicyActivationDate,attendanceGroupPolicyOn,validateAttendanceGroupPolicy,type AttendanceGroupPolicy,type EffectiveAttendanceGroupPolicy} from '../lib/attendance-group-policy';
const pattern='00000000-0000-0000-0000-000000000001';
const policy=():AttendanceGroupPolicy=>({version:1,clock:{pairing:'auto',minimumIntervalMinutes:0,lateGraceMinutes:5,earlyGraceMinutes:0,skipLatenessIfIncomplete:true},
 overtime:{enabled:true,beforeShift:false,afterShift:true,allowBackdatedWithoutClock:false,splitAtMidnight:false,offsetLateness:false,approval:'manual',autoMethod:'intersect',rounding:{mode:'nearest',step:15},
 days:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>[key,{minimumMinutes:0,maximumMinutes:null,patternVersionId:pattern}])) as AttendanceGroupPolicy['overtime']['days']}});
describe('shared attendance policy contract',()=>{
 it('preserves all independent controls and central immutable references without copying rates',()=>{
  const input=policy();input.overtime.enabled=false;input.overtime.beforeShift=true;input.overtime.afterShift=false;input.overtime.allowBackdatedWithoutClock=true;
  input.overtime.days.off={minimumMinutes:30,maximumMinutes:60,patternVersionId:null};
  expect(validateAttendanceGroupPolicy(input,1440)).toEqual(input);expect(input.overtime.rounding).toEqual({mode:'nearest',step:15});
 });
 it('requires all five distinct day classifications and complete references for activated overtime',()=>{
  for(const kind of ATTENDANCE_POLICY_DAY_CLASSES){const value=policy();value.overtime.days[kind].patternVersionId=null;expect(()=>validateAttendanceGroupPolicy(value,1440)).toThrow();}
  const value=policy();delete(value.overtime.days as Partial<typeof value.overtime.days>).replacementHoliday;expect(()=>validateAttendanceGroupPolicy(value,1440)).toThrow();
 });
 it('refuses unknown or executable properties, implicit booleans, fractional minutes and invalid UUIDs',()=>{
  expect(()=>validateAttendanceGroupPolicy({...policy(),formula:'arbitrary code'},1440)).toThrow();
  expect(()=>validateAttendanceGroupPolicy({...policy(),get clock(){throw Error('must not execute');}},1440)).toThrow('Executable properties');
  for(const interval of [-1,0.5,NaN,Infinity,1441]){const value=policy();value.clock.minimumIntervalMinutes=interval;expect(()=>validateAttendanceGroupPolicy(value,1440)).toThrow();}
  const value=policy();(value.overtime as unknown as Record<string,unknown>).enabled='on';expect(()=>validateAttendanceGroupPolicy(value,1440)).toThrow();
  value.overtime.enabled=true;value.overtime.days.normal.patternVersionId='pattern-code';expect(()=>validateAttendanceGroupPolicy(value,1440)).toThrow();
 });
 it('checks each threshold against the real period and refuses unsupported rounding combinations',()=>{
  for(const kind of ATTENDANCE_POLICY_DAY_CLASSES){const value=policy();value.overtime.days[kind]={minimumMinutes:61,maximumMinutes:60,patternVersionId:pattern};expect(()=>validateAttendanceGroupPolicy(value,1440)).toThrow('Minimum overtime');}
  const value=policy();value.overtime.days.normal.maximumMinutes=1441;expect(()=>validateAttendanceGroupPolicy(value,1440)).toThrow();
  value.overtime.days.normal.maximumMinutes=0;expect(validateAttendanceGroupPolicy(value,1440).overtime.days.normal.maximumMinutes).toBe(0);
  for(const step of [null,1,7,90]){const candidate=policy();candidate.overtime.rounding.step=step as never;expect(()=>validateAttendanceGroupPolicy(candidate,1440)).toThrow();}
  const none=policy();none.overtime.rounding={mode:'none',step:null};expect(validateAttendanceGroupPolicy(none,1440).overtime.rounding).toEqual(none.overtime.rounding);
 });
 it('keeps missing dates in legacy mode and never guesses between overlapping active snapshots',()=>{
  const a:EffectiveAttendanceGroupPolicy={id:'a',effectiveFrom:'2026-01-02',effectiveTo:'2026-01-05',superseded:false,policy:policy()},b={...a,id:'b',effectiveFrom:'2026-01-05',effectiveTo:null};
  expect(attendanceGroupPolicyOn([b,a],'2026-01-01')).toBeNull();expect(attendanceGroupPolicyOn([b,a],'2026-01-04')?.id).toBe('a');expect(attendanceGroupPolicyOn([a,b],'2026-01-05')?.id).toBe('b');
  expect(attendanceGroupPolicyOn([{...a,superseded:true}],'2026-01-03')).toBeNull();
  expect(()=>attendanceGroupPolicyOn([a,{...a,id:'conflict'}],'2026-01-03')).toThrow('Overlapping');
  expect(()=>attendanceGroupPolicyActivationDate('2026-02-30','2026-02-01')).toThrow();
  expect(()=>attendanceGroupPolicyActivationDate('2026-01-01','2026-01-01')).toThrow('future');expect(attendanceGroupPolicyActivationDate('2026-01-02','2026-01-01')).toBe('2026-01-02');
 });
});
