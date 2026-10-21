/** Dated policy consumer of the existing closed-pair owner. No persistence, day assignment or pay.
 * Only the canonical attendance owner may supply absolute minutes on its resolved day timeline. */
import {closedClockPairs,type ClosedClockInterval} from './full-flexi-time';
import type {AttendanceGroupPolicy} from './attendance-group-policy';
export type PolicyClock={id:string;at:number;direction:'in'|'out'};
export type PolicyClockFlag={kind:'close'|'duplicate'|'unmatched';clockIds:string[]};
export type PolicyClockEvidence={
 complete:boolean;requiresReview:boolean;flags:PolicyClockFlag[];
 checkInAbs:number|null;checkOutAbs:number|null;intervals:ClosedClockInterval[];
};
export function attendancePolicyClockEvidence(raw:readonly PolicyClock[],
 policy:AttendanceGroupPolicy['clock'],periodMinutes:number):PolicyClockEvidence{
 if(!Number.isSafeInteger(periodMinutes)||periodMinutes<1||periodMinutes>4320||raw.length>1024)
  throw Error('Clock evidence exceeds the canonical attendance period.');
 if(!['auto','firstInLastOut'].includes(policy.pairing)||!Number.isSafeInteger(policy.minimumIntervalMinutes)||policy.minimumIntervalMinutes<0||policy.minimumIntervalMinutes>periodMinutes)
  throw Error('Invalid clock policy.');
 const ids=new Set<string>();
 for(const clock of raw){
  if(!clock.id||clock.id.length>160||ids.has(clock.id)||!Number.isFinite(clock.at)||clock.at<0||clock.at>periodMinutes||!['in','out'].includes(clock.direction))
   throw Error('Invalid canonical clock evidence.');
  ids.add(clock.id);
 }
 // Preserve raw records and their order. A sorted view is only a pairing input, never a rewritten log.
 const ordered=raw.map((clock,index)=>({...clock,index})).sort((a,b)=>a.at-b.at||a.index-b.index);
 const flags:PolicyClockFlag[]=[];
 for(let index=1;index<ordered.length;index++){
  const a=ordered[index-1],b=ordered[index],gap=b.at-a.at;
  if(gap===0)flags.push({kind:'duplicate',clockIds:[a.id,b.id]});
  else if(gap<policy.minimumIntervalMinutes)flags.push({kind:'close',clockIds:[a.id,b.id]});
 }
 const paired=closedClockPairs(ordered);
 if(ordered.length&&!paired.complete)flags.push({kind:'unmatched',clockIds:ordered.map(clock=>clock.id)});
 const checkInAbs=ordered.find(clock=>clock.direction==='in')?.at??null;
 const lastOut=ordered.filter(clock=>clock.direction==='out').at(-1);
 const checkOutAbs=lastOut?.at??null;
 const complete=paired.complete&&flags.length===0;
 const intervals=complete?(policy.pairing==='auto'?paired.intervals:[{inAbs:checkInAbs!,outAbs:checkOutAbs!}]):[];
 return {complete,requiresReview:flags.length>0,flags,checkInAbs,checkOutAbs,intervals};
}
