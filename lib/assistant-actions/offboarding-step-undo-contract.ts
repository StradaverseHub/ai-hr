/** One human-reviewed active/applicable legacy offboarding undo intent. */
import {z} from 'zod';
const id=z.guid(),text=z.string().max(2000).nullable();
export const OffboardingStepUndoHuman=z.object({caseId:id,caseNumber:z.string().min(1).max(100),stepKey:z.string().min(1).max(100),reason:z.string().max(500).nullable(),confirmUndo:z.literal(true),acceptCaseReopening:z.boolean()}).strict().refine(v=>v.stepKey!=='resign_outcome');
export const OffboardingStepUndoReview=z.object({caseId:id,caseNumber:z.string().min(1).max(100),companyId:id,stepKey:z.string().min(1).max(100),stepLabel:z.string().min(1).max(300),resignationDate:z.iso.date(),lastWorkingDay:z.iso.date().nullable(),
 before:z.object({done:z.literal(true),caseStatus:z.enum(['in_progress','completed']),reference:z.string().max(100).nullable(),notes:text}).strict(),
 after:z.object({done:z.literal(false),caseStatus:z.literal('in_progress'),reference:z.string().max(100).nullable(),notes:text}).strict(),reopensCase:z.boolean(),reason:z.string().max(500).nullable(),
}).strict().refine(v=>v.reopensCase===(v.before.caseStatus==='completed')&&v.before.reference===v.after.reference&&v.before.notes===v.after.notes);
export const OffboardingStepUndoPrepared=z.object({content:OffboardingStepUndoHuman,review:OffboardingStepUndoReview,reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().superRefine((v,ctx)=>{
 for(const key of ['caseId','caseNumber','stepKey','reason'] as const)if(v.content[key]!==v.review[key])ctx.addIssue({code:'custom',message:'Reviewed source changed.'});
 if(v.review.reopensCase&&!v.content.acceptCaseReopening)ctx.addIssue({code:'custom',message:'Confirm case reopening.'});
});

export const OFFBOARDING_STEP_UNDO_ACTION='lifecycle.offboarding.step.undo' as const;
export const OffboardingStepUndoNativeReference=z.object({caseId:id,stepKey:z.string().min(1).max(100),status:z.literal('in_progress'),stepEventId:id,reopeningEventId:id.nullable()}).strict().refine(v=>v.stepKey!=='resign_outcome'&&v.stepEventId!==v.reopeningEventId);
const base={action:z.literal(OFFBOARDING_STEP_UNDO_ACTION),contractVersion:z.literal(1)},digest=z.string().regex(/^[a-f0-9]{64}$/);
export const OffboardingStepUndo={action:OFFBOARDING_STEP_UNDO_ACTION,Human:OffboardingStepUndoHuman,
 Confirmation:z.object({...base,actionId:id,reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:id}).strict(),
 Prepared:z.object({...base,actionId:id,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:OffboardingStepUndoHuman,review:OffboardingStepUndoReview}).strict(),
 Completed:z.object({...base,actionId:id,state:z.literal('completed'),receipt:OffboardingStepUndoNativeReference}).strict(),
 Retired:z.object({...base,actionId:id,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('offboarding_step_undo_review_index'),reviews:z.array(z.object({...base,actionId:id,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
 Selection:z.object({caseNumber:z.string().trim().min(1).max(100)}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),cases:z.array(z.object({caseId:id,caseNumber:z.string(),steps:z.array(z.object({key:z.string(),label:z.string()}).strict()).max(100)}).strict()).max(1),truncated:z.literal(false)}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
};
