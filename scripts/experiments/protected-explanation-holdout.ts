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
const holdout = z.strictObject({
  version: z.literal(1),
  locale: z.enum(['en', 'ms']).optional(),
  modelDigest: digest,
  developmentReportDigest: digest,
  minimumGain: z.number().int().min(1),
  cases: z.array(z.strictObject({
    module: z.enum(AGENT_MODULE_CODES),
    choices: z.array(finding).min(2).max(8),
    focus: z.string().min(8).max(180).regex(/^[\p{L}\p{M} '?.,’\-]+$/u),
    expected: finding,
  })).min(4).max(32),
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

/** Evaluator-owned fictional cases, scored against both the original model
 * contract and a fixed lexical selector that receives the same focus. */
export async function scoreProtectedExplanationHoldout(bytes: Buffer, expectedSha: string, developmentReport: Buffer,
  modelDigest: string, model: PilotModel) {
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

  const { call, budget } = observeModel(model);
  const original = { correct: 0, rejected: 0, gains: 0, regressions: 0 };
  const deterministic = { correct: 0, abstained: 0, gains: 0, regressions: 0 };
  const candidate = { correct: 0, rejected: 0 };
  const retrievalMargins = [1, 2, 3, 4, 5, 6, 8].map(minimumMargin => ({
    minimumMargin,
    correct: 0, rejected: 0, modelCalls: 0,
    versusFocused: { gains: 0, regressions: 0 },
  }));
  for (const fixture of cases) {
    const past = await choose(call, fixture, false);
    const next = await choose(call, fixture, true);
    const {choice: fixed, margin} = deterministicChoice(fixture, locale);
    // Both policies would send the identical focused request on a retrieval abstention.
    // Reuse that observed response to attribute accuracy and calls without extra sampling.
    for (const policy of retrievalMargins) {
      const usesModel = margin < policy.minimumMargin;
      const routed = usesModel ? next : fixed === fixture.expected ? 'correct' : 'incorrect';
      if (usesModel) policy.modelCalls++;
      if (routed === 'correct') policy.correct++;
      if (routed === 'rejected') policy.rejected++;
      if (routed === 'correct' && next !== 'correct') policy.versusFocused.gains++;
      if (routed !== 'correct' && next === 'correct') policy.versusFocused.regressions++;
    }
    if (past === 'correct') original.correct++;
    if (past === 'rejected') original.rejected++;
    if (next === 'correct') candidate.correct++;
    if (next === 'rejected') candidate.rejected++;
    if (fixed === fixture.expected) deterministic.correct++;
    if (fixed === null) deterministic.abstained++;
    if (next === 'correct' && past !== 'correct') original.gains++;
    if (next !== 'correct' && past === 'correct') original.regressions++;
    if (next === 'correct' && fixed !== fixture.expected) deterministic.gains++;
    if (next !== 'correct' && fixed === fixture.expected) deterministic.regressions++;
  }
  const confirmedGain = candidate.rejected === 0 && original.gains >= spec.minimumGain && original.regressions === 0;
  const {minimumMargin: _, ...retrievalFirst} = retrievalMargins[0];
  return {
    evidence: 'offline_explanation_revision_holdout', releaseAuthorized: false,
    holdoutDigest: expectedSha, developmentReportDigest: spec.developmentReportDigest,
    comparator: locale === 'en' ? 'canonical_english_explanation_retrieval_v2' : 'canonical_malay_explanation_retrieval_v1',
    locale, cases: cases.length, minimumGain: spec.minimumGain,
    original, deterministic, candidate, retrievalFirst, retrievalMargins, confirmedGain,
    beatsDeterministic: candidate.rejected === 0 && deterministic.gains >= spec.minimumGain && deterministic.regressions === 0,
    budget,
  };
}
