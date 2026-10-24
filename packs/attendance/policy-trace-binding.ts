/** A dated resolver identity, not work, final approval or financial authority. */
import type {AttendancePolicyExecutionContext} from '../../core/attendance';
import type {TraceAttendancePolicyBinding} from '../../core/attendance-trace';
import {overtimeDate,overtimeUuid} from '../../lib/overtime-pattern-schema';
export function attendancePolicyTraceBinding(context:AttendancePolicyExecutionContext|undefined):TraceAttendancePolicyBinding|null{
 try{
  if(context?.state!=='policy')return null;
  const p=context.selected;
  for(const id of [context.employmentId,context.companyId,p.id,p.ruleId])overtimeUuid(id,'policyBinding');
  overtimeDate(context.date,'sourceDate');overtimeDate(p.effectiveFrom,'effectiveFrom');
  if(p.companyId!==context.companyId||p.ruleId!==context.schedule.ruleId||p.effectiveFrom>context.date
   ||!Number.isSafeInteger(p.ordinal)||p.ordinal<1||!Number.isSafeInteger(p.activation.epoch)||p.activation.epoch<0
   ||!p.activation.actorUserId||!Number.isFinite(Date.parse(p.activation.recordedAt)))return null;
  if(!['auto','firstInLastOut'].includes(context.resolvedClock.pairing))return null;
  // Epoch zero is a real cutover identity; tracing it must not erase proved raw work.
  // Approval and financial owners retain their separate positive-activation requirements.
  return {authority:'datedPolicyOnly',sourceDate:context.date,employmentId:context.employmentId,companyId:context.companyId,
   revisionId:p.id,ruleId:p.ruleId,ordinal:p.ordinal,effectiveFrom:p.effectiveFrom,
   activation:{epoch:p.activation.epoch,actorUserId:p.activation.actorUserId,recordedAt:p.activation.recordedAt},
   pairing:context.resolvedClock.pairing};
 }catch{return null;}
}
