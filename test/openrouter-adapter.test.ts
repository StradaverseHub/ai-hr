/** Mocked-only adapter/probe regressions, authored UNRUN. No real provider or key. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {fixtureOpenRouterAdapter as createOpenRouterAdapter} from './helpers/provider-egress-fixture';
import { readOpenRouterOptions } from '../lib/ai/providers/openrouter-configuration';
import { envFallbackConfig } from '../lib/ai/registry';
import type { AiUsage, ResolvedAiConfig } from '../lib/ai/types';
const cfg: ResolvedAiConfig = { provider: 'openrouter', model: 'fictional/model', apiKey: 'fixture-key',
  providerOptions: readOpenRouterOptions({version:1,routing:{allowedProviders:['approved-a']}}),
  governance: {run:async (_request,call)=>call(()=>{})} };
const completion = (usage: unknown = {prompt_tokens:10,completion_tokens:2,total_tokens:12,prompt_tokens_details:{cached_tokens:0}}) => ({
  choices:[{finish_reason:'stop',message:{role:'assistant',content:'Fictional draft'}}],usage });
const response = (value: unknown) => new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
afterEach(()=>vi.unstubAllEnvs());
describe('OpenRouter adapter gateway contract',()=>{
 it('records only actual known usage and sends one fixed privacy-bound nonstreaming request',async()=>{
  const fetcher=vi.fn(async()=>response(completion())),record=vi.fn((_usage:AiUsage)=>{});
  const adapter=createOpenRouterAdapter(fetcher);
  expect(await adapter.generate(cfg,{system:'Authorized minimal instruction',prompt:'Fictional input',onUsage:record})).toBe('Fictional draft');
  expect(fetcher).toHaveBeenCalledTimes(1);const [url,init]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
  expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');expect(init.redirect).toBe('error');expect(init.cache).toBe('no-store');
  expect(JSON.parse(String(init.body))).toMatchObject({model:'fictional/model',stream:false,provider:{only:['approved-a'],order:['approved-a'],data_collection:'deny',zdr:true,require_parameters:true,allow_fallbacks:false}});
  expect(record).toHaveBeenCalledWith({inputTokens:10,outputTokens:2,cachedInputTokens:0});
 });
 it('never substitutes zero usage for missing accounting or returns truncated/refused drafts',async()=>{
  const record=vi.fn(),fetcher=vi.fn(async()=>response(completion(undefined))),adapter=createOpenRouterAdapter(fetcher);
  const unknown=completion();delete (unknown as {usage?:unknown}).usage;fetcher.mockResolvedValueOnce(response(unknown));
  await adapter.generate(cfg,{system:'s',prompt:'p',onUsage:record});expect(record).not.toHaveBeenCalled();
  const cut=completion();cut.choices[0].finish_reason='length';fetcher.mockResolvedValueOnce(response(cut));
  await expect(adapter.generate(cfg,{system:'s',prompt:'p',onUsage:record})).rejects.toThrow('AI provider response unavailable');
  expect(record).toHaveBeenCalledTimes(1); // Known charged usage survives refusal; no invented usage.
 });
 it.each([undefined,{version:2,routing:{allowedProviders:['approved-a']}},{version:1,routing:{allowedProviders:[]}}])
 ('refuses missing/invalid persisted routing before any request',async providerOptions=>{
  const fetcher=vi.fn(async()=>response(completion())),adapter=createOpenRouterAdapter(fetcher);
  await expect(adapter.generate({...cfg,providerOptions:providerOptions as ResolvedAiConfig['providerOptions']},{system:'s',prompt:'p'})).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('requires governance for generation, does not expose an image adapter, and refuses automatic router models',async()=>{
  const fetcher=vi.fn(async()=>response(completion())),adapter=createOpenRouterAdapter(fetcher);expect(adapter.readImage).toBeUndefined();
  await expect(adapter.generate({...cfg,governance:undefined},{system:'s',prompt:'p'})).rejects.toThrow();
  for(const model of ['openrouter/auto','openrouter/free','openrouter/bodybuilder','OpenRouter/auto','fictional/model:online','fictional/model:nitro','fictional/group/model','fictional/model\n'])await expect(adapter.generate({...cfg,model},{system:'s',prompt:'p'})).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('does not enable an OpenRouter environment fallback',()=>{
  for(const name of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(name,'');
  vi.stubEnv('OPENROUTER_API_KEY','fixture-never-admitted');expect(envFallbackConfig()).toBeNull();
 });
 it('checks only bounded official metadata GETs and does not return key labels or certify generation',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(response({data:{label:'private-fixture-label',usage:0}}))
   .mockResolvedValueOnce(response({data:{id:'fictional/model',endpoints:[{tag:'approved-a',supported_parameters:['tools','tool_choice']}]}}))
   .mockResolvedValueOnce(response({data:[{model_id:'fictional/model',tag:'approved-a',supported_parameters:['tools','tool_choice']}]}));
  const result=await createOpenRouterAdapter(fetcher).validate(cfg);expect(result).toEqual({ok:true});expect(JSON.stringify(result)).not.toContain('private');
  expect(fetcher.mock.calls.map(([url])=>url)).toEqual(['https://openrouter.ai/api/v1/key','https://openrouter.ai/api/v1/models/fictional/model/endpoints','https://openrouter.ai/api/v1/endpoints/zdr']);
  for(const [,init] of fetcher.mock.calls){expect(init.method).toBe('GET');expect(init.body).toBeUndefined();expect(init.redirect).toBe('error');}
 });
 it('fails generically for unapproved/non-ZDR/non-tool route metadata and management keys',async()=>{
  for(const mode of ['management','unapproved','not-zdr','no-tools'] as const){
   const fetcher=vi.fn().mockResolvedValueOnce(response({data:{label:'private',usage:0,is_management_key:mode==='management'}}))
    .mockResolvedValueOnce(response({data:{id:'fictional/model',endpoints:[{tag:mode==='unapproved'?'foreign':'approved-a',supported_parameters:mode==='no-tools'?[]:['tools','tool_choice']}]}}))
    .mockResolvedValueOnce(response({data:mode==='not-zdr'?[]:[{model_id:'fictional/model',tag:'approved-a',supported_parameters:['tools','tool_choice']}]}));
   expect(await createOpenRouterAdapter(fetcher).validate(cfg)).toEqual({ok:false,error:'Approved AI route metadata could not be confirmed.'});
  }
 });
});
