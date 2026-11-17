/** Actual native Manual email/Form + Personnel journey; all identities are fictional. */
import {randomUUID} from 'node:crypto';
import {runBulkJobTick} from '../../core/bulk-job-worker';
import {expect} from 'vitest';
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../../db/client';
import {migrateTestDb,closeAll,owner,createAppUser,setModule,entitledCtx} from '../harness';
import {contractPostingFixture,finishContractPostingJob,approveAppliedContractPosting} from './contract-posting-fixture';
import {saveAutomationDocumentTemplate,saveAutomationEmailTemplate,saveAutomationWorkflow,type AutomationWorkflow} from '../../packs/automation/service';
import {startContractSharedManualWorkflow,contractAutomationJobHandler,contractSharedContext,contractSharedWorkPage,contractSharedLetterActions,readContractSharedLetter,readContractSharedForm,saveContractSharedForm,actContractSharedLetter,bindContractSharedEmployee,previewContractSharedDecision,submitContractSharedDecision,readContractSharedApproval,actContractSharedApproval,listContractSharedPostings} from '../../packs/contracts/service';

export async function historicalEmailPostingFixture(){
 const f=await contractPostingFixture({future:false,payChanges:false});
 // Outcomes need only the real HR review; the separate email Form retains its Employee Sign.
 const outcomeTemplate=f.workflow.steps.find(s=>s.type==='generateDocument')!.params.letterTemplateId as string;
 await saveAutomationDocumentTemplate(f.admin,{template:{id:outcomeTemplate,module:'contract_staff',name:'Fictional reviewed outcome',description:'',rules:{decision:['Renew']},blocks:[{id:'outcome',type:'text',text:'Renewal starts {contract.newStart}.',section:''}],fields:[],routing:[{id:randomUUID(),order:1,action:'review',owner:true,who:{kind:'people',userIds:[f.admin.userId!]}}]},expectedRevision:1,publish:true,retired:false});
 await owner.db.execute(sql`update app_user set archived_at=now() where tenant_id=${f.b.tenantId}::uuid and id=${f.employeeActor.userId!}::uuid`);
 const formId=randomUUID(),emailId=randomUUID();
 await saveAutomationDocumentTemplate(f.admin,{template:{id:formId,module:'contract_staff',name:'Fictional employee acknowledgement Form',description:'',rules:{},blocks:[{id:'intro',type:'text',text:'Please acknowledge the retained agreement.',section:''},{id:'answers',type:'fields',text:'',section:'main'}],fields:[{id:'ack',label:'I acknowledge the agreement',type:'checkbox',owner:'employee',pmKey:null,required:true,sensitive:false,options:[],section:'main',when:null}],routing:[{id:'hr',order:1,action:'review',owner:true,who:{kind:'people',userIds:[f.admin.userId!]}},{id:'employee',order:2,action:'sign',owner:false,who:{kind:'employee'}}]},expectedRevision:0,publish:true,retired:false});
 await saveAutomationEmailTemplate(f.admin,{template:{id:emailId,module:'contract_staff',name:'Fictional retained Form email',active:true,subject:'Read your agreement',body:'Please open your retained Form.',cc:[],documentIds:[formId]},retired:false,expectedRevision:0,reason:'Reviewed fictional historical Form task'});
 const workflow:AutomationWorkflow={id:randomUUID(),module:'contract_staff',name:'Fictional manual retained Form',description:'',status:'live',required:false,trigger:{event:'manual',days:0,workdays:false,repeat:false},skipWhen:'never',conditions:[],steps:[{id:randomUUID(),type:'sendEmail',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{emailTemplateId:emailId}}]};
 await saveAutomationWorkflow(f.admin,{workflow,expectedRevision:0,reason:'Reviewed native email prerequisite'});
 const current=await contractSharedContext(f.admin,f.caseId);if(!current.flow)throw Error('The genuine Manual email requires its adopted Contract period.');
 const start=await startContractSharedManualWorkflow(f.admin,{caseId:f.caseId,revision:current.flow.revision,workflowId:workflow.id,workflowRevision:1,requestId:randomUUID()});
 // HR has not reviewed the Form: this original email job must WAIT, not finish.
 // Poll only genuine kernel units and prove the exact accepted event/run/template/source pin.
 type WaitingEmail={pinId:string;runId:string;letterId:string};let waiting:WaitingEmail|undefined,nativeFailure:unknown;
 const diagnostic:typeof contractAutomationJobHandler={...contractAutomationJobHandler,async describeFailure(job,error,step,native){
  nativeFailure=error;const describe=contractAutomationJobHandler.describeFailure;if(!describe)throw Error('Canonical failure descriptor is required.');return describe(job,error,step,native);
 }};
 for(let count=0;count<100&&!waiting;count++){
  const worked=await runBulkJobTick(owner.client,{handlers:[diagnostic]});
  const failed=await owner.db.execute<{id:string;error:string|null}>(sql`select id,error from bulk_job where tenant_id=${f.b.tenantId}::uuid and state in('failed','cancelled')`);
  if(failed.length)throw nativeFailure??new Error('The genuine email prerequisite failed: '+JSON.stringify(failed));
  [waiting]=await owner.db.execute<WaitingEmail>(sql`select pin.id as "pinId",run.id as "runId",letter.id as "letterId"
   from bulk_job job join contract_shared_event event on event.tenant_id=job.tenant_id and event.id=${start.eventId}::uuid and event.job_id=job.id
   join app.contract_email_prerequisite_origin origin on origin.tenant_id=event.tenant_id and origin.origin_event_id=event.id and origin.root_event_id=event.id and origin.job_id=job.id
   join contract_shared_email_document_step pin on pin.tenant_id=origin.tenant_id and pin.id=origin.pin_id
   join automation_run run on run.tenant_id=pin.tenant_id and run.id=pin.workflow_run_id
   join contract_shared_letter letter on letter.tenant_id=pin.tenant_id and letter.case_id=pin.case_id and letter.workflow_run_id=run.id and letter.workflow_step_id=pin.workflow_step_id
   join document_signing_document document on document.tenant_id=letter.tenant_id and document.id=letter.signing_document_id and document.subject_id=letter.id and document.subject_type='contract'
   where job.tenant_id=${f.b.tenantId}::uuid and job.id=${start.jobId}::uuid and job.kind='contract_automation' and job.state='finalizing'
   and job.operation_key=event.id and job.input=jsonb_build_object('eventId',event.id) and event.trigger_event='manual' and event.case_id=${f.caseId}::uuid
   and event.workflow_versions=jsonb_build_array(jsonb_build_object('workflowId',${workflow.id}::uuid,'revision',1))
   and run.module='contract_staff' and run.subject_id=event.case_id and run.workflow_id=${workflow.id}::uuid and run.workflow_revision=1 and run.status='waiting' and run.waiting_for=pin.id and run.step_cursor=0
   and run.remaining_steps->0->'step'->>'id'=${workflow.steps[0].id} and run.remaining_steps->0->'step'->>'type'='sendEmail'
   and pin.case_id=event.case_id and pin.company_id=${f.b.companyId}::uuid and pin.subject_person_id=${f.employee.personId}::uuid
   and pin.source_period_revision=${current.flow.period.sourceRevision} and pin.decision_revision=0 and pin.workflow_step_id=${workflow.steps[0].id}
   and pin.email_template_id=${emailId}::uuid and pin.email_revision=1 and pin.documents->>${formId}=letter.id::text
   and letter.purpose='email' and letter.data->>'templateId'=${formId} and letter.data->>'templateVersion'='1'
   and letter.data->'emailTemplateRef'=jsonb_build_object('id',${emailId}::uuid,'revision',1) and letter.data->>'state'='routing'`);
  if(!worked&&!waiting)await new Promise(resolve=>setTimeout(resolve,50));
 }
 if(!waiting)throw Error('The accepted Manual email did not reach its exact native Form prerequisite.');
 const email={id:waiting.letterId};
 const[readiness]=await owner.withTenant(f.admin,tx=>tx.execute<{value:{ready:boolean;reason:string}}>(sql`select app.contract_shared_email_document_readiness(${email.id}::uuid) as value`));expect(readiness.value).toEqual({ready:false,reason:'hr_steps'});
 const review=await readContractSharedLetter(f.admin,email.id),response=await readContractSharedForm(f.admin,email.id);if(!response?.visible)throw new Error('Actual routed HR Form body is unavailable');
 await actContractSharedLetter(f.admin,{id:email.id,actionId:randomUUID(),stepId:review.pendingAction!.stepId,revision:review.contentRevision,hash:review.contentHash!,responseRevision:response.responseRevision,responseHash:response.responseHash,action:'reviewed'});
 // Create and approve the ordinary decision through its actual preview, approval and released letter.
 const revision=(await contractSharedContext(f.proposer,f.caseId)).flow!.revision;
 const preview=await previewContractSharedDecision(f.proposer,{caseId:f.caseId,revision,draft:f.draft});await finishContractPostingJob(preview.jobId,f.proposer,'contract_preview');
 const accepted=await submitContractSharedDecision(f.proposer,{caseId:f.caseId,revision,previewId:preview.previewId});await finishContractPostingJob(accepted.jobId,f.proposer,'contract_automation');
 const [approvalId]=await owner.db.execute<{id:string}>(sql`select id from contract_shared_approval where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid`);const approval=await readContractSharedApproval(f.admin,approvalId.id);
 await actContractSharedApproval(f.admin,{id:approval.id,actionId:randomUUID(),layerId:approval.pendingLayerId!,revision:approval.contentRevision,hash:approval.contentHash,action:'approve',reason:'Reviewed'});
 const [approvalJob]=await owner.db.execute<{id:string}>(sql`select job_id as id from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid and trigger_event='approvalsComplete'`);await finishContractPostingJob(approvalJob.id,f.admin,'contract_automation');
 const [outcome]=await owner.db.execute<{id:string}>(sql`select id from contract_shared_letter where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid and purpose='outcome'`);const letter=await readContractSharedLetter(f.admin,outcome.id);
 await actContractSharedLetter(f.admin,{id:letter.id,actionId:randomUUID(),stepId:letter.pendingAction!.stepId,revision:letter.contentRevision,hash:letter.contentHash!,action:'reviewed'});
 const [releasedJob]=await owner.db.execute<{id:string}>(sql`select job_id as id from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid and trigger_event='letterReleased' and data->>'letterId'=${outcome.id}`);await finishContractPostingJob(releasedJob.id,f.admin,'contract_automation');
 const posting=(await listContractSharedPostings(f.approver,{status:'pending'})).rows[0];await approveAppliedContractPosting(f.approver,{id:posting.id,revision:posting.revision});
 const [native]=await owner.db.execute<{counter:number}>(sql`select contract_number as counter from employment where tenant_id=${f.b.tenantId}::uuid and id=${f.employee.employmentId}::uuid`);expect(native.counter).toBe(5);
 return {...f,email};
}
