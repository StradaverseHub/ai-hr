/** Canonical pinned email documents; shared runtime owns waiting and OneHR owns delivery. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import type {SqlExecutor} from '../db/sql-executor';
import type {AutomationStepContext} from '../lib/automation/runtime';
import {ContractManagementError} from '../lib/contract-management-model';
import type {AutomationEmailTemplate} from '../lib/automation/email';
import type {ContractEmailPreparation} from './contract-shared-email';

export type ContractEmailTemplateReference={id:string;revision:number};
export type ContractPinnedEmailDocuments={
 prerequisiteId:string;sourcePeriodRevision:string;reference:ContractEmailTemplateReference;template:{template_id:string;revision:number;name:string;active:boolean;subject:string;body:string;cc:AutomationEmailTemplate['cc'];body_doc:AutomationEmailTemplate['bodyDoc']|null;assets:AutomationEmailTemplate['assets']|null;file_slots:AutomationEmailTemplate['slots']|null;document_ids:string[]|null};
 documentTemplateIds:string[];documents:Record<string,string>;
};
/** Only the native immutable pin supplies these words and references, including during later retries. */
export function contractPinnedEmailTemplate(plan:ContractPinnedEmailDocuments):AutomationEmailTemplate{
 const row=plan.template;
 return {id:plan.reference.id,module:'contract_staff',name:row.name,active:row.active,subject:row.subject,body:row.body,cc:row.cc,
  ...(row.body_doc?{bodyDoc:row.body_doc}:{}),assets:row.assets??[],slots:row.file_slots??[],documentIds:row.document_ids??[]};
}
export type ContractEmailDocumentReadiness={ready:boolean;reason:'released'|'employee'|'employee_account'|'hr_steps'|'returned'|'stopped'|'source_changed'};
const refSchema=z.object({id:z.uuid(),revision:z.number().int().positive()}).strict();
/** Recover the existing pin before considering the current template's on/off or retirement state. */
export async function prepareContractSharedEmailStep(tx:SqlExecutor,ctx:SessionContext,input:{
 step:AutomationStepContext;current:{revision:number;retired:boolean;template:AutomationEmailTemplate}|undefined;
 create:(templateId:string,reference:ContractEmailTemplateReference)=>Promise<string>;
}):Promise<ContractEmailPreparation|null>{
 if(ctx.userId)throw new ContractManagementError('forbidden','Email preparation requires the protected workflow owner.');
 const {run,step}=input.step;
 const [pin]=await tx.execute<{id:string;revision:number}>(sql`select email_template_id as id,email_revision as revision from contract_shared_email_document_step
  where tenant_id=${ctx.tenantId}::uuid and case_id=${run.subjectId}::uuid and workflow_run_id=${run.id}::uuid and workflow_step_id=${step.id}
  and app.contract_shared_effect_held(${run.subjectId}::uuid,${run.id}::uuid,${step.id},'sendEmail')`);
 if(!pin&&(!input.current||input.current.retired||!input.current.template.active))return null;
 const reference=pin??{id:input.current!.template.id,revision:input.current!.revision};
 const plan=await prepareContractSharedEmailDocuments(tx,ctx,{step:input.step,reference,create:input.create});
 const template=contractPinnedEmailTemplate(plan);
 if(plan.waitingFor)return {template,reference:plan.reference,waitingFor:plan.waitingFor,waitingReason:'Waiting for the required HR document steps and the employee’s verified account.'};
 if(template.slots?.some(slot=>slot.required)){
  const [files]=await tx.execute<{ready:boolean}>(sql`select app.contract_shared_email_required_files_ready(${plan.prerequisiteId}::uuid) as ready`);
  if(!files.ready)return {template,reference:plan.reference,waitingFor:plan.prerequisiteId,waitingReason:'Upload the required files for this person before this email can be sent.'};
 }
 return {template,reference:plan.reference,waitingFor:null,waitingReason:null};
}
/** The native owner accepts the actual frozen workflow step and returns the first-preparation email version.
 * It never accepts a substitute employment/person or manufactured reviewer role. */
export async function prepareContractSharedEmailDocuments(tx:SqlExecutor,ctx:SessionContext,input:{
 step:AutomationStepContext;reference:ContractEmailTemplateReference;
 create:(templateId:string,reference:ContractEmailTemplateReference)=>Promise<string>;
}):Promise<ContractPinnedEmailDocuments&{waitingFor:string|null;waitingDocumentId:string|null;waitingReason:ContractEmailDocumentReadiness['reason']|null}>{
 if(ctx.userId)throw new ContractManagementError('forbidden','Email document preparation requires the protected workflow owner.');
 const reference=refSchema.parse(input.reference),{run,step}=input.step;
 const [row]=await tx.execute<{plan:ContractPinnedEmailDocuments}>(sql`select app.contract_shared_email_documents_prepare(${run.subjectId}::uuid,${run.id}::uuid,${step.id},${reference.id}::uuid,${reference.revision}) as plan`);
 const plan=row.plan,documents={...plan.documents};
 // Like the existing V9 email owner, prepare every selected document before choosing the first HR hold.
 // All definitions and Personnel source snapshots therefore belong to the same first preparation.
 for(const templateId of plan.documentTemplateIds){
  if(documents[templateId])continue;
  const [existing]=await tx.execute<{id:string|null}>(sql`select app.contract_shared_email_document_reuse(${run.subjectId}::uuid,${run.id}::uuid,${step.id},${templateId}::uuid) as id`);
  const id=existing.id??z.uuid().parse(await input.create(templateId,plan.reference));
  await tx.execute(sql`select app.contract_shared_email_document_bind(${run.subjectId}::uuid,${run.id}::uuid,${step.id},${templateId}::uuid,${id}::uuid)`);
  documents[templateId]=id;
 }
 for(const templateId of plan.documentTemplateIds){
  const id=documents[templateId];
  const [state]=await tx.execute<{readiness:ContractEmailDocumentReadiness}>(sql`select app.contract_shared_email_document_readiness(${id}::uuid) as readiness`);
  if(!state.readiness.ready)return {...plan,documents,waitingFor:plan.prerequisiteId,waitingDocumentId:id,waitingReason:state.readiness.reason};
 }
 return {...plan,documents,waitingFor:null,waitingDocumentId:null,waitingReason:null};
}
