/** Finite native Workforce sections. Human values remain local; no model proposal supplies them. */
import {z} from 'zod';
import {workforceMaintenanceFields} from '../workforce-maintenance-fields';
export const WORKFORCE_PROFILE_MAINTENANCE_ACTION='employees.workforce_profile.maintain' as const;
export const PROFILE_SECTIONS=['personal','contact','correspondence'] as const;
const uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),value=z.string().max(4000).nullable(),version=z.string().regex(/^\d{1,20}$/);
export const workforceProfileSectionValues=(section:typeof PROFILE_SECTIONS[number])=>z.object(Object.fromEntries(workforceMaintenanceFields('person',section).map(f=>[f.key,value]))).strict();
const base={action:z.literal(WORKFORCE_PROFILE_MAINTENANCE_ACTION),contractVersion:z.literal(1)};
const humanSection=<S extends typeof PROFILE_SECTIONS[number]>(section:S)=>z.object({...base,employmentId:uuid,subjectId:uuid,section:z.literal(section),expectedVersion:version,values:workforceProfileSectionValues(section)}).strict();
const Human=z.discriminatedUnion('section',[humanSection('personal'),humanSection('contact'),humanSection('correspondence')]).refine(v=>v.employmentId===v.subjectId).refine(v=>new TextEncoder().encode(JSON.stringify(v)).byteLength<=16000,'Profile review exceeds the local custody budget');
const Subject=z.object({employmentId:uuid,subjectId:uuid,employeeName:z.string().min(1),employeeCode:z.string().nullable(),companyName:z.string().min(1)}).strict();
const Item=Subject.extend({section:z.enum(PROFILE_SECTIONS),before:z.record(z.string(),value),after:z.record(z.string(),value),sharedPerson:z.literal(true)}).strict().refine(v=>v.employmentId===v.subjectId&&workforceProfileSectionValues(v.section).safeParse(v.before).success&&workforceProfileSectionValues(v.section).safeParse(v.after).success);
const Receipt=z.object({kind:z.literal('maintained'),subjectId:uuid,employmentId:uuid,eventId:uuid,sharedPerson:z.literal(true)}).strict();
const consequence='shared_person_profile_updated_not_employment_pay_or_access' as const;
export const WorkforceProfileMaintenance={action:WORKFORCE_PROFILE_MAINTENANCE_ACTION,Human,Item,Receipt,consequence,indexKind:'workforce_profile_maintenance_review_index',
 Selection:z.object({query:z.string().trim().max(80),employmentId:uuid.optional(),section:z.enum(PROFILE_SECTIONS).optional()}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),employees:z.array(Subject).max(25),truncated:z.boolean(),selected:z.object({employmentId:uuid,subjectId:uuid,section:z.enum(PROFILE_SECTIONS),expectedVersion:version,values:z.record(z.string(),value)}).strict().refine(v=>v.employmentId===v.subjectId&&workforceProfileSectionValues(v.section).safeParse(v.values).success).nullable(),options:z.array(z.object({category:z.string(),value:z.string(),label:z.string()}).strict()).max(4000)}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
 Confirmation:z.object({...base,actionId:uuid,reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:uuid}).strict(),
 Prepared:z.object({...base,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:Item,consequence:z.literal(consequence)}).strict().refine(v=>new TextEncoder().encode(JSON.stringify(v)).byteLength<=120000),
 Completed:z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:Receipt}).strict(),Retired:z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('workforce_profile_maintenance_review_index'),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
} as const;
export type WorkforceProfileMaintenanceHuman=z.infer<typeof Human>;
