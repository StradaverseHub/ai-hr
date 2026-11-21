import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { requestAttendanceCorrection } from '../core/attendance';
import { ownAttendanceSubmissionRoute, saveAttendanceWorkflow, setAttendanceWorkflowEnabled } from '../core/attendance-workflow';
import { attendanceSubmissionCopy } from '../lib/attendance-workflow-submission';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
let b:Base;
const date=()=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')-86400000).toISOString().slice(0,10);
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();});
async function fixture(){
 const worker=await hireEmployee(adminCtx(b),{person:{fullName:'Submission employee',primaryEmail:randomUUID()+'@route.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const userId=await createAppUser(b.tenantId,worker.personId,'employee');
 return {worker,self:{...adminCtx(b),userId,personId:worker.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]}};
}
function config(type:'irregularity'|'self_overtime'){
 return {companyId:b.companyId,code:type==='irregularity'?'IRREGULARITY':'SELF_OT',name:'Explicit HR approval',applicationType:type,priority:100,criteria:{},stages:[{name:'HR review',level:{kind:'hr_admin',employmentId:null,alternates:[]}}],active:true};
}
async function configure(type:'irregularity'|'self_overtime'){
 return saveAttendanceWorkflow(adminCtx(b),config(type));
}
async function submit(employmentId:string){return requestAttendanceCorrection(adminCtx(b),{employmentId,date:date(),checkIn:'09:00',checkOut:'18:00',reason:'Forgotten clock-out'});}
async function expectNoApplication(){
 expect(await owner.db.select().from(schema.attendanceCorrection)).toHaveLength(0);
 expect(await owner.db.select().from(schema.attendanceWorkflowRequest)).toHaveLength(0);
 expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'attendance-correction.requested'))).toHaveLength(0);
}
describe('mandatory configured route for new attendance submissions',()=>{
 it('refuses absent configuration and routes active workflows even when the legacy switch is off',async()=>{
  const {worker}=await fixture();
  await expect(submit(worker.employmentId)).rejects.toMatchObject({code:'noMatch',message:attendanceSubmissionCopy.noMatch});
  await expectNoApplication();
  await configure('irregularity');await setAttendanceWorkflowEnabled(adminCtx(b),b.companyId,'irregularity',false);
  await expect(submit(worker.employmentId)).resolves.toMatchObject({correctionId:expect.any(String)});
 });
 it('does not accept a Self Overtime workflow as an Irregularity route',async()=>{
  const {worker}=await fixture();await configure('self_overtime');
  await expect(submit(worker.employmentId)).rejects.toMatchObject({code:'noMatch'});await expectNoApplication();
 });
 it('does not accept an Irregularity workflow as a Self Overtime route',async()=>{
  const {worker}=await fixture();await configure('irregularity');
  await expect(requestAttendanceCorrection(adminCtx(b),{employmentId:worker.employmentId,date:date(),plannedStartTime:'18:00',plannedEndTime:'19:00',requestedOtMinutes:60,reason:'Planned work'})).rejects.toMatchObject({code:'noMatch'});await expectNoApplication();
 });
 it('shows and freezes the explicitly configured approver rather than the reporting-line fallback',async()=>{
  const {worker,self}=await fixture();const template=await configure('irregularity');
  const route=await ownAttendanceSubmissionRoute(self,worker.employmentId,'irregularity');
  expect(route.available).toBe(true);if(!route.available)throw Error('Expected configured route');
  expect(route.firstApprovers).toEqual([{kind:'hr_admin',name:'HR administrators'}]);
  expect(route.stages[0].approvers).toEqual([{kind:'hr_admin',employmentId:null,name:'HR administrators'}]);
  const {correctionId}=await submit(worker.employmentId);
  const [frozen]=await owner.db.select().from(schema.attendanceWorkflowRequest).where(eq(schema.attendanceWorkflowRequest.correctionId,correctionId));
  expect(frozen.templateId).toBe(template.id);expect(frozen.stages).toEqual(route.stages);
 });
 it('keeps own route reads restricted to the authenticated employee',async()=>{
  const first=await fixture(),other=await fixture();await configure('irregularity');
  await expect(ownAttendanceSubmissionRoute(first.self,other.worker.employmentId,'irregularity')).rejects.toThrow('not visible');
 });
 it('reports unavailable preview without silently assigning HR',async()=>{
  const {worker,self}=await fixture();
  expect(await ownAttendanceSubmissionRoute(self,worker.employmentId,'irregularity')).toEqual({available:false,reason:'noMatch'});
 });
 it('saves a valid scoped workflow while the employee has no Direct Superior',async()=>{
  const {worker,self}=await fixture();
  const input={...config('irregularity'),criteria:{employeeIds:[worker.employmentId]},stages:[{name:'Manager review',level:{kind:'direct_manager',employmentId:null,alternates:[]}}]};
  const saved=await saveAttendanceWorkflow(adminCtx(b),input);
  expect(saved.lineageId).toEqual(expect.any(String));
  expect(await ownAttendanceSubmissionRoute(self,worker.employmentId,'irregularity')).toEqual({available:false,reason:'unresolved'});
  await expect(submit(worker.employmentId)).rejects.toMatchObject({reason:'unresolved'});
  await expectNoApplication();
 });
 it('refuses a changed route before committing any request and accepts the refreshed preview',async()=>{
  const {worker,self}=await fixture();
  const saved=await configure('irregularity');
  const route=await ownAttendanceSubmissionRoute(self,worker.employmentId,'irregularity');
  if(!route.available)throw Error('Expected configured route');
  const next=await saveAttendanceWorkflow(adminCtx(b),{...config('irregularity'),name:'Updated route',expectedVersion:saved.version},saved.lineageId);
  const request={employmentId:worker.employmentId,date:date(),checkIn:'09:00',checkOut:'18:00',reason:'Forgotten clock-out'};
  await expect(requestAttendanceCorrection(self,{...request,workflowFingerprint:route.fingerprint})).rejects.toMatchObject({reason:'routeChanged'});
  await expectNoApplication();
  const updated=await ownAttendanceSubmissionRoute(self,worker.employmentId,'irregularity');
  if(!updated.available)throw Error('Expected updated route');
  await requestAttendanceCorrection(self,{...request,workflowFingerprint:updated.fingerprint});
  const [frozen]=await owner.db.select().from(schema.attendanceWorkflowRequest);
  expect(frozen.templateId).toBe(next.id);
 });
 it('replays simultaneous create and edit saves for the same exact intent',async()=>{
  const admin=adminCtx(b),input=config('irregularity'),createId=randomUUID();
  const create=()=>saveAttendanceWorkflow(admin,input,undefined,undefined,true,createId);
  const [one,two]=await Promise.all([create(),create()]);
  expect(two.id).toBe(one.id);
  const editId=randomUUID(),updated={...input,expectedVersion:one.version,name:'Updated workflow'};
  const edit=()=>saveAttendanceWorkflow(admin,updated,one.lineageId,undefined,false,editId);
  const [next,replay]=await Promise.all([edit(),edit()]);
  expect(replay.id).toBe(next.id);
  expect(next.version).toBe(one.version+1);
  await expect(saveAttendanceWorkflow(admin,{...updated,name:'Different edit'},one.lineageId,undefined,false,editId)).rejects.toMatchObject({code:'stale'});
  expect(await owner.db.select().from(schema.attendanceWorkflowTemplate)).toHaveLength(2);
 });

});
