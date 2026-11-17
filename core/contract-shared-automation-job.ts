/** Contract events use the existing sealed kernel and shared runtime. Each finalize unit handles one workflow. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {BulkJobHandler,BulkJobUnit} from './bulk-job-worker';
import type {BulkJobRow} from './bulk-job';
import type {SessionContext} from '../db/client';
import type postgres from 'postgres';
import {withScopedLifecycleTenant} from './module-gate';
import {reservedSqlExecutor} from '../db/sql-executor';
import {readContractSharedExecutionInputs} from './contract-shared-preview-job';
import {contractSharedAutomationContext} from './contract-shared-context';
import {contractAutomationRead,contractAutomationPending} from '../lib/contract-automation-context';
import {queueAutomationEmailTx} from './automation-email-delivery';
import {activateContractSharedApproval,activateContractSharedLetter} from './contract-shared-signing';
import {activateContractSharedPosting} from './contract-shared-postings';
import {activateContractSharedOffboarding} from './contract-shared-ending';
import {contractSharedEmailExecutors} from './contract-shared-email';
import {CONTRACT_AUTOMATION_CATALOGUE} from '../lib/automation/catalogues/contracts';
import {runAutomationEvent,resumeAutomationRun,sqlAutomationRunStore,type AutomationExecutors,type AutomationRuntimeGuards,type AutomationRun} from '../packs/automation/service';
import {todayInKualaLumpur} from '../lib/hr-date';

const inputSchema=z.object({eventId:z.uuid()}).strict();
const progressSchema=z.object({activeEventId:z.uuid().nullable(),workflowCursor:z.number().int().min(0).max(200),mailAfter:z.uuid().nullable().optional()}).strict();
type Event={id:string;case_id:string;trigger_event:string;occurrence:string;decision_revision:number;workflow_versions:{workflowId:string;revision:number}[];data:Record<string,unknown>};
export const contractAutomationJobHandler:BulkJobHandler<never>={
 kind:'contract_automation',mode:'per-step',finalizeOwner:true,
 async prepare(ctx,job){
  const {eventId}=inputSchema.parse(job.input);
  const allowed=await withScopedLifecycleTenant(ctx,async tx=>{
   const [row]=await tx.execute<{ok:boolean}>(sql`select app.contract_shared_event_check(${eventId}::uuid,${job.id}::uuid) as ok`);return row?.ok===true;
  });
  return allowed?{steps:[],plan:{activeEventId:null,workflowCursor:0}}:{refused:'The accepted Contract event or its verified principal is no longer available.'};
 },
 async applyStepTx(){throw new Error('Contract automation advances through bounded shared-runtime finalize units.');},
 async finalize(ctx,job,unit){
  await unit.verifySeal();
  const {eventId:rootId}=inputSchema.parse(job.input),progress=progressSchema.parse(job.plan);
  const finished=await unit.ownerTx!(owner=>advanceContractSharedAutomationOwner(owner,ctx,job,unit));
  return finished?{result:{processed:true}}:'more';
 },
 quietNotice:()=>true,
 async describeFailure(){return {error:'The Contract workflow could not continue. People Ops can review the case and its current setup.'};},
};

/** Shared bounded runtime unit; the system wrapper supplies only truthful tenant context and its native capability. */
export async function advanceContractSharedAutomationOwner(owner:postgres.ReservedSql,ctx:SessionContext,job:BulkJobRow,unit:BulkJobUnit,system=false):Promise<boolean>{
   await owner`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id','',true),set_config('jit','off',true)`;
   const db=reservedSqlExecutor(owner);
   const [event]=await db.execute<Event>(sql`select id,case_id,trigger_event,occurrence,decision_revision,workflow_versions,data from contract_shared_event
    where tenant_id=${ctx.tenantId}::uuid and job_id=${job.id}::uuid and coalesce(root_event_id,id)=${rootId}::uuid and processed_at is null
    order by case when id=${rootId}::uuid then 0 else 1 end,created_at,id limit 1 for update`);
   if(!event)return true;
   await owner`select set_config('app.contract_event',${event.id},true)`;
   if(event.trigger_event==='approvalActionNeeded'){
    const after=progress.activeEventId===event.id?progress.mailAfter??null:null;
    const [row]=await db.execute<{page:{approvalId:string;revision:number;recipients:string[]}|null}>(sql`select app.contract_shared_approval_mail_page(${event.case_id}::uuid,${after}::uuid) as page`);
    if(row?.page?.recipients.length){
     await queueAutomationEmailTx(db,{module:'contract_staff',subjectId:event.case_id,key:`approval:${row.page.approvalId}:${row.page.revision}:${after??'start'}`,to:row.page.recipients,cc:[],subject:'Contract decision approval is waiting',body:'A Contract decision is waiting for your approval. Open your assigned approval to review the agreed terms.\n\n{{case.link}}'});
     await unit.set(owner,{planMerge:{activeEventId:event.id,workflowCursor:0,mailAfter:row.page.recipients.at(-1)!}});
    }else{
     if(event.trigger_event==='decisionSubmitted'&&!event.workflow_versions.length)await db.execute(sql`select app.contract_shared_execution_attention(${event.id}::uuid,'No live workflow matched this accepted decision. Publish a workflow or start one by hand.','no_workflow')`);
   await db.execute(sql`select app.contract_shared_event_finish(${event.id}::uuid,${job.id}::uuid)`);
     await unit.set(owner,{planMerge:{activeEventId:null,workflowCursor:0,mailAfter:null}});
    }
    return false;
   }
   const inputs=await readContractSharedExecutionInputs(owner,ctx,event.case_id),today=todayInKualaLumpur();
   const context=contractSharedAutomationContext(inputs.view,inputs.refs),workerCtx={...ctx,userId:undefined};
   const facts=event.data.conditionFacts;
   const read=contractAutomationRead(context,event.trigger_event,today,facts&&typeof facts==='object'&&!Array.isArray(facts)?facts as Record<string,unknown>:undefined),store=sqlAutomationRunStore(db);
   const letterId=typeof event.data.letterId==='string'&&z.uuid().safeParse(event.data.letterId).success?event.data.letterId:null;
   if(letterId)context.pending=contractAutomationPending(inputs.refs.documents.filter(document=>document.subjectType==='contract'&&document.subjectId===letterId));
   const [letter]=letterId?await db.execute<{name:string}>(sql`select data->'definition'->>'name' as name from contract_shared_letter where tenant_id=${ctx.tenantId}::uuid and case_id=${event.case_id}::uuid and id=${letterId}::uuid`):[];
   const letterValues=letter?{'letter.documentName':letter.name,'letter.signingStep':context.pending?.label??'','letter.sentBackBy':typeof event.data.sentBackBy==='string'?event.data.sentBackBy:'','letter.sentBackReason':typeof event.data.sentBackReason==='string'?event.data.sentBackReason:''}:undefined;
   const executors:AutomationExecutors={
    ...contractSharedEmailExecutors(db,{context,today,templates:inputs.runtimeEmails,letterValues}),
    requestApproval:step=>activateContractSharedApproval(db,workerCtx,{view:inputs.view,context,step,lastAssigned:inputs.definitions.lastAssigned,today}),
    generateDocument:step=>activateContractSharedLetter(db,workerCtx,{view:inputs.view,context,step,templates:inputs.definitions.documents,lastAssigned:inputs.definitions.lastAssigned,today}),
    createPosting:async step=>{
     const posting=await activateContractSharedPosting(db,{caseId:event.case_id,runId:step.run.id,stepId:step.step.id});
     return posting.skipped?{status:'skipped',reason:posting.reason??'This decision creates no Personnel posting.'}:{status:'done',message:`Personnel posting PP-${posting.number} is waiting for approval.`};
    },
    startOffboarding:step=>activateContractSharedOffboarding(db,workerCtx,step),
    notifyFailure:async(_run,reason)=>{
     await db.execute(sql`select app.contract_shared_execution_attention(${event.id}::uuid,${reason.slice(0,1000)})`);
    },
   };
   if(system){const refused=async()=>({status:'failed' as const,reason:'Morning automation can send reminders only. Employment decisions and effects require their authorized human workflow.'});executors.requestApproval=refused;executors.generateDocument=refused;executors.createPosting=refused;executors.startOffboarding=refused;}
   const guards:AutomationRuntimeGuards={
    emailTemplate:step=>{const template=inputs.definitions.emails.find(item=>item.id===step.params.emailTemplateId);return !template||template.retired?'missing':template.active?'active':'off';},
    documentTemplate:step=>inputs.definitions.documents.some(item=>item.template.id===step.params.letterTemplateId)?'available':'missing',
   };
   const waitingId=(event.trigger_event==='approvalsComplete'||event.trigger_event==='approvalRejected')?event.data.approvalId:event.trigger_event==='letterReleased'?event.data.letterId:null;
   if(typeof waitingId==='string'&&z.uuid().safeParse(waitingId).success){
    const [waiting]=await store.waiting('contract_staff',event.case_id,waitingId);
    if(waiting){
     let next:AutomationRun;
     if(event.trigger_event==='approvalRejected')next={...waiting,status:'failed',waitingFor:null,remaining:[],failure:'A decision approval was rejected. Remaining steps stopped.',log:[...waiting.log,{at:new Date().toISOString(),kind:'failed' as const,step:null,stepId:null,type:null,message:'A decision approval was rejected. Remaining steps stopped.'}].slice(-200)};
     else {
      // Step conditions belong to the event that started the pinned run, rather
      // than the later signing/approval event which happened to resume it.
      const [original]=await db.execute<{facts:Record<string,unknown>}>(sql`select data->'conditionFacts' as facts from contract_shared_event where tenant_id=${ctx.tenantId}::uuid and case_id=${event.case_id}::uuid and trigger_event=${waiting.trigger} and (${waiting.eventKey}=trigger_event||'|'||occurrence or starts_with(${waiting.eventKey},trigger_event||'|'||occurrence||'|')) order by length(occurrence) desc,created_at,id limit 1`);
      const resumedRead=contractAutomationRead(context,waiting.trigger,today,original?.facts);
      next=await resumeAutomationRun(waiting,waitingId,{executors,guards,read:resumedRead,now:()=>new Date().toISOString()});
     }
     await store.save(next,'waiting');
     return false;
    }
   }
   const cursor=progress.activeEventId===event.id?progress.workflowCursor:0;
   const reference=event.workflow_versions[cursor];
   if(reference){
    const definition=inputs.definitions.workflows.find(item=>item.workflow.id===reference.workflowId&&item.revision===reference.revision);
    if(!definition)throw new Error('The accepted Contract workflow revision is unavailable.');
    const result=await runAutomationEvent({catalogue:CONTRACT_AUTOMATION_CATALOGUE,workflows:[definition],event:{trigger:event.trigger_event,subjectId:event.case_id,occurrence:event.occurrence,today,read,
     anchor:anchor=>anchor==='contractEnd'?context.flow?.period.endOn??null:null,
     skipReason:kind=>kind==='decided'&&context.flow?.decision?'A decision has been submitted.':kind==='caseClosed'&&context.flow&&['renewed','converted','offboarding','superseded'].includes(context.flow.stage)?'The case is closed.':null},
     store,executors,guards,now:()=>new Date().toISOString(),newId:randomUUID});
    if(!result.matched&&event.trigger_event==='decisionSubmitted')await db.execute(sql`select app.contract_shared_execution_attention(${event.id}::uuid,'An accepted workflow no longer matches the case facts. Review the case before continuing.','no_workflow')`);
    await unit.set(owner,{planMerge:{activeEventId:event.id,workflowCursor:cursor+1}});
    return false;
   }
   if(event.trigger_event==='decisionSubmitted'&&!event.workflow_versions.length)await db.execute(sql`select app.contract_shared_execution_attention(${event.id}::uuid,'No live workflow matched this accepted decision. Publish a workflow or start one by hand.','no_workflow')`);
   await db.execute(sql`select app.contract_shared_event_finish(${event.id}::uuid,${job.id}::uuid)`);
   await unit.set(owner,{planMerge:{activeEventId:null,workflowCursor:0}});
   return false;
}
