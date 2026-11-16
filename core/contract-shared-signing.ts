import {createHash,randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import type {SqlExecutor} from '../db/sql-executor';
import {withScopedLifecycleTenant} from './module-gate';
import {pgSqlState} from '../lib/db-error';
import {ContractManagementError} from '../lib/contract-management-model';
import {contractApprovalLayersSchema} from '../lib/contract-automation';
import {contractApprovalAssignments} from '../lib/contract-approval-assignment';
import {newContractApprovalRequest} from '../lib/contract-approval-flow';
import type {ContractAutomationContext} from '../lib/contract-automation-context';
import type {ContractFlow,ContractFlowDecision} from '../lib/contract-case-flow';
import type {AutomationStepContext} from '../lib/automation/runtime';
import {createSigningDocumentTx,recordDocumentSigningActionTx,resendSigningDocumentTx} from '../packs/document-signing/service';
import {automationDocument,type AutomationDocumentSignature} from '../lib/automation-document';
import {automationDocumentMatches,type AutomationDocumentTemplate} from '../lib/automation/document-template';
import {contractLetterAssignment} from '../lib/contract-letter-routing';
import type {ContractLetterFlow} from '../lib/contract-letter-flow';
import type {Document} from '../lib/lifecycle-v9-model';

export type ContractSharedApproval={
 id:string;caseId:string;decisionRevision:number;employeeName:string;employeeCode:string;company:string;
 decision:ContractFlowDecision;period:ContractFlow['period'];contentRevision:number;contentHash:string;pendingLayerId:string|null;
 canAct:boolean;status:'pending'|'approved'|'rejected'|'cancelled';
 layers:{id:string;label:string;stage:number;assigneeName:string|null;fulfilled:boolean}[];
 history:{id:string;stepId:string;actorName:string;action:'approved'|'returned';comment:string;at:string}[];
};
async function readApprovalTx(tx:SqlExecutor,id:string):Promise<ContractSharedApproval>{
 const [row]=await tx.execute<{approval:ContractSharedApproval}>(sql`select app.contract_shared_approval_read(${id}::uuid) as approval`);
 return row.approval;
}
function signingFailure(error:unknown):never{
 const code=pgSqlState(error);
 if(code==='42501')throw new ContractManagementError('forbidden','This Contract item is unavailable.');
 if(code==='40001'||code==='P0001')throw new ContractManagementError('conflict','This Contract item changed. Reload before acting.');
 if(code==='22023')throw new ContractManagementError('invalid','Check the current approval layer and enter a rejection reason when rejecting.');
 throw error;
}

export type ContractSharedLetter={
 id:string;caseId:string;decisionRevision:number;templateId:string;templateVersion:number;name:string;generatedOn:string;
 state:ContractLetterFlow['state'];valuesFixed:boolean;releasedAt:string|null;contentRevision:number;contentHash:string|null;
 returned:boolean;canEdit:boolean;canResend:boolean;pendingAction:{stepId:string;kind:'review'|'approve'|'sign'}|null;
 layers:{id:string;label:string;stage:number;kind:string;owner:boolean;assigneeName:string|null;unavailable:boolean;fulfilled:boolean}[];
 history:{id:string;stepId:string;actorName:string;action:string;comment:string;at:string;revision:number;hash:string}[];
 body:{definition:NonNullable<ContractLetterFlow['definition']>;blocks:Record<string,string>;values:Record<string,string>;receipts:AutomationDocumentSignature[];fingerprintSource:string}|null;
};
async function readLetterTx(tx:SqlExecutor,id:string):Promise<ContractSharedLetter>{
 const [row]=await tx.execute<{letter:ContractSharedLetter}>(sql`select app.contract_shared_letter_read(${id}::uuid) as letter`);return row.letter;
}
export async function readContractSharedLetter(ctx:SessionContext,id:string){
 z.uuid().parse(id);try{return await withScopedLifecycleTenant(ctx,tx=>readLetterTx(tx,id));}catch(error){return signingFailure(error);}
}
/** Native hash serialization is authoritative; the renderer consumes that exact visible template/body/value snapshot. */
export function renderContractSharedLetter(letter:ContractSharedLetter):Document|null{
 if(!letter.body)return null;
 const {body}=letter;
 if(createHash('sha256').update(body.fingerprintSource).digest('hex')!==letter.contentHash)throw new ContractManagementError('conflict','The retained letter fingerprint could not be verified.');
 const snapshot=JSON.parse(body.fingerprintSource) as {definition:typeof body.definition;blocks:typeof body.blocks;values:typeof body.values};
 const blocks=snapshot.definition.blocks.map(block=>Object.hasOwn(snapshot.blocks,block.id)?block.type==='table'?{...block,rows:snapshot.blocks[block.id]}:['heading','subheading','text'].includes(block.type)?{...block,text:snapshot.blocks[block.id]}:block:block);
 const document=automationDocument({id:letter.id,name:letter.name,templateId:letter.templateId,templateVersion:letter.templateVersion,blocks,fields:snapshot.definition.fields,merge:{...snapshot.values,'company.name':snapshot.values['org.company']??''},createdAt:letter.generatedOn,receipts:body.receipts});
 return {...document,status:letter.state==='withdrawn'?'withdrawn':letter.state==='released'?(body.receipts.length?'signed':'completed'):'draft'};
}
const letterAction=z.object({id:z.uuid(),actionId:z.uuid(),stepId:z.string().min(1).max(200),revision:z.number().int().positive(),hash:z.string().regex(/^[a-f0-9]{64}$/),action:z.enum(['signed','reviewed','approved','returned','resent']),comment:z.string().trim().max(5000).default(''),method:z.enum(['typed','drawn']).optional(),value:z.string().max(1048576).optional(),consent:z.boolean().optional()}).strict();
export async function actContractSharedLetter(ctx:SessionContext,raw:z.input<typeof letterAction>):Promise<ContractSharedLetter>{
 const input=letterAction.parse(raw);
 try{return await withScopedLifecycleTenant(ctx,async tx=>{
  const signature=input.action==='signed'?{method:input.method,value:input.value,consent:input.consent}:null;
  const [prepared]=await tx.execute<{result:{duplicate:boolean;signingDocumentId:string}}>(sql`select app.contract_shared_letter_action_prepare(${input.id}::uuid,${input.stepId},${input.actionId},${input.action},${input.comment},${input.hash},${input.revision},${JSON.stringify(signature)}::jsonb) as result`);
  if(!prepared.result.duplicate){
   if(input.action==='resent')await resendSigningDocumentTx(tx,ctx,{id:prepared.result.signingDocumentId,actionId:input.actionId,comment:input.comment});
   else await recordDocumentSigningActionTx(tx,ctx,{id:prepared.result.signingDocumentId,actionId:input.actionId,stepId:input.stepId,revision:input.revision,hash:input.hash,action:input.action,comment:input.comment,method:input.method,value:input.value,consent:input.consent});
  }
  return readLetterTx(tx,input.id);
 });}catch(error){return signingFailure(error);}
}
export async function editContractSharedLetter(ctx:SessionContext,raw:{id:string;revision:number;hash:string;blocks:Record<string,string>}):Promise<ContractSharedLetter>{
 const input=z.object({id:z.uuid(),revision:z.number().int().positive(),hash:z.string().regex(/^[a-f0-9]{64}$/),blocks:z.record(z.string().min(1).max(200),z.string().max(1048576))}).strict().parse(raw);
 try{return await withScopedLifecycleTenant(ctx,async tx=>{
  await tx.execute(sql`select app.contract_shared_letter_edit(${input.id}::uuid,${input.revision},${input.hash},${JSON.stringify(input.blocks)}::jsonb)`);
  return readLetterTx(tx,input.id);
 });}catch(error){return signingFailure(error);}
}

export async function activateContractSharedLetter(tx:SqlExecutor,ctx:SessionContext,input:{view:{id:string;companyId:string;employmentId:string;flow:ContractFlow|null};context:ContractAutomationContext;step:AutomationStepContext;templates:{template:AutomationDocumentTemplate;version:number}[];lastAssigned:Record<string,string|null>;today:string}){
 if(ctx.userId)throw new ContractManagementError('forbidden','A protected Contract event worker is required.');
 const chosen=input.templates.find(item=>item.template.id===input.step.step.params.letterTemplateId),decision=input.view.flow?.decision;
 if(!chosen||!decision)throw new ContractManagementError('conflict','A published outcome template and accepted decision are required.');
 const names={renew:'Renew',convert:'Convert to permanent',end:'End'};
 const facts={businessGroup:input.context.businessGroupId,company:input.view.companyId,department:input.context.departmentId,jobTitle:input.context.jobTitle,decision:names[decision.kind]};
 if(!automationDocumentMatches(chosen.template,field=>facts[field as keyof typeof facts]??null))throw new ContractManagementError('conflict','The outcome template does not match this decision and organisation.');
 const assignment=contractLetterAssignment(chosen.template,input.context,{today:input.today,lastAssigned:input.lastAssigned});
 if(assignment.unresolved.some(issue=>!issue.holderId&&assignment.route.steps.find(step=>step.id===issue.stepId)?.role!=='employee'))throw new ContractManagementError('conflict','A letter step has no eligible holder or fallback member.');
 const routing={templateId:chosen.template.id,templateVersion:chosen.version,caseOwnerId:assignment.route.steps.find(step=>step.owner)?.holderId??null,fallbackGroupId:input.context.fallbackGroupId,liveMergeReviews:true};
 const [prepared]=await tx.execute<{letter:{id:string;signingDocumentId:string;contentHash:string;state:string;existing:boolean}}>(sql`select app.contract_shared_prepare_letter(${input.view.id}::uuid,${input.step.run.id}::uuid,${input.step.step.id},${chosen.template.id}::uuid,${chosen.version},${JSON.stringify(assignment.route)}::jsonb,${JSON.stringify(routing)}::jsonb) as letter`);
 const letter=prepared.letter;
 if(!letter.existing){
  await createSigningDocumentTx(tx,ctx,{id:letter.signingDocumentId,companyId:input.view.companyId,employmentId:input.view.employmentId,subjectId:letter.id,subjectType:'contract',contentHash:letter.contentHash,route:assignment.route,guardrails:{requiredRoles:[]},routing});
  await tx.execute(sql`select app.contract_shared_enqueue_child_event(nullif(current_setting('app.contract_event',true),'')::uuid,'letterActionNeeded',${'letter:'+letter.id+':generated'},jsonb_build_object('letterId',${letter.id}::text))`);
 }
 return letter.state==='released'?{status:'done' as const,message:'The existing outcome letter has been released.'}:{status:'wait' as const,documentId:letter.id,message:'Waiting for the outcome letter to be reviewed and released.'};
}
export async function readContractSharedApproval(ctx:SessionContext,id:string){
 z.uuid().parse(id);
 try{return await withScopedLifecycleTenant(ctx,tx=>readApprovalTx(tx,id));}catch(error){return signingFailure(error);}
}
const approvalAction=z.object({id:z.uuid(),actionId:z.uuid(),layerId:z.string().min(1).max(200),revision:z.number().int().positive(),hash:z.string().regex(/^[a-f0-9]{64}$/),action:z.enum(['approve','reject']),reason:z.string().trim().max(5000)}).strict();
export async function actContractSharedApproval(ctx:SessionContext,raw:z.input<typeof approvalAction>):Promise<ContractSharedApproval>{
 const input=approvalAction.parse(raw),action=input.action==='approve'?'approved' as const:'returned' as const;
 if(input.action==='reject'&&!input.reason)throw new ContractManagementError('invalid','Enter a rejection reason.');
 try{return await withScopedLifecycleTenant(ctx,async tx=>{
  const [prepared]=await tx.execute<{result:{duplicate:boolean;signingDocumentId:string}}>(sql`select app.contract_shared_approval_action_prepare(${input.id}::uuid,${input.layerId},${input.actionId},${action},${input.reason},${input.hash},${input.revision}) as result`);
  if(!prepared.result.duplicate)await recordDocumentSigningActionTx(tx,ctx,{id:prepared.result.signingDocumentId,actionId:input.actionId,stepId:input.layerId,revision:input.revision,hash:input.hash,action,comment:input.reason});
  return readApprovalTx(tx,input.id);
 });}catch(error){return signingFailure(error);}
}

/** Internal executor. The native preparation and signing owners recheck the held event and frozen workflow step. */
export async function activateContractSharedApproval(tx:SqlExecutor,ctx:SessionContext,input:{view:{id:string;companyId:string;employmentId:string;flow:ContractFlow|null};context:ContractAutomationContext;step:AutomationStepContext;lastAssigned:Record<string,string|null>;today:string}){
 if(ctx.userId)throw new ContractManagementError('forbidden','A protected Contract event worker is required.');
 const flow=input.view.flow;
 if(!flow?.decision)throw new ContractManagementError('conflict','An accepted decision is required.');
 const layers=contractApprovalLayersSchema.parse(input.step.step.params.layers);
 const assignments=contractApprovalAssignments({layers,context:input.context,today:input.today,lastAssigned:input.lastAssigned});
 if(assignments.some(item=>!item.candidateUserIds.length||item.layer.pick==='roundRobin'&&!item.selectedUserId))throw new ContractManagementError('conflict','An approval layer has no eligible approver or fallback member.');
 const route=newContractApprovalRequest({id:randomUUID(),caseId:input.view.id,tenantId:ctx.tenantId,companyId:input.view.companyId,decisionRevision:flow.decision.revision,subjectPersonId:input.context.subjectPersonId,fingerprint:'0'.repeat(64),assignments}).document.route;
 const [prepared]=await tx.execute<{approval:{id:string;signingDocumentId:string;contentHash:string;existing:boolean}}>(sql`select app.contract_shared_prepare_approval(${input.view.id}::uuid,${input.step.run.id}::uuid,${input.step.step.id},${JSON.stringify(assignments)}::jsonb,${JSON.stringify(route)}::jsonb) as approval`);
 const approval=prepared.approval;
 if(!approval.existing)await createSigningDocumentTx(tx,ctx,{id:approval.signingDocumentId,companyId:input.view.companyId,employmentId:input.view.employmentId,subjectId:approval.id,subjectType:'contract-approval',contentHash:approval.contentHash,route,guardrails:{requiredRoles:[]}});
 return {status:'wait' as const,documentId:approval.id,message:'Waiting for the configured decision approval layers.'};
}
