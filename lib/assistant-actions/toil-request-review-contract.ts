/** Closed human worked-date request custody. Models never supply entitlement totals or approval. */
import {z} from 'zod';
import {OWN_TOIL_REPLACEMENT_ACTION as action,OwnToilReplacementHumanContent,OwnToilReplacementReview,OwnToilReplacementSourceReceipt} from './own-toil-replacement-contract';
const base={action:z.literal(action),contractVersion:z.literal(1)};
export const ToilRequestReviewPrepare=OwnToilReplacementHumanContent;
export const ToilRequestReviewConfirmation=z.object({...base,actionId:z.uuid(),reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const ToilRequestReviewRetirement=z.object({...base,actionId:z.uuid()}).strict();
export const ToilRequestPreparedReview=z.object({...base,actionId:z.uuid(),reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:OwnToilReplacementHumanContent,review:OwnToilReplacementReview,consequence:z.literal('request_only_no_credit_grant_or_cash')}).strict();
export const ToilRequestCompletedReview=z.object({...base,actionId:z.uuid(),state:z.literal('completed'),receipt:OwnToilReplacementSourceReceipt}).strict();
export const ToilRequestRetiredReview=z.object({...base,actionId:z.uuid(),state:z.enum(['discarded','expired','refused'])}).strict();
export const ToilRequestReviewIndex=z.object({kind:z.literal('toil_request_review_index'),reviews:z.array(z.object({...base,actionId:z.uuid(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(row=>row.actionId)).size===rows.length)}).strict();
