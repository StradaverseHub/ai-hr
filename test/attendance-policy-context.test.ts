import {randomUUID} from 'node:crypto';
import {and,asc,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {createCompany} from '../core/admin';
import {createShift,assignDefaultShift,updateShift} from '../core/roster';
import {ensureStandardRule} from '../core/attendance-rule';
import {attendancePolicyExecutionContextTx,scheduleAttendanceGroupPolicy,checkIn,checkOut,canonicalOvertimeInputTx,canonicalOvertimePayrollInputTx,canonicalOvertimeToilInputTx,readOvertimeCalculationTx,createOvertimeCalculationOwner,calculateOvertimePatternDay,
 hasOvertimePatternForDayTx,hasRecordedAttendanceGroupPolicyTx,listCoveredOvertimeDaysTx,requestAttendanceCorrection,decideAttendanceCorrection} from '../packs/attendance/service';
import {ATTENDANCE_POLICY_DAY_CLASSES,type AttendanceGroupPolicy} from '../lib/attendance-group-policy';
import {HR_LOCAL_TZ,todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,entitledCtx,type Base} from './harness';
let b:Base,ctx:SessionContext;
const day=(n=0)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
function policy():AttendanceGroupPolicy{return {version:1,clock:{pairing:'auto',minimumIntervalMinutes:5,lateGraceMinutes:10,earlyGraceMinutes:15,skipLatenessIfIncomplete:true},
  overtime:{enabled:false,beforeShift:false,afterShift:true,allowBackdatedWithoutClock:false,splitAtMidnight:false,offsetLateness:false,approval:'manual',autoMethod:'actual',rounding:{mode:'none',step:null},
    days:Object.fromEntries(ATTENDANCE_POLICY_DAY_CLASSES.map(key=>[key,{minimumMinutes:0,maximumMinutes:null,patternVersionId:null}])) as AttendanceGroupPolicy['overtime']['days']}};}
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'attendance','active');ctx=adminCtx(b);});
async function fixture(){
  const ruleId=(await ensureStandardRule(ctx)).id;
  const e=await hireEmployee(ctx,{person:{fullName:'Fictional policy context',primaryEmail:randomUUID()+'@fixture.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-20)});
  const shiftInput={code:'CTX_'+randomUUID().slice(0,6),name:'Fictional policy context shift',startTime:'09:00',endTime:'18:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5,6,7],ruleId};
  const sh=await createShift(ctx,shiftInput);await assignDefaultShift(ctx,{employmentId:e.employmentId,shiftId:sh.id});
  const save=(value=policy(),expectedOrdinal=0,effectiveFrom=day(1))=>scheduleAttendanceGroupPolicy(ctx,{companyId:b.companyId,ruleId,expectedOrdinal,effectiveFrom,reason:'Fictional forward policy selection',policy:value});
  return {...e,ruleId,shiftId:sh.id,shiftInput,save};
}
const read=(employmentId:string,date:string,actor=ctx)=>withTenant(actor,tx=>attendancePolicyExecutionContextTx(tx,actor,{employmentId,date}));
describe('canonical execution-policy selection',()=>{
  it('keeps uncovered dates explicitly legacy and selects the exact immutable dated company/group revision',async()=>{
    const f=await fixture();expect(await read(f.employmentId,day(1))).toEqual({state:'legacy',reason:'noDatedPolicy'});
    const first=await f.save();const secondPolicy=policy();secondPolicy.clock.pairing='firstInLastOut';
    const second=await f.save(secondPolicy,1,day(2));
    expect(await read(f.employmentId,day())).toEqual({state:'legacy',reason:'noDatedPolicy'});
    expect(await read(f.employmentId,day(1))).toMatchObject({state:'policy',employmentId:f.employmentId,date:day(1),companyId:b.companyId,timeZone:HR_LOCAL_TZ,
      selected:{id:first.id,ruleId:f.ruleId,ordinal:1,policy:policy()},resolvedClock:{pairing:'auto',lateGraceMinutes:10,earlyGraceMinutes:15},
      schedule:{source:'default-shift',shiftId:f.shiftId,ruleId:f.ruleId,normalMinutes:480,durationOnly:false},calendar:[{date:day(1),state:'known',dayClass:'normal'}]});
    expect(await read(f.employmentId,day(2))).toMatchObject({state:'policy',selected:{id:second.id,ordinal:2},resolvedClock:{pairing:'firstInLastOut'}});
    // Selecting live inputs neither creates an attendance result nor approves an application.
    expect(await owner.db.select().from(s.attendance).where(eq(s.attendance.employmentId,f.employmentId))).toEqual([]);
    expect(await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.employmentId,f.employmentId))).toEqual([]);
  });
  it('retains explicit shift grace above the new group values and uses group values only when overrides are absent',async()=>{
    const f=await fixture();await f.save();
    await updateShift(ctx,{shiftId:f.shiftId,...f.shiftInput,lateGraceMinutes:3,earlyLeaveGraceMinutes:4});
    expect(await read(f.employmentId,day(1))).toMatchObject({state:'policy',selected:{policy:{clock:{lateGraceMinutes:10,earlyGraceMinutes:15}}},resolvedClock:{lateGraceMinutes:3,earlyGraceMinutes:4}});
    await updateShift(ctx,{shiftId:f.shiftId,...f.shiftInput,lateGraceMinutes:null,earlyLeaveGraceMinutes:null});
    expect(await read(f.employmentId,day(1))).toMatchObject({state:'policy',resolvedClock:{lateGraceMinutes:10,earlyGraceMinutes:15}});
  });
  it('reads all bounded actual-date calendar facts only when splitting is enabled',async()=>{
    const f=await fixture(),configured=policy();configured.overtime.splitAtMidnight=true;await f.save(configured);
    const result=await read(f.employmentId,day(1));expect(result.state).toBe('policy');
    if(result.state!=='policy')throw Error('Expected canonical policy selection');
    expect(result.calendar.map(fact=>fact.date)).toEqual([day(1),day(2),day(3)]);
  });
  it('refuses missing employer proof and foreign subjects, never labelling an unreadable policy as legacy',async()=>{
    const f=await fixture();await f.save();
    expect(await read(f.employmentId,day(1),adminCtx(await seedBase()))).toEqual({state:'unavailable',reason:'subjectUnavailable'});
    await owner.db.delete(s.assignment).where(eq(s.assignment.employmentId,f.employmentId));
    expect(await read(f.employmentId,day(1))).toEqual({state:'unavailable',reason:'companyUnavailable'});
  });
  it('refuses stale or forged principal claims before exposing policy identities',async()=>{
    const f=await fixture();await f.save();
    await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,ctx.userId!));
    expect(await read(f.employmentId,day(1))).toEqual({state:'unavailable',reason:'principalUnavailable'});
  });
});

/** Safety staging only: these probes must not be counted as complete policy execution or Payroll
 * acceptance. The routing fence must be replaced by canonical receipts/parts before feature release. */
describe('dated-policy raw writer routing',()=>{
 const row=async(employmentId:string,date:string)=>{
  const [saved]=await owner.db.select().from(s.attendance).where(and(eq(s.attendance.employmentId,employmentId),eq(s.attendance.attendanceDate,date))).limit(1);
  return saved;
 };
 const covered=(employmentId:string,date:string)=>withTenant(ctx,tx=>listCoveredOvertimeDaysTx(tx,ctx,{employmentIds:[employmentId],from:date,to:date}));
 const detected=(employmentId:string,date:string,actor=ctx)=>withTenant(actor,tx=>hasRecordedAttendanceGroupPolicyTx(tx,actor,{employmentId,date}));
 async function clock(employmentId:string,date:string){
  await checkIn(ctx,{employmentId,date,time:'09:00'});await checkOut(ctx,{employmentId,date,time:'20:00'});
 }
 it('keeps an uncovered date legacy but fences a dated policy without losing its actual punches',async()=>{
  const f=await fixture(),configured=await f.save();
  await clock(f.employmentId,day());
  expect(await detected(f.employmentId,day())).toBe(false);
  expect((await row(f.employmentId,day())).calcTrace?.overtimePattern).toBeUndefined();
  expect(await covered(f.employmentId,day())).toEqual([]);
  await clock(f.employmentId,day(1));
  const saved=await row(f.employmentId,day(1));
  expect(saved).toMatchObject({checkInAt:'09:00:00',checkOutAt:'20:00:00'});
  expect(saved.calcTrace?.overtimePattern).toEqual({status:'refused',reason:'sourceUnavailable'});
  const punches=await owner.db.select().from(s.attendancePunch).where(eq(s.attendancePunch.attendanceId,saved.id)).orderBy(asc(s.attendancePunch.punchAt),asc(s.attendancePunch.id));
  expect(punches.map(punch=>({time:punch.punchAt,direction:punch.direction}))).toEqual([{time:'09:00:00',direction:'in'},{time:'20:00:00',direction:'out'}]);
  expect(await detected(f.employmentId,day(1))).toBe(true);
  expect(await withTenant(ctx,tx=>hasOvertimePatternForDayTx(tx,ctx,{employmentId:f.employmentId,date:day(1)}))).toBe(true);
  expect(await covered(f.employmentId,day(1))).toMatchObject([{employmentId:f.employmentId,date:day(1),coverage:'calculation',outcome:'refused',calculationId:expect.any(String)}]);
  const snapshot=await withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,{employmentId:f.employmentId,date:day(1)}));
  expect(snapshot.attendanceGroupPolicy).toMatchObject({id:configured.id,companyId:b.companyId,ruleId:f.ruleId,ordinal:1});
  expect(snapshot.policyExecutionContext).toMatchObject({state:'policy',selected:{id:configured.id},resolvedClock:{lateGraceMinutes:10,earlyGraceMinutes:15},
   schedule:{shiftId:f.shiftId,normalMinutes:480,breakMinutes:60,durationOnly:false},calendar:[{date:day(1),state:'known',dayClass:'normal'}]});
  // The manual fixture has no physical capture receipts. Labels and insertion dates cannot invent
  // absolute midnight placement or turn a scalar approval into captured work.
  expect(snapshot.policyClockSource).toEqual({state:'unavailable',authority:'sourceOnly',reason:'missingCapture'});
  expect(snapshot.policyClockReview).toEqual({state:'unavailable',authority:'proposalOnly',reason:'sourceUnavailable'});
  const current=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,{employmentId:f.employmentId,date:day(1)}));
  expect(current?.calculation).toMatchObject({bindingKind:'attendanceGroupPolicy',policyRevisionId:configured.id,policyPartCount:0,
   versionId:null,assignmentId:null,outcome:'refused',durationOutcome:'refused',transferable:false,payableNumerator:null,payableDenominator:null});
  expect(current?.evidence?.evidence).toMatchObject({attendanceGroupPolicy:snapshot.attendanceGroupPolicy,evaluation:null,duration:null,
   resolution:{status:'refused',issues:[{path:'attendanceGroupPolicy.execution'}]}});
  const calculations=await owner.db.select().from(s.attendanceOvertimeCalculation).where(eq(s.attendanceOvertimeCalculation.sourceId,current!.source.id))
   .orderBy(asc(s.attendanceOvertimeCalculation.ordinal));
  expect(calculations.map(calculation=>calculation.ordinal)).toEqual([1,2]);
  expect(current?.source.revision).toBe(2);expect(current?.source.currentCalculationId).toBe(current?.calculation?.id);
  await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'toil','active');ctx=await entitledCtx(b);
  for(const reader of [canonicalOvertimePayrollInputTx,canonicalOvertimeToilInputTx])
   await expect(withTenant(ctx,tx=>reader(tx,ctx,{employmentId:f.employmentId,date:day(1)}))).rejects.toMatchObject({code:'unavailable'});
  expect(await owner.db.select().from(s.attendanceOvertimeLine)).toEqual([]);
  expect(await owner.db.select().from(s.overtimeSourceSettlement)).toEqual([]);
 });
 it('rejects a newly superseded prepared policy, then retains both immutable versions after a fresh recalculation',async()=>{
  const f=await fixture(),first=await f.save();await clock(f.employmentId,day(3));
  const before=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,{employmentId:f.employmentId,date:day(3)}));
  expect(before?.calculation?.policyRevisionId).toBe(first.id);
  let secondId='';const api=createOvertimeCalculationOwner(canonicalOvertimeInputTx);
  await expect(withTenant(ctx,async tx=>{
   const prepared=await api.prepareTx(tx,ctx,{employmentId:f.employmentId,date:day(3)});
   const next=policy();next.clock.pairing='firstInLastOut';
   secondId=(await f.save(next,1,day(2))).id;
   return api.recordTx(tx,ctx,{prepared,expectedCurrentRevision:before!.source.revision,reason:'Fictional stale preparation probe'});
  })).rejects.toMatchObject({code:'stale'});
  const unchanged=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,{employmentId:f.employmentId,date:day(3)}));
  expect(unchanged).toEqual(before);
  const replacement=await calculateOvertimePatternDay(ctx,{employmentId:f.employmentId,date:day(3),expectedCurrentRevision:before!.source.revision,
   reason:'Fictional explicit refresh after policy change'});
  expect(replacement).toMatchObject({status:'recorded',policyRevisionId:secondId,evaluation:null,duration:null});
  const after=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,{employmentId:f.employmentId,date:day(3)}));
  expect(after?.calculation).toMatchObject({policyRevisionId:secondId,outcome:'refused',transferable:false});
  const retained=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,{employmentId:f.employmentId,date:day(3),revisionId:before!.calculation!.id}));
  expect(retained?.calculation).toEqual(before?.calculation);expect(retained?.evidence).toEqual(before?.evidence);
  expect(await owner.db.select().from(s.attendanceOvertimeLine)).toEqual([]);
  expect(await owner.db.select().from(s.overtimeSourceSettlement)).toEqual([]);
 });
 it('refuses a changed live schedule context instead of attaching its new windows to the recorded raw result',async()=>{
  const f=await fixture();await f.save();await clock(f.employmentId,day(1));
  const before=await withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,{employmentId:f.employmentId,date:day(1)}));
  expect(before.policyExecutionContext?.state).toBe('policy');const rawBefore=await row(f.employmentId,day(1));
  await updateShift(ctx,{shiftId:f.shiftId,...f.shiftInput,startTime:'10:00',endTime:'19:00'});
  const after=await withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,{employmentId:f.employmentId,date:day(1)}));
  expect(after.policyExecutionContext).toEqual({state:'unavailable',reason:'scheduleUnavailable'});
  expect(after.input.source.inputDigest).not.toBe(before.input.source.inputDigest);
  const stored=await withTenant(ctx,tx=>readOvertimeCalculationTx(tx,ctx,{employmentId:f.employmentId,date:day(1)}));
  expect(stored?.evidence?.evidence).toMatchObject({policyExecutionContext:before.policyExecutionContext});
  expect(await row(f.employmentId,day(1))).toEqual(rawBefore);
 });
 it('does not apply another employer policy merely because both employers share a Schedule Group',async()=>{
  const f=await fixture(),other=await createCompany(ctx,{legalName:'Fictional other policy employer',country:'MY',currency:'MYR'});
  await scheduleAttendanceGroupPolicy(ctx,{companyId:other.id,ruleId:f.ruleId,expectedOrdinal:0,effectiveFrom:day(1),reason:'Fictional other employer policy',policy:policy()});
  await clock(f.employmentId,day(1));
  expect(await detected(f.employmentId,day(1))).toBe(false);
  expect((await row(f.employmentId,day(1))).calcTrace?.overtimePattern).toBeUndefined();
  expect(await covered(f.employmentId,day(1))).toEqual([]);
 });
 it('does not treat missing dated employer proof as proof that the configured group has no policy',async()=>{
  const f=await fixture();await f.save();await clock(f.employmentId,day(1));
  await owner.db.delete(s.assignment).where(eq(s.assignment.employmentId,f.employmentId));
  expect(await detected(f.employmentId,day(1))).toBe(true);
  await expect(withTenant(ctx,tx=>canonicalOvertimeInputTx(tx,ctx,{employmentId:f.employmentId,date:day(1)}))).rejects.toMatchObject({code:'unavailable'});
 });
 it('reasserts an already approved scalar plan without turning it into policy execution evidence',async()=>{
  const f=await fixture();await f.save();
  const requested=await requestAttendanceCorrection(ctx,{employmentId:f.employmentId,date:day(1),requestedOtMinutes:120,
   reason:'Fictional policy routing plan',plannedStartTime:'18:00',plannedEndTime:'20:00',otReasonCategory:'project_deadline'});
  await decideAttendanceCorrection(ctx,{correctionId:requested.correctionId,decision:'approved'});
  await clock(f.employmentId,day(1));
  const [first]=await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,requested.correctionId)).limit(1);
  expect(first.appliedAt).not.toBeNull();
  await checkIn(ctx,{employmentId:f.employmentId,date:day(1),time:'21:00'});
  await checkOut(ctx,{employmentId:f.employmentId,date:day(1),time:'22:00'});
  const [again]=await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,requested.correctionId)).limit(1);
  expect(again.appliedAt).toEqual(first.appliedAt);expect(again.approvedOtMinutes).toBe(first.approvedOtMinutes);
  expect((await row(f.employmentId,day(1))).calcTrace?.overtimePattern).toEqual({status:'refused',reason:'sourceUnavailable'});
  expect(await covered(f.employmentId,day(1))).toMatchObject([{coverage:'calculation',outcome:'refused'}]);
  const calculations=await owner.db.select().from(s.attendanceOvertimeCalculation).orderBy(asc(s.attendanceOvertimeCalculation.sourceId),asc(s.attendanceOvertimeCalculation.ordinal));
  expect(calculations.length).toBeGreaterThan(1);
  expect(calculations.every(calculation=>calculation.bindingKind==='attendanceGroupPolicy'&&calculation.outcome==='refused'&&!calculation.transferable)).toBe(true);
  expect(await owner.db.select().from(s.overtimeSourceSettlement)).toEqual([]);
 });
 it('rejects a revoked actual principal before labelling an unreadable policy legacy',async()=>{
  const f=await fixture();await f.save();await clock(f.employmentId,day(1));
  await owner.db.delete(s.roleAssignment).where(eq(s.roleAssignment.appUserId,ctx.userId!));
  await expect(detected(f.employmentId,day(1))).rejects.toThrow('Current Attendance principal required');
 });
});
