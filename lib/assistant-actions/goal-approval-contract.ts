/** Explicit human approval of exactly one proposed native goal; no model-authored goal facts. */
import {z} from 'zod';
export const GOAL_APPROVAL_ACTION='performance.goal.approve' as const;
const uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),base={action:z.literal(GOAL_APPROVAL_ACTION),contractVersion:z.literal(1)};
const Human=z.object({...base,employmentId:uuid,subjectId:uuid,approve:z.literal(true)}).strict();
const Item=z.object({employmentId:uuid,subjectId:uuid,title:z.string().max(4000),description:z.string().max(12000).nullable(),metric:z.string().max(4000).nullable(),target:z.string().max(4000).nullable(),weight:z.string().max(40).nullable(),dueOn:z.string().nullable(),before:z.literal('proposed'),after:z.literal('approved')}).strict();
const Receipt=z.object({kind:z.literal('approved'),subjectId:uuid,employmentId:uuid,eventId:uuid}).strict();
const consequence='goal_approved_not_review_locked_or_rating_or_pay_decided' as const;
export const GoalApproval={action:GOAL_APPROVAL_ACTION,Human,Item,Receipt,consequence,indexKind:'performance_goal_approval_review_index',
 Selection:z.object({query:z.string().trim().max(80),subjectId:uuid.optional()}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),items:z.array(z.object({subjectId:uuid,employmentId:uuid,title:z.string().max(4000)}).strict()).max(25),truncated:z.boolean()}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
 Confirmation:z.object({...base,actionId:uuid,reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:uuid}).strict(),
 Prepared:z.object({...base,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:Item,consequence:z.literal(consequence)}).strict().refine(v=>v.content.subjectId===v.review.subjectId&&v.content.employmentId===v.review.employmentId),
 Completed:z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:Receipt}).strict(),Retired:z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('performance_goal_approval_review_index'),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
} as const;
export type GoalApprovalHuman=z.infer<typeof Human>;
