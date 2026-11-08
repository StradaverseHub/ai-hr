import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { requestAttendanceCorrection } from '../core/attendance';
import { ownAttendanceSubmissionRoute, saveAttendanceWorkflow, setAttendanceWorkflowEnabled } from '../core/attendance-workflow';
import { AttendanceWorkflowSubmissionError } from '../lib/attendance-workflow-submission';
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
async function configure(type:'irregularity'|'self_overtime'){
 const admin=adminCtx(b);
 const template=await saveAttendanceWorkflow(admin,{companyId:b.companyId,code:type==='irregularity'?'IRREGULARITY':'SELF_OT',name:'Explicit HR approval',applicationType:type,priority:100,criteria:{},stages:[{name:'HR review',level:{kind:'hr_admin',employmentId:null,alternates:[]}}],active:true});
 await setAttendanceWorkflowEnabled(admin,b.companyId,type,true);return template;
}
async function submit(employmentId:string){return requestAttendanceCorrection(adminCtx(b),{employmentId,date:date(),checkIn:'09:00',checkOut:'18:00',reason:'Forgotten clock-out'});}
async function expectNoApplication(){
 expect(await owner.db.select().from(schema.attendanceCorrection)).toHaveLength(0);
 expect(await owner.db.select().from(schema.attendanceWorkflowRequest)).toHaveLength(0);
 expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'attendance-correction.requested'))).toHaveLength(0);
}
describe('mandatory configured route for new attendance submissions',()=>{
 it('refuses absent and disabled routing with contact-HR copy and no pending application',async()=>{
  const {worker}=await fixture();
  await expect(submit(worker.employmentId)).rejects.toMatchObject({code:'noMatch',message:'Please Contact the HR Administrator.'});
  await expectNoApplication();
  await configure('irregularity');await setAttendanceWorkflowEnabled(adminCtx(b),b.companyId,'irregularity',false);
  await expect(submit(worker.employmentId)).rejects.toBeInstanceOf(AttendanceWorkflowSubmissionError);await expectNoApplication();
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
  expect(await ownAttendanceSubmissionRoute(self,worker.employmentId,'irregularity')).toEqual({available:false});
 });
});
