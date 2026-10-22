/** Runtime probes prepared for the real workflow owner; no payment/plan/exception authority claimed. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as s from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {saveAttendanceWorkflow,setAttendanceWorkflowEnabled} from '../core/attendance-workflow';
import {requestAttendanceCorrection,decideAttendanceCorrection} from '../packs/attendance/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base;
const day=(n:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'attendance','active');});
async function actor(name:string,role:'employee'|'hr_admin'){
 const person=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.invalid'},companyId:b.companyId,
  departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-20)});
 const userId=await createAppUser(b.tenantId,person.personId,role);
 const ctx:SessionContext={...adminCtx(b),userId,personId:person.personId,roles:[role],grants:[{role,companyId:b.companyId}]};
 return {...person,ctx};
}
async function fixture(){
 const worker=await actor('Fictional final receipt applicant','employee'),first=await actor('Fictional first HR','hr_admin'),last=await actor('Fictional final HR','hr_admin');
 await saveAttendanceWorkflow(adminCtx(b),{companyId:b.companyId,routingVersion:3,code:'FINAL_RECEIPT',name:'Fictional receipt workflow',
  applicationType:'self_overtime',priority:100,criteria:{departmentIds:[b.deptA]},active:true,
  stages:[first,last].map((who,index)=>({name:'Level '+(index+1),mode:'sequential',source:{kind:'specific_employee',employmentIds:[who.employmentId]},hrAlternative:false}))});
 await setAttendanceWorkflowEnabled(adminCtx(b),b.companyId,'self_overtime',true);
 const request=await requestAttendanceCorrection(worker.ctx,{employmentId:worker.employmentId,date:day(1),requestedOtMinutes:60,
  plannedStartTime:'18:00',plannedEndTime:'19:00',requestKind:'self_overtime',reason:'Fictional final receipt window'});
 return {worker,first,last,id:request.correctionId};
}
describe('owner-issued final workflow receipt',()=>{
 it('mints once only after the real final participant effect, without inventing future work',async()=>{
  const f=await fixture();
  const receipts=()=>owner.db.select().from(s.attendancePolicyFinalReceipt).where(eq(s.attendancePolicyFinalReceipt.correctionId,f.id));
  expect(await receipts()).toEqual([]);
  const [contract]=await owner.db.select().from(s.attendancePolicyRequestContract).where(eq(s.attendancePolicyRequestContract.correctionId,f.id));
  expect(contract.plannedWindow).toEqual({version:1,basis:'startDateEarlierEndNextDay',sourceDate:day(1),
   startLabel:'18:00:00',endLabel:'19:00:00',from:1080,to:1140,requestedMinutes:60});
  await decideAttendanceCorrection(f.first.ctx,{correctionId:f.id,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'});
  expect(await receipts()).toEqual([]);
  await decideAttendanceCorrection(f.last.ctx,{correctionId:f.id,decision:'approved',expectedStageIndex:1,expectedParticipantSlot:'1:0'});
  const rows=await receipts();expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({tenantId:b.tenantId,employmentId:f.worker.employmentId,attendanceDate:day(1),companyId:b.companyId,
   actorUserId:f.last.ctx.userId,authority:'finalWorkflowDecisionOnly',rawEvidence:null,workflowEvidence:{routingVersion:3,stageCount:2,submittedPlan:contract.plannedWindow}});
  expect(await owner.db.select().from(s.attendance).where(eq(s.attendance.employmentId,f.worker.employmentId))).toEqual([]);
  expect(await owner.db.select().from(s.overtimeSourceSettlement)).toEqual([]);
  await expect(decideAttendanceCorrection(f.last.ctx,{correctionId:f.id,decision:'approved'})).rejects.toThrow();
  expect(await receipts()).toEqual(rows);
 });
 it('retains an explicit overnight start-date plan but never positions a mismatched scalar request',async()=>{
  const f=await fixture();
  const submit=async(start:string,end:string,minutes:number,offset:number)=>requestAttendanceCorrection(f.worker.ctx,
   {employmentId:f.worker.employmentId,date:day(offset),requestedOtMinutes:minutes,plannedStartTime:start,plannedEndTime:end,
    requestKind:'self_overtime',reason:'Fictional immutable positioned plan'});
  const overnight=await submit('23:30','01:15',105,2),mismatched=await submit('18:00','19:00',30,3);
  const [plan]=await owner.db.select().from(s.attendancePolicyRequestContract).where(eq(s.attendancePolicyRequestContract.correctionId,overnight.correctionId));
  expect(plan.plannedWindow).toMatchObject({sourceDate:day(2),from:1410,to:1515,requestedMinutes:105});
  const [missing]=await owner.db.select().from(s.attendancePolicyRequestContract).where(eq(s.attendancePolicyRequestContract.correctionId,mismatched.correctionId));
  expect(missing.plannedWindow).toBeNull();
  await expect(owner.db.update(s.attendancePolicyRequestContract).set({plannedWindow:{from:1,to:2}})
   .where(eq(s.attendancePolicyRequestContract.correctionId,overnight.correctionId))).rejects.toThrow();
 });
 it('does not grant application writes to receipts or permit owner rewriting',async()=>{
  const f=await fixture();
  await decideAttendanceCorrection(f.first.ctx,{correctionId:f.id,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'});
  await decideAttendanceCorrection(f.last.ctx,{correctionId:f.id,decision:'approved',expectedStageIndex:1,expectedParticipantSlot:'1:0'});
  await expect(withTenant(adminCtx(b),tx=>tx.delete(s.attendancePolicyFinalReceipt).where(eq(s.attendancePolicyFinalReceipt.correctionId,f.id)))).rejects.toThrow();
  await expect(owner.db.update(s.attendancePolicyFinalReceipt).set({actorUserId:randomUUID()}).where(eq(s.attendancePolicyFinalReceipt.correctionId,f.id))).rejects.toThrow();
 });
});
