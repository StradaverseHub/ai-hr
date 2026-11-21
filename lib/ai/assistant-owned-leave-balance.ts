import type { AssistantAnswerPlan } from './assistant-answer-plan';
import type { PrivateAssistantPayload } from './provider-assistant-policy';

const leaveFields = {
  leave_available: 'available',
  leave_taken: 'taken',
  leave_pending: 'pending',
} as const;
type LeaveBalanceIntent = keyof typeof leaveFields;

export function isOwnLeaveBalanceIntent(intent: string): intent is LeaveBalanceIntent {
  return Object.hasOwn(leaveFields, intent);
}

/** Only select references in the caller's already-scoped catalogue. An absent
 * or ambiguous requested field cannot authorize a substitute field or card. */
export function selectOwnLeaveBalance(
  catalogue: PrivateAssistantPayload,
): Extract<AssistantAnswerPlan, { mode: 'answer' }> | undefined {
  if (catalogue.operation !== 'conversation' || !isOwnLeaveBalanceIntent(catalogue.intent)) return;
  const field = leaveFields[catalogue.intent];
  const [source] = catalogue.reads;
  if (catalogue.reads.length !== 1 || source.module !== 'leave' || source.cards.length !== 1) return;
  const [card] = source.cards;
  const requested = card.facts.filter(fact => fact.field === field);
  if (requested.length !== 1 || !requested[0].available) return;
  return { version: 1, mode: 'answer', blocks: [{ kind: 'fact', read: source.read, card: card.card, fact: requested[0].fact }] };
}
