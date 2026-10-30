/** TEST ONLY: synthetic privacy-review seam for this legacy gateway-control suite. The new
 * disclosure assertion/consumption is isolated so the original protocol, capture, source, admission,
 * spend and accounting controls below are still exercised. Actual binding/transfer/revocation and
 * provider egress dispatch remain real. Dedicated provider-privacy-request, provider-data-review-gate
 * and ai-private-analysis suites exercise the real default-block/review policy separately. This
 * fixture grants no production review status and admits no real provider data. */
vi.mock('../lib/ai/provider-privacy-request', async importActual => {
  const actual = await importActual<typeof import('../lib/ai/provider-privacy-request')>();
  return { ...actual, assertProviderPrivacyRequest: () => {}, consumeProviderPrivacyRequest: () => {} };
});

/** Immutable protocol capture tests, authored UNRUN. Mock transport/governance only; no authority proof. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureConversationInput, conversationInputDigest } from '../lib/ai/conversation-input';
import { converse } from '../lib/ai';
import { openaiAdapter } from '../lib/ai/providers/openai';
import type { ConverseArgs, ResolvedAiConfig } from '../lib/ai/types';
afterEach(() => vi.restoreAllMocks());
const fixture = (): ConverseArgs => ({ system: ['Fixed fictional system'], tools: [], turns: [
  { role: 'user', content: 'Original question' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', input: { selected: ['original'] } }],
    providerState: { provider: 'anthropic', blocks: [{ type: 'thinking', signature: 'opaque-signature', thinking: 'opaque-block' }] } },
  { role: 'tool', results: [{ id: 'c1', name: 'read', content: 'Original permitted result' }] },
] });
describe('conversation admission input capture', () => {
  it('deeply captures protocol values including opaque state without changing their content', () => {
    const input = fixture(), captured = captureConversationInput(input);
    expect(captured).toEqual({ ...input, maxTokens: 2048, timeoutMs: 120_000 });
    expect(captured.turns).not.toBe(input.turns); expect(Object.isFrozen(captured.turns)).toBe(true);
    const original = input.turns[1], saved = captured.turns[1];
    if (original.role !== 'assistant' || saved.role !== 'assistant') throw Error();
    expect(saved.providerState).toEqual(original.providerState); expect(saved.providerState).not.toBe(original.providerState);
    original.content = 'Retargeted'; input.system[0] = 'Retargeted';
    if (input.turns[2].role === 'tool') input.turns[2].results[0].content = 'Retargeted';
    expect(JSON.stringify(captured)).not.toContain('Retargeted');
    expect(() => captured.system.push('new')).toThrow();
  });
  it('retains malformed undefined arguments rather than repairing them into executable objects', () => {
    const input = fixture(); if (input.turns[1].role === 'assistant') input.turns[1].toolCalls![0].input = undefined;
    const result = captureConversationInput(input); if (result.turns[1].role !== 'assistant') throw Error();
    expect(result.turns[1].toolCalls![0]).toHaveProperty('input', undefined);
  });
  it('refuses accessor execution, opaque objects, cycles, oversize data and unknown root options', () => {
    let invoked = 0;
    const getter = fixture(); Object.defineProperty(getter, 'turns', { enumerable: true, get: () => { invoked++; return []; } });
    expect(() => captureConversationInput(getter)).toThrow('could not be confirmed'); expect(invoked).toBe(0);
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const input of [{ ...fixture(), plugins: [] }, { ...fixture(), system: ['x'.repeat(4_194_305)] },
      { ...fixture(), maxTokens: NaN }, { ...fixture(), timeoutMs: -1 },
      { ...fixture(), turns: [{ role: 'assistant', content: '', providerState: { provider: 'google', blocks: new Date() } }] },
      { ...fixture(), turns: [{ role: 'assistant', content: '', providerState: { provider: 'google', blocks: cycle } }] }])
      expect(() => captureConversationInput(input as ConverseArgs)).toThrow('could not be confirmed');
  });
  it('binds every captured field and normalizes only documented gateway defaults', () => {
    const input = fixture(), hash = conversationInputDigest(input);
    expect(conversationInputDigest({ ...input, maxTokens: 2048, timeoutMs: 120_000 })).toBe(hash);
    expect(conversationInputDigest({ ...input, cacheKey: 'changed' })).not.toBe(hash);
    input.system[0] = 'changed'; expect(conversationInputDigest(input)).not.toBe(hash);
  });
  it('uses the original captured request when a retained caller mutates during asynchronous admission', async () => {
    let entered!: () => void, failed!: (error: unknown) => void, release!: () => void;
    const reached = new Promise<void>((resolve, reject) => { entered = resolve; failed = reject; }), held = new Promise<void>(resolve => { release = resolve; });
    const input = fixture(); const expected = conversationInputDigest(input);
    const cfg: ResolvedAiConfig = { provider: 'openai', apiKey: 'fictional-not-sent', model: 'fictional/model', governance: {
      async run(request, call) { expect(request.inputDigest).toBe(expected); entered(); await held; return call(() => {}); },
    } };
    const transport = vi.spyOn(openaiAdapter, 'converse').mockImplementation(async (_cfg, args) => {
      expect(JSON.stringify(args)).not.toContain('Retargeted'); expect(Object.isFrozen(args.turns)).toBe(true);
      return { text: 'fictional', stop: 'end', toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 } };
    });
    const pending = converse(cfg, input);
    void pending.catch(failed);
    try {
      await reached; input.system[0] = 'Retargeted'; input.turns[0] = { role: 'user', content: 'Retargeted' };
      input.tools.push({ name: 'Retargeted', description: 'Retargeted', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } });
      release(); await expect(pending).resolves.toMatchObject({ text: 'fictional' }); expect(transport).toHaveBeenCalledTimes(1);
    } finally { release(); await pending.catch(() => {}); }
  });
});
