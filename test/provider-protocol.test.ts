/** Authored UNRUN. Mock transport checks protocol adjudication, never live capability. */
import { afterEach, describe, expect, it } from 'vitest';
import { runProviderProtocolEvaluation, assertProviderProtocolEvaluation } from '../lib/ai/provider-protocol';
import { readOpenRouterOptions } from '../lib/ai/providers/openrouter-configuration';
import type { ResolvedAiConfig } from '../lib/ai/types';
import { syntheticProviderTransport } from './provider-evaluation-fixture';
const options = readOpenRouterOptions({ version: 1, routing: { allowedProviders: ['approved-a'], allowFallbacks: false, sort: 'latency' } });
const cfg = (): ResolvedAiConfig => ({ provider: 'openrouter', model: 'fictional/model', apiKey: 'fixture-only-key', providerOptions: options,
  governance: { async run(_request, call) { return call(() => {}); } } });
let mock: ReturnType<typeof syntheticProviderTransport> | undefined;
afterEach(() => { mock?.restore(); mock = undefined; });
describe('fixed synthetic provider protocol', () => {
  it('requires exact text and a closed tool-call/result cycle, retaining real zero usage and unknown money', async () => {
    mock = syntheticProviderTransport(); const config = cfg(), summary = await runProviderProtocolEvaluation(config);
    expect(summary).toMatchObject({ calls: 3, usageReportedCalls: 3, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, accountChargeCredits: null });
    expect(summary.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(mock.draft).toHaveBeenCalledTimes(1); expect(mock.conversation).toHaveBeenCalledTimes(2);
    const final = mock.conversation.mock.calls[1][1];
    expect(final.turns).toHaveLength(3);
    expect(final.turns[2]).toMatchObject({ role: 'tool', results: [{ id: 'synthetic-call', name: 'integration_echo' }] });
    expect(() => assertProviderProtocolEvaluation(summary, config)).not.toThrow();
    expect(() => assertProviderProtocolEvaluation({ ...summary }, config)).toThrow();
    for (const changed of [{ ...config, apiKey: 'rotated-key' }, { ...config, model: 'fictional/other' }, { ...config, providerOptions: readOpenRouterOptions({ version: 1, routing: { allowedProviders: ['approved-b'], allowFallbacks: false, sort: 'latency' } }) }]) {
      expect(() => assertProviderProtocolEvaluation(summary, changed)).toThrow();
    }
  });
  it('does not treat normalized missing counters as reported zero', async () => {
    mock = syntheticProviderTransport();
    mock.draft.mockImplementationOnce(async (_cfg, args) => /eval_[a-f0-9-]+/.exec(args.prompt)![0]);
    const summary = await runProviderProtocolEvaluation(cfg());
    expect(summary).toMatchObject({ calls: 3, usageReportedCalls: 2, inputTokens: null, outputTokens: null, cachedInputTokens: null, accountChargeCredits: null });
  });
  it('refuses a text mismatch without starting tool requests', async () => {
    mock = syntheticProviderTransport(); mock.draft.mockResolvedValueOnce('A model self-rating is not proof');
    await expect(runProviderProtocolEvaluation(cfg())).rejects.toThrow();
    expect(mock.conversation).not.toHaveBeenCalled();
  });
  it.each(['refusal', 'wrong-tool', 'duplicate', 'extra-input', 'bad-marker', 'truncated'] as const)('refuses %s without executing arbitrary tools', async mode => {
    mock = syntheticProviderTransport();
    mock.conversation.mockImplementationOnce(async (_cfg, args) => {
      const marker = /eval_[a-f0-9-]+/.exec(JSON.stringify(args.turns))![0];
      const call = { id: 'synthetic-call', name: mode === 'wrong-tool' ? 'read_payroll' : 'integration_echo', input: { marker: mode === 'bad-marker' ? 'wrong' : marker, ...(mode === 'extra-input' ? { private: true } : {}) } };
      return { text: '', stop: mode === 'refusal' ? 'end' : mode === 'truncated' ? 'max_tokens' : 'tool_use', toolCalls: mode === 'duplicate' ? [call, call] : [call], usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }, usageReported: true };
    });
    await expect(runProviderProtocolEvaluation(cfg())).rejects.toThrow();
    expect(mock.conversation).toHaveBeenCalledTimes(1);
  });
  it('refuses an ungoverned/direct-provider candidate before transport', async () => {
    mock = syntheticProviderTransport();
    await expect(runProviderProtocolEvaluation({ ...cfg(), governance: undefined })).rejects.toThrow();
    await expect(runProviderProtocolEvaluation({ ...cfg(), provider: 'openai' })).rejects.toThrow();
    expect(mock.draft).not.toHaveBeenCalled(); expect(mock.conversation).not.toHaveBeenCalled();
  });
});
