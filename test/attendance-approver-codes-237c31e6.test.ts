// Board 237c31e6: the approval progress panel shows each approver as "Name · Employee ID". Two request-bound readers
// (5697) return codes only for identities the caller may already see, once per page. All people, companies, codes
// and dates are fictional.
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,isNull,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {checkIn,checkOut,requestAttendanceCorrection,decideAttendanceCorrection,listAttendanceCorrections,myAttendanceCorrections} from '../core/attendance';
import {saveAttendanceWorkflow,setAttendanceWorkflowEnabled,ownAttendanceSubmissionRoute,attendanceApproverCodesForRequestsTx} from '../core/attendance-workflow';
import {attendanceSubmissionRouteOnBehalf} from '../core/attendance-on-behalf';
import type {AttendanceV4WorkflowInput,AttendanceV4Level} from '../lib/attendance-workflow-v4';
import {todayInKualaLumpur} from '../lib/hr-date';
import {observeNativeRead} from './helpers/native-read-observer';
import {adminCtx,createAppUser,owner,closeAll,migrateTestDb,resetDb,seedBase,type Base} from './harness';

let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();base=await seedBase();});

type Role='employee'|'manager'|'hr_admin';
type Actor=Awaited<ReturnType<typeof actor>>;
async function company(name:string){
 const [row]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:name}).returning();
 const [department]=await owner.db.insert(schema.department).values({tenantId:base.tenantId,companyId:row.id,name:`${name} department`}).returning();
 return {id:row.id,departmentId:department.id};
}
async function actor(name:string,employeeCode:string,options:{role?:Role;companyId?:string;departmentId?:string;roleCompanyId?:string|null}={}){
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:`${randomUUID()}@example.invalid`},companyId:options.companyId??base.companyId,departmentId:options.departmentId??base.deptB,employeeCode,employmentType:'full_time',hiredOn:'2020-01-01'});
 const role=options.role??'employee',roleCompanyId=options.roleCompanyId===undefined?null:options.roleCompanyId;
 const userId=await createAppUser(base.tenantId,hired.personId,role);
 if(roleCompanyId)await owner.db.update(schema.roleAssignment).set({companyId:roleCompanyId}).where(eq(schema.roleAssignment.appUserId,userId));
 const ctx:SessionContext={...adminCtx(base),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:roleCompanyId}]};
 return{...hired,ctx,userId,employeeCode};
}
const day=todayInKualaLumpur();
async function clocked(subject:Actor){const root=adminCtx(base);await checkIn(root,{employmentId:subject.employmentId,date:day,time:'08:00',manual:true});await checkOut(root,{employmentId:subject.employmentId,date:day,time:'17:00',manual:true});}
const submit=async(subject:Actor)=>(await requestAttendanceCorrection(subject.ctx,{employmentId:subject.employmentId,date:day,checkIn:'09:00',checkOut:'18:00',reason:'Fictional approval progress check'})).correctionId;
const superior=(depth:number):AttendanceV4Level['sources'][number]=>({kind:'direct_manager',depth});
const named=(...people:Actor[]):AttendanceV4Level['sources'][number]=>({kind:'specific_employee',employmentIds:people.map(p=>p.employmentId)});
async function saveTwoLevelWorkflow(employees:Actor[],secondLevel:Actor){
 const code='PROG_'+randomUUID().slice(0,8);
 const input:AttendanceV4WorkflowInput={companyId:base.companyId,applicationType:'irregularity',routingVersion:4,code,name:'Fictional two-level approval',priority:100,active:true,
  criteria:{employeeIds:employees.map(e=>e.employmentId)},cc:[],
  stages:[{name:'Level 1',mode:'any_one',sources:[superior(1)],hrAlternative:false},{name:'Level 2',mode:'any_one',sources:[named(secondLevel)],hrAlternative:false}]};
 await saveAttendanceWorkflow(adminCtx(base),input);await setAttendanceWorkflowEnabled(adminCtx(base),base.companyId,'irregularity',true);
 const [template]=await owner.db.select({id:schema.attendanceWorkflowTemplate.id}).from(schema.attendanceWorkflowTemplate)
  .where(and(eq(schema.attendanceWorkflowTemplate.code,code),isNull(schema.attendanceWorkflowTemplate.supersededAt)));
 return template.id;
}
const codesFor=(who:Actor|{ctx:SessionContext},ids:string[])=>withTenant(who.ctx,async tx=>Object.fromEntries([...(await attendanceApproverCodesForRequestsTx(tx,ids)).entries()]));
const routeCodesFor=(who:Actor,subject:Actor,templateId:string)=>withTenant(who.ctx,async tx=>(await tx.execute(sql`select employment_id,employee_code from app.attendance_workflow_route_approver_codes(${subject.employmentId}::uuid,${templateId}::uuid)`) as unknown as {employment_id:string;employee_code:string|null}[])
 .map(row=>[row.employment_id,row.employee_code]).sort());

/** Employee A (EMP-0009 shape) reports to a first-level superior in A's company; the second level is a named approver
 *  employed by ANOTHER company of the tenant (5140), whose code A's own row security cannot read. */
async function scenario(){
 const other=await company('Fictional sister company');
 const first=await actor('Fictional first-level approver','FX-0004');
 const second=await actor('Fictional cross-company approver','FX-0002',{companyId:other.id,departmentId:other.departmentId});
 const subject=await actor('Fictional applicant','FX-0009');
 const colleague=await actor('Fictional colleague','FX-0011');
 const stranger=await actor('Fictional unrelated employee','FX-0013');
 const hr=await actor('Fictional company HR','FX-0020',{role:'hr_admin',roleCompanyId:base.companyId});
 await setReportingLine(adminCtx(base),{subordinateEmploymentId:subject.employmentId,managerEmploymentId:first.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 await setReportingLine(adminCtx(base),{subordinateEmploymentId:colleague.employmentId,managerEmploymentId:first.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 const templateId=await saveTwoLevelWorkflow([subject,colleague],second);
 await clocked(subject);await clocked(colleague);
 const own=await submit(subject),theirs=await submit(colleague);
 return {other,first,second,subject,colleague,stranger,hr,templateId,own,theirs};
}

describe('app.attendance_workflow_approver_codes (frozen requests)',()=>{
 it('returns the subject the codes of their own approvers, including the cross-company one, and nothing for another employee\'s request',async()=>{
  const s=await scenario();
  // The previous reader (employment under the caller's row security) cannot see the other company's approver.
  const previous=await withTenant(s.subject.ctx,tx=>tx.select({id:schema.employment.id,code:schema.employment.employeeCode}).from(schema.employment).where(eq(schema.employment.id,s.second.employmentId)));
  expect(previous).toEqual([]);
  expect(await codesFor(s.subject,[s.own,s.theirs])).toEqual({[s.own]:{[s.first.employmentId]:'FX-0004',[s.second.employmentId]:'FX-0002'}});
  expect(await codesFor(s.colleague,[s.own])).toEqual({});
  expect(await codesFor(s.stranger,[s.own,s.theirs])).toEqual({});
  // An unknown id or an empty page answers nothing, without error.
  expect(await codesFor(s.subject,[randomUUID()])).toEqual({});
  expect(await codesFor(s.subject,[])).toEqual({});
 });

 it('answers HR for their company, the frozen participants, and the decision maker recorded later',async()=>{
  const s=await scenario();
  expect(await codesFor(s.hr,[s.own,s.theirs])).toEqual({
   [s.own]:{[s.first.employmentId]:'FX-0004',[s.second.employmentId]:'FX-0002'},
   [s.theirs]:{[s.first.employmentId]:'FX-0004',[s.second.employmentId]:'FX-0002'}});
  // The cross-company second-level approver is a frozen participant of both requests.
  expect(Object.keys(await codesFor(s.second,[s.own,s.theirs])).sort()).toEqual([s.own,s.theirs].sort());
  // HR of the sister company only is neither the subject's administrator nor a participant.
  const sisterHr=await actor('Fictional sister HR','FX-0030',{role:'hr_admin',roleCompanyId:s.other.id,companyId:s.other.id,departmentId:s.other.departmentId});
  expect(await codesFor(sisterHr,[s.own])).toEqual({});
  await decideAttendanceCorrection(s.first.ctx,{correctionId:s.own,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'});
  expect((await codesFor(s.subject,[s.own]))[s.own]).toEqual({[s.first.employmentId]:'FX-0004',[s.second.employmentId]:'FX-0002'});
 });

 it('reaches every employee screen through the page reader, once per page',async()=>{
  const s=await scenario();
  const probe=observeNativeRead();
  let rows:Awaited<ReturnType<typeof myAttendanceCorrections>>;
  try{rows=await myAttendanceCorrections(s.subject.ctx,s.subject.employmentId,{limit:25});}finally{probe.restore();}
  expect(rows!.map(row=>row.id)).toEqual([s.own]);
  expect(rows![0].workflow?.approverCodes).toEqual({[s.first.employmentId]:'FX-0004',[s.second.employmentId]:'FX-0002'});
  expect(probe.queries.filter(query=>query.sql.includes('attendance_workflow_approver_codes'))).toHaveLength(1);
 });
});

describe('app.attendance_workflow_route_approver_codes (before Submit)',()=>{
 it('returns the route codes to the subject and to Request On Behalf holders only',async()=>{
  const s=await scenario();
  const expected=[[s.first.employmentId,'FX-0004'],[s.second.employmentId,'FX-0002']].sort();
  expect(await routeCodesFor(s.subject,s.subject,s.templateId)).toEqual(expected);
  expect(await routeCodesFor(s.hr,s.subject,s.templateId)).toEqual(expected);
  // The subject's own superior, in their reporting line (the database half of Request On Behalf).
  expect(await routeCodesFor(s.first,s.subject,s.templateId)).toEqual(expected);
  // Another employee, an unrelated employee and a stale/unknown template answer nothing.
  expect(await routeCodesFor(s.colleague,s.subject,s.templateId)).toEqual([]);
  expect(await routeCodesFor(s.stranger,s.subject,s.templateId)).toEqual([]);
  expect(await routeCodesFor(s.subject,s.subject,randomUUID())).toEqual([]);
  // The cross-company second-level approver is not entitled to read the subject's route.
  expect(await routeCodesFor(s.second,s.subject,s.templateId)).toEqual([]);
 });

 it('carries the codes on the submission route, mobile v2 fields unchanged',async()=>{
  const s=await scenario();
  const route=await ownAttendanceSubmissionRoute(s.subject.ctx,s.subject.employmentId,'irregularity');
  expect(route).toMatchObject({available:true,firstApprovers:[{kind:'direct_manager',name:'Fictional first-level approver'}],
   approverCodes:{[s.first.employmentId]:'FX-0004',[s.second.employmentId]:'FX-0002'}});
  expect(route.available&&route.stages.map(stage=>stage.approvers.map(a=>a.name))).toEqual([['Fictional first-level approver'],['Fictional cross-company approver']]);
  const behalf=await attendanceSubmissionRouteOnBehalf(s.hr.ctx,s.subject.employmentId,'irregularity');
  expect(behalf).toMatchObject({available:true,approverCodes:{[s.first.employmentId]:'FX-0004',[s.second.employmentId]:'FX-0002'}});
 });

 it('names the unresolved level and the configured level count when a Direct Superior is missing',async()=>{
  const second=await actor('Fictional named approver','FX-0102');
  const subject=await actor('Fictional applicant without superior','FX-0101');
  await saveTwoLevelWorkflow([subject],second);
  const route=await ownAttendanceSubmissionRoute(subject.ctx,subject.employmentId,'irregularity');
  expect(route).toMatchObject({available:false,reason:'unresolved',problem:{levelIndex:0},levelCount:2});
  expect(route.available).toBe(false);
  if(!route.available)expect(Object.keys(route).sort()).toEqual(['available','levelCount','problem','reason']);
 });
});

describe('group-shaped reads (70 companies, 1,000 employments)',()=>{
 it('reads one page of codes in one statement under All companies and under one company',async()=>{
  // Direct fixture rows (fictional) keep this a read-shape test; ~1,000 hires through the service would dominate it.
  const companies=await Promise.all(Array.from({length:70},(_,i)=>company(`Fictional group company ${String(i).padStart(2,'0')}`)));
  const people=await owner.db.insert(schema.person).values(Array.from({length:1000},(_,i)=>({tenantId:base.tenantId,fullName:`Fictional group person ${String(i).padStart(4,'0')}`,primaryEmail:`group-${i}-${randomUUID()}@example.invalid`}))).returning({id:schema.person.id});
  await owner.db.insert(schema.employment).values(people.map((p,i)=>({tenantId:base.tenantId,personId:p.id,companyId:companies[i%70].id,employeeCode:`GRP-${String(i).padStart(4,'0')}`,hiredOn:'2020-01-01'})));
  const s=await scenario();
  const groupHr=await actor('Fictional group HR','FX-0040',{role:'hr_admin'});
  const otherCompanyHr=await actor('Fictional group company 03 HR','FX-0041',{role:'hr_admin',roleCompanyId:companies[3].id,companyId:companies[3].id,departmentId:companies[3].departmentId});
  // A full page of ids: the two real requests and padding that names no request.
  const page=[s.own,s.theirs,...Array.from({length:23},()=>randomUUID())];
  const both={[s.own]:{[s.first.employmentId]:'FX-0004',[s.second.employmentId]:'FX-0002'},[s.theirs]:{[s.first.employmentId]:'FX-0004',[s.second.employmentId]:'FX-0002'}};
  const expectations:[string,Actor,Record<string,Record<string,string>>][]=[['All companies HR',groupHr,both],['one-company HR',s.hr,both],['another company HR',otherCompanyHr,{}],['subject',s.subject,{[s.own]:both[s.own]}]];
  for(const [label,who,expected] of expectations){
   const probe=observeNativeRead();const started=performance.now();
   let codes:Record<string,Record<string,string|null>>;
   try{codes=await codesFor(who,page);}finally{probe.restore();}
   expect(codes!,label).toEqual(expected);
   const calls=probe.queries.filter(query=>query.sql.includes('attendance_workflow_approver_codes'));
   expect(calls,label).toHaveLength(1);
   expect(performance.now()-started,label).toBeLessThan(10_000);
  }
  // The HR list page reads the codes once for the whole page, whatever its row count.
  const probe=observeNativeRead();
  let rows:Awaited<ReturnType<typeof listAttendanceCorrections>>;
  try{rows=await listAttendanceCorrections(groupHr.ctx,{status:'pending'});}finally{probe.restore();}
  expect(rows!.map(row=>row.id).sort()).toEqual([s.own,s.theirs].sort());
  for(const row of rows!)expect(row.workflow?.approverCodes).toEqual(both[row.id]);
  expect(probe.queries.filter(query=>query.sql.includes('attendance_workflow_approver_codes'))).toHaveLength(1);
  // Equivalence with the previous reader for HR (same codes, same identities) where row security already reached.
  const previous=await withTenant(groupHr.ctx,tx=>tx.select({id:schema.employment.id,code:schema.employment.employeeCode}).from(schema.employment)
   .where(sql`${schema.employment.id} in (${s.first.employmentId}::uuid,${s.second.employmentId}::uuid)`));
  expect(Object.fromEntries(previous.map(row=>[row.id,row.code]))).toEqual(both[s.own]);
 },180_000);
});
