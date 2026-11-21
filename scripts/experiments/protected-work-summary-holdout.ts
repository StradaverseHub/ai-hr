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
const repetitions = 2;
const holdoutContractDigest = routingDigest([guidanceContractDigest, PROTECTED_CATALOGUE_FORMAT,
  PROTECTED_HOLDOUT_GENERATION_OPTIONS, repetitions, 'stable-case-comparison']);
const fail = (): never => { throw Error('Invalid frozen protected holdout.'); };
type AnswerOutcome = Awaited<ReturnType<typeof evaluateProtectedAnswer>>['diagnostic']['outcome'];

function recordCase(scores: {correct: number; rejected: number; gains: number; regressions: number},
  reference: readonly AnswerOutcome[], candidate: readonly AnswerOutcome[]) {
  const candidateStable = candidate.every(outcome => outcome === 'correct');
  if (reference.every(outcome => outcome === 'correct')) scores.correct++;
  if (reference.includes('rejected')) scores.rejected++;
  if (candidateStable && !reference.includes('correct')) scores.gains++;
  if (!candidateStable && reference.includes('correct')) scores.regressions++;
}

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
      report.releaseAuthorized !== false || report.meetsThreshold !== true || report.repetitions !== repetitions ||
      report.modelDigest !== modelDigest ||
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
  const arms = ([
    {name: 'parent', run: withProtectedGuidance(model, parentRules)},
    {name: 'candidate', run: withProtectedGuidance(model, candidateRules)},
    {name: 'canonical', run: model},
  ] as const).slice(0, continuation ? 3 : 2);
  const parent = { correct: 0, rejected: 0, gains: 0, regressions: 0 };
  const canonical = { correct: 0, rejected: 0, gains: 0, regressions: 0 };
  let candidateCorrect = 0;
  let candidateRejected = 0;
  const candidateCorrectByRepeat = Array<number>(repetitions).fill(0);
  function recordUsage(result: Awaited<ReturnType<typeof evaluateProtectedAnswer>>) {
    usage.calls++;
    usage.inputTokens += result.inputTokens;
    usage.outputTokens += result.outputTokens;
  }
  for (const [index, fixture] of cases.entries()) {
    const outcomes: Record<(typeof arms)[number]['name'], AnswerOutcome[]> = { parent: [], candidate: [], canonical: [] };
    for (let repeat = 0; repeat < repetitions; repeat++) {
      // Rotate the first arm across cases and again on the repeat.
      const start = (index + repeat) % arms.length;
      for (const arm of [...arms.slice(start), ...arms.slice(0, start)]) {
        const result = await evaluateProtectedAnswer(fixture, 'baseline_v1', arm.run);
        recordUsage(result);
        outcomes[arm.name].push(result.diagnostic.outcome);
      }
      if (outcomes.candidate[repeat] === 'correct') candidateCorrectByRepeat[repeat]++;
    }
    if (outcomes.candidate.every(outcome => outcome === 'correct')) candidateCorrect++;
    if (outcomes.candidate.includes('rejected')) candidateRejected++;
    recordCase(parent, outcomes.parent, outcomes.candidate);
    if (continuation) recordCase(canonical, outcomes.canonical, outcomes.candidate);
  }
  const meetsThreshold = parent.gains >= spec.minimumGain && parent.regressions === 0 && candidateRejected === 0 &&
    (!continuation || (canonical.gains >= spec.minimumGain && canonical.regressions === 0));
  return {
    evidence: 'offline_protected_holdout', releaseAuthorized: false, holdoutDigest: expectedSha256, modelDigest,
    contractDigest: holdoutContractDigest,
    developmentReportDigest: spec.developmentReportDigest,
    parentDigest: spec.parentDigest, candidateDigest: spec.candidateDigest, minimumGain: spec.minimumGain,
    cases: cases.length, repetitions, parentCorrect: parent.correct, parentRejected: parent.rejected,
    candidateCorrect, candidateRejected, candidateCorrectByRepeat, gains: parent.gains, regressions: parent.regressions,
    meetsThreshold, usage,
    ...(continuation ? { previousReportDigest: spec.previousReportDigest, canonical } : {}),
  };
}
