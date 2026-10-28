/** One existing processed run only; no posted money, rows, private sources or generic execution. */
import {z} from 'zod';
import {REVIEWED_PAYROLL_CLOSE_ACTION as action,ReviewedPayrollCloseHumanContent,ReviewedPayrollCloseReview,ReviewedPayrollCloseSourceReceipt} from './reviewed-payroll-close-contract';
const base={action:z.literal(action),contractVersion:z.literal(1)},digest=z.string().regex(/^[a-f0-9]{64}$/);
export const PayrollCloseReviewPrepare=ReviewedPayrollCloseHumanContent;
export const PayrollCloseReviewConfirmation=z.object({...base,actionId:z.guid(),reviewedDigest:digest}).strict();
export const PayrollCloseReviewRetirement=z.object({...base,actionId:z.guid()}).strict();
export const PayrollClosePreparedReview=z.object({...base,actionId:z.guid(),reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:ReviewedPayrollCloseHumanContent,review:ReviewedPayrollCloseReview}).strict();
export const PayrollCloseCompletedReview=z.object({...base,actionId:z.guid(),state:z.literal('completed'),receipt:ReviewedPayrollCloseSourceReceipt}).strict();
export const PayrollCloseRetiredReview=z.object({...base,actionId:z.guid(),state:z.enum(['discarded','expired','refused'])}).strict();
export const PayrollCloseReviewIndex=z.object({kind:z.literal('payroll_close_review_index'),reviews:z.array(z.object({...base,actionId:z.guid(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(row=>row.actionId)).size===rows.length)}).strict();
