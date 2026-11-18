// Approver choices on Probation form approval rows (lane G1, migration 5756; handoff B3, owner mockup screen 10): a
// routing, group or named-people row gives the step to one person chosen by the V9 assignment owner's rule when the Line
// Manager submits, frozen for the Part; nobody available goes to the case's fallback group and is recorded; Review and
// Approve rows record decisions without a signature; a Direct Superior row follows the case's holder and the
// duplicate-role policy; an assigned person's general Probation delegation moves the step. Fictional people only.
import {automationBusinessPartnerWorkspace,saveAutomationBusinessPartners,type BusinessPartnerRule} from '../packs/automation/service';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {hireEmployee,setReportingLine} from '../core/org';
import {adminCtx,closeAll,createAppUser,setModule,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {newProbationPart} from '../lib/probation-model';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {withTenant,type SessionContext} from '../db/client';
import type {ProbationApprovalRow} from '../lib/probation-form';
import {probationCase,saveProbationDraft,actOnProbation,probationTaskList,probationSummaryRows,DEFAULT_PROBATION_CONFIG,DEFAULT_PROBATION_FORM,defaultProbationRoutes} from '../packs/probation/service';

let b:Base,admin:SessionContext;
async function saveBusinessPartners(rules:BusinessPartnerRule[]){
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
const onLeaveToday=(employmentId:string)=>owner.db.execute(sql`insert into leave_request(tenant_id,employment_id,leave_type_id,start_date,end_date,days,status,reason) values(${b.tenantId}::uuid,${employmentId}::uuid,${b.annualLeaveTypeId}::uuid,${todayInKualaLumpur()}::date,${todayInKualaLumpur()}::date,1,'approved','Fictional approved leave')`);
const assessment=Object.fromEntries(DEFAULT_PROBATION_FORM.criteria.map(c=>[c.id,{rating:4,evidence:'Observed fictional evidence for this criterion'}]));

/** A native Part 3 whose pinned form version carries `rows`; the admin is the case's PBP and GBS and the fallback group. */
async function caseWithRows(rows:ProbationApprovalRow[],groups:(people:{admin:string})=>{id:string;name:string;members:string[];limit:number}[]=()=>[]){
 const[hrPerson]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional HR Partner',${randomUUID()+'@probation.example.test'}) returning id`);
 await owner.db.execute(sql`update app_user set person_id=${hrPerson.id}::uuid where id=${admin.userId}::uuid`);admin={...admin,personId:hrPerson.id};
 const staff=await person('Fictional Staff'),manager=await person('Fictional Manager'),peer=await person('Fictional Peer');
 const allGroups=[{id:'probation-people',name:'Fictional People Ops',members:[admin.userId!],limit:10},...groups({admin:admin.userId!})];
 await owner.db.execute(sql`insert into lc_v9_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({version:9,peopleOpsGroup:'probation-people',groups:allGroups})}::jsonb)`);
 await saveBusinessPartners([{rules:{company:[b.companyId]},userId:admin.userId!}]);
 await owner.db.execute(sql`insert into lc_onboarding_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({groups:allGroups})}::jsonb)`);
 await owner.db.execute(sql`update employment set probation_value=0,probation_months=0 where id in(${manager.employmentId}::uuid,${peer.employmentId}::uuid)`);
 await owner.db.execute(sql`update employment set probation_unit='month',probation_value=12,probation_months=12,probation_end_date='2026-12-31' where id=${staff.employmentId}::uuid`);
 const ids={caseId:randomUUID(),settings:randomUUID(),form:randomUUID(),route:randomUUID(),part:randomUUID()};
 const form={...DEFAULT_PROBATION_FORM,approvals:{'1':[],'2':[],'3':rows}};
 const part={...newProbationPart(ids.part,3,0,'2026-12-31',30),state:'issued' as const};
 const data={id:ids.caseId,employmentId:staff.employmentId,companyId:b.companyId,sourceKey:'employment:'+staff.employmentId,startOn:'2026-01-01',originalEndOn:'2026-12-31',endOn:'2026-12-31',gradeAtStart:'12',revision:1,config:DEFAULT_PROBATION_CONFIG,planMonths:12,planFlag:true,extensionCount:0,kpiAcknowledged:true,state:'in_review',pendingOutcome:null,facts:{employeeName:'Fictional Staff',holders:{employee:staff.userId,lm:null,hod:null,pbp:null}}};
 await owner.db.execute(sql`insert into probation_configuration(id,tenant_id,company_id,kind,version,state,data,created_by) values(${ids.settings}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'settings',1,'published',${JSON.stringify(DEFAULT_PROBATION_CONFIG)}::jsonb,${admin.userId}::uuid),(${ids.form}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'form',1,'published',${JSON.stringify(form)}::jsonb,${admin.userId}::uuid),(${ids.route}::uuid,${b.tenantId}::uuid,${b.companyId}::uuid,'route',1,'published',${JSON.stringify(defaultProbationRoutes())}::jsonb,${admin.userId}::uuid)`);
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
 const prepare=async()=>{
  let p=await current(staff.ctx);await saveProbationDraft(staff.ctx,{caseId:ids.caseId,partId:ids.part,revision:p.revision,rater:'employee',patch:{employee:assessment}});
  p=await current(staff.ctx);await actOnProbation(staff.ctx,{caseId:ids.caseId,partId:ids.part,revision:p.revision,command:'submit_employee'});
  p=await current(manager.ctx);await saveProbationDraft(manager.ctx,{caseId:ids.caseId,partId:ids.part,revision:p.revision,rater:'lm',patch:{manager:assessment,reviewOn:todayInKualaLumpur(),conductedBy:manager.userId,outcome:'confirm',justification:'Observed evidence supports confirmation'}});
 };
 const submit=async()=>{const p=await current(manager.ctx);await actOnProbation(manager.ctx,{caseId:ids.caseId,partId:ids.part,revision:p.revision,command:'submit_manager',method:'typed',value:'Fictional Manager',consent:true});};
 const acknowledge=async()=>{
  let p=await current(staff.ctx);await saveProbationDraft(staff.ctx,{caseId:ids.caseId,partId:ids.part,revision:p.revision,rater:'employee',patch:{employeeComments:'I acknowledge the review discussion.'}});
  p=await current(staff.ctx);await actOnProbation(staff.ctx,{caseId:ids.caseId,partId:ids.part,revision:p.revision,command:'acknowledge',method:'typed',value:'Fictional Staff',consent:true});
 };
 const frozen=async()=>(await owner.db.execute<{route:{steps:Record<string,unknown>[]};unresolved:unknown}>(sql`select data->'route' as route,data->'approverUnresolved' as unresolved from probation_part where id=${ids.part}::uuid`))[0];
 const holders=async()=>owner.db.execute<{step_id:string;holder_id:string;kind:string;represented_id:string|null}>(sql`select step_id,holder_id,kind,represented_id from probation_delegate where part_id=${ids.part}::uuid order by step_id`);
 return{ids,staff,manager,peer,current,prepare,submit,acknowledge,frozen,holders};
}
const onCase=(caseId:string,list:{items:{caseId:string;partId:string;kind:string;category:string}[]})=>list.items.filter(item=>item.caseId===caseId);

describe('routed form approvers (5756)',()=>{
 it('assigns the person a routing\'s matching row names (I8), never the fallback group',async()=>{
  const named=await person('Fictional Routed Head');
  const routingId=randomUUID();
  const rows:ProbationApprovalRow[]=[{id:'routed_head',order:1,action:'approve',who:'routing:'+routingId,pick:'any'}];
  const c=await caseWithRows(rows);
  await owner.db.execute(sql`insert into automation_routing_version(tenant_id,routing_id,revision,name,routing_rows,reason,saved_by) values(${b.tenantId}::uuid,${routingId}::uuid,1,'Fictional HOD by department',${JSON.stringify([{match:{department:[b.deptA]},assignTo:{kind:'people',userIds:[named.userId]}}])}::jsonb,'Fictional routing',${admin.userId}::uuid)`);
  await c.prepare();await c.submit();
  expect([...await c.holders()]).toEqual([{step_id:'routed_head',holder_id:named.userId,kind:'missing_holder',represented_id:null}]);
  expect((await c.frozen()).unresolved??[]).toEqual([]);
  await c.acknowledge();
  expect(onCase(c.ids.caseId,await probationTaskList(named.ctx,{category:'approval'}))).toEqual([expect.objectContaining({partId:c.ids.part,kind:'approve'})]);
  // I9: the tracker names the routing and the person holding the step, never the raw role id.
  const row=(await probationSummaryRows(admin,{})).rows.find(r=>r.id===c.ids.caseId)!;
  expect(row.parts.find(p=>p.id===c.ids.part)).toMatchObject({waitingRole:'routing:'+routingId,waitingLabel:'Fictional HOD by department',waitingName:'Fictional Routed Head'});
 });

 it('gives each routed step one person when the Line Manager submits, records Review and Approve without a signature, and completes the part',async()=>{
  const reviewer=await person('Fictional Named Reviewer'),away=await person('Fictional Away Approver'),approver=await person('Fictional Group Approver');
  const rows:ProbationApprovalRow[]=[
   {id:'peer_review',order:1,action:'review',who:'people',userIds:[reviewer.userId]},
   {id:'group_ok',order:2,action:'approve',who:'group:approvers',pick:'any'},
  ];
  const c=await caseWithRows(rows,()=>[{id:'approvers',name:'Fictional approvers',members:[away.userId,approver.userId],limit:0}]);
  await onLeaveToday(away.employmentId);
  await c.prepare();await c.submit();
  const route=(await c.frozen()).route.steps;
  expect(route.map(step=>[step.id,step.role,step.kind,step.stage,step.signature??null,step.label??null])).toEqual([
   ['lm','lm','sign',0,null,null],['employee','employee','acknowledge',1,null,null],
   ['peer_review','people','review',2,null,null],['group_ok','group:approvers','approve',3,false,'Fictional approvers']]);
  // Member order names the person on leave first; the assignment owner skips them. The choice is frozen on the Part.
  expect([...await c.holders()]).toEqual([
   {step_id:'group_ok',holder_id:approver.userId,kind:'missing_holder',represented_id:null},
   {step_id:'peer_review',holder_id:reviewer.userId,kind:'missing_holder',represented_id:null}]);
  const[assigned]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from domain_event where aggregate_id=${c.ids.caseId}::uuid and event_type='probation.form_approvers_assigned'`);expect(assigned.n).toBe(1);
  await c.acknowledge();
  // The Review step is the named reviewer's Approval Item; nobody else holds it.
  expect((await c.current(reviewer.ctx)).allowedCommands).toContain('approve');
  expect(onCase(c.ids.caseId,await probationTaskList(reviewer.ctx,{category:'approval'}))).toEqual([expect.objectContaining({partId:c.ids.part,kind:'approve',category:'approval'})]);
  expect(onCase(c.ids.caseId,await probationTaskList(approver.ctx))).toEqual([]);
  let part=await c.current(reviewer.ctx);
  await actOnProbation(reviewer.ctx,{caseId:c.ids.caseId,partId:c.ids.part,revision:part.revision,stepId:'peer_review',command:'approve',reason:'Reviewed the evidence',coveredStepIds:[]});
  part=await c.current(admin);
  expect(part.signing!.document.actions).toContainEqual(expect.objectContaining({stepId:'peer_review',role:'people',action:'reviewed',actorId:reviewer.userId,signature:null,comment:'Reviewed the evidence'}));
  expect(part.allowedCommands).not.toContain('record');
  // The person on leave was never given the step and cannot act on it.
  part=await c.current(admin);
  await expect(actOnProbation(away.ctx,{caseId:c.ids.caseId,partId:c.ids.part,revision:part.revision,stepId:'group_ok',command:'approve',coveredStepIds:[]})).rejects.toThrow();
  expect(onCase(c.ids.caseId,await probationTaskList(approver.ctx,{category:'approval'}))).toEqual([expect.objectContaining({partId:c.ids.part,kind:'approve',category:'approval'})]);
  part=await c.current(approver.ctx);
  await actOnProbation(approver.ctx,{caseId:c.ids.caseId,partId:c.ids.part,revision:part.revision,stepId:'group_ok',command:'approve',coveredStepIds:[]});
  part=await c.current(admin);
  expect(part.signing!.document.actions).toContainEqual(expect.objectContaining({stepId:'group_ok',role:'group:approvers',action:'approved',actorId:approver.userId,signature:null}));
  // The independent Approve completes the signature set: GBS People Ops may record the part.
  expect(part.allowedCommands).toContain('record');
 });

 it('gives a step nobody can take to the fallback group, records who it was meant for, and refuses a person the step does not name',async()=>{
  const away=await person('Fictional Away Member'),outsider=await person('Fictional Outsider');
  const rows:ProbationApprovalRow[]=[{id:'hr_approval',order:1,action:'approve_sign',who:'group:away',pick:'roundRobin'}];
  const c=await caseWithRows(rows,()=>[{id:'away',name:'Fictional away group',members:[away.userId],limit:0}]);
  await onLeaveToday(away.employmentId);
  await c.prepare();
  // The database checks the person against the step: someone outside the group (and not a fallback choice) is refused.
  await expect(withTenant(c.manager.ctx,async tx=>{
   await tx.execute(sql`select app.probation_prepare_signing(${c.ids.part}::uuid)`);
   await tx.execute(sql`select app.probation_form_freeze_approvers(${c.ids.part}::uuid,${JSON.stringify([{stepId:'hr_approval',holderId:outsider.userId}])}::jsonb)`);
  })).rejects.toThrow();
  await expect(withTenant(c.staff.ctx,async tx=>{await tx.execute(sql`select app.probation_form_routing_context(${c.ids.part}::uuid)`);})).rejects.toThrow();
  await c.submit();
  const{route,unresolved}=await c.frozen();
  expect(route.steps.find(step=>step.id==='hr_approval')).toMatchObject({role:'group:away',kind:'approve',meantFor:'The assignment group “Fictional away group”'});
  expect(unresolved).toEqual([expect.objectContaining({stepId:'hr_approval',meantFor:'The assignment group “Fictional away group”',reason:`Everyone in Fictional away group is on leave on ${todayInKualaLumpur()}.`,fallbackGroupId:'probation-people',holderId:admin.userId})]);
  expect([...await c.holders()]).toEqual([{step_id:'hr_approval',holder_id:admin.userId,kind:'missing_holder',represented_id:null}]);
  const[event]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from domain_event where aggregate_id=${c.ids.caseId}::uuid and event_type='probation.form_routing_fallback'`);expect(event.n).toBe(1);
  await c.acknowledge();
  const part=await c.current(admin);
  expect(part.route.steps.find(step=>step.id==='hr_approval')).toMatchObject({holderId:admin.userId});
  expect(part.allowedCommands).toContain('approve');
 });

 it('moves an assigned approver\'s step to their general Probation delegate, who sees it in their queue and acts on behalf',async()=>{
  const approver=await person('Fictional Assigned Approver'),delegate=await person('Fictional Approver Delegate');
  const c=await caseWithRows([{id:'named_ok',order:1,action:'approve_sign',who:'people',userIds:[approver.userId]}]);
  await c.prepare();await c.submit();await c.acknowledge();
  expect((await c.current(admin)).route.steps.find(step=>step.id==='named_ok')).toMatchObject({holderId:approver.userId});
  const[line]=await owner.db.execute<{id:string}>(sql`insert into reporting_line(tenant_id,subordinate_employment_id,manager_employment_id,line_type,valid_from) values(${b.tenantId}::uuid,${approver.employmentId}::uuid,${delegate.employmentId}::uuid,'delegate',${addDaysIso(todayInKualaLumpur(),-1)}::date) returning id`);
  expect(onCase(c.ids.caseId,await probationTaskList(delegate.ctx))).toEqual([]);
  await owner.db.execute(sql`insert into reporting_line_scope(tenant_id,reporting_line_id,module,task_type) values(${b.tenantId}::uuid,${line.id}::uuid,'probation','probation.approve')`);
  const part=await c.current(delegate.ctx),step=part.route.steps.find(s=>s.id==='named_ok')!;
  expect(step).toMatchObject({holderId:delegate.userId,representedId:approver.userId});
  expect(onCase(c.ids.caseId,await probationTaskList(delegate.ctx,{category:'approval'}))).toEqual([expect.objectContaining({partId:c.ids.part,kind:'approve'})]);
  await actOnProbation(delegate.ctx,{caseId:c.ids.caseId,partId:c.ids.part,revision:part.revision,stepId:'named_ok',command:'approve',method:'typed',value:'Fictional Approver Delegate',consent:true,coveredStepIds:step.coveredStepIds??[]});
  expect((await c.current(admin)).signing!.document.actions).toContainEqual(expect.objectContaining({stepId:'named_ok',action:'signed',actorId:delegate.userId,representedId:approver.userId}));
 });

 it('resolves a Direct Superior step to the case\'s Line Manager, then applies the duplicate-role policy; Head of Department rows freeze as before',async()=>{
  const c=await caseWithRows([{id:'ds',order:1,action:'approve_sign',who:'superior'},{id:'hod',order:2,action:'approve_sign',who:'hod'}]);
  // The Line Manager signed the assessment, so the escalate policy moves their Direct Superior step to their own manager.
  await setReportingLine(admin,{subordinateEmploymentId:c.manager.employmentId,managerEmploymentId:c.peer.employmentId,lineType:'administrative',validFrom:'2026-01-01'});
  await c.prepare();await c.submit();
  expect((await c.frozen()).route.steps.map(step=>[step.id,step.role,step.kind])).toEqual([['lm','lm','sign'],['employee','employee','acknowledge'],['ds','superior','approve'],['hod','hod','approve']]);
  expect([...await c.holders()]).toEqual([]);
  await c.acknowledge();
  const part=await c.current(admin);
  expect(part.route.steps.find(step=>step.id==='ds')).toMatchObject({role:'superior',representedId:c.manager.userId});
  expect(part.route.steps.find(step=>step.id==='ds')!.holderId).not.toBe(c.manager.userId);
  expect(part.route.steps.find(step=>step.id==='hod')).toMatchObject({role:'hod'});
  expect((await c.current(c.manager.ctx)).allowedCommands).not.toContain('approve');
 });
});
