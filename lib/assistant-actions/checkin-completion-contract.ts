/** Explicit completion with preservation or handwritten notes. Notes are private human review data, never audit/provider facts. */
import {z} from 'zod';
export const CHECKIN_COMPLETION_ACTION='performance.checkin.complete' as const;
const uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),base={action:z.literal(CHECKIN_COMPLETION_ACTION),contractVersion:z.literal(1)};
const Human=z.object({...base,employmentId:uuid,subjectId:uuid,complete:z.literal(true),notesMode:z.enum(['preserve','replace']),notes:z.string().max(8000).optional()}).strict().refine(v=>v.notesMode==='preserve'?v.notes===undefined:typeof v.notes==='string'&&v.notes.trim().length>0);
const Item=z.object({employmentId:uuid,subjectId:uuid,employeeName:z.string().min(1).max(4000),companyName:z.string().min(1).max(4000),scheduledOn:z.iso.date(),before:z.literal('scheduled'),after:z.literal('completed'),beforeNotes:z.string().max(8000).nullable(),afterNotes:z.string().max(8000).nullable(),notesMode:z.enum(['preserve','replace'])}).strict();
const Receipt=z.object({kind:z.literal('completed'),completedAt:z.iso.datetime(),subjectId:uuid,employmentId:uuid,eventId:uuid}).strict();
const consequence='scheduled_checkin_completed_with_human_notes_choice' as const;
export const CheckInCompletion={action:CHECKIN_COMPLETION_ACTION,Human,Item,Receipt,consequence,indexKind:'performance_checkin_completion_review_index',
 Selection:z.object({query:z.string().trim().max(80),subjectId:uuid.optional()}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),items:z.array(z.object({subjectId:uuid,employmentId:uuid,employeeName:z.string().min(1).max(4000),companyName:z.string().min(1).max(4000),scheduledOn:z.iso.date()}).strict()).max(25),truncated:z.boolean()}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
 Confirmation:z.object({...base,actionId:uuid,reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:uuid}).strict(),
 Prepared:z.object({...base,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:Item,consequence:z.literal(consequence)}).strict().refine(v=>v.content.subjectId===v.review.subjectId&&v.content.employmentId===v.review.employmentId),
 Completed:z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:Receipt}).strict(),Retired:z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('performance_checkin_completion_review_index'),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
} as const;
export type CheckInCompletionHuman=z.infer<typeof Human>;
