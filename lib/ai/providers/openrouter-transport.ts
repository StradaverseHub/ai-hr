/** UNREGISTERED server transport. No tenant/provider activation or authorization is established
 * here. The gateway owner must freshly authorize/redact every field BEFORE calling it and settle
 * actual usage honestly. No arbitrary endpoint, plugins, retries, tool execution or persistent key. */
import { z } from 'zod';
import { AiGatewayError, type ConverseArgs } from '../types';
import { buildOpenRouterRoutingPolicy } from './openrouter-policy';
import { readOpenRouterCompletion } from './openrouter-completion';
import { readOpenRouterAccounting } from './openrouter-accounting';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_BYTES = 2 * 1024 * 1024;
const unavailable = () => new AiGatewayError('AI provider response unavailable.');
const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
const id = z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/);
const model = z.string().min(3).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/)
  .refine(value => value !== 'openrouter/auto' && !value.startsWith('openrouter/auto:'));
const Configuration = z.object({ model, routing: z.unknown() }).strict();
const KeyConfiguration = Configuration.extend({
  apiKey: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/),
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
    const body = JSON.stringify({ model: cfg.model, messages, stream: false,
      max_completion_tokens: args.maxTokens ?? 2048, provider: buildOpenRouterRoutingPolicy(cfg.routing),
      ...(args.tools.length ? { tools: args.tools.map(tool => ({ type: 'function', function: {
        name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: true,
      } })), tool_choice: 'auto', parallel_tool_calls: false } : {}) });
    if (Buffer.byteLength(body, 'utf8') > MAX_BYTES) throw unavailable();
    return body;
  } catch { throw unavailable(); }
}

async function responseJson(response: Response, signal: AbortSignal, expired: () => boolean): Promise<unknown> {
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
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch { void reader.cancel().catch(() => {}); throw unavailable(); }
  finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

/** Fetch implementation is a server/test dependency, never a posted transport option. Factory
 * holds no credentials or tenant state. Exactly one fixed-endpoint request, no redirect or retry.
 * Deadline/cancellation covers headers AND bounded body reading, even if a test transport stalls. */
export function createOpenRouterTransport(fetcher: typeof fetch) {
  return async (configuration: unknown, args: ConverseArgs, signal?: AbortSignal) => {
    if (signal?.aborted) throw unavailable();
    let cfg: z.infer<typeof KeyConfiguration>, body: string;
    try { cfg = KeyConfiguration.parse(configuration); body = buildOpenRouterRequest({ model: cfg.model, routing: cfg.routing }, args); }
    catch { throw unavailable(); }
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
        const response = await fetcher(ENDPOINT, { method: 'POST', redirect: 'error', cache: 'no-store',
          headers: { Authorization: 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' },
          body, signal: controller.signal });
        const value = await responseJson(response, controller.signal, () => performance.now() - started >= timeoutMs);
        if (controller.signal.aborted || performance.now() - started >= timeoutMs) throw unavailable();
        const completion = readOpenRouterCompletion(value);
        const usage = value && typeof value === 'object' ? (value as Record<string, unknown>).usage : undefined;
        return { completion, accounting: readOpenRouterAccounting(usage), elapsedMs: performance.now() - started };
      };
      return await Promise.race([run(), cancelled]);
    } catch { throw unavailable(); }
    finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', abortWait);
    }
  };
}
