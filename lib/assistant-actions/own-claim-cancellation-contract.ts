/** ADR-0151 wave 1: cancel one's own pending claim. The person names the claim; the native service owns
 * whether it may still be cancelled. No amount is computed, refunded or paid by this action. */
import {z} from 'zod';
export const OWN_CLAIM_CANCELLATION_ACTION='claims.cancel' as const;
const base={action:z.literal(OWN_CLAIM_CANCELLATION_ACTION),contractVersion:z.literal(1)},uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const OwnClaimCancellationHumanContent=z.object({...base,employmentId:uuid,claimId:uuid,cancel:z.literal(true)}).strict();
export type OwnClaimCancellationHumanContent=z.infer<typeof OwnClaimCancellationHumanContent>;
/** Stored values shown back to the person so they can recognise the claim. Displayed, never recomputed. */
export const OwnClaimCancellationReview=z.object({employmentId:uuid,claimId:uuid,claimTypeName:z.string().min(1).max(200),incurredOn:date,amount:z.string().regex(/^\d+\.\d{2}$/),status:z.literal('pending')}).strict();
export type OwnClaimCancellationReview=z.infer<typeof OwnClaimCancellationReview>;
export const OwnClaimCancellationPreparedSource=z.object({kind:z.literal('prepared_source'),content:OwnClaimCancellationHumanContent,review:OwnClaimCancellationReview,reviewedDigest:digest,consequence:z.literal('pending_claim_cancelled_no_payment')}).strict();
export type OwnClaimCancellationPreparedSource=z.infer<typeof OwnClaimCancellationPreparedSource>;
export const OwnClaimCancellationSourceReceipt=z.object({kind:z.literal('cancelled'),claimId:uuid,cancelledEventId:uuid,employmentId:uuid,currentStatus:z.enum(['pending','approved','rejected','cancelled','paid'])}).strict();
export type OwnClaimCancellationSourceReceipt=z.infer<typeof OwnClaimCancellationSourceReceipt>;
export const OwnClaimCancellationChoices=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('choices'),claims:z.array(z.object({employmentId:uuid,claimId:uuid,claimTypeName:z.string().min(1).max(200),incurredOn:date,amount:z.string().regex(/^\d+\.\d{2}$/)}).strict()).max(25),truncated:z.boolean()}).strict(),
 z.object({kind:z.literal('unavailable')}).strict(),
]);
export type OwnClaimCancellationChoices=z.infer<typeof OwnClaimCancellationChoices>;

// Review custody contract (the shared store's prepared/completed/retired shapes for this kind).
export const ClaimCancellationReviewPrepare=OwnClaimCancellationHumanContent;
export const ClaimCancellationReviewConfirmation=z.object({...base,actionId:uuid,reviewedDigest:digest}).strict();
export const ClaimCancellationReviewRetirement=z.object({...base,actionId:uuid}).strict();
export const ClaimCancellationPreparedReview=z.object({...base,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:OwnClaimCancellationHumanContent,review:OwnClaimCancellationReview,consequence:z.literal('pending_claim_cancelled_no_payment')}).strict();
export const ClaimCancellationCompletedReview=z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:OwnClaimCancellationSourceReceipt}).strict();
export const ClaimCancellationRetiredReview=z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict();
export const ClaimCancellationReviewIndex=z.object({kind:z.literal('claim_cancellation_review_index'),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(row=>row.actionId)).size===rows.length)}).strict();
