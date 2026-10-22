/** Dated policy consumer of the existing closed-pair owner. No persistence, day assignment or pay.
 * Only the canonical attendance owner may supply resolved absolute positions, in the named units. */
import {closedClockPairs,type ClosedClockInterval} from './full-flexi-time';
import type {AttendanceGroupPolicy} from './attendance-group-policy';
export type PolicyClock={id:string;at:number;direction:'in'|'out'};
export type PolicyClockFlag={kind:'close'|'duplicate'|'unmatched';clockIds:string[]};
export type PolicyClockEvidence={
 complete:boolean;requiresReview:boolean;flags:PolicyClockFlag[];
 checkInAbs:number|null;checkOutAbs:number|null;intervals:ClosedClockInterval[];
};
function validatePolicy(policy:AttendanceGroupPolicy['clock'],periodMinutes:number,count:number){
 if(!Number.isSafeInteger(periodMinutes)||periodMinutes<1||periodMinutes>4320||count>1024)
  throw Error('Clock evidence exceeds the canonical attendance period.');
 if(!['auto','firstInLastOut'].includes(policy.pairing)||!Number.isSafeInteger(policy.minimumIntervalMinutes)||policy.minimumIntervalMinutes<0||policy.minimumIntervalMinutes>periodMinutes)
  throw Error('Invalid clock policy.');
}
/** Shared pairing/flag owner. Units are chosen by the validated adapter, never mixed in one run. */
function evidence(raw:readonly PolicyClock[],pairing:AttendanceGroupPolicy['clock']['pairing'],minimumInterval:number,period:number):PolicyClockEvidence{
 const ids=new Set<string>();
 for(const clock of raw){
  if(typeof clock.id!=='string'||!clock.id.trim()||clock.id.length>160||ids.has(clock.id)||!Number.isFinite(clock.at)||clock.at<0||clock.at>period||!['in','out'].includes(clock.direction))
   throw Error('Invalid canonical clock evidence.');
  ids.add(clock.id);
 }
 // Preserve raw records and their order. A sorted view is only a pairing input, never a rewritten log.
 const ordered=raw.map((clock,index)=>({...clock,index})).sort((a,b)=>a.at-b.at||a.index-b.index);
 const flags:PolicyClockFlag[]=[];
 for(let index=1;index<ordered.length;index++){
  const a=ordered[index-1],b=ordered[index],gap=b.at-a.at;
  if(gap===0)flags.push({kind:'duplicate',clockIds:[a.id,b.id]});
  else if(gap<minimumInterval)flags.push({kind:'close',clockIds:[a.id,b.id]});
 }
 const paired=closedClockPairs(ordered);
 if(ordered.length&&!paired.complete)flags.push({kind:'unmatched',clockIds:ordered.map(clock=>clock.id)});
 const checkInAbs=ordered.find(clock=>clock.direction==='in')?.at??null;
 const lastOut=ordered.filter(clock=>clock.direction==='out').at(-1);
 const checkOutAbs=lastOut?.at??null;
 const complete=paired.complete&&flags.length===0;
 const intervals=complete?(pairing==='auto'?paired.intervals:[{inAbs:checkInAbs!,outAbs:checkOutAbs!}]):[];
 return {complete,requiresReview:flags.length>0,flags,checkInAbs,checkOutAbs,intervals};
}

/** Compatibility adapter for already resolved minute evidence. New second-bearing captures must use
 * the named seconds adapter below, preserving sub-minute order before payroll-minute projection. */
export function attendancePolicyClockEvidence(raw:readonly PolicyClock[],
 policy:AttendanceGroupPolicy['clock'],periodMinutes:number):PolicyClockEvidence{
 validatePolicy(policy,periodMinutes,raw.length);
 return evidence(raw,policy.pairing,policy.minimumIntervalMinutes,periodMinutes);
}
export type PolicyClockSecond={id:string;atSeconds:number;direction:'in'|'out'};
export type PolicyClockSecondEvidence={
 complete:boolean;requiresReview:boolean;flags:PolicyClockFlag[];
 checkInSecond:number|null;checkOutSecond:number|null;
 intervals:{inSecond:number;outSecond:number}[];
 /** The existing payroll minute owner floors each recorded boundary, not the elapsed seconds.
  * Zero-minute pairs remain in the seconds evidence and create no invented minute interval. */
 minuteIntervals:ClosedClockInterval[];
};
/** An adapter boundary, never a timestamp/date resolver: the canonical source must first establish
 * each absolute second on its subject/day timeline. No inference from clock labels or capture order. */
export function attendancePolicyClockSecondEvidence(raw:readonly PolicyClockSecond[],
 policy:AttendanceGroupPolicy['clock'],periodMinutes:number):PolicyClockSecondEvidence{
 validatePolicy(policy,periodMinutes,raw.length);
 for(const clock of raw)if(!Number.isSafeInteger(clock.atSeconds))throw Error('Canonical seconds must be whole exact seconds.');
 const result=evidence(raw.map(clock=>({id:clock.id,at:clock.atSeconds,direction:clock.direction})),
  policy.pairing,policy.minimumIntervalMinutes*60,periodMinutes*60);
 return {complete:result.complete,requiresReview:result.requiresReview,flags:result.flags,
  checkInSecond:result.checkInAbs,checkOutSecond:result.checkOutAbs,
  intervals:result.intervals.map(interval=>({inSecond:interval.inAbs,outSecond:interval.outAbs})),
  minuteIntervals:result.intervals.map(interval=>({inAbs:Math.floor(interval.inAbs/60),outAbs:Math.floor(interval.outAbs/60)}))
   .filter(interval=>interval.inAbs<interval.outAbs)};
}
