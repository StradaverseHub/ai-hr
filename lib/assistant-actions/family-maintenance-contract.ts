/** Human-only shared-person Family / Dependents register command. HR values stay in encrypted local custody. */
import {z} from 'zod';
import {dependentFieldApplies,CHILD_RELIEF_CATEGORIES} from '../dependent-vocabulary';
export const FAMILY_MAINTENANCE_ACTION='employees.family.maintain' as const;
const uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),text=z.string().max(4000).nullable();
const Fields=z.object({fullName:z.string().min(1).max(4000),
 relationship:z.string().min(1).max(4000),
 dateOfBirth:z.iso.date().nullable(),
 gender:text,
 icOrPassport:text,
 phone:text,
 remarks:text,
 passportNumber:text,
 residentialAddress:text,
 deceasedOn:z.iso.date().nullable(),
 marriageDate:z.iso.date().nullable(),
 marriageStatus:text,
 occupation:text,
 companyName:text,
 employerAddress:text,
 schoolName:text,
 studyLevel:text,
 studyCountry:text,
 childReliefCategory:text,
 isBeneficiary:z.boolean(),isDeceased:z.boolean(),
 spouseWorking:z.boolean().nullable(),isStudent:z.boolean().nullable(),childTaxRelief:z.boolean().nullable(),childReliefPercentage:z.number().nullable()}).strict();
const Human=z.object({action:z.literal(FAMILY_MAINTENANCE_ACTION),contractVersion:z.literal(1),employmentId:uuid,subjectId:uuid,operation:z.enum(['add','update','archive']),dependentId:uuid.nullable(),fields:Fields.nullable()}).strict().refine(v=>(v.operation==='add'?v.dependentId===null:v.dependentId!==null)&&(v.operation==='archive'?v.fields===null:v.fields!==null)).refine(v=>!v.fields||Object.entries(v.fields).every(([key,value])=>dependentFieldApplies(v.fields!.relationship,key)||value===null),'Use the native Family screen for non-applicable legacy fields').refine(v=>new TextEncoder().encode(JSON.stringify(v)).byteLength<=24000,'Family review exceeds the local custody budget');
const Subject=z.object({employmentId:uuid,subjectId:uuid,employeeName:z.string().min(1),employeeCode:z.string().nullable(),companyName:z.string().min(1)}).strict();
const Grid=z.partialRecord(z.enum(CHILD_RELIEF_CATEGORIES),z.object({full:z.number().nonnegative(),half:z.number().nonnegative()}).strict()).nullable();
const ReliefValues=z.object({numChildren:z.number(),childReliefMode:z.literal('auto'),childReliefTable:Grid}).strict();
const Relief=z.object({changed:z.boolean(),before:z.number().nullable(),after:z.number().nullable(),payrollAlert:z.object({period:z.string().regex(/^\d{4}-\d{2}$/),batches:z.number().int().positive()}).strict().nullable(),skipped:z.enum(['manual_mode','unchanged','no_statutory_row','error']).nullable(),values:z.object({before:ReliefValues,after:ReliefValues}).strict().nullable()}).strict().refine(v=>v.changed===(v.values!==null));
const Item=Subject.extend({operation:z.enum(['add','update','archive']),dependentId:uuid.nullable(),before:Fields.nullable(),after:Fields.nullable(),relief:Relief,sharedPerson:z.literal(true)}).strict();
const Receipt=z.object({kind:z.literal('maintained'),subjectId:uuid,employmentId:uuid,dependentId:uuid,eventId:uuid,operation:z.enum(['add','update','archive']),sharedPerson:z.literal(true)}).strict();
const base={action:z.literal(FAMILY_MAINTENANCE_ACTION),contractVersion:z.literal(1)},consequence='shared_person_family_and_native_auto_relief_changed_payroll_alert_only' as const;
export const FamilyMaintenance={action:FAMILY_MAINTENANCE_ACTION,Fields,Human,Item,Receipt,Relief,ReliefValues,consequence,indexKind:'family_maintenance_review_index',
 Selection:z.object({query:z.string().trim().max(80),employmentId:uuid.optional()}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),employees:z.array(Subject).max(25),truncated:z.boolean(),dependents:z.array(z.object({id:uuid,fields:Fields,revision:z.string()}).strict()).max(100),options:z.array(z.object({value:z.string(),label:z.string()}).strict()).max(200)}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
 Confirmation:z.object({...base,actionId:uuid,reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:uuid}).strict(),
 Prepared:z.object({...base,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:Item,consequence:z.literal(consequence)}).strict().refine(v=>new TextEncoder().encode(JSON.stringify(v)).byteLength<=120000,'Family review exceeds its local response budget'),
 Completed:z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:Receipt}).strict(),Retired:z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('family_maintenance_review_index'),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
} as const;
export type FamilyMaintenanceHuman=z.infer<typeof Human>;

export type FamilyMaintenanceFields=z.infer<typeof Fields>;
