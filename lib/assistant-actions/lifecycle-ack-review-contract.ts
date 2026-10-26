/** Human equipment acknowledgement custody. Contact/device facts and consent remain explicit human input. */
import {z} from 'zod';
import {OWN_LIFECYCLE_ACKNOWLEDGEMENT_ACTION as action,OwnLifecycleAcknowledgementHumanContent,OwnLifecycleAcknowledgementSourceReceipt} from './own-lifecycle-acknowledgement-contract';
const base={action:z.literal(action),contractVersion:z.literal(1)};
export const LifecycleAckReviewPrepare=OwnLifecycleAcknowledgementHumanContent;
export const LifecycleAckReviewConfirmation=z.object({...base,actionId:z.uuid(),reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const LifecycleAckReviewRetirement=z.object({...base,actionId:z.uuid()}).strict();
export const LifecycleAckPreparedReview=z.object({...base,actionId:z.uuid(),reviewedDigest:z.string().regex(/^[a-f0-9]{64}$/),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime(),content:OwnLifecycleAcknowledgementHumanContent,caseNumber:z.string().min(1).max(100),consequence:z.literal('equipment_acknowledgement_only')}).strict();
export const LifecycleAckCompletedReview=z.object({...base,actionId:z.uuid(),state:z.literal('completed'),receipt:OwnLifecycleAcknowledgementSourceReceipt}).strict();
export const LifecycleAckRetiredReview=z.object({...base,actionId:z.uuid(),state:z.enum(['discarded','expired','refused'])}).strict();
export const LifecycleAckReviewIndex=z.object({kind:z.literal('lifecycle_ack_review_index'),reviews:z.array(z.object({...base,actionId:z.uuid(),state:z.enum(['awaiting_confirmation','completed','discarded','expired','refused']),createdAt:z.iso.datetime(),expiresAt:z.iso.datetime()}).strict()).max(25).refine(rows=>new Set(rows.map(row=>row.actionId)).size===rows.length)}).strict();
