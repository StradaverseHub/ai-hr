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

/** Authored UNRUN. Mock transport checks protocol adjudication, never live capability. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProviderProtocolEvaluation, assertProviderProtocolEvaluation } from '../lib/ai/provider-protocol';
import { readOpenRouterOptions } from '../lib/ai/providers/openrouter-configuration';
import type { ResolvedAiConfig } from '../lib/ai/types';
import { syntheticProviderTransport } from './provider-evaluation-fixture';
// TEST ONLY: preserve this suite's synthetic governance/protocol boundary. Real opaque issued
// identity, one-use privacy admission and review approval are covered by their dedicated suites.
vi.mock('../core/ai-governance',()=>({
  preparePrivateAiTask:async(configuration:ResolvedAiConfig,id:string,read:()=>Promise<unknown>)=>{const {getProviderWorkloadDescriptor}=await import('../lib/ai/provider-workload-policy');const descriptor=getProviderWorkloadDescriptor(id)!;return {configuration,operation:descriptor.operation,...descriptor.capture(await read()),dispose(){}};},
  withAiRunObserver:(configuration:ResolvedAiConfig,hooks:{beforeCall?:()=>void;usage?:(value:import('../lib/ai/types').AiUsage)=>void;observation?:(value:import('../lib/ai/types').AiRunObservation)=>void;settled?:()=>void}):ResolvedAiConfig=>({...configuration,governance:{async run(request,call,outgoing){try{return await configuration.governance!.run(request,async(record,observe)=>{hooks.beforeCall?.();return call(value=>{record(value);hooks.usage?.(value);},value=>{observe?.(value);hooks.observation?.(value);});},outgoing);}finally{hooks.settled?.();}}}}),
}));
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
  it.each([{costs:[0,0,0],expected:0},{costs:[0.1,0.2,0.3],expected:0.6},{costs:[null,0,1],expected:null}])('aggregates actual per-call account-credit observations honestly: $costs',async({costs,expected})=>{
    mock=syntheticProviderTransport();let index=0;const draft=mock.draft.getMockImplementation()!,conversation=mock.conversation.getMockImplementation()!;
    const receipt=()=>({version:1 as const,provider:'openrouter' as const,accountCostUnit:'openrouter_account_credits' as const,usage:{inputTokens:0,outputTokens:0,cachedInputTokens:0},accountCostCredits:costs[index++],elapsedMs:5});
    mock.draft.mockImplementation(async(config,args)=>{const result=await draft(config,args);args.onObservation?.(receipt());return result;});
    mock.conversation.mockImplementation(async(config,args)=>{const result=await conversation(config,args);args.onObservation?.(receipt());return result;});
    const summary=await runProviderProtocolEvaluation(cfg());if(expected===null)expect(summary.accountChargeCredits).toBeNull();else expect(summary.accountChargeCredits).toBeCloseTo(expected,12);
    expect(mock.draft).toHaveBeenCalledOnce();expect(mock.conversation).toHaveBeenCalledTimes(2);
  });
  it('does not invent a total when a call has conflicting provider receipts',async()=>{
    mock=syntheticProviderTransport();const draft=mock.draft.getMockImplementation()!;
    mock.draft.mockImplementation(async(config,args)=>{const result=await draft(config,args);for(const cost of [0,1])args.onObservation?.({version:1,provider:'openrouter',accountCostUnit:'openrouter_account_credits',usage:{inputTokens:0,outputTokens:0,cachedInputTokens:0},accountCostCredits:cost,elapsedMs:5});return result;});
    expect((await runProviderProtocolEvaluation(cfg())).accountChargeCredits).toBeNull();
  });

});
