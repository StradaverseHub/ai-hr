import {contractLetterDocument,contractDocumentWordingFields,contractWordingKeys} from '../lib/contract-letter-wording';
import {derivedDocumentKind} from '../lib/document-form-fields';
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
import type {contractRoutingChooser} from '../lib/contract-routing-chooser';
import {initializeContractSharedFormTx,lockContractSharedFormTx,prepareContractSharedFormActionTx} from './contract-shared-form';
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
 if(code==='22023')throw new ContractManagementError('invalid','Check the current Contract action and its required details.');
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
/** No chosen account or email is accepted. The native owner binds only the unique active login for the employee person. */
export async function bindContractSharedEmployee(ctx:SessionContext,id:string):Promise<ContractSharedLetter>{
 z.uuid().parse(id);
 try{return await withScopedLifecycleTenant(ctx,async tx=>{
  await tx.execute(sql`select app.contract_shared_letter_bind_employee(${id}::uuid)`);
  return readLetterTx(tx,id);
 });}catch(error){
  if(pgSqlState(error)==='22023')throw new ContractManagementError('invalid','The employee needs exactly one verified active AIHR account linked to their Personnel record. No substitute signer can be chosen.');
  return signingFailure(error);
 }
}
/** Native hash serialization is authoritative; the renderer consumes that exact visible template/body/value snapshot. */
export function renderContractSharedLetter(letter:ContractSharedLetter):Document|null{
 if(!letter.body)return null;
 const {body}=letter;
 if(createHash('sha256').update(body.fingerprintSource).digest('hex')!==letter.contentHash)throw new ContractManagementError('conflict','The retained letter fingerprint could not be verified.');
 const snapshot=JSON.parse(body.fingerprintSource) as {definition:typeof body.definition;blocks:typeof body.blocks;values:typeof body.values};
 const blocks=snapshot.definition.blocks.map(block=>Object.hasOwn(snapshot.blocks,block.id)?block.type==='table'?{...block,rows:snapshot.blocks[block.id]}:['heading','subheading','text'].includes(block.type)?{...block,text:snapshot.blocks[block.id]}:block:block);
 const document=automationDocument({id:letter.id,name:letter.name,templateId:letter.templateId,templateVersion:letter.templateVersion,blocks,fields:snapshot.definition.fields,merge:{...snapshot.values,'company.name':snapshot.values['org.company']??''},createdAt:letter.generatedOn,receipts:body.receipts});
 return {...contractLetterDocument(document),status:letter.state==='withdrawn'?'withdrawn':letter.state==='released'?(body.receipts.length?'signed':'completed'):'draft'};
}
const letterAction=z.object({id:z.uuid(),actionId:z.uuid(),stepId:z.string().min(1).max(200),revision:z.number().int().positive(),hash:z.string().regex(/^[a-f0-9]{64}$/),action:z.enum(['signed','reviewed','approved','returned','resent']),comment:z.string().trim().max(5000).default(''),method:z.enum(['typed','drawn']).optional(),value:z.string().max(1048576).optional(),consent:z.boolean().optional(),responseRevision:z.number().int().positive().optional(),responseHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),blocks:z.record(z.string().min(1).max(200),z.string().max(1048576)).optional()}).strict().refine(input=>input.blocks===undefined||['reviewed','approved'].includes(input.action),'Save wording while completing a review or approval.');
export async function actContractSharedLetter(ctx:SessionContext,raw:z.input<typeof letterAction>):Promise<ContractSharedLetter>{
 const input=letterAction.parse(raw);
 try{return await withScopedLifecycleTenant(ctx,async tx=>{
  const current=await readLetterTx(tx,input.id);
  if(input.blocks){const fields=contractDocumentWordingFields(renderContractSharedLetter(current),Object.keys(current.body?.values??{}));input.blocks=Object.fromEntries(Object.entries(input.blocks).map(([key,value])=>[key,contractWordingKeys(value,fields)]));}
  const form=current.body&&derivedDocumentKind(current.body.definition.blocks)==='Form';
  // Form answers share the legal action transaction and follow the native source/letter/signing/response lock order.
  if(form)await lockContractSharedFormTx(tx,input.id);
  const signature=input.action==='signed'?{method:input.method,value:input.value,consent:input.consent}:null;
  const [prepared]=input.blocks!==undefined
   ?await tx.execute<{result:{duplicate:boolean;signingDocumentId:string;revision:number;hash:string}}>(sql`select app.contract_shared_review_prepare(${input.id}::uuid,${input.stepId},${input.actionId}::uuid,${input.action},${input.comment},${input.hash},${input.revision},${JSON.stringify(input.blocks)}::jsonb) as result`)
   :await tx.execute<{result:{duplicate:boolean;signingDocumentId:string;revision?:number;hash?:string}}>(sql`select app.contract_shared_letter_action_prepare(${input.id}::uuid,${input.stepId},${input.actionId},${input.action},${input.comment},${input.hash},${input.revision},${JSON.stringify(signature)}::jsonb) as result`);
  if(form)await prepareContractSharedFormActionTx(tx,ctx,{letterId:input.id,actionId:input.actionId,stepId:input.stepId,action:input.action,contentRevision:prepared.result.revision??input.revision,contentHash:prepared.result.hash??input.hash,responseRevision:input.responseRevision,responseHash:input.responseHash,signature});
  if(!prepared.result.duplicate){
   if(input.action==='resent')await resendSigningDocumentTx(tx,ctx,{id:prepared.result.signingDocumentId,actionId:input.actionId,comment:input.comment});
   else await recordDocumentSigningActionTx(tx,ctx,{id:prepared.result.signingDocumentId,actionId:input.actionId,stepId:input.stepId,revision:prepared.result.revision??input.revision,hash:prepared.result.hash??input.hash,action:input.action,comment:input.comment,method:input.method,value:input.value,consent:input.consent});
  }
  return readLetterTx(tx,input.id);
 });}catch(error){return signingFailure(error);}
}
export async function editContractSharedLetter(ctx:SessionContext,raw:{id:string;revision:number;hash:string;blocks:Record<string,string>}):Promise<ContractSharedLetter>{
 const input=z.object({id:z.uuid(),revision:z.number().int().positive(),hash:z.string().regex(/^[a-f0-9]{64}$/),blocks:z.record(z.string().min(1).max(200),z.string().max(1048576))}).strict().parse(raw);
 try{return await withScopedLifecycleTenant(ctx,async tx=>{
  const current=await readLetterTx(tx,input.id),fields=contractDocumentWordingFields(renderContractSharedLetter(current),Object.keys(current.body?.values??{}));input.blocks=Object.fromEntries(Object.entries(input.blocks).map(([key,value])=>[key,contractWordingKeys(value,fields)]));
  await tx.execute(sql`select app.contract_shared_letter_edit(${input.id}::uuid,${input.revision},${input.hash},${JSON.stringify(input.blocks)}::jsonb)`);
  return readLetterTx(tx,input.id);
 });}catch(error){return signingFailure(error);}
}

async function prepareContractSharedLetter(tx:SqlExecutor,ctx:SessionContext,input:{view:{id:string;companyId:string;employmentId:string;flow:ContractFlow|null};context:ContractAutomationContext;step:AutomationStepContext;templates:{template:AutomationDocumentTemplate;version:number}[];lastAssigned:Record<string,string|null>;today:string;chooser?:ReturnType<typeof contractRoutingChooser>;email?:{templateId:string;reference:{id:string;revision:number}}}){
 if(ctx.userId)throw new ContractManagementError('forbidden','A protected Contract event worker is required.');
 const chosen=input.templates.find(item=>item.template.id===(input.email?.templateId??input.step.step.params.letterTemplateId)),decision=input.view.flow?.decision;
 if(!chosen||!decision&&!input.email)throw new ContractManagementError('conflict','A published outcome template and accepted decision are required.');
 const names={renew:'Renew',convert:'Convert to permanent',end:'End'};
 const facts={businessGroup:input.context.businessGroupId,company:input.view.companyId,department:input.context.departmentId,jobTitle:input.context.jobTitle,decision:decision?names[decision.kind]:null};
 if(!automationDocumentMatches(chosen.template,field=>facts[field as keyof typeof facts]??null))throw new ContractManagementError('conflict','The outcome template does not match this decision and organisation.');
 const assignment=contractLetterAssignment(chosen.template,input.context,{today:input.today,lastAssigned:input.lastAssigned},input.chooser);
 if(assignment.unresolved.some(issue=>!issue.holderId&&assignment.route.steps.find(step=>step.id===issue.stepId)?.role!=='employee'))throw new ContractManagementError('conflict','A letter step has no eligible holder or fallback member.');
 const routing={templateId:chosen.template.id,templateVersion:chosen.version,caseOwnerId:assignment.route.steps.find(step=>step.owner)?.holderId??null,fallbackGroupId:input.context.fallbackGroupId,liveMergeReviews:true};
 const [prepared]=await tx.execute<{letter:{id:string;signingDocumentId:string;contentHash:string;state:string;existing:boolean}}>(sql`select app.contract_shared_prepare_letter(${input.view.id}::uuid,${input.step.run.id}::uuid,${input.step.step.id},${chosen.template.id}::uuid,${chosen.version},${JSON.stringify(assignment.route)}::jsonb,${JSON.stringify(routing)}::jsonb,${input.email?JSON.stringify(input.email.reference):null}::jsonb) as letter`);
 const letter=prepared.letter;
 if(!letter.existing){
  const contentHash=derivedDocumentKind(chosen.template.blocks)==='Form'?await initializeContractSharedFormTx(tx,ctx,letter.id):null;
  await createSigningDocumentTx(tx,ctx,{id:letter.signingDocumentId,companyId:input.view.companyId,employmentId:input.view.employmentId,subjectId:letter.id,subjectType:'contract',contentHash:contentHash??letter.contentHash,route:assignment.route,guardrails:{requiredRoles:[]},routing});
  if(!input.email)await tx.execute(sql`select app.contract_shared_enqueue_child_event(nullif(current_setting('app.contract_event',true),'')::uuid,'letterActionNeeded',${'letter:'+letter.id+':generated'},jsonb_build_object('letterId',${letter.id}::text))`);
 }
 return letter;
}
/** The normal Generate document step still waits for canonical release. */
export async function activateContractSharedLetter(...args:Parameters<typeof prepareContractSharedLetter>){
 const letter=await prepareContractSharedLetter(...args);
 return letter.state==='released'?{status:'done' as const,message:'The existing outcome letter has been released.'}:{status:'wait' as const,documentId:letter.id,message:'Waiting for the outcome letter to be reviewed and released.'};
}
/** Email-selected documents share the native document owner; the Send email step owns the prerequisite hold. */
export async function activateContractSharedEmailDocument(tx:SqlExecutor,ctx:SessionContext,input:Parameters<typeof prepareContractSharedLetter>[2]&{email:NonNullable<Parameters<typeof prepareContractSharedLetter>[2]['email']>}):Promise<string>{
 return (await prepareContractSharedLetter(tx,ctx,input)).id;
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
export async function activateContractSharedApproval(tx:SqlExecutor,ctx:SessionContext,input:{view:{id:string;companyId:string;employmentId:string;flow:ContractFlow|null};context:ContractAutomationContext;step:AutomationStepContext;lastAssigned:Record<string,string|null>;today:string;chooser?:ReturnType<typeof contractRoutingChooser>}){
 if(ctx.userId)throw new ContractManagementError('forbidden','A protected Contract event worker is required.');
 const flow=input.view.flow;
 if(!flow?.decision)throw new ContractManagementError('conflict','An accepted decision is required.');
 const layers=contractApprovalLayersSchema.parse(input.step.step.params.layers);
 const assignments=contractApprovalAssignments({layers,context:input.context,today:input.today,lastAssigned:input.lastAssigned},input.chooser);
 if(assignments.some(item=>!item.candidateUserIds.length||item.layer.pick==='roundRobin'&&!item.selectedUserId))throw new ContractManagementError('conflict','An approval layer has no eligible approver or fallback member.');
 const route=newContractApprovalRequest({id:randomUUID(),caseId:input.view.id,tenantId:ctx.tenantId,companyId:input.view.companyId,decisionRevision:flow.decision.revision,subjectPersonId:input.context.subjectPersonId,fingerprint:'0'.repeat(64),assignments}).document.route;
 const [prepared]=await tx.execute<{approval:{id:string;signingDocumentId:string;contentHash:string;existing:boolean}}>(sql`select app.contract_shared_prepare_approval(${input.view.id}::uuid,${input.step.run.id}::uuid,${input.step.step.id},${JSON.stringify(assignments)}::jsonb,${JSON.stringify(route)}::jsonb) as approval`);
 const approval=prepared.approval;
 if(!approval.existing){
  await createSigningDocumentTx(tx,ctx,{id:approval.signingDocumentId,companyId:input.view.companyId,employmentId:input.view.employmentId,subjectId:approval.id,subjectType:'contract-approval',contentHash:approval.contentHash,route,guardrails:{requiredRoles:[]}});
  await tx.execute(sql`select app.contract_shared_enqueue_child_event(nullif(current_setting('app.contract_event',true),'')::uuid,'approvalActionNeeded',${'approval:'+approval.id+':created'},jsonb_build_object('approvalId',${approval.id}::text))`);
 }
 return {status:'wait' as const,documentId:approval.id,message:'Waiting for the configured decision approval layers.'};
}
