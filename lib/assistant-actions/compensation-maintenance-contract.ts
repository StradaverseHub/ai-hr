/** Human-entered pay values are local strings; no model derives money, currency or effective dates. */
import {z} from 'zod';
import {isCurrencyCode} from '../currencies';
import {PERSONNEL_PAY_MODES,PERSONNEL_PAYMENT_TERMS} from '../personnel-choice-vocabulary';
export const COMPENSATION_MAINTENANCE_ACTION='employees.compensation.maintain' as const;
const uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),money=z.string().regex(/^(?:0|[1-9]\d{0,9})\.\d{2}$/),date=z.iso.date();
const Fields=z.object({basicSalary:money,currency:z.string().refine(isCurrencyCode),payMode:z.enum(PERSONNEL_PAY_MODES),paymentTerm:z.enum(PERSONNEL_PAYMENT_TERMS),rateAmount:money.nullable(),remarks:z.string().max(2000).nullable(),effectiveFrom:date}).strict();
const Human=z.object({action:z.literal(COMPENSATION_MAINTENANCE_ACTION),contractVersion:z.literal(1),employmentId:uuid,subjectId:uuid,operation:z.enum(['set','edit','supersede']),compensationId:uuid.nullable(),fields:Fields.nullable()}).strict().refine(v=>v.employmentId===v.subjectId&&(v.operation==='set'?v.compensationId===null:v.compensationId!==null)&&(v.operation==='supersede'?v.fields===null:v.fields!==null));
const HistoryFields=z.object({basicSalary:z.string().max(80),currency:z.string().max(10),monthlyAllowance:z.string().max(80),payMode:z.enum(PERSONNEL_PAY_MODES),paymentTerm:z.string().max(80),rateAmount:z.string().max(80).nullable(),remarks:z.string().max(16000).nullable(),validFrom:date,validTo:date.nullable(),superseded:z.boolean()}).strict();
const Subject=z.object({employmentId:uuid,employeeName:z.string().min(1).max(240),employeeCode:z.string().max(100).nullable(),companyName:z.string().min(1).max(240)}).strict();
const Item=Subject.extend({subjectId:uuid,operation:z.enum(['set','edit','supersede']),compensationId:uuid.nullable(),recalculationPeriods:z.array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)).max(100),changes:z.array(z.object({id:uuid.nullable(),before:HistoryFields.nullable(),after:HistoryFields}).strict()).min(1).max(2)}).strict();
const Receipt=z.object({kind:z.literal('maintained'),subjectId:uuid,employmentId:uuid,compensationId:uuid,eventId:uuid,operation:z.enum(['set','edit','supersede'])}).strict();
const base={action:z.literal(COMPENSATION_MAINTENANCE_ACTION),contractVersion:z.literal(1)},consequence='salary_history_changed_not_payroll_generated_approved_or_paid' as const;
export const CompensationMaintenance={action:COMPENSATION_MAINTENANCE_ACTION,Fields,HistoryFields,Human,Item,Receipt,consequence,indexKind:'compensation_maintenance_review_index',
 Selection:z.object({query:z.string().trim().max(80),employmentId:uuid.optional()}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),employees:z.array(Subject).max(25),truncated:z.boolean(),history:z.array(z.object({id:uuid,fields:HistoryFields,revision:z.string()}).strict()).max(100)}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
 Confirmation:z.object({...base,actionId:uuid,reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:uuid}).strict(),
 Prepared:z.object({...base,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:Item,consequence:z.literal(consequence)}).strict().refine(v=>new TextEncoder().encode(JSON.stringify(v)).byteLength<=120000),
 Completed:z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:Receipt}).strict(),Retired:z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('compensation_maintenance_review_index'),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
} as const;
export type CompensationMaintenanceHuman=z.infer<typeof Human>;
