/** Human-authored own claim DRAFT only. Models may nominate references, never dates, distances,
 * amounts, receipt contents or other employee facts. A digest is not a human click or custody. */
import {z} from 'zod';
export const OWN_CLAIM_DRAFT_ACTION='claims.draft.save' as const;
const UUID=z.string().uuid(),Digest=z.string().regex(/^[a-f0-9]{64}$/);
const Scalar=z.union([z.string().max(4000),z.number().finite(),z.boolean(),z.null()]);
const Answers=z.record(z.string().min(1).max(200),Scalar).refine(value=>Object.keys(value).length<=128).nullable();
export const OwnClaimDraftNomination=z.object({action:z.literal(OWN_CLAIM_DRAFT_ACTION),contractVersion:z.literal(1),employmentId:UUID,draftId:UUID.nullable(),claimTypeId:UUID,claimItemId:UUID.nullable()}).strict();
export type OwnClaimDraftNomination=z.infer<typeof OwnClaimDraftNomination>;
/** These are actual human entries, not provider output. Native draft validation intentionally permits
 * incomplete answers and over-budget drafts; canonical submit owns the separate complete checks. */
export const OwnClaimDraftHumanContent=z.object({action:z.literal(OWN_CLAIM_DRAFT_ACTION),contractVersion:z.literal(1),employmentId:UUID,draftId:UUID.nullable(),expectedDraftRevision:z.string().regex(/^[0-9]+$/).nullable().optional(),claimTypeId:UUID,claimItemId:UUID.nullable(),enteredAmount:z.number().finite(),quantityKm:z.number().finite().nullable(),incurredOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),description:z.string().max(4000).nullable(),fieldValues:Answers,retainedAttachmentIds:z.array(UUID).max(25)}).strict().superRefine((value,ctx)=>{if(value.draftId===null&&value.expectedDraftRevision!=null)ctx.addIssue({code:z.ZodIssueCode.custom,message:'The draft revision is unavailable.'});if(new Set(value.retainedAttachmentIds).size!==value.retainedAttachmentIds.length||value.draftId===null&&value.retainedAttachmentIds.length)ctx.addIssue({code:z.ZodIssueCode.custom,message:'The draft receipt references are unavailable.'});if(new TextEncoder().encode(JSON.stringify(value)).byteLength>128000)ctx.addIssue({code:z.ZodIssueCode.custom,message:'The draft content is too large.'});});
export type OwnClaimDraftHumanContent=z.infer<typeof OwnClaimDraftHumanContent>;
export const OwnClaimDraftConfirmation=z.object({action:z.literal(OWN_CLAIM_DRAFT_ACTION),contractVersion:z.literal(1),reviewedDigest:Digest}).strict();
export type OwnClaimDraftConfirmation=z.infer<typeof OwnClaimDraftConfirmation>;
export const OwnClaimDraftPreparedSource=z.object({kind:z.literal('prepared_source'),content:OwnClaimDraftHumanContent,reviewedDigest:Digest,provisionalAmount:z.string().regex(/^\d+\.\d{2}$/),provisionalQuantityKm:z.string().regex(/^-?\d+\.\d{2}$/).nullable(),provisionalTaxable:z.boolean(),consequence:z.literal('draft_only_no_submission_or_reimbursement')}).strict();
export type OwnClaimDraftPreparedSource=z.infer<typeof OwnClaimDraftPreparedSource>;
export const OwnClaimDraftSourceReceipt=z.object({kind:z.literal('draft_saved'),draftId:UUID,savedEventId:UUID,employmentId:UUID,currentStatus:z.enum(['draft','pending','approved','rejected','cancelled','paid']),replayed:z.boolean()}).strict();
export type OwnClaimDraftSourceReceipt=z.infer<typeof OwnClaimDraftSourceReceipt>;
