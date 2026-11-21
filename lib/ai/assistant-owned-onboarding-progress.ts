import type { AssistantAnswerPlan, AssistantExplanationCode } from './assistant-answer-plan';
import type { PrivateAssistantPayload } from './provider-assistant-policy';

const progressFindings: ReadonlySet<AssistantExplanationCode> = new Set([
  'specialist_finding:lifecycle_steps_remaining',
  'specialist_finding:lifecycle_progress_complete',
  'specialist_finding:lifecycle_progress_unknown',
]);

/** Select the completed and total counts from the same authorized native summary.
 * The lifecycle specialist owns the meaning of those counts. */
export function selectOwnOnboardingProgress(
  catalogue: PrivateAssistantPayload,
): Extract<AssistantAnswerPlan, { mode: 'answer' }> | undefined {
  if (catalogue.operation !== 'conversation' || catalogue.intent !== 'lifecycle') return;
  const [source] = catalogue.reads;
  if (catalogue.reads.length !== 1 || source.module !== 'lifecycle') return;

  const summaries = source.cards.filter(card => card.facts.some(fact =>
    fact.field === 'progressDone' || fact.field === 'progressTotal'));
  if (summaries.length !== 1) return;
  const [summary] = summaries;
  const done = summary.facts.filter(fact => fact.field === 'progressDone');
  const total = summary.facts.filter(fact => fact.field === 'progressTotal');
  const findings = source.explanations.filter(item => item.card === null && progressFindings.has(item.code));
  if (done.length !== 1 || total.length !== 1 || !done[0].available || !total[0].available || findings.length !== 1)
    return;

  return { version: 1, mode: 'answer', blocks: [
    { kind: 'fact', read: source.read, card: summary.card, fact: done[0].fact },
    { kind: 'fact', read: source.read, card: summary.card, fact: total[0].fact },
    { kind: 'explanation', read: source.read, card: null, code: findings[0].code },
  ] };
}
