import { routingDigest } from '../../lib/ai/module-agent-routing';
import { runProtectedLeaveComparison } from './protected-leave-comparison';
import { runProtectedWorkSummaryComparison } from './protected-work-summary-comparison';
import { protectedGuidanceProposalSchema, runProtectedWorkSummaryImprovement } from './protected-work-summary-improvement';
import { leaveAnswerJsonSchema } from './leave-answer-format';
import { PROTECTED_CATALOGUE_FORMAT, protectedCatalogueAnswerJsonSchema } from './protected-catalogue-answer-format';
import { runLeaveImprovement, type PilotModel } from '../teras/leave-improvement';
import { localOutputPath, writeLocalOutput } from '../teras/output';

const baseUrl = 'http://127.0.0.1:11434';
const generationOptions = { temperature: 0, seed: 42, num_predict: 512 };

async function main() {
  const [model, outfile, ...flags] = process.argv.slice(2);
  const runners = {
    '--protected': runProtectedLeaveComparison,
    '--protected-work-summary': runProtectedWorkSummaryComparison,
    '--improve-protected-work-summary': runProtectedWorkSummaryImprovement,
  };
  const isBenchmark = (flag: string): flag is keyof typeof runners => Object.hasOwn(runners, flag);
  const benchmarks = flags.filter(isBenchmark);
  const [benchmark] = benchmarks;
  const useCatalogueFormat = flags.includes('--catalogue-schema');
  const useStaticSchema = flags.includes('--schema');
  // An exact locally installed tag keeps this experiment independent of cloud-provider credentials.
  if (!model || !/^[a-z0-9_.\/-]+:[a-z0-9_.-]+$/.test(model) || !outfile ||
      flags.some(flag => flag !== '--schema' && flag !== '--catalogue-schema' && !isBenchmark(flag)) ||
      new Set(flags).size !== flags.length || benchmarks.length > 1 || (useCatalogueFormat && (!benchmark || useStaticSchema)))
    throw Error('Usage: node --import tsx scripts/experiments/leave-improvement-cli.ts MODEL:TAG REPORT.json [--schema | --catalogue-schema] [--protected | --protected-work-summary | --improve-protected-work-summary]');
  const answerFormat = useStaticSchema ? leaveAnswerJsonSchema : 'json';
  localOutputPath(outfile);
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
    const format = mode !== 'answer' ? revisionFormat : useCatalogueFormat ? protectedCatalogueAnswerJsonSchema(JSON.parse(prompt)) : answerFormat;
    const result = await request('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, system, prompt, stream: false, format, options: generationOptions }),
    });
    if (result?.done !== true || result.model !== model || typeof result.response !== 'string')
      throw Error('Local model returned an incomplete response.');
    return { text: result.response, inputTokens: result.prompt_eval_count, outputTokens: result.eval_count };
  };
  const run = benchmark ? runners[benchmark] : runLeaveImprovement;
  const report = await run(generate);
  if (await models() !== modelDigest) throw Error('Local model changed during the experiment.');
  const answerFormatDigest = routingDigest(useCatalogueFormat ? PROTECTED_CATALOGUE_FORMAT : answerFormat);
  writeLocalOutput(outfile, JSON.stringify({ ...report, model, modelDigest, generationOptions, answerFormatDigest }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'Leave experiment unavailable.');
  process.exitCode = 1;
});
