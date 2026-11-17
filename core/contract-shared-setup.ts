/** Human-reviewed starting configuration, installed as small sealed units on the existing kernel. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import type {BulkJobHandler} from './bulk-job-worker';
import {withScopedLifecycleTenant} from './module-gate';
import {lockAccessConfigurationReadTx} from './access-configuration-lock';
import {contractStartingConfiguration,type ContractStartingMappings} from '../lib/contract-starting-configuration';
import {automationDocumentTemplateSchema,automationDocumentTemplateProblems} from '../lib/automation/document-template';
import {automationWorkflowProblems,type AutomationWorkflow} from '../lib/automation/workflow';
import {automationEmailTemplateProblems,type AutomationEmailTemplate} from '../lib/automation/email';
import {contractStepParamProblems} from '../lib/contract-automation';
import {CONTRACT_AUTOMATION_CATALOGUE} from '../lib/automation/catalogues/contracts';
import {ContractManagementError} from '../lib/contract-management-model';
import {pgSqlState} from '../lib/db-error';
const mappingSchema=z.object({companyId:z.uuid(),fallbackGroupId:z.string().min(1).max(200),postingApproverGroupId:z.string().min(1).max(200),bpRoutingId:z.uuid(),ceoRoutingId:z.uuid()}).strict();
const jobInput=z.object({companyId:z.uuid(),mapping:mappingSchema}).strict().refine(input=>input.companyId===input.mapping.companyId);
export type ContractSharedSetup={installed:boolean;v9Ready:boolean;accessReady:boolean;jobId:string|null;canInstall:boolean;missing:string[];groups:{id:string;name:string}[];routings:{id:string;name:string}[]};
export function contractSharedSetup(ctx:SessionContext,companyId:string):Promise<ContractSharedSetup>{
 z.uuid().parse(companyId);
 return withScopedLifecycleTenant(ctx,async tx=>{
  await lockAccessConfigurationReadTx(tx,ctx.tenantId);
  const [row]=await tx.execute<{value:ContractSharedSetup}>(sql`select app.contract_shared_setup_read(${companyId}::uuid) as value`);
  return {...row.value,missing:row.value.installed&&row.value.accessReady?[]:row.value.missing};
 });
}
export async function startContractSharedSetup(ctx:SessionContext,raw:ContractStartingMappings):Promise<{jobId:string}>{
 const mapping=mappingSchema.parse(raw);
 try{return await withScopedLifecycleTenant(ctx,async tx=>{
  const [row]=await tx.execute<{result:{jobId:string}}>(sql`select app.contract_shared_setup_start(${mapping.companyId}::uuid,${JSON.stringify(mapping)}::jsonb) as result`);
  return row.result;
 });}catch(error){
  if(pgSqlState(error)==='42501')throw new ContractManagementError('forbidden','Map populated native groups and BP and CEO routings. Contract settings, workflow and template permissions are required.');
  throw error;
 }
}
async function check(tx:Tx,mapping:ContractStartingMappings){
 const [row]=await tx.execute<{ok:boolean}>(sql`select app.contract_shared_setup_check(${mapping.companyId}::uuid,${JSON.stringify(mapping)}::jsonb) as ok`);
 if(!row?.ok)throw new ContractManagementError('forbidden','The setup mappings or your Contract configuration authority changed.');
}
const payload=z.object({type:z.enum(['document','email','workflow','settings']),definition:z.unknown()}).strict();
export const contractSetupJobHandler:BulkJobHandler<z.infer<typeof payload>>={
 kind:'contract_setup',mode:'per-step',
 async prepare(ctx,job){
  const {mapping}=jobInput.parse(job.input);
  await withScopedLifecycleTenant(ctx,tx=>check(tx,mapping));
  const defaults=contractStartingConfiguration(mapping),refs={groupExists:(id:string)=>[mapping.fallbackGroupId,mapping.postingApproverGroupId].includes(id),routingExists:(id:string)=>[mapping.bpRoutingId,mapping.ceoRoutingId].includes(id),personExists:()=>false};
  const problems=[...defaults.documents.flatMap(doc=>automationDocumentTemplateProblems(automationDocumentTemplateSchema.parse(doc),refs)),...defaults.emails.flatMap(email=>automationEmailTemplateProblems(email,CONTRACT_AUTOMATION_CATALOGUE,refs)),...defaults.workflows.flatMap(workflow=>[...automationWorkflowProblems(workflow,CONTRACT_AUTOMATION_CATALOGUE,refs),...contractStepParamProblems(workflow,{emailTemplates:defaults.emails.map(email=>({...email,retired:false})),letterTemplateIds:defaults.documents.map(doc=>doc.id)},refs)])];
  if(problems.length)return {refused:'The starting configuration needs review before it can be installed.'};
  return {steps:[...defaults.documents.map(definition=>({kind:'document',payload:{type:'document' as const,definition}})),...defaults.emails.map(definition=>({kind:'email',payload:{type:'email' as const,definition}})),...defaults.workflows.map(definition=>({kind:'workflow',payload:{type:'workflow' as const,definition}})),{kind:'settings',payload:{type:'settings',definition:mapping}}],plan:{version:1}};
 },
 async applyStepTx(tx,_ctx,job,step){
  const {mapping}=jobInput.parse(job.input);await check(tx,mapping);
  const input=payload.parse(step.payload);
  // Definitions were schema/catalogue checked in prepare and frozen by the kernel's sealed step payloads.
  // An existing identity always wins: installing twice never republishes or overwrites a consultant's changes.
  if(input.type==='document'){
   const doc=automationDocumentTemplateSchema.parse(input.definition);
   const [prior]=await tx.execute<{id:string}>(sql`select id from automation_document_template where tenant_id=app.current_tenant_id() and id=${doc.id}::uuid`);
   if(!prior)await tx.execute(sql`select app.automation_document_template_save(${doc.id}::uuid,'contract_staff',${JSON.stringify(doc)}::jsonb,0,true,false)`);
  }else if(input.type==='email'){
   const email=input.definition as AutomationEmailTemplate;
   const [prior]=await tx.execute<{id:string}>(sql`select template_id as id from automation_email_template_version where tenant_id=app.current_tenant_id() and template_id=${email.id}::uuid limit 1`);
   if(!prior)await tx.execute(sql`select app.automation_email_template_save_rich(${email.id}::uuid,'contract_staff',${email.name},${email.active},${email.subject},${email.body},${JSON.stringify(email.cc)}::jsonb,false,0,'Install the reviewed starting configuration',null::jsonb)`);
  }else if(input.type==='workflow'){
   const workflow=input.definition as AutomationWorkflow;
   const [prior]=await tx.execute<{id:string}>(sql`select workflow_id as id from automation_workflow_version where tenant_id=app.current_tenant_id() and workflow_id=${workflow.id}::uuid limit 1`);
   if(!prior){
    const [choices]=await tx.execute<{value:{emails:{id:string;active:boolean;retired:boolean}[];documents:{id:string}[]}}>(sql`select app.automation_template_choices('contract_staff') as value`);
    const problems=contractStepParamProblems(workflow,{emailTemplates:choices.value.emails,letterTemplateIds:choices.value.documents.map(doc=>doc.id)},{groupExists:(id:string)=>[mapping.fallbackGroupId,mapping.postingApproverGroupId].includes(id),routingExists:(id:string)=>[mapping.bpRoutingId,mapping.ceoRoutingId].includes(id),personExists:()=>false});
    if(problems.length)throw new ContractManagementError('invalid','A referenced starting template changed. Review it before continuing setup.');
    const {status,required,...definition}=workflow;await tx.execute(sql`select app.automation_workflow_save(${workflow.id}::uuid,'contract_staff',${status},${required},${JSON.stringify(definition)}::jsonb,0,'Install the reviewed starting configuration')`);
   }
  }else{
   const [prior]=await tx.execute<{revision:number}>(sql`select revision from contract_shared_settings where tenant_id=app.current_tenant_id() and company_id=${mapping.companyId}::uuid`);
   await tx.execute(sql`select app.contract_shared_setup_access_role()`);
   if(!prior)await tx.execute(sql`select app.contract_shared_settings_save(${mapping.companyId}::uuid,0,${JSON.stringify({fallbackGroupId:mapping.fallbackGroupId,postingApproverGroupId:mapping.postingApproverGroupId,stallEnabled:true,stallDays:5,automaticSuperior:{enabled:true,permissions:['view','decide']}})}::jsonb)`);
  }
  return {counters:{configured:1}};
 },
 quietNotice:()=>true,
 async describeFailure(){return {error:'The starting configuration stopped. Check the mapped groups, routings and configuration permissions. Existing definitions were preserved.'};},
};
