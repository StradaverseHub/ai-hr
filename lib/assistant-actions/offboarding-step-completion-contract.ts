/** Bounded legacy offboarding command contract. Not registered/executable until coordinator allocation
 * and case-subject custody approval. No V9 task, delegate, outcome, employment termination or date write.
 */
import {z} from 'zod';
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const caseStatus=z.enum(['in_progress','completed']);
export const OffboardingStepCompletionHuman=z.object({
 caseId:z.guid(),caseNumber:z.string().min(1).max(100),stepKey:z.string().min(1).max(100),
 reference:z.string().max(100).nullable(),notes:z.string().max(2000).nullable(),
 confirmStepCompletion:z.literal(true),acceptDerivedCaseCompletion:z.boolean(),
}).strict().refine(value=>value.stepKey!=='resign_outcome',{message:'Record the outcome through the native outcome control.'});
export const OffboardingStepCompletionReview=z.object({
 caseId:z.guid(),caseNumber:z.string().min(1).max(100),companyId:z.guid(),
 stepKey:z.string().min(1).max(100),stepLabel:z.string().min(1).max(300),
 resignationDate:z.iso.date(),lastWorkingDay:z.iso.date().nullable(),
 before:z.object({done:z.literal(false),caseStatus}).strict(),
 after:z.object({done:z.literal(true),caseStatus}).strict(),
 reference:z.string().max(100).nullable(),notes:z.string().max(2000).nullable(),
}).strict();
export const OffboardingStepCompletionPreparedSource=z.object({
 content:OffboardingStepCompletionHuman,review:OffboardingStepCompletionReview,reviewedDigest:digest,
}).strict().superRefine((value,ctx)=>{
 for(const key of ['caseId','caseNumber','stepKey','reference','notes'] as const){
  if(value.content[key]!==value.review[key])ctx.addIssue({code:'custom',message:'Reviewed source changed.'});
 }
 if(value.review.after.caseStatus==='completed'&&!value.content.acceptDerivedCaseCompletion)
  ctx.addIssue({code:'custom',message:'Confirm the derived case completion.'});
});
export const OffboardingStepCompletionNativeReference=z.object({
 caseId:z.guid(),stepKey:z.string().min(1).max(100),status:caseStatus,
 stepEventId:z.guid(),completionEventId:z.guid().nullable(),
}).strict().superRefine((value,ctx)=>{
 if(value.stepKey==='resign_outcome'||value.stepEventId===value.completionEventId||
    (value.status==='completed')!==(value.completionEventId!==null))
  ctx.addIssue({code:'custom',message:'Native completion references unavailable.'});
});
export const OffboardingStepCompletionConfirmation=z.object({reviewedDigest:digest}).strict();
export const OFFBOARDING_STEP_ACTION='lifecycle.offboarding.step.complete' as const;
const base={action:z.literal(OFFBOARDING_STEP_ACTION),contractVersion:z.literal(1)};
export const OffboardingStepCompletion={action:OFFBOARDING_STEP_ACTION,Human:OffboardingStepCompletionHuman,
 Confirmation:z.object({...base,actionId:z.guid(),reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:z.guid()}).strict(),
 Prepared:z.object({...base,actionId:z.guid(),reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:OffboardingStepCompletionHuman,review:OffboardingStepCompletionReview}).strict(),
 Completed:z.object({...base,actionId:z.guid(),state:z.literal('completed'),receipt:OffboardingStepCompletionNativeReference}).strict(),
 Retired:z.object({...base,actionId:z.guid(),state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('offboarding_step_review_index'),reviews:z.array(z.object({...base,actionId:z.guid(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
 Selection:z.object({caseNumber:z.string().trim().min(1).max(100)}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),cases:z.array(z.object({caseId:z.guid(),caseNumber:z.string(),steps:z.array(z.object({key:z.string(),label:z.string()}).strict()).max(100)}).strict()).max(1),truncated:z.literal(false)}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
};
