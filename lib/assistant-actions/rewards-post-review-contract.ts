/** Existing whole approved unit only; no posted recommendation, budget, salary or calculated money. */
import {z} from 'zod';
import {REVIEWED_REWARDS_POST_ACTION as action,ReviewedRewardsPostHumanContent,ReviewedRewardsPostReview,ReviewedRewardsPostSourceReceipt} from './reviewed-rewards-post-contract';
const base={action:z.literal(action),contractVersion:z.literal(1)},digest=z.string().regex(/^[a-f0-9]{64}$/);
export const RewardsPostReviewPrepare=ReviewedRewardsPostHumanContent;
export const RewardsPostReviewConfirmation=z.object({...base,actionId:z.uuid(),reviewedDigest:digest}).strict();
export const RewardsPostReviewRetirement=z.object({...base,actionId:z.uuid()}).strict();
export const RewardsPostPreparedReview=z.object({...base,actionId:z.uuid(),reviewedDigest:digest,createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:ReviewedRewardsPostHumanContent,review:ReviewedRewardsPostReview}).strict();
export const RewardsPostCompletedReview=z.object({...base,actionId:z.uuid(),state:z.literal('completed'),receipt:ReviewedRewardsPostSourceReceipt}).strict();
export const RewardsPostRetiredReview=z.object({...base,actionId:z.uuid(),state:z.enum(['discarded','expired','refused'])}).strict();
export const RewardsPostReviewIndex=z.object({kind:z.literal('rewards_post_review_index'),reviews:z.array(z.object({...base,actionId:z.uuid(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(row=>row.actionId)).size===rows.length)}).strict();
