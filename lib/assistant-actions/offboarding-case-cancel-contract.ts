/** One legacy offboarding case cancellation; linked IT work and employment remain unchanged. */
import {z} from 'zod';
const id=z.guid(),reason=z.string().trim().min(1).max(500),digest=z.string().regex(/^[a-f0-9]{64}$/);
export const OffboardingCaseCancelHuman=z.object({caseId:id,caseNumber:z.string().min(1).max(100),reason,confirmCaseCancellation:z.literal(true)}).strict();
export const OffboardingCaseCancelReview=z.object({caseId:id,caseNumber:z.string().min(1).max(100),companyId:id,resignationDate:z.iso.date(),lastWorkingDay:z.iso.date().nullable(),before:z.object({status:z.literal('in_progress'),cancelReason:z.string().max(500).nullable()}).strict(),after:z.object({status:z.literal('cancelled'),cancelReason:reason}).strict()}).strict();
export const OffboardingCaseCancelPrepared=z.object({content:OffboardingCaseCancelHuman,review:OffboardingCaseCancelReview,reviewedDigest:digest}).strict().superRefine((v,ctx)=>{
 if(v.content.caseId!==v.review.caseId||v.content.caseNumber!==v.review.caseNumber||v.content.reason!==v.review.after.cancelReason)ctx.addIssue({code:'custom',message:'Reviewed cancellation changed.'});
});
export const OffboardingCaseCancelNativeReference=z.object({caseId:id,status:z.literal('cancelled'),eventId:id}).strict();

/** Dedicated closed human-review wire shapes; private SQL proofs never enter these packets. */
export const OFFBOARDING_CASE_CANCEL_ACTION='lifecycle.offboarding.case.cancel' as const;
const wireBase={action:z.literal(OFFBOARDING_CASE_CANCEL_ACTION),contractVersion:z.literal(1)};
const WirePrepared=z.object({...wireBase,actionId:id,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:OffboardingCaseCancelHuman,review:OffboardingCaseCancelReview}).strict().superRefine((v,ctx)=>{
 if(!OffboardingCaseCancelPrepared.safeParse({content:v.content,review:v.review,reviewedDigest:v.reviewedDigest}).success||Date.parse(v.expiresAt)<=Date.parse(v.createdAt))ctx.addIssue({code:'custom',message:'Reviewed cancellation unavailable.'});
});
export const OffboardingCaseCancel={action:OFFBOARDING_CASE_CANCEL_ACTION,Human:OffboardingCaseCancelHuman,
 Confirmation:z.object({...wireBase,actionId:id,reviewedDigest:digest}).strict(),Retirement:z.object({...wireBase,actionId:id}).strict(),Prepared:WirePrepared,
 Completed:z.object({...wireBase,actionId:id,state:z.literal('completed'),receipt:OffboardingCaseCancelNativeReference}).strict(),
 Retired:z.object({...wireBase,actionId:id,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('offboarding_case_cancel_review_index'),reviews:z.array(z.object({...wireBase,actionId:id,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
 Selection:z.object({caseNumber:z.string().trim().min(1).max(100)}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),cases:z.array(z.object({caseId:id,caseNumber:z.string().min(1).max(100)}).strict()).length(1),truncated:z.literal(false)}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
};
