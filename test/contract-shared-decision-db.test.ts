import {randomUUID} from 'node:crypto';
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

beforeAll(migrateTestDb);afterAll(closeAll);
const year=Number(todayInKualaLumpur().slice(0,4));
const start=`${year}-01-01`,end=`${year}-12-31`;
async function fixture(){
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'lifecycle','active');let admin=await entitledCtx(b);
 const [person]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional Contract preview administrator',${randomUUID()+'@preview.test'}) returning id`);
 await owner.db.execute(sql`update app_user set person_id=${person.id}::uuid where tenant_id=${b.tenantId}::uuid and id=${admin.userId}::uuid`);admin={...admin,personId:person.id};
 await v9Setup(admin);const config=(await v9Workspace(admin)).config!,groupId=randomUUID();
 await v9SaveConfig(admin,config.revision,{...config,groups:[...config.groups,{id:groupId,name:'Contract People Ops',members:[admin.userId!],limit:0}],peopleOpsGroup:groupId});
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
const draft={kind:'renew' as const,months:6,payChanges:false,reason:'Continue the agreed role'};
let f:Awaited<ReturnType<typeof fixture>>;
beforeEach(async()=>{f=await fixture();});
describe('protected Contract decision preview and submission',()=>{
 it('queues shared email with frozen rich wording, default CC and a source-bound individual approval link',async()=>{
  const origin='https://contract-mail-fixture.invalid',templateId=randomUUID();
  for(const userId of [f.admin.userId!,f.proposer.userId!])await owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${origin+'/auth/'+f.b.tenantId},${randomUUID()},${userId}::uuid)`);
  await saveAutomationEmailTemplate(f.admin,{template:{id:templateId,module:'contract_staff',name:'Contract decision receipt',active:true,subject:'Review {{employee.name}}',body:'The agreed salary is {{contract.salary}}. Open {{case.link}}',bodyDoc:automationEmailBodyDoc({body:'The agreed salary is {{contract.salary}}. Open {{case.link}}'}),cc:[{kind:'person',userId:f.proposer.userId!}]},expectedRevision:0,retired:false,reason:'Fictional reviewed email'});
  const workflow={...f.workflow,steps:[{id:randomUUID(),type:'sendEmail',conditions:[],to:[{kind:'person' as const,userId:f.admin.userId!}],cc:[],params:{emailTemplateId:templateId}},...f.workflow.steps]};
  await saveAutomationWorkflow(f.admin,{workflow,expectedRevision:1,reason:'Include the shared decision receipt'});
  const requested=await previewContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,draft});await finishPreview(requested.jobId,f.proposer);
  const preview=await readContractSharedDecisionPreview(f.proposer,requested.previewId);expect(preview.plan?.blockers).toEqual([]);
  const accepted=await submitContractSharedDecision(f.proposer,{caseId:f.caseId,revision:1,previewId:requested.previewId});await finishAutomation(accepted.jobId,f.proposer);
  const deliveries=await owner.db.execute<{id:string;key:string;payload:{linkPath:string;mail:{subject:string;body:string;to:string[];cc:string[];richBody:{values:Record<string,string>}}}}>(sql`select id,mail_key as key,payload from automation_email_delivery where tenant_id=${f.b.tenantId}::uuid order by mail_key`);
  expect(deliveries).toHaveLength(2);
  const workflowMail=deliveries.find(item=>!item.key.startsWith('approval:'))!,assignment=deliveries.find(item=>item.key.startsWith('approval:'))!;
  expect(workflowMail.payload.mail).toMatchObject({subject:'Review Fictional Contract subject',to:[f.admin.userId],cc:[f.proposer.userId]});
  expect(workflowMail.payload.mail.body).toContain('{{case.link}}');expect(workflowMail.payload.mail.richBody.values['contract.salary']).toBe('4976.21');
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
  const reviewed=await actContractSharedLetter(f.admin,{id:letter.id,actionId:randomUUID(),stepId:letter.pendingAction!.stepId,revision:letter.contentRevision,hash:letter.contentHash!,action:'reviewed'});
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
  expect((await actContractSharedLetter(employee,{...sign,hash:refreshed.contentHash!})).history).toHaveLength(2);
  await setCompensation(f.admin,{employmentId:f.employee.employmentId,basicSalary:5200.12,effectiveFrom:start});
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
  expect((await readContractSharedDecisionPreview(f.proposer,fresh.previewId)).plan?.blockers.join(' ')).toContain('No live workflow');
  expect((await contractSharedContext(f.proposer,f.caseId)).flow?.stage).toBe('open');
 });
 it('binds the native offered-reason guard to the Personnel catalogue and rejects unknown codes',async()=>{
  const offered=await owner.withTenant({...f.admin,userId:undefined},tx=>tx.execute<{code:string;offered:boolean}>(sql`select code,app.contract_shared_end_reason_offered(code) as offered from unnest(ARRAY[${sql.join(TERMINATION_REASONS.map(reason=>sql`${reason.code}`),sql`, `)}]::text[]) code`));
  expect(offered).toHaveLength(TERMINATION_REASONS.length);expect(offered.every(reason=>reason.offered)).toBe(true);
  const [unknown]=await owner.withTenant({...f.admin,userId:undefined},tx=>tx.execute<{offered:boolean}>(sql`select app.contract_shared_end_reason_offered('not-a-personnel-reason') as offered`));expect(unknown.offered).toBe(false);
 });
});
