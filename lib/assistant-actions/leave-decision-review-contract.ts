/** Closed human assigned Leave decision custody. A model never chooses an approval outcome. */
import {z} from 'zod';
import {REVIEWED_LEAVE_DECISION_ACTION as action,ReviewedLeaveDecisionHumanContent,ReviewedLeaveDecisionReview,ReviewedLeaveDecisionSourceReceipt} from './reviewed-leave-decision-contract';
const base={action:z.literal(action),contractVersion:z.literal(1)};
export const LeaveDecisionReviewPrepare=ReviewedLeaveDecisionHumanContent;
export const LeaveDecisionReviewConfirmation=z.object({...base,actionId:z.uuid(),reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const LeaveDecisionReviewRetirement=z.object({...base,actionId:z.uuid()}).strict();
export const LeaveDecisionPreparedReview=z.object({...base,actionId:z.uuid(),reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:ReviewedLeaveDecisionHumanContent,review:ReviewedLeaveDecisionReview,consequence:z.literal('assigned_decision_request_may_remain_pending')}).strict();
export const LeaveDecisionCompletedReview=z.object({...base,actionId:z.uuid(),state:z.literal('completed'),receipt:ReviewedLeaveDecisionSourceReceipt}).strict();
export const LeaveDecisionRetiredReview=z.object({...base,actionId:z.uuid(),state:z.enum(['discarded','expired','refused'])}).strict();
export const LeaveDecisionReviewIndex=z.object({kind:z.literal('leave_decision_review_index'),reviews:z.array(z.object({...base,actionId:z.uuid(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(row=>row.actionId)).size===rows.length)}).strict();
