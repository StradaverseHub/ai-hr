import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {closeAll,migrateTestDb,resetDb,seedBase,setModule,entitledCtx,createAppUser,owner} from './harness';
import {hireEmployee,setEmploymentInfo} from '../core/org';
import {setCompensation} from '../core/comp';
import {v9Setup,v9Workspace,v9SaveConfig} from '../packs/lifecycle/service';
import {adoptContractSharedCase,previewContractSharedDecision,readContractSharedDecisionPreview,submitContractSharedDecision,contractSharedHistory,contractSharedContext,contractPreviewJobHandler} from '../packs/contracts/service';
import {saveAutomationDocumentTemplate,saveAutomationWorkflow,automationBuilderAccess,type AutomationWorkflow} from '../packs/automation/service';
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
 await owner.db.execute(sql`insert into contract_case(id,tenant_id,company_id,employment_id,term_id,number,revision,data) values(${caseId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${employee.employmentId}::uuid,${termId}::uuid,'CT-PREVIEW-1',1,jsonb_build_object('revision',1,'state','upcoming','term',jsonb_build_object('startOn',${start},'endOn',${end}),'decision',NULL,'decisionDraft',NULL))`);
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
 for(let count=0;count<30;count++){
  const job=await readBulkJob(as,id,'contract_preview');
  if(['completed','failed','cancelled'].includes(job.state))return job;
  await runBulkJobTick(owner.client,{handlers:[contractPreviewJobHandler]});
 }
 throw new Error('Protected Contract preview did not finish.');
}
const draft={kind:'renew' as const,months:6,payChanges:false,reason:'Continue the agreed role'};
let f:Awaited<ReturnType<typeof fixture>>;
beforeEach(async()=>{f=await fixture();});
describe('protected Contract decision preview and submission',()=>{
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
  const [event]=await owner.db.execute<{versions:unknown;job:string}>(sql`select workflow_versions as versions,job_id as job from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and id=${accepted.eventId}::uuid`);
  expect(event).toEqual({versions:[{workflowId:f.workflow.id,revision:1}],job:accepted.jobId});
  const history=await contractSharedHistory(f.proposer,f.caseId);expect(history.map(entry=>entry.revision)).toEqual([2,1]);
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
