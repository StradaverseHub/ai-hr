import { ANSWER_PLAN_LIMITS } from '../../lib/ai/assistant-answer-plan';
import { capturePrivateAssistantTask } from '../../lib/ai/provider-assistant-policy';

export const PROTECTED_CATALOGUE_FORMAT = 'protected_catalogue_answer_v1';

function exact(value: string | number | null) {
  return { type: value === null ? 'null' : typeof value === 'number' ? 'integer' : 'string', const: value };
}

function object<T extends Readonly<Record<string, unknown>>>(properties: T) {
  return { type: 'object', additionalProperties: false, properties, required: Object.keys(properties) };
}

/** A decoding experiment for a single fictional model-backed answer. The existing adjudicators
 * still reject duplicates and any answer the local source will not support. */
export function protectedCatalogueAnswerJsonSchema(input: unknown) {
  const { local } = capturePrivateAssistantTask(input);
  if (local.operation !== 'conversation') throw Error('A protected answer catalogue is required.');
  const choices = local.reads.flatMap(read => [
    ...read.cards.flatMap(card => card.facts.filter(fact => fact.available).map(fact => object({
      kind: exact('fact'), read: exact(read.read), card: exact(card.card), fact: exact(fact.fact),
    }))),
    ...read.explanations.map(item => object({
      kind: exact('explanation'), read: exact(read.read), card: exact(item.card), code: exact(item.code),
    })),
  ]);
  if (choices.length === 0) throw Error('A protected answer requires an available reference.');
  return object({
    version: exact(1),
    mode: exact('answer'),
    blocks: { type: 'array', minItems: 1, maxItems: Math.min(choices.length, ANSWER_PLAN_LIMITS.blocks), items: { anyOf: choices } },
  });
}
