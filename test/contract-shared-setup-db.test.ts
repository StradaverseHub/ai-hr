import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../db/client';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner,type Base} from './harness';
import {v9Setup,v9Workspace,v9SaveConfig} from '../packs/lifecycle/service';
import {saveAutomationRouting,saveAutomationWorkflow,listAutomationWorkflows,listAutomationDocumentTemplates,listAutomationEmailTemplates} from '../packs/automation/service';
import {contractSharedSetup,startContractSharedSetup,contractSetupJobHandler,contractSharedSettings,saveContractSharedMember,saveContractSharedRole} from '../packs/contracts/service';
import {contractDefaultId,type ContractStartingMappings} from '../lib/contract-starting-configuration';
import {readBulkJob} from '../core/bulk-job';
import {contractStartingConfigurationBeforeLetterMailFix} from './helpers/contract-starting-configuration-before-letter-mail-fix';
import {runBulkJobTick} from '../core/bulk-job-worker';
let b:Base,admin:SessionContext,mapping:ContractStartingMappings;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=await entitledCtx(b);
 const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional setup administrator',${randomUUID()+'@setup.test'}) returning id`);
 await owner.db.execute(sql`update app_user set person_id=${person.id}::uuid where tenant_id=${b.tenantId}::uuid and id=${admin.userId}::uuid`);admin={...admin,personId:person.id};await v9Setup(admin);
 const config=(await v9Workspace(admin)).config!,groupId=randomUUID();await v9SaveConfig(admin,config.revision,{...config,groups:[...config.groups,{id:groupId,name:'Mapped native People Ops',members:[admin.userId!],limit:0}],peopleOpsGroup:groupId});
 const bpRoutingId=randomUUID(),ceoRoutingId=randomUUID();
 for(const [id,name] of [[bpRoutingId,'Mapped BP routing'],[ceoRoutingId,'Mapped CEO routing']])await saveAutomationRouting(admin,{routing:{id,name,rows:[{match:{},assignTo:{kind:'group',groupId}}]},expectedRevision:0,retired:false,reason:'Actual setup mapping fixture'});
 mapping={companyId:b.companyId,fallbackGroupId:groupId,postingApproverGroupId:groupId,bpRoutingId,ceoRoutingId};
});
async function finish(id:string,selected=contractSetupJobHandler){
 let cause:unknown;
 const handler={...selected,describeFailure:async(...args:Parameters<NonNullable<typeof contractSetupJobHandler.describeFailure>>)=>{cause=args[1];return contractSetupJobHandler.describeFailure!(...args);}};
 for(let n=0;n<100;n++){
  const job=await readBulkJob(admin,id,'contract_setup');if(job.state==='failed')throw cause??new Error(job.error??'Setup failed');
  if(job.state==='completed'){expect(job.errors).toEqual([]);return job;}
  await runBulkJobTick(owner.client,{handlers:[handler]});
 }
 throw new Error('Setup did not finish');
}
describe('Mapped Contract starting setup on the existing human kernel',()=>{
 it('does not treat canonical shared groups alone as an initialized Contract projection',async()=>{
  await owner.db.execute(sql`delete from lc_v9_config where tenant_id=${b.tenantId}::uuid`);
  const state=await contractSharedSetup(admin,b.companyId);expect(state.v9Ready).toBe(false);expect(state.installed).toBe(false);expect(state.missing.join(' ')).toMatch(/authorized On\/Off Boarding administrator/);
  await expect(startContractSharedSetup(admin,mapping)).rejects.toMatchObject({code:'forbidden'});
 });
 it('requires real populated groups and real published routings, and preserves ordinary-user denial',async()=>{
  expect((await contractSharedSetup(admin,b.companyId)).installed).toBe(false);
  await expect(startContractSharedSetup(admin,{...mapping,fallbackGroupId:'invented-group'})).rejects.toMatchObject({code:'forbidden'});
  await expect(startContractSharedSetup(admin,{...mapping,ceoRoutingId:randomUUID()})).rejects.toMatchObject({code:'forbidden'});
  const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional unauthorized setup requester',${randomUUID()+'@setup.test'}) returning id`);
  const userId=await createAppUser(b.tenantId,person.id,'employee'),plain={...admin,userId,personId:person.id,roles:['employee'],grants:undefined} as SessionContext;
  await expect(startContractSharedSetup(plain,mapping)).rejects.toMatchObject({code:'forbidden'});
  const [jobs]=await owner.db.execute<{count:number}>(sql`select count(*)::int as count from bulk_job where tenant_id=${b.tenantId}::uuid and kind='contract_setup'`);expect(jobs.count).toBe(0);
 });
 it('installs the reviewed definitions with an actual creator, and retries without overwriting custom changes or applying HR effects',async()=>{
  const {jobId}=await startContractSharedSetup(admin,mapping);const finished=await finish(jobId);
  expect(finished.created_by).toBe(admin.userId);expect(finished.steps_done).toBe(25);
  const state=await contractSharedSetup(admin,b.companyId);expect(state.installed).toBe(true);expect(state.accessReady).toBe(false);expect(state.missing.join(' ')).toContain('explicitly assign');
  const member={id:randomUUID(),roleId:contractDefaultId(401),userId:admin.userId!,companyId:null,businessGroupId:b.companyId,validFrom:'2026-01-01',validTo:null,revoked:false};await saveContractSharedMember(admin,member);expect((await contractSharedSetup(admin,b.companyId)).accessReady).toBe(true);expect((await contractSharedSetup(admin,b.companyId)).missing).toEqual([]);await saveContractSharedMember(admin,{...member,revoked:true,expectedRevision:1});expect((await contractSharedSetup(admin,b.companyId)).accessReady).toBe(false);
  const documents=await listAutomationDocumentTemplates(admin,'contract_staff');expect(documents).toHaveLength(5);expect(state.reviewNeeded).toEqual([]);
  const emails=await listAutomationEmailTemplates(admin,{module:'contract_staff'});expect(emails).toHaveLength(7);for(const [id,doc] of [[103,3],[104,5],[107,4]])expect(emails.find(item=>item.template.id===contractDefaultId(id))?.template.documentIds).toEqual([contractDefaultId(doc)]);
  for(const doc of documents)expect(doc.template.blocks[0]).toMatchObject({type:'letterhead'});
  const workflows=await listAutomationWorkflows(admin,{module:'contract_staff'});expect(workflows).toHaveLength(12);
  const renew=workflows.find(item=>item.workflow.id===contractDefaultId(204))!;
  await saveAutomationWorkflow(admin,{workflow:{...renew.workflow,name:'Consultant-reviewed renewal flow',status:'paused'},expectedRevision:renew.revision,reason:'Preserve a later authorized edit'});
  const next=await startContractSharedSetup(admin,mapping);await finish(next.jobId);
  const retained=(await listAutomationWorkflows(admin,{module:'contract_staff'})).find(item=>item.workflow.id===renew.workflow.id)!;
  expect(retained.revision).toBe(2);expect(retained.workflow.name).toBe('Consultant-reviewed renewal flow');expect(retained.workflow.status).toBe('paused');
  expect((await contractSharedSettings(admin,b.companyId)).settings.fallbackGroupId).toBe(mapping.fallbackGroupId);
  const [effects]=await owner.db.execute<{counts:number[]}>(sql`select array[(select count(*)::int from contract_case where tenant_id=${b.tenantId}::uuid),(select count(*)::int from automation_run where tenant_id=${b.tenantId}::uuid),(select count(*)::int from automation_email_delivery where tenant_id=${b.tenantId}::uuid),(select count(*)::int from personnel_posting where tenant_id=${b.tenantId}::uuid)] as counts`);
  expect(effects.counts).toEqual([0,0,0,0]);
 });
 it('retains genuine old installed and consultant versions after kernel cleanup and honestly requests manual review',async()=>{
  const historical=contractStartingConfigurationBeforeLetterMailFix(mapping),oldHandler:typeof contractSetupJobHandler={...contractSetupJobHandler,async prepare(){return {steps:[...historical.documents.map(definition=>({kind:'document',payload:{type:'document' as const,definition}})),...historical.emails.map(definition=>({kind:'email',payload:{type:'email' as const,definition}})),...historical.workflows.map(definition=>({kind:'workflow',payload:{type:'workflow' as const,definition}})),{kind:'settings',payload:{type:'settings' as const,definition:mapping}}],plan:{version:1}};}};
  const first=await startContractSharedSetup(admin,mapping);await finish(first.jobId,oldHandler);
  const [cleaned]=await owner.db.execute<{input:unknown;steps:number}>(sql`select input,(select count(*)::int from bulk_job_step where job_id=j.id) steps from bulk_job j where j.id=${first.jobId}::uuid`);expect(cleaned).toEqual({input:null,steps:0});
  const declined=(await listAutomationWorkflows(admin,{module:'contract_staff'})).find(item=>item.workflow.id===contractDefaultId(208))!;
  await saveAutomationWorkflow(admin,{workflow:{...declined.workflow,name:'Consultant-owned decline routing',status:'paused'},expectedRevision:1,reason:'A real later consultant change must survive setup'});
  const snapshot=async()=>[...await owner.db.execute<{kind:string;id:string;version:number;definition:unknown}>(sql`select 'document' kind,template_id::text id,version,definition from automation_document_template_version where tenant_id=${b.tenantId}::uuid union all select 'email',template_id::text,revision,to_jsonb(v)-'saved_at' from automation_email_template_version v where tenant_id=${b.tenantId}::uuid union all select 'workflow',workflow_id::text,revision,to_jsonb(w)-'saved_at' from automation_workflow_version w where tenant_id=${b.tenantId}::uuid order by kind,id,version`)];
  const before=await snapshot();const second=await startContractSharedSetup(admin,mapping);await finish(second.jobId);
  const after=await snapshot();expect(after.filter(row=>row.id!==contractDefaultId(107))).toEqual(before);
  expect(after.filter(row=>row.id===contractDefaultId(107))).toHaveLength(1);
  const state=await contractSharedSetup(admin,b.companyId);expect(state.installed).toBe(true);expect(state.reviewNeeded).toHaveLength(8);expect(state.reviewNeeded).toContainEqual({kind:'workflow',id:contractDefaultId(208),name:'Consultant-owned decline routing'});expect(state.reviewNeeded).toContainEqual({kind:'email',id:contractDefaultId(103),name:'Your end-of-contract letter'});
  const third=await startContractSharedSetup(admin,mapping);await finish(third.jobId);expect(await snapshot()).toEqual(after);
  const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional access-only administrator',${randomUUID()+'@setup.test'}) returning id`);const userId=await createAppUser(b.tenantId,person.id,'employee'),roleId=randomUUID();await saveContractSharedRole(admin,{id:roleId,name:'Actual setup access only',permissions:['access'],expectedRevision:0});await saveContractSharedMember(admin,{id:randomUUID(),roleId,userId,companyId:null,businessGroupId:null,validFrom:'2020-01-01',validTo:null,revoked:false});
  const accessOnly={...admin,userId,personId:person.id,roles:['employee'],grants:undefined} as SessionContext,hidden=await contractSharedSetup(accessOnly,b.companyId);expect(hidden.canInstall).toBe(false);expect(hidden.reviewNeeded).toEqual([]);

 });

});
