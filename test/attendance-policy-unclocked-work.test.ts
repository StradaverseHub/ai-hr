import {describe,expect,it} from 'vitest';
import {attendancePolicyAttestedRawTrace} from '../lib/attendance-policy-attested-trace';
import {attendancePolicyLocalWorkInstant,attendancePolicyUnclockedWorkDates,validateAttendancePolicyUnclockedWork,type AttendancePolicyUnclockedWork} from '../lib/attendance-policy-unclocked-work';
const midnight=Date.parse('2026-09-20T00:00:00+08:00');
const fixture=():AttendancePolicyUnclockedWork=>({version:1,completeWorkedDay:true,sourceDate:'2026-09-20',reason:'HR confirms the actual worked interval from a supervisor report.',
 intervals:[{fromEpochMillisecond:midnight+23*3600000+555,toEpochMillisecond:midnight+25*3600000+555}]});
describe('HR source raw trace normalization',()=>{
 it('removes only the separate calculation marker',()=>{
  expect(attendancePolicyAttestedRawTrace({overtimePattern:{calculationId:'retained-marker'}})).toBeNull();
  expect(attendancePolicyAttestedRawTrace(null)).toBeNull();
 });
 it.each([[],['overtimePattern'],{},'overtimePattern',0,{v:1},{overtimePattern:{},inAbs:0}].map(trace=>({trace})))('preserves other raw evidence %# for independent validation',({trace})=>{
  expect(attendancePolicyAttestedRawTrace(trace)).toBe(trace);
 });
});
describe('explicit unclocked actual-work submission',()=>{
 it('retains actual overnight milliseconds and the stated reason without inventing a punch or rounding a count',()=>{
  const work=fixture(),result=validateAttendancePolicyUnclockedWork(work,midnight+3*86400000);
  expect(result).toEqual(work);expect(result).not.toBe(work);expect(result.intervals[0]).not.toBe(work.intervals[0]);
  expect(result).not.toHaveProperty('payableMinutes');expect(result).not.toHaveProperty('captureId');
 });
 it.each(['future','outside','overlap','fraction','inverted','missingReason','rolloverDate','incompleteDay'] as const)('rejects %s actual-work testimony',kind=>{
  const work=fixture();
  if(kind==='future')work.intervals[0].toEpochMillisecond=midnight+3*86400000;
  if(kind==='outside')work.intervals[0].fromEpochMillisecond=midnight-1;
  if(kind==='overlap')work.intervals.push({...work.intervals[0]});
  if(kind==='fraction')work.intervals[0].fromEpochMillisecond+=0.5;
  if(kind==='inverted')work.intervals[0].toEpochMillisecond=work.intervals[0].fromEpochMillisecond;
  if(kind==='missingReason')work.reason=' ';
  if(kind==='rolloverDate')work.sourceDate='2026-02-30';
  if(kind==='incompleteDay')Object.assign(work,{completeWorkedDay:false});
  expect(()=>validateAttendancePolicyUnclockedWork(work,midnight+2*86400000)).toThrow();
 });
});

describe('malformed retained HR actual-work evidence',()=>{
 it.each(['nullActual','nullRequested','unrenderableInstant','invertedRequested','outsideRequested'] as const)('refuses %s evidence before rendering its instants',kind=>{
  const work=fixture(),malformed:unknown=kind==='nullActual'?{...work,intervals:[null]}
   :kind==='nullRequested'?{...work,requestedIntervals:[null]}
   :kind==='unrenderableInstant'?{...work,intervals:[{fromEpochMillisecond:Number.MAX_SAFE_INTEGER-60000,toEpochMillisecond:Number.MAX_SAFE_INTEGER}]}
   :{...work,requestedIntervals:[{fromEpochMillisecond:work.intervals[0].fromEpochMillisecond,
    toEpochMillisecond:kind==='invertedRequested'?work.intervals[0].fromEpochMillisecond-1:work.intervals[0].toEpochMillisecond+1}]};
  expect(()=>validateAttendancePolicyUnclockedWork(malformed as AttendancePolicyUnclockedWork,midnight+3*86400000)).toThrow();
 });
});

describe('explicit Malaysia work-time entry',()=>{
 it('retains millisecond endpoints across midnight independently of the browser timezone',()=>{
  expect(attendancePolicyLocalWorkInstant('2026-09-20T23:59:59.555')).toBe(midnight+86400000-445);
  expect(attendancePolicyLocalWorkInstant('2026-09-21T00:01')).toBe(midnight+86400000+60000);
 });
 it.each(['2026-02-30T12:00','2026-09-20T25:00','2026-09-20T12:00Z','2026-09-20T12:00+00:00','2026-09-20T12:00:00.5555'])('rejects invalid or implicitly zoned input %s',value=>{
  expect(()=>attendancePolicyLocalWorkInstant(value)).toThrow();
 });
});

describe('explicit requested positions within complete HR actual work',()=>{
 it('retains the later requested subset and original milliseconds without turning it into a plan',()=>{
  const work=fixture();work.requestedIntervals=[{fromEpochMillisecond:midnight+24*3600000+777,toEpochMillisecond:midnight+24.5*3600000+777}];
  const result=validateAttendancePolicyUnclockedWork(work,midnight+3*86400000,30);
  expect(result).toEqual(work);expect(result.requestedIntervals).not.toBe(work.requestedIntervals);
  expect(result).not.toHaveProperty('plannedWindow');
 });
 it.each(['count','outside','overlap','unordered','subminute','empty'] as const)('refuses %s requested positions',kind=>{
  const work=fixture();const interval={fromEpochMillisecond:midnight+24*3600000+777,toEpochMillisecond:midnight+24.5*3600000+777};
  work.requestedIntervals=[interval];
  if(kind==='outside')work.requestedIntervals[0]={...interval,toEpochMillisecond:midnight+26*3600000};
  if(kind==='overlap')work.requestedIntervals.push({...interval});
  if(kind==='unordered')work.requestedIntervals.push({fromEpochMillisecond:midnight+23.5*3600000,toEpochMillisecond:midnight+24*3600000});
  if(kind==='subminute')work.requestedIntervals[0]={...interval,toEpochMillisecond:interval.fromEpochMillisecond+1000};
  if(kind==='empty')work.requestedIntervals=[];
  expect(()=>validateAttendancePolicyUnclockedWork(work,midnight+3*86400000,kind==='count'?31:30)).toThrow();
 });
});

describe('unclocked withdrawal physical calendar protection',()=>{
 it('retains the source day and later physical dates across a month boundary',()=>{
  const start=Date.parse('2026-09-30T00:00:00+08:00');
  expect(attendancePolicyUnclockedWorkDates({...fixture(),sourceDate:'2026-09-30',intervals:[
   {fromEpochMillisecond:start+23*3600000+777,toEpochMillisecond:start+25*3600000+555}]}))
   .toEqual(['2026-09-30','2026-10-01']);
 });
 it('excludes an exclusive midnight end but includes a single actual millisecond after it',()=>{
  const work={...fixture(),intervals:[{fromEpochMillisecond:midnight+23*3600000,toEpochMillisecond:midnight+86400000}]};
  expect(attendancePolicyUnclockedWorkDates(work)).toEqual(['2026-09-20']);
  work.intervals[0].toEpochMillisecond++;
  expect(attendancePolicyUnclockedWorkDates(work)).toEqual(['2026-09-20','2026-09-21']);
 });
 it('keeps the source date without treating a gap as actual work',()=>{
  expect(attendancePolicyUnclockedWorkDates({...fixture(),intervals:[
   {fromEpochMillisecond:midnight+2*86400000,toEpochMillisecond:midnight+2*86400000+60000}]}))
   .toEqual(['2026-09-20','2026-09-22']);
 });
});
