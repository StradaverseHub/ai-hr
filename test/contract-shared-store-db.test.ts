import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
import {v9Setup} from '../packs/lifecycle/service';
import {automationBuilderAccess,automationDocumentVersions,listAutomationDocumentTemplates,saveAutomationDocumentTemplate,saveAutomationWorkflow,type AutomationWorkflow} from '../packs/automation/service';
import {contractSharedAccess,contractSharedSettings,saveContractSharedMember,saveContractSharedRole,saveContractSharedSettings} from '../packs/contracts/service';
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
  await saveContractSharedMember(admin,{id:randomUUID(),roleId:id,userId:plain.userId,companyId:b.companyId,businessUnitId:null,validFrom:'2020-01-01',validTo:null,revoked:false});
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
 it('does not turn scoped Manage access into tenant-wide administration and refuses stale assignment changes',async()=>{
  const plain=await ordinary(),roleId=randomUUID(),id=randomUUID();
  await saveContractSharedRole(admin,{id:roleId,name:'Scoped configuration',permissions:['view','access'],expectedRevision:0});
  const assignment={id,roleId,userId:plain.userId,companyId:b.companyId,businessUnitId:null,validFrom:'2020-01-01',validTo:null,revoked:false};
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
  await setEmploymentInfo(admin,{employmentId:employee.employmentId,contractNumber:4});
  expect(await read()).toBe(4);
  const [event]=await owner.db.execute<{payload:{after:{contractNumber:number}}}>(sql`select payload from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${employee.employmentId}::uuid and event_type='employment.info.updated' order by sequence desc limit 1`);
  expect(event.payload.after.contractNumber).toBe(4);
  await expect(setEmploymentInfo(await ordinary(),{employmentId:employee.employmentId,contractNumber:9})).rejects.toThrow();
  expect(await read()).toBe(4);
 });
});
