import { createHash } from 'node:crypto';
import { adjudicateAssistantAnswerPlan } from '../../lib/ai/assistant-answer-plan';
import { routingDigest } from '../../lib/ai/module-agent-routing';
import { adjudicatePrivateAssistantTerminal, privateAssistantCatalogue } from '../../lib/ai/provider-assistant-policy';
import type { PilotModel } from '../teras/leave-improvement';
import { evaluateProtectedAnswer, type ProtectedAnswerFixture } from './protected-answer-comparison';
import { requireProtectedDevelopmentWinner } from './protected-development-winner';
import { protectedWorkSummarySplits } from './protected-work-summary-comparison';
import { isGuidance, protectedStrategyDigest, withProtectedGuidance } from './protected-work-summary-guidance';

export const PROTECTED_HOLDOUT_LIMIT_BYTES = 1024 * 1024;
const fail = (): never => { throw Error('Invalid frozen protected holdout.'); };

export function readFrozenHoldoutJson(bytes: Buffer, digest: unknown) {
  if (!bytes.length || bytes.length > PROTECTED_HOLDOUT_LIMIT_BYTES ||
      createHash('sha256').update(bytes).digest('hex') !== digest) return fail();
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { return fail(); }
}

function captureRules(value: unknown) {
  if (!Array.isArray(value) || !value.every(isGuidance) || new Set(value).size !== value.length) return fail();
  return value;
}

function projection(fixture: ProtectedAnswerFixture) {
  return privateAssistantCatalogue(fixture.intent, fixture.reads, 'baseline_v1', fixture.selected.selection);
}

function caseShape(local: ReturnType<typeof projection>) {
  if (local.operation !== 'conversation') return fail();
  // Reordering references changes their ordinals but supplies the same evidence.
  return routingDigest({ intent: local.intent, reads: local.reads.map(read => routingDigest({
    module: read.module,
    cards: read.cards.map(card => routingDigest({
      facts: card.facts.map(({ field, available }) => `${field}:${available}`).sort(),
      explanations: read.explanations.filter(option => option.card === card.card).map(option => option.code).sort(),
    })).sort(),
    explanations: read.explanations.filter(option => option.card === null).map(option => option.code).sort(),
  })).sort() });
}

/** The evaluator supplies a precommitted fictional case file. Only masked reference
 * metadata reaches the model. The result reports aggregate comparisons only. */
export async function scoreProtectedWorkSummaryHoldout(bytes: Buffer, expectedSha256: string,
  developmentReport: Buffer, modelDigest: string, model: PilotModel) {
  const spec = readFrozenHoldoutJson(bytes, expectedSha256);
  if (!spec || Object.keys(spec).sort().join(',') !==
      'candidateDigest,candidateRules,cases,developmentReportDigest,minimumGain,modelDigest,parentDigest,parentRules,version' ||
      spec.version !== 2 || !/^[a-f0-9]{64}$/.test(modelDigest) || spec.modelDigest !== modelDigest ||
      !Array.isArray(spec.cases) || spec.cases.length < 2 || spec.cases.length > 32 ||
      !Number.isSafeInteger(spec.minimumGain) || spec.minimumGain < 1 || spec.minimumGain > spec.cases.length) return fail();
  const parentRules = captureRules(spec.parentRules);
  const candidateRules = captureRules(spec.candidateRules);
  if (candidateRules.length !== parentRules.length + 1 ||
      !parentRules.every((rule, index) => rule === candidateRules[index]) ||
      protectedStrategyDigest(parentRules) !== spec.parentDigest ||
      protectedStrategyDigest(candidateRules) !== spec.candidateDigest) return fail();

  const { development, validation } = protectedWorkSummarySplits();
  requireProtectedDevelopmentWinner(readFrozenHoldoutJson(developmentReport, spec.developmentReportDigest), {
    modelDigest, parentRules, candidateRules, validationCases: validation.length,
    developmentCasesDigest: routingDigest(development), validationCasesDigest: routingDigest(validation),
  });
  const seen = new Set([...development, ...validation].map(fixture => caseShape(projection(fixture))));
  const ids = new Set<string>();
  const cases: ProtectedAnswerFixture[] = spec.cases;
  // Validate the complete file and reject exposed or repeated projections before any call.
  for (const fixture of cases) {
    if (!fixture || typeof fixture.id !== 'string' || !/^[a-z0-9][a-z0-9:_-]{0,79}$/.test(fixture.id) ||
        ids.has(fixture.id) || !['attendance', 'lifecycle', 'toil', 'notifications'].includes(fixture.intent)) return fail();
    let local;
    try {
      local = projection(fixture);
      const expected = adjudicateAssistantAnswerPlan(fixture.expected, fixture.reads);
      if (expected.mode !== 'answer') return fail();
      adjudicatePrivateAssistantTerminal(JSON.stringify(expected), local);
    } catch { return fail(); }
    const key = caseShape(local);
    if (seen.has(key)) throw Error('Holdout repeats an exposed or previously listed answer catalogue.');
    seen.add(key);
    ids.add(fixture.id);
  }

  const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  const parent = withProtectedGuidance(model, parentRules);
  const candidate = withProtectedGuidance(model, candidateRules);
  const scores = { parentCorrect: 0, candidateCorrect: 0, parentRejected: 0, candidateRejected: 0, gains: 0, regressions: 0 };
  for (const fixture of cases) {
    const previous = await evaluateProtectedAnswer(fixture, 'baseline_v1', parent);
    const next = await evaluateProtectedAnswer(fixture, 'baseline_v1', candidate);
    usage.calls += 2;
    usage.inputTokens += previous.inputTokens + next.inputTokens;
    usage.outputTokens += previous.outputTokens + next.outputTokens;
    const previousCorrect = previous.diagnostic.outcome === 'correct';
    const nextCorrect = next.diagnostic.outcome === 'correct';
    if (previousCorrect) scores.parentCorrect++;
    if (nextCorrect) scores.candidateCorrect++;
    if (previous.diagnostic.outcome === 'rejected') scores.parentRejected++;
    if (next.diagnostic.outcome === 'rejected') scores.candidateRejected++;
    if (!previousCorrect && nextCorrect) scores.gains++;
    if (previousCorrect && !nextCorrect) scores.regressions++;
  }
  const meetsThreshold = scores.gains >= spec.minimumGain && scores.regressions === 0 && scores.candidateRejected === 0;
  return {
    evidence: 'offline_protected_holdout', releaseAuthorized: false, holdoutDigest: expectedSha256, modelDigest,
    developmentReportDigest: spec.developmentReportDigest,
    parentDigest: spec.parentDigest, candidateDigest: spec.candidateDigest, minimumGain: spec.minimumGain,
    cases: cases.length, ...scores, meetsThreshold, usage,
  };
}
