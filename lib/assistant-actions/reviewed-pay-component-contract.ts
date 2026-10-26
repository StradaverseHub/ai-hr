/** Human-supplied Payroll Setup CREATE. No amounts are derived, suggested or confirmed by a model.
 * Shape checks are closed; canonical native validators own all numeric/statutory/catalogue meaning. */
import {z} from 'zod';
export const REVIEWED_PAY_COMPONENT_ACTION='typed_pay_components.create' as const;
const base={action:z.literal(REVIEWED_PAY_COMPONENT_ACTION),contractVersion:z.literal(1)},digest=z.string().regex(/^[a-f0-9]{64}$/),number=z.number().finite();
const operand=z.discriminatedUnion('ref',[
 z.object({ref:z.literal('number'),value:number,label:z.string().max(40).optional()}).strict(),
 z.object({ref:z.literal('component'),code:z.string().max(200)}).strict(),
 z.object({ref:z.literal('basic')}).strict(),z.object({ref:z.literal('days')}).strict(),z.object({ref:z.literal('hours')}).strict(),
 z.object({ref:z.literal('fixed_allowances')}).strict(),z.object({ref:z.literal('calendar_days')}).strict(),z.object({ref:z.literal('prorated_basic')}).strict()]);
export const ReviewedPayComponentRule=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('fixed')}).strict(),
 z.object({kind:z.literal('percent_of'),base:z.enum(['basic','component']),pct:number,componentCode:z.string().max(200).optional()}).strict(),
 z.object({kind:z.literal('per_day'),rate:number}).strict(),
 z.object({kind:z.literal('per_hour'),rate:number,onlyPullHoursWithinShiftSchedule:z.boolean().optional()}).strict(),
 z.object({kind:z.literal('flat_capped'),value:number,cap:number}).strict(),
 z.object({kind:z.literal('qty_rate'),qty:number,rate:number}).strict(),
 z.object({kind:z.literal('formula'),start:operand,terms:z.array(z.object({op:z.enum(['+','-','*','/']),operand}).strict()).max(8)}).strict()]);
/** Native create/import-pending are deliberately distinct. This human source requires a completed
 * native rule (fixed null is legitimate); no posted pending calculation, seed/import or archive flag. */
export const ReviewedPayComponentInput=z.object({code:z.string().max(200),name:z.string().max(16000),label:z.string().nullable().optional(),description:z.string().nullable().optional(),kind:z.enum(['allowance','deduction','contribution','non_payable']),includedInEpf:z.boolean(),includedInSocsoEis:z.boolean(),includedInPcb:z.boolean(),includedInHrdfBase:z.boolean(),isNonPayable:z.boolean(),prorates:z.boolean(),eaFormLine:z.string().nullable().optional(),roundingMethod:z.string().optional(),rule:ReviewedPayComponentRule.nullable().optional(),epfBonus2012:z.boolean().optional(),pcbRemunerationType:z.enum(['normal','additional','optional_deduction']).nullable().optional(),pcbExemptionCode:z.string().nullable().optional(),displayCategory:z.string().nullable().optional(),orpOvertime:z.boolean().optional(),orpUnpaidLeave:z.boolean().optional()}).strict();
export const ReviewedPayComponentNomination=z.object({...base,code:z.string().max(200)}).strict();
export const ReviewedPayComponentHumanContent=z.object({...base,input:ReviewedPayComponentInput,confirmCatalogCreate:z.literal(true)}).strict();
export type ReviewedPayComponentHumanContent=z.infer<typeof ReviewedPayComponentHumanContent>;
export const ReviewedPayComponentConfirmation=z.object({...base,reviewedDigest:digest}).strict();
export const ReviewedPayComponentPreparedSource=z.object({kind:z.literal('prepared_source'),content:ReviewedPayComponentHumanContent,review:ReviewedPayComponentInput,reviewedDigest:digest,consequence:z.literal('catalogue_created_no_employee_assignment_or_payroll_run')}).strict();
export type ReviewedPayComponentPreparedSource=z.infer<typeof ReviewedPayComponentPreparedSource>;
export const ReviewedPayComponentSourceReceipt=z.object({kind:z.literal('created'),componentId:z.uuid(),createdEventId:z.uuid(),code:z.string(),name:z.string(),label:z.string().nullable(),kindOfComponent:z.enum(['allowance','deduction','contribution','non_payable']),archived:z.boolean(),proof:z.literal('historical_create_current_record'),replayed:z.boolean()}).strict();
