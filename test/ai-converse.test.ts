/**
 * ADR-0082 slice 1 — the provider-neutral conversation contract (`lib/ai` converse()).
 *
 * Every mechanic under test here fails SILENTLY in production: the request still sends, the provider
 * still answers, and the assistant is quietly wrong. None of it is caught by tsc, and until this file
 * the three adapters had ZERO test coverage of any kind. What is pinned:
 *
 *   - ONE turn carries every tool_result (Anthropic/Google); splitting them does not error, it silently
 *     stops the model issuing parallel calls. OpenAI is the exception and the adapter fans out to N
 *     `role: 'tool'` messages IN CALL ORDER — the fan-out lives in the adapter so the caller cannot get
 *     the one-turn rule wrong;
 *   - a FAILED tool returns a result with isError, never a dropped result;
 *   - stop-reason normalisation across three disagreeing vocabularies, with refusal > max_tokens >
 *     evidence-of-a-call > the provider's own label;
 *   - usage normalisation: inputTokens and cachedInputTokens are DISJOINT on all three, which the naive
 *     field copy gets wrong in two different directions;
 *   - error mapping: one of the shipped generic strings, no provider body, no `cause`;
 *   - the cacheable prefix (tools + system) is byte-identical across a clock change and a different
 *     user, and never exceeds Anthropic's four cache breakpoints;
 *   - generateDraft still goes down its OWN path, byte-identically.
 *
 * The three SDKs are FAKED at the module boundary — no API key, no network, no cost. The real error
 * classes are kept (`...actual`) because the adapters' error mapping is `instanceof`-based and a fake
 * error class would make the mapping test vacuous.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  anthropic: { clientOptions: [] as unknown[], requests: [] as unknown[], reply: null as unknown, error: null as unknown },
  openai: { clientOptions: [] as unknown[], requests: [] as unknown[], reply: null as unknown, error: null as unknown },
  google: { clientOptions: [] as unknown[], requests: [] as unknown[], reply: null as unknown, error: null as unknown },
}));

vi.mock('@anthropic-ai/sdk', async (importActual) => {
  const actual = await importActual<typeof import('@anthropic-ai/sdk')>();
  class FakeAnthropic {
    static APIError = actual.default.APIError;
    messages = {
      create: async (body: unknown) => {
        sdk.anthropic.requests.push(body);
        if (sdk.anthropic.error) throw sdk.anthropic.error;
        return sdk.anthropic.reply;
      },
    };
    models = { retrieve: async () => ({}) };
    constructor(options: unknown) {
      sdk.anthropic.clientOptions.push(options);
    }
  }
  return { ...actual, default: FakeAnthropic as unknown as typeof actual.default };
});

vi.mock('openai', async (importActual) => {
  const actual = await importActual<typeof import('openai')>();
  class FakeOpenAI {
    static APIError = actual.default.APIError;
    chat = {
      completions: {
        create: async (body: unknown) => {
          sdk.openai.requests.push(body);
          if (sdk.openai.error) throw sdk.openai.error;
          return sdk.openai.reply;
        },
      },
    };
    models = { retrieve: async () => ({}) };
    constructor(options: unknown) {
      sdk.openai.clientOptions.push(options);
    }
  }
  return { ...actual, default: FakeOpenAI as unknown as typeof actual.default };
});

vi.mock('@google/genai', async (importActual) => {
  const actual = await importActual<typeof import('@google/genai')>();
  class FakeGoogleGenAI {
    models = {
      generateContent: async (req: unknown) => {
        sdk.google.requests.push(req);
        if (sdk.google.error) throw sdk.google.error;
        return sdk.google.reply;
      },
    };
    constructor(options: unknown) {
      sdk.google.clientOptions.push(options);
    }
  }
  return { ...actual, GoogleGenAI: FakeGoogleGenAI as unknown as typeof actual.GoogleGenAI };
});

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { ApiError } from '@google/genai';
import {
  AiGatewayError,
  converse,
  generateDraft,
  normaliseStop,
  supportsConverse,
  type AiStop,
  type AiProvider,
  type AiToolCall,
  type AiToolSpec,
  type AiTurn,
  type ResolvedAiConfig,
} from '../lib/ai';

/* ---------------------------------------------------------------------------------------------- */

const ANTHROPIC: ResolvedAiConfig = { provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'sk-ant-test' };
const OPENAI: ResolvedAiConfig = { provider: 'openai', model: 'gpt-5.5', apiKey: 'sk-oai-test' };
const GOOGLE: ResolvedAiConfig = { provider: 'google', model: 'gemini-2.5-flash', apiKey: 'sk-goo-test' };

const SYSTEM = ['You are the ai-hr assistant.', 'Answer only from tool results.'];

const TOOLS: AiToolSpec[] = [
  {
    name: 'list_employees',
    description: 'List employees in a department.',
    inputSchema: { type: 'object', properties: { departmentId: { type: 'string' } }, required: ['departmentId'], additionalProperties: false },
  },
  {
    name: 'leave_balance',
    description: 'Leave balance for one employee.',
    inputSchema: { type: 'object', properties: { employeeId: { type: 'string' } }, required: ['employeeId'], additionalProperties: false },
  },
];

/**
 * The fixture exchange every translation test runs: a question, ONE assistant turn asking for TWO
 * PARALLEL tools plus opaque reasoning state, and ONE tool turn carrying both outcomes — the second of
 * which FAILED.
 */
function fixtureTurns(state?: { provider: AiProvider; blocks: unknown }): AiTurn[] {
  return [
    { role: 'user', content: 'Who is on leave in Finance?' },
    {
      role: 'assistant',
      content: 'Let me look that up.',
      toolCalls: [
        { id: 'call_1', name: 'list_employees', input: { departmentId: 'd-finance' } },
        { id: 'call_2', name: 'leave_balance', input: { employeeId: 'e-9' } },
      ],
      ...(state ? { providerState: state } : {}),
    },
    {
      role: 'tool',
      results: [
        { id: 'call_1', name: 'list_employees', content: '[{"id":"e-9","name":"Ann"}]' },
        { id: 'call_2', name: 'leave_balance', content: 'employee not found', isError: true },
      ],
    },
  ];
}

type AnyRecord = Record<string, unknown>;
type Req = { model: string; system?: unknown; messages?: Array<AnyRecord>; tools?: unknown; [k: string]: unknown };

const lastAnthropicRequest = () => sdk.anthropic.requests.at(-1) as Req;
const lastOpenAiRequest = () => sdk.openai.requests.at(-1) as Req;
const lastGoogleRequest = () => sdk.google.requests.at(-1) as { model: string; contents: Array<AnyRecord>; config: AnyRecord };
const blocks = (v: unknown) => v as Array<AnyRecord>;

/** An Anthropic reply with no tool call and a normal stop — the "just answer" shape. */
function anthropicReply(over: AnyRecord = {}): AnyRecord {
  return {
    content: [{ type: 'text', text: 'Ann is on leave.' }],
    stop_reason: 'end_turn',
    stop_details: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null, cache_creation_input_tokens: null },
    ...over,
  };
}

function openaiReply(over: AnyRecord = {}): AnyRecord {
  return {
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Ann is on leave.', refusal: null } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...over,
  };
}

function googleReply(over: AnyRecord = {}): AnyRecord {
  return {
    candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: 'Ann is on leave.' }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    ...over,
  };
}

beforeEach(() => {
  for (const s of [sdk.anthropic, sdk.openai, sdk.google]) {
    s.clientOptions.length = 0;
    s.requests.length = 0;
    s.error = null;
  }
  sdk.anthropic.reply = anthropicReply();
  sdk.openai.reply = openaiReply();
  sdk.google.reply = googleReply();
});

/* ================================================================================================ */

describe('ADR-0082 — converse() dispatch and capability gate', () => {
  it('all three adapters implement converse, so the assistant is available on every configured provider', () => {
    expect(supportsConverse('anthropic')).toBe(true);
    expect(supportsConverse('openai')).toBe(true);
    expect(supportsConverse('google')).toBe(true);
  });

  it('normalises maxTokens and timeoutMs AT THE GATEWAY, so no adapter can send undefined', async () => {
    await converse(ANTHROPIC, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(lastAnthropicRequest().max_tokens).toBe(2048);
    // The SDK default is a 10-minute timeout with 2 retries — an 8-turn loop of that is hours.
    expect(sdk.anthropic.clientOptions.at(-1)).toMatchObject({ timeout: 120_000, maxRetries: 1 });

    await converse(OPENAI, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: [], maxTokens: 64, timeoutMs: 5_000 });
    expect(lastOpenAiRequest().max_completion_tokens).toBe(64);
    expect(sdk.openai.clientOptions.at(-1)).toMatchObject({ timeout: 5_000, maxRetries: 1 });

    await converse(GOOGLE, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: [], timeoutMs: 7_000 });
    expect(lastGoogleRequest().config).toMatchObject({ maxOutputTokens: 2048, httpOptions: { timeout: 7_000 } });
  });

  it('constructs the client PER CALL from the resolved key — never a module singleton serving two tenants', async () => {
    await converse({ ...ANTHROPIC, apiKey: 'sk-tenant-a' }, { system: SYSTEM, turns: [{ role: 'user', content: 'a' }], tools: [] });
    await converse({ ...ANTHROPIC, apiKey: 'sk-tenant-b' }, { system: SYSTEM, turns: [{ role: 'user', content: 'b' }], tools: [] });
    expect(sdk.anthropic.clientOptions).toHaveLength(2);
    expect(sdk.anthropic.clientOptions[0]).toMatchObject({ apiKey: 'sk-tenant-a' });
    expect(sdk.anthropic.clientOptions[1]).toMatchObject({ apiKey: 'sk-tenant-b' });
  });

  it('an empty answer is NOT an error when the model asked for a tool (unlike generateDraft)', async () => {
    sdk.anthropic.reply = anthropicReply({
      content: [{ type: 'tool_use', id: 'call_9', name: 'list_employees', input: { departmentId: 'd1' } }],
      stop_reason: 'tool_use',
    });
    const r = await converse(ANTHROPIC, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: TOOLS });
    expect(r.text).toBe('');
    expect(r.stop).toBe('tool_use');
    expect(r.toolCalls).toEqual([{ id: 'call_9', name: 'list_employees', input: { departmentId: 'd1' } }]);
  });
});

/* ================================================================================================ */

describe('ADR-0082 — one turn carries every tool result (mechanic 1) and no result is ever dropped (mechanic 2)', () => {
  it('Anthropic: ONE user message holding BOTH tool_result blocks, the failed one flagged is_error', async () => {
    await converse(ANTHROPIC, { system: SYSTEM, turns: fixtureTurns(), tools: TOOLS });
    const messages = lastAnthropicRequest().messages ?? [];
    expect(messages).toHaveLength(3);

    const toolTurn = messages[2];
    expect(toolTurn.role).toBe('user');
    const results = blocks(toolTurn.content);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.tool_use_id)).toEqual(['call_1', 'call_2']);
    expect(results[0].type).toBe('tool_result');
    expect(results[0].is_error).toBeUndefined();
    // The failure is REPORTED, not omitted: a missing tool_use_id is a protocol violation.
    expect(results[1].is_error).toBe(true);
    expect(results[1].content).toBe('employee not found');
  });

  it('Anthropic: the assistant turn carries thinking FIRST, then text, then both tool_use blocks', async () => {
    const turns = fixtureTurns({ provider: 'anthropic', blocks: [{ type: 'thinking', thinking: 'plan it', signature: 'sig-1' }] });
    await converse(ANTHROPIC, { system: SYSTEM, turns, tools: TOOLS });
    const assistant = blocks((lastAnthropicRequest().messages ?? [])[1].content);
    expect(assistant.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use', 'tool_use']);
    // Carried back VERBATIM — the signature is what buys multi-turn reasoning continuity.
    expect(assistant[0]).toEqual({ type: 'thinking', thinking: 'plan it', signature: 'sig-1' });
    expect(assistant[2]).toMatchObject({ id: 'call_1', name: 'list_employees', input: { departmentId: 'd-finance' } });
  });

  it('Anthropic: provider state minted by ANOTHER provider is discarded, not fed to Anthropic', async () => {
    const turns = fixtureTurns({ provider: 'google', blocks: [{ text: 'x', thoughtSignature: 'goo-sig' }] });
    await converse(ANTHROPIC, { system: SYSTEM, turns, tools: TOOLS });
    expect(JSON.stringify(lastAnthropicRequest())).not.toContain('goo-sig');
  });

  it('OpenAI: the SAME neutral turn fans out to TWO role:tool messages, in call order, error in the content', async () => {
    await converse(OPENAI, { system: SYSTEM, turns: fixtureTurns(), tools: TOOLS });
    const messages = lastOpenAiRequest().messages ?? [];
    // developer + user + assistant + TWO tool messages
    expect(messages.map((m) => m.role)).toEqual(['developer', 'user', 'assistant', 'tool', 'tool']);
    expect(messages[3]).toMatchObject({ tool_call_id: 'call_1' });
    expect(messages[4]).toMatchObject({ tool_call_id: 'call_2', content: 'ERROR: employee not found' });

    const assistant = messages[2];
    expect(assistant.content).toBe('Let me look that up.');
    const calls = blocks(assistant.tool_calls);
    expect(calls).toHaveLength(2);
    // The outbound encoding disagreement: neutral input is parsed, OpenAI's arguments is a JSON STRING.
    expect(calls[0]).toMatchObject({ id: 'call_1', type: 'function' });
    expect((calls[0].function as AnyRecord).arguments).toBe('{"departmentId":"d-finance"}');
  });

  it('Google: ONE user content holding BOTH functionResponse parts, each carrying `name`', async () => {
    await converse(GOOGLE, { system: SYSTEM, turns: fixtureTurns(), tools: TOOLS });
    const contents = lastGoogleRequest().contents;
    expect(contents).toHaveLength(3);
    // The assistant role is called `model` here; function responses go back as `user`.
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);

    const parts = blocks(contents[2].parts);
    expect(parts).toHaveLength(2);
    const responses = parts.map((p) => p.functionResponse as AnyRecord);
    // `name` is the correlation key on Google — its id is optional and often absent.
    expect(responses.map((r) => r.name)).toEqual(['list_employees', 'leave_balance']);
    expect(responses[0].response).toEqual({ output: '[{"id":"e-9","name":"Ann"}]' });
    // Failure is reported through the documented `error` key, never by omitting the response.
    expect(responses[1].response).toEqual({ error: 'employee not found' });
  });
});

/* ================================================================================================ */

describe('ADR-0082 — tool schema translation', () => {
  it('Anthropic sends input_schema with strict:true', async () => {
    await converse(ANTHROPIC, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: TOOLS });
    const tools = blocks(lastAnthropicRequest().tools);
    expect(tools).toHaveLength(2);
    expect(tools[0].strict).toBe(true);
    expect(tools[0].input_schema).toEqual(TOOLS[0].inputSchema);
    expect(lastAnthropicRequest().tool_choice).toEqual({ type: 'auto' });
  });

  it('OpenAI sends function.parameters with strict:true, parallel calls on, and the cache key when given', async () => {
    await converse(OPENAI, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: TOOLS, cacheKey: 'ab12cd34' });
    const req = lastOpenAiRequest();
    const tools = blocks(req.tools);
    expect((tools[0].function as AnyRecord).strict).toBe(true);
    expect((tools[0].function as AnyRecord).parameters).toEqual(TOOLS[0].inputSchema);
    expect(req.tool_choice).toBe('auto');
    expect(req.parallel_tool_calls).toBe(true);
    expect(req.prompt_cache_key).toBe('ab12cd34');
  });

  it('Google sends parametersJsonSchema and NEVER `parameters` (whose type enum is uppercase)', async () => {
    await converse(GOOGLE, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: TOOLS });
    const config = lastGoogleRequest().config;
    const declarations = blocks((blocks(config.tools)[0] as AnyRecord).functionDeclarations);
    expect(declarations).toHaveLength(2);
    expect(declarations[0].parametersJsonSchema).toEqual(TOOLS[0].inputSchema);
    expect(declarations[0].parameters).toBeUndefined();
    // The SDK would otherwise RUN the tools itself and hide the loop the turn cap lives in.
    expect(config.automaticFunctionCalling).toEqual({ disable: true });
  });

  it('with no tools, no tool_choice is sent (a tool policy without tools is a request error)', async () => {
    await converse(ANTHROPIC, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(lastAnthropicRequest().tools).toBeUndefined();
    expect(lastAnthropicRequest().tool_choice).toBeUndefined();
    await converse(OPENAI, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(lastOpenAiRequest().tool_choice).toBeUndefined();
  });
});

/* ================================================================================================ */

describe('ADR-0082 — the cacheable prefix', () => {
  it('Anthropic marks the LAST tool and the LAST system block, and never exceeds four breakpoints', async () => {
    await converse(ANTHROPIC, { system: SYSTEM, turns: fixtureTurns(), tools: TOOLS });
    const req = lastAnthropicRequest();
    const tools = blocks(req.tools);
    expect(tools[0].cache_control).toBeUndefined();
    expect(tools[1].cache_control).toEqual({ type: 'ephemeral' });

    const system = blocks(req.system);
    expect(system.map((b) => b.type)).toEqual(['text', 'text']);
    expect(system[0].cache_control).toBeUndefined();
    expect(system[1].cache_control).toEqual({ type: 'ephemeral' });

    // Third breakpoint: the last block of a FINAL tool-result turn, so turns 2..N do not re-pay full
    // input price on the prefix the earlier turns established.
    const results = blocks((req.messages ?? [])[2].content);
    expect(results[1].cache_control).toEqual({ type: 'ephemeral' });

    // The cap is FOUR, and blowing it is a request error rather than a degradation.
    const markers = JSON.stringify(req).match(/"cache_control"/g) ?? [];
    expect(markers.length).toBeLessThanOrEqual(4);
  });

  it('a deep loop still never exceeds four breakpoints', async () => {
    const deep: AiTurn[] = [];
    for (let i = 0; i < 8; i++) {
      deep.push({ role: 'user', content: `q${i}` });
      deep.push({ role: 'assistant', content: '', toolCalls: [{ id: `c${i}`, name: 'list_employees', input: {} }] });
      deep.push({ role: 'tool', results: [{ id: `c${i}`, name: 'list_employees', content: 'ok' }] });
    }
    await converse(ANTHROPIC, { system: SYSTEM, turns: deep, tools: TOOLS });
    const markers = JSON.stringify(lastAnthropicRequest()).match(/"cache_control"/g) ?? [];
    expect(markers.length).toBeLessThanOrEqual(4);
  });

  it('the prefix is BYTE-IDENTICAL across a clock change, a different user and a different question', async () => {
    await converse(ANTHROPIC, { system: SYSTEM, turns: [{ role: 'user', content: `asked at ${new Date(0).toISOString()} by user-1` }], tools: TOOLS });
    await converse(ANTHROPIC, { system: SYSTEM, turns: [{ role: 'user', content: `asked at ${new Date(99999).toISOString()} by user-2` }], tools: TOOLS });
    const [a, b] = sdk.anthropic.requests as Req[];
    // One volatile byte above the last breakpoint costs ~10x on every later request and reports nothing.
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
    expect(JSON.stringify(a.system)).toBe(JSON.stringify(b.system));
    expect(JSON.stringify(a.messages)).not.toBe(JSON.stringify(b.messages));
  });
});

/* ================================================================================================ */

describe('ADR-0082 — stop-reason normalisation', () => {
  const call: AiToolCall = { id: 'c1', name: 'list_employees', input: {} };

  it('precedence: refusal > max_tokens > evidence-of-a-call > the provider label', () => {
    // A refusal with a stray call must NEVER execute the call.
    expect(normaliseStop('refusal', [call])).toEqual({ stop: 'refusal', toolCalls: [] });
    // A response truncated mid-tool_use has PARTIAL input; a half-parsed query is not executed.
    expect(normaliseStop('max_tokens', [call])).toEqual({ stop: 'max_tokens', toolCalls: [] });
    // Google has no tool-use stop reason at all, so the parsed call beats the label.
    expect(normaliseStop('end', [call])).toEqual({ stop: 'tool_use', toolCalls: [call] });
    // Claimed a call, produced none: terminal AND visible, never a finished answer.
    expect(normaliseStop('tool_use', [])).toEqual({ stop: 'other', toolCalls: [] });
    expect(normaliseStop('end', [])).toEqual({ stop: 'end', toolCalls: [] });
    expect(normaliseStop('other', [])).toEqual({ stop: 'other', toolCalls: [] });
  });

  const anthropicCases: Array<[string, AiStop]> = [
    ['end_turn', 'end'],
    ['stop_sequence', 'end'],
    ['max_tokens', 'max_tokens'],
    ['refusal', 'refusal'],
    ['pause_turn', 'other'],
  ];
  it.each(anthropicCases)('Anthropic stop_reason %s -> %s', async (raw, expected) => {
    sdk.anthropic.reply = anthropicReply({ stop_reason: raw });
    const r = await converse(ANTHROPIC, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(r.stop).toBe(expected);
  });

  it('Anthropic: tool_use with parsed calls is tool_use; max_tokens DROPS the truncated calls', async () => {
    const withCall = [{ type: 'tool_use', id: 'c1', name: 'list_employees', input: { departmentId: 'd' } }];
    sdk.anthropic.reply = anthropicReply({ content: withCall, stop_reason: 'tool_use' });
    expect((await converse(ANTHROPIC, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: TOOLS })).stop).toBe('tool_use');

    sdk.anthropic.reply = anthropicReply({ content: withCall, stop_reason: 'max_tokens' });
    const truncated = await converse(ANTHROPIC, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: TOOLS });
    expect(truncated.stop).toBe('max_tokens');
    expect(truncated.toolCalls).toEqual([]);
  });

  const openaiCases: Array<[string, AiStop]> = [
    ['stop', 'end'],
    ['length', 'max_tokens'],
    ['content_filter', 'refusal'],
    ['function_call', 'other'],
  ];
  it.each(openaiCases)('OpenAI finish_reason %s -> %s', async (raw, expected) => {
    sdk.openai.reply = openaiReply({ choices: [{ finish_reason: raw, message: { role: 'assistant', content: 'x', refusal: null } }] });
    const r = await converse(OPENAI, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(r.stop).toBe(expected);
  });

  it('OpenAI: message.refusal is ORTHOGONAL to finish_reason and is checked first', async () => {
    sdk.openai.reply = openaiReply({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '', refusal: 'I cannot help with that.' } }] });
    const r = await converse(OPENAI, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(r.stop).toBe('refusal');
  });

  const googleCases: Array<[string, AiStop]> = [
    ['STOP', 'end'],
    ['MAX_TOKENS', 'max_tokens'],
    ['SAFETY', 'refusal'],
    ['PROHIBITED_CONTENT', 'refusal'],
    ['SPII', 'refusal'],
    ['BLOCKLIST', 'refusal'],
    ['RECITATION', 'other'],
    ['LANGUAGE', 'other'],
    ['OTHER', 'other'],
    ['MALFORMED_FUNCTION_CALL', 'other'],
    ['UNEXPECTED_TOOL_CALL', 'other'],
  ];
  it.each(googleCases)('Google finishReason %s -> %s', async (raw, expected) => {
    sdk.google.reply = googleReply({ candidates: [{ finishReason: raw, content: { role: 'model', parts: [{ text: 'x' }] } }] });
    const r = await converse(GOOGLE, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(r.stop).toBe(expected);
  });

  it('Google: a BLOCKED PROMPT has no candidates at all — that is a refusal, not an empty success', async () => {
    sdk.google.reply = googleReply({ candidates: [], promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'raw provider prose' } });
    const r = await converse(GOOGLE, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(r.stop).toBe('refusal');
    expect(r.text).toBe('');
  });

  it('Google: no candidate and no block reason is `other`, never a finished answer', async () => {
    sdk.google.reply = googleReply({ candidates: undefined });
    const r = await converse(GOOGLE, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(r.stop).toBe('other');
  });

  it('Google: STOP with a functionCall present is tool_use — the evidence beats the label', async () => {
    sdk.google.reply = googleReply({
      candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { name: 'list_employees', args: { departmentId: 'd' } } }] } }],
    });
    const r = await converse(GOOGLE, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: TOOLS });
    expect(r.stop).toBe('tool_use');
  });
});

/* ================================================================================================ */

describe('ADR-0082 — tool-call identity and argument encoding', () => {
  it('OpenAI: arguments are PARSED inbound; unparseable arguments become undefined, not a dropped call', async () => {
    sdk.openai.reply = openaiReply({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            refusal: null,
            tool_calls: [
              { id: 'c1', type: 'function', function: { name: 'list_employees', arguments: '{"departmentId":"d1"}' } },
              { id: 'c2', type: 'function', function: { name: 'leave_balance', arguments: '{"employeeId":' } },
              { id: 'c3', type: 'custom', custom: { name: 'x', input: 'y' } },
            ],
          },
        },
      ],
    });
    const r = await converse(OPENAI, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: TOOLS });
    // The custom tool call is narrowed away rather than crashing on tc.function.
    expect(r.toolCalls).toHaveLength(2);
    expect(r.toolCalls[0].input).toEqual({ departmentId: 'd1' });
    // undefined = "the model produced arguments we cannot parse" — the caller must return isError.
    expect(r.toolCalls[1].input).toBeUndefined();
  });

  it('Google: a missing FunctionCall.id is synthesised, and the synthetic id is NOT echoed back', async () => {
    sdk.google.reply = googleReply({
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts: [
              { functionCall: { name: 'list_employees', args: { departmentId: 'd1' } } },
              { functionCall: { name: 'list_employees', args: { departmentId: 'd2' } } },
            ],
          },
        },
      ],
    });
    const r = await converse(GOOGLE, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: TOOLS });
    expect(r.toolCalls.map((c) => c.id)).toEqual(['g-syn:list_employees#0', 'g-syn:list_employees#1']);

    // Two parallel calls to the SAME tool with no ids are correlated BY POSITION. Sending a synthesised
    // id back would be sending Google an id it never minted.
    await converse(GOOGLE, {
      system: SYSTEM,
      tools: TOOLS,
      turns: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', toolCalls: r.toolCalls },
        { role: 'tool', results: r.toolCalls.map((c) => ({ id: c.id, name: c.name, content: 'ok' })) },
      ],
    });
    const contents = lastGoogleRequest().contents;
    const responses = blocks(contents[2].parts).map((p) => p.functionResponse as AnyRecord);
    expect(responses.map((x) => x.name)).toEqual(['list_employees', 'list_employees']);
    expect(responses[0].id).toBeUndefined();
    expect(blocks(contents[1].parts).map((p) => (p.functionCall as AnyRecord).id)).toEqual([undefined, undefined]);
  });

  it('Google: a model-supplied id IS echoed back on both legs', async () => {
    sdk.google.reply = googleReply({
      candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ functionCall: { id: 'goo-1', name: 'list_employees', args: {} } }] } }],
    });
    const r = await converse(GOOGLE, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: TOOLS });
    expect(r.toolCalls[0].id).toBe('goo-1');

    await converse(GOOGLE, {
      system: SYSTEM,
      tools: TOOLS,
      turns: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', toolCalls: r.toolCalls },
        { role: 'tool', results: [{ id: 'goo-1', name: 'list_employees', content: 'ok' }] },
      ],
    });
    const contents = lastGoogleRequest().contents;
    expect((blocks(contents[2].parts)[0].functionResponse as AnyRecord).id).toBe('goo-1');
  });

  it('Google: thought signatures round-trip VERBATIM, with no duplicated function call', async () => {
    const parts = [
      { text: 'thinking out loud', thought: true, thoughtSignature: 'goo-sig-1' },
      { functionCall: { name: 'list_employees', args: {} }, thoughtSignature: 'goo-sig-2' },
    ];
    sdk.google.reply = googleReply({ candidates: [{ finishReason: 'STOP', content: { role: 'model', parts } }] });
    const r = await converse(GOOGLE, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: TOOLS });
    expect(r.providerState).toEqual({ provider: 'google', blocks: parts });
    // A `thought: true` part is NOT the answer — reading response.text would have concatenated it.
    expect(r.text).toBe('');

    await converse(GOOGLE, {
      system: SYSTEM,
      tools: TOOLS,
      turns: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: r.text, toolCalls: r.toolCalls, providerState: r.providerState },
        { role: 'tool', results: [{ id: r.toolCalls[0].id, name: 'list_employees', content: 'ok' }] },
      ],
    });
    const model = lastGoogleRequest().contents[1];
    expect(model.parts).toEqual(parts);
  });

  it('OpenAI carries NO reasoning state — the documented, accepted degradation of chat.completions', async () => {
    sdk.openai.reply = openaiReply();
    const r = await converse(OPENAI, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(r.providerState).toBeUndefined();
  });
});

/* ================================================================================================ */

describe('ADR-0082 — usage normalisation (inputTokens and cachedInputTokens are DISJOINT)', () => {
  it('Anthropic: input_tokens EXCLUDES cache reads, and cache CREATION is fresh billable input', async () => {
    sdk.anthropic.reply = anthropicReply({
      usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 20 },
    });
    const r = await converse(ANTHROPIC, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(r.usage).toEqual({ inputTokens: 120, outputTokens: 40, cachedInputTokens: 900 });
    // The naive copy would report 100 uncached input and lose 920 tokens of real spend.
    expect(r.usage.inputTokens + r.usage.cachedInputTokens).toBe(1020);
  });

  it('Anthropic: nullable cache fields normalise to zero', async () => {
    sdk.anthropic.reply = anthropicReply({ usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: null, cache_creation_input_tokens: null } });
    const r = await converse(ANTHROPIC, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: [] });
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 0 });
  });

  it('OpenAI: cached_tokens is a SUBSET of prompt_tokens and is subtracted out', async () => {
    sdk.openai.reply = openaiReply({
      usage: { prompt_tokens: 1000, completion_tokens: 40, total_tokens: 1040, prompt_tokens_details: { cached_tokens: 900 }, completion_tokens_details: { reasoning_tokens: 30 } },
    });
    const r = await converse(OPENAI, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: [] });
    // 100 uncached + 900 cached = the provider's 1000. Copying the fields verbatim double-counts 900.
    expect(r.usage).toEqual({ inputTokens: 100, outputTokens: 40, cachedInputTokens: 900 });
    expect(r.usage.inputTokens + r.usage.cachedInputTokens).toBe(1000);
  });

  it('Google: cached is a subset of the prompt count; thoughts and toolUsePrompt are DISJOINT and must be added', async () => {
    sdk.google.reply = googleReply({
      usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 900, candidatesTokenCount: 40, thoughtsTokenCount: 60, toolUsePromptTokenCount: 25, totalTokenCount: 1125 },
    });
    const r = await converse(GOOGLE, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: [] });
    // candidatesTokenCount alone EXCLUDES reasoning: a thinking-heavy answer would meter as almost free.
    expect(r.usage).toEqual({ inputTokens: 125, outputTokens: 100, cachedInputTokens: 900 });
    // totalTokenCount is documented as the sum of all four, and the neutral shape reproduces it.
    expect(r.usage.inputTokens + r.usage.cachedInputTokens + r.usage.outputTokens).toBe(1125);
  });

  it('missing usage normalises to ZERO on every provider (and zero is not "free")', async () => {
    sdk.anthropic.reply = anthropicReply({ usage: undefined });
    sdk.openai.reply = openaiReply({ usage: undefined });
    sdk.google.reply = googleReply({ usageMetadata: undefined });
    const zero = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    expect((await converse(ANTHROPIC, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: [] })).usage).toEqual(zero);
    expect((await converse(OPENAI, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: [] })).usage).toEqual(zero);
    expect((await converse(GOOGLE, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: [] })).usage).toEqual(zero);
  });
});

/* ================================================================================================ */

describe('ADR-0082 — error mapping keeps the provider body on the far side of the boundary', () => {
  const LEAK = 'sk-live-AAAABBBBCCCCDDDD';

  it('Anthropic: an API error becomes a generic AiGatewayError with no cause and no key fragment', async () => {
    sdk.anthropic.error = new Anthropic.APIError(401, { error: { message: `Invalid bearer token ${LEAK}` } }, undefined, undefined);
    const err = await converse(ANTHROPIC, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: [] }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AiGatewayError);
    const gateway = err as AiGatewayError;
    expect(gateway.message).toBe('Invalid API key');
    expect(gateway.message).not.toContain(LEAK);
    // Never set `cause`: Next's error serialisation and any structured logger walk the chain and would
    // surface the raw SDK body — which for a 401 can carry a key fragment.
    expect(gateway.cause).toBeUndefined();
    // Nothing from the provider survives serialisation either — the error carries no attached body.
    expect(JSON.stringify(gateway)).not.toContain(LEAK);
  });

  it('the mapped messages are the SHIPPED strings, on all three providers', async () => {
    const known = ['Invalid API key', 'Model not available for this key', 'Rate limited — try again shortly'];
    const args = { system: SYSTEM, turns: [{ role: 'user' as const, content: 'hi' }], tools: [] };

    sdk.anthropic.error = new Anthropic.APIError(429, { error: { message: LEAK } }, undefined, undefined);
    await expect(converse(ANTHROPIC, args)).rejects.toThrow('Rate limited — try again shortly');

    sdk.openai.error = new OpenAI.APIError(404, { error: { message: LEAK } }, undefined, undefined);
    await expect(converse(OPENAI, args)).rejects.toThrow('Model not available for this key');

    sdk.google.error = new ApiError({ message: LEAK, status: 429 });
    await expect(converse(GOOGLE, args)).rejects.toThrow('Rate limited — try again shortly');

    sdk.openai.error = new Error(`socket hang up ${LEAK}`);
    const netErr = (await converse(OPENAI, args).then(
      () => null,
      (e: unknown) => e,
    )) as AiGatewayError;
    expect(netErr.message).toBe('Could not reach OpenAI');
    expect(known).not.toContain(netErr.message);
  });

  /**
   * 400 IS AMBIGUOUS ON GOOGLE AND THE ANSWER DIFFERS BY PATH — both halves are pinned here on purpose.
   *
   * This case used to assert one thing: converse() maps 400 to "Invalid API key". The premise was
   * right — the Gemini Developer API really does answer a bad key with 400, not the 401 Anthropic and
   * OpenAI use — but it stopped being the WHOLE truth once converse() made the request shape variable,
   * because a tool schema the model rejects is also a 400. So the half that is still true (the fixed,
   * trivial request shapes of generate/validate) stays, and only the half converse() invalidated moves.
   */
  it('Google reads 400 as a bad key on the fixed-shape paths, and names both causes once tools are in play', async () => {
    // THE SURVIVING HALF. generate() cannot send an invalid request shape, so 400 IS the key.
    sdk.google.error = new ApiError({ message: LEAK, status: 400 });
    await expect(generateDraft(GOOGLE, { system: 'sys', prompt: 'p' })).rejects.toThrow('Invalid API key');

    // THE RETIRED HALF. On converse() a 400 is as likely to be the tool schema, and telling the admin to
    // rotate a working key contradicts the Test-connection button, which probes without tools.
    sdk.google.error = new ApiError({ message: LEAK, status: 400 });
    await expect(
      converse(GOOGLE, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: [] }),
    ).rejects.toThrow('Invalid API key, or a request this model will not accept');
  });
});

/* ================================================================================================ */

describe('ADR-0082 — generateDraft is untouched (the I11 tripwire)', () => {
  it('still sends the drafting shape: a STRING system, no tools, no tool policy', async () => {
    sdk.anthropic.reply = anthropicReply({ content: [{ type: 'text', text: 'DRAFT: solid quarter.' }] });
    const text = await generateDraft(ANTHROPIC, { system: 'You draft reviews.', prompt: 'Write one.' });
    expect(text).toBe('DRAFT: solid quarter.');

    const req = lastAnthropicRequest();
    expect(typeof req.system).toBe('string');
    expect(req.tools).toBeUndefined();
    expect(req.tool_choice).toBeUndefined();
    expect(req.messages).toEqual([{ role: 'user', content: 'Write one.' }]);
    expect(req.max_tokens).toBe(2048);
    // And the drafting client keeps the SDK defaults it has always run with — the converse ceilings are
    // on a SEPARATE client factory.
    const opts = sdk.anthropic.clientOptions.at(-1) as Record<string, unknown>;
    expect(opts.timeout).toBeUndefined();
    expect(opts.maxRetries).toBeUndefined();
  });

  it('still THROWS on an empty draft, where converse deliberately does not', async () => {
    sdk.anthropic.reply = anthropicReply({ content: [] });
    await expect(generateDraft(ANTHROPIC, { system: 's', prompt: 'p' })).rejects.toThrow('No draft was produced — please try again.');
    // Exactly one SDK round-trip: no hidden retry, and no detour through converse.
    expect(sdk.anthropic.requests).toHaveLength(1);
  });

  it('one converse() call is one provider round-trip — the LOOP belongs to the caller', async () => {
    sdk.anthropic.reply = anthropicReply({
      content: [{ type: 'tool_use', id: 'c1', name: 'list_employees', input: {} }],
      stop_reason: 'tool_use',
    });
    await converse(ANTHROPIC, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: TOOLS });
    expect(sdk.anthropic.requests).toHaveLength(1);
  });
});

/* ================================================================================================ */

/**
 * The r221 verification round. Every case below is a regression test for a defect the adversarial pass
 * found in the first build, or for a path the completeness critic showed had no coverage at all. Each
 * one failed before its fix and none of them is reachable from the happy path — which is why 40 green
 * cases sat on top of them.
 */
describe('ADR-0082 — r221 verification findings', () => {
  it('Anthropic extracts thinking AND redacted_thinking off a reply as providerState, and keeps them out of the answer', async () => {
    // THE REFERENCE PROVIDER'S RESPONSE LEG HAD NO TEST. The request leg was covered with a hand-built
    // state, so a wrong filter predicate here would lose reasoning continuity across every tool turn
    // while all 40 existing cases stayed green.
    sdk.anthropic.reply = anthropicReply({
      content: [
        { type: 'thinking', thinking: 'She is in Finance.', signature: 'sig-1' },
        { type: 'redacted_thinking', data: 'ENCRYPTED' },
        { type: 'text', text: 'Ann is on leave.' },
      ],
    });
    const r = await converse(ANTHROPIC, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: TOOLS });

    expect(r.text).toBe('Ann is on leave.');
    expect(r.providerState?.provider).toBe('anthropic');
    expect(blocks(r.providerState?.blocks).map((b) => b.type)).toEqual(['thinking', 'redacted_thinking']);
  });

  it('Google reports an ABSENT finishReason as "other", not as a finished answer', async () => {
    // genai.d.ts: "If empty, the model has NOT stopped generating the tokens." The old `?? 'STOP'`
    // default rendered a truncated sentence as the assistant's completed answer, and the caller's loop
    // terminated on it. Anthropic and OpenAI both send the same missing-label case to 'other'.
    sdk.google.reply = googleReply({
      candidates: [{ content: { role: 'model', parts: [{ text: 'Employees in Finance are' }] } }],
    });
    const r = await converse(GOOGLE, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: TOOLS });

    expect(r.stop).toBe('other');
    expect(r.text).toBe('Employees in Finance are');
  });

  it('Google does not replay a functionCall the gateway suppressed, but still carries the surviving signature', async () => {
    // normaliseStop empties toolCalls on max_tokens, so the caller never runs the half-parsed call —
    // but providerState carried the whole parts array, functionCall included, and requestContents
    // replays it VERBATIM. The model saw an outstanding tool request with no functionResponse closing
    // it and re-issued it or invented the result. Nothing errored.
    sdk.google.reply = googleReply({
      candidates: [
        {
          finishReason: 'MAX_TOKENS',
          content: {
            role: 'model',
            parts: [
              { text: 'Let me check', thoughtSignature: 'sig-a' },
              { functionCall: { name: 'leave_balance', args: { employeeId: 'e-1' } }, thoughtSignature: 'sig-b' },
            ],
          },
        },
      ],
    });
    const r = await converse(GOOGLE, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: TOOLS });

    expect(r.stop).toBe('max_tokens');
    expect(r.toolCalls).toEqual([]);
    const kept = blocks(r.providerState?.blocks);
    expect(kept.some((p) => p.functionCall != null)).toBe(false);
    expect(kept).toHaveLength(1);
    expect(kept[0].thoughtSignature).toBe('sig-a');
  });

  it('OpenAI drops an information-free assistant turn instead of sending content:null with no tool_calls', async () => {
    // The SDK documents content as "required unless tool_calls or function_call is specified". The turn
    // is reachable: a refusal puts its prose on message.refusal (never surfaced) so text is '', and
    // normaliseStop empties toolCalls. Anthropic and Google both guarded it; OpenAI did not, so one
    // ConverseArgs built a legal request on two providers and a 400 on the third — surfaced to the user
    // as "Could not reach OpenAI", a network message for a request-shape bug.
    const turns: AiTurn[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'and?' },
    ];
    await converse(OPENAI, { system: SYSTEM, turns, tools: TOOLS });

    const messages = lastOpenAiRequest().messages ?? [];
    expect(messages.some((m) => m.role === 'assistant')).toBe(false);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(2);
  });

  it.each([
    ['anthropic', ANTHROPIC, () => (lastAnthropicRequest().messages ?? []).map((m) => m.content)],
    ['google', GOOGLE, () => lastGoogleRequest().contents.map((c) => c.parts)],
  ] as const)('%s drops a tool turn carrying no results rather than sending an empty content array', async (_label, cfg, sent) => {
    const turns: AiTurn[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Looking.', toolCalls: [{ id: 'call_1', name: 'leave_balance', input: { employeeId: 'e-1' } }] },
      { role: 'tool', results: [] },
    ];
    await converse(cfg, { system: SYSTEM, turns, tools: TOOLS });

    // An empty content/parts array is a request error on both providers.
    expect(sent().some((c) => Array.isArray(c) && c.length === 0)).toBe(false);
  });

  it('Google does not assert an auth fault for a 400 raised while tools are in play, and still leaks nothing', async () => {
    // The counterpart to the split pinned above: on the converse path a 400 is as likely to be the tool
    // schema as the key, so the message may not assert one cause — and must still keep the provider's
    // own body on the far side of the boundary.
    sdk.google.error = new ApiError({ message: 'Invalid JSON payload at tools[0]', status: 400 });
    let message = '';
    try {
      await converse(GOOGLE, { system: SYSTEM, turns: [{ role: 'user', content: 'hi' }], tools: TOOLS });
    } catch (e) {
      expect(e).toBeInstanceOf(AiGatewayError);
      message = (e as Error).message;
    }
    expect(message).toBe('Invalid API key, or a request this model will not accept');
    expect(message).not.toContain('Invalid JSON payload');
  });
});
