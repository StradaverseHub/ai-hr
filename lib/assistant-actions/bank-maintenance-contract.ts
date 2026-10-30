/** Human-only bank destination review; no provider or inferred financial instructions. */
import {z} from 'zod';
export const BANK_MAINTENANCE_ACTION='employees.bank.maintain' as const;
const uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),text=z.string().max(4000).nullable();
const Fields=z.object({bankName:text,bankAccountNo:text,enableCustomHolderName:z.boolean(),customHolderName:text,enableCustomHolderId:z.boolean(),customHolderId:text}).strict();
const Human=z.object({action:z.literal(BANK_MAINTENANCE_ACTION),contractVersion:z.literal(1),employmentId:uuid,subjectId:uuid,fields:Fields}).strict().refine(v=>new TextEncoder().encode(JSON.stringify(v)).byteLength<=24000);
const Subject=z.object({employmentId:uuid,subjectId:uuid,employeeName:z.string().min(1),employeeCode:z.string().nullable(),companyName:z.string().min(1),supported:z.boolean()}).strict();
const Item=Subject.extend({country:z.literal('MY'),before:Fields,after:Fields,sharedPerson:z.literal(true)}).strict();
const Receipt=z.object({kind:z.literal('maintained'),subjectId:uuid,employmentId:uuid,statutoryId:uuid,eventId:uuid,sharedPerson:z.literal(true)}).strict();
const base={action:z.literal(BANK_MAINTENANCE_ACTION),contractVersion:z.literal(1)},consequence='bank_destination_saved_not_payment_processed_or_statutory_changed' as const;
export const BankMaintenance={action:BANK_MAINTENANCE_ACTION,Fields,Human,Item,Receipt,consequence,indexKind:'bank_maintenance_review_index',
 Selection:z.object({query:z.string().trim().max(80),employmentId:uuid.optional()}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),employees:z.array(Subject).max(25),truncated:z.boolean(),current:Fields.nullable(),banks:z.array(z.string()).max(200)}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
 Confirmation:z.object({...base,actionId:uuid,reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:uuid}).strict(),
 Prepared:z.object({...base,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:Item,consequence:z.literal(consequence)}).strict().refine(v=>new TextEncoder().encode(JSON.stringify(v)).byteLength<=120000),
 Completed:z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:Receipt}).strict(),Retired:z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('bank_maintenance_review_index'),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
} as const;
export type BankMaintenanceHuman=z.infer<typeof Human>;
