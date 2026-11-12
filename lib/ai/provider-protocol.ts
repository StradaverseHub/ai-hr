/** Fixed synthetic protocol evaluation; never HR data, tool execution or a model self-rating.
 * Primary protocol reference: https://openrouter.ai/docs/guides/features/tool-calling
 * Route controls are not account-policy proof: https://openrouter.ai/docs/guides/features/zdr
 */
import { createHash, randomUUID } from 'node:crypto';
import {preparePrivateAiTask,withAiRunObserver} from '../../core/ai-governance';
import { converse, generateDraft } from './index';
import {createAiRunAccounting} from './run-accounting';
import { captureAiConfig } from './governance';
import { readOpenRouterOptions } from './providers/openrouter-configuration';
import { AiGatewayError, type AiUsage,type AiRunObservation, type AiToolSpec, type ResolvedAiConfig,type GenerateArgs,type ConverseArgs } from './types';
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

/** Which of the three fixed calls failed, and how far it got: `local` = refused before admission (no model run,
 * nothing sent); `provider` = admitted and handed to the provider call, which failed (the transport logs its phase);
 * `response` = the provider answered but the answer did not satisfy the fixed protocol. No content is retained. */
export type ProviderProtocolStage = 'draft' | 'tool_call' | 'tool_result';
export type ProviderProtocolOrigin = 'local' | 'provider' | 'response';
type Progress = { stage: ProviderProtocolStage; dispatched: boolean; answered: boolean };
/** Same generic type and message as before. The original refusal is held non-enumerably for code-only
 * classification by the caller; its message, cause and any provider text are never copied or serialized. */
export class ProviderProtocolFailure extends AiGatewayError {
  declare readonly refusal: unknown;
  constructor(readonly stage: ProviderProtocolStage, readonly origin: ProviderProtocolOrigin, refusal: unknown) {
    super('The provider protocol evaluation could not be confirmed.');
    Object.defineProperty(this, 'refusal', { value: refusal, enumerable: false });
  }
}

/** Only actual completed calls with exact nonce/text/tool correlations produce an issued result.
 * This narrowly evaluates protocol behaviour on these inputs/bounds, not all task quality or privacy.
 * Any failure leaves as ProviderProtocolFailure naming only the failing call and how far it got.
 */
export async function runProviderProtocolEvaluation(configuration: ResolvedAiConfig): Promise<ProviderProtocolSummary> {
  const progress: Progress = { stage: 'draft', dispatched: false, answered: false };
  try { return await evaluateProviderProtocol(configuration, progress); }
  catch (error) { throw new ProviderProtocolFailure(progress.stage, progress.answered ? 'response' : progress.dispatched ? 'provider' : 'local', error); }
}
async function evaluateProviderProtocol(configuration: ResolvedAiConfig, progress: Progress): Promise<ProviderProtocolSummary> {
  // Retain the actual issued configuration identity for canonical derivations. Captured display
  // parameters alone cannot issue privacy/source authority.
  if (configuration.provider !== 'openrouter' || !configuration.governance) return unavailable();
  const configurationBinding = binding(configuration);
  const started = performance.now(), observations: (AiUsage | null)[] = [],charges:(number|null)[]=[];
  const inTime = () => { if (performance.now() - started >= PROVIDER_PROTOCOL_LIMITS.totalMs) return unavailable(); };
  let usage:AiUsage[]=[],accounting=createAiRunAccounting(configuration.provider);
  const cfg=withAiRunObserver(configuration,{
    beforeCall(){if(performance.now()-started>=PROVIDER_PROTOCOL_LIMITS.totalMs)return unavailable();progress.dispatched=true;},
    usage(value){usage.push({...value});},observation(value){accounting.observe(value);},
    settled(){const actual=usage.length===1&&validUsage(usage[0])?usage[0]:null;observations.push(actual);const receipt=accounting.snapshot(actual?actual.inputTokens+actual.outputTokens+actual.cachedInputTokens:null);charges.push(receipt.providerObservationStatus==='reported'?receipt.openrouterAccountCostCredits:null);},
  });
  const next=(stage:ProviderProtocolStage)=>{progress.stage=stage;progress.dispatched=false;progress.answered=false;};
  async function preparedCall(id:string,source:unknown){inTime();usage=[];accounting=createAiRunAccounting(configuration.provider);return preparePrivateAiTask(cfg,id,async()=>source);}
  const marker = `eval_${randomUUID()}`;
  const system = ['This is a synthetic integration protocol test. There are no people, accounts or HR records in this test.'];
  next('draft');const echoTask=await preparedCall('synthetic_protocol_echo_v1',{marker});let echo:string;
  try{if(echoTask.operation!=='draft')return unavailable();echo=await generateDraft(echoTask.configuration,echoTask.args as GenerateArgs);progress.answered=true;}finally{echoTask.dispose();}
  inTime(); if (echo !== marker) return unavailable();
  const tool: AiToolSpec = { name: 'integration_echo', description: 'Synthetic integration fixture only. Return the supplied marker through the tool; this tool has no side effects.',
    inputSchema: { type: 'object', properties: { marker: { type: 'string', enum: [marker] } }, required: ['marker'], additionalProperties: false } };
  const question = `Call integration_echo exactly once with marker ${marker}. Do not answer in text yet.`;
  next('tool_call');const firstTask=await preparedCall('synthetic_protocol_tools_v1',{marker,stage:'first',callId:null});let first:Awaited<ReturnType<typeof converse>>;
  try{if(firstTask.operation!=='conversation')return unavailable();first=await converse(firstTask.configuration,firstTask.args as ConverseArgs);progress.answered=true;}finally{firstTask.dispose();}
  inTime();
  const call = first.toolCalls[0];
  if (first.stop !== 'tool_use' || first.toolCalls.length !== 1 || !call || call.name !== tool.name || !/^[\x21-\x7e]{1,200}$/.test(call.id) ||
      !call.input || typeof call.input !== 'object' || Array.isArray(call.input) || Object.keys(call.input).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(call.input, 'marker') || (call.input as Record<string, unknown>).marker !== marker) return unavailable();
  next('tool_result');const finalTask=await preparedCall('synthetic_protocol_tools_v1',{marker,stage:'final',callId:call.id});let final:Awaited<ReturnType<typeof converse>>;
  try{if(finalTask.operation!=='conversation')return unavailable();final=await converse(finalTask.configuration,finalTask.args as ConverseArgs);progress.answered=true;}finally{finalTask.dispose();}
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
