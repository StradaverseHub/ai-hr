/** Human acknowledgement only. No rating, comment, decision or generated factual value is accepted. */
import {z} from 'zod';
export const OwnReviewAcknowledgementIntent=z.object({version:z.literal(1),reviewId:z.uuid(),acknowledge:z.literal(true)}).strict();
export type OwnReviewAcknowledgementIntent=z.infer<typeof OwnReviewAcknowledgementIntent>;
export const OwnReviewAcknowledgementReview=z.object({version:z.literal(1),action:z.literal('performance.review.acknowledge'),engine:z.literal('standard_cycle_only'),
 reviewId:z.uuid(),employmentId:z.uuid(),cycleId:z.uuid(),cycleName:z.string(),periodStart:z.string(),periodEnd:z.string(),
 meaning:z.literal('acknowledgement_not_rating_endorsement'),reviewDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type OwnReviewAcknowledgementReview=z.infer<typeof OwnReviewAcknowledgementReview>;
export const OwnReviewAcknowledgementReceipt=z.object({version:z.literal(1),action:z.literal('performance.review.acknowledge'),engine:z.literal('standard_cycle_only'),
 proof:z.literal('recorded_acknowledgement_current_record'),reviewId:z.uuid(),employmentId:z.uuid(),cycleId:z.uuid(),eventId:z.uuid(),acknowledgedAt:z.string().datetime(),
 meaning:z.literal('acknowledged_not_rating_endorsement')}).strict();
export type OwnReviewAcknowledgementReceipt=z.infer<typeof OwnReviewAcknowledgementReceipt>;
