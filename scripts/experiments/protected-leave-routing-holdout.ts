import { z } from 'zod';
import { adjudicateAssistantAnswerPlan } from '../../lib/ai/assistant-answer-plan';
import { presentGroundedToolOutcome } from '../../lib/ai/grounded-tool-presentation';
import { routingDigest } from '../../lib/ai/module-agent-routing';
import {
  adjudicatePrivateAssistantTerminal, privateAssistantCatalogue, resolvePrivateAssistantClarifiedIntent,
  resolvePrivateAssistantContextualIntent, resolvePrivateAssistantProposal, selectPrivateAssistantCards, type PrivateAssistantClarification,
} from '../../lib/ai/provider-assistant-policy';
import { selectProtectedLeaveCount } from './protected-leave-comparison';
import { readFrozenHoldoutJson } from './protected-work-summary-holdout';

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
const holdout = z.object({
  version: z.literal(1), candidateSha: sha,
  cases: z.array(z.object({ scenario, expected }).strict()).min(4).max(32),
}).strict();

function observe(input: z.infer<typeof scenario>): z.infer<typeof expected> {
  const defer = { kind: 'defer' } as const;
  const clarification: PrivateAssistantClarification | null = input.clarification
    ? { ...input.clarification, originalQuestion: input.question, earlier: [] } : null;
  if (resolvePrivateAssistantProposal(clarification?.answer ?? input.question)) return defer;
  const { intent } = clarification ? resolvePrivateAssistantClarifiedIntent(clarification)
    : resolvePrivateAssistantContextualIntent(input.question, []);
  if (intent !== 'leave_available' && intent !== 'leave_taken' && intent !== 'leave_pending') return defer;

  const employments = input.employments.map((row, index) => ({ ...row, employmentId: `fixture-own-${index}` }));
  const presentation = presentGroundedToolOutcome('my_leave_balances', { ok: true, employments });
  if (!presentation) return defer;
  const cards = employments.flatMap((row, employment) => row.balances.map((_, balance) => ({
    employment, balance, key: row.employmentId, labels: [row.company],
  })));
  if (presentation.cards.length !== cards.length) throw Error('Unexpected canonical fixture projection.');
  const reads = [{ read: 0, presentation, explanations: [] }];
  const selection = selectPrivateAssistantCards(intent, reads, clarification, cards.map((row, card) => ({ ...row, read: 0, card })));
  if (selection.slot) return defer;
  const catalogue = privateAssistantCatalogue(intent, reads, 'baseline_v1', selection.selection);
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
export function scoreProtectedLeaveRoutingHoldout(bytes: Buffer, holdoutDigest: string, candidateSha: string) {
  const parsed = holdout.safeParse(readFrozenHoldoutJson(bytes, holdoutDigest));
  if (!parsed.success || parsed.data.candidateSha !== candidateSha) throw Error('Invalid frozen leave routing suite.');
  const cases = parsed.data.cases;
  const expectedDirect = cases.filter(row => row.expected.kind === 'direct').length;
  if (expectedDirect < 2 || cases.length - expectedDirect < 2 ||
      new Set(cases.map(row => routingDigest(row.scenario))).size !== cases.length)
    throw Error('Use distinct fictional scenarios covering direct answers and deferrals.');

  const scores = { correctDirect: 0, correctDeferrals: 0, wrongDirect: 0, unexpectedDirect: 0, missedDirect: 0 };
  for (const item of cases) {
    const observed = observe(item.scenario);
    if (item.expected.kind === 'defer') {
      if (observed.kind === 'defer') scores.correctDeferrals++;
      else scores.unexpectedDirect++;
    } else if (observed.kind === 'defer') scores.missedDirect++;
    else if (routingDigest(item.expected) === routingDigest(observed)) scores.correctDirect++;
    else scores.wrongDirect++;
  }
  return { evidence: 'offline_leave_routing_holdout', candidateSha, holdoutDigest, cases: cases.length, expectedDirect,
    ...scores, meetsThreshold: scores.correctDirect + scores.correctDeferrals === cases.length, releaseAuthorized: false };
}
