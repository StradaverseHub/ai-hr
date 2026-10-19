/**
 * r570 — the OpenRouter adapter (lib/ai/providers/openrouter.ts). No database, no network: the real
 * `openai` SDK runs end to end against a stubbed `globalThis.fetch` (the SDK reads the global fetch when
 * each per-call client is constructed — node_modules/openai/internal/shims.js getDefaultFetch), so what
 * is asserted is what would actually go on the wire.
 *
 * Pinned: the fixed host; no OpenAI account headers even when the OPENAI_* env vars are set; the
 * no-training / no-retention routing policy on every completion; `system` + `max_tokens`; NO retries;
 * the usage mapping and "no usage → no record"; the tool round trip; generic, key-free errors; the two
 * validate probes; no image reading; and a governance refusal that stops before any transport.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AiAllowanceError,
  AiGatewayError,
  AiImageReadError,
  PROVIDERS,
  PROVIDER_META,
  converse,
  envFallbackConfig,
  generateDraft,
  readImage,
  supportsConverse,
  supportsImageReading,
  validateConfig,
  type ResolvedAiConfig,
} from '../lib/ai';
import { OPENROUTER_BASE_URL, openrouterAdapter } from '../lib/ai/providers/openrouter';
import type { AiGovernance } from '../lib/ai/governance';

const KEY = 'sk-or-v1-LEAKCANARY123';
const cfg: ResolvedAiConfig = { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', apiKey: KEY };

type Call = { url: string; method: string; headers: Headers; body: Record<string, unknown> | null };
let calls: Call[] = [];
let replies: Array<() => Response | Promise<Response>> = [];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const completion = (over: Record<string, unknown> = {}) => ({
  id: 'gen-1',
  object: 'chat.completion',
  created: 1,
  model: cfg.model,
  choices: [{ index: 0, message: { role: 'assistant', content: 'Hello there', refusal: null }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 30 } },
  ...over,
});

const ENV_KEYS = ['OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'OPENAI_BASE_URL', 'OPENAI_ADMIN_KEY', 'OPENROUTER_API_KEY'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  calls = [];
  replies = [];
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Every one of these would be picked up by an OpenAI client constructed without explicit options.
  process.env.OPENAI_ORG_ID = 'org-ENVLEAK';
  process.env.OPENAI_PROJECT_ID = 'proj-ENVLEAK';
  process.env.OPENAI_BASE_URL = 'https://evil.example/v1';
  process.env.OPENAI_ADMIN_KEY = 'sk-admin-ENVLEAK';
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const raw = init?.body;
    calls.push({ url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: typeof raw === 'string' ? JSON.parse(raw) : null });
    const next = replies.shift();
    if (!next) throw new Error('unexpected fetch');
    return next();
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function expectWireSafe(call: Call, path: string) {
  expect(call.url).toBe(`${OPENROUTER_BASE_URL}${path}`);
  expect(new URL(call.url).origin + new URL(call.url).pathname).toMatch(/^https:\/\/openrouter\.ai\/api\/v1\//);
  expect(call.headers.get('openai-organization')).toBeNull();
  expect(call.headers.get('openai-project')).toBeNull();
  expect(call.headers.get('http-referer')).toBeNull();
  expect(call.headers.get('x-title')).toBeNull();
  expect(call.headers.get('authorization')).toBe(`Bearer ${KEY}`);
  expect(JSON.stringify([...call.headers.entries()])).not.toContain('ENVLEAK');
}

describe('registry', () => {
  it('lists OpenRouter last, opt-in, with no env key, so the env fallback can never select it', () => {
    expect(PROVIDERS).toEqual(['anthropic', 'openai', 'google', 'openrouter']);
    expect(PROVIDER_META.openrouter.envKeyVars).toEqual([]);
    expect(PROVIDER_META.openrouter.optIn).toBe(true);
    expect(PROVIDERS.filter((p) => PROVIDER_META[p].optIn)).toEqual(['openrouter']);
    expect(PROVIDER_META.openrouter.models).toContain(PROVIDER_META.openrouter.defaultModel);
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-platform';
    const saved = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY'].map((k) => [k, process.env[k]] as const);
    for (const [k] of saved) delete process.env[k];
    try {
      expect(envFallbackConfig()).toBeNull();
    } finally {
      for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
    }
  });

  it('keeps the production defaults and drops the shut-down Gemini 2.0 ids', () => {
    expect(PROVIDER_META.anthropic.defaultModel).toBe('claude-opus-4-8');
    expect(PROVIDER_META.openai.defaultModel).toBe('gpt-5.5');
    expect(PROVIDER_META.google.defaultModel).toBe('gemini-3.8-flash');
    expect(PROVIDER_META.google.models.some((m) => m.startsWith('gemini-2.0'))).toBe(false);
    for (const p of PROVIDERS) expect(PROVIDER_META[p].models).toContain(PROVIDER_META[p].defaultModel);
  });
});

describe('generate', () => {
  it('sends one policy-bound request to the fixed host and maps usage', async () => {
    replies.push(() => json(200, completion()));
    const onUsage = vi.fn();
    await expect(openrouterAdapter.generate(cfg, { system: 'You draft.', prompt: 'Draft it.', maxTokens: 512, onUsage })).resolves.toBe('Hello there');
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expect(c.method).toBe('POST');
    expectWireSafe(c, '/chat/completions');
    expect(c.body).toMatchObject({
      model: cfg.model,
      max_tokens: 512,
      messages: [
        { role: 'system', content: 'You draft.' },
        { role: 'user', content: 'Draft it.' },
      ],
    });
    expect(c.body!.provider).toEqual({ data_collection: 'deny', zdr: true, require_parameters: true });
    for (const k of ['max_completion_tokens', 'prompt_cache_key', 'parallel_tool_calls']) expect(c.body).not.toHaveProperty(k);
    expect(JSON.stringify(c.body)).not.toContain('developer');
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 70, outputTokens: 20, cachedInputTokens: 30 });
  });

  it('does not record usage when it is absent or malformed', async () => {
    const onUsage = vi.fn();
    replies.push(() => json(200, completion({ usage: undefined })));
    await openrouterAdapter.generate(cfg, { system: 's', prompt: 'p', onUsage });
    replies.push(() => json(200, completion({ usage: { prompt_tokens: '100', completion_tokens: 20 } })));
    await openrouterAdapter.generate(cfg, { system: 's', prompt: 'p', onUsage });
    replies.push(() => json(200, completion({ usage: { prompt_tokens: -1, completion_tokens: 20 } })));
    await openrouterAdapter.generate(cfg, { system: 's', prompt: 'p', onUsage });
    expect(calls).toHaveLength(3);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it.each([500, 429, 502, 503])('makes exactly one request on a %i (no retries)', async (status) => {
    replies.push(() => json(status, { error: { code: status, message: 'upstream' } }));
    replies.push(() => json(200, completion()));
    await expect(openrouterAdapter.generate(cfg, { system: 's', prompt: 'p' })).rejects.toBeInstanceOf(AiGatewayError);
    expect(calls).toHaveLength(1);
  });

  it('treats a 200 that carries an embedded error as a failure, never as a (partial) draft', async () => {
    replies.push(() => json(200, { id: 'gen-x', error: { code: 503, message: `no provider for ${KEY}` } }));
    await expect(openrouterAdapter.generate(cfg, { system: 's', prompt: 'p' })).rejects.toThrow('no-training, no-retention');
    const onUsage = vi.fn();
    replies.push(() =>
      json(200, completion({ choices: [{ index: 0, message: { role: 'assistant', content: 'partial output' }, finish_reason: 'error', error: { code: 502, message: 'gone' } }] })),
    );
    await expect(openrouterAdapter.generate(cfg, { system: 's', prompt: 'p', onUsage })).rejects.toThrow('No OpenRouter provider is available right now');
    // The tokens were spent, so they are still recorded.
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 70, outputTokens: 20, cachedInputTokens: 30 });
  });
});

describe('errors are generic and never carry the key', () => {
  const cases: Array<[number, string]> = [
    [401, 'Invalid API key'],
    [402, 'OpenRouter credits are exhausted'],
    [403, 'OpenRouter declined this request (a key spending limit, guardrail or content policy)'],
    [404, 'Model not available, or no OpenRouter provider meets the no-training, no-retention policy'],
    [408, 'No OpenRouter provider is available right now'],
    [429, 'Rate limited — try again shortly'],
    [500, 'Could not reach OpenRouter'],
    [502, 'No OpenRouter provider is available right now'],
    [503, 'No OpenRouter provider that meets the no-training, no-retention policy is available right now'],
  ];
  it.each(cases)('%i → %s', async (status, message) => {
    // The provider body ECHOES the key, as some upstreams do in auth errors.
    replies.push(() => json(status, { error: { code: status, message: `Bad key ${KEY}`, metadata: { raw: KEY } } }));
    const error = await openrouterAdapter.converse!(cfg, { system: ['s'], turns: [{ role: 'user', content: 'q' }], tools: [] }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(AiGatewayError);
    expect(error!.message).toBe(message);
    const everything = `${JSON.stringify(error)} ${error!.message} ${error!.stack ?? ''} ${String((error as { cause?: unknown }).cause ?? '')}`;
    expect(everything).not.toContain('LEAKCANARY');
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('a transport failure is generic too', async () => {
    replies.push(() => Promise.reject(new TypeError(`connect failed for ${KEY}`)));
    const error = await openrouterAdapter.generate(cfg, { system: 's', prompt: 'p' }).then(() => null, (e: unknown) => e as Error);
    expect(error).toBeInstanceOf(AiGatewayError);
    expect(error!.message).toBe('Could not reach OpenRouter');
    expect(`${JSON.stringify(error)} ${error!.stack}`).not.toContain('LEAKCANARY');
  });
});

describe('converse', () => {
  const tool = {
    name: 'find_employee',
    description: 'Find an employee by name.',
    inputSchema: { type: 'object' as const, properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false as const },
  };

  it('round-trips a tool call with the shared translation', async () => {
    replies.push(() =>
      json(200, completion({
        choices: [{
          index: 0,
          message: { role: 'assistant', content: null, refusal: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'find_employee', arguments: '{"name":"Bo"}' } }] },
          finish_reason: 'tool_calls',
        }],
      })),
    );
    const result = await converse(cfg, {
      system: ['Stable A', 'Stable B'],
      tools: [tool],
      cacheKey: 'digest-never-sent',
      turns: [
        { role: 'user', content: 'Who is Ann?' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'find_employee', input: { name: 'Ann' } }] },
        { role: 'tool', results: [{ id: 'call_1', name: 'find_employee', content: 'no match', isError: true }] },
      ],
    });
    expect(result.stop).toBe('tool_use');
    expect(result.toolCalls).toEqual([{ id: 'call_2', name: 'find_employee', input: { name: 'Bo' } }]);
    expect(result.usage).toEqual({ inputTokens: 70, outputTokens: 20, cachedInputTokens: 30 });
    expect(result.usageReported).toBe(true);
    expect(calls).toHaveLength(1);
    const [c] = calls;
    expectWireSafe(c, '/chat/completions');
    expect(c.body!.provider).toEqual({ data_collection: 'deny', zdr: true, require_parameters: true });
    expect(c.body!.max_tokens).toBe(2048);
    expect(c.body!.tool_choice).toBe('auto');
    for (const k of ['max_completion_tokens', 'prompt_cache_key', 'parallel_tool_calls']) expect(c.body).not.toHaveProperty(k);
    expect(c.body!.messages).toEqual([
      { role: 'system', content: 'Stable A\n\nStable B' },
      { role: 'user', content: 'Who is Ann?' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'find_employee', arguments: '{"name":"Ann"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'ERROR: no match' },
    ]);
    expect(c.body!.tools).toEqual([{ type: 'function', function: { name: 'find_employee', description: tool.description, parameters: tool.inputSchema, strict: true } }]);
  });

  it('reports usageReported false when usage is absent', async () => {
    replies.push(() => json(200, completion({ usage: undefined })));
    const result = await openrouterAdapter.converse!(cfg, { system: ['s'], turns: [{ role: 'user', content: 'q' }], tools: [] });
    expect(result.usageReported).toBe(false);
    expect(result.text).toBe('Hello there');
  });
});

describe('validate', () => {
  it('a rejected key is "Invalid API key" after one probe', async () => {
    replies.push(() => json(401, { error: { code: 401, message: `No auth credentials found ${KEY}` } }));
    await expect(validateConfig(cfg)).resolves.toEqual({ ok: false, error: 'Invalid API key' });
    expect(calls).toHaveLength(1);
    expectWireSafe(calls[0], '/key');
    expect(calls[0].method).toBe('GET');
  });

  it('an unknown model is reported, a listed one passes', async () => {
    replies.push(() => json(200, { data: { label: 'k' } }));
    replies.push(() => json(200, { data: [{ id: 'openai/gpt-6-luna' }] }));
    await expect(validateConfig(cfg)).resolves.toEqual({ ok: false, error: 'Model not available on OpenRouter' });
    expect(calls.map((c) => c.url)).toEqual([`${OPENROUTER_BASE_URL}/key`, `${OPENROUTER_BASE_URL}/models`]);
    calls.forEach((c, i) => expectWireSafe(c, i === 0 ? '/key' : '/models'));
    replies.push(() => json(200, { data: { label: 'k' } }));
    replies.push(() => json(200, { data: [{ id: 'openai/gpt-6-luna' }, { id: cfg.model }] }));
    await expect(validateConfig(cfg)).resolves.toEqual({ ok: true });
  });

  it('never throws on a transport failure or a malformed listing', async () => {
    replies.push(() => Promise.reject(new TypeError('offline')));
    await expect(validateConfig(cfg)).resolves.toEqual({ ok: false, error: 'Could not reach OpenRouter' });
    replies.push(() => json(200, {}));
    replies.push(() => json(200, { data: 'nope' }));
    await expect(validateConfig(cfg)).resolves.toEqual({ ok: false, error: 'Model not available on OpenRouter' });
  });
});

describe('capabilities and refusal before transport', () => {
  it('can converse but cannot read images, and readImage refuses without any request', async () => {
    expect(supportsConverse('openrouter')).toBe(true);
    expect(supportsImageReading('openrouter')).toBe(false);
    expect(openrouterAdapter.readImage).toBeUndefined();
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
    const error = await readImage(cfg, { data: png, mimeType: 'image/png' }).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AiImageReadError);
    expect((error as AiImageReadError).retryable).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a governance refusal stops generateDraft and converse before any request', async () => {
    const governance: AiGovernance = { run: async () => { throw new AiAllowanceError('paused'); } };
    const governed = { ...cfg, governance };
    await expect(generateDraft(governed, { system: 's', prompt: 'p' })).rejects.toBeInstanceOf(AiAllowanceError);
    await expect(converse(governed, { system: ['s'], turns: [{ role: 'user', content: 'q' }], tools: [] })).rejects.toBeInstanceOf(AiAllowanceError);
    expect(fetch).not.toHaveBeenCalled();
  });
});
