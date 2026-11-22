import { normalizePrivateAssistantSelectionLabel, type PrivateAssistantClarification,
  type PrivateAssistantLocalEmployment, type PrivateAssistantPayload } from './provider-assistant-policy';

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

export type LeaveTrialEmployment = Readonly<{ employmentId: string; company: string }>;
export type LeaveTrialScope = 'single_employment' | 'explicit_employment';

export function selectTrialLeaveCount(local: PrivateAssistantPayload, scope: LeaveTrialScope,
  roster: readonly LeaveTrialEmployment[], cardEmployments: readonly PrivateAssistantLocalEmployment[],
  clarification: PrivateAssistantClarification | null) {
  if (roster.length === 0) return null;
  const block = selectProtectedLeaveCount(local);
  if (!block || roster.length === 1) return block;
  if (scope !== 'explicit_employment' || clarification?.slot !== 'employment') return null;

  const choice = normalizePrivateAssistantSelectionLabel(clarification.answer);
  if (!choice) return null;
  // Match the full roster. Another employment with the same company label can have no visible cards.
  const matching = roster.filter(row => normalizePrivateAssistantSelectionLabel(row.company) === choice);
  if (matching.length !== 1) return null;
  const card = cardEmployments.find(row => row.read === block.read && row.card === block.card);
  return card?.key === matching[0].employmentId ? block : null;
}
