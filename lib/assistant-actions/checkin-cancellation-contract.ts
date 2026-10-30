/** Explicit human cancellation of one scheduled native check-in; no notes or generated factual input. */
import {z} from 'zod';
export const CHECKIN_CANCELLATION_ACTION='performance.checkin.cancel' as const;
const uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),base={action:z.literal(CHECKIN_CANCELLATION_ACTION),contractVersion:z.literal(1)};
const Human=z.object({...base,employmentId:uuid,subjectId:uuid,cancel:z.literal(true)}).strict();
const Item=z.object({employmentId:uuid,subjectId:uuid,employeeName:z.string().min(1).max(4000),companyName:z.string().min(1).max(4000),scheduledOn:z.iso.date(),before:z.literal('scheduled'),after:z.literal('cancelled')}).strict();
const Receipt=z.object({kind:z.literal('cancelled'),subjectId:uuid,employmentId:uuid,eventId:uuid}).strict();
const consequence='scheduled_checkin_cancelled_not_completed_or_notes_changed' as const;
export const CheckInCancellation={action:CHECKIN_CANCELLATION_ACTION,Human,Item,Receipt,consequence,indexKind:'performance_checkin_cancellation_review_index',
 Selection:z.object({query:z.string().trim().max(80),subjectId:uuid.optional()}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),items:z.array(z.object({subjectId:uuid,employmentId:uuid,employeeName:z.string().min(1).max(4000),companyName:z.string().min(1).max(4000),scheduledOn:z.iso.date()}).strict()).max(25),truncated:z.boolean()}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
 Confirmation:z.object({...base,actionId:uuid,reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:uuid}).strict(),
 Prepared:z.object({...base,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:Item,consequence:z.literal(consequence)}).strict().refine(v=>v.content.subjectId===v.review.subjectId&&v.content.employmentId===v.review.employmentId),
 Completed:z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:Receipt}).strict(),Retired:z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('performance_checkin_cancellation_review_index'),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
} as const;
export type CheckInCancellationHuman=z.infer<typeof Human>;
