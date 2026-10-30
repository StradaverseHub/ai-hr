/** Authored UNRUN. Actual askAssistant→prepared disclosure→gateway/root→OpenRouter adapter/transport.
 * Only HTTP is mocked. All keys, rates and private release-owned contracts below are FICTIONAL;
 * candidate activation uses the explicit synthetic transport fixture. No live route is certified. */
import {createHash,randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import * as schema from '../db/schema';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {askAssistant} from '../core/assistant';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {isModuleEnabled} from '../core/entitlements';
import {saveAiProviderConfig,setActiveProvider,resolveActiveAiConfig} from '../core/ai-config';
import {aiSpendConfigurationDigest} from '../lib/ai/spend-receipt';
import {readOpenRouterOptions} from '../lib/ai/providers/openrouter-configuration';
import {FIXED_FREE_CARRIER_SOURCE_DIGEST,FIXED_FREE_INVARIANTS} from '../lib/ai/providers/openrouter-fixed-free-carrier';
import {FIXED_METERED_CARRIER_SOURCE_DIGEST,FIXED_METERED_INVARIANTS} from '../lib/ai/providers/openrouter-fixed-metered-carrier';
import {openrouterAdapter,createOpenRouterAdapter} from '../lib/ai/providers/openrouter';
import {evaluateSyntheticCandidate} from './provider-evaluation-fixture';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';
let base:Base,admin:SessionContext,ctx:SessionContext,employmentId:string;
const endpoint='fictional/exact-endpoint',key='fictional-loop-key',signer='fictional-loop-signer',secret='ab'.repeat(32);
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
beforeEach(async()=>{
 await resetDb();base=await seedBase();await setModule(base.tenantId,'assistant','active');admin={...await entitledCtx(base),grants:[{role:'hr_admin',companyId:null}]};
 // Leave is a CORE module (packs/catalog.ts isCore): always enabled, and the database refuses any tenant_module row
 // for it. Assert the canonical tool's module is genuinely on rather than writing a row that cannot exist.
 expect(isModuleEnabled(admin,'leave'),'core Leave module must be enabled for the canonical tool round trip').toBe(true);
 const employee=await hireEmployee(admin,{person:{fullName:'Fictional Reviewed Loop',primaryEmail:`${randomUUID()}@fixture.test`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});employmentId=employee.employmentId;
 await seedEntitlement(admin,{leaveTypeId:base.annualLeaveTypeId,annualDays:113.75,validFrom:'2020-01-01'});await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId,leaveTypeId:base.annualLeaveTypeId,entryType:'accrual',days:'113.75',effectiveOn:todayInKualaLumpur()});
 const userId=await createAppUser(base.tenantId,employee.personId,'employee');await grantAssistant(admin,{appUserId:userId});ctx={...await entitledCtx(base,['employee']),userId,personId:employee.personId,grants:[{role:'employee',companyId:null}]};
 vi.stubEnv('AI_CONFIG_SECRET','fictional-reviewed-loop-custody');for(const name of ['OPENAI_API_KEY','ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY','AI_SPEND_RECEIPT_KEY_ID','AI_SPEND_RECEIPT_SIGNING_KEY'])vi.stubEnv(name,'');
});
async function setup(kind:'free'|'metered'){
 const model=kind==='free'?'fictional/assistant:free':'fictional/assistant-metered',options=readOpenRouterOptions({version:1,routing:{allowedProviders:[endpoint],allowFallbacks:false,sort:'latency'}});
 await saveAiProviderConfig(admin,{provider:'openrouter',model,apiKey:key,providerOptions:options});const evaluation=await evaluateSyntheticCandidate(admin);await setActiveProvider(admin,{provider:'openrouter',evaluationReceipt:evaluation.receipt});
 const cfg=await withTenant(ctx,tx=>resolveActiveAiConfig(tx,ctx,'hr_assistant'));if(!cfg)throw Error('Expected actual active fictional candidate');
 const configurationDigest=aiSpendConfigurationDigest(cfg),capability=createHash('sha256').update(randomUUID()).digest('hex'),source=kind==='free'?FIXED_FREE_CARRIER_SOURCE_DIGEST:FIXED_METERED_CARRIER_SOURCE_DIGEST,reserved=kind==='free'?'1':'129024000';
 // Explicit owner-only fictional provisioning, never a consent/read-only helper or real record.
 await owner.db.execute(sql`insert into app.ai_spend_capability(digest,provider,model,operation,max_request_nanos,source_digest,verified_at,expires_at,semantics) values(${capability},'openrouter',${model},'conversation',${reserved}::bigint,${source},now()-interval '1 minute',now()+interval '1 hour','complete_inference_usd_ceiling_v1')`);
 const invariants=JSON.stringify(Object.fromEntries((kind==='free'?FIXED_FREE_INVARIANTS:FIXED_METERED_INVARIANTS).map(name=>[name,true])));
 if(kind==='free')await owner.db.execute(sql`insert into app.ai_spend_reviewed_carrier_catalog(capability_digest,tenant_id,carrier,configuration_digest,model,operation,endpoint_slug,source_digest,workspace_control_digest,review_evidence_digest,independent_evidence_digest,invariants,reviewed_at,expires_at) values(${capability},${base.tenantId}::uuid,'openrouter_fixed_free_text_v1',${configurationDigest},${model},'conversation',${endpoint},${source},${'b'.repeat(64)},${'c'.repeat(64)},${'d'.repeat(64)},${invariants}::jsonb,now()-interval '1 minute',now()+interval '1 hour')`);
 else await owner.db.execute(sql`insert into app.ai_spend_reviewed_metered_carrier_catalog(capability_digest,tenant_id,carrier,configuration_digest,model,operation,endpoint_slug,native_context_tokens,completion_tokens,prompt_usd_per_million,completion_usd_per_million,native_contract_digest,endpoint_revision_digest,documentation_digest,source_digest,workspace_control_digest,review_evidence_digest,independent_evidence_digest,invariants,reviewed_at,expires_at) values(${capability},${base.tenantId}::uuid,'openrouter_fixed_metered_text_v1',${configurationDigest},${model},'conversation',${endpoint},32768,2048,3,15,${'e'.repeat(64)},${'f'.repeat(64)},${'1'.repeat(64)},${source},${'b'.repeat(64)},${'c'.repeat(64)},${'d'.repeat(64)},${invariants}::jsonb,now()-interval '1 minute',now()+interval '1 hour')`);
 vi.stubEnv('AI_SPEND_RECEIPT_KEY_ID',signer);vi.stubEnv('AI_SPEND_RECEIPT_SIGNING_KEY',secret);await owner.db.execute(sql`insert into app.ai_spend_receipt_verifier(key_id,secret,valid_from) values(${signer},decode(${secret},'hex'),now()-interval '1 minute') on conflict(key_id) do update set secret=excluded.secret,enabled=true,valid_from=excluded.valid_from,retired_at=null`);
 return{model,capability,reserved};
}
describe('actual reviewed OpenRouter Assistant loop',()=>{
 it.each(['free','metered'] as const)('%s omits cache BEFORE immutable preparation and keeps one real task root through a local canonical read and private selector request',async kind=>{
  const fixture=await setup(kind),cost=kind==='free'?0:0.000018;let posts=0;const bodies:Record<string,unknown>[]=[];
  const fetcher=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{
   if(init?.method==='POST'){posts++;const body=JSON.parse(String(init.body));bodies.push(body);const user=(body.messages as {role:string;content:string}[]).find(message=>message.role==='user');expect(user).toBeTruthy();const catalogue=JSON.parse(user!.content),read=catalogue.reads[0],card=read.cards.find((card:{facts:{field:string;available:boolean}[]})=>card.facts.some(fact=>fact.field==='available'&&fact.available)),fact=card.facts.find((fact:{field:string;available:boolean})=>fact.field==='available'&&fact.available);expect(fact).toBeTruthy();return new Response(JSON.stringify({id:`gen-reviewed-loop-${posts}`,model:fixture.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({version:1,mode:'answer',blocks:[{kind:'fact',read:read.read,card:card.card,fact:fact.fact}]})}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost}}),{headers:{'content-type':'application/json'}});}
   return new Response(JSON.stringify({data:{id:`gen-reviewed-loop-${posts}`,model:fixture.model,is_byok:false,streamed:false,total_cost:cost}}),{headers:{'content-type':'application/json'}});
  });
  const adapter=createOpenRouterAdapter(fetcher);vi.spyOn(openrouterAdapter,'converse').mockImplementation((configuration,args)=>adapter.converse!(configuration,args));
  const result=await askAssistant(ctx,{question:'My leave balance'});expect(result).toMatchObject({stop:'end',turns:1,toolsUsed:['my_leave_balances']});expect(posts).toBe(1);expect(fetcher).toHaveBeenCalledTimes(2);
  for(const body of bodies){expect(body).not.toHaveProperty('cacheKey');expect(body).not.toHaveProperty('cache_control');expect(body.provider).toMatchObject({only:[endpoint],order:[endpoint],allow_fallbacks:false,zdr:true,data_collection:'deny',max_price:{prompt:kind==='free'?0:3,completion:kind==='free'?0:15,request:0}});}
  expect((bodies[0].messages as {role:string}[]).some(message=>message.role==='tool')).toBe(false);for(const secret of [employmentId,'113.75','Annual Leave','Fictional Reviewed Loop','My leave balance','providerState'])expect(JSON.stringify(bodies)).not.toContain(secret);
  const tasks=await owner.db.execute<{id:string;source_kind:string}>(sql`select id,source_kind from app.ai_spend_task where tenant_id=${base.tenantId}::uuid and created_by=${ctx.userId}::uuid and source_kind='assistant_question'`);expect(tasks).toHaveLength(1);
  const runs=await owner.db.execute<{root:string;state:string;reserved:string;actual:string}>(sql`select root_id::text as root,state,reserved_nanos::text as reserved,confirmed_nanos::text as actual from app.ai_spend_reservation where tenant_id=${base.tenantId}::uuid and capability_digest=${fixture.capability} order by run_id`);expect(runs).toHaveLength(1);expect(new Set(runs.map(row=>row.root))).toEqual(new Set([tasks[0].id]));for(const row of runs)expect(row).toMatchObject({state:'confirmed',reserved:fixture.reserved,actual:kind==='free'?'0':'18000'});
 });
});
