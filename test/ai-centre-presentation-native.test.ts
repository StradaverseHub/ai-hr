/** Disposable native projection proof only. Fictional data; no provider/admission/network execution. */
import {readFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import * as schema from '../db/schema';
import {workerDb} from './db-names';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {aiManagementPresentationView,aiManagementView,setAiAllowance,setGroupAllowance} from '../core/ai-management';
import {getAiConfigView,getAiConfigPresentationView,resolveActiveAiConfig,saveAiProviderConfig} from '../core/ai-config';
import {resolveAiProviderDisplayTx,resolveAiProviderSnapshotTx,assertAiProviderSnapshot} from '../core/ai-provider-snapshot';
import {governedAiConfig} from '../core/ai-governance';
import {assertAiPrincipalTx} from '../core/ai-principal';
import {providerCandidatesTx} from '../core/ai-provider-readiness';
import {setAiSpendBudget,aiSpendStatusTx} from '../core/ai-spend-management';
import {setTenantSetting} from '../core/tenant-settings';
import {hireEmployee} from '../core/org';
import {encryptSecret} from '../lib/ai/crypto';
import {pgSqlState} from '../lib/db-error';
import {defaultModelFor} from '../lib/ai/registry';
import {aiManagementView as readLockedManagement} from './fixtures/ai-management-locked-baseline';

const prototype=readFileSync('test/prototypes/ai-centre-presentation.sql','utf8');
const oldNames=['ai_provider_candidate_view_v1','ai_spend_status','ai_optional_spend_status','_ai_provider_evaluation_actor_valid'];
const added=['ai_provider_candidate_presentation_v1()','ai_optional_spend_presentation_status_v1()',
 '_ai_presentation_optional_spend_value(jsonb)','_ai_presentation_spend_value()','_ai_presentation_candidate_rows()','_ai_presentation_actor_valid()'];
type FunctionInfo={signature:string;definition:string;details:Record<string,unknown>};
let original:FunctionInfo[],created:FunctionInfo[]=[],installed=false,expectedDatabase='',base:Base,group:SessionContext;
let verifyNetwork=()=>{};
const ownedCapabilities=new Set<string>();
const context=(b:Base):SessionContext=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
const routes=()=>({version:1,routing:{allowedProviders:['approved-fictional'],allowFallbacks:false,sort:'price'}});
async function definitions(){return Array.from(await owner.client<FunctionInfo[]>`select p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid) as definition,to_jsonb(p) as details
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname=any(${oldNames}::text[]) order by p.proname`);}
async function addedDefinitions(reader:Pick<typeof owner.client,'unsafe'>){
 const signatures=added.map(signature=>"'app."+signature+"'").join(',');
 return Array.from(await reader.unsafe<FunctionInfo[]>(`select p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid)as definition,to_jsonb(p)as details from pg_proc p where p.oid=any(array[${signatures}]::regprocedure[]) order by p.proname`));
}
async function install(){created=await owner.client.begin(async tx=>{await tx`select set_config('aihr.ai_presentation_fixture.database',${expectedDatabase},true)`;await tx.unsafe(prototype);const rows=await addedDefinitions(tx);expect(rows).toHaveLength(6);return rows;});installed=true;}
async function restore(){
 if(!installed)return;
 expect(await addedDefinitions(owner.client)).toEqual(created); // Never drop a foreign/drifted definition.
 await owner.client.begin(async tx=>{for(const row of original)await tx.unsafe(row.definition);for(const signature of added)await tx.unsafe('drop function app.'+signature);});installed=false;
 expect(await definitions()).toEqual(original);
}
async function refuseRead(ctx:SessionContext){const before=await effects();await expect(aiManagementPresentationView(ctx)).rejects.toThrow();expect(await effects()).toEqual(before);}
async function effects(){
 const tables=['public.ai_provider_config','public.ai_provider_candidate','public.ai_provider_protocol_evaluation','public.ai_control_policy','public.ai_model_run','public.assistant_grant','public.domain_event',
  'app.ai_spend_budget','app.ai_spend_reservation','app.ai_spend_root','app.ai_spend_capability','app.ai_spend_admission_scope'];
 return Array.from(await owner.client.unsafe(tables.map(table=>`select '${table}' as name,count(*)::int as rows,md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb)::text) as digest from ${table} t`).join(' union all ')));
}
async function active(provider:'openai'|'openrouter'='openai',options:Record<string,unknown>={}){
 const [row]=await owner.db.insert(schema.aiProviderConfig).values({tenantId:base.tenantId,provider,model:provider==='openrouter'?'fictional/active':'fictional-active-model',
  providerOptions:options,apiKeyCiphertext:encryptSecret('fictional-active-key',base.tenantId),keyLast4:'-key',isActive:true}).returning();return row;
}
async function candidate(){await saveAiProviderConfig(group,{provider:'openrouter',model:'fictional/pending',apiKey:'fictional-candidate-key',providerOptions:routes()});}
async function run(userId:string,state:string,actualTokens:number|null,reservedTokens=100,reason:string|null=null){
 const [row]=await owner.db.insert(schema.aiModelRun).values({tenantId:base.tenantId,userId,companyIds:[base.companyId],featureId:'pay_rule_draft',operation:'draft',provider:'openai',model:'fictional-model',state,actualTokens,reservedTokens,reason}).returning();return row;
}
async function population(){
 await active('openrouter',routes());await candidate();
 const heavy=await createAppUser(base.tenantId,null,'employee'),medium=await createAppUser(base.tenantId,null,'employee'),quiet=await createAppUser(base.tenantId,null,'employee');
 for(const [id,label]of [[heavy,'zz-heavy'],[medium,'zz-medium'],[quiet,'zz-quiet']])await owner.db.update(schema.appUser).set({workosUserId:label}).where(eq(schema.appUser.id,id));
 for(let i=0;i<55;i++)await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'aa-light-'+String(i).padStart(2,'0')});
 await setAiAllowance(group,{kind:'company',subjectId:base.companyId,dailyRequests:3,monthlyTokens:10000,enabled:true});
 await setAiAllowance(group,{kind:'user',subjectId:quiet,dailyRequests:0,monthlyTokens:null,enabled:true});
 await setGroupAllowance(group,{kind:'group_role',subject:'employee',dailyRequests:5,monthlyTokens:10000,enabled:true});
 await setAiSpendBudget(group,{kind:'tenant',monthlyUsd:'0',rootUsd:''});
 const completed=await run(heavy,'completed',9000);await run(medium,'completed',500);const held=await run(medium,'pending',null);await run(heavy,'blocked',null,100,'daily_limit');
 // Native private financial rows are fixed fictional owner fixtures, not production capability or receipt certification.
 const root=randomUUID(),digest=createHash('sha256').update('fictional-presentation-'+randomUUID()).digest('hex');ownedCapabilities.add(digest);await owner.client`insert into app.ai_spend_capability(digest,provider,model,operation,max_request_nanos,source_digest,verified_at,expires_at,semantics)
 values(${digest},'openai','fictional-model','draft',1250000000,${'b'.repeat(64)},now()-interval '1 minute',now()+interval '1 day','complete_inference_usd_ceiling_v1')`;
 await owner.client`insert into app.ai_spend_root(tenant_id,root_id,kind) values(${base.tenantId}::uuid,${root}::uuid,'evaluation')`;
 for(const [row,state,confirmed]of [[completed,'confirmed','0'],[held,'held',null]]as const)await owner.client`insert into app.ai_spend_reservation(run_id,tenant_id,root_id,user_id,company_ids,feature_id,capability_digest,request_digest,configuration_digest,reserved_nanos,confirmed_nanos,state,settled_at)
 values(${row.id}::uuid,${base.tenantId}::uuid,${root}::uuid,${row.userId}::uuid,array[${base.companyId}::uuid],'pay_rule_draft',${digest},${'c'.repeat(64)},${'d'.repeat(64)},1250000000,${confirmed}::bigint,${state},case when ${state}='held' then null else now() end)`;
 const other=await seedBase(),otherRoot=randomUUID(),[otherHeld]=await owner.db.insert(schema.aiModelRun).values({tenantId:other.tenantId,userId:other.adminUserId,companyIds:[other.companyId],featureId:'pay_rule_draft',operation:'draft',provider:'openai',model:'fictional-foreign',state:'pending',actualTokens:null,reservedTokens:9999}).returning();
 await owner.db.insert(schema.aiModelRun).values({tenantId:other.tenantId,userId:other.adminUserId,companyIds:[other.companyId],featureId:'pay_rule_draft',operation:'draft',provider:'openai',model:'fictional-foreign',state:'completed',actualTokens:9999,reservedTokens:9999});
 await owner.client`insert into app.ai_spend_root(tenant_id,root_id,kind)values(${other.tenantId}::uuid,${otherRoot}::uuid,'evaluation')`;
 await owner.client`insert into app.ai_spend_reservation(run_id,tenant_id,root_id,user_id,company_ids,feature_id,capability_digest,request_digest,configuration_digest,reserved_nanos,state)
 values(${otherHeld.id}::uuid,${other.tenantId}::uuid,${otherRoot}::uuid,${other.adminUserId}::uuid,array[${other.companyId}::uuid],'pay_rule_draft',${digest},${'e'.repeat(64)},${'f'.repeat(64)},9000000000,'held')`;
 await owner.client`insert into app.ai_spend_budget(tenant_id,scope_key,kind,monthly_nanos,root_nanos)values(${other.tenantId}::uuid,'tenant','tenant',777,888)`;
 const [admin]=await owner.db.select({label:schema.appUser.workosUserId}).from(schema.appUser).where(eq(schema.appUser.id,base.adminUserId));
 await setModule(base.tenantId,'notifications','active');await setTenantSetting(group,{key:'notifications.readiness_nudge_enabled',value:true});
 return{heavy,medium,quiet,completed,held,adminLabel:admin.label};
}
async function heldBarrier(kind:'access'|'history',read:(pid:number)=>Promise<void>){
 let enter!:()=>void,release!:()=>void,pid=0;const ready=new Promise<void>(r=>{enter=r;}),done=new Promise<void>(r=>{release=r;});
 const holder=owner.client.begin(async tx=>{const [identity]=await tx`select pg_backend_pid() as pid`;pid=identity.pid;
  if(kind==='access')await tx`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+base.tenantId},0))`;
  else await tx`select pg_advisory_xact_lock(hashtext(${'audit-chain:'+base.tenantId}))`;
  enter();await done;
 });
 try{await Promise.race([ready,holder.then(()=>{throw Error('Native holder exited early');})]);await read(pid);}finally{release();await holder;}
}
beforeAll(async()=>{
 expect(process.env.GITHUB_ACTIONS).toBe('true');expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');expect(process.env.GITHUB_REPOSITORY).toBe('StradaverseHub/ai-hr');
 const pool=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;if(!pool||! /^[1-9][0-9]*$/.test(pool)||process.env.WORKER_DB==='0')throw Error('Owned canonical worker required');expectedDatabase=workerDb(pool);
 for(const [key,user]of Object.entries({TEST_DATABASE_URL:'ai_hr_app',DATABASE_URL:'ai_hr_app',TEST_MIGRATION_DATABASE_URL:'postgres',MIGRATION_DATABASE_URL:'postgres'})){
  const url=new URL(process.env[key]!);expect({host:url.hostname,port:url.port,database:url.pathname,user:url.username,search:url.search,hash:url.hash}).toEqual({host:'127.0.0.1',port:'5433',database:'/'+expectedDatabase,user,search:'',hash:''});
 }
 await migrateTestDb();const [actual]=await owner.client`select current_database()as database,session_user,current_user`;expect(actual).toEqual({database:expectedDatabase,session_user:'postgres',current_user:'postgres'});
 original=await definitions();expect(original).toHaveLength(4);await install();
},300000);
beforeEach(async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','fictional-ai-centre-presentation-key');for(const name of ['ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(name,'');vi.stubEnv('OPENAI_API_KEY','fictional-platform-key');
 const fetch=vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw Error('No provider/network calls permitted');});verifyNetwork=()=>{try{expect(fetch).not.toHaveBeenCalled();}finally{fetch.mockRestore();}};await resetDb();base=await seedBase();group=context(base);
});
afterEach(()=>{try{verifyNetwork();}finally{vi.unstubAllEnvs();}});
afterAll(async()=>{try{if(installed)await restore();if(ownedCapabilities.size){await resetDb();await owner.client`delete from app.ai_spend_capability where digest=any(${[...ownedCapabilities]}::text[])`;}}finally{await closeAll();}});

describe.sequential('AI Centre presentation native purpose prototype',()=>{
 it('keeps all old native wrapper metadata/ACL/owner and denies every private helper to the app role',async()=>{
  expect(createHash('sha256').update(readFileSync('test/fixtures/ai-management-locked-baseline.ts')).digest('hex')).toBe('fdd12d1bf9048ea433b45c3c6ad4abe588551340d534bae4adf36e135b786897');
  const current=await definitions();expect(current).toHaveLength(4);
  for(const before of original){const after=current.find(r=>r.signature===before.signature)!;const{prosrc:oldBody,...oldMetadata}=before.details,{prosrc:newBody,...newMetadata}=after.details;expect(newMetadata).toEqual(oldMetadata);if(before.signature.includes('_ai_provider_evaluation_actor_valid'))expect(newBody).toEqual(oldBody);}
  const rows=await owner.client`select p.proname,r.rolname as owner,p.prosecdef,has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app_exec,
   exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a where a.grantee=0) as public_exec
   from pg_proc p join pg_roles r on r.oid=p.proowner where p.pronamespace='app'::regnamespace and p.proname like '_ai_presentation_%' order by p.proname`;
  expect(rows).toHaveLength(4);for(const row of rows)expect(row).toMatchObject({owner:'postgres',prosecdef:true,app_exec:false,public_exec:false});
  await expect(database.withTenant(group,tx=>tx.execute(sql`select app._ai_presentation_spend_value()`))).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='42501');
 });
 it('preserves independent full nonempty legacy DTO and complete attention, held/known-zero/unknown USD, switch attribution and candidate overlay',async()=>{
  const f=await population(),before=await effects(),old=await readLockedManagement(group),view=await aiManagementPresentationView(group);
  expect(view).toEqual(old);expect(await aiManagementView(group)).toEqual(old);expect(view.provider).toEqual({provider:'openrouter',model:'fictional/pending'});
  expect(view.usage).toEqual([{feature_id:'pay_rule_draft',daily_requests:'3',monthly_tokens:'9500',held_tokens:'100',blocked:'1',failed:'0'}]);
  expect(view.users.slice(0,2).map(r=>r.id)).toEqual([f.heavy,f.medium]);expect(view.moreUsers).toBe(true);
  expect(view.attention.users.map(r=>r.id)).toEqual([f.heavy,f.quiet]);expect(view.attention.blocked).toEqual([{id:f.heavy,label:'zz-heavy',count:1,reason:'daily_limit'}]);
  expect(view.attention.users[0]).toMatchObject({source:'group',group:{kind:'group_role',count:1,scopeKey:'group_role:employee'},tokens:{used:9000,limit:10000,level:'near'}});
  expect(view.attention.users[1]).toMatchObject({source:'individual',daily:{used:0,limit:0,level:'at'}});
  expect(view.attention.companies.map(r=>r.id)).toEqual([base.companyId]);expect(view.companies[0]).toMatchObject({daily:{used:3,limit:3,level:'at'},tokens:{used:9600,limit:10000,level:'near'}});
  expect(view.spend).toEqual({currency:'USD',unit:'nano_usd',semantics:'application_inference_allocation',certifiedLiveRoutes:0,reviewedCarrierRecords:0,liveCapability:'not_verified_here',budgets:[{scopeKey:'tenant',monthlyNanos:'0',rootNanos:null}],unpricedUnknownRuns:1,heldNanos:'1250000000',confirmedNanos:'0',breached:false});
  expect(view.agentSwitches.readiness_reminders).toMatchObject({state:'attributed',by:f.adminLabel});
  expect(await aiManagementPresentationView(group,'medium',{state:'blocked',feature:'pay_rule_draft'})).toEqual(await readLockedManagement(group,'medium',{state:'blocked',feature:'pay_rule_draft'}));
  expect(await effects()).toEqual(before);
 });
 it('company administration retains only authorized company aggregates, active provider/model and no group candidate/spend/login identities',async()=>{
  await population();const [hidden]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Fictional hidden company'}).returning();
  await owner.db.insert(schema.aiModelRun).values({tenantId:base.tenantId,userId:base.adminUserId,companyIds:[hidden.id],featureId:'pay_rule_draft',operation:'draft',provider:'openai',model:'fictional-hidden',state:'completed',actualTokens:99999,reservedTokens:99999});
  const scopedId=await createAppUser(base.tenantId,null,'hr_admin');await owner.db.update(schema.roleAssignment).set({companyId:base.companyId}).where(eq(schema.roleAssignment.appUserId,scopedId));
  const scoped:SessionContext={...group,userId:scopedId,grants:[{role:'hr_admin',companyId:base.companyId}]};
  const view=await aiManagementPresentationView(scoped);expect(view).toEqual(await readLockedManagement(scoped));expect(view.provider).toEqual({provider:'openrouter',model:'fictional/active'});
  expect(view.users).toEqual([]);expect(view.runs).toEqual([]);expect(view.groups).toEqual([]);expect(view.spend).toBeNull();expect(view.attention.users).toEqual([]);expect(view.attention.blocked).toEqual([]);expect(view.companies.map(r=>r.id)).toEqual([base.companyId]);
  expect(view.usage).toEqual([{feature_id:'pay_rule_draft',daily_requests:'3',monthly_tokens:'9500',held_tokens:'100',blocked:'1',failed:'0'}]);
  await expect(getAiConfigPresentationView(scoped)).rejects.toThrow();
  for(const query of [sql`select * from app.ai_provider_candidate_presentation_v1()`,sql`select app.ai_optional_spend_presentation_status_v1()`])await expect(database.withTenant(scoped,tx=>tx.execute(query),{readOnlySnapshot:true})).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='42501');
 });
 it('reads provider configuration in the same snapshot, preserving current metadata while exposing no plaintext/ciphertext or provider capability',async()=>{
  await active('openrouter',routes());await candidate();const before=await effects(),shown=await getAiConfigPresentationView(group);expect(shown).toEqual(await getAiConfigView(group));
  const native=database.withTenant,carriers:{isolation:string;read_only:string;snapshot:string;pid:number}[]=[];
  const spy=vi.spyOn(database,'withTenant').mockImplementation(async<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>native(ctx,async tx=>{
   const [carrier]=await tx.execute<{isolation:string;read_only:string;snapshot:string;pid:number}>(sql`select current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')as read_only,txid_current_snapshot()::text as snapshot,pg_backend_pid()as pid`);carriers.push(carrier);return read(tx);
  },options));
  try{await aiManagementPresentationView(group);expect(carriers).toHaveLength(1);expect(carriers[0]).toMatchObject({isolation:'repeatable read',read_only:'on',snapshot:expect.any(String),pid:expect.any(Number)});}finally{spy.mockRestore();}
  const display=await database.withTenant(group,tx=>resolveAiProviderDisplayTx(tx,group),{readOnlySnapshot:true});expect(display).toEqual({provider:'openrouter',model:'fictional/active'});expect(Object.isFrozen(display)).toBe(true);expect(Object.keys(display!)).toEqual(['provider','model']);
  expect(()=>Reflect.apply(assertAiProviderSnapshot,undefined,[display,group])).toThrow();expect(()=>Reflect.apply(governedAiConfig,undefined,[group,display,'hr_assistant'])).toThrow();
  const serialized=JSON.stringify({shown,display});for(const secret of ['fictional-active-key','fictional-candidate-key','apiKeyCiphertext','fingerprint','governance'])expect(serialized).not.toContain(secret);
  expect(await effects()).toEqual(before);
 });
 it('uses environment fallback only for a genuinely absent active provider and keeps unknown spend costs unknown',async()=>{
  expect((await aiManagementPresentationView(group)).provider).toEqual({provider:'openai',model:defaultModelFor('openai')});
  expect((await aiManagementPresentationView(group)).spend).toMatchObject({heldNanos:'0',confirmedNanos:null,unpricedUnknownRuns:0});
  vi.stubEnv('OPENAI_API_KEY','');expect((await aiManagementPresentationView(group)).provider).toBeNull();
 });
 it('fails closed for undecryptable active secrets and malformed active options without falling back to the environment',async()=>{
  const row=await active();await owner.db.update(schema.aiProviderConfig).set({apiKeyCiphertext:'fictional-corrupt'}).where(eq(schema.aiProviderConfig.id,row.id));
  expect((await aiManagementPresentationView(group)).provider).toBeNull();expect((await readLockedManagement(group)).provider).toBeNull();
  await expect(owner.db.update(schema.aiProviderConfig).set({providerOptions:{unexpected:true}}).where(eq(schema.aiProviderConfig.id,row.id))).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='23514');
  await owner.db.update(schema.aiProviderConfig).set({apiKeyCiphertext:encryptSecret('fictional-active-key',base.tenantId)}).where(eq(schema.aiProviderConfig.id,row.id));
  const info=async()=>{const [value]=await owner.client<{definition:string;details:unknown}[]>`select pg_get_functiondef(p.oid)as definition,to_jsonb(p)as details from pg_proc p where p.oid='app.ai_active_provider_config_v2()'::regprocedure`;return value;},originalResolver=await info();
  const projection='c.api_key_ciphertext, c.provider_options';expect(originalResolver.definition.split(projection)).toHaveLength(2);
  try{
   // Owner-only projection-shape fault retains every actual resolver authority clause;
   // the stored row still satisfies its real constraint. No table/guard is disabled.
   await owner.client.unsafe(originalResolver.definition.replace(projection,projection+" || '{\"unexpected\":true}'::jsonb"));
   expect((await aiManagementPresentationView(group)).provider).toBeNull();expect((await readLockedManagement(group)).provider).toBeNull();
  }finally{await owner.client.unsafe(originalResolver.definition);expect(await info()).toEqual(originalResolver);}
 });
 it.each(['access','history']as const)('completes one genuine RR/RO management snapshot while the native %s writer stays held and creates no effects',async kind=>{
  await population();const before=await effects(),expected=await readLockedManagement(group);
  await heldBarrier(kind,async pid=>{
   const view=await aiManagementPresentationView(group);expect(view).toEqual(expected);
   expect((await owner.client`select count(*)::int as n from pg_locks where pid=${pid} and locktype='advisory' and granted`)[0].n).toBeGreaterThan(0);
   if(kind==='access')await expect(aiManagementView(group)).rejects.toThrow('Current AI calling authority');
  });expect(await effects()).toEqual(before);
 });
 it('enforces actual RR/RO mode and write refusal; old provider/candidate/spend/admission owners still refuse the new read purpose',async()=>{
  await candidate();const before=await effects();
  for(const query of [sql`select * from app.ai_provider_candidate_presentation_v1()`,sql`select app.ai_optional_spend_presentation_status_v1()`])await expect(database.withTenant(group,tx=>tx.execute(query))).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='42501');
  for(const read of [()=>database.withTenant(group,tx=>resolveActiveAiConfig(tx,group),{readOnlySnapshot:true}),()=>database.withTenant(group,tx=>providerCandidatesTx(tx,group),{readOnlySnapshot:true}),()=>database.withTenant(group,tx=>aiSpendStatusTx(tx,group),{readOnlySnapshot:true}),()=>database.withTenant(group,tx=>tx.execute(sql`select app.ai_admit('pay_rule_draft','draft','openai','fictional',1)`),{readOnlySnapshot:true})])await expect(read()).rejects.toThrow();
  await expect(database.withTenant(group,async tx=>{const [mode]=await tx.execute<{isolation:string;read_only:string}>(sql`select current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')as read_only`);expect(mode).toEqual({isolation:'repeatable read',read_only:'on'});await tx.execute(sql`insert into public.ai_control_policy(tenant_id,kind,scope_key,enabled) values(${base.tenantId}::uuid,'user_default','user_default',false)`);},{readOnlySnapshot:true})).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='25006');
  expect(await effects()).toEqual(before);
 });
 it('keeps existing native RC commands exclusive under a held Access writer and commits no partial budget/event changes',async()=>{
  const before=await effects();await heldBarrier('access',async()=>{await expect(setAiSpendBudget(group,{kind:'tenant',monthlyUsd:'1',rootUsd:''})).rejects.toThrow('Current AI calling authority');});expect(await effects()).toEqual(before);
  await database.withTenant(group,async tx=>{await assertAiPrincipalTx(tx,group);const [probe]=await owner.client.begin(observer=>observer`select pg_try_advisory_xact_lock_shared(hashtextextended(${'access-configuration:'+base.tenantId},0))as acquired`);expect(probe.acquired).toBe(false);});
 });
 it('freshly refuses revoked, archived, relinked, foreign, forged and suspended actors without fallback or disclosure',async()=>{
  await candidate();const foreign=await seedBase();
  for(const ctx of [{...group,tenantId:foreign.tenantId},{...group,userId:foreign.adminUserId},{...group,roles:['super_admin'],grants:[{role:'super_admin',companyId:null}]}])await refuseRead(ctx);
  await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,base.adminUserId));await refuseRead(group);await owner.db.update(schema.appUser).set({archivedAt:null}).where(eq(schema.appUser.id,base.adminUserId));
  const [person]=await owner.db.insert(schema.person).values({tenantId:base.tenantId,fullName:'Fictional changed identity'}).returning();await owner.db.update(schema.appUser).set({personId:person.id}).where(eq(schema.appUser.id,base.adminUserId));await refuseRead(group);await owner.db.update(schema.appUser).set({personId:null}).where(eq(schema.appUser.id,base.adminUserId));
  await owner.db.update(schema.tenant).set({status:'suspended'}).where(eq(schema.tenant.id,base.tenantId));await refuseRead(group);await owner.db.update(schema.tenant).set({status:'active'}).where(eq(schema.tenant.id,base.tenantId));
  const removed=await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,base.adminUserId)).returning();await refuseRead(group);await owner.db.insert(schema.roleAssignment).values(removed);
  const before=await effects();expect((await aiManagementPresentationView(group)).provider).toEqual({provider:'openai',model:defaultModelFor('openai')});expect(await effects()).toEqual(before);
 });
 it('refuses a currently blocked employment-backed login and captures supplied context before asynchronous reads',async()=>{
  const hired=await hireEmployee(group,{person:{fullName:'Fictional blocked administrator',primaryEmail:randomUUID()+'@example.invalid'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  await owner.db.update(schema.appUser).set({personId:hired.personId}).where(eq(schema.appUser.id,base.adminUserId));const linked={...group,personId:hired.personId};expect((await aiManagementPresentationView(linked)).provider).toBeTruthy();
  await owner.db.update(schema.employment).set({terminatedOn:'2020-01-02'}).where(eq(schema.employment.id,hired.employmentId));expect((await owner.client`select app.login_blocked(${base.adminUserId}::uuid)as blocked`)[0].blocked).toBe(true);await expect(aiManagementPresentationView(linked)).rejects.toThrow();
  await owner.db.update(schema.employment).set({terminatedOn:null}).where(eq(schema.employment.id,hired.employmentId));const supplied={...linked,roles:linked.roles?.slice(),grants:linked.grants?.map(g=>({...g}))},pending=aiManagementPresentationView(supplied);supplied.tenantId=randomUUID();supplied.roles=['employee'];supplied.grants=[{role:'employee',companyId:null}];expect((await pending).provider).toBeTruthy();
 });
 it('refuses predecessor metadata drift atomically and restores the exact original native functions',async()=>{
  await restore();try{
   await expect(owner.client.begin(tx=>tx.unsafe(prototype))).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='55000');
   await owner.client`alter function app.ai_spend_status() cost 101`;await expect(install()).rejects.toSatisfy((e:unknown)=>pgSqlState(e)==='55000');
   expect((await owner.client`select count(*)::int as n from pg_proc where pronamespace='app'::regnamespace and (proname like '_ai_presentation_%' or proname like '%presentation_status_v1' or proname='ai_provider_candidate_presentation_v1')`)[0].n).toBe(0);
   expect((await owner.client`select procost from pg_proc where oid='app.ai_spend_status()'::regprocedure`)[0].procost).toBe(101);
  }finally{for(const row of original)await owner.client.unsafe(row.definition);expect(await definitions()).toEqual(original);await install();}
 });
});
