/** Unexposed contract: one legacy offboarding case cancellation; no linked IT/employment effects. */
import {z} from 'zod';
const id=z.guid(),reason=z.string().trim().min(1).max(500),digest=z.string().regex(/^[a-f0-9]{64}$/);
export const OffboardingCaseCancelHuman=z.object({caseId:id,caseNumber:z.string().min(1).max(100),reason,confirmCaseCancellation:z.literal(true)}).strict();
export const OffboardingCaseCancelReview=z.object({caseId:id,caseNumber:z.string().min(1).max(100),companyId:id,resignationDate:z.iso.date(),lastWorkingDay:z.iso.date().nullable(),before:z.object({status:z.literal('in_progress'),cancelReason:z.string().max(500).nullable()}).strict(),after:z.object({status:z.literal('cancelled'),cancelReason:reason}).strict()}).strict();
export const OffboardingCaseCancelPrepared=z.object({content:OffboardingCaseCancelHuman,review:OffboardingCaseCancelReview,reviewedDigest:digest}).strict().superRefine((v,ctx)=>{
 if(v.content.caseId!==v.review.caseId||v.content.caseNumber!==v.review.caseNumber||v.content.reason!==v.review.after.cancelReason)ctx.addIssue({code:'custom',message:'Reviewed cancellation changed.'});
});
export const OffboardingCaseCancelNativeReference=z.object({caseId:id,status:z.literal('cancelled'),eventId:id}).strict();
