// PBP route overrides and per-part delegation for routed form approver steps (lane H, migration 5758). A PBP may
// override an unsubmitted Part route that contains routing, group, named-people or Direct Superior steps (same authority,
// revision and audit; routed steps keep a routing of the case's form version), and may record a dated delegation for
// such a step, which represents the step's current person and still meets the duplicate-role policy. The case's
// employee is never the person for a routed step. Fictional people only.
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {hireEmployee,setReportingLine} from '../core/org';
import {adminCtx,closeAll,createAppUser,setModule,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {newProbationPart} from '../lib/probation-model';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import type {SessionContext} from '../db/client';
import type {SigningRoute} from '../lib/document-signing-model';
import type {ProbationApprovalRow} from '../lib/probation-form';
import {probationCase,saveProbationDraft,actOnProbation,overrideProbationRoute,replaceProbationSigner,DEFAULT_PROBATION_CONFIG,DEFAULT_PROBATION_FORM,defaultProbationRoutes} from '../packs/probation/service';

let b:Base,admin:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);});

async function person(name:string){
 const e=await hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@probation.example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
 const userId=await createAppUser(b.tenantId,e.personId,'employee');
 return{...e,userId,ctx:{...admin,userId,personId:e.personId,roles:['employee'],grants:undefined} as SessionContext};
}
const assessment=Object.fromEntries(DEFAULT_PROBATION_FORM.criteria.map(c=>[c.id,{rating:4,evidence:'Observed fictional evidence for this criterion'}]));
/** The database's refusal text (drizzle wraps it with the failed query). */
const refusal=(work:Promise<unknown>)=>work.then(()=>'',(e:{message?:string;cause?:{message?:string}})=>`${e?.cause?.message??''} ${e?.message??''}`);

/** A native Part 3 whose pinned form version carries `rows` (as test/probation-form-approvers-db.test.ts); the admin is the case's PBP and GBS. */
async function caseWithRows(rows:ProbationApprovalRow[],groups:{id:string;name:string;members:string[];limit:number}[]=[]){
 const[hrPerson]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional HR Partner',${randomUUID()+'@probation.example.test'}) returning id`);
 await owner.db.execute(sql`update app_user set person_id=${hrPerson.id}::uuid where id=${admin.userId}::uuid`);admin={...admin,personId:hrPerson.id};
 const staff=await person('Fictional Staff'),manager=await person('Fictional Manager'),peer=await person('Fictional Peer');
 const allGroups=[{id:'probation-people',name:'Fictional People Ops',members:[admin.userId!],limit:10},...groups];
 await owner.db.execute(sql`insert into lc_v9_config(tenant_id,data) values(${b.tenantId}::uuid,${JSON.stringify({version:9,peopleOpsGroup:'probation-people',groups:allGroups,bpRules:[{rules:{company:[b.companyId]},userId:admin.userId}]})}::jsonb)`);
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
 const stored=async()=>(await owner.db.execute<{route:SigningRoute;override:boolean|null;policy:unknown;revision:number}>(sql`select data->'route' as route,(data->>'routeOverride')::boolean as override,data->'routePolicy' as policy,revision from probation_part where id=${ids.part}::uuid`))[0];
 const holders=async()=>[...await owner.db.execute<{step_id:string;holder_id:string;kind:string;represented_id:string|null}>(sql`select step_id,holder_id,kind,represented_id from probation_delegate where part_id=${ids.part}::uuid order by created_at,id`)];
 const events=async(type:string)=>(await owner.db.execute<{n:number}>(sql`select count(*)::int n from domain_event where aggregate_id=${ids.caseId}::uuid and event_type=${type}`))[0].n;
 return{ids,staff,manager,peer,current,prepare,submit,acknowledge,stored,holders,events};
}
const today=()=>todayInKualaLumpur();

describe('PBP route override of a Part with routed approver steps (5758)',()=>{
 it('reorders the routed steps of a reopened Part with the same authority, revision and audit, and the resubmission keeps the override',async()=>{
  const reviewer=await person('Fictional Named Reviewer'),approver=await person('Fictional Group Approver');
  const c=await caseWithRows([
   {id:'peer_review',order:1,action:'review',who:'people',userIds:[reviewer.userId]},
   {id:'group_ok',order:2,action:'approve',who:'group:approvers',pick:'any'},
  ],[{id:'approvers',name:'Fictional approvers',members:[approver.userId],limit:0}]);
  await c.prepare();await c.submit();
  expect((await c.stored()).route.steps.map(s=>[s.id,s.role,s.stage])).toEqual([['lm','lm',0],['employee','employee',1],['peer_review','people',2],['group_ok','group:approvers',3]]);
  const assigned=await c.holders();expect(assigned).toHaveLength(2);
  // The PBP reopens the Line Manager's submission; the route stays the one frozen from the form version.
  let part=await c.current(admin);
  await actOnProbation(admin,{caseId:c.ids.caseId,partId:c.ids.part,revision:part.revision,command:'unlock',reason:'Reopened to change the approval order',owner:'lm'});
  part=await c.current(admin);
  const before=await c.stored();
  // As the UI sends it: the resolved route without holders, routed steps swapped, a client label that the server ignores.
  const draft:SigningRoute={...part.route,steps:part.route.steps.map(s=>({...s,holderId:null,holderPersonId:undefined,representedId:undefined,coveredStepIds:undefined,coveredByStepId:undefined,
   ...(s.id==='peer_review'?{stage:3}:s.id==='group_ok'?{stage:2,label:'Client label'}:{})}))};
  // Refused: not the case's PBP, a stale revision, a routed step the form version does not define, a named holder.
  expect(await refusal(overrideProbationRoute(c.manager.ctx,{partId:c.ids.part,revision:part.storageRevision,route:draft,reason:'Manager tries to reroute'}))).toMatch(/PBP may change only an unsubmitted route/);
  expect(await refusal(overrideProbationRoute(admin,{partId:c.ids.part,revision:part.storageRevision-1,route:draft,reason:'Stale revision'}))).toMatch(/PBP may change only an unsubmitted route/);
  const invented={...draft,steps:[...draft.steps,{id:'new_group',role:'group:approvers',kind:'approve' as const,stage:4,holderId:null,required:true}]};
  expect(await refusal(overrideProbationRoute(admin,{partId:c.ids.part,revision:part.storageRevision,route:invented,reason:'Adds a routing the form does not have'}))).toMatch(/must keep a routing of this case's form version/);
  const named={...draft,steps:draft.steps.map(s=>s.id==='group_ok'?{...s,holderId:approver.userId}:s)};
  await expect(overrideProbationRoute(admin,{partId:c.ids.part,revision:part.storageRevision,route:named,reason:'Names a person in the route'})).rejects.toThrow();
  expect((await c.stored()).revision).toBe(before.revision);
  expect(await c.events('probation.route_changed')).toBe(0);

  await overrideProbationRoute(admin,{partId:c.ids.part,revision:part.storageRevision,route:draft,reason:'Group approval before the peer review'});
  const after=await c.stored();
  expect(after.revision).toBe(before.revision+1);expect(after.override).toBe(true);
  expect(after.policy).toEqual(before.policy);
  expect(after.route.steps.map(s=>[s.id,s.role,s.kind,s.stage,s.signature??null,s.label??null])).toEqual([
   ['lm','lm','sign',0,null,null],['employee','employee','acknowledge',1,null,null],
   ['peer_review','people','review',3,null,null],['group_ok','group:approvers','approve',2,false,'Fictional approvers']]);
  expect(await c.events('probation.route_changed')).toBe(1);
  const[snapshot]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from probation_revision where part_id=${c.ids.part}::uuid and rater='meta' and reason='Group approval before the peer review' and revision=${before.revision}`);expect(snapshot.n).toBe(1);

  // The Line Manager resubmits: the override is kept (not re-derived from the form) and each step keeps its person.
  await c.submit();
  expect((await c.stored()).route.steps.map(s=>[s.id,s.stage])).toEqual([['lm',0],['employee',1],['peer_review',3],['group_ok',2]]);
  expect(await c.holders()).toEqual(assigned);
  await c.acknowledge();
  expect((await c.current(approver.ctx)).allowedCommands).toContain('approve');
  expect((await c.current(reviewer.ctx)).allowedCommands).not.toContain('approve');
 });

 it('keeps the 0949 rules for a route without routed steps: Head of Department and PBP only',async()=>{
  const c=await caseWithRows([{id:'hod',order:1,action:'approve_sign',who:'hod'}]);
  const part=await c.current(admin),route=defaultProbationRoutes().parts['3'];
  const gbs={...route,steps:[...route.steps,{id:'gbs_extra',role:'gbs',kind:'approve' as const,stage:9,holderId:null,required:true}]};
  expect(await refusal(overrideProbationRoute(admin,{partId:c.ids.part,revision:part.storageRevision,route:gbs,reason:'Adds a GBS step'}))).toMatch(/source role approvers/);
  await overrideProbationRoute(admin,{partId:c.ids.part,revision:part.storageRevision,route,reason:'Keeps the configured route'});
  const after=await c.stored();
  expect(after.override).toBe(true);expect(after.route).toEqual(route);expect(after.policy??null).toBeNull();
 });
});

describe('Delegation of a routed approver step (5758)',()=>{
 it('records a dated delegation for an assigned named-people step; the delegate acts on behalf of the assigned person',async()=>{
  const approver=await person('Fictional Assigned Approver'),delegate=await person('Fictional Delegate');
  const c=await caseWithRows([{id:'named_ok',order:1,action:'approve_sign',who:'people',userIds:[approver.userId]}]);
  await c.prepare();await c.submit();await c.acknowledge();
  const input={partId:c.ids.part,stepId:'named_ok',holderId:delegate.userId,kind:'delegation' as const,validFrom:today(),validTo:addDaysIso(today(),5),reason:'Fictional planned absence'};
  // Same checks as a Head of Department or PBP step: a current PBP/GBS records it; never the employee.
  await expect(replaceProbationSigner(c.staff.ctx,input)).rejects.toThrow();
  expect(await refusal(replaceProbationSigner(admin,{...input,holderId:c.staff.userId}))).toMatch(/employee cannot review or approve their own probation/);
  expect(await refusal(replaceProbationSigner(admin,{...input,holderId:c.staff.userId,kind:'holder_changed'}))).toMatch(/employee cannot review or approve their own probation/);
  await replaceProbationSigner(admin,input);
  expect(await c.holders()).toEqual([
   {step_id:'named_ok',holder_id:approver.userId,kind:'missing_holder',represented_id:null},
   {step_id:'named_ok',holder_id:delegate.userId,kind:'delegation',represented_id:approver.userId}]);
  expect(await c.events('probation.signer_replaced')).toBe(1);
  const part=await c.current(delegate.ctx),step=part.route.steps.find(s=>s.id==='named_ok')!;
  expect(step).toMatchObject({holderId:delegate.userId,representedId:approver.userId});
  expect(part.allowedCommands).toContain('approve');
  expect((await c.current(approver.ctx)).allowedCommands).not.toContain('approve');
  await actOnProbation(delegate.ctx,{caseId:c.ids.caseId,partId:c.ids.part,revision:part.revision,stepId:'named_ok',command:'approve',method:'typed',value:'Fictional Delegate',consent:true,coveredStepIds:step.coveredStepIds??[]});
  expect((await c.current(admin)).signing!.document.actions).toContainEqual(expect.objectContaining({stepId:'named_ok',action:'signed',actorId:delegate.userId,representedId:approver.userId}));
 });

 it('applies the duplicate-role policy to the delegate, and a Direct Superior step represents the Line Manager holder',async()=>{
  const approver=await person('Fictional Assigned Approver'),delegate=await person('Fictional Delegate');
  const c=await caseWithRows([{id:'ds',order:1,action:'approve_sign',who:'superior'},{id:'named_ok',order:2,action:'approve_sign',who:'people',userIds:[approver.userId]}]);
  await setReportingLine(admin,{subordinateEmploymentId:c.manager.employmentId,managerEmploymentId:c.peer.employmentId,lineType:'administrative',validFrom:'2026-01-01'});
  await c.prepare();await c.submit();await c.acknowledge();
  // A delegation of a routed step to the Line Manager, who already signed: the escalate policy moves it to their manager.
  await replaceProbationSigner(admin,{partId:c.ids.part,stepId:'named_ok',holderId:c.manager.userId,kind:'delegation',validFrom:today(),validTo:null,reason:'Fictional cover by the manager'});
  let part=await c.current(admin);
  const escalated=part.route.steps.find(s=>s.id==='named_ok')!;
  expect(escalated.representedId).toBe(c.manager.userId);expect(escalated.holderId).not.toBe(c.manager.userId);
  // The Direct Superior step (held by the Line Manager holder) delegated to someone else represents the Line Manager.
  await replaceProbationSigner(admin,{partId:c.ids.part,stepId:'ds',holderId:delegate.userId,kind:'delegation',validFrom:today(),validTo:null,reason:'Fictional superior absence'});
  expect((await c.holders()).find(h=>h.step_id==='ds')).toEqual({step_id:'ds',holder_id:delegate.userId,kind:'delegation',represented_id:c.manager.userId});
  part=await c.current(delegate.ctx);
  expect(part.route.steps.find(s=>s.id==='ds')).toMatchObject({holderId:delegate.userId,representedId:c.manager.userId});
  expect(part.allowedCommands).toContain('approve');
 });
});
