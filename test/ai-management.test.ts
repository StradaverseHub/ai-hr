import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import * as tenantDb from '../db/client';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { governedAiConfig } from '../core/ai-governance';
import { aiManagementView, parseAiAllowance, setAiAllowance, setAiFeature, setAssistantPermission } from '../core/ai-management';
import { generateDraft, converse, readImage } from '../lib/ai';
import { openaiAdapter } from '../lib/ai/providers/openai';
import { askAssistant } from '../core/assistant';
import { hireEmployee } from '../core/org';
import { todayInKualaLumpur } from '../lib/hr-date';
import { setTenantSetting } from '../core/tenant-settings';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base:Base, group:SessionContext;
const cfg=()=>governedAiConfig(group,{provider:'openai',model:'test-model',apiKey:'never-a-real-key'},'pay_rule_draft');
const call=(context=group,tokens:number|null=10,reserve=100)=>governedAiConfig(context,{provider:'openai',model:'test-model',apiKey:'never-a-real-key'},'pay_rule_draft').governance!.run({operation:'draft',reservedTokens:reserve},async record=>{if(tokens!==null)record({inputTokens:tokens,outputTokens:0,cachedInputTokens:0});return 'draft';});
const limit=(kind:'company'|'user',id:string,daily:number|null,monthly:number|null,enabled=true)=>setAiAllowance(group,{kind,subjectId:id,dailyRequests:daily,monthlyTokens:monthly,enabled});
const runs=()=>owner.db.select().from(schema.aiModelRun).where(eq(schema.aiModelRun.tenantId,base.tenantId)).orderBy(schema.aiModelRun.startedAt,schema.aiModelRun.id);

beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();base=await seedBase();group={...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]};});
afterAll(closeAll);

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
   await expect(generateDraft(cfg(),{system:'private instructions',prompt:'private employee text'})).rejects.toThrow('paused');
   await expect(converse(cfg(),{system:['private instructions'],tools:[],turns:[{role:'user',content:'private text'}]})).rejects.toThrow('paused');
   const data=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082','hex');
   await expect(readImage(cfg(),{data,mimeType:'image/png'})).rejects.toThrow('paused');
   expect(draft).not.toHaveBeenCalled();expect(chat).not.toHaveBeenCalled();expect(image).not.toHaveBeenCalled();
   const serialized=JSON.stringify(await runs());expect(serialized).not.toContain('private');expect(serialized).not.toContain('never-a-real-key');
  }finally{vi.restoreAllMocks();}
 });
 it('records provider-reported usage, retains failures without usage and does not silently free capacity',async()=>{
  const adapter=vi.spyOn(openaiAdapter,'generate').mockImplementation(async(_cfg,args)=>{args.onUsage?.({inputTokens:8,cachedInputTokens:4,outputTokens:2});return 'draft';});
  try{
   await expect(generateDraft(cfg(),{system:'system',prompt:'prompt'})).resolves.toBe('draft');
   adapter.mockRejectedValueOnce(new Error('transport failed'));
   await expect(generateDraft(cfg(),{system:'system',prompt:'prompt'})).rejects.toThrow();
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
  const original=tenantDb.withTenant;
  const write=vi.spyOn(tenantDb,'withTenant').mockImplementationOnce(original).mockRejectedValueOnce(new Error('private database failure'));
  try{await expect(call(group,25)).rejects.toThrow('reservation remains held');}finally{write.mockRestore();}
  const pending=(await runs()).find(r=>r.state==='pending');expect(pending).toBeDefined();expect(pending?.actualTokens).toBeNull();expect(pending?.reservedTokens).toBe(100);
 });
 it('honors configured defaults, null fallbacks and platform restrictions in both status and admission',async()=>{
  await setModule(base.tenantId,'performance','active');
  await owner.db.delete(schema.tenantSetting).where(eq(schema.tenantSetting.key,'performance.ai_360_enabled'));
  vi.stubEnv('OPENAI_API_KEY','fixture-never-sent');
  try{
   const row=(await aiManagementView(group)).features.find(f=>f.id==='performance_360')!;expect(row.enabled).toBe(true);expect(row.state).toBe('ready');
   await owner.db.insert(schema.tenantSetting).values({tenantId:base.tenantId,key:'performance.ai_360_enabled',value:sql`'null'::jsonb`,source:'platform'});
   await expect(governedAiConfig(group,{provider:'openai',model:'fixture',apiKey:'never-sent'},'performance_360').governance!.run({operation:'draft',reservedTokens:100},async()=> 'draft')).resolves.toBe('draft');
   await setModule(base.tenantId,'notifications','active');
   await setTenantSetting(group,{key:'notifications.readiness_nudge_enabled',value:true});
   vi.stubEnv('SETTING_KILL','notifications.readiness_nudge_enabled');
   expect((await aiManagementView(group)).features.find(f=>f.id==='readiness_reminders')?.state).toBe('restricted');
   await expect(governedAiConfig(group,{provider:'openai',model:'fixture',apiKey:'never-sent'},'readiness_reminders').governance!.run({operation:'draft',reservedTokens:100},async()=> 'must not run')).rejects.toThrow('paused');
  }finally{vi.unstubAllEnvs();}
 });
 it('rechecks canonical switches rather than trusting a stale configuration',async()=>{
  await expect(withTenant(group,tx=>tx.insert(schema.aiControlPolicy).values({tenantId:base.tenantId,kind:'feature',scopeKey:'feature:performance_pm',featureId:'performance_pm',enabled:false}))).rejects.toThrow();
  await setTenantSetting(group,{key:'performance.ai_pm_enabled',value:true});
  const stale=governedAiConfig(group,{provider:'openai',model:'test-model',apiKey:'never-a-real-key'},'performance_pm');
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
  const transport=vi.spyOn(openaiAdapter,'converse');
  try{await expect(askAssistant(group,{question:'What can you help with?'})).rejects.toMatchObject({code:'ai_control'});expect(transport).not.toHaveBeenCalled();}
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
