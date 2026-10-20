import {describe,expect,it} from 'vitest';
import {attendancePolicyClockEvidence,type PolicyClock} from '../lib/attendance-policy-clocks';
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
