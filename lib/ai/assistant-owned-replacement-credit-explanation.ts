import type { AssistantAnswerPlan, AssistantExplanationCode } from './assistant-answer-plan';
import type { PrivateAssistantPayload } from './provider-assistant-policy';

const explanations = {
  expired: 'specialist_finding:credit_expired_not_available',
  converted: 'specialist_finding:credit_pay_conversion_not_payslip',
} as const satisfies Record<string, AssistantExplanationCode>;
export type ReplacementCreditFocus = keyof typeof explanations;

const phrases = new Map<string, ReplacementCreditFocus>([
  ["why can't i use my expired replacement credits", 'expired'],
  ['why can’t i use my expired replacement credits', 'expired'],
  ['why are my expired replacement credits unavailable', 'expired'],
  ['does my replacement credit conversion mean i was paid', 'converted'],
  ['does my replacement credit conversion prove payment', 'converted'],
]);

export function ownReplacementCreditFocus(normalizedQuestion: string): ReplacementCreditFocus | undefined {
  return phrases.get(normalizedQuestion);
}

/** A recorded finding for the authorized own ledger can answer the specific
 * question. The other finding cannot substitute for missing evidence. */
export function selectOwnReplacementCreditExplanation(catalogue: PrivateAssistantPayload, focus: ReplacementCreditFocus):
  Extract<AssistantAnswerPlan, { mode: 'answer' }> | undefined {
  if (catalogue.operation !== 'conversation' || catalogue.intent !== 'toil' || catalogue.reads.length !== 1) return;
  const [source] = catalogue.reads;
  const code = explanations[focus];
  if (source.module !== 'toil' || !source.explanations.some(item => item.card === null && item.code === code)) return;
  return { version: 1, mode: 'answer', blocks: [{ kind: 'explanation', read: source.read, card: null, code }] };
}
