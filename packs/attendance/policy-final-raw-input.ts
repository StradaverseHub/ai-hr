/** Retained raw effect/current capture agreement is not a submitted policy
 * binding, a live workflow capability, an approved duration or settlement authority. */
import {isDeepStrictEqual} from 'node:util';
import type {AttendancePolicyExecutionContext} from '../../core/attendance';
import type {AttendanceTraceV1} from '../../core/attendance-trace';
import type {PolicyApprovalInput} from './policy-approval-input';
import type {RecordedPolicyClockSource} from './policy-clock-input';
import {attendancePolicyTraceBinding} from './policy-trace-binding';
import {replayAttendancePolicyRawClocks} from './policy-clock-replay';

type RawCurrent={attendanceId:string;checkInAt:string|null;checkOutAt:string|null;workedMinutes:number|null;
 lateMinutes:number|null;earlyOutMinutes:number|null;underMinutes:number|null;
 dayType:'workday'|'rest_day'|'holiday'|null;trace:AttendanceTraceV1|null};
type Request=Pick<PolicyApprovalInput['requests'][number],'id'|'status'|'cancelledAt'|'submissionContract'|'finalReceipt'>;
export type PolicyFinalRawAgreement=
 |{state:'unavailable';authority:'retainedRawAgreementOnly';reason:'identityUnavailable'|'finalReceiptUnavailable'|'rawEffectUnavailable'|'captureSetMismatch'|'rawReplayUnavailable'}
 |{state:'known';authority:'retainedRawAgreementOnly';correctionId:string;workflowRequestId:string;
   attendanceId:string;policyRevisionId:string;captureIds:string[]};

/** Both arguments must come from the canonical tenant transaction reader. This deliberately does
 * not map requested/system_calculated/smaller_of/greater_of into interval operators. The original
 * submission binding and complete scalar/count allocation owner remain separate prerequisites. */
export function attendancePolicyFinalRawAgreement(context:AttendancePolicyExecutionContext|undefined,
 request:Request,tenantId:string,source:RecordedPolicyClockSource|undefined,current:RawCurrent):PolicyFinalRawAgreement{
 const refuse=(reason:Extract<PolicyFinalRawAgreement,{state:'unavailable'}>['reason']):PolicyFinalRawAgreement=>
  ({state:'unavailable',authority:'retainedRawAgreementOnly',reason});
 if(context?.state!=='policy'||!tenantId||!current.attendanceId)return refuse('identityUnavailable');
 const submission=request.submissionContract,final=request.finalReceipt,binding=attendancePolicyTraceBinding(context);
 if(submission.state!=='recorded'||submission.kind!=='epoch'||submission.correctionId!==request.id
  ||submission.tenantId!==tenantId||submission.employmentId!==context.employmentId
  ||submission.companyId!==context.companyId||submission.date!==context.date
  ||!binding||!isDeepStrictEqual(submission.policyBinding,binding))return refuse('identityUnavailable');
 if(request.status!=='approved'||request.cancelledAt!==null||final.state!=='recorded'
  ||final.authority!=='finalWorkflowDecisionOnly'||final.correctionId!==request.id
  ||final.submissionEpoch!==submission.visibleEpoch)return refuse('finalReceiptUnavailable');
 // raw:null is the legitimate future-plan case and carries no worked-day proof.
 const raw=final.raw;
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return refuse('rawEffectUnavailable');
 const trace=current.trace,retainedTrace=raw.trace;
 if(!trace||!retainedTrace||typeof retainedTrace!=='object'||Array.isArray(retainedTrace))return refuse('rawEffectUnavailable');
 // The calculation reference is written AFTER the raw final effect. It belongs to the independent
 // financial owner, not physical work. Compare every retained raw field while excluding only that
 // separately owned marker; current financial consumers must revalidate their own calculation.
 const {overtimePattern:retainedCalculation,...retainedRawTrace}=retainedTrace;
 const {overtimePattern:currentCalculation,...currentRawTrace}=trace;
 if(!binding||!trace||!isDeepStrictEqual(trace.executionPolicy,binding)
  ||raw.attendanceId!==current.attendanceId||raw.checkIn!==current.checkInAt||raw.checkOut!==current.checkOutAt
  ||raw.workedMinutes!==current.workedMinutes||raw.lateMinutes!==current.lateMinutes
  ||raw.earlyOutMinutes!==current.earlyOutMinutes||raw.dayType!==current.dayType
  ||!isDeepStrictEqual(retainedRawTrace,currentRawTrace))return refuse('rawEffectUnavailable');
 if(source?.state!=='known'||source.clocks.length<2||source.clocks.length>128
  ||raw.punchCount!==source.clocks.length||!Array.isArray(raw.punches)
  ||raw.punches.length!==source.clocks.length)return refuse('captureSetMismatch');
 const currentById=new Map(source.clocks.map(clock=>[clock.id,clock]));
 if(currentById.size!==source.clocks.length||new Set(source.clocks.map(clock=>clock.captureId)).size!==source.clocks.length)
  return refuse('captureSetMismatch');
 const seen=new Set<string>();
 for(const punch of raw.punches){
  if(!punch||typeof punch!=='object'||Array.isArray(punch)||!('id' in punch)||typeof punch.id!=='string'||seen.has(punch.id))
   return refuse('captureSetMismatch');
  seen.add(punch.id);
  const clock=currentById.get(punch.id);
  if(!clock||!('clock_capture_id' in punch)||!('direction' in punch)||punch.clock_capture_id!==clock.captureId||punch.direction!==clock.direction)return refuse('captureSetMismatch');
  // Label comparisons remain checks of retained labels only; all actual instants come from the
  // current reader's immutable capture receipts and independent millisecond replay below.
  const seconds=Math.floor(clock.atMilliseconds/1000)%86400;
  const label=[Math.floor(seconds/3600),Math.floor(seconds/60)%60,seconds%60].map(v=>String(v).padStart(2,'0')).join(':');
  if(!('punch_at' in punch)||punch.punch_at!==label)return refuse('captureSetMismatch');
 }
 const replay=replayAttendancePolicyRawClocks(context,source,current.trace,current);
 if(replay.state!=='known'||!replay.evidence.complete||replay.evidence.requiresReview)return refuse('rawReplayUnavailable');
 return {state:'known',authority:'retainedRawAgreementOnly',correctionId:request.id,workflowRequestId:final.workflowRequestId,
  attendanceId:current.attendanceId,policyRevisionId:context.selected.id,captureIds:source.clocks.map(clock=>clock.captureId)};
}
