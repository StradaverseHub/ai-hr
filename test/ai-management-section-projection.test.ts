/** Fictional-data native read contract. No provider requests or command authority are exercised. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {aiManagementPageView,aiManagementView,setAiAllowance,setGroupAllowance,setAiFeature} from '../core/ai-management';
import {aiManagementAlerts,aiInventoryView,aiRunHistory} from '../core/ai-inventory';
import {getAiConfigView,saveAiProviderConfig} from '../core/ai-config';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {setAiSpendBudget} from '../core/ai-spend-management';
import {hireEmployee,terminateEmployment} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {AI_MANAGEMENT_SECTIONS,type AiManagementSection} from '../lib/ai/management-sections';
import type {AiAdapter} from '../lib/ai/types';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {anthropicAdapter} from '../lib/ai/providers/anthropic';
import {googleAdapter} from '../lib/ai/providers/google';
import {gatewayAdapter} from '../lib/ai/providers/gateway';
import {openrouterAdapter} from '../lib/ai/providers/openrouter';
import {readOpenRouterOptions} from '../lib/ai/providers/openrouter-configuration';
import {observeNativeRead,type NativeReadQuery} from './helpers/native-read-observer';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base,group:SessionContext;
const providerAttempt=vi.fn(),networkAttempt=vi.fn();
beforeAll(migrateTestDb);
beforeEach(async()=>{
 for(const key of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY','OPENROUTER_API_KEY','AI_GATEWAY_API_KEY'])vi.stubEnv(key,'');
 vi.stubEnv('AI_CONFIG_SECRET','fictional-section-projection-secret-0123456789');
 providerAttempt.mockClear();networkAttempt.mockClear();
 const forbidden=async()=>{providerAttempt();throw new Error('Provider transport is outside this read test');};
 const adapters:AiAdapter[]=[openaiAdapter,anthropicAdapter,googleAdapter,gatewayAdapter,openrouterAdapter];
 for(const adapter of adapters){
  vi.spyOn(adapter,'generate').mockImplementation(forbidden);vi.spyOn(adapter,'validate').mockImplementation(forbidden);
  if(adapter.converse)vi.spyOn(adapter,'converse').mockImplementation(forbidden);
  if(adapter.readImage)vi.spyOn(adapter,'readImage').mockImplementation(forbidden);
 }
 vi.stubGlobal('fetch',async()=>{networkAttempt();throw new Error('Network is outside this read test');});
 await resetDb();b=await seedBase();group={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
});
afterEach(()=>{expect(providerAttempt).not.toHaveBeenCalled();expect(networkAttempt).not.toHaveBeenCalled();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
afterAll(closeAll);

type Full=Awaited<ReturnType<typeof aiManagementView>>;
/** Independent visible-field contract: neither legacy run rows nor allowance details are banner inputs. */
function common(view:Full){return {spend:view.spend,features:view.features,agentSwitches:view.agentSwitches,policies:view.policies,
 userDefault:view.userDefault,companies:view.companies,companyUsage:view.companyUsage,usage:view.usage,attention:view.attention,
 groups:view.groups,provider:view.provider,mayWriteUsers:view.mayWriteUsers};}
function expectedPage(view:Full,section:AiManagementSection){return {...common(view),section,
 allowances:section==='allowances'?{users:view.users,moreUsers:view.moreUsers,legacyBudget:view.legacyBudget}:null};}
const classify=(text:string)=>text.includes('left join lateral(select count(*) filter')?'top-users'
 :text.includes('"assistant_budget"')?'legacy-budget'
 :text.includes('"ai_model_run"')&&text.includes('"finished_at"')?'legacy-recent-runs'
 :text.includes('select u.id,')&&text.includes('array(select r.role::text')?'user-memberships':'shared';
const classes=(queries:NativeReadQuery[])=>queries.map(q=>classify(q.sql));
async function observed<T>(read:()=>Promise<T>){const probe=observeNativeRead({classify}),start=performance.now();try{const value=await read();return {value,probe,elapsedMs:performance.now()-start};}finally{probe.restore();}}
async function login(name:string,role:'employee'|'hr_admin'='employee',personId?:string){
 const [row]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:name,personId}).returning();
 await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:row.id,role,companyId:null});return row.id;
}
async function usage(userId:string,state:'completed'|'pending'|'failed'|'blocked',reserved:number,actual:number|null,extra:Partial<typeof schema.aiModelRun.$inferInsert>={}){
 const [row]=await owner.db.insert(schema.aiModelRun).values({tenantId:b.tenantId,userId,companyIds:[b.companyId],featureId:'pay_rule_draft',operation:'draft',
  provider:'openai',model:'fictional-model',state,reservedTokens:reserved,actualTokens:actual,...extra}).returning();return row;
}
async function populated(){
 const hired=await hireEmployee(group,{person:{fullName:'Fictional Projection Heavy',primaryEmail:'projection-heavy@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const heavy=await login('projection-heavy','employee',hired.personId),quiet=await login('projection-quiet-zero'),off=await login('projection-off');
 await owner.db.insert(schema.appUser).values(Array.from({length:60},(_,i)=>({tenantId:b.tenantId,workosUserId:'aa-projection-light-'+String(i).padStart(3,'0')})));
 await usage(heavy,'completed',100,700);await usage(heavy,'pending',200,null);await usage(heavy,'failed',100,null);
 await usage(heavy,'blocked',5000,null,{reason:'daily_limit'});
 await setAiAllowance(group,{kind:'user_default',dailyRequests:null,monthlyTokens:2000,enabled:true});
 await setGroupAllowance(group,{kind:'group_role',subject:'employee',dailyRequests:null,monthlyTokens:900,enabled:true});
 await setAiAllowance(group,{kind:'user',subjectId:heavy,dailyRequests:10,monthlyTokens:1000,enabled:true});
 await setAiAllowance(group,{kind:'user',subjectId:quiet,dailyRequests:0,monthlyTokens:null,enabled:true});
 await setAiAllowance(group,{kind:'user',subjectId:off,dailyRequests:0,monthlyTokens:null,enabled:false});
 await setAiAllowance(group,{kind:'company',subjectId:b.companyId,dailyRequests:0,monthlyTokens:null,enabled:true});
 await owner.db.insert(schema.assistantBudget).values({tenantId:b.tenantId,monthlyTokenCeiling:12345,perUserDailyQuestions:7,effectiveFrom:todayInKualaLumpur()});
 return {heavy,quiet,off,hired};
}

it('preserves all eight group-admin page projections and removes only their unused native reads',async()=>{
 const f=await populated(),baseline=await observed(()=>aiManagementView(group));
 expect(baseline.value.users).toHaveLength(50);expect(baseline.value.moreUsers).toBe(true);expect(baseline.value.runs).toHaveLength(4);
 expect(baseline.value.legacyBudget).toMatchObject({monthly:12345,daily:7});
 expect(classes(baseline.probe.queries).filter(c=>c!=='shared')).toEqual(['top-users','user-memberships','legacy-recent-runs','legacy-budget']);
 for(const section of AI_MANAGEMENT_SECTIONS){
  const result=await observed(()=>aiManagementPageView(group,section));expect(result.value).toEqual(expectedPage(baseline.value,section));
  expect(result.value).not.toHaveProperty('runs');expect(result.value).not.toHaveProperty('runFilter');expect(result.value).not.toHaveProperty('users');
  expect(classes(result.probe.queries)).not.toContain('legacy-recent-runs');
  expect(classes(result.probe.queries).filter(c=>c==='top-users')).toHaveLength(section==='allowances'?1:0);
  expect(classes(result.probe.queries).filter(c=>c==='legacy-budget')).toHaveLength(section==='allowances'?1:0);
  expect(result.probe.queries.length).toBe(baseline.probe.queries.length-(section==='allowances'?1:3));
  const memberships=result.probe.queries.filter(q=>classify(q.sql)==='user-memberships');expect(memberships).toHaveLength(1);
  if(section!=='allowances'){expect(memberships[0].rows).toBe(2);expect(memberships[0].params).toContain(f.heavy);expect(memberships[0].params).toContain(f.quiet);}
  expect(baseline.probe.properties).toHaveLength(1);expect(result.probe.properties).toHaveLength(1);
  expect(result.probe.properties.every(p=>p.role==='ai_hr_app'&&p.isolation==='repeatable read'&&p.readOnly===true)).toBe(true);
  expect(result.probe.state).toEqual({active:0,maxActive:1});
 }
 expect(baseline.value.attention.users.map(u=>u.id)).toEqual([f.heavy,f.quiet]);
 expect(baseline.value.attention.companies.map(c=>c.id)).toContain(b.companyId);
});

it('preserves company-scoped projections without returning group users, runs or private spend inputs',async()=>{
 const f=await populated(),[otherCompany]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Outside Company'}).returning();
 await setAiAllowance(group,{kind:'company',subjectId:otherCompany.id,dailyRequests:0,monthlyTokens:null,enabled:true});
 const [u]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:'projection-company-admin'}).returning();
 await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:u.id,companyId:b.companyId,role:'hr_admin'});
 const ctx:SessionContext={...group,userId:u.id,grants:[{role:'hr_admin',companyId:b.companyId}]},baseline=await aiManagementView(ctx);
 expect(baseline.companies.map(c=>c.id)).toEqual([b.companyId]);expect(baseline.users).toEqual([]);expect(baseline.runs).toEqual([]);
 expect(baseline.attention.users).toEqual([]);expect(baseline.attention.blocked).toEqual([]);expect(baseline.spend).toBeNull();
 for(const section of AI_MANAGEMENT_SECTIONS){
  const result=await observed(()=>aiManagementPageView(ctx,section));expect(result.value).toEqual(expectedPage(baseline,section));
  expect(classes(result.probe.queries)).not.toContain('top-users');expect(classes(result.probe.queries)).not.toContain('legacy-recent-runs');
  expect(classes(result.probe.queries)).not.toContain('legacy-budget');
  const visible=JSON.stringify(result.value);
  expect(visible).not.toContain(otherCompany.id);expect(visible).not.toContain(f.heavy);expect(visible).not.toContain(f.quiet);
 }
 const page=await aiManagementPageView(ctx,'features');expect((await aiInventoryView(ctx,page)).scope).toBe('registry');expect(await aiManagementAlerts(ctx,page)).toEqual({status:'not_shown'});
});

it('completes group and scoped AI presentation while the tenant Access write lock is held',async()=>{
 await saveAiProviderConfig(group,{provider:'openai',model:'fictional-lock-test',apiKey:'fictional-lock-test-key',makeActive:true});
 await saveAiProviderConfig(group,{provider:'openrouter',model:'fictional/candidate',apiKey:'fictional-candidate-key',
  providerOptions:readOpenRouterOptions({version:1,routing:{allowedProviders:['approved-a']}})});
 await setAiSpendBudget(group,{kind:'tenant',monthlyUsd:'0',rootUsd:''});
 const [login]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:'projection-lock-scoped-admin'}).returning();
 await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:login.id,companyId:b.companyId,role:'hr_admin'});
 const scoped:SessionContext={...group,userId:login.id,grants:[{role:'hr_admin',companyId:b.companyId}]};
 const adminSnapshot=await aiManagementPageView(group,'overview'),scopedSnapshot=await aiManagementPageView(scoped,'allowances');
 const configSnapshot=await getAiConfigView(group);
 expect(configSnapshot.providers.find(provider=>provider.provider==='openrouter')).toMatchObject({candidateSaved:true,model:'fictional/candidate'});
 expect(adminSnapshot.spend?.budgets).toContainEqual({scopeKey:'tenant',monthlyNanos:'0',rootNanos:null});
 expect(scopedSnapshot.spend).toBeNull();
 expect(adminSnapshot.provider).toEqual({provider:'openai',model:'fictional-lock-test'});

 let deadline:ReturnType<typeof setTimeout>|undefined;
 let reads:Promise<unknown>|undefined;
 try{
  await withTenant(group,async tx=>{
   await lockAccessConfigurationTx(tx,b.tenantId);
   reads=Promise.all([aiManagementPageView(group,'overview'),aiManagementPageView(scoped,'allowances'),getAiConfigView(group)]);
   const timeout=new Promise<never>((_,reject)=>{
    deadline=setTimeout(()=>reject(new Error('AI presentation waited for the held Access lock')),4000);
   });
   expect(await Promise.race([reads,timeout])).toEqual([adminSnapshot,scopedSnapshot,configSnapshot]);
  });
 }finally{
  clearTimeout(deadline);
  await reads?.catch(()=>{});
 }

 // The read-only path cannot access the provider evaluation key or group-private projections as scoped HR.
 await expect(withTenant(group,tx=>tx.execute(sql`select * from app.ai_provider_evaluation_candidate_v1('openrouter')`),{readOnlySnapshot:true}))
  .rejects.toMatchObject({cause:{code:'P0001',message:'AI candidate unavailable'}});
 await expect(getAiConfigView(scoped)).rejects.toThrow('Only a current group-wide administrator');
 await expect(withTenant(scoped,tx=>tx.execute(sql`select app.ai_optional_spend_status()`),{readOnlySnapshot:true}))
  .rejects.toMatchObject({cause:{code:'P0001',message:'AI spend administration unavailable'}});
 await expect(withTenant(group,async tx=>{
  await tx.execute(sql`select set_config('app.agent_principal_id', ${randomUUID()}, true)`);
  return tx.execute(sql`select * from app.ai_provider_candidate_view_v1()`);
 },{readOnlySnapshot:true})).rejects.toMatchObject({cause:{code:'P0001',message:'AI candidate unavailable'}});
});

it('keeps zero and null caps, quiet zero-capped users, held tokens and switch attribution exact',async()=>{
 const f=await populated();await setModule(b.tenantId,'claims','active');await setAiFeature(group,'claims_triage',true);
 const page=await aiManagementPageView(group,'allowances');expect(page.section).toBe('allowances');
 if(page.section!=='allowances')throw new Error('Wrong page-purpose result');
 expect(page.allowances.users.find(u=>u.id===f.heavy)).toMatchObject({source:'individual',daily:{used:3,limit:10,level:null},tokens:{used:1000,limit:1000,level:'at'},recorded:700,held:300});
 expect(page.attention.users.find(u=>u.id===f.quiet)).toMatchObject({daily:{used:0,limit:0,level:'at'},tokens:{used:0,limit:null,level:null}});
 expect(page.attention.users.some(u=>u.id===f.off)).toBe(false);
 const baseline=await aiManagementView(group);expect(page.agentSwitches).toEqual(baseline.agentSwitches);expect(page.features).toEqual(baseline.features);
 expect(await aiManagementAlerts(group,page)).toEqual(await aiManagementAlerts(group,baseline));
 expect(await aiInventoryView(group,page)).toEqual(await aiInventoryView(group,baseline));
});

it('preserves default, role, company, department and individual allowance precedence in common attention',async()=>{
 const hired=await hireEmployee(group,{person:{fullName:'Fictional Tier Member',primaryEmail:'projection-tier@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const id=await login('projection-tier','employee',hired.personId);await usage(id,'completed',10,95);
 await setAiAllowance(group,{kind:'user_default',dailyRequests:null,monthlyTokens:100,enabled:true});
 const check=async(source:'default'|'group'|'individual',limit:number,kind?:string)=>{
  const full=await aiManagementView(group),row=full.users.find(u=>u.id===id)!;expect(row.source).toBe(source);expect(row.tokens.limit).toBe(limit);
  if(kind)expect(row.group?.kind).toBe(kind);
  for(const section of ['overview','features','allowances'] as const)expect(await aiManagementPageView(group,section)).toEqual(expectedPage(full,section));
 };
 await check('default',100);
 await setGroupAllowance(group,{kind:'group_role',subject:'employee',dailyRequests:null,monthlyTokens:90,enabled:true});await check('group',90,'group_role');
 await setGroupAllowance(group,{kind:'group_company',subject:b.companyId,dailyRequests:null,monthlyTokens:80,enabled:true});await check('group',80,'group_company');
 await setGroupAllowance(group,{kind:'group_department',subject:b.deptA,dailyRequests:null,monthlyTokens:70,enabled:true});await check('group',70,'group_department');
 await setAiAllowance(group,{kind:'user',subjectId:id,dailyRequests:null,monthlyTokens:60,enabled:true});await check('individual',60);
});

it('retains Kuala Lumpur day boundaries and reported zero versus missing observations in the actual run-history owner',async()=>{
 const [clock]=await owner.client`select date_trunc('day',now() at time zone 'Asia/Kuala_Lumpur') at time zone 'Asia/Kuala_Lumpur' as day_start`;
 const at=new Date(clock.day_start),before=new Date(at.getTime()-1);
 const zero=await usage(b.adminUserId,'completed',1,0,{provider:'openrouter',startedAt:at,openrouterAccountCostCredits:'0',observedRoundTripMs:12.5,providerObservationStatus:'reported'});
 const missing=await usage(b.adminUserId,'completed',1,null,{startedAt:before,providerObservationStatus:'missing'});
 const full=await aiManagementView(group),page=await aiManagementPageView(group,'runs');expect(page).toEqual(expectedPage(full,'runs'));
 const self=full.users.find(u=>u.id===b.adminUserId)!;expect(self.daily.used).toBe(1);
 const history=await aiRunHistory(group,{},{});expect(history.rows.find(r=>r.id===zero.id)).toMatchObject({reportedCredits:'0',actual:0,roundTripMs:12.5,observationStatus:'reported'});
 expect(history.rows.find(r=>r.id===missing.id)).toMatchObject({reportedCredits:null,actual:null,roundTripMs:null,observationStatus:'missing'});
 expect(full.runs.find(r=>r.id===zero.id)?.reportedCredits).toBe('0');expect(page).not.toHaveProperty('runs');
});

it('keeps stored encrypted-key usability and never falls back after stored-key decryption failure',async()=>{
 await saveAiProviderConfig(group,{provider:'openai',model:'fictional-projection-model',apiKey:'fictional-projection-key-never-sent',makeActive:true});
 let full=await aiManagementView(group);expect(full.provider).toEqual({provider:'openai',model:'fictional-projection-model'});
 for(const section of AI_MANAGEMENT_SECTIONS)expect(await aiManagementPageView(group,section)).toEqual(expectedPage(full,section));
 vi.stubEnv('OPENAI_API_KEY','fictional-fallback-must-not-hide-stored-key-failure');
 await owner.db.update(schema.aiProviderConfig).set({apiKeyCiphertext:'invalid-fictional-ciphertext'}).where(eq(schema.aiProviderConfig.tenantId,b.tenantId));
 full=await aiManagementView(group);expect(full.provider).toBeNull();
 for(const section of AI_MANAGEMENT_SECTIONS){const page=await aiManagementPageView(group,section);expect(page.provider).toBeNull();expect(page).toEqual(expectedPage(full,section));expect(JSON.stringify(page)).not.toContain('fictional-projection-key-never-sent');}
});

it('preserves optional USD allocation data including a configured zero cap',async()=>{
 await setAiSpendBudget(group,{kind:'tenant',monthlyUsd:'0',rootUsd:''});
 const full=await aiManagementView(group);expect(full.spend?.budgets).toContainEqual({scopeKey:'tenant',monthlyNanos:'0',rootNanos:null});
 for(const section of AI_MANAGEMENT_SECTIONS){const page=await aiManagementPageView(group,section);expect(page.spend).toEqual(full.spend);expect(await aiManagementAlerts(group,page)).toEqual(await aiManagementAlerts(group,full));}
});

it.each(['employee','foreign-tenant','mismatched-grants','revoked','archived','blocked'] as const)('refuses %s authority through every page purpose',async mode=>{
 let ctx:SessionContext={...group};
 if(mode==='employee')ctx={...group,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 if(mode==='foreign-tenant'){const foreign=await seedBase();ctx={...group,tenantId:foreign.tenantId};}
 if(mode==='mismatched-grants')ctx={...group,roles:['super_admin'],grants:[{role:'super_admin',companyId:null}]};
 if(mode==='revoked')await owner.db.delete(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,b.adminUserId));
 if(mode==='archived')await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,b.adminUserId));
 if(mode==='blocked'){
  const hired=await hireEmployee(group,{person:{fullName:'Fictional Blocked Administrator',primaryEmail:'projection-blocked@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  const userId=await createAppUser(b.tenantId,hired.personId,'hr_admin');ctx={...group,userId,personId:hired.personId};
  const date=new Date(todayInKualaLumpur()+'T00:00:00Z');date.setUTCDate(date.getUTCDate()-1);
  await terminateEmployment(group,{employmentId:hired.employmentId,terminationDate:date.toISOString().slice(0,10),terminationType:'voluntary'});
 }
 await expect(aiManagementView(ctx)).rejects.toThrow();
 for(const section of AI_MANAGEMENT_SECTIONS)await expect(aiManagementPageView(ctx,section)).rejects.toThrow();
});

it('refuses unknown page purposes before any database query and preserves its captured session',async()=>{
 const before=JSON.stringify(group),probe=observeNativeRead();
 try{for(const section of ['',null,{},'inventory','full'])await expect(aiManagementPageView(group,section as never)).rejects.toThrow('Unknown AI management section');}
 finally{probe.restore();}
 expect(probe.queries).toEqual([]);expect(probe.properties).toEqual([]);expect(JSON.stringify(group)).toBe(before);
});

it('captures the page session before asynchronous admission without observing later caller mutations',async()=>{
 await populated();const expected=await aiManagementPageView(group,'allowances');
 const ctx:SessionContext={...group,roles:group.roles?.slice(),grants:group.grants?.map(g=>({...g}))};
 const pending=aiManagementPageView(ctx,'allowances');ctx.tenantId=randomUUID();ctx.userId=randomUUID();ctx.roles=['employee'];ctx.grants=[{role:'employee',companyId:randomUUID()}];
 expect(await pending).toEqual(expected);
});

it('removes the all-login lateral query from a scaled non-Allowances read with exact native data parity',async()=>{
 const [initial]=await owner.client`select count(*)::int as logins from app_user where tenant_id=${b.tenantId}::uuid`;
 const f=await populated();await owner.db.insert(schema.appUser).values(Array.from({length:1000},(_,i)=>({tenantId:b.tenantId,workosUserId:'scaled-projection-'+String(i).padStart(4,'0')})));
 const [census]=await owner.client`select count(*)::int as logins from app_user where tenant_id=${b.tenantId}::uuid`;expect(census.logins).toBe(initial.logins+1063);
 // Balanced whole-read order reduces a simple warm-cache ordering bias; this is not browser/load p95 evidence.
 const firstFull=await observed(()=>aiManagementView(group)),firstPage=await observed(()=>aiManagementPageView(group,'features')),
  secondPage=await observed(()=>aiManagementPageView(group,'features')),secondFull=await observed(()=>aiManagementView(group));
 const baseline=firstFull,candidate=firstPage;
 expect(secondFull.value).toEqual(firstFull.value);expect(secondPage.value).toEqual(firstPage.value);
 expect(secondFull.probe.queries.length).toBe(firstFull.probe.queries.length);expect(secondPage.probe.queries.length).toBe(firstPage.probe.queries.length);
 expect(baseline.value.users).toHaveLength(50);expect(baseline.value.moreUsers).toBe(true);expect(candidate.value).toEqual(expectedPage(baseline.value,'features'));
 expect(baseline.value.users[0].id).toBe(f.heavy);expect(classes(baseline.probe.queries).filter(c=>c==='top-users')).toHaveLength(1);expect(classes(candidate.probe.queries)).not.toContain('top-users');
 expect(candidate.probe.queries.length).toBe(baseline.probe.queries.length-3);
 const beforeRows=baseline.probe.queries.reduce((n,q)=>n+(q.rows??0),0),afterRows=candidate.probe.queries.reduce((n,q)=>n+(q.rows??0),0);expect(afterRows).toBeLessThan(beforeRows);
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'ai-management-section-projection.json'),JSON.stringify({
  kind:'NATIVE_AI_MANAGEMENT_SECTION_COMPONENT_NOT_BROWSER_OR_RELEASE',releaseEligible:false,fictionalBulkLogins:1060,nativeTenantLoginRows:census.logins,
  exactCommonParity:true,fullUsers:baseline.value.users.length,fullMoreUsers:baseline.value.moreUsers,
  baselineStatements:baseline.probe.queries.length,candidateStatements:candidate.probe.queries.length,baselineRows:beforeRows,candidateRows:afterRows,
  baselineClasses:classes(baseline.probe.queries),candidateClasses:classes(candidate.probe.queries),providerCalls:providerAttempt.mock.calls.length,fetchCalls:networkAttempt.mock.calls.length,
  balancedArms:[{purpose:'full',elapsedMs:firstFull.elapsedMs,telemetry:firstFull.probe.telemetry()},{purpose:'page',elapsedMs:firstPage.elapsedMs,telemetry:firstPage.probe.telemetry()},{purpose:'page',elapsedMs:secondPage.elapsedMs,telemetry:secondPage.probe.telemetry()},{purpose:'full',elapsedMs:secondFull.elapsedMs,telemetry:secondFull.probe.telemetry()}],
 },null,2));
},120_000);
