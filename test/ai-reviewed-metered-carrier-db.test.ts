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

/** Authored UNRUN. FICTIONAL release-owned certificate/control records + mocked HTTP only.
 * Actual app-role resolver, root/admission and HMAC ledger run normally. No real route is certified,
 * no inline migration is applied, and no live key/provider/account is activated. */
import {createHash,randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {saveAiProviderConfig} from '../core/ai-config';
import {resolveAiProviderCandidateSnapshotTx} from '../core/ai-provider-snapshot';
import {aiSpendStatusTx} from '../core/ai-spend-management';
import {governedAiConfig,bindStrictAiSpendRoot} from '../core/ai-governance';
import {AiSpendControlError,resolveReviewedAiSpendCapabilityTx,withReviewedAiSpendDispatch} from '../core/ai-spend-capability';
import {aiSpendConfigurationDigest} from '../lib/ai/spend-receipt';
import {FIXED_METERED_CARRIER_SOURCE_DIGEST,FIXED_METERED_INVARIANTS} from '../lib/ai/providers/openrouter-fixed-metered-carrier';
import {openrouterAdapter,createOpenRouterAdapter} from '../lib/ai/providers/openrouter';
import {generateDraft} from '../lib/ai';
import {draftInputDigest} from '../lib/ai/draft-input';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let base:Base,ctx:SessionContext;
const model='fictional/reviewed-metered',key='fictional-controlled-key',endpoint='fictional/exact-endpoint',secret='ab'.repeat(32),signer='fictional-reviewed-signer';
const providerOptions={version:1 as const,routing:{allowedProviders:[endpoint],allowFallbacks:false,sort:'latency' as const}};
const meter={nativeContextTokens:4096,completionTokens:128,promptUsdPerMillion:3,completionUsdPerMillion:15},reserved='14208000';
const args={system:'Synthetic review only',prompt:'Synthetic fixed question',maxTokens:64,timeoutMs:1000};
const request=()=>Object.freeze({operation:'draft' as const,reservedTokens:100,inputDigest:draftInputDigest(args)});
beforeAll(async()=>{await migrateTestDb();const[installed]=await owner.db.execute<{ready:boolean}>(sql`select to_regprocedure('app.ai_spend_reviewed_metered_carrier(text,text,text,text,text,text,text)') is not null as ready`);expect(installed.ready,'Install the normally coordinated reviewed-carrier draft before this actual DB suite').toBe(true);});afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-reviewed-carrier-custody-secret');vi.stubEnv('AI_SPEND_RECEIPT_KEY_ID',signer);vi.stubEnv('AI_SPEND_RECEIPT_SIGNING_KEY',secret);for(const env of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(env,'');await resetDb();base=await seedBase();ctx={...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]};});
async function candidate(){await saveAiProviderConfig(ctx,{provider:'openrouter',model,apiKey:key,providerOptions});return withTenant(ctx,tx=>resolveAiProviderCandidateSnapshotTx(tx,ctx,'openrouter'));}
async function reviewed(input:{expired?:boolean;staleSource?:boolean}={}){
 const snapshot=await candidate(),configurationDigest=aiSpendConfigurationDigest(snapshot.configuration),capabilityDigest=createHash('sha256').update('FICTIONAL-TEST-ONLY:'+configurationDigest+randomUUID()).digest('hex');
 const sourceDigest=input.staleSource?'0'.repeat(64):FIXED_METERED_CARRIER_SOURCE_DIGEST,reviewedAt=new Date(Date.now()-(input.expired?7200000:60000)).toISOString(),expiresAt=new Date(Date.now()+(input.expired?-3600000:3600000)).toISOString();
 // Explicit privileged fixture setup. Neither consent nor a read-only/helper claim installs records.
 await owner.db.execute(sql`insert into app.ai_spend_receipt_verifier(key_id,secret,valid_from) values(${signer},decode(${secret},'hex'),now()-interval '1 minute') on conflict(key_id) do update set secret=excluded.secret,enabled=true,valid_from=excluded.valid_from,retired_at=null`);
 await owner.db.execute(sql`insert into app.ai_spend_capability(digest,provider,model,operation,max_request_nanos,source_digest,verified_at,expires_at,semantics) values(${capabilityDigest},'openrouter',${model},'draft',${reserved}::bigint,${sourceDigest},${reviewedAt}::timestamptz,${expiresAt}::timestamptz,'complete_inference_usd_ceiling_v1')`);
 const invariants=JSON.stringify(Object.fromEntries(FIXED_METERED_INVARIANTS.map(name=>[name,true])));
 await owner.db.execute(sql`insert into app.ai_spend_reviewed_metered_carrier_catalog(capability_digest,tenant_id,carrier,configuration_digest,model,operation,endpoint_slug,native_context_tokens,completion_tokens,prompt_usd_per_million,completion_usd_per_million,native_contract_digest,endpoint_revision_digest,documentation_digest,source_digest,workspace_control_digest,review_evidence_digest,independent_evidence_digest,invariants,reviewed_at,expires_at)
 values(${capabilityDigest},${base.tenantId}::uuid,'openrouter_fixed_metered_text_v1',${configurationDigest},${model},'draft',${endpoint},${meter.nativeContextTokens},${meter.completionTokens},${meter.promptUsdPerMillion},${meter.completionUsdPerMillion},${'e'.repeat(64)},${'f'.repeat(64)},${'1'.repeat(64)},${sourceDigest},${'b'.repeat(64)},${'c'.repeat(64)},${'d'.repeat(64)},${invariants}::jsonb,${reviewedAt}::timestamptz,${expiresAt}::timestamptz)`);
 await cap();
 return{snapshot,capabilityDigest,configurationDigest};
}
function transport(cost='0.001'){
 const fetcher=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>new Response(init?.method==='POST'?`{"id":"gen-reviewed-fixture","model":"${model}","choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","content":"Synthetic answer"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"cost":${cost}}}`:`{"data":{"id":"gen-reviewed-fixture","model":"${model}","is_byok":false,"streamed":false,"total_cost":${cost}}}`,{headers:{'content-type':'application/json'}}));
 const adapter=createOpenRouterAdapter(fetcher);vi.spyOn(openrouterAdapter,'generate').mockImplementation((configuration,input)=>adapter.generate(configuration,input));return fetcher;
}
/** Owner decision: a USD cap is OPTIONAL. Only a configured cap (any value, including0) needs this carrier;
 * with none, no USD ceiling is promised and there is no USD-based refusal (non-money controls still apply). */
async function cap(){await owner.db.execute(sql`insert into app.ai_spend_budget(tenant_id,scope_key,kind,monthly_nanos,root_nanos,updated_by) values(${base.tenantId}::uuid,'tenant','tenant',1000000000,1000000000,${ctx.userId}::uuid) on conflict(tenant_id,scope_key) do nothing`);}
async function configuration(snapshot:Awaited<ReturnType<typeof candidate>>){return bindStrictAiSpendRoot(governedAiConfig(ctx,snapshot,'provider_evaluation'),{rootTaskId:snapshot.candidate!.id,kind:'evaluation'});}
describe('conditional private complete metered monetary carrier',()=>{
 it('uses a complete private reviewed meter record, actual enforced caps and authentic paid HMAC reconciliation',async()=>{
  const f=await reviewed(),fetcher=transport(),cfg=await configuration(f.snapshot);expect(await generateDraft(cfg,args)).toBe('Synthetic answer');expect(fetcher).toHaveBeenCalledTimes(2);
  const body=JSON.parse(String(fetcher.mock.calls[0][1]?.body));expect(body.provider).toMatchObject({only:[endpoint],order:[endpoint],allow_fallbacks:false,max_price:{prompt:3,completion:15,request:0},zdr:true,data_collection:'deny'});
  const[row]=await owner.db.execute<{state:string;reserved:string;actual:string;generation:string}>(sql`select state,reserved_nanos::text as reserved,confirmed_nanos::text as actual,generation_id as generation from app.ai_spend_reservation where capability_digest=${f.capabilityDigest}`);expect(row).toEqual({state:'confirmed',reserved,actual:'1000000',generation:'gen-reviewed-fixture'});
 });
 it('keeps its allocation held when model-reported0 lacks authenticated matching terminal metadata',async()=>{
  const f=await reviewed(),fetcher=transport();fetcher.mockImplementation(async(_url,init)=>new Response(init?.method==='POST'?JSON.stringify({id:'gen-reviewed-fixture',model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'Synthetic answer'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:0}}):JSON.stringify({data:{id:'wrong-generation',model,is_byok:false,streamed:false,total_cost:0}}),{headers:{'content-type':'application/json'}}));
  expect(await generateDraft(await configuration(f.snapshot),args)).toBe('Synthetic answer');const[row]=await owner.db.execute<{state:string;actual:string|null}>(sql`select state,confirmed_nanos::text as actual from app.ai_spend_reservation where capability_digest=${f.capabilityDigest}`);expect(row).toEqual({state:'held',actual:null});expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('records an authentic charge above the full context/output allocation as breach and refuses further admission',async()=>{
  const f=await reviewed(),fetcher=transport('0.02'),cfg=await configuration(f.snapshot);await expect(generateDraft(cfg,args)).rejects.toThrow();
  const[row]=await owner.db.execute<{state:string;actual:string;generation:string}>(sql`select state,confirmed_nanos::text as actual,generation_id as generation from app.ai_spend_reservation where capability_digest=${f.capabilityDigest}`);expect(row).toEqual({state:'breach',actual:'20000000',generation:'gen-reviewed-fixture'});
  await expect(generateDraft(cfg,args)).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('charges each retry against the SAME persisted root and reserves full native limits rather than estimated prompt tokens',async()=>{
  const f=await reviewed(),fetcher=transport(),cfg=await configuration(f.snapshot);
  await owner.db.execute(sql`update app.ai_spend_budget set root_nanos=${(BigInt(reserved)+BigInt(1000000)-BigInt(1)).toString()}::bigint where tenant_id=${ctx.tenantId}::uuid and kind='tenant'`);
  await generateDraft(cfg,args);await expect(generateDraft(cfg,args)).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(2);
  const rows=await owner.db.execute<{root:string;reserved:string;actual:string;state:string}>(sql`select root_id::text as root,reserved_nanos::text as reserved,confirmed_nanos::text as actual,state from app.ai_spend_reservation where tenant_id=${ctx.tenantId}::uuid`);expect(rows).toEqual([{root:f.snapshot.candidate!.id,reserved,actual:'1000000',state:'confirmed'}]);
 });
 it('refuses missing complete input/reasoning contracts and output above the approved M without inference',async()=>{
  const f=await reviewed(),fetcher=transport();await expect(generateDraft(await configuration(f.snapshot),{...args,maxTokens:129})).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();const[held]=await owner.db.execute<{state:string;amount:string}>(sql`select state,reserved_nanos::text as amount from app.ai_spend_reservation where capability_digest=${f.capabilityDigest}`);expect(held).toEqual({state:'held',amount:reserved});
  // Owner-side record shapes are also constrained: independent release review cannot omit a dimension.
  for(const omitted of ['hardNativeContextAllInput','completionIncludesAllReasoning']){const other=createHash('sha256').update(randomUUID()).digest('hex');await owner.db.execute(sql`insert into app.ai_spend_capability select ${other},provider,model,operation,max_request_nanos,source_digest,verified_at,expires_at,revoked_at,semantics from app.ai_spend_capability where digest=${f.capabilityDigest}`);
  await expect(owner.db.execute(sql`insert into app.ai_spend_reviewed_metered_carrier_catalog select ${other},tenant_id,carrier,configuration_digest,model,operation,endpoint_slug,native_context_tokens,completion_tokens,prompt_usd_per_million,completion_usd_per_million,native_contract_digest,endpoint_revision_digest,documentation_digest,source_digest,workspace_control_digest,review_evidence_digest,independent_evidence_digest,invariants-${omitted},reviewed_at,expires_at,revoked_at from app.ai_spend_reviewed_metered_carrier_catalog where capability_digest=${f.capabilityDigest}`)).rejects.toThrow();}
 });
 it('refuses absent, revoked, changed key/options/source and unavailable signer evidence before dispatch; app principals cannot mint or inspect private records',async()=>{
  const missing=await candidate(),fetcher=transport();await cap();
  // A configured cap with no reviewed record cannot establish cost: it fails closed in admission, before transport.
  await expect(generateDraft(await configuration(missing),args)).rejects.toThrow('The current reviewed AI spend capability could not be confirmed.');expect(fetcher).not.toHaveBeenCalled();
  const f=await reviewed();await expect(withTenant(ctx,tx=>tx.execute(sql`select * from app.ai_spend_reviewed_metered_carrier_catalog`))).rejects.toThrow();await expect(withTenant(ctx,tx=>tx.execute(sql`insert into app.ai_spend_reviewed_metered_carrier_catalog select * from app.ai_spend_reviewed_metered_carrier_catalog`))).rejects.toThrow();
  for(const changed of [{...f.snapshot.configuration,apiKey:'other-key'},{...f.snapshot.configuration,providerOptions:{...providerOptions,routing:{...providerOptions.routing,allowedProviders:['other/endpoint']}}}])await expect(withTenant(ctx,tx=>resolveReviewedAiSpendCapabilityTx(tx,ctx,changed,request()))).rejects.toThrow();
  vi.stubEnv('AI_SPEND_RECEIPT_SIGNING_KEY','cd'.repeat(32));await expect(withTenant(ctx,tx=>resolveReviewedAiSpendCapabilityTx(tx,ctx,f.snapshot.configuration,request()))).rejects.toThrow();vi.stubEnv('AI_SPEND_RECEIPT_SIGNING_KEY',secret);
  await owner.db.execute(sql`update app.ai_spend_reviewed_metered_carrier_catalog set revoked_at=now() where capability_digest=${f.capabilityDigest}`);await expect(generateDraft(await configuration(f.snapshot),args)).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
 });
 it('with NO configured USD cap an absent reviewed metered carrier is no USD refusal: admitted uncapped under the same root, unknown cost kept unknown',async()=>{
  const missing=await candidate(),fetcher=transport();expect(await generateDraft(await configuration(missing),args)).toBe('Synthetic answer');
  // No carrier proof means no generation-metadata GET: exactly the one completion POST, and no reservation or zero receipt.
  expect(fetcher).toHaveBeenCalledOnce();expect(fetcher.mock.calls[0][1]?.method).toBe('POST');
  expect(await owner.db.execute(sql`select run_id from app.ai_spend_reservation where tenant_id=${base.tenantId}::uuid`)).toEqual([]);
  expect(await owner.db.execute<{root:string;money_mode:string}>(sql`select root_id::text as root,money_mode from app.ai_spend_admission_scope where tenant_id=${base.tenantId}::uuid`)).toEqual([{root:missing.candidate!.id,money_mode:'uncapped'}]);
  // The run stays unpriced debt: a later cap on this root refuses instead of treating it as zero.
  await cap();await expect(generateDraft(await configuration(missing),args)).rejects.toBeInstanceOf(AiSpendControlError);expect(fetcher).toHaveBeenCalledOnce();
  await expect(withTenant(ctx,tx=>tx.execute(sql`select * from app.ai_spend_policy_context('provider_evaluation',${missing.candidate!.id}::uuid,'evaluation')`))).rejects.toMatchObject({cause:expect.objectContaining({code:'P0001',message:'Unpriced AI history requires monetary review'})});
 });
 it.each(['expired','staleSource'] as const)('refuses actual private %s certification before network',async kind=>{const f=await reviewed({[kind]:true}),fetcher=transport();await expect(generateDraft(await configuration(f.snapshot),args)).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();});
 it('binds signer challenge to the actual app principal/tenant and keeps historical certificate identity immutable',async()=>{
  const f=await reviewed();await expect(withTenant(ctx,tx=>resolveReviewedAiSpendCapabilityTx(tx,{...ctx,userId:randomUUID()},f.snapshot.configuration,request()))).rejects.toThrow();
  const foreign=adminCtx(await seedBase());await expect(withTenant(foreign,tx=>resolveReviewedAiSpendCapabilityTx(tx,foreign,f.snapshot.configuration,request()))).rejects.toThrow();
  await expect(owner.db.execute(sql`update app.ai_spend_reviewed_metered_carrier_catalog set workspace_control_digest=${'e'.repeat(64)} where capability_digest=${f.capabilityDigest}`)).rejects.toThrow();await expect(owner.db.execute(sql`delete from app.ai_spend_reviewed_metered_carrier_catalog where capability_digest=${f.capabilityDigest}`)).rejects.toThrow();
 });
 it('shows tenant-owned reviewed metadata without asserting live capability or disclosing control evidence',async()=>{
  const f=await reviewed(),fetcher=transport();vi.stubEnv('AI_SPEND_RECEIPT_SIGNING_KEY','cd'.repeat(32));
  const status=await withTenant(ctx,tx=>aiSpendStatusTx(tx,ctx));expect(status).toMatchObject({reviewedCarrierRecords:1,liveCapability:'not_verified_here',certifiedLiveRoutes:0,confirmedNanos:null});
  // A currently installed review record is still not a signer, live availability or model capability proof.
  await expect(generateDraft(await configuration(f.snapshot),args)).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
  const serialized=JSON.stringify(status);for(const privateValue of [f.capabilityDigest,f.configurationDigest,model,key,endpoint,'b'.repeat(64),'c'.repeat(64),'d'.repeat(64)])expect(serialized).not.toContain(privateValue);
  const foreignBase=await seedBase(),foreign={...adminCtx(foreignBase),grants:[{role:'hr_admin',companyId:null}]};expect(await withTenant(foreign,tx=>aiSpendStatusTx(tx,foreign))).toMatchObject({reviewedCarrierRecords:0,liveCapability:'not_verified_here',budgets:[]});
  await owner.db.execute(sql`update app.ai_spend_reviewed_metered_carrier_catalog set revoked_at=now() where capability_digest=${f.capabilityDigest}`);expect(await withTenant(ctx,tx=>aiSpendStatusTx(tx,ctx))).toMatchObject({reviewedCarrierRecords:0,liveCapability:'not_verified_here'});
  await owner.db.execute(sql`update public.role_assignment set role='employee' where app_user_id=${ctx.userId}::uuid and tenant_id=${ctx.tenantId}::uuid`);
  const employee={...ctx,roles:['employee'],grants:[{role:'employee',companyId:null}]};expect(await withTenant(employee,tx=>aiSpendStatusTx(tx,employee))).toBeNull();await expect(withTenant(ctx,tx=>aiSpendStatusTx(tx,ctx))).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();
 });
 it('requires the actual resolver-issued envelope identity and same request/configuration, not a copied structural price claim',async()=>{
  const f=await reviewed(),req=request(),envelope=await withTenant(ctx,tx=>resolveReviewedAiSpendCapabilityTx(tx,ctx,f.snapshot.configuration,req));
  await expect(withReviewedAiSpendDispatch({...envelope},f.snapshot.configuration,req,async()=>undefined)).rejects.toThrow();await expect(withReviewedAiSpendDispatch(envelope,{...f.snapshot.configuration},req,async()=>undefined)).rejects.toThrow();await expect(withReviewedAiSpendDispatch(envelope,f.snapshot.configuration,{...req},async()=>undefined)).rejects.toThrow();
 });
});
