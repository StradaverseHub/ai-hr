import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {withLifecycleTenant} from './module-gate';
import {workingDatesForSpan} from './leave';
import {todayInKualaLumpur,addCalendarMonths} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {isCalendarDate} from '../lib/calendar-date';
import {DEFAULT_PROBATION_CONFIG,createProbationCase,editProbationPart,managerSubmissionIssues,probationRoute,type ProbationCase,type ProbationPart,type ProbationConfig,type ProbationRole,ProbationError} from '../lib/probation-model';
import {DEFAULT_PROBATION_FORM,validateProbationForm,scoreProbationForm,probationFormIssues,type ProbationForm} from '../lib/probation-form';
import {pendingSigningSteps,signingComplete,type SigningRoute,type SigningDocument,type SigningGuardrails} from '../lib/document-signing-model';
import {createSigningDocumentTx,readSigningDocumentTx,recordDocumentSigningActionTx,reviseSigningDocumentTx,replaceDocumentSignerTx,declineDocumentAcknowledgementTx} from '../packs/document-signing/service';
export {DEFAULT_PROBATION_CONFIG,DEFAULT_PROBATION_FORM};
export type {ProbationCase,ProbationPart,ProbationConfig,ProbationRole,ProbationForm};
const uuid=(value:string)=>{if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value))throw new ProbationError('invalid','Choose a valid probation record.');return value;};
const json=(value:unknown)=>JSON.stringify(value);
const requireDay=(value:string)=>{if(!isCalendarDate(value))throw new ProbationError('invalid','Enter a valid calendar date.');return value;};
export type ProbationPersonnel={employmentId:string;personId:string;companyId:string;employeeName:string;employeeCode:string|null;companyName:string;startOn:string;endOn:string|null;grade:string;gradeId:string|null;currentGradeId:string|null;employmentType:string;probationMonths:number|null;probationUnit:string|null;probationValue:number|null;explicitNoProbation:boolean;unknownPeriod:boolean;confirmationOn:string|null;resignationOn:string|null;terminatedOn:string|null;departmentId:string|null;businessUnitId:string|null;department:string|null;businessUnit:string|null;title:string|null;division:string|null;holders:Record<'employee'|'lm'|'hod'|'pbp',string|null>};
type Version<T>={id:string;version:number;data:T};
export type ProbationRouteConfiguration={version:number;parts:Record<'1'|'2'|'3',SigningRoute>;rules?:{businessUnitId?:string;grade?:string;part:1|2|3;outcome?:string;route:SigningRoute}[]};
export type ProbationSettings=ProbationConfig&{overrides?:{businessUnitId?:string;grade?:string;months?:number;kpiGate:'block'|'warn'|'off'}[]};
export type ProbationSetup={settings:Version<ProbationSettings>|null;form:Version<ProbationForm>|null;route:Version<ProbationRouteConfiguration>|null;canConfigure:boolean;enabled:boolean;activationOn:string|null};
export type ProbationPartView=ProbationPart&{storageRevision:number;contentRevision:number;selfVisible:boolean;managerVisible:boolean;signing:{id:string;document:SigningDocument}|null;canEditEmployee:boolean;canEditManager:boolean;managerIssues:string[];employeeIssues:string[];route:SigningRoute};
export type ProbationCaseView={record:ProbationCase&{facts:ProbationPersonnel};parts:ProbationPartView[];form:ProbationForm;roles:ProbationRole[];files:{id:string;kind:string;name:string;partId:string|null;revision:number}[];followups:{id:string;kind:string;note:string;at:string;actorId:string}[];outcomes:ProbationOutcomeView[]};
export type ProbationOutcomeView={id:string;partId:string;outcome:string;state:string;revision:number;letterFileId:string|null;releasedAt:string|null;failure:string|null;sourceKey:string};
async function sourceTx(tx:Tx,id:string){const[row]=await tx.execute<{data:ProbationPersonnel}>(sql`select app.probation_personnel_source(${uuid(id)}::uuid) as data`);if(!row?.data)throw new ProbationError('forbidden','The employee is unavailable for probation.');return row.data;}
async function setupTx(tx:Tx,ctx:SessionContext,companyId:string):Promise<ProbationSetup>{
 const rows=await tx.execute<Version<ProbationSettings|ProbationForm|ProbationRouteConfiguration>&{kind:string}>(sql`select distinct on(kind) id,version,kind,data from probation_configuration where tenant_id=${ctx.tenantId}::uuid and company_id=${uuid(companyId)}::uuid and state='published' order by kind,version desc`);
 const [access]=await tx.execute<{ok:boolean}>(sql`select app.probation_config_admin(${companyId}::uuid) as ok`);
 const [activation]=await tx.execute<{enabled:boolean;activation_on:string|null}>(sql`select enabled,activation_on::text from probation_activation where tenant_id=${ctx.tenantId}::uuid and company_id=${companyId}::uuid`);
 return{settings:rows.find(r=>r.kind==='settings') as Version<ProbationSettings>??null,form:rows.find(r=>r.kind==='form') as Version<ProbationForm>??null,route:rows.find(r=>r.kind==='route') as Version<ProbationRouteConfiguration>??null,canConfigure:!!access?.ok,enabled:!!activation?.enabled,activationOn:activation?.activation_on??null};
}
export function probationSetup(ctx:SessionContext,companyId:string){return withLifecycleTenant(ctx,tx=>setupTx(tx,ctx,companyId));}
export function bootstrapProbationPreparer(ctx:SessionContext,input:{companyId:string;userId:string;reason:string}){return withLifecycleTenant(ctx,async tx=>{const[row]=await tx.execute<{id:string}>(sql`select app.probation_bootstrap_admin(${uuid(input.companyId)}::uuid,${uuid(input.userId)}::uuid,${input.reason}) as id`);return row.id;});}
export function assignProbationAccess(ctx:SessionContext,input:{companyId:string;userId:string;role:'admin'|'pbp'|'gbs';validFrom:string;validTo:string|null;businessUnitId?:string|null;departmentId?:string|null;reason:string}){return withLifecycleTenant(ctx,async tx=>{const[row]=await tx.execute<{id:string}>(sql`select app.probation_assign_access(${uuid(input.companyId)}::uuid,${uuid(input.userId)}::uuid,${input.role},${requireDay(input.validFrom)}::date,${input.validTo?requireDay(input.validTo):null}::date,${input.businessUnitId?uuid(input.businessUnitId):null}::uuid,${input.departmentId?uuid(input.departmentId):null}::uuid,${input.reason}) as id`);return row.id;});}
export function saveProbationConfiguration(ctx:SessionContext,input:{companyId:string;kind:'settings'|'form'|'route';data:ProbationSettings|ProbationForm|ProbationRouteConfiguration;publish:boolean}){return withLifecycleTenant(ctx,async tx=>{
 if(input.kind==='settings'){const{validateProbationConfig}=await import('../lib/probation-model');validateProbationConfig(input.data as ProbationSettings);}
 if(input.kind==='form')validateProbationForm(input.data as ProbationForm);
 const[row]=await tx.execute<{id:string}>(sql`select app.probation_config_write(${uuid(input.companyId)}::uuid,${input.kind},${json(input.data)}::jsonb,${input.publish}) as id`);return row.id;
});}
export function defaultProbationRoutes():ProbationRouteConfiguration{const holders={employee:null,lm:null,hod:null,pbp:null,gbs:null};return{version:1,parts:{'1':probationRoute(1,holders),'2':probationRoute(2,holders),'3':probationRoute(3,holders)}};}
export async function installProbationDrafts(ctx:SessionContext,companyId:string){
 for(const[kind,data]of [['settings',DEFAULT_PROBATION_CONFIG],['form',DEFAULT_PROBATION_FORM],['route',defaultProbationRoutes()]]as const)await saveProbationConfiguration(ctx,{companyId,kind,data,publish:false});
}
export function probationIntakeCandidates(ctx:SessionContext,companyId:string){return withLifecycleTenant(ctx,async tx=>{
 const[access]=await tx.execute<{ok:boolean}>(sql`select app.probation_config_admin(${uuid(companyId)}::uuid) as ok`);if(!access?.ok)throw new ProbationError('forbidden','Named probation preparer access is required.');
 const ids=await tx.execute<{id:string}>(sql`select id from employment e where tenant_id=${ctx.tenantId}::uuid and company_id=${companyId}::uuid and not exists(select 1 from probation_case c where c.employment_id=e.id and c.tenant_id=e.tenant_id) order by employee_code,id limit 1000`);
 return Promise.all(ids.map(r=>sourceTx(tx,r.id)));
});}
async function admitTx(tx:Tx,ctx:SessionContext,employmentId:string,reason:string){
 const source=await sourceTx(tx,employmentId),setup=await setupTx(tx,ctx,source.companyId);
 if(!setup.settings||!setup.form||!setup.route)throw new ProbationError('invalid','Publish probation settings, form and routes before intake.');
 if(source.confirmationOn||source.resignationOn||source.terminatedOn||source.employmentType!=='full_time'||source.explicitNoProbation)return null;
 const calendarEnd=source.endOn??addDaysIso(addCalendarMonths(source.startOn,setup.settings.data.defaultMonths),-1);
 const calendar=new Set(await workingDatesForSpan(tx,employmentId,addDaysIso(source.startOn,-366),addCalendarMonths(calendarEnd,12)));
 const exactMonths=source.endOn?[...Array(120)].map((_,i)=>i+1).find(n=>addDaysIso(addCalendarMonths(source.startOn,n),-1)===source.endOn):undefined;
 const months=source.unknownPeriod?null:source.probationMonths??exactMonths??1;
 const unknownLength=!source.unknownPeriod&&source.probationMonths===null&&exactMonths===undefined;
 const config=structuredClone(setup.settings.data);
 const record=createProbationCase({id:randomUUID(),employmentId,companyId:source.companyId,sourceKey:'employment:'+employmentId,startOn:source.startOn,endOn:source.endOn,months,grade:source.grade,explicitNoProbation:false,unknownLength,config,nextId:randomUUID,isWorking:day=>calendar.has(day)});
 if(!record)return null;
 const [row]=await tx.execute<{id:string}>(sql`select app.probation_admit(${json({...record,facts:source})}::jsonb,${json(record.parts)}::jsonb,${setup.settings.id}::uuid,${setup.form.id}::uuid,${setup.route.id}::uuid,${reason}) as id`);return row.id;
}
export function admitProbation(ctx:SessionContext,input:{employmentId:string;reason:string}){return withLifecycleTenant(ctx,tx=>admitTx(tx,ctx,uuid(input.employmentId),input.reason));}
async function rolesTx(tx:Tx,employmentId:string):Promise<ProbationRole[]>{
 const roles:ProbationRole[]=[];for(const role of ['employee','lm','hod','pbp','gbs']as const){const[row]=await tx.execute<{ok:boolean}>(sql`select app.probation_role(${employmentId}::uuid,${role}) as ok`);if(row?.ok)roles.push(role);}return roles;
}
async function caseTx(tx:Tx,ctx:SessionContext,id:string,lock=false):Promise<ProbationCaseView>{
 void lock; // Native commands lock part -> case; a read must not invert that order.
 const[row]=await tx.execute<{id:string;employment_id:string;form_id:string;revision:number;data:Omit<ProbationCase,'parts'>&{facts:ProbationPersonnel}}>(sql`select id,employment_id,form_id,revision,data from probation_case where id=${uuid(id)}::uuid and tenant_id=${ctx.tenantId}::uuid`);
 if(!row)throw new ProbationError('forbidden','This probation case is unavailable in your current scope.');
 const[version]=await tx.execute<{data:ProbationForm}>(sql`select data from probation_configuration where id=${row.form_id}::uuid and tenant_id=${ctx.tenantId}::uuid`);if(!version)throw new ProbationError('invalid','The pinned probation form is unavailable.');
 const roles=await rolesTx(tx,row.employment_id),metadata=await tx.execute<{id:string;revision:number;content_revision:number;data:Omit<ProbationPart,'employee'|'manager'> & {documentKind?:string;route:SigningRoute}}>(sql`select id,revision,content_revision,data from probation_part where case_id=${row.id}::uuid and tenant_id=${ctx.tenantId}::uuid and coalesce(data->>'documentKind','review')='review' order by (data->>'cycle')::integer,(data->>'type')::integer,id`);
 const ids=metadata.map(r=>r.id),drafts=ids.length?await tx.execute<{part_id:string;rater:'employee'|'lm';data:Partial<ProbationPart>}>(sql`select part_id,rater,data from probation_rater_draft where tenant_id=${ctx.tenantId}::uuid and part_id=any(array[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`):[];
 const signatures=ids.length?await tx.execute<{id:string;subject_id:string;data:SigningDocument}>(sql`select id,subject_id,data from document_signing_document where tenant_id=${ctx.tenantId}::uuid and subject_type='probation' and subject_id=any(array[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`):[];
 const blank=()=>Object.fromEntries(version.data.criteria.map(c=>[c.id,{rating:null,evidence:''}]));
 const parts:ProbationPartView[]=metadata.map(p=>{
  const self=drafts.find(d=>d.part_id===p.id&&d.rater==='employee'),manager=drafts.find(d=>d.part_id===p.id&&d.rater==='lm'),stored=signatures.find(d=>d.subject_id===p.id);
  const part={...p.data,...self?.data,...manager?.data,employee:self?.data.employee??blank(),manager:manager?.data.manager??blank(),kpis:manager?.data.kpis??[],support:manager?.data.support??{coaching:'',access:'',checkins:'',other:''},employeeComments:self?.data.employeeComments??'',strengths:manager?.data.strengths??'',development:manager?.data.development??'',managerComments:manager?.data.managerComments??'',outcome:manager?.data.outcome??null,midpointStatus:manager?.data.midpointStatus??null,justification:manager?.data.justification??'',extensionMonths:manager?.data.extensionMonths??null,revision:p.revision} as ProbationPart;
  const open=!['not_issued','locked','recorded','completed_offline','cancelled'].includes(part.state)&&row.data.state!=='withdrawn';
  const managerIssues=part.type===1?managerSubmissionIssues(part,{...row.data,parts:[]} as ProbationCase):[...probationFormIssues(version.data,part.manager,!row.data.kpiAcknowledged&&row.data.config.kpiGate==='warn'),...(!part.reviewOn?['review_date']:[]),...(!part.conductedBy?['conducted_by']:[]),...(row.data.config.lmWaitsForEmployee&&!part.staffSubmittedAt&&!part.employeeWaitException?['employee_submission']:[]),...(part.type===2?[...(!part.strengths.trim()?['strengths']:[]),...(!part.development.trim()?['development']:[]),...(!part.managerComments.trim()?['manager_comments']:[]),...(!part.midpointStatus?['midpoint_status']:[])]:[...(!part.outcome?['outcome']:[]),...(!part.justification.trim()?['justification']:[]),...(part.outcome==='extend'&&(![3,6].includes(part.extensionMonths??0)||row.data.extensionCount>=2)?['extension']:[])])];
  const score=scoreProbationForm(version.data,part.manager);if(score){const suggestion=part.type===2?(score.band>=3?'satisfactory':score.band===2?'development':'at_risk'):(score.band>=3?'confirm':score.band===2?'extend':'not_confirm');if((part.type===2?part.midpointStatus:part.outcome)&&suggestion!==(part.type===2?part.midpointStatus:part.outcome)&&!part.justification.trim())managerIssues.push('override_justification');}
  return{...part,route:p.data.route,storageRevision:p.revision,contentRevision:p.content_revision,selfVisible:!!self,managerVisible:!!manager,signing:stored?{id:stored.id,document:stored.data}:null,canEditEmployee:open&&roles.includes('employee')&&!part.acknowledgedAt&&(!part.staffSubmittedAt||!!part.managerSubmittedAt),canEditManager:open&&roles.includes('lm')&&!part.managerSubmittedAt&&(part.type===1||!!part.staffSubmittedAt||!!part.employeeWaitException),managerIssues:[...new Set(managerIssues)],employeeIssues:part.type===1?[]:probationFormIssues(version.data,part.employee)};
 });
 const files=await tx.execute<{id:string;kind:string;name:string;partId:string|null;revision:number}>(sql`select id,kind,name,part_id as "partId",revision from probation_file where case_id=${row.id}::uuid and tenant_id=${ctx.tenantId}::uuid order by created_at,id`);
 const followups=await tx.execute<{id:string;kind:string;note:string;at:string;actorId:string}>(sql`select id,kind,note,created_at::text as at,actor_user_id as "actorId" from probation_followup where case_id=${row.id}::uuid and tenant_id=${ctx.tenantId}::uuid order by created_at desc,id desc`);
 const outcomes=await tx.execute<ProbationOutcomeView>(sql`select id,part_id as "partId",outcome,state,revision,letter_file_id as "letterFileId",released_at::text as "releasedAt",failure,source_key as "sourceKey" from probation_outcome where case_id=${row.id}::uuid and tenant_id=${ctx.tenantId}::uuid order by revision desc,id`);
 return{record:{...row.data,facts:await sourceTx(tx,row.employment_id),revision:row.revision,parts},parts,form:version.data,roles,files:[...files],followups:[...followups],outcomes:[...outcomes]};
}
export function probationCase(ctx:SessionContext,id:string){return withLifecycleTenant(ctx,tx=>caseTx(tx,ctx,id));}
export function probationCases(ctx:SessionContext){return withLifecycleTenant(ctx,async tx=>{
 const ids=await tx.execute<{id:string}>(sql`select id from probation_case where tenant_id=${ctx.tenantId}::uuid order by (data->>'endOn')::date,id limit 1000`);
 return Promise.all(ids.map(r=>caseTx(tx,ctx,r.id)));
});}
export function saveProbationDraft(ctx:SessionContext,input:{caseId:string;partId:string;revision:number;rater:'employee'|'lm';patch:Partial<ProbationPart>}){return withLifecycleTenant(ctx,async tx=>{
 const view=await caseTx(tx,ctx,input.caseId,true),part=view.parts.find(p=>p.id===input.partId);if(!part)throw new ProbationError('invalid','Review unavailable.');
 editProbationPart(view.record,part.id,input.rater,input.patch);
 const[row]=await tx.execute<{revision:number}>(sql`select app.probation_save_draft(${part.id}::uuid,${input.rater},${json(input.patch)}::jsonb,${input.revision}) as revision`);return row.revision;
});}
async function signingTx(tx:Tx,ctx:SessionContext,view:ProbationCaseView,part:ProbationPartView){
 const[source]=await tx.execute<{data:{contentHash:string;contentRevision:number}}>(sql`select app.probation_signing_content(${part.id}::uuid) as data`);
 const[routes]=await tx.execute<{route:SigningRoute}>(sql`select app.probation_resolved_route(${part.id}::uuid) as route`);
 const[rules]=await tx.execute<{rules:SigningGuardrails}>(sql`select app.probation_signing_guardrails(${part.id}::uuid) as rules`);
 if(!source?.data||!routes?.route||!rules?.rules)throw new ProbationError('invalid','The current signing route is unavailable.');
 let stored=part.signing;
 if(!stored)stored=await createSigningDocumentTx(tx,ctx,{companyId:view.record.companyId,employmentId:view.record.employmentId,subjectId:part.id,subjectType:'probation',contentHash:source.data.contentHash,route:routes.route,guardrails:rules.rules}).then(r=>({id:r.id,document:r.document}));
 else{
  if(stored.document.contentHash!==source.data.contentHash)stored={id:stored.id,document:await reviseSigningDocumentTx(tx,ctx,{id:stored.id,hash:source.data.contentHash,reason:'New owner-authored probation content revision'})};
  for(const step of routes.route.steps){const old=stored.document.route.steps.find(s=>s.id===step.id);if(old&&step.holderId&&old.holderId!==step.holderId)stored={id:stored.id,document:await replaceDocumentSignerTx(tx,ctx,{id:stored.id,stepId:step.id,holderId:step.holderId,reason:'Current role holder or recorded delegate changed',kind:step.representedId?'delegation':'holder_changed'})};}
 }
 return stored;
}
export function actOnProbation(ctx:SessionContext,input:{caseId:string;partId:string;revision:number;command:'submit_employee'|'submit_manager'|'acknowledge'|'approve'|'return'|'record'|'unlock'|'kpi_exception'|'employee_wait_exception'|'confirm_extension'|'request_refusal'|'confirm_refusal';reason?:string;months?:number;owner?:'employee'|'lm';stepId?:string;method?:'typed'|'drawn';value?:string;consent?:boolean;actionId?:string}){return withLifecycleTenant(ctx,async tx=>{
 const view=await caseTx(tx,ctx,input.caseId,true),part=view.parts.find(p=>p.id===input.partId);if(!part||part.revision!==input.revision)throw new ProbationError('conflict','The review changed. Read its current revision before acting.');
 if(['submit_manager','acknowledge','approve','return','confirm_refusal'].includes(input.command)){
  const stored=await signingTx(tx,ctx,view,part),pending=pendingSigningSteps(stored.document);
  const step=input.stepId?pending.find(s=>s.id===input.stepId):pending.find(s=>s.holderId===ctx.userId);
  if(input.command==='confirm_refusal'){
   const ack=stored.document.route.steps.find(s=>s.role==='employee'&&s.kind==='acknowledge');if(!ack)throw new ProbationError('invalid','Employee acknowledgement is missing.');
   await declineDocumentAcknowledgementTx(tx,ctx,{id:stored.id,stepId:ack.id,reason:input.reason??''});
  }else{
   if(!step)throw new ProbationError('forbidden','Only the currently assigned pending signer may act.');
   await recordDocumentSigningActionTx(tx,ctx,{id:stored.id,stepId:step.id,revision:stored.document.contentRevision,hash:stored.document.contentHash,action:input.command==='return'?'returned':'signed',comment:input.command==='acknowledge'?part.employeeComments:input.reason,method:input.method,value:input.value,consent:input.consent,actionId:input.actionId});
  }
 }
 if(input.command==='approve')return{revision:part.revision};
 const[row]=await tx.execute<{revision:number}>(sql`select app.probation_part_command(${part.id}::uuid,${part.revision},${input.command},${json({reason:input.reason,months:input.months,owner:input.owner})}::jsonb) as revision`);
 return{revision:row.revision};
});}
export function logProbationFollowup(ctx:SessionContext,input:{caseId:string;partId?:string|null;kind:'followup'|'development'|'extension_recommendation'|'nonconfirmation_recommendation';note:string}){return withLifecycleTenant(ctx,async tx=>{const[row]=await tx.execute<{id:string}>(sql`select app.probation_followup_add(${uuid(input.caseId)}::uuid,${input.partId?uuid(input.partId):null}::uuid,${input.kind},${input.note}) as id`);return row.id;});}
export function overrideProbationRoute(ctx:SessionContext,input:{partId:string;revision:number;route:SigningRoute;reason:string}){return withLifecycleTenant(ctx,async tx=>{await tx.execute(sql`select app.probation_route_override(${uuid(input.partId)}::uuid,${json(input.route)}::jsonb,${input.reason},${input.revision})`);});}
export function replaceProbationSigner(ctx:SessionContext,input:{partId:string;stepId:string;holderId:string;kind:'delegation'|'holder_changed'|'missing_holder';validFrom:string;validTo:string|null;reason:string}){return withLifecycleTenant(ctx,async tx=>{await tx.execute(sql`select app.probation_delegate_add(${uuid(input.partId)}::uuid,${input.stepId},${uuid(input.holderId)}::uuid,${input.kind},${requireDay(input.validFrom)}::date,${input.validTo?requireDay(input.validTo):null}::date,${input.reason})`);});}
