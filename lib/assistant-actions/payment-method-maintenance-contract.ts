/** Current employment routing only; no inferred default, money, file or payment instruction. */
import {z} from 'zod';
export const PAYMENT_METHOD_MAINTENANCE_ACTION='employees.payment_method.maintain' as const;
const uuid=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),Method=z.enum(['bank_transfer','cheque','cash']).nullable(),base={action:z.literal(PAYMENT_METHOD_MAINTENANCE_ACTION),contractVersion:z.literal(1)};
const Human=z.object({...base,employmentId:uuid,subjectId:uuid,expectedMethod:Method,paymentMethod:Method}).strict().refine(v=>v.subjectId===v.employmentId&&v.expectedMethod!==v.paymentMethod);
const Subject=z.object({employmentId:uuid,employeeName:z.string().min(1).max(4000),employeeCode:z.string().max(4000).nullable(),companyName:z.string().min(1).max(4000),supported:z.boolean()}).strict();
const Effects=z.object({currentExports:z.literal('current_method_applies_to_later_exports_including_processed_closed'),nullMeaning:z.literal('unset_no_company_default_readiness_bank_like_ocbc_requires_explicit'),noPayment:z.literal('no_file_payment_or_recalculation')}).strict();
const effects={currentExports:'current_method_applies_to_later_exports_including_processed_closed',nullMeaning:'unset_no_company_default_readiness_bank_like_ocbc_requires_explicit',noPayment:'no_file_payment_or_recalculation'} as const;
const Item=Subject.extend({subjectId:uuid,before:Method,after:Method,readiness:z.enum(['ready','not_required']),effects:Effects}).strict().refine(v=>v.subjectId===v.employmentId&&v.before!==v.after&&v.readiness===(v.after==='bank_transfer'?'ready':'not_required'));
const Receipt=z.object({kind:z.literal('maintained'),employmentId:uuid,subjectId:uuid,eventId:uuid,before:Method,after:Method}).strict().refine(v=>v.subjectId===v.employmentId&&v.before!==v.after);
const consequence='current_payment_method_changed_no_file_payment_or_recalculation' as const;
export const PaymentMethodMaintenance={action:PAYMENT_METHOD_MAINTENANCE_ACTION,Method,Human,Subject,Item,Receipt,effects,consequence,indexKind:'payment_method_maintenance_review_index',
 Selection:z.object({query:z.string().trim().max(80),employmentId:uuid.optional()}).strict(),
 Choices:z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),employees:z.array(Subject).max(25),truncated:z.boolean(),current:z.object({paymentMethod:Method}).strict().nullable()}).strict(),z.object({kind:z.literal('unavailable')}).strict()]),
 Confirmation:z.object({...base,actionId:uuid,reviewedDigest:digest}).strict(),Retirement:z.object({...base,actionId:uuid}).strict(),
 Prepared:z.object({...base,actionId:uuid,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:Human,review:Item,consequence:z.literal(consequence)}).strict().refine(v=>v.content.expectedMethod===v.review.before&&v.content.paymentMethod===v.review.after&&v.content.employmentId===v.review.employmentId),
 Completed:z.object({...base,actionId:uuid,state:z.literal('completed'),receipt:Receipt}).strict(),Retired:z.object({...base,actionId:uuid,state:z.enum(['discarded','expired','refused'])}).strict(),
 Index:z.object({kind:z.literal('payment_method_maintenance_review_index'),reviews:z.array(z.object({...base,actionId:uuid,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict(),
} as const;
export type PaymentMethodMaintenanceHuman=z.infer<typeof Human>;
