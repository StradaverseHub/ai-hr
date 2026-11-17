/** Fixed native morning jobs: truthful system actor, bounded source units and the existing OneHR queue. */
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {BulkJobHandler,BulkJobDiscardUnit} from './bulk-job-worker';
import type {BulkJobRow} from './bulk-job';
import {reservedSqlExecutor} from '../db/sql-executor';
import {advanceContractSharedAutomationOwner} from './contract-shared-automation-job';
import {queueAutomationEmailTx} from './automation-email-delivery';
import {decideAutomationRuns,type AutomationWorkflow} from '../packs/automation/service';
import {CONTRACT_AUTOMATION_CATALOGUE} from '../lib/automation/catalogues/contracts';
import type {ContractFlow} from '../lib/contract-case-flow';
const progress=z.object({phase:z.enum(['periods','digest']),after:z.uuid().nullable(),activeCase:z.uuid().nullable(),workflowAfter:z.uuid().nullable(),company:z.uuid().nullable(),companyAfter:z.uuid().nullable(),digestAfter:z.uuid().nullable(),recipientAfter:z.uuid().nullable().default(null)});
const initial=()=>({phase:'periods' as const,after:null,activeCase:null,workflowAfter:null,company:null,companyAfter:null,digestAfter:null,recipientAfter:null});
const forbidden=async():Promise<never>=>{throw new Error('This fixed system kind never captures a human or uses application-role steps.');};
export const contractScheduleJobHandler:BulkJobHandler<never>={kind:'contract_schedule',mode:'per-step',finalizeOwner:true,prepare:forbidden,applyStepTx:forbidden,quietNotice:()=>true,
 systemOwner:{async prepare(job,unit){z.object({day:z.iso.date()}).strict().parse(job.input);await unit.ownerTx(async()=>undefined);return initial();},async finalize(job,unit){return scheduleUnit(job,unit);}}
};
export const contractScheduledAutomationJobHandler:BulkJobHandler<never>={kind:'contract_scheduled_automation',mode:'per-step',finalizeOwner:true,prepare:forbidden,applyStepTx:forbidden,quietNotice:()=>true,
 systemOwner:{async prepare(job,unit){z.object({eventId:z.uuid()}).strict().parse(job.input);await unit.ownerTx(async()=>undefined);return {activeEventId:null,workflowCursor:0};},async finalize(job,unit){await unit.verifySeal();const done=await unit.ownerTx(owner=>advanceContractSharedAutomationOwner(owner,{tenantId:job.tenant_id,userId:undefined,roles:[]},job,unit,true));return done?{result:{processed:true,actorType:'system'}}:'more';}}
};
async function scheduleUnit(job:BulkJobRow,unit:BulkJobDiscardUnit){
 await unit.verifySeal();const plan=progress.parse(job.plan),day=z.object({day:z.iso.date()}).parse(job.input).day;
 return unit.ownerTx(async owner=>{
  const db=reservedSqlExecutor(owner);
  if(plan.phase==='periods'){
   if(!plan.activeCase){
    const [candidate]=await db.execute<{id:string}>(sql`select e.id from employment e join company c on c.tenant_id=e.tenant_id and c.id=e.company_id and c.archived_at is null
     join contract_shared_settings settings on settings.tenant_id=e.tenant_id and settings.company_id=e.company_id
     where e.tenant_id=${job.tenant_id}::uuid and (${plan.after}::uuid is null or e.id>${plan.after}::uuid)
     and e.voided_at is null and e.blacklisted_at is null and e.hired_on<=${day}::date and (least(e.terminated_on,e.resignation_date,e.last_working_date) is null or least(e.terminated_on,e.resignation_date,e.last_working_date)>${day}::date)
     and exists(select 1 from assignment a where a.tenant_id=e.tenant_id and a.employment_id=e.id and a.superseded_at is null and a.valid_from<=${day}::date and (a.valid_to is null or a.valid_to>${day}::date) and a.employment_type='contract')
     and exists(select 1 from tenant_module module where module.tenant_id=e.tenant_id and module.module_code='lifecycle' and module.status in('active','trial') and (module.company_id is null or module.company_id=e.company_id) and (module.expires_at is null or module.expires_at>now())) order by e.id limit 1`);
    if(!candidate){await unit.set(owner,{planMerge:{phase:'digest',after:null}});return 'more' as const;}
    const [opened]=await db.execute<{value:{caseId?:string;legacy?:boolean;held?:boolean}}>(sql`select app.contract_shared_system_period_try_open(${candidate.id}::uuid) as value`);
    await unit.set(owner,{planMerge:{after:candidate.id,activeCase:opened.value.caseId&&!opened.value.legacy?opened.value.caseId:null,workflowAfter:null},countersAdd:{periodsChecked:1,...(opened.value.held?{periodsHeld:1}:{})}});return 'more' as const;
   }
   const [source]=await db.execute<{data:ContractFlow;businessGroup:string}>(sql`select f.data,coalesce(company.parent_company_id,company.id)::text as "businessGroup" from contract_shared_case f join contract_case c on c.tenant_id=f.tenant_id and c.id=f.case_id join company on company.tenant_id=c.tenant_id and company.id=c.company_id where f.tenant_id=${job.tenant_id}::uuid and f.case_id=${plan.activeCase}::uuid`);
   if(!source){await unit.set(owner,{planMerge:{activeCase:null,workflowAfter:null}});return 'more' as const;}
   const definitions=await db.execute<{id:string;revision:number;status:'live';required:boolean;definition:AutomationWorkflow}>(sql`select workflow_id as id,revision,status,required,definition from(select distinct on(workflow_id) workflow_id,revision,status,required,definition from automation_workflow_version where tenant_id=${job.tenant_id}::uuid and module='contract_staff' order by workflow_id,revision desc) latest where status='live' and definition->'trigger'->>'event' in('beforeContractEnd','afterContractEnd') and (${plan.workflowAfter}::uuid is null or workflow_id>${plan.workflowAfter}::uuid) order by workflow_id limit 25`);
   for(const definition of definitions){
    const workflow:AutomationWorkflow={...definition.definition,id:definition.id,module:'contract_staff',status:'live' as const,required:definition.required};
    const decision=source.data.decision;const facts:Record<string,string|null>={businessGroup:source.businessGroup,decision:decision?{renew:'Renew',convert:'Convert to permanent',end:'End'}[decision.kind]:null,endReason:decision?.endReason??null,declineReason:source.data.declined?.reason??null,payChanges:decision?(decision.payChanges?'Yes':'No'):null,termMonths:decision?.months==null?null:String(decision.months),daysToEnd:String(Math.round((Date.parse(source.data.period.endOn+'T00:00:00Z')-Date.parse(day+'T00:00:00Z'))/86400000))};
    const event={trigger:workflow.trigger.event,subjectId:plan.activeCase,occurrence:'period:'+source.data.period.id,today:day,read:(field:string)=>facts[field]??null,
     anchor:()=>source.data.period.endOn,skipReason:(kind:string)=>kind==='decided'&&source.data.decision?'A decision has been submitted.':kind==='caseClosed'&&['renewed','converted','offboarding','superseded'].includes(source.data.stage)?'The case is closed.':null};
    const assessment=decideAutomationRuns(CONTRACT_AUTOMATION_CATALOGUE,[{workflow,revision:definition.revision}],event).decisions[0];
    if(assessment?.outcome==='run'||assessment?.outcome==='skip'){
     const occurrence='workflow:'+definition.id+':period:'+source.data.period.id+':'+(workflow.trigger.repeat?day:assessment.dueDate??'no-date');
     await db.execute(sql`select app.contract_shared_system_event(${plan.activeCase}::uuid,${workflow.trigger.event},${occurrence},${JSON.stringify([{workflowId:definition.id,revision:definition.revision}])}::jsonb)`);
    }
   }
   await unit.set(owner,{planMerge:definitions.length===25?{workflowAfter:definitions.at(-1)!.id}:{activeCase:null,workflowAfter:null}});return 'more' as const;
  }
  if(!plan.company){
   const [company]=await db.execute<{id:string}>(sql`select company.id from company join contract_shared_settings settings on settings.tenant_id=company.tenant_id and settings.company_id=company.id where company.tenant_id=${job.tenant_id}::uuid and company.archived_at is null and (${plan.companyAfter}::uuid is null or company.id>${plan.companyAfter}::uuid) and exists(select 1 from tenant_module module where module.tenant_id=company.tenant_id and module.module_code='lifecycle' and module.status in('active','trial') and (module.company_id is null or module.company_id=company.id) and (module.expires_at is null or module.expires_at>now())) order by company.id limit 1`);
   if(!company)return {result:{processed:true,day,actorType:'system'}};
   await unit.set(owner,{planMerge:{company:company.id,companyAfter:company.id,digestAfter:null,recipientAfter:null}});return 'more' as const;
  }
  const rows=await db.execute<{caseId:string;name:string;flags:string[];stalledDays:number|null;personId:string}>(sql`select * from app.contract_shared_digest_cases(${plan.company}::uuid,${plan.digestAfter}::uuid)`);
  if(!rows.length){await unit.set(owner,{planMerge:{company:null,digestAfter:null}});return 'more' as const;}
  const recipients=await db.execute<{id:string}>(sql`select app.contract_shared_digest_recipients(${job.tenant_id}::uuid,${plan.company}::uuid,${plan.recipientAfter}::uuid) as id`);
  const key=`digest:${day}:${plan.company}:${plan.digestAfter??'start'}:to:${plan.recipientAfter??'start'}`,first=rows[0],context={systemJobId:job.id,digestKey:key,digestCompanyId:plan.company,employmentId:null as string|null,cases:rows.map(row=>({caseId:row.caseId,personId:row.personId}))};
  const [employment]=await db.execute<{employmentId:string}>(sql`select employment_id as "employmentId" from contract_case where tenant_id=${job.tenant_id}::uuid and id=${first.caseId}::uuid`);context.employmentId=employment?.employmentId??null;
  await db.execute(sql`insert into app.contract_system_digest(tenant_id,mail_key,job_id,company_id,case_id,source_date,context,recipient_ids) values(${job.tenant_id}::uuid,${key},${job.id}::uuid,${plan.company}::uuid,${first.caseId}::uuid,${day}::date,${JSON.stringify(context)}::jsonb,${'{'+recipients.map(row=>row.id).join(',')+'}'}::uuid[]) on conflict(tenant_id,mail_key) do nothing`);
  if(recipients.length){
   const body='Contract cases needing attention on '+day+'\n\n'+rows.map(row=>row.name.slice(0,100)+' — '+[...row.flags.map(flag=>flag.replaceAll('_',' ')),...(row.stalledDays!==null?['Stalled '+row.stalledDays+' days']:[])].join('; ')).join('\n')+'\n\nOpen Contract Management to review these cases.\n{{case.link}}';
   await owner`select set_config('app.contract_digest',${key},true)`;
   await queueAutomationEmailTx(db,{module:'contract_staff',subjectId:first.caseId,key,to:recipients.map(row=>row.id),cc:[],subject:'Daily Contract cases needing attention · '+day,body});
  }
  await unit.set(owner,{planMerge:recipients.length===100?{recipientAfter:recipients.at(-1)!.id}:{digestAfter:rows.at(-1)!.caseId,recipientAfter:null},countersAdd:{digestCases:recipients.length===100?0:rows.length,digestPages:recipients.length?1:0}});return 'more' as const;
 });
}
