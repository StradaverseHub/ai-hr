/** Unexposed bounded undo contract; executable registry/custody awaits coordinator allocation. */
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
