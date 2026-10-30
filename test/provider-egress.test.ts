/** Runtime dispatch regression: mocked SDK/fetch only, never a live provider or credential. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {withProviderEgressDispatch,consumeProviderEgressDispatch} from '../lib/ai/provider-egress';
import {draftInputDigest} from '../lib/ai/draft-input';
import {conversationInputDigest} from '../lib/ai/conversation-input';
import {captureImageInput,imageInputDigest} from '../lib/ai/image-input';
import {anthropicAdapter} from '../lib/ai/providers/anthropic';
import {googleAdapter} from '../lib/ai/providers/google';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {gatewayAdapter} from '../lib/ai/providers/gateway';
import {createOpenRouterAdapter} from '../lib/ai/providers/openrouter';
import {createOpenRouterTransport} from '../lib/ai/providers/openrouter-transport';
import {readOpenRouterOptions} from '../lib/ai/providers/openrouter-configuration';
import type {AiAdapter,ConverseArgs,GenerateArgs,ResolvedAiConfig} from '../lib/ai/types';
const sdk=vi.hoisted(()=>({anthropic:vi.fn(),anthropicProbe:vi.fn(),google:vi.fn(),openai:vi.fn(),openaiProbe:vi.fn(),dns:vi.fn()}));
vi.mock('@anthropic-ai/sdk',()=>({default:class{static APIError=class extends Error{};messages={create:sdk.anthropic};models={retrieve:sdk.anthropicProbe};}}));
vi.mock('@google/genai',()=>({ApiError:class extends Error{},GoogleGenAI:class{models={generateContent:sdk.google};}}));
vi.mock('openai',()=>({default:class{static APIError=class extends Error{};chat={completions:{create:sdk.openai}};models={retrieve:sdk.openaiProbe};}}));
vi.mock('node:dns/promises',()=>({lookup:sdk.dns}));
const draft:GenerateArgs={system:'Source-owned minimal instruction',prompt:'Sanitized fictional question',maxTokens:32};
const conversation:ConverseArgs={system:['Source-owned instruction'],turns:[{role:'user',content:'Sanitized fictional question'}],tools:[],maxTokens:32,timeoutMs:1000};
const options=readOpenRouterOptions({version:1,routing:{allowedProviders:['approved-fixture'],allowFallbacks:false,sort:'latency'}});
const config=(provider:ResolvedAiConfig['provider']):ResolvedAiConfig=>({provider,model:provider==='openrouter'?'fictional/model':'fixture-model',apiKey:'fictional-not-a-credential',
 ...(provider==='openrouter'?{providerOptions:options}:{}),...(provider==='ai_gateway'?{gatewayBaseUrl:'https://fictional.example/v1'}:{}),governance:{run:async(_request,call)=>call(()=>{})}});
const response=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
const completed=()=>({choices:[{finish_reason:'stop',message:{role:'assistant',content:'Fictional answer'}}],usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6,prompt_tokens_details:{cached_tokens:0}}});
const native=[['anthropic',anthropicAdapter],['google',googleAdapter],['openai',openaiAdapter]] as const;
beforeEach(()=>{
 for(const mock of Object.values(sdk))mock.mockReset();
 sdk.anthropic.mockResolvedValue({content:[{type:'text',text:'Fictional answer'}],stop_reason:'end_turn',usage:{input_tokens:4,output_tokens:2}});
 sdk.google.mockResolvedValue({text:'Fictional answer',candidates:[{finishReason:'STOP',content:{parts:[{text:'Fictional answer'}]}}],usageMetadata:{promptTokenCount:4,candidatesTokenCount:2}});
 sdk.openai.mockResolvedValue(completed());sdk.anthropicProbe.mockResolvedValue({});sdk.openaiProbe.mockResolvedValue({});sdk.dns.mockResolvedValue([{address:'203.0.113.10'}]);
});
afterEach(()=>vi.restoreAllMocks());
const sendDraft=(cfg:ResolvedAiConfig,adapter:AiAdapter,args=draft)=>withProviderEgressDispatch(cfg,{operation:'draft',inputDigest:draftInputDigest(args)},()=>adapter.generate(cfg,args));

describe('one-use final provider egress dispatch',()=>{
 it.each(native)('%s refuses direct SDK entry despite a posted governance/privacy flag',async(provider,adapter)=>{
  const cfg=config(provider);
  await expect(adapter.generate(cfg,draft)).rejects.toThrow();
  await expect(adapter.converse!(cfg,conversation)).rejects.toThrow();
  const image={data:new Uint8Array([1,2,3]),mimeType:'image/png' as const,signal:new AbortController().signal,timeoutMs:1000};
  await expect(adapter.readImage!(cfg,image)).rejects.toThrow();expect((await adapter.validate(cfg)).ok).toBe(false);
  await expect(withProviderEgressDispatch({...cfg,privacyReviewed:true} as ResolvedAiConfig,{operation:'draft',inputDigest:draftInputDigest(draft)},()=>adapter.generate(cfg,draft))).rejects.toThrow();
  expect(sdk.anthropic).not.toHaveBeenCalled();expect(sdk.google).not.toHaveBeenCalled();expect(sdk.openai).not.toHaveBeenCalled();expect(sdk.anthropicProbe).not.toHaveBeenCalled();expect(sdk.openaiProbe).not.toHaveBeenCalled();
 });
 it.each(native)('%s sends the exact authorized draft and preserves observed usage',async(provider,adapter)=>{
  const cfg=config(provider),usage=vi.fn();expect(await sendDraft(cfg,adapter,{...draft,onUsage:usage})).toBe('Fictional answer');
  expect(usage).toHaveBeenCalledOnce();expect(usage).toHaveBeenCalledWith({inputTokens:4,outputTokens:2,cachedInputTokens:0});
  const call=provider==='anthropic'?sdk.anthropic:provider==='google'?sdk.google:sdk.openai;
  expect(call).toHaveBeenCalledOnce();expect(JSON.stringify(call.mock.calls[0][0])).toContain(draft.prompt);
 });
 it.each(native)('%s accepts an exact authorized conversation and no other input',async(provider,adapter)=>{
  const cfg=config(provider);const out=await withProviderEgressDispatch(cfg,{operation:'conversation',inputDigest:conversationInputDigest(conversation)},()=>adapter.converse!(cfg,conversation));
  expect(out.text).toBe('Fictional answer');expect(out.usageReported).toBe(true);
  await expect(withProviderEgressDispatch(cfg,{operation:'conversation',inputDigest:conversationInputDigest(conversation)},()=>adapter.converse!(cfg,{...conversation,turns:[{role:'user',content:'Unreviewed replacement'}]}))).rejects.toThrow();
 });
 it('refuses wrong operation, model, key, route or actual draft digest before another SDK call',async()=>{
  const cfg=config('openai');
  for(const changed of [{...cfg,model:'different-model'},{...cfg,apiKey:'different-fictional-key'},{...cfg,provider:'anthropic' as const}])await expect(withProviderEgressDispatch(cfg,{operation:'draft',inputDigest:draftInputDigest(draft)},()=>openaiAdapter.generate(changed,draft))).rejects.toThrow();
  for(const changed of [{...draft,prompt:'Unreviewed input'},{...draft,system:'Unreviewed system'},{...draft,maxTokens:33}])await expect(withProviderEgressDispatch(cfg,{operation:'draft',inputDigest:draftInputDigest(draft)},()=>openaiAdapter.generate(cfg,changed))).rejects.toThrow();
  await expect(withProviderEgressDispatch(cfg,{operation:'conversation',inputDigest:conversationInputDigest(conversation)},()=>openaiAdapter.generate(cfg,draft))).rejects.toThrow();expect(sdk.openai).not.toHaveBeenCalled();
 });
 it('never uses a matching configuration permit with the wrong native SDK carrier',async()=>{
  const cfg=config('anthropic');
  await expect(withProviderEgressDispatch(cfg,{operation:'draft',inputDigest:draftInputDigest(draft)},()=>openaiAdapter.generate(cfg,draft))).rejects.toThrow();
  await expect(withProviderEgressDispatch(cfg,{operation:'draft',inputDigest:draftInputDigest(draft)},()=>googleAdapter.generate(cfg,draft))).rejects.toThrow();
  expect(sdk.openai).not.toHaveBeenCalled();expect(sdk.google).not.toHaveBeenCalled();
 });
 it('consumes only once, refuses nested issuance and closes inherited async context after the owner returns',async()=>{
  const cfg=config('openai');
  await withProviderEgressDispatch(cfg,{operation:'draft',inputDigest:draftInputDigest(draft)},async()=>{
   expect(await openaiAdapter.generate(cfg,draft)).toBe('Fictional answer');await expect(openaiAdapter.generate(cfg,draft)).rejects.toThrow();
   await expect(sendDraft(cfg,openaiAdapter)).rejects.toThrow();
  });expect(sdk.openai).toHaveBeenCalledOnce();
  let late!:Promise<unknown>;
  await withProviderEgressDispatch(cfg,{operation:'draft',inputDigest:draftInputDigest(draft)},async()=>{
   late=new Promise(resolve=>{setTimeout(()=>{void openaiAdapter.generate(cfg,draft).then(()=>resolve('unexpected send'),()=>resolve('refused'));},0);});
  });expect(await late).toBe('refused');expect(sdk.openai).toHaveBeenCalledOnce();
 });
 it('keeps exact ai_gateway routing identity through its OpenAI serializer and refuses direct gateway DNS',async()=>{
  const cfg=config('ai_gateway');await expect(gatewayAdapter.generate(cfg,draft)).rejects.toThrow();expect(sdk.dns).not.toHaveBeenCalled();
  expect(await sendDraft(cfg,gatewayAdapter)).toBe('Fictional answer');expect(sdk.dns).toHaveBeenCalledOnce();expect(sdk.openai).toHaveBeenCalledOnce();
  await expect(withProviderEgressDispatch(cfg,{operation:'draft',inputDigest:draftInputDigest(draft)},()=>gatewayAdapter.generate({...cfg,gatewayBaseUrl:'https://other.example/v1'},draft))).rejects.toThrow();
  await expect(withProviderEgressDispatch(cfg,{operation:'draft',inputDigest:draftInputDigest(draft)},()=>openaiAdapter.generate({...cfg,provider:'openai',gatewayBaseUrl:undefined},draft))).rejects.toThrow();expect(sdk.openai).toHaveBeenCalledOnce();
 });
 it('binds normalized image timeout and captured bytes, refusing a changed image before SDK serialization',async()=>{
  const cfg=config('openai'),captured=captureImageInput({data:new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]),mimeType:'image/png',timeoutMs:999999});
  expect(captured.timeoutMs).toBe(20000);const args={...captured,signal:new AbortController().signal};
  await withProviderEgressDispatch(cfg,{operation:'image',inputDigest:imageInputDigest(captured)},()=>openaiAdapter.readImage!(cfg,args));expect(sdk.openai).toHaveBeenCalledOnce();
  await expect(withProviderEgressDispatch(cfg,{operation:'image',inputDigest:imageInputDigest(captured)},()=>openaiAdapter.readImage!(cfg,{...args,data:new Uint8Array([1,2,3])}))).rejects.toThrow();expect(sdk.openai).toHaveBeenCalledOnce();
 });
 it('permits only the native fixed probe operation, never a prompt/image send or caller-supplied probe input',async()=>{
  for(const [provider,adapter] of native)expect(await withProviderEgressDispatch(config(provider),{operation:'probe'},()=>adapter.validate(config(provider)))).toEqual({ok:true});
  expect(sdk.google.mock.calls[0][0]).toMatchObject({contents:'hi',config:{maxOutputTokens:1}});
  const cfg=config('openai');await expect(withProviderEgressDispatch(cfg,{operation:'probe'},()=>openaiAdapter.generate(cfg,draft))).rejects.toThrow();
  await expect(withProviderEgressDispatch(cfg,{operation:'probe',inputDigest:draftInputDigest(draft)},()=>openaiAdapter.validate(cfg))).rejects.toThrow();
  await expect(withProviderEgressDispatch(cfg,{operation:'probe'},async()=>consumeProviderEgressDispatch(cfg,'probe',draft))).rejects.toThrow();
 });
 it('guards the actual OpenRouter raw POST, not merely the exported adapter wrapper',async()=>{
  const cfg=config('openrouter'),fetcher=vi.fn(async()=>response(completed())),transport=createOpenRouterTransport(fetcher);
  const route={model:cfg.model,apiKey:cfg.apiKey,routing:options.routing};
  await expect(transport(route,conversation)).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
  await withProviderEgressDispatch(cfg,{operation:'conversation',inputDigest:conversationInputDigest(conversation)},async()=>{
   expect((await transport(route,conversation)).completion.text).toBe('Fictional answer');await expect(transport(route,conversation)).rejects.toThrow();
  });expect(fetcher).toHaveBeenCalledOnce();
  await expect(withProviderEgressDispatch(cfg,{operation:'conversation',inputDigest:conversationInputDigest(conversation)},()=>transport({...route,routing:{...options.routing,allowedProviders:['foreign']}},conversation))).rejects.toThrow();
  await expect(withProviderEgressDispatch(cfg,{operation:'probe'},()=>transport(route,conversation))).rejects.toThrow();
  await expect(withProviderEgressDispatch(cfg,{operation:'draft',inputDigest:draftInputDigest(draft)},()=>transport(route,{...conversation,tools:[{name:'unreviewed',description:'x',inputSchema:{type:'object',properties:{},required:[],additionalProperties:false}}]}))).rejects.toThrow();expect(fetcher).toHaveBeenCalledOnce();
 });
 it('keeps OpenRouter charged-but-refused observations, does not invent missing usage, and requires the actual draft digest',async()=>{
  const cfg=config('openrouter'),fetcher=vi.fn(async()=>response(completed())),adapter=createOpenRouterAdapter(fetcher),usage=vi.fn(),observation=vi.fn();
  expect(await sendDraft(cfg,adapter,{...draft,onUsage:usage,onObservation:observation})).toBe('Fictional answer');expect(usage).toHaveBeenCalledWith({inputTokens:4,outputTokens:2,cachedInputTokens:0});
  const cut=completed();cut.choices[0].finish_reason='length';fetcher.mockResolvedValueOnce(response(cut));
  await expect(sendDraft(cfg,adapter,{...draft,onUsage:usage,onObservation:observation})).rejects.toThrow();expect(usage).toHaveBeenCalledTimes(2);expect(observation).toHaveBeenCalledTimes(2);
  const missing=completed() as {usage?:unknown};delete missing.usage;fetcher.mockResolvedValueOnce(response(missing));
  await sendDraft(cfg,adapter,{...draft,onUsage:usage,onObservation:observation});expect(usage).toHaveBeenCalledTimes(2);expect(observation.mock.calls[2][0].usage).toBeNull();
  await expect(withProviderEgressDispatch(cfg,{operation:'conversation',inputDigest:conversationInputDigest(conversation)},()=>adapter.generate(cfg,draft))).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(3);
 });
 it('allows only the fixed official metadata GET sequence for an OpenRouter probe',async()=>{
  const cfg=config('openrouter'),fetcher=vi.fn().mockResolvedValueOnce(response({data:{label:'fictional',usage:0}}))
   .mockResolvedValueOnce(response({data:{id:cfg.model,endpoints:[{tag:'approved-fixture',supported_parameters:['tools','tool_choice']}]}}))
   .mockResolvedValueOnce(response({data:[{model_id:cfg.model,tag:'approved-fixture',supported_parameters:['tools','tool_choice']}]}));
  const adapter=createOpenRouterAdapter(fetcher);expect((await adapter.validate(cfg)).ok).toBe(false);expect(fetcher).not.toHaveBeenCalled();
  expect(await withProviderEgressDispatch(cfg,{operation:'probe'},()=>adapter.validate(cfg))).toEqual({ok:true});
  expect(fetcher.mock.calls.map(([url])=>url)).toEqual(['https://openrouter.ai/api/v1/key','https://openrouter.ai/api/v1/models/fictional/model/endpoints','https://openrouter.ai/api/v1/endpoints/zdr']);
  for(const [,init] of fetcher.mock.calls){expect(init.method).toBe('GET');expect(init.body).toBeUndefined();}
 });
});
