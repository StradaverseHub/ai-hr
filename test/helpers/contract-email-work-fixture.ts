/** Actual native Manual email/Form + Personnel journey; all identities are fictional. */
import {randomUUID} from 'node:crypto';
import {expect} from 'vitest';
import {sql} from 'drizzle-orm';
import type {SessionContext} from '../../db/client';
import {migrateTestDb,closeAll,owner,createAppUser,setModule,entitledCtx} from '../harness';
import {contractPostingFixture,finishContractPostingJob,approveAppliedContractPosting} from './contract-posting-fixture';
import {saveAutomationDocumentTemplate,saveAutomationEmailTemplate,saveAutomationWorkflow,type AutomationWorkflow} from '../../packs/automation/service';
import {startContractSharedManualWorkflow,contractSharedContext,contractSharedWorkPage,contractSharedLetterActions,readContractSharedLetter,readContractSharedForm,saveContractSharedForm,actContractSharedLetter,bindContractSharedEmployee,previewContractSharedDecision,submitContractSharedDecision,readContractSharedApproval,actContractSharedApproval,listContractSharedPostings} from '../../packs/contracts/service';

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
 const start=await startContractSharedManualWorkflow(f.admin,{caseId:f.caseId,revision:(await contractSharedContext(f.admin,f.caseId)).flow!.revision,workflowId:workflow.id,workflowRevision:1,requestId:randomUUID()});
 await finishContractPostingJob(start.jobId,f.admin,'contract_automation');
 const [email]=await owner.db.execute<{id:string}>(sql`select id from contract_shared_letter where tenant_id=${f.b.tenantId}::uuid and case_id=${f.caseId}::uuid and purpose='email'`);expect(email).toBeTruthy();
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
