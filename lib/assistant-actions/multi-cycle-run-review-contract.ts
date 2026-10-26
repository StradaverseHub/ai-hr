/** Human draft creation only. Exact native confirmation stays in persistent top-level custody;
 * no payroll calculation, processing, closing, employee money or bank payment is represented. */
import {z} from 'zod';
import {REVIEWED_MULTI_CYCLE_RUN_ACTION as action,ReviewedMultiCycleRunHumanContent,ReviewedMultiCycleRunReview,ReviewedMultiCycleRunSourceReceipt} from './reviewed-multi-cycle-run-contract';
const base={action:z.literal(action),contractVersion:z.literal(1)},digest=z.string().regex(/^[a-f0-9]{64}$/);
export const MultiCycleRunReviewPrepare=ReviewedMultiCycleRunHumanContent;
export const MultiCycleRunReviewConfirmation=z.object({...base,actionId:z.uuid(),reviewedDigest:digest}).strict();
export const MultiCycleRunReviewRetirement=z.object({...base,actionId:z.uuid()}).strict();
export const MultiCycleRunPreparedReview=z.object({...base,actionId:z.uuid(),reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:ReviewedMultiCycleRunHumanContent,review:ReviewedMultiCycleRunReview}).strict();
export const MultiCycleRunCompletedReview=z.object({...base,actionId:z.uuid(),state:z.literal('completed'),receipt:ReviewedMultiCycleRunSourceReceipt}).strict();
export const MultiCycleRunRetiredReview=z.object({...base,actionId:z.uuid(),state:z.enum(['discarded','expired','refused'])}).strict();
export const MultiCycleRunReviewIndex=z.object({kind:z.literal('multi_cycle_run_review_index'),reviews:z.array(z.object({...base,actionId:z.uuid(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(row=>row.actionId)).size===rows.length)}).strict();
