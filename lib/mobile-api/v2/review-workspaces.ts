/** Employment reviews preserve their advisory semantics and distinct manager/HR forms. */
import { z } from 'zod';
import { commandOf } from './common';
import { TaskDecisionRefusal } from './tasks';
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const d=new Date(s+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===s;});
export const ReviewWorkspaceKind=z.enum(['managerReview','hrReview']);
export type ReviewWorkspaceKind=z.infer<typeof ReviewWorkspaceKind>;
export const isReviewWorkspaceKind=(s:string):s is ReviewWorkspaceKind=>ReviewWorkspaceKind.safeParse(s).success;
export const ReviewWorkspace=z.object({kind:ReviewWorkspaceKind,id:z.string().uuid(),subject:z.object({name:z.string().max(300),code:z.string().max(64).nullable()}),reviewType:z.enum(['probation','contract','internship']),endDate:date,dueDate:date,managerRecommendation:z.string().max(100).nullable(),managerComments:z.string().max(10000).nullable(),expected:z.object({status:z.enum(['pending_manager','pending_hr'])})});
export type ReviewWorkspace=z.infer<typeof ReviewWorkspace>;
export const ReviewWorkspaceResult=z.union([z.object({outcome:z.literal('found'),workspace:ReviewWorkspace}),TaskDecisionRefusal]);
const common={expected:z.object({status:z.enum(['pending_manager','pending_hr'])}).strict(),comments:z.string().trim().max(4000).optional()};
export const REVIEW_TERMINATION_REASONS=['contract_end','involuntary','voluntary','retired','death','other'] as const;
export const ReviewWorkspaceCommand=commandOf({ ...common, terminationReason:z.enum(REVIEW_TERMINATION_REASONS).optional(), action:z.enum(['recommend_confirm','recommend_extend','recommend_terminate','confirm','extend','terminate']),extendToDate:date.optional() }).superRefine((v,c)=>{if(v.action==='terminate'&&!v.terminationReason)c.addIssue({code:'custom',message:'Termination reason required'});if(v.action!=='terminate'&&v.terminationReason)c.addIssue({code:'custom',message:'Reason only applies to termination'});if(v.action==='extend'&&!v.extendToDate)c.addIssue({code:'custom',message:'Extension date required'});if(v.action!=='extend'&&v.extendToDate)c.addIssue({code:'custom',message:'Date only applies to extension'});});
export type ReviewWorkspaceCommand=z.infer<typeof ReviewWorkspaceCommand>;
export const ReviewWorkspaceDecisionResult=z.union([z.object({outcome:z.literal('accepted'),status:z.enum(['pending_hr','completed'])}),TaskDecisionRefusal]);
