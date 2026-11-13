// Board 96a54ed2: Request On Behalf and Approve On Behalf for Attendance Irregularity and Self Overtime. All people,
// companies and dates are fictional.
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {checkIn,checkOut,requestAttendanceCorrection,decideAttendanceCorrection} from '../core/attendance';
import {saveAttendanceWorkflow,attendanceWorkflowForTx} from '../core/attendance-workflow';
import {attendanceOnBehalfApprovals,attendanceOnBehalfSubject,requestAttendanceCorrectionOnBehalf,searchAttendanceOnBehalfSubjects,attendanceSubmissionRouteOnBehalf} from '../core/attendance-on-behalf';
import type {AttendanceV4WorkflowInput,AttendanceV4Level} from '../lib/attendance-workflow-v4';
import {addDaysIso} from '../core/leave-escalation';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,createAppUser,owner,closeAll,migrateTestDb,resetDb,seedBase,type Base} from './harness';

let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();base=await seedBase();});

type Role='employee'|'manager'|'hr_admin';
type Actor=Awaited<ReturnType<typeof actor>>;
async function actor(name:string,options:{role?:Role;login?:boolean;companyId?:string;departmentId?:string;roleCompanyId?:string|null}={}){
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:`${randomUUID()}@example.invalid`},companyId:options.companyId??base.companyId,departmentId:options.departmentId??base.deptB,employmentType:'full_time',hiredOn:'2020-01-01'});
 const role=options.role??'employee',roleCompanyId=options.roleCompanyId===undefined?null:options.roleCompanyId;
 const userId=options.login===false?null:await createAppUser(base.tenantId,hired.personId,role);
 if(userId&&roleCompanyId)await owner.db.update(schema.roleAssignment).set({companyId:roleCompanyId}).where(eq(schema.roleAssignment.appUserId,userId));
 const ctx:SessionContext={...adminCtx(base),userId:userId??undefined,personId:hired.personId,roles:[role],grants:[{role,companyId:roleCompanyId}]};
 return{...hired,ctx,userId};
}
async function company(name:string){
 const [row]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:name}).returning();
 const [department]=await owner.db.insert(schema.department).values({tenantId:base.tenantId,companyId:row.id,name:`${name} department`}).returning();
 return {id:row.id,departmentId:department.id};
}
const reports=(subordinate:Actor,manager:Actor)=>setReportingLine(adminCtx(base),{subordinateEmploymentId:subordinate.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
const superior=(depth:number):AttendanceV4Level['sources'][number]=>({kind:'direct_manager',depth});
const named=(...people:Actor[]):AttendanceV4Level['sources'][number]=>({kind:'specific_employee',employmentIds:people.map(p=>p.employmentId)});
const level=(sources:AttendanceV4Level['sources'],mode:AttendanceV4Level['mode']='any_one'):AttendanceV4Level=>({name:'Level 1',mode,sources,hrAlternative:false});
function workflow(employees:Actor[],stages:AttendanceV4Level[],patch:Partial<AttendanceV4WorkflowInput>={}):AttendanceV4WorkflowInput{
 return{companyId:base.companyId,applicationType:'irregularity',routingVersion:4,code:'OB_'+randomUUID().slice(0,8),name:'Fictional on-behalf workflow',priority:100,active:true,criteria:{employeeIds:employees.map(e=>e.employmentId)},stages:stages.map((stage,index)=>({...stage,name:`Level ${index+1}`})),cc:[],...patch};
}
const day=todayInKualaLumpur();
async function clocked(subject:Actor,on=day){const root=adminCtx(base);await checkIn(root,{employmentId:subject.employmentId,date:on,time:'08:00',manual:true});await checkOut(root,{employmentId:subject.employmentId,date:on,time:'17:00',manual:true});}
const fileFor=(by:Actor,subject:Actor,on=day)=>requestAttendanceCorrectionOnBehalf(by.ctx,{employmentId:subject.employmentId,date:on,checkIn:'09:00',checkOut:'18:00',reason:'Fictional on-behalf filing'});
const correctionOf=async(id:string)=>(await owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id,id)))[0];
const requestOf=async(id:string)=>(await owner.db.select().from(schema.attendanceWorkflowRequest).where(eq(schema.attendanceWorkflowRequest.correctionId,id)))[0];
const participantsOf=async(requestId:string)=>owner.db.select().from(schema.attendanceWorkflowParticipantDecision).where(eq(schema.attendanceWorkflowParticipantDecision.requestId,requestId));
const decideFor=(by:Actor,designated:Actor,id:string,stage:number,slot:string,decision:'approved'|'rejected'='approved')=>decideAttendanceCorrection(by.ctx,{correctionId:id,decision,expectedStageIndex:stage,expectedParticipantSlot:slot,onBehalfOfEmploymentId:designated.employmentId,...(decision==='rejected'?{rejectReason:'Fictional on-behalf rejection'}:{})});
const decideSelf=(by:Actor,id:string,stage:number,slot:string)=>decideAttendanceCorrection(by.ctx,{correctionId:id,decision:'approved',expectedStageIndex:stage,expectedParticipantSlot:slot});

describe('Request On Behalf',()=>{
 it('HR files for an employee of a company they administer; the request is the employee\'s, on their own route',async()=>{
  const hr=await actor('Fictional company HR',{role:'hr_admin',roleCompanyId:base.companyId}),employee=await actor('Fictional employee A'),boss=await actor('Fictional superior B');
  await reports(employee,boss);
  await saveAttendanceWorkflow(adminCtx(base),workflow([employee],[level([superior(1)])]));
  await clocked(employee);
  const route=await attendanceSubmissionRouteOnBehalf(hr.ctx,employee.employmentId,'irregularity');
  expect(route).toMatchObject({available:true,firstApprovers:[{name:'Fictional superior B'}]});
  const {correctionId}=await fileFor(hr,employee);
  expect(await correctionOf(correctionId)).toMatchObject({employmentId:employee.employmentId,submittedByUserId:hr.userId,submittedByPersonId:hr.personId,submittedByName:'Fictional company HR',status:'pending'});
  expect((await requestOf(correctionId)).stages[0].approvers.map(a=>a.employmentId)).toEqual([boss.employmentId]);
  const flow=await withTenant(employee.ctx,tx=>attendanceWorkflowForTx(tx,correctionId));
  expect(flow?.submittedByName).toBe('Fictional company HR');
  // The employee's own filing stays unstamped, and a posted submitter is never trusted.
  const own=await requestAttendanceCorrection(employee.ctx,{employmentId:employee.employmentId,date:addDaysIso(day,-1),checkIn:'09:00',checkOut:'18:00',reason:'Fictional own filing'}).catch(()=>null);
  if(own)expect(await correctionOf(own.correctionId)).toMatchObject({submittedByUserId:null,submittedByPersonId:null,submittedByName:null});
  await expect(owner.db.update(schema.attendanceCorrection).set({submittedByName:'Someone else'}).where(eq(schema.attendanceCorrection.id,correctionId))).rejects.toThrow();
 });
 it('refuses HR outside the company, the employee themselves and a missing permission key',async()=>{
  const other=await company('Fictional other company');
  const outsideHr=await actor('Fictional other-company HR',{role:'hr_admin',companyId:other.id,departmentId:other.departmentId,roleCompanyId:other.id});
  const employee=await actor('Fictional employee outside HR scope');
  expect(await attendanceOnBehalfSubject(outsideHr.ctx,'request',employee.employmentId)).toBeNull();
  await expect(fileFor(outsideHr,employee)).rejects.toMatchObject({code:'notAllowed'});
  await expect(fileFor(employee,employee)).rejects.toMatchObject({code:'notAllowed'});
  const hr=await actor('Fictional HR without key',{role:'hr_admin',roleCompanyId:base.companyId});
  await owner.db.insert(schema.payrollPermissionGrant).values({tenantId:base.tenantId,permissionKey:'attendance.request_on_behalf',role:'hr_admin',allowed:false,companyId:null});
  expect(await attendanceOnBehalfSubject(hr.ctx,'request',employee.employmentId)).toBeNull();
  await expect(fileFor(hr,employee)).rejects.toMatchObject({code:'notAllowed'});
  expect(await owner.db.select().from(schema.attendanceCorrection)).toEqual([]);
 });
 it('a superior acts only for people beneath them: never their own manager, a peer or another team',async()=>{
  const top=await actor('Fictional top manager',{role:'manager'}),mid=await actor('Fictional middle manager',{role:'manager'}),peer=await actor('Fictional peer manager',{role:'manager'});
  const report=await actor('Fictional direct report'),indirect=await actor('Fictional indirect report'),otherTeam=await actor('Fictional other team member');
  await reports(mid,top);await reports(peer,top);await reports(report,mid);await reports(indirect,report);await reports(otherTeam,peer);
  for(const subject of [report,indirect])expect(await attendanceOnBehalfSubject(mid.ctx,'request',subject.employmentId)).toMatchObject({employmentId:subject.employmentId});
  for(const subject of [top,peer,otherTeam])expect(await attendanceOnBehalfSubject(mid.ctx,'request',subject.employmentId)).toBeNull();
  const found=await searchAttendanceOnBehalfSubjects(mid.ctx,{purpose:'request',query:'Fictional',page:0});
  expect(found.rows.map(r=>r.employmentId).sort()).toEqual([report.employmentId,indirect.employmentId].sort());
  // The default keys are hr_admin, super_admin and manager: an employee-role login gets no list.
  expect((await searchAttendanceOnBehalfSubjects(report.ctx,{purpose:'request',query:'',page:0})).rows).toEqual([]);
 });
 it('two simultaneous filings for one day give one application',async()=>{
  const hr=await actor('Fictional double-click HR',{role:'hr_admin'}),employee=await actor('Fictional double-click employee'),boss=await actor('Fictional double-click superior');
  await reports(employee,boss);await saveAttendanceWorkflow(adminCtx(base),workflow([employee],[level([superior(1)])]));await clocked(employee);
  const results=await Promise.allSettled([fileFor(hr,employee),fileFor(hr,employee)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(await owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.employmentId,employee.employmentId))).toHaveLength(1);
 });
});

describe('per-company permission keys',()=>{
 it('a role counts only for the company it covers: HR in one company does not lift a superior\'s denial in another',async()=>{
  const other=await company('Fictional company B with its own override');
  const user=await actor('Fictional HR-in-A, superior-in-B',{role:'hr_admin',roleCompanyId:base.companyId,companyId:other.id,departmentId:other.departmentId});
  await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.userId!,companyId:other.id,role:'manager'});
  const ctx:SessionContext={...user.ctx,roles:['hr_admin','manager'],grants:[{role:'hr_admin',companyId:base.companyId},{role:'manager',companyId:other.id}]};
  const report=await actor('Fictional report in B',{companyId:other.id,departmentId:other.departmentId});
  await setReportingLine(adminCtx(base),{subordinateEmploymentId:report.employmentId,managerEmploymentId:user.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
  await owner.db.insert(schema.payrollPermissionGrant).values([
   {tenantId:base.tenantId,permissionKey:'attendance.request_on_behalf',role:'manager',allowed:false,companyId:other.id},
   {tenantId:base.tenantId,permissionKey:'attendance.request_on_behalf',role:'hr_admin',allowed:true,companyId:other.id}]);
  expect(await attendanceOnBehalfSubject(ctx,'request',report.employmentId)).toBeNull();
  await owner.db.delete(schema.payrollPermissionGrant).where(eq(schema.payrollPermissionGrant.role,'manager'));
  expect(await attendanceOnBehalfSubject(ctx,'request',report.employmentId)).toBeNull(); // hr_admin is not held in B
  await owner.db.insert(schema.payrollPermissionGrant).values({tenantId:base.tenantId,permissionKey:'attendance.request_on_behalf',role:'manager',allowed:true,companyId:other.id});
  expect(await attendanceOnBehalfSubject(ctx,'request',report.employmentId)).toMatchObject({employmentId:report.employmentId});
 });
});

describe('Approve On Behalf',()=>{
 async function routed(stages:(people:{a:Actor;b:Actor;c:Actor})=>AttendanceV4Level[]){
  // B is an HR administrator so a final approval by B has the calculation access the final effect needs.
  const employee=await actor('Fictional applicant'),a=await actor('Fictional approver A'),b=await actor('Fictional approver B',{role:'hr_admin'}),c=await actor('Fictional approver C',{role:'hr_admin'});
  const hr=await actor('Fictional acting HR',{role:'hr_admin',roleCompanyId:base.companyId});
  await saveAttendanceWorkflow(adminCtx(base),workflow([employee],stages({a,b,c})));
  await clocked(employee);
  const {correctionId}=await requestAttendanceCorrection(employee.ctx,{employmentId:employee.employmentId,date:day,checkIn:'09:00',checkOut:'18:00',reason:'Fictional application'});
  return {employee,a,b,c,hr,id:correctionId,request:await requestOf(correctionId)};
 }
 it('records Approved On Behalf for the designated approver, then routes to the next level',async()=>{
  const f=await routed(({a,b})=>[level([named(a)]),level([named(b)])]);
  const list=await attendanceOnBehalfApprovals(f.hr.ctx,f.a.employmentId);
  expect(list?.rows).toEqual([{correctionId:f.id,slot:'0:0',stageIndex:0}]);
  expect((await attendanceOnBehalfApprovals(f.hr.ctx,f.b.employmentId))?.rows).toEqual([]);
  await decideFor(f.hr,f.a,f.id,0,'0:0');
  const [evidence]=await participantsOf(f.request.id);
  expect(evidence).toMatchObject({stageIndex:0,actingMode:'on_behalf',actualUserId:f.hr.userId,actualPersonId:f.hr.personId,assigned:expect.objectContaining({employmentId:f.a.employmentId})});
  expect((await requestOf(f.id)).currentStage).toBe(1);
  // One person still cannot act on two levels of the same application.
  await expect(decideFor(f.hr,f.b,f.id,1,'1:0')).rejects.toThrow();
  await decideSelf(f.b,f.id,1,'1:0');
  expect((await correctionOf(f.id)).status).toBe('approved');
  const events=await owner.db.select({payload:schema.domainEvent.payload}).from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,f.id),eq(schema.domainEvent.eventType,'attendance-workflow.stage.decided')));
  expect(events.map(e=>(e.payload as {actingMode:string}).actingMode).sort()).toEqual(['assigned','on_behalf']);
 });
 it('Rejected On Behalf needs a reason and ends the application',async()=>{
  const f=await routed(({a})=>[level([named(a)])]);
  await decideFor(f.hr,f.a,f.id,0,'0:0','rejected');
  expect((await correctionOf(f.id)).status).toBe('rejected');
  expect((await participantsOf(f.request.id))[0]).toMatchObject({decision:'rejected',actingMode:'on_behalf'});
 });
 it('keeps Everyone and in-order rules: only outstanding slots, and the level completes only when all have decided',async()=>{
  const everyone=await routed(({a,b,c})=>[level([named(a,b)],'all_required'),level([named(c)])]);
  await decideFor(everyone.hr,everyone.b,everyone.id,0,'0:1');
  expect((await requestOf(everyone.id)).currentStage).toBe(0);
  await decideSelf(everyone.a,everyone.id,0,'0:0');
  expect((await requestOf(everyone.id)).currentStage).toBe(1);
  await resetDb();base=await seedBase();
  const ordered=await routed(({a,b,c})=>[level([named(a,b)],'sequential'),level([named(c)])]);
  expect((await attendanceOnBehalfApprovals(ordered.hr.ctx,ordered.b.employmentId))?.rows).toEqual([]);
  await expect(decideFor(ordered.hr,ordered.b,ordered.id,0,'0:1')).rejects.toThrow();
  await decideFor(ordered.hr,ordered.a,ordered.id,0,'0:0');
  expect((await requestOf(ordered.id)).currentStage).toBe(0);
 });
 it('refuses the applicant, the designated approver, a non-holder and a superior outside the approver\'s line',async()=>{
  const f=await routed(({a,b})=>[level([named(a)]),level([named(b)])]);
  await expect(decideFor(f.employee,f.a,f.id,0,'0:0')).rejects.toThrow();
  await expect(decideFor(f.a,f.a,f.id,0,'0:0')).rejects.toThrow();
  const stranger=await actor('Fictional unrelated manager',{role:'manager'});
  expect(await attendanceOnBehalfApprovals(stranger.ctx,f.a.employmentId)).toBeNull();
  await expect(decideFor(stranger,f.a,f.id,0,'0:0')).rejects.toThrow();
  expect(await participantsOf(f.request.id)).toEqual([]);
 });
 it('the person who filed on the employee\'s behalf can never decide it; HR may decide for them instead',async()=>{
  const employee=await actor('Fictional filed-for employee'),boss=await actor('Fictional filing superior',{role:'manager'}),hr=await actor('Fictional deciding HR',{role:'hr_admin'});
  await reports(employee,boss);
  await saveAttendanceWorkflow(adminCtx(base),workflow([employee],[level([superior(1)]),level([named(hr)])]));
  await clocked(employee);
  const {correctionId}=await fileFor(boss,employee);
  await expect(decideSelf(boss,correctionId,0,'0:0')).rejects.toThrow();
  expect(await withTenant(boss.ctx,tx=>tx.execute<{slot:unknown}>(sql`select app.attendance_workflow_v3_decision_slot(${correctionId}::uuid) as slot`))).toEqual([{slot:null}]);
  await decideFor(hr,boss,correctionId,0,'0:0');
  expect((await requestOf(correctionId)).currentStage).toBe(1);
 });
 it('works for an approver whose account is not activated yet',async()=>{
  const employee=await actor('Fictional waiting applicant'),pending=await actor('Fictional pending approver',{login:false}),hr=await actor('Fictional activation HR',{role:'hr_admin'}),last=await actor('Fictional final approver',{role:'hr_admin'});
  await saveAttendanceWorkflow(adminCtx(base),workflow([employee],[level([named(pending)]),level([named(last)])]));
  await clocked(employee);
  const {correctionId}=await requestAttendanceCorrection(employee.ctx,{employmentId:employee.employmentId,date:day,checkIn:'09:00',checkOut:'18:00',reason:'Fictional waiting application'});
  expect((await requestOf(correctionId)).stages[0].approvers[0]).toMatchObject({userId:null,pendingActivation:true});
  await decideFor(hr,pending,correctionId,0,'0:0');
  expect((await requestOf(correctionId)).currentStage).toBe(1);
 });
 it('two simultaneous on-behalf decisions record one participant decision',async()=>{
  const f=await routed(({a,b})=>[level([named(a)]),level([named(b)])]);
  const other=await actor('Fictional second HR',{role:'hr_admin'});
  const results=await Promise.allSettled([decideFor(f.hr,f.a,f.id,0,'0:0'),decideFor(other,f.a,f.id,0,'0:0')]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect(await participantsOf(f.request.id)).toHaveLength(1);
 });
});

describe('group-shaped reads',()=>{
 it('searches 70 companies and 1,000 employments in one bounded page, under all companies and under one company',async()=>{
  // Direct fixture rows (fictional) keep this a read-shape test; ~1,000 hires through the service would dominate it.
  const companies=await Promise.all(Array.from({length:70},(_,i)=>company(`Fictional group company ${String(i).padStart(2,'0')}`)));
  const people=await owner.db.insert(schema.person).values(Array.from({length:1000},(_,i)=>({tenantId:base.tenantId,fullName:`Fictional group person ${String(i).padStart(4,'0')}`,primaryEmail:`group-${i}-${randomUUID()}@example.invalid`}))).returning({id:schema.person.id});
  await owner.db.insert(schema.employment).values(people.map((p,i)=>({tenantId:base.tenantId,personId:p.id,companyId:companies[i%70].id,employeeCode:`GRP-${String(i).padStart(4,'0')}`,hiredOn:'2020-01-01'})));
  const groupHr=await actor('Fictional group HR',{role:'hr_admin'});
  const started=Date.now();
  const first=await searchAttendanceOnBehalfSubjects(groupHr.ctx,{purpose:'request',query:'GRP-',page:0});
  expect(first.rows).toHaveLength(25);expect(first.more).toBe(true);
  expect(first.rows.map(r=>r.employeeCode)).toEqual(Array.from({length:25},(_,i)=>`GRP-${String(i).padStart(4,'0')}`));
  const last=await searchAttendanceOnBehalfSubjects(groupHr.ctx,{purpose:'request',query:'GRP-',page:39});
  expect(last.rows).toHaveLength(25);expect(last.more).toBe(false);
  expect(Date.now()-started).toBeLessThan(20_000);
  const oneCompanyHr=await actor('Fictional single-company HR',{role:'hr_admin',roleCompanyId:companies[3].id});
  const scoped=await searchAttendanceOnBehalfSubjects(oneCompanyHr.ctx,{purpose:'request',query:'GRP-',page:0});
  expect(scoped.rows.every(r=>r.companyId===companies[3].id)).toBe(true);
  expect(scoped.rows.length).toBeGreaterThan(10);expect(scoped.more).toBe(false);
 },120_000);
});
