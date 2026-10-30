/** Current schedule group only; native dated shifts and calendar effects are separate workflows. */
import {z} from 'zod';
export const SCHEDULE_GROUP_MAINTENANCE_ACTION='attendance.schedule_group.maintain' as const;
const id=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),base={action:z.literal(SCHEDULE_GROUP_MAINTENANCE_ACTION),contractVersion:z.literal(1)};
const Group=z.object({id,name:z.string().min(1).max(4000)}).strict();
const Subject=z.object({employmentId:id,employeeName:z.string().min(1).max(4000),employeeCode:z.string().max(4000).nullable(),companyName:z.string().min(1).max(4000)}).strict();
const Human=z.object({...base,employmentId:id,subjectId:id,expectedGroupId:id.nullable(),attendanceRuleId:id.nullable()}).strict().refine(v=>v.subjectId===v.employmentId&&v.expectedGroupId!==v.attendanceRuleId);
const Item=Subject.extend({subjectId:id,before:Group.nullable(),after:Group.nullable(),onDate:z.iso.date()}).strict().refine(v=>v.subjectId===v.employmentId&&v.before?.id!==v.after?.id);
const Receipt=z.object({kind:z.literal('maintained'),subjectId:id,employmentId:id,eventId:id,before:id.nullable(),after:id.nullable()}).strict().refine(v=>v.subjectId===v.employmentId&&v.before!==v.after);
const consequence='current_schedule_group_changed_native_shift_compatibility_checked' as const;
export const ScheduleGroupMaintenance={action:SCHEDULE_GROUP_MAINTENANCE_ACTION,Human,Item,Receipt,consequence,indexKind:'schedule_group_maintenance_review_index',
 Selection:z.object({query:z.string().trim().max(80),employmentId:id.optional()}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),employees:z.array(Subject.extend({attendanceRuleId:id.nullable()})).max(25),groups:z.array(Group).max(200),truncated:z.boolean()}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
 Confirmation:z.object({...base,actionId:id,reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:id}).strict(),
 Prepared:z.object({...base,actionId:id,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:Item,consequence:z.literal(consequence)}).strict().refine(v=>v.content.subjectId===v.review.subjectId&&v.content.employmentId===v.review.employmentId&&v.content.expectedGroupId===(v.review.before?.id??null)&&v.content.attendanceRuleId===(v.review.after?.id??null)),
 Completed:z.object({...base,actionId:id,state:z.literal('completed'),receipt:Receipt}).strict(),Retired:z.object({...base,actionId:id,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('schedule_group_maintenance_review_index'),reviews:z.array(z.object({...base,actionId:id,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
} as const;
export type ScheduleGroupMaintenanceHuman=z.infer<typeof Human>;
