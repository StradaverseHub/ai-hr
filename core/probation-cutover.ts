import {createHash} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {withScopedLifecycleTenant} from './module-gate';
import {assertModuleEnabled} from './entitlements';
import {workingDatesForSpan} from './leave';
import {internalConfig} from '../lib/internal-auth/config';
import {todayInKualaLumpur,addCalendarMonths} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {createProbationCase,advanceProbationWorkingDays,newProbationPart,probationDueDay,ProbationError,type ProbationCase,type ProbationPart} from '../lib/probation-model';
import {effectiveProbationSettings} from '../lib/probation-configuration';
import {probationCutoverDates,probationCutoverWorkflowMatches,probationIntakeCycleEnds,type ProbationCutoverOccurrence,type ProbationCutoverRecipient} from '../lib/probation-intake-model';
import {PROBATION_WORKFLOW_EVENTS,probationWorkflowIssues,renderProbationWords,type ProbationWorkflow} from '../lib/probation-workflow';
import type {ProbationPersonnel,ProbationSettings} from './probation';
import type {ProbationIntakeWorkspace,ProbationIntakeCandidate} from './probation-intake';
type PreservedCase=Pick<ProbationCase,'id'|'employmentId'|'revision'|'state'|'startOn'|'endOn'|'gradeAtStart'|'config'>&{
 source:ProbationPersonnel;workflowIds:string[];milestones:{kpiReminderOn:string;kpiOverdueOn:string};
 parts:(ProbationPart&{pending:ProbationCutoverRecipient[]})[];holders:ProbationCutoverRecipient[];
};
export type ProbationReactivationCase={id:string;employmentId:string;employeeName:string;revision:number;status:'preserved'|'held';reason:string|null};
export type ProbationCutoverPlan={companyId:string;module:'probation';environment:{configuredOrigin:string|null;verification:'configured_origin_only'};activationOn:string;historicalExcludedCount:number;mode:'initial'|'reactivation';reactivation:ProbationReactivationCase[];planComplete:boolean;exportTruncated:boolean;holds:string[];sourceSnapshot:unknown;cohort:ProbationIntakeCandidate[];imports:{employmentId:string;entryId:string;entryRevision:number;sourceDigest:string;record:ProbationCase;milestones:{kpiReminderOn:string;kpiOverdueOn:string};settingsId:string;formId:string;routeId:string}[];wouldFire:ProbationCutoverOccurrence[];excludedPast:ProbationCutoverOccurrence[];eventDriven:{workflowId:string;workflowName:string;event:string;condition:'requires_future_authoritative_transition'}[];noCatchup:{pastDatesExcluded:true;pendingStageRecheckedAtDelivery:true;overdueSummary:'once_per_activation_batch';requiresNamedOwnerApproval:true};sends:false};
const stableId=(key:string)=>{const raw=createHash('sha256').update(key).digest('hex');return `${raw.slice(0,8)}-${raw.slice(8,12)}-5${raw.slice(13,16)}-a${raw.slice(17,20)}-${raw.slice(20,32)}`;};
async function buildProbationCutoverTx(tx:Tx,ctx:SessionContext,companyId:string,activationOn=todayInKualaLumpur()):Promise<ProbationCutoverPlan>{
 const[workspace]=await tx.execute<{data:ProbationIntakeWorkspace}>(sql`select app.probation_intake_workspace(${companyId}::uuid) as data`),[native]=await tx.execute<{data:{reactivation:PreservedCase[];activation:{enabled:boolean;watermark:string|null;priorCutover:boolean}|null}}>(sql`select app.probation_cutover_snapshot(${companyId}::uuid) as data`);
 const configurations=await tx.execute<{id:string;kind:string;data:ProbationSettings&{targetGrades?:string[]};version:number}>(sql`select id,kind,data,version from probation_configuration where tenant_id=${ctx.tenantId}::uuid and company_id=${companyId}::uuid and state='published' order by version desc,id`);
 const workflows=await tx.execute<{id:string;data:ProbationWorkflow}>(sql`select distinct on(definition_key) id,data from probation_builder_definition where tenant_id=${ctx.tenantId}::uuid and company_id=${companyId}::uuid and kind='workflow' and state='published' order by definition_key,version desc`);
 const templates=await tx.execute<{outcome:string}>(sql`select distinct data->>'outcome' as outcome from probation_builder_definition where tenant_id=${ctx.tenantId}::uuid and company_id=${companyId}::uuid and kind='template' and state='published' and data->>'unfinished'='false'`);
 const mode=native.data.activation?.priorCutover?'reactivation':'initial';
 const reactivation:ProbationReactivationCase[]=[];
 const holds:string[]=[];if(native.data.activation?.enabled)holds.push('Pause this company before preparing a new activation.');if(native.data.reactivation.length>500)holds.push('The preserved probation cohort exceeds the complete rehearsal bound.');if(workspace.data.truncated)holds.push('The intake cohort exceeds the complete 500-employment rehearsal bound. Split the authorised company cohort before approval.');
 for(const event of PROBATION_WORKFLOW_EVENTS)if(!workflows.some(w=>w.data.trigger.event===event))holds.push(`Publish the required ${event} probation workflow before activation.`);
 for(const outcome of['confirm','extend','not_confirm'])if(!templates.some(t=>t.outcome===outcome))holds.push(`Publish the approved ${outcome} letter wording before activation.`);
 for(const workflow of workflows)for(const issue of probationWorkflowIssues(workflow.data))holds.push(`${workflow.data.name}: ${issue}`);
 const summaryWorkflows=workflows.filter(w=>w.data.trigger.event==='overdue_summary'&&Object.keys(w.data.conditions).length===0);if(summaryWorkflows.length!==1)holds.push('Publish exactly one global PBP overdue-summary workflow for this activation batch.');else if(summaryWorkflows[0].data.steps.some(step=>/[{][{]\s*(employeeName|employeeCode|part|endOn)\s*[}][}]/.test(step.subject+' '+step.body)))holds.push('The cohort summary must use company/due-date wording rather than a single employee or review.');
 const imports:ProbationCutoverPlan['imports']=[],wouldFire:ProbationCutoverOccurrence[]=[],excludedPast:ProbationCutoverOccurrence[]=[];
 let exportBytes=0,exportTruncated=false;
 const collect=(occurrence:ProbationCutoverOccurrence)=>{if(exportTruncated)return;const bytes=Buffer.byteLength(JSON.stringify(occurrence),'utf8');if(wouldFire.length+excludedPast.length>=30000||exportBytes+bytes>8*1024*1024){exportTruncated=true;holds.push('The complete would-fire export exceeds the reviewed batch size. Narrow the authorised cohort and prepare a complete fresh export; this partial rehearsal cannot be approved.');return;}exportBytes+=bytes;(occurrence.excludedPast?excludedPast:wouldFire).push(occurrence);};

 for(const candidate of workspace.data.candidates){
  if(candidate.classification==='excluded'||candidate.classification==='already_admitted')continue;
  const source=candidate.source,entry=candidate.disposition;if(candidate.classification!=='ready'||!entry){holds.push(`${source.employeeName}: ${candidate.issues.join(' ')||'Review the intake disposition.'}`);continue;}
  const settings=configurations.find(v=>v.kind==='settings'),form=configurations.find(v=>v.kind==='form'&&(v.data.targetGrades??Array.from({length:12},(_,i)=>String(i+12))).includes(source.grade)),route=configurations.find(v=>v.kind==='route');
  if(!settings||!form||!route){holds.push(`${source.employeeName}: publish matching settings, evaluation form and signing route.`);continue;}
  try{
   const baseEnd=source.originalEndOn??source.endOn,exactMonths=baseEnd?[...Array(120)].map((_,i)=>i+1).find(n=>addDaysIso(addCalendarMonths(source.startOn,n),-1)===baseEnd):undefined;
   const config=effectiveProbationSettings(settings.data,source,source.probationMonths??exactMonths??(source.unknownPeriod?(source.grade==='H'?3:settings.data.defaultMonths):null));
   const end=source.endOn??addDaysIso(addCalendarMonths(source.startOn,source.grade==='H'?3:config.defaultMonths),-1);if((Date.parse(end)-Date.parse(source.startOn))/86400000>12*366)throw new ProbationError('invalid','Validate the canonical probation period before planning the working calendar.');
   const calendar=new Set(await workingDatesForSpan(tx,source.employmentId,addDaysIso(source.startOn,-366),addCalendarMonths(end,12)));
   let index=0;const record=createProbationCase({id:stableId(`${ctx.tenantId}:${source.employmentId}:case`),employmentId:source.employmentId,companyId,sourceKey:'employment:'+source.employmentId,startOn:source.startOn,endOn:baseEnd,months:source.unknownPeriod?null:source.probationMonths??exactMonths??1,grade:source.grade,explicitNoProbation:source.explicitNoProbation,unknownLength:!source.unknownPeriod&&source.probationMonths===null&&exactMonths===undefined,config,nextId:()=>stableId(`${ctx.tenantId}:${source.employmentId}:part:${++index}`),isWorking:day=>calendar.has(day)});
   if(!record)throw new ProbationError('invalid','This source is no longer eligible.');
   const ends=probationIntakeCycleEnds(source,entry.extensionEventIds??[],record.endOn),originalFinal=record.parts.find(p=>p.type===3)!;record.extensionCount=ends.length-1;record.endOn=ends[ends.length-1];
   if(record.extensionCount!==(entry.extensionCount??0))throw new ProbationError('invalid','Review the exact canonical extension sources and the current cycle count.');
   record.parts=[...record.parts.filter(p=>p.type!==3),...ends.map((periodEnd,cycle)=>newProbationPart(cycle===0?originalFinal.id:stableId(`${ctx.tenantId}:${source.employmentId}:extension:${cycle}`),3,cycle,probationDueDay(periodEnd,day=>calendar.has(day)),config.issueLeadDays))];
   if(entry.parts.length!==record.parts.length||record.parts.some(part=>!entry.parts.some(p=>p.type===part.type&&p.cycle===part.cycle)))throw new ProbationError('invalid','Map exactly the required Parts and cycles for the canonical review plan.');
   for(const part of record.parts){const stage=entry.parts.find(p=>p.type===part.type&&p.cycle===part.cycle)!;if(stage.status==='completed_offline'){part.state='completed_offline';part.offlinePdfId=stage.evidenceId;}else if(part.issueOn<activationOn)part.state='issued';}
   record.kpiAcknowledged=record.parts.some(p=>p.type===1&&p.state==='completed_offline');
   const milestones={kpiReminderOn:advanceProbationWorkingDays(record.startOn,config.kpiReminderWorkingDay,day=>calendar.has(day)),kpiOverdueOn:advanceProbationWorkingDays(record.parts.find(p=>p.type===1)!.dueOn,1,day=>calendar.has(day))};
   imports.push({employmentId:source.employmentId,entryId:entry.id,entryRevision:entry.revision,sourceDigest:candidate.sourceDigest,record,milestones,settingsId:settings.id,formId:form.id,routeId:route.id});
   for(const date of probationCutoverDates(record,milestones))for(const workflow of workflows){if(workflow.data.trigger.event!==date.event||!probationCutoverWorkflowMatches(workflow.data,source,date.part.type))continue;
    for(const step of workflow.data.steps){if(exportTruncated)continue;const pending=date.part.type===1?['lm']:config.lmWaitsForEmployee?['employee']:['employee','lm'];const recipients=candidate.holders.filter(h=>pending.includes(h.role)&&step.to.includes(h.role as typeof step.to[number])).map(h=>({role:h.role,userId:h.userId,name:h.name} satisfies ProbationCutoverRecipient));if(!recipients.length)continue;
     const words={employeeName:source.employeeName,employeeCode:source.employeeCode??'',companyName:source.companyName,part:String(date.part.type),dueOn:date.part.dueOn,endOn:record.endOn};
     const occurrence:ProbationCutoverOccurrence={module:'probation',workflowId:workflow.id,workflowName:workflow.data.name,stepId:step.id,caseId:record.id,employmentId:source.employmentId,partId:date.part.id,event:date.event,dueOn:date.dueOn,recipients,subject:renderProbationWords(step.subject,words),body:renderProbationWords(step.body,words),conditional:true,excludedPast:date.dueOn<activationOn};collect(occurrence);
    }
   }
  }catch(error){holds.push(`${source.employeeName}: ${error instanceof ProbationError?error.message:'The canonical working calendar or source could not be resolved. Review the record before preparing a fresh export.'}`);}
 }
 const preservedWorkflows=await tx.execute<{id:string;data:ProbationWorkflow}>(sql`select id,data from probation_builder_definition where tenant_id=${ctx.tenantId}::uuid and company_id=${companyId}::uuid and kind='workflow' and state='published' order by id`);
 for(const preserved of native.data.reactivation.slice(0,500)){
  const {source,parts}=preserved;
  const sourceChanged=source.startOn!==preserved.startOn||(source.endOn!==null&&source.endOn!==preserved.endOn);
  const reason=source.resignationOn||source.terminatedOn||source.confirmationOn?'A Personnel decision requires reconciliation.':sourceChanged?'Canonical Personnel dates require reconciliation.':!preserved.milestones?.kpiReminderOn||!preserved.milestones?.kpiOverdueOn?'The preserved working-calendar milestones require reconciliation.':null;
  reactivation.push({id:preserved.id,employmentId:preserved.employmentId,employeeName:source.employeeName,revision:preserved.revision,status:reason?'held':'preserved',reason});
  if(reason){holds.push(`${source.employeeName}: ${reason}`);continue;}
  for(const date of probationCutoverDates(preserved,preserved.milestones)){
   if(date.dueOn<date.part.issueOn)continue;
   const part=parts.find(candidate=>candidate.id===date.part.id)!;
   const expectedRoles=part.type===1?['lm']:preserved.config.lmWaitsForEmployee?['employee']:['employee','lm'];
   const pending=part.state==='not_issued'?preserved.holders.filter(h=>expectedRoles.includes(h.role)):part.pending;
   for(const workflow of preservedWorkflows){
    if(!preserved.workflowIds.includes(workflow.id)||workflow.data.trigger.event!==date.event||!probationCutoverWorkflowMatches(workflow.data,{...source,grade:preserved.gradeAtStart},part.type))continue;
    for(const step of workflow.data.steps){
     const recipients=pending.filter(h=>step.to.some(role=>role===h.role));
     if(!recipients.length)continue;
     const words={employeeName:source.employeeName,employeeCode:source.employeeCode??'',companyName:source.companyName,part:String(part.type),dueOn:part.dueOn,endOn:preserved.endOn};
     collect({module:'probation',workflowId:workflow.id,workflowName:workflow.data.name,stepId:step.id,caseId:preserved.id,employmentId:preserved.employmentId,partId:part.id,event:date.event,dueOn:date.dueOn,recipients,subject:renderProbationWords(step.subject,words),body:renderProbationWords(step.body,words),conditional:true,excludedPast:date.dueOn<activationOn});
    }
   }
  }
 }
 const summaryWorkflow=summaryWorkflows.length===1?summaryWorkflows[0]:undefined,summaryStep=summaryWorkflow?.data.steps.filter(step=>step.to.includes('pbp')).sort((a,b)=>a.id.localeCompare(b.id))[0];
 if(summaryWorkflow&&!summaryStep)holds.push('The global overdue summary must include a scoped PBP recipient.');
 if(summaryWorkflow&&summaryStep){
  const cohort=[...imports.map(imported=>({id:imported.record.id,source:workspace.data.candidates.find(c=>c.source.employmentId===imported.employmentId)!.source,holders:workspace.data.candidates.find(c=>c.source.employmentId===imported.employmentId)!.holders,parts:imported.record.parts})),...native.data.reactivation.filter(c=>reactivation.some(r=>r.id===c.id&&r.status==='preserved'))];
  const summarized=new Set<string>();
  for(const candidate of cohort.sort((a,b)=>a.id.localeCompare(b.id))){
   if(!candidate.parts.some(part=>!['locked','completed_offline','cancelled'].includes(part.state)&&part.dueOn<activationOn))continue;
   const pbp=candidate.holders.find(h=>h.role==='pbp');if(!pbp||summarized.has(pbp.userId))continue;
   summarized.add(pbp.userId);
   const words={companyName:candidate.source.companyName,dueOn:activationOn,employeeName:'',employeeCode:'',part:'',endOn:''};
   collect({module:'probation',workflowId:summaryWorkflow.id,workflowName:summaryWorkflow.data.name,stepId:summaryStep.id,caseId:candidate.id,employmentId:candidate.source.employmentId,partId:null,event:'overdue_summary',dueOn:activationOn,recipients:[pbp],subject:renderProbationWords(summaryStep.subject,words),body:renderProbationWords(summaryStep.body,words),conditional:true,excludedPast:false});
  }
 }
 if(wouldFire.length+excludedPast.length>30000)holds.push('The complete would-fire export exceeds the reviewed 30,000-occurrence batch bound; split the cohort before activation.');
 let origin:string|null=null;try{origin=internalConfig().origin;}catch{holds.push('The installation origin is unresolved; deployment owner verification is required.');}
 return{companyId,module:'probation',environment:{configuredOrigin:origin,verification:'configured_origin_only'},activationOn,mode,reactivation,historicalExcludedCount:workspace.data.excludedCount,planComplete:holds.length===0,exportTruncated,holds,sourceSnapshot:native.data,cohort:workspace.data.candidates,imports,wouldFire,excludedPast,eventDriven:workflows.filter(w=>!['kpi_assigned','kpi_reminder','kpi_overdue','review_issued','review_reminder','review_due'].includes(w.data.trigger.event)).map(w=>({workflowId:w.id,workflowName:w.data.name,event:w.data.trigger.event,condition:'requires_future_authoritative_transition'})),noCatchup:{pastDatesExcluded:true,pendingStageRecheckedAtDelivery:true,overdueSummary:'once_per_activation_batch',requiresNamedOwnerApproval:true},sends:false};
}
export function prepareProbationCutoverPlan(ctx:SessionContext,companyId:string){return withScopedLifecycleTenant(ctx,async tx=>{assertModuleEnabled(ctx,'lifecycle',companyId);const plan=await buildProbationCutoverTx(tx,ctx,companyId);const[row]=await tx.execute<{data:{id:string;digest:string;snapshot:ProbationCutoverPlan;sends:false}}>(sql`select app.probation_prepare_cutover_plan(${companyId}::uuid,${JSON.stringify(plan)}::jsonb) as data`);return row.data;});}

/** This is an installation-owner operation, deliberately absent from ordinary application actions. */
export async function activatePreparedProbationCutover(ctx:SessionContext,connection:import('./notice-projection').NotificationSweepConnection,input:{id:string;digest:string;installationReceipt:{origin:string;reference:string}}){
 if(ctx.userId)throw new ProbationError('forbidden','The verified no-login installation owner must execute cutover.');ctx={...ctx,roles:[],grants:undefined};
 return connection.withTenant(ctx,async tx=>{
  const[authority]=await tx.execute<{ok:boolean}>(sql`select app.probation_storage_runner() as ok`);if(!authority?.ok)throw new ProbationError('forbidden','The actual database owner connection is required.');
  await tx.execute(sql`select app.probation_write_lock()`);
  const[batch]=await tx.execute<{companyId:string;digest:string;data:ProbationCutoverPlan;approvedBy:string|null;appliedAt:string|null;receipt:unknown}>(sql`select company_id as "companyId",digest,data,approved_by as "approvedBy",applied_at::text as "appliedAt",owner_receipt as receipt from probation_cutover where id=${input.id}::uuid and tenant_id=${ctx.tenantId}::uuid for update`);
  if(!batch||batch.digest!==input.digest||!batch.approvedBy)throw new ProbationError('conflict','The exact fresh named cutover approval is required.');if(batch.appliedAt)return{alreadyApplied:true,receipt:batch.receipt};
  if(!batch.data.planComplete||batch.data.holds.length||!batch.data.environment.configuredOrigin||input.installationReceipt.origin!==batch.data.environment.configuredOrigin||input.installationReceipt.reference.trim().length<3)throw new ProbationError('invalid','Resolve every held source and verify the configured installation before cutover.');assertModuleEnabled(ctx,'lifecycle',batch.companyId);
  const current=await buildProbationCutoverTx(tx,ctx,batch.companyId);const material=(plan:ProbationCutoverPlan)=>({companyId:plan.companyId,activationOn:plan.activationOn,mode:plan.mode,reactivation:plan.reactivation,historicalExcludedCount:plan.historicalExcludedCount,environment:plan.environment,holds:plan.holds,planComplete:plan.planComplete,exportTruncated:plan.exportTruncated,sourceSnapshot:plan.sourceSnapshot,imports:plan.imports,wouldFire:plan.wouldFire,excludedPast:plan.excludedPast,eventDriven:plan.eventDriven});
  const[same]=await tx.execute<{ok:boolean}>(sql`select ${JSON.stringify(material(current))}::jsonb is not distinct from ${JSON.stringify(material(batch.data))}::jsonb as ok`);if(!same.ok)throw new ProbationError('conflict','The canonical cohort, working calendars, message plan or installation changed after approval. Prepare and approve a fresh export.');
  await tx.execute(sql`select app.probation_activate_cutover(${input.id}::uuid,${current.activationOn}::date)`);
  for(const imported of current.imports){const record={...imported.record,milestones:imported.milestones,cutoverBatchId:input.id};const[row]=await tx.execute<{id:string}>(sql`select app.probation_admit(${JSON.stringify(record)}::jsonb,${JSON.stringify(imported.record.parts)}::jsonb,${imported.settingsId}::uuid,${imported.formId}::uuid,${imported.routeId}::uuid,'Exact named approved existing-probation cutover') as id`);await tx.execute(sql`select app.probation_apply_intake_stage(${input.id}::uuid,${imported.entryId}::uuid,${row.id}::uuid)`);}
  const[receipt]=await tx.execute<{data:unknown}>(sql`select app.probation_finalize_cutover(${input.id}::uuid,${JSON.stringify(input.installationReceipt)}::jsonb) as data`);return{alreadyApplied:false,receipt:receipt.data};
 });
}
export function requestProbationLegacyReconciliation(ctx:SessionContext,input:{caseId:string;revision:number;reason:string}){return withScopedLifecycleTenant(ctx,async tx=>{const[row]=await tx.execute<{id:string}>(sql`select app.probation_request_legacy_reconciliation(${input.caseId}::uuid,${input.revision},${input.reason}) as id`);return row.id;});}
export function approveProbationLegacyReconciliation(ctx:SessionContext,input:{id:string;reason:string}){return withScopedLifecycleTenant(ctx,tx=>tx.execute(sql`select app.probation_approve_legacy_reconciliation(${input.id}::uuid,${input.reason})`));}
export function applyProbationLegacyReconciliation(ctx:SessionContext,connection:import('./notice-projection').NotificationSweepConnection,id:string){if(ctx.userId)throw new ProbationError('forbidden','Verified no-login reconciliation owner required.');return connection.withTenant({...ctx,roles:[],grants:undefined},tx=>tx.execute(sql`select app.probation_apply_legacy_reconciliation(${id}::uuid)`));}

/** Pause dispatch for one company while preserving its cases, ownership and receipts. */
export function pauseProbationCompany(ctx:SessionContext,connection:import('./notice-projection').NotificationSweepConnection,input:{companyId:string;receipt:string}){
 if(ctx.userId)throw new ProbationError('forbidden','The verified no-login installation owner must execute rollback.');
 return connection.withTenant({...ctx,roles:[],grants:undefined},async tx=>{
  const [result]=await tx.execute<{paused:boolean}>(sql`select app.probation_pause_company(${input.companyId}::uuid,${input.receipt}) as paused`);
  return result.paused;
 });
}
