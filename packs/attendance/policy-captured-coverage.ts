/** Original capture geometry and the separate existing boundary-floor count attribution.
 * This is proposal evidence only; ready headers, current consumers and settlement retain their owners. */
import type {CanonicalOvertimeSnapshot} from './overtime-patterns';
import {attendancePolicyIndependentDurationReplay,attendancePolicyIndependentSource,type IndependentPolicyDurationSource} from './policy-duration-replay';
import {attendancePolicyCoverageProposal,type PolicyCoverageIdentity} from './policy-coverage';
import {overtimeUuid} from '../../lib/overtime-pattern-schema';
export type PolicyCapturedCoverageProposal=
 |{state:'unavailable';authority:'capturedCountCoverageProposalOnly';reason:'durationUnavailable'|'sourceMismatch'|'countPlacementUnavailable'}
 |{state:'prepared';authority:'capturedCountCoverageProposalOnly';identity:PolicyCoverageIdentity;durationDigest:string;
   countBasis:'capturedBoundaryFloor';minutes:number;
   allocations:{sequence:number;calendarDate:string;fromMinute:number;toMinute:number;minutes:number;
    inPunchId:string;outPunchId:string;inCaptureId:string;outCaptureId:string;
    captureInEpochMillisecond:number;captureOutEpochMillisecond:number;
    fromEpochMillisecond:number;toEpochMillisecond:number}[];
   intervals:{fromEpochMillisecond:number;toEpochMillisecond:number}[]};
/** A minute coordinate is count attribution, not a captured instant. Keep that existing count
 * owner unchanged and intersect its selected windows with the independently replayed original
 * millisecond geometry. Never lengthen a capture to justify a minute count or rounding remainder. */
export function attendancePolicyIndependentCapturedCoverage(identity:PolicyCoverageIdentity,snapshot:IndependentPolicyDurationSource):PolicyCapturedCoverageProposal{
 const refuse=(reason:Extract<PolicyCapturedCoverageProposal,{state:'unavailable'}>['reason']):PolicyCapturedCoverageProposal=>
  ({state:'unavailable',authority:'capturedCountCoverageProposalOnly',reason});
 try{
  const source=snapshot.source,context=snapshot.policyExecutionContext,clocks=snapshot.policyClockSource,review=snapshot.policyClockReview,
   proposal=snapshot.policyExecutionProposal,replay=attendancePolicyIndependentDurationReplay(snapshot);
  if(replay.state!=='known'||proposal?.state!=='proposed'||proposal.duration.status!=='calculated')return refuse('durationUnavailable');
  if(source.tenantId!==identity.tenantId||source.employmentId!==identity.employmentId||source.date!==identity.date
   ||context?.state!=='policy'||context.companyId!==identity.companyId||clocks?.state!=='known'||review?.state!=='known')return refuse('sourceMismatch');
  const count=attendancePolicyCoverageProposal(identity,proposal);
  if(count.state!=='prepared')return refuse('countPlacementUnavailable');
  const midnight=Date.parse(identity.date+'T00:00:00+08:00');
  const pairs=review.evidence.intervals.map(pair=>{
   const ins=clocks.clocks.filter(clock=>clock.direction==='in'&&clock.atMilliseconds===pair.inMillisecond),
    outs=clocks.clocks.filter(clock=>clock.direction==='out'&&clock.atMilliseconds===pair.outMillisecond);
   if(ins.length!==1||outs.length!==1)throw Error('Ambiguous captured boundary');
   for(const clock of [ins[0],outs[0]]){overtimeUuid(clock.id,'punch');overtimeUuid(clock.captureId,'capture');}
   return {pair,inClock:ins[0],outClock:outs[0]};
  });
  const allocations:Extract<PolicyCapturedCoverageProposal,{state:'prepared'}>['allocations']=[];
  for(const [sequence,part]of proposal.duration.parts.entries())for(const allocation of part.allocations){
   let owned=0;
   for(const {pair,inClock,outClock}of pairs){
    const from=Math.max(allocation.from,Math.floor(pair.inMillisecond/60000)),
     to=Math.min(allocation.to,Math.floor(pair.outMillisecond/60000));
    if(to<=from)continue;
    const physicalFrom=Math.max(pair.inMillisecond,from*60000),physicalTo=Math.min(pair.outMillisecond,to*60000);
    if(!Number.isSafeInteger(physicalFrom)||!Number.isSafeInteger(physicalTo)||physicalFrom>=physicalTo)return refuse('countPlacementUnavailable');
    owned+=to-from;
    allocations.push({sequence,calendarDate:part.date,fromMinute:from,toMinute:to,minutes:to-from,
     inPunchId:inClock.id,outPunchId:outClock.id,inCaptureId:inClock.captureId,outCaptureId:outClock.captureId,
     captureInEpochMillisecond:midnight+pair.inMillisecond,captureOutEpochMillisecond:midnight+pair.outMillisecond,
     fromEpochMillisecond:midnight+physicalFrom,toEpochMillisecond:midnight+physicalTo});
   }
   if(owned!==allocation.to-allocation.from)return refuse('countPlacementUnavailable');
  }
  if(allocations.reduce((sum,row)=>sum+row.minutes,0)!==replay.minutes)return refuse('countPlacementUnavailable');
  allocations.sort((a,b)=>a.fromEpochMillisecond-b.fromEpochMillisecond||a.toEpochMillisecond-b.toEpochMillisecond);
  const intervals:Extract<PolicyCapturedCoverageProposal,{state:'prepared'}>['intervals']=[];
  for(const row of allocations){
   const last=intervals.at(-1);
   if(last&&row.fromEpochMillisecond<last.toEpochMillisecond)return refuse('countPlacementUnavailable');
   if(last&&row.fromEpochMillisecond===last.toEpochMillisecond)last.toEpochMillisecond=row.toEpochMillisecond;
   else intervals.push({fromEpochMillisecond:row.fromEpochMillisecond,toEpochMillisecond:row.toEpochMillisecond});
  }
  return {state:'prepared',authority:'capturedCountCoverageProposalOnly',identity:{...identity},durationDigest:replay.digest,
   countBasis:'capturedBoundaryFloor',minutes:replay.minutes,allocations,intervals};
 }catch{return refuse('sourceMismatch');}
}

export function attendancePolicyCapturedCoverageProposal(identity:PolicyCoverageIdentity,snapshot:CanonicalOvertimeSnapshot):PolicyCapturedCoverageProposal{
 const source=attendancePolicyIndependentSource(snapshot);
 return source?attendancePolicyIndependentCapturedCoverage(identity,source)
  :{state:'unavailable',authority:'capturedCountCoverageProposalOnly',reason:'durationUnavailable'};
}
