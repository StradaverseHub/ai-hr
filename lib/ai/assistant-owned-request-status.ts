import { ANSWER_PLAN_LIMITS, type AssistantAnswerBlock, type AssistantAnswerPlan } from './assistant-answer-plan';
import type { PrivateAssistantPayload } from './provider-assistant-policy';

const statusSources = {
  claim_statuses: { module: 'claims', date: 'incurredOn' },
  leave_requests: { module: 'approvals', date: 'from' },
} as const;
type StatusIntent = keyof typeof statusSources;

export function isOwnRequestStatusIntent(intent: string): intent is StatusIntent {
  return Object.hasOwn(statusSources, intent);
}

/** Summarize the statuses in the already scoped source order. Dates distinguish
 * records when space permits. Never drop a status to fit a date. */
export function selectOwnRequestStatuses(
  catalogue: PrivateAssistantPayload,
): Extract<AssistantAnswerPlan, { mode: 'answer' }> | undefined {
  if (catalogue.operation !== 'conversation' || !isOwnRequestStatusIntent(catalogue.intent)) return;
  const { module, date } = statusSources[catalogue.intent];
  const [source] = catalogue.reads;
  if (catalogue.reads.length !== 1 || source.module !== module ||
      source.cards.length === 0 || source.cards.length > ANSWER_PLAN_LIMITS.blocks) return;

  const includeDates = source.cards.length * 2 <= ANSWER_PLAN_LIMITS.blocks;
  const blocks: AssistantAnswerBlock[] = [];
  for (const card of source.cards) {
    const statuses = card.facts.filter(fact => fact.field === 'status');
    if (statuses.length !== 1 || !statuses[0].available) return;
    blocks.push({ kind: 'fact', read: source.read, card: card.card, fact: statuses[0].fact });
    if (includeDates) {
      const dates = card.facts.filter(fact => fact.field === date);
      if (dates.length === 1 && dates[0].available)
        blocks.push({ kind: 'fact', read: source.read, card: card.card, fact: dates[0].fact });
    }
  }
  return { version: 1, mode: 'answer', blocks };
}
