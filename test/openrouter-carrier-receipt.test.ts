import {fixtureOpenRouterTransport as createOpenRouterTransport} from './helpers/provider-egress-fixture';
/** Fictional reviewed profiles and mocked HTTP only. Exercises the REAL carrier/transport/HMAC
 * composition used by governance. No principal, SQL settlement, real route or invoice proof. */
import {createHmac} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {ResolvedAiConfig} from '../lib/ai/types';
import {readOpenRouterOptions} from '../lib/ai/providers/openrouter-configuration';
import {aiSpendConfigurationDigest,createAiSpendReceiptScope} from '../lib/ai/spend-receipt';
import {draftInputDigest} from '../lib/ai/draft-input';
import {exactUsdDecimalNanos} from '../lib/ai/providers/openrouter-spend-evidence';
import {captureReviewedFreeCarrier,FIXED_FREE_CARRIER_SOURCE_DIGEST,FIXED_FREE_INVARIANTS,issueReviewedFreeProof,currentReviewedFreeEnvelope,withReviewedFreeDispatch} from '../lib/ai/providers/openrouter-fixed-free-carrier';
import {captureReviewedMeteredCarrier,FIXED_METERED_CARRIER_SOURCE_DIGEST,FIXED_METERED_INVARIANTS,issueReviewedMeteredProof,currentReviewedMeteredEnvelope,withReviewedMeteredDispatch} from '../lib/ai/providers/openrouter-fixed-metered-carrier';
const secret='55'.repeat(32),keyId='fictional-composed-receipt';
const options=readOpenRouterOptions({version:1,routing:{allowedProviders:['fictional/endpoint'],allowFallbacks:false,sort:'latency'}});
const args={system:['Synthetic carrier receipt only'],turns:[{role:'user' as const,content:'No HR data'}],tools:[],maxTokens:64,timeoutMs:1000};
const request=()=>Object.freeze({operation:'draft' as const,reservedTokens:100,inputDigest:draftInputDigest({system:args.system[0],prompt:args.turns[0].content,maxTokens:args.maxTokens})});
const response=(body:string)=>new Response(body,{headers:{'content-type':'application/json'}});
beforeEach(()=>{vi.stubEnv('AI_SPEND_RECEIPT_KEY_ID',keyId);vi.stubEnv('AI_SPEND_RECEIPT_SIGNING_KEY',secret);});
afterEach(()=>vi.unstubAllEnvs());
async function composed(kind:'free'|'metered',cost:string,metadataId='gen-composed'){
 const cfg:ResolvedAiConfig={provider:'openrouter',model:kind==='free'?'fictional/carrier:free':'fictional/carrier',apiKey:'fictional-composed-key',providerOptions:options};
 const req=request(),common={capabilityDigest:'a'.repeat(64),configurationDigest:aiSpendConfigurationDigest(cfg),model:cfg.model,operation:'draft' as const,endpointSlug:'fictional/endpoint',workspaceControlDigest:'b'.repeat(64),reviewEvidenceDigest:'c'.repeat(64),independentEvidenceDigest:'d'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString()};
 let proof:object,envelope:ReturnType<typeof currentReviewedFreeEnvelope>;
 if(kind==='free'){
  const profile=captureReviewedFreeCarrier({...common,sourceDigest:FIXED_FREE_CARRIER_SOURCE_DIGEST,invariants:Object.fromEntries(FIXED_FREE_INVARIANTS.map(k=>[k,true]))});
  proof=issueReviewedFreeProof(profile,cfg,req);envelope=currentReviewedFreeEnvelope(cfg,req,proof);
 }else{
  const profile=captureReviewedMeteredCarrier({...common,carrier:'openrouter_fixed_metered_text_v1',sourceDigest:FIXED_METERED_CARRIER_SOURCE_DIGEST,meterContract:{semantics:'all_native_input_and_all_generated_output_v1',nativeContextTokens:4096,completionTokens:128,promptUsdPerMillion:3,completionUsdPerMillion:15,nativeContractDigest:'e'.repeat(64),endpointRevisionDigest:'f'.repeat(64),documentationDigest:'1'.repeat(64)},invariants:Object.fromEntries(FIXED_METERED_INVARIANTS.map(k=>[k,true]))});
  proof=issueReviewedMeteredProof(profile,cfg,req);envelope=currentReviewedMeteredEnvelope(cfg,req,proof);
 }
 const binding={tenantId:'00000000-0000-0000-0000-000000000001',userId:'00000000-0000-0000-0000-000000000002',runId:'00000000-0000-0000-0000-000000000003',rootTaskId:'00000000-0000-0000-0000-000000000004',requestDigest:envelope.requestDigest,capabilityDigest:envelope.capabilityDigest,configurationDigest:aiSpendConfigurationDigest(cfg)},scope=createAiSpendReceiptScope(binding);
 const terminal=JSON.stringify({id:'gen-composed',model:cfg.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'Synthetic answer'}}]}).replace(/}$/,',"usage":{"cost":'+cost+'}}');
 const metadata='{"data":{"id":'+JSON.stringify(metadataId)+',"model":'+JSON.stringify(cfg.model)+',"is_byok":false,"streamed":false,"total_cost":'+cost+'}}';
 const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(response(terminal)).mockResolvedValueOnce(response(metadata));
 const consume=()=>scope.run(()=>createOpenRouterTransport(fetcher,req.operation)({model:cfg.model,apiKey:cfg.apiKey,routing:options.routing},args));
 const result=kind==='free'?await withReviewedFreeDispatch(proof,cfg,req,consume):await withReviewedMeteredDispatch(proof,cfg,req,consume);
 return{cfg,binding,envelope,result,fetcher,receipt:scope.receipt()};
}
describe('reviewed carrier and authenticated monetary receipt composition',()=>{
 it('retains the full metered reservation and binds authentic terminal cost to the same run/root/configuration',async()=>{
  const f=await composed('metered','0.001');expect(f.envelope.reservedNanos).toBe('14208000');expect(f.result.completion.text).toBe('Synthetic answer');expect(f.receipt).not.toBeNull();
  const receipt=f.receipt!;expect(receipt.signature).toBe(createHmac('sha256',Buffer.from(secret,'hex')).update(receipt.payload).digest('hex'));const payload=JSON.parse(receipt.payload);
  expect(payload.slice(1,8)).toEqual(Object.values(f.binding));expect(payload.slice(8,11)).toEqual(['gen-composed','1000000',keyId]);expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body)).provider.max_price).toEqual({prompt:3,completion:15,request:0});expect(f.fetcher.mock.calls[1][1]?.headers).toEqual({Authorization:'Bearer '+f.cfg.apiKey});expect(receipt.payload).not.toContain(f.cfg.apiKey);expect(receipt.payload).not.toContain('No HR data');
 });
 it('preserves a positive sub-nano free-route charge instead of turning enforced zero-price intent into zero evidence',async()=>{
  const f=await composed('free','0.0000000001');expect(f.envelope.reservedNanos).toBe('1');expect(f.receipt).not.toBeNull();const payload=JSON.parse(f.receipt!.payload);expect(payload[9]).toBe('1');expect(exactUsdDecimalNanos(payload[11])).toBe('1');expect(payload[11]).not.toBe('0');expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body)).provider.max_price).toEqual({prompt:0,completion:0,request:0});
  // The private SQL confirmer owns breach/pause. This pure case proves the nonzero exact
  // evidence survives the real zero-price carrier and cannot masquerade as a zero receipt.
 });
 it('keeps the receipt unknown when metered metadata belongs to a different generation, despite valid completion',async()=>{
  const f=await composed('metered','0.001','gen-other');expect(f.result.completion.text).toBe('Synthetic answer');expect(f.envelope.reservedNanos).toBe('14208000');expect(f.receipt).toBeNull();expect(f.fetcher).toHaveBeenCalledTimes(2);
 });
});
