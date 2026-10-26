/** Authored UNRUN: full native correction-request shapes, source drift, real role gates and rollback.
 * Explicit times/minutes/reasons are fictional human inputs; no model computes work or money. */
import {randomUUID} from 'node:crypto';
import {todayInKualaLumpur} from '../lib/hr-date';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {checkIn,checkOut,requestAttendanceCorrection} from '../packs/attendance/service';
import {attendanceClockData} from '../core/attendance-clock-data';
import {saveAttendanceWorkflow,setAttendanceWorkflowEnabled} from '../core/attendance-workflow';
import type {AttendanceWorkflowInput} from '../lib/attendance-workflow';
import {OwnAttendanceCorrectionIntent} from '../lib/assistant-actions/own-attendance-correction-contract';
import {prepareOwnAttendanceCorrectionTx,confirmOwnAttendanceCorrectionTx,reopenOwnAttendanceCorrectionEventTx} from '../core/assistant-actions/own-attendance-correction-source';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
function calendarDate(offset:number){const value=new Date(todayInKualaLumpur()+'T12:00:00Z');value.setUTCDate(value.getUTCDate()+offset);return value.toISOString().slice(0,10);}
let base:Base,date:string;beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();base=await seedBase();date=calendarDate(-2);await setModule(base.tenantId,'attendance','active');await setModule(base.tenantId,'assistant','active');});
async function fixture(role:'employee'|'hr_admin'='employee'){
 const admin=adminCtx(base),h=await hireEmployee(admin,{person:{fullName:'Fictional Attendance Owner',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:`${Number(todayInKualaLumpur().slice(0,4))-2}-01-01`}),userId=await createAppUser(base.tenantId,h.personId,role);
 await grantAssistant(admin,{appUserId:userId});await checkIn(admin,{employmentId:h.employmentId,date,time:'08:00',manual:true});await checkOut(admin,{employmentId:h.employmentId,date,time:'17:00',manual:true});
 const ctx:SessionContext={tenantId:base.tenantId,userId,personId:h.personId,roles:[role],entitlements:harnessSnapshot(base.tenantId)},intent=OwnAttendanceCorrectionIntent.parse({version:1,employmentId:h.employmentId,date,checkIn:'09:00',checkOut:'18:00',reason:'Fictional verified human correction',remark:'Human optional note',requestKind:'other'});
 return {admin,ctx,employmentId:h.employmentId,intent};
}
const prepare=(a:Awaited<ReturnType<typeof fixture>>)=>withTenant(a.ctx,tx=>prepareOwnAttendanceCorrectionTx(tx,a.ctx,a.intent));
const confirm=(a:Awaited<ReturnType<typeof fixture>>,digest:string)=>withTenant(a.ctx,tx=>confirmOwnAttendanceCorrectionTx(tx,a.ctx,a.intent,digest));
async function state(a:Awaited<ReturnType<typeof fixture>>){return {requests:await owner.db.select().from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.employmentId,a.employmentId)).orderBy(schema.attendanceCorrection.id),workflows:await owner.db.select().from(schema.attendanceWorkflowRequest).where(eq(schema.attendanceWorkflowRequest.employmentId,a.employmentId)).orderBy(schema.attendanceWorkflowRequest.id),events:await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.subjectEmploymentId,a.employmentId),eq(schema.domainEvent.eventType,'attendance-correction.requested'))).orderBy(schema.domainEvent.id),attendance:await owner.db.select().from(schema.attendance).where(eq(schema.attendance.employmentId,a.employmentId)).orderBy(schema.attendance.id)};}
describe('own Attendance correction request source',()=>{
 it('retains clock-pair, planned-OT, nested raw-clock and unclocked input contracts without accepting actor/policy/decision overrides',()=>{
  const common={version:1,employmentId:randomUUID(),date,reason:'Human reason'},nested={clockChanges:{version:1,baseline:'0'.repeat(64),entries:[{punchAt:'08:00',direction:'in'}]}};
  expect(OwnAttendanceCorrectionIntent.parse({...common,employmentId:common.employmentId.toUpperCase()}).employmentId).toBe(common.employmentId);
  expect(OwnAttendanceCorrectionIntent.safeParse({...common,...nested}).success).toBe(true);expect(OwnAttendanceCorrectionIntent.safeParse({...common,requestedOtMinutes:60,unclockedWork:{completeWorkedDay:true,intervals:[{fromEpochMillisecond:1,toEpochMillisecond:2}]}}).success).toBe(true);
  expect(OwnAttendanceCorrectionIntent.safeParse({...common,reason:'x'.repeat(4001)}).success).toBe(false);expect(OwnAttendanceCorrectionIntent.safeParse({...common,remark:'x'.repeat(4001)}).success).toBe(false);
  for(const field of ['actor','approvedOtMinutes','policyId','workflowId','attachment'])expect(OwnAttendanceCorrectionIntent.safeParse({...common,[field]:'posted'}).success).toBe(false);
 });
 it('submits own clock-pair correction and reopens the exact native event without amending the actual day',async()=>{
  const a=await fixture(),before=await state(a),review=await prepare(a);expect((await state(a)).requests).toHaveLength(0);expect(review.request).toMatchObject({checkIn:'09:00',checkOut:'18:00',reason:a.intent.reason,remark:'Human optional note',requestKind:'other'});
  const receipt=await confirm(a,review.reviewDigest),after=await state(a);expect(receipt).toMatchObject({status:'pending',meaning:'submitted_not_approved'});expect(after.requests).toHaveLength(1);expect(after.events).toHaveLength(1);expect(after.events[0].id).toBe(receipt.eventId);expect(after.attendance).toEqual(before.attendance);
  const reference={employmentId:a.employmentId,eventId:receipt.eventId};expect(await withTenant(a.ctx,tx=>reopenOwnAttendanceCorrectionEventTx(tx,a.ctx,reference))).toEqual(receipt);expect(await state(a)).toEqual(after);await expect(confirm(a,review.reviewDigest)).rejects.toThrow();expect(await state(a)).toEqual(after);
 });
 it.each(['combined','planned'] as const)('retains the full %s clock/OT human request instead of reducing all corrections to OT-only',async kind=>{
  const a=await fixture();a.intent=kind==='combined'?{...a.intent,requestedOtMinutes:60}:{version:1,employmentId:a.employmentId,date:calendarDate(7),requestedOtMinutes:60,plannedStartTime:'18:00',plannedEndTime:'19:00',otReasonCategory:'project_deadline',reason:'Fictional explicitly planned work',remark:'Human note',requestKind:'self_overtime'};
  const before=await state(a),review=await prepare(a),receipt=await confirm(a,review.reviewDigest),after=await state(a);expect(receipt.meaning).toBe('submitted_not_approved');expect(after.requests[0].requestedOtMinutes).toBe(60);if(kind==='combined')expect(after.requests[0].proposedCheckIn).toBe('09:00:00');else expect(after.requests[0]).toMatchObject({proposedCheckIn:null,plannedStartTime:'18:00:00',plannedEndTime:'19:00:00',otReasonCategory:'project_deadline',remark:'Human note'});expect(after.attendance).toEqual(before.attendance);
 });
 it('preserves native HR-only raw clock-data authority and supports an actually authorised own HR request',async()=>{
  const a=await fixture('hr_admin'),raw=await attendanceClockData(a.admin,a.employmentId,date);a.intent={version:1,employmentId:a.employmentId,date,reason:'Fictional human raw-clock correction',clockChanges:{version:1,baseline:raw.baseline,entries:raw.rows.map(row=>({id:row.id,punchAt:row.direction==='in'?'09:00':'18:00',direction:row.direction}))}};
  const before=await state(a),review=await prepare(a);await confirm(a,review.reviewDigest);const after=await state(a);expect(after.requests[0].clockChanges?.entries).toHaveLength(2);expect(after.attendance).toEqual(before.attendance);
 });
 it('refuses an ordinary employee raw-clock edit and own HR unclocked testimony under the unchanged native gate',async()=>{
  const a=await fixture(),raw=await attendanceClockData(a.admin,a.employmentId,date);a.intent={version:1,employmentId:a.employmentId,date,reason:'Human reason',clockChanges:{version:1,baseline:raw.baseline,entries:[]}};await expect(prepare(a)).rejects.toThrow(/administrator/);expect((await state(a)).requests).toHaveLength(0);
  const hr=await fixture('hr_admin');hr.intent={version:1,employmentId:hr.employmentId,date,requestedOtMinutes:60,reason:'Human attestation',unclockedWork:{completeWorkedDay:true,intervals:[{fromEpochMillisecond:Date.parse(date+'T09:00:00+08:00'),toEpochMillisecond:Date.parse(date+'T10:00:00+08:00')}]}};await expect(prepare(hr)).rejects.toThrow(/Another authorised HR/);expect((await state(hr)).requests).toHaveLength(0);
 });
 it('refuses changed original day/source and actual routing drift before native request effects',async()=>{
  const a=await fixture(),review=await prepare(a);await checkOut(a.admin,{employmentId:a.employmentId,date,time:'17:30',manual:true});const before=await state(a);await expect(confirm(a,review.reviewDigest)).rejects.toThrow();expect(await state(a)).toEqual(before);
  const manager=await hireEmployee(a.admin,{person:{fullName:'Fictional Routing Manager',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptB,employmentType:'full_time',hiredOn:`${Number(todayInKualaLumpur().slice(0,4))-2}-01-01`});await createAppUser(base.tenantId,manager.personId,'manager');await setReportingLine(a.admin,{subordinateEmploymentId:a.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:`${Number(todayInKualaLumpur().slice(0,4))-2}-01-01`});
  const input:AttendanceWorkflowInput={companyId:base.companyId,code:'FICTIONAL',name:'Fictional human approval',description:'Fictional route',applicationType:'irregularity',priority:100,criteria:{departmentIds:[base.deptA]},stages:[{name:'Manager review',level:{kind:'direct_manager',employmentId:null,alternates:[]}}],active:true};await saveAttendanceWorkflow(a.admin,input);const fresh=await prepare(a);await setAttendanceWorkflowEnabled(a.admin,base.companyId,'irregularity',true);await expect(confirm(a,fresh.reviewDigest)).rejects.toThrow();expect((await state(a)).requests).toHaveLength(0);
  const routed=await prepare(a);await confirm(a,routed.reviewDigest);expect((await state(a)).workflows).toHaveLength(1);
 });
 it('rechecks current Assistant/Attendance authority and never retargets a captured human request',async()=>{
  const a=await fixture(),review=await prepare(a);await revokeAssistant(a.admin,{appUserId:a.ctx.userId!});await expect(confirm(a,review.reviewDigest)).rejects.toThrow();await grantAssistant(a.admin,{appUserId:a.ctx.userId!});await setModule(base.tenantId,'attendance','disabled');await expect(confirm(a,review.reviewDigest)).rejects.toThrow();await setModule(base.tenantId,'attendance','active');
  const captured=await withTenant(a.ctx,async tx=>{const pending=prepareOwnAttendanceCorrectionTx(tx,a.ctx,a.intent);a.intent.checkIn='10:00';return pending;});expect(captured.request.checkIn).toBe('09:00');await expect(confirm(a,captured.reviewDigest)).rejects.toThrow();a.intent.checkIn='09:00';await confirm(a,captured.reviewDigest);
 });
 it('rolls back request, workflow and native event together if shared custody completion fails',async()=>{
  const a=await fixture(),review=await prepare(a),before=await state(a);await expect(withTenant(a.ctx,async tx=>{await confirmOwnAttendanceCorrectionTx(tx,a.ctx,a.intent,review.reviewDigest);throw Error('fictional custody failure');})).rejects.toThrow('fictional custody failure');expect(await state(a)).toEqual(before);await confirm(a,review.reviewDigest);expect((await state(a)).events).toHaveLength(1);
 });
 it('keeps one native pending request across competing confirms and retains ordinary API shape',async()=>{
  const a=await fixture(),review=await prepare(a),outcomes=await Promise.allSettled([confirm(a,review.reviewDigest),confirm(a,review.reviewDigest)]);expect(outcomes.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect((await state(a)).events).toHaveLength(1);
  const result=await requestAttendanceCorrection(a.ctx,{employmentId:a.employmentId,date:calendarDate(-1),checkIn:'09:00',reason:'Fictional ordinary submission'});expect(Object.keys(result)).toEqual(['correctionId']);
 });
 it('refuses foreign subjects and native-event references without returning another employee request',async()=>{
  const a=await fixture(),receipt=await confirm(a,(await prepare(a)).reviewDigest),reference={employmentId:randomUUID(),eventId:receipt.eventId};await expect(withTenant(a.ctx,tx=>reopenOwnAttendanceCorrectionEventTx(tx,a.ctx,reference))).rejects.toThrow();a.intent={...a.intent,employmentId:reference.employmentId};await expect(prepare(a)).rejects.toThrow();expect((await state(a)).events).toHaveLength(1);
 });
});
