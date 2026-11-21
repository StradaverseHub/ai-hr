import { createHash } from 'node:crypto';
import { adjudicateAssistantAnswerPlan } from '../../lib/ai/assistant-answer-plan';
import { routingDigest } from '../../lib/ai/module-agent-routing';
import { adjudicatePrivateAssistantTerminal, privateAssistantCatalogue } from '../../lib/ai/provider-assistant-policy';
import type { PilotModel } from '../teras/leave-improvement';
import { evaluateProtectedAnswer, type ProtectedAnswerFixture } from './protected-answer-comparison';
import { PROTECTED_CATALOGUE_FORMAT } from './protected-catalogue-answer-format';
import { requireProtectedDevelopmentWinner } from './protected-development-winner';
import { protectedWorkSummarySplits } from './protected-work-summary-comparison';
import { guidanceContractDigest, isGuidance, protectedStrategyDigest, withProtectedGuidance } from './protected-work-summary-guidance';

export const PROTECTED_HOLDOUT_LIMIT_BYTES = 1024 * 1024;
export const PROTECTED_HOLDOUT_GENERATION_OPTIONS = Object.freeze({ temperature: 0, seed: 42, num_predict: 512 });
const holdoutContractDigest = routingDigest([guidanceContractDigest, PROTECTED_CATALOGUE_FORMAT, PROTECTED_HOLDOUT_GENERATION_OPTIONS]);
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

function addPriorExposure(previous: { report: Buffer; cases: Buffer }, reportDigest: string,
  parentDigest: string, modelDigest: string, seen: Set<string>) {
  const report = readFrozenHoldoutJson(previous.report, reportDigest);
  if (report?.evidence !== 'offline_protected_holdout' || report.contractDigest !== holdoutContractDigest ||
      report.releaseAuthorized !== false || report.meetsThreshold !== true || report.modelDigest !== modelDigest ||
      report.parentDigest !== protectedStrategyDigest([]) || report.candidateDigest !== parentDigest ||
      report.regressions !== 0 || report.candidateRejected !== 0 ||
      !Number.isSafeInteger(report.minimumGain) || report.minimumGain < 1 ||
      !Number.isSafeInteger(report.gains) || report.gains < report.minimumGain || report.gains > report.cases) return fail();
  const spec = readFrozenHoldoutJson(previous.cases, report.holdoutDigest);
  if (spec?.version !== 2 || spec.modelDigest !== modelDigest || spec.parentDigest !== report.parentDigest ||
      spec.candidateDigest !== parentDigest || spec.minimumGain !== report.minimumGain ||
      spec.developmentReportDigest !== report.developmentReportDigest ||
      !Array.isArray(spec.cases) || spec.cases.length !== report.cases || spec.cases.length < 2 || spec.cases.length > 32) return fail();
  for (const fixture of spec.cases) {
    const key = caseShape(projection(fixture));
    if (seen.has(key)) return fail();
    seen.add(key);
  }
}

/** The evaluator supplies a precommitted fictional case file. Only masked reference
 * metadata reaches the model. The result reports aggregate comparisons only. */
export async function scoreProtectedWorkSummaryHoldout(bytes: Buffer, expectedSha256: string,
  developmentReport: Buffer, modelDigest: string, model: PilotModel, previous?: { report: Buffer; cases: Buffer }) {
  const spec = readFrozenHoldoutJson(bytes, expectedSha256);
  const continuation = spec?.version === 3;
  const fields = ['candidateDigest', 'candidateRules', 'cases', 'developmentReportDigest', 'minimumGain',
    'modelDigest', 'parentDigest', 'parentRules', 'version'];
  if (continuation) fields.push('previousReportDigest');
  if (!spec || Object.keys(spec).sort().join(',') !== fields.sort().join(',') ||
      (!continuation && spec.version !== 2) || continuation !== Boolean(previous) ||
      !/^[a-f0-9]{64}$/.test(modelDigest) || spec.modelDigest !== modelDigest ||
      !Array.isArray(spec.cases) || spec.cases.length < 2 || spec.cases.length > 32 ||
      !Number.isSafeInteger(spec.minimumGain) || spec.minimumGain < 1 || spec.minimumGain > spec.cases.length) return fail();
  const parentRules = captureRules(spec.parentRules);
  const candidateRules = captureRules(spec.candidateRules);
  if (parentRules.length !== (continuation ? 1 : 0) || candidateRules.length !== parentRules.length + 1 ||
      !parentRules.every((rule, index) => rule === candidateRules[index]) ||
      protectedStrategyDigest(parentRules) !== spec.parentDigest ||
      protectedStrategyDigest(candidateRules) !== spec.candidateDigest) return fail();

  const { development, validation } = protectedWorkSummarySplits();
  requireProtectedDevelopmentWinner(readFrozenHoldoutJson(developmentReport, spec.developmentReportDigest), {
    modelDigest, parentRules, candidateRules, validationCases: validation.length,
    developmentCasesDigest: routingDigest(development), validationCasesDigest: routingDigest(validation),
  });
  const seen = new Set([...development, ...validation].map(fixture => caseShape(projection(fixture))));
  if (previous) addPriorExposure(previous, spec.previousReportDigest, spec.parentDigest, modelDigest, seen);
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
  const canonical = { correct: 0, rejected: 0, gains: 0, regressions: 0 };
  function recordUsage(result: Awaited<ReturnType<typeof evaluateProtectedAnswer>>) {
    usage.calls++;
    usage.inputTokens += result.inputTokens;
    usage.outputTokens += result.outputTokens;
  }
  for (const fixture of cases) {
    const previous = await evaluateProtectedAnswer(fixture, 'baseline_v1', parent);
    const next = await evaluateProtectedAnswer(fixture, 'baseline_v1', candidate);
    recordUsage(previous);
    recordUsage(next);
    const previousCorrect = previous.diagnostic.outcome === 'correct';
    const nextCorrect = next.diagnostic.outcome === 'correct';
    if (previousCorrect) scores.parentCorrect++;
    if (nextCorrect) scores.candidateCorrect++;
    if (previous.diagnostic.outcome === 'rejected') scores.parentRejected++;
    if (next.diagnostic.outcome === 'rejected') scores.candidateRejected++;
    if (!previousCorrect && nextCorrect) scores.gains++;
    if (previousCorrect && !nextCorrect) scores.regressions++;
    if (continuation) {
      const original = await evaluateProtectedAnswer(fixture, 'baseline_v1', model);
      recordUsage(original);
      const originalCorrect = original.diagnostic.outcome === 'correct';
      if (originalCorrect) canonical.correct++;
      if (original.diagnostic.outcome === 'rejected') canonical.rejected++;
      if (!originalCorrect && nextCorrect) canonical.gains++;
      if (originalCorrect && !nextCorrect) canonical.regressions++;
    }
  }
  const meetsThreshold = scores.gains >= spec.minimumGain && scores.regressions === 0 && scores.candidateRejected === 0 &&
    (!continuation || (canonical.gains >= spec.minimumGain && canonical.regressions === 0));
  return {
    evidence: 'offline_protected_holdout', releaseAuthorized: false, holdoutDigest: expectedSha256, modelDigest,
    contractDigest: holdoutContractDigest,
    developmentReportDigest: spec.developmentReportDigest,
    parentDigest: spec.parentDigest, candidateDigest: spec.candidateDigest, minimumGain: spec.minimumGain,
    cases: cases.length, ...scores, meetsThreshold, usage,
    ...(continuation ? { previousReportDigest: spec.previousReportDigest, canonical } : {}),
  };
}
