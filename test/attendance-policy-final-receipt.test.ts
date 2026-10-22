import {readFileSync} from 'node:fs';
import {attendancePolicyFinalRawAgreement} from '../packs/attendance/policy-final-raw-input';
import {ATTENDANCE_POLICY_DAY_CLASSES,type AttendanceGroupPolicy} from '../lib/attendance-group-policy';
import {createShift,assignDefaultShift} from '../core/roster';
/** Runtime probes prepared for the real workflow owner; no payment/plan/exception authority claimed. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as s from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {saveAttendanceWorkflow,setAttendanceWorkflowEnabled} from '../core/attendance-workflow';
import {requestAttendanceCorrection,decideAttendanceCorrection} from '../packs/attendance/service';
import {setAttendancePolicy,ensureStandardRule,checkInTx,checkOutTx,canonicalOvertimeInputTx} from '../packs/attendance/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base;
const day=(n:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'attendance','active');});
async function actor(name:string,role:'employee'|'hr_admin'){
 const person=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.invalid'},companyId:b.companyId,
  departmentId:role==='employee'?b.deptA:b.deptB,employmentType:'full_time',hiredOn:day(-20)});
 const userId=await createAppUser(b.tenantId,person.personId,role);
 const ctx:SessionContext={...adminCtx(b),userId,personId:person.personId,roles:[role],grants:[{role,companyId:b.companyId}]};
 return {...person,ctx};
}
async function fixture(offset=1,prepare?:(worker:Awaited<ReturnType<typeof actor>>)=>Promise<void>){
 const worker=await actor('Fictional final receipt applicant','employee'),first=await actor('Fictional first HR','hr_admin'),last=await actor('Fictional final HR','hr_admin');
 await saveAttendanceWorkflow(adminCtx(b),{companyId:b.companyId,routingVersion:3,code:'FINAL_RECEIPT',name:'Fictional receipt workflow',
  applicationType:'self_overtime',priority:100,criteria:{departmentIds:[b.deptA]},active:true,
  stages:[first,last].map((who,index)=>({name:'Level '+(index+1),mode:'sequential',source:{kind:'specific_employee',employmentIds:[who.employmentId]},hrAlternative:false}))});
 await setAttendanceWorkflowEnabled(adminCtx(b),b.companyId,'self_overtime',true);
 if(prepare)await prepare(worker);
 const request=await requestAttendanceCorrection(worker.ctx,{employmentId:worker.employmentId,date:day(offset),requestedOtMinutes:60,
  plannedStartTime:'18:00',plannedEndTime:'19:00',requestKind:'self_overtime',reason:'Fictional final receipt window'});
 return {worker,first,last,id:request.correctionId};
}
describe('owner-issued final workflow receipt',()=>{
 it('consumes a real v3 captured-day final receipt against current source and refuses a later replacement capture',async()=>{
  const admin=adminCtx(b);let ruleId='';
  await setAttendancePolicy(admin,{companyId:b.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:0,
   lateAfter:'09:00',halfDayBefore:'13:00',workingDays:[1,2,3,4,5,6,7],otApprovalCalculation:'requested'});
  const f=await fixture(0,async worker=>{
   ruleId=(await ensureStandardRule(admin)).id;
   const shift=await createShift(admin,{code:'RAW_'+randomUUID().slice(0,6),name:'Fictional restored cutover shift',
    startTime:'09:00',endTime:'18:00',breakMinutes:0,weeklyPattern:[1,2,3,4,5,6,7],ruleId});
   await assignDefaultShift(admin,{employmentId:worker.employmentId,shiftId:shift.id});
   const policy:AttendanceGroupPolicy={version:1,clock:{pairing:'auto',minimumIntervalMinutes:0,lateGraceMinutes:0,
    earlyGraceMinutes:0,skipLatenessIfIncomplete:true},overtime:{enabled:false,beforeShift:false,afterShift:true,
     allowBackdatedWithoutClock:false,splitAtMidnight:false,offsetLateness:false,approval:'manual',autoMethod:'actual',
     rounding:{mode:'none',step:null},days:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>[key,
      {minimumMinutes:0,maximumMinutes:null,patternVersionId:null}])) as AttendanceGroupPolicy['overtime']['days']}};
   // Restore-only fixture for a policy that already existed before this day. This does not test
   // scheduling/activation authority. Both configuration triggers are re-enabled atomically BEFORE
   // any clock, request or approval operation; no business workflow guard is disabled.
   await owner.db.transaction(async tx=>{
    await tx.execute(sql`ALTER TABLE attendance_group_policy_revision DISABLE TRIGGER attendance_group_policy_revision_guard`);
    await tx.execute(sql`ALTER TABLE attendance_group_policy_revision DISABLE TRIGGER zz_attendance_policy_activation_epoch`);
    await tx.insert(s.attendanceGroupPolicyRevision).values({tenantId:b.tenantId,companyId:b.companyId,ruleId,ordinal:1,
     effectiveFrom:day(-1),policy,activationEpoch:0,createdByUserId:admin.userId!,createdAt:new Date(day(-2)+'T00:00:00+08:00'),
     reason:'Fictional restored historical cutover baseline, not activation proof'});
    await tx.execute(sql`ALTER TABLE attendance_group_policy_revision ENABLE TRIGGER attendance_group_policy_revision_guard`);
    await tx.execute(sql`ALTER TABLE attendance_group_policy_revision ENABLE TRIGGER zz_attendance_policy_activation_epoch`);
   });
   const triggers=await owner.db.execute(sql`select tgname,tgenabled from pg_trigger where tgrelid='attendance_group_policy_revision'::regclass
    and tgname in ('attendance_group_policy_revision_guard','zz_attendance_policy_activation_epoch') order by tgname`);
   expect(Array.from(triggers).map(row=>row.tgenabled)).toEqual(['O','O']);
   for(const [direction,time] of [['in','09:00:00'],['out','19:00:00']] as const){
    const [capture]=await owner.db.insert(s.attendanceClockCapture).values({tenantId:b.tenantId,employmentId:worker.employmentId,
     attendanceDate:day(0),direction,requestId:randomUUID(),commandDigest:'a'.repeat(64),serverRecordedAt:new Date(day(0)+'T'+time+'+08:00')}).returning();
    await (direction==='in'?checkInTx:checkOutTx)(worker.ctx,{employmentId:worker.employmentId,date:day(0),time,clockCaptureId:capture.id,preciseOrder:true});
   }
  });
  await decideAttendanceCorrection(f.first.ctx,{correctionId:f.id,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'});
  expect(await owner.db.select().from(s.attendancePolicyFinalReceipt).where(eq(s.attendancePolicyFinalReceipt.correctionId,f.id))).toEqual([]);
  await decideAttendanceCorrection(f.last.ctx,{correctionId:f.id,decision:'approved',expectedStageIndex:1,expectedParticipantSlot:'1:0'});
  const [receipt]=await owner.db.select().from(s.attendancePolicyFinalReceipt).where(eq(s.attendancePolicyFinalReceipt.correctionId,f.id));
  expect(receipt.rawEvidence).not.toBeNull();expect(receipt.workflowEvidence.routingVersion).toBe(3);
  expect(receipt.rawEvidence).toMatchObject({otMinutes:null,workedMinutes:600});
  const [decided]=await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,f.id));
  expect(decided).toMatchObject({status:'approved',approvedOtMinutes:60,appliedAt:null});
  await expect(decideAttendanceCorrection(f.last.ctx,{correctionId:f.id,decision:'approved'})).rejects.toThrow();
  const [contract]=await owner.db.select().from(s.attendancePolicyRequestContract).where(eq(s.attendancePolicyRequestContract.correctionId,f.id));
  expect(contract.policyBinding).toMatchObject({authority:'datedPolicyOnly',ruleId,employmentId:f.worker.employmentId,sourceDate:day(0),activation:{epoch:0}});
  expect(receipt.workflowEvidence.submittedPolicy).toEqual(contract.policyBinding);
  const result=await withTenant(admin,async tx=>{
   const snapshot=await canonicalOvertimeInputTx(tx,admin,{employmentId:f.worker.employmentId,date:day(0)});
   const request=snapshot.policyApprovalInput?.requests.find(row=>row.id===f.id);
   const [raw]=await tx.select().from(s.attendance).where(and(eq(s.attendance.employmentId,f.worker.employmentId),eq(s.attendance.attendanceDate,day(0))));
   if(!request)throw Error('Expected real retained workflow receipt');
   const current={...raw,attendanceId:raw.id,trace:raw.calcTrace};
   const agreement=attendancePolicyFinalRawAgreement(snapshot.policyExecutionContext,request,b.tenantId,snapshot.policyClockSource,current);
   expect(agreement).toMatchObject({state:'known',authority:'retainedRawAgreementOnly',attendanceId:raw.id,correctionId:f.id});
   if(snapshot.policyClockSource?.state!=='known')throw Error('Expected real captured sources');
   const replacement=structuredClone(snapshot.policyClockSource);replacement.clocks[0].captureId=randomUUID();
   expect(attendancePolicyFinalRawAgreement(snapshot.policyExecutionContext,request,b.tenantId,replacement,current))
    .toMatchObject({state:'unavailable',reason:'captureSetMismatch'});
   return agreement;
  });
  expect(result).not.toHaveProperty('minutes');expect(result).not.toHaveProperty('transferable');
  expect(await owner.db.select().from(s.overtimeSourceSettlement)).toEqual([]);
 });
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
 it('keeps the submitted company method through a real later configuration change',async()=>{
  const setting=(method:'requested'|'system_calculated')=>setAttendancePolicy(adminCtx(b),{companyId:b.companyId,
   workStart:'09:00',workEnd:'18:00',breakMinutes:0,lateAfter:'09:00',halfDayBefore:'13:00',
   workingDays:[1,2,3,4,5,6,7],otApprovalCalculation:method});
  await setting('requested');
  const f=await fixture();
  const [contract]=await owner.db.select().from(s.attendancePolicyRequestContract).where(eq(s.attendancePolicyRequestContract.correctionId,f.id));
  expect(contract.manualApprovalMethod).toBe('requested');
  await setting('system_calculated');
  await decideAttendanceCorrection(f.first.ctx,{correctionId:f.id,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'});
  await decideAttendanceCorrection(f.last.ctx,{correctionId:f.id,decision:'approved',expectedStageIndex:1,expectedParticipantSlot:'1:0'});
  const [request]=await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,f.id));
  expect(request).toMatchObject({status:'approved',otApprovalMethod:'requested',approvedOtMinutes:60});
  const [receipt]=await owner.db.select().from(s.attendancePolicyFinalReceipt).where(eq(s.attendancePolicyFinalReceipt.correctionId,f.id));
  expect(receipt).toMatchObject({requestEvidence:{method:'requested',approvedMinutes:60},workflowEvidence:{submittedManualMethod:'requested'}});
  await expect(owner.db.update(s.attendancePolicyRequestContract).set({manualApprovalMethod:'system_calculated'})
   .where(eq(s.attendancePolicyRequestContract.correctionId,f.id))).rejects.toThrow();
  expect(await owner.db.select().from(s.overtimeSourceSettlement)).toEqual([]);
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
 it('retains the frozen legacy effect body and private execution ACL behind the scoped dispatcher',async()=>{
  const frozen=readFileSync('db/migrations/0548_attendance_hierarchy_approval.sql','utf8');
  const start=frozen.indexOf('CREATE FUNCTION app.attendance_workflow_final_effect(');
  expect(start).toBeGreaterThanOrEqual(0);
  const bodyStart=frozen.indexOf('AS $$',start),end=frozen.indexOf('$$;',bodyStart+5);
  expect(bodyStart).toBeGreaterThan(start);expect(end).toBeGreaterThan(bodyStart+1000);
  const body=frozen.slice(bodyStart+5,end);
  const [row]=await owner.db.execute(sql`select p.prosrc,
   has_function_privilege('ai_hr_app','app.attendance_workflow_legacy_labels_final_effect(uuid,integer)','EXECUTE') as legacy_callable,
   has_function_privilege('ai_hr_app','app.attendance_workflow_final_effect(uuid,integer)','EXECUTE') as dispatcher_callable
   from pg_proc p where p.oid='app.attendance_workflow_legacy_labels_final_effect(uuid,integer)'::regprocedure`);
  expect(row).toEqual({prosrc:body,legacy_callable:false,dispatcher_callable:false});
 });
 it('does not grant application writes to receipts or permit owner rewriting',async()=>{
  const f=await fixture();
  await decideAttendanceCorrection(f.first.ctx,{correctionId:f.id,decision:'approved',expectedStageIndex:0,expectedParticipantSlot:'0:0'});
  await decideAttendanceCorrection(f.last.ctx,{correctionId:f.id,decision:'approved',expectedStageIndex:1,expectedParticipantSlot:'1:0'});
  await expect(withTenant(adminCtx(b),tx=>tx.delete(s.attendancePolicyFinalReceipt).where(eq(s.attendancePolicyFinalReceipt.correctionId,f.id)))).rejects.toThrow();
  await expect(owner.db.update(s.attendancePolicyFinalReceipt).set({actorUserId:randomUUID()}).where(eq(s.attendancePolicyFinalReceipt.correctionId,f.id))).rejects.toThrow();
 });
});
