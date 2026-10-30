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

/** Authored UNRUN: source-bound draft digest and capture, no provider API or DB. */
import {expect,it,vi} from 'vitest';
import {draftInputDigest} from '../lib/ai/draft-input';
import {generateDraft} from '../lib/ai';
import {openaiAdapter} from '../lib/ai/providers/openai';
import type {ResolvedAiConfig,AiUsage} from '../lib/ai/types';
it('binds exact draft system/prompt/output budget and consistent implicit default, omitting runtime callbacks',()=>{const args={system:'Synthetic',prompt:'Question'};expect(draftInputDigest(args)).toBe(draftInputDigest({...args,maxTokens:2048}));for(const changed of [{...args,system:'Changed'},{...args,prompt:'Changed'},{...args,maxTokens:1}])expect(draftInputDigest(changed)).not.toBe(draftInputDigest(args));});
it('captures outbound primitives before asynchronous admission and binds the actual digest',async()=>{let release!:()=>void,observed='';const pending=new Promise<void>(resolve=>{release=resolve;});const args={system:'Original system',prompt:'Original question',maxTokens:120};const cfg:ResolvedAiConfig={provider:'openai',apiKey:'fictional',model:'fictional/model',governance:{async run(request,call){observed=request.inputDigest!;await pending;return call((_usage:AiUsage)=>{});}}};const spy=vi.spyOn(openaiAdapter,'generate').mockResolvedValue('Synthetic result');try{const promise=generateDraft(cfg,args);args.system='mutated';args.prompt='mutated';args.maxTokens=900;release();await promise;expect(observed).toBe(draftInputDigest({system:'Original system',prompt:'Original question',maxTokens:120}));expect(spy.mock.calls[0][1]).toMatchObject({system:'Original system',prompt:'Original question',maxTokens:120});}finally{spy.mockRestore();}});
