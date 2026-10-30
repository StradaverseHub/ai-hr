/** Closed human review boundary for one native Payroll reopening, with shared custody and proof.
 * Models nominate a run only; a human authors the reason and acknowledges consequences. */
import {z} from 'zod';
export const REVIEWED_PAYROLL_REOPEN_ACTION='payroll.reopen' as const;
const id=z.guid().transform(value=>value.toLowerCase());
const base={action:z.literal(REVIEWED_PAYROLL_REOPEN_ACTION),contractVersion:z.literal(1)};
export const ReviewedPayrollReopenNomination=z.object({...base,batchId:id}).strict();
export const ReviewedPayrollReopenHumanContent=z.object({...base,batchId:id,
 reason:z.string().trim().min(1).max(4000),confirmReopenClosedRun:z.literal(true),
 acknowledgeRecordedDownstreamWarnings:z.literal(true),
}).strict();
export type ReviewedPayrollReopenHumanContent=z.infer<typeof ReviewedPayrollReopenHumanContent>;
export const ReviewedPayrollReopenWarnings=z.object({paymentDisbursed:z.boolean(),statutoryFiled:z.boolean(),
 statutoryFiledCount:z.number().int().nonnegative(),statutoryReportCount:z.number().int().nonnegative(),
}).strict().refine(row=>row.statutoryFiled===(row.statutoryFiledCount>0)&&row.statutoryFiledCount<=row.statutoryReportCount);
export const ReviewedPayrollReopenReview=z.object({batchId:id,companyId:id,companyName:z.string().min(1),
 payPeriodId:id,payPeriod:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),runType:z.enum(['regular','off_cycle','bonus','adjustment']),
 runSeq:z.number().int().positive(),cycleName:z.string().nullable(),beforeStatus:z.literal('closed'),afterStatus:z.literal('processed'),
 beforePeriodStatus:z.enum(['open','closed']),afterPeriodStatus:z.literal('open'),parentWillReopen:z.boolean(),
 warnings:ReviewedPayrollReopenWarnings,paymentWarningMeaning:z.literal('recorded_payment_summary_export_not_verified_bank_settlement'),
 consequence:z.literal('enable_later_payroll_edits_no_recalculation_payment_reversal_or_statutory_withdrawal'),
}).strict().refine(row=>row.parentWillReopen===(row.beforePeriodStatus==='closed'));
/** Exact native references; current state is separate from the historical transition proof. */
export const ReviewedPayrollReopenSourceReceipt=z.object({kind:z.literal('reopened'),batchId:id,payPeriodId:id,
 statusHistoryId:id,unlockedEventId:id,periodReopenedEventId:id.nullable(),parentWasReopened:z.boolean(),
 currentStatus:z.enum(['draft','processed','closed']),currentPeriodStatus:z.enum(['open','closed']),
 proof:z.literal('exact_unlock_history_batch_event_conditional_parent_event'),
 semantics:z.literal('historical_reopen_not_reset_recalculated_or_payment_reversed'),replayed:z.boolean(),
}).strict().refine(row=>row.parentWasReopened===(row.periodReopenedEventId!==null));
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const PayrollReopenConfirmation=z.object({...base,actionId:id,reviewedDigest:digest}).strict();
export const PayrollReopenRetirement=z.object({...base,actionId:id}).strict();
export const PayrollReopenPrepared=z.object({...base,actionId:id,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:ReviewedPayrollReopenHumanContent,review:ReviewedPayrollReopenReview}).strict().refine(row=>row.content.batchId===row.review.batchId);
export const PayrollReopenCompleted=z.object({...base,actionId:id,state:z.literal('completed'),receipt:ReviewedPayrollReopenSourceReceipt}).strict();
export const PayrollReopenRetired=z.object({...base,actionId:id,state:z.enum(['discarded','expired','refused'])}).strict();
export const PayrollReopenIndex=z.object({kind:z.literal('payroll_reopen_review_index'),reviews:z.array(z.object({...base,actionId:id,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25)}).strict();
export const PayrollReopenChoices=z.discriminatedUnion('kind',[z.object({kind:z.literal('choices'),batches:z.array(z.object({batchId:id,companyName:z.string().min(1).max(4000),payPeriod:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),cycleName:z.string().max(4000).nullable()}).strict()).max(25)}).strict(),z.object({kind:z.literal('unavailable')}).strict()]);
export const PayrollReopen={action:REVIEWED_PAYROLL_REOPEN_ACTION,Human:ReviewedPayrollReopenHumanContent,Item:ReviewedPayrollReopenReview,Receipt:ReviewedPayrollReopenSourceReceipt,Prepared:PayrollReopenPrepared,Completed:PayrollReopenCompleted,Retired:PayrollReopenRetired,Index:PayrollReopenIndex,Choices:PayrollReopenChoices,Confirmation:PayrollReopenConfirmation,Retirement:PayrollReopenRetirement,Selection:z.object({}).strict(),indexKind:'payroll_reopen_review_index'} as const;
