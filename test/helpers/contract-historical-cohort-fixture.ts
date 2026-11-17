/** Actual human multi-workflow dispatch; separate manual producer keeps its own frozen cohort. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {expect} from 'vitest';
import {owner} from '../harness';
import {contractPostingFixture,finishContractPostingJob,approveAppliedContractPosting} from './contract-posting-fixture';
import {saveAutomationDocumentTemplate,saveAutomationEmailTemplate,saveAutomationWorkflow} from '../../packs/automation/service';
import {contractSharedContext,previewContractSharedDecision,submitContractSharedDecision,startContractSharedManualWorkflow,contractAutomationJobHandler,readContractSharedApproval,actContractSharedApproval,readContractSharedLetter,actContractSharedLetter,listContractSharedPostings} from '../../packs/contracts/service';
import {runBulkJobTick} from '../../core/bulk-job-worker';
export async function historicalStartedCohortFixture(){
 const f=await contractPostingFixture({future:false,payChanges:false});
 await saveAutomationWorkflow(f.admin,{workflow:{...f.workflow,trigger:{event:'manual',days:0,workdays:false,repeat:false}},expectedRevision:1,reason:'Independent genuine manual producer cohort'});
 const documentId=randomUUID(),emailId=randomUUID(),aId='10000000-0000-4000-8000-000000000001',bId='20000000-0000-4000-8000-000000000002';
 await saveAutomationDocumentTemplate(f.admin,{template:{id:documentId,module:'contract_staff',name:'Original cohort acknowledgement',description:'',rules:{},blocks:[{id:'body',type:'text',text:'Review the original cohort agreement.',section:''}],fields:[],routing:[{id:'hr',order:1,action:'review',owner:true,who:{kind:'people',userIds:[f.admin.userId!]}},{id:'hr-sign',order:2,action:'sign',owner:false,who:{kind:'people',userIds:[f.admin.userId!]}}]},expectedRevision:0,publish:true,retired:false});
 await saveAutomationEmailTemplate(f.admin,{template:{id:emailId,module:'contract_staff',name:'Original cohort email',active:true,subject:'Original cohort acknowledgement',body:'Open the original Form.',cc:[],documentIds:[documentId]},expectedRevision:0,retired:false,reason:'Actual no-tail email'});
 const trigger={event:'decisionSubmitted',days:0,workdays:false,repeat:false};
 await saveAutomationWorkflow(f.admin,{workflow:{...f.workflow,id:aId,name:'Frozen A email only',trigger,conditions:[],steps:[{id:'email',type:'sendEmail',conditions:[],to:[{kind:'role',role:'employee'}],cc:[],params:{emailTemplateId:emailId}}]},expectedRevision:0,reason:'Actual human multi-workflow cohort A'});
 await saveAutomationWorkflow(f.admin,{workflow:{...f.workflow,id:bId,name:'Frozen B started approval',trigger,conditions:[],steps:[{id:'approval',type:'requestApproval',conditions:[],to:[],cc:[],params:{layers:[{id:randomUUID(),name:'Retained approval',pick:'any',approver:{kind:'person',userId:f.admin.userId!}}]}}]},expectedRevision:0,reason:'Actual human multi-workflow cohort B'});
 const preview=await previewContractSharedDecision(f.proposer,{caseId:f.caseId,revision:(await contractSharedContext(f.proposer,f.caseId)).flow!.revision,draft:f.draft});
 await finishContractPostingJob(preview.jobId,f.proposer,'contract_preview');
 const started=await submitContractSharedDecision(f.proposer,{caseId:f.caseId,revision:(await contractSharedContext(f.proposer,f.caseId)).flow!.revision,previewId:preview.previewId});
 const tick=()=>runBulkJobTick(owner.client,{handlers:[contractAutomationJobHandler]});
 let cohort:{runId:string;pinId:string;letterId:string;bRunId:string}|undefined;
 for(let count=0;count<100&&!cohort;count++){
  await tick();[cohort]=await owner.db.execute<{runId:string;pinId:string;letterId:string;bRunId:string}>(sql`select a.id as "runId",pin.id as "pinId",pin.documents->>${documentId} as "letterId",b.id as "bRunId" from automation_run a join contract_shared_email_document_step pin on pin.tenant_id=a.tenant_id and pin.workflow_run_id=a.id and a.waiting_for=pin.id join automation_run b on b.tenant_id=a.tenant_id and b.subject_id=a.subject_id and b.event_key=a.event_key and b.workflow_id=${bId}::uuid and b.status='waiting' where a.tenant_id=${f.b.tenantId}::uuid and a.subject_id=${f.caseId}::uuid and a.workflow_id=${aId}::uuid and a.status='waiting'`);
 }
 if(!cohort)throw Error('Actual human A email and B approval did not both start.');
 const[event]=await owner.db.execute<{refs:{workflowId:string}[]}>(sql`select workflow_versions as refs from contract_shared_event where id=${started.eventId}::uuid`);expect(event.refs.map(ref=>ref.workflowId)).toEqual([aId,bId]);
 const post=async()=>{
  const manual=await startContractSharedManualWorkflow(f.admin,{caseId:f.caseId,revision:(await contractSharedContext(f.admin,f.caseId)).flow!.revision,workflowId:f.workflow.id,workflowRevision:2,requestId:randomUUID()});
  await finishContractPostingJob(manual.jobId,f.admin,'contract_automation');
  const[approvalId]=await owner.db.execute<{id:string}>(sql`select approval.id from contract_shared_approval approval join automation_run run on run.tenant_id=approval.tenant_id and run.id=approval.workflow_run_id where approval.tenant_id=${f.b.tenantId}::uuid and run.workflow_id=${f.workflow.id}::uuid`);
  const approval=await readContractSharedApproval(f.admin,approvalId.id);await actContractSharedApproval(f.admin,{id:approval.id,actionId:randomUUID(),layerId:approval.pendingLayerId!,revision:approval.contentRevision,hash:approval.contentHash,action:'approve',reason:'Actual separate producer approval'});
  const[approved]=await owner.db.execute<{job:string}>(sql`select job_id as job from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and data->>'approvalId'=${approval.id} and trigger_event='approvalsComplete' order by created_at desc,id desc limit 1`);await finishContractPostingJob(approved.job,f.admin,'contract_automation');
  const[letter]=await owner.db.execute<{id:string}>(sql`select letter.id from contract_shared_letter letter join automation_run run on run.tenant_id=letter.tenant_id and run.id=letter.workflow_run_id where letter.tenant_id=${f.b.tenantId}::uuid and run.workflow_id=${f.workflow.id}::uuid and letter.purpose='outcome'`);
  const review=await readContractSharedLetter(f.admin,letter.id);await actContractSharedLetter(f.admin,{id:review.id,actionId:randomUUID(),stepId:review.pendingAction!.stepId,revision:review.contentRevision,hash:review.contentHash!,action:'reviewed'});
  const sign=await readContractSharedLetter(f.employeeActor,letter.id);await actContractSharedLetter(f.employeeActor,{id:sign.id,actionId:randomUUID(),stepId:sign.pendingAction!.stepId,revision:sign.contentRevision,hash:sign.contentHash!,action:'signed',method:'typed',value:'Fictional Contract employee',consent:true});
  const[released]=await owner.db.execute<{job:string}>(sql`select job_id as job from contract_shared_event where tenant_id=${f.b.tenantId}::uuid and data->>'letterId'=${letter.id} and trigger_event='letterReleased' order by created_at desc,id desc limit 1`);await finishContractPostingJob(released.job,f.employeeActor,'contract_automation');
  const postings=await listContractSharedPostings(f.approver,{status:'pending'});expect(postings.rows).toHaveLength(1);await approveAppliedContractPosting(f.approver,{id:postings.rows[0].id,revision:postings.rows[0].revision});
 };
 // This published text-only document is an ordinary Letter, not a Form. Read each real
 // pending native action again so Sign uses the canonical post-Review revision/hash.
 const complete=async()=>{
  for(const action of ['reviewed','signed'] as const){
   const letter=await readContractSharedLetter(f.admin,cohort!.letterId);expect(letter.pendingAction?.kind).toBe(action==='reviewed'?'review':'sign');
   await actContractSharedLetter(f.admin,{id:letter.id,actionId:randomUUID(),stepId:letter.pendingAction!.stepId,revision:letter.contentRevision,hash:letter.contentHash!,action,...(action==='signed'?{method:'typed' as const,value:'Fictional verified signer',consent:true}:{})});
  }
  expect((await readContractSharedLetter(f.admin,cohort!.letterId)).state).toBe('released');
 };
 return {...f,startEvent:started,cohort,aId,bId,emailId,tick,post,complete};
}
