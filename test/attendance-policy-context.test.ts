import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {createShift,assignDefaultShift,updateShift} from '../core/roster';
import {ensureStandardRule} from '../core/attendance-rule';
import {attendancePolicyExecutionContextTx,scheduleAttendanceGroupPolicy} from '../packs/attendance/service';
import {ATTENDANCE_POLICY_DAY_CLASSES,type AttendanceGroupPolicy} from '../lib/attendance-group-policy';
import {HR_LOCAL_TZ,todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
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
