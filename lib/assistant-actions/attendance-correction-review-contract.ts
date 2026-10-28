/** Human own correction submission only; native clock/OT approval and other-HR rules still apply. */
import {z} from 'zod';
import {OwnAttendanceCorrectionIntent,OwnAttendanceCorrectionReview,OwnAttendanceCorrectionReceipt} from './own-attendance-correction-contract';
export const ATTENDANCE_CORRECTION_REVIEW_ACTION='attendance.correction.request' as const;
const base={action:z.literal(ATTENDANCE_CORRECTION_REVIEW_ACTION),contractVersion:z.literal(1)},digest=z.string().regex(/^[a-f0-9]{64}$/);
export const AttendanceCorrectionReviewPrepare=z.object({...base,intent:OwnAttendanceCorrectionIntent}).strict();
export const AttendanceCorrectionReviewConfirmation=z.object({...base,actionId:z.guid(),reviewedDigest:digest}).strict();
export const AttendanceCorrectionReviewRetirement=z.object({...base,actionId:z.guid()}).strict();
export const AttendanceCorrectionPreparedReview=z.object({...base,actionId:z.guid(),reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),review:OwnAttendanceCorrectionReview.omit({reviewDigest:true})}).strict();
export const AttendanceCorrectionCompletedReview=z.object({...base,actionId:z.guid(),state:z.literal('completed'),receipt:OwnAttendanceCorrectionReceipt}).strict();
export const AttendanceCorrectionRetiredReview=z.object({...base,actionId:z.guid(),state:z.enum(['discarded','expired','refused'])}).strict();
export const AttendanceCorrectionReviewIndex=z.object({kind:z.literal('attendance_correction_review_index'),reviews:z.array(z.object({...base,actionId:z.guid(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(r=>r.actionId)).size===rows.length)}).strict();
