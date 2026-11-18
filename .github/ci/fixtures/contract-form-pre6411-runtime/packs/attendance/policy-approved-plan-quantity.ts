/** Approved-plan quantity and actual work are independent evidence. This projection is
 * not a captured span, payable clock extension, final-effect capability or settlement. */
import {attendancePolicyIndependentDurationReplay,attendancePolicyIndependentSource,type IndependentPolicyDurationSource} from './policy-duration-replay';
import {attendancePolicyPlanInput} from './policy-plan-input';
import {attendancePolicyAttestedWorkInput} from './policy-attested-work-input';
import {attendancePolicyCountAttribution} from './policy-count-attribution';
import {subtractAttendancePolicyIntervals} from '../../lib/attendance-policy-intervals';
import {overtimeUuid} from '../../lib/overtime-pattern-schema';
import type {CanonicalOvertimeSnapshot} from './overtime-patterns';

type PhysicalInterval={fromEpochMillisecond:number;toEpochMillisecond:number};
export type PolicyApprovedPlanQuantity=
 |{state:'unavailable';authority:'approvedPlanQuantityProposalOnly';reason:'planUnavailable'|'workedDayUnavailable'|'quantityMismatch'}
 |{state:'prepared';authority:'approvedPlanQuantityProposalOnly';basis:'approvedPlanWithIndependentWorkedDay';
   source:IndependentPolicyDurationSource['source'];durationDigest:string;minutes:number;
   plan:Extract<ReturnType<typeof attendancePolicyPlanInput>,{state:'known'}>;
   quantities:{sequence:number;calendarDate:string;dayClass:string;selectedMinutes:number;payableMinutes:number;
    intervals:{from:number;to:number}[];roundingCountAttributions:Extract<ReturnType<typeof attendancePolicyCountAttribution>,{state:'known'}>['parts'][number]['roundingCountAttributions']}[];
   workedDay:{basis:'captured'|'attested';intervals:PhysicalInterval[];
    captures?:{inPunchId:string;outPunchId:string;inCaptureId:string;outCaptureId:string;fromEpochMillisecond:number;toEpochMillisecond:number}[];
    correctionId?:string;workflowRequestId?:string}};

export function attendancePolicyIndependentApprovedPlanQuantity(snapshot:IndependentPolicyDurationSource):PolicyApprovedPlanQuantity{
 const refuse=(reason:Extract<PolicyApprovedPlanQuantity,{state:'unavailable'}>['reason']):PolicyApprovedPlanQuantity=>
  ({state:'unavailable',authority:'approvedPlanQuantityProposalOnly',reason});
 try{
  const context=snapshot.policyExecutionContext,proposal=snapshot.policyExecutionProposal;
  const duration=attendancePolicyIndependentDurationReplay(snapshot);
  if(context?.state!=='policy'||proposal?.state!=='proposed'||proposal.duration.status!=='calculated'
   ||proposal.duration.intervalBasis!=='approvedPlan'||duration.state!=='known')return refuse('planUnavailable');
  const plan=attendancePolicyPlanInput(context,snapshot.policyApprovalInput,snapshot.source.tenantId);
  if(plan.state!=='known')return refuse('planUnavailable');
  const counts=attendancePolicyCountAttribution(proposal.duration);
  if(counts.state!=='known'||counts.minutes!==duration.minutes)return refuse('quantityMismatch');
  const quantities:Extract<PolicyApprovedPlanQuantity,{state:'prepared'}>['quantities']=[];
  for(const [sequence,part]of proposal.duration.parts.entries()){
   const count=counts.parts[sequence];
   if(!count||count.calendarDate!==part.date||count.dayClass!==part.dayClass
    ||subtractAttendancePolicyIntervals(part.allocations,plan.intervals,4320).length)return refuse('quantityMismatch');
   quantities.push({sequence,calendarDate:part.date,dayClass:part.dayClass,selectedMinutes:count.physicalMinutes,
    payableMinutes:count.minutes,intervals:part.allocations.map(row=>({...row})),roundingCountAttributions:count.roundingCountAttributions});
  }
  let workedDay:Extract<PolicyApprovedPlanQuantity,{state:'prepared'}>['workedDay'];
  const attested=snapshot.policyRawEffectSource?.attested;
  if(attested){
   const work=attendancePolicyAttestedWorkInput(context,snapshot.policyApprovalInput,snapshot.source.tenantId,attested);
   if(work.state!=='known'||work.attendanceId!==snapshot.source.attendanceId)return refuse('workedDayUnavailable');
   workedDay={basis:'attested',correctionId:work.correctionId,workflowRequestId:work.workflowRequestId,
    intervals:work.actualWork.intervals.map(row=>({fromEpochMillisecond:row.fromEpochMillisecond,toEpochMillisecond:row.toEpochMillisecond}))};
  }else{
   const clocks=snapshot.policyClockSource,review=snapshot.policyClockReview;
   if(clocks?.state!=='known'||review?.state!=='known'||!review.evidence.complete||review.evidence.requiresReview)return refuse('workedDayUnavailable');
   const midnight=Date.parse(snapshot.source.date+'T00:00:00+08:00');
   const captures=review.evidence.intervals.map(pair=>{
    const ins=clocks.clocks.filter(row=>row.direction==='in'&&row.atMilliseconds===pair.inMillisecond);
    const outs=clocks.clocks.filter(row=>row.direction==='out'&&row.atMilliseconds===pair.outMillisecond);
    if(ins.length!==1||outs.length!==1)throw Error('Original worked interval has ambiguous captures.');
    for(const clock of [ins[0],outs[0]]){overtimeUuid(clock.id,'punch');overtimeUuid(clock.captureId,'capture');}
    return {inPunchId:ins[0].id,outPunchId:outs[0].id,inCaptureId:ins[0].captureId,outCaptureId:outs[0].captureId,
     fromEpochMillisecond:midnight+pair.inMillisecond,toEpochMillisecond:midnight+pair.outMillisecond};
   });
   workedDay={basis:'captured',captures,intervals:captures.map(row=>({fromEpochMillisecond:row.fromEpochMillisecond,toEpochMillisecond:row.toEpochMillisecond}))};
  }
  if(!workedDay.intervals.length)return refuse('workedDayUnavailable');
  let end:number|null=null;
  for(const span of workedDay.intervals){
   if(!Number.isSafeInteger(span.fromEpochMillisecond)||!Number.isSafeInteger(span.toEpochMillisecond)
    ||span.toEpochMillisecond<=span.fromEpochMillisecond||(end!==null&&span.fromEpochMillisecond<end))return refuse('workedDayUnavailable');
   end=span.toEpochMillisecond;
  }
  // The complete real worked footprint is retained independently of plan positions. It
  // may be disjoint or shorter; neither quantity nor rounding manufactures physical work.
  return {state:'prepared',authority:'approvedPlanQuantityProposalOnly',basis:'approvedPlanWithIndependentWorkedDay',
   source:{...snapshot.source},durationDigest:duration.digest,minutes:duration.minutes,plan,quantities,workedDay};
 }catch{return refuse('quantityMismatch');}
}
export function attendancePolicyApprovedPlanQuantity(snapshot:CanonicalOvertimeSnapshot):PolicyApprovedPlanQuantity{
 const source=attendancePolicyIndependentSource(snapshot);
 return source?attendancePolicyIndependentApprovedPlanQuantity(source)
  :{state:'unavailable',authority:'approvedPlanQuantityProposalOnly',reason:'workedDayUnavailable'};
}
