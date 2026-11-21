import { z } from 'zod';
import { adjudicateAssistantAnswerPlan } from '../../lib/ai/assistant-answer-plan';
import { presentGroundedToolOutcome } from '../../lib/ai/grounded-tool-presentation';
import { leaveEvaluationCaseSetDigest } from '../../lib/ai/assistant-leave-evaluation-receipt';
import { routingDigest } from '../../lib/ai/module-agent-routing';
import {
  adjudicatePrivateAssistantTerminal, privateAssistantCatalogue, resolvePrivateAssistantClarifiedIntent,
  resolvePrivateAssistantContextualIntent, resolvePrivateAssistantProposal, selectPrivateAssistantCards, type PrivateAssistantClarification,
} from '../../lib/ai/provider-assistant-policy';
import { selectProtectedLeaveCount } from '../../lib/ai/assistant-leave-count';
import { readFrozenHoldoutJson } from './protected-work-summary-holdout';
import { evaluateProtectedAnswer } from './protected-answer-comparison';
import type { PilotModel } from '../teras/leave-improvement';

const label = z.string().trim().min(1).max(160);
const wording = z.string().trim().min(1).max(300);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const field = z.enum(['available', 'taken', 'pending']);
const count = z.number().finite().min(-10000).max(10000);
const leave = z.object({
  leaveType: label, available: count.nullable(), taken: count.nullable(), pending: count.nullable(),
  withheld: z.boolean(),
}).strict();

const scenario = z.object({
  question: wording,
  clarification: z.object({ slot: z.enum(['employment', 'leave_type']), answer: wording }).strict().optional(),
  employments: z.array(z.object({ company: label, balances: z.array(leave).min(1).max(6) }).strict()).max(4),
}).strict();
const expected = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct'), employment: z.number().int().min(0).max(3),
    balance: z.number().int().min(0).max(5), field, value: count }).strict(),
  z.object({ kind: z.literal('defer') }).strict(),
]);
const casesSchema = z.array(z.object({ scenario, expected }).strict()).min(4).max(32);
const holdout = z.object({ version: z.literal(1), candidateSha: sha, cases: casesSchema }).strict();
const pairedHoldout = z.object({
  version: z.literal(2), candidateSha: sha, cases: casesSchema,
  modelDigest: z.string().regex(/^[a-f0-9]{64}$/), minimumSavedCalls: z.number().int().min(1).max(32),
}).strict();

const normalizedText = (value: string) => value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');

function caseDigests(cases: z.infer<typeof casesSchema>) {
  const digests = cases.map(({ scenario: input }) => routingDigest(['aihr.assistant.leave-evaluation-case.v1', {
    question: normalizedText(input.question),
    clarification: input.clarification ? [input.clarification.slot, normalizedText(input.clarification.answer)] : null,
    employments: input.employments.map(({ company, balances }) => [
      normalizedText(company),
      balances.map(row => [normalizedText(row.leaveType), row.available, row.taken, row.pending, row.withheld]),
    ]),
  }])).sort();
  if (new Set(digests).size !== cases.length) throw Error('Use distinct fictional scenarios covering direct answers and deferrals.');
  return digests;
}

/** Private preregistration material. Keep the per-scenario digests with the coordinator. */
export function describePairedLeaveRoutingCases(bytes: Buffer, holdoutDigest: string) {
  const parsed = pairedHoldout.parse(readFrozenHoldoutJson(bytes, holdoutDigest));
  return { holdoutDigest, caseDigests: caseDigests(parsed.cases) };
}

function project(input: z.infer<typeof scenario>) {
  const clarification: PrivateAssistantClarification | null = input.clarification
    ? { ...input.clarification, originalQuestion: input.question, earlier: [] } : null;
  if (resolvePrivateAssistantProposal(clarification?.answer ?? input.question)) return null;
  const { intent } = clarification ? resolvePrivateAssistantClarifiedIntent(clarification)
    : resolvePrivateAssistantContextualIntent(input.question, []);
  if (intent !== 'leave_available' && intent !== 'leave_taken' && intent !== 'leave_pending') return null;

  const employments = input.employments.map((row, index) => ({ ...row, employmentId: `fixture-own-${index}` }));
  const presentation = presentGroundedToolOutcome('my_leave_balances', { ok: true, employments });
  if (!presentation) return null;
  const cards = employments.flatMap((row, employment) => row.balances.map((_, balance) => ({
    employment, balance, key: row.employmentId, labels: [row.company],
  })));
  if (presentation.cards.length !== cards.length) throw Error('Unexpected canonical fixture projection.');
  const reads = [{ read: 0, presentation, explanations: [] }];
  const selection = selectPrivateAssistantCards(intent, reads, clarification, cards.map((row, card) => ({ ...row, read: 0, card })));
  if (selection.slot) return null;
  const catalogue = privateAssistantCatalogue(intent, reads, 'baseline_v1', selection.selection);
  return { intent, reads, selected: selection, catalogue, cards, presentation };
}

function observe(source: ReturnType<typeof project>): z.infer<typeof expected> {
  const defer = { kind: 'defer' } as const;
  if (!source) return defer;
  const { catalogue, reads, cards, presentation } = source;
  const block = selectProtectedLeaveCount(catalogue);
  if (!block) return defer;
  adjudicateAssistantAnswerPlan(adjudicatePrivateAssistantTerminal(JSON.stringify({
    version: 1, mode: 'answer', blocks: [block],
  }), catalogue), reads);
  const { employment, balance } = cards[block.card];
  const fact = presentation.cards[block.card].facts[block.fact];
  return { kind: 'direct', employment, balance, field: field.parse(fact.field), value: count.parse(fact.value) };
}

/** Score a precommitted fictional suite. The report carries neither individual results nor case contents. */
function scoreCases(cases: z.infer<typeof casesSchema>, requireOneEmployment = false) {
  const expectedDirect = cases.filter(row => row.expected.kind === 'direct').length;
  if (expectedDirect < 2 || cases.length - expectedDirect < 2)
    throw Error('Use distinct fictional scenarios covering direct answers and deferrals.');
  const fingerprints = caseDigests(cases);

  const scores = { correctDirect: 0, correctDeferrals: 0, wrongDirect: 0, unexpectedDirect: 0, missedDirect: 0 };
  const paired = cases.map(item => {
    const source = project(item.scenario);
    const observed = observe(requireOneEmployment && item.scenario.employments.length !== 1 ? null : source);
    const correct = routingDigest(item.expected) === routingDigest(observed);
    if (item.expected.kind === 'defer') {
      if (observed.kind === 'defer') scores.correctDeferrals++;
      else scores.unexpectedDirect++;
    } else if (observed.kind === 'defer') scores.missedDirect++;
    else if (correct) scores.correctDirect++;
    else scores.wrongDirect++;
    return { ...item, source, observed, correct };
  });
  return { paired, fingerprints, result: { cases: cases.length, expectedDirect,
    ...scores, meetsThreshold: scores.correctDirect + scores.correctDeferrals === cases.length } };
}

export function scoreProtectedLeaveRoutingHoldout(bytes: Buffer, holdoutDigest: string, candidateSha: string) {
  const parsed = holdout.safeParse(readFrozenHoldoutJson(bytes, holdoutDigest));
  if (!parsed.success || parsed.data.candidateSha !== candidateSha) throw Error('Invalid frozen leave routing suite.');
  return { evidence: 'offline_leave_routing_holdout', candidateSha, holdoutDigest,
    ...scoreCases(parsed.data.cases).result, releaseAuthorized: false };
}

/** Compare actual masked baseline calls on direct cases. Deferral cases are evaluated locally and continue
 * through the same baseline by design. Validate all expected answer references before starting transport. */
export async function scorePairedLeaveRoutingHoldout(bytes: Buffer, holdoutDigest: string, candidateSha: string,
  modelDigest: string, model: PilotModel) {
  const parsed = pairedHoldout.safeParse(readFrozenHoldoutJson(bytes, holdoutDigest));
  if (!parsed.success || parsed.data.candidateSha !== candidateSha || parsed.data.modelDigest !== modelDigest)
    throw Error('Invalid frozen paired leave suite.');
  const { paired, fingerprints, result } = scoreCases(parsed.data.cases, true);
  const { minimumSavedCalls } = parsed.data;
  if (minimumSavedCalls > result.expectedDirect) throw Error('Saved-call target exceeds the direct case count.');
  const comparisons = paired.flatMap(({ scenario, expected, source, observed, correct }, index) => {
    if (expected.kind !== 'direct') return [];
    if (scenario.employments.length !== 1) throw Error('Expected direct answer exceeds the trial employment scope.');
    if (!source) throw Error('Expected direct answer has no verified source.');
    const card = source.cards.findIndex(row => row.employment === expected.employment && row.balance === expected.balance);
    const fact = card < 0 ? -1 : source.presentation.cards[card].facts.findIndex(row => row.field === expected.field && row.value === expected.value);
    if (fact < 0) throw Error('Expected direct answer has no verified source.');
    const plan = { version: 1, mode: 'answer', blocks: [{ kind: 'fact', read: 0, card, fact }] };
    adjudicateAssistantAnswerPlan(adjudicatePrivateAssistantTerminal(JSON.stringify(plan), source.catalogue), source.reads);
    return [{ fixture: { id: String(index), intent: source.intent, reads: source.reads, selected: source.selected, expected: plan }, observed, correct }];
  });
  const comparison = { baselineCalls: 0, baselineCorrect: 0, baselineRejected: 0, candidateFallbackCalls: 0,
    candidateCorrect: 0, gains: 0, regressions: 0, savedCalls: 0, baselineInputTokens: 0, baselineOutputTokens: 0 };
  for (const { fixture, observed, correct } of comparisons) {
    const baseline = await evaluateProtectedAnswer(fixture, 'baseline_v1', model);
    const baselineCorrect = baseline.diagnostic.outcome === 'correct';
    const defers = observed.kind === 'defer';
    const candidateCorrect = defers ? baselineCorrect : correct;
    comparison.baselineCalls++;
    comparison.baselineInputTokens += baseline.inputTokens;
    comparison.baselineOutputTokens += baseline.outputTokens;
    if (baselineCorrect) comparison.baselineCorrect++;
    if (baseline.diagnostic.outcome === 'rejected') comparison.baselineRejected++;
    if (defers) comparison.candidateFallbackCalls++;
    if (candidateCorrect) comparison.candidateCorrect++;
    if (!baselineCorrect && candidateCorrect) comparison.gains++;
    if (baselineCorrect && !candidateCorrect) comparison.regressions++;
    if (!defers && correct) comparison.savedCalls++;
  }
  return { evidence: 'offline_paired_leave_routing_holdout', scope: 'single_active_own_employment', candidateSha, holdoutDigest, modelDigest, minimumSavedCalls,
    caseSetDigest: leaveEvaluationCaseSetDigest(fingerprints), ...result, ...comparison, meetsThreshold: result.meetsThreshold && comparison.regressions === 0 && comparison.savedCalls >= minimumSavedCalls,
    releaseAuthorized: false };
}
