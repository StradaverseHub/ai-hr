import {describe,expect,it} from 'vitest';
import {attendancePolicyClockEvidence,attendancePolicyClockSecondEvidence,attendancePolicyClockMillisecondEvidence,type PolicyClock} from '../lib/attendance-policy-clocks';
import {fullFlexiIntervals} from '../lib/full-flexi-time';
import type {AttendanceGroupPolicy} from '../lib/attendance-group-policy';
const policy=(pairing:AttendanceGroupPolicy['clock']['pairing']='auto'):AttendanceGroupPolicy['clock']=>({pairing,minimumIntervalMinutes:0,lateGraceMinutes:0,earlyGraceMinutes:0,skipLatenessIfIncomplete:false});
const clock=(id:string,at:number,direction:'in'|'out'):PolicyClock=>({id,at,direction});
const day=[clock('a',540,'in'),clock('b',720,'out'),clock('c',780,'in'),clock('d',1080,'out')];
describe('explicit dated clock policy evidence',()=>{
 it('uses closed pairs for Auto and the evidenced outer boundaries for First In Last Out',()=>{
  const before=JSON.stringify(day);
  expect(attendancePolicyClockEvidence(day,policy(),1440).intervals).toEqual([{inAbs:540,outAbs:720},{inAbs:780,outAbs:1080}]);
  expect(attendancePolicyClockEvidence(day,policy('firstInLastOut'),1440).intervals).toEqual([{inAbs:540,outAbs:1080}]);
  expect(JSON.stringify(day)).toBe(before);
 });
 it('retains close/duplicate evidence for review rather than silently filtering a boundary',()=>{
  const result=attendancePolicyClockEvidence([clock('a',540,'in'),clock('b',544,'out')],{...policy(),minimumIntervalMinutes:5},1440);
  expect(result.complete).toBe(false);expect(result.intervals).toEqual([]);
  expect(result.flags).toEqual([{kind:'close',clockIds:['a','b']}]);
  const duplicate=attendancePolicyClockEvidence([clock('a',540,'in'),clock('b',540,'in'),clock('c',600,'out')],policy(),1440);
  expect(duplicate.requiresReview).toBe(true);expect(duplicate.flags.some(flag=>flag.kind==='duplicate')).toBe(true);
  expect(duplicate.intervals).toEqual([]);
 });
 it.each(['auto','firstInLastOut'] as const)('does not invent a boundary from incomplete %s evidence',pairing=>{
  for(const punches of [[clock('a',540,'out')],[clock('a',540,'in')],[clock('a',540,'in'),clock('b',600,'out'),clock('c',650,'in')]]){
   const result=attendancePolicyClockEvidence(punches,policy(pairing),1440);
   expect(result.complete).toBe(false);expect(result.intervals).toEqual([]);expect(result.requiresReview).toBe(true);
  }
 });
 it('retains explicit overnight offsets and treats the minimum boundary inclusively',()=>{
  const result=attendancePolicyClockEvidence([clock('a',1320,'in'),clock('b',1800,'out')],{...policy(),minimumIntervalMinutes:480},2880);
  expect(result.complete).toBe(true);expect(result.intervals).toEqual([{inAbs:1320,outAbs:1800}]);
 });
 it('preserves the existing Full Flexi compatibility treatment of exact duplicate captures',()=>{
  expect(fullFlexiIntervals([{punchAt:'09:00',direction:'in'},{punchAt:'09:00',direction:'in'},{punchAt:'12:00',direction:'out'},{punchAt:'13:00',direction:'in'},{punchAt:'18:00',direction:'out'}],'09:00',null)).toEqual({complete:true,intervals:[{inAbs:540,outAbs:720},{inAbs:780,outAbs:1080}],checkInAt:'09:00',checkOutAt:'18:00'});
 });
 it('refuses invalid evidence and never interprets a clock without a canonical period',()=>{
  expect(()=>attendancePolicyClockEvidence([clock('a',1500,'in')],policy(),1440)).toThrow();
  expect(()=>attendancePolicyClockEvidence([clock('a',540,'in'),clock('a',600,'out')],policy(),1440)).toThrow();
  expect(()=>attendancePolicyClockEvidence(day,policy(),0)).toThrow();
  expect(attendancePolicyClockEvidence([],policy(),1440)).toEqual({complete:false,requiresReview:false,flags:[],checkInAbs:null,checkOutAbs:null,intervals:[]});
 });
});

describe('canonical second precision before payroll-minute projection',()=>{
 const seconds=(id:string,atSeconds:number,direction:'in'|'out')=>({id,atSeconds,direction});
 it('flags 59 seconds even across a whole-minute boundary and accepts exactly 60 seconds',()=>{
  const p={...policy(),minimumIntervalMinutes:1};
  const close=attendancePolicyClockSecondEvidence([seconds('a',32401,'in'),seconds('b',32460,'out')],p,1440);
  expect(close).toMatchObject({complete:false,requiresReview:true,flags:[{kind:'close',clockIds:['a','b']}],intervals:[],minuteIntervals:[]});
  expect(attendancePolicyClockSecondEvidence([seconds('a',32401,'in'),seconds('b',32461,'out')],p,1440))
   .toMatchObject({complete:true,requiresReview:false,flags:[],intervals:[{inSecond:32401,outSecond:32461}],minuteIntervals:[{inAbs:540,outAbs:541}]});
 });
 it('does not call distinct seconds within one minute duplicates or invent a whole minute',()=>{
  expect(attendancePolicyClockSecondEvidence([seconds('a',32401,'in'),seconds('b',32459,'out')],policy(),1440))
   .toEqual({complete:true,requiresReview:false,flags:[],checkInSecond:32401,checkOutSecond:32459,
    intervals:[{inSecond:32401,outSecond:32459}],minuteIntervals:[]});
 });
 it('retains exact duplicate/unmatched events and never debounces them into a valid calculation',()=>{
  const result=attendancePolicyClockSecondEvidence([seconds('a',32400,'in'),seconds('b',32400,'in'),seconds('c',36000,'out')],policy(),1440);
  expect(result.complete).toBe(false);expect(result.flags.map(flag=>flag.kind)).toEqual(['duplicate','unmatched']);
  expect(result.intervals).toEqual([]);expect(result.minuteIntervals).toEqual([]);
 });
 it('preserves supplied next-day positions and the canonical boundary-minute arithmetic',()=>{
  expect(attendancePolicyClockSecondEvidence([seconds('a',86399,'in'),seconds('b',86461,'out')],policy(),2880))
   .toMatchObject({complete:true,intervals:[{inSecond:86399,outSecond:86461}],minuteIntervals:[{inAbs:1439,outAbs:1441}]});
 });
 it.each(['auto','firstInLastOut'] as const)('retains available boundaries while refusing an incomplete %s result',pairing=>{
  const result=attendancePolicyClockSecondEvidence([seconds('a',32401,'out')],policy(pairing),1440);
  expect(result).toMatchObject({complete:false,checkInSecond:null,checkOutSecond:32401,intervals:[],minuteIntervals:[]});
 });
 it.each(['auto','firstInLastOut'] as const)('shares the original pair owner and preserves minute-boundary %s compatibility',pairing=>{
  const original=attendancePolicyClockEvidence(day,policy(pairing),1440),input=day.map(clock=>seconds(clock.id,clock.at*60,clock.direction)),before=structuredClone(input);
  const result=attendancePolicyClockSecondEvidence(input,policy(pairing),1440);
  expect(result.complete).toBe(original.complete);expect(result.flags).toEqual(original.flags);expect(result.minuteIntervals).toEqual(original.intervals);expect(input).toEqual(before);
 });
 it('refuses sub-second/invalid positions, invalid identities and positions outside the resolved period',()=>{
  for(const at of [-1,0.5,NaN,Infinity,86401])expect(()=>attendancePolicyClockSecondEvidence([seconds('a',at,'in')],policy(),1440)).toThrow();
  for(const id of ['', ' ', 42 as never])expect(()=>attendancePolicyClockSecondEvidence([seconds(id,32400,'in')],policy(),1440)).toThrow();
  expect(()=>attendancePolicyClockSecondEvidence([seconds('a',32400,'in'),seconds('a',36000,'out')],policy(),1440)).toThrow();
 });
});

describe('captured millisecond precision before minute projection',()=>{
 const ms=(id:string,atMilliseconds:number,direction:'in'|'out')=>({id,atMilliseconds,direction});
 it('refuses 59.950 seconds even when premature second truncation would report an accepted minute',()=>{
  const p={...policy(),minimumIntervalMinutes:1},clocks=[ms('a',86399950,'in'),ms('b',86459900,'out')];
  expect(attendancePolicyClockMillisecondEvidence(clocks,p,2880)).toMatchObject({complete:false,requiresReview:true,
   flags:[{kind:'close',clockIds:['a','b']}],intervals:[],minuteIntervals:[]});
  // Adversarial comparison is against the actual earlier adapter, not a hypothetical second owner.
  expect(attendancePolicyClockSecondEvidence(clocks.map(clock=>({id:clock.id,direction:clock.direction,atSeconds:Math.floor(clock.atMilliseconds/1000)})),p,2880).complete).toBe(true);
 });
 it('accepts an exact minute and preserves actual midnight offsets and whole-minute boundary arithmetic',()=>{
  expect(attendancePolicyClockMillisecondEvidence([ms('a',86399950,'in'),ms('b',86459950,'out')],{...policy(),minimumIntervalMinutes:1},2880))
   .toMatchObject({complete:true,flags:[],intervals:[{inMillisecond:86399950,outMillisecond:86459950}],minuteIntervals:[{inAbs:1439,outAbs:1440}]});
 });
 it('does not mistake distinct milliseconds within one second for exact duplicates',()=>{
  expect(attendancePolicyClockMillisecondEvidence([ms('a',32400001,'in'),ms('b',32400999,'out')],policy(),1440))
   .toMatchObject({complete:true,flags:[],intervals:[{inMillisecond:32400001,outMillisecond:32400999}],minuteIntervals:[]});
 });
 it.each(['auto','firstInLastOut'] as const)('preserves established second/minute %s behaviour without mutating raw records',pairing=>{
  const input=day.map(clock=>ms(clock.id,clock.at*60000,clock.direction)),before=structuredClone(input);
  const actual=attendancePolicyClockMillisecondEvidence(input,policy(pairing),1440);
  expect(actual.minuteIntervals).toEqual(attendancePolicyClockEvidence(day,policy(pairing),1440).intervals);expect(input).toEqual(before);
 });
 it('retains duplicate/unmatched flags and refuses fractional or invalid millisecond positions',()=>{
  const actual=attendancePolicyClockMillisecondEvidence([ms('a',32400001,'in'),ms('b',32400001,'in'),ms('c',36000000,'out')],policy(),1440);
  expect(actual.flags.map(flag=>flag.kind)).toEqual(['duplicate','unmatched']);expect(actual.minuteIntervals).toEqual([]);
  for(const value of [-1,0.5,NaN,Infinity,86400001])expect(()=>attendancePolicyClockMillisecondEvidence([ms('a',value,'in')],policy(),1440)).toThrow();
 });
});
