/** Annual-only human submission contract; native service owns every effect. */
import {z} from 'zod';
export const REWARDS_SUBMIT_ACTION='rewards.annual_review.submit' as const;
const stage=z.enum(['draft','bg','gr','ctro','ec','approved','posted','rejected','withdrawn']);
const id=z.guid(),digest=z.string().regex(/^[a-f0-9]{64}$/),base={action:z.literal(REWARDS_SUBMIT_ACTION),contractVersion:z.literal(1)};
export const RewardsSubmitHuman=z.object({...base,unitId:id,revision:z.number().int().nonnegative(),reason:z.string().trim().min(10).max(4000),confirmWholeAnnualReview:z.literal(true),confirmNativeWarnings:z.literal(true)}).strict();
export const RewardsSubmitReview=z.object({unitId:id,companyId:id,companyName:z.string().min(1).max(1000),name:z.string().min(1).max(1000),kind:z.literal('annual'),revision:z.number().int().nonnegative(),before:z.literal('draft'),after:z.literal('bg'),nextSeat:z.literal('bg'),reason:z.string().min(10).max(4000),consequence:z.literal('whole_annual_review_submitted_to_bg_same_revision_native_approvals_required')}).strict();
export const RewardsSubmitReceipt=z.object({kind:z.literal('submitted_for_review'),unitId:id,decisionId:id,eventId:id,submittedRevision:z.number().int().nonnegative(),currentRevision:z.number().int().nonnegative(),currentStatus:stage,proof:z.literal('historical_annual_submission_current_unit')}).strict().refine(r=>r.currentRevision>=r.submittedRevision);
export const RewardsSubmitConfirmation=z.object({...base,actionId:id,reviewedDigest:digest}).strict();
export const RewardsSubmitRetirement=z.object({...base,actionId:id}).strict();
export const RewardsSubmitPrepared=z.object({...base,actionId:id,reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:RewardsSubmitHuman,review:RewardsSubmitReview}).strict().refine(r=>r.content.unitId===r.review.unitId&&r.content.revision===r.review.revision&&r.content.reason===r.review.reason&&Date.parse(r.expiresAt)>Date.parse(r.createdAt));
export const RewardsSubmitCompleted=z.object({...base,actionId:id,state:z.literal('completed'),receipt:RewardsSubmitReceipt}).strict();
export const RewardsSubmitRetired=z.object({...base,actionId:id,state:z.enum(['discarded','expired','refused'])}).strict();
export const RewardsSubmitIndex=z.object({kind:z.literal('rewards_submit_review_index'),reviews:z.array(z.object({...base,actionId:id,state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(r=>new Set(r.map(x=>x.actionId)).size===r.length)}).strict();
export const RewardsSubmitChoices=z.object({kind:z.literal('choices'),units:z.array(z.object({unitId:id,companyName:z.string().min(1).max(1000),name:z.string().min(1).max(1000),revision:z.number().int().nonnegative(),status:z.literal('draft')}).strict()).max(20),truncated:z.boolean()}).strict();
