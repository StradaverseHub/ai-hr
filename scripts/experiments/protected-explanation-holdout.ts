import { z } from 'zod';
import { AGENT_MODULE_CODES } from '../../lib/ai/module-agents';
import { routingDigest } from '../../lib/ai/module-agent-routing';
import { SPECIALIST_HOLDOUTS } from '../../lib/ai/module-specialist-holdouts';
import { SPECIALIST_FINDINGS } from '../../lib/ai/module-specialists';
import en from '../../messages/en.json';
import ms from '../../messages/ms.json';
import type { PilotModel } from '../teras/leave-improvement';
import {
  choose, EXPLANATION_ANSWER_FORMAT, EXPLANATION_GENERATION_OPTIONS, explanationCases, observeModel, type ExplanationCase,
} from './protected-explanation-priority';
import { readFrozenHoldoutJson } from './protected-work-summary-holdout';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const finding = z.enum(SPECIALIST_FINDINGS).refine(value => value !== 'scope_current_caller');
const explanationCase = z.strictObject({
  module: z.enum(AGENT_MODULE_CODES),
  choices: z.array(finding).min(2).max(8),
  focus: z.string().min(8).max(180).regex(/^[\p{L}\p{M} '?.,’\-]+$/u),
  expected: finding,
});
const holdout = z.strictObject({
  version: z.literal(1),
  locale: z.enum(['en', 'ms']).optional(),
  modelDigest: digest,
  developmentReportDigest: digest,
  minimumGain: z.number().int().min(1),
  cases: z.array(explanationCase).min(4).max(32),
});

const freshPlan = z.strictObject({
  version: z.literal(1),
  minimumMargin: z.literal(5),
  englishSha256: digest,
  malaySha256: digest,
});

// These were inspected before the margin was selected, including the same-author challenge.
const EXPLANATION_ROUTING_EXPOSURES = Object.freeze({
  english: 'f9bb960dc5820c6341c64ada9751720c91ce157bdfd718689877facf9dc95028',
  malay: '461a48971f6b590f309c7553724bc7d77584c1fb2b094ce5daba168c5997dc24',
  challenge: 'e5cc3268ec367856ce402f83b6e5b2d1483b4c6ca09e816731df664934e4b4b4',
});

const score = z.strictObject({ correct: z.number().int().min(0), rejected: z.number().int().min(0) });
const developmentReportSchema = z.object({
  evidence: z.literal('offline_explanation_revision_development'),
  releaseAuthorized: z.literal(false),
  modelDigest: digest,
  answerFormatDigest: digest,
  generationOptions: z.strictObject({ temperature: z.literal(0), seed: z.literal(42), num_predict: z.literal(512) }),
  developmentDigest: digest,
  validationDigest: digest,
  validationCases: z.number().int().min(1),
  revision: z.literal('include_source_focus'),
  advanced: z.literal(true),
  baseline: score,
  candidate: score,
  regressions: z.literal(0),
});

const normalize = (text: string) => text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{M}]+/gu) ?? [];
const catalogue = ({ module, choices }: ExplanationCase) => routingDigest([module, [...choices].sort()]);
const findings: Record<'en' | 'ms', Record<string, string>> = {
  en: en.assistant.workspace.specialistFindings,
  ms: ms.assistant.workspace.specialistFindings,
};
const commonWords = {
  en: new Set('a an and are as at been but by can does for from has have i in is it its not of on or that the this to was were with you your'.split(' ')),
  ms: new Set('adakah apakah atau bagi boleh dalam dan dengan di daripada ini itu ke kepada pada saya serta tidak untuk yang'.split(' ')),
};
const terms = (text: string, locale: 'en' | 'ms') => new Set(normalize(text).filter(word => !commonWords[locale].has(word)));

function recordComparison(evidence: {gains: number; regressions: number}, passed: boolean, referencePassed: boolean) {
  if (passed && !referencePassed) evidence.gains++;
  if (!passed && referencePassed) evidence.regressions++;
}

function deterministicChoice({ choices, focus }: ExplanationCase, locale: 'en' | 'ms') {
  const words = terms(focus, locale);
  const documents = choices.map(choice => {
    const finding = choice.slice('specialist_finding:'.length);
    return { choice, words: terms(finding + ' ' + findings[locale][finding], locale) };
  });
  const frequencies = new Map<string, number>();
  for (const document of documents) for (const word of document.words) frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
  const ranked = documents.map(({ choice, words: document }) => ({
    choice,
    overlap: [...words].reduce((sum, word) => document.has(word) ? sum + documents.length + 1 - frequencies.get(word)! : sum, 0),
  })).sort((a, b) => b.overlap - a.overlap);
  const margin = ranked[0].overlap - ranked[1].overlap;
  return {choice: margin > 0 ? ranked[0].choice : null, margin};
}

function prepareExplanationHoldout(bytes: Buffer, expectedSha: string, developmentReport: Buffer, modelDigest: string) {
  const parsedSpec = holdout.safeParse(readFrozenHoldoutJson(bytes, expectedSha));
  if (!parsedSpec.success) throw Error('Invalid frozen explanation holdout.');
  const spec = parsedSpec.data;
  const locale = spec.locale ?? 'en';
  const parsedReport = developmentReportSchema.safeParse(readFrozenHoldoutJson(developmentReport, spec.developmentReportDigest));
  if (!parsedReport.success) throw Error('Invalid frozen explanation development report.');
  const report = parsedReport.data;
  const publicCases = explanationCases();
  const development = publicCases.filter(row => row.module !== 'toil');
  const validation = publicCases.filter(row => row.module === 'toil');
  if (spec.modelDigest !== modelDigest || report.modelDigest !== modelDigest ||
      report.answerFormatDigest !== routingDigest(EXPLANATION_ANSWER_FORMAT) ||
      routingDigest(report.generationOptions) !== routingDigest(EXPLANATION_GENERATION_OPTIONS) ||
      report.developmentDigest !== routingDigest(development) || report.validationDigest !== routingDigest(validation) ||
      report.validationCases !== validation.length || report.baseline.correct + report.baseline.rejected > validation.length ||
      report.candidate.correct > validation.length || report.candidate.rejected !== 0 ||
      report.candidate.correct <= report.baseline.correct || spec.minimumGain > spec.cases.length)
    throw Error('The frozen explanation report does not bind a winning revision for this evaluator.');

  const exposed = new Set(publicCases.map(catalogue));
  const freshCatalogues = new Set<string>();
  const seen = new Set<string>();
  const cases: ExplanationCase[] = spec.cases.map(row => {
    const allowed = new Set(SPECIALIST_HOLDOUTS.filter(fixture => fixture.module === row.module).flatMap(fixture => fixture.expected));
    if (new Set(row.choices).size !== row.choices.length || !row.choices.includes(row.expected) ||
        row.choices.some(choice => !allowed.has(choice) || !findings[locale][choice]))
      throw Error('Invalid specialist selection catalogue or missing localized finding.');
    const fixture = {
      ...row,
      choices: row.choices.map(choice => `specialist_finding:${choice}` as const),
      expected: `specialist_finding:${row.expected}` as const,
    };
    const key = catalogue(fixture);
    const caseKey = routingDigest([key, normalize(fixture.focus)]);
    if (exposed.has(key) || seen.has(caseKey)) throw Error('Explanation holdout reuses an exposed catalogue or repeated case.');
    freshCatalogues.add(key);
    seen.add(caseKey);
    return fixture;
  });
  if (freshCatalogues.size < 2) throw Error('Use at least two distinct fresh explanation catalogues.');
  return {spec, locale, cases, expectedSha};
}

async function evaluateExplanationHoldout(prepared: ReturnType<typeof prepareExplanationHoldout>, model: PilotModel,
  margins: readonly number[], execution: 'replay' | 'direct' = 'replay') {
  const {spec, locale, cases, expectedSha} = prepared;
  const { call, budget } = observeModel(model);
  const fixedChoices = cases.map(fixture => deterministicChoice(fixture, locale));
  const routedRun = execution === 'direct' ? observeModel(model) : null;
  const directlyRouted: Awaited<ReturnType<typeof choose>>[] = [];
  if (routedRun) {
    if (margins.length !== 1) throw Error('Direct routing requires a single frozen margin.');
    // Run the route before the reference arms. A deterministic return never invokes the model.
    for (const [index, fixture] of cases.entries()) {
      const {choice, margin} = fixedChoices[index];
      directlyRouted.push(margin < margins[0]
        ? await choose(routedRun.call, fixture, true)
        : choice === fixture.expected ? 'correct' : 'incorrect');
    }
  }
  const original = { correct: 0, rejected: 0, gains: 0, regressions: 0 };
  const deterministic = { correct: 0, abstained: 0, gains: 0, regressions: 0 };
  const candidate = { correct: 0, rejected: 0 };
  const retrievalMargins = margins.map(minimumMargin => ({
    minimumMargin,
    correct: 0, rejected: 0, modelCalls: routedRun?.budget.calls ?? 0,
    versusFocused: { gains: 0, regressions: 0 },
    versusOriginal: { gains: 0, regressions: 0 },
    versusDeterministic: { gains: 0, regressions: 0 },
  }));
  for (const [index, fixture] of cases.entries()) {
    const past = await choose(call, fixture, false);
    const next = await choose(call, fixture, true);
    const originalCorrect = past === 'correct';
    const focusedCorrect = next === 'correct';
    const {choice: fixed, margin} = fixedChoices[index];
    const deterministicCorrect = fixed === fixture.expected;
    // The margin sweep replays a reference answer. A direct route has its own observed answer.
    for (const policy of retrievalMargins) {
      const usesModel = margin < policy.minimumMargin;
      const routed = directlyRouted[index] ?? (usesModel ? next : deterministicCorrect ? 'correct' : 'incorrect');
      const routedCorrect = routed === 'correct';
      if (!routedRun && usesModel) policy.modelCalls++;
      if (routedCorrect) policy.correct++;
      if (routed === 'rejected') policy.rejected++;
      recordComparison(policy.versusFocused, routedCorrect, focusedCorrect);
      recordComparison(policy.versusOriginal, routedCorrect, originalCorrect);
      recordComparison(policy.versusDeterministic, routedCorrect, deterministicCorrect);
    }
    if (originalCorrect) original.correct++;
    if (past === 'rejected') original.rejected++;
    if (focusedCorrect) candidate.correct++;
    if (next === 'rejected') candidate.rejected++;
    if (deterministicCorrect) deterministic.correct++;
    if (fixed === null) deterministic.abstained++;
    recordComparison(original, focusedCorrect, originalCorrect);
    recordComparison(deterministic, focusedCorrect, deterministicCorrect);
  }
  const confirmedGain = candidate.rejected === 0 && original.gains >= spec.minimumGain && original.regressions === 0;
  const {minimumMargin: _, ...retrievalFirst} = retrievalMargins[0];
  return {
    evidence: execution === 'direct' ? 'offline_direct_explanation_fallback' : 'offline_explanation_revision_holdout',
    releaseAuthorized: false,
    holdoutDigest: expectedSha, developmentReportDigest: spec.developmentReportDigest,
    comparator: locale === 'en' ? 'canonical_english_explanation_retrieval_v2' : 'canonical_malay_explanation_retrieval_v1',
    locale, cases: cases.length, minimumGain: spec.minimumGain,
    original, deterministic, candidate, retrievalFirst, retrievalMargins, confirmedGain,
    beatsDeterministic: candidate.rejected === 0 && deterministic.gains >= spec.minimumGain && deterministic.regressions === 0,
    budget, ...(routedRun ? { routedBudget: routedRun.budget } : {}),
  };
}

/** Evaluator-owned fictional cases, scored against both the original model
 * contract and a fixed lexical selector that receives the same focus. */
export async function scoreProtectedExplanationHoldout(bytes: Buffer, expectedSha: string, developmentReport: Buffer,
  modelDigest: string, model: PilotModel, execution: 'replay' | 'direct' = 'replay') {
  return evaluateExplanationHoldout(prepareExplanationHoldout(bytes, expectedSha, developmentReport, modelDigest),
    model, execution === 'direct' ? [1] : [1, 2, 3, 4, 5, 6, 8], execution);
}

type ExposureCase = Pick<ExplanationCase, 'module' | 'focus' | 'expected'>;

export function assertFreshExplanationCases(exposed: readonly ExposureCase[], fresh: readonly ExposureCase[]) {
  const questionKey = (row: ExposureCase) => routingDigest([row.module, normalize(row.focus)]);
  const findingKey = (row: ExposureCase) => routingDigest([row.module, row.expected]);
  const questions = new Set(exposed.map(questionKey));
  const seenFindings = new Set(exposed.map(findingKey));
  for (const row of fresh) {
    const question = questionKey(row);
    const finding = findingKey(row);
    if (questions.has(question) || seenFindings.has(finding)) throw Error('Fresh routing cases repeat a prior question or expected finding.');
    questions.add(question);
    seenFindings.add(finding);
  }
}

export async function scoreFreshExplanationRouting(input: {
  plan: Buffer; planSha256: string; developmentReport: Buffer; english: Buffer; malay: Buffer;
  exposures: Record<keyof typeof EXPLANATION_ROUTING_EXPOSURES, Buffer>;
}, modelDigest: string, model: PilotModel) {
  const plan = freshPlan.parse(readFrozenHoldoutJson(input.plan, input.planSha256));
  const english = prepareExplanationHoldout(input.english, plan.englishSha256, input.developmentReport, modelDigest);
  const malay = prepareExplanationHoldout(input.malay, plan.malaySha256, input.developmentReport, modelDigest);
  if (english.locale !== 'en' || malay.locale !== 'ms') throw Error('Supply separate English and Malay routing holdouts.');
  const exposed: ExposureCase[] = explanationCases();
  for (const key of ['english', 'malay', 'challenge'] as const) {
    const prior = holdout.parse(readFrozenHoldoutJson(input.exposures[key], EXPLANATION_ROUTING_EXPOSURES[key]));
    if (prior.modelDigest !== modelDigest || prior.developmentReportDigest !== english.spec.developmentReportDigest)
      throw Error('Fresh routing must use the model and parent that produced the frozen routing choice.');
    exposed.push(...prior.cases.map(row => ({...row, expected: `specialist_finding:${row.expected}` as const})));
  }
  // An additional paraphrase or translation of a known expected finding is not a new case.
  assertFreshExplanationCases(exposed, [...english.cases, ...malay.cases]);

  const locales = [];
  for (const prepared of [english, malay]) {
    const result = await evaluateExplanationHoldout(prepared, model, [plan.minimumMargin]);
    locales.push({locale: result.locale, holdoutDigest: result.holdoutDigest, cases: result.cases,
      minimumGain: result.minimumGain, original: result.original, deterministic: result.deterministic,
      focused: result.candidate, candidate: result.retrievalMargins[0], budget: result.budget});
  }
  const preservesQuality = locales.every(({candidate}) => candidate.rejected === 0 &&
    [candidate.versusOriginal, candidate.versusFocused, candidate.versusDeterministic].every(row => row.regressions === 0));
  const improvesOnBaselines = locales.every(({candidate, minimumGain}) =>
    candidate.versusOriginal.gains >= minimumGain && candidate.versusDeterministic.gains >= minimumGain);
  const savesCalls = locales.some(row => row.candidate.modelCalls < row.cases);
  return {evidence: 'offline_fresh_explanation_routing', releaseAuthorized: false, planSha256: input.planSha256,
    developmentReportDigest: english.spec.developmentReportDigest, exposedHoldoutDigests: EXPLANATION_ROUTING_EXPOSURES,
    minimumMargin: plan.minimumMargin, preservesQuality, improvesOnBaselines, savesCalls,
    passedOfflineScreen: preservesQuality && improvesOnBaselines && savesCalls, locales};
}
