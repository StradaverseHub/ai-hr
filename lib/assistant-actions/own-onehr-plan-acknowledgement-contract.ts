/** OneHR career-conversation acknowledgement only; no plan narrative, rating or decision input. */
import {z} from 'zod';
export const OwnOnehrPlanAcknowledgementIntent=z.object({version:z.literal(1),planId:z.uuid(),acknowledge:z.literal(true)}).strict();
export type OwnOnehrPlanAcknowledgementIntent=z.infer<typeof OwnOnehrPlanAcknowledgementIntent>;
export const OwnOnehrPlanAcknowledgementReview=z.object({version:z.literal(1),action:z.literal('performance.onehr.plan.acknowledge'),engine:z.literal('onehr_plan'),
 planId:z.uuid(),reviewId:z.uuid(),employmentId:z.uuid(),planYear:z.number().int(),conversationHeldOn:z.string().nullable(),
 meaning:z.literal('acknowledge_career_conversation_not_rating_or_promotion'),reviewDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type OwnOnehrPlanAcknowledgementReview=z.infer<typeof OwnOnehrPlanAcknowledgementReview>;
export const OwnOnehrPlanAcknowledgementEventMetadata=z.object({version:z.literal(1),planRevision:z.number().int().positive(),acknowledgedAt:z.string().datetime()}).strict();
export const OwnOnehrPlanAcknowledgementReceipt=z.object({version:z.literal(1),action:z.literal('performance.onehr.plan.acknowledge'),engine:z.literal('onehr_plan'),
 proof:z.literal('recorded_plan_acknowledgement_current_revision'),planId:z.uuid(),reviewId:z.uuid(),employmentId:z.uuid(),eventId:z.uuid(),planYear:z.number().int(),planRevision:z.number().int().positive(),acknowledgedAt:z.string().datetime(),
 meaning:z.literal('acknowledged_career_conversation_not_rating_or_promotion')}).strict();
export type OwnOnehrPlanAcknowledgementReceipt=z.infer<typeof OwnOnehrPlanAcknowledgementReceipt>;
