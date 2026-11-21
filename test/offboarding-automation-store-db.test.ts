import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {saveAutomationWorkflow,listAutomationWorkflows,automationWorkflowRevision,type AutomationWorkflow} from '../packs/automation/service';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);
 await owner.db.execute(sql`insert into lc_onboarding_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({version:1,access:{onboarding:[],offboarding:[admin.userId]},groups:[]})}::jsonb) on conflict(tenant_id) do update set data=excluded.data`);
 await owner.db.execute(sql`insert into lc_v9_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({version:9,revision:1,templates:[],emails:[],groups:[{id:'ops',name:'Operations',limit:25,members:[admin.userId]}],peopleOpsGroup:'ops'})}::jsonb) on conflict(tenant_id) do update set data=excluded.data`);
});
const workflow=(params:Record<string,unknown>={}):AutomationWorkflow=>({id:randomUUID(),module:'off',name:'Resignation received',description:'',status:'paused',required:false,trigger:{event:'submitted',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[{id:'decision',type:'requestDecision',to:[{kind:'role',role:'directSuperior'}],cc:[],conditions:[],params:{choices:'both',dueDays:3,...params}}]});

describe('Shared Offboarding workflow store authority and validation',()=>{
 it('requires the existing tenant configuration administrator and Offboarding membership together',async()=>{
  const user=await createAppUser(b.tenantId,null,'employee'),employee={...admin,userId:user,roles:['employee']} as SessionContext;
  const scoped=await createAppUser(b.tenantId,null,'hr_admin'),otherAdmin={...admin,userId:scoped} as SessionContext;
  const [allowed]=await withTenant(admin,tx=>tx.execute<{allowed:boolean}>(sql`select app.automation_can_configure('off') as allowed`));expect(allowed.allowed).toBe(true);
  await expect(saveAutomationWorkflow(employee,{workflow:workflow(),expectedRevision:0,reason:'Unauthorized'})).rejects.toMatchObject({code:'forbidden'});
  await expect(saveAutomationWorkflow(otherAdmin,{workflow:workflow(),expectedRevision:0,reason:'No Offboarding membership'})).rejects.toMatchObject({code:'forbidden'});
 });
 it('stores additive paused drafts and refuses invalid Live without adding a revision',async()=>{
  const wf=workflow({dueDays:0});const saved=await saveAutomationWorkflow(admin,{workflow:wf,expectedRevision:0,reason:'Configure decision'});
  expect(saved.problems).toContain('Step 1: Due within must be 1 to 60 working days, or left blank.');
  await expect(saveAutomationWorkflow(admin,{workflow:{...wf,status:'live'},expectedRevision:1,reason:'Publish invalid'})).rejects.toMatchObject({code:'invalid'});
  expect((await listAutomationWorkflows(admin,{module:'off'})).map(row=>[row.workflow.id,row.revision,row.workflow.status])).toEqual([[wf.id,1,'paused']]);
 });
 it('keeps prior workflow snapshots, enforces stale-save refusal, and emits its audit events once',async()=>{
  const wf=workflow();await saveAutomationWorkflow(admin,{workflow:wf,expectedRevision:0,reason:'Create'});
  const next={...wf,status:'live' as const,name:'Configured resignation'};await saveAutomationWorkflow(admin,{workflow:next,expectedRevision:1,reason:'Activate'});
  await expect(saveAutomationWorkflow(admin,{workflow:next,expectedRevision:1,reason:'Stale'})).rejects.toMatchObject({code:'conflict'});
  expect((await automationWorkflowRevision(admin,wf.id,1)).workflow.name).toBe('Resignation received');
  const [events]=await owner.db.execute<{types:string[]}>(sql`select array_agg(event_type order by sequence) as types from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${wf.id}::uuid`);
  expect(events.types).toEqual(['automation.workflow.created','automation.workflow.saved']);
 });
 it('does not disclose another tenant’s Offboarding definitions',async()=>{
  const wf=workflow();await saveAutomationWorkflow(admin,{workflow:wf,expectedRevision:0,reason:'Create'});
  const foreign=await seedBase();await setModule(foreign.tenantId,'lifecycle','active');
  expect(await listAutomationWorkflows(adminCtx(foreign),{module:'off'})).toEqual([]);
  await expect(automationWorkflowRevision(adminCtx(foreign),wf.id,1)).rejects.toMatchObject({code:'not_found'});
 });
});
