/** Frozen-candidate diagnosis ONLY. Does not replace the 13 positive readiness failures.
 * Real guards/custody/private tasks, no review/admission/transport mocks or approval renewal. */
import {randomUUID} from 'node:crypto';
import {subscribe,unsubscribe} from 'node:diagnostics_channel';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant} from '../db/client';
import {saveAiProviderConfig} from '../core/ai-config';
import {resolveAiProviderCandidateSnapshotTx} from '../core/ai-provider-snapshot';
import {bindStrictAiSpendRoot,governedAiConfig,preparePrivateAiTask,withAiRunObserver} from '../core/ai-governance';
import {generateDraft,converse} from '../lib/ai';
import {PROVIDER_DATA_REVIEW_RECORDS,assertProviderDataContractReviewed} from '../lib/ai/provider-data-reviews';
import {PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST} from '../lib/ai/provider-data-source-manifest';
import {AiPrivacyGateError} from '../lib/ai/provider-privacy-error';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-disclosure-diagnostic-key');await resetDb();base=await seedBase();});
afterAll(async()=>{try{await closeAll();}finally{vi.unstubAllEnvs();}});
describe('ea98 synthetic readiness disclosure refusal diagnosis (not positive readiness)',()=>{
 it.each(['synthetic_protocol_echo_v1','synthetic_protocol_tools_v1']as const)('exposes actual %s unreviewed refusal before HTTP, admission, model run or readiness receipt',async contract=>{
  const review=PROVIDER_DATA_REVIEW_RECORDS.find(row=>row.contractId===contract)!;
  expect(review.status).toBe('approved');expect(review.sourceDigest).toBe('261d6298b853a76e91fbc494d64d14099cdbca115cafdd47932828daef8f463a');
  expect(PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST).toBe('e9e422d54fd2762d18b5289b8824a740410c44c8271627a7d28c7cf24c87cfd5');
  expect(()=>assertProviderDataContractReviewed(contract,PROVIDER_DATA_TRANSFORM_SOURCE_DIGEST)).toThrow(AiPrivacyGateError);
  const ctx=adminCtx(base);await saveAiProviderConfig(ctx,{provider:'openrouter',model:'fictional/model',apiKey:'fictional-key',providerOptions:{version:1,routing:{allowedProviders:['approved-a'],allowFallbacks:false,sort:'latency'}}});
  const snapshot=await withTenant(ctx,tx=>resolveAiProviderCandidateSnapshotTx(tx,ctx,'openrouter'));
  expect(snapshot.candidate?.id).toBeTruthy();
  let beforeCalls=0,httpRequests=0;
  const cfg=withAiRunObserver(bindStrictAiSpendRoot(governedAiConfig(ctx,snapshot,'provider_evaluation'),{rootTaskId:snapshot.candidate!.id,kind:'evaluation'}),{beforeCall(){beforeCalls++;}});
  const marker='eval_'+randomUUID(),source=contract==='synthetic_protocol_echo_v1'?{marker}:{marker,stage:'first',callId:null};
  const task=await preparePrivateAiTask(cfg,contract,async()=>source),onHttp=()=>{httpRequests++;};
  const facts=async()=>Array.from(await owner.client`select (select count(*)::int from public.ai_model_run where tenant_id=${base.tenantId}::uuid)as runs,(select count(*)::int from public.ai_provider_protocol_evaluation where tenant_id=${base.tenantId}::uuid)as receipts`);
  const before=await facts();expect(before).toEqual([{runs:0,receipts:0}]);
  subscribe('undici:request:create',onHttp);subscribe('http.client.request.start',onHttp);
  try{
   let refusal:unknown;try{if(task.operation==='draft')await generateDraft(task.configuration,task.args);else await converse(task.configuration,task.args);}catch(error){refusal=error;}
   expect(refusal).toBeInstanceOf(AiPrivacyGateError);expect(refusal).toMatchObject({reason:'unreviewed'});
   expect(beforeCalls).toBe(0);expect(httpRequests).toBe(0);expect(await facts()).toEqual(before);
  }finally{unsubscribe('undici:request:create',onHttp);unsubscribe('http.client.request.start',onHttp);task.dispose();}
 });
});
