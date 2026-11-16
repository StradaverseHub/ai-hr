/** Contract events use the existing sealed kernel and shared runtime. Each finalize unit handles one workflow. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {BulkJobHandler} from './bulk-job-worker';
import {withScopedLifecycleTenant} from './module-gate';
import {reservedSqlExecutor} from '../db/sql-executor';
import {readContractSharedExecutionInputs} from './contract-shared-preview-job';
import {contractSharedAutomationContext} from './contract-shared-context';
import {contractAutomationRead} from '../lib/contract-automation-context';
import {activateContractSharedApproval,activateContractSharedLetter} from './contract-shared-signing';
import {activateContractSharedOffboarding} from './contract-shared-ending';
import {CONTRACT_AUTOMATION_CATALOGUE} from '../lib/automation/catalogues/contracts';
import {runAutomationEvent,resumeAutomationRun,sqlAutomationRunStore,type AutomationExecutors,type AutomationRuntimeGuards,type AutomationRun} from '../packs/automation/service';
import {todayInKualaLumpur} from '../lib/hr-date';

const inputSchema=z.object({eventId:z.uuid()}).strict();
const progressSchema=z.object({activeEventId:z.uuid().nullable(),workflowCursor:z.number().int().min(0).max(200)}).strict();
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
  const finished=await unit.ownerTx!(async owner=>{
   await owner`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id','',true),set_config('jit','off',true)`;
   const db=reservedSqlExecutor(owner);
   const [event]=await db.execute<Event>(sql`select id,case_id,trigger_event,occurrence,decision_revision,workflow_versions,data from contract_shared_event
    where tenant_id=${ctx.tenantId}::uuid and job_id=${job.id}::uuid and coalesce(root_event_id,id)=${rootId}::uuid and processed_at is null
    order by case when id=${rootId}::uuid then 0 else 1 end,created_at,id limit 1 for update`);
   if(!event)return true;
   await owner`select set_config('app.contract_event',${event.id},true)`;
   const inputs=await readContractSharedExecutionInputs(owner,ctx,event.case_id),today=todayInKualaLumpur();
   const context=contractSharedAutomationContext(inputs.view,inputs.refs),workerCtx={...ctx,userId:undefined};
   const read=contractAutomationRead(context,event.trigger_event,today),store=sqlAutomationRunStore(db);
   const executors:AutomationExecutors={
    requestApproval:step=>activateContractSharedApproval(db,workerCtx,{view:inputs.view,context,step,lastAssigned:inputs.definitions.lastAssigned,today}),
    generateDocument:step=>activateContractSharedLetter(db,workerCtx,{view:inputs.view,context,step,templates:inputs.definitions.documents,lastAssigned:inputs.definitions.lastAssigned,today}),
    startOffboarding:step=>activateContractSharedOffboarding(db,workerCtx,step),
    notifyFailure:async(_run,reason)=>{
     await db.execute(sql`select app.contract_shared_execution_attention(${event.id}::uuid,${reason.slice(0,1000)})`);
    },
   };
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
     else next=await resumeAutomationRun(waiting,waitingId,{executors,guards,read,now:()=>new Date().toISOString()});
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
   await db.execute(sql`select app.contract_shared_event_finish(${event.id}::uuid,${job.id}::uuid)`);
   await unit.set(owner,{planMerge:{activeEventId:null,workflowCursor:0}});
   return false;
  });
  return finished?{result:{processed:true}}:'more';
 },
 quietNotice:()=>true,
 async describeFailure(){return {error:'The Contract workflow could not continue. People Ops can review the case and its current setup.'};},
};
