// Owner decision 2026-11-12 (board daa76ed4, migration 5143): a legitimately assigned approver in another company of the
// tenant gives the final decision themselves through a request-bound read window, with no Personnel access outside it.
// All people, companies and dates are fictional.
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {checkIn,checkOut,requestAttendanceCorrection,decideAttendanceCorrection} from '../core/attendance';
import {saveAttendanceWorkflow} from '../core/attendance-workflow';
import type {AttendanceV4WorkflowInput,AttendanceV4Level} from '../lib/attendance-workflow-v4';
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
async function actor(name:string,options:{companyId?:string;departmentId?:string;roleCompanyId?:string|null;b?:Base}={}){
 const at=options.b??base;
 const hired=await hireEmployee(adminCtx(at),{person:{fullName:name,primaryEmail:`${randomUUID()}@example.invalid`},companyId:options.companyId??at.companyId,departmentId:options.departmentId??at.deptB,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(at.tenantId,hired.personId,'employee');
 const roleCompanyId=options.roleCompanyId===undefined?null:options.roleCompanyId;
 if(roleCompanyId)await owner.db.update(schema.roleAssignment).set({companyId:roleCompanyId}).where(eq(schema.roleAssignment.appUserId,userId));
 const ctx:SessionContext={...adminCtx(at),userId,personId:hired.personId,roles:['employee'],grants:[{role:'employee',companyId:roleCompanyId}]};
 return{...hired,ctx,userId};
}
const reports=(subordinate:Actor,manager:Actor)=>setReportingLine(adminCtx(base),{subordinateEmploymentId:subordinate.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
const level=(sources:AttendanceV4Level['sources'],mode:AttendanceV4Level['mode']='any_one'):AttendanceV4Level=>({name:'Level 1',mode,sources,hrAlternative:false});
function workflow(employees:Actor[],stages:AttendanceV4Level[],type:'irregularity'|'self_overtime'):AttendanceV4WorkflowInput{
 return{companyId:base.companyId,applicationType:type,routingVersion:4,code:'W_'+randomUUID().slice(0,8),name:'Fictional window workflow',priority:100,active:true,criteria:{employeeIds:employees.map(e=>e.employmentId)},stages:stages.map((stage,index)=>({...stage,name:`Level ${index+1}`})),cc:[]};
}
const today=todayInKualaLumpur();
async function file(applicant:Actor,type:'irregularity'|'self_overtime'){
 if(type==='self_overtime')return (await requestAttendanceCorrection(applicant.ctx,{employmentId:applicant.employmentId,date:addDaysIso(today,1),requestedOtMinutes:90,requestKind:'self_overtime',reason:'Fictional window overtime'})).correctionId;
 const root=adminCtx(base);
 await checkIn(root,{employmentId:applicant.employmentId,date:today,time:'08:00',manual:true});await checkOut(root,{employmentId:applicant.employmentId,date:today,time:'17:00',manual:true});
 return (await requestAttendanceCorrection(applicant.ctx,{employmentId:applicant.employmentId,date:today,checkIn:'09:00',checkOut:'18:30',reason:'Fictional window correction'})).correctionId;
}
const approve=(who:Actor,id:string)=>decideAttendanceCorrection(who.ctx,{correctionId:id,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'});
const correction=async(id:string)=>(await owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id,id)))[0];
const day=async(subject:Actor)=>{const [row]=await owner.db.select().from(schema.attendance).where(and(eq(schema.attendance.employmentId,subject.employmentId),eq(schema.attendance.attendanceDate,today)));
 return row?{checkInAt:row.checkInAt,checkOutAt:row.checkOutAt,status:row.status,workedMinutes:row.workedMinutes,lateMinutes:row.lateMinutes,earlyOutMinutes:row.earlyOutMinutes,otMinutes:row.otMinutes}:null;};
const reads=async(who:Actor,subject:Actor)=>withTenant(who.ctx,async tx=>({
 employment:(await tx.select({id:schema.employment.id}).from(schema.employment).where(eq(schema.employment.id,subject.employmentId))).length,
 person:(await tx.select({id:schema.person.id}).from(schema.person).where(eq(schema.person.id,subject.personId))).length,
 attendance:(await tx.select({id:schema.attendance.id}).from(schema.attendance).where(eq(schema.attendance.employmentId,subject.employmentId))).length,
 visible:(await tx.execute<{ok:boolean}>(sql`select app.can_see_employment(${subject.employmentId}::uuid) as ok, ${subject.employmentId}::uuid = any(app.visible_employment_ids()) as listed`))[0],
}));
const nothing={employment:0,person:0,attendance:0,visible:{ok:false,listed:false}};

async function pair(type:'irregularity'|'self_overtime'){
 const b=await company('Fictional Company B');
 const crossApplicant=await actor('Fictional Irwin applicant'),crossBoss=await actor('Fictional Company B superior',{companyId:b.id,departmentId:b.departmentId,roleCompanyId:b.id});
 const localApplicant=await actor('Fictional same-company applicant'),localBoss=await actor('Fictional same-company superior');
 await reports(crossApplicant,crossBoss);await reports(localApplicant,localBoss);
 await saveAttendanceWorkflow(adminCtx(base),workflow([crossApplicant,localApplicant],[level([{kind:'direct_manager',depth:1}])],type));
 return {crossApplicant,crossBoss,localApplicant,localBoss,crossId:await file(crossApplicant,type),localId:await file(localApplicant,type)};
}

describe('request-bound final decision window',()=>{
 it('a Company B superior completes Company A Attendance Irregularity with the same payable result as a same-company approval',async()=>{
  const f=await pair('irregularity');
  expect(await reads(f.crossBoss,f.crossApplicant)).toEqual(nothing);
  await approve(f.crossBoss,f.crossId);await approve(f.localBoss,f.localId);
  expect((await correction(f.crossId)).status).toBe('approved');
  const cross=await day(f.crossApplicant),local=await day(f.localApplicant);
  expect(cross).not.toBeNull();expect(cross).toEqual(local);
  expect(cross).toMatchObject({checkInAt:expect.stringMatching(/^09:00/),checkOutAt:expect.stringMatching(/^18:30/)});
  // A later statement after the commit: still nothing outside the window.
  expect(await reads(f.crossBoss,f.crossApplicant)).toEqual(nothing);
 });
 it('a Company B superior completes Self Overtime identically, and an OT-bearing final rejection is theirs too',async()=>{
  const f=await pair('self_overtime');
  const crossResult=await approve(f.crossBoss,f.crossId),localResult=await approve(f.localBoss,f.localId);
  expect(crossResult).toEqual(localResult);
  const pick=(row:typeof schema.attendanceCorrection.$inferSelect)=>({status:row.status,approvedOtMinutes:row.approvedOtMinutes,otApprovalMethod:row.otApprovalMethod,appliedAt:row.appliedAt});
  expect(pick(await correction(f.crossId))).toEqual(pick(await correction(f.localId)));
  expect((await correction(f.crossId)).status).toBe('approved');
  expect(await reads(f.crossBoss,f.crossApplicant)).toEqual(nothing);
  const second=(await requestAttendanceCorrection(f.crossApplicant.ctx,{employmentId:f.crossApplicant.employmentId,date:addDaysIso(today,2),requestedOtMinutes:30,requestKind:'self_overtime',reason:'Fictional second overtime'})).correctionId;
  await decideAttendanceCorrection(f.crossBoss.ctx,{correctionId:second,decision:'rejected',rejectReason:'Fictional reason',expectedStageIndex:0,expectedParticipantSlot:'0:0'});
  expect((await correction(second)).status).toBe('rejected');
 });
 it('a forged hint, a non-assigned colleague and another tenant open nothing',async()=>{
  const f=await pair('irregularity');
  const colleague=await actor('Fictional unassigned colleague');
  for(const who of [f.crossBoss,colleague]){
   const forged=await withTenant(who.ctx,async tx=>{
    await tx.execute(sql`select set_config('app.attendance_workflow_effect',${f.crossId},true)`);
    await tx.execute(sql`select set_config('app.attendance_final_window',${f.crossId+'/'+f.crossApplicant.employmentId+'/'+'0'.repeat(32)},true)`);
    const [row]=await tx.execute<{ok:boolean}>(sql`select app.can_see_employment(${f.crossApplicant.employmentId}::uuid) as ok`);
    const people=await tx.select({id:schema.employment.id}).from(schema.employment).where(eq(schema.employment.id,f.crossApplicant.employmentId));
    await tx.execute(sql`select set_config('app.attendance_workflow_effect','',true),set_config('app.attendance_final_window','',true)`);
    const [opened]=await tx.execute<{ok:boolean}>(sql`select app.attendance_workflow_open_final_window(${f.crossId}::uuid) as ok`);
    return {visible:row.ok,people:people.length,opened:opened.ok};
   });
   expect(forged).toEqual({visible:false,people:0,opened:false});
  }
  await expect(decideAttendanceCorrection(colleague.ctx,{correctionId:f.crossId,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'})).rejects.toThrow();
  const other=await seedBase(),foreigner=await actor('Fictional other tenant user',{b:other});
  const [foreign]=await withTenant(foreigner.ctx,tx=>tx.execute<{ok:boolean}>(sql`select app.attendance_workflow_open_final_window(${f.crossId}::uuid) as ok`));
  expect(foreign.ok).toBe(false);
  expect((await correction(f.crossId)).status).toBe('pending');
 });
 it('a rolled-back savepoint closes the window and leaves the request pending',async()=>{
  const f=await pair('irregularity');
  const outcome=await withTenant(f.crossBoss.ctx,async tx=>{
   await tx.execute(sql`savepoint window_probe`);
   await decideAttendanceCorrection(f.crossBoss.ctx,{correctionId:f.crossId,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'},tx);
   await tx.execute(sql`rollback to savepoint window_probe`);
   await tx.execute(sql`select set_config('app.attendance_final_window',${f.crossId+'/'+f.crossApplicant.employmentId+'/'+'0'.repeat(32)},true)`);
   const [row]=await tx.execute<{ok:boolean}>(sql`select app.can_see_employment(${f.crossApplicant.employmentId}::uuid) as ok`);
   const [opened]=await tx.execute<{ok:boolean}>(sql`select set_config('app.attendance_final_window','',true),app.attendance_workflow_open_final_window(${f.crossId}::uuid) as ok`);
   return row.ok||opened.ok;
  });
  expect(outcome).toBe(false);
  expect((await correction(f.crossId)).status).toBe('pending');
  expect(await owner.db.select().from(schema.attendanceWorkflowParticipantDecision)).toHaveLength(0);
 });
 it('concurrent final decisions by two assigned cross-company approvers have one winner',async()=>{
  const b=await company('Fictional race company');
  const applicant=await actor('Fictional race applicant');
  const x=await actor('Fictional race approver X',{companyId:b.id,departmentId:b.departmentId,roleCompanyId:b.id}),y=await actor('Fictional race approver Y',{companyId:b.id,departmentId:b.departmentId,roleCompanyId:b.id});
  await saveAttendanceWorkflow(adminCtx(base),workflow([applicant],[level([{kind:'specific_employee',employmentIds:[x.employmentId,y.employmentId]}])],'irregularity'));
  const id=await file(applicant,'irregularity');
  const results=await Promise.allSettled([
   decideAttendanceCorrection(x.ctx,{correctionId:id,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'}),
   decideAttendanceCorrection(y.ctx,{correctionId:id,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:1'}),
  ]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect((await correction(id)).status).toBe('approved');
  expect(await owner.db.select().from(schema.attendanceWorkflowParticipantDecision)).toHaveLength(1);
  for(const who of [x,y])expect(await reads(who,applicant)).toEqual(nothing);
 });
 it('a same-company approver never opens the window; a cross-company approval opens it once and it cannot reopen',async()=>{
  const f=await pair('irregularity');
  const spent=async()=>(await owner.client`select count(*)::int as n from app.attendance_final_window_spent`)[0].n;
  // The spent record outlives a test's database reset (owner-only app table), so compare counts, not absolutes.
  const before=await spent();
  await approve(f.localBoss,f.localId);
  expect(await spent()).toBe(before);
  const reopened=await withTenant(f.crossBoss.ctx,async tx=>{
   await decideAttendanceCorrection(f.crossBoss.ctx,{correctionId:f.crossId,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'},tx);
   const [row]=await tx.execute<{ok:boolean;visible:boolean}>(sql`select app.attendance_workflow_open_final_window(${f.crossId}::uuid) as ok,app.can_see_employment(${f.crossApplicant.employmentId}::uuid) as visible`);
   return row;
  });
  expect(reopened).toEqual({ok:false,visible:false});
  expect(await spent()).toBe(before+1);
 });
 it('refuses the window for a final level that is not yet complete',async()=>{
  const b=await company('Fictional Everyone company');
  const applicant=await actor('Fictional Everyone applicant');
  const x=await actor('Fictional Everyone X',{companyId:b.id,departmentId:b.departmentId,roleCompanyId:b.id}),y=await actor('Fictional Everyone Y',{companyId:b.id,departmentId:b.departmentId,roleCompanyId:b.id});
  await saveAttendanceWorkflow(adminCtx(base),workflow([applicant],[level([{kind:'specific_employee',employmentIds:[x.employmentId,y.employmentId]}],'all_required')],'irregularity'));
  const id=await file(applicant,'irregularity');
  const opened=await withTenant(x.ctx,async tx=>{
   await decideAttendanceCorrection(x.ctx,{correctionId:id,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'},tx);
   return (await tx.execute<{ok:boolean}>(sql`select app.attendance_workflow_open_final_window(${id}::uuid) as ok`))[0].ok;
  });
  expect(opened).toBe(false);
  expect((await correction(id)).status).toBe('pending');
 });
 it('returns exactly the reviewed 2105 reader result when no window is installed',async()=>{
  const f=await pair('irregularity');
  const {REVIEWED_VISIBILITY_PREDECESSOR}=await import('./helpers/reviewed-visibility');
  for(const who of [f.crossBoss,f.localBoss]){
   let compared:{current:string[];reviewed:string[]}|null=null;
   await owner.client.begin(async tx=>{
    await tx`select set_config('app.tenant_id',${base.tenantId},true),set_config('app.user_id',${who.userId},true),set_config('app.roles','employee',true),set_config('app.grants','[]',true)`;
    const [current]=await tx<{ids:string[]}[]>`select app.visible_employment_ids() as ids`;
    await tx.unsafe(REVIEWED_VISIBILITY_PREDECESSOR);
    const [reviewed]=await tx<{ids:string[]}[]>`select app.visible_employment_ids() as ids`;
    compared={current:current.ids,reviewed:reviewed.ids};
    throw new Error('discard the reviewed reader');
   }).catch((error:Error)=>{if(error.message!=='discard the reviewed reader')throw error;});
   expect(compared).not.toBeNull();expect(compared!.current).toEqual(compared!.reviewed);
   if(who===f.localBoss)expect(compared!.current).toContain(f.localApplicant.employmentId);
   else expect(compared!.current).not.toContain(f.crossApplicant.employmentId);
  }
 });
});
