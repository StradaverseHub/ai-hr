import {attendancePolicyAttestedWorkInput,type PolicyAttestedWorkSource} from './policy-attested-work-input';
/** Frozen scalar methods select counts; they are never aliases for interval intersection.
 * Only exact retained final effects and current captured work can supply a Manual proposal. */
import {isDeepStrictEqual} from 'node:util';
import {resolveApprovedOt,type AttendancePolicyExecutionContext} from '../../core/attendance';
import type {PolicyApprovalInput} from './policy-approval-input';
import {attendancePolicyWorkInput,type PolicyWorkInput} from './policy-work-input';
import {attendancePolicyClockMillisecondEvidence} from '../../lib/attendance-policy-clocks';
import {attendancePolicyPlanInput,type PolicyPlanInput} from './policy-plan-input';
import type {RecordedPolicyClockSource} from './policy-clock-input';
import {attendancePolicyFinalRawAgreement,type PolicyRawCurrent} from './policy-final-raw-input';
import {selectAttendancePolicyCandidate} from './policy-duration';
import {attendancePolicyIntervalMinutes as minutes,subtractAttendancePolicyIntervals as subtract,
 unionAttendancePolicyIntervals as union,type AttendancePolicyInterval} from '../../lib/attendance-policy-intervals';

export type PolicyRawEffectSource={clocks:RecordedPolicyClockSource|undefined;current:PolicyRawCurrent;attested?:PolicyAttestedWorkSource};
export type PolicyManualDurationInput=
 |{state:'unavailable';authority:'manualCountProposalOnly';reason:'sourceUnavailable'|'approvalSetUnavailable'|'methodMismatch'|'countPlacementUnavailable'}
 |{state:'known';authority:'manualCountProposalOnly';correctionId:string;workflowRequestId:string;
   method:'requested'|'system_calculated'|'smaller_of'|'greater_of';systemMinutes:number;approvedMinutes:number;
   basis:'completeActualCount'|'completeSubmittedWindow'|'completeAttestedRequest';intervals:AttendancePolicyInterval[]};

/** Count placement only. The caller independently proves the submitted policy, current
 * captures and final effect before using these positions in a duration proposal. */
export function selectAttendancePolicyManualPositions(input:{method:Extract<PolicyManualDurationInput,{state:'known'}>['method'];
 requestedMinutes:number;approvedMinutes:number;systemMinutes:number;actualIntervals:readonly AttendancePolicyInterval[];
 hasSubmittedWindow:boolean;periodMinutes:number;plan:PolicyPlanInput;requestedIntervals?:readonly AttendancePolicyInterval[]}){
 const refuse=()=>({state:'unavailable' as const,authority:'manualCountPlacementOnly' as const});
 if(resolveApprovedOt(input.requestedMinutes,input.systemMinutes,input.method)!==input.approvedMinutes)return refuse();
 const actual=union(input.actualIntervals,input.periodMinutes);
 if(minutes(actual,input.periodMinutes)!==input.systemMinutes)return refuse();
 // A requested-count winner retains its explicit original positions even on a scalar tie.
 // System-calculated always owns the complete actual count; scalar methods stay scalar.
 const needsWindow=input.approvedMinutes!==input.systemMinutes
  ||input.method!=='system_calculated'&&input.approvedMinutes===input.requestedMinutes&&(input.hasSubmittedWindow||input.requestedIntervals!==undefined);
 if(needsWindow){
  if(input.requestedIntervals!==undefined){
   if(!input.requestedIntervals.length||input.requestedIntervals.length>16||input.requestedIntervals.some((row,index)=>index>0&&row.from<input.requestedIntervals![index-1].to))return refuse();
   const intervals=union(input.requestedIntervals,input.periodMinutes);
   if(!intervals.length||minutes(intervals,input.periodMinutes)!==input.requestedMinutes
    ||input.approvedMinutes!==input.requestedMinutes||subtract(intervals,actual,input.periodMinutes).length)return refuse();
   return {state:'known' as const,authority:'manualCountPlacementOnly' as const,basis:'completeAttestedRequest' as const,intervals};
  }
  if(input.plan.state!=='known')return refuse();
  const intervals=union(input.plan.intervals,input.periodMinutes);
  if(minutes(intervals,input.periodMinutes)!==input.approvedMinutes||subtract(intervals,actual,input.periodMinutes).length)return refuse();
  return {state:'known' as const,authority:'manualCountPlacementOnly' as const,basis:'completeSubmittedWindow' as const,intervals};
 }
 return {state:'known' as const,authority:'manualCountPlacementOnly' as const,basis:'completeActualCount' as const,intervals:actual};
}

export function attendancePolicyManualDurationInput(context:AttendancePolicyExecutionContext|undefined,work:PolicyWorkInput|undefined,
 approvals:PolicyApprovalInput|undefined,tenantId:string,raw:PolicyRawEffectSource|undefined):PolicyManualDurationInput{
 const refuse=(reason:Extract<PolicyManualDurationInput,{state:'unavailable'}>['reason']):PolicyManualDurationInput=>
  ({state:'unavailable',authority:'manualCountProposalOnly',reason});
 if(context?.state!=='policy'||work?.state!=='known'||!raw||!approvals
  ||approvals.authority!=='sourceOnly'||approvals.policyRevisionId!==context.selected.id||approvals.mode!=='manual'
  ||context.selected.policy.overtime.approval!=='manual'||!isDeepStrictEqual(approvals.activation,context.selected.activation))return refuse('sourceUnavailable');
 // Multiple scalar decisions cannot independently claim the same whole day's system count.
 // A separate complete multi-request allocation contract is required before admitting that set.
 if(approvals.requests.length>500||new Set(approvals.requests.map(row=>row.id)).size!==approvals.requests.length)return refuse('approvalSetUnavailable');
 const requests=approvals.requests.filter(row=>row.requestedMinutes!==null&&row.cancelledAt===null&&row.status!=='rejected');
 if(requests.length!==1)return refuse('approvalSetUnavailable');
 const request=requests[0],method=request.method,final=request.finalReceipt,submission=request.submissionContract;
 if(request.status!=='approved'||final.state!=='recorded'||submission.state!=='recorded'
  ||!method||!['requested','system_calculated','smaller_of','greater_of'].includes(method)
  ||submission.manualApprovalMethod!==method||final.request.method!==method
  ||final.request.approvedMinutes!==request.approvedMinutes||final.request.requestedMinutes!==request.requestedMinutes
  ||!Number.isSafeInteger(request.requestedMinutes)||request.requestedMinutes!<0
  ||request.approvedMinutes===null||!Number.isSafeInteger(request.approvedMinutes)||request.approvedMinutes<0)
  return refuse('methodMismatch');
 const submittedAt=Date.parse(submission.recordedAt),decidedAt=Date.parse(final.recordedAt),activatedAt=Date.parse(context.selected.activation.recordedAt);
 if(![submittedAt,decidedAt,activatedAt].every(Number.isFinite)||submittedAt<activatedAt||decidedAt<submittedAt)return refuse('sourceUnavailable');
 if(raw.attested){
  const replay=attendancePolicyAttestedWorkInput(context,approvals,tenantId,raw.attested);
  if(replay.state!=='known'||replay.correctionId!==request.id||replay.attendanceId!==raw.current.attendanceId
   ||!isDeepStrictEqual(replay.work,work)||raw.current.checkInAt!==null||raw.current.checkOutAt!==null
   ||raw.current.workedMinutes!==null||raw.current.lateMinutes!==null||raw.current.earlyOutMinutes!==null
   ||raw.current.underMinutes!==null||raw.current.trace!==null||raw.current.dayType!==raw.attested.anchor.dayType)
   return refuse('sourceUnavailable');
 }else{
  const agreement=attendancePolicyFinalRawAgreement(context,request,tenantId,raw.clocks,raw.current);
  if(agreement.state!=='known'||raw.clocks?.state!=='known')return refuse('sourceUnavailable');
  const clocks=attendancePolicyClockMillisecondEvidence(raw.clocks.clocks,context.resolvedClock,work.periodMinutes);
  if(!isDeepStrictEqual(attendancePolicyWorkInput(context,clocks),work))return refuse('sourceUnavailable');
 }
 const selection=selectAttendancePolicyCandidate({eligibleIntervals:work.eligibleActualIntervals,unpaidIntervals:work.unpaidIntervals,
  lateOffsetIntervals:work.lateOffsetIntervals,offsetLateness:context.selected.policy.overtime.offsetLateness,periodMinutes:work.periodMinutes});
 if(selection.state!=='known')return refuse('sourceUnavailable');
 const actual=context.selected.policy.overtime.enabled?selection.afterOffset.intervals:[],systemMinutes=minutes(actual,work.periodMinutes);
 if(resolveApprovedOt(request.requestedMinutes!,systemMinutes,method)!==request.approvedMinutes)return refuse('methodMismatch');
 // The replay above validated this exact immutable testimony, including original instants.
 const retainedRequest=raw.attested?attendancePolicyAttestedWorkInput(context,approvals,tenantId,raw.attested):undefined;
 const midnight=Date.parse(context.date+'T00:00:00+08:00');
 const requestedIntervals=retainedRequest?.state==='known'?retainedRequest.actualWork.requestedIntervals?.map(row=>({
  from:Math.floor((row.fromEpochMillisecond-midnight)/60000),to:Math.floor((row.toEpochMillisecond-midnight)/60000)})):undefined;
 const plan=attendancePolicyPlanInput(context,approvals,tenantId);
 if(plan.state==='known'&&(plan.references.length!==1||plan.references[0].correctionId!==request.id
  ||plan.references[0].workflowRequestId!==final.workflowRequestId))return refuse('countPlacementUnavailable');
 const positioned=selectAttendancePolicyManualPositions({method,requestedMinutes:request.requestedMinutes!,approvedMinutes:request.approvedMinutes,
  systemMinutes,actualIntervals:actual,hasSubmittedWindow:request.plannedWindow.startLabel!==null||request.plannedWindow.endLabel!==null,
  periodMinutes:work.periodMinutes,plan,...(requestedIntervals?{requestedIntervals}:{})});
 if(positioned.state!=='known')return refuse('countPlacementUnavailable');
 return {state:'known',authority:'manualCountProposalOnly',correctionId:request.id,workflowRequestId:final.workflowRequestId,
  method,systemMinutes,approvedMinutes:request.approvedMinutes,basis:positioned.basis,intervals:positioned.intervals.map(row=>({...row}))};
}
