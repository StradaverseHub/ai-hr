import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {AutomationError,automationWorkflowRevision,listAutomationRoutings,listAutomationWorkflows,saveAutomationRouting,saveAutomationWorkflow,type AutomationWorkflow,type Routing} from '../packs/automation/service';

/** Migration 5740 and core/automation-store.ts: authority, tenancy, append-only revisions, frozen copies and audit. */
let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);
 await owner.db.execute(sql`insert into lc_v9_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({version:9,groups:[{id:'g-gbs',name:'GBS People Ops',members:[],limit:0}]})}::jsonb)
  on conflict(tenant_id) do update set data=jsonb_set(lc_v9_config.data,'{groups}',${JSON.stringify([{id:'g-gbs',name:'GBS People Ops',members:[],limit:0}])}::jsonb)`);
});
async function member(grant?:'allow'|'deny'){
 const[p]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional automation user',${randomUUID()+'@automation.example.test'}) returning id`);
 const userId=await createAppUser(b.tenantId,p.id,'employee');
 if(grant)await owner.db.execute(sql`insert into access_user_override(tenant_id,user_id,capability_id,effect) values(${b.tenantId}::uuid,${userId}::uuid,'probation.module',${grant})`);
 return{...admin,userId,personId:p.id,roles:['employee'],grants:undefined} as SessionContext;
}
const workflow=(over:Partial<AutomationWorkflow>={}):AutomationWorkflow=>({id:randomUUID(),module:'probation',name:'Outcome · Confirm',description:'',status:'paused',required:true,
 trigger:{event:'outcomeDecided',days:0,workdays:false,repeat:false},skipWhen:'caseClosed',conditions:[{field:'outcome',op:'is',values:['Confirm']}],
 steps:[{id:'s1',type:'sendEmail',conditions:[],to:[{kind:'role',role:'employee'}],cc:[{kind:'group',groupId:'g-gbs'}],params:{emailTemplateId:'e-letter'}}],...over});
const routing=(over:Partial<Routing>={}):Routing=>({id:randomUUID(),name:'BP by business group',rows:[{match:{businessGroup:['CHGB']},assignTo:{kind:'group',groupId:'g-gbs'}}],...over});
const rejects=async(p:Promise<unknown>,code:AutomationError['code'])=>{await expect(p).rejects.toBeInstanceOf(AutomationError);await expect(p).rejects.toMatchObject({code});};

describe('Shared automation workflows',()=>{
 it('saves revisions in order, refuses a stale save and keeps every revision as a frozen copy',async()=>{
  const wf=workflow();
  expect(await saveAutomationWorkflow(admin,{workflow:wf,expectedRevision:0,reason:'Default outcome workflow'})).toMatchObject({revision:1,problems:[]});
  expect((await saveAutomationWorkflow(admin,{workflow:{...wf,status:'live'},expectedRevision:1,reason:'Go live'})).revision).toBe(2);
  await rejects(saveAutomationWorkflow(admin,{workflow:{...wf,name:'Stale edit'},expectedRevision:1,reason:'Late save'}),'conflict');
  const [latest]=await listAutomationWorkflows(admin,{module:'probation'});
  expect(latest).toMatchObject({revision:2,workflow:{id:wf.id,status:'live',name:'Outcome · Confirm',required:true}});
  expect((await automationWorkflowRevision(admin,wf.id,1)).workflow.status).toBe('paused');
  const[events]=await owner.db.execute<{types:string[]}>(sql`select array_agg(event_type order by sequence) as types from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${wf.id}::uuid`);
  expect(events.types).toEqual(['automation.workflow.created','automation.workflow.saved']);
 });
 it('saves a paused draft with problems but refuses to make it live',async()=>{
  const wf=workflow({conditions:[{field:'resultBand',op:'lte',values:['2']}]});
  const saved=await saveAutomationWorkflow(admin,{workflow:wf,expectedRevision:0,reason:'Draft'});
  expect(saved.problems).toEqual(['Condition 1: this field is not available for the chosen trigger.']);
  await rejects(saveAutomationWorkflow(admin,{workflow:{...wf,status:'live'},expectedRevision:1,reason:'Go live'}),'invalid');
  await rejects(saveAutomationWorkflow(admin,{workflow:workflow({status:'live',steps:[{id:'s1',type:'notify',conditions:[],to:[{kind:'group',groupId:'g-missing'}],cc:[],params:{}}]}),expectedRevision:0,reason:'x'}),'invalid');
 });
 it('never changes a retired workflow or moves one to another module',async()=>{
  const wf=workflow();await saveAutomationWorkflow(admin,{workflow:wf,expectedRevision:0,reason:'Draft'});
  await saveAutomationWorkflow(admin,{workflow:{...wf,status:'retired'},expectedRevision:1,reason:'No longer used'});
  await rejects(saveAutomationWorkflow(admin,{workflow:{...wf,status:'paused'},expectedRevision:2,reason:'Revive'}),'invalid');
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.automation_workflow_save(${wf.id}::uuid,'onb','paused',true,${JSON.stringify({...wf,module:'onb'})}::jsonb,2,'Move')`))).rejects.toThrow();
 });
 it('lets only the Probation module permission configure, honours a deny, and leaves other modules closed',async()=>{
  const wf=workflow();await saveAutomationWorkflow(admin,{workflow:wf,expectedRevision:0,reason:'Draft'});
  const plain=await member(),granted=await member('allow'),denied=await member('deny');
  expect(await listAutomationWorkflows(plain)).toEqual([]);
  await rejects(saveAutomationWorkflow(plain,{workflow:workflow(),expectedRevision:0,reason:'x'}),'forbidden');
  expect((await listAutomationWorkflows(granted)).map(w=>w.workflow.id)).toEqual([wf.id]);
  expect((await saveAutomationWorkflow(granted,{workflow:workflow(),expectedRevision:0,reason:'Granted user'})).revision).toBe(1);
  expect(await listAutomationWorkflows(denied)).toEqual([]);
  await rejects(saveAutomationWorkflow(admin,{workflow:{...workflow(),module:'onb'},expectedRevision:0,reason:'x'}),'invalid');
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.automation_workflow_save(${randomUUID()}::uuid,'contract_staff','paused',false,'{}'::jsonb,0,'x')`))).rejects.toThrow();
 });
 it('keeps the version tables append-only and closed to direct writes',async()=>{
  const wf=workflow();await saveAutomationWorkflow(admin,{workflow:wf,expectedRevision:0,reason:'Draft'});
  for(const statement of[
   sql`insert into automation_workflow_version(tenant_id,workflow_id,revision,module,status,required,definition,reason,saved_by) values(${b.tenantId}::uuid,${randomUUID()}::uuid,1,'probation','live',true,'{}'::jsonb,'x',${admin.userId}::uuid)`,
   sql`update automation_workflow_version set status='live' where workflow_id=${wf.id}::uuid`,
   sql`delete from automation_workflow_version where workflow_id=${wf.id}::uuid`,
  ])await expect(withTenant(admin,tx=>tx.execute(statement))).rejects.toThrow();
  const[n]=await owner.db.execute<{n:number;status:string}>(sql`select count(*)::int n,max(status) status from automation_workflow_version where workflow_id=${wf.id}::uuid`);expect(n).toEqual({n:1,status:'paused'});
 });
 it('never crosses tenants',async()=>{
  const wf=workflow();await saveAutomationWorkflow(admin,{workflow:wf,expectedRevision:0,reason:'Draft'});
  const foreign=await seedBase();await setModule(foreign.tenantId,'lifecycle','active');const other=adminCtx(foreign);
  expect(await listAutomationWorkflows(other)).toEqual([]);
  await rejects(automationWorkflowRevision(other,wf.id,1),'not_found');
  expect((await saveAutomationWorkflow(other,{workflow:{...wf,steps:[{...wf.steps[0],cc:[]}]},expectedRevision:0,reason:'Same id, other tenant'})).revision).toBe(1);
  expect((await automationWorkflowRevision(admin,wf.id,1)).workflow.steps[0].cc).toHaveLength(1);
 });
});

describe('Shared routings',()=>{
 it('saves valid routings, refuses unknown groups and retired edits, and lets workflows name live routings only',async()=>{
  const r=routing();expect(await saveAutomationRouting(admin,{routing:r,retired:false,expectedRevision:0,reason:'BP routing'})).toEqual({revision:1});
  await rejects(saveAutomationRouting(admin,{routing:routing({rows:[{match:{},assignTo:{kind:'group',groupId:'g-missing'}}]}),retired:false,expectedRevision:0,reason:'x'}),'invalid');
  expect((await listAutomationRoutings(admin)).map(x=>[x.routing.name,x.revision,x.retired])).toEqual([['BP by business group',1,false]]);
  const wf=workflow({status:'live',steps:[{id:'s1',type:'notify',conditions:[],to:[{kind:'routing',routingId:r.id}],cc:[],params:{subject:'Hello'}}]});
  expect((await saveAutomationWorkflow(admin,{workflow:wf,expectedRevision:0,reason:'Uses BP routing'})).revision).toBe(1);
  await saveAutomationRouting(admin,{routing:r,retired:true,expectedRevision:1,reason:'Replaced'});
  await rejects(saveAutomationRouting(admin,{routing:r,retired:false,expectedRevision:2,reason:'Revive'}),'invalid');
  await rejects(saveAutomationWorkflow(admin,{workflow:wf,expectedRevision:1,reason:'Resave'}),'invalid');
 });
 it('hides routings and groups from people who configure nothing',async()=>{
  await saveAutomationRouting(admin,{routing:routing(),retired:false,expectedRevision:0,reason:'BP routing'});
  const plain=await member();
  expect(await listAutomationRoutings(plain)).toEqual([]);
  await rejects(saveAutomationRouting(plain,{routing:routing(),retired:false,expectedRevision:0,reason:'x'}),'forbidden');
  expect(await withTenant(plain,tx=>tx.execute(sql`select * from app.automation_assignment_groups()`))).toEqual([]);
  expect(await withTenant(plain,tx=>tx.execute(sql`select * from app.automation_active_users(${`{${admin.userId}}`}::uuid[])`))).toEqual([]);
 });
});
