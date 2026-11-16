import type {ProbationOrganisationMapping} from '../lib/probation-organisation';
import {LeaveDependencyUnavailable} from './leave-dependency-lock';
import {validateProbationOfflinePdf} from '../lib/probation-offline-pdf';
import {effectiveProbationSettings} from '../lib/probation-configuration';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {isModuleEnabled,assertModuleEnabled} from './entitlements';
export {withScopedLifecycleTenant as withProbationTenant} from './module-gate';
export * from './probation-settings-scope';
export type {ProbationAutomationHistoryRun} from './probation-automation';
import {withScopedLifecycleTenant as withProbationTenant} from './module-gate';
const companyGate=(ctx:SessionContext,companyId:string)=>{if(ctx.entitlementsExempt===undefined)assertModuleEnabled(ctx,'lifecycle',companyId);};
import {workingDatesForSpan} from '../packs/leave/service';
import {todayInKualaLumpur,addCalendarMonths} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {isCalendarDate} from '../lib/calendar-date';
import {DEFAULT_PROBATION_CONFIG,createProbationCase,editProbationPart,managerSubmissionIssues,probationRoute,type ProbationCase,type ProbationPart,type ProbationConfig,type ProbationRole,ProbationError} from '../lib/probation-model';
import {DEFAULT_PROBATION_FORM,validateProbationForm,scoreProbationForm,probationFormIssues,probationApprovalRouted,type ProbationForm} from '../lib/probation-form';
import {pendingSigningSteps,signingComplete,signingStepAction,type SigningRoute,type SigningDocument,type SigningGuardrails} from '../lib/document-signing-model';
import {freezeFormApproversTx} from './probation-form-approvers';
import {createSigningDocumentTx,readSigningDocumentTx,recordDocumentSigningActionTx,reviseSigningDocumentTx,refreshCanonicalProbationSigningRouteTx,declineDocumentAcknowledgementTx} from '../packs/document-signing/service';
export {DEFAULT_PROBATION_CONFIG,DEFAULT_PROBATION_FORM,ProbationError};
export type {ProbationCase,ProbationPart,ProbationConfig,ProbationRole,ProbationForm};
const uuid=(value:string)=>{if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))throw new ProbationError('invalid','Choose a valid probation record.');return value;};
const json=(value:unknown)=>JSON.stringify(value);
const requireDay=(value:string)=>{if(!isCalendarDate(value))throw new ProbationError('invalid','Enter a valid calendar date.');return value;};
export type ProbationPersonnel={employmentId:string;personId:string;companyId:string;employeeName:string;employeeCode:string|null;companyName:string;startOn:string;endOn:string|null;grade:string;gradeId:string|null;currentGradeId:string|null;employmentType:string;probationMonths:number|null;eligibilityReviewRequired?:boolean;originalEndOn?:string|null;extendedEndOn?:string|null;extensionHistory?:import('../lib/probation-intake-model').ProbationExtensionSource[];probationUnit:string|null;probationValue:number|null;explicitNoProbation:boolean;unknownPeriod:boolean;confirmationOn:string|null;resignationOn:string|null;terminatedOn:string|null;departmentId:string|null;businessUnitId:string|null;businessGroupId:string|null;businessGroup:string|null;organisationMapping?:ProbationOrganisationMapping;organisationLegacy?:{businessGroupId:string|null;businessGroup:string|null;businessUnitId:string|null;businessUnit:string|null};department:string|null;businessUnit:string|null;title:string|null;division:string|null;holders:Record<'employee'|'lm'|'hod'|'pbp',string|null>};
type Version<T>={id:string;version:number;data:T};
export type ProbationDuplicateRolePolicy={mode:'escalate'|'sign_once'|'named_alternate';alternateUserId?:string|null};
export type ProbationRouteConfiguration={organisationMapping?:ProbationOrganisationMapping;version:number;duplicateRolePolicy?:ProbationDuplicateRolePolicy;parts:Record<'1'|'2'|'3',SigningRoute>;rules?:{businessGroupId?:string;businessUnitId?:string;grade?:string;part:1|2|3;outcome?:string;route:SigningRoute}[]};
export type ProbationSettings=ProbationConfig&{organisationMapping?:ProbationOrganisationMapping;overrides?:{businessGroupId?:string;businessUnitId?:string;grade?:string;months?:number;kpiGate:'block'|'warn'|'off'}[]};
export type ProbationSetup={settingsScoped?:boolean;settings:Version<ProbationSettings>|null;form:Version<ProbationForm>|null;route:Version<ProbationRouteConfiguration>|null;drafts:Partial<Record<'settings'|'form'|'route',Version<ProbationSettings|ProbationForm|ProbationRouteConfiguration>>>;latestVersion:Record<'settings'|'form'|'route',number>;gradeHFormAvailable:boolean;canConfigure:boolean;enabled:boolean;activationOn:string|null};
export type ProbationCommand='submit_employee'|'submit_manager'|'acknowledge'|'approve'|'return'|'record'|'unlock'|'kpi_exception'|'employee_wait_exception'|'confirm_extension'|'request_refusal'|'confirm_refusal';
export type ProbationPartView=ProbationPart&{override?:boolean;scoreBand?:number|null;canAdjudicateOfflineDecision?:boolean;offlineDecision?:import('../lib/probation-intake-model').ProbationOfflineFinalDecision|null;allowedCommands:ProbationCommand[];storageRevision:number;contentRevision:number;submittedFacts?:ProbationPersonnel;submittedPeriod?:{startOn:string;endOn:string;gradeAtStart:string};acknowledgedKpis?:ProbationPart['kpis'];selfVisible:boolean;managerVisible:boolean;signing:{id:string;document:SigningDocument}|null;canEditEmployee:boolean;canEditSelfAssessment:boolean;canEditEmployeeComments:boolean;canEditManager:boolean;managerIssues:string[];employeeIssues:string[];route:SigningRoute};
export type ProbationLetterTask={partId:string;label:string;state:string;waitingRole:string|null;waitingName:string|null};
export type ProbationLegacyReconciliationView={canRequest:boolean;holdReason:string|null;request:{id:string;reason:string;requestedAt:string;approvedAt:string|null;appliedAt:string|null;canApprove:boolean}|null};
export type ProbationCaseView={startStatus?:'waiting_for_start'|'did_not_join'|null;runtimeEnabled:boolean;sourceMoved:boolean;canRequestDateShift:boolean;canReconcileDates?:boolean;legacyReconciliation?:ProbationLegacyReconciliationView|null;letterTasks:ProbationLetterTask[];sourceChanged:boolean;dateAdjustments:{id:string;oldEndOn:string;newEndOn:string;reason:string;requestedAt:string;appliedAt:string|null;status:'awaiting_gbs'|'queued'|'applied'|'failed'|'superseded';canApprove:boolean;canSupersede:boolean;supersededAt:string|null;supersededReason:string|null;approvedAt:string|null;failure:string|null}[];record:ProbationCase&{facts:ProbationPersonnel};parts:ProbationPartView[];form:ProbationForm;roles:ProbationRole[];files:{id:string;kind:string;name:string;partId:string|null;revision:number;filingState:'pending'|'filed'|'not_required'}[];followups:{id:string;kind:string;note:string;at:string;actorId:string;partId?:string|null;contentRevision?:number}[];outcomes:ProbationOutcomeView[];holderNames:Record<string,string>};
export type ProbationOutcomeView={id:string;partId:string;outcome:string;state:string;revision:number;extensionMonths?:number|null;letterFileId:string|null;releasedAt:string|null;failure:string|null;sourceKey:string;filingState:'not_prepared'|'pending'|'filed'};
async function sourceTx(tx:Tx,id:string){const[row]=await tx.execute<{data:ProbationPersonnel}>(sql`select app.probation_personnel_source(${uuid(id)}::uuid) as data`);if(!row?.data)throw new ProbationError('forbidden','The employee is unavailable for probation.');return row.data;}
async function setupTx(tx:Tx,ctx:SessionContext,companyId:string,grade?:string):Promise<ProbationSetup>{
 companyGate(ctx,companyId);
 const rows=await tx.execute<Version<ProbationSettings|ProbationForm|ProbationRouteConfiguration>&{kind:string}>(sql`select distinct on(kind) id,version,kind,data from probation_configuration where tenant_id=${ctx.tenantId}::uuid and company_id=${uuid(companyId)}::uuid and state='published' and (kind<>'form' or app.probation_current_publication(company_id,'form',id) and coalesce(data->'targetGrades',${json(Array.from({length:12},(_,i)=>String(i+12)))}::jsonb)?${grade??'12'}) order by kind,version desc`);
 const [access]=await tx.execute<{ok:boolean}>(sql`select app.probation_config_admin(${companyId}::uuid) as ok`);
 const versions=access?.ok?await tx.execute<Version<ProbationSettings|ProbationForm|ProbationRouteConfiguration>&{kind:'settings'|'form'|'route';state:string}>(sql`select distinct on(kind) id,version,kind,state,data from probation_configuration where tenant_id=${ctx.tenantId}::uuid and company_id=${companyId}::uuid order by kind,version desc`):[];
 const [activation]=await tx.execute<{enabled:boolean;activation_on:string|null}>(sql`select enabled,activation_on::text from probation_activation where tenant_id=${ctx.tenantId}::uuid and company_id=${companyId}::uuid`);
 const[scoped]=access?.ok?await tx.execute<{scoped:boolean}>(sql`select exists(select 1 from probation_settings_scope_version where tenant_id=${ctx.tenantId}::uuid and scope='standard' and state='published') as scoped`):[];
 const[hForm]=await tx.execute<{available:boolean}>(sql`select exists(select 1 from probation_configuration where tenant_id=${ctx.tenantId}::uuid and company_id=${companyId}::uuid and kind='form' and state='published' and app.probation_current_publication(company_id,'form',id) and data->'targetGrades'?'H') as available`);
 return{settingsScoped:!!scoped?.scoped,gradeHFormAvailable:!!hForm?.available,settings:rows.find(r=>r.kind==='settings') as Version<ProbationSettings>??null,form:rows.find(r=>r.kind==='form') as Version<ProbationForm>??null,route:rows.find(r=>r.kind==='route') as Version<ProbationRouteConfiguration>??null,drafts:Object.fromEntries(versions.filter(v=>v.state==='draft').map(v=>[v.kind,v])),latestVersion:{settings:versions.find(v=>v.kind==='settings')?.version??0,form:versions.find(v=>v.kind==='form')?.version??0,route:versions.find(v=>v.kind==='route')?.version??0},canConfigure:!!access?.ok,enabled:!!activation?.enabled,activationOn:activation?.activation_on??null};
}
export function probationSetup(ctx:SessionContext,companyId:string){return withProbationTenant(ctx,tx=>setupTx(tx,ctx,companyId));}
export function bootstrapProbationPreparer(ctx:SessionContext,input:{companyId:string;userId:string;reason:string}){return withProbationTenant(ctx,async tx=>{const[row]=await tx.execute<{id:string}>(sql`select app.probation_bootstrap_admin(${uuid(input.companyId)}::uuid,${uuid(input.userId)}::uuid,${input.reason}) as id`);return row.id;});}
export function assignProbationAccess(ctx:SessionContext,input:{companyId:string;userId:string;role:'admin'|'pbp'|'gbs';validFrom:string;validTo:string|null;businessUnitId?:string|null;departmentId?:string|null;reason:string}){return withProbationTenant(ctx,async tx=>{const[row]=await tx.execute<{id:string}>(sql`select app.probation_assign_access(${uuid(input.companyId)}::uuid,${uuid(input.userId)}::uuid,${input.role},${requireDay(input.validFrom)}::date,${input.validTo?requireDay(input.validTo):null}::date,${input.businessUnitId?uuid(input.businessUnitId):null}::uuid,${input.departmentId?uuid(input.departmentId):null}::uuid,${input.reason}) as id`);return row.id;});}
export function saveProbationConfiguration(ctx:SessionContext,input:{companyId:string;kind:'settings'|'form'|'route';data:ProbationSettings|ProbationForm|ProbationRouteConfiguration;publish:boolean;expectedVersion:number}){return withProbationTenant(ctx,async tx=>{
 let data=input.data;
 if(input.kind==='settings'){
  const {validateProbationConfig}=await import('../lib/probation-model');
  const setup=await setupTx(tx,ctx,input.companyId);
  data={...input.data as ProbationSettings,gradeHFormPublished:setup.gradeHFormAvailable};
  validateProbationConfig(data);
 }
 if(input.kind==='form'){
  const form=input.data as ProbationForm;validateProbationForm(form);
  // The form version's named alternate signer must be a current login of this tenant (the route configuration's rule).
  const alternate=form.duplicateRolePolicy?.mode==='named_alternate'?form.duplicateRolePolicy.alternateUserId:null;
  if(alternate){const[row]=await tx.execute<{ok:boolean}>(sql`select exists(select 1 from app_user u where u.id=${uuid(alternate)}::uuid and u.tenant_id=${ctx.tenantId}::uuid and u.archived_at is null and not app.login_blocked(u.id)) as ok`);if(!row?.ok)throw new ProbationError('invalid','Choose a current person as the named alternate signer.');}
  // 5756: routing, group and named-people approval rows must name live routings, existing groups and current people.
  const routed=Object.values(form.approvals??{}).flat().filter(row=>probationApprovalRouted(row.who));
  if(routed.length){
   const{automationReferencesTx}=await import('./automation-builder');
   const refs=await automationReferencesTx(tx,routed.flatMap(row=>row.who==='people'?row.userIds??[]:[]));
   for(const row of routed){
    if(row.who.startsWith('routing:')&&!refs.routingExists(row.who.slice(8)))throw new ProbationError('invalid','An approval step names a routing that no longer exists. Choose another routing.');
    if(row.who.startsWith('group:')&&!refs.groupExists(row.who.slice(6)))throw new ProbationError('invalid','An approval step names an assignment group that no longer exists. Choose another group.');
    if(row.who==='people'&&(row.userIds??[]).some(id=>!refs.personExists(id)))throw new ProbationError('invalid','An approval step names someone who is no longer a current person. Choose current people.');
   }
  }
 }
 const[row]=await tx.execute<{id:string}>(sql`select app.probation_config_write(${uuid(input.companyId)}::uuid,${input.kind},${json(data)}::jsonb,${input.publish},${input.expectedVersion}) as id`);return row.id;
});}
export function defaultProbationRoutes():ProbationRouteConfiguration{const holders={employee:null,lm:null,hod:null,pbp:null,gbs:null};return{version:1,duplicateRolePolicy:{mode:'escalate'},parts:{'1':probationRoute(1,holders),'2':probationRoute(2,holders),'3':probationRoute(3,holders)}};}
export async function installProbationDrafts(ctx:SessionContext,companyId:string){
 const setup=await probationSetup(ctx,companyId);
 for(const[kind,data]of [['settings',DEFAULT_PROBATION_CONFIG],['form',DEFAULT_PROBATION_FORM],['route',defaultProbationRoutes()]]as const)if(!setup.latestVersion[kind]&&!(kind==='settings'&&setup.settingsScoped))await saveProbationConfiguration(ctx,{companyId,kind,data,publish:false,expectedVersion:0});
 const{PROBATION_WORKFLOW_EVENTS}=await import('../lib/probation-workflow'),{newProbationLetterTemplate}=await import('../lib/probation-letter-template');
 await withProbationTenant(ctx,async tx=>{
  const definitions=await tx.execute<{kind:string;data:{trigger?:{event:string};conditions?:Record<string,unknown>;outcome?:string}}>(sql`select kind,data from probation_builder_definition where tenant_id=${ctx.tenantId}::uuid and company_id=${companyId}::uuid`);
  for(const event of PROBATION_WORKFLOW_EVENTS)if(!definitions.some(d=>d.kind==='workflow'&&d.data.trigger?.event===event&&Object.keys(d.data.conditions??{}).length===0)){
   const id=randomUUID(),roles=event.startsWith('letter_')?['employee','pbp']:event==='overdue_summary'?['pbp','gbs']:['employee','lm','hod','pbp','gbs'];
   const definition={id,name:event.replaceAll('_',' '),module:'probation',status:'draft',description:'Review the wording, recipients and trigger before publishing. Publishing does not activate runtime.',trigger:{event},conditions:{},steps:[{id:'notify',type:'notify',subject:event==='overdue_summary'?'Overdue probation work for {{companyName}}':'Probation review for {{employeeName}}',body:event==='overdue_summary'?'Review the existing overdue probation work in your scoped tracker as of {{dueOn}}.':'{{employeeName}}: Part {{part}} is due {{dueOn}}.',to:roles}]};
   await tx.execute(sql`select app.probation_definition_save(${companyId}::uuid,${id},'workflow',${json(definition)}::jsonb,false,0)`);
  }
  for(const outcome of['confirm','extend','not_confirm']as const)if(!definitions.some(d=>d.kind==='template'&&d.data.outcome===outcome)){
   const id=randomUUID(),template=newProbationLetterTemplate(outcome,id,outcome==='confirm'?'Confirmation letter':outcome==='extend'?'Probation extension letter':'Non-confirmation letter');
   await tx.execute(sql`select app.probation_definition_save(${companyId}::uuid,${id},'template',${json(template)}::jsonb,false,0)`);
  }
 });
}
export function probationIntakeCandidates(ctx:SessionContext,companyId:string){return withProbationTenant(ctx,async tx=>{
 companyGate(ctx,companyId);
 const[access]=await tx.execute<{ok:boolean}>(sql`select app.probation_config_admin(${uuid(companyId)}::uuid) as ok`);if(!access?.ok)throw new ProbationError('forbidden','Probation module permission is required.');
 const ids=await tx.execute<{id:string}>(sql`select id from employment e where tenant_id=${ctx.tenantId}::uuid and company_id=${companyId}::uuid and not exists(select 1 from probation_case c where c.employment_id=e.id and c.tenant_id=e.tenant_id) order by employee_code,id limit 1000`);
 return Promise.all(ids.map(r=>sourceTx(tx,r.id)));
});}
async function admitTx(tx:Tx,ctx:SessionContext,employmentId:string,reason:string){
 const source=await sourceTx(tx,employmentId),setup=await setupTx(tx,ctx,source.companyId,source.grade);
 if(!setup.settings||!setup.form||!setup.route)throw new ProbationError('invalid','Publish probation settings, form and routes before intake.');
 if(source.confirmationOn||source.resignationOn||source.terminatedOn||source.employmentType!=='full_time'||source.explicitNoProbation)return null;
 const exactMonths=source.endOn?[...Array(120)].map((_,i)=>i+1).find(n=>addDaysIso(addCalendarMonths(source.startOn,n),-1)===source.endOn):undefined;
 const config=effectiveProbationSettings(setup.settings.data,source,source.probationMonths??exactMonths??(source.unknownPeriod?(source.grade==='H'?3:setup.settings.data.defaultMonths):null));
 const calendarEnd=source.endOn??addDaysIso(addCalendarMonths(source.startOn,source.grade==='H'?3:config.defaultMonths),-1);
 const calendar=new Set(await workingDatesForSpan(tx,employmentId,addDaysIso(source.startOn,-366),addCalendarMonths(calendarEnd,12)));
 const months=source.unknownPeriod?null:source.probationMonths??exactMonths??1;
 const unknownLength=!source.unknownPeriod&&source.probationMonths===null&&exactMonths===undefined;
 const record=createProbationCase({id:randomUUID(),employmentId,companyId:source.companyId,sourceKey:'employment:'+employmentId,startOn:source.startOn,endOn:source.endOn,months,grade:source.grade,explicitNoProbation:false,unknownLength,config,nextId:randomUUID,isWorking:day=>calendar.has(day)});
 if(!record)return null;
 const{advanceProbationWorkingDays}=await import('../lib/probation-model');const milestones={kpiReminderOn:advanceProbationWorkingDays(record.startOn,config.kpiReminderWorkingDay,day=>calendar.has(day)),kpiOverdueOn:advanceProbationWorkingDays(record.parts.find(p=>p.type===1)!.dueOn,1,day=>calendar.has(day))};
 const [row]=await tx.execute<{id:string}>(sql`select app.probation_admit(${json({...record,facts:source,milestones})}::jsonb,${json(record.parts)}::jsonb,${setup.settings.id}::uuid,${setup.form.id}::uuid,${setup.route.id}::uuid,${reason}) as id`);
 // W3: "A probation case opens" for shared workflows.
 if(row?.id){const{emitProbationEventsSafelyTx}=await import('./probation-automation');await emitProbationEventsSafelyTx(tx,ctx,row.id,[{trigger:'caseOpened',occurrence:'',facts:{}}]);}
 return row.id;
}
export function admitProbation(ctx:SessionContext,input:{employmentId:string;reason:string}){return withProbationTenant(ctx,tx=>admitTx(tx,ctx,uuid(input.employmentId),input.reason));}
async function rolesTx(tx:Tx,employmentId:string):Promise<ProbationRole[]>{
 const roles:ProbationRole[]=[];for(const role of ['employee','lm','hod','pbp','gbs']as const){const[row]=await tx.execute<{ok:boolean}>(sql`select app.probation_role(${employmentId}::uuid,${role}) as ok`);if(row?.ok)roles.push(role);}return roles;
}
async function caseTx(tx:Tx,ctx:SessionContext,id:string,lock=false):Promise<ProbationCaseView>{
 void lock; // Native commands lock part -> case; a read must not invert that order.
 const[row]=await tx.execute<{id:string;employment_id:string;form_id:string;revision:number;runtime_enabled:boolean;source_moved:boolean;data:Omit<ProbationCase,'parts'>&{facts:ProbationPersonnel}}>(sql`select id,employment_id,form_id,revision,data,app.probation_case_source_moved(probation_case.id) as source_moved,(not app.probation_case_source_moved(probation_case.id) and app.probation_owns_legacy(probation_case.employment_id) and exists(select 1 from probation_activation active where active.tenant_id=probation_case.tenant_id and active.company_id=probation_case.company_id and active.enabled)) as runtime_enabled from probation_case where id=${uuid(id)}::uuid and tenant_id=${ctx.tenantId}::uuid`);
 if(!row)throw new ProbationError('forbidden','This probation case is unavailable in your current scope.');
 companyGate(ctx,row.data.companyId);
 const[version]=await tx.execute<{data:ProbationForm}>(sql`select data from probation_configuration where id=${row.form_id}::uuid and tenant_id=${ctx.tenantId}::uuid`);if(!version)throw new ProbationError('invalid','The pinned probation form is unavailable.');
 const roles=row.source_moved?[]:await rolesTx(tx,row.employment_id),metadata=await tx.execute<{id:string;revision:number;content_revision:number;commands:ProbationCommand[];lm_actor:boolean;self_actor:boolean;can_adjudicate:boolean;resolved_route:SigningRoute;offline_decision:import('../lib/probation-intake-model').ProbationOfflineFinalDecision|null;data:Omit<ProbationPart,'employee'|'manager'> & {documentKind?:string;signingFacts?:ProbationPersonnel;signingPeriod?:{startOn:string;endOn:string;gradeAtStart:string};signingKpis?:ProbationPart['kpis'];route:SigningRoute}}>(sql`select id,revision,content_revision,data,app.probation_resolved_route(id) as resolved_route,case when data->>'type'='3' and data->>'state'='completed_offline' then app.probation_offline_decision_for_part(id) else null end as offline_decision,case when data->>'type'='3' and data->>'state'='completed_offline' then app.probation_can_adjudicate_offline_final(id) else false end as can_adjudicate,app.probation_commands(id) as commands,app.probation_part_role(id,'lm') as lm_actor,app.probation_part_role(id,'employee') as self_actor from probation_part where case_id=${row.id}::uuid and tenant_id=${ctx.tenantId}::uuid and coalesce(data->>'documentKind','review')='review' order by (data->>'cycle')::integer,(data->>'type')::integer,id`);
 const ids=metadata.map(r=>r.id),drafts=ids.length?await tx.execute<{part_id:string;rater:'employee'|'lm';data:Partial<ProbationPart>}>(sql`select part_id,rater,data from probation_rater_draft where tenant_id=${ctx.tenantId}::uuid and part_id=any(array[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`):[];
 const signatures=ids.length?await tx.execute<{id:string;subject_id:string;data:SigningDocument}>(sql`select id,subject_id,data from document_signing_document where tenant_id=${ctx.tenantId}::uuid and subject_type='probation' and subject_id=any(array[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`):[];
 const blank=()=>Object.fromEntries(version.data.criteria.map(c=>[c.id,{rating:null,evidence:''}]));
 const parts:ProbationPartView[]=metadata.map(p=>{
  const self=drafts.find(d=>d.part_id===p.id&&d.rater==='employee'),manager=drafts.find(d=>d.part_id===p.id&&d.rater==='lm'),stored=signatures.find(d=>d.subject_id===p.id);
  const part={...p.data,...self?.data,...manager?.data,employee:self?.data.employee??blank(),manager:manager?.data.manager??blank(),kpis:manager?.data.kpis??[],support:manager?.data.support??{coaching:'',access:'',checkins:'',other:''},employeeComments:self?.data.employeeComments??'',strengths:manager?.data.strengths??'',development:manager?.data.development??'',managerComments:manager?.data.managerComments??'',outcome:manager?.data.outcome??null,midpointStatus:manager?.data.midpointStatus??null,justification:manager?.data.justification??'',extensionMonths:manager?.data.extensionMonths??null,revision:p.revision} as ProbationPart;
  const open=row.runtime_enabled&&!['not_issued','locked','recorded','completed_offline','cancelled'].includes(part.state)&&row.data.state!=='withdrawn';
  const managerIssues=part.type===1?managerSubmissionIssues(part,{...row.data,parts:[]} as ProbationCase):[...probationFormIssues(version.data,part.manager,!row.data.kpiAcknowledged&&row.data.config.kpiGate==='warn'),...(!part.reviewOn?['review_date']:[]),...(!part.conductedBy?['conducted_by']:[]),...(row.data.config.lmWaitsForEmployee&&!part.staffSubmittedAt&&!part.employeeWaitException?['employee_submission']:[]),...(part.type===2?[...(!part.strengths.trim()?['strengths']:[]),...(!part.development.trim()?['development']:[]),...(!part.managerComments.trim()?['manager_comments']:[]),...(!part.midpointStatus?['midpoint_status']:[])]:[...(!part.outcome?['outcome']:[]),...(!part.justification.trim()?['justification']:[]),...(part.outcome==='extend'&&(![3,6].includes(part.extensionMonths??0)||row.data.extensionCount>=(row.data.config.maxExtensions??2))?['extension']:[])])];
  const score=scoreProbationForm(version.data,part.manager);if(score){const suggestion=part.type===2?(score.band>=3?'satisfactory':score.band===2?'development':'at_risk'):(score.band>=3?'confirm':score.band===2?'extend':'not_confirm');if((part.type===2?part.midpointStatus:part.outcome)&&suggestion!==(part.type===2?part.midpointStatus:part.outcome)&&!part.justification.trim())managerIssues.push('override_justification');}
  return{...part,canAdjudicateOfflineDecision:p.can_adjudicate,offlineDecision:p.offline_decision,allowedCommands:p.commands,submittedFacts:p.data.signingFacts,submittedPeriod:p.data.signingPeriod,acknowledgedKpis:p.data.signingKpis,route:p.resolved_route,storageRevision:p.revision,contentRevision:p.content_revision,selfVisible:!!self,managerVisible:!!manager,signing:stored?{id:stored.id,document:stored.data}:null,canEditSelfAssessment:open&&p.self_actor&&!part.staffSubmittedAt&&!part.managerSubmittedAt&&part.type!==1,canEditEmployeeComments:open&&p.self_actor&&!!part.managerSubmittedAt&&!part.acknowledgedAt&&!!stored&&pendingSigningSteps(stored.data).some(step=>step.role==='employee'&&step.holderId===ctx.userId),canEditEmployee:open&&p.self_actor&&!part.acknowledgedAt&&(!part.staffSubmittedAt&&!part.managerSubmittedAt&&part.type!==1||!!part.managerSubmittedAt&&!!stored&&pendingSigningSteps(stored.data).some(step=>step.role==='employee'&&step.holderId===ctx.userId)),canEditManager:open&&p.lm_actor&&!part.managerSubmittedAt&&(part.type===1||!row.data.config.lmWaitsForEmployee||!!part.staffSubmittedAt||!!part.employeeWaitException),managerIssues:[...new Set(managerIssues)],employeeIssues:part.type===1?[]:probationFormIssues(version.data,part.employee)};
 });
 const holders=await tx.execute<{user_id:string;name:string}>(sql`select user_id,name from app.probation_case_holder_names(${row.id}::uuid)`);
 const files=await tx.execute<{id:string;kind:string;name:string;partId:string|null;revision:number;filingState:'pending'|'filed'|'not_required'}>(sql`select id,kind,name,case when kind in('offline','completed_part','letter_released') then case when employee_document_id is null then 'pending' else 'filed' end else 'not_required' end as "filingState",part_id as "partId",revision from probation_file where case_id=${row.id}::uuid and tenant_id=${ctx.tenantId}::uuid order by created_at,id`);
 const followups=await tx.execute<{id:string;kind:string;note:string;at:string;actorId:string;partId:string|null;contentRevision:number}>(sql`select id,kind,note,created_at::text as at,actor_user_id as "actorId",part_id as "partId",content_revision as "contentRevision" from probation_followup where case_id=${row.id}::uuid and tenant_id=${ctx.tenantId}::uuid order by created_at desc,id desc`);
 const outcomes=await tx.execute<ProbationOutcomeView>(sql`select id,part_id as "partId",outcome,state,revision,extension_months as "extensionMonths",letter_file_id as "letterFileId",released_at::text as "releasedAt",failure,source_key as "sourceKey",case when letter_file_id is null then 'not_prepared' when exists(select 1 from probation_file f where f.id=letter_file_id and f.tenant_id=probation_outcome.tenant_id and f.employee_document_id is not null) then 'filed' else 'pending' end as "filingState" from probation_outcome where case_id=${row.id}::uuid and tenant_id=${ctx.tenantId}::uuid order by revision desc,id`);
 const letterTasks=await tx.execute<ProbationLetterTask>(sql`select * from app.probation_letter_tasks(${row.id}::uuid)`);
 const facts=row.source_moved?row.data.facts:await sourceTx(tx,row.employment_id),dateAdjustments=await tx.execute<{id:string;oldEndOn:string;newEndOn:string;reason:string;requestedAt:string;appliedAt:string|null;status:'awaiting_gbs'|'queued'|'applied'|'failed'|'superseded';canApprove:boolean;canSupersede:boolean;supersededAt:string|null;supersededReason:string|null;approvedAt:string|null;failure:string|null}>(sql`select id,old_end::text as "oldEndOn",new_end::text as "newEndOn",reason,created_at::text as "requestedAt",applied_at::text as "appliedAt",gbs_approved_at::text as "approvedAt",failure,superseded_at::text as "supersededAt",superseded_reason as "supersededReason",coalesce((actions.value->>'canApprove')::boolean,false) as "canApprove",coalesce((actions.value->>'canSupersede')::boolean,false) as "canSupersede",case when superseded_at is not null then 'superseded' when applied_at is not null then 'applied' when failure is not null then 'failed' when gbs_approved_at is not null then 'queued' else 'awaiting_gbs' end as status from probation_date_adjustment cross join lateral (select app.probation_date_request_actions(id) as value) actions where case_id=${row.id}::uuid and tenant_id=${ctx.tenantId}::uuid order by created_at desc,id`);
 const [dateRequest]=await tx.execute<{allowed:boolean;canReconcile:boolean;legacy:ProbationLegacyReconciliationView|null}>(sql`select app.probation_can_request_date_shift(${row.id}::uuid) as allowed,app.probation_can_reconcile_dates(${row.id}::uuid) as "canReconcile",app.probation_legacy_reconciliation_state(${row.id}::uuid) as legacy`);
 const startStatus=row.data.state==='withdrawn'?(row.data.closure==='did_not_join'?'did_not_join' as const:null):row.data.startOn>todayInKualaLumpur()&&!['confirmed','not_confirmed'].includes(row.data.state)?'waiting_for_start' as const:null;
 return{startStatus,runtimeEnabled:row.runtime_enabled,sourceMoved:row.source_moved,canRequestDateShift:dateRequest.allowed,canReconcileDates:dateRequest.canReconcile,legacyReconciliation:dateRequest.legacy,letterTasks:[...letterTasks],sourceChanged:facts.startOn!==row.data.startOn||facts.endOn!==null&&facts.endOn!==row.data.endOn,dateAdjustments:[...dateAdjustments],record:{...row.data,facts,revision:row.revision,parts},parts,form:version.data,roles,files:[...files],followups:[...followups],outcomes:[...outcomes],holderNames:Object.fromEntries(holders.map(h=>[h.user_id,h.name]))};
}
export function probationCase(ctx:SessionContext,id:string){return withProbationTenant(ctx,tx=>caseTx(tx,ctx,id));}
/** I5: the shared workflow run log of a case for its History (bounded; only for someone who can see the case). */
export function probationAutomationHistory(ctx:SessionContext,id:string){return withProbationTenant(ctx,async tx=>{const[row]=await tx.execute<{companyId:string}>(sql`select company_id as "companyId" from probation_case where id=${uuid(id)}::uuid and tenant_id=${ctx.tenantId}::uuid`);if(!row)return[];companyGate(ctx,row.companyId);const{probationAutomationHistoryTx}=await import('./probation-automation');return probationAutomationHistoryTx(tx,uuid(id));});}
export function probationCases(ctx:SessionContext){return withProbationTenant(ctx,async tx=>{
 const scoped=ctx.entitlementsExempt===undefined&&!isModuleEnabled(ctx,'lifecycle')?(ctx.entitlements?.scopedModules.lifecycle??[]):null;
 const ids=await tx.execute<{id:string}>(sql`select id from probation_case where tenant_id=${ctx.tenantId}::uuid ${scoped?sql`and company_id=any(array[${sql.join(scoped.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`:sql``} order by (data->>'endOn')::date,id limit 1000`);
 return Promise.all(ids.map(r=>caseTx(tx,ctx,r.id)));
});}
export function saveProbationDraft(ctx:SessionContext,input:{caseId:string;partId:string;revision:number;rater:'employee'|'lm';patch:Partial<ProbationPart>}){return withProbationTenant(ctx,async tx=>{
 const view=await caseTx(tx,ctx,input.caseId,true),part=view.parts.find(p=>p.id===input.partId);if(!part)throw new ProbationError('invalid','Review unavailable.');
 editProbationPart(view.record,part.id,input.rater,input.patch);
 const[row]=await tx.execute<{revision:number}>(sql`select app.probation_save_draft(${part.id}::uuid,${input.rater},${json(input.patch)}::jsonb,${input.revision}) as revision`);return row.revision;
});}
async function signingTx(tx:Tx,ctx:SessionContext,view:ProbationCaseView,part:ProbationPartView):Promise<{id:string;document:SigningDocument}>{
 // 5756: once the route is frozen from the form version, each routing, group or named-people approval step gets its person.
 if(!part.managerSubmittedAt&&part.canEditManager){await tx.execute(sql`select app.probation_prepare_signing(${part.id}::uuid)`);await freezeFormApproversTx(tx,part.id,view.record.id);}
 const[source]=await tx.execute<{data:{contentHash:string;contentRevision:number}}>(sql`select app.probation_signing_content(${part.id}::uuid) as data`);
 const[routes]=await tx.execute<{route:SigningRoute}>(sql`select app.probation_resolved_route(${part.id}::uuid) as route`);
 const[rules]=await tx.execute<{rules:SigningGuardrails}>(sql`select app.probation_signing_guardrails(${part.id}::uuid) as rules`);
 if(!source?.data||!routes?.route||!rules?.rules)throw new ProbationError('invalid','The current signing route is unavailable.');
 let stored=part.signing;
 if(!stored)return await createSigningDocumentTx(tx,ctx,{companyId:view.record.companyId,employmentId:view.record.employmentId,subjectId:part.id,subjectType:'probation',contentHash:source.data.contentHash,route:routes.route,guardrails:rules.rules}).then(r=>({id:r.id,document:r.document}));
 {
  if(stored.document.contentHash!==source.data.contentHash)stored={id:stored.id,document:await reviseSigningDocumentTx(tx,ctx,{id:stored.id,hash:source.data.contentHash,route:routes.route,reason:'New owner-authored probation content revision'})};
  else if(routes.route.steps.some(step=>{
   const previous=stored?.document.route.steps.find(candidate=>candidate.id===step.id);
   return previous?.holderId!==step.holderId||(previous?.representedId??null)!==(step.representedId??null)||(previous?.coveredByStepId??null)!==(step.coveredByStepId??null)||JSON.stringify(previous?.coveredStepIds??[])!==JSON.stringify(step.coveredStepIds??[]);
  })){
   stored={id:stored.id,document:await refreshCanonicalProbationSigningRouteTx(tx,stored.id)};
  }
 }
 return stored;
}
export function actOnProbation(ctx:SessionContext,input:{caseId:string;partId:string;revision:number;command:ProbationCommand;reason?:string;months?:number;owner?:'employee'|'lm';stepId?:string;method?:'typed'|'drawn';value?:string;consent?:boolean;actionId?:string;coveredStepIds?:string[]}){return withProbationTenant(ctx,async tx=>{
 if(input.coveredStepIds!==undefined&&(!Array.isArray(input.coveredStepIds)||input.coveredStepIds.length>1||input.coveredStepIds.some(id=>typeof id!=='string'||!id||id.length>200))){
  throw new ProbationError('invalid','The requested approval role coverage is invalid.');
 }
 const view=await caseTx(tx,ctx,input.caseId,true),part=view.parts.find(p=>p.id===input.partId);if(!part||part.revision!==input.revision)throw new ProbationError('conflict','The review changed. Read its current revision before acting.');
 // Declined signature (migration 5746): the Line Manager records it on the acknowledgement step and the part moves on;
 // the PBP's confirm_refusal only records the decline itself for a part that was already waiting on the old order.
 const declines=input.command==='request_refusal'||input.command==='confirm_refusal'&&!part.acknowledgedAt;
 if(['submit_manager','acknowledge','approve','return'].includes(input.command)||declines){
  const stored=await signingTx(tx,ctx,view,part),pending=pendingSigningSteps(stored.document);
  const step=input.stepId?pending.find(s=>s.id===input.stepId):pending.find(s=>s.holderId===ctx.userId);
  if(declines){
   const ack=stored.document.route.steps.find(s=>s.role==='employee'&&s.kind==='acknowledge');if(!ack)throw new ProbationError('invalid','Employee acknowledgement is missing.');
   await declineDocumentAcknowledgementTx(tx,ctx,{id:stored.id,stepId:ack.id,reason:input.reason??''});
  }else{
   if(!step)throw new ProbationError('forbidden','Only the currently assigned pending signer may act.');
   if(input.command==='approve'&&JSON.stringify(input.coveredStepIds??[])!==JSON.stringify(step.coveredStepIds??[])){
    throw new ProbationError('conflict','The pending approval roles changed. Review the current role coverage before signing.');
   }
   // 5756: a Review step and an Approve step without signature record their decision; every other step signs, as before.
   await recordDocumentSigningActionTx(tx,ctx,{id:stored.id,stepId:step.id,revision:stored.document.contentRevision,hash:stored.document.contentHash,action:input.command==='return'?'returned':input.command==='approve'?signingStepAction(stored.document,step):'signed',comment:input.command==='acknowledge'?part.employeeComments:input.reason,method:input.method,value:input.value,consent:input.consent,actionId:input.actionId});
  }
 }
 if(input.command==='approve'){await tx.execute(sql`select app.probation_review_transition(${part.id}::uuid)`);await emitPartEventsTx(tx,ctx,view,part,input.command,null);return{revision:part.revision};}
 const[row]=await tx.execute<{revision:number}>(sql`select app.probation_part_command(${part.id}::uuid,${part.revision},${input.command},${json({reason:input.reason,months:input.months,owner:input.owner})}::jsonb) as revision`);
 await tx.execute(sql`select app.probation_review_transition(${part.id}::uuid)`);
 // Suggestion overridden: the audited event the shared engine's outcomeOverridden trigger reads (migration 5745).
 const[override]=input.command==='submit_manager'?await tx.execute<{overridden:boolean}>(sql`select app.probation_record_override(${part.id}::uuid) as overridden`):[];
 if(input.command==='record'){
  if(part.state!=='completed_offline')await fileCompletedPartTx(tx,ctx,view.record.id,part.id);
  if(part.type===3){
   const[outcome]=await tx.execute<{id:string;revision:number;outcome:string}>(sql`select id,revision,outcome from probation_outcome where part_id=${part.id}::uuid and tenant_id=${ctx.tenantId}::uuid`);
   // Shared workflows (W2, migrations 5748/5753): "The probation outcome is decided". A matching live workflow takes over
   // the letter, posting and offboarding; with none, the case keeps today's path (auto-drafted letter, else the PBP).
   // Other: workflows on "the outcome is decided" still run (e.g. to tell the PBP); no letter is prepared and the PBP
   // chooses the real outcome (I3).
   if(outcome?.outcome==='other'){await decideOutcomeAutomationTx(tx,ctx,view,part,outcome);await tx.execute(sql`select app.probation_outcome_failure(${outcome.id}::uuid,'The outcome is Other: no letter is prepared. The PBP chooses Confirm, Extend or Non-confirmation for this case.')`);}
   else if(outcome)await proceedWithOutcomeTx(tx,ctx,view,part,outcome);
  }
 }
 await emitPartEventsTx(tx,ctx,view,part,input.command,override?override.overridden===true:null);
 return{revision:row.revision};
});}
/**
 * A decided outcome (recorded Part 3, or an Other outcome the PBP decided): the matching live shared workflows take
 * the letter, posting and offboarding (W2); with none, today's path drafts the single suggested letter, else the PBP is
 * asked to choose one. The case is never left without a next step.
 */
async function proceedWithOutcomeTx(tx:Tx,ctx:SessionContext,view:ProbationCaseView,part:ProbationPartView,outcome:{id:string;revision:number;outcome:string;extensionMonths?:number|null}){
 const decided=await decideOutcomeAutomationTx(tx,ctx,view,part,outcome);
 if(decided)return;
 try{await tx.transaction(async scope=>{const[choice]=await scope.execute<{data:{suggestedTemplateId:string|null;tie:boolean}}>(sql`select app.probation_letter_template_choices(${outcome.id}::uuid) as data`);if(!choice.data.suggestedTemplateId||choice.data.tie)throw new Error('Letter selection needs review');const{prepareProbationLetterTx}=await import('./probation-letter');await prepareProbationLetterTx(scope,ctx,{outcomeId:outcome.id,templateId:choice.data.suggestedTemplateId,revision:outcome.revision,edits:{}});});}
 catch{await tx.execute(sql`select app.probation_outcome_failure(${outcome.id}::uuid,'The review is recorded. Select and complete the approved outcome letter before signing and release.')`);}
}
/**
 * I3 (handoff B4, B5): the case's PBP (or GBS People Ops) chooses the real outcome of an Other outcome, with a reason
 * (migration 5760: authorised, audited, a follow-up row). In the same transaction the outcome then proceeds as that
 * outcome, so the case is never parked for good.
 */
export function decideProbationOtherOutcome(ctx:SessionContext,input:{caseId:string;outcomeId:string;revision:number;outcome:'confirm'|'extend'|'not_confirm';months?:3|6|null;reason:string}){return withProbationTenant(ctx,async tx=>{
 if(!['confirm','extend','not_confirm'].includes(input.outcome))throw new ProbationError('invalid','Choose Confirm, Extend or Non-confirmation.');
 const[row]=await tx.execute<{revision:number}>(sql`select app.probation_decide_other(${uuid(input.outcomeId)}::uuid,${input.revision},${input.outcome},${input.outcome==='extend'?input.months??null:null}::integer,${input.reason}) as revision`);
 const view=await caseTx(tx,ctx,input.caseId);
 const[outcome]=await tx.execute<{id:string;partId:string;revision:number;outcome:string;extensionMonths:number|null}>(sql`select id,part_id as "partId",revision,outcome,extension_months as "extensionMonths" from probation_outcome where id=${uuid(input.outcomeId)}::uuid and tenant_id=${ctx.tenantId}::uuid and case_id=${uuid(input.caseId)}::uuid`);
 const part=view.parts.find(p=>p.id===outcome?.partId);if(!outcome||!part)throw new ProbationError('invalid','Outcome source review unavailable.');
 await proceedWithOutcomeTx(tx,ctx,view,part,outcome);
 return{revision:row.revision};
});}
/** I3: the PBP or GBS records the action taken with the Line Manager for a low result; the PBP's task then clears. */
export function recordProbationLowResultAction(ctx:SessionContext,input:{partId:string;note:string}){return withProbationTenant(ctx,async tx=>{const[row]=await tx.execute<{id:string}>(sql`select app.probation_record_low_result_action(${uuid(input.partId)}::uuid,${input.note}) as id`);return row.id;});}
export function logProbationFollowup(ctx:SessionContext,input:{caseId:string;partId?:string|null;kind:'followup'|'development'|'extension_recommendation'|'nonconfirmation_recommendation';note:string}){return withProbationTenant(ctx,async tx=>{const[row]=await tx.execute<{id:string}>(sql`select app.probation_followup_add(${uuid(input.caseId)}::uuid,${input.partId?uuid(input.partId):null}::uuid,${input.kind},${input.note}) as id`);return row.id;});}
export function overrideProbationRoute(ctx:SessionContext,input:{partId:string;revision:number;route:SigningRoute;reason:string}){return withProbationTenant(ctx,async tx=>{await tx.execute(sql`select app.probation_route_override(${uuid(input.partId)}::uuid,${json(input.route)}::jsonb,${input.reason},${input.revision})`);});}
export function replaceProbationSigner(ctx:SessionContext,input:{partId:string;stepId:string;holderId:string;kind:'delegation'|'holder_changed'|'missing_holder';validFrom:string;validTo:string|null;reason:string}){return withProbationTenant(ctx,async tx=>{await tx.execute(sql`select app.probation_delegate_add(${uuid(input.partId)}::uuid,${input.stepId},${uuid(input.holderId)}::uuid,${input.kind},${requireDay(input.validFrom)}::date,${input.validTo?requireDay(input.validTo):null}::date,${input.reason})`);});}
export type ProbationTrackerFlag='overdue'|'end_passed'|'ending14'|'low_result'|'kpi_submit'|'kpi_ack'|'overridden';
export type ProbationSummaryRow={letterWaiting:ProbationLetterTask|null;closure?:string|null;extensionMax?:number;lowBand?:number|null;startStatus?:'waiting_for_start'|'did_not_join'|null;action?:import('../lib/probation-tracker').ProbationRowAction;id:string;employmentId:string;companyId:string;revision:number;employeeName:string;employeeCode:string|null;title:string|null;businessGroupId:string|null;businessGroup:string|null;organisationMapping?:ProbationOrganisationMapping;organisationLegacy?:{businessGroupId:string|null;businessGroup:string|null;businessUnitId:string|null;businessUnit:string|null};businessUnitId:string|null;businessUnit:string|null;departmentId:string|null;department:string|null;pbpUserId:string|null;grade:string;startOn:string;endOn:string;planMonths:number;planFlag:boolean;extensionCount:number;state:string;kpiAcknowledged:boolean;parts:{id:string;type:1|2|3;cycle:number;state:string;dueOn:string;managerSubmittedAt:string|null;staffSubmittedAt:string|null;acknowledgedAt:string|null;scoreBand:number|null;override:boolean;waitingRole:string|null;waitingName:string|null;waitingLabel?:string|null;calendarDaysOverdue?:number;lowResultActioned?:boolean}[];canOpen:true};
type ProbationTrackerFacet={bg:string|null;bgName:string|null;bu:string|null;buName:string|null;department:string|null;departmentName:string|null;grade:string;pbp:string|null;pbpName:string|null;state:string};
const trackerScope=(ctx:SessionContext)=>ctx.entitlementsExempt===undefined&&!isModuleEnabled(ctx,'lifecycle')?(ctx.entitlements?.scopedModules.lifecycle??[]):null;
/** Facet columns over the visible tracker cases (migration 5746): the PBP is named from the case's own PBP holder in one join. */
const trackerFacetColumns=sql`c.data->'facts'->>'businessGroupId' as bg,c.data->'facts'->>'businessGroup' as "bgName",c.data->'facts'->>'businessUnitId' as bu,c.data->'facts'->>'businessUnit' as "buName",c.data->'facts'->>'departmentId' as department,c.data->'facts'->>'department' as "departmentName",c.data->>'gradeAtStart' as grade,c.data->'facts'->'holders'->>'pbp' as pbp,c.pbp_name as "pbpName",c.data->>'state' as state`;
/**
 * Tracker summary at group scale (docs/SCALE-AND-RELEASE-RULES.md rules 2-3; migration 5746). One statement decides the
 * visible cases once (app.probation_tracker_cases, the case access rule as a set), counts every tile, pages in SQL and
 * returns the filter facets; a second statement adds, for that page only, who is waiting, letters and holder names.
 * The cost of the page details does not grow with the offset.
 */
export function probationSummaryRows(ctx:SessionContext,filters:{companyId?:string;businessGroupId?:string;businessUnitId?:string;departmentId?:string;grade?:string;pbpUserId?:string;state?:string;search?:string;flag?:ProbationTrackerFlag;
 /** Only cases with work waiting on the caller (app.probation_task_list, the same owner as My Action Centre). */
 mine?:boolean;offset?:number;limit?:number}={}){return withProbationTenant(ctx,async tx=>{
 const limit=Math.max(1,Math.min(100,Math.floor(filters.limit??50))),offset=Math.max(0,Math.min(100000,Math.floor(filters.offset??0)));
 const scope=trackerScope(ctx);
 const today=todayInKualaLumpur();
 const anyPart=(condition:ReturnType<typeof sql>)=>sql`exists(select 1 from jsonb_array_elements(c.review_parts) p(data) where ${condition})`;
 const flagExpressions:Record<ProbationTrackerFlag,ReturnType<typeof sql>>={
 overdue:anyPart(sql`p.data->>'state' not in('locked','completed_offline','cancelled') and (p.data->>'dueOn')::date<${today}::date`),
 end_passed:sql`(c.data->>'endOn')::date<${today}::date and c.data->>'state' not in('confirmed','not_confirmed','withdrawn')`,
 ending14:sql`(c.data->>'endOn')::date between ${today}::date and ${addDaysIso(today,14)}::date and c.data->>'state' not in('confirmed','not_confirmed','withdrawn')`,
 // I3: the case's pinned low band (default 2), not a fixed Band 2.
 low_result:anyPart(sql`(p.data->>'scoreBand')::integer<=coalesce(case when c.data->'config'->>'lowBand' ~ '^[1-5]$' then (c.data->'config'->>'lowBand')::integer end,2) and p.data->>'state'<>'cancelled'`),
 kpi_submit:sql`(c.data->>'startOn')::date<=${today}::date and ${anyPart(sql`p.data->>'type'='1' and p.data->>'managerSubmittedAt' is null and p.data->>'state' not in('completed_offline','cancelled')`)}`,
 kpi_ack:anyPart(sql`p.data->>'type'='1' and p.data->>'managerSubmittedAt' is not null and p.data->>'acknowledgedAt' is null and p.data->>'state' not in('completed_offline','cancelled')`),
 overridden:anyPart(sql`p.data->>'override'='true' and p.data->>'state'<>'cancelled'`)};
 const scoped=sql`where c.tenant_id=${ctx.tenantId}::uuid ${scope?sql`and c.company_id=any(array[${sql.join(scope.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`:sql``}`;
 const conditions=sql`${scoped} ${filters.companyId?sql`and c.company_id=${uuid(filters.companyId)}::uuid`:sql``} ${filters.businessGroupId?sql`and c.data->'facts'->>'businessGroupId'=${uuid(filters.businessGroupId)}`:sql``} ${filters.businessUnitId?sql`and c.data->'facts'->>'businessUnitId'=${uuid(filters.businessUnitId)}`:sql``} ${filters.departmentId?sql`and c.data->'facts'->>'departmentId'=${uuid(filters.departmentId)}`:sql``} ${filters.grade?sql`and c.data->>'gradeAtStart'=${filters.grade}`:sql``} ${filters.pbpUserId?sql`and c.data->'facts'->'holders'->>'pbp'=${uuid(filters.pbpUserId)}`:sql``} ${filters.state?sql`and c.data->>'state'=${filters.state}`:sql``} ${filters.search?sql`and position(lower(${filters.search.trim().slice(0,100)}) in lower(c.data->'facts'->>'employeeName'))>0`:sql``} ${filters.mine?sql`and c.id in(select (task->>'caseId')::uuid from jsonb_array_elements(app.probation_task_list(null,200)->'items') task)`:sql``}`;
 type Counts={total:number;overdue:number;end_passed:number;ending14:number;low_result:number;kpi_submit:number;kpi_ack:number;overridden:number};
 const[result]=await tx.execute<{counts:Counts;rows:ProbationSummaryRow[];facets:ProbationTrackerFacet[]}>(sql`with vc as materialized (select * from app.probation_tracker_cases()),
  base as materialized (select c.* from vc c ${conditions}),
  page as (select c.id,c.employment_id as "employmentId",c.company_id as "companyId",c.revision,c.data->'facts'->>'employeeName' as "employeeName",c.data->'facts'->>'employeeCode' as "employeeCode",c.data->'facts'->>'title' as title,c.data->'facts'->>'businessGroupId' as "businessGroupId",c.data->'facts'->>'businessGroup' as "businessGroup",c.data->'facts'->>'businessUnitId' as "businessUnitId",c.data->'facts'->>'businessUnit' as "businessUnit",c.data->'facts'->>'departmentId' as "departmentId",c.data->'facts'->>'department' as department,c.data->'facts'->'holders'->>'pbp' as "pbpUserId",c.data->>'gradeAtStart' as grade,c.data->>'startOn' as "startOn",c.data->>'endOn' as "endOn",(c.data->>'planMonths')::integer as "planMonths",(c.data->>'planFlag')::boolean as "planFlag",(c.data->>'extensionCount')::integer as "extensionCount",coalesce((c.data->'config'->>'maxExtensions')::integer,2) as "extensionMax",case when c.data->'config'->>'lowBand' ~ '^[1-5]$' then (c.data->'config'->>'lowBand')::integer end as "lowBand",c.data->>'closure' as closure,c.data->>'state' as state,(c.data->>'kpiAcknowledged')::boolean as "kpiAcknowledged",true as "canOpen" from base c ${filters.flag?sql`where ${flagExpressions[filters.flag]}`:sql``} order by (c.data->>'endOn')::date,c.id limit ${limit} offset ${offset})
  select (select jsonb_build_object('total',count(*) filter(where ${filters.flag?flagExpressions[filters.flag]:sql`true`}),'overdue',count(*) filter(where ${flagExpressions.overdue}),'end_passed',count(*) filter(where ${flagExpressions.end_passed}),'ending14',count(*) filter(where ${flagExpressions.ending14}),'low_result',count(*) filter(where ${flagExpressions.low_result}),'kpi_submit',count(*) filter(where ${flagExpressions.kpi_submit}),'kpi_ack',count(*) filter(where ${flagExpressions.kpi_ack}),'overridden',count(*) filter(where ${flagExpressions.overridden})) from base c) as counts,
   coalesce((select jsonb_agg(to_jsonb(page) order by (page."endOn")::date,page.id) from page),'[]'::jsonb) as rows,
   coalesce((select jsonb_agg(f) from (select distinct ${trackerFacetColumns} from vc c ${scoped}) f),'[]'::jsonb) as facets`);
 const counts=result.counts,rows=result.rows;
 const details=rows.length?await tx.execute<{case_id:string;parts:ProbationSummaryRow['parts'];letter:ProbationLetterTask|null;names:{role:string;name:string}[]}>(sql`select case_id,parts,letter,names from app.probation_tracker_page(array[${sql.join(rows.map(r=>sql`${r.id}::uuid`),sql`, `)}]::uuid[])`):[];
 for(const row of rows){const detail=details.find(d=>d.case_id===row.id);row.parts=detail?.parts??[];row.letterWaiting=detail?.letter??null;for(const part of row.parts)part.waitingName=part.waitingName??detail?.names.find(n=>n.role===part.waitingRole)?.name??null;}
 // I3: low results whose action the PBP recorded for the part's current content (one bounded read for this page).
 const lowParts=rows.flatMap(row=>row.parts.filter(part=>part.scoreBand!==null).map(part=>part.id));
 const actioned=new Set(lowParts.length?(await tx.execute<{id:string}>(sql`select distinct f.part_id as id from probation_followup f join probation_part p on p.id=f.part_id and p.tenant_id=f.tenant_id where f.tenant_id=${ctx.tenantId}::uuid and f.kind='low_result_action' and f.content_revision=p.content_revision and f.part_id=any(array[${sql.join(lowParts.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`)).map(r=>r.id):[]);
 for(const row of rows)for(const part of row.parts)if(part.scoreBand!==null)part.lowResultActioned=actioned.has(part.id);
 // Working days overdue (KPI parts) come from the holiday owner, one resolution per company calendar: they are read
 // after the list by probationTrackerWorkingDays so the list never waits for them (72 companies: about 1 s).
 for(const row of rows)for(const part of row.parts){if(part.dueOn>=today||['locked','completed_offline','cancelled'].includes(part.state))continue;part.calendarDaysOverdue=Math.round((Date.parse(today+'T00:00:00Z')-Date.parse(part.dueOn+'T00:00:00Z'))/86400000);}
 const{probationRowStartStatus,probationRowAction}=await import('../lib/probation-tracker');
 for(const row of rows){row.startStatus=probationRowStartStatus(row,today);row.action=probationRowAction(row,today);}
 return{rows,offset,limit,hasMore:offset+rows.length<counts.total,total:counts.total,totals:{overdue:counts.overdue,end_passed:counts.end_passed,ending14:counts.ending14,low_result:counts.low_result,kpi_submit:counts.kpi_submit,kpi_ack:counts.kpi_ack,overridden:counts.overridden},options:trackerOptionsFrom(result.facets)};
});}
/**
 * Working days overdue for the overdue KPI parts of tracker rows the caller has just read through probationSummaryRows
 * (server-side rows of the same request, never client input), keyed by part id. The tracker streams this in after the
 * list. Parts that are not overdue KPI parts are absent.
 */
export function probationTrackerWorkingDays(ctx:SessionContext,rows:readonly Pick<ProbationSummaryRow,'employmentId'|'parts'>[]):Promise<Record<string,number>>{
 const today=todayInKualaLumpur();
 const kpis=rows.flatMap(row=>row.parts.filter(part=>part.type===1&&part.dueOn<today&&!['locked','completed_offline','cancelled'].includes(part.state)).map(part=>({partId:part.id,employmentId:row.employmentId,from:addDaysIso(part.dueOn,1)})));
 if(!kpis.length)return Promise.resolve({});
 return withProbationTenant(ctx,async tx=>{const counts=await workingDayCountsTx(tx,kpis.map(item=>({employmentId:item.employmentId,from:item.from,to:today})));return Object.fromEntries(kpis.map((item,index)=>[item.partId,counts[index]]));});
}
/**
 * Working days in [from, to] for many employments at once (the tracker's "working days overdue"): holidays from the
 * holiday owner in one batched read, and each company's attendance working and half-working week days in one read.
 * Same answer as workingDatesForSpan(...).length, which stays the exact path when the tenant uses rotations or rosters.
 */
async function workingDayCountsTx(tx:Tx,spans:{employmentId:string;from:string;to:string}[]):Promise<number[]>{
 if(!spans.length)return [];
 const ids=[...new Set(spans.map(span=>span.employmentId))];
 const [rotations]=await tx.execute<{any:boolean}>(sql`select exists(select 1 from attendance_rotation) as any`);
 if(rotations?.any){const out:number[]=[];for(const span of spans)out.push((await workingDatesForSpan(tx,span.employmentId,span.from,span.to)).length);return out;}
 const start=spans.reduce((min,span)=>span.from<min?span.from:min,spans[0].from),end=spans.reduce((max,span)=>span.to>max?span.to:max,spans[0].to);
 const{holidayDatesByEmployment}=await import('./holidays');
 const holidays=await holidayDatesByEmployment(tx,{employmentIds:ids,startDate:start,endDate:end});
 const weeks=await tx.execute<{id:string;working:number[]|null;half:number[]|null}>(sql`select distinct on(e.id) e.id,p.working_days as working,p.half_working_days as half from employment e join company c on c.id=e.company_id left join attendance_policy p on p.company_id=e.company_id where e.id=any(array[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]) order by e.id`);
 const week=new Map(weeks.map(row=>[row.id,new Set([...(row.working??[1,2,3,4,5]),...(row.half??[])])]));
 return spans.map(span=>{
  const off=holidays.get(span.employmentId)??new Set<string>(),days=week.get(span.employmentId)??new Set([1,2,3,4,5]);let count=0;
  for(let day=span.from;day<=span.to;day=addDaysIso(day,1)){const iso=((new Date(day+'T00:00:00Z').getUTCDay()+6)%7)+1;if(!off.has(day)&&days.has(iso))count++;}
  return count;
 });
}
export type ProbationAdministrationOptions={organisationMapping?:ProbationOrganisationMapping;organisationCatalogs?:Record<ProbationOrganisationMapping,import('../lib/probation-organisation').ProbationOrganisationCatalog>;personnelBusinessUnits?:{id:string;name:string;companyId:string}[];businessGroups:{id:string;name:string;companyId?:string}[];grades:string[];companies:{id:string;name:string}[];users:{id:string;name:string}[];departments:{id:string;name:string;companyId:string}[];businessUnits:{id:string;name:string;companyId:string}[]};
export function probationAdministrationOptions(ctx:SessionContext):Promise<ProbationAdministrationOptions>{return withProbationTenant(ctx,async tx=>{
 const companies=await tx.execute<{id:string;name:string}>(sql`select c.id,c.legal_name as name from company c where c.tenant_id=${ctx.tenantId}::uuid and c.archived_at is null and app.probation_config_admin(c.id) order by c.legal_name,c.id`);
 const allowed=companies.filter(c=>ctx.entitlementsExempt!==undefined||isModuleEnabled(ctx,'lifecycle',c.id));if(!allowed.length)throw new ProbationError('forbidden','Probation module permission is required.');
 const users=await tx.execute<{id:string;name:string}>(sql`select u.id,p.full_name as name from app_user u join person p on p.id=u.person_id and p.tenant_id=u.tenant_id where u.tenant_id=${ctx.tenantId}::uuid and u.archived_at is null and not app.login_blocked(u.id) and app.access_workforce_person(p.id,'workforce.view') order by p.full_name,u.id limit 1000`);
 const scope=sql`array[${sql.join(allowed.map(c=>sql`${c.id}::uuid`),sql`, `)}]::uuid[]`;
 const departments=await tx.execute<{id:string;name:string;companyId:string}>(sql`select id,name,company_id as "companyId" from department where tenant_id=${ctx.tenantId}::uuid and company_id=any(${scope}) and archived_at is null order by name,id`);
 const businessUnits=await tx.execute<{id:string;name:string;companyId:string}>(sql`select id,name,company_id as "companyId" from business_unit where tenant_id=${ctx.tenantId}::uuid and company_id=any(${scope}) and archived_at is null order by name,id`);
 const businessGroups=await tx.execute<{id:string;name:string}>(sql`select distinct bg.id,bg.legal_name as name from company c join company bg on bg.id=coalesce(c.parent_company_id,c.id) and bg.tenant_id=c.tenant_id where c.tenant_id=${ctx.tenantId}::uuid and c.id=any(${scope}) order by bg.legal_name,bg.id`);
 const grades=await tx.execute<{code:string}>(sql`select regexp_replace(upper(code),'^(JG|GRADE)[ -]*','','g') as code from job_grade where tenant_id=${ctx.tenantId}::uuid and archived_at is null order by rank,code limit 500`);
 const [mapping]=await tx.execute<{mapping:ProbationOrganisationMapping}>(sql`select app.probation_organisation_mapping() as mapping`);
 const organisationMapping=mapping.mapping,organisationCatalogs={
  'legacy-v1':{businessGroups:[...businessGroups],businessUnits:[...businessUnits]},
  'personnel-v2':{businessGroups:businessUnits.map(unit=>({id:unit.id,name:unit.name,companyId:unit.companyId})),businessUnits:allowed.map(company=>({...company,companyId:company.id}))},
 };
 return{...organisationCatalogs[organisationMapping],organisationMapping,organisationCatalogs,personnelBusinessUnits:[...businessUnits],grades:[...new Set(grades.map(g=>g.code))],companies:allowed,users:[...users],departments:[...departments]};
});}
export function uploadProbationEvidence(ctx:SessionContext,input:{caseId:string;partId:string;revision:number;name:string;content:Buffer;reason:string}){return withProbationTenant(ctx,async tx=>{
 await validateProbationOfflinePdf(input.content);
 const view=await caseTx(tx,ctx,input.caseId),part=view.parts.find(p=>p.id===input.partId);if(!part||part.revision!==input.revision)throw new ProbationError('conflict','The intake review changed.');
 const[row]=await tx.execute<{id:string}>(sql`select app.probation_file_save(${view.record.id}::uuid,${part.id}::uuid,'offline',${input.name},${input.content},${part.revision},${input.reason}) as id`);return row.id;
});}
async function fileCompletedPartTx(tx:Tx,ctx:SessionContext,caseId:string,partId:string){
 const view=await caseTx(tx,ctx,caseId),part=view.parts.find(p=>p.id===partId);if(!part||part.state!=='locked')throw new ProbationError('invalid','A completed signed review is required.');
 const[row]=await tx.execute<{data:{requestId:string;fileId:string|null;status:'ready'|'pending'}}>(sql`select app.probation_request_part_pdf(${part.id}::uuid,${part.storageRevision},${part.contentRevision}) as data`);return row.data;
}
export function generateProbationPartPdf(ctx:SessionContext,input:{caseId:string;partId:string}){return withProbationTenant(ctx,tx=>fileCompletedPartTx(tx,ctx,input.caseId,input.partId));}
export function downloadProbationFile(ctx:SessionContext,caseId:string,fileId:string){return withProbationTenant(ctx,async tx=>{
 await caseTx(tx,ctx,uuid(caseId));const[row]=await tx.execute<{name:string;mimeType:string;content:Buffer}>(sql`select name,mime_type as "mimeType",content from probation_file where id=${uuid(fileId)}::uuid and case_id=${caseId}::uuid and tenant_id=${ctx.tenantId}::uuid`);
 if(!row)throw new ProbationError('forbidden','This probation document is unavailable in your current scope.');return row;
});}

export type ProbationTrackerOptions={businessGroups:{id:string;name:string}[];businessUnits:{id:string;name:string}[];departments:{id:string;name:string}[];grades:string[];pbps:{id:string;name:string}[];states:string[];facets?:{businessGroupId:string|null;businessUnitId:string|null;departmentId:string|null;grade:string}[]};
async function trackerOptionsTx(tx:Tx,ctx:SessionContext):Promise<ProbationTrackerOptions>{
 const scope=trackerScope(ctx);
 const rows=await tx.execute<ProbationTrackerFacet>(sql`select distinct ${trackerFacetColumns} from app.probation_tracker_cases() c where c.tenant_id=${ctx.tenantId}::uuid ${scope?sql`and c.company_id=any(array[${sql.join(scope.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`:sql``}`);
 return trackerOptionsFrom([...rows]);
}
function trackerOptionsFrom(rows:ProbationTrackerFacet[]):ProbationTrackerOptions{
 const choices=(id:'bg'|'bu'|'department'|'pbp',name:'bgName'|'buName'|'departmentName'|'pbpName')=>[...new Map(rows.filter(r=>r[id]&&r[name]).map(r=>[r[id]!,{id:r[id]!,name:r[name]!}])).values()].sort((a,b)=>a.name.localeCompare(b.name));
 return{facets:rows.map(row=>({businessGroupId:row.bg,businessUnitId:row.bu,departmentId:row.department,grade:row.grade})),businessGroups:choices('bg','bgName'),businessUnits:choices('bu','buName'),departments:choices('department','departmentName'),pbps:choices('pbp','pbpName'),grades:[...new Set(rows.map(r=>r.grade))].sort(),states:[...new Set(rows.map(r=>r.state))].sort()};
}
/** Names come only from visible cases, never an unrestricted Personnel search. */
export function probationEmployeeNameSuggestions(ctx:SessionContext,input:{search:string;businessGroupId?:string;businessUnitId?:string;departmentId?:string;grade?:string}) {
 const search=input.search.trim().slice(0,100);if(search.length<2)return Promise.resolve([] as string[]);
 return withProbationTenant(ctx,async tx=>{
  const scope=ctx.entitlementsExempt===undefined&&!isModuleEnabled(ctx,'lifecycle')?(ctx.entitlements?.scopedModules.lifecycle??[]):null;
  const rows=await tx.execute<{name:string}>(sql`select distinct c.data->'facts'->>'employeeName' as name from app.probation_tracker_cases() c where c.tenant_id=${ctx.tenantId}::uuid
   ${scope?sql`and c.company_id=any(array[${sql.join(scope.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`:sql``}
   and position(lower(${search}) in lower(c.data->'facts'->>'employeeName'))>0
   ${input.businessGroupId?sql`and c.data->'facts'->>'businessGroupId'=${uuid(input.businessGroupId)}`:sql``}
   ${input.businessUnitId?sql`and c.data->'facts'->>'businessUnitId'=${uuid(input.businessUnitId)}`:sql``}
   ${input.departmentId?sql`and c.data->'facts'->>'departmentId'=${uuid(input.departmentId)}`:sql``}
   ${input.grade?sql`and c.data->>'gradeAtStart'=${input.grade.slice(0,40)}`:sql``}
   order by name limit 10`);
  return rows.map(row=>row.name);
 });
}
export function probationTrackerOptions(ctx:SessionContext){return withProbationTenant(ctx,tx=>trackerOptionsTx(tx,ctx));}
export function canConfigureProbationWorkflows(ctx:SessionContext):Promise<boolean>{if(ctx.entitlementsExempt===undefined&&!isModuleEnabled(ctx,'lifecycle')&&!ctx.entitlements?.scopedModules.lifecycle?.length)return Promise.resolve(false);return withProbationTenant(ctx,async tx=>{const rows=await tx.execute<{id:string}>(sql`select id from company where tenant_id=${ctx.tenantId}::uuid and archived_at is null and app.probation_config_admin(id)`);return rows.some(c=>ctx.entitlementsExempt!==undefined||isModuleEnabled(ctx,'lifecycle',c.id));});}

export async function prepareProbationCutover(ctx:SessionContext,companyId:string){const{prepareProbationCutoverPlan}=await import('./probation-cutover');return prepareProbationCutoverPlan(ctx,companyId);}
export function approveProbationCutover(ctx:SessionContext,input:{id:string;digest:string;reason:string}){return withProbationTenant(ctx,async tx=>{await tx.execute(sql`select app.probation_approve_cutover(${input.id}::uuid,${input.digest},${input.reason})`);const[receipt]=await tx.execute<{id:string;digest:string;snapshot:import('./probation-cutover').ProbationCutoverPlan;approvedBy:string;approvedAt:string;reason:string}>(sql`select id,digest,data as snapshot,approved_by as "approvedBy",approved_at::text as "approvedAt",reason from probation_cutover where id=${input.id}::uuid and tenant_id=${ctx.tenantId}::uuid`);return{...receipt,sends:false as const};});}

/** Existing minute sweep supplies a real privileged connection; context roles confer no maintenance power. */
export function requestProbationActivation(ctx:SessionContext,input:{id:string;digest:string;installationReference:string}) {
 return withProbationTenant(ctx,async tx=>{const[row]=await tx.execute<{id:string}>(sql`select app.probation_request_activation(${uuid(input.id)}::uuid,${input.digest},${input.installationReference}) as id`);return probationActivationRequestTx(tx,ctx,row.id);});
}
async function probationActivationRequestTx(tx:Tx,ctx:SessionContext,id:string){
 const[row]=await tx.execute<{id:string;state:'pending'|'completed'|'failed'}>(sql`select id,state from probation_activation_request where id=${uuid(id)}::uuid and tenant_id=${ctx.tenantId}::uuid`);
 if(!row)throw new ProbationError('forbidden','Activation request is unavailable.');return row;
}
export function probationActivationRequest(ctx:SessionContext,id:string){return withProbationTenant(ctx,tx=>probationActivationRequestTx(tx,ctx,id));}
export async function sweepProbation(ctx:SessionContext,connection:import('./notice-projection').NotificationSweepConnection,now=new Date()):Promise<{processed:number;failed:number}>{
 if(ctx.userId)throw new ProbationError('forbidden','Probation maintenance requires the verified no-login owner connection.');
 ctx={...ctx,roles:[],grants:undefined}; // The actual owner connection and protected source intent confer authority.
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
 const activationRequests=await (await import('./probation-cutover')).processRequestedProbationActivations(ctx,connection);
 const companies=await connection.withTenant(ctx,async tx=>{const[owner]=await tx.execute<{ok:boolean}>(sql`select app.probation_storage_runner() as ok`);if(!owner?.ok)throw new ProbationError('forbidden','Verified probation storage owner required.');return tx.execute<{companyId:string;activationOn:string}>(sql`select company_id as "companyId",activation_on::text as "activationOn" from probation_activation where tenant_id=${ctx.tenantId}::uuid and enabled and activation_on<=${today}::date order by company_id`);});
 let processed=activationRequests.processed,failed=activationRequests.failed;
 const scheduleRequests=await connection.withTenant(ctx,tx=>tx.execute<{id:string;companyId:string}>(sql`
  select q.id,c.company_id as "companyId" from probation_schedule_reconciliation_request q
  join probation_case c on c.id=q.case_id and c.tenant_id=q.tenant_id
  where q.tenant_id=${ctx.tenantId}::uuid and q.state='pending' order by q.created_at,q.id limit 200`));
 for(const request of scheduleRequests){
  if(ctx.entitlementsExempt===undefined&&!isModuleEnabled(ctx,'lifecycle',request.companyId))continue;
  try{
   await connection.withTenant(ctx,async tx=>{
    const [requestState]=await tx.execute<{data:{caseId:string;revision:number;reason:string}|null}>(sql`select app.probation_schedule_reconciliation_owner(${request.id}::uuid) as data`);
    if(!requestState.data)return;
    const {caseId,revision,reason}=requestState.data;
    await reconcileProbationDatesTx(tx,ctx,caseId,revision,reason);
    await tx.execute(sql`update probation_schedule_reconciliation_request set state='applied',resolved_at=now() where id=${request.id}::uuid and tenant_id=${ctx.tenantId}::uuid and state='pending'`);
   });
   processed++;
  }catch{failed++;}
 }
 const dateShifts=await connection.withTenant(ctx,tx=>tx.execute<{requestId:string;caseId:string;revision:number;companyId:string}>(sql`select r.id as "requestId",r.case_id as "caseId",r.expected_revision as revision,c.company_id as "companyId" from probation_date_adjustment r join probation_case c on c.id=r.case_id and c.tenant_id=r.tenant_id where r.tenant_id=${ctx.tenantId}::uuid and r.gbs_approved_at is not null and r.applied_at is null and r.superseded_at is null and r.failure is null and exists(select 1 from probation_activation active where active.tenant_id=c.tenant_id and active.company_id=c.company_id and active.enabled) order by r.gbs_approved_at,r.id limit 200`));
 for(const request of dateShifts){if(ctx.entitlementsExempt===undefined&&!isModuleEnabled(ctx,'lifecycle',request.companyId))continue;try{await connection.withTenant(ctx,tx=>applyProbationDateShiftOwnerTx(tx,ctx,request));processed++;}catch{failed++;await connection.withTenant(ctx,tx=>tx.execute(sql`update probation_date_adjustment set failure='The canonical source or protected movement needs PBP/GBS review before an owner retry.' where id=${request.requestId}::uuid and tenant_id=${ctx.tenantId}::uuid and applied_at is null and superseded_at is null`));}}

 const rendering=await connection.withTenant(ctx,tx=>tx.execute<{id:string;companyId:string}>(sql`select request.id,c.company_id as "companyId" from probation_render_request request join probation_case c on c.id=request.case_id and c.tenant_id=request.tenant_id where request.tenant_id=${ctx.tenantId}::uuid and request.state='pending' order by request.created_at,request.id limit 200`));
 for(const request of rendering){if(ctx.entitlementsExempt===undefined&&!isModuleEnabled(ctx,'lifecycle',request.companyId))continue;try{const state=await connection.withTenant(ctx,tx=>sealProbationRenderTx(tx,ctx,request.id));if(state==='held')failed++;else if(state!=='paused')processed++;}catch{failed++;await connection.withTenant(ctx,tx=>tx.execute(sql`select app.probation_hold_render(${request.id}::uuid,'render_failed')`));}}
 const filing=await connection.withTenant(ctx,tx=>tx.execute<{fileId:string;companyId:string}>(sql`select q.file_id as "fileId",c.company_id as "companyId" from probation_filing_queue q join probation_case c on c.id=q.case_id and c.tenant_id=q.tenant_id where q.tenant_id=${ctx.tenantId}::uuid and q.state in('pending','held') and app.probation_company_entitled(c.company_id) and exists(select 1 from probation_activation active where active.tenant_id=c.tenant_id and active.company_id=c.company_id and active.enabled) order by q.created_at,q.file_id limit 500`));
 for(const file of filing){if(ctx.entitlementsExempt===undefined&&!isModuleEnabled(ctx,'lifecycle',file.companyId))continue;try{const[receipt]=await connection.withTenant(ctx,async tx=>{
   const [evidence]=await tx.execute<{content:Buffer}>(sql`select content from probation_file where id=${file.fileId}::uuid and tenant_id=${ctx.tenantId}::uuid and kind='offline'`);
   if(evidence)await validateProbationOfflinePdf(evidence.content);
   return tx.execute<{id:string|null}>(sql`select app.probation_file_owner(${file.fileId}::uuid) as id`);
  });if(receipt?.id)processed++;}catch{failed++;await connection.withTenant(ctx,tx=>tx.execute(sql`update probation_filing_queue set state='held',failure='Canonical Personal File filing needs an owner retry.' where file_id=${file.fileId}::uuid and tenant_id=${ctx.tenantId}::uuid`));}}
 for(const company of companies){if(ctx.entitlementsExempt===undefined&&!isModuleEnabled(ctx,'lifecycle',company.companyId))continue;
  // New admissions only: older employees require the reviewed cutover/offline intake path. An employment opens its case
  // when it exists (activated), including before its start date; nothing is issued until the start date (decision 6).
  const admissions=await connection.withTenant(ctx,tx=>tx.execute<{id:string}>(sql`select e.id from employment e join assignment a on a.employment_id=e.id and a.tenant_id=e.tenant_id and a.valid_to is null and a.superseded_at is null where e.tenant_id=${ctx.tenantId}::uuid and e.company_id=${company.companyId}::uuid and a.employment_type='full_time' and e.voided_at is null and e.import_pending_attempt_id is null and coalesce(e.join_date,e.hired_on)>=${company.activationOn}::date and not exists(select 1 from probation_case c where c.tenant_id=e.tenant_id and c.employment_id=e.id) order by e.id limit 500`));
  for(const e of admissions)try{await connection.withTenant(ctx,tx=>admitTx(tx,ctx,e.id,'Activated new starter intake'));processed++;}catch{failed++;}
  // Did not join: the hire was voided, ended on or before its start date, or an exit was recorded before it started.
  const notJoined=await connection.withTenant(ctx,tx=>tx.execute<{id:string}>(sql`select id from probation_case where tenant_id=${ctx.tenantId}::uuid and company_id=${company.companyId}::uuid and data->>'state' not in('withdrawn','confirmed','not_confirmed') and app.probation_owns_legacy(employment_id) and app.probation_did_not_join(id) order by id limit 500`));
  for(const c of notJoined)try{await connection.withTenant(ctx,tx=>tx.execute(sql`select app.probation_withdraw(${c.id}::uuid,'Did not join: the hire was withdrawn or ended before the start date')`));processed++;}catch{failed++;}
  const cases=await connection.withTenant(ctx,tx=>tx.execute<{id:string}>(sql`select id from probation_case where tenant_id=${ctx.tenantId}::uuid and company_id=${company.companyId}::uuid and app.probation_owns_legacy(employment_id) and data->>'state' not in('withdrawn','confirmed','not_confirmed') order by id limit 2000`));
  // W3: dated and issue triggers of shared workflows, checked once per company; cases emit only those with a live workflow.
  const liveDated=cases.length?await connection.withTenant(ctx,async tx=>{const{liveProbationTriggersTx}=await import('./probation-automation');return liveProbationTriggersTx(tx,cases[0].id,['formIssued','dueAfterStart','dueBeforeReview','kpiOverdue']);}):new Set<string>();
  for(const c of cases)try{await connection.withTenant(ctx,async tx=>{
   const view=await caseTx(tx,ctx,c.id);if(view.sourceMoved){await tx.execute(sql`select app.probation_hold_source_transfer(${c.id}::uuid)`);return;}if(view.record.facts.resignationOn||view.record.facts.terminatedOn){await tx.execute(sql`select app.probation_withdraw(${c.id}::uuid,'Canonical Personnel exit recorded')`);return;}
   if(view.sourceChanged){await tx.execute(sql`select app.probation_mark_source_change(${c.id}::uuid)`);return;}
   const signingDocuments=await tx.execute<{id:string}>(sql`
    select d.id from document_signing_document d join probation_part p on p.id=d.subject_id and p.tenant_id=d.tenant_id
    where d.tenant_id=${ctx.tenantId}::uuid and d.subject_type='probation' and p.case_id=${c.id}::uuid
     and app.document_signing_subject_access('probation',p.id,'canonical_refresh') order by p.id`);
   for(const document of signingDocuments){
    await refreshCanonicalProbationSigningRouteTx(tx,document.id);
    await tx.execute(sql`select app.probation_notify_route_attention(${document.id}::uuid)`);
   }

   const workflows=await tx.execute<{id:string;data:import('../lib/probation-workflow').ProbationWorkflow}>(sql`select id,data from probation_builder_definition where tenant_id=${ctx.tenantId}::uuid and company_id=${company.companyId}::uuid and kind='workflow' and state='published' and id::text in(select jsonb_array_elements_text(data->'workflowIds') from probation_case where id=${c.id}::uuid)`);
   const datedEvents:{trigger:string;occurrence:string;facts:import('./probation-automation').ProbationEventFacts;anchors:Record<string,string|null>;today:string}[]=[];
   for(const original of view.parts){let part=original;
    if(part.state==='not_issued'&&part.issueOn<=today&&view.record.startOn<=today){await tx.execute(sql`select app.probation_issue(${part.id}::uuid,${today}::date)`);part=(await caseTx(tx,ctx,c.id)).parts.find(p=>p.id===part.id)!;if(part.state!=='not_issued')datedEvents.push({trigger:'formIssued',occurrence:part.id,facts:{partId:part.id,partType:part.type,dueOn:part.dueOn},anchors:{},today});}
    // Dated shared-workflow triggers count from the start date, the review due date and the Week 1 KPI overdue date; the
    // runner decides whether today is due and runs each once (repeat: once per day).
    if(view.record.startOn<=today&&!['locked','completed_offline','cancelled','not_issued'].includes(part.state))for(const trigger of['dueAfterStart','dueBeforeReview',...(part.type===1?['kpiOverdue']:[])])datedEvents.push({trigger,occurrence:part.id,facts:{partId:part.id,partType:part.type,dueOn:part.dueOn},anchors:{startDate:view.record.startOn,reviewDueDate:part.dueOn,kpiOverdueDate:view.record.milestones?.kpiOverdueOn??null},today});
    if(['locked','completed_offline','cancelled','not_issued'].includes(part.state)){if(part.state==='locked'&&!view.files.some(f=>f.kind==='completed_part'&&f.partId===part.id&&f.revision===part.contentRevision))await fileCompletedPartTx(tx,ctx,c.id,part.id);continue;}
    const events=new Set<string>();
    if(part.issueOn===today)events.add(part.type===1?'kpi_assigned':'review_issued');
    if(part.type===1){
     if(view.record.milestones?.kpiReminderOn===today)events.add('kpi_reminder');
     if(view.record.milestones?.kpiOverdueOn===today)events.add('kpi_overdue');
    }
    else{if(today<=part.dueOn&&(today===addDaysIso(part.dueOn,-view.record.config.firstReminderDays)||today>=addDaysIso(part.dueOn,-view.record.config.dailyReminderDays)))events.add('review_reminder');if(part.dueOn===today)events.add('review_due');}
    for(const w of workflows)if(events.has(w.data.trigger.event))await tx.execute(sql`select app.probation_workflow_run(${c.id}::uuid,${part.id}::uuid,${w.id}::uuid,${part.revision},'Current-day automatic probation event')`);
   }
   if(datedEvents.length&&liveDated.size){const{emitProbationEventsSafelyTx}=await import('./probation-automation');await emitProbationEventsSafelyTx(tx,ctx,c.id,datedEvents,liveDated);}
  });processed++;}catch{failed++;}
 // G2: the daily overdue summary of shared workflows, once per company and day: one set-based read finds one context
 // case per PBP with an overdue review part (bounded); each PBP's summary runs once a day (the occurrence is the day).
 if(cases.length)try{await connection.withTenant(ctx,async tx=>{
  const{liveProbationTriggersTx,emitProbationEventsSafelyTx}=await import('./probation-automation');
  const live=await liveProbationTriggersTx(tx,cases[0].id,['overdueSummary']);if(!live.size)return;
  const rows=await tx.execute<{case_id:string;pbp:string;overdue:number}>(sql`select case_id,pbp,overdue from app.probation_overdue_summary_cases(${company.companyId}::uuid,${today}::date)`);
  for(const row of rows)await emitProbationEventsSafelyTx(tx,ctx,row.case_id,[{trigger:'overdueSummary',occurrence:`${today}:${row.pbp}`,facts:{overdueCount:Number(row.overdue)},today}],live);
 });}catch{failed++;}
 }
 const released=await connection.withTenant(ctx,tx=>tx.execute<{id:string;companyId:string}>(sql`
  select outcome.id,c.company_id as "companyId" from probation_outcome outcome
  join probation_case c on c.id=outcome.case_id and c.tenant_id=outcome.tenant_id
  join probation_activation active on active.tenant_id=c.tenant_id and active.company_id=c.company_id and active.enabled
  where outcome.tenant_id=${ctx.tenantId}::uuid and outcome.released_at is not null and outcome.state<>'completed'
   and outcome.failure is null
   and app.probation_owns_legacy(c.employment_id) and not app.probation_case_source_moved(c.id)
   and (outcome.outcome<>'confirm' or (c.data->>'endOn')::date<=${today}::date)
  order by outcome.released_at,outcome.id limit 200`));
 for(const outcome of released){
  if(ctx.entitlementsExempt===undefined&&!isModuleEnabled(ctx,'lifecycle',outcome.companyId))continue;
  try{
   const result=await connection.withTenant(ctx,tx=>applyProbationOutcomeTx(tx,ctx,outcome.id));
   if(result.completed)processed++;
  }catch(error){
   const cause=error instanceof Error&&error.cause?error.cause:error;
   if(error instanceof LeaveDependencyUnavailable&&error.reason==='busy'||cause&&typeof cause==='object'&&'code' in cause&&cause.code==='55P03')continue;
   failed++;
   try{
    await connection.withTenant(ctx,tx=>tx.execute(sql`select app.probation_outcome_failure(${outcome.id}::uuid,'The canonical Personnel or Offboarding update could not complete. Review the current source and record a GBS retry.')`));
   }catch{ /* A concurrent pause or transfer retains its own guarded hold. */ }
  }
 }
 return{processed,failed};
}

/**
 * Catalogue events of a review command (W3): the Line Manager submits (and a low result or an overridden suggestion),
 * the employee acknowledges or declines to sign, an approval is returned, still pending or complete. Only triggers with
 * a live shared workflow do any work; the command never fails because of a workflow (each event has its own savepoint).
 */
async function emitPartEventsTx(tx:Tx,ctx:SessionContext,view:ProbationCaseView,part:ProbationPartView,command:ProbationCommand,overridden:boolean|null){
 const triggers:string[]=[],score=scoreProbationForm(view.form,part.manager);
 if(command==='submit_manager'){triggers.push('lmSubmitted');if(score&&score.band<=(view.record.config.lowBand??2))triggers.push('lowResult');if(overridden)triggers.push('outcomeOverridden');}
 if(command==='acknowledge')triggers.push('acknowledged');
 if(command==='request_refusal'||command==='confirm_refusal')triggers.push('declinedToSign');
 if(command==='return')triggers.push('returned');
 const[doc]=await tx.execute<{data:SigningDocument;revision:number}>(sql`select data,revision from document_signing_document where tenant_id=${ctx.tenantId}::uuid and subject_type='probation' and subject_id=${part.id}::uuid`);
 const{probationPendingStep,emitProbationEventsSafelyTx}=await import('./probation-automation');
 const pending=doc?probationPendingStep(pendingSigningSteps(doc.data)):null;
 if(command==='approve')triggers.push(pending?.users.length?'approvalPending':'approvalsComplete');
 // G2: like the notify-only engine's approval_pending (app.probation_review_transition), a part is also "waiting" after the
 // Line Manager signs, the employee acknowledges or a decline is recorded, whenever someone's step is then pending.
 if(['submit_manager','acknowledge','request_refusal','confirm_refusal'].includes(command)&&pending?.users.length)triggers.push('approvalPending');
 if(!triggers.length)return;
 await emitProbationEventsSafelyTx(tx,ctx,view.record.id,triggers.map(trigger=>({trigger,occurrence:`${part.id}:${doc?.revision??part.revision}:${trigger}`,pending:pending?.users??null,
  facts:{partId:part.id,partType:part.type,dueOn:part.dueOn??null,resultBand:score?.band??null,overridden,pendingStep:pending?.label??null}})));
}
/** Runs the outcome's shared workflows in a savepoint; any unexpected error leaves the outcome on today's path. */
async function decideOutcomeAutomationTx(tx:Tx,ctx:SessionContext,view:ProbationCaseView,part:ProbationPartView,outcome:{id:string;revision:number;outcome:string;extensionMonths?:number|null}):Promise<boolean>{
 const score=scoreProbationForm(view.form,part.manager),suggestion=score?(score.band>=3?'confirm':score.band===2?'extend':'not_confirm'):null;
 try{
  const{runProbationOutcomeDecidedTx}=await import('./probation-automation');
  // A nested transaction (driver savepoint): a database error inside it does not doom the recording command.
  const result=await tx.transaction(scope=>runProbationOutcomeDecidedTx(scope,ctx,{record:view.record,partId:part.id,dueOn:part.dueOn??null,outcome:{id:outcome.id,revision:outcome.revision,outcome:outcome.outcome,extensionMonths:outcomeExtensionMonths(part,outcome)},resultBand:score?.band??null,overridden:suggestion?suggestion!==outcome.outcome:null}));
  return result.matched;
 }catch{return false;}
}
/**
 * New path (W2): an outcome decided with shared workflows resumes their frozen remaining steps once its letter is
 * released and filed, then records the effect without writing the movement (a Personnel posting waits for approval).
 * Outcomes without a run (decided before this shipped, or no workflow matched) and outcomes whose run failed before it
 * created anything (handled by hand) take the default path in applyProbationOutcomeTx, which since I1 also creates the
 * same Personnel posting (same values, group and idempotency key) instead of writing the movement.
 * F7: once a run has created a Personnel posting (or the offboarding hand-off), the outcome never falls back to writing
 * the movement directly. If a later step failed, the GBS retry records the effect with that posting (still pending
 * approval) instead, so the movement cannot be written twice; the failed step itself was asked to be checked by hand.
 */
async function applyAutomatedOutcomeTx(tx:Tx,ctx:SessionContext,view:ProbationCaseView,part:ProbationPartView,outcome:{id:string;outcome:string;extensionMonths?:number|null}):Promise<{completed:boolean;waitingOn?:string}|null>{
 const{probationOutcomeAutomationTx,resumeProbationOutcomeTx}=await import('./probation-automation');
 // A run that failed before it created a posting or hand-off asked the PBP to check and release by hand: that outcome
 // then completes on the path below.
 const before=await probationOutcomeAutomationTx(tx,outcome.id),failedWithEffect=before.failed>0&&!!(before.postingId||before.handoffId);
 if(!before.runs||before.failed&&!failedWithEffect)return null;
 if(outcome.outcome==='confirm'&&view.record.endOn>todayInKualaLumpur())return{completed:false,waitingOn:view.record.endOn};
 const[letter]=await tx.execute<{id:string;revision:number}>(sql`select d.id,o.revision from probation_outcome o join document_signing_document d on d.tenant_id=o.tenant_id and d.subject_type='probation' and d.subject_id=o.letter_part_id where o.id=${outcome.id}::uuid and o.tenant_id=${ctx.tenantId}::uuid`);
 const extensionMonths=outcomeExtensionMonths(part,outcome);
 if(letter&&!failedWithEffect)await resumeProbationOutcomeTx(tx,ctx,{record:view.record,partId:part.id,outcome:{id:outcome.id,revision:letter.revision,outcome:outcome.outcome,extensionMonths},documentId:letter.id});
 const after=await probationOutcomeAutomationTx(tx,outcome.id);
 if(after.waiting||after.failed&&!failedWithEffect)return{completed:false};
 let next:{endOn:string}|null=null,newPart:ProbationPart|null=null;
 if(outcome.outcome==='extend'){if(extensionMonths!==3&&extensionMonths!==6)throw new ProbationError('invalid','The actual PBP-approved extension length is required.');const start=addDaysIso(view.record.endOn,1),end=addDaysIso(addCalendarMonths(start,extensionMonths),-1);next={endOn:end};const working=new Set(await workingDatesForSpan(tx,view.record.employmentId,addDaysIso(end,-366),addDaysIso(end,366)));const{newProbationPart,probationDueDay}=await import('../lib/probation-model');newPart=newProbationPart(randomUUID(),3,view.record.extensionCount+1,probationDueDay(end,day=>working.has(day),view.record.config.nonWorkingDayRule),view.record.config.issueLeadDays);}
 await tx.execute(sql`select app.probation_record_posting_effect(${outcome.id}::uuid,${after.postingId}::uuid,${outcome.outcome==='not_confirm'?after.handoffId:null}::uuid,${json(next)}::jsonb,${json(newPart)}::jsonb)`);
 return{completed:true};
}
/** The extension length an Extend outcome applies: the PBP's choice for an Other outcome, else the accepted offline decision, else the review's. */
const outcomeExtensionMonths=(part:ProbationPartView,outcome:{extensionMonths?:number|null})=>part.outcome==='other'&&!part.offlineDecision?.acceptedAt&&outcome.extensionMonths?outcome.extensionMonths:part.offlineDecision?.acceptedAt?part.offlineDecision.extensionMonths:part.extensionMonths;
async function applyProbationOutcomeTx(tx:Tx,ctx:SessionContext,outcomeId:string){
 const[outcome]=await tx.execute<{id:string;caseId:string;partId:string;outcome:string;state:string;releasedAt:string|null;extensionMonths:number|null}>(sql`select id,case_id as "caseId",part_id as "partId",outcome,state,released_at::text as "releasedAt",extension_months as "extensionMonths" from probation_outcome where tenant_id=${ctx.tenantId}::uuid and id=${uuid(outcomeId)}::uuid`);
 if(!outcome||!outcome.releasedAt)throw new ProbationError('invalid','Release the authorised signed letter before applying the outcome.');
 if(outcome.state==='completed')return{completed:true};const view=await caseTx(tx,ctx,outcome.caseId),part=view.parts.find(p=>p.id===outcome.partId);if(!part)throw new ProbationError('invalid','Outcome source review unavailable.');
 if(!view.runtimeEnabled||view.sourceMoved||view.sourceChanged||view.record.facts.resignationOn||view.record.facts.terminatedOn)throw new ProbationError('conflict','The current Personnel source requires outcome reconciliation.');
 const automated=await applyAutomatedOutcomeTx(tx,ctx,view,part,outcome);if(automated)return automated;
 let handoff:string|null=null,next:{endOn:string}|null=null,newPart:ProbationPart|null=null;
 if(outcome.outcome==='not_confirm'){const{createProbationOffboardingTx}=await import('../packs/lifecycle/service');handoff=await createProbationOffboardingTx(tx,ctx,view.record.id);}
 else if(outcome.outcome==='confirm'||outcome.outcome==='extend'){
  if(outcome.outcome==='confirm'&&view.record.endOn>todayInKualaLumpur())return{completed:false,waitingOn:view.record.endOn};
  const extension=outcomeExtensionMonths(part,outcome);
  if(outcome.outcome==='extend'){if(extension!==3&&extension!==6)throw new ProbationError('invalid','The actual PBP-approved extension length is required.');const start=addDaysIso(view.record.endOn,1),end=addDaysIso(addCalendarMonths(start,extension),-1);next={endOn:end};const working=new Set(await workingDatesForSpan(tx,view.record.employmentId,addDaysIso(end,-366),addDaysIso(end,366)));const{newProbationPart,probationDueDay}=await import('../lib/probation-model');newPart=newProbationPart(randomUUID(),3,view.record.extensionCount+1,probationDueDay(end,day=>working.has(day),view.record.config.nonWorkingDayRule),view.record.config.issueLeadDays);}
  // I1 (decision 4): with no shared workflow either, Confirm and Extend still create the Personnel posting for the
  // pinned "who approves Personnel postings" group (People Ops when unset) and record the posting effect: the case
  // closes or extends with the posting pending. Only the posting's approval writes the movement, never this path.
  const{probationAutomationContextTx,createProbationOutcomePostingTx}=await import('./probation-automation');
  const context=await probationAutomationContextTx(tx,view.record.id);
  if(!context.postingApproverGroupId){await tx.execute(sql`select app.probation_outcome_failure(${outcome.id}::uuid,'No group is set to approve Personnel postings. Choose one in Probation settings, then record a GBS retry.')`);return{completed:false};}
  const posting=await createProbationOutcomePostingTx(tx,view.record,{id:outcome.id,outcome:outcome.outcome,extensionMonths:extension},context.postingApproverGroupId);
  await tx.execute(sql`select app.probation_record_posting_effect(${outcome.id}::uuid,${posting.id}::uuid,${null}::uuid,${json(next)}::jsonb,${json(newPart)}::jsonb)`);return{completed:true};
 }else throw new ProbationError('invalid','PBP must adjudicate Other before an employment outcome can be applied.');
 await tx.execute(sql`select app.probation_record_effect(${outcome.id}::uuid,${null},${handoff}::uuid,${json(next)}::jsonb,${json(newPart)}::jsonb)`);return{completed:true};
}
export function applyProbationOutcome(ctx:SessionContext,outcomeId:string){return withProbationTenant(ctx,async tx=>{const[row]=await tx.execute<{data:{completed:boolean;queued:boolean}}>(sql`select app.probation_request_outcome_retry(${uuid(outcomeId)}::uuid) as data`);return row.data;});}

export function requestProbationDateShift(ctx:SessionContext,input:{caseId:string;revision:number;newEndOn:string;reason:string}){return withProbationTenant(ctx,async tx=>{const[row]=await tx.execute<{id:string}>(sql`select app.probation_request_date_shift(${uuid(input.caseId)}::uuid,${input.revision},${requireDay(input.newEndOn)}::date,${input.reason}) as id`);return row.id;});}
async function reconcileProbationDatesTx(tx:Tx,ctx:SessionContext,caseId:string,revision:number,reason:string,shiftDays?:number){
 const view=await caseTx(tx,ctx,caseId),facts=view.record.facts;if(view.record.revision!==revision)throw new ProbationError('conflict','The probation record changed.');if(!facts.endOn)throw new ProbationError('invalid','Canonical Personnel probation dates must be confirmed first.');
 const working=new Set(await workingDatesForSpan(tx,view.record.employmentId,addDaysIso(facts.startOn,-366),addCalendarMonths(facts.endOn,12)));
 const{probationDueDay,advanceProbationWorkingDays}=await import('../lib/probation-model');
 const plan=createProbationCase({id:view.record.id,employmentId:view.record.employmentId,companyId:view.record.companyId,sourceKey:view.record.sourceKey,startOn:facts.startOn,endOn:facts.endOn,months:facts.probationMonths??view.record.planMonths,grade:view.record.gradeAtStart,explicitNoProbation:false,config:view.record.config,nextId:randomUUID,isWorking:day=>working.has(day)});if(!plan)throw new ProbationError('invalid','This corrected source is not eligible; PBP must review its disposition.');
 const parts=shiftDays!==undefined?view.parts.filter(p=>p.cycle===view.record.extensionCount).map(p=>({...p,dueOn:probationDueDay(addDaysIso(p.dueOn,shiftDays),day=>working.has(day),view.record.config.nonWorkingDayRule),issueOn:addDaysIso(probationDueDay(addDaysIso(p.dueOn,shiftDays),day=>working.has(day),view.record.config.nonWorkingDayRule),-(p.type===1?0:view.record.config.issueLeadDays))})):plan.parts;
 const priorKpi=view.parts.find(part=>part.type===1&&part.state!=='cancelled'),nextKpi=parts.find(part=>part.type===1);
 const canRescheduleKpi=nextKpi&&(!priorKpi||!priorKpi.managerSubmittedAt&&!['locked','recorded','completed_offline'].includes(priorKpi.state));
 const milestones=nextKpi&&canRescheduleKpi?{
  kpiReminderOn:advanceProbationWorkingDays(facts.startOn,view.record.config.kpiReminderWorkingDay,day=>working.has(day)),
  kpiOverdueOn:advanceProbationWorkingDays(nextKpi.dueOn,1,day=>working.has(day)),
 }:undefined;
 await tx.execute(sql`select app.probation_reconcile_dates(${view.record.id}::uuid,${revision},${JSON.stringify({startOn:facts.startOn,endOn:facts.endOn,planMonths:plan.planMonths,planFlag:plan.planFlag,milestones})}::jsonb,${JSON.stringify(parts.map(p=>({id:p.id,type:p.type,cycle:view.record.extensionCount,dueOn:p.dueOn,issueOn:p.issueOn})))}::jsonb,${reason})`);
}
export function reconcileProbationDates(ctx:SessionContext,input:{caseId:string;revision:number;reason:string}){
 return withProbationTenant(ctx,async tx=>{
  const view=await caseTx(tx,ctx,input.caseId);
  if(!view.canReconcileDates)throw new ProbationError('forbidden','This case does not have an actionable Personnel schedule change.');
  await tx.execute(sql`select app.probation_request_schedule_reconciliation(${uuid(input.caseId)}::uuid,${input.revision},${input.reason})`);
  return{queued:true as const};
 });
}
async function applyProbationDateShiftOwnerTx(tx:Tx,ctx:SessionContext,input:{caseId:string;requestId:string;revision:number}){
 const[request]=await tx.execute<{old_end:string;new_end:string;appliedAt:string|null}>(sql`select old_end::text,new_end::text,applied_at::text as "appliedAt" from probation_date_adjustment where id=${input.requestId}::uuid and case_id=${input.caseId}::uuid and tenant_id=${ctx.tenantId}::uuid`);if(!request)throw new ProbationError('forbidden','Date adjustment unavailable.');if(request.appliedAt)return{alreadyApplied:true};
 const{applyApprovedProbationDateShiftTx}=await import('./movement');await applyApprovedProbationDateShiftTx(tx,ctx,input.requestId);const days=Math.round((Date.parse(request.new_end+'T00:00:00Z')-Date.parse(request.old_end+'T00:00:00Z'))/86400000);await reconcileProbationDatesTx(tx,ctx,input.caseId,input.revision,'Apply approved canonical long-leave date shift',days);await tx.execute(sql`select app.probation_finish_date_shift(${input.requestId}::uuid)`);return{alreadyApplied:false};
}
export function applyProbationDateShift(ctx:SessionContext,input:{caseId:string;requestId:string;revision:number}){return withProbationTenant(ctx,async tx=>{const[row]=await tx.execute<{data:{alreadyApplied:boolean;queued:boolean;requestId?:string}}>(sql`select app.probation_queue_date_shift(${uuid(input.requestId)}::uuid,${uuid(input.caseId)}::uuid,${input.revision}) as data`);return row.data;});}

/** Probation navigation: the installed owner (2252) plus what Probation access roles add (5763), including the Access page. */
export function probationNavigationAccess(ctx:SessionContext):Promise<{page:boolean;configure:boolean;intake:boolean;access:boolean}>{if(ctx.entitlementsExempt===undefined&&!isModuleEnabled(ctx,'lifecycle')&&!ctx.entitlements?.scopedModules.lifecycle?.some(company=>isModuleEnabled(ctx,'lifecycle',company)))return Promise.resolve({page:false,configure:false,intake:false,access:false});return withProbationTenant(ctx,async tx=>{const[row]=await tx.execute<{access:{page:boolean;configure:boolean;intake:boolean};roles:{configure:boolean;intake:boolean;access:boolean}}>(sql`select app.probation_navigation_access() as access,app.probation_access_navigation() as roles`);const configure=row.access.configure||row.roles.configure;return{page:row.access.page||configure,configure,intake:row.access.intake||row.roles.intake,access:row.roles.access};});}

export function probationSignerCandidates(ctx:SessionContext,caseId:string,search=''){return withProbationTenant(ctx,tx=>tx.execute<{id:string;name:string}>(sql`select * from app.probation_signer_candidates(${uuid(caseId)}::uuid,${search.slice(0,100)})`));}
export type ProbationInbox={count:number;items:{caseId:string;partId:string;employeeName:string;kind:string;href:string}[]};
/** Whether Probation work can exist for this caller: Lifecycle on for the tenant or for any scoped company (throws like isModuleEnabled). */
export function probationModuleOn(ctx:SessionContext):boolean{return ctx.entitlementsExempt!==undefined||isModuleEnabled(ctx,'lifecycle')||!!ctx.entitlements?.scopedModules.lifecycle?.some(company=>isModuleEnabled(ctx,'lifecycle',company));}
export function probationInbox(ctx:SessionContext):Promise<ProbationInbox>{if(!probationModuleOn(ctx))return Promise.resolve({count:0,items:[]});return withProbationTenant(ctx,async tx=>{const[row]=await tx.execute<{data:ProbationInbox}>(sql`select app.probation_inbox() as data`);return row.data;});}
/** One current Probation task of the caller, as the case view offers it (app.probation_task_list, migration 5751). */
export type ProbationTaskItem={caseId:string;partId:string;companyId:string;employeeName:string;kind:string;category:'approval'|'task';href:string;dueOn:string|null;updatedAt:string;partType:string|null};
/** `capped`: more than 200 candidates exist; the screens link to the tracker filtered to the caller's work. */
export type ProbationTaskList={count:number;capped:boolean;items:ProbationTaskItem[]};
/** The caller's current Probation work, bounded (at most 200 confirmed, `limit` returned) and set-based. */
export function probationTaskList(ctx:SessionContext,options:{category?:'approval'|'task';limit?:number;companyIds?:readonly string[]}={}):Promise<ProbationTaskList>{
 if(!probationModuleOn(ctx))return Promise.resolve({count:0,capped:false,items:[]});
 const limit=Math.max(1,Math.min(200,Math.floor(options.limit??200)));
 return withProbationTenant(ctx,async tx=>{
  const[row]=await tx.execute<{data:ProbationTaskList}>(sql`select app.probation_task_list(${options.category??null}::text,${limit}::integer) as data`);
  const data=row.data;
  if(!options.companyIds)return data;
  const companies=new Set(options.companyIds),items=data.items.filter(item=>companies.has(item.companyId));
  return {count:items.length,capped:data.capped,items};
 });
}
/** The kind of task label for one Probation task in the shared task list (lib/assigned-work.ts PACK_TASK_KINDS). */
const probationPackKind=(item:ProbationTaskItem)=>item.category==='approval'?'probationApproval' as const:'probationTask' as const;
/**
 * WP-A1 provider for Probation (core/approvals-inbox.ts PACK_TASK_SOURCES): the caller's Approve steps and other
 * Probation tasks, each linking to the case view, which authorizes again. createdAt is the part's last change.
 */
export async function pendingProbationTasks(ctx:SessionContext,scopeIds:string[]|undefined):Promise<import('../lib/assigned-work').PackTaskItem[]>{
 const list=await probationTaskList(ctx,{companyIds:scopeIds});
 // L5: the step code and part name the task on /tasks ("Sign probation letter"), never a generic "Probation task".
 return list.items.map(item=>({id:item.partId,kind:probationPackKind(item),subjectName:item.employeeName,createdAt:new Date(item.updatedAt).toISOString(),linkPath:item.href,action:{code:item.kind,part:item.partType===null||item.partType===undefined?null:Number(item.partType)||null}}));
}

async function sealProbationRenderTx(tx:Tx,ctx:SessionContext,requestId:string):Promise<'sealed'|'held'|'paused'>{
 const[row]=await tx.execute<{data:{sealed?:boolean;held?:boolean;paused?:boolean;kind:'review'|'letter';partId:string;caseId:string;contentHash:string;data:Record<string,unknown>}}>(sql`select app.probation_owner_render_context(${requestId}::uuid) as data`);const context=row.data;if(context.paused)return'paused';if(context.held)return'held';if(context.sealed)return'sealed';
 let bytes:Buffer;
 if(context.kind==='review'){
  const snapshot=context.data as unknown as {record:ProbationCase&{facts:ProbationPersonnel};part:ProbationPart&{signingFacts:ProbationPersonnel;signingPeriod:{startOn:string;endOn:string;gradeAtStart:string};signingKpis:ProbationPart['kpis']};form:ProbationForm;employee:Partial<ProbationPart>;manager:Partial<ProbationPart>;signing:SigningDocument;signingId:string;partContentRevision:number};
  const blank=()=>Object.fromEntries(snapshot.form.criteria.map(c=>[c.id,{rating:null,evidence:''}]));
  const part={...snapshot.part,...snapshot.employee,...snapshot.manager,employee:snapshot.part.staffSubmittedAt?snapshot.employee.employee??blank():blank(),manager:snapshot.manager.manager??blank(),kpis:snapshot.manager.kpis??[],support:snapshot.manager.support??{coaching:'',access:'',checkins:'',other:''},employeeComments:snapshot.employee.employeeComments??'',strengths:snapshot.manager.strengths??'',development:snapshot.manager.development??'',managerComments:snapshot.manager.managerComments??'',outcome:snapshot.manager.outcome??null,midpointStatus:snapshot.manager.midpointStatus??null,justification:snapshot.manager.justification??'',extensionMonths:snapshot.manager.extensionMonths??null,allowedCommands:[],storageRevision:snapshot.part.revision,contentRevision:snapshot.partContentRevision,submittedFacts:snapshot.part.signingFacts,submittedPeriod:snapshot.part.signingPeriod,acknowledgedKpis:snapshot.part.signingKpis,selfVisible:true,managerVisible:true,signing:{id:snapshot.signingId,document:snapshot.signing},canEditEmployee:false,canEditSelfAssessment:false,canEditEmployeeComments:false,canEditManager:false,managerIssues:[],employeeIssues:[],route:snapshot.signing.route} as ProbationPartView;
  const view:ProbationCaseView={runtimeEnabled:false,sourceMoved:false,canRequestDateShift:false,record:{...snapshot.record,parts:[part]},parts:[part],form:snapshot.form,roles:[],files:[],followups:[],outcomes:[],holderNames:{},sourceChanged:false,dateAdjustments:[],letterTasks:[]};const{renderProbationPartPdf}=await import('./probation-pdf');bytes=await renderProbationPartPdf(view,part);
 }else{
  const snapshot=context.data as unknown as {part:{letterTemplateName?:string;letterTemplateId:string;letterTemplateVersion:number;letterBlocks:import('../lib/lifecycle-v9-model').Block[];letterFields:import('../lib/lifecycle-v9-model').Field[];letterMerge:Record<string,string>};signing:SigningDocument;createdAt:string};
  const{probationLetterDocument}=await import('../lib/probation-letter-document'),{renderProbationLetterPdf}=await import('./probation-letter');const document=probationLetterDocument({id:context.partId,name:snapshot.part.letterTemplateName??'Probation outcome letter',templateId:snapshot.part.letterTemplateId,templateVersion:snapshot.part.letterTemplateVersion,blocks:snapshot.part.letterBlocks,fields:snapshot.part.letterFields,merge:snapshot.part.letterMerge,createdAt:snapshot.createdAt,signing:snapshot.signing});bytes=await renderProbationLetterPdf(document,snapshot.signing,'Probation outcome · '+context.partId);
 }
 const[sealed]=await tx.execute<{id:string|null}>(sql`select app.probation_owner_seal_render(${requestId}::uuid,${context.contentHash},${bytes}) as id`);
 // W3: "A letter is signed and released" for shared workflows, once per letter.
 if(sealed.id&&context.kind==='letter'){const{emitProbationEventsSafelyTx}=await import('./probation-automation');await emitProbationEventsSafelyTx(tx,ctx,context.caseId,[{trigger:'letterReleased',occurrence:context.partId,facts:{partId:context.partId,letter:{name:(context.data as {part?:{letterTemplateName?:string}}).part?.letterTemplateName??null}}}]);}
 return sealed.id?'sealed':'held';
}


export function supersedeProbationDateShift(ctx:SessionContext,input:{caseId:string;requestId:string;revision:number;reason:string}){return withProbationTenant(ctx,async tx=>{await tx.execute(sql`select app.probation_supersede_date_shift(${uuid(input.caseId)}::uuid,${uuid(input.requestId)}::uuid,${input.revision},${input.reason})`);});}

export type ProbationPublicationKind='form'|'workflow'|'template';
export function probationPublicationRetirement(ctx:SessionContext,input:{companyId:string;kind:ProbationPublicationKind;versionId:string}){
 return withProbationTenant(ctx,async tx=>{
  companyGate(ctx,input.companyId);
  const [row]=await tx.execute<{data:{canRetire:boolean;expectedVersion:number}}>(sql`select app.probation_publication_retirement(${uuid(input.companyId)}::uuid,${input.kind},${uuid(input.versionId)}::uuid) as data`);
  return row.data;
 });
}
export function retireProbationPublication(ctx:SessionContext,input:{companyId:string;kind:ProbationPublicationKind;versionId:string;expectedVersion:number;reason:string}){
 return withProbationTenant(ctx,async tx=>{
  companyGate(ctx,input.companyId);
  const [row]=await tx.execute<{data:{id:string;version:number}}>(sql`select app.probation_retire_publication(${uuid(input.companyId)}::uuid,${input.kind},${uuid(input.versionId)}::uuid,${input.expectedVersion},${input.reason}) as data`);
  return row.data;
 });
}
