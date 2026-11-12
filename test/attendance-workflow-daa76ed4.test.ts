// Board daa76ed4: approvers from any company of the Organization Code (tenant), approvers whose account is pending
// activation, and per-level Escalation Approval by the nightly runner. All people, companies and dates are fictional.
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,asc,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {checkIn,checkOut,requestAttendanceCorrection,decideAttendanceCorrection,cancelOwnAttendanceCorrection} from '../core/attendance';
import {saveAttendanceWorkflow,ownAttendanceSubmissionRoute,generateAttendanceWorkflowPreview,getAttendanceWorkflowPreview} from '../core/attendance-workflow';
import {sweepAttendanceWorkflowEscalations,ATTENDANCE_ESCALATION_EVENT} from '../core/attendance-workflow-escalation';
import {parseAttendanceV4Route,type AttendanceV4WorkflowInput,type AttendanceV4Level} from '../lib/attendance-workflow-v4';
import {addDaysIso} from '../core/leave-escalation';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,createAppUser,owner,closeAll,migrateTestDb,resetDb,seedBase,type Base} from './harness';

let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();base=await seedBase();});

type Actor=Awaited<ReturnType<typeof actor>>;
async function company(name:string){
 const [row]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:name}).returning();
 const [department]=await owner.db.insert(schema.department).values({tenantId:base.tenantId,companyId:row.id,name:`${name} department`}).returning();
 return {id:row.id,departmentId:department.id};
}
async function actor(name:string,options:{role?:'employee'|'hr_admin';login?:boolean;companyId?:string;departmentId?:string;roleCompanyId?:string|null}={}){
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:`${randomUUID()}@example.invalid`},companyId:options.companyId??base.companyId,departmentId:options.departmentId??base.deptB,employmentType:'full_time',hiredOn:'2020-01-01'});
 const role=options.role??'employee',roleCompanyId=options.roleCompanyId===undefined?null:options.roleCompanyId;
 const userId=options.login===false?null:await createAppUser(base.tenantId,hired.personId,role);
 if(userId&&roleCompanyId)await owner.db.update(schema.roleAssignment).set({companyId:roleCompanyId}).where(eq(schema.roleAssignment.appUserId,userId));
 const ctx:SessionContext={...adminCtx(base),userId:userId??undefined,personId:hired.personId,roles:[role],grants:[{role,companyId:roleCompanyId}]};
 return{...hired,ctx,userId,role,roleCompanyId};
}
/** The person's account is created later (activation); the returned actor acts through it. */
async function activate(person:Actor):Promise<Actor>{
 const userId=await createAppUser(base.tenantId,person.personId,'employee');
 return{...person,userId,ctx:{...adminCtx(base),userId,personId:person.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]}};
}
const reports=(subordinate:Actor,manager:Actor)=>setReportingLine(adminCtx(base),{subordinateEmploymentId:subordinate.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
const superior=(depth:number):AttendanceV4Level['sources'][number]=>({kind:'direct_manager',depth});
const named=(...people:Actor[]):AttendanceV4Level['sources'][number]=>({kind:'specific_employee',employmentIds:people.map(p=>p.employmentId)});
const level=(sources:AttendanceV4Level['sources'],patch:Partial<AttendanceV4Level>={}):AttendanceV4Level=>({name:'Level 1',mode:'any_one',sources,hrAlternative:false,...patch});
function workflow(employees:Actor[],stages:AttendanceV4Level[],patch:Partial<AttendanceV4WorkflowInput>={}):AttendanceV4WorkflowInput{
 return{companyId:base.companyId,applicationType:'irregularity',routingVersion:4,code:'D76_'+randomUUID().slice(0,8),name:'Fictional daa76ed4 workflow',priority:100,active:true,criteria:{employeeIds:employees.map(e=>e.employmentId)},stages:stages.map((stage,index)=>({...stage,name:`Level ${index+1}`})),cc:[],...patch};
}
async function submit(applicant:Actor,kind:'irregularity'|'self_overtime'='irregularity'){
 const today=todayInKualaLumpur(),root=adminCtx(base);
 if(kind==='self_overtime')return (await requestAttendanceCorrection(applicant.ctx,{employmentId:applicant.employmentId,date:addDaysIso(today,1),requestedOtMinutes:60,requestKind:'self_overtime',reason:'Fictional daa76ed4 overtime'})).correctionId;
 await checkIn(root,{employmentId:applicant.employmentId,date:today,time:'08:00',manual:true});await checkOut(root,{employmentId:applicant.employmentId,date:today,time:'17:00',manual:true});
 return (await requestAttendanceCorrection(applicant.ctx,{employmentId:applicant.employmentId,date:today,checkIn:'09:00',checkOut:'18:00',reason:'Fictional daa76ed4 verification'})).correctionId;
}
const requestOf=async(correctionId:string)=>(await owner.db.select().from(schema.attendanceWorkflowRequest).where(eq(schema.attendanceWorkflowRequest.correctionId,correctionId)))[0];
const statusOf=async(correctionId:string)=>(await owner.db.select({status:schema.attendanceCorrection.status}).from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id,correctionId)))[0]?.status;
const escalationsOf=async(requestId:string)=>owner.db.select().from(schema.attendanceWorkflowEscalation).where(eq(schema.attendanceWorkflowEscalation.requestId,requestId)).orderBy(asc(schema.attendanceWorkflowEscalation.stageIndex));
const participantsOf=async(requestId:string)=>owner.db.select().from(schema.attendanceWorkflowParticipantDecision).where(eq(schema.attendanceWorkflowParticipantDecision.requestId,requestId));
const completionsOf=async(requestId:string)=>owner.db.select().from(schema.attendanceWorkflowDecision).where(eq(schema.attendanceWorkflowDecision.requestId,requestId));
const decide=(who:Actor,correctionId:string,stage:number,slot:string,decision:'approved'|'rejected'='approved')=>decideAttendanceCorrection(who.ctx,{correctionId,decision,expectedStageIndex:stage,expectedParticipantSlot:slot,...(decision==='rejected'?{rejectReason:'Fictional rejection'}:{})});
const system=():SessionContext=>({...adminCtx(base),userId:undefined});
const sees=(who:Actor,employmentId:string)=>withTenant(who.ctx,tx=>tx.select({id:schema.employment.id}).from(schema.employment).where(eq(schema.employment.id,employmentId)));
const readsApplication=(who:Actor,correctionId:string)=>withTenant(who.ctx,tx=>tx.select({id:schema.attendanceCorrection.id}).from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id,correctionId)));

describe('cross-company approvers within the Organization Code',()=>{
 it('a sibling-company Direct Superior decides both application types, without Personnel access for them or their HR',async()=>{
  const b=await company('Fictional Company B');
  const applicant=await actor('Fictional Employee A');
  const boss=await actor('Fictional Company B superior',{companyId:b.id,departmentId:b.departmentId,roleCompanyId:b.id});
  const bHr=await actor('Fictional Company B HR',{role:'hr_admin',companyId:b.id,departmentId:b.departmentId,roleCompanyId:b.id});
  const aHr=await actor('Fictional Company A HR',{role:'hr_admin',roleCompanyId:base.companyId});
  await reports(applicant,boss);
  for(const kind of ['irregularity','self_overtime'] as const){
   const saved=await saveAttendanceWorkflow(adminCtx(base),workflow([applicant],[level([superior(1)]),level([named(aHr)])],{applicationType:kind}));
   if(kind==='irregularity'){
    const preview=await generateAttendanceWorkflowPreview(adminCtx(base),saved.lineageId,1,[base.companyId]);
    expect(preview).toMatchObject({totalMatching:1,warningCount:0});
    const stored=(await getAttendanceWorkflowPreview(adminCtx(base),saved.lineageId,[base.companyId]))!;
    expect(stored.employees[0]).toMatchObject({outcome:'routed',levels:[{level:1,approvers:[{name:'Fictional Company B superior'}]},{level:2}]});
   }
   const id=await submit(applicant,kind),frozen=await requestOf(id);
   expect(frozen.stages[0].approvers).toEqual([expect.objectContaining({kind:'direct_manager',employmentId:boss.employmentId,userId:boss.userId})]);
   expect(frozen.stages[0].approvers[0]).not.toHaveProperty('pendingActivation');
   // Request-bound visibility only: the request and its application, never the employee's Personnel record.
   expect(await readsApplication(boss,id)).toEqual([{id}]);
   expect(await sees(boss,applicant.employmentId)).toEqual([]);
   expect(await readsApplication(bHr,id)).toEqual([]);
   expect(await sees(bHr,applicant.employmentId)).toEqual([]);
   await decide(boss,id,0,'0:0');
   expect(await statusOf(id)).toBe('pending');
   await decide(aHr,id,1,'1:0');
   expect(await statusOf(id)).toBe('approved');
   await owner.db.update(schema.attendanceWorkflowTemplate).set({supersededAt:new Date()}).where(eq(schema.attendanceWorkflowTemplate.lineageId,saved.lineageId));
  }
 });
 it('a final approval by an approver without calculation access keeps the existing HR handoff',async()=>{
  const b=await company('Fictional handoff company');
  const applicant=await actor('Fictional handoff applicant'),boss=await actor('Fictional handoff superior',{companyId:b.id,departmentId:b.departmentId,roleCompanyId:b.id});
  await reports(applicant,boss);
  await saveAttendanceWorkflow(adminCtx(base),workflow([applicant],[level([superior(1)])]));
  const id=await submit(applicant);
  await expect(decide(boss,id,0,'0:0')).rejects.toMatchObject({problem:{code:'hr_handoff_required',levelIndex:0}});
  expect(await statusOf(id)).toBe('pending');
  expect(await participantsOf((await requestOf(id)).id)).toEqual([]);
 });
 it('a named approver may come from another company; another tenant never resolves',async()=>{
  const b=await company('Fictional named-approver company');
  const applicant=await actor('Fictional named applicant'),reviewer=await actor('Fictional named reviewer',{companyId:b.id,departmentId:b.departmentId,roleCompanyId:b.id});
  const resolve=(ids:string[])=>withTenant(adminCtx(base),tx=>tx.execute<{route:{ok:boolean;problem?:{code:string}}}>(sql`select app.attendance_workflow_resolve_v4(${applicant.employmentId}::uuid,${JSON.stringify([{name:'Level 1',mode:'any_one',sources:[{kind:'specific_employee',employmentIds:ids}],hrAlternative:false}])}::jsonb,'[]'::jsonb) as route`));
  expect((await resolve([reviewer.employmentId]))[0].route).toMatchObject({ok:true});
  const other=await seedBase();
  const foreign=await hireEmployee(adminCtx(other),{person:{fullName:'Fictional other tenant employee',primaryEmail:`${randomUUID()}@example.invalid`},companyId:other.companyId,departmentId:other.deptB,employmentType:'full_time',hiredOn:'2020-01-01'});
  await createAppUser(other.tenantId,foreign.personId,'employee');
  expect((await resolve([foreign.employmentId]))[0].route).toMatchObject({ok:false,problem:{code:'employee_unavailable'}});
 });
 it('refuses archived, blocked-equivalent and duplicate logins with a real warning',async()=>{
  const archivedBoss=await actor('Fictional archived superior'),doubleBoss=await actor('Fictional double-login superior');
  await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,archivedBoss.userId!));
  await createAppUser(base.tenantId,doubleBoss.personId,'employee');
  const one=await actor('Fictional archived-line applicant'),two=await actor('Fictional double-line applicant');
  await reports(one,archivedBoss);await reports(two,doubleBoss);
  const saved=await saveAttendanceWorkflow(adminCtx(base),workflow([one,two],[level([superior(1)])]));
  for(const applicant of [one,two])expect(await ownAttendanceSubmissionRoute(applicant.ctx,applicant.employmentId,'irregularity')).toEqual({available:false,reason:'unresolved'});
  expect(await generateAttendanceWorkflowPreview(adminCtx(base),saved.lineageId,1,[base.companyId])).toMatchObject({warningCount:2});
  const stored=(await getAttendanceWorkflowPreview(adminCtx(base),saved.lineageId,[base.companyId]))!;
  expect(Object.fromEntries(stored.warnings.map(w=>[w.employmentId,w.superiorProblem]))).toEqual({[one.employmentId]:'no_login',[two.employmentId]:'multiple_logins'});
 });
});

describe('approvers whose account is pending activation',()=>{
 it('the request waits for the designated person, nobody else can act, and their activated login decides it',async()=>{
  const applicant=await actor('Fictional pending-line applicant'),pending=await actor('Fictional new manager',{login:false});
  const hr=await actor('Fictional final HR',{role:'hr_admin'}),stranger=await actor('Fictional unrelated colleague');
  await reports(applicant,pending);
  const saved=await saveAttendanceWorkflow(adminCtx(base),workflow([applicant],[level([superior(1)]),level([named(hr)])]));
  await generateAttendanceWorkflowPreview(adminCtx(base),saved.lineageId,1,[base.companyId]);
  const stored=(await getAttendanceWorkflowPreview(adminCtx(base),saved.lineageId,[base.companyId]))!;
  expect(stored.warningCount).toBe(0);
  expect(stored.employees[0].levels[0].approvers).toEqual([expect.objectContaining({name:'Fictional new manager',pendingActivation:true})]);
  const id=await submit(applicant),frozen=await requestOf(id);
  expect(frozen.stages[0].approvers).toEqual([expect.objectContaining({employmentId:pending.employmentId,personId:pending.personId,userId:null,pendingActivation:true})]);
  for(const who of [stranger,hr])await expect(decide(who,id,0,'0:0')).rejects.toThrow();
  expect(await participantsOf(frozen.id)).toEqual([]);
  const activated=await activate(pending);
  expect(await readsApplication(activated,id)).toEqual([{id}]);
  await decide(activated,id,0,'0:0');
  expect(await statusOf(id)).toBe('pending');
  const [evidence]=await participantsOf(frozen.id);
  expect(evidence).toMatchObject({stageIndex:0,actualUserId:activated.userId,actualPersonId:pending.personId,actingMode:'assigned'});
  expect((await requestOf(id)).createdAt).toEqual(frozen.createdAt);
  await decide(hr,id,1,'1:0');
  expect(await statusOf(id)).toBe('approved');
 });
 it('a named approver without an account is retained; a second login later makes the slot unusable, not reassigned',async()=>{
  const applicant=await actor('Fictional named-pending applicant'),pending=await actor('Fictional named pending approver',{login:false}),hr=await actor('Fictional named final HR',{role:'hr_admin'});
  await saveAttendanceWorkflow(adminCtx(base),workflow([applicant],[level([named(pending)]),level([named(hr)])]));
  const id=await submit(applicant);
  expect((await requestOf(id)).stages[0].approvers[0]).toMatchObject({userId:null,pendingActivation:true});
  const first=await activate(pending),second=await activate(pending);
  for(const who of [first,second])await expect(decide(who,id,0,'0:0')).rejects.toThrow();
  await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,second.userId!));
  await decide(first,id,0,'0:0');
  expect((await requestOf(id)).currentStage).toBe(1);
 });
});

describe('Escalation Approval',()=>{
 const today=()=>todayInKualaLumpur();
 async function threeLevels(patch:{firstMode?:AttendanceV4Level['mode'];first?:AttendanceV4Level['sources']}={}){
  const applicant=await actor('Fictional escalation applicant'),one=await actor('Fictional Level 1 superior'),two=await actor('Fictional Level 2 head'),hr=await actor('Fictional Level 3 HR',{role:'hr_admin'});
  await reports(applicant,one);await reports(one,two);
  await saveAttendanceWorkflow(adminCtx(base),workflow([applicant],[
   level(patch.first??[superior(1)],{mode:patch.firstMode??'any_one',escalateAfterDays:3}),
   level([superior(2)],{escalateAfterDays:5}),
   level([named(hr)]),
  ]));
  const id=await submit(applicant);
  return {applicant,one,two,hr,id,request:await requestOf(id)};
 }
 it('moves Level 1 after 3 days and Level 2 after 5, once each, never past the final level and never deciding',async()=>{
  const f=await threeLevels();
  expect(f.request.stages.map(stage=>stage.escalateAfterDays)).toEqual([3,5,undefined]);
  expect(f.request.escalateOn).toBe(addDaysIso(today(),4));
  expect(await sweepAttendanceWorkflowEscalations(system(),{today:addDaysIso(today(),3)})).toMatchObject({escalated:0});
  expect(await sweepAttendanceWorkflowEscalations(system(),{today:addDaysIso(today(),4)})).toMatchObject({escalated:1,failed:0});
  expect(await sweepAttendanceWorkflowEscalations(system(),{today:addDaysIso(today(),4)})).toMatchObject({escalated:0});
  let request=await requestOf(f.id);
  expect(request.currentStage).toBe(1);expect(request.escalateOn).toBe(addDaysIso(today(),6));
  const [first]=await escalationsOf(f.request.id);
  expect(first).toMatchObject({stageIndex:0,nextStageIndex:1,escalateAfterDays:3,dueOn:addDaysIso(today(),4),actor:'system',reason:'no_decision_within_period',partialDecisions:[]});
  expect(first.fromParticipants.map(a=>a.employmentId)).toEqual([f.one.employmentId]);
  expect(first.nextParticipants.map(a=>a.employmentId)).toEqual([f.two.employmentId]);
  const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,f.id),eq(schema.domainEvent.eventType,ATTENDANCE_ESCALATION_EVENT)));
  expect(events).toHaveLength(1);expect(events[0]).toMatchObject({actorType:'system',subjectEmploymentId:f.applicant.employmentId});
  // The earlier approver can still read it but can no longer act.
  expect(await readsApplication(f.one,f.id)).toEqual([{id:f.id}]);
  await expect(decide(f.one,f.id,0,'0:0')).rejects.toThrow();
  await sweepAttendanceWorkflowEscalations(system(),{today:addDaysIso(today(),6)});
  request=await requestOf(f.id);
  expect(request.currentStage).toBe(2);expect(request.escalateOn).toBeNull();
  expect(await sweepAttendanceWorkflowEscalations(system(),{today:addDaysIso(today(),400)})).toMatchObject({escalated:0});
  expect((await requestOf(f.id)).currentStage).toBe(2);
  expect(await statusOf(f.id)).toBe('pending');
  expect(await completionsOf(f.request.id)).toEqual([]);
  expect((await escalationsOf(f.request.id)).map(e=>e.stageIndex)).toEqual([0,1]);
  await decide(f.hr,f.id,2,'2:0');
  expect(await statusOf(f.id)).toBe('approved');
 });
 it('concurrent runners record one escalation for the level',async()=>{
  const f=await threeLevels(),due=addDaysIso(today(),4);
  const results=await Promise.all([1,2,3].map(()=>sweepAttendanceWorkflowEscalations(system(),{today:due})));
  expect(results.reduce((n,r)=>n+r.escalated,0)).toBe(1);
  expect((await escalationsOf(f.request.id)).map(e=>e.stageIndex)).toEqual([0]);
  expect((await requestOf(f.id)).currentStage).toBe(1);
 });
 it('a racing decision and escalation have exactly one winner',async()=>{
  const f=await threeLevels();
  const [decision,sweep]=await Promise.allSettled([decide(f.one,f.id,0,'0:0'),sweepAttendanceWorkflowEscalations(system(),{today:addDaysIso(today(),4)})]);
  const decided=decision.status==='fulfilled',escalated=sweep.status==='fulfilled'&&sweep.value.escalated===1;
  expect(decided!==escalated).toBe(true);
  expect((await requestOf(f.id)).currentStage).toBe(1);
  expect((await escalationsOf(f.request.id)).length).toBe(escalated?1:0);
  expect((await completionsOf(f.request.id)).length).toBe(decided?1:0);
 });
 it('keeps an incomplete Everyone level\'s approvals and marks the level escalated, never approved',async()=>{
  const x=await actor('Fictional Everyone X'),y=await actor('Fictional Everyone Y');
  const f=await threeLevels({first:[named(x,y)],firstMode:'all_required'});
  await decide(x,f.id,0,'0:0');
  expect((await requestOf(f.id)).currentStage).toBe(0);
  expect(await sweepAttendanceWorkflowEscalations(system(),{today:addDaysIso(today(),4)})).toMatchObject({escalated:1});
  const [row]=await escalationsOf(f.request.id);
  expect(row.partialDecisions).toEqual([expect.objectContaining({slot:'0:0',decision:'approved',actualPersonId:x.personId})]);
  expect(await completionsOf(f.request.id)).toEqual([]);
  expect((await participantsOf(f.request.id)).map(p=>[p.stageIndex,p.participantSlot])).toEqual([[0,'0:0']]);
  await expect(decide(y,f.id,0,'0:1')).rejects.toThrow();
  expect(await statusOf(f.id)).toBe('pending');
 });
 it('a rejected or cancelled request never escalates, and its due date is cleared',async()=>{
  const cancelled=await threeLevels();
  await cancelOwnAttendanceCorrection(cancelled.applicant.ctx,{correctionId:cancelled.id});
  expect(await sweepAttendanceWorkflowEscalations(system(),{today:addDaysIso(today(),30)})).toMatchObject({escalated:0,failed:0});
  expect(await escalationsOf(cancelled.request.id)).toEqual([]);
  expect((await requestOf(cancelled.id))).toMatchObject({currentStage:0,escalateOn:null});
 });
 it('the final level, and a level left last by a skipped one, never escalate',async()=>{
  const applicant=await actor('Fictional skipped-last applicant'),one=await actor('Fictional only superior');await reports(applicant,one);
  await saveAttendanceWorkflow(adminCtx(base),workflow([applicant],[level([superior(1)],{escalateAfterDays:2}),level([superior(2)])]));
  const id=await submit(applicant),request=await requestOf(id);
  expect(request.stages).toHaveLength(1);expect(request.escalateOn).toBeNull();
  expect(await sweepAttendanceWorkflowEscalations(system(),{today:addDaysIso(today(),30)})).toMatchObject({escalated:0});
  expect(()=>parseAttendanceV4Route({routingVersion:4,stages:[{name:'Level 1',mode:'any_one',sources:[superior(1)],hrAlternative:false,escalateAfterDays:2}],cc:[]})).toThrow();
  for(const days of [0,366,1.5,'3'])expect(()=>parseAttendanceV4Route({routingVersion:4,stages:[{name:'Level 1',mode:'any_one',sources:[superior(1)],hrAlternative:false,escalateAfterDays:days},{name:'Level 2',mode:'any_one',sources:[superior(2)],hrAlternative:false}],cc:[]})).toThrow();
 });
 it('only the no-login system context may run the escalation owner',async()=>{
  const f=await threeLevels();
  await expect(withTenant(f.hr.ctx,tx=>tx.execute(sql`select app.attendance_workflow_escalate(${f.request.id}::uuid,${addDaysIso(today(),30)}::date)`))).rejects.toMatchObject({cause:expect.objectContaining({code:'42501'})});
  await expect(sweepAttendanceWorkflowEscalations(f.hr.ctx,{today:addDaysIso(today(),30)})).rejects.toThrow();
  // A direct advance without a decision or escalation row is refused or matches nothing under row security.
  await withTenant(f.hr.ctx,tx=>tx.execute(sql`update attendance_workflow_request set current_stage=1 where id=${f.request.id}::uuid`)).catch(()=>undefined);
  expect((await requestOf(f.id)).currentStage).toBe(0);
 });
 it('pages a 70-company tenant in bounded batches with one escalation per request',async()=>{
  // Measured locally-shaped estimate: ~70 hires and submissions; the explicit timeout is about 3x the expected run.
  const companies=await Promise.all(Array.from({length:70},(_,i)=>company(`Fictional runner company ${i+1}`)));
  const ids:string[]=[];
  const boss=await actor('Fictional group superior');
  for(const [index,entry] of companies.entries()){
   const applicant=await actor(`Fictional runner applicant ${index+1}`,{companyId:entry.id,departmentId:entry.departmentId});
   await reports(applicant,boss);
   await saveAttendanceWorkflow(adminCtx(base),workflow([applicant],[level([superior(1)],{escalateAfterDays:1}),level([named(await actor(`Fictional runner HR ${index+1}`,{role:'hr_admin'}))])],{companyId:entry.id}));
   ids.push(await submit(applicant));
  }
  const result=await sweepAttendanceWorkflowEscalations(system(),{today:addDaysIso(today(),2),batchSize:25});
  expect(result).toMatchObject({escalated:70,examined:70,failed:0,batches:3,cappedOut:false});
  const rows=await owner.db.select({requestId:schema.attendanceWorkflowEscalation.requestId}).from(schema.attendanceWorkflowEscalation);
  expect(new Set(rows.map(r=>r.requestId)).size).toBe(70);
  expect(await sweepAttendanceWorkflowEscalations(system(),{today:addDaysIso(today(),2),batchSize:25})).toMatchObject({escalated:0});
 },300_000);
});
