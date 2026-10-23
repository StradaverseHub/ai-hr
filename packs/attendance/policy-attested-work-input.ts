/** Independent retained HR-work replay. A testimony is never a captured clock or a live
 * workflow capability. Financial coverage and settlement must independently admit this source. */
import {isDeepStrictEqual} from 'node:util';
import type {attendance} from '../../db/schema';
import type {AttendancePolicyExecutionContext} from '../../core/attendance';
import type {PolicyApprovalInput} from './policy-approval-input';
import {attendancePolicyTraceBinding} from './policy-trace-binding';
import {attendancePolicyUnclockedWorkComparison} from './policy-work-input';
import {validateAttendancePolicyUnclockedWork,type AttendancePolicyUnclockedWork} from '../../lib/attendance-policy-unclocked-work';

export type PolicyAttestedWorkSource={authority:'attestedSourceOnly';punchCount:number;
 anchor:Pick<typeof attendance.$inferSelect,'id'|'tenantId'|'employmentId'|'attendanceDate'|'attestedWorkCorrectionId'|'attestedWorkContext'|
 'checkInAt'|'checkOutAt'|'status'|'dayType'|'workedMinutes'|'otMinutes'|'lateMinutes'|'earlyOutMinutes'|'underMinutes'|
 'lateDeductMinutes'|'earlyOutDeductMinutes'|'otFlatMinutes'|'ot00Minutes'|'ot10Minutes'|'ot15Minutes'|'ot20Minutes'|'ot30Minutes'|'calcTrace'>;
 /** Actual immutable private-owner row, read independently of the receipt's retained copy. */
 ownerEffect:Record<string,unknown>};
const json=(value:unknown)=>JSON.parse(JSON.stringify(value));
const same=(a:unknown,b:unknown)=>isDeepStrictEqual(json(a),json(b));
export function attendancePolicyAttestedWorkInput(context:AttendancePolicyExecutionContext|undefined,
 approvals:PolicyApprovalInput|undefined,tenantId:string,source:PolicyAttestedWorkSource|undefined){
 const refuse=()=>({state:'unavailable' as const,authority:'attestedWorkReplayOnly' as const});
 try{
  if(context?.state!=='policy'||!source||source.authority!=='attestedSourceOnly'||source.punchCount!==0||!approvals
   ||approvals.authority!=='sourceOnly'||approvals.policyRevisionId!==context.selected.id
   ||!same(approvals.activation,context.selected.activation))return refuse();
  const a=source.anchor,binding=attendancePolicyTraceBinding(context);
  if(!binding||binding.activation.epoch<1||!a.attestedWorkCorrectionId||a.tenantId!==tenantId
   ||a.employmentId!==context.employmentId||a.attendanceDate!==context.date||a.status!=='present'
   ||!same(a.attestedWorkContext,context))return refuse();
  const trace=a.calcTrace;
  // Only the independently owned calculation marker may follow the unknown raw anchor.
  if(trace!==null&&(typeof trace!=='object'||Array.isArray(trace)||Object.keys(trace).some(key=>key!=='overtimePattern')))
   return refuse();
  for(const key of ['checkInAt','checkOutAt','workedMinutes','otMinutes','lateMinutes','earlyOutMinutes','underMinutes',
   'lateDeductMinutes','earlyOutDeductMinutes','otFlatMinutes','ot00Minutes','ot10Minutes','ot15Minutes','ot20Minutes','ot30Minutes'] as const)
   if(a[key]!==null)return refuse();
  const active=approvals.requests.filter(row=>row.requestedMinutes!==null&&row.cancelledAt===null&&row.status!=='rejected');
  if(active.length!==1||active[0].id!==a.attestedWorkCorrectionId)return refuse();
  const request=active[0],submission=request.submissionContract,final=request.finalReceipt;
  if(request.status!=='approved'||submission.state!=='recorded'||final.state!=='recorded'||final.raw!==null
   ||submission.kind!=='epoch'||submission.tenantId!==tenantId||submission.employmentId!==context.employmentId
   ||submission.companyId!==context.companyId||submission.date!==context.date||submission.correctionId!==request.id
   ||submission.visibleEpoch===null||submission.visibleEpoch<binding.activation.epoch
   ||!same(submission.policyBinding,binding)||final.submissionEpoch!==submission.visibleEpoch)return refuse();
  const submitted=submission.attestedWork,effect=final.workflow.unclockedEffect;
  if(!submitted||submitted.authority!=='hrAttestedWorkSubmission'||submitted.correctionId!==request.id
   ||submitted.tenantId!==tenantId||submitted.companyId!==context.companyId||submitted.employmentId!==context.employmentId
   ||submitted.date!==context.date||typeof submitted.actorUserId!=='string'||!submitted.actorUserId
   ||typeof submitted.recordedAt!=='string'||!effect||typeof effect!=='object'||Array.isArray(effect))return refuse();
  const e=effect as Record<string,unknown>,actual=source.ownerEffect;
  const normalized=(row:Record<string,unknown>)=>({...row,recorded_at:typeof row.recorded_at==='string'?Date.parse(row.recorded_at):null});
  if(!same(normalized(e),normalized(actual))||e.authority!=='attestedActualWorkOnly'||e.attendance_id!==a.id
   ||e.correction_id!==request.id||e.tenant_id!==tenantId||e.company_id!==context.companyId
   ||e.employment_id!==context.employmentId||e.attendance_date!==context.date
   ||e.workflow_request_id!==final.workflowRequestId||e.actor_user_id!==final.actorUserId
   ||!same(e.attested_work,submitted)||!same(e.context_evidence,context)||!same(e.policy_binding,binding)
   ||e.requested_minutes!==request.requestedMinutes||e.approved_minutes!==request.approvedMinutes
   ||e.manual_method!==request.method||submission.manualApprovalMethod!==request.method)return refuse();
  const submittedAt=Date.parse(submission.recordedAt),attestedAt=Date.parse(submitted.recordedAt),
   finalAt=Date.parse(final.recordedAt),effectAt=typeof e.recorded_at==='string'?Date.parse(e.recorded_at):NaN,
   activatedAt=Date.parse(context.selected.activation.recordedAt);
  if(![submittedAt,attestedAt,finalAt,effectAt,activatedAt].every(Number.isFinite)
   ||attestedAt<activatedAt||submittedAt<attestedAt||effectAt<submittedAt||finalAt<effectAt)return refuse();
  const work=validateAttendancePolicyUnclockedWork(submitted.work as AttendancePolicyUnclockedWork,Math.floor(attestedAt));
  if(!same(work,submitted.work))return refuse();
  const comparison=attendancePolicyUnclockedWorkComparison(context,work,Math.floor(attestedAt));
  if(comparison.state!=='known')return refuse();
  return {state:'known' as const,authority:'attestedWorkReplayOnly' as const,correctionId:request.id,
   workflowRequestId:final.workflowRequestId,attendanceId:a.id,actualWork:comparison.actualWork,
   work:comparison.work,measurements:comparison.measurements};
 }catch{return refuse();}
}
