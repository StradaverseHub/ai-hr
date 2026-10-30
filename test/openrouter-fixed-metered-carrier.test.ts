import {fixtureOpenRouterTransport as createOpenRouterTransport} from './helpers/provider-egress-fixture';
/** Authored UNRUN. Fictional source-issued control record + mocked HTTP only. Rates and limits are FICTIONAL. This does NOT certify
 * a real model/endpoint/workspace, prove current routability or activate any provider. */
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {buildOpenRouterRequest} from '../lib/ai/providers/openrouter-transport';
import {captureReviewedMeteredCarrier,FIXED_METERED_CARRIER_SOURCE_DIGEST,FIXED_METERED_INVARIANTS,issueReviewedMeteredProof,currentReviewedMeteredEnvelope,withReviewedMeteredDispatch,consumeReviewedMeteredPost,captureMeteredContract,meteredReservationNanos} from '../lib/ai/providers/openrouter-fixed-metered-carrier';
import {currentReviewedFreeEnvelope,withReviewedFreeDispatch} from '../lib/ai/providers/openrouter-fixed-free-carrier';
import {aiSpendConfigurationDigest} from '../lib/ai/spend-receipt';
import {draftInputDigest} from '../lib/ai/draft-input';
import {conversationInputDigest} from '../lib/ai/conversation-input';
import type {ResolvedAiConfig,ConverseArgs} from '../lib/ai/types';
const cfg:ResolvedAiConfig={provider:'openrouter',model:'fictional/model',apiKey:'fictional-key',providerOptions:{version:1,routing:{allowedProviders:['fictional/endpoint'],allowFallbacks:false,sort:'latency'}}};
const args:ConverseArgs={system:['Synthetic only'],turns:[{role:'user',content:'Synthetic question'}],tools:[],maxTokens:64,timeoutMs:1000};
const request=()=>Object.freeze({operation:'draft' as const,reservedTokens:100,inputDigest:draftInputDigest({system:args.system[0],prompt:args.turns[0].role==='user'?args.turns[0].content:'',maxTokens:args.maxTokens})});
const meter={semantics:'all_native_input_and_all_generated_output_v1' as const,nativeContextTokens:4096,completionTokens:128,promptUsdPerMillion:3,completionUsdPerMillion:15,nativeContractDigest:'e'.repeat(64),endpointRevisionDigest:'f'.repeat(64),documentationDigest:'1'.repeat(64)};
const profile=()=>captureReviewedMeteredCarrier({carrier:'openrouter_fixed_metered_text_v1',meterContract:meter,capabilityDigest:'a'.repeat(64),sourceDigest:FIXED_METERED_CARRIER_SOURCE_DIGEST,configurationDigest:aiSpendConfigurationDigest(cfg),model:cfg.model,operation:'draft',endpointSlug:'fictional/endpoint',workspaceControlDigest:'b'.repeat(64),reviewEvidenceDigest:'c'.repeat(64),independentEvidenceDigest:'d'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString(),invariants:Object.fromEntries(FIXED_METERED_INVARIANTS.map(key=>[key,true]))});
const configuration=()=>({model:cfg.model,apiKey:cfg.apiKey,routing:(cfg.providerOptions as {routing:unknown}).routing});
beforeEach(()=>{vi.stubEnv('AI_SPEND_RECEIPT_KEY_ID','');vi.stubEnv('AI_SPEND_RECEIPT_SIGNING_KEY','');});afterEach(()=>vi.unstubAllEnvs());
describe('conditional source-owned complete metered carrier dispatch',()=>{
 it('requires a complete documented native context/output contract, not raw metadata, fractional prices or variant syntax',()=>{
  expect(captureMeteredContract(meter)).toEqual(meter);expect(meteredReservationNanos(meter)).toBe('14208000');
  for(const bad of [{...meter,promptUsdPerMillion:3.01},{...meter,nativeContextTokens:Infinity},{...meter,completionTokens:32769},{...meter,completionTokens:4097},{...meter,semantics:'metadata_only'},{...meter,documentationDigest:''}])expect(()=>captureMeteredContract(bad)).toThrow();
  for(const model of ['fictional/model:free','fictional/model:online','openrouter/free'])expect(()=>captureReviewedMeteredCarrier({...profile(),model})).toThrow();
  expect(()=>meteredReservationNanos({...meter,nativeContextTokens:Number.MAX_SAFE_INTEGER,promptUsdPerMillion:Number.MAX_SAFE_INTEGER})).toThrow();
 });
 it('requires independently reviewed closed controls, current source/config and expiry; metadata/suffix alone cannot issue an envelope',()=>{
  expect(()=>currentReviewedMeteredEnvelope(cfg,request())).toThrow();expect(()=>currentReviewedMeteredEnvelope(cfg,request(),{})).toThrow();
  for(const changed of [{...profile(),invariants:{...profile().invariants,noByok:false}},{...profile(),sourceDigest:'0'.repeat(64)},{...profile(),reviewEvidenceDigest:profile().independentEvidenceDigest},{...profile(),expiresAt:new Date(Date.now()-1).toISOString()}])expect(()=>captureReviewedMeteredCarrier(changed)).toThrow();
 });
 it('uses exactly one original-deadline POST with reviewed whole-USD/M caps and full native maxima, fixed endpoint, privacy and disabled processing',async()=>{
  const req=request(),proof=issueReviewedMeteredProof(profile(),cfg,req),envelope=currentReviewedMeteredEnvelope(cfg,req,proof);expect(envelope).toMatchObject({reservedNanos:'14208000',requestDigest:req.inputDigest});expect(()=>currentReviewedFreeEnvelope(cfg,req,proof)).toThrow();await expect(withReviewedFreeDispatch(proof,cfg,req,async()=>undefined)).rejects.toThrow();
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({id:'gen-fictional',model:cfg.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'Synthetic answer'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:0}}),{headers:{'content-type':'application/json'}}));
  await withReviewedMeteredDispatch(proof,cfg,req,()=>createOpenRouterTransport(fetcher,req.operation)(configuration(),args));expect(fetcher).toHaveBeenCalledTimes(1);
  const body=JSON.parse(String(fetcher.mock.calls[0][1]?.body));expect(body.provider).toMatchObject({only:['fictional/endpoint'],order:['fictional/endpoint'],allow_fallbacks:false,require_parameters:true,data_collection:'deny',zdr:true,max_price:{prompt:3,completion:15,request:0}});expect(body.plugins.every((entry:{enabled:boolean})=>entry.enabled===false)).toBe(true);expect(body).not.toHaveProperty('models');expect(body).not.toHaveProperty('cache_control');expect(fetcher.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  await expect(withReviewedMeteredDispatch(proof,cfg,req,async()=>undefined)).rejects.toThrow();
 });
 it('binds exact client-tool conversation history without granting server-tool execution or cache continuation',async()=>{
  const input:ConverseArgs={...args,turns:[{role:'user',content:'Synthetic question'},{role:'assistant',content:'',toolCalls:[{id:'call-1',name:'synthetic_read',input:{}}]},{role:'tool',results:[{id:'call-1',name:'synthetic_read',content:'Synthetic canonical result'}]}],tools:[{name:'synthetic_read',description:'Synthetic only',inputSchema:{type:'object',properties:{},required:[],additionalProperties:false}}]};
  const req=Object.freeze({operation:'conversation' as const,reservedTokens:100,inputDigest:conversationInputDigest(input)}),proof=issueReviewedMeteredProof(captureReviewedMeteredCarrier({...profile(),operation:'conversation'}),cfg,req);currentReviewedMeteredEnvelope(cfg,req,proof);
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({id:'gen-fictional-tools',model:cfg.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'Synthetic final'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:0}}),{headers:{'content-type':'application/json'}}));
  await withReviewedMeteredDispatch(proof,cfg,req,()=>createOpenRouterTransport(fetcher,req.operation)(configuration(),input));expect(fetcher).toHaveBeenCalledTimes(1);const body=JSON.parse(String(fetcher.mock.calls[0][1]?.body));expect(body.tools).toMatchObject([{type:'function',function:{name:'synthetic_read'}}]);expect(body.messages[3]).toMatchObject({role:'tool',tool_call_id:'call-1'});
  const cached={...input,cacheKey:'opaque-cache'},changed=Object.freeze({...req,inputDigest:conversationInputDigest(cached)}),second=issueReviewedMeteredProof(captureReviewedMeteredCarrier({...profile(),operation:'conversation'}),cfg,changed);currentReviewedMeteredEnvelope(cfg,changed,second);await expect(withReviewedMeteredDispatch(second,cfg,changed,()=>createOpenRouterTransport(fetcher,req.operation)(configuration(),cached))).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('reserves full native C and M even for tiny input and refuses output above the reviewed maximum before HTTP',async()=>{
  const input={...args,maxTokens:129},req=Object.freeze({operation:'draft' as const,reservedTokens:1,inputDigest:draftInputDigest({system:input.system[0],prompt:'Synthetic question',maxTokens:129})}),proof=issueReviewedMeteredProof(profile(),cfg,req);expect(currentReviewedMeteredEnvelope(cfg,req,proof).reservedNanos).toBe('14208000');const fetcher=vi.fn<typeof fetch>();
  await expect(withReviewedMeteredDispatch(proof,cfg,req,()=>createOpenRouterTransport(fetcher,req.operation)(configuration(),input))).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
  for(const changed of [{...profile(),invariants:{...profile().invariants,hardNativeContextAllInput:false}},{...profile(),invariants:{...profile().invariants,completionIncludesAllReasoning:false}},{...profile(),invariants:{...profile().invariants,noPaidCacheWrites:false}}])expect(()=>captureReviewedMeteredCarrier(changed)).toThrow();
 });
 it('rejects detached asynchronous dispatch after the original scope closes',async()=>{
  const req=request(),proof=issueReviewedMeteredProof(profile(),cfg,req);currentReviewedMeteredEnvelope(cfg,req,proof);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let late!:Promise<unknown>;const fetcher=vi.fn<typeof fetch>();
  await withReviewedMeteredDispatch(proof,cfg,req,async()=>{const body=buildOpenRouterRequest({model:cfg.model,routing:(cfg.providerOptions as {routing:unknown}).routing},args);consumeReviewedMeteredPost(cfg,body);late=(async()=>{await gate;return createOpenRouterTransport(fetcher,req.operation)(configuration(),args);})();});
  release();await expect(late).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
 });
 it('refuses copied proofs, changed request/key and duplicate dispatch before HTTP',async()=>{
  const req=request(),proof=issueReviewedMeteredProof(profile(),cfg,req);currentReviewedMeteredEnvelope(cfg,req,proof);const fetcher=vi.fn<typeof fetch>();
  await expect(withReviewedMeteredDispatch({...proof},cfg,req,async()=>undefined)).rejects.toThrow();await expect(withReviewedMeteredDispatch(proof,{...cfg},req,async()=>undefined)).rejects.toThrow();
  await expect(withReviewedMeteredDispatch(proof,cfg,req,()=>createOpenRouterTransport(fetcher,req.operation)(configuration(),{...args,turns:[{role:'user',content:'Changed'}]}))).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
  const second=issueReviewedMeteredProof(profile(),cfg,req);currentReviewedMeteredEnvelope(cfg,req,second);
  await expect(withReviewedMeteredDispatch(second,cfg,req,async()=>{const body=buildOpenRouterRequest({model:cfg.model,routing:(cfg.providerOptions as {routing:unknown}).routing},args);consumeReviewedMeteredPost({...cfg,apiKey:'other-key'},body);})).rejects.toThrow();
  const third=issueReviewedMeteredProof(profile(),cfg,req);currentReviewedMeteredEnvelope(cfg,req,third);
  await expect(withReviewedMeteredDispatch(third,cfg,req,async()=>{const body=buildOpenRouterRequest({model:cfg.model,routing:(cfg.providerOptions as {routing:unknown}).routing},args);consumeReviewedMeteredPost(cfg,body);consumeReviewedMeteredPost(cfg,body);})).rejects.toThrow();
 });
});
