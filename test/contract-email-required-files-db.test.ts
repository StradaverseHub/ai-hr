/** Fictional native persisted waits: authorization/file proof only, no SMTP or installed journey claim. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,owner,createAppUser,type Base} from './harness';
import {hireEmployee,setEmploymentInfo} from '../core/org';
import {v9Setup} from '../packs/lifecycle/service';
import {adoptContractSharedCase,saveContractSharedRole,saveContractSharedMember} from '../packs/contracts/service';
import {saveAutomationEmailTemplate,saveAutomationWorkflow,uploadAutomationEmailAsset,automationEmailCaseFilePage,type AutomationWorkflow} from '../packs/automation/service';
import {todayInKualaLumpur} from '../lib/hr-date';
let b:Base,admin:SessionContext;
const year=Number(todayInKualaLumpur().slice(0,4)),start=`${year}-01-01`,end=`${year+1}-12-31`;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=await entitledCtx(b);
 const [p]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional file operator',${randomUUID()+'@files.example.test'}) returning id`);
 await owner.db.execute(sql`update app_user set person_id=${p.id}::uuid where id=${admin.userId!}::uuid and tenant_id=${b.tenantId}::uuid`);admin={...admin,personId:p.id};await v9Setup(admin);
});
async function fixture(){
 const employee=await hireEmployee(admin,{person:{fullName:'Fictional waiting employee',primaryEmail:randomUUID()+'@files.example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'contract',hiredOn:start,provisionalEndOn:end});
 await setEmploymentInfo(admin,{employmentId:employee.employmentId,contractStartDate:start,contractEndDate:end,contractNumber:2});
 const term=randomUUID(),caseId=randomUUID();
 await owner.db.execute(sql`insert into contract_term(id,tenant_id,company_id,employment_id,version,kind,start_on,end_on,source_revision) values(${term}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${employee.employmentId}::uuid,1,'project',${start}::date,${end}::date,'fictional-owned-period')`);
 await owner.db.execute(sql`insert into contract_case(id,tenant_id,company_id,employment_id,term_id,number,revision,data) values(${caseId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${employee.employmentId}::uuid,${term}::uuid,${'CT-FILE-'+caseId},1,jsonb_build_object('revision',1,'state','upcoming','term',jsonb_build_object('startOn',${start}::text,'endOn',${end}::text),'decision',NULL,'decisionDraft',NULL))`);
 await adoptContractSharedCase(admin,caseId);
 const template={id:randomUUID(),module:'contract_staff' as const,name:'Fictional waiting email',active:true,subject:'Contract information',body:'Please read your information.',cc:[],slots:[{id:randomUUID(),label:'Required voucher',required:true},{id:randomUUID(),label:'Optional note',required:false}]};
 await saveAutomationEmailTemplate(admin,{template,retired:false,expectedRevision:0,reason:'Initial fictional email'});
 const step={id:randomUUID(),type:'sendEmail' as const,conditions:[],to:[{kind:'person' as const,userId:admin.userId!}],cc:[],params:{emailTemplateId:template.id}};
 const workflow:AutomationWorkflow={id:randomUUID(),module:'contract_staff',name:'Fictional waiting workflow',description:'',required:false,status:'live',trigger:{event:'manual',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[step]};
 await saveAutomationWorkflow(admin,{workflow,expectedRevision:0,reason:'Actual frozen definition for persisted wait'});
 const run=randomUUID(),pin=randomUUID();
 await owner.db.execute(sql`insert into automation_run(tenant_id,id,module,workflow_id,workflow_revision,subject_id,event_key,trigger_event,status,step_cursor,waiting_for,remaining_steps,started_by) values(${b.tenantId}::uuid,${run}::uuid,'contract_staff',${workflow.id}::uuid,1,${caseId}::uuid,'fictional-files','manual','waiting',0,${pin}::uuid,${JSON.stringify([{step,index:0}])}::jsonb,${admin.userId!}::uuid)`);
 await owner.db.execute(sql`insert into contract_shared_email_document_step(tenant_id,case_id,workflow_run_id,workflow_step_id,id,company_id,source_period_revision,email_template_id,email_revision,subject_person_id,decision_revision,phase) select tenant_id,case_id,${run}::uuid,${step.id},${pin}::uuid,${b.companyId}::uuid,data->'period'->>'sourceRevision',${template.id}::uuid,1,${employee.personId}::uuid,0,'outcome' from contract_shared_case where tenant_id=${b.tenantId}::uuid and case_id=${caseId}::uuid`);
 return {employee,caseId,template,run,pin,step,workflow};
}
async function proof(pin:string,tenant=b.tenantId){return owner.client.begin(async tx=>{await tx`select set_config('app.tenant_id',${tenant},true)`;const [row]=await tx<{proof:{ready:boolean;assets:{id:string;contentHash:string}[]}}[]>`select app.contract_shared_email_required_files_proof(${pin}::uuid) as proof`;return row.proof;});}
const upload=(f:Awaited<ReturnType<typeof fixture>>,extra:Record<string,unknown>={})=>uploadAutomationEmailAsset(admin,{templateId:f.template.id,module:'contract_staff',revision:1,kind:'file',name:'voucher.txt',content:Buffer.from('Fictional voucher only'),caseId:f.caseId,slotId:f.template.slots[0].id,prerequisiteId:f.pin,...extra});
describe('required Contract email files retain the real pending version/source',()=>{
 it('holds a required slot, exposes both versions and accepts only the explicit frozen pending selection after Personnel advances',async()=>{
  const f=await fixture();expect(await proof(f.pin)).toEqual({ready:false,assets:[]});
  await saveAutomationEmailTemplate(admin,{template:{...f.template,name:'Revised fictional email'},retired:false,expectedRevision:1,reason:'A newer email must not rewrite the existing wait'});
  await setEmploymentInfo(admin,{employmentId:f.employee.employmentId,contractNumber:3});
  const page=await automationEmailCaseFilePage(admin,f.caseId);expect(page.items.map(i=>[i.revision,i.prerequisiteId??null])).toEqual([[1,f.pin],[2,null]]);
  expect(page.items[0].slots.map(s=>s.file)).toEqual([null,null]);
  await expect(upload(f,{prerequisiteId:undefined})).rejects.toMatchObject({code:'conflict'});
  const asset=await upload(f);expect(await proof(f.pin)).toEqual({ready:true,assets:[asset]});
  expect((await automationEmailCaseFilePage(admin,f.caseId)).items[0].slots.find(s=>s.id===f.template.slots[0].id)?.file).toEqual(asset);
  await owner.db.execute(sql`update contract_shared_case set revision=revision+1,data=jsonb_set(jsonb_set(data,'{revision}',to_jsonb(revision+1)),'{period,sourceRevision}',to_jsonb('fictional-later-source'::text)) where tenant_id=${b.tenantId}::uuid and case_id=${f.caseId}::uuid`);
  // No native writer replaces an existing case period: such a forged projection must hold closed.
  expect(await proof(f.pin)).toEqual({ready:false,assets:[]});
  await expect(upload(f)).rejects.toMatchObject({code:'forbidden'});
 });
 it('rejects unknown/cross-case/version/slot/module hints, caller GUCs and unverified actors without changing stored bytes',async()=>{
  const f=await fixture(),other=await fixture();
  for(const patch of [{prerequisiteId:randomUUID()},{prerequisiteId:other.pin},{caseId:other.caseId},{revision:2},{slotId:randomUUID()}])await expect(upload(f,patch)).rejects.toThrow();
  await expect(upload(f,{module:'probation'})).rejects.toMatchObject({code:'invalid'});
  const [p]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional unprivileged uploader',${randomUUID()+'@files.example.test'}) returning id`);
  const uid=await createAppUser(b.tenantId,p.id,'employee'),plain={...admin,userId:uid,personId:p.id,roles:['employee'],grants:undefined} as SessionContext;
  await expect(withTenant(plain,async tx=>{await tx.execute(sql`select set_config('app.requested_contract_email_pin',${f.pin},true)`);return tx.execute(sql`select app.automation_email_asset_upload(${f.template.id}::uuid,'contract_staff',1,'file','forged.txt','text/plain',decode('SGk=','base64'),${f.caseId}::uuid,${f.template.slots[0].id})`);})).rejects.toThrow();
  await expect(withTenant(admin,tx=>tx.execute(sql`select app.contract_shared_email_required_files_proof(${f.pin}::uuid)`))).rejects.toThrow();
  expect(await proof(f.pin,(await seedBase()).tenantId)).toEqual({ready:false,assets:[]});
  const [count]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from lc_v9_email_asset where tenant_id=${b.tenantId}::uuid`);expect(count.n).toBe(0);
 });
 it('keeps ordinary current-version uploads working and holds again when the exact persisted cursor or source is wrong',async()=>{
  const f=await fixture(),asset=await upload(f,{prerequisiteId:undefined});expect((await proof(f.pin)).assets).toEqual([asset]);expect((await proof(f.pin)).ready).toBe(true);
  await owner.db.execute(sql`update automation_run set step_cursor=1 where tenant_id=${b.tenantId}::uuid and id=${f.run}::uuid`);
  expect(await proof(f.pin)).toEqual({ready:false,assets:[]});await expect(upload(f)).rejects.toMatchObject({code:'forbidden'});
 });
 it('keeps a bounded case page equivalent for all-company and one-company actors among 70 companies and 1,000 employments',async()=>{
  const f=await fixture();
  await owner.db.execute(sql`with companies as(insert into company(tenant_id,legal_name) select ${b.tenantId}::uuid,'Unrelated file scale company '||n from generate_series(1,70) n returning id,legal_name), numbered as materialized(select id,row_number() over(order by legal_name) n from companies), fixture as materialized(select series.n,gen_random_uuid() person_id,c.id company_id from generate_series(1,1000) series(n) join numbered c on c.n=((series.n-1)%70)+1), people as(insert into person(id,tenant_id,full_name,primary_email) select person_id,${b.tenantId}::uuid,'Unrelated file employee '||n,'filescale-'||n||'@files.example.test' from fixture) insert into employment(tenant_id,person_id,company_id,hired_on,employee_code) select ${b.tenantId}::uuid,person_id,company_id,${start}::date,'FILESCALE-'||n from fixture`);
  await saveAutomationEmailTemplate(admin,{template:f.template,retired:false,expectedRevision:1,reason:'Separate newest version for bounded pages'});
  const [p]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional one-company file operator',${randomUUID()+'@files.example.test'}) returning id`);
  const uid=await createAppUser(b.tenantId,p.id,'employee'),roleId=randomUUID();
  await saveContractSharedRole(admin,{id:roleId,name:'One-company email files',permissions:['view','manual'],expectedRevision:0});
  await saveContractSharedMember(admin,{id:randomUUID(),roleId,userId:uid,companyId:b.companyId,businessGroupId:null,validFrom:start,validTo:null,revoked:false});
  const scoped={...admin,userId:uid,personId:p.id,roles:['employee'],grants:undefined} as SessionContext;
  for(const offset of [0,1]){
   const all=await automationEmailCaseFilePage(admin,f.caseId,{limit:1,offset}),one=await automationEmailCaseFilePage(scoped,f.caseId,{limit:1,offset});
   expect(one).toEqual(all);expect(all.items).toHaveLength(1);expect(all.items[0].revision).toBe(offset+1);expect(all.hasMore).toBe(offset===0);expect(all.offset).toBe(offset);
  }
 });

});
