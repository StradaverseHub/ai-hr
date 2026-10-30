import {assertProviderPrivacyRequest,consumeProviderPrivacyRequest} from './provider-privacy-request';
import {withProviderEgressDispatch} from './provider-egress';
/**
 * AI gateway (ADR-0007 / ADR-0023). The single boundary between this product and any LLM provider.
 * Provider-agnostic: callers pass a already-resolved {provider, model, apiKey} and a redacted prompt;
 * this dispatches to the right adapter. Draft-only by contract — nothing here writes a review or pay.
 *
 * Mandatory disclosure enforcement binds reviewed minimized request bytes before admission.
 * Legacy redactPII remains a convenience helper, never proof that arbitrary prose is safe.
 * Unknown/unreviewed data shapes refuse; operational fixed probes contain no workload data.
 *
 * The provider client is constructed PER CALL inside each adapter from the resolved key — never cached
 * at module scope (a singleton would serve one tenant's drafts with another tenant's key).
 */
import { captureAiConfig,governed,textReservation,type UngovernedProbe } from './governance';
import { captureConversationInput, conversationInputDigest } from './conversation-input';
import {draftInputDigest} from './draft-input';
import {captureImageInput,imageInputDigest} from './image-input';
import { anthropicAdapter } from './providers/anthropic';
import { googleAdapter } from './providers/google';
import { openaiAdapter } from './providers/openai';
import { openrouterAdapter } from './providers/openrouter';
import { gatewayAdapter } from './providers/gateway';
import { AiImageReadError,imageReadError,validImageBytes } from './image-protocol';
import type { ImageReadArgs } from './types';
export { AiImageReadError } from './image-protocol';
export type { AiImageMime,ImageReadArgs } from './types';
import {
  AiGatewayError,
  type AiAdapter,
  type AiProvider,
  type AiRunObservation,
  type ConverseArgs,
  type ConverseResult,
  type GenerateArgs,
  type ResolvedAiConfig,
} from './types';

export { AiGatewayError, AiAllowanceError, normaliseStop } from './types';
export type { AiProvider, ResolvedAiConfig, GenerateArgs, ValidateResult } from './types';
export type {
  AiJsonSchema,
  AiToolSpec,
  AiToolCall,
  AiToolResult,
  AiProviderState,
  AiTurn,
  AiStop,
  AiUsage,
  ConverseArgs,
  ConverseResult,
} from './types';
export { PROVIDERS, PROVIDER_META, isProvider, defaultModelFor, envFallbackConfig, hasEnvFallback } from './registry';
export { isSecretStorable, SecretConfigError } from './crypto';

const ADAPTERS: Record<AiProvider, AiAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  google: googleAdapter,
  openrouter: openrouterAdapter,
  ai_gateway: gatewayAdapter,
};

function adapterFor(provider: AiProvider): AiAdapter {
  const a = ADAPTERS[provider];
  if (!a) throw new AiGatewayError(`Unknown AI provider: ${provider}`);
  return a;
}

/** One non-streaming generation against the resolved provider/model. Generic errors only. Throws if
 *  the provider returns no text (e.g. the whole budget was spent on thinking, or a safety block) so a
 *  caller never silently receives an empty draft. */
export async function generateDraft(cfg: ResolvedAiConfig, args: GenerateArgs): Promise<string> {
  args=Object.freeze({...args,system:args.system,prompt:args.prompt,maxTokens:args.maxTokens??2048});
  cfg=captureAiConfig(cfg);
  if(args.signal?.aborted)throw new AiGatewayError('Drafting was cancelled.');
  const inputDigest=draftInputDigest(args);
  assertProviderPrivacyRequest(cfg,'draft',inputDigest);
  return governed(cfg,{operation:'draft',reservedTokens:textReservation(args.system+args.prompt,args.maxTokens),inputDigest},(record,observe)=>{
   const assertPrivacy=consumeProviderPrivacyRequest(cfg,'draft',inputDigest);
   return withProviderEgressDispatch(cfg,{operation:'draft',inputDigest},()=>generateDraftTransport(cfg,{...args,onUsage:record,onObservation:cfg.provider==='openrouter'?observe:undefined}),assertPrivacy);
  });
}
async function generateDraftTransport(cfg: ResolvedAiConfig, args: GenerateArgs): Promise<string> {
  const adapter=adapterFor(cfg.provider);
  if(args.timeoutMs==null&&!args.signal){const text=await adapter.generate(cfg,args);if(!text)throw new AiGatewayError('No draft was produced — please try again.');return text;}
  const controller=new AbortController(),abort=()=>controller.abort(),timeoutMs=Math.min(22000,Math.max(1,Number.isFinite(args.timeoutMs)?args.timeoutMs!:22000));
  if(args.signal?.aborted){args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});throw new AiGatewayError('Drafting was cancelled.');}
  args.signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,timeoutMs);
  try{const text=await adapter.generate(cfg,{...args,signal:controller.signal,timeoutMs});if(!text)throw new AiGatewayError('No draft was produced — please try again.');return text;}
  finally{clearTimeout(timer);args.signal?.removeEventListener('abort',abort);}
}

export function supportsImageReading(provider:AiProvider){return typeof ADAPTERS[provider]?.readImage==='function';}
/** This operation never changes the existing text/conversation paths. Callers authorize the bytes before using it. */
export async function readImage(cfg:ResolvedAiConfig,args:Omit<ImageReadArgs,'signal'|'timeoutMs'>&Partial<Pick<ImageReadArgs,'signal'|'timeoutMs'>>){
 const captured=captureImageInput(args);
 cfg=captureAiConfig(cfg);
 if(!supportsImageReading(cfg.provider))throw new AiImageReadError(false);
 if(captured.signal?.aborted)throw new AiImageReadError(true);
 const inputDigest=imageInputDigest(captured);
 assertProviderPrivacyRequest(cfg,'image',inputDigest);
 return governed(cfg,{operation:'image',reservedTokens:Math.min(1000000000,Math.max(32768,captured.data.length*2)+2500),inputDigest},record=>{
  const assertPrivacy=consumeProviderPrivacyRequest(cfg,'image',inputDigest);
  return withProviderEgressDispatch(cfg,{operation:'image',inputDigest},()=>readImageTransport(cfg,{...captured,onUsage:record}),assertPrivacy);
 });
}
async function readImageTransport(cfg:ResolvedAiConfig,args:Omit<ImageReadArgs,'signal'|'timeoutMs'>&Partial<Pick<ImageReadArgs,'signal'|'timeoutMs'>>){
 if(!validImageBytes(args.data,args.mimeType))throw new AiImageReadError(false);
 const adapter=adapterFor(cfg.provider);if(!adapter.readImage)throw new AiImageReadError(false);
 const timeoutMs=Math.min(20000,Math.max(1,Number.isFinite(args.timeoutMs)?args.timeoutMs!:20000)),controller=new AbortController();
 const abort=()=>controller.abort();if(args.signal?.aborted)abort();else args.signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(abort,timeoutMs);
 try{
  if(controller.signal.aborted){args.onUsage?.({inputTokens:0,outputTokens:0,cachedInputTokens:0});throw new AiImageReadError(true);}
  const text=await adapter.readImage(cfg,{...args,signal:controller.signal,timeoutMs});
  if(controller.signal.aborted)throw new AiImageReadError(true);
  return Array.from(text.trim()).slice(0,6000).join('');
 }catch(error){throw imageReadError(error);}finally{clearTimeout(timer);args.signal?.removeEventListener('abort',abort);}
}

/** Cheapest credential+model probe. Returns ok/false + a generic reason; never throws. */
export function validateConfig(probe: UngovernedProbe) {
  const cfg=captureAiConfig(probe);
  return governed(cfg,{operation:'probe',reservedTokens:0},()=>withProviderEgressDispatch(cfg,{operation:'probe'},()=>adapterFor(cfg.provider).validate(cfg)));
}

/** Whether this provider can run the assistant loop (ADR-0082). A cheap UI gate that mirrors
 *  isAiConfigured — "this provider cannot converse" is a state a screen can render, not a crash. */
export function supportsConverse(provider: AiProvider): boolean {
  return typeof ADAPTERS[provider]?.converse === 'function';
}

/**
 * ONE non-streaming, tool-aware exchange against the resolved provider/model (ADR-0082). Generic errors
 * only. This is the assistant's transport; it is NOT a loop — the caller owns the turn cap, the budget
 * re-check, the audit row and the whole-exchange deadline.
 *
 * Deliberately does NOT throw on empty text. With tools, `stop === 'tool_use'` with an empty `text` is
 * the normal, correct shape — unlike generateDraft above, where empty means failure. The loop decides
 * what an empty answer means.
 *
 * `generateDraft` is NOT reimplemented on top of this, and must not be. Three test files mock `lib/ai`
 * as `{ ...importActual, generateDraft: vi.fn() }`; an intra-module call from generateDraft into
 * converse would NOT be intercepted, so those suites would make real network calls with a real key.
 * The two share adapters, error mapping and the per-call client factory — and share no call path.
 *
 * Full captured request bytes must match an opaque source-issued reviewed disclosure binding.
 * Raw history, system text, tool data and provider continuation cannot obtain a flag-based bypass.
 */
export async function converse(cfg: ResolvedAiConfig, args: ConverseArgs): Promise<ConverseResult> {
  cfg=captureAiConfig(cfg);
  args=captureConversationInput(args);
  const adapter = adapterFor(cfg.provider);
  if (!adapter.converse) throw new AiGatewayError('This AI provider does not support the assistant.');
  // Defaults are normalised HERE, not per adapter, so a fourth adapter cannot silently send `undefined`
  // and inherit a server-side default nobody chose.
  const text=args.system.join('')+JSON.stringify(args.tools)+args.turns.map(t=>t.role==='tool'?t.results.map(r=>r.content).join(''):t.content).join('');
  const inputDigest=conversationInputDigest(args);
  assertProviderPrivacyRequest(cfg,'conversation',inputDigest);
  return governed(cfg,{operation:'conversation',reservedTokens:textReservation(text,args.maxTokens),inputDigest},async(record,observe)=>{
   const assertPrivacy=consumeProviderPrivacyRequest(cfg,'conversation',inputDigest);
   return withProviderEgressDispatch(cfg,{operation:'conversation',inputDigest},async()=>{let terminalObserved=false;const terminal:{usage:AiRunObservation['usage']}={usage:null};const result=await adapter.converse!(cfg,{...args,...(cfg.provider==='openrouter'?{onObservation:(observation:AiRunObservation)=>{
   terminalObserved=true;terminal.usage=observation.usage;observe?.(observation);if(observation.usage)record(observation.usage);
  }}:{}),maxTokens:args.maxTokens??2048,timeoutMs:args.timeoutMs??120_000});
  if(terminalObserved){const usage=terminal.usage,reported=result.usageReported===true;if(reported?(!usage||usage.inputTokens!==result.usage.inputTokens||usage.outputTokens!==result.usage.outputTokens||usage.cachedInputTokens!==result.usage.cachedInputTokens):usage!==null)throw new AiGatewayError('The AI provider usage could not be confirmed.');}
  // A charged-but-rejected completion may never return. Actual terminal usage is already recorded
  // by the trusted adapter callback; do not double-record successful OpenRouter counters.
  if(!terminalObserved&&(result.usageReported??[result.usage.inputTokens,result.usage.outputTokens,result.usage.cachedInputTokens].some(n=>n>0)))record(result.usage);return result;},assertPrivacy);});
}

/**
 * Mask a few direct identifiers before free text leaves the tenant for a model. Conservative — only
 * high-precision patterns (emails, Malaysian IC numbers, long phone-like runs), so ordinary prose is
 * untouched. It NEVER masks names: a name typed into free text passes through, and some prompt builders
 * deliberately send a first name or a structured name field. Callers that must withhold a name have to
 * leave it out of the prompt themselves; this function is not a PII guarantee.
 */
export function redactPII(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\b\d{6}-\d{2}-\d{4}\b/g, '[id]') // MY IC, dashed
    .replace(/\b\d{12}\b/g, '[id]') // MY IC, undashed
    .replace(/\b(?:\+?6?0)\d[\d\s-]{6,}\d\b/g, '[phone]') // MY phone-like runs
    .trim();
}
