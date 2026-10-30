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

/** Authored UNRUN. Requires coordinated optional-USD draft installation; never apply schema inline.
 * Real app-role config/principal/native-root/admission/usage/controls; ONLY HTTP is mocked except
 * the one explicitly fictional existing finite-price fixture used to verify zero allocation.
 * No provider, certificate or model quality/activation claim is established by fixture responses.
 */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {saveAiProviderConfig,resolveActiveAiConfig,setActiveProvider} from '../core/ai-config';
import {acceptBaselineFixture,activateDirectProviderFixture} from './ai-provider-change-fixture';
import {bindStrictAiSpendRoot} from '../core/ai-governance';
import {AI_SPEND_CONTROL_REFUSALS} from '../core/ai-spend-capability';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {setAiSpendBudget,aiSpendStatusTx} from '../core/ai-spend-management';
import {setAiAllowance,setAiFeature} from '../core/ai-management';
import {evaluateProviderCandidate} from '../core/ai-provider-readiness';
import {generateDraft} from '../lib/ai';
import type {AiProvider,ResolvedAiConfig} from '../lib/ai/types';
import {readOpenRouterOptions} from '../lib/ai/providers/openrouter-configuration';
import {syntheticConsentFor} from './provider-evaluation-fixture';
import {installSyntheticSpendCapability} from './ai-spend-fixture';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,a:SessionContext,restorePrice:(()=>void)|undefined;
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>{restorePrice?.();restorePrice=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');a={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};await grantAssistant(a,{appUserId:b.adminUserId});vi.stubEnv('AI_CONFIG_SECRET','fictional-optional-usd-key');for(const key of['OPENAI_API_KEY','ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY','AI_SPEND_RECEIPT_KEY_ID','AI_SPEND_RECEIPT_SIGNING_KEY'])vi.stubEnv(key,'');});
const args={system:'Fictional no-HR admission fixture.',prompt:'Return fictional.',maxTokens:8};
const modeRows=()=>owner.db.execute<{run_id:string;root_id:string|null;money_mode:string;company_ids:string[];feature_id:string}>(sql`select run_id,root_id,money_mode,company_ids,feature_id from app.ai_spend_admission_scope where tenant_id=${b.tenantId}::uuid order by created_at,run_id`);
const runRows=()=>owner.db.select().from(s.aiModelRun);
const holds=()=>owner.db.execute(sql`select * from app.ai_spend_reservation where tenant_id=${b.tenantId}::uuid`);
function http(){let sequence=0;vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url),method=init?.method??(input instanceof Request?input.method:'GET');
 if(method!=='POST')throw Error('Unexpected fictional HTTP method');
 let body:unknown;
 if(url.hostname==='api.openai.com'&&url.pathname==='/v1/chat/completions')body={id:'chatcmpl-fictional',object:'chat.completion',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'fictional'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};
 else if(url.hostname==='api.anthropic.com'&&url.pathname==='/v1/messages')body={id:'msg_fictional',type:'message',role:'assistant',model:'fictional-model',content:[{type:'text',text:'fictional'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:1,output_tokens:1}};
 else if(url.hostname==='generativelanguage.googleapis.com'&&url.pathname.includes(':generateContent'))body={candidates:[{index:0,finishReason:'STOP',content:{role:'model',parts:[{text:'fictional'}]}}],usageMetadata:{promptTokenCount:1,candidatesTokenCount:1,totalTokenCount:2}};
 else if(url.href==='https://openrouter.ai/api/v1/chat/completions'){
  const text=typeof init?.body==='string'?init.body:input instanceof Request?await input.text():'';const request=JSON.parse(text),marker=text.match(/eval_[a-f0-9-]+/)?.[0];if(!marker)throw Error('Missing real protocol fixture marker');
  const call=request.tools?.length&&request.messages.at(-1)?.role!=='tool';body={id:'gen-fictional-'+(++sequence),model:request.model,choices:[{index:0,finish_reason:call?'tool_calls':'stop',message:{role:'assistant',content:call?null:marker,...(call?{tool_calls:[{id:'call-fictional',type:'function',function:{name:'integration_echo',arguments:JSON.stringify({marker})}}]}:{})}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:0}};
 }else throw Error('Unexpected fictional HTTP destination');
 return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
 }));}
// This is the ACTUAL native issuer used by bindAiSpendTaskTx, not an owner INSERT or posted UUID.
async function configured(provider:Exclude<AiProvider,'openrouter'>='openai',feature:'hr_assistant'|'pay_rule_draft'='hr_assistant',native=true){
 await activateDirectProviderFixture(a,{provider,model:'fictional-model',apiKey:'fictional-'+randomUUID()});
 return withTenant(a,async tx=>{const cfg=await resolveActiveAiConfig(tx,a,feature);if(!cfg)throw Error('Missing actual issued fixture config');if(!native)return{cfg,root:null};
  const[row]=await tx.execute<{root:string}>(sql`select app.ai_spend_task_issue('hr_assistant','assistant_question',null::uuid,'question') as root`);
  return{cfg:bindStrictAiSpendRoot(cfg,{rootTaskId:row.root,kind:'agent'}),root:row.root};
 });
}
const call=(cfg:ResolvedAiConfig)=>generateDraft(cfg,args);
// Drizzle wraps the database error as 'Failed query: ...'; the RAISE itself is the cause (SQLSTATE P0001).
const raised=(message:string)=>({cause:expect.objectContaining({code:'P0001',message})});
async function policy(root:string|null,feature='hr_assistant'){return withTenant(a,tx=>tx.execute<{monetary_required:boolean;company_ids:string[]}>(sql`select * from app.ai_spend_policy_context(${feature},${root}::uuid,${root?'agent':null})`));}

describe('actual optional USD policy with mandatory nonmoney controls',()=>{
 it.each(['openai','anthropic','google'] as const)('ordinary %s BYOK uses real admission/root/settlement with no configured USD cap and no certificate',async provider=>{
  http();const fetcher=vi.mocked(fetch),{cfg,root}=await configured(provider);expect(await call(cfg)).toBe('fictional');expect(fetcher).toHaveBeenCalledOnce();
  expect(await modeRows()).toMatchObject([{root_id:root,money_mode:'uncapped',feature_id:'hr_assistant'}]);expect(await holds()).toEqual([]);
  expect(await runRows()).toMatchObject([{state:'completed',actualTokens:2}]);expect(await withTenant(a,tx=>aiSpendStatusTx(tx,a))).toMatchObject({budgets:[],unpricedUnknownRuns:1,confirmedNanos:null});
 });
 it.each(['tenant','company','user','feature'] as const)('any finite %s ancestor remains strict, even with the other dimension blank and value zero',async kind=>{
  http();const {cfg}=await configured();await setAiSpendBudget(a,{kind,subjectId:kind==='company'?b.companyId:kind==='user'?b.adminUserId:null,featureId:kind==='feature'?'hr_assistant':null,monthlyUsd:'0',rootUsd:''});
  await expect(call(cfg)).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();expect(await runRows()).toEqual([]);expect(await modeRows()).toEqual([]);
  const status=await withTenant(a,tx=>aiSpendStatusTx(tx,a));expect(status?.budgets).toMatchObject([{monthlyNanos:'0',rootNanos:null}]);
 });
 it('zero remains an enforced stop even when an explicitly fictional exact price capability exists',async()=>{
  http();const {cfg}=await configured(),price=await installSyntheticSpendCapability(a,{provider:'openai',model:cfg.model});restorePrice=price.restore;
  await setAiSpendBudget(a,{kind:'tenant',monthlyUsd:'',rootUsd:'0'});await expect(call(cfg)).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();expect(await holds()).toEqual([]);expect(await runRows()).toEqual([]);
 });
 it('clears only the explicitly selected blank USD scope and preserves every other finite value and audit',async()=>{
  await setAiSpendBudget(a,{kind:'company',subjectId:b.companyId,monthlyUsd:'0',rootUsd:'1.000000001'});await setAiSpendBudget(a,{kind:'tenant',monthlyUsd:'2',rootUsd:''});
  await setAiSpendBudget(a,{kind:'tenant',monthlyUsd:'',rootUsd:' '});const status=await withTenant(a,tx=>aiSpendStatusTx(tx,a));expect(status?.budgets).toMatchObject([{scopeKey:'company:'+b.companyId,monthlyNanos:'0',rootNanos:'1000000001'}]);
  const events=await owner.db.execute<{payload:{cleared:boolean;monthlyNanos:string|null;rootNanos:string|null}}>(sql`select payload from domain_event where tenant_id=${b.tenantId}::uuid and event_type='ai-control.spend-allocation-changed' order by occurred_at,id`);expect(events.some(row=>row.payload.cleared&&row.payload.monthlyNanos===null&&row.payload.rootNanos===null)).toBe(true);
 });
 it('includes every actually visible company, not only the first company, in monetary policy',async()=>{
  http();const[second]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional second company'}).returning();const{cfg,root}=await configured();
  const before=await policy(root);expect(before[0].company_ids).toEqual(expect.arrayContaining([b.companyId,second.id]));await setAiSpendBudget(a,{kind:'company',subjectId:second.id,monthlyUsd:'',rootUsd:'0'});
  await expect(call(cfg)).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
 });
 it('preserves mandatory native roots and refuses foreign/random/old run association even without monetary caps',async()=>{
  http();const{cfg,root}=await configured();const other=await seedBase(),foreign={...await entitledCtx(other,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};
  await expect(policy(randomUUID())).rejects.toThrow();await expect(withTenant(foreign,tx=>tx.execute(sql`select * from app.ai_spend_policy_context('hr_assistant',${root}::uuid,'agent')`))).rejects.toThrow();
  await expect(policy(null)).rejects.toThrow();expect(await call(cfg)).toBe('fictional');const [run]=await modeRows();
  await expect(withTenant(a,tx=>tx.execute(sql`select app.ai_spend_record_admission(${run.run_id}::uuid,${root}::uuid,'agent',${'a'.repeat(64)},${'b'.repeat(64)})`))).rejects.toThrow();
  await expect(withTenant(a,tx=>tx.execute(sql`select * from app.ai_spend_admission_scope`))).rejects.toThrow();
 });
 it('unknown uncapped history blocks later applicable monthly and same-task limits, without TTL or guessed zero',async()=>{
  http();const{cfg,root}=await configured();await call(cfg);await owner.db.execute(sql`update ai_model_run set started_at='2020-01-01' where tenant_id=${b.tenantId}::uuid`);
  await setAiSpendBudget(a,{kind:'tenant',monthlyUsd:'100',rootUsd:''});await expect(policy(root)).rejects.toMatchObject(raised('Unpriced AI history requires monetary review'));
  await setAiSpendBudget(a,{kind:'tenant',monthlyUsd:'',rootUsd:'100'});await expect(policy(root)).rejects.toMatchObject(raised('Unpriced AI task history requires monetary review'));
  const next=await withTenant(a,tx=>tx.execute<{root:string}>(sql`select app.ai_spend_task_issue('hr_assistant','assistant_question',null::uuid,'question') as root`));expect(await policy(next[0].root)).toMatchObject([{monetary_required:true}]);
  expect(fetch).toHaveBeenCalledOnce();expect(await holds()).toEqual([]);expect(await modeRows()).toMatchObject([{root_id:root,money_mode:'uncapped'}]);
 });
 it('retains unknown monetary debt when model-run pruning is attempted instead of freeing financial capacity',async()=>{
  http();const{cfg,root}=await configured();await call(cfg);const[run]=await modeRows();
  await expect(owner.db.execute(sql`delete from ai_model_run where id=${run.run_id}::uuid`)).rejects.toThrow();
  expect(await modeRows()).toMatchObject([{run_id:run.run_id,root_id:root,money_mode:'uncapped'}]);
  await setAiSpendBudget(a,{kind:'tenant',monthlyUsd:'1',rootUsd:''});await expect(policy(root)).rejects.toMatchObject(raised('Unpriced AI history requires monetary review'));
  expect(fetch).toHaveBeenCalledOnce();expect(await holds()).toEqual([]);
 });
 it('historical unassociated nonblocked admissions cannot disappear from a new monetary cutoff',async()=>{
  const{root}=await configured();await withTenant(a,tx=>tx.execute(sql`select * from app.ai_admit('pay_rule_draft','draft','openai','fictional-model',8)`));
  await setAiSpendBudget(a,{kind:'tenant',monthlyUsd:'1',rootUsd:''});await expect(policy(root)).rejects.toMatchObject(raised('Unpriced AI history requires monetary review'));
  await setAiSpendBudget(a,{kind:'tenant',monthlyUsd:'',rootUsd:'1'});await expect(policy(root)).rejects.toMatchObject(raised('Unpriced AI task history requires monetary review'));
 });
 it('legacy rootless features stay ordinary only with no applicable USD cap, while their real usage is retained',async()=>{
  http();const{cfg}=await configured('openai','pay_rule_draft',false);await call(cfg);expect(await modeRows()).toMatchObject([{root_id:null,money_mode:'uncapped',feature_id:'pay_rule_draft'}]);
  await setAiSpendBudget(a,{kind:'user',subjectId:b.adminUserId,monthlyUsd:'',rootUsd:'5'});await expect(call(cfg)).rejects.toThrow();expect(fetch).toHaveBeenCalledOnce();
 });
 it.each(['daily','tokens','concurrency','pause','grant'] as const)('no-money mode still enforces actual %s authority/control before transport',async kind=>{
  http();const{cfg}=await configured();
  if(kind==='grant')await revokeAssistant(a,{appUserId:b.adminUserId});else if(kind==='pause')await setAiFeature(a,'hr_assistant',false);else await setAiAllowance(a,{kind:'user',subjectId:b.adminUserId,enabled:true,dailyRequests:kind==='daily'?0:null,monthlyTokens:kind==='tokens'?0:null,maxConcurrent:kind==='concurrency'?0:null});
  await expect(call(cfg)).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();expect(await modeRows()).toEqual([]);
 });
 it('real transport deadline still cancels an uncapped provider call without zeroing unknown usage/cost',async()=>{
  const{cfg}=await configured();const fetcher=vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{const abort=()=>reject(new DOMException('Fictional abort','AbortError'));if(init?.signal?.aborted)abort();else init?.signal?.addEventListener('abort',abort,{once:true});}));vi.stubGlobal('fetch',fetcher);
  await expect(generateDraft(cfg,{...args,timeoutMs:5})).rejects.toThrow();expect(fetcher).toHaveBeenCalledOnce();expect(await modeRows()).toMatchObject([{money_mode:'uncapped'}]);expect(await runRows()).toMatchObject([{state:'failed',actualTokens:null}]);
 });
 it('holds the actual ai-control interval through admission against a competing finite-budget writer',async()=>{
  const{root}=await configured();let ready!:()=>void,release!:()=>void,fail!:(error:unknown)=>void;const started=new Promise<void>((yes,no)=>{ready=yes;fail=no;}),done=new Promise<void>(yes=>{release=yes;});
  const watchdog=setTimeout(()=>{fail(Error('Owned optional-policy handshake timed out'));release();},10000);
  const holder=withTenant(a,async tx=>{expect(await tx.execute<{monetary_required:boolean}>(sql`select * from app.ai_spend_policy_context('hr_assistant',${root}::uuid,'agent')`)).toMatchObject([{monetary_required:false}]);ready();await done;
   const[r]=await tx.execute<{run_id:string}>(sql`select * from app.ai_admit('hr_assistant','draft','openai','fictional-model',8)`);await tx.execute(sql`select app.ai_spend_record_admission(${r.run_id}::uuid,${root}::uuid,'agent',${'a'.repeat(64)},${'b'.repeat(64)})`);});void holder.catch(fail);
  let writer:Promise<void>|undefined,writerError:unknown;
  try{await started;writer=setAiSpendBudget(a,{kind:'tenant',monthlyUsd:'1',rootUsd:''});void writer.catch(error=>{writerError=error;});let waiting=false;const deadline=Date.now()+2000;
   while(Date.now()<deadline){if(writerError)throw writerError;const[row]=await owner.db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_locks l where l.locktype='advisory' and not l.granted and l.objsubid=2 and l.database=(select oid from pg_database where datname=current_database()) and l.classid=((hashtext('ai-control')::bigint & 4294967295)::oid) and l.objid=((hashtext(${b.tenantId})::bigint & 4294967295)::oid)) as waiting`);if(row.waiting){waiting=true;break;}await new Promise(yes=>setTimeout(yes,20));}
   expect(waiting,'actual competing budget writer must wait, not race the no-cap decision').toBe(true);
  }finally{release();clearTimeout(watchdog);await holder;if(writer)await writer;}
  await expect(policy(root)).rejects.toMatchObject(raised('Unpriced AI history requires monetary review'));expect(await modeRows()).toMatchObject([{root_id:root,money_mode:'uncapped'}]);
 });
 it('restores the caller statement and lock timeouts after the issue, policy and admission-record owners return',async()=>{
  await configured();
  const settings=await withTenant(a,async tx=>{
   await tx.execute(sql`set local statement_timeout='30s'`);await tx.execute(sql`set local lock_timeout='10s'`);
   const[issued]=await tx.execute<{root:string}>(sql`select app.ai_spend_task_issue('hr_assistant','assistant_question',null::uuid,'question') as root`);
   expect(await tx.execute<{monetary_required:boolean}>(sql`select * from app.ai_spend_policy_context('hr_assistant',${issued.root}::uuid,'agent')`)).toMatchObject([{monetary_required:false}]);
   const[r]=await tx.execute<{run_id:string}>(sql`select * from app.ai_admit('hr_assistant','draft','openai','fictional-model',8)`);
   await tx.execute(sql`select app.ai_spend_record_admission(${r.run_id}::uuid,${issued.root}::uuid,'agent',${'a'.repeat(64)},${'b'.repeat(64)})`);
   return tx.execute<{name:string;setting:string}>(sql`select name,setting from pg_catalog.pg_settings where name in ('lock_timeout','statement_timeout') order by name`);
  });
  // Without the restore these read 500/5000: the owners' bounds would govern the rest of the caller's transaction.
  expect(settings.map(row=>({name:row.name,setting:Number(row.setting)}))).toEqual([{name:'lock_timeout',setting:10000},{name:'statement_timeout',setting:30000}]);
 });
 it('types exactly the spend-control RAISE texts the migrations emit, so a renamed refusal cannot silently fall through',()=>{
  const source=['0651_ai_spend_controls','0654_ai_optional_usd_policy'].map(name=>readFileSync(`db/migrations/${name}.sql`,'utf8')).join('\n');expect(source.length).toBeGreaterThan(20000);
  for(const text of [...AI_SPEND_CONTROL_REFUSALS,'AI spend task paused'])expect(source.includes(`RAISE EXCEPTION '${text}'`),text).toBe(true);
 });
 it('completes real candidate readiness and explicit one-use activation with three mocked HTTP calls and no monetary certificate',async()=>{
  http();const options=readOpenRouterOptions({version:1,routing:{allowedProviders:['approved-a'],allowFallbacks:false,sort:'latency'}});await saveAiProviderConfig(a,{provider:'openrouter',model:'fictional/model',apiKey:'fictional-only-key',providerOptions:options});
  const receipt=await evaluateProviderCandidate(a,await syntheticConsentFor(a));expect(fetch).toHaveBeenCalledTimes(3);expect(receipt.summary.calls).toBe(3);
  const scopes=await modeRows();expect(scopes).toHaveLength(3);expect(scopes.every(row=>row.money_mode==='uncapped'&&row.feature_id==='provider_evaluation')).toBe(true);expect(new Set(scopes.map(row=>row.root_id)).size).toBe(1);expect(await holds()).toEqual([]);
  await acceptBaselineFixture(a,{kind:'openrouter_candidate'});await setActiveProvider(a,{provider:'openrouter',evaluationReceipt:receipt.receipt});expect(await withTenant(a,tx=>resolveActiveAiConfig(tx,a))).toMatchObject({provider:'openrouter',model:'fictional/model'});await expect(setActiveProvider(a,{provider:'openrouter',evaluationReceipt:receipt.receipt})).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(3);
 });
});
