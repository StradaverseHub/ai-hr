/** ADR-0151 wave 1b: request overtime for one of the caller's OWN employments — the same native request
 * the Plan Overtime form submits (an overtime-only attendance request, no clock times). The native
 * attendance service owns validation, the minutes, routing and the approval chain; it is a request,
 * never an approval. Reason and remark are the person's own words; the model never fills them in. */
import {z} from 'zod';
export const OWN_OVERTIME_REQUEST_ACTION='attendance.overtime.request' as const;
const uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),date=z.iso.date(),time=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const text=z.string().max(4000);
const base={action:z.literal(OWN_OVERTIME_REQUEST_ACTION),contractVersion:z.literal(1)};
export const OwnOvertimeEmployment=z.object({employmentId:uuid,employeeCode:z.string().max(100).nullable(),companyName:z.string().min(1).max(240)}).strict();
export const OwnOvertimeChoices=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('choices'),employments:z.array(OwnOvertimeEmployment).max(16)}).strict(),
 z.object({kind:z.literal('unavailable')}).strict(),
]);
export type OwnOvertimeChoices=z.infer<typeof OwnOvertimeChoices>;
export const OwnOvertimeHumanContent=z.object({...base,employmentId:uuid,date,plannedStartTime:time,plannedEndTime:time,reason:text,remark:text.optional()}).strict()
 .refine(value=>value.plannedStartTime!==value.plannedEndTime&&value.reason.trim().length>0);
export type OwnOvertimeHumanContent=z.infer<typeof OwnOvertimeHumanContent>;
/** What the native preparation will submit: the engine's own minute count for the planned window. */
export const OwnOvertimeReview=z.object({employmentId:uuid,date,plannedStartTime:time,plannedEndTime:time,requestedOtMinutes:z.number().int().positive(),reason:text,remark:text.nullable()}).strict();
export const OwnOvertimeSourceReceipt=z.object({kind:z.literal('requested'),correctionId:uuid,eventId:uuid,employmentId:uuid,date,requestedOtMinutes:z.number().int().positive(),
 currentStatus:z.enum(['pending','approved','rejected']),cancelled:z.boolean()}).strict();
export const OvertimeRequestReviewConfirmation=z.object({...base,actionId:uuid,reviewedDigest:digest}).strict();
export const OvertimeRequestReviewRetirement=z.object({...base,actionId:uuid}).strict();
export const OvertimeRequestPreparedReview=z.object({...base,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:OwnOvertimeHumanContent,review:OwnOvertimeReview,consequence:z.literal('overtime_requested_not_approved')}).strict();
export const OvertimeRequestCompletedReview=z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:OwnOvertimeSourceReceipt}).strict();
export const OvertimeRequestRetiredReview=z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict();
export const OvertimeRequestReviewIndex=z.object({kind:z.literal('overtime_request_review_index'),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict();
