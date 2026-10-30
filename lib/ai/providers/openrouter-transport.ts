import {consumeOpenRouterProviderEgress} from '../provider-egress';
/** UNRELEASED fixed-endpoint server transport. No tenant/provider activation or authorization is established
 * here. The gateway owner must freshly authorize/redact every field BEFORE calling it and settle
 * actual usage honestly. No arbitrary endpoint, enabled plugins, retries, tool execution or persistent key. */
import { z } from 'zod';
import { AiGatewayError, type ConverseArgs } from '../types';
import { buildOpenRouterRoutingPolicy } from './openrouter-policy';
import { readOpenRouterCompletion } from './openrouter-completion';
import { readOpenRouterAccounting,type OpenRouterAccounting } from './openrouter-accounting';
import {observeOpenRouterSpendTerminal} from '../spend-receipt';
import {enforceReviewedMeteredBody,consumeReviewedMeteredPost} from './openrouter-fixed-metered-carrier';
import {enforceReviewedFreeBody,consumeReviewedFreePost} from './openrouter-fixed-free-carrier';
import {readOpenRouterOptions} from './openrouter-configuration';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_BYTES = 2 * 1024 * 1024;
// Official ChatRequest plugin schemas checked 29 October 2026 (pinned in the contract test).
// Send opt-outs only for plugins with a documented boolean `enabled` property. In particular,
// jev-router rejects this extra property; switchyard-router/web-fetch declare no off switch either.
// Do not list those plugins as if `enabled:false` disabled them: listing a plugin can opt into it.
// Account-default review remains mandatory; request opt-outs cannot certify enforced defaults.
// Preserve account security guardrails (alignment/armor/moderation).
const DISABLED_PROCESSORS = ['auto-beta-router','auto-router','context-compression','file-parser',
  'fusion','pareto-router','response-healing','web'] as const;

const unavailable = () => new AiGatewayError('AI provider response unavailable.');
type FailurePhase = 'configuration' | 'request' | 'dispatch' | 'network' | 'response' | 'accounting' | 'completion' | 'cancelled';
/** Closed operational metadata only. Never pass an exception, request or response to the sink.
 * Public errors remain generic, and a broken diagnostic sink cannot replace that boundary. */
function diagnosticFailure(phase: FailurePhase, status: number | null) {
  const httpStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  try { console.warn('[ai-provider-transport-failure]', { provider: 'openrouter', phase, httpStatus }); }
  catch { /* Logging cannot expose a sink exception or change provider failure semantics. */ }
  return unavailable();
}
const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/).refine(value=>value.trim()===value);
const id = z.string().min(1).max(256).refine(value=>!/[\u0000-\u001f\u007f]/.test(value));
export const OpenRouterModel = z.string().min(3).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(?::free)?$/)
  .refine(value => value.trim()===value && !value.toLowerCase().startsWith('openrouter/'));
const Configuration = z.object({ model: OpenRouterModel, routing: z.unknown() }).strict();
export const OpenRouterTransportConfiguration = Configuration.extend({
  apiKey: z.string().min(1).max(4096).refine(value=>! /[^\x21-\x7e]/.test(value)),
});
const Call = z.object({ id, name, input: z.unknown().refine(value => value !== undefined) }).strict();
const Arguments = z.object({
  system: z.array(z.string().max(65_536)).min(1).max(16),
  turns: z.array(z.discriminatedUnion('role', [
    z.object({ role: z.literal('user'), content: z.string().max(262_144) }).strict(),
    z.object({ role: z.literal('assistant'), content: z.string().max(262_144),
      toolCalls: z.array(Call).max(32).optional(), providerState: z.unknown().optional() }).strict(),
    z.object({ role: z.literal('tool'), results: z.array(z.object({ id, name,
      content: z.string().max(262_144), isError: z.boolean().optional() }).strict()).min(1).max(32) }).strict(),
  ])).min(1).max(128),
  tools: z.array(z.object({ name, description: z.string().max(16_384),
    inputSchema: z.object({ type: z.literal('object'), properties: z.record(z.string(), z.unknown()),
      required: z.array(z.string()).max(512), additionalProperties: z.literal(false) }).strict(),
  }).strict()).max(32),
  maxTokens: z.number().int().min(1).max(32_768).optional(),
  timeoutMs: z.number().int().min(1).max(120_000).optional(),
  cacheKey: z.string().max(512).optional(),
}).strict();

/** Constructs only explicitly supported fields. No key, routing override, user identifier, cache
 * hint, opaque reasoning state, server tool or plugin is copied into the body by a generic spread.
 * History correlation is protocol integrity; it is NOT fresh data/tool authorization. */
export function buildOpenRouterRequest(configuration: unknown, argumentsValue: unknown): string {
  try {
    const cfg = Configuration.parse(configuration), args = Arguments.parse(argumentsValue);
    const tools = new Set(args.tools.map(tool => tool.name));
    if (tools.size !== args.tools.length || args.turns[0].role !== 'user'
      || args.turns[args.turns.length - 1].role === 'assistant') throw unavailable();
    const pending = new Map<string, string>(), seen = new Set<string>();
    const messages: Record<string, unknown>[] = [{ role: 'system', content: args.system.join('\n\n') }];
    for (const turn of args.turns) {
      if (turn.role === 'tool') {
        for (const result of turn.results) {
          if (pending.get(result.id) !== result.name) throw unavailable();
          pending.delete(result.id);
          messages.push({ role: 'tool', tool_call_id: result.id, content: result.content });
        }
      } else {
        if (pending.size) throw unavailable();
        if (turn.role === 'user') messages.push({ role: 'user', content: turn.content });
        else {
          const calls = (turn.toolCalls ?? []).map(call => {
            if (seen.has(call.id) || !tools.has(call.name)) throw unavailable();
            const input = JSON.stringify(call.input);
            if (input === undefined || Buffer.byteLength(input, 'utf8') > 65_536) throw unavailable();
            seen.add(call.id); pending.set(call.id, call.name);
            return { id: call.id, type: 'function', function: { name: call.name, arguments: input } };
          });
          messages.push({ role: 'assistant', content: turn.content,
            ...(calls.length ? { tool_calls: calls } : {}) });
        }
      }
    }
    if (pending.size) throw unavailable();
    const body = JSON.stringify(enforceReviewedMeteredBody(cfg,argumentsValue as ConverseArgs,enforceReviewedFreeBody(cfg,argumentsValue as ConverseArgs,{ model: cfg.model, messages, stream: false,
      max_completion_tokens: args.maxTokens ?? 2048, provider: buildOpenRouterRoutingPolicy(cfg.routing),
      plugins: DISABLED_PROCESSORS.map(id=>({id,enabled:false})),
      ...(args.tools.length ? { tools: args.tools.map(tool => ({ type: 'function', function: {
        name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: true,
      } })), tool_choice: 'auto' } : {}) })));
    if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) throw unavailable();
    return body;
  } catch { throw unavailable(); }
}

export async function readOpenRouterJsonResponse(response: Response, signal: AbortSignal, expired: () => boolean,onRaw?:(raw:string)=>void): Promise<unknown> {
  if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    void response.body?.cancel().catch(() => {}); throw unavailable();
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > MAX_BYTES)) {
    void response.body?.cancel().catch(() => {}); throw unavailable();
  }
  if (!response.body) throw unavailable();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0, reads = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted || expired() || ++reads > 4096) throw unavailable();
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength; if (bytes > MAX_BYTES) throw unavailable();
      chunks.push(part.value);
    }
    const body = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    const raw=new TextDecoder('utf-8', { fatal: true }).decode(body),value=JSON.parse(raw);onRaw?.(raw);return value;
  } catch { void reader.cancel().catch(() => {}); throw unavailable(); }
  finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

/** Fetch implementation is a server/test dependency, never a posted transport option. Factory
 * holds no credentials or tenant state. Exactly one fixed-endpoint request, no redirect or retry.
 * Deadline/cancellation covers headers AND bounded body reading, even if a test transport stalls. */
export type OpenRouterTerminalObservation=Readonly<{accounting:OpenRouterAccounting;elapsedMs:number}>;
export function createOpenRouterTransport(fetcher: typeof fetch) {
  return async (configuration: unknown, args: ConverseArgs, signal?: AbortSignal,onTerminal?:(observation:OpenRouterTerminalObservation)=>void) => {
    if (signal?.aborted) throw diagnosticFailure('cancelled', null);
    let cfg: z.infer<typeof OpenRouterTransportConfiguration>, body: string;
    let phase: FailurePhase = 'configuration', httpStatus: number | null = null;
    try {
      cfg = OpenRouterTransportConfiguration.parse(configuration);
      phase = 'request'; body = buildOpenRouterRequest({ model: cfg.model, routing: cfg.routing }, args);
    } catch { throw diagnosticFailure(phase, null); }
    const controller = new AbortController(), timeoutMs = args.timeoutMs ?? 30_000, started = performance.now();
    const abort = () => controller.abort();
    let abortWait!: () => void;
    const cancelled = new Promise<never>((_, reject) => { abortWait = () => reject(unavailable()); });
    // Observe early cancellation even if it arrives before the race is installed.
    void cancelled.catch(() => {});
    controller.signal.addEventListener('abort', abortWait, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, timeoutMs);
    try {
      if (controller.signal.aborted) throw unavailable();
      const run = async () => {
        phase = 'dispatch';
        consumeOpenRouterProviderEgress({provider:'openrouter',model:cfg.model,apiKey:cfg.apiKey,providerOptions:readOpenRouterOptions({version:1,routing:cfg.routing})},args);
        consumeReviewedFreePost({provider:'openrouter',model:cfg.model,apiKey:cfg.apiKey,providerOptions:readOpenRouterOptions({version:1,routing:cfg.routing})},body);
        consumeReviewedMeteredPost({provider:'openrouter',model:cfg.model,apiKey:cfg.apiKey,providerOptions:readOpenRouterOptions({version:1,routing:cfg.routing})},body);
        phase = 'network';
        const response = await fetcher(ENDPOINT, { method: 'POST', redirect: 'error', cache: 'no-store',
          headers: { Authorization: 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' },
          body, signal: controller.signal });
        phase = 'response'; httpStatus = response.status;
        let raw='';
        const expired=()=>performance.now()-started>=timeoutMs;
        const value = await readOpenRouterJsonResponse(response, controller.signal,expired,text=>{raw=text;});
        if (controller.signal.aborted || performance.now() - started >= timeoutMs) throw unavailable();
        phase = 'accounting';
        const usage = value && typeof value === 'object' ? (value as Record<string, unknown>).usage : undefined;
        const accounting=readOpenRouterAccounting(usage),elapsedMs=performance.now()-started;
        // Complete bounded HTTP200 JSON may report a charge even when choices/error fields refuse
        // completion. Observe exactly once BEFORE content parsing; never expose the body/cause.
        // Official: /docs/cookbook/administration/usage-accounting and /docs/api_reference/errors-and-debugging.
        onTerminal?.(Object.freeze({accounting,elapsedMs}));
        await observeOpenRouterSpendTerminal(raw,{provider:'openrouter',model:cfg.model,apiKey:cfg.apiKey,providerOptions:readOpenRouterOptions({version:1,routing:cfg.routing})},controller.signal,expired,fetcher,async metadataResponse=>{let text='';await readOpenRouterJsonResponse(metadataResponse,controller.signal,expired,raw=>{text=raw;});return text;});
        phase = 'completion';
        const completion = readOpenRouterCompletion(value);
        // Some approved endpoints support tools but not the optional parallel_tool_calls parameter.
        // Preserve sequential tool execution deterministically instead of sending an unsupported flag.
        if (completion.toolCalls.length > 1) throw unavailable();
        return { completion, accounting, elapsedMs };
      };
      return await Promise.race([run(), cancelled]);
    } catch { throw diagnosticFailure(controller.signal.aborted ? 'cancelled' : phase, httpStatus); }
    finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', abortWait);
    }
  };
}
