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
