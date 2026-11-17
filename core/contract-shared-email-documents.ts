/** Canonical pinned email documents; shared runtime owns waiting and OneHR owns delivery. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import type {SqlExecutor} from '../db/sql-executor';
import type {AutomationStepContext} from '../lib/automation/runtime';
import {ContractManagementError} from '../lib/contract-management-model';

export type ContractEmailTemplateReference={id:string;revision:number};
export type ContractPinnedEmailDocuments={
 prerequisiteId:string;sourcePeriodRevision:string;reference:ContractEmailTemplateReference;template:Record<string,unknown>;
 documentTemplateIds:string[];documents:Record<string,string>;
};
export type ContractEmailDocumentReadiness={ready:boolean;reason:'released'|'employee'|'employee_account'|'hr_steps'|'returned'|'stopped'|'source_changed'};
const refSchema=z.object({id:z.uuid(),revision:z.number().int().positive()}).strict();
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
