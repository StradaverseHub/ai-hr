import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, relative, sep } from 'node:path';
import { routingDigest } from '../../lib/ai/module-agent-routing';
import { runProtectedLeaveComparison, runProtectedLeaveRouting } from './protected-leave-comparison';
import { scorePairedLeaveRoutingHoldout } from './protected-leave-routing-holdout';
import { runProtectedWorkSummaryComparison } from './protected-work-summary-comparison';
import { protectedGuidanceProposalSchema, runProtectedWorkSummaryImprovement } from './protected-work-summary-improvement';
import { leaveAnswerJsonSchema } from './leave-answer-format';
import { PROTECTED_CATALOGUE_FORMAT, protectedCatalogueAnswerJsonSchema } from './protected-catalogue-answer-format';
import { PROTECTED_INDEXED_FORMAT, protectedIndexedAnswer } from './protected-indexed-answer-format';
import {
  PROTECTED_HOLDOUT_GENERATION_OPTIONS, PROTECTED_HOLDOUT_LIMIT_BYTES, scoreProtectedWorkSummaryHoldout,
} from './protected-work-summary-holdout';
import { scoreFreshExplanationRouting, scoreProtectedExplanationHoldout } from './protected-explanation-holdout';
import { compareProtectedExplanationMeanings } from './protected-explanation-meanings';
import {
  EXPLANATION_ANSWER_FORMAT, EXPLANATION_GENERATION_OPTIONS,
  runProtectedExplanationImprovement, runProtectedExplanationPriority,
} from './protected-explanation-priority';
import { runLeaveImprovement, type PilotModel } from '../teras/leave-improvement';
import { localOutputPath, REPO_ROOT, writeLocalOutput } from '../teras/output';

const baseUrl = 'http://127.0.0.1:11434';

function readHoldoutInput(filename: string, outsideCheckout: boolean) {
  const path = realpathSync(filename);
  const location = relative(realpathSync(REPO_ROOT), path);
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > PROTECTED_HOLDOUT_LIMIT_BYTES ||
      (outsideCheckout && !isAbsolute(location) && !location.startsWith('..' + sep)))
    throw Error('Use bounded evaluator files outside the checkout for cases and plans.');
  return readFileSync(path);
}

async function main() {
  const [model, outfile, ...args] = process.argv.slice(2);
  const pairedLeave = args[0] === '--paired-leave-routing';
  const freshRouting = args[0] === '--fresh-explanation-routing';
  const explanationHoldout = freshRouting || args[0] === '--protected-explanation-holdout';
  const workSummaryHoldout = args[0] === '--protected-holdout';
  const holdoutMode = pairedLeave || explanationHoldout || workSummaryHoldout;
  const [, holdoutPath, holdoutSha, developmentReportPath, previousReportPath, previousCasesPath] = args;
  if (pairedLeave && (args.length !== 3 || !holdoutPath || !/^[a-f0-9]{64}$/.test(holdoutSha ?? '')))
    throw Error('Supply evaluator-owned CASE_FILE SHA256 for paired leave routing.');
  const hasPrevious = workSummaryHoldout && args.length === 6 && Boolean(previousReportPath && previousCasesPath);
  if (holdoutMode && !pairedLeave && ((args.length !== 4 && !hasPrevious) || !holdoutPath || !developmentReportPath || !/^[a-f0-9]{64}$/.test(holdoutSha ?? '')))
    throw Error('Supply FILE SHA256 DEVELOPMENT_REPORT for a holdout or DIRECTORY PLAN_SHA256 DEVELOPMENT_REPORT for fresh routing.');
  const flags = holdoutMode ? [] : args;
  const runners = {
    '--protected': runProtectedLeaveComparison,
    '--protected-leave-routing': runProtectedLeaveRouting,
    '--protected-work-summary': runProtectedWorkSummaryComparison,
    '--improve-protected-work-summary': runProtectedWorkSummaryImprovement,
    '--protected-explanation-priority': runProtectedExplanationPriority,
    '--compare-explanation-meanings': compareProtectedExplanationMeanings,
    '--improve-protected-explanation': runProtectedExplanationImprovement,
  };
  const isBenchmark = (flag: string): flag is keyof typeof runners => Object.hasOwn(runners, flag);
  const benchmarks = flags.filter(isBenchmark);
  const [benchmark] = benchmarks;
  const useCatalogueFormat = (holdoutMode && !pairedLeave && !explanationHoldout) || flags.includes('--catalogue-schema');
  const useStaticSchema = flags.includes('--schema');
  const useIndexedFormat = flags.includes('--indexed-catalogue');
  const improveExplanation = benchmark === '--improve-protected-explanation';
  const explanationPriority = explanationHoldout || benchmark === '--protected-explanation-priority' ||
    benchmark === '--compare-explanation-meanings' || improveExplanation;
  // An exact locally installed tag keeps this experiment independent of cloud-provider credentials.
  if (!model || !/^[a-z0-9_.\/-]+:[a-z0-9_.-]+$/.test(model) || !outfile ||
      flags.some(flag => !['--schema', '--catalogue-schema', '--indexed-catalogue'].includes(flag) && !isBenchmark(flag)) ||
      new Set(flags).size !== flags.length || benchmarks.length > 1 || (useCatalogueFormat && !holdoutMode && (!benchmark || useStaticSchema)) ||
      (explanationPriority && (useStaticSchema || useCatalogueFormat)) ||
      (useIndexedFormat && (benchmark !== '--protected-work-summary' || useStaticSchema || useCatalogueFormat)))
    throw Error('Usage: node --import tsx scripts/experiments/leave-improvement-cli.ts MODEL:TAG REPORT.json [--schema | --catalogue-schema | --indexed-catalogue] [' + Object.keys(runners).join(' | ') + ']');
  const answerFormat = useStaticSchema ? leaveAnswerJsonSchema : 'json';
  const generationOptions = workSummaryHoldout || benchmark === '--improve-protected-work-summary'
    ? PROTECTED_HOLDOUT_GENERATION_OPTIONS : EXPLANATION_GENERATION_OPTIONS;
  const target = localOutputPath(outfile);
  if (holdoutMode && existsSync(target)) throw Error('Use a new report path.');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  if (pairedLeave && git('status', '--porcelain', '--untracked-files=no')) throw Error('Use the clean frozen candidate checkout.');
  const candidateSha = pairedLeave ? git('rev-parse', 'HEAD') : null;
  const developmentReport = holdoutMode && !pairedLeave ? readHoldoutInput(developmentReportPath, false) : null;
  const cases = holdoutMode && !freshRouting ? readHoldoutInput(holdoutPath, true) : null;
  const previousHoldout = hasPrevious ? {
    report: readHoldoutInput(previousReportPath, true), cases: readHoldoutInput(previousCasesPath, true),
  } : undefined;
  const freshInput = freshRouting && developmentReport ? {
    plan: readHoldoutInput(join(holdoutPath, 'plan.json'), true), planSha256: holdoutSha, developmentReport,
    english: readHoldoutInput(join(holdoutPath, 'en.json'), true), malay: readHoldoutInput(join(holdoutPath, 'ms.json'), true),
    exposures: {
      english: readHoldoutInput(join(holdoutPath, 'exposed-en.json'), true),
      malay: readHoldoutInput(join(holdoutPath, 'exposed-ms.json'), true),
      challenge: readHoldoutInput(join(holdoutPath, 'exposed-challenge.json'), true),
    },
  } : null;
  const deadline = AbortSignal.timeout(30 * 60_000);
  const request = async (path: string, init?: RequestInit) => {
    const response = await fetch(baseUrl + path, { ...init, redirect: 'error', signal: AbortSignal.any([deadline, AbortSignal.timeout(90_000)]) });
    if (!response.ok) throw Error('Local model service returned HTTP ' + response.status);
    return response.json();
  };
  const models = async () => {
    const list = await request('/api/tags');
    const entry = Array.isArray(list?.models) ? list.models.find((row: { name?: unknown }) => row.name === model) : null;
    if (!entry || typeof entry.digest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.digest) ||
        !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.details?.format !== 'gguf')
      throw Error('Supply an installed local GGUF model with an explicit tag.');
    return entry.digest as string;
  };
  const modelDigest = await models();
  const generate: PilotModel = async ({ mode, system, prompt }) => {
    if (await models() !== modelDigest) throw Error('Local model changed during the experiment.');
    const revisionFormat = benchmark === '--improve-protected-work-summary' ? protectedGuidanceProposalSchema : 'json';
    const format = mode === 'revise' && improveExplanation ? {
      type: 'object', additionalProperties: false, required: ['change'],
      properties: { change: { type: 'string', enum: Object.keys(JSON.parse(prompt).options) } },
    } : explanationPriority ? {
      type: 'object', additionalProperties: false, required: ['choice'],
      properties: { choice: { type: 'string', enum: JSON.parse(prompt).choices } },
    } : mode !== 'answer' ? revisionFormat : useCatalogueFormat ? protectedCatalogueAnswerJsonSchema(JSON.parse(prompt)) : answerFormat;
    const indexed = useIndexedFormat ? protectedIndexedAnswer(JSON.parse(prompt)) : null;
    const result = await request('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, system: indexed?.system ?? system, prompt: indexed?.prompt ?? prompt, stream: false,
        format: indexed?.format ?? format, options: generationOptions,
      }),
    });
    if (result?.done !== true || result.model !== model || typeof result.response !== 'string')
      throw Error('Local model returned an incomplete response.');
    return { text: indexed ? indexed.decode(result.response) : result.response, inputTokens: result.prompt_eval_count, outputTokens: result.eval_count };
  };
  const run = benchmark ? runners[benchmark] : runLeaveImprovement;
  const report = candidateSha && cases ? await scorePairedLeaveRoutingHoldout(cases, holdoutSha, candidateSha, modelDigest, generate)
    : freshInput ? await scoreFreshExplanationRouting(freshInput, modelDigest, generate)
    : cases && developmentReport ? await (explanationHoldout
      ? scoreProtectedExplanationHoldout(cases, holdoutSha, developmentReport, modelDigest, generate)
      : scoreProtectedWorkSummaryHoldout(cases, holdoutSha, developmentReport, modelDigest, generate, previousHoldout))
    : await run(generate);
  if (await models() !== modelDigest) throw Error('Local model changed during the experiment.');
  if (candidateSha && (git('rev-parse', 'HEAD') !== candidateSha || git('status', '--porcelain', '--untracked-files=no')))
    throw Error('The candidate checkout changed during scoring.');
  const answerFormatDigest = routingDigest(explanationPriority ? EXPLANATION_ANSWER_FORMAT :
    useIndexedFormat ? PROTECTED_INDEXED_FORMAT : useCatalogueFormat ? PROTECTED_CATALOGUE_FORMAT : answerFormat);
  writeLocalOutput(outfile, JSON.stringify({ ...report, model, modelDigest, generationOptions, answerFormatDigest }, null, 2));
  if ((pairedLeave || workSummaryHoldout) && 'meetsThreshold' in report && !report.meetsThreshold) process.exitCode = 2;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Leave experiment unavailable.');
  process.exitCode = 1;
});
