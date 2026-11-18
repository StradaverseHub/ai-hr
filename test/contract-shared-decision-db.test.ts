import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner} from './harness';
import {hireEmployee,setEmploymentInfo} from '../core/org';
import {setCompensation} from '../core/comp';
import {v9Setup,v9Workspace,v9SaveConfig} from '../packs/lifecycle/service';
import {adoptContractSharedCase,previewContractSharedDecision,readContractSharedDecisionPreview,submitContractSharedDecision,contractSharedHistory,contractSharedContext,contractPreviewJobHandler,contractAutomationJobHandler,readContractSharedApproval,actContractSharedApproval,readContractSharedLetter,actContractSharedLetter,renderContractSharedLetter,bindContractSharedEmployee} from '../packs/contracts/service';
import {saveAutomationDocumentTemplate,saveAutomationWorkflow,saveAutomationEmailTemplate,automationEmailBodyDoc,automationBuilderAccess,type AutomationWorkflow} from '../packs/automation/service';
import {runBulkJobTick} from '../core/bulk-job-worker';
import {readBulkJob} from '../core/bulk-job';
import {todayInKualaLumpur} from '../lib/hr-date';
import {TERMINATION_REASONS} from '../core/termination-reason';
import {contractSharedManualWorkflows,startContractSharedManualWorkflow,readContractSharedReleaseProof,saveContractSharedRole,saveContractSharedMember} from '../packs/contracts/service';

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
async function finishPreview(id:string,as:SessionContext,statementTimeoutMs?:number){
 let failure:unknown;
 const diagnostic:typeof contractPreviewJobHandler={...contractPreviewJobHandler,async finalize(ctx,job,unit){
  if(statementTimeoutMs===undefined)return contractPreviewJobHandler.finalize!(ctx,job,unit);
  // The real held owner transaction awaits cancellation/rollback; Vitest must not abandon a live query.
  return contractPreviewJobHandler.finalize!(ctx,job,{...unit,ownerTx:run=>unit.ownerTx!(async connection=>{
   await connection`select set_config('statement_timeout',${String(statementTimeoutMs)},true),set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id','',true),set_config('jit','off',true)`;
   const [native]=await connection<{body:string;sourceHash:string;owner:string;role:string;caseId:string;actorUserId:string;actorPersonId:string;boundActorPersonId:string|null}[]>`select p.prosrc as body,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') as "sourceHash",p.proowner::regrole::text as owner,current_user as role,preview.case_id as "caseId",preview.requested_by as "actorUserId",preview.requested_person_id as "actorPersonId",app.contract_actor_person(preview.requested_by) as "boundActorPersonId" from pg_proc p join contract_shared_preview preview on preview.tenant_id=${ctx.tenantId}::uuid and preview.job_id=${job.id}::uuid where p.oid='app.contract_shared_setup_revision(uuid)'::regprocedure`;
   if(!native)throw Error('Actual held preview/setup source unavailable for the performance diagnostic');
   // A plain EXPLAIN of the exact live SELECT is useful only under its actual definer identity.
   expect(native.role).toBe(native.owner);
   // Exact live forward body: never let an old==old oracle mask a skipped migration.
   expect(native.sourceHash).toBe('ed94a2c8c9982bf59bc45b4afaa87748b2fb0257abcc764b99619de345479f8a');
   expect(native.actorUserId).toBe(ctx.userId);expect(native.actorPersonId).toBeTruthy();expect(native.boundActorPersonId).toBe(native.actorPersonId);
   const query=native.body.trim().replace(/;$/, '').replace(/\bp_case\b/g,()=>'$1::uuid');
   const [planning]=await connection<{mode:string}[]>`select current_setting('plan_cache_mode') as mode`;
   await connection`select set_config('plan_cache_mode','force_generic_plan',true)`;
   const plan=await connection.unsafe('explain (format json,verbose,costs) '+query,[native.caseId]);
   await connection`select set_config('plan_cache_mode',${planning.mode},true)`;
   console.info('[Actual native Contract setup source plan]',JSON.stringify({sourceHash:native.sourceHash,owner:native.owner,role:native.role,jobId:job.id,caseId:native.caseId,diagnosticPlanMode:'force_generic_plan',nativePlanMode:planning.mode,plan}));
   return run(connection);
  })});
 },describeFailure:async(...args:Parameters<NonNullable<typeof contractPreviewJobHandler.describeFailure>>)=>{
  failure=args[1];return contractPreviewJobHandler.describeFailure!(...args);
 }};
 for(let count=0;count<30;count++){
  const job=await readBulkJob(as,id,'contract_preview');
  if(job.state==='failed')throw failure??new Error(job.error??'Protected Contract preview failed.');
  if(job.state==='cancelled')throw new Error('Protected Contract preview was cancelled.');
  if(job.state==='completed')return job;
  await runBulkJobTick(owner.client,{handlers:[diagnostic]});
 }
 throw new Error('Protected Contract preview did not finish.');
}
async function finishAutomation(id:string,as:SessionContext,handler=contractAutomationJobHandler){
 let failure:unknown;
 const diagnostic={...handler,describeFailure:async(...args:Parameters<NonNullable<typeof contractAutomationJobHandler.describeFailure>>)=>{
  failure=args[1];return handler.describeFailure!(...args);
 }};
 for(let count=0;count<100;count++){
  const job=await readBulkJob(as,id,'contract_automation');
  if(job.state==='failed')throw failure??new Error(job.error??'Protected Contract automation failed.');
  if(job.state==='cancelled')throw new Error('Protected Contract automation was cancelled.');
  if(job.state==='completed')return job;
  await runBulkJobTick(owner.client,{handlers:[diagnostic]});
 }
 throw new Error('Protected Contract automation did not finish.');
}
const draft={kind:'renew' as const,months:6,payChanges:false,reason:'Continue the agreed role'};
let f:Awaited<ReturnType<typeof fixture>>;
beforeEach(async()=>{f=await fixture();});
describe('protected Contract decision preview and submission',()=>{
 it('enforces the Contract reminder range at the real server writer before publishing',async()=>{
  const reminder:AutomationWorkflow={...f.workflow,id:randomUUID(),name:'Bounded Contract reminder',trigger:{event:'beforeContractEnd',days:365,workdays:false,repeat:false},conditions:[],steps:[{id:randomUUID(),type:'notify',conditions:[],to:[{kind:'person',userId:f.admin.userId!}],cc:[],params:{subject:'Contract period reminder',body:'Review the current contract period.'}}]};
  expect((await saveAutomationWorkflow(f.admin,{workflow:reminder,expectedRevision:0,reason:'Valid maximum Contract reminder'})).revision).toBe(1);
  await expect(saveAutomationWorkflow(f.admin,{workflow:{...reminder,trigger:{...reminder.trigger,days:366}},expectedRevision:1,reason:'Outside the Contract reminder range'})).rejects.toMatchObject({code:'invalid'});
  const[retained]=await owner.db.execute<{revision:number;days:number}>(sql`select revision,(definition->'trigger'->>'days')::integer as days from automation_workflow_version where tenant_id=${f.b.tenantId}::uuid and workflow_id=${reminder.id}::uuid order by revision desc limit 1`);
  expect(retained).toEqual({revision:1,days:365});
  expect((await saveAutomationWorkflow(f.admin,{workflow:{...reminder,trigger:{...reminder.trigger,days:0}},expectedRevision:1,reason:'Same-day Contract reminder'})).revision).toBe(2);
 });
 it('checks manual conditions and scope before admission, then retains the selected version exactly once',async()=>{
  const workflow:AutomationWorkflow={...f.workflow,id:randomUUID(),name:'Manual case follow-up',trigger:{event:'manual',days:0,workdays:false,repeat:false},conditions:[{field:'decision',op:'isNot',values:['Renew']},{field:'daysToEnd',op:'gte',values:['0']}],steps:[{id:randomUUID(),type:'notify',conditions:[],to:[{kind:'person',userId:f.admin.userId!}],cc:[],params:{subject:'Manual follow-up',body:'Review this Contract case.'}}]};
  const unmatched={...workflow,id:randomUUID(),name:'Renew-only follow-up',conditions:[{field:'decision',op:'is' as const,values:['Renew']}]};
  await saveAutomationWorkflow(f.admin,{workflow,expectedRevision:0,reason:'Real manual workflow fixture'});
  await saveAutomationWorkflow(f.admin,{workflow:unmatched,expectedRevision:0,reason:'Does not match the current case'});
  await expect(contractSharedManualWorkflows(f.proposer,f.caseId)).rejects.toMatchObject({code:'forbidden'});
  const roleId=randomUUID();await saveContractSharedRole(f.admin,{id:roleId,name:'Manual Contract operator',permissions:['view','manual'],expectedRevision:0});
  await saveContractSharedMember(f.admin,{id:randomUUID(),roleId,userId:f.proposer.userId!,companyId:f.b.companyId,businessGroupId:null,validFrom:start,validTo:null,revoked:false});
  const choices=await contractSharedManualWorkflows(f.proposer,f.caseId);expect(choices.map(choice=>choice.id)).toEqual([workflow.id]);
  await expect(startContractSharedManualWorkflow(f.proposer,{caseId:f.caseId,revision:1,workflowId:unmatched.id,workflowRevision:1,requestId:randomUUID()})).rejects.toMatchObject({code:'invalid'});
  const [before]=await owner.db.execute<{events:number}>(sql`select count(*)::int as events from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and trigger_event='manual'`);expect(before.events).toBe(0);
  await owner.db.execute(sql`update contract_shared_case set revision=revision+1,data=jsonb_set(jsonb_set(data,'{flags}','["no_workflow","fallback"]'::jsonb),'{revision}',to_jsonb(revision+1)) where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid`);
  const command={caseId:f.caseId,revision:(await contractSharedContext(f.proposer,f.caseId)).flow!.revision,workflowId:workflow.id,workflowRevision:1,requestId:randomUUID()};
  const accepted=await startContractSharedManualWorkflow(f.proposer,command);
  const reconciled=await contractSharedContext(f.proposer,f.caseId);
  expect(reconciled.flow?.flags).toEqual(['fallback']);
  expect(await startContractSharedManualWorkflow(f.proposer,command)).toEqual(accepted);
  expect((await contractSharedContext(f.proposer,f.caseId)).flow?.revision).toBe(reconciled.flow?.revision);
  await expect(startContractSharedManualWorkflow(f.proposer,{...command,workflowId:unmatched.id})).rejects.toMatchObject({code:'conflict'});
  await saveAutomationWorkflow(f.admin,{workflow:{...workflow,status:'paused'},expectedRevision:1,reason:'Accepted manual work keeps its version'});
  expect((await finishAutomation(accepted.jobId,f.proposer)).state).toBe('completed');
  const runs=await owner.db.execute<{workflow:string;revision:number;status:string}>(sql`select workflow_id as workflow,workflow_revision as revision,status from automation_run where tenant_id=${f.b.tenantId}::uuid and trigger_event='manual'`);
  expect([...runs]).toEqual([{workflow:workflow.id,revision:1,status:'done'}]);
  expect((await contractSharedContext(f.proposer,f.caseId)).source.contractNumber).toBe(4);
 });
 it('cancels an automatic Any-group approval email when its actual recipient leaves the group',async()=>{
  const origin='https://contract-group-mail-fixture.invalid';
  await owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${origin+'/auth/'+f.b.tenantId},${randomUUID()},${f.admin.userId!}::uuid)`);
  const first=f.workflow.steps[0];
  await saveAutomationWorkflow(f.admin,{workflow:{...f.workflow,steps:[{...first,params:{layers:[{id:randomUUID(),name:'People Ops approval',pick:'any',approver:{kind:'group',groupId:f.groupId}}]}},...f.workflow.steps.slice(1)]},expectedRevision:1,reason:'Actual group approval fixture'});
  const requested=await previewContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,draft});await finishPreview(requested.jobId,f.proposer);
  const accepted=await submitContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,previewId:requested.previewId});await finishAutomation(accepted.jobId,f.proposer);
  const [mail]=await owner.db.execute<{id:string}>(sql`select id from automation_email_delivery where tenant_id=${f.b.tenantId}::uuid and mail_key like 'approval:%'`);expect(mail).toBeTruthy();
  const token=randomUUID();await owner.db.execute(sql`update automation_email_delivery set status='leased',lease_token=${token}::uuid,lease_until=now()+interval '3 minutes' where id=${mail.id}::uuid`);
  const target=async()=>(await owner.db.execute<{target:unknown}>(sql`select app.automation_email_target(${mail.id}::uuid,${token}::uuid,${origin}) as target`))[0].target;
  expect(await target()).not.toBeNull();
  // The existing native configuration owner may revoke membership; the new shared add-only editor cannot.
  const config=(await v9Workspace(f.admin)).config!;
  await v9SaveConfig(f.admin,config.revision,{...config,groups:config.groups.map(group=>group.id===f.groupId?{...group,members:[]}:group)});
  expect(await target()).toBeNull();
 });
 it('keeps the exact original setup fingerprint through set-based account and participant identity states',async()=>{
  const migration=readFileSync(new URL('../db/migrations/6315_contract_shared_commands.sql',import.meta.url),'utf8');
  const ownerStart=migration.indexOf('CREATE FUNCTION app.contract_shared_setup_revision(p_case uuid)');
  const originalBody=migration.slice(ownerStart).split('AS $$\n')[1].split('\n$$;')[0].replace(/\bp_case\b/g,()=>'$1::uuid');
  if(!originalBody.startsWith(' WITH workflows'))throw Error('The frozen5807 equivalence oracle changed');
  const compare=async(label:string,caseId=f.caseId)=>owner.client.begin(async connection=>{
   await connection`select set_config('app.tenant_id',${f.b.tenantId},true),set_config('app.user_id',${f.proposer.userId!},true),set_config('jit','off',true),set_config('statement_timeout','8000',true)`;
   const[context]=await connection<{role:string;tenant:string;user:string;private:boolean}[]>`select current_user as role,app.current_tenant_id() as tenant,app.current_user_id() as user,not has_function_privilege('ai_hr_app','app.contract_shared_setup_revision(uuid)','EXECUTE') as private`;
   expect(context).toEqual({role:'postgres',tenant:f.b.tenantId,user:f.proposer.userId!,private:true});
   const[before]=await connection.unsafe<{hash:string}[]>('select ('+originalBody+') as hash',[caseId]);
   const[after]=await connection<{hash:string}[]>`select app.contract_shared_setup_revision(${caseId}::uuid) as hash`;
   expect(after.hash,label).toBe(before.hash);return after.hash;
  });
  const baseline=await compare('Original source and published dependencies');
  const otherTenant=await seedBase();await createAppUser(otherTenant.tenantId,f.proposer.personId!,'employee');
  expect(await compare('Same Person account in another tenant does not affect tenant-scoped uniqueness')).toBe(baseline);
  const[adminEmployment]=await owner.db.execute<{count:number}>(sql`select count(*)::int as count from employment where person_id=${f.admin.personId}::uuid`);expect(adminEmployment.count).toBe(0);
  await compare('Named active account without any employment remains verified');
  await owner.db.execute(sql`update app_user set archived_at=now() where id=${f.admin.userId}::uuid`);await compare('Archived referenced account remains hashed with verified=false');
  await owner.db.execute(sql`update app_user set archived_at=null where id=${f.admin.userId}::uuid`);
  const[unlinked]=await owner.db.execute<{id:string}>(sql`insert into app_user(tenant_id,workos_user_id) values(${f.b.tenantId}::uuid,${'unlinked-parity-'+randomUUID()}) returning id`);
  await owner.db.execute(sql`update lc_v9_config set data=jsonb_set(data,'{groups}',(data->'groups')||jsonb_build_array(jsonb_build_object('id','unrelated-parity','name','Still hashed','limit',0,'members',jsonb_build_array(${unlinked.id}::text)))) where tenant_id=${f.b.tenantId}::uuid`);
  expect(await compare('Unrelated group members remain hashed, including NULL Person')).not.toBe(baseline);
  await owner.db.execute(sql`update lc_v9_config set data=jsonb_set(data,'{groups}',(data->'groups')||jsonb_build_array(jsonb_build_object('id','membership-fold-parity','name','Duplicates and missing accounts','limit',0,'members',jsonb_build_array(${unlinked.id}::text,${unlinked.id}::text,${randomUUID()}::text,'not-a-uuid')))) where tenant_id=${f.b.tenantId}::uuid`);
  await compare('Duplicate membership, orphan UUID and malformed ID preserve the exact original account set');
  const duplicate=await createAppUser(f.b.tenantId,f.proposer.personId!,'employee');
  await compare('Manager uniqueness counts every active same-Person account');
  await owner.db.execute(sql`update app_user set archived_at=now() where id=${duplicate}::uuid`);await compare('Archived duplicate restores the canonical unique manager');
  const[manager]=await owner.db.execute<{name:string}>(sql`select full_name as name from person where id=${f.proposer.personId}::uuid`);
  await owner.db.execute(sql`update person set full_name='   ' where id=${f.proposer.personId}::uuid`);await compare('Blank name is unverified while account activity is a separate fact');
  await owner.db.execute(sql`update person set full_name=${manager.name} where id=${f.proposer.personId}::uuid`);
  await owner.db.execute(sql`update employment set blacklisted_at=now() where tenant_id=${f.b.tenantId}::uuid and person_id=${f.proposer.personId}::uuid`);await compare('Canonical person-wide blocked login');
  await owner.db.execute(sql`update employment set blacklisted_at=null,last_working_date=current_date where tenant_id=${f.b.tenantId}::uuid and person_id=${f.proposer.personId}::uuid`);await compare('Login allows the last day while Contract participants require an unended employment');
  await owner.db.execute(sql`update employment set last_working_date=current_date-1 where tenant_id=${f.b.tenantId}::uuid and person_id=${f.proposer.personId}::uuid`);await compare('Login blocks after the last day');
  await compare('No selected case still hashes the exact configuration-only source',randomUUID());
 });
 it('does not hydrate unrelated tenant groups into a case-specific decision preview',async()=>{
  await owner.db.execute(sql`with unrelated as(insert into app_user(tenant_id,workos_user_id) select ${f.b.tenantId}::uuid,'unrelated-contract-fixture-'||gen_random_uuid()::text from generate_series(1,5001) returning id)
   update lc_v9_config set data=jsonb_set(data,'{groups}',(data->'groups')||jsonb_build_array(jsonb_build_object('id','unrelated-large-group','name','Unrelated configuration','limit',0,'members',(select jsonb_agg(id) from unrelated)))),revision=revision+1 where tenant_id=${f.b.tenantId}::uuid`);
  const requested=await previewContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,draft});
  const workerStarted=performance.now();
  try{expect((await finishPreview(requested.jobId,f.proposer,8_000)).state).toBe('completed');}finally{console.info('[Contract preview5001 native worker ms]',Math.round(performance.now()-workerStarted));}
  expect((await readContractSharedDecisionPreview(f.proposer,requested.previewId)).plan?.blockers).toEqual([]);
 });
 it('queues shared email with frozen rich wording, default CC and a source-bound individual approval link',async()=>{
  const origin='https://contract-mail-fixture.invalid',templateId=randomUUID();
  for(const userId of [f.admin.userId!,f.proposer.userId!])await owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${origin+'/auth/'+f.b.tenantId},${randomUUID()},${userId}::uuid)`);
  await saveAutomationEmailTemplate(f.admin,{template:{id:templateId,module:'contract_staff',name:'Contract decision receipt',active:true,subject:'Review {{employee.name}}',body:'The agreed salary is {{contract.salary}}. Open {{case.link}}',bodyDoc:automationEmailBodyDoc({body:'The agreed salary is {{contract.salary}}. Open {{case.link}}'}),cc:[{kind:'person',userId:f.proposer.userId!}]},expectedRevision:0,retired:false,reason:'Fictional reviewed email'});
  const workflow={...f.workflow,steps:[{id:randomUUID(),type:'sendEmail',conditions:[],to:[{kind:'person' as const,userId:f.admin.userId!}],cc:[],params:{emailTemplateId:templateId}},...f.workflow.steps]};
  await saveAutomationWorkflow(f.admin,{workflow,expectedRevision:1,reason:'Include the shared decision receipt'});
  const requested=await previewContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,draft:{...draft,payChanges:true,basicSalary:'5200.12'}});await finishPreview(requested.jobId,f.proposer);
  const preview=await readContractSharedDecisionPreview(f.proposer,requested.previewId);expect(preview.plan?.blockers).toEqual([]);
  const originalActorId=f.proposer.userId;if(!originalActorId)throw Error('The actual admitted decision actor is required.');
  let checkedHeldCustody=false;
  const guarded:typeof contractAutomationJobHandler={...contractAutomationJobHandler,async finalize(ctx,job,unit){
   return contractAutomationJobHandler.finalize!(ctx,job,{...unit,ownerTx:callback=>unit.ownerTx!(async native=>{
    await native`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id','',true)`;
    const[child]=await native<{id:string;pin:string}[]>`select child.id,pin.id as pin from contract_shared_event child join app.contract_email_prerequisite_origin binding on binding.tenant_id=child.tenant_id and binding.job_id=child.job_id join contract_shared_event original on original.tenant_id=binding.tenant_id and original.id=binding.origin_event_id and original.processed_at is not null and original.error is null join contract_shared_email_document_step pin on pin.tenant_id=binding.tenant_id and pin.id=binding.pin_id where child.tenant_id=${ctx.tenantId}::uuid and child.job_id=${job.id}::uuid and child.trigger_event='approvalActionNeeded' and child.processed_at is null order by child.created_at,child.id limit 1`;
    if(child&&!checkedHeldCustody){
     await native`select set_config('app.contract_event',${child.id},true)`;
     const baseline=async()=>{const[row]=await native<{source:boolean;handled:{handled:boolean}}[]>`select app.contract_shared_email_recovery_source(${ctx.tenantId}::uuid,${child.pin}::uuid) as source,app.contract_shared_email_recovery_original(${child.id}::uuid) as handled`;expect(row).toEqual({source:true,handled:{handled:false}});};
     await baseline();
     const[originalPin]=await native<{data:unknown}[]>`select to_jsonb(pin) as data from contract_shared_email_document_step pin where pin.tenant_id=${ctx.tenantId}::uuid and pin.id=${child.pin}::uuid`;
     // Negative fault attempts run under the genuine held worker; native immutable custody stays enabled.
     const faults=[
      {name:'company',apply:()=>native`update contract_shared_email_document_step set company_id=${randomUUID()}::uuid where tenant_id=${ctx.tenantId}::uuid and id=${child.pin}::uuid`},
      {name:'Person',apply:()=>native`update contract_shared_email_document_step set subject_person_id=${randomUUID()}::uuid where tenant_id=${ctx.tenantId}::uuid and id=${child.pin}::uuid`},
      {name:'period',apply:()=>native`update contract_shared_email_document_step set source_period_revision='negative-custody-period' where tenant_id=${ctx.tenantId}::uuid and id=${child.pin}::uuid`},
      {name:'decision',apply:()=>native`update contract_shared_email_document_step set decision_revision=decision_revision+1 where tenant_id=${ctx.tenantId}::uuid and id=${child.pin}::uuid`},
      {name:'email revision',apply:()=>native`update contract_shared_email_document_step set email_revision=email_revision+1 where tenant_id=${ctx.tenantId}::uuid and id=${child.pin}::uuid`},
     ];
     for(const fault of faults){
      await native`savepoint custody_negative`;let refusal:unknown;
      try{await fault.apply();}catch(error){refusal=error;}finally{await native`rollback to savepoint custody_negative`;await native`release savepoint custody_negative`;}
      expect(refusal,fault.name).toMatchObject({code:'23514',message:'Prepared email references and document bindings are immutable'});
      const[unchanged]=await native<{data:unknown}[]>`select to_jsonb(pin) as data from contract_shared_email_document_step pin where pin.tenant_id=${ctx.tenantId}::uuid and pin.id=${child.pin}::uuid`;expect(unchanged).toEqual(originalPin);await baseline();
     }
     const sources=[
      {name:'original actor archived',apply:()=>native`update app_user set archived_at=now() where tenant_id=${ctx.tenantId}::uuid and id=${originalActorId}::uuid`},
      {name:'native company archived',apply:()=>native`update company set archived_at=now() where tenant_id=${ctx.tenantId}::uuid and id=(select company_id from contract_shared_email_document_step where tenant_id=${ctx.tenantId}::uuid and id=${child.pin}::uuid)`},
     ];
     for(const source of sources){
      await native`savepoint source_negative`;
      try{
       await source.apply();const[proof]=await native<{source:boolean}[]>`select app.contract_shared_email_recovery_source(${ctx.tenantId}::uuid,${child.pin}::uuid) as source`;expect(proof.source,source.name).toBe(false);
       // Refusal may occur at the exact current-event fence or the stricter original-frame fence.
       let frameError:unknown;let result:{handled:boolean}|undefined;
       try{const[row]=await native<{value:{handled:boolean}}[]>`select app.contract_shared_email_recovery_original(${child.id}::uuid) as value`;result=row.value;}catch(error){frameError=error;}
       if(frameError)expect(frameError,source.name).toMatchObject({code:'42501'});else expect(result,source.name).toMatchObject({handled:true});
      }finally{await native`rollback to savepoint source_negative`;await native`release savepoint source_negative`;}
      await baseline();
     }
     checkedHeldCustody=true;
    }
    return callback(native);
   })});
  }};
  const accepted=await submitContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,previewId:requested.previewId});expect((await finishAutomation(accepted.jobId,f.proposer,guarded)).state).toBe('completed');expect(checkedHeldCustody).toBe(true);
  const deliveries=await owner.db.execute<{id:string;key:string;payload:{linkPath:string;mail:{subject:string;body:string;to:string[];cc:string[];richBody:{values:Record<string,string>}}}}>(sql`select id,mail_key as key,payload from automation_email_delivery where tenant_id=${f.b.tenantId}::uuid order by mail_key`);
  const receipts=deliveries.length===2?null:{
   jobs:await owner.db.execute(sql`select id,state,phase,error from bulk_job where tenant_id=${f.b.tenantId}::uuid and id=${accepted.jobId}::uuid`),
   events:await owner.db.execute(sql`select id,trigger_event,processed_at is not null as processed,error from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and job_id=${accepted.jobId}::uuid order by created_at,id`),
   runs:await owner.db.execute(sql`select id,trigger_event,status,step_cursor,waiting_for,failure from automation_run where tenant_id=${f.b.tenantId}::uuid and subject_id=${f.caseId}::uuid order by started_at,id`),
  };
  expect(deliveries,JSON.stringify({keys:deliveries.map(item=>item.key),receipts})).toHaveLength(2);
  const events=await owner.db.execute<{trigger:string;processed:boolean;error:string|null;reconciliation:unknown}>(sql`select trigger_event as trigger,processed_at is not null as processed,error,email_reconciliation as reconciliation from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and job_id=${accepted.jobId}::uuid order by created_at,id`);
  expect(events.map(event=>event.trigger)).toContain('approvalActionNeeded');
  expect(events.every(event=>event.processed&&event.error===null&&event.reconciliation===null),JSON.stringify(events)).toBe(true);
  const consumed=await owner.db.execute<{status:string;cursor:number;waiting:string|null;pin:string;step:string;ordinal:number}>(sql`select run.status,run.step_cursor as cursor,run.waiting_for as waiting,pin.id as pin,pin.workflow_step_id as step,frozen.n::integer as ordinal from contract_shared_email_document_step pin join automation_run run on run.tenant_id=pin.tenant_id and run.id=pin.workflow_run_id join automation_workflow_version version on version.tenant_id=run.tenant_id and version.workflow_id=run.workflow_id and version.revision=run.workflow_revision cross join lateral jsonb_array_elements(version.definition->'steps') with ordinality frozen(step,n) where pin.tenant_id=${f.b.tenantId}::uuid and pin.case_id=${f.caseId}::uuid and frozen.step->>'id'=pin.workflow_step_id`);
  expect(consumed).toHaveLength(1);const[emailStep]=consumed;if(!emailStep)throw Error('The actual consumed native email pin is missing');expect(emailStep).toMatchObject({status:'waiting',cursor:2,ordinal:1});expect(emailStep.waiting).not.toBe(emailStep.pin);

  const workflowMail=deliveries.find(item=>!item.key.startsWith('approval:'))!,assignment=deliveries.find(item=>item.key.startsWith('approval:'))!;
  expect(workflowMail.payload.mail).toMatchObject({subject:'Review Fictional Contract subject',to:[f.admin.userId],cc:[f.proposer.userId]});
  expect(workflowMail.payload.mail.body).toContain('{{case.link}}');expect(workflowMail.payload.mail.richBody.values['contract.salary']).toBe('5200.12');expect(JSON.stringify(workflowMail.payload)).not.toContain('4976.21');
  await saveAutomationEmailTemplate(f.admin,{template:{id:templateId,module:'contract_staff',name:'Contract decision receipt',active:true,subject:'Later wording',body:'Later body',cc:[]},expectedRevision:1,retired:false,reason:'Later edits do not rewrite queued mail'});
  const [approval]=await owner.db.execute<{id:string}>(sql`select id from contract_shared_approval where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid`);
  const token=randomUUID();await owner.db.execute(sql`update automation_email_delivery set status='leased',lease_token=${token}::uuid,lease_until=now()+interval '3 minutes' where id=${assignment.id}::uuid`);
  const target=async()=>(await owner.db.execute<{target:{payload:{linkPath:string}}|null}>(sql`select app.automation_email_target(${assignment.id}::uuid,${token}::uuid,${origin}) as target`))[0].target;
  expect((await target())?.payload.linkPath).toBe('/lifecycle/contracts/approvals/'+approval.id);
  const pending=await readContractSharedApproval(f.admin,approval.id);
  await actContractSharedApproval(f.admin,{id:approval.id,actionId:randomUUID(),layerId:pending.pendingLayerId!,revision:pending.contentRevision,hash:pending.contentHash,action:'approve',reason:'Agreed'});
  expect(await target()).toBeNull();
  const [frozen]=await owner.db.execute<{subject:string}>(sql`select payload->'mail'->>'subject' as subject from automation_email_delivery where id=${workflowMail.id}::uuid`);expect(frozen.subject).toBe('Review Fictional Contract subject');
 });
 it('executes pinned approvals, holds and verifies the employee login, and freezes agreed values without automatic Personnel or Payroll writes',async()=>{
  const requested=await previewContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,draft});
  await finishPreview(requested.jobId,f.proposer);
  const accepted=await submitContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,previewId:requested.previewId});
  await saveAutomationWorkflow(f.admin,{workflow:{...f.workflow,status:'paused'},expectedRevision:1,reason:'Already accepted work retains revision one'});
  expect((await finishAutomation(accepted.jobId,f.proposer)).state).toBe('completed');
  const [row]=await owner.db.execute<{id:string}>(sql`select id from contract_shared_approval where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid`);
  const approval=await readContractSharedApproval(f.admin,row.id);
  expect(approval.canAct).toBe(true);expect(approval.status).toBe('pending');expect(approval.layers.map(layer=>layer.label)).toEqual(['CEO']);
  expect((await readContractSharedApproval(f.proposer,row.id)).canAct).toBe(false);
  expect(JSON.stringify(approval)).not.toMatch(/497621|4976\.21|candidatePersonIds|holderPersonId|signingPolicy/);
  const approve={id:row.id,actionId:randomUUID(),layerId:approval.pendingLayerId!,revision:approval.contentRevision,hash:approval.contentHash,action:'approve' as const,reason:'Agreed'};
  expect((await actContractSharedApproval(f.admin,approve)).status).toBe('approved');
  expect((await actContractSharedApproval(f.admin,approve)).history).toHaveLength(1);
  const [released]=await owner.db.execute<{job:string}>(sql`select job_id as job from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid and trigger_event='approvalsComplete'`);
  expect((await finishAutomation(released.job,f.admin)).state).toBe('completed');
  const [generated]=await owner.db.execute<{id:string}>(sql`select id from contract_shared_letter where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid`);
  const letter=await readContractSharedLetter(f.admin,generated.id);
  expect(letter.canEdit).toBe(true);expect(letter.pendingAction?.kind).toBe('review');expect(letter.layers[1]).toMatchObject({kind:'sign',unavailable:true,assigneeName:null});
  expect(renderContractSharedLetter(letter)?.blocks[0].text).toBe('Dear {employee.name}');
  const [otherPerson]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${f.b.tenantId}::uuid,'Different Personnel identity',${randomUUID()+'@preview.test'}) returning id`);
  await owner.db.execute(sql`update employment set person_id=${otherPerson.id}::uuid where tenant_id=${f.b.tenantId}::uuid and id=${f.employee.employmentId}::uuid`);
  const changedSource=await readContractSharedLetter(f.admin,letter.id);
  expect(changedSource.canEdit).toBe(false);expect(changedSource.pendingAction).toBeNull();expect(changedSource.body?.values['employee.name']).toBe('Fictional Contract subject');
  await owner.db.execute(sql`update employment set person_id=${f.employee.personId}::uuid where tenant_id=${f.b.tenantId}::uuid and id=${f.employee.employmentId}::uuid`);
  const hidden=await readContractSharedLetter(f.proposer,generated.id);expect(hidden.body).toBeNull();expect(hidden.contentHash).toBeNull();
  const review={id:letter.id,actionId:randomUUID(),stepId:letter.pendingAction!.stepId,revision:letter.contentRevision,hash:letter.contentHash!,action:'reviewed' as const,blocks:{intro:'Reviewed wording for {employee.name}'}};
  await expect(actContractSharedLetter(f.proposer,review)).rejects.toMatchObject({code:'forbidden'});
  await expect(actContractSharedLetter(f.admin,{...review,action:'approved'})).rejects.toMatchObject({code:'invalid'});
  expect((await readContractSharedLetter(f.admin,letter.id)).contentRevision).toBe(letter.contentRevision);
  const reviewed=await actContractSharedLetter(f.admin,review);
  expect(reviewed.body?.blocks.intro).toBe('Reviewed wording for {employee.name}');expect(reviewed.contentRevision).toBe(letter.contentRevision+1);
  const replay=await actContractSharedLetter(f.admin,review);expect(replay.contentRevision).toBe(reviewed.contentRevision);expect(replay.history).toHaveLength(1);
  await expect(actContractSharedLetter(f.admin,{...review,blocks:{intro:'A different retry'}})).rejects.toMatchObject({code:'conflict'});
  expect(reviewed.state).toBe('routing');expect(reviewed.pendingAction).toBeNull();expect(reviewed.valuesFixed).toBe(false);
  const held=await contractSharedContext(f.proposer,f.caseId);expect(held.flow?.stage).toBe('document');expect(held.flow?.flags).toContain('employee_cannot_sign');expect(held.source.contractNumber).toBe(4);
  const userId=await createAppUser(f.b.tenantId,f.employee.personId,'employee');
  const employee:SessionContext={...f.admin,userId,personId:f.employee.personId,roles:['employee'],grants:undefined};
  const duplicateId=await createAppUser(f.b.tenantId,f.employee.personId,'employee');
  await expect(bindContractSharedEmployee(employee,letter.id)).rejects.toMatchObject({code:'invalid'});
  await owner.db.execute(sql`update app_user set archived_at=now() where tenant_id=${f.b.tenantId}::uuid and id=${duplicateId}::uuid`);
  const ready=await bindContractSharedEmployee(employee,letter.id);
  expect(ready.pendingAction?.kind).toBe('sign');expect(ready.body).not.toBeNull();
  await expect(readContractSharedApproval(employee,row.id)).rejects.toMatchObject({code:'forbidden'});
  // Only the native Payroll writer changes pay; a draft letter follows it until the first actual signature.
  await setCompensation(f.admin,{employmentId:f.employee.employmentId,basicSalary:5100.11,effectiveFrom:start});
  const sign={id:letter.id,actionId:randomUUID(),stepId:ready.pendingAction!.stepId,revision:ready.contentRevision,hash:ready.contentHash!,action:'signed' as const,method:'typed' as const,value:'Fictional Contract subject',consent:true};
  await expect(actContractSharedLetter(employee,sign)).rejects.toMatchObject({code:'conflict'});
  const refreshed=await readContractSharedLetter(employee,letter.id);expect(refreshed.body?.values['contract.salary']).toBe('5100.11');
  const signed=await actContractSharedLetter(employee,{...sign,hash:refreshed.contentHash!});
  expect(signed.state).toBe('released');expect(signed.valuesFixed).toBe(true);
  const proof=await readContractSharedReleaseProof(employee,letter.id);
  expect(proof).toMatchObject({protocol:'contract-release-v1',contentHash:signed.contentHash,contentRevision:signed.contentRevision});
  expect(proof?.fingerprint).toMatch(/^[a-f0-9]{64}$/);expect(proof?.fingerprint).not.toBe(signed.contentHash);
  const [evidence]=await owner.db.execute<{evidence:{document:{blocks:Record<string,string>};signatures:{actorId:string;actorPersonId:string;signature:{value:string}}[]}}>(sql`select evidence from contract_shared_release_receipt where tenant_id=${f.b.tenantId}::uuid and letter_id=${letter.id}::uuid`);
  expect(evidence.evidence.document.blocks.intro).toBe('Reviewed wording for {employee.name}');
  expect(evidence.evidence.signatures).toHaveLength(1);
  expect(evidence.evidence.signatures[0]).toMatchObject({actorId:userId,actorPersonId:f.employee.personId,signature:{value:'Fictional Contract subject'}});
  await expect(withTenant(employee,tx=>tx.execute(sql`update contract_shared_release_receipt set fingerprint=${'0'.repeat(64)} where letter_id=${letter.id}::uuid`))).rejects.toThrow();
  expect((await actContractSharedLetter(employee,{...sign,hash:refreshed.contentHash!})).history).toHaveLength(2);
  await setCompensation(f.admin,{employmentId:f.employee.employmentId,basicSalary:5200.12,effectiveFrom:start});
  expect(await readContractSharedReleaseProof(employee,letter.id)).toEqual(proof);
  expect((await readContractSharedLetter(employee,letter.id)).body?.values['contract.salary']).toBe('5100.11');
  const current=await contractSharedContext(f.proposer,f.caseId);expect(current.flow?.stage).toBe('workflow');expect(current.flow?.flags).not.toContain('employee_cannot_sign');expect(current.source.contractNumber).toBe(4);
  const [native]=await owner.db.execute<{count:number;salary:string}>(sql`select (select count(*)::int from personnel_posting where tenant_id=${f.b.tenantId}::uuid) as count,c.basic_salary::text as salary from compensation c where c.tenant_id=${f.b.tenantId}::uuid and c.employment_id=${f.employee.employmentId}::uuid and c.superseded_at is null and c.valid_from<=${todayInKualaLumpur()}::date and (c.valid_to is null or c.valid_to>${todayInKualaLumpur()}::date) order by c.valid_from desc,c.id limit 1`);
  expect(native.count).toBe(0);expect(Number(native.salary)).toBe(5200.12);
 });
 it('lets a real manager without builder/pay access review the chain without reading private routing inputs or applying effects',async()=>{
  expect((await automationBuilderAccess(f.proposer)).any).toBe(false);
  const requested=await previewContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,draft});
  expect((await readContractSharedDecisionPreview(f.proposer,requested.previewId)).plan).toBeNull();
  expect((await finishPreview(requested.jobId,f.proposer)).state).toBe('completed');
  const preview=await readContractSharedDecisionPreview(f.proposer,requested.previewId);
  expect(preview.plan?.blockers).toEqual([]);expect(preview.plan?.workflows).toHaveLength(1);
  expect(preview.plan?.workflows[0].steps.map(step=>step.type)).toEqual(['requestApproval','generateDocument','createPosting']);
  expect(preview.plan?.workflows[0].steps[0].layers[0]).toMatchObject({name:'CEO',who:'Fictional Contract preview administrator'});
  expect(preview.plan?.warnings.join(' ')).toContain('signature will be held');
  expect(preview.plan).not.toHaveProperty('approvalAssignments');expect(preview.plan).not.toHaveProperty('letterAssignments');
  expect(JSON.stringify(preview)).not.toMatch(/497621|4976\.21|sourceSnapshot|compensationId/);
  const view=await contractSharedContext(f.proposer,f.caseId);expect(view.flow?.revision).toBe(1);expect(view.flow?.decision).toBeNull();expect(view.source).not.toHaveProperty('salaryCents');
  const [effects]=await owner.db.execute<{runs:number;postings:number;letters:number}>(sql`select (select count(*)::int from automation_run where tenant_id=${f.b.tenantId}::uuid) as runs,(select count(*)::int from personnel_posting where tenant_id=${f.b.tenantId}::uuid) as postings,(select count(*)::int from contract_shared_letter where tenant_id=${f.b.tenantId}::uuid) as letters`);
  expect(effects).toEqual({runs:0,postings:0,letters:0});
  await expect(withTenant(f.proposer,tx=>tx.execute(sql`select data from contract_shared_event`))).rejects.toThrow();
  await expect(withTenant(f.proposer,tx=>tx.execute(sql`select plan from contract_shared_preview`))).rejects.toThrow();
  await expect(withTenant(f.proposer,tx=>tx.execute(sql`select app.contract_shared_preview_finish(${requested.previewId}::uuid,${requested.jobId}::uuid,'forged','{}'::jsonb)`))).rejects.toThrow();
 });
 it('requires a ready current preview and admits a frozen decision/event once without changing Personnel or Payroll',async()=>{
  const requested=await previewContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,draft});
  await expect(submitContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,previewId:requested.previewId})).rejects.toMatchObject({code:'conflict'});
  expect((await finishPreview(requested.jobId,f.proposer)).state).toBe('completed');
  const accepted=await submitContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,previewId:requested.previewId});
  expect(accepted.flow).toMatchObject({revision:2,stage:'workflow',decision:{kind:'renew',payChanges:false,salaryCents:null}});
  expect(await submitContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,previewId:requested.previewId})).toEqual(accepted);
  await saveAutomationWorkflow(f.admin,{workflow:{...f.workflow,status:'paused'},expectedRevision:1,reason:'Future runs paused; accepted work keeps its revision'});
  expect(await submitContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,previewId:requested.previewId})).toEqual(accepted);
  const [event]=await owner.db.execute<{versions:unknown;job:string}>(sql`select workflow_versions as versions,job_id as job from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and id=${accepted.eventId}::uuid`);
  expect(event).toEqual({versions:[{workflowId:f.workflow.id,revision:1}],job:accepted.jobId});
  const history=await contractSharedHistory(f.proposer,f.caseId);expect(history.map(entry=>entry.revision)).toEqual([2,1]);
  expect(history[0]).toMatchObject({actorId:f.proposer.userId,actorPersonId:f.proposer.personId,actorName:'Fictional Contract proposer'});
  const [native]=await owner.db.execute<{start:string;end:string;number:number;salary:string}>(sql`select e.contract_start_date::text as start,e.contract_end_date::text as end,e.contract_number as number,c.basic_salary::text as salary from employment e join compensation c on c.employment_id=e.id and c.tenant_id=e.tenant_id and c.superseded_at is null where e.id=${f.employee.employmentId}::uuid`);
  expect(native).toMatchObject({start,end,number:4});expect(Number(native.salary)).toBe(4976.21);
 });
 it('expires a preview when workflow setup changes and keeps the case open for a fresh review',async()=>{
  const requested=await previewContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,draft});
  expect((await finishPreview(requested.jobId,f.proposer)).state).toBe('completed');
  await saveAutomationWorkflow(f.admin,{workflow:{...f.workflow,status:'paused'},expectedRevision:1,reason:'Changed after the preview'});
  await expect(submitContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,previewId:requested.previewId})).rejects.toMatchObject({code:'conflict'});
  const fresh=await previewContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,draft});
  expect((await finishPreview(fresh.jobId,f.proposer)).state).toBe('completed');
  expect((await readContractSharedDecisionPreview(f.proposer,fresh.previewId)).plan?.blockers).toEqual([]);expect((await readContractSharedDecisionPreview(f.proposer,fresh.previewId)).plan?.warnings.join(' ')).toContain('No workflow ran');
  expect((await contractSharedContext(f.proposer,f.caseId)).flow?.stage).toBe('open');
 });
 it('binds the native offered-reason guard to the Personnel catalogue and rejects unknown codes',async()=>{
  const offered=await owner.withTenant({...f.admin,userId:undefined},tx=>tx.execute<{code:string;offered:boolean}>(sql`select code,app.contract_shared_end_reason_offered(code) as offered from unnest(ARRAY[${sql.join(TERMINATION_REASONS.map(reason=>sql`${reason.code}`),sql`, `)}]::text[]) code`));
  expect(offered).toHaveLength(TERMINATION_REASONS.length);expect(offered.every(reason=>reason.offered)).toBe(true);
  const [unknown]=await owner.withTenant({...f.admin,userId:undefined},tx=>tx.execute<{offered:boolean}>(sql`select app.contract_shared_end_reason_offered('not-a-personnel-reason') as offered`));expect(unknown.offered).toBe(false);
 });
});

it('accepts a decision against paused workflows and records No workflow ran without starting a workflow',async()=>{
 await saveAutomationWorkflow(f.admin,{workflow:{...f.workflow,status:'paused'},expectedRevision:1,reason:'Explicit paused workflow acceptance scenario'});
 const requested=await previewContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,draft});await finishPreview(requested.jobId,f.proposer);
 const accepted=await submitContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,previewId:requested.previewId});await finishAutomation(accepted.jobId,f.proposer);
 const detail=await contractSharedContext(f.proposer,f.caseId);expect(detail.flow?.decision?.kind).toBe('renew');expect(detail.flow?.flags).toContain('no_workflow');
 expect(await owner.db.execute(sql`select id from automation_run where tenant_id=${f.b.tenantId}::uuid and subject_id=${f.caseId}::uuid`)).toHaveLength(0);
});
