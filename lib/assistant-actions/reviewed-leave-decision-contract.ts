/** Human assigned Leave decision only. No posted actor, force flag, target impersonation or model effects. */
import {z} from 'zod';
import {isCalendarDate} from '../calendar-date';
export const REVIEWED_LEAVE_DECISION_ACTION='approvals.leave.decide' as const;
const base={action:z.literal(REVIEWED_LEAVE_DECISION_ACTION),contractVersion:z.literal(1)},id=z.uuid(),digest=z.string().regex(/^[a-f0-9]{64}$/),decision=z.enum(['approved','rejected']),date=z.string().refine(isCalendarDate);
export const ReviewedLeaveDecisionNomination=z.object({...base,leaveRequestId:id,currentStepId:id.nullable()}).strict();
export const ReviewedLeaveDecisionHumanContent=z.object({...base,leaveRequestId:id,currentStepId:id.nullable(),decision,rejectReason:z.string().trim().min(1).max(2000).nullable(),confirmAssignedDecision:z.literal(true)}).strict().refine(v=>v.decision==='rejected'?v.rejectReason!==null:v.rejectReason===null);
export type ReviewedLeaveDecisionHumanContent=z.infer<typeof ReviewedLeaveDecisionHumanContent>;
export const ReviewedLeaveDecisionConfirmation=z.object({...base,reviewedDigest:digest}).strict();
/** Admission bound only: larger native applicant text refuses this unmounted source without truncation. */
export const ReviewedLeaveDecisionReview=z.object({leaveRequestId:id,employmentId:id,leaveTypeId:id,leaveTypeName:z.string(),startDate:date,endDate:date,days:z.string(),durationType:z.string(),hours:z.string().nullable(),fromTime:z.string().nullable(),toTime:z.string().nullable(),applicantReason:z.string().max(16000).nullable(),employeeRemark:z.string().max(16000).nullable(),currentStepId:id.nullable(),stepIndex:z.number().int().nonnegative().nullable(),decision,rejectReason:z.string().nullable(),outcome:z.enum(['rejection_if_confirmed','step_decision_if_confirmed','approval_if_native_checks_pass'])}).strict();
export const ReviewedLeaveDecisionPreparedSource=z.object({kind:z.literal('prepared_source'),content:ReviewedLeaveDecisionHumanContent,review:ReviewedLeaveDecisionReview,reviewedDigest:digest,consequence:z.literal('assigned_decision_request_may_remain_pending')}).strict();
export type ReviewedLeaveDecisionPreparedSource=z.infer<typeof ReviewedLeaveDecisionPreparedSource>;
export const ReviewedLeaveDecisionSourceReceipt=z.object({kind:z.literal('decision_recorded'),leaveRequestId:id,employmentId:id,decisionEventId:id,decisionStepId:id.nullable(),stepIndex:z.number().int().nonnegative().nullable(),decision,currentStatus:z.enum(['pending','approved','rejected','cancelled']),semantics:z.literal('recorded_decision_current_request_status'),replayed:z.boolean()}).strict();
