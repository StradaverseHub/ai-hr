/** Human-only shared-person Emergency Contact register command. HR values stay in encrypted local custody. */
import {z} from 'zod';
export const EMERGENCY_CONTACT_MAINTENANCE_ACTION='employees.emergency_contact.maintain' as const;
const uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),text=z.string().max(4000).nullable();
const Fields=z.object({fullName:z.string().min(1).max(4000),relationship:text,mobilePhone:text,homePhone:text,address:text,remarks:text,priority:z.enum(['primary','secondary','other'])}).strict();
const Human=z.object({action:z.literal(EMERGENCY_CONTACT_MAINTENANCE_ACTION),contractVersion:z.literal(1),employmentId:uuid,subjectId:uuid,operation:z.enum(['add','update','archive']),contactId:uuid.nullable(),fields:Fields.nullable()}).strict().refine(v=>(v.operation==='add'?v.contactId===null:v.contactId!==null)&&(v.operation==='archive'?v.fields===null:v.fields!==null)).refine(v=>new TextEncoder().encode(JSON.stringify(v)).byteLength<=16000,'Emergency review exceeds the local custody budget');
const Subject=z.object({employmentId:uuid,subjectId:uuid,employeeName:z.string().min(1),employeeCode:z.string().nullable(),companyName:z.string().min(1)}).strict();
const Item=Subject.extend({operation:z.enum(['add','update','archive']),contactId:uuid.nullable(),before:Fields.nullable(),after:Fields.nullable(),demotesPrimary:z.object({id:uuid,fields:Fields}).strict().nullable(),sharedPerson:z.literal(true)}).strict();
const Receipt=z.object({kind:z.literal('maintained'),subjectId:uuid,employmentId:uuid,contactId:uuid,eventId:uuid,operation:z.enum(['add','update','archive']),sharedPerson:z.literal(true)}).strict();
const base={action:z.literal(EMERGENCY_CONTACT_MAINTENANCE_ACTION),contractVersion:z.literal(1)},consequence='shared_person_emergency_register_changed_not_employment_or_pay' as const;
export const EmergencyContactMaintenance={action:EMERGENCY_CONTACT_MAINTENANCE_ACTION,Fields,Human,Item,Receipt,consequence,indexKind:'emergency_contact_maintenance_review_index',
 Selection:z.object({query:z.string().trim().max(80),employmentId:uuid.optional()}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),employees:z.array(Subject).max(25),truncated:z.boolean(),contacts:z.array(z.object({id:uuid,fields:Fields,revision:z.string()}).strict()).max(100),options:z.array(z.object({value:z.string(),label:z.string()}).strict()).max(200)}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
 Confirmation:z.object({...base,actionId:uuid,reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:uuid}).strict(),
 Prepared:z.object({...base,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:Item,consequence:z.literal(consequence)}).strict().refine(v=>new TextEncoder().encode(JSON.stringify(v)).byteLength<=120000,'Emergency review exceeds its local response budget'),
 Completed:z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:Receipt}).strict(),Retired:z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('emergency_contact_maintenance_review_index'),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
} as const;
export type EmergencyContactMaintenanceHuman=z.infer<typeof Human>;
