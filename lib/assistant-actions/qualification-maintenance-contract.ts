/** Human-only qualification register command. Values remain in local encrypted review custody. */
import {z} from 'zod';
export const QUALIFICATION_MAINTENANCE_ACTION='employees.qualification.maintain' as const;
const uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),text=z.string().max(4000).nullable();
const Fields=z.object({qualification:z.string().min(1).max(240),description:text,fromYm:text,toYm:text,institute:text,major:text,graduationDate:text,result:text,isHighest:z.boolean()}).strict();
const Human=z.object({action:z.literal(QUALIFICATION_MAINTENANCE_ACTION),contractVersion:z.literal(1),employmentId:uuid,subjectId:uuid,operation:z.enum(['add','update','archive']),qualificationId:uuid.nullable(),fields:Fields.nullable()}).strict().refine(v=>v.employmentId===v.subjectId&&(v.operation==='add'?v.qualificationId===null:v.qualificationId!==null)&&(v.operation==='archive'?v.fields===null:v.fields!==null)).refine(v=>new TextEncoder().encode(JSON.stringify(v)).byteLength<=16000,'Qualification review exceeds the local custody budget');
const Subject=z.object({employmentId:uuid,employeeName:z.string().min(1),employeeCode:z.string().nullable(),companyName:z.string().min(1)}).strict();
const Item=Subject.extend({subjectId:uuid,operation:z.enum(['add','update','archive']),qualificationId:uuid.nullable(),before:Fields.nullable(),after:Fields.nullable(),clearsHighestId:uuid.nullable(),clearsHighest:z.object({id:uuid,fields:Fields}).strict().nullable()}).strict();
const Receipt=z.object({kind:z.literal('maintained'),subjectId:uuid,employmentId:uuid,qualificationId:uuid,eventId:uuid,operation:z.enum(['add','update','archive'])}).strict();
const base={action:z.literal(QUALIFICATION_MAINTENANCE_ACTION),contractVersion:z.literal(1)};
const consequence='qualification_register_changed_not_employment_or_pay' as const;
export const QualificationMaintenance={action:QUALIFICATION_MAINTENANCE_ACTION,Fields,Human,Item,Receipt,consequence,indexKind:'qualification_maintenance_review_index',
 Selection:z.object({query:z.string().trim().max(80),employmentId:uuid.optional()}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),employees:z.array(Subject).max(25),truncated:z.boolean(),qualifications:z.array(z.object({id:uuid,fields:Fields,revision:z.string()}).strict()).max(100),options:z.array(z.object({value:z.string(),label:z.string()}).strict()).max(200)}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
 Confirmation:z.object({...base,actionId:uuid,reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:uuid}).strict(),
 Prepared:z.object({...base,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:Item,consequence:z.literal(consequence)}).strict(),
 Completed:z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:Receipt}).strict(),
 Retired:z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('qualification_maintenance_review_index'),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
} as const;
export type QualificationMaintenanceHuman=z.infer<typeof Human>;
