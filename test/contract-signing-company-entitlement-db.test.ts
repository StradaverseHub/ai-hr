import {recordDocumentSigningActionTx} from '../packs/document-signing/service';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner} from './harness';
import {hireEmployee,setEmploymentInfo} from '../core/org';
import {setCompensation} from '../core/comp';
import {v9Setup,v9Workspace,v9SaveConfig} from '../packs/lifecycle/service';
import {adoptContractSharedCase,previewContractSharedDecision,submitContractSharedDecision,contractPreviewJobHandler,contractAutomationJobHandler,readContractSharedApproval,actContractSharedApproval,readContractSharedLetter,actContractSharedLetter} from '../packs/contracts/service';
import {saveAutomationDocumentTemplate,saveAutomationWorkflow,type AutomationWorkflow} from '../packs/automation/service';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {readBulkJob} from '../core/bulk-job';
import {todayInKualaLumpur} from '../lib/hr-date';
import {isModuleEnabled} from '../core/entitlements';

beforeAll(migrateTestDb);afterAll(closeAll);
const year=Number(todayInKualaLumpur().slice(0,4));
const start=`${year}-01-01`,end=`${year}-12-31`;
async function fixture(){
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'lifecycle','active');let admin=await entitledCtx(b);
 const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional Contract preview administrator',${randomUUID()+'@preview.test'}) returning id`);
 await owner.db.execute(sql`update app_user set person_id=${person.id}::uuid where tenant_id=${b.tenantId}::uuid and id=${admin.userId}::uuid`);admin={...admin,personId:person.id};
 await v9Setup(admin);const config=(await v9Workspace(admin)).config!,groupId=config.peopleOpsGroup;
 await v9SaveConfig(admin,config.revision,{...config,groups:config.groups.map(g=>g.id===groupId?{...g,members:[...new Set([...g.members,admin.userId!])]}:g)});
 const manager=await hireEmployee(admin,{person:{fullName:'Fictional Contract proposer',primaryEmail:randomUUID()+'@preview.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:start});
 const managerId=await createAppUser(b.tenantId,manager.personId,'employee');
 const proposer:SessionContext={...admin,userId:managerId,personId:manager.personId,roles:['employee'],grants:undefined};
 const employee=await hireEmployee(admin,{person:{fullName:'Fictional Contract subject',primaryEmail:randomUUID()+'@preview.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'contract',hiredOn:start,provisionalEndOn:end,reportingManagerEmploymentId:manager.employmentId});
 await setEmploymentInfo(admin,{employmentId:employee.employmentId,contractStartDate:start,contractEndDate:end,contractNumber:4});
 await setCompensation(admin,{employmentId:employee.employmentId,basicSalary:4976.21,effectiveFrom:start});
 const termId=randomUUID(),caseId=randomUUID();
 await owner.db.execute(sql`insert into contract_term(id,tenant_id,company_id,employment_id,version,kind,start_on,end_on,source_revision) values(${termId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${employee.employmentId}::uuid,1,'project',${start}::date,${end}::date,'fixture-native-period')`);
 await owner.db.execute(sql`insert into contract_case(id,tenant_id,company_id,employment_id,term_id,number,revision,data) values(${caseId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${employee.employmentId}::uuid,${termId}::uuid,'CT-PREVIEW-1',1,jsonb_build_object('revision',1,'state','upcoming','term',jsonb_build_object('startOn',${start}::text,'endOn',${end}::text),'decision',NULL,'decisionDraft',NULL))`);
 await adoptContractSharedCase(proposer,caseId);
 const templateId=randomUUID();
 await saveAutomationDocumentTemplate(admin,{template:{id:templateId,module:'contract_staff',name:'Contract renewal outcome',description:'Fictional wording',rules:{decision:['Renew']},blocks:[{id:'intro',type:'text',text:'Dear {employee.name}',section:''}],fields:[],routing:[{id:randomUUID(),order:1,action:'review',owner:true,who:{kind:'group',groupId}},{id:randomUUID(),order:2,action:'sign',owner:false,who:{kind:'employee'}}]},expectedRevision:0,publish:true,retired:false});
 const workflow:AutomationWorkflow={id:randomUUID(),module:'contract_staff',name:'Contract renewal decision',description:'',status:'live',required:false,trigger:{event:'decisionSubmitted',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[{field:'decision',op:'is',values:['Renew']}],steps:[
  {id:randomUUID(),type:'requestApproval',conditions:[],to:[],cc:[],params:{layers:[{id:randomUUID(),name:'CEO',pick:'any',approver:{kind:'person',userId:admin.userId}}]}},
  {id:randomUUID(),type:'generateDocument',conditions:[],to:[],cc:[],params:{letterTemplateId:templateId}},
  {id:randomUUID(),type:'createPosting',conditions:[],to:[],cc:[],params:{eventType:'Renewal'}},
 ]};
 await saveAutomationWorkflow(admin,{workflow,expectedRevision:0,reason:'Reviewed Contract decision fixture'});
 return {b,admin,proposer,employee,caseId,groupId,workflow};
}
async function finishPreview(id:string,as:SessionContext){
 let failure:unknown;
 const diagnostic={...contractPreviewJobHandler,describeFailure:async(...args:Parameters<NonNullable<typeof contractPreviewJobHandler.describeFailure>>)=>{
  failure=args[1];return contractPreviewJobHandler.describeFailure!(...args);
 }};
 for(let count=0;count<30;count++){
  const job=await readBulkJob(as,id,'contract_preview');
  if(job.state==='failed')throw failure??new Error(job.error??'Protected Contract preview failed.');
  if(['completed','failed','cancelled'].includes(job.state))return job;
  await runBulkJobTick(owner.client,{handlers:[diagnostic]});
 }
 throw new Error('Protected Contract preview did not finish.');
}
async function finishAutomation(id:string,as:SessionContext){
 let failure:unknown;
 const diagnostic={...contractAutomationJobHandler,describeFailure:async(...args:Parameters<NonNullable<typeof contractAutomationJobHandler.describeFailure>>)=>{
  failure=args[1];return contractAutomationJobHandler.describeFailure!(...args);
 }};
 for(let count=0;count<100;count++){
  const job=await readBulkJob(as,id,'contract_automation');
  if(job.state==='failed')throw failure??new Error(job.error??'Protected Contract automation failed.');
  if(['completed','cancelled'].includes(job.state))return job;
  await runBulkJobTick(owner.client,{handlers:[diagnostic]});
 }
 throw new Error('Protected Contract automation did not finish.');
}
describe('Contract canonical signing company entitlement guard',()=>{
 it('refuses approval and ordinary Letter writes when only another company retains Lifecycle',async()=>{
  // Unwanted-success proof is retained separately at ef1bcc4a7 / hosted43963344028.
  const f=await fixture();
  const [companyB]=await owner.db.execute<{id:string}>(sql`insert into company(tenant_id,legal_name) values(${f.b.tenantId}::uuid,'Fictional unrelated Lifecycle company B') returning id`);
  const requested=await previewContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,draft:{kind:'renew',months:6,payChanges:false,reason:'Fictional entitlement boundary proof'}});
  await finishPreview(requested.jobId,f.proposer);
  const accepted=await submitContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,previewId:requested.previewId});await finishAutomation(accepted.jobId,f.proposer);
  const [approvalRow]=await owner.db.execute<{id:string}>(sql`select id from contract_shared_approval where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid`);
  const before=await readContractSharedApproval(f.admin,approvalRow.id);expect(before.canAct).toBe(true);
  await setModule(f.b.tenantId,'lifecycle',null);
  await setModule(f.b.tenantId,'lifecycle','active',companyB.id);
  async function fresh(){return {...await entitledCtx(f.b),personId:f.admin.personId};}
  async function proveOff(as:SessionContext){
   expect(isModuleEnabled(as,'lifecycle',f.b.companyId)).toBe(false);
   expect(isModuleEnabled(as,'lifecycle',companyB.id)).toBe(true);
   const [native]=await withTenant(as,tx=>tx.execute<{a:boolean;b:boolean}>(sql`select app.contract_company_entitled(${f.b.companyId}::uuid) as a,app.contract_company_entitled(${companyB.id}::uuid) as b`));
   expect(native).toEqual({a:false,b:true});
  }
  const approvalActor=await fresh();await proveOff(approvalActor);
  const readonlyApproval=await readContractSharedApproval(approvalActor,before.id);expect(readonlyApproval.canAct).toBe(false);expect(readonlyApproval.history).toHaveLength(0);
  await expect(actContractSharedApproval(approvalActor,{id:before.id,actionId:randomUUID(),layerId:before.pendingLayerId!,revision:before.contentRevision,hash:before.contentHash,action:'approve',reason:'Fictional actual assigned approval'})).rejects.toMatchObject({code:'conflict'});
  const [approvalSigning]=await owner.db.execute<{id:string}>(sql`select signing_document_id as id from contract_shared_approval where tenant_id=${f.b.tenantId}::uuid and id=${before.id}::uuid`);
  await expect(withTenant(approvalActor,tx=>recordDocumentSigningActionTx(tx,approvalActor,{id:approvalSigning.id,actionId:randomUUID(),stepId:before.pendingLayerId!,revision:before.contentRevision,hash:before.contentHash,action:'approved',comment:'A disabled company cannot use the generic entry point'}))).rejects.toThrow();
  expect((await readContractSharedApproval(approvalActor,before.id)).history).toHaveLength(0);
  // Enable A only while the original held workflow generates its actual ordinary outcome letter.
  await setModule(f.b.tenantId,'lifecycle','active',f.b.companyId);
  const enabled=await fresh(),enabledApproval=await readContractSharedApproval(enabled,before.id);expect(enabledApproval.canAct).toBe(true);
  await actContractSharedApproval(enabled,{id:before.id,actionId:randomUUID(),layerId:before.pendingLayerId!,revision:before.contentRevision,hash:before.contentHash,action:'approve',reason:'The actual company is enabled again'});
  const [event]=await owner.db.execute<{job:string}>(sql`select job_id as job from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid and trigger_event='approvalsComplete'`);
  await finishAutomation(event.job,await fresh());
  const [letterRow]=await owner.db.execute<{id:string;purpose:string}>(sql`select id,purpose from contract_shared_letter where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid`);
  expect(letterRow.purpose).toBe('outcome');
  const letterBefore=await readContractSharedLetter(await fresh(),letterRow.id);expect(letterBefore.pendingAction?.kind).toBe('review');
  await setModule(f.b.tenantId,'lifecycle','disabled',f.b.companyId);
  const letterActor=await fresh();await proveOff(letterActor);
  const readonlyLetter=await readContractSharedLetter(letterActor,letterBefore.id);expect(readonlyLetter.body).not.toBeNull();expect(readonlyLetter.pendingAction).toBeNull();expect(readonlyLetter.canEdit).toBe(false);
  await expect(actContractSharedLetter(letterActor,{id:letterBefore.id,actionId:randomUUID(),stepId:letterBefore.pendingAction!.stepId,revision:letterBefore.contentRevision,hash:letterBefore.contentHash!,action:'reviewed'})).rejects.toMatchObject({code:'forbidden'});
  const [letterSigning]=await owner.db.execute<{id:string}>(sql`select signing_document_id as id from contract_shared_letter where tenant_id=${f.b.tenantId}::uuid and id=${letterBefore.id}::uuid`);
  await expect(withTenant(letterActor,tx=>recordDocumentSigningActionTx(tx,letterActor,{id:letterSigning.id,actionId:randomUUID(),stepId:letterBefore.pendingAction!.stepId,revision:letterBefore.contentRevision,hash:letterBefore.contentHash!,action:'reviewed',comment:'A disabled company cannot bypass the Contract action'}))).rejects.toThrow();
  const [retained]=await owner.db.execute<{actions:number}>(sql`select jsonb_array_length(d.data->'actions') as actions from contract_shared_letter l join document_signing_document d on d.tenant_id=l.tenant_id and d.id=l.signing_document_id where l.tenant_id=${f.b.tenantId}::uuid and l.id=${letterRow.id}::uuid`);
  expect(retained.actions).toBe(0);
  await setModule(f.b.tenantId,'lifecycle','active',f.b.companyId);const restored=await fresh(),ready=await readContractSharedLetter(restored,letterBefore.id);expect(ready.pendingAction?.kind).toBe('review');
  const reviewed=await actContractSharedLetter(restored,{id:ready.id,actionId:randomUUID(),stepId:ready.pendingAction!.stepId,revision:ready.contentRevision,hash:ready.contentHash!,action:'reviewed'});expect(reviewed.history).toHaveLength(1);
 },120_000);
});
