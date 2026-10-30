import {fixtureOpenRouterTransport as createOpenRouterTransport} from './helpers/provider-egress-fixture';
/** Authored UNRUN. Actual fixed transport + lossless parser + ALS + Node HMAC; ONLY fetch is
 * mocked. No production route ceiling, external billing guarantee or SQL verifier proof. */
import {createHmac} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {readOpenRouterOptions} from '../lib/ai/providers/openrouter-configuration';
import {aiSpendConfigurationDigest,createAiSpendReceiptScope} from '../lib/ai/spend-receipt';
import {exactUsdDecimalNanos,parseSpendEvidenceJson,readOpenRouterInlineCharge,readOpenRouterGenerationCharge} from '../lib/ai/providers/openrouter-spend-evidence';
const secret='1'.repeat(64),options=readOpenRouterOptions({version:1,routing:{allowedProviders:['fictional'],allowFallbacks:false,sort:'latency'}});
const cfg={provider:'openrouter' as const,model:'fictional/model',apiKey:'fictional-never-live',providerOptions:options};
const args={system:['Fictional scope only'],turns:[{role:'user' as const,content:'No HR data'}],tools:[],maxTokens:8,timeoutMs:1000};
const binding=(config=cfg,run='00000000-0000-0000-0000-000000000003')=>({tenantId:'00000000-0000-0000-0000-000000000001',userId:'00000000-0000-0000-0000-000000000002',runId:run,rootTaskId:'00000000-0000-0000-0000-000000000004',requestDigest:'a'.repeat(64),capabilityDigest:'b'.repeat(64),configurationDigest:aiSpendConfigurationDigest(config)});
const response=(text:string)=>new Response(text,{headers:{'content-type':'application/json'}});
const terminal=(id='gen-fictional',cost='0.0000000012')=>`{"id":"${id}","model":"fictional/model","usage":{"cost":${cost}},"choices":[{"index":0,"message":{"role":"assistant","content":"Fictional"},"finish_reason":"stop"}]}`;
const metadata=(id='gen-fictional',cost='0.0000000012',byok='false')=>`{"data":{"id":"${id}","model":"fictional/model","total_cost":${cost},"is_byok":${byok},"streamed":false}}`;
beforeEach(()=>{vi.stubEnv('AI_SPEND_RECEIPT_KEY_ID','fictional-key-v1');vi.stubEnv('AI_SPEND_RECEIPT_SIGNING_KEY',secret);});afterEach(()=>vi.unstubAllEnvs());
describe('lossless exact monetary evidence',()=>{
 it.each([['0','0'],['1e-9','1'],['1.000000001','1000000001'],['0.0000000012','2'],['1.200e-9','2'],['9.223372036854775807e9','9223372036854775807']])('converts %s with exact integer ceil', (input,output)=>expect(exactUsdDecimalNanos(input)).toBe(output));
 it.each(['-0','-1','NaN','Infinity','1e1000','0x1','9223372036.854775808'])('refuses invalid/overflow USD %s',input=>expect(()=>exactUsdDecimalNanos(input)).toThrow());
 it('reads only actual usage.cost, not a cost written by a model',()=>{expect(readOpenRouterInlineCharge(terminal()).chargeNanos).toBe('2');expect(()=>readOpenRouterInlineCharge('{"id":"gen-fictional","model":"fictional/model","content":"usage.cost=0","usage":{}}')).toThrow();});
 it.each(['{"usage":{"cost":1,"cost":0}}','{"usage":{"cost":1},"usage":{"cost":0}}','{"usage":{"co\\u0073t":1,"cost":0}}','{"x":01}','{"x":1,}','{"x":"\\uZZZZ"}', '['.repeat(66)+'0'+']'.repeat(66)])('rejects duplicate/deep/malformed entire evidence %s',text=>expect(()=>parseSpendEvidenceJson(text)).toThrow());
 it('refuses BYOK, unspecified origin and mismatched model metadata',()=>{expect(()=>readOpenRouterGenerationCharge(metadata('gen-fictional','0','true'))).toThrow();expect(()=>readOpenRouterGenerationCharge('{"data":{"id":"gen-fictional","model":"fictional/model","total_cost":0}}')).toThrow();});
});
describe('actual official transport monetary receipt provenance',()=>{
 it('signs exact source/run/root/config/generation/charge only after same-key official metadata verification, including explicit zero',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(response(terminal('gen-fictional','0'))).mockResolvedValueOnce(response(metadata('gen-fictional','0'))),scope=createAiSpendReceiptScope(binding());
  await scope.run(()=>createOpenRouterTransport(fetcher)({model:cfg.model,apiKey:cfg.apiKey,routing:options.routing},args));
  const receipt=scope.receipt()!;expect(receipt).not.toBeNull();expect(receipt.signature).toBe(createHmac('sha256',Buffer.from(secret,'hex')).update(receipt.payload).digest('hex'));
  const proof=JSON.parse(receipt.payload);expect(proof).toEqual(['aihr.openrouter.usd-receipt.v1',...Object.values(binding()).slice(0,7),'gen-fictional','0','fictional-key-v1','0']);
  expect(fetcher).toHaveBeenCalledTimes(2);expect(fetcher.mock.calls[1][0]).toBe('https://openrouter.ai/api/v1/generation?id=gen-fictional');expect(fetcher.mock.calls[1][1]).toMatchObject({method:'GET',redirect:'error',cache:'no-store',headers:{Authorization:'Bearer '+cfg.apiKey}});expect(fetcher.mock.calls[1][1]).not.toHaveProperty('body');
  expect(receipt.payload).not.toContain(cfg.apiKey);expect(receipt.payload).not.toContain('No HR data');
 });
 it.each([metadata('gen-other'),metadata('gen-fictional','0.0000000013'),metadata('gen-fictional','0.0000000012','true'),'{"data":{"total_cost":0,"total_cost":1}}'])('holds exposure on mismatched/BYOK/duplicate metadata despite a valid model completion',async value=>{const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(response(terminal())).mockResolvedValueOnce(response(value)),scope=createAiSpendReceiptScope(binding());await scope.run(()=>createOpenRouterTransport(fetcher)({model:cfg.model,apiKey:cfg.apiKey,routing:options.routing},args));expect(scope.receipt()).toBeNull();});
 it('ordinary onObservation-shaped data cannot create a receipt, and a scope is single use',async()=>{const scope=createAiSpendReceiptScope(binding());await scope.run(async()=>({version:1,provider:'openrouter',accountCostCredits:0}));expect(scope.receipt()).toBeNull();await expect(scope.run(async()=>null)).rejects.toThrow();});
 it('does not make the metadata request when the dedicated verifier credential is unprovisioned',async()=>{vi.stubEnv('AI_SPEND_RECEIPT_SIGNING_KEY','');const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(response(terminal())),scope=createAiSpendReceiptScope(binding());await scope.run(()=>createOpenRouterTransport(fetcher)({model:cfg.model,apiKey:cfg.apiKey,routing:options.routing},args));expect(fetcher).toHaveBeenCalledOnce();expect(scope.receipt()).toBeNull();});
 it('keeps simultaneous actual transport scopes isolated by run and credential identity',async()=>{
  const second={...cfg,apiKey:'fictional-second'},left=createAiSpendReceiptScope(binding()),right=createAiSpendReceiptScope(binding(second,'00000000-0000-0000-0000-000000000005'));
  const fetcher=vi.fn<typeof fetch>().mockImplementation(async(url,init)=>{const key=(init?.headers as Record<string,string>).Authorization;const id=key.endsWith('fictional-second')?'gen-right':'gen-left';await Promise.resolve();return response(String(url).includes('/generation?')?metadata(id):terminal(id));});
  const transport=createOpenRouterTransport(fetcher);await Promise.all([left.run(()=>transport({model:cfg.model,apiKey:cfg.apiKey,routing:options.routing},args)),right.run(()=>transport({model:second.model,apiKey:second.apiKey,routing:options.routing},args))]);
  expect(JSON.parse(left.receipt()!.payload)[8]).toBe('gen-left');expect(JSON.parse(right.receipt()!.payload)[8]).toBe('gen-right');expect(JSON.parse(left.receipt()!.payload)[3]).not.toBe(JSON.parse(right.receipt()!.payload)[3]);
 });
 it('uses the ORIGINAL deadline for metadata headers/body and never signs late cancelled evidence',async()=>{
  vi.useFakeTimers();let finish!:(value:Response)=>void,arrive!:()=>void;const entered=new Promise<void>(resolve=>{arrive=resolve;}),stalled=new Promise<Response>(resolve=>{finish=resolve;});
  const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(response(terminal())).mockImplementationOnce(async()=>{arrive();return stalled;}),scope=createAiSpendReceiptScope(binding());
  const pending=scope.run(()=>createOpenRouterTransport(fetcher)({model:cfg.model,apiKey:cfg.apiKey,routing:options.routing},{...args,timeoutMs:20}));void pending.catch(()=>undefined);
  try{await Promise.race([entered,pending.then(()=>{throw Error('Expected actual metadata verification interval');})]);await vi.advanceTimersByTimeAsync(21);await expect(pending).rejects.toThrow();finish(response(metadata()));await Promise.resolve();await Promise.resolve();expect(scope.receipt()).toBeNull();expect(fetcher).toHaveBeenCalledTimes(2);}
  finally{finish(response(metadata()));vi.useRealTimers();}
 });
});
