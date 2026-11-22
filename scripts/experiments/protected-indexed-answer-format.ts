import { ANSWER_PLAN_LIMITS, type AssistantAnswerBlock } from '../../lib/ai/assistant-answer-plan';
import { capturePrivateAssistantTask } from '../../lib/ai/provider-assistant-policy';

export const PROTECTED_INDEXED_FORMAT = 'protected_indexed_answer_v1';

/** Offline presentation of the same authorized references as a numbered choice list.
 * Both existing answer adjudicators still run on the decoded selection. */
export function protectedIndexedAnswer(input: unknown) {
  const { local } = capturePrivateAssistantTask(input);
  if (local.operation !== 'conversation') throw Error('A protected answer catalogue is required.');
  const options = local.reads.flatMap(read => [
    ...read.cards.flatMap(card => card.facts.filter(fact => fact.available).map(fact => ({
      block: { kind: 'fact', read: read.read, card: card.card, fact: fact.fact } satisfies AssistantAnswerBlock,
      label: { read: read.read, card: card.card, module: read.module, field: fact.field },
    }))),
    ...read.explanations.map(item => ({
      block: { kind: 'explanation', read: read.read, card: item.card, code: item.code } satisfies AssistantAnswerBlock,
      label: { read: read.read, card: item.card, module: read.module, explanation: item.code },
    })),
  ]);
  const choices = options.map(({ label }, index) => ({ index, ...label }));
  if (!choices.length) throw Error('A protected answer requires an available reference.');
  const maximum = Math.min(choices.length, ANSWER_PLAN_LIMITS.blocks);
  const route = local.strategy === 'focused_v1'
    ? 'Identify the requested recorded field or canonical meaning. Keep related results adjacent in a useful order.'
    : 'Choose concise relevant recorded facts and supported canonical explanations.';
  return {
    system: route + ' Select only from the listed choices. For leave_available prioritize available, for leave_pending prioritize pending, and for leave_taken prioritize taken. For other intents select the smallest useful current-source answer. Never infer facts, permissions, dates or unavailable information. Return exactly one JSON object with a selection array containing distinct choice indices in answer order.',
    prompt: JSON.stringify({ intent: local.intent, choices }),
    format: {
      type: 'object', additionalProperties: false, required: ['selection'],
      properties: {
        selection: {
          type: 'array', minItems: 1, maxItems: maximum, uniqueItems: true,
          items: { type: 'integer', enum: choices.map(choice => choice.index) },
        },
      },
    },
    decode(text: string) {
      try {
        const answer: unknown = JSON.parse(text);
        if (!answer || typeof answer !== 'object' || Object.keys(answer).join() !== 'selection' ||
            !('selection' in answer) || !Array.isArray(answer.selection)) return '{}';
        const indices: unknown[] = answer.selection;
        if (!indices.length || indices.length > maximum || new Set(indices).size !== indices.length) return '{}';
        const blocks = indices.map(index => {
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= options.length)
            throw Error('Unknown selection index.');
          return options[index].block;
        });
        return JSON.stringify({ version: 1, mode: 'answer', blocks });
      } catch {
        return '{}';
      }
    },
  };
}
