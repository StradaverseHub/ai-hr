// Moving notify-only Probation workflows to the shared engine, exactly (lane G2, migration 5757). For every event the
// catalogue marks exact, the old engine's own planner (app.probation_workflow_plan) and words (the 0949 notice words,
// rendered with lib/probation-workflow.ts) are compared with what the converted shared workflow sends on the same case
// at each stage: recipients, subject and body. "Move to shared workflows" is idempotent and audited, and a moved
// definition never notifies a case twice. Fictional people only.
import {automationBusinessPartnerWorkspace,saveAutomationBusinessPartners} from '../packs/automation/service';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {hireEmployee,setReportingLine} from '../core/org';
import {adminCtx,closeAll,createAppUser,setModule,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {newProbationPart} from '../lib/probation-model';
import {todayInKualaLumpur} from '../lib/hr-date';
import {withTenant,type SessionContext} from '../db/client';
import {renderProbationWords,type ProbationWorkflow,type ProbationWorkflowEvent} from '../lib/probation-workflow';
import {convertProbationLegacyWorkflow} from '../lib/automation/probation-legacy';
import {PROBATION_AUTOMATION_CATALOGUE} from '../lib/automation/catalogues/probation';
import {probationNotifyPreviewTx,probationAutomationCaseTx} from '../core/probation-automation';
import {probationCase,saveProbationDraft,actOnProbation,moveProbationWorkflowsToShared,DEFAULT_PROBATION_CONFIG,DEFAULT_PROBATION_FORM,defaultProbationRoutes} from '../packs/probation/service';

let b:Base,admin:SessionContext;
async function saveBusinessPartners(rules:Parameters<typeof saveAutomationBusinessPartners>[1]['rules']){
 const current=await automationBusinessPartnerWorkspace(admin);
 if(!current)throw Error('The actual fixture administrator cannot configure Business Partner responsibilities.');
 await saveAutomationBusinessPartners(admin,{expectedRevision:current.revision,rules,reason:'Reviewed fictional Contract and Probation Business Partner responsibilities'});
}

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);});

async function person(name:string){
 const e=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@probation.example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
 const userId=await createAppUser(b.tenantId,e.personId,'employee');
 return{...e,userId,ctx:{...admin,userId,personId:e.personId,roles:['employee'],grants:undefined} as SessionContext};
}
const assessment=Object.fromEntries(DEFAULT_PROBATION_FORM.criteria.map(c=>[c.id,{rating:4,evidence:'Observed fictional evidence for this criterion'}]));
const TO=['employee','lm','hod','pbp','gbs'] as const;
const legacy=(event:ProbationWorkflowEvent,id=randomUUID()):ProbationWorkflow=>({id,name:'Fictional '+event,module:'probation',status:'published',description:'',trigger:{event},conditions:{},
 steps:[{id:'s1',type:'notify',subject:'Part {{part}} for {{employeeName}} ({{ employeeCode }})',body:'Due {{dueOn}}; probation ends {{endOn}} at {{companyName}}.',to:[...TO]}]});

/** A native Part 3 case; the admin is its PBP and GBS People Ops. `workflows` are published and pinned to the case. */
async function legacyCase(workflows:ProbationWorkflow[]=[]){
 const[hrPerson]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional HR Partner',${randomUUID()+'@probation.example.test'}) returning id`);
 await owner.db.execute(sql`update app_user set person_id=${hrPerson.id}::uuid where id=${admin.userId}::uuid`);admin={...admin,personId:hrPerson.id};
 const staff=await person('Fictional Staff'),manager=await person('Fictional Manager'),peer=await person('Fictional Peer');
 const groups=[{id:'probation-people',name:'Fictional People Ops',members:[admin.userId!],limit:10}];
 await owner.db.execute(sql`insert into lc_v9_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({version:9,peopleOpsGroup:'probation-people',groups})}::jsonb)`);
 await saveBusinessPartners([{rules:{company:[b.companyId]},userId:admin.userId!}]);
 await owner.db.execute(sql`insert into lc_onboarding_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({groups})}::jsonb)`);
 await owner.db.execute(sql`update employment set probation_value=0,probation_months=0 where id in(${manager.employmentId}::uuid,${peer.employmentId}::uuid)`);
 await owner.db.execute(sql`update employment set probation_unit='month',probation_value=12,probation_months=12,probation_end_date='2026-12-31' where id=${staff.employmentId}::uuid`);
 const ids={caseId:randomUUID(),settings:randomUUID(),form:randomUUID(),route:randomUUID(),part:randomUUID()};
 const definitionIds=workflows.map(()=>randomUUID());
 const part={...newProbationPart(ids.part,3,0,'2026-12-31',30),state:'issued' as const};
 const data={id:ids.caseId,employmentId:staff.employmentId,companyId:b.companyId,sourceKey:'employment:'+staff.employmentId,startOn:'2026-01-01',originalEndOn:'2026-12-31',endOn:'2026-12-31',gradeAtStart:'12',revision:1,config:DEFAULT_PROBATION_CONFIG,planMonths:12,planFlag:true,extensionCount:0,kpiAcknowledged:true,state:'in_review',pendingOutcome:null,workflowIds:definitionIds,
  facts:{employeeName:'Fictional Staff',employeeCode:'FS-0001',companyName:'Fictional Company Sdn Bhd',holders:{employee:staff.userId,lm:null,hod:null,pbp:null}}};
 await owner.db.execute(sql`insert into probation_configuration(id,tenant_id,company_id,kind,version,state,data,created_by) values(${ids.settings}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'settings',1,'published',${JSON.stringify(DEFAULT_PROBATION_CONFIG)}::jsonb,${admin.userId}::uuid),(${ids.form}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'form',1,'published',${JSON.stringify(DEFAULT_PROBATION_FORM)}::jsonb,${admin.userId}::uuid),(${ids.route}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'route',1,'published',${JSON.stringify(defaultProbationRoutes())}::jsonb,${admin.userId}::uuid)`);
 for(const [i,w] of workflows.entries())await owner.db.execute(sql`insert into probation_builder_definition(id,tenant_id,company_id,definition_key,kind,version,state,data,created_by) values(${definitionIds[i]}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${w.id},'workflow',1,'published',${JSON.stringify(w)}::jsonb,${admin.userId}::uuid)`);
 await owner.db.execute(sql`insert into probation_activation(tenant_id,company_id,enabled,activation_on,dry_run_digest,approved_by) values(${b.tenantId}::uuid,${b.companyId}::uuid,true,'2026-01-01',${'a'.repeat(64)},${admin.userId}::uuid)`);
 await owner.db.execute(sql`insert into probation_case(id,tenant_id,company_id,employment_id,source_key,settings_id,form_id,route_id,data) values(${ids.caseId}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,${staff.employmentId}::uuid,${data.sourceKey},${ids.settings}::uuid,${ids.form}::uuid,${ids.route}::uuid,${JSON.stringify(data)}::jsonb)`);
 const {employee,manager:managerValues,employeeComments,kpis,support,strengths,development,managerComments,outcome,midpointStatus,justification,extensionMonths,...metadata}=part;
 void employee;void managerValues;void employeeComments;void kpis;void support;void strengths;void development;void managerComments;void outcome;void midpointStatus;void justification;void extensionMonths;
 await owner.db.execute(sql`insert into probation_part(id,tenant_id,case_id,data) values(${ids.part}::uuid,${b.tenantId}::uuid,${ids.caseId}::uuid,${JSON.stringify({...metadata,route:defaultProbationRoutes().parts['3']})}::jsonb)`);
 const blank=Object.fromEntries(DEFAULT_PROBATION_FORM.criteria.map(c=>[c.id,{rating:null,evidence:''}]));
 await owner.db.execute(sql`insert into probation_rater_draft(part_id,tenant_id,rater,data) values(${ids.part}::uuid,${b.tenantId}::uuid,'employee',${JSON.stringify({employee:blank,employeeComments:''})}::jsonb),(${ids.part}::uuid,${b.tenantId}::uuid,'lm',${JSON.stringify({manager:blank})}::jsonb)`);
 await setReportingLine(admin,{subordinateEmploymentId:staff.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2026-01-01'});
 await owner.db.execute(sql`update department set head_employment_id=${peer.employmentId}::uuid where id=${b.deptA}::uuid`);
 await owner.db.execute(sql`insert into probation_access(tenant_id,user_id,company_id,role,valid_from,reason) values(${b.tenantId}::uuid,${admin.userId}::uuid,${b.companyId}::uuid,'pbp','2026-01-01','Fictional PBP opt-in'),(${b.tenantId}::uuid,${admin.userId}::uuid,${b.companyId}::uuid,'gbs','2026-01-01','Fictional GBS opt-in')`);
 const current=async(ctx:SessionContext)=>(await probationCase(ctx,ids.caseId)).parts[0];
 return{ids,definitionIds,staff,manager,peer,current};
}

/** The old engine's recipients (its planner) and words (the notice words) for one definition on this part. */
async function oldEngine(caseId:string,partId:string,definition:ProbationWorkflow){
 const plan=await owner.withTenant(admin,async tx=>(await tx.execute<{plan:{messages?:{recipients:{userId:string}[]}[]}}>(sql`select app.probation_workflow_plan(${caseId}::uuid,${partId}::uuid,${JSON.stringify(definition)}::jsonb) as plan`))[0].plan);
 const[words]=await owner.db.execute<Record<string,string|null>>(sql`select c.data->'facts'->>'employeeName' as "employeeName",c.data->'facts'->>'employeeCode' as "employeeCode",c.data->'facts'->>'companyName' as "companyName",p.data->>'type' as part,p.data->>'dueOn' as "dueOn",c.data->>'endOn' as "endOn" from probation_case c join probation_part p on p.case_id=c.id where c.id=${caseId}::uuid and p.id=${partId}::uuid`);
 const values=Object.fromEntries(Object.entries(words).map(([k,v])=>[k,v??'']));
 const step=definition.steps[0];
 return{userIds:[...new Set((plan.messages?.[0]?.recipients??[]).map(r=>r.userId))].sort(),subject:renderProbationWords(step.subject,values),body:renderProbationWords(step.body,values)};
}
/** What the converted shared workflow's Notify step sends on the same part. */
async function sharedEngine(caseId:string,partId:string,definition:ProbationWorkflow){
 const converted=convertProbationLegacyWorkflow(definition,{workflowId:randomUUID(),companyId:b.companyId});
 if(!converted.ok)throw new Error(converted.reason);
 return withTenant(admin,async tx=>{const record=(await probationAutomationCaseTx(tx,caseId))!;return probationNotifyPreviewTx(tx,{record,step:converted.workflow.steps[0],facts:{partId,partType:3,dueOn:null}});});
}
const exactEvents=(PROBATION_AUTOMATION_CATALOGUE.legacyEvents??[]).filter(e=>e.exact).map(e=>e.event as ProbationWorkflowEvent);

describe('exact conversion of notify-only workflows (G2)',()=>{
 it('reaches the same people with the same subject and body as the old engine, for every exact event at every stage',async()=>{
  const c=await legacyCase();
  // Pending-party events are compared on the part (letters are compared on their holders: the part is irrelevant there).
  expect(exactEvents.sort()).toEqual(['approval_pending','kpi_assigned','kpi_overdue','letter_release_pending','letter_released','letter_returned','review_due','review_issued'].sort());
  const compare=async(stage:string)=>{for(const event of exactEvents){
   const definition=legacy(event);
   if(event==='letter_release_pending')definition.steps[0].to=['employee','lm','hod','pbp'];
   const shared=await sharedEngine(c.ids.caseId,c.ids.part,definition);
   if(event.startsWith('letter_')){
    // The old letter transition (5752) reaches app.probation_users_for_roles of the step's roles that the event ever reached.
    const roles=(PROBATION_AUTOMATION_CATALOGUE.legacyEvents!.find(e=>e.event===event)!.roles??[]).filter(r=>definition.steps[0].to.includes(r as typeof TO[number]));
    const[row]=await owner.withTenant(admin,async tx=>tx.execute<{users:string[]}>(sql`select app.probation_users_for_roles(e.id,${JSON.stringify(roles)}::jsonb) as users from employment e where e.id=${c.staff.employmentId}::uuid`));
    const old=await oldEngine(c.ids.caseId,c.ids.part,definition);
    expect({stage,event,...shared}).toEqual({stage,event,userIds:[...new Set(row.users)].sort(),subject:old.subject,body:old.body});
   }else expect({stage,event,...shared}).toEqual({stage,event,...await oldEngine(c.ids.caseId,c.ids.part,definition)});
  }};
  await compare('issued');
  let p=await c.current(c.staff.ctx);await saveProbationDraft(c.staff.ctx,{caseId:c.ids.caseId,partId:c.ids.part,revision:p.revision,rater:'employee',patch:{employee:assessment}});
  p=await c.current(c.staff.ctx);await actOnProbation(c.staff.ctx,{caseId:c.ids.caseId,partId:c.ids.part,revision:p.revision,command:'submit_employee'});
  await compare('self-assessed');
  p=await c.current(c.manager.ctx);await saveProbationDraft(c.manager.ctx,{caseId:c.ids.caseId,partId:c.ids.part,revision:p.revision,rater:'lm',patch:{manager:assessment,reviewOn:todayInKualaLumpur(),conductedBy:c.manager.userId,outcome:'confirm',justification:'Observed evidence supports confirmation'}});
  p=await c.current(c.manager.ctx);await actOnProbation(c.manager.ctx,{caseId:c.ids.caseId,partId:c.ids.part,revision:p.revision,command:'submit_manager',method:'typed',value:'Fictional Manager',consent:true});
  await compare('submitted');
  p=await c.current(c.staff.ctx);await saveProbationDraft(c.staff.ctx,{caseId:c.ids.caseId,partId:c.ids.part,revision:p.revision,rater:'employee',patch:{employeeComments:'I acknowledge the review.'}});
  p=await c.current(c.staff.ctx);await actOnProbation(c.staff.ctx,{caseId:c.ids.caseId,partId:c.ids.part,revision:p.revision,command:'acknowledge',method:'typed',value:'Fictional Staff',consent:true});
  await compare('acknowledged');
 });

 it('keeps what it cannot convert exactly on the old engine, with the reason',()=>{
  const at={workflowId:randomUUID(),companyId:randomUUID()};
  for(const event of ['kpi_reminder','review_reminder','overdue_summary'] as const)expect(convertProbationLegacyWorkflow(legacy(event),at)).toMatchObject({ok:false});
  expect(convertProbationLegacyWorkflow({...legacy('review_due'),conditions:{businessUnitId:randomUUID()}},at)).toMatchObject({ok:false,reason:expect.stringMatching(/organisation mapping/)});
  expect(convertProbationLegacyWorkflow(legacy('letter_release_pending'),at)).toMatchObject({ok:false,reason:expect.stringMatching(/Confirm/)});
  expect(convertProbationLegacyWorkflow({...legacy('letter_released'),conditions:{part:3}},at)).toMatchObject({ok:false});
  const converted=convertProbationLegacyWorkflow({...legacy('review_due'),conditions:{part:3,grade:'12'}},at);
  expect(converted).toMatchObject({ok:true,workflow:{status:'live',trigger:{event:'dueBeforeReview',days:0},conditions:[{field:'company',op:'is',values:[at.companyId]},{field:'part',op:'is',values:['Part 3 · Final Confirmation Review']},{field:'jobGrade',op:'is',values:['12']}]}});
  if(converted.ok)expect(converted.workflow.steps[0]).toMatchObject({type:'notify',to:['pendingEmployee','pendingLm','pendingHod','pendingPbp','pendingGbs'].map(role=>({kind:'role',role})),params:{subject:'Part {{probation.partNumber}} for {{employee.name}} ({{employee.id}})',body:'Due {{probation.partDueOn}}; probation ends {{probation.endDate}} at {{org.company}}.',legacy:true}});
 });

 it('moves the exact workflows once, audited, and a moved definition never notifies the case twice',async()=>{
  const approval=legacy('approval_pending'),reminder=legacy('review_reminder');
  const c=await legacyCase([approval,reminder]);
  let p=await c.current(c.staff.ctx);await saveProbationDraft(c.staff.ctx,{caseId:c.ids.caseId,partId:c.ids.part,revision:p.revision,rater:'employee',patch:{employee:assessment}});
  p=await c.current(c.staff.ctx);await actOnProbation(c.staff.ctx,{caseId:c.ids.caseId,partId:c.ids.part,revision:p.revision,command:'submit_employee'});
  p=await c.current(c.manager.ctx);await saveProbationDraft(c.manager.ctx,{caseId:c.ids.caseId,partId:c.ids.part,revision:p.revision,rater:'lm',patch:{manager:assessment,reviewOn:todayInKualaLumpur(),conductedBy:c.manager.userId,outcome:'confirm',justification:'Observed evidence supports confirmation'}});
  p=await c.current(c.manager.ctx);await actOnProbation(c.manager.ctx,{caseId:c.ids.caseId,partId:c.ids.part,revision:p.revision,command:'submit_manager',method:'typed',value:'Fictional Manager',consent:true});
  // Before the move the old engine sends approval_pending to whoever is pending (the employee); the shared preview agrees.
  const before=await owner.db.execute<{users:string[]}>(sql`select recipient_user_ids as users from probation_occurrence where case_id=${c.ids.caseId}::uuid and workflow_id=${c.definitionIds[0]}::uuid`);
  expect(before.map(o=>o.users)).toEqual([[c.staff.userId]]);
  expect((await sharedEngine(c.ids.caseId,c.ids.part,approval)).userIds).toEqual([c.staff.userId]);
  // Only the configure permission may move; a Line Manager may not.
  await expect(moveProbationWorkflowsToShared(c.manager.ctx,{reason:'Fictional unauthorized move'})).rejects.toThrow();
  const result=await moveProbationWorkflowsToShared(admin,{reason:'Fictional move to the shared engine'});
  expect(result.moved.map(m=>m.definitionId)).toEqual([c.definitionIds[0]]);
  expect(result.kept).toEqual([expect.objectContaining({definitionId:c.definitionIds[1],reason:expect.stringMatching(/two schedules/)})]);
  const again=await moveProbationWorkflowsToShared(admin,{reason:'Fictional second run'});
  expect(again).toMatchObject({moved:[],alreadyMoved:1});
  const[audit]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from domain_event where aggregate_id=${c.definitionIds[0]}::uuid and event_type='probation.workflow_moved'`);expect(audit.n).toBe(1);
  const[saved]=await owner.db.execute<{status:string;n:number}>(sql`select min(status) as status,count(*)::int n from automation_workflow_version where workflow_id=${result.moved[0].workflowId}::uuid`);expect(saved).toEqual({status:'live',n:1});
  // The employee acknowledges: the old engine no longer sends for the moved definition (nor its default in-app notice);
  // the shared workflow sends once, to the Head of Department now pending.
  p=await c.current(c.staff.ctx);await saveProbationDraft(c.staff.ctx,{caseId:c.ids.caseId,partId:c.ids.part,revision:p.revision,rater:'employee',patch:{employeeComments:'I acknowledge the review.'}});
  p=await c.current(c.staff.ctx);await actOnProbation(c.staff.ctx,{caseId:c.ids.caseId,partId:c.ids.part,revision:p.revision,command:'acknowledge',method:'typed',value:'Fictional Staff',consent:true});
  const after=await owner.db.execute<{n:number}>(sql`select count(*)::int n from probation_occurrence where case_id=${c.ids.caseId}::uuid and kind='approval_pending'`);
  expect(after[0].n).toBe(before.length);
  const runs=await owner.db.execute<{status:string;log:{kind:string;recipients?:string[]}[]}>(sql`select status,log from automation_run where subject_id=${c.ids.caseId}::uuid and workflow_id=${result.moved[0].workflowId}::uuid`);
  expect(runs).toHaveLength(1);
  expect(runs[0].log.find(entry=>entry.kind==='stepDone')?.recipients).toEqual([c.peer.userId]);
 });
});
