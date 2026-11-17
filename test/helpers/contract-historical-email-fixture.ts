/** Native fictional Manual0 pin; no run/event/capability is manufactured by this helper. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {expect} from 'vitest';
import {owner} from '../harness';
import {contractPostingFixture,releaseContractPosting,approveAppliedContractPosting} from './contract-posting-fixture';
import {saveAnswers,actForm} from './contract-document-fixture';
import {saveAutomationDocumentTemplate,saveAutomationEmailTemplate,saveAutomationWorkflow} from '../../packs/automation/service';
import {startContractSharedManualWorkflow,contractSharedContext,previewContractSharedDecision,submitContractSharedDecision,contractAutomationJobHandler,contractScheduleJobHandler,contractScheduledAutomationJobHandler,adoptContractSharedCase} from '../../packs/contracts/service';
import {finishContractPostingJob} from './contract-posting-fixture';
import {runBulkJobTick} from '../../core/bulk-job-worker';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {hireEmployee,setEmploymentInfo} from '../../core/org';
import {setCompensation} from '../../core/comp';
export async function historicalManualEmailFixture(origin:string,system=false,makePostingFixture=()=>contractPostingFixture({future:false,payChanges:false})){
 const f=await makePostingFixture();
 for(const userId of[f.admin.userId!,f.employeeActor.userId!])await owner.db.execute(sql`insert into app_external_identity(issuer,subject,app_user_id) values(${origin+'/auth/'+f.b.tenantId},${f.b.tenantId+'/'+userId},${userId}::uuid)`);
 const documentId=randomUUID(),emailId=randomUUID(),workflowId=randomUUID();
 await saveAutomationDocumentTemplate(f.admin,{template:{id:documentId,module:'contract_staff',name:'Actual retained HR Form',description:'Fictional historical recovery',rules:{},blocks:[{id:'intro',type:'text',text:'Please review this original Form.',section:''},{id:'fields',type:'fields',text:'',section:'main'}],fields:[{id:'hrChoice',label:'HR confirmation',type:'select',owner:'hr',pmKey:null,required:true,sensitive:false,options:['Yes','No'],section:'main',when:null}],routing:[{id:'review',order:1,action:'review',owner:true,who:{kind:'people',userIds:[f.admin.userId!]}},{id:'hr-sign',order:2,action:'sign',owner:false,who:{kind:'people',userIds:[f.admin.userId!]}},{id:'employee-sign',order:3,action:'sign',owner:false,who:{kind:'employee'}}]},expectedRevision:0,publish:true,retired:false});
 await saveAutomationEmailTemplate(f.admin,{template:{id:emailId,module:'contract_staff',name:'Actual immutable Manual0 email',active:true,subject:'Original Manual0 for {{employee.name}}',body:'Original retained Form. {{case.link}}',cc:[],documentIds:[documentId]},expectedRevision:0,retired:false,reason:'Fictional original before-decision source'});
 const emailStep=randomUUID(),tailStep=randomUUID();
 await saveAutomationWorkflow(f.admin,{workflow:{id:workflowId,module:'contract_staff',name:'Actual Manual0 then business suffix',description:'',status:'live',required:false,trigger:{event:system?'afterContractEnd':'manual',days:system?1:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[{id:emailStep,type:'sendEmail',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{emailTemplateId:emailId}},{id:tailStep,type:'requestApproval',conditions:[],to:[],cc:[],params:{layers:[{id:randomUUID(),name:'Must not execute after authority changes',pick:'any',approver:{kind:'person',userId:f.admin.userId!}}]}}]},expectedRevision:0,reason:'Real old-run business suffix is denied after the first decision'});
 let start:{eventId:string;jobId:string}|undefined;
 if(system){
  await owner.db.execute(sql`insert into contract_shared_settings(tenant_id,company_id,fallback_group_id,posting_group_id,updated_by) values(${f.b.tenantId}::uuid,${f.b.companyId}::uuid,${f.groupId},${f.groupId},${f.admin.userId}::uuid) on conflict(tenant_id,company_id) do update set fallback_group_id=excluded.fallback_group_id,posting_group_id=excluded.posting_group_id`);
  const today=todayInKualaLumpur();await owner.client.begin(async tx=>{await tx`select set_config('app.tenant_id',${f.b.tenantId},true),set_config('app.user_id','',true)`;await tx`select app.contract_shared_system_enqueue('contract_schedule',${randomUUID()}::uuid,jsonb_build_object('day',${today}::text),'morning',${today}::date)`;});
 }else start=await startContractSharedManualWorkflow(f.admin,{caseId:f.caseId,revision:(await contractSharedContext(f.admin,f.caseId)).flow!.revision,workflowId,workflowRevision:1,requestId:randomUUID()});
 const tick=async()=>{await runBulkJobTick(owner.client,{handlers:[contractAutomationJobHandler,contractScheduleJobHandler,contractScheduledAutomationJobHandler]});expect(await owner.db.execute(sql`select id,error from bulk_job where tenant_id=${f.b.tenantId}::uuid and state='failed'`)).toEqual([]);};
 let pin:{id:string;runId:string;revision:number;source:string}|undefined;
 for(let n=0;n<35&&!pin;n++){await tick();[pin]=await owner.db.execute<{id:string;runId:string;revision:number;source:string}>(sql`select p.id,p.workflow_run_id as "runId",p.decision_revision as revision,p.source_period_revision as source from contract_shared_email_document_step p join automation_run run on run.tenant_id=p.tenant_id and run.id=p.workflow_run_id and run.status='waiting' and run.waiting_for=p.id where p.tenant_id=${f.b.tenantId}::uuid and p.case_id=${f.caseId}::uuid and p.email_template_id=${emailId}::uuid`);}
 if(!pin)throw Error('The genuine before-decision job did not reach its pinned HR Form wait');expect(pin.revision).toBe(0);
 if(system){const[binding]=await owner.db.execute<{eventId:string;jobId:string}>(sql`select origin_event_id as "eventId",job_id as "jobId" from app.contract_email_prerequisite_origin where tenant_id=${f.b.tenantId}::uuid and pin_id=${pin.id}::uuid`);if(!binding)throw Error('The genuine system pin lacks its native original job');start=binding;}
 // Both branches establish start using actual native admissions, never a fabricated UUID/creator.
 if(!start)throw Error('The actual original admission is unavailable');const admitted=start;
 const[letter]=await owner.db.execute<{id:string}>(sql`select value::uuid as id from contract_shared_email_document_step p cross join lateral jsonb_each_text(p.documents) d where p.tenant_id=${f.b.tenantId}::uuid and p.id=${pin.id}::uuid`);
 await saveAnswers(f.admin,letter.id,{hrChoice:'Yes'});await actForm(f.admin,letter.id,'reviewed');
 const firstDecision=async()=>{const revision=(await contractSharedContext(f.proposer,f.caseId)).flow!.revision;const preview=await previewContractSharedDecision(f.proposer,{caseId:f.caseId,revision,draft:f.draft});await finishContractPostingJob(preview.jobId,f.proposer,'contract_preview');return submitContractSharedDecision(f.proposer,{caseId:f.caseId,revision,previewId:preview.previewId});};
 const post=async()=>{const posting=await releaseContractPosting(f);await approveAppliedContractPosting(f.admin,{id:posting.id,revision:posting.revision});const[receipt]=await owner.db.execute<{applied:boolean}>(sql`select applied_at is not null as applied from contract_shared_posting where tenant_id=${f.b.tenantId}::uuid and posting_id=${posting.id}::uuid`);expect(receipt.applied).toBe(true);};
 const completeHR=()=>actForm(f.admin,letter.id,'signed');
 const deliveries=()=>owner.db.execute<{id:string;payload:Record<string,unknown>}>(sql`select id,payload from automation_email_delivery where tenant_id=${f.b.tenantId}::uuid and payload->'mail'->>'templateId'=${emailId} order by id`);
 const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,2100));for(let n=0;n<35;n++){await tick();const[job]=await owner.db.execute<{state:string}>(sql`select state from bulk_job where id=${admitted.jobId}::uuid`);if(job.state==='completed')return;}};
 return {...f,start:admitted,pin,letter,workflowId,emailId,emailStep,tailStep,tick,firstDecision,post,completeHR,deliveries,settle};
}

/** Two actual independent subjects/cases prove that reconciliation reads never follow a caller's person/company guess. */
export async function unrelatedReconciliationCases(f:Pick<Awaited<ReturnType<typeof contractPostingFixture>>,'b'|'admin'|'start'|'end'>){
 const[company]=await owner.db.execute<{id:string}>(sql`insert into company(tenant_id,legal_name) values(${f.b.tenantId}::uuid,'Fictional other reconciliation company') returning id`);
 const[department]=await owner.db.execute<{id:string}>(sql`insert into department(tenant_id,company_id,name) values(${f.b.tenantId}::uuid,${company.id}::uuid,'Fictional other department') returning id`);
 async function create(companyId:string,departmentId:string){
  const employee=await hireEmployee(f.admin,{person:{fullName:'Fictional independent reconciliation subject',primaryEmail:randomUUID()+'@reconciliation.test'},companyId,departmentId,employmentType:'contract',hiredOn:f.start,provisionalEndOn:f.end});
  await setEmploymentInfo(f.admin,{employmentId:employee.employmentId,contractStartDate:f.start,contractEndDate:f.end,contractNumber:2});await setCompensation(f.admin,{employmentId:employee.employmentId,basicSalary:4000,effectiveFrom:f.start});
  const termId=randomUUID(),caseId=randomUUID();
  await owner.db.execute(sql`insert into contract_term(id,tenant_id,company_id,employment_id,version,kind,start_on,end_on,source_revision) values(${termId}::uuid,${f.b.tenantId}::uuid,${companyId}::uuid,${employee.employmentId}::uuid,1,'project',${f.start}::date,${f.end}::date,'fictional-independent-source')`);
  await owner.db.execute(sql`insert into contract_case(id,tenant_id,company_id,employment_id,term_id,number,revision,data) values(${caseId}::uuid,${f.b.tenantId}::uuid,${companyId}::uuid,${employee.employmentId}::uuid,${termId}::uuid,${'CT-RECON-'+caseId.slice(0,8)},1,jsonb_build_object('revision',1,'state','upcoming','term',jsonb_build_object('startOn',${f.start}::text,'endOn',${f.end}::text),'decision',NULL,'decisionDraft',NULL))`);
  await adoptContractSharedCase(f.admin,caseId);return {caseId,personId:employee.personId,employmentId:employee.employmentId};
 }
 return {sameCompany:await create(f.b.companyId,f.b.deptA),otherCompany:await create(company.id,department.id)};
}
