import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
import {v9Setup} from '../packs/lifecycle/service';
import {automationBuilderAccess,automationDocumentVersions,automationTemplateChoices,listAutomationDocumentTemplates,listAutomationWorkflows,saveAutomationRouting,saveAutomationDocumentTemplate,saveAutomationWorkflow,type AutomationWorkflow} from '../packs/automation/service';
import {contractSharedAccess,contractSharedSettings,saveContractSharedMember,saveContractSharedRole,saveContractSharedSettings,contractSharedPage,contractSharedContext,dryRunContractWorkflow} from '../packs/contracts/service';
import {DEFAULT_CONTRACT_FLOW_SETTINGS} from '../lib/contract-case-flow';
import type {AutomationDocumentTemplate} from '../lib/automation/document-template';
import {hireEmployee,setEmploymentInfo} from '../core/org';
import {listAutomationEmailTemplates,saveAutomationEmailTemplate} from '../packs/automation/service';
import {automationEmailBodyDoc} from '../lib/automation/email';

let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=await entitledCtx(b);const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional Contract administrator',${randomUUID()+'@contracts.test'}) returning id`);await owner.db.execute(sql`update app_user set person_id=${person.id}::uuid where tenant_id=${b.tenantId}::uuid and id=${b.adminUserId}::uuid`);admin={...admin,personId:person.id};await v9Setup(admin);});
async function ordinary(){
 const [p]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional Contract operator',${randomUUID()+'@contracts.test'}) returning id`);
 const userId=await createAppUser(b.tenantId,p.id,'employee');
 return {...admin,userId,personId:p.id,roles:['employee'],grants:undefined} as SessionContext;
}
const template=():AutomationDocumentTemplate=>({id:randomUUID(),module:'contract_staff',name:'Contract renewal',description:'Fictional test wording',rules:{decision:['Renew']},blocks:[{id:'intro',type:'text',text:'Dear {employee.name}',section:''}],fields:[],routing:[{id:'review',order:1,action:'review',owner:true,who:{kind:'directSuperior'}}]});
describe('Contract scoped access and settings',()=>{
 it('refuses direct table writes and ordinary access-management callers',async()=>{
  const plain=await ordinary();
  await expect(contractSharedAccess(plain)).rejects.toMatchObject({code:'forbidden'});
  await expect(saveContractSharedRole(plain,{id:randomUUID(),name:'Not authorized',permissions:['access'],expectedRevision:0})).rejects.toMatchObject({code:'forbidden'});
  await expect(withTenant(admin,tx=>tx.execute(sql`insert into contract_access_role(tenant_id,name,permissions,updated_by) values(${b.tenantId}::uuid,'Direct write','{}',${admin.userId}::uuid)`))).rejects.toThrow();
 });
 it('records named roles and effective assignments with fresh server-side permission checks',async()=>{
  const plain=await ordinary(),id=randomUUID();
  await saveContractSharedRole(admin,{id,name:'Contract PBP',permissions:['view','decide'],expectedRevision:0});
  await saveContractSharedMember(admin,{id:randomUUID(),roleId:id,userId:plain.userId,companyId:b.companyId,businessGroupId:null,validFrom:'2020-01-01',validTo:null,revoked:false});
  const [rights]=await withTenant(plain,tx=>tx.execute<{view:boolean;pay:boolean}>(sql`select app.contract_shared_permitted('view',${b.companyId}::uuid) as view,app.contract_shared_permitted('seePay',${b.companyId}::uuid) as pay`));
  expect(rights).toEqual({view:true,pay:false});
  const access=await contractSharedAccess(admin);expect(access.roles.find(r=>r.id===id)?.permissions).toEqual(['view','decide']);
  expect(access.members.some(m=>m.userId===plain.userId)).toBe(true);
  await expect(saveContractSharedRole(admin,{id,name:'Stale role',permissions:['seePay'],expectedRevision:0})).rejects.toMatchObject({code:'conflict'});
 });
 it('checks group references and settings revision, without changing existing legacy settings',async()=>{
  const before=await contractSharedSettings(admin,b.companyId);expect(before.revision).toBe(0);
  const [native]=await owner.db.execute<{id:string}>(sql`select data->>'peopleOpsGroup' as id from lc_v9_config where tenant_id=${b.tenantId}::uuid`);
  const settings={...DEFAULT_CONTRACT_FLOW_SETTINGS,fallbackGroupId:native.id,postingApproverGroupId:native.id};
  expect(await saveContractSharedSettings(admin,{companyId:b.companyId,expectedRevision:0,settings})).toEqual({revision:1});
  expect((await contractSharedSettings(admin,b.companyId)).settings).toEqual(settings);
  await expect(saveContractSharedSettings(admin,{companyId:b.companyId,expectedRevision:0,settings})).rejects.toMatchObject({code:'conflict'});
  await expect(saveContractSharedSettings(admin,{companyId:b.companyId,expectedRevision:1,settings:{...settings,fallbackGroupId:'deleted-group'}})).rejects.toMatchObject({code:'invalid'});
 });
 it('limits role administration to tenant-wide grants and refuses stale assignment changes',async()=>{
  const plain=await ordinary(),roleId=randomUUID(),id=randomUUID();
  await saveContractSharedRole(admin,{id:roleId,name:'Scoped configuration',permissions:['view','access'],expectedRevision:0});
  const assignment={id,roleId,userId:plain.userId,companyId:b.companyId,businessGroupId:null,validFrom:'2020-01-01',validTo:null,revoked:false};
  await saveContractSharedMember(admin,assignment);
  await expect(contractSharedAccess(plain)).rejects.toMatchObject({code:'forbidden'});
  await expect(saveContractSharedMember(admin,{...assignment,id:randomUUID()})).rejects.toMatchObject({code:'invalid'});
  await expect(saveContractSharedMember(admin,{...assignment,revoked:true,expectedRevision:0})).rejects.toMatchObject({code:'conflict'});
  await saveContractSharedMember(admin,{...assignment,revoked:true,expectedRevision:1});
  const [rights]=await withTenant(plain,tx=>tx.execute<{view:boolean}>(sql`select app.contract_shared_permitted('view',${b.companyId}::uuid) as view`));
  expect(rights.view).toBe(false);
 });
});
describe('Contract shared document versions and workflows',()=>{
 it('keeps Workflow, Template and Assignment-group permissions independent in the stores and template picker',async()=>{
  const plain=await ordinary(),roleId=randomUUID(),doc=template();
  await saveAutomationDocumentTemplate(admin,{template:doc,expectedRevision:0,publish:true,retired:false});
  await saveContractSharedRole(admin,{id:roleId,name:'Workflow editor only',permissions:['workflows'],expectedRevision:0});
  await saveContractSharedMember(admin,{id:randomUUID(),roleId,userId:plain.userId,companyId:b.companyId,businessGroupId:null,validFrom:'2020-01-01',validTo:null,revoked:false});
  expect((await automationBuilderAccess(plain,'workflows')).contractStaff).toBe(true);
  expect((await automationBuilderAccess(plain,'templates')).contractStaff).toBe(false);
  expect((await automationBuilderAccess(plain,'groups')).contractStaff).toBe(false);
  expect((await automationTemplateChoices(plain,'contract_staff')).documents.map(document=>document.id)).toContain(doc.id);
  expect(await listAutomationDocumentTemplates(plain,'contract_staff')).toEqual([]);
  const workflow:AutomationWorkflow={id:randomUUID(),module:'contract_staff',name:'Draft workflow',description:'',status:'paused',required:false,trigger:{event:'caseOpened',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[]};
  expect((await saveAutomationWorkflow(plain,{workflow,expectedRevision:0,reason:'Authorized workflow draft'})).revision).toBe(1);
  await expect(saveAutomationDocumentTemplate(plain,{template:{...doc,id:randomUUID()},expectedRevision:0,publish:false,retired:false})).rejects.toMatchObject({code:'forbidden'});
  await expect(saveAutomationRouting(plain,{routing:{id:randomUUID(),name:'Not authorized',rows:[]},expectedRevision:0,retired:false,reason:'Must refuse'})).rejects.toMatchObject({code:'forbidden'});
  await expect(saveAutomationEmailTemplate(plain,{template:{id:randomUUID(),module:'contract_staff',name:'No template right',active:true,subject:'Subject',body:'Message',cc:[]},expectedRevision:0,retired:false,reason:'Must refuse'})).rejects.toMatchObject({code:'forbidden'});
  await saveContractSharedRole(admin,{id:roleId,name:'Templates editor only',permissions:['templates'],expectedRevision:1});
  expect((await automationBuilderAccess(plain,'workflows')).contractStaff).toBe(false);
  expect((await automationBuilderAccess(plain,'templates')).contractStaff).toBe(true);
  expect(await listAutomationWorkflows(plain,{module:'contract_staff'})).toEqual([]);
  await expect(saveAutomationWorkflow(plain,{workflow:{...workflow,id:randomUUID()},expectedRevision:0,reason:'Must refuse'})).rejects.toMatchObject({code:'forbidden'});
 });
 it('retains rich email source in an immutable new revision without rewriting the old plain message',async()=>{
  const email={id:randomUUID(),module:'contract_staff' as const,name:'Contract letter email',active:true,subject:'Contract update',body:'Dear {{employee.name}}',cc:[]};
  await saveAutomationEmailTemplate(admin,{template:email,expectedRevision:0,retired:false,reason:'Plain version'});
  const bodyDoc=automationEmailBodyDoc(email);
  await saveAutomationEmailTemplate(admin,{template:{...email,bodyDoc},expectedRevision:1,retired:false,reason:'Rich version'});
  const revisions=await owner.db.execute<{revision:number;bodyDoc:unknown}>(sql`select revision,body_doc as "bodyDoc" from automation_email_template_version where tenant_id=${b.tenantId}::uuid and template_id=${email.id}::uuid order by revision`);
  expect(revisions).toEqual([{revision:1,bodyDoc:null},{revision:2,bodyDoc}]);
  expect((await listAutomationEmailTemplates(admin,{module:'contract_staff'}))[0].template.bodyDoc).toEqual(bodyDoc);
 });
 it('publishes Review-only Contract templates, protects immutable versions and isolates modules',async()=>{
  const doc=template();
  expect((await saveAutomationDocumentTemplate(admin,{template:doc,expectedRevision:0,publish:true,retired:false})).revision).toBe(1);
  expect((await listAutomationDocumentTemplates(admin,'contract_staff'))[0]).toMatchObject({revision:1,liveVersion:1,template:{id:doc.id}});
  await saveAutomationDocumentTemplate(admin,{template:{...doc,name:'Updated title'},expectedRevision:1,publish:false,retired:false});
  expect((await automationDocumentVersions(admin,doc.id)).map(v=>v.template.name)).toEqual(['Updated title','Contract renewal']);
  expect((await listAutomationDocumentTemplates(admin,'contract_staff'))[0].liveVersion).toBe(1);
  await expect(saveAutomationDocumentTemplate(admin,{template:doc,expectedRevision:1,publish:true,retired:false})).rejects.toMatchObject({code:'conflict'});
  await expect(saveAutomationDocumentTemplate(admin,{template:{...doc,routing:[]},expectedRevision:2,publish:true,retired:false})).rejects.toMatchObject({code:'invalid'});
  const plain=await ordinary();expect(await listAutomationDocumentTemplates(plain,'contract_staff')).toEqual([]);
 });
 it('validates nested approval references and the published document before making a Contract workflow Live',async()=>{
  const doc=template();await saveAutomationDocumentTemplate(admin,{template:doc,expectedRevision:0,publish:true,retired:false});
  const workflow:AutomationWorkflow={id:randomUUID(),module:'contract_staff',name:'Renew',description:'',status:'live',required:false,trigger:{event:'decisionSubmitted',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[{field:'decision',op:'is',values:['Renew']}],steps:[
   {id:'approval',type:'requestApproval',to:[],cc:[],conditions:[],params:{layers:[{id:randomUUID(),name:'Direct Superior',approver:{kind:'role',role:'directSuperior'},pick:'any'}]}},
   {id:'letter',type:'generateDocument',to:[],cc:[],conditions:[],params:{letterTemplateId:doc.id}},
   {id:'posting',type:'createPosting',to:[],cc:[],conditions:[],params:{eventType:'Renewal'}},
  ]};
  expect((await automationBuilderAccess(admin)).contractStaff).toBe(true);
  expect((await saveAutomationWorkflow(admin,{workflow,expectedRevision:0,reason:'Test Contract route'})).problems).toEqual([]);
  const missing=structuredClone(workflow);missing.id=randomUUID();missing.steps[0].params.layers=[{id:randomUUID(),name:'Missing approver',approver:{kind:'group',groupId:'removed'},pick:'any'}];
  await expect(saveAutomationWorkflow(admin,{workflow:missing,expectedRevision:0,reason:'Must refuse'})).rejects.toMatchObject({code:'invalid'});
 });
});
describe('native Personnel contract numbering',()=>{
 it('preserves unknown historical numbers, validates whole numbers and audits the native write',async()=>{
  const employee=await hireEmployee(admin,{person:{fullName:'Fictional numbered contractor',primaryEmail:randomUUID()+'@contracts.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'contract',hiredOn:'2026-01-01',provisionalEndOn:'2027-12-31'});
  const read=async()=>[...await owner.db.execute<{number:number|null}>(sql`select contract_number as number from employment where id=${employee.employmentId}::uuid`)][0].number;
  expect(await read()).toBeNull();
  await expect(setEmploymentInfo(admin,{employmentId:employee.employmentId,contractNumber:1.5})).rejects.toThrow('Contract number');
  await setEmploymentInfo(admin,{employmentId:employee.employmentId,contractNumber:4,contractStartDate:'2026-01-01',contractEndDate:'2027-12-31'});
  expect(await read()).toBe(4);
  const [event]=await owner.db.execute<{payload:{after:{contractNumber:number}}}>(sql`select payload from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${employee.employmentId}::uuid and event_type='employment.info.updated' order by sequence desc limit 1`);
  expect(event.payload.after.contractNumber).toBe(4);
  await expect(setEmploymentInfo(await ordinary(),{employmentId:employee.employmentId,contractNumber:9})).rejects.toThrow();
  expect(await read()).toBe(4);
 });
});
describe('bounded Contract projections',()=>{
 it('fences legacy raw and unredacted readers after adoption while retaining the authorized shared projection',async()=>{
  const manager=await hireEmployee(admin,{person:{fullName:'Fictional cutover manager',primaryEmail:randomUUID()+'@contracts.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
  const employee=await hireEmployee(admin,{person:{fullName:'Fictional cutover contractor',primaryEmail:randomUUID()+'@contracts.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'contract',hiredOn:'2026-01-01',provisionalEndOn:'2027-12-31',reportingManagerEmploymentId:manager.employmentId});
  await setEmploymentInfo(admin,{employmentId:employee.employmentId,contractNumber:4});
  const userId=await createAppUser(b.tenantId,manager.personId,'employee'),subject={...admin,userId,personId:manager.personId,roles:['employee'],grants:undefined};
  const termId=randomUUID(),caseId=randomUUID();
  await setEmploymentInfo(admin,{employmentId:employee.employmentId,contractStartDate:'2026-01-01',contractEndDate:'2027-12-31'});
  await owner.db.execute(sql`insert into contract_term(id,tenant_id,company_id,employment_id,version,kind,start_on,end_on,source_revision) values(${termId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${employee.employmentId}::uuid,1,'project','2026-01-01','2027-12-31','fixture')`);
  await owner.db.execute(sql`insert into contract_case(id,tenant_id,company_id,employment_id,term_id,number,revision,data) values(${caseId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${employee.employmentId}::uuid,${termId}::uuid,'CT-CUTOVER-1',1,jsonb_build_object('revision',1,'state','upcoming','term',jsonb_build_object('startOn','2026-01-01','endOn','2027-12-31'),'decision',NULL,'decisionDraft',NULL))`);
  const legacy=()=>withTenant(subject,tx=>tx.execute<{id:string}>(sql`select id from contract_case where id=${caseId}::uuid`));
  expect(await legacy()).toHaveLength(1);
  const decider=await ordinary(),decideRoleId=randomUUID();
  await saveContractSharedRole(admin,{id:decideRoleId,name:'Incomplete decision grant',permissions:['decide'],expectedRevision:0});
  await saveContractSharedMember(admin,{id:randomUUID(),roleId:decideRoleId,userId:decider.userId,companyId:b.companyId,businessGroupId:null,validFrom:'2020-01-01',validTo:null,revoked:false});
  await expect(withTenant(decider,tx=>tx.execute(sql`select app.contract_shared_adopt(${caseId}::uuid)`))).rejects.toThrow();
  expect(await legacy()).toHaveLength(1);
  await withTenant(admin,tx=>tx.execute(sql`select app.contract_shared_adopt(${caseId}::uuid)`));
  expect(await legacy()).toEqual([]);
  const [old]=await withTenant(subject,tx=>tx.execute<{source:unknown;projection:unknown}>(sql`select app.contract_case_source(${caseId}::uuid) as source,app.contract_case_projection(${caseId}::uuid) as projection`));
  expect(old).toEqual({source:null,projection:null});
  expect((await contractSharedContext(subject,caseId)).source).not.toHaveProperty('salaryCents');
  const viewer=await ordinary(),roleId=randomUUID();
  await saveContractSharedRole(admin,{id:roleId,name:'Cutover view without pay',permissions:['view'],expectedRevision:0});
  await saveContractSharedMember(admin,{id:randomUUID(),roleId,userId:viewer.userId,companyId:b.companyId,businessGroupId:null,validFrom:'2020-01-01',validTo:null,revoked:false});
  const detail=await contractSharedContext(viewer,caseId);
  expect(detail.flow?.period.number).toBe('4');expect(detail.source).not.toHaveProperty('salaryCents');
  expect(await withTenant(viewer,tx=>tx.execute(sql`select id from contract_case where id=${caseId}::uuid`))).toEqual([]);
 });
 it('pages 1,000 employments across 70 companies with native numbers and isolates a scoped viewer',async()=>{
  await owner.db.execute(sql`
   with companies as (
    insert into company(tenant_id,legal_name) select ${b.tenantId}::uuid,'Contract scale company '||lpad(n::text,2,'0') from generate_series(1,70) n returning id,legal_name
   ), numbered as materialized(select id,row_number() over(order by legal_name) as n from companies), fixture as materialized(
    select series.n,gen_random_uuid() as person_id,gen_random_uuid() as employment_id,gen_random_uuid() as term_id,gen_random_uuid() as case_id,c.id as company_id
    from generate_series(1,1000) series(n) join numbered c on c.n=((series.n-1)%70)+1
   ), people as (
    insert into person(id,tenant_id,full_name,primary_email) select person_id,${b.tenantId}::uuid,'Contract scale employee '||lpad(n::text,4,'0'),'scale-'||n||'@contracts.test' from fixture
   ), employments as (
    insert into employment(id,tenant_id,person_id,company_id,hired_on,employee_code,contract_start_date,contract_end_date,contract_number)
    select employment_id,${b.tenantId}::uuid,person_id,company_id,'2026-01-01'::date,'SCALE-'||n,'2026-01-01'::date,'2027-12-31'::date,4 from fixture
   ), terms as (
    insert into contract_term(id,tenant_id,company_id,employment_id,version,kind,start_on,end_on,source_revision)
    select term_id,${b.tenantId}::uuid,company_id,employment_id,1,'project','2026-01-01'::date,'2027-12-31'::date,'scale-fixture' from fixture
   )
   insert into contract_case(id,tenant_id,company_id,employment_id,term_id,number,revision,data)
   select case_id,${b.tenantId}::uuid,company_id,employment_id,term_id,'CT-2026-'||lpad(n::text,4,'0'),1,
    jsonb_build_object('revision',1,'state','upcoming','term',jsonb_build_object('startOn','2026-01-01','endOn','2027-12-31'),'decision',NULL,'decisionDraft',NULL) from fixture`);
  admin={...await entitledCtx(b),personId:admin.personId};
  const first=await contractSharedPage(admin,{limit:50}),second=await contractSharedPage(admin,{limit:50,offset:50}),last=await contractSharedPage(admin,{limit:50,offset:950});
  expect(first.rows).toHaveLength(50);expect(second.rows).toHaveLength(50);expect(last.rows).toHaveLength(50);
  expect(first.hasMore).toBe(true);expect(last.hasMore).toBe(false);
  expect(first.rows.map(row=>row.employeeName)).toEqual(Array.from({length:50},(_,i)=>'Contract scale employee '+String(i+1).padStart(4,'0')));
  expect(new Set([...first.rows,...second.rows].map(row=>row.employmentId)).size).toBe(100);
  expect(first.rows.every(row=>row.contractNumber===4&&!('salaryCents' in row))).toBe(true);
  const plain=await ordinary(),roleId=randomUUID(),companyId=first.rows[0].companyId;
  await saveContractSharedRole(admin,{id:roleId,name:'One company viewer',permissions:['view'],expectedRevision:0});
  await saveContractSharedMember(admin,{id:randomUUID(),roleId,userId:plain.userId,companyId,businessGroupId:null,validFrom:'2020-01-01',validTo:null,revoked:false});
  const scoped=await contractSharedPage(plain,{limit:100});
  expect(scoped.rows).toHaveLength(15);expect(scoped.rows.every(row=>row.companyId===companyId)).toBe(true);
  const detail=await contractSharedContext(plain,scoped.rows[0].id);
  expect(detail.source).not.toHaveProperty('salaryCents');expect(detail.source).not.toHaveProperty('allowanceCents');
  await expect(contractSharedContext(plain,first.rows[1].id)).rejects.toMatchObject({code:'forbidden'});
  await expect(withTenant(plain,tx=>tx.execute(sql`select data from contract_shared_case limit 1`))).rejects.toThrow();
  const snapshot=async()=>[...await owner.db.execute<{counts:unknown}>(sql`select jsonb_build_array(
   (select count(*) from domain_event where tenant_id=${b.tenantId}::uuid),
   (select count(*) from automation_run where tenant_id=${b.tenantId}::uuid),
   (select count(*) from automation_email_delivery where tenant_id=${b.tenantId}::uuid),
   (select count(*) from personnel_posting where tenant_id=${b.tenantId}::uuid),
   (select count(*) from contract_shared_case where tenant_id=${b.tenantId}::uuid),
   (select count(*) from contract_shared_letter where tenant_id=${b.tenantId}::uuid)) as counts`)][0].counts;
  const before=await snapshot();
  const workflow:AutomationWorkflow={id:randomUUID(),module:'contract_staff',name:'Test Contract preview',description:'',status:'live',required:false,trigger:{event:'decisionSubmitted',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[{field:'decision',op:'is',values:['Renew']}],steps:[{id:randomUUID(),type:'requestApproval',conditions:[],to:[],cc:[],params:{layers:[{id:randomUUID(),name:'CEO',pick:'any',approver:{kind:'person',userId:admin.userId}}]}}]};
  const preview=await dryRunContractWorkflow(admin,{caseId:first.rows[0].id,workflow,event:{decision:'Renew',payChanges:'No',termMonths:'6'}});
  expect(preview.run.wouldRun).toBe(true);expect(preview.run.steps[0].to).toEqual(['CEO: Fictional Contract administrator']);
  expect(preview.run.sends).toBe(false);expect(await snapshot()).toEqual(before);
  await expect(dryRunContractWorkflow(plain,{caseId:scoped.rows[0].id,workflow,event:{decision:'Renew'}})).rejects.toThrow();
 });
});
