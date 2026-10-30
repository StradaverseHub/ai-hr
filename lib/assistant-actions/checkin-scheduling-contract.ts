/** Actual mounted scheduling intent: employee and date, with native-derived manager and no notes. */
import {z} from 'zod';
export const CHECKIN_SCHEDULING_ACTION='performance.checkin.schedule' as const;
const uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),base={action:z.literal(CHECKIN_SCHEDULING_ACTION),contractVersion:z.literal(1)};
const Human=z.object({...base,employmentId:uuid,scheduledOn:z.iso.date(),confirmSchedule:z.literal(true)}).strict();
const Item=z.object({employmentId:uuid,employeeName:z.string().min(1).max(4000),companyName:z.string().min(1).max(4000),scheduledOn:z.iso.date(),before:z.literal('not_created'),after:z.literal('scheduled')}).strict();
const Receipt=z.object({kind:z.literal('scheduled'),employmentId:uuid,checkinId:uuid,eventId:uuid,scheduledOn:z.iso.date()}).strict();
const consequence='new_scheduled_checkin_created_for_selected_employee_and_date' as const;
export const CheckInScheduling={action:CHECKIN_SCHEDULING_ACTION,Human,Item,Receipt,consequence,indexKind:'performance_checkin_scheduling_review_index',
 Selection:z.object({query:z.string().trim().max(80),employmentId:uuid.optional()}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),items:z.array(z.object({employmentId:uuid,employeeName:z.string().min(1).max(4000),companyName:z.string().min(1).max(4000)}).strict()).max(25),truncated:z.boolean()}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
 Confirmation:z.object({...base,actionId:uuid,reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:uuid}).strict(),
 Prepared:z.object({...base,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:Item,consequence:z.literal(consequence)}).strict().refine(v=>v.content.employmentId===v.review.employmentId&&v.content.scheduledOn===v.review.scheduledOn),
 Completed:z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:Receipt}).strict(),Retired:z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('performance_checkin_scheduling_review_index'),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
} as const;
export type CheckInSchedulingHuman=z.infer<typeof Human>;
