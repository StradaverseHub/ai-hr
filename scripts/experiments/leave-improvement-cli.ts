import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { routingDigest } from '../../lib/ai/module-agent-routing';
import { runProtectedLeaveComparison } from './protected-leave-comparison';
import { runProtectedWorkSummaryComparison } from './protected-work-summary-comparison';
import { protectedGuidanceProposalSchema, runProtectedWorkSummaryImprovement } from './protected-work-summary-improvement';
import { leaveAnswerJsonSchema } from './leave-answer-format';
import { PROTECTED_CATALOGUE_FORMAT, protectedCatalogueAnswerJsonSchema } from './protected-catalogue-answer-format';
import { PROTECTED_INDEXED_FORMAT, protectedIndexedAnswer } from './protected-indexed-answer-format';
import { PROTECTED_HOLDOUT_LIMIT_BYTES, scoreProtectedWorkSummaryHoldout } from './protected-work-summary-holdout';
import { runProtectedExplanationPriority } from './protected-explanation-priority';
import { runLeaveImprovement, type PilotModel } from '../teras/leave-improvement';
import { localOutputPath, REPO_ROOT, writeLocalOutput } from '../teras/output';

const baseUrl = 'http://127.0.0.1:11434';
const generationOptions = { temperature: 0, seed: 42, num_predict: 512 };

async function main() {
  const [model, outfile, ...args] = process.argv.slice(2);
  const holdoutMode = args[0] === '--protected-holdout';
  const [, holdoutPath, holdoutSha] = args;
  if (holdoutMode && (args.length !== 3 || !holdoutPath || !/^[a-f0-9]{64}$/.test(holdoutSha ?? '')))
    throw Error('Use --protected-holdout FILE SHA256 with an evaluator-held fictional case file.');
  const flags = holdoutMode ? [] : args;
  const runners = {
    '--protected': runProtectedLeaveComparison,
    '--protected-work-summary': runProtectedWorkSummaryComparison,
    '--improve-protected-work-summary': runProtectedWorkSummaryImprovement,
    '--protected-explanation-priority': runProtectedExplanationPriority,
  };
  const isBenchmark = (flag: string): flag is keyof typeof runners => Object.hasOwn(runners, flag);
  const benchmarks = flags.filter(isBenchmark);
  const [benchmark] = benchmarks;
  const useCatalogueFormat = holdoutMode || flags.includes('--catalogue-schema');
  const useStaticSchema = flags.includes('--schema');
  const useIndexedFormat = flags.includes('--indexed-catalogue');
  const explanationPriority = benchmark === '--protected-explanation-priority';
  // An exact locally installed tag keeps this experiment independent of cloud-provider credentials.
  if (!model || !/^[a-z0-9_.\/-]+:[a-z0-9_.-]+$/.test(model) || !outfile ||
      flags.some(flag => !['--schema', '--catalogue-schema', '--indexed-catalogue'].includes(flag) && !isBenchmark(flag)) ||
      new Set(flags).size !== flags.length || benchmarks.length > 1 || (useCatalogueFormat && !holdoutMode && (!benchmark || useStaticSchema)) ||
      (explanationPriority && (useStaticSchema || useCatalogueFormat)) ||
      (useIndexedFormat && (benchmark !== '--protected-work-summary' || useStaticSchema || useCatalogueFormat)))
    throw Error('Usage: node --import tsx scripts/experiments/leave-improvement-cli.ts MODEL:TAG REPORT.json [--schema | --catalogue-schema | --indexed-catalogue] [--protected | --protected-work-summary | --improve-protected-work-summary | --protected-explanation-priority]');
  const answerFormat = useStaticSchema ? leaveAnswerJsonSchema : 'json';
  const target = localOutputPath(outfile);
  let holdout: Buffer | undefined;
  if (holdoutMode) {
    const path = realpathSync(holdoutPath);
    const location = relative(realpathSync(REPO_ROOT), path);
    const stat = statSync(path);
    if ((!isAbsolute(location) && !location.startsWith('..' + sep)) || !stat.isFile() ||
        stat.size > PROTECTED_HOLDOUT_LIMIT_BYTES || existsSync(target))
      throw Error('Use a holdout outside the checkout and a new report path.');
    holdout = readFileSync(path);
  }
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
    const format = explanationPriority ? {
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
  const report = holdout ? await scoreProtectedWorkSummaryHoldout(holdout, holdoutSha, modelDigest, generate) : await run(generate);
  if (await models() !== modelDigest) throw Error('Local model changed during the experiment.');
  const answerFormatDigest = routingDigest(explanationPriority ? 'protected_explanation_priority_v1' :
    useIndexedFormat ? PROTECTED_INDEXED_FORMAT : useCatalogueFormat ? PROTECTED_CATALOGUE_FORMAT : answerFormat);
  writeLocalOutput(outfile, JSON.stringify({ ...report, model, modelDigest, generationOptions, answerFormatDigest }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Leave experiment unavailable.');
  process.exitCode = 1;
});
