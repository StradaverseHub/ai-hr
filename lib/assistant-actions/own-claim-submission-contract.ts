/** Existing human-authored draft submission only. Direct-new/upload and monetary entry stay with
 * their native UI owners; no model amount, hasReceipt assertion, receipt bytes or approval input. */
import {z} from 'zod';
export const OWN_CLAIM_SUBMISSION_ACTION='claims.submit' as const;
const base={action:z.literal(OWN_CLAIM_SUBMISSION_ACTION),contractVersion:z.literal(1)},uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),scalar=z.union([z.string().max(4000),z.number().finite(),z.boolean(),z.null()]);
export const OwnClaimSubmissionNomination=z.object({...base,employmentId:uuid,draftId:uuid}).strict();
export const OwnClaimSubmissionHumanContent=z.object({...base,employmentId:uuid,draftId:uuid,receiptIds:z.array(uuid).max(25).refine(ids=>new Set(ids).size===ids.length),submitForApproval:z.literal(true)}).strict();
export type OwnClaimSubmissionHumanContent=z.infer<typeof OwnClaimSubmissionHumanContent>;
export const OwnClaimSubmissionConfirmation=z.object({...base,reviewedDigest:digest}).strict();
export const OwnClaimSubmissionReview=z.object({employmentId:uuid,draftId:uuid,claimTypeId:uuid,claimItemId:uuid.nullable(),amount:z.string().regex(/^\d+\.\d{2}$/),quantityKm:z.string().regex(/^-?\d+\.\d{2}$/).nullable(),taxable:z.boolean(),incurredOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),description:z.string().max(4000).nullable(),fieldValues:z.record(z.string(),scalar).nullable(),receipts:z.array(z.object({id:uuid,fileName:z.string().max(1000),mimeType:z.string().max(100),sizeBytes:z.number().int().nonnegative()}).strict()).max(25)}).strict();
export const OwnClaimSubmissionPreparedSource=z.object({kind:z.literal('prepared_source'),content:OwnClaimSubmissionHumanContent,review:OwnClaimSubmissionReview,reviewedDigest:digest,consequence:z.literal('submitted_for_approval_not_approved_or_reimbursed')}).strict();
export type OwnClaimSubmissionPreparedSource=z.infer<typeof OwnClaimSubmissionPreparedSource>;
export const OwnClaimSubmissionSourceReceipt=z.object({kind:z.literal('submitted'),claimId:uuid,submittedEventId:uuid,employmentId:uuid,currentStatus:z.enum(['pending','approved','rejected','cancelled','paid']),replayed:z.boolean()}).strict();
export type OwnClaimSubmissionSourceReceipt=z.infer<typeof OwnClaimSubmissionSourceReceipt>;
