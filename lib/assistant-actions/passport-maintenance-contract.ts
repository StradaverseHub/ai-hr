/** Human-only existing-profile passport review; no provider or inferred financial instructions. */
import {z} from 'zod';
export const PASSPORT_MAINTENANCE_ACTION='employees.passport.maintain' as const;
const uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),text=z.string().max(4000).nullable();
const Fields=z.object({passportNumber:text,passportIssueDate:z.iso.date().nullable(),passportExpiryDate:z.iso.date().nullable(),passportRemark:text,passportIssuingCountry:text,passportIssuingCountryCode:text}).strict();
const Human=z.object({action:z.literal(PASSPORT_MAINTENANCE_ACTION),contractVersion:z.literal(1),employmentId:uuid,subjectId:uuid,fields:Fields}).strict().refine(v=>new TextEncoder().encode(JSON.stringify(v)).byteLength<=24000);
const Subject=z.object({employmentId:uuid,subjectId:uuid,employeeName:z.string().min(1),employeeCode:z.string().nullable(),companyName:z.string().min(1),supported:z.boolean()}).strict();
const Item=Subject.extend({country:z.literal('MY'),before:Fields,after:Fields,sharedPerson:z.literal(true)}).strict();
const Receipt=z.object({kind:z.literal('maintained'),subjectId:uuid,employmentId:uuid,statutoryId:uuid,eventId:uuid,sharedPerson:z.literal(true)}).strict();
const base={action:z.literal(PASSPORT_MAINTENANCE_ACTION),contractVersion:z.literal(1)},consequence='passport_information_saved_not_ic_dob_pay_or_access' as const;
export const PassportMaintenance={action:PASSPORT_MAINTENANCE_ACTION,Fields,Human,Item,Receipt,consequence,indexKind:'passport_maintenance_review_index',
 Selection:z.object({query:z.string().trim().max(80),employmentId:uuid.optional()}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),employees:z.array(Subject).max(25),truncated:z.boolean(),current:Fields.nullable()}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
 Confirmation:z.object({...base,actionId:uuid,reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:uuid}).strict(),
 Prepared:z.object({...base,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:Item,consequence:z.literal(consequence)}).strict().refine(v=>new TextEncoder().encode(JSON.stringify(v)).byteLength<=120000),
 Completed:z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:Receipt}).strict(),Retired:z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('passport_maintenance_review_index'),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
} as const;
export type PassportMaintenanceHuman=z.infer<typeof Human>;
