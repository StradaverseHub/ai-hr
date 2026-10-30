/** Actual app-role source reads. No provider transport, key/configuration lookup or business effect
 * is needed to explain the three scheduled-agent switches. Authored for GitHub Actions only. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import * as providerConfig from '../core/ai-config';
import {assistantAgentStatusTx,ASSISTANT_AGENT_MANAGEMENT_HREF} from '../core/ai-management';
import {setTenantSetting} from '../core/tenant-settings';
import {grantAssistant} from '../core/assistant-grant';
import {withAssistantRead} from '../core/assistant-read-session';
import {hireEmployee} from '../core/org';
import {presentCanonicalModuleData} from '../lib/ai/module-job-presentation';
import {AI_FEATURES} from '../lib/ai/features';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base,group:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();base=await seedBase();for(const module of ['assistant','notifications','claims','payroll'])await setModule(base.tenantId,module,'active');
 group={...await entitledCtx(base,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};await grantAssistant(group,{appUserId:base.adminUserId});
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
const read=(ctx=group)=>withTenant(ctx,async tx=>{await tx.execute(sql`SET TRANSACTION READ ONLY`);return assistantAgentStatusTx(tx,ctx);});
const canonical=(ctx=group)=>withAssistantRead(ctx,'assistant',reader=>reader.moduleWork('assistant'));
const key='notifications.readiness_nudge_enabled';
// Closed expected inventory: five deterministic chasers were added to the original three.
const expectedAgentIds=['readiness_reminders','claims_triage','approval_chasers','review_chasers','clock_reminders','document_reminders','lifecycle_chasers','payroll_hypotheses'];
const expectedTemplateChasers=['approval_chasers','review_chasers','clock_reminders','document_reminders','lifecycle_chasers'];
describe('minimal current administrator scheduled-agent switch source',()=>{
 it('reads live switch states in the supplied read-only transaction without resolving provider configuration or private metadata',async()=>{
  const config=vi.spyOn(providerConfig,'getAiConfigView').mockImplementation(async()=>{throw Error('Private configuration must not be read');});
  const active=vi.spyOn(providerConfig,'resolveActiveAiConfig').mockImplementation(async()=>{throw Error('Provider must not be resolved');});
  const before=await read();expect(before).toMatchObject({total:AI_FEATURES.filter(feature=>feature.kind==='agent').length,switchesOn:0,effectiveSwitchesOn:0,managementHref:ASSISTANT_AGENT_MANAGEMENT_HREF});
  await setTenantSetting(group,{key,value:true});
  const after=await read();expect(after).toMatchObject({total:8,switchesOn:1,effectiveSwitchesOn:1});
  expect(after.agents.find(row=>row.feature==='readiness_reminders')).toEqual({feature:'readiness_reminders',switchOn:true,effectiveSwitchOn:true,state:'templates',attribution:'attributed'});
  expect(after.agents.map(row=>row.feature)).toEqual(expectedAgentIds);
  expect(after.agents.filter(row=>expectedTemplateChasers.includes(row.feature)).map(({feature,switchOn,effectiveSwitchOn,state})=>({feature,switchOn,effectiveSwitchOn,state}))).toEqual(expectedTemplateChasers.map(feature=>({feature,switchOn:false,effectiveSwitchOn:false,state:'paused'})));
  await setTenantSetting(group,{key,value:false});expect((await read()).switchesOn).toBe(0);
  expect(config).not.toHaveBeenCalled();expect(active).not.toHaveBeenCalled();
  expect(JSON.stringify(after)).not.toMatch(/provider|model|keyLast4|apiKey|userId|eventId|tenantId|budget|usage|workos|fullName/);
 });
 it('separates saved switches from missing modules, platform restrictions, attribution and scheduled-model availability',async()=>{
  for(const setting of [key,'claims.input_triage_enabled','payroll.anomaly_hypotheses_enabled'])await setTenantSetting(group,{key:setting,value:true});
  const all=await read();expect(all).toMatchObject({switchesOn:3,effectiveSwitchesOn:3});
  expect(all.agents.filter(row=>row.feature==='claims_triage'||row.feature==='payroll_hypotheses').map(row=>row.state)).toEqual(['scheduled','scheduled']);
  expect(all.agents.filter(row=>expectedTemplateChasers.includes(row.feature)).map(row=>row.state)).toEqual(['paused','paused','paused','paused','paused']);
  // The source state 'scheduled' means scheduled AI unavailable, never ready or running.
  expect(all.agents.some(row=>String(row.state)==='ready'||String(row.state)==='running')).toBe(false);
  await setModule(base.tenantId,'claims','disabled');
  const missing=await read();expect(missing).toMatchObject({switchesOn:3,effectiveSwitchesOn:2});expect(missing.agents.find(row=>row.feature==='claims_triage')?.state).toBe('module');
  vi.stubEnv('SETTING_KILL',key);
  const restricted=await read();expect(restricted).toMatchObject({switchesOn:3,effectiveSwitchesOn:1});expect(restricted.agents.find(row=>row.feature==='readiness_reminders')?.state).toBe('restricted');
 });
 it('does not count an unattributed switch as effective and exposes no switch-on actor',async()=>{
  await owner.db.insert(s.tenantSetting).values({tenantId:base.tenantId,key,value:sql`'true'::jsonb`,source:'platform'});
  const result=await read();expect(result).toMatchObject({switchesOn:1,effectiveSwitchesOn:0});
  expect(result.agents.find(row=>row.feature==='readiness_reminders')).toMatchObject({switchOn:true,effectiveSwitchOn:false,attribution:'unattributed'});
  expect(JSON.stringify(result)).not.toContain(base.adminUserId);
 });
 it('allows company administrators the same read-only switch status as the management screen, without a management link',async()=>{
  const [user]=await owner.db.insert(s.appUser).values({tenantId:base.tenantId,workosUserId:'fictional-scoped-switch-admin'}).returning();
  await owner.db.insert(s.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,companyId:base.companyId,role:'hr_admin'});
  const scoped={...group,userId:user.id,grants:[{role:'hr_admin',companyId:base.companyId}]};await grantAssistant(group,{appUserId:user.id});
  await setTenantSetting(group,{key,value:true});
  const result=await read(scoped);expect(result).toMatchObject({switchesOn:1,effectiveSwitchesOn:1});expect(result).not.toHaveProperty('managementHref');
  const work=await canonical(scoped),view=presentCanonicalModuleData('assistant',work.data),card=view.cards.find(card=>card.title.kind==='module'&&card.title.module==='assistant')!;
  expect(card.facts.find(fact=>fact.field==='backgroundAgentSwitchesOn')?.value).toBe(1);expect(card.href).toBeUndefined();
 });
 it('leaves an ordinary user catalogue unchanged and refuses direct administration reads or stale principals',async()=>{
  const employee=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional ordinary reader',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  const userId=await createAppUser(base.tenantId,employee.personId,'employee');await grantAssistant(group,{appUserId:userId});
  const ctx={...await entitledCtx(base,['employee']),userId,personId:employee.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  await expect(read(ctx)).rejects.toThrow('Only HR administrators');
  const work=await canonical(ctx);expect(work.data).not.toHaveProperty('adminAgentStatus');
  expect(presentCanonicalModuleData('assistant',work.data).cards.every(card=>card.facts.length===0&&card.href===undefined)).toBe(true);
  await expect(read({...group,personId:randomUUID()})).rejects.toThrow('authority');
  await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,base.adminUserId));
  await expect(read()).rejects.toThrow('authority');
 });
 it('keeps switches tenant-isolated and projects only source-owned counts onto the existing Assistant capability card',async()=>{
  await setTenantSetting(group,{key,value:true});
  const other=await seedBase(),foreign={...await entitledCtx(other,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};
  expect((await read(foreign)).switchesOn).toBe(0);
  await expect(read({...group,tenantId:other.tenantId})).rejects.toThrow('authority');
  const work=await canonical(),view=presentCanonicalModuleData('assistant',work.data);
  expect(view.cards.every(card=>card.title.kind==='module')).toBe(true);
  const card=view.cards.find(card=>card.title.kind==='module'&&card.title.module==='assistant')!;
  expect(card.facts).toEqual([{field:'backgroundAgentsTotal',value:8,format:'number'},{field:'backgroundAgentSwitchesOn',value:1,format:'number'},{field:'backgroundAgentEffectiveSwitchesOn',value:1,format:'number'}]);
  expect(card.href).toBe(ASSISTANT_AGENT_MANAGEMENT_HREF);expect(view.cards.filter(card=>card.facts.length>0)).toEqual([card]);
  const source=work.data as {capabilities:unknown[]};
  expect(()=>presentCanonicalModuleData('assistant',{...source,adminAgentStatus:{total:3,switchesOn:4,effectiveSwitchesOn:0}})).toThrow();
  expect(()=>presentCanonicalModuleData('assistant',{...source,adminAgentStatus:{total:3,switchesOn:1,effectiveSwitchesOn:1,managementHref:'https://untrusted.invalid'}})).toThrow();
 });
});
