/** Fixed synthetic protocol evaluation; never HR data, tool execution or a model self-rating.
 * Primary protocol reference: https://openrouter.ai/docs/guides/features/tool-calling
 * Route controls are not account-policy proof: https://openrouter.ai/docs/guides/features/zdr
 */
import { createHash, randomUUID } from 'node:crypto';
import { converse, generateDraft } from './index';
import {createAiRunAccounting} from './run-accounting';
import { captureAiConfig } from './governance';
import { readOpenRouterOptions } from './providers/openrouter-configuration';
import { AiGatewayError, type AiUsage,type AiRunObservation, type AiToolSpec, type ResolvedAiConfig } from './types';
export const PROVIDER_PROTOCOL_SUITE_VERSION = 1;
export const PROVIDER_PROTOCOL_LIMITS = Object.freeze({ calls: 3, outputTokens: 1024, perCallMs: 15_000, totalMs: 60_000 });
export type ProviderProtocolSummary = Readonly<{ calls: 3; elapsedMs: number; usageReportedCalls: number;
  inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; accountChargeCredits: number | null }>;
const issued = new WeakMap<object, string>();
const unavailable = (): never => { throw new AiGatewayError('The provider protocol evaluation could not be confirmed.'); };
const binding = (cfg: ResolvedAiConfig) => createHash('sha256').update(JSON.stringify([
  cfg.provider, cfg.model, cfg.apiKey, readOpenRouterOptions(cfg.providerOptions),
])).digest('hex');
const validUsage = (value: AiUsage) => [value.inputTokens, value.outputTokens, value.cachedInputTokens].every(n => Number.isSafeInteger(n) && n >= 0);

/** Only actual completed calls with exact nonce/text/tool correlations produce an issued result.
 * This narrowly evaluates protocol behaviour on these inputs/bounds, not all task quality or privacy.
 */
export async function runProviderProtocolEvaluation(configuration: ResolvedAiConfig): Promise<ProviderProtocolSummary> {
  configuration = captureAiConfig(configuration);
  if (configuration.provider !== 'openrouter' || !configuration.governance) return unavailable();
  const configurationBinding = binding(configuration), governance = configuration.governance;
  const started = performance.now(), observations: (AiUsage | null)[] = [],charges:(number|null)[]=[];
  const inTime = () => { if (performance.now() - started >= PROVIDER_PROTOCOL_LIMITS.totalMs) return unavailable(); };
  const cfg: ResolvedAiConfig = Object.freeze({ ...configuration, governance: Object.freeze({
    async run<T>(request: Parameters<typeof governance.run>[0], call: (record: (usage: AiUsage) => void,observe?: (observation:AiRunObservation)=>void) => Promise<T>, outgoing: ResolvedAiConfig = configuration): Promise<T> {
      inTime(); const usage: AiUsage[] = [],accounting=createAiRunAccounting(configuration.provider);
      try {
        return await governance.run(request, async (record,observe) => {
          // Admission may have waited: never start a late provider request after the evaluation deadline.
          if (performance.now() - started >= PROVIDER_PROTOCOL_LIMITS.totalMs) {
            record({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
            return unavailable();
          }
          return call(value => { usage.push({ ...value }); record(value); },value=>{accounting.observe(value);observe?.(value);});
        }, outgoing);
      } finally { const actual=usage.length === 1 && validUsage(usage[0]) ? usage[0] : null;observations.push(actual);const receipt=accounting.snapshot(actual?actual.inputTokens+actual.outputTokens+actual.cachedInputTokens:null);charges.push(receipt.providerObservationStatus==='reported'?receipt.openrouterAccountCostCredits:null); }
    },
  }) });
  const marker = `eval_${randomUUID()}`;
  const system = ['This is a synthetic integration protocol test. There are no people, accounts or HR records in this test.'];
  const echo = await generateDraft(cfg, { system: system[0], prompt: `Return exactly this token and nothing else: ${marker}`,
    maxTokens: PROVIDER_PROTOCOL_LIMITS.outputTokens, timeoutMs: PROVIDER_PROTOCOL_LIMITS.perCallMs });
  inTime(); if (echo !== marker) return unavailable();
  const tool: AiToolSpec = { name: 'integration_echo', description: 'Synthetic integration fixture only. Return the supplied marker through the tool; this tool has no side effects.',
    inputSchema: { type: 'object', properties: { marker: { type: 'string', enum: [marker] } }, required: ['marker'], additionalProperties: false } };
  const question = `Call integration_echo exactly once with marker ${marker}. Do not answer in text yet.`;
  const first = await converse(cfg, { system, tools: [tool], turns: [{ role: 'user', content: question }],
    maxTokens: PROVIDER_PROTOCOL_LIMITS.outputTokens, timeoutMs: PROVIDER_PROTOCOL_LIMITS.perCallMs });
  inTime();
  const call = first.toolCalls[0];
  if (first.stop !== 'tool_use' || first.toolCalls.length !== 1 || !call || call.name !== tool.name || !/^[\x21-\x7e]{1,200}$/.test(call.id) ||
      !call.input || typeof call.input !== 'object' || Array.isArray(call.input) || Object.keys(call.input).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(call.input, 'marker') || (call.input as Record<string, unknown>).marker !== marker) return unavailable();
  const final = await converse(cfg, { system: [...system, 'After the tool result, return exactly its marker and nothing else.'], tools: [tool], turns: [
    { role: 'user', content: question }, { role: 'assistant', content: first.text, toolCalls: [call], ...(first.providerState ? { providerState: first.providerState } : {}) },
    { role: 'tool', results: [{ id: call.id, name: call.name, content: JSON.stringify({ marker }) }] },
  ], maxTokens: PROVIDER_PROTOCOL_LIMITS.outputTokens, timeoutMs: PROVIDER_PROTOCOL_LIMITS.perCallMs });
  inTime(); if (final.stop !== 'end' || final.toolCalls.length || final.text.trim() !== marker || observations.length !== 3) return unavailable();
  const known = observations.filter((value): value is AiUsage => value !== null), allKnown = known.length === 3;
  const credits=charges.every(value=>value!==null)?charges.reduce<number>((sum,value)=>sum+value!,0):null;
  const summary: ProviderProtocolSummary = Object.freeze({ calls: 3, elapsedMs: Math.max(0, Math.round(performance.now() - started)),
    usageReportedCalls: known.length, inputTokens: allKnown ? known.reduce((n, value) => n + value.inputTokens, 0) : null,
    outputTokens: allKnown ? known.reduce((n, value) => n + value.outputTokens, 0) : null,
    cachedInputTokens: allKnown ? known.reduce((n, value) => n + value.cachedInputTokens, 0) : null, accountChargeCredits: credits!==null&&Number.isFinite(credits)?credits:null });
  issued.set(summary, configurationBinding);
  return summary;
}

/** A copied/self-rated result or one from a different key/model/route cannot issue readiness evidence. */
export function assertProviderProtocolEvaluation(summary: ProviderProtocolSummary, configuration: ResolvedAiConfig): void {
  if (issued.get(summary) !== binding(configuration)) return unavailable();
}
