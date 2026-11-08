/** Fictional native controls for the proposed common presentation ABI. Authored UNRUN.
 * Requires the centrally reconciled/allocated append; missing ABI fails, never skips or falls back.
 * This covers the common owner, not closure of Provider/Workers/Assistant/preview child routes. */
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import * as s from '../db/schema';
import {aiManagementPageView,aiManagementView,setAiFeature} from '../core/ai-management';
import {readAiManagementPresentationTx} from '../core/ai-management-presentation';
import {aiSpendPresentationStatusTx,aiSpendStatusTx,setAiSpendBudget} from '../core/ai-spend-management';
import {saveAiProviderConfig} from '../core/ai-config';
import {setMandateStopSwitch} from '../core/mandates/mandates';
import {assertAiCentreRunningTx} from '../core/ai-centre-control';
import {AI_MANAGEMENT_SECTIONS} from '../lib/ai/management-sections';
import {pgSqlState} from '../lib/db-error';
import type {AiAdapter} from '../lib/ai/types';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {anthropicAdapter} from '../lib/ai/providers/anthropic';
import {googleAdapter} from '../lib/ai/providers/google';
import {gatewayAdapter} from '../lib/ai/providers/gateway';
import {openrouterAdapter} from '../lib/ai/providers/openrouter';
import {observeNativeRead} from './helpers/native-read-observer';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {EntitlementsResolutionFailedError,resolveEntitlementsTx} from '../core/entitlements';
import {agentSwitchStatesTx} from '../core/agent-principal';
import {assertAiPresentationPrincipalTx} from '../core/ai-principal';

let b:Base,group:SessionContext;
const attempted=vi.fn();
beforeAll(migrateTestDb);
beforeEach(async()=>{
 for(const key of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY'])vi.stubEnv(key,'');
 vi.stubEnv('AI_CONFIG_SECRET','fictional-presentation-secret-0123456789');attempted.mockClear();
 const forbidden=async()=>{attempted();throw new Error('Provider transport is outside common presentation');};
 const adapters:AiAdapter[]=[openaiAdapter,anthropicAdapter,googleAdapter,gatewayAdapter,openrouterAdapter];
 for(const adapter of adapters){vi.spyOn(adapter,'generate').mockImplementation(forbidden);vi.spyOn(adapter,'validate').mockImplementation(forbidden);
  if(adapter.converse)vi.spyOn(adapter,'converse').mockImplementation(forbidden);if(adapter.readImage)vi.spyOn(adapter,'readImage').mockImplementation(forbidden);}
 vi.stubGlobal('fetch',forbidden);await resetDb();b=await seedBase();group={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
});
afterEach(()=>{expect(attempted).not.toHaveBeenCalled();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
afterAll(closeAll);
const events=()=>owner.db.select({id:s.domainEvent.id}).from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.id);
async function bind(tx:Tx,ctx:SessionContext){
 await tx.execute(sql`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId??''},true),set_config('app.roles',${(ctx.roles??[]).join(',')},true),set_config('app.grants',${JSON.stringify(ctx.grants??[])}::text,true),set_config('app.agent_principal_id','',true)`);
 const [role]=await tx.execute<{role:string}>(sql`select current_user as role`);expect(role.role).toBe('ai_hr_app');
}

it('enforces all four actual native transaction modes without turning the display ABI into an RC or writable capability',async()=>{
 for(const isolation of ['read committed','repeatable read'] as const)for(const access of ['read write','read only'] as const){
  const result=await database.db.transaction(async tx=>{
   await bind(tx,group);
   const [mode]=await tx.execute(sql`select current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as read_only`);
   expect(mode).toEqual({isolation,read_only:access==='read only'?'on':'off'});
   const [row]=await tx.execute<{status:{currency:string;heldNanos:string;confirmedNanos:string|null;unpricedUnknownRuns:number}}>(sql`select app.ai_spend_presentation_status_v1() as status`);
   return row.status;
  },{isolationLevel:isolation,accessMode:access}).then(status=>({status,error:null}),error=>({status:null,error:pgSqlState(error)}));
  if(isolation==='repeatable read'&&access==='read only')expect(result.status).toMatchObject({currency:'USD',heldNanos:'0',confirmedNanos:null,unpricedUnknownRuns:0});
  else expect(result.error).toBe('42501');
 }
 await expect(database.withTenant(group,tx=>readAiManagementPresentationTx(tx,group))).rejects.toThrow();
 await expect(database.withTenant(group,async tx=>{await tx.execute(sql`set transaction read only`);return readAiManagementPresentationTx(tx,group);})).rejects.toThrow();
 expect(await database.withTenant(group,tx=>readAiManagementPresentationTx(tx,group),{readOnlySnapshot:true})).toBeNull();
});

it('preserves a real zero allocation and distinguishes reported provider zero from unknown unpaid nonprobe inference',async()=>{
 await setAiSpendBudget(group,{kind:'tenant',monthlyUsd:'0',rootUsd:'0'});
 const common={tenantId:b.tenantId,userId:group.userId!,companyIds:[b.companyId],featureId:'pay_rule_draft',model:'fictional/model',reservedTokens:1};
 await owner.db.insert(s.aiModelRun).values([
  {...common,provider:'openrouter',operation:'draft',state:'completed',actualTokens:0,openrouterAccountCostCredits:'0',observedRoundTripMs:1,providerObservationStatus:'reported'},
  {...common,provider:'openai',operation:'draft',state:'completed',actualTokens:null,providerObservationStatus:'missing'},
  {...common,provider:'openai',operation:'probe',state:'completed',actualTokens:0},
  {...common,provider:'openai',operation:'draft',state:'blocked',reason:'paused',actualTokens:null},
 ]);
 const before=await events(),presented=await database.withTenant(group,tx=>aiSpendPresentationStatusTx(tx,group),{readOnlySnapshot:true});
 expect(presented).toMatchObject({currency:'USD',unit:'nano_usd',semantics:'application_inference_allocation',certifiedLiveRoutes:0,reviewedCarrierRecords:0,liveCapability:'not_verified_here',budgets:[{scopeKey:'tenant',monthlyNanos:'0',rootNanos:'0'}],heldNanos:'0',confirmedNanos:null,breached:false,unpricedUnknownRuns:2});
 expect(await database.withTenant(group,tx=>aiSpendStatusTx(tx,group))).toEqual(presented);
 expect((await aiManagementPageView(group,'allowances')).spend).toEqual(presented);expect(await events()).toEqual(before);
});

it('exposes only nonsecret candidate metadata to a genuine group RRRO principal and keeps private helpers and tables inaccessible',async()=>{
 const key='fictional-presentation-candidate-key';
 await saveAiProviderConfig(group,{provider:'openrouter',model:'fictional/presentation-candidate',apiKey:key,providerOptions:{version:1,routing:{allowedProviders:['approved-a'],allowFallbacks:false,sort:'latency'}}});
 const metadata=await database.withTenant(group,async tx=>Array.from(await tx.execute(sql`select * from app.ai_provider_candidate_presentation_v1()`)),{readOnlySnapshot:true});
 expect(metadata).toHaveLength(1);expect(metadata[0]).toMatchObject({provider:'openrouter',model:'fictional/presentation-candidate',key_last4:key.slice(-4)});
 expect(Object.keys(metadata[0]).sort()).toEqual(['id','key_last4','model','provider','provider_options','updated_at','version_token']);
 expect(JSON.stringify(metadata)).not.toContain(key);
 for(const query of [sql`select * from public.ai_provider_candidate`,sql`select app._ai_management_presentation_group_v1()`,sql`select app._ai_spend_status_facts_v1()`,sql`select app._ai_optional_spend_status_facts_v1()`]){
  const code=await database.withTenant(group,tx=>tx.execute(query),{readOnlySnapshot:true}).then(()=>null,pgSqlState);expect(code).toBe('42501');
 }
 const [u]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:'fictional-presentation-company'}).returning();
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:u.id,role:'hr_admin',companyId:b.companyId});
 const company={...group,userId:u.id,grants:[{role:'hr_admin',companyId:b.companyId}]};
 for(const query of [sql`select * from app.ai_provider_candidate_presentation_v1()`,sql`select app.ai_spend_presentation_status_v1()`])expect(await database.withTenant(company,tx=>tx.execute(query),{readOnlySnapshot:true}).then(()=>null,pgSqlState)).toBe('42501');
 expect(await database.withTenant(company,tx=>aiSpendPresentationStatusTx(tx,company),{readOnlySnapshot:true})).toBeNull();
 // The old native view keeps its RC-only authority; the new one must refuse RC.
 expect(await database.withTenant(group,tx=>tx.execute(sql`select * from app.ai_provider_candidate_view_v1()`))).toHaveLength(1);
 expect(await database.withTenant(group,tx=>tx.execute(sql`select * from app.ai_provider_candidate_view_v1()`),{readOnlySnapshot:true}).then(()=>null,pgSqlState)).toBe('P0001');
 expect(await database.withTenant(group,tx=>tx.execute(sql`select * from app.ai_provider_candidate_presentation_v1()`)).then(()=>null,pgSqlState)).toBe('42501');
});

it.each(['commit','rollback'] as const)('finishes all eight common pages while a real Access writer holds an uncommitted revocation, then respects its %s',async outcome=>{
 const before=await events(),actual=database.withTenant,observed:{pid:number;holderPid:number;role:string;isolation:string;read_only:string;advisory:string;blocked:number[]}[]=[];
 let writerEvents=before;
 const rollback=new Error('fictional owned rollback');let holderOpen=false;
 try{
  await owner.client.begin(async holder=>{
   const [holderFacts]=await holder<{pid:number}[]>`select pg_backend_pid() as pid`;
   await holder`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
   await holder`delete from public.role_assignment where tenant_id=${b.tenantId}::uuid and app_user_id=${group.userId!}::uuid`;
   writerEvents=Array.from(await holder<{id:string}[]>`select id from public.domain_event where tenant_id=${b.tenantId}::uuid order by id`);holderOpen=true;
   const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(ctx,async tx=>{
    await tx.execute(sql`set local lock_timeout='300ms'`);
    const value=await read(tx);
    const [facts]=await tx.execute<{pid:number;role:string;isolation:string;read_only:string;advisory:string;blocked:number[]}>(sql`select pg_backend_pid() as pid,current_user as role,current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as read_only,(select count(*)::text from pg_catalog.pg_locks where pid=pg_backend_pid() and locktype='advisory') as advisory,pg_blocking_pids(pg_backend_pid()) as blocked`);
    expect(holderOpen).toBe(true);observed.push({...facts,holderPid:holderFacts.pid});return value;
   },options));
   try{
    for(const section of AI_MANAGEMENT_SECTIONS){const view=await aiManagementPageView(group,section);expect(view.companies.map(row=>row.id)).toContain(b.companyId);expect(view.provider).toBeNull();expect(view.spend).toMatchObject({currency:'USD',heldNanos:'0',confirmedNanos:null,unpricedUnknownRuns:0});}
    await expect(aiManagementView(group)).rejects.toThrow();
   }finally{spy.mockRestore();holderOpen=false;}
   if(outcome==='rollback')throw rollback;
  });
 }catch(error){if(error!==rollback)throw error;expect(outcome).toBe('rollback');}
 expect(observed).toHaveLength(8);expect(observed.every(row=>row.pid!==row.holderPid&&row.role==='ai_hr_app'&&row.isolation==='repeatable read'&&row.read_only==='on'&&row.advisory==='0'&&row.blocked.length===0)).toBe(true);
 if(outcome==='commit')await expect(aiManagementPageView(group,'overview')).rejects.toThrow();
 else expect((await aiManagementPageView(group,'overview')).companies.map(row=>row.id)).toContain(b.companyId);
 expect(await events()).toEqual(outcome==='commit'?writerEvents:before);
});

it('keeps an admitted old grant snapshot coherent and narrows the next snapshot and stale command after a committed scope edit',async()=>{
 const [outside]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional outside RRRO company'}).returning();
 let changed=false,afterChange:Awaited<ReturnType<typeof events>>|undefined;const probe=observeNativeRead({after:async query=>{
  if(!changed&&query.sql.includes('from public.app_user u')&&query.sql.includes('app.principal_snapshot_current()')){
   changed=true;await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,group.userId!));afterChange=await events();
  }
 }});
 let old:Awaited<ReturnType<typeof aiManagementPageView>>;
 try{old=await aiManagementPageView(group,'overview');}finally{probe.restore();}
 expect(changed).toBe(true);expect(old.companies.map(row=>row.id)).toEqual(expect.arrayContaining([b.companyId,outside.id]));
 expect(probe.properties).toHaveLength(1);expect(probe.properties[0]).toMatchObject({role:'ai_hr_app',isolation:'repeatable read',readOnly:true});
 await expect(aiManagementPageView(group,'overview')).rejects.toThrow();
 const narrowed={...group,grants:[{role:'hr_admin',companyId:b.companyId}]};
 const next=await aiManagementPageView(narrowed,'overview');expect(next.companies.map(row=>row.id)).toEqual([b.companyId]);expect(next.spend).toBeNull();expect(next.attention.users).toEqual([]);
 await expect(setAiFeature(group,'claims_triage',false)).rejects.toThrow();expect(afterChange).toBeDefined();expect(await events()).toEqual(afterChange);
});

it('gets native write refusal and SQL rollback rather than upgrading or continuing an aborted presentation carrier',async()=>{
 let continued=false;
 const write=await database.withTenant(group,async tx=>{await readAiManagementPresentationTx(tx,group);await tx.update(s.company).set({legalName:'Forbidden presentation write'}).where(eq(s.company.id,b.companyId));continued=true;},{readOnlySnapshot:true}).then(()=>null,pgSqlState);
 expect(write).toBe('25006');expect(continued).toBe(false);
 const error=await database.withTenant(group,async tx=>{await readAiManagementPresentationTx(tx,group);await tx.execute(sql`select 1/0`);continued=true;},{readOnlySnapshot:true}).then(()=>null,pgSqlState);
 expect(error).toBe('22012');expect(continued).toBe(false);
 expect((await owner.db.select().from(s.company).where(eq(s.company.id,b.companyId)))[0].legalName).toBe('Acme Sdn Bhd');
 expect((await aiManagementPageView(group,'overview')).companies.map(row=>row.id)).toContain(b.companyId);
});

it('finishes common reads while an actual raw Stop writer holds Access and AI ownership before its commit',async()=>{
 await setMandateStopSwitch(group,false);const actual=database.withTenant,modes:{role:string;isolation:string;read_only:string;advisory:string;blocked:number[]}[]=[];
 try{
  await owner.client.begin(async writer=>{
   await writer`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${group.userId!},true),set_config('app.roles','hr_admin',true),set_config('app.grants',${JSON.stringify(group.grants)},true),set_config('app.agent_principal_id','',true)`;
   await writer`update public.teras_mandate_control set stopped=true where tenant_id=${b.tenantId}::uuid`;
   let writerOpen=true;
   const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(ctx,async tx=>{
    await tx.execute(sql`set local lock_timeout='300ms'`);const value=await read(tx);
    const [mode]=await tx.execute<{role:string;isolation:string;read_only:string;advisory:string;blocked:number[]}>(sql`select current_user as role,current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as read_only,(select count(*)::text from pg_catalog.pg_locks where pid=pg_backend_pid() and locktype='advisory') as advisory,pg_blocking_pids(pg_backend_pid()) as blocked`);
    expect(writerOpen).toBe(true);modes.push(mode);return value;
   },options));
   try{
    for(const section of AI_MANAGEMENT_SECTIONS)expect((await aiManagementPageView(group,section)).companies.map(row=>row.id)).toContain(b.companyId);
    const old=await database.withTenant(group,async tx=>{await readAiManagementPresentationTx(tx,group);return Array.from(await tx.execute<{stopped:boolean}>(sql`select stopped from app.ai_centre_control_state()`));},{readOnlySnapshot:true});
    expect(old).toEqual([{stopped:false}]);await expect(aiManagementView(group)).rejects.toThrow();
   }finally{spy.mockRestore();writerOpen=false;}
  });
  expect(modes).toHaveLength(9);expect(modes.every(row=>row.role==='ai_hr_app'&&row.isolation==='repeatable read'&&row.read_only==='on'&&row.advisory==='0'&&row.blocked.length===0)).toBe(true);
  expect(await database.withTenant(group,async tx=>Array.from(await tx.execute(sql`select stopped from app.ai_centre_control_state()`)),{readOnlySnapshot:true})).toEqual([{stopped:true}]);
 }finally{await setMandateStopSwitch(group,false);}
});

it('treats Stop as snapshot metadata while the unchanged live barrier still refuses commands and allows canonical resume',async()=>{
 await setMandateStopSwitch(group,false);
 try{
  await database.withTenant(group,async tx=>{
   await readAiManagementPresentationTx(tx,group);
   const [before]=await tx.execute<{stopped:boolean;generation:number}>(sql`select stopped,generation from app.ai_centre_control_state()`);expect(before.stopped).toBe(false);
   await owner.client.begin(async writer=>{
    await writer`select set_config('app.tenant_id',${b.tenantId},true),set_config('app.user_id',${group.userId!},true),set_config('app.roles','hr_admin',true),set_config('app.grants',${JSON.stringify(group.grants)},true),set_config('app.agent_principal_id','',true)`;
    await writer`update public.teras_mandate_control set stopped=true where tenant_id=${b.tenantId}::uuid`;
   });
   const [after]=await tx.execute(sql`select stopped,generation from app.ai_centre_control_state()`);expect(after).toEqual(before);
  },{readOnlySnapshot:true});
  const fresh=await database.withTenant(group,async tx=>{await readAiManagementPresentationTx(tx,group);return Array.from(await tx.execute<{stopped:boolean;generation:number}>(sql`select stopped,generation from app.ai_centre_control_state()`));},{readOnlySnapshot:true});
  expect(fresh[0].stopped).toBe(true);expect(fresh[0].generation).toBeGreaterThan(0);
  expect((await aiManagementPageView(group,'overview')).companies.map(row=>row.id)).toContain(b.companyId);
  await expect(database.withTenant(group,tx=>assertAiCentreRunningTx(tx,group))).rejects.toMatchObject({reason:'paused'});
 }finally{await setMandateStopSwitch(group,false);}
});


it('recovers a prior session resolution error only for PAGE purposes using current modules and attributed switches',async()=>{
 for(const code of ['assistant','payroll','claims'])await setModule(b.tenantId,code,'active');
 await saveAiProviderConfig(group,{provider:'openai',model:'fictional-common-recovered-model',apiKey:'fictional-common-recovered-key',makeActive:true});
 await setAiFeature(group,'claims_triage',true);
 const [switchEvent]=await owner.client<{id:string;at:string;actor_id:string;label:string}[]>`select e.id,e.occurred_at::text as at,e.actor_id,coalesce(p.full_name,u.workos_user_id) as label
  from public.domain_event e join public.app_user u on u.id=e.actor_id and u.tenant_id=e.tenant_id left join public.person p on p.id=u.person_id
  where e.tenant_id=${b.tenantId}::uuid and e.event_type='tenant-setting.changed' and e.aggregate_type='tenant-setting'
   and e.aggregate_id=${b.tenantId}::uuid and e.payload->>'key'='claims.input_triage_enabled' order by e.occurred_at desc,e.sequence desc limit 1`;
 expect(switchEvent?.id).toBeTruthy();expect(switchEvent.actor_id).toBe(group.userId);expect(switchEvent.label).toBeTruthy();
 const switchAt=new Date(switchEvent.at);expect(Number.isFinite(switchAt.getTime())).toBe(true);
 const nativeSwitches=await database.withTenant(group,async tx=>{
  await assertAiPresentationPrincipalTx(tx,group);
  const fresh={...group,entitlements:await resolveEntitlementsTx(tx,group.tenantId)};
  return agentSwitchStatesTx(tx,fresh);
 },{readOnlySnapshot:true});
 expect(nativeSwitches.find(row=>row.feature==='claims_triage')).toEqual({feature:'claims_triage',state:'attributed',userId:group.userId,eventId:switchEvent.id,at:switchAt});
 const recovering:SessionContext={...group,entitlements:undefined,entitlementsError:'fictional earlier session snapshot failure'};
 const before=await events();
 for(const section of ['features','allowances'] as const){
  const view=await aiManagementPageView(recovering,section);
  expect(view.provider).toEqual({provider:'openai',model:'fictional-common-recovered-model'});
  expect(view.features.find(row=>row.id==='claims_triage')).toMatchObject({enabled:true,state:'scheduled'});
  expect(view.features.find(row=>row.id==='payroll_explanation')).toMatchObject({enabled:true,state:'ready'});
  expect(view.agentSwitches.claims_triage).toEqual({state:'attributed',by:switchEvent.label,at:switchAt});
 }
 expect(await events()).toEqual(before);expect(recovering.entitlements).toBeUndefined();expect(recovering.entitlementsError).toBe('fictional earlier session snapshot failure');
 // The historical full API keeps its original error-bearing-context refusal.
 await expect(aiManagementView(recovering)).rejects.toBeInstanceOf(EntitlementsResolutionFailedError);
 await setModule(b.tenantId,'claims','disabled');
 const currentOff=await aiManagementPageView(recovering,'features');
 expect(currentOff.features.find(row=>row.id==='claims_triage')).toMatchObject({enabled:true,state:'module'});
 expect(currentOff.agentSwitches.claims_triage).toEqual({state:'attributed',by:switchEvent.label,at:switchAt});
 await setAiFeature(group,'claims_triage',false);
 const switchedOff=await aiManagementPageView(recovering,'features');
 expect(switchedOff.features.find(row=>row.id==='claims_triage')).toMatchObject({enabled:false,state:'paused'});
 expect(switchedOff.agentSwitches.claims_triage).toEqual({state:'off'});
 expect(recovering.entitlements).toBeUndefined();expect(recovering.entitlementsError).toBe('fictional earlier session snapshot failure');
});

it('propagates an actual entitlement snapshot SQL failure and settles rollback before a recovered PAGE read',async()=>{
 const recovering:SessionContext={...group,entitlements:undefined,entitlementsError:'fictional earlier session snapshot failure'};
 const actual=database.withTenant,observed:{role:string;isolation:string;read_only:string}[]=[];
 // Existing owner + app connections only. The real relation lock makes the resolver fail;
 // neither its result nor calling authority is mocked or replaced.
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(ctx:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(ctx,async tx=>{
  await tx.execute(sql`set local lock_timeout='300ms'`);
  const [mode]=await tx.execute<{role:string;isolation:string;read_only:string}>(sql`select current_user as role,current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as read_only`);
  observed.push(mode);return read(tx);
 },options));
 try{
  await owner.client.begin(async holder=>{
   await holder`lock table public.tenant_module in access exclusive mode`;
   const failure=await aiManagementPageView(recovering,'features').then(()=>null,(error:unknown)=>error);
   expect(pgSqlState(failure)).toBe('55P03');
   expect((failure as {query?:unknown}|null)?.query).toEqual(expect.stringContaining('FROM tenant_module tm'));
  });
 }finally{spy.mockRestore();}
 expect(observed).toEqual([{role:'ai_hr_app',isolation:'repeatable read',read_only:'on'}]);
 const next=await aiManagementPageView(recovering,'features');expect(next.features.length).toBeGreaterThan(0);
 expect(recovering.entitlements).toBeUndefined();expect(recovering.entitlementsError).toBe('fictional earlier session snapshot failure');
});
