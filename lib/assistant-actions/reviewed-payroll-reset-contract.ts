/** Human input and review projection only. Reset is not registered or mounted until its complete
 * native deletion/update proof and coordinated migration are reviewed. Native Payroll owns money. */
import {z} from 'zod';
export const REVIEWED_PAYROLL_RESET_ACTION='payroll.reset' as const;
const id=z.guid().transform(value=>value.toLowerCase());
const base={action:z.literal(REVIEWED_PAYROLL_RESET_ACTION),contractVersion:z.literal(1)};
export const ReviewedPayrollResetNomination=z.object({...base,batchId:id}).strict();
export const ReviewedPayrollResetHumanContent=z.object({...base,batchId:id,
 reason:z.string().trim().min(1).max(4000),confirmResetProcessedRun:z.literal(true),
 acknowledgePayslipLoanClaimConsequences:z.literal(true),
}).strict();
export type ReviewedPayrollResetHumanContent=z.infer<typeof ReviewedPayrollResetHumanContent>;
const count=z.number().int().nonnegative().max(10000);
/** Counts describe the current native source set, not a second loan reversal calculation. */
export const ReviewedPayrollResetReview=z.object({batchId:id,companyId:id,companyName:z.string().min(1).max(4000),
 payPeriodId:id,payPeriod:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),runType:z.enum(['regular','off_cycle','bonus','adjustment']),
 runSeq:z.number().int().positive(),cycleName:z.string().max(4000).nullable(),beforeStatus:z.literal('processed'),afterStatus:z.literal('draft'),
 payslipsToDelete:count,appliedRepaymentRows:count,affectedLoans:count,paidClaimsToRevert:count,consumedItemsToRelease:count,
 recalculationMarked:z.boolean(),statutoryReportCount:count,recordedPaymentSummaryExport:z.boolean(),
 consequence:z.literal('delete_payslips_clear_totals_unwind_native_loans_claims_consumption_and_recalc_keep_draft_inputs'),
 downstreamMeaning:z.literal('recorded_exports_and_reports_retained_no_bank_reversal_or_filing_withdrawal'),
 parentAndSiblings:z.literal('unchanged'),
}).strict().refine(value=>value.affectedLoans<=value.appliedRepaymentRows);
