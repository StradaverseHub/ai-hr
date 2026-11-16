import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {
 AutomationError,automationRoutingOptions,automationBuilderAccess,installAutomationDefaults,listAutomationEmailTemplates,listAutomationRoutings,listAutomationWorkflows,
 saveAutomationEmailTemplate,searchAutomationPeople,type AutomationEmailTemplate,
} from '../packs/automation/service';
import {PROBATION_DEFAULTS} from '../app/automation/probation-defaults';

/** Migration 5743 and core/automation-email.ts / core/automation-builder.ts: authority, tenancy, append-only revisions,
 * turning a template off, retirement, audit, the bounded builder reads and the idempotent default install. */
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
const template=(over:Partial<AutomationEmailTemplate>={}):AutomationEmailTemplate=>({id:randomUUID(),module:'probation',name:'Your probation letter',active:true,
 subject:'Your probation letter: {{probation.outcome}}',body:'Dear {{employee.name}},\n\nYour letter is attached.',cc:[{kind:'group',groupId:'g-gbs'}],...over});
const rejects=async(p:Promise<unknown>,code:AutomationError['code'])=>{await expect(p).rejects.toBeInstanceOf(AutomationError);await expect(p).rejects.toMatchObject({code});};

describe('Shared automation email templates (5743)',()=>{
 it('saves revisions in order, turns a template off, refuses a stale save and records each save',async()=>{
  const t=template();
  expect(await saveAutomationEmailTemplate(admin,{template:t,retired:false,expectedRevision:0,reason:'Default letter email'})).toEqual({revision:1,warnings:[]});
  expect((await saveAutomationEmailTemplate(admin,{template:{...t,active:false},retired:false,expectedRevision:1,reason:'Turned off'})).revision).toBe(2);
  await rejects(saveAutomationEmailTemplate(admin,{template:{...t,name:'Late edit'},retired:false,expectedRevision:1,reason:'Late'}),'conflict');
  const listed=await listAutomationEmailTemplates(admin,{module:'probation'});
  expect(listed.map(x=>[x.template.id,x.revision,x.template.active,x.retired,x.template.cc])).toEqual([[t.id,2,false,false,[{kind:'group',groupId:'g-gbs'}]]]);
  const events=await owner.db.execute<{type:string;payload:{revision:number;active:boolean;previousActive:boolean|null}}>(sql`select event_type as type,payload from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${t.id}::uuid order by sequence`);
  expect(events.map(e=>[e.type,e.payload.revision,e.payload.active,e.payload.previousActive])).toEqual([['automation.email_template.created',1,true,null],['automation.email_template.saved',2,false,true]]);
 });
 it('returns merge-field warnings and refuses an incomplete template or an unknown CC group',async()=>{
  const saved=await saveAutomationEmailTemplate(admin,{template:template({body:'Band {{probation.bandName}}'}),retired:false,expectedRevision:0,reason:'Warn'});
  expect(saved.warnings).toEqual(['{{probation.bandName}} is not a merge field of this module and will stay as typed.']);
  await rejects(saveAutomationEmailTemplate(admin,{template:template({subject:'  '}),retired:false,expectedRevision:0,reason:'x'}),'invalid');
  await rejects(saveAutomationEmailTemplate(admin,{template:template({cc:[{kind:'group',groupId:'g-missing'}]}),retired:false,expectedRevision:0,reason:'x'}),'invalid');
  await rejects(saveAutomationEmailTemplate(admin,{template:template({module:'onb'}),retired:false,expectedRevision:0,reason:'x'}),'invalid');
  // The database refuses what the service would catch, as the last guard.
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.automation_email_template_save(${randomUUID()}::uuid,'probation','x',true,'Subject','Body','[{"kind":"nobody"}]'::jsonb,false,0,'x')`))).rejects.toThrow();
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.automation_email_template_save(${randomUUID()}::uuid,'probation','x',true,'Subject','Body','{}'::jsonb,false,0,'x')`))).rejects.toThrow();
 });
 it('keeps retirement final and a template in its module',async()=>{
  const t=template();await saveAutomationEmailTemplate(admin,{template:t,retired:false,expectedRevision:0,reason:'Draft'});
  expect((await saveAutomationEmailTemplate(admin,{template:t,retired:true,expectedRevision:1,reason:'No longer used'})).revision).toBe(2);
  await rejects(saveAutomationEmailTemplate(admin,{template:t,retired:false,expectedRevision:2,reason:'Revive'}),'invalid');
  expect((await listAutomationEmailTemplates(admin))[0]).toMatchObject({revision:2,retired:true});
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.automation_email_template_save(${t.id}::uuid,'onb','x',true,'Subject','Body','[]'::jsonb,false,2,'Move')`))).rejects.toThrow();
 });
 it('lets only the Probation module permission configure Probation templates, and honours a deny',async()=>{
  const t=template();await saveAutomationEmailTemplate(admin,{template:t,retired:false,expectedRevision:0,reason:'Draft'});
  const plain=await member(),granted=await member('allow'),denied=await member('deny');
  expect(await listAutomationEmailTemplates(plain)).toEqual([]);
  await rejects(saveAutomationEmailTemplate(plain,{template:template(),retired:false,expectedRevision:0,reason:'x'}),'forbidden');
  expect(await automationBuilderAccess(plain)).toEqual({probation:false,any:false});
  expect((await listAutomationEmailTemplates(granted)).map(x=>x.template.id)).toEqual([t.id]);
  expect(await automationBuilderAccess(granted)).toEqual({probation:true,any:true});
  expect(await listAutomationEmailTemplates(denied)).toEqual([]);
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.automation_email_template_save(${randomUUID()}::uuid,'contract_staff','x',true,'Subject','Body','[]'::jsonb,false,0,'x')`))).rejects.toThrow();
 });
 it('keeps the version table append-only and closed to direct writes',async()=>{
  const t=template();await saveAutomationEmailTemplate(admin,{template:t,retired:false,expectedRevision:0,reason:'Draft'});
  for(const statement of[
   sql`insert into automation_email_template_version(tenant_id,template_id,revision,module,name,active,subject,body,reason,saved_by) values(${b.tenantId}::uuid,${randomUUID()}::uuid,1,'probation','x',true,'Subject','Body','x',${admin.userId}::uuid)`,
   sql`update automation_email_template_version set active=false where template_id=${t.id}::uuid`,
   sql`delete from automation_email_template_version where template_id=${t.id}::uuid`,
  ])await expect(withTenant(admin,tx=>tx.execute(statement))).rejects.toThrow();
  const[n]=await owner.db.execute<{n:number;active:boolean}>(sql`select count(*)::int n,bool_and(active) active from automation_email_template_version where template_id=${t.id}::uuid`);expect(n).toEqual({n:1,active:true});
 });
 it('never crosses tenants',async()=>{
  const t=template();await saveAutomationEmailTemplate(admin,{template:t,retired:false,expectedRevision:0,reason:'Draft'});
  const foreign=await seedBase();await setModule(foreign.tenantId,'lifecycle','active');const other=adminCtx(foreign);
  expect(await listAutomationEmailTemplates(other)).toEqual([]);
  expect((await saveAutomationEmailTemplate(other,{template:{...t,cc:[]},retired:false,expectedRevision:0,reason:'Same id, other tenant'})).revision).toBe(1);
  expect((await listAutomationEmailTemplates(admin))[0].template.cc).toHaveLength(1);
 });
});

describe('Shared builder reads and default install',()=>{
 it('reads bounded organisation options and people only for someone who configures a module',async()=>{
  const options=await automationRoutingOptions(admin);
  expect(options.companies.map(c=>[c.id,c.name,c.businessGroupId])).toEqual([[b.companyId,'Acme Sdn Bhd',b.companyId]]);
  expect(options.businessGroups).toEqual([{id:b.companyId,name:'Acme Sdn Bhd'}]);
  expect(options.departments.map(d=>d.name)).toEqual(['Finance','Operations']);
  expect(options.jobTitles).toEqual(['Executive']);
  const plain=await member();
  await rejects(automationRoutingOptions(plain),'forbidden');
  await rejects(searchAutomationPeople(plain,'Fictional'),'forbidden');
  expect(await searchAutomationPeople(admin,'x')).toEqual([]);
 });
 it('installs the Probation defaults Paused in one transaction and leaves them alone the second time',async()=>{
  const first=await installAutomationDefaults(admin,PROBATION_DEFAULTS);
  expect(first).toEqual({installed:{workflows:16,emailTemplates:4,routings:2},alreadyPresent:0});
  const workflows=await listAutomationWorkflows(admin,{module:'probation'});
  expect(workflows).toHaveLength(16);
  expect(workflows.every(w=>w.workflow.status==='paused'&&w.revision===1)).toBe(true);
  expect(workflows.filter(w=>w.workflow.required)).toHaveLength(12);
  expect(workflows.find(w=>w.workflow.name==='Outcome · Confirm')?.workflow).toMatchObject({trigger:{event:'outcomeDecided'},conditions:[{field:'outcome',op:'is',values:['Confirm']}],steps:[{type:'generateDocument'},{type:'sendEmail'},{type:'createPosting',params:{eventType:'Confirmation'}}]});
  expect((await listAutomationEmailTemplates(admin)).map(t=>t.template.name).sort()).toEqual(['Review form is open','Signing request','Week 1 KPI alert','Your probation letter']);
  expect((await listAutomationRoutings(admin)).map(r=>[r.routing.name,r.routing.rows.length])).toEqual([['BP by business group',0],['HOD by business group and department',0]]);
  // A later edit survives a second install, which installs nothing.
  const edited=workflows[0];
  await withTenant(admin,tx=>tx.execute(sql`select app.automation_workflow_save(${edited.workflow.id}::uuid,'probation','paused',false,${JSON.stringify({...edited.workflow,name:'Edited name',status:undefined,required:undefined})}::jsonb,1,'Edit')`));
  expect(await installAutomationDefaults(admin,PROBATION_DEFAULTS)).toEqual({installed:{workflows:0,emailTemplates:0,routings:0},alreadyPresent:22});
  expect((await listAutomationWorkflows(admin)).find(w=>w.workflow.id===edited.workflow.id)).toMatchObject({revision:2,workflow:{name:'Edited name'}});
  await rejects(installAutomationDefaults(await member(),PROBATION_DEFAULTS),'forbidden');
 });
});
