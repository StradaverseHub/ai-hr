import type { PrivateAssistantPayload } from './provider-assistant-policy';

const fields = { leave_available: 'available', leave_taken: 'taken', leave_pending: 'pending' } as const;

/** Select one explicit leave count from the same closed catalogue that a provider would see. */
export function selectProtectedLeaveCount(local: PrivateAssistantPayload) {
  if (local.operation !== 'conversation' || !Object.hasOwn(fields, local.intent)) return null;
  const field = fields[local.intent as keyof typeof fields];
  const [read] = local.reads;
  if (local.reads.length !== 1 || read.module !== 'leave' || read.cards.length !== 1) return null;
  const [card] = read.cards;
  const matches = card.facts.filter(fact => fact.available && fact.field === field);
  if (matches.length !== 1) return null;
  return { kind: 'fact' as const, read: read.read, card: card.card, fact: matches[0].fact };
}
