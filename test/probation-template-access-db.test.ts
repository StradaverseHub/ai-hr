import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import type {SessionContext} from '../db/client';
import {withTenant} from '../db/client';
import {automationBuilderAccess,automationAssignmentGroups,listAutomationRoutings,listAutomationEmailTemplates,saveAutomationEmailTemplate} from '../packs/automation/service';
import {v9WorkflowNavigationAllowed,v9Workspace} from '../packs/lifecycle/service';
import {buildScaleFixture} from './helpers/ai-centre-scale-fixture';
import {observeStatements} from './helpers/statement-observer';
let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);});
async function member(probation:boolean,legacy:boolean){
 const[person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name) values(${b.tenantId}::uuid,'Fictional template maintainer') returning id`);
 const userId=await createAppUser(b.tenantId,person.id,legacy?'hr_admin':'employee');
 await owner.db.execute(sql`insert into access_user_override(tenant_id,user_id,capability_id,effect) values(${b.tenantId}::uuid,${userId}::uuid,'probation.module',${probation?'allow':'deny'})`);
 return {...admin,userId,personId:person.id,roles:[legacy?'hr_admin':'employee'],grants:undefined};
}
it('enforces Probation-only, legacy-only, both and neither at the actual service boundary',async()=>{
 const template={id:randomUUID(),module:'probation' as const,name:'Fictional module email',subject:'Subject',body:'Body',active:true,cc:[]};
 await saveAutomationEmailTemplate(admin,{template,expectedRevision:0,retired:false,reason:'Fixture'});
 await owner.db.execute(sql`insert into lc_v9_config(tenant_id,data) values(${b.tenantId}::uuid,'{"version":9,"groups":[{"id":"fixture-group","name":"Fictional group","members":[],"limit":0}]}'::jsonb)`);
 for(const [probation,legacy]of [[true,false],[false,true],[true,true],[false,false]]){
  const ctx=await member(probation,legacy);
  expect((await automationBuilderAccess(ctx)).probation).toBe(probation);expect(await v9WorkflowNavigationAllowed(ctx)).toBe(legacy);
  expect((await listAutomationEmailTemplates(ctx,{module:'probation'})).map(item=>item.template.id)).toEqual(probation?[template.id]:[]);
  if(probation){
   expect((await automationAssignmentGroups(ctx)).map(group=>group.id)).toEqual(['fixture-group']);expect(await listAutomationRoutings(ctx)).toEqual([]);
   const current=(await listAutomationEmailTemplates(ctx))[0];await saveAutomationEmailTemplate(ctx,{template:current.template,expectedRevision:current.revision,retired:false,reason:'Authorised module edit'});
  }else await expect(saveAutomationEmailTemplate(ctx,{template:{...template,id:randomUUID()},expectedRevision:0,retired:false,reason:'Refused edit'})).rejects.toMatchObject({code:'forbidden'});
  if(!legacy)await expect(v9Workspace(ctx)).rejects.toMatchObject({code:'forbidden'});
 }
 const[configuration]=await owner.db.execute<{data:{groups:{id:string}[]}}>(sql`select data from lc_v9_config where tenant_id=${b.tenantId}::uuid`);
 expect(configuration.data.groups).toEqual([{id:'fixture-group',name:'Fictional group',members:[],limit:0}]);
});

it('keeps ordered canonical list/count parity at 71 companies and 1000 employments for group and single-company readers',async()=>{
 const fixture=await buildScaleFixture(b,{employments:1000,events:0});
 expect(fixture.companyIds.length).toBeGreaterThanOrEqual(70);expect(fixture.employmentIds).toHaveLength(1000);
 for(const ctx of Object.values(fixture.personas))await owner.db.execute(sql`insert into access_user_override(tenant_id,user_id,capability_id,effect) values(${b.tenantId}::uuid,${ctx.userId}::uuid,'probation.module','allow') on conflict do nothing`);
 const definitions=['Zulu','Alpha','Middle'].map(name=>({id:randomUUID(),module:'probation' as const,name,active:true,subject:'Subject',body:'Body',cc:[]}));
 for(const template of definitions)await saveAutomationEmailTemplate(admin,{template,expectedRevision:0,retired:false,reason:'Fictional scale template'});
 for(const ctx of [fixture.personas.group,fixture.personas.multi,fixture.personas.single]){
  const baseline=await withTenant(ctx,tx=>tx.execute<{id:string;name:string;revision:number;body:string}>(sql`select distinct on(template_id) template_id as id,name,revision,body from automation_email_template_version where tenant_id=app.current_tenant_id() and module='probation' order by template_id,revision desc limit 500`));
  const expected=[...baseline].sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  const observed=await observeStatements(()=>listAutomationEmailTemplates(ctx,{module:'probation'}));
  expect(observed.result.map(item=>({id:item.template.id,name:item.template.name,revision:item.revision,body:item.template.body}))).toEqual(expected);
  expect(observed.result).toHaveLength(3);expect(observed.result.map(item=>item.template.name)).toEqual(['Alpha','Middle','Zulu']);
  expect(observed.statements.filter(statement=>statement.sql.includes('from automation_email_template_version'))).toHaveLength(1);
 }
},120000);
