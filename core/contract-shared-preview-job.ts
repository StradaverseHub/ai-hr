/** Protected decision preflight on the existing bulk-job kernel. Private routing inputs never become an app read API. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type postgres from 'postgres';
import type {SessionContext} from '../db/client';
import {reservedSqlExecutor} from '../db/sql-executor';
import {withScopedLifecycleTenant} from './module-gate';
import type {BulkJobHandler} from './bulk-job-worker';
import type {ContractSharedContext} from './contract-shared-read';
import {contractSharedAutomationContext,type ContractContextReferences} from './contract-shared-context';
import {contractProposedDecisionSchema} from './contract-shared-commands';
import {validateContractFlowDecision} from '../lib/contract-case-flow';
import {buildContractDecisionPlan,type ContractDecisionPlan,type ContractPreviewDefinitions} from '../lib/contract-decision-preview';
import {contractWorkflowRecipients} from '../lib/contract-automation';
import type {AutomationWorkflow} from '../lib/automation/workflow';
import type {Routing} from '../lib/automation/routing';
import type {AutomationDocumentTemplate} from '../lib/automation/document-template';
import type {AutomationEmailTemplate} from '../lib/automation/email';
import {todayInKualaLumpur} from '../lib/hr-date';

const inputSchema=z.object({previewId:z.uuid()}).strict();
const MAX_PREVIEW_PEOPLE=5000;
const emptyPlan=(reason:string):ContractDecisionPlan=>({blockers:[reason],warnings:[],workflowVersions:[],workflows:[],approvalAssignments:{},letterAssignments:{}});

/** The case reader and participant owner run as the actual proposer; private reference reads run only as the worker. */
async function readPreviewInputs(owner:postgres.ReservedSql,ctx:SessionContext,caseId:string,execution=false){
 await owner`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id','',true),set_config('jit','off',true)`;
 const db=reservedSqlExecutor(owner);
 // The seal must precede every plan input read; finalization compares it again after all those reads.
 const setup=execution?{revision:''}:(await db.execute<{revision:string}>(sql`select app.contract_shared_setup_revision(${caseId}::uuid) as revision`))[0];
 if(!execution)await owner`select set_config('app.user_id',${ctx.userId??''},true)`;
 type CaseInputs={view:ContractSharedContext;participants:ContractContextReferences['participants'];documents?:ContractContextReferences['documents']};
 const caseRow=execution
  ?(await db.execute<{bundle:CaseInputs}>(sql`select app.contract_shared_worker_context(${caseId}::uuid) as bundle`))[0]?.bundle
  :(await db.execute<CaseInputs>(sql`select app.contract_shared_context(${caseId}::uuid) as view,app.contract_shared_participants(${caseId}::uuid) as participants`))[0];
 await owner`select set_config('app.user_id','',true)`;
 if(!caseRow?.view?.flow)throw new Error('Contract preview source is unavailable.');
 const [configured]=await db.execute<{groups:ContractContextReferences['groups'];fallback:string|null;posting:string|null}>(sql`
  select coalesce(v.data->'groups','[]'::jsonb) as groups,coalesce(s.fallback_group_id,v.data->>'peopleOpsGroup') as fallback,coalesce(s.posting_group_id,v.data->>'peopleOpsGroup') as posting
  from contract_case c left join lc_v9_config v on v.tenant_id=c.tenant_id left join contract_shared_settings s on s.tenant_id=c.tenant_id and s.company_id=c.company_id
  where c.tenant_id=${ctx.tenantId}::uuid and c.id=${caseId}::uuid`);
 type WorkflowRow={id:string;revision:number;required:boolean;definition:AutomationWorkflow};
 const workflows=execution?await db.execute<WorkflowRow>(sql`
  select distinct v.workflow_id as id,v.revision,v.required,v.definition from contract_shared_event e
  join automation_workflow_version v on v.tenant_id=e.tenant_id and v.module='contract_staff' and (
   exists(select 1 from jsonb_array_elements(e.workflow_versions) x where x->>'workflowId'=v.workflow_id::text and x->>'revision'=v.revision::text)
   or exists(select 1 from automation_run r where r.tenant_id=e.tenant_id and r.subject_id=e.case_id and r.module='contract_staff' and r.status='waiting'
    and r.waiting_for::text=coalesce(e.data->>'prerequisiteId',e.data->>'approvalId',e.data->>'letterId') and r.workflow_id=v.workflow_id and r.workflow_revision=v.revision))
  where e.tenant_id=${ctx.tenantId}::uuid and e.case_id=${caseId}::uuid and e.job_id::text=current_setting('app.bulk_job',true)
  and e.id::text=current_setting('app.contract_event',true)
  order by id,v.revision limit 251`):await db.execute<WorkflowRow>(sql`
  select workflow_id as id,revision,required,definition from(select distinct on(workflow_id) workflow_id,revision,status,required,definition from automation_workflow_version
   where tenant_id=${ctx.tenantId}::uuid and module='contract_staff' order by workflow_id,revision desc) latest
  where status='live' and definition->'trigger'->>'event'='decisionSubmitted' order by workflow_id limit 201`);
 const uuidArray=(ids:readonly string[])=>'{'+[...new Set(ids.filter(id=>z.uuid().safeParse(id).success))].join(',')+'}';
 const steps=workflows.flatMap(row=>row.definition.steps);
 const directDocumentIds=steps.flatMap(step=>step.type==='generateDocument'&&typeof step.params.letterTemplateId==='string'?[step.params.letterTemplateId]:[]);
 const emailIds=steps.flatMap(step=>step.type==='sendEmail'&&typeof step.params.emailTemplateId==='string'?[step.params.emailTemplateId]:[]);
 type EmailRow={id:string;name:string;active:boolean;retired:boolean;revision:number;cc:AutomationEmailTemplate['cc'];subject:string|null;body:string|null;bodyDoc:AutomationEmailTemplate['bodyDoc']|null;documentIds:string[]};
 const emails=await db.execute<EmailRow>(sql`
  select template_id as id,name,active,retired,revision,cc,coalesce(document_ids,'[]'::jsonb) as "documentIds",
  ${execution?sql`subject,body,body_doc as "bodyDoc"`:sql`null::text as subject,null::text as body,null::jsonb as "bodyDoc"`}
  from automation_email_template_version email where tenant_id=${ctx.tenantId}::uuid and module='contract_staff' and template_id=any(${uuidArray(emailIds)}::uuid[])
  and (revision=(select max(latest.revision) from automation_email_template_version latest where latest.tenant_id=email.tenant_id and latest.template_id=email.template_id)
  ${execution?sql`or exists(select 1 from contract_shared_email_document_step pin join automation_run run on run.tenant_id=pin.tenant_id and run.id=pin.workflow_run_id
   where pin.tenant_id=email.tenant_id and pin.case_id=${caseId}::uuid and pin.email_template_id=email.template_id and pin.email_revision=email.revision
   and run.module='contract_staff' and run.status in('running','waiting') and run.workflow_id=any(${uuidArray(workflows.map(row=>row.id))}::uuid[]))`:sql``})
  order by template_id,revision desc limit 501`);
 const documentIds=[...new Set([...directDocumentIds,...emails.flatMap(email=>email.documentIds)])];
 const documents=await db.execute<{template:AutomationDocumentTemplate;version:number}>(sql`
  select v.definition as template,h.live_version as version from automation_document_template h join automation_document_template_version v on v.tenant_id=h.tenant_id and v.template_id=h.id and v.version=h.live_version
  where h.tenant_id=${ctx.tenantId}::uuid and h.module='contract_staff' and not h.retired and h.id=any(${uuidArray(documentIds)}::uuid[]) order by h.id limit 501`);
 const recipients=[...workflows.flatMap(row=>contractWorkflowRecipients(row.definition)),...emails.flatMap(email=>email.cc)];
 const routingIds=[...recipients.flatMap(recipient=>recipient.kind==='routing'?[recipient.routingId]:[]),...documents.flatMap(({template})=>template.routing.flatMap(step=>step.who.kind==='routing'?[step.who.routingId]:[]))];
 const routingRows=await db.execute<{id:string;name:string;rows:Routing['rows']}>(sql`
  select routing_id as id,name,routing_rows as rows from(select distinct on(routing_id) routing_id,name,routing_rows,retired,revision from automation_routing_version
   where tenant_id=${ctx.tenantId}::uuid and routing_id=any(${uuidArray(routingIds)}::uuid[]) order by routing_id,revision desc) latest where not retired order by routing_id limit 501`);
 const groupIds=new Set([configured?.fallback,configured?.posting,...recipients.flatMap(recipient=>recipient.kind==='group'?[recipient.groupId]:[]),...routingRows.flatMap(routing=>routing.rows.flatMap(row=>row.assignTo.kind==='group'?[row.assignTo.groupId]:[])),...documents.flatMap(({template})=>template.routing.flatMap(step=>step.who.kind==='group'?[step.who.groupId]:[]))]);
 if(workflows.length>(execution?250:200)||routingRows.length>500||documents.length>500||emails.length>500)throw new Error('Contract automation reference limits exceeded.');
 const refs:ContractContextReferences={participants:caseRow.participants,groups:(configured?.groups??[]).filter(group=>groupIds.has(group.id)),fallbackGroupId:configured?.fallback??null,postingApproverGroupId:configured?.posting??null,routings:[...routingRows],people:[],documents:caseRow.documents??[]};
 const definitions:ContractPreviewDefinitions={workflows:workflows.map(row=>({revision:row.revision,workflow:{...row.definition,id:row.id,module:'contract_staff',status:'live',required:row.required}})),documents:[...documents],emails:emails.map(({id,name,active,retired,cc})=>({id,name,active,retired,cc})),lastAssigned:{}};
 const ids=new Set(refs.participants.map(p=>p.id));
 for(const document of refs.documents){
  for(const step of document.route.steps)if(step.holderId)ids.add(step.holderId);
  if(document.routing?.caseOwnerId)ids.add(document.routing.caseOwnerId);
 }
 for(const group of refs.groups)for(const id of group.members)ids.add(id);
 for(const routing of refs.routings)for(const row of routing.rows)if(row.assignTo.kind==='people')for(const id of row.assignTo.userIds)ids.add(id);
 for(const {workflow} of definitions.workflows)for(const recipient of contractWorkflowRecipients(workflow))if(recipient.kind==='person')ids.add(recipient.userId);
 for(const email of emails)for(const recipient of email.cc)if(recipient.kind==='person')ids.add(recipient.userId);
 for(const {template} of definitions.documents)for(const step of template.routing)if(step.who.kind==='people')for(const id of step.who.userIds)ids.add(id);
 const valid=[...ids].filter(id=>z.uuid().safeParse(id).success);
 if(valid.length>MAX_PREVIEW_PEOPLE)throw new Error('Contract preview identity limits exceeded.');
 if(valid.length){
  refs.people=[...await db.execute<{id:string;personId:string;name:string}>(sql`select u.id,u.person_id as "personId",p.full_name as name from app_user u join person p on p.tenant_id=u.tenant_id and p.id=u.person_id
   where u.tenant_id=${ctx.tenantId}::uuid and u.id in(${sql.join(valid.map(id=>sql`${id}::uuid`),sql`, `)}) and app.contract_verified_human(u.id) order by u.id`)];
  const recent=await db.execute<{id:string;last:string}>(sql`select user_id as id,max(assigned_at)::text as last from document_signing_assignment
   where tenant_id=${ctx.tenantId}::uuid and user_id in(${sql.join(valid.map(id=>sql`${id}::uuid`),sql`, `)}) group by user_id`);
  definitions.lastAssigned=Object.fromEntries(recent.map(row=>[row.id,row.last]));
 }
 if(execution&&emails.some(email=>email.subject===null||email.body===null))throw new Error('The published Contract email source is unavailable.');
 const runtimeEmails=execution?emails.map(email=>({revision:email.revision,retired:email.retired,template:{id:email.id,module:'contract_staff' as const,name:email.name,active:email.active,subject:email.subject!,body:email.body!,cc:email.cc,...(email.bodyDoc?{bodyDoc:email.bodyDoc}:{})}})):[];
 return {view:caseRow.view,refs,definitions,runtimeEmails,setupRevision:setup.revision,db};
}

/** Private worker reuse; the native context adapter independently checks the held kernel event capability. */
export function readContractSharedExecutionInputs(owner:postgres.ReservedSql,ctx:SessionContext,caseId:string){
 return readPreviewInputs(owner,ctx,caseId,true);
}

export const contractPreviewJobHandler:BulkJobHandler<never>={
 kind:'contract_preview',mode:'per-step',finalizeOwner:true,
 async prepare(ctx,job){
  const input=inputSchema.parse(job.input);
  const allowed=await withScopedLifecycleTenant(ctx,async tx=>{
   const [row]=await tx.execute<{ok:boolean}>(sql`select app.contract_shared_preview_check(${input.previewId}::uuid,${job.id}::uuid) as ok`);return row?.ok===true;
  });
  return allowed?{steps:[],plan:input}:{refused:'The Contract case or preview permission changed. Reload before previewing.'};
 },
 async applyStepTx(){throw new Error('A decision preview has no effect steps.');},
 async finalize(ctx,job,unit){
  await unit.verifySeal();
  const {previewId}=inputSchema.parse(job.input);
  const summary=await unit.ownerTx!(async owner=>{
   await owner`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id','',true)`;
   const [request]=await owner<{case_id:string;decision:unknown}[]>`select case_id,decision from contract_shared_preview where tenant_id=${ctx.tenantId}::uuid and id=${previewId}::uuid and job_id=${job.id}::uuid`;
   if(!request)throw new Error('The protected Contract preview is unavailable.');
   const inputs=await readPreviewInputs(owner,ctx,request.case_id);
   let plan:ContractDecisionPlan;
   const parsed=contractProposedDecisionSchema.safeParse(request.decision);
   if(!parsed.success)plan=emptyPlan('Check the proposed decision, dates and agreed pay.');
   else if(inputs.view.source.nativeIntakeRequired)plan=emptyPlan('Complete the native post-retirement Contract intake with its authorised owner before proposing a decision.');
   else if(!inputs.view.sourceCurrent||inputs.view.source.ended||inputs.view.source.periodRevision!==inputs.view.flow!.period.sourceRevision)plan=emptyPlan('The Personnel period changed or employment ended. Reconcile it before submitting.');
   else if(parsed.data.kind!=='end'&&inputs.view.source.sourceIssue)plan=emptyPlan('Verify the native Payroll pay basis and currency before proposing new Contract terms.');
   else{
    const decision=parsed.data;
    try{
     const cents=decision.salaryCents===null?null:BigInt(decision.salaryCents);
     const canonical=validateContractFlowDecision(inputs.view.flow!,{kind:decision.kind,startOn:decision.startOn??undefined,endOn:decision.endOn??undefined,months:decision.months??undefined,payChanges:decision.payChanges,basicSalary:cents===null?undefined:`${cents/BigInt(100)}.${String(cents%BigInt(100)).padStart(2,'0')}`,reason:decision.reason,endReason:decision.endReason??undefined});
     if(Object.entries(decision).some(([key,value])=>canonical[key as keyof typeof canonical]!==value))plan=emptyPlan('Check the proposed decision and authoritative dates.');
     else plan=buildContractDecisionPlan({context:contractSharedAutomationContext(inputs.view,inputs.refs),decision:canonical,definitions:inputs.definitions,today:todayInKualaLumpur()});
    }catch(error){if(error instanceof Error&&error.name==='ContractManagementError')plan=emptyPlan(error.message);else throw error;}
   }
   await inputs.db.execute(sql`select app.contract_shared_preview_finish(${previewId}::uuid,${job.id}::uuid,${inputs.setupRevision},${JSON.stringify(plan)}::text::jsonb)`);
   return {previewId,blockers:plan.blockers.length,workflows:plan.workflows.length};
  });
  return {result:summary};
 },
 quietNotice:()=>true,
 async describeFailure(){return {error:'The Contract preview could not be prepared. Reload the case and try again.'};},
};
