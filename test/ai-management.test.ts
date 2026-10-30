/** TEST ONLY: synthetic privacy-review seam for this legacy allowance/counter suite. The new
 * disclosure assertion/consumption is isolated so every original quota, RLS, source, admission,
 * spend and durable unknown-usage/settlement control below remains real. Binding, transfer,
 * revocation, config provenance and provider egress stay real. Dedicated provider-privacy-request,
 * provider-data-review-gate and ai-private-analysis tests exercise actual disclosure refusal.
 * This fixture grants no production review status and admits no real provider data. */
vi.mock('../lib/ai/provider-privacy-request', async importActual => {
 const actual = await importActual<typeof import('../lib/ai/provider-privacy-request')>();
 return {...actual,assertProviderPrivacyRequest:()=>{},consumeProviderPrivacyRequest:()=>{}};
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import * as tenantDb from '../db/client';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { resolveActiveAiConfig } from '../core/ai-config';
import { bindAiSpendTaskTx } from '../core/ai-spend-task';
import type { AiFeatureId } from '../lib/ai/features';
import { aiManagementView, allowanceLevel, applyBulkAssistantAccess, clearGroupAllowance, setGroupAllowance, clearUserAllowance, parseAiAllowance, previewBulkAssistantAccess, setAiAllowance, setAiFeature, setAssistantPermission } from '../core/ai-management';
import { generateDraft, converse, readImage } from '../lib/ai';
import { openaiAdapter } from '../lib/ai/providers/openai';
import { askAssistant } from '../core/assistant';
import { hireEmployee } from '../core/org';
import { todayInKualaLumpur } from '../lib/hr-date';
import { setTenantSetting } from '../core/tenant-settings';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base:Base, group:SessionContext;
const cfg=async(context=group,feature:AiFeatureId='pay_rule_draft')=>{const resolved=await withTenant(context,tx=>resolveActiveAiConfig(tx,context,feature));if(!resolved)throw new Error('Missing fake fixture configuration');return resolved;};
const call=async(context=group,tokens:number|null=10,reserve=100)=>(await cfg(context)).governance!.run({operation:'draft',reservedTokens:reserve},async record=>{if(tokens!==null)record({inputTokens:tokens,outputTokens:0,cachedInputTokens:0});return 'draft';});
const limit=(kind:'company'|'user',id:string,daily:number|null,monthly:number|null,enabled=true)=>setAiAllowance(group,{kind,subjectId:id,dailyRequests:daily,monthlyTokens:monthly,enabled});
const runs=()=>owner.db.select().from(schema.aiModelRun).where(eq(schema.aiModelRun.tenantId,base.tenantId)).orderBy(schema.aiModelRun.startedAt,schema.aiModelRun.id);

beforeAll(migrateTestDb);
beforeEach(async()=>{vi.stubEnv('ANTHROPIC_API_KEY','');vi.stubEnv('OPENAI_API_KEY','never-a-real-key');vi.stubEnv('GOOGLE_API_KEY','');vi.stubEnv('GEMINI_API_KEY','');await resetDb();base=await seedBase();group={...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]};});
afterAll(async()=>{await closeAll();vi.unstubAllEnvs();});

describe('central AI allowance admission and durable accounting',()=>{
 it('serializes simultaneous calls at a daily user ceiling and counts blocked calls separately',async()=>{
  await limit('user',base.adminUserId,2,null);
  const result=await Promise.allSettled(Array.from({length:8},()=>call()));
  expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(2);
  const rows=await runs();expect(rows.filter(r=>r.state==='completed')).toHaveLength(2);expect(rows.filter(r=>r.state==='blocked')).toHaveLength(6);
  expect(rows.filter(r=>r.state==='completed').every(r=>r.actualTokens===10)).toBe(true);
 });
 it('holds unknown usage durably, including concurrent calls and changes to the cap',async()=>{
  await limit('company',base.companyId,null,150);
  const result=await Promise.allSettled(Array.from({length:6},()=>call(group,null)));
  expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const [pendingUsage]=(await runs()).filter(r=>r.state==='completed');expect(pendingUsage.actualTokens).toBeNull();expect(pendingUsage.reservedTokens).toBe(100);
  await limit('company',base.companyId,null,200);
  await expect(call(group,null)).resolves.toBe('draft');
  await expect(call(group,null)).rejects.toThrow('monthly');
 });
 it('applies company and user caps cumulatively and zero/paused controls before transport',async()=>{
  await limit('company',base.companyId,3,null);await limit('user',base.adminUserId,1,null);
  await call();await expect(call()).rejects.toThrow('daily');
  await limit('user',base.adminUserId,null,0);await expect(call()).rejects.toThrow('monthly');
  await limit('user',base.adminUserId,null,null,false);await expect(call()).rejects.toThrow('paused');
  await limit('user',base.adminUserId,null,null);await expect(call()).resolves.toBe('draft');
 });
 it('prevents calls through every gateway operation when paused, before the adapter is touched',async()=>{
  await setAiFeature(group,'pay_rule_draft',false);
  const draft=vi.spyOn(openaiAdapter,'generate'),chat=vi.spyOn(openaiAdapter,'converse'),image=vi.spyOn(openaiAdapter,'readImage');
  try{
   await expect(generateDraft(await cfg(),{system:'private instructions',prompt:'private employee text'})).rejects.toThrow('paused');
   await expect(converse(await cfg(),{system:['private instructions'],tools:[],turns:[{role:'user',content:'private text'}]})).rejects.toThrow('paused');
   const data=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082','hex');
   await expect(readImage(await cfg(),{data,mimeType:'image/png'})).rejects.toThrow('paused');
   expect(draft).not.toHaveBeenCalled();expect(chat).not.toHaveBeenCalled();expect(image).not.toHaveBeenCalled();
   const serialized=JSON.stringify(await runs());expect(serialized).not.toContain('private');expect(serialized).not.toContain('never-a-real-key');
  }finally{vi.restoreAllMocks();}
 });
 it('records provider-reported usage, retains failures without usage and does not silently free capacity',async()=>{
  const adapter=vi.spyOn(openaiAdapter,'generate').mockImplementation(async(_cfg,args)=>{args.onUsage?.({inputTokens:8,cachedInputTokens:4,outputTokens:2});return 'draft';});
  try{
   await expect(generateDraft(await cfg(),{system:'system',prompt:'prompt'})).resolves.toBe('draft');
   adapter.mockRejectedValueOnce(new Error('transport failed'));
   await expect(generateDraft(await cfg(),{system:'system',prompt:'prompt'})).rejects.toThrow();
   const rows=await runs();expect(rows.find(r=>r.state==='completed')?.actualTokens).toBe(14);const failed=rows.find(r=>r.state==='failed')!;expect(failed.actualTokens).toBeNull();expect(failed.reservedTokens).toBeGreaterThan(0);
  }finally{vi.restoreAllMocks();}
 });
 it('settles only the original actor’s pending admission, exactly once',async()=>{
  const [request]=await withTenant(group,tx=>tx.execute<{run_id:string}>(sql`select * from app.ai_admit('pay_rule_draft','draft','openai','fixture',100)`));
  const [other]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'other-fixture-actor'}).returning();
  const stranger:SessionContext={...group,userId:other.id,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  await expect(withTenant(stranger,tx=>tx.execute(sql`select app.ai_settle(${request.run_id}::uuid,true,0)`))).rejects.toThrow();
  expect((await runs())[0].state).toBe('pending');
  await withTenant(group,tx=>tx.execute(sql`select app.ai_settle(${request.run_id}::uuid,true,10)`));
  await expect(withTenant(group,tx=>tx.execute(sql`select app.ai_settle(${request.run_id}::uuid,true,0)`))).rejects.toThrow();
  expect((await runs())[0].actualTokens).toBe(10);
 });
 it('distinguishes reported zero tokens from absent usage and preserves an unsettled reservation',async()=>{
  await call(group,0);expect((await runs())[0].actualTokens).toBe(0);
  const prepared=await cfg();
  const original=tenantDb.withTenant;
  const write=vi.spyOn(tenantDb,'withTenant').mockImplementationOnce(original).mockRejectedValueOnce(new Error('private database failure'));
  try{await expect(prepared.governance!.run({operation:'draft',reservedTokens:100},async record=>{record({inputTokens:25,outputTokens:0,cachedInputTokens:0});return 'draft';})).rejects.toThrow('reservation remains held');}finally{write.mockRestore();}
  const pending=(await runs()).find(r=>r.state==='pending');expect(pending).toBeDefined();expect(pending?.actualTokens).toBeNull();expect(pending?.reservedTokens).toBe(100);
 });
 it('honors configured defaults, null fallbacks and platform restrictions in both status and admission',async()=>{
  await setModule(base.tenantId,'performance','active');
  await owner.db.delete(schema.tenantSetting).where(eq(schema.tenantSetting.key,'performance.ai_360_enabled'));
  vi.stubEnv('OPENAI_API_KEY','fixture-never-sent');
  try{
   const row=(await aiManagementView(group)).features.find(f=>f.id==='performance_360')!;expect(row.enabled).toBe(true);expect(row.state).toBe('ready');
   await owner.db.insert(schema.tenantSetting).values({tenantId:base.tenantId,key:'performance.ai_360_enabled',value:sql`'null'::jsonb`,source:'platform'});
   await expect((await cfg(group,'performance_360')).governance!.run({operation:'draft',reservedTokens:100},async()=> 'draft')).resolves.toBe('draft');
   await setModule(base.tenantId,'notifications','active');
   await setTenantSetting(group,{key:'notifications.readiness_nudge_enabled',value:true});
   vi.stubEnv('SETTING_KILL','notifications.readiness_nudge_enabled');
   expect((await aiManagementView(group)).features.find(f=>f.id==='readiness_reminders')?.state).toBe('restricted');
   // Readiness reminders are an autonomous workload: the product binds its native spend root before any
   // admission (core/readiness-nudge.ts). Drive that real path so the platform kill is what refuses it.
   const rooted=await withTenant(group,async tx=>{const resolved=await resolveActiveAiConfig(tx,group,'readiness_reminders');if(!resolved)throw new Error('Missing fake fixture configuration');return bindAiSpendTaskTx(tx,group,resolved,{kind:'readiness_template',gap:'no_bank_account',audience:'hr'});});
   await expect(rooted.governance!.run({operation:'draft',reservedTokens:100},async()=> 'must not run')).rejects.toThrow('paused');
  }finally{vi.unstubAllEnvs();}
 });
 it('does not mistake a provider and enabled switches for scheduled model admission',async()=>{
  for(const module of ['notifications','claims','payroll'])await setModule(base.tenantId,module as never,'active');
  await setTenantSetting(group,{key:'notifications.readiness_nudge_enabled',value:true});
  await setTenantSetting(group,{key:'claims.input_triage_enabled',value:true});
  await setTenantSetting(group,{key:'payroll.anomaly_hypotheses_enabled',value:true});
  const view=await aiManagementView(group);
  expect(view.provider).not.toBeNull();
  expect(view.features.find(f=>f.id==='readiness_reminders')).toMatchObject({enabled:true,state:'templates'});
  for(const id of ['claims_triage','payroll_hypotheses'])expect(view.features.find(f=>f.id===id)).toMatchObject({enabled:true,state:'scheduled'});
 });
 it('rechecks canonical switches rather than trusting a stale configuration',async()=>{
  await expect(withTenant(group,tx=>tx.insert(schema.aiControlPolicy).values({tenantId:base.tenantId,kind:'feature',scopeKey:'feature:performance_pm',featureId:'performance_pm',enabled:false}))).rejects.toThrow();
  await setTenantSetting(group,{key:'performance.ai_pm_enabled',value:true});
  const stale=await cfg(group,'performance_pm');
  await setTenantSetting(group,{key:'performance.ai_pm_enabled',value:false});
  await expect(stale.governance!.run({operation:'draft',reservedTokens:100},async()=> 'must not run')).rejects.toThrow('paused');
 });
 it('uses Malaysia day/month boundaries and keeps settlement assigned to the start period',async()=>{
  await owner.db.execute(sql`insert into ai_model_run(tenant_id,user_id,company_ids,feature_id,operation,provider,model,state,reserved_tokens,actual_tokens,started_at)
   values(${base.tenantId}::uuid,${base.adminUserId}::uuid,array[${base.companyId}::uuid],'pay_rule_draft','draft','openai','test-model','completed',100,1000,
   (date_trunc('month',now() at time zone 'Asia/Kuala_Lumpur') at time zone 'Asia/Kuala_Lumpur')-interval '1 second')`);
  await limit('user',base.adminUserId,1,100);
  await expect(call(group,10)).resolves.toBe('draft');
  await expect(call()).rejects.toThrow('daily');
  const [admission]=await withTenant(group,tx=>tx.execute<{run_id:string}>(sql`select * from app.ai_admit('report_insight','draft','openai','test-model',1)`));
  // Existing ceiling blocks admission; settlement cannot fabricate a completed/blocked request.
  await expect(withTenant(group,tx=>tx.execute(sql`select app.ai_settle(${admission.run_id}::uuid,true,1)`))).rejects.toThrow();
  const [clock]=await owner.db.execute<{myt:string;utc:string}>(sql`select to_char(date_trunc('day',now() at time zone 'Asia/Kuala_Lumpur') at time zone 'Asia/Kuala_Lumpur' at time zone 'UTC','HH24:MI') myt, to_char(date_trunc('day',now() at time zone 'UTC'),'HH24:MI') utc`);
  expect(clock.myt).toBe('16:00');expect(clock.utc).toBe('00:00');
 });
 it('never allows app-role counter editing or deleting history',async()=>{
  await call();
  await expect(withTenant(group,tx=>tx.delete(schema.aiModelRun))).rejects.toThrow();
  await expect(withTenant(group,tx=>tx.update(schema.aiModelRun).set({actualTokens:0}))).rejects.toThrow();
  await expect(withTenant(group,tx=>tx.execute(sql`truncate ai_model_run`))).rejects.toThrow();
  expect((await runs())[0].actualTokens).toBe(10);
 });
});

describe('scoped administration and inventory',()=>{
 it('allows a company administrator to edit only their company; exposes scoped totals without run rows',async()=>{
  const [other]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Other Company'}).returning();
  const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'scoped-admin'}).returning();
  await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId:base.companyId,role:'hr_admin'});
  const scoped:SessionContext={...group,userId:user.id,grants:[{role:'hr_admin',companyId:base.companyId}]};
  await setAiAllowance(scoped,{kind:'company',subjectId:base.companyId,dailyRequests:5,monthlyTokens:null,enabled:true});
  await expect(setAiAllowance(scoped,{kind:'company',subjectId:other.id,dailyRequests:0,monthlyTokens:null,enabled:true})).rejects.toThrow('scope');
  await expect(setAiAllowance(scoped,{kind:'user',subjectId:user.id,dailyRequests:0,monthlyTokens:null,enabled:true})).rejects.toThrow('group');
  await expect(setAiFeature(scoped,'hr_assistant',false)).rejects.toThrow('group');
  await expect(setAssistantPermission(scoped,user.id,true)).rejects.toThrow('group');
  await call(group,25);await call(scoped,10);
  const groupView=await aiManagementView(group);expect(groupView.companies).toHaveLength(2);expect(groupView.runs).toHaveLength(2);
  const view=await aiManagementView(scoped);expect(view.companies.map(c=>c.id)).toEqual([base.companyId]);expect(view.users).toEqual([]);expect(view.runs).toEqual([]);
  expect(view.companyUsage.every(r=>r.company_id===base.companyId)).toBe(true);expect(Number(view.companyUsage[0].monthly_tokens)).toBe(35);
  expect(Number(view.usage[0].daily_requests)).toBe(2);expect(JSON.stringify(view)).not.toContain(other.id);
  await expect(withTenant(scoped,tx=>tx.insert(schema.aiControlPolicy).values({tenantId:base.tenantId,kind:'company',scopeKey:`company:${other.id}`,subjectId:other.id,dailyRequests:0}))).rejects.toThrow();
 });
 it('charges an employee only for companies they can actually access',async()=>{
  const [other]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Unrelated Company'}).returning();
  const employment=await hireEmployee(group,{person:{fullName:'Scoped Employee',primaryEmail:'employee@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  const uid=await createAppUser(base.tenantId,employment.personId,'employee');
  const employee:SessionContext={...group,userId:uid,personId:employment.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  await limit('company',other.id,0,null);await limit('company',base.companyId,1,null);
  await expect(call(employee)).resolves.toBe('draft');
  const [record]=await runs();expect(record.companyIds).toEqual([base.companyId]);expect(record.userId).toBe(uid);
  await owner.db.update(schema.employment).set({terminatedOn:sql`current_date + 30`}).where(eq(schema.employment.personId,employment.personId));
  await expect(call(employee)).rejects.toThrow('daily');
 });
 it('uses the existing Assistant grant owner and reports an allowance refusal accurately',async()=>{
  expect((await aiManagementView(group)).users.find(u=>u.id===base.adminUserId)?.assistantGranted).toBe(false);
  await setAssistantPermission(group,base.adminUserId,true);
  expect((await aiManagementView(group)).users.find(u=>u.id===base.adminUserId)?.assistantGranted).toBe(true);
  await setModule(base.tenantId,'assistant','active');group={...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]};
  await limit('user',base.adminUserId,0,null);
  vi.stubEnv('OPENAI_API_KEY','fixture-never-sent');vi.stubEnv('ANTHROPIC_API_KEY','');vi.stubEnv('GOOGLE_API_KEY','');vi.stubEnv('GEMINI_API_KEY','');
  // The main Assistant question seals its strategy-use marker with the operator secret the customer environment
  // check requires; without it the marker fails closed before the allowance refusal this case observes.
  vi.stubEnv('AI_CONFIG_SECRET','fictional-allowance-marker-secret');
  const transport=vi.spyOn(openaiAdapter,'converse');
  try{await expect(askAssistant(group,{question:'show assistant capabilities'})).rejects.toMatchObject({code:'ai_control'});expect(transport).not.toHaveBeenCalled();}
  finally{vi.restoreAllMocks();vi.unstubAllEnvs();}
  await setAssistantPermission(group,base.adminUserId,false);
  expect((await aiManagementView(group)).users.find(u=>u.id===base.adminUserId)?.assistantGranted).toBe(false);
  const grants=await owner.db.select().from(schema.assistantGrant).where(eq(schema.assistantGrant.appUserId,base.adminUserId)).orderBy(schema.assistantGrant.grantedAt,schema.assistantGrant.id);expect(grants).toHaveLength(1);expect(grants[0].revokedAt).not.toBeNull();
 });
 it('rejects other tenants and ordinary users, including raw app-role writes',async()=>{
  const foreign=await seedBase();
  await expect(limit('company',foreign.companyId,0,null)).rejects.toThrow('scope');
  await expect(limit('user',foreign.adminUserId,0,null)).rejects.toThrow('scope');
  await expect(setAssistantPermission(group,foreign.adminUserId,true)).rejects.toThrow('scope');
  const employee:SessionContext={tenantId:base.tenantId,userId:base.adminUserId,roles:['employee'],grants:[{role:'employee',companyId:null}],entitlements:group.entitlements};
  await expect(aiManagementView(employee)).rejects.toThrow('administrators');
  await expect(setAiAllowance(employee,{kind:'company',subjectId:base.companyId,dailyRequests:1,monthlyTokens:null,enabled:true})).rejects.toThrow();
  await expect(withTenant(employee,tx=>tx.insert(schema.aiControlPolicy).values({tenantId:base.tenantId,kind:'user',scopeKey:`user:${base.adminUserId}`,subjectId:base.adminUserId,dailyRequests:0}))).rejects.toThrow();
  await expect(setAiFeature(group,'feedback_planning',false)).rejects.toThrow('platform');
 });
 it('validates allowance input and preserves zero versus no cap',()=>{
  expect(parseAiAllowance('',100)).toBeNull();expect(parseAiAllowance('0',100)).toBe(0);expect(parseAiAllowance('100',100)).toBe(100);
  for(const value of ['-1','1.5','NaN','Infinity','1e2','101'])expect(()=>parseAiAllowance(value,100)).toThrow();
 });
});

describe('tenant default user allowance, usage against limits and attention',()=>{
 const byDefault=(daily:number|null,monthly:number|null,enabled=true)=>setAiAllowance(group,{kind:'user_default',dailyRequests:daily,monthlyTokens:monthly,enabled});
 const login=async(name:string,role:'employee'|'hr_admin'='employee')=>{
  const [u]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:name}).returning();
  await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:u.id,role,companyId:null});
  return {id:u.id,ctx:{tenantId:base.tenantId,userId:u.id,roles:[role],grants:[{role,companyId:null}],entitlements:group.entitlements} as SessionContext};
 };
 const run=(userId:string|null,state:'completed'|'pending'|'failed'|'blocked',reserved:number,actual:number|null,feature='pay_rule_draft',reason:string|null=null)=>
  owner.db.insert(schema.aiModelRun).values({tenantId:base.tenantId,userId,companyIds:[base.companyId],featureId:feature,operation:'draft',provider:'openai',model:'fixture',state,reason,reservedTokens:reserved,actualTokens:actual});

 it('applies the default to every login without an individual policy; an individual policy replaces it rather than stacking',async()=>{
  const other=await login('default-governed');
  await byDefault(1,null);
  await call();await expect(call()).rejects.toThrow('daily');
  await call(other.ctx);await expect(call(other.ctx)).rejects.toThrow('daily');
  // Non-vacuous REPLACE: if the default still applied beside the individual policy, the second call would be refused.
  await limit('user',base.adminUserId,3,null);
  await expect(call()).resolves.toBe('draft');await expect(call()).resolves.toBe('draft');await expect(call()).rejects.toThrow('daily');
  // A stricter individual policy also wins over a looser default.
  await byDefault(100,null);await limit('user',base.adminUserId,null,0);await expect(call()).rejects.toThrow('monthly');
  await expect(call(other.ctx)).resolves.toBe('draft');
  // Use default: the login returns to the default; the removal keeps the change history.
  await clearUserAllowance(group,base.adminUserId);await expect(call()).resolves.toBe('draft');
  await expect(clearUserAllowance(group,base.adminUserId)).rejects.toThrow('already follows');
  const events=await owner.db.execute<{event_type:string}>(sql`select event_type from domain_event where tenant_id=${base.tenantId}::uuid and aggregate_type='ai-control' order by occurred_at,id`);
  expect(Array.from(events).map(e=>e.event_type)).toContain('ai-control.allowance-cleared');
  await byDefault(null,null,false);await expect(call(other.ctx)).rejects.toThrow('paused');
 });
 it('leaves calls without a login and other tenants untouched by the default',async()=>{
  await byDefault(0,0,false);
  await expect(call()).rejects.toThrow('paused');
  await expect(call({...group,userId:undefined})).rejects.toThrow('Current AI calling authority');
  const foreign=await seedBase();const foreignGroup:SessionContext={...adminCtx(foreign),grants:[{role:'hr_admin',companyId:null}]};
  await expect(call(foreignGroup)).resolves.toBe('draft');
 });
 it('refuses the default to company administrators, by service and by raw app-role write, and never removes non-user policies',async()=>{
  const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'scoped-admin'}).returning();
  await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId:base.companyId,role:'hr_admin'});
  const scoped:SessionContext={...group,userId:user.id,grants:[{role:'hr_admin',companyId:base.companyId}]};
  await expect(setAiAllowance(scoped,{kind:'user_default',dailyRequests:0,monthlyTokens:null,enabled:true})).rejects.toThrow('group');
  await expect(withTenant(scoped,tx=>tx.insert(schema.aiControlPolicy).values({tenantId:base.tenantId,kind:'user_default',scopeKey:'user_default',dailyRequests:0}))).rejects.toMatchObject({cause:{code:'42501'}});
  await byDefault(5,null);
  // RLS hides nothing here (every login may read the default) but the write policy still refuses the update.
  expect(await withTenant(scoped,tx=>tx.update(schema.aiControlPolicy).set({dailyRequests:0}).where(eq(schema.aiControlPolicy.scopeKey,'user_default')).returning())).toEqual([]);
  expect(await withTenant(scoped,tx=>tx.delete(schema.aiControlPolicy).where(eq(schema.aiControlPolicy.scopeKey,'user_default')).returning())).toEqual([]);
  const [stored]=await owner.db.select().from(schema.aiControlPolicy).where(eq(schema.aiControlPolicy.scopeKey,'user_default'));expect(stored.dailyRequests).toBe(5);
  await limit('user',user.id,1,null);
  await expect(clearUserAllowance(scoped,user.id)).rejects.toThrow('group');
  expect(await withTenant(scoped,tx=>tx.delete(schema.aiControlPolicy).where(eq(schema.aiControlPolicy.scopeKey,`user:${user.id}`)).returning())).toEqual([]);
  await limit('company',base.companyId,1,null);
  await expect(withTenant(group,tx=>tx.delete(schema.aiControlPolicy).where(eq(schema.aiControlPolicy.scopeKey,`company:${base.companyId}`)))).rejects.toMatchObject({cause:{message:expect.stringContaining('individual user')}});
  await expect(withTenant(group,tx=>tx.delete(schema.aiControlPolicy).where(eq(schema.aiControlPolicy.scopeKey,'user_default')))).rejects.toMatchObject({cause:{message:expect.stringContaining('individual user')}});
  // The table shape admits exactly one subject-less default.
  await expect(owner.db.insert(schema.aiControlPolicy).values({tenantId:base.tenantId,kind:'user_default',scopeKey:`user_default`,subjectId:user.id})).rejects.toMatchObject({cause:{code:'23514'}});
  await expect(owner.db.insert(schema.aiControlPolicy).values({tenantId:base.tenantId,kind:'user_default',scopeKey:'user:default'})).rejects.toMatchObject({cause:{code:'23514'}});
 });
 it('shows usage against the cap exactly as admission counts it, including held reservations',async()=>{
  expect(allowanceLevel(39,50)).toBeNull();expect(allowanceLevel(40,50)).toBe('near');expect(allowanceLevel(50,50)).toBe('at');expect(allowanceLevel(0,0)).toBe('at');expect(allowanceLevel(10,null)).toBeNull();
  await run(base.adminUserId,'completed',100,700);await run(base.adminUserId,'pending',200,null);await run(base.adminUserId,'failed',100,null);await run(base.adminUserId,'blocked',5000,null,'pay_rule_draft','monthly_limit');
  await limit('user',base.adminUserId,10,1000);
  let me=(await aiManagementView(group)).users.find(u=>u.id===base.adminUserId)!;
  expect(me.tokens).toEqual({used:1000,limit:1000,level:'at'});expect(me.held).toBe(300);expect(me.recorded).toBe(700);expect(me.daily).toEqual({used:3,limit:10,level:null});expect(me.source).toBe('individual');
  await expect(call(group,1,1)).rejects.toThrow('monthly');
  await limit('user',base.adminUserId,10,1200);
  me=(await aiManagementView(group)).users.find(u=>u.id===base.adminUserId)!;expect(me.tokens.level).toBe('near');
  await expect(call(group,1,100)).resolves.toBe('draft');
  await limit('company',base.companyId,5,null);
  const view=await aiManagementView(group);const [co]=view.companies;
  expect(co.daily).toEqual({used:4,limit:5,level:'near'});expect(co.tokens.limit).toBeNull();expect(view.attention.companies.map(c=>c.id)).toEqual([base.companyId]);
 });
 it('lists a login paused by its own zero cap in attention even before it makes a call, and not one paused by its switch',async()=>{
  const quiet=await login('quiet-zero');const switched=await login('quiet-switched');const capped=await login('quiet-capped');
  await limit('user',quiet.id,0,null);await setAiAllowance(group,{kind:'user',subjectId:switched.id,dailyRequests:0,monthlyTokens:null,enabled:false});await limit('user',capped.id,5,null);
  const view=await aiManagementView(group);
  // Independent expectation: only the enabled login with a zero cap, and none of them has a run this month.
  expect(view.attention.users.map(u=>u.id)).toEqual([quiet.id]);
  expect(view.attention.users[0]).toMatchObject({label:'quiet-zero',daily:{used:0,limit:0}});
 });
 it('sorts heavy users first and finds them beyond the first fifty names, with attention for near limits and blocks today',async()=>{
  for(let i=0;i<55;i++)await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:`aa-light-${String(i).padStart(2,'0')}`});
  const heavy=await login('zz-heavy');const medium=await login('zz-medium');
  await run(heavy.id,'completed',100,9000);await run(medium.id,'completed',100,500);await run(heavy.id,'blocked',100,null,'pay_rule_draft','daily_limit');
  await byDefault(null,10000);
  const view=await aiManagementView(group);
  expect(view.users.slice(0,2).map(u=>u.id)).toEqual([heavy.id,medium.id]);expect(view.moreUsers).toBe(true);
  expect(view.users[0]).toMatchObject({source:'default',tokens:{used:9000,limit:10000,level:'near'}});
  expect(view.attention.users.map(u=>u.id)).toEqual([heavy.id]);
  expect(view.attention.blocked).toEqual([{id:heavy.id,label:'zz-heavy',count:1,reason:'daily_limit'}]);
  expect((await aiManagementView(group,'medium')).users.map(u=>u.id)).toEqual([medium.id]);
 });
 it('keeps attention scoped: company administrators see only their companies and no login identities',async()=>{
  const [other]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Other Company'}).returning();
  const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'scoped-admin'}).returning();
  await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId:base.companyId,role:'hr_admin'});
  const scoped:SessionContext={...group,userId:user.id,grants:[{role:'hr_admin',companyId:base.companyId}]};
  await limit('company',base.companyId,1,null);await limit('company',other.id,1,null);await byDefault(1,null);
  await call();await expect(call()).rejects.toThrow('daily');
  const groupView=await aiManagementView(group);
  expect(groupView.attention.companies.map(c=>c.id).sort()).toEqual([base.companyId,other.id].sort());
  expect(groupView.attention.blocked.map(b=>b.id)).toEqual([base.adminUserId]);expect(groupView.attention.users.map(u=>u.id)).toEqual([base.adminUserId]);
  const view=await aiManagementView(scoped);
  expect(view.attention.companies.map(c=>c.id)).toEqual([base.companyId]);expect(view.attention.users).toEqual([]);expect(view.attention.blocked).toEqual([]);expect(view.users).toEqual([]);
  const serialized=JSON.stringify(view.attention)+JSON.stringify(view.companies);expect(serialized).not.toContain(other.id);expect(serialized).not.toContain(base.adminUserId);
 });
 it('lists a company paused by a configured zero cap before any attempt, but not one paused by its switch or without a cap',async()=>{
  // Walkthrough 28 October 2026: a company with a zero daily cap blocks every call, and blocked calls never
  // count as usage, so the old "usage above zero" rule could never list it.
  const [switchedOff]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Switched Off Company'}).returning();
  const [noConcurrency]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Zero Concurrency Company'}).returning();
  expect((await aiManagementView(group)).attention.companies).toEqual([]);
  await limit('company',base.companyId,0,null);await limit('company',switchedOff.id,0,null,false);
  await setAiAllowance(group,{kind:'company',subjectId:noConcurrency.id,dailyRequests:null,monthlyTokens:null,maxConcurrent:0,enabled:true});
  const view=await aiManagementView(group);
  expect(view.attention.companies.map(c=>c.id).sort()).toEqual([base.companyId,noConcurrency.id].sort());
  expect(view.attention.companies.find(c=>c.id===base.companyId)!.daily).toEqual({used:0,limit:0,level:'at'});
  await limit('company',base.companyId,null,null);
  expect((await aiManagementView(group)).attention.companies.map(c=>c.id)).toEqual([noConcurrency.id]);
 });
 it('filters recent runs by blocked, failed and capability for group administrators only',async()=>{
  await run(base.adminUserId,'completed',100,10);await run(base.adminUserId,'failed',100,null,'report_insight');await run(null,'blocked',100,null,'report_insight','paused');await run(base.adminUserId,'blocked',100,null,'pay_rule_draft','daily_limit');
  expect((await aiManagementView(group)).runs).toHaveLength(4);
  expect((await aiManagementView(group,'',{state:'blocked'})).runs.map(r=>r.state)).toEqual(['blocked','blocked']);
  expect((await aiManagementView(group,'',{state:'failed'})).runs.map(r=>r.feature)).toEqual(['report_insight']);
  expect((await aiManagementView(group,'',{feature:'report_insight'})).runs).toHaveLength(2);
  expect((await aiManagementView(group,'',{state:'blocked',feature:'report_insight'})).runs.map(r=>r.reason)).toEqual(['paused']);
  const scoped:SessionContext={...group,grants:[{role:'hr_admin',companyId:base.companyId}]};
  expect((await aiManagementView(scoped,'',{state:'blocked'})).runs).toEqual([]);
 });
});



describe('current calling-login authority for AI control writes', () => {
 it.each(['feature', 'allowance', 'clear', 'setting'] as const)('refuses an archived administrator before %s effects', async operation => {
  await setAiAllowance(group, { kind: 'user', subjectId: base.adminUserId, dailyRequests: 3, monthlyTokens: 100, enabled: true });
  const before = await owner.db.select().from(schema.aiControlPolicy);
  const beforeSettings = await owner.db.select().from(schema.tenantSetting);
  const beforeEvents = await owner.db.select().from(schema.domainEvent);
  await owner.db.update(schema.appUser).set({ archivedAt: new Date() }).where(eq(schema.appUser.id, base.adminUserId));
  const command = operation === 'feature' ? () => setAiFeature(group, 'hr_assistant', false)
   : operation === 'setting' ? () => setAiFeature(group, 'claims_triage', false)
   : operation === 'clear' ? () => clearUserAllowance(group, base.adminUserId)
   : () => setAiAllowance(group, { kind: 'user', subjectId: base.adminUserId, dailyRequests: 0, monthlyTokens: 0, enabled: false });
  await expect(command()).rejects.toThrow();
  expect(await owner.db.select().from(schema.aiControlPolicy)).toEqual(before);
  expect(await owner.db.select().from(schema.tenantSetting)).toEqual(beforeSettings);
  expect(await owner.db.select().from(schema.domainEvent)).toEqual(beforeEvents);
  expect(await runs()).toEqual([]);
 });
});

describe('bulk HR assistant access',()=>{
 const hire=async(name:string,departmentId:string)=>{const employment=await hireEmployee(group,{person:{fullName:name,primaryEmail:`${name.toLowerCase().replace(/[^a-z]/g,'')}@fixture.test`},companyId:base.companyId,departmentId,employmentType:'full_time',hiredOn:todayInKualaLumpur()});return createAppUser(base.tenantId,employment.personId,'employee');};
 const login=async(name:string,role:'employee'|'manager'='employee')=>{const [u]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:name}).returning();await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:u.id,role,companyId:null});return {id:u.id};};
 const live=async()=>Array.from(await owner.db.execute<{app_user_id:string}>(sql`select app_user_id from assistant_grant where tenant_id=${base.tenantId}::uuid and revoked_at is null order by app_user_id`)).map(r=>r.app_user_id);
 const events=async(type:string)=>Array.from(await owner.db.execute<{payload:Record<string,unknown>}>(sql`select payload from domain_event where tenant_id=${base.tenantId}::uuid and event_type=${type} order by occurred_at,id`)).map(r=>r.payload);
 it('previews, then grants a whole department with one bulk event and one event per person',async()=>{
  const a1=await hire('Bulk Alpha One',base.deptA),a2=await hire('Bulk Alpha Two',base.deptA),b1=await hire('Bulk Beta One',base.deptB);
  const scope={kind:'department',departmentId:base.deptA};
  // Independent expectation: exactly the two people hired into department A.
  expect(await previewBulkAssistantAccess(group,scope,true)).toEqual({matched:2,changing:2});
  await expect(applyBulkAssistantAccess(group,scope,true,3)).rejects.toThrow('changed since you reviewed');
  expect(await live()).toEqual([]);
  expect(await applyBulkAssistantAccess(group,scope,true,2)).toEqual({changed:2});
  expect(await live()).toEqual([a1,a2].sort());expect(await live()).not.toContain(b1);
  expect((await events('assistant-grant.granted')).map(p=>p.appUserId).sort()).toEqual([a1,a2].sort());
  expect(await events('assistant-grant.bulk-granted')).toEqual([{scope,changed:2}]);
  // Already granted: nothing changes, and a confirmation of zero writes no per-person event.
  expect(await previewBulkAssistantAccess(group,scope,true)).toEqual({matched:2,changing:0});
 });
 it('revokes by role and by explicit list, leaving other people untouched',async()=>{
  const m=await login('bulk-manager','manager'),e=await login('bulk-employee');
  await setAssistantPermission(group,m.id,true);await setAssistantPermission(group,e.id,true);
  expect(await previewBulkAssistantAccess(group,{kind:'role',role:'manager'},false)).toEqual({matched:1,changing:1});
  await applyBulkAssistantAccess(group,{kind:'role',role:'manager'},false,1);
  expect(await live()).toEqual([e.id]);
  await applyBulkAssistantAccess(group,{kind:'users',userIds:[e.id,m.id]},false,1);
  expect(await live()).toEqual([]);
  expect((await events('assistant-grant.bulk-revoked')).map(p=>p.changed)).toEqual([1,1]);
 });
 it('matches a search only inside the tenant and refuses company administrators and malformed scopes',async()=>{
  const mine=await login('zz-search-target');const foreign=await seedBase();
  await owner.db.insert(schema.appUser).values({tenantId:foreign.tenantId,workosUserId:'zz-search-target-foreign'});
  expect(await previewBulkAssistantAccess(group,{kind:'search',q:'zz-search'},true)).toEqual({matched:1,changing:1});
  await applyBulkAssistantAccess(group,{kind:'search',q:'zz-search'},true,1);expect(await live()).toEqual([mine.id]);
  const scoped:SessionContext={...group,grants:[{role:'hr_admin',companyId:base.companyId}]};
  await expect(previewBulkAssistantAccess(scoped,{kind:'role',role:'employee'},true)).rejects.toThrow('group administrator');
  await expect(applyBulkAssistantAccess(scoped,{kind:'role',role:'employee'},true,0)).rejects.toThrow('group administrator');
  for(const bad of [{kind:'role',role:'operator'},{kind:'company',companyId:'not-a-uuid'},{kind:'users',userIds:[]},{kind:'search',q:'  '},{kind:'everyone'}])await expect(previewBulkAssistantAccess(group,bad,true)).rejects.toThrow('Choose who');
 });
});

describe('group allowances (0662): individual, then department, company, role, then default',()=>{
 const person=async(name:string,departmentId:string,role:'employee'|'manager'='employee')=>{
  const employment=await hireEmployee(group,{person:{fullName:name,primaryEmail:`${name.toLowerCase().replace(/[^a-z]/g,'')}@fixture.test`},companyId:base.companyId,departmentId,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  const id=await createAppUser(base.tenantId,employment.personId,role);
  return {id,ctx:{tenantId:base.tenantId,userId:id,personId:employment.personId,roles:[role],grants:[{role,companyId:null}],entitlements:group.entitlements} as SessionContext};
 };
 const groupLimit=(kind:string,subject:string,daily:number|null)=>setGroupAllowance(group,{kind,subject,dailyRequests:daily,monthlyTokens:null,enabled:true});
 it('applies the most specific matching tier, ignoring looser ones, and the strictest row within a tier',async()=>{
  const a=await person('Group Alpha',base.deptA);
  await setAiAllowance(group,{kind:'user_default',dailyRequests:100,monthlyTokens:null,enabled:true});
  await groupLimit('group_role','employee',5);await groupLimit('group_company',base.companyId,3);await groupLimit('group_department',base.deptA,1);
  // Department (1/day) wins over company (3) and role (5); the default (100) is not consulted.
  await expect(call(a.ctx)).resolves.toBe('draft');await expect(call(a.ctx)).rejects.toThrow('daily');
  await clearGroupAllowance(group,{kind:'group_department',subject:base.deptA});
  // Company tier next: two more calls today (3 in total), then refused.
  await expect(call(a.ctx)).resolves.toBe('draft');await expect(call(a.ctx)).resolves.toBe('draft');await expect(call(a.ctx)).rejects.toThrow('daily');
  // An individual allowance replaces every group.
  await setAiAllowance(group,{kind:'user',subjectId:a.id,dailyRequests:10,monthlyTokens:null,enabled:true});
  await expect(call(a.ctx)).resolves.toBe('draft');
 });
 it('counts each login separately under the same group, and binds the strictest of two matching role groups',async()=>{
  const one=await person('Group Beta One',base.deptB),two=await person('Group Beta Two',base.deptB,'manager');
  await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:two.id,role:'employee',companyId:null});
  await groupLimit('group_role','employee',2);await groupLimit('group_role','manager',1);
  await expect(call(one.ctx)).resolves.toBe('draft');await expect(call(one.ctx)).resolves.toBe('draft');await expect(call(one.ctx)).rejects.toThrow('daily');
  // The manager-and-employee login: both role rows bind, so the stricter one (1) stops the second call.
  await expect(call(two.ctx)).resolves.toBe('draft');await expect(call(two.ctx)).rejects.toThrow('daily');
  const view=await aiManagementView(group,'Group Beta');
  expect(view.users.find(u=>u.id===two.id)).toMatchObject({source:'group',daily:{limit:1}});
  expect(view.users.find(u=>u.id===one.id)).toMatchObject({source:'group',daily:{limit:2}});
 });
 it('falls back to the default when the group is removed, and refuses company administrators, unknown scopes and outside subjects',async()=>{
  const c=await person('Group Gamma',base.deptA);
  await setAiAllowance(group,{kind:'user_default',dailyRequests:1,monthlyTokens:null,enabled:true});
  await groupLimit('group_department',base.deptA,5);await clearGroupAllowance(group,{kind:'group_department',subject:base.deptA});
  await expect(call(c.ctx)).resolves.toBe('draft');await expect(call(c.ctx)).rejects.toThrow('daily');
  const scoped:SessionContext={...group,grants:[{role:'hr_admin',companyId:base.companyId}]};
  await expect(setGroupAllowance(scoped,{kind:'group_company',subject:base.companyId,dailyRequests:1,monthlyTokens:null,enabled:true})).rejects.toThrow('group administrator');
  await expect(withTenant(scoped,tx=>tx.insert(schema.aiControlPolicy).values({tenantId:base.tenantId,kind:'group_company',subjectId:base.companyId,scopeKey:`group_company:${base.companyId}`,dailyRequests:0}))).rejects.toMatchObject({cause:{code:'42501'}});
  const foreign=await seedBase();
  await expect(groupLimit('group_company',foreign.companyId,1)).rejects.toThrow('outside your administrative scope');
  for(const [kind,subject] of [['group_role','operator'],['group_company','not-a-uuid'],['group_everyone','x']])await expect(groupLimit(kind,subject,1)).rejects.toThrow('Unknown allowance scope');
  await expect(owner.db.insert(schema.aiControlPolicy).values({tenantId:base.tenantId,kind:'group_role',scopeKey:'group_role:operator'})).rejects.toMatchObject({cause:{code:'23514'}});
  const events=Array.from(await owner.db.execute<{event_type:string;payload:{kind:string}}>(sql`select event_type,payload from domain_event where tenant_id=${base.tenantId}::uuid and aggregate_type='ai-control' and payload->>'kind' like 'group_%' order by occurred_at,id`));
  expect(events.map(e=>e.event_type)).toEqual(['ai-control.allowance-changed','ai-control.allowance-cleared']);
 });
});
