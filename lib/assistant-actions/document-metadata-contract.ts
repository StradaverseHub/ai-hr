/** Human-entered ordinary-document metadata; neither files nor authority can enter this protocol. */
import {z} from 'zod';
export const DOCUMENT_METADATA_ACTION='employees.document_metadata.maintain' as const;
const uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),text=z.string().max(4000).nullable();
const Fields=z.object({title:z.string().min(1).max(4000),category:text,description:text}).strict();
const Human=z.object({action:z.literal(DOCUMENT_METADATA_ACTION),contractVersion:z.literal(1),employmentId:uuid,subjectId:uuid,fields:Fields}).strict().refine(v=>new TextEncoder().encode(JSON.stringify(v)).byteLength<=24000);
const Subject=z.object({employmentId:uuid,subjectId:uuid,employeeName:z.string().min(1),employeeCode:z.string().nullable(),companyName:z.string().min(1)}).strict();
const Attachment=z.object({fileName:z.string().max(4000),mimeType:z.string().max(240),sizeBytes:z.number().int().nonnegative()}).strict();
const Item=Subject.extend({before:Fields,after:Fields,attachment:Attachment}).strict();
const Receipt=z.object({kind:z.literal('maintained'),subjectId:uuid,employmentId:uuid,eventId:uuid}).strict();
const base={action:z.literal(DOCUMENT_METADATA_ACTION),contractVersion:z.literal(1)},consequence='ordinary_document_metadata_changed_attachment_untouched' as const;
export const DocumentMetadata={action:DOCUMENT_METADATA_ACTION,Fields,Human,Item,Receipt,Attachment,consequence,indexKind:'document_metadata_review_index',
 Selection:z.object({query:z.string().trim().max(80),employmentId:uuid.optional()}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),employees:z.array(Subject.omit({subjectId:true})).max(25),truncated:z.boolean(),documents:z.array(z.object({id:uuid,fields:Fields,attachment:Attachment}).strict()).max(100)}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
 Confirmation:z.object({...base,actionId:uuid,reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:uuid}).strict(),
 Prepared:z.object({...base,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:Item,consequence:z.literal(consequence)}).strict().refine(v=>new TextEncoder().encode(JSON.stringify(v)).byteLength<=120000),
 Completed:z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:Receipt}).strict(),Retired:z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('document_metadata_review_index'),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
} as const;
export type DocumentMetadataHuman=z.infer<typeof Human>;
