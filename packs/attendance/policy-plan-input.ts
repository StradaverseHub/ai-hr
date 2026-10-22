/** Shared positioned-plan input for the future canonical calculation and independent financial
 * readers. A known plan set is not a worked day, eligible OT, payable part or settlement capability. */
import {isDeepStrictEqual} from 'node:util';
import {plannedOvertimeMinutes} from '../../lib/overtime-duration';
import type {AttendancePolicyExecutionContext} from '../../core/attendance';
import type {PolicyApprovalInput} from './policy-approval-input';
import {unionAttendancePolicyIntervals,type AttendancePolicyInterval} from '../../lib/attendance-policy-intervals';

export type PolicyPlanInput=
 |{state:'unavailable';authority:'approvedPlanOnly';reason:'contextUnavailable'|'policyBindingUnavailable'|'planSetUnavailable'|'planIdentityMismatch'|'planUnavailable'}
 |{state:'known';authority:'approvedPlanOnly';sourceDate:string;companyId:string;policyRevisionId:string;periodMinutes:4320;
   intervals:AttendancePolicyInterval[];references:{correctionId:string;workflowRequestId:string;recordedAt:string;intervals:AttendancePolicyInterval[]}[]};

/** Revalidate the complete recorded set; union only after every active approved request passes.
 * No caller may drop one bad receipt and use the rest as the parent's complete approval proof.
 * A currently visible later policy epoch does not prove the original frozen policy binding.
 * Until a richer binding owner exists, require the exact activated company epoch or refuse. */
export function attendancePolicyPlanInput(context:AttendancePolicyExecutionContext|undefined,
 approvals:PolicyApprovalInput|undefined,tenantId:string):PolicyPlanInput{
 const refuse=(reason:Extract<PolicyPlanInput,{state:'unavailable'}>['reason']):PolicyPlanInput=>({state:'unavailable',authority:'approvedPlanOnly',reason});
 if(context?.state!=='policy')return refuse('contextUnavailable');
 const selected=context.selected;
 if(!approvals||approvals.authority!=='sourceOnly'||approvals.policyRevisionId!==selected.id
  ||approvals.mode!==selected.policy.overtime.approval||approvals.autoMethod!==selected.policy.overtime.autoMethod
  ||!isDeepStrictEqual(approvals.activation,selected.activation)||selected.companyId!==context.companyId
  ||!Number.isSafeInteger(selected.activation.epoch)||selected.activation.epoch<1)return refuse('policyBindingUnavailable');
 if(approvals.requests.length>500||new Set(approvals.requests.map(row=>row.id)).size!==approvals.requests.length)
  return refuse('planSetUnavailable');
 const references:Extract<PolicyPlanInput,{state:'known'}>['references']=[];
 for(const request of approvals.requests){
  if(request.status!=='approved'||request.cancelledAt!==null)continue;
  const submission=request.submissionContract,final=request.finalReceipt,plan=request.positionedPlan;
  if(submission.state!=='recorded'||submission.kind!=='epoch'||submission.visibleEpoch!==selected.activation.epoch)
   return refuse('policyBindingUnavailable');
  if(submission.correctionId!==request.id||submission.tenantId!==tenantId||submission.employmentId!==context.employmentId
   ||submission.companyId!==context.companyId||submission.date!==context.date)return refuse('planIdentityMismatch');
  if(final.state!=='recorded'||plan.state!=='recorded')return refuse('planUnavailable');
  if(final.correctionId!==request.id||plan.correctionId!==request.id||plan.workflowRequestId!==final.workflowRequestId
   ||plan.companyId!==context.companyId||plan.sourceDate!==context.date||plan.submissionEpoch!==submission.visibleEpoch
   ||plan.recordedAt!==final.recordedAt||final.submissionEpoch!==submission.visibleEpoch
   ||request.approvedMinutes!==request.requestedMinutes||!Number.isSafeInteger(request.approvedMinutes)
   ||request.approvedMinutes===null||request.approvedMinutes<1)return refuse('planIdentityMismatch');
  const value=plan.submittedPlan;
  const start=/^([01]\d|2[0-3]):[0-5]\d:00$/.test(value.startLabel??'')?value.startLabel!.slice(0,5):null;
  const end=/^([01]\d|2[0-3]):[0-5]\d:00$/.test(value.endLabel??'')?value.endLabel!.slice(0,5):null;
  const duration=start&&end?plannedOvertimeMinutes(start,end):null;
  const from=start?Number(start.slice(0,2))*60+Number(start.slice(3)):null;
  if(duration===null||from===null||value.version!==1||value.basis!=='startDateEarlierEndNextDay'||value.from!==from
   ||value.to!==from+duration||duration!==request.approvedMinutes
   ||value.startLabel!==request.plannedWindow.startLabel||value.endLabel!==request.plannedWindow.endLabel
   ||final.request.requestedMinutes!==request.requestedMinutes||final.request.approvedMinutes!==request.approvedMinutes
   ||final.request.method!==request.method||final.request.plannedStartLabel!==value.startLabel||final.request.plannedEndLabel!==value.endLabel
   ||plan.intervals.length!==1||value.sourceDate!==context.date||value.requestedMinutes!==request.approvedMinutes
   ||plan.intervals[0].from!==value.from||plan.intervals[0].to!==value.to
   ||value.to-value.from!==request.approvedMinutes)return refuse('planIdentityMismatch');
  // Source projections are rechecked as evidence, including dates after JSON round trips.
  const submitted=Date.parse(submission.recordedAt),activated=Date.parse(selected.activation.recordedAt),decided=Date.parse(final.recordedAt);
  if(!Number.isFinite(submitted)||!Number.isFinite(activated)||!Number.isFinite(decided)
   ||submitted<activated||decided<submitted)return refuse('policyBindingUnavailable');
  references.push({correctionId:request.id,workflowRequestId:plan.workflowRequestId,recordedAt:plan.recordedAt,
   intervals:plan.intervals.map(row=>({...row}))});
 }
 if(!references.length)return refuse('planUnavailable');
 if(new Set(references.map(row=>row.workflowRequestId)).size!==references.length)return refuse('planSetUnavailable');
 try{
  const intervals=unionAttendancePolicyIntervals(references.flatMap(row=>row.intervals),4320);
  references.sort((a,b)=>a.correctionId.localeCompare(b.correctionId));
  return {state:'known',authority:'approvedPlanOnly',sourceDate:context.date,companyId:context.companyId,
   policyRevisionId:selected.id,periodMinutes:4320,intervals,references};
 }catch{return refuse('planIdentityMismatch');}
}
