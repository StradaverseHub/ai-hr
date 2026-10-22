/** Frozen scalar methods select counts; they are never aliases for interval intersection.
 * Only exact retained final effects and current captured work can supply a Manual proposal. */
import {isDeepStrictEqual} from 'node:util';
import {resolveApprovedOt,type AttendancePolicyExecutionContext} from '../../core/attendance';
import type {PolicyApprovalInput} from './policy-approval-input';
import {attendancePolicyWorkInput,type PolicyWorkInput} from './policy-work-input';
import {attendancePolicyClockMillisecondEvidence} from '../../lib/attendance-policy-clocks';
import {attendancePolicyPlanInput} from './policy-plan-input';
import type {RecordedPolicyClockSource} from './policy-clock-input';
import {attendancePolicyFinalRawAgreement,type PolicyRawCurrent} from './policy-final-raw-input';
import {selectAttendancePolicyCandidate} from './policy-duration';
import {attendancePolicyIntervalMinutes as minutes,subtractAttendancePolicyIntervals as subtract,
 unionAttendancePolicyIntervals as union,type AttendancePolicyInterval} from '../../lib/attendance-policy-intervals';

export type PolicyRawEffectSource={clocks:RecordedPolicyClockSource|undefined;current:PolicyRawCurrent};
export type PolicyManualDurationInput=
 |{state:'unavailable';authority:'manualCountProposalOnly';reason:'sourceUnavailable'|'approvalSetUnavailable'|'methodMismatch'|'countPlacementUnavailable'}
 |{state:'known';authority:'manualCountProposalOnly';correctionId:string;workflowRequestId:string;
   method:'requested'|'system_calculated'|'smaller_of'|'greater_of';systemMinutes:number;approvedMinutes:number;
   basis:'completeActualCount'|'completeSubmittedWindow';intervals:AttendancePolicyInterval[]};

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
 const agreement=attendancePolicyFinalRawAgreement(context,request,tenantId,raw.clocks,raw.current);
 if(agreement.state!=='known'||raw.clocks?.state!=='known')return refuse('sourceUnavailable');
 const submittedAt=Date.parse(submission.recordedAt),decidedAt=Date.parse(final.recordedAt),activatedAt=Date.parse(context.selected.activation.recordedAt);
 if(![submittedAt,decidedAt,activatedAt].every(Number.isFinite)||submittedAt<activatedAt||decidedAt<submittedAt)return refuse('sourceUnavailable');
 const clocks=attendancePolicyClockMillisecondEvidence(raw.clocks.clocks,context.resolvedClock,work.periodMinutes);
 if(!isDeepStrictEqual(attendancePolicyWorkInput(context,clocks),work))return refuse('sourceUnavailable');
 const selection=selectAttendancePolicyCandidate({eligibleIntervals:work.eligibleActualIntervals,unpaidIntervals:work.unpaidIntervals,
  lateOffsetIntervals:work.lateOffsetIntervals,offsetLateness:context.selected.policy.overtime.offsetLateness,periodMinutes:work.periodMinutes});
 if(selection.state!=='known')return refuse('sourceUnavailable');
 const actual=context.selected.policy.overtime.enabled?selection.afterOffset.intervals:[],systemMinutes=minutes(actual,work.periodMinutes);
 if(resolveApprovedOt(request.requestedMinutes!,systemMinutes,method)!==request.approvedMinutes)return refuse('methodMismatch');
 let intervals=actual,basis:'completeActualCount'|'completeSubmittedWindow'='completeActualCount';
 if(request.approvedMinutes!==systemMinutes){
  const plan=attendancePolicyPlanInput(context,approvals,tenantId);
  if(plan.state!=='known'||plan.references.length!==1||plan.references[0].correctionId!==request.id
   ||plan.references[0].workflowRequestId!==final.workflowRequestId)return refuse('countPlacementUnavailable');
  intervals=union(plan.intervals,work.periodMinutes);basis='completeSubmittedWindow';
  // Outside-clock, unpaid, late-offset and partial scalar minutes acquire no invented position.
  if(minutes(intervals,work.periodMinutes)!==request.approvedMinutes||subtract(intervals,actual,work.periodMinutes).length)
   return refuse('countPlacementUnavailable');
 }
 return {state:'known',authority:'manualCountProposalOnly',correctionId:request.id,workflowRequestId:final.workflowRequestId,
  method,systemMinutes,approvedMinutes:request.approvedMinutes,basis,intervals:intervals.map(row=>({...row}))};
}
