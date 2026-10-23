/** Physical source coverage only; no settlement/lock/database success is claimed here. */
import {describe,expect,it} from 'vitest';
import {attendancePolicyCoverageProposal as prepare,conflictingAttendancePolicyCoverage as conflicts} from '../packs/attendance/policy-coverage';
import type {PolicyCoverageIdentity} from '../packs/attendance/policy-coverage';
import type {PolicyExecutionProposal} from '../packs/attendance/policy-execution-proposal';
import {deriveAttendancePolicyDurationProposal} from '../packs/attendance/policy-duration';
import {ATTENDANCE_POLICY_DAY_CLASSES,type AttendanceGroupPolicy} from '../lib/attendance-group-policy';
const id=(n:number)=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const date='2026-10-23';
const identity=():PolicyCoverageIdentity=>({tenantId:id(1),companyId:id(2),employmentId:id(3),sourceId:id(4),calculationId:id(5),date});
function proposal(intervals:{from:number;to:number}[],sourceDate=date,rounding:AttendanceGroupPolicy['overtime']['rounding']={mode:'none',step:null},direction:'earliest'|'latest'='earliest'):PolicyExecutionProposal{
 const policy:AttendanceGroupPolicy={version:1,clock:{pairing:'auto',minimumIntervalMinutes:0,lateGraceMinutes:0,earlyGraceMinutes:0,skipLatenessIfIncomplete:true},
  overtime:{enabled:true,beforeShift:true,afterShift:true,allowBackdatedWithoutClock:false,splitAtMidnight:true,offsetLateness:false,
   approval:'auto',autoMethod:'actual',rounding,days:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>[key,
    {minimumMinutes:0,maximumMinutes:null,patternVersionId:id(6)}])) as AttendanceGroupPolicy['overtime']['days']}};
 const calendar=Array.from({length:3},(_,offset)=>({state:'known' as const,date:new Date(Date.parse(sourceDate+'T00:00:00Z')+offset*86400000).toISOString().slice(0,10),
  companyId:id(2),dayClass:'normal' as const,moneyDay:'workday' as const,references:['fictional-calendar:'+offset]}));
 return {state:'proposed',authority:'proposalOnly',policyRevisionId:id(7),formulaParts:[],duration:deriveAttendancePolicyDurationProposal({sourceDate,
  companyId:id(2),periodMinutes:4320,policy,workedIntervals:intervals,eligibleActualIntervals:intervals,eligiblePlannedIntervals:null,
  unpaidIntervals:[],lateOffsetIntervals:[],calendar,method:'actual',approval:'policyAuto',allocationByClass:{normal:direction}})};
}
function prepared(who:PolicyCoverageIdentity,intervals:{from:number;to:number}[]){
 const value=prepare(who,proposal(intervals,who.date));if(value.state!=='prepared')throw Error('Expected physical fixture');return value;
}
describe('canonical parent physical coverage',()=>{
 it('detects overlap between a previous overnight parent and a next-day cash/TOIL parent',()=>{
  const old=prepared(identity(),[{from:1410,to:1470}]),next=prepared({...identity(),sourceId:id(8),calculationId:id(9),date:'2026-10-24'},[{from:15,to:45}]);
  expect(conflicts(next,[old])).toEqual([id(4)]);
  const adjacent=prepared({...next.identity,sourceId:id(10)},[{from:30,to:60}]);expect(conflicts(adjacent,[old])).toEqual([]);
 });
 it('permits only an exact same-calculation retry and separates tenants/employments, not companies',()=>{
  const old=prepared(identity(),[{from:60,to:120}]);expect(conflicts(structuredClone(old),[old])).toEqual([]);
  expect(conflicts({...old,identity:{...old.identity,calculationId:id(9)}},[old])).toEqual([id(4)]);
  expect(conflicts({...old,identity:{...old.identity,companyId:id(9)}},[old])).toEqual([id(4)]);
  expect(conflicts({...old,identity:{...old.identity,tenantId:id(9)}},[old])).toEqual([]);
  expect(conflicts({...old,identity:{...old.identity,employmentId:id(9)}},[old])).toEqual([]);
 });
 it.each(['earliest','latest'] as const)('keeps physical coverage unchanged when %s dated-source attribution owns a rounded count',direction=>{
  const who=identity(),p=proposal([{from:1430,to:1450}],who.date,{mode:'up',step:30},direction),view=prepare(who,p);
  expect(view).toMatchObject({state:'prepared',countAttribution:{physicalMinutes:20,roundedMinutes:10,minutes:30}});
  if(view.state!=='prepared'||!view.countAttribution)throw Error('Expected separate count/source coverage');
  const midnight=Date.parse(who.date+'T00:00:00+08:00');
  expect(view.intervals).toEqual([{fromEpochMillisecond:midnight+1430*60000,toEpochMillisecond:midnight+1450*60000}]);
  expect(view.countAttribution.parts.map(part=>part.minutes)).toEqual(direction==='earliest'?[20,10]:[10,20]);
  const adjacent=prepared({...who,sourceId:id(30),calculationId:id(31)},[{from:1450,to:1460}]);
  expect(conflicts(adjacent,[view])).toEqual([]);
  if(p.state!=='proposed'||p.duration.status!=='calculated'||!p.duration.classes[0].roundingCountAttribution)throw Error('Expected bound count');
  p.duration.classes[0].roundingCountAttribution.anchor.to++;
  expect(prepare(who,p)).toMatchObject({state:'unavailable',reason:'unplacedCountCoverageRequired'});
 });
 it('refuses missing positioning, duplicate children and unplaced rounded minutes',()=>{
  const p=proposal([{from:60,to:120}]);if(p.state!=='proposed'||p.duration.status!=='calculated')throw Error('Expected duration');
  const duplicate=structuredClone(p);if(duplicate.state!=='proposed'||duplicate.duration.status!=='calculated')throw Error('Expected copied duration');duplicate.duration.parts.push(structuredClone(duplicate.duration.parts[0]));
  expect(prepare(identity(),duplicate)).toMatchObject({state:'unavailable',reason:'partitionMismatch'});
  p.duration.classes[0].unplacedPayableMinutes=20;p.duration.payableMinutes+=20;
  expect(prepare(identity(),p)).toMatchObject({state:'unavailable',reason:'unplacedCountCoverageRequired'});
 });
 it('matches exact half-open overlap across ordered gaps and refuses malformed stored coverage',()=>{
  for(let offset=0;offset<10;offset++){
   const a=prepared(identity(),Array.from({length:20},(_,i)=>({from:i*10,to:i*10+2}))),
    b=prepared({...identity(),sourceId:id(8),calculationId:id(9)},Array.from({length:20},(_,i)=>({from:i*10+offset,to:i*10+offset+2})));
   const overlap=a.intervals.some(x=>b.intervals.some(y=>x.fromEpochMillisecond<y.toEpochMillisecond&&y.fromEpochMillisecond<x.toEpochMillisecond));
   expect(conflicts(a,[b]).length>0).toBe(overlap);
  }
  const a=prepared(identity(),[{from:60,to:120}]);
  expect(()=>conflicts({...a,intervals:[{fromEpochMillisecond:5,toEpochMillisecond:4}]},[])).toThrow('Invalid recorded physical coverage');
 });
 it('does not mutate source identity and refuses malformed identity/count evidence',()=>{
  const who=identity(),before=structuredClone(who),view=prepared(who,[{from:60,to:120}]);view.identity.sourceId=id(99);expect(who).toEqual(before);
  expect(prepare({...who,date:'2026-02-30'},proposal([]))).toMatchObject({state:'unavailable',reason:'partitionMismatch'});
  expect(prepare({...who,sourceId:'wrong'},proposal([]))).toMatchObject({state:'unavailable',reason:'partitionMismatch'});
 });
});
