/** Human selects one EXISTING run. No posted money, employee rows, processing/approval state,
 * actor, override, generated numeric revision or generic service invocation. */
import {z} from 'zod';
export const REVIEWED_PAYROLL_CLOSE_ACTION='payroll.close' as const;
const base={action:z.literal(REVIEWED_PAYROLL_CLOSE_ACTION),contractVersion:z.literal(1)},id=z.uuid().transform(value=>value.toLowerCase()),digest=z.string().regex(/^[a-f0-9]{64}$/),count=z.number().int().nonnegative();
export const ReviewedPayrollCloseNomination=z.object({...base,batchId:id}).strict();
export const ReviewedPayrollCloseHumanContent=z.object({...base,batchId:id,confirmCloseProcessedRun:z.literal(true)}).strict();
export type ReviewedPayrollCloseHumanContent=z.infer<typeof ReviewedPayrollCloseHumanContent>;
export const ReviewedPayrollCloseConfirmation=z.object({...base,reviewedDigest:digest}).strict();
export const ReviewedPayrollCloseReview=z.object({batchId:id,companyId:id,payPeriodId:id,payPeriod:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),runType:z.enum(['regular','off_cycle','bonus','adjustment']),runSeq:z.number().int().positive(),cycleName:z.string().nullable(),status:z.literal('processed'),recordedEmployeeCount:count,visiblePayslipCount:count,siblingRunCount:count,otherUnclosedRuns:count,releaseConfigurationPresent:z.boolean(),consequence:z.literal('close_this_run_apply_configured_payslip_release_parent_closes_when_all_runs_closed')}).strict();
/** INTERNAL source packet. reviewedDigest includes private canonical checks/row versions, NOT a
 * browser token. Future shared custody keeps it encrypted and binds a fresh secret nonce/keyed public
 * commitment to the permitted review. No raw source or fingerprint goes to a model/provider/browser. */
export const ReviewedPayrollClosePreparedSource=z.object({kind:z.literal('prepared_source'),content:ReviewedPayrollCloseHumanContent,review:ReviewedPayrollCloseReview,reviewedDigest:digest,consequence:z.literal('immutable_run_configured_payslip_release_not_bank_payment')}).strict();
export type ReviewedPayrollClosePreparedSource=z.infer<typeof ReviewedPayrollClosePreparedSource>;
export const ReviewedPayrollCloseSourceReceipt=z.object({kind:z.literal('closed'),batchId:id,closedEventId:id,payPeriodId:id,currentStatus:z.enum(['draft','processed','closed']),currentPeriodStatus:z.enum(['open','closed']),recordedReleasedAt:z.iso.datetime(),currentReleasedAt:z.iso.datetime().nullable(),proof:z.literal('historical_close_current_batch'),semantics:z.literal('configured_payslip_release_not_bank_payment'),replayed:z.boolean()}).strict();
