/** Human-entered hand TP3 balances. No year edit, form payload or ancillary tax seed is accepted. */
import {z} from 'zod';
export const TP3_OPENING_MAINTENANCE_ACTION='employees.tp3_opening.maintain' as const;
const uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),year=z.number().int().min(2000).max(2100),amount=z.number().finite().nonnegative().max(9999999999.99).nullable(),money=z.string().regex(/^\d{1,10}\.\d{2}$/).nullable();
const InputFields=z.object({tp3Year:year,tp3NetRemuneration:amount,tp3EpfClaimed:amount,tp3PcbPaid:amount}).strict();
const Fields=z.object({tp3Year:year,tp3NetRemuneration:money,tp3EpfClaimed:money,tp3PcbPaid:money}).strict();
const Human=z.object({action:z.literal(TP3_OPENING_MAINTENANCE_ACTION),contractVersion:z.literal(1),employmentId:uuid,subjectId:uuid,fields:InputFields}).strict();
const Subject=z.object({employmentId:uuid,subjectId:uuid,employeeName:z.string().min(1).max(4000),employeeCode:z.string().nullable(),companyName:z.string().min(1).max(4000),supported:z.boolean()}).strict();
const Item=Subject.extend({country:z.literal('MY'),before:Fields,after:Fields,sharedPerson:z.literal(true),eligibility:z.literal('existing_hand_balances_unchanged_year_no_matching_form')}).strict().refine(v=>v.before.tp3Year===v.after.tp3Year);
const Receipt=z.object({kind:z.literal('maintained'),subjectId:uuid,employmentId:uuid,statutoryId:uuid,eventId:uuid,sharedPerson:z.literal(true)}).strict();
const base={action:z.literal(TP3_OPENING_MAINTENANCE_ACTION),contractVersion:z.literal(1)},consequence='hand_tp3_balances_saved_year_and_ancillary_seeds_unchanged_no_payroll_recalculation' as const;
export const Tp3OpeningMaintenance={action:TP3_OPENING_MAINTENANCE_ACTION,InputFields,Fields,Human,Item,Receipt,consequence,indexKind:'tp3_opening_maintenance_review_index',fieldIds:['payroll.previous_employment_this_year_tp3_opening_balances.year','payroll.previous_employment_this_year_tp3_opening_balances.netremuneration','payroll.previous_employment_this_year_tp3_opening_balances.epfclaimed','payroll.previous_employment_this_year_tp3_opening_balances.pcbpaid'],
 Selection:z.object({query:z.string().trim().max(80),employmentId:uuid.optional()}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),employees:z.array(Subject).max(25),truncated:z.boolean(),current:Fields.nullable()}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
 Confirmation:z.object({...base,actionId:uuid,reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:uuid}).strict(),
 Prepared:z.object({...base,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:Item,consequence:z.literal(consequence)}).strict().refine(v=>v.content.fields.tp3Year===v.review.before.tp3Year&&v.review.before.tp3Year===v.review.after.tp3Year&&v.content.employmentId===v.review.employmentId&&v.content.subjectId===v.review.subjectId),
 Completed:z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:Receipt}).strict(),Retired:z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('tp3_opening_maintenance_review_index'),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
} as const;
export type Tp3OpeningMaintenanceHuman=z.infer<typeof Human>;
