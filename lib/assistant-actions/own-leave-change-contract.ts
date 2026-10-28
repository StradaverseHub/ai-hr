/** ADR-0151 wave 1: change one's own PENDING plain leave request — cancel it, or edit its dates, reason and
 * remark on the same leave type (full days only). The native leave service owns every rule, the day count
 * and the approval chain; anything outside this envelope belongs to the Leave form. */
import {z} from 'zod';
export const OWN_LEAVE_CANCELLATION_ACTION='leave.cancel' as const;
export const OWN_LEAVE_EDIT_ACTION='leave.edit' as const;
const uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/),days=z.number().finite().positive();
const text=z.string().max(4000);
/** One own pending plain leave request as the person sees it on the choices list and the review card. */
export const OwnPendingLeave=z.object({employmentId:uuid,leaveRequestId:uuid,leaveTypeName:z.string().min(1).max(200),startDate:date,endDate:date,days,reason:text.nullable(),employeeRemark:text.nullable()}).strict();
export type OwnPendingLeave=z.infer<typeof OwnPendingLeave>;
export const OwnLeaveChangeChoices=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('choices'),requests:z.array(OwnPendingLeave).max(25),truncated:z.boolean()}).strict(),
 z.object({kind:z.literal('unavailable')}).strict(),
]);
export type OwnLeaveChangeChoices=z.infer<typeof OwnLeaveChangeChoices>;

// Cancel
const cancelBase={action:z.literal(OWN_LEAVE_CANCELLATION_ACTION),contractVersion:z.literal(1)};
export const OwnLeaveCancellationHumanContent=z.object({...cancelBase,employmentId:uuid,leaveRequestId:uuid,cancel:z.literal(true)}).strict();
export type OwnLeaveCancellationHumanContent=z.infer<typeof OwnLeaveCancellationHumanContent>;
export const OwnLeaveCancellationReview=OwnPendingLeave;
export const OwnLeaveCancellationSourceReceipt=z.object({kind:z.literal('cancelled'),leaveRequestId:uuid,eventId:uuid,employmentId:uuid,currentStatus:z.enum(['pending','approved','rejected','cancelled'])}).strict();
export const LeaveCancellationReviewConfirmation=z.object({...cancelBase,actionId:uuid,reviewedDigest:digest}).strict();
export const LeaveCancellationReviewRetirement=z.object({...cancelBase,actionId:uuid}).strict();
export const LeaveCancellationPreparedReview=z.object({...cancelBase,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:OwnLeaveCancellationHumanContent,review:OwnLeaveCancellationReview,consequence:z.literal('pending_leave_withdrawn')}).strict();
export const LeaveCancellationCompletedReview=z.object({...cancelBase,actionId:uuid,state:z.literal('completed'),receipt:OwnLeaveCancellationSourceReceipt}).strict();
export const LeaveCancellationRetiredReview=z.object({...cancelBase,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict();
export const LeaveCancellationReviewIndex=z.object({kind:z.literal('leave_cancellation_review_index'),reviews:z.array(z.object({...cancelBase,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict();

// Edit
const editBase={action:z.literal(OWN_LEAVE_EDIT_ACTION),contractVersion:z.literal(1)};
/** The person's own new values. Reason and remark are their words; the model never fills them in. */
export const OwnLeaveEditHumanContent=z.object({...editBase,employmentId:uuid,leaveRequestId:uuid,startDate:date,endDate:date,reason:text.optional(),employeeRemark:text.optional()}).strict().refine(value=>value.startDate<=value.endDate);
export type OwnLeaveEditHumanContent=z.infer<typeof OwnLeaveEditHumanContent>;
/** Before and after as the engine computes them; the day count is the leave engine's, never a guess. */
export const OwnLeaveEditReview=z.object({before:OwnPendingLeave,after:z.object({startDate:date,endDate:date,days,reason:text.nullable(),employeeRemark:text.nullable()}).strict()}).strict();
export const OwnLeaveEditSourceReceipt=z.object({kind:z.literal('edited'),leaveRequestId:uuid,eventId:uuid,employmentId:uuid,days,currentStatus:z.enum(['pending','approved','rejected','cancelled'])}).strict();
export const LeaveEditReviewConfirmation=z.object({...editBase,actionId:uuid,reviewedDigest:digest}).strict();
export const LeaveEditReviewRetirement=z.object({...editBase,actionId:uuid}).strict();
export const LeaveEditPreparedReview=z.object({...editBase,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:OwnLeaveEditHumanContent,review:OwnLeaveEditReview,consequence:z.literal('pending_leave_edited_still_pending')}).strict();
export const LeaveEditCompletedReview=z.object({...editBase,actionId:uuid,state:z.literal('completed'),receipt:OwnLeaveEditSourceReceipt}).strict();
export const LeaveEditRetiredReview=z.object({...editBase,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict();
export const LeaveEditReviewIndex=z.object({kind:z.literal('leave_edit_review_index'),reviews:z.array(z.object({...editBase,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict();
