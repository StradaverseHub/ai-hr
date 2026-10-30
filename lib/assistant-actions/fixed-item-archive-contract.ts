/** Existing recurring row only. Human selection never supplies amounts, dates, bypass flags or decisions. */
import {z} from 'zod';
export const FIXED_ITEM_ARCHIVE_ACTION='employees.fixed_item.archive' as const;
const id=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),text=z.string().max(16000).nullable(),base={action:z.literal(FIXED_ITEM_ARCHIVE_ACTION),contractVersion:z.literal(1)};
const Fields=z.object({componentId:id,code:z.string().min(1).max(240),name:z.string().max(4000),amount:z.string().max(80),currency:z.string().max(10),validFrom:z.iso.date(),validTo:z.iso.date().nullable(),prorateOverride:z.boolean().nullable(),remarks:text,runType:z.string().max(100).nullable(),payrollCycleId:id.nullable(),archived:z.boolean()}).strict();
const Human=z.object({...base,employmentId:id,subjectId:id}).strict();
const Subject=z.object({employmentId:id,employeeName:z.string().min(1).max(4000),employeeCode:z.string().max(4000).nullable(),companyName:z.string().min(1).max(4000)}).strict();
const Item=Subject.extend({subjectId:id,before:Fields,after:Fields,processedPeriods:z.array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)).max(2000)}).strict().refine(v=>!v.before.archived&&v.after.archived&&JSON.stringify({...v.before,archived:true})===JSON.stringify(v.after));
const Receipt=z.object({kind:z.literal('archived'),subjectId:id,employmentId:id,eventId:id}).strict();
const consequence='recurring_item_archived_history_retained_no_recalculation_or_stale_mark' as const;
export const FixedItemArchive={action:FIXED_ITEM_ARCHIVE_ACTION,Fields,Human,Item,Receipt,consequence,indexKind:'fixed_item_archive_review_index',
 Selection:z.object({query:z.string().trim().max(80),employmentId:id.optional()}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),employees:z.array(Subject).max(25),truncated:z.boolean(),items:z.array(z.object({id,fields:Fields}).strict()).max(100)}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
 Confirmation:z.object({...base,actionId:id,reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:id}).strict(),
 Prepared:z.object({...base,actionId:id,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:Item,consequence:z.literal(consequence)}).strict().refine(v=>v.content.subjectId===v.review.subjectId&&v.content.employmentId===v.review.employmentId&&new TextEncoder().encode(JSON.stringify(v)).byteLength<=120000),
 Completed:z.object({...base,actionId:id,state:z.literal('completed'),receipt:Receipt}).strict(),Retired:z.object({...base,actionId:id,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('fixed_item_archive_review_index'),reviews:z.array(z.object({...base,actionId:id,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
} as const;
export type FixedItemArchiveHuman=z.infer<typeof Human>;
