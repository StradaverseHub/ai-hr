/** Require paired evidence in English and Malay before advancing an offline routing proposal. */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {routingDigest} from '../../lib/ai/module-agent-routing';
import {EXPLANATION_ANSWER_FORMAT, EXPLANATION_GENERATION_OPTIONS} from './protected-explanation-priority';
import {readFrozenHoldoutJson} from './protected-work-summary-holdout';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().min(0).max(32);
const report = z.object({
  evidence: z.literal('offline_explanation_revision_holdout'),
  releaseAuthorized: z.literal(false),
  locale: z.enum(['en', 'ms']).optional(),
  comparator: z.enum(['canonical_english_explanation_retrieval_v2', 'canonical_malay_explanation_retrieval_v1']),
  cases: count.min(4),
  candidate: z.object({correct: count, rejected: count}),
  modelDigest: digest,
  developmentReportDigest: digest,
  holdoutDigest: digest,
  answerFormatDigest: digest,
  generationOptions: z.strictObject({temperature: z.literal(0), seed: z.literal(42), num_predict: z.literal(512)}),
  retrievalMargins: z.array(z.object({
    minimumMargin: z.number().int().positive(),
    correct: count,
    rejected: count,
    modelCalls: count,
    versusFocused: z.object({gains: count, regressions: count}),
  })).min(1).max(16),
});

type BoundReport = Readonly<{bytes: Buffer; sha256: string}>;

export function assessExplanationRouting(minimumMargin: number, english: BoundReport, malay: BoundReport) {
  if (!Number.isSafeInteger(minimumMargin) || minimumMargin < 1) throw Error('Supply one positive integer margin.');
  const locales = ['en', 'ms'] as const;
  const comparators = ['canonical_english_explanation_retrieval_v2', 'canonical_malay_explanation_retrieval_v1'];
  const evaluated = [english, malay].map(({bytes, sha256}, index) => {
    const parsed = report.safeParse(readFrozenHoldoutJson(bytes, sha256));
    if (!parsed.success) throw Error('Expected a frozen explanation routing report.');
    const row = parsed.data;
    const locale = locales[index];
    if ((row.locale ?? 'en') !== locale || row.comparator !== comparators[index])
      throw Error('Distinct English and Malay evidence required.');
    if (row.answerFormatDigest !== routingDigest(EXPLANATION_ANSWER_FORMAT) ||
        routingDigest(row.generationOptions) !== routingDigest(EXPLANATION_GENERATION_OPTIONS))
      throw Error('Routing report does not use the frozen model contract.');
    if (new Set(row.retrievalMargins.map(policy => policy.minimumMargin)).size !== row.retrievalMargins.length)
      throw Error('Routing report has duplicate margins.');
    const route = row.retrievalMargins.find(policy => policy.minimumMargin === minimumMargin);
    if (!route) throw Error('The proposed margin was not evaluated in each locale.');
    const {correct: focusedCorrect, rejected: focusedRejected} = row.candidate;
    const {gains, regressions} = route.versusFocused;
    if (focusedCorrect + focusedRejected > row.cases || route.correct + route.rejected > row.cases ||
        route.modelCalls > row.cases || gains > row.cases - focusedCorrect || regressions > focusedCorrect ||
        route.correct !== focusedCorrect + gains - regressions)
      throw Error('Inconsistent paired routing counts.');
    return {locale, reportSha256: sha256, holdoutDigest: row.holdoutDigest, modelDigest: row.modelDigest,
      developmentReportDigest: row.developmentReportDigest, cases: row.cases, focusedCorrect,
      routedCorrect: route.correct, rejected: route.rejected, gains, regressions, callsAvoided: row.cases - route.modelCalls};
  });
  const [en, ms] = evaluated;
  if (en.modelDigest !== ms.modelDigest || en.developmentReportDigest !== ms.developmentReportDigest ||
      en.holdoutDigest === ms.holdoutDigest) throw Error('Routing reports do not share a model and parent with distinct cases.');
  const preservesQuality = evaluated.every(row => row.regressions === 0 && row.rejected === 0);
  const hasGain = evaluated.some(row => row.gains > 0);
  const savesCalls = evaluated.some(row => row.callsAvoided > 0);
  return {evidence: 'offline_explanation_routing_screen', releaseAuthorized: false, minimumMargin,
    eligibleForFreshEvaluation: preservesQuality && hasGain && savesCalls, preservesQuality, hasGain, savesCalls,
    locales: evaluated};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [margin, english, englishSha, malay, malaySha, ...extra] = process.argv.slice(2);
  if (!margin || !english || !englishSha || !malay || !malaySha || extra.length)
    throw Error('Supply MARGIN EN_REPORT EN_SHA256 MS_REPORT MS_SHA256.');
  console.log(JSON.stringify(assessExplanationRouting(Number(margin),
    {bytes: readFileSync(english), sha256: englishSha},
    {bytes: readFileSync(malay), sha256: malaySha}), null, 2));
}
