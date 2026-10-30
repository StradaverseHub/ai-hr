import {fixtureOpenRouterTransport as createOpenRouterTransport} from './helpers/provider-egress-fixture';
/** Authored mocked-only transport acceptance. UNRUN; no real key, network or HR records. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOpenRouterRequest } from '../lib/ai/providers/openrouter-transport';
import { AiGatewayError, type ConverseArgs } from '../lib/ai/types';
const secret = 'fictional-openrouter-key-never-use';
const config = () => ({ model: 'openai/fictional-model', apiKey: secret,
  routing: { allowedProviders: ['openai'], allowFallbacks: false, sort: 'latency' } });
const args = (): ConverseArgs => ({ system: ['Fictional bounded system'], turns: [{ role: 'user', content: 'Fictional task' }], tools: [] });
const payload = () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Fictional response' } }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, prompt_tokens_details: { cached_tokens: 0 }, cost: 0 } });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const tool = { name: 'fictional_read', description: 'Fictional local read only',
  inputSchema: { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const } };
const toolArgs = (): ConverseArgs => ({ ...args(), tools: [tool], turns: [
  { role: 'user', content: 'Fictional task' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'fictional_call_1', name: tool.name, input: {} }] },
  { role: 'tool', results: [{ id: 'fictional_call_1', name: tool.name, content: 'Fictional permitted result' }] },
] });
afterEach(() => vi.useRealTimers());

describe('unregistered OpenRouter request boundary', () => {
  it('constructs only supported fields and pins routing/privacy without copying opaque state or cache identity', () => {
    const input = toolArgs(); input.cacheKey = 'fictional-cache-identity';
    const assistant = input.turns[1];
    if (assistant.role !== 'assistant') throw new Error('Fictional assistant fixture missing');
    assistant.providerState = { provider: 'anthropic', blocks: ['fictional-opaque-state'] };
    const c = config(), body = JSON.parse(buildOpenRouterRequest({ model: c.model, routing: c.routing }, input));
    expect(body).toMatchObject({ stream: false, max_completion_tokens: 2048,
      provider: { only: ['openai'], order: ['openai'], allow_fallbacks: false,
        require_parameters: true, data_collection: 'deny', zdr: true } });
    expect(body.messages[2].tool_calls[0].function.arguments).toBe('{}');
    expect(body.messages[3]).toEqual({ role: 'tool', tool_call_id: 'fictional_call_1', content: 'Fictional permitted result' });
    expect(body.plugins).toContainEqual({id:'web',enabled:false});
    expect(body.plugins).toContainEqual({id:'fusion',enabled:false});
    expect(body.plugins.every((plugin:{enabled:boolean})=>plugin.enabled===false)).toBe(true);
    expect(body.plugins.some((plugin:{id:string})=>['alignment','armor','moderation'].includes(plugin.id))).toBe(false);
    for (const key of ['apiKey', 'user', 'session_id', 'cacheKey', 'providerState', 'max_tokens', 'parallel_tool_calls']) expect(body).not.toHaveProperty(key);
    expect(JSON.stringify(body)).not.toContain('fictional-opaque-state');
    expect(JSON.stringify(body)).not.toContain('fictional-cache-identity');
  });

  it('accepts narrow fixed :free syntax without claiming an eligible live ZDR/tool route or monetary certificate', () => {
    const c=config(), body=JSON.parse(buildOpenRouterRequest({model:'fictional/model:free',routing:c.routing},args()));
    expect(body.model).toBe('fictional/model:free');expect(body.provider).toMatchObject({only:['openai'],allow_fallbacks:false,zdr:true,data_collection:'deny'});
    // Ordinary syntax validation has no private reviewed dispatch authority and invents no price proof.
    expect(body.provider).not.toHaveProperty('max_price');
    for(const model of ['fictional/model:online','fictional/model:nitro','fictional/model:free:online','openrouter/free'])expect(()=>buildOpenRouterRequest({model,routing:c.routing},args())).toThrow(AiGatewayError);
  });

  it.each(['duplicate-call', 'wrong-result', 'unknown-tool', 'unfinished', 'cyclic-input'] as const)
  ('refuses %s before transport instead of repairing the tool graph silently', flaw => {
    const input = toolArgs(), assistant = input.turns[1], result = input.turns[2];
    if (assistant.role !== 'assistant' || result.role !== 'tool') throw new Error('Fictional protocol fixture missing');
    if (flaw === 'duplicate-call') assistant.toolCalls!.push({ ...assistant.toolCalls![0] });
    if (flaw === 'wrong-result') result.results[0].id = 'orphan';
    if (flaw === 'unknown-tool') assistant.toolCalls![0].name = 'not_advertised';
    if (flaw === 'unfinished') input.turns.pop();
    if (flaw === 'cyclic-input') { const cycle: { next?: unknown } = {}; cycle.next = cycle; assistant.toolCalls![0].input = cycle; }
    const c = config(); expect(() => buildOpenRouterRequest({ model: c.model, routing: c.routing }, input)).toThrow(AiGatewayError);
  });

  it('refuses oversized UTF-8 bodies, automatic model routing and endpoint/plugin overrides', () => {
    const c = config(), input = args();
    input.turns = Array.from({ length: 6 }, () => ({ role: 'user' as const, content: '😀'.repeat(100_000) }));
    expect(() => buildOpenRouterRequest({ model: c.model, routing: c.routing }, input)).toThrow(AiGatewayError);
    expect(() => buildOpenRouterRequest({ model: 'openrouter/auto', routing: c.routing }, args())).toThrow(AiGatewayError);
    expect(() => buildOpenRouterRequest({ model: c.model, routing: c.routing, baseURL: 'https://example.invalid' }, args())).toThrow(AiGatewayError);
    expect(() => buildOpenRouterRequest({ model: c.model, routing: c.routing }, { ...args(), plugins: ['web'] })).toThrow(AiGatewayError);
  });
});

describe('unregistered OpenRouter fixed-endpoint transport', () => {
  it('performs one exact POST and returns honest usage/credit metadata without exposing the key', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(payload()));
    const result = await createOpenRouterTransport(fetcher)(config(), args());
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store',
      headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.body).not.toContain(secret);
    expect(result.completion).toMatchObject({ text: 'Fictional response', stop: 'end', toolCalls: [], usageReported: true,
      usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 0 } });
    expect(result.accounting).toMatchObject({ totalTokens: 5, accountCostCredits: 0 });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0); expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('keeps missing usage and cost explicitly unknown', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ choices: payload().choices }));
    const result = await createOpenRouterTransport(fetcher)(config(), args());
    expect(result.completion.usageReported).toBe(false);
    expect(result.accounting).toMatchObject({ totalTokens: null, usage: null, accountCostCredits: null });
  });

  it.each(['network', 'http', 'body-error', 'non-json', 'oversized'] as const)
  ('sanitizes %s and never retries', async fault => {
    const fetcher = vi.fn<typeof fetch>();
    if (fault === 'network') fetcher.mockRejectedValue(new Error(secret + ' fictional private upstream body'));
    else if (fault === 'http') fetcher.mockResolvedValue(response({ error: secret }, 429));
    else if (fault === 'body-error') fetcher.mockResolvedValue(response({ ...payload(), error: { message: secret } }));
    else if (fault === 'non-json') fetcher.mockResolvedValue(new Response(secret, { headers: { 'Content-Type': 'text/html' } }));
    else fetcher.mockResolvedValue(new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }));
    const error = await createOpenRouterTransport(fetcher)(config(), args()).catch(value => value);
    expect(error).toBeInstanceOf(AiGatewayError); expect(error.message).toBe('AI provider response unavailable.');
    expect(error.cause).toBeUndefined(); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not call transport when already cancelled or when configuration attempts to override the endpoint', async () => {
    const controller = new AbortController(); controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(createOpenRouterTransport(fetcher)(config(), args(), controller.signal)).rejects.toBeInstanceOf(AiGatewayError);
    await expect(createOpenRouterTransport(fetcher)({ ...config(), endpoint: 'https://example.invalid' }, args())).rejects.toBeInstanceOf(AiGatewayError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('bounds an unresponsive fetch even when the mock ignores cancellation', async () => {
    vi.useFakeTimers(); const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => {}));
    const pending = createOpenRouterTransport(fetcher)(config(), { ...args(), timeoutMs: 5 });
    const assertion = expect(pending).rejects.toBeInstanceOf(AiGatewayError);
    await vi.advanceTimersByTimeAsync(5); await assertion; expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cancels a stalled response body and refuses excessive empty fragments', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const controller = new AbortController(), fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { headers: { 'Content-Type': 'application/json' } }));
    const pending = createOpenRouterTransport(fetcher)(config(), args(), controller.signal);
    const assertion = expect(pending).rejects.toBeInstanceOf(AiGatewayError);
    await Promise.resolve(); controller.abort(); await assertion; await Promise.resolve(); expect(cancelled).toBe(true);
    const empty = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new Uint8Array(0)); } });
    const fragmented = vi.fn<typeof fetch>().mockResolvedValue(new Response(empty, { headers: { 'Content-Type': 'application/json' } }));
    await expect(createOpenRouterTransport(fragmented)(config(), args())).rejects.toBeInstanceOf(AiGatewayError);
  });
});
