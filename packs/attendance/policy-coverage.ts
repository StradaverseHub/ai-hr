/** Canonical immutable physical-coverage projection. Settlement must own complete current claims, permission,
 * locks and uniqueness; this pure view grants no cash/TOIL authority and writes no reservation. */
import {isDeepStrictEqual} from 'node:util';
import {isCalendarDate} from '../../lib/calendar-date';
import {overtimeUuid} from '../../lib/overtime-pattern-schema';
import {unionAttendancePolicyIntervals} from '../../lib/attendance-policy-intervals';
import type {PolicyExecutionProposal} from './policy-execution-proposal';
export type PolicyCoverageIdentity={tenantId:string;companyId:string;employmentId:string;sourceId:string;calculationId:string;date:string};
export type PolicyCoverageProposal=
 |{state:'unavailable';authority:'coverageProposalOnly';reason:'durationUnavailable'|'unplacedCountCoverageRequired'|'partitionMismatch'}
 |{state:'prepared';authority:'coverageProposalOnly';identity:PolicyCoverageIdentity;basis:'actual'|'approvedPlan';
   intervals:{fromEpochMillisecond:number;toEpochMillisecond:number}[]};
/** Use only the parent's actual dated allocation. Next-day parts stay under this parent; converting
 * a local label from another request or a scalar rounded remainder would fabricate physical cover. */
export function attendancePolicyCoverageProposal(identity:PolicyCoverageIdentity,proposal:PolicyExecutionProposal):PolicyCoverageProposal{
 const refuse=(reason:Extract<PolicyCoverageProposal,{state:'unavailable'}>['reason']):PolicyCoverageProposal=>({state:'unavailable',authority:'coverageProposalOnly',reason});
 if(!isCalendarDate(identity.date))return refuse('partitionMismatch');
 try{for(const key of ['tenantId','companyId','employmentId','sourceId','calculationId'] as const)overtimeUuid(identity[key],key);}
 catch{return refuse('partitionMismatch');}
 if(proposal.state!=='proposed'||proposal.duration.status!=='calculated')return refuse('durationUnavailable');
 const duration=proposal.duration;
 if(duration.parts.length>3||duration.classes.length>5||duration.parts.some(part=>part.allocations.length>4320))return refuse('partitionMismatch');
 if(duration.classes.some(row=>row.unplacedPayableMinutes!==0))return refuse('unplacedCountCoverageRequired');
 try{
  const allocations=duration.parts.flatMap(part=>{
   if(!Number.isSafeInteger(part.allocatedPayableMinutes)||part.allocatedPayableMinutes<0
    ||part.allocations.reduce((n,row)=>n+row.to-row.from,0)!==part.allocatedPayableMinutes)throw Error('Count mismatch');
   return part.allocations;
  });
  const normalized=unionAttendancePolicyIntervals(allocations,4320);
  const count=normalized.reduce((n,row)=>n+row.to-row.from,0);
  // Overlapping children cannot claim the same minute twice, including identical copied parts.
  if(count!==duration.payableMinutes||allocations.reduce((n,row)=>n+row.to-row.from,0)!==count)
   return refuse('partitionMismatch');
  const midnight=Date.parse(identity.date+'T00:00:00+08:00'); // existing Asia/Kuala_Lumpur timeline
  return {state:'prepared',authority:'coverageProposalOnly',identity:{...identity},basis:duration.intervalBasis,
   intervals:normalized.map(row=>({fromEpochMillisecond:midnight+row.from*60000,toEpochMillisecond:midnight+row.to*60000}))};
 }catch{return refuse('partitionMismatch');}
}
/** Mode deliberately does not participate: a physical minute cannot be reserved by cash in one
 * attendance parent and TOIL in another. Adjacent half-open ranges do not overlap. */
export function conflictingAttendancePolicyCoverage(candidate:Extract<PolicyCoverageProposal,{state:'prepared'}>,
 current:readonly Extract<PolicyCoverageProposal,{state:'prepared'}>[] ){
 if(current.length>5000)throw Error('Narrow the complete physical coverage read.');
 const valid=(row:Extract<PolicyCoverageProposal,{state:'prepared'}>)=>{
  if(row.intervals.length>4320)throw Error('Invalid recorded physical coverage.');
  let end:number|null=null;
  for(const interval of row.intervals){
   if(!Number.isSafeInteger(interval.fromEpochMillisecond)||!Number.isSafeInteger(interval.toEpochMillisecond)
    ||interval.fromEpochMillisecond>=interval.toEpochMillisecond||(end!==null&&interval.fromEpochMillisecond<end))
    throw Error('Invalid recorded physical coverage.');
   end=interval.toEpochMillisecond;
  }
 };
 valid(candidate);
 const overlaps=(a:typeof candidate.intervals,b:typeof candidate.intervals)=>{
  let i=0,j=0;
  while(i<a.length&&j<b.length){
   if(a[i].fromEpochMillisecond<b[j].toEpochMillisecond&&b[j].fromEpochMillisecond<a[i].toEpochMillisecond)return true;
   if(a[i].toEpochMillisecond<=b[j].toEpochMillisecond)i++;else j++;
  }
  return false;
 };
 const conflicts:string[]=[];
 for(const row of current){
  if(row.identity.tenantId!==candidate.identity.tenantId||row.identity.employmentId!==candidate.identity.employmentId)continue;
  valid(row);
  const same=row.identity.sourceId===candidate.identity.sourceId&&row.identity.calculationId===candidate.identity.calculationId;
  if(same&&isDeepStrictEqual(row,candidate))continue; // exact reservation retry only
  if(overlaps(candidate.intervals,row.intervals))
   conflicts.push(row.identity.sourceId);
 }
 return [...new Set(conflicts)].sort();
}
