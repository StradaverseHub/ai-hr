import { z } from 'zod';
import {
  ANSWER_PLAN_LIMITS, ASSISTANT_CLARIFICATION_SLOTS, ASSISTANT_EXPLANATION_CODES,
} from '../../lib/ai/assistant-answer-plan';

const ordinal = (limit: number) => z.int().min(0).max(limit - 1);
const read = ordinal(ANSWER_PLAN_LIMITS.reads);
const card = ordinal(ANSWER_PLAN_LIMITS.cards);

const block = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fact'), read, card, fact: ordinal(ANSWER_PLAN_LIMITS.factsPerCard) }),
  z.strictObject({ kind: z.literal('explanation'), read, card: card.nullable(), code: z.enum(ASSISTANT_EXPLANATION_CODES) }),
]);

// The experiment supplies this same shape for every case. The source adjudicator
// still checks whether a reference exists in the current caller's reads.
export const leaveAnswerFormat = z.discriminatedUnion('mode', [
  z.strictObject({ version: z.literal(1), mode: z.literal('answer'), blocks: z.array(block).min(1).max(ANSWER_PLAN_LIMITS.blocks) }),
  z.strictObject({ version: z.literal(1), mode: z.literal('clarify'), slot: z.enum(ASSISTANT_CLARIFICATION_SLOTS) }),
  z.strictObject({ version: z.literal(1), mode: z.literal('insufficient'), code: z.enum(['no_verified_facts', 'unsupported_explanation']) }),
  z.strictObject({ version: z.literal(1), mode: z.literal('refuse'), code: z.enum(['unsupported_request', 'human_review_required']) }),
]);

export const leaveAnswerJsonSchema = z.toJSONSchema(leaveAnswerFormat);
