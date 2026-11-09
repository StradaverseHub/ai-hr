import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { withTenant, type SessionContext } from '../db/client';
import { attendance, attendanceClockCapture, attendancePunch } from '../db/schema';
import { addImportedPunchesBatchTx, attendancePolicyExecutionContextTx, checkInTx, checkOutTx, recordedIndependentClockPolicyAgreesTx } from '../core/attendance';
import { liveClockStateTx } from '../core/attendance-clock-read';
import { attendanceClockData } from '../core/attendance-clock-data';
import { scheduleAttendanceClockPolicy } from '../core/attendance-clock-policy';
import { ensureStandardRule } from '../core/attendance-rule';
import { hireEmployee } from '../core/org';
import { assignDefaultShift, createShift } from '../core/roster';
import { attendanceDayEditor, saveAttendanceDayEdit } from '../packs/attendance/day-adjustment';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let base:Base,ctx:SessionContext;
const dateAt=(days:number)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+days*86_400_000).toISOString().slice(0,10);
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();base=await seedBase();await setModule(base.tenantId,'attendance','active');ctx=adminCtx(base);});

async function fixture(){
  const {id:ruleId}=await ensureStandardRule(ctx);
  const {employmentId}=await hireEmployee(ctx,{person:{fullName:'Fictional clock policy employee',primaryEmail:randomUUID()+'@example.invalid'},
    companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:dateAt(-30)});
  const {id:shiftId}=await createShift(ctx,{code:'CLOCK_POLICY',name:'Fictional fixed work day',
    startTime:'09:00',endTime:'18:00',breakMinutes:0,weeklyPattern:[1,2,3,4,5,6,7],ruleId});
  await assignDefaultShift(ctx,{employmentId,shiftId});
  const save=(effectiveFrom:string,expectedOrdinal:number,normal:'auto'|'firstInLastOut')=>scheduleAttendanceClockPolicy(ctx,{
    companyId:base.companyId,ruleId,expectedOrdinal,effectiveFrom,reason:'Fictional prospective clock policy',
    policy:{pairing:{normal,rest:'firstInLastOut',off:'auto',publicHoliday:'firstInLastOut'},minimumIntervalMinutes:2},
  });
  const importDay=(day:string,entries:readonly (readonly [string,'in'|'out'])[])=>withTenant(ctx,tx=>addImportedPunchesBatchTx(tx,ctx,{
    runId:randomUUID(),days:[{employmentId,day,punches:entries.map(([time,direction])=>({time,direction}))}],
  }));
  const read=async(date:string)=>(await owner.db.select().from(attendance)
    .where(and(eq(attendance.employmentId,employmentId),eq(attendance.attendanceDate,date))))[0];
  return {employmentId,save,importDay,read};
}

it('uses independent dated pairing and last accepted filtering for terminal labels without activating dated overtime',async()=>{
  const f=await fixture(),old=dateAt(-1),auto=dateAt(1),envelope=dateAt(2);
  const work=[['09:00:00','in'],['12:00:00','out'],['13:00:00','in'],['18:00:00','out']] as const;
  await f.importDay(old,work);
  const oldBefore=await f.read(old);
  const first=await f.save(auto,0,'auto');
  const second=await f.save(envelope,1,'firstInLastOut');
  expect(await f.read(old)).toEqual(oldBefore);
  expect(await f.read(auto)).toBeUndefined();
  const withClose=[work[0],['09:01:00','out'] as const,...work.slice(1)];
  await f.importDay(auto,withClose);
  await f.importDay(envelope,withClose);
  expect(await f.read(auto)).toMatchObject({workedMinutes:480,otMinutes:0,calcTrace:{
    clockPolicy:{revisionId:first.id,attendanceDate:auto,dayClass:'normal',pairing:'auto',minimumIntervalMinutes:2,requiresReview:false},
  }});
  expect(await f.read(envelope)).toMatchObject({workedMinutes:540,otMinutes:0,calcTrace:{
    clockPolicy:{revisionId:second.id,attendanceDate:envelope,pairing:'firstInLastOut'},
  }});
  expect(await withTenant(ctx,tx=>attendancePolicyExecutionContextTx(tx,ctx,{employmentId:f.employmentId,date:auto})))
    .toEqual({state:'legacy',reason:'noDatedPolicy'});
  const audit=await attendanceClockData(ctx,f.employmentId,envelope);
  expect(audit.rows).toHaveLength(5);
  expect(audit.rows.find(row=>row.punchAt==='09:01:00')).toMatchObject({exclusion:'minimumInterval',voidedAt:null});
  expect(audit.rows.find(row=>row.punchAt==='12:00:00')).toMatchObject({exclusion:'intermediatePunch',voidedAt:null});
  const retained=await owner.db.select().from(attendancePunch).where(eq(attendancePunch.employmentId,f.employmentId));
  expect(retained.every(punch=>!punch.voidedAt)).toBe(true);
  const day=await f.read(envelope);
  if(!day.calcTrace?.clockPolicy)throw new Error('Expected the recorded calculation evidence.');
  const inputs={employmentId:f.employmentId,date:envelope,attendanceId:day.id,companyId:base.companyId,
    punches:retained.filter(punch=>punch.attendanceDate===envelope)};
  await expect(withTenant(ctx,tx=>recordedIndependentClockPolicyAgreesTx(tx,ctx,{...inputs,trace:day.calcTrace!}))).resolves.toBe(true);
  const stale=structuredClone(day.calcTrace);
  stale.clockPolicy!.exclusions.pop();
  await expect(withTenant(ctx,tx=>recordedIndependentClockPolicyAgreesTx(tx,ctx,{...inputs,trace:stale}))).resolves.toBe(false);
});

it('selects pairing from the resolved business day class, including explicit Off and Holiday',async()=>{
  const f=await fixture(),effectiveFrom=dateAt(1);
  await f.save(effectiveFrom,0,'auto');
  const classes=[
    ['workday','normal','auto',480],['rest_day','rest','firstInLastOut',540],
    ['off_day','off','auto',480],['holiday','publicHoliday','firstInLastOut',540],
  ] as const;
  for(const [index,[dayKind,dayClass,pairing,workedMinutes]] of classes.entries()){
    const date=dateAt(index+1);
    const editor=await attendanceDayEditor(ctx,f.employmentId,date);
    if(!editor)throw new Error('Expected the scoped Attendance editor.');
    await saveAttendanceDayEdit(ctx,{employmentId:f.employmentId,date,baseline:editor.baseline,
      reason:'Fictional canonical day type',kind:'schedule',shiftId:null,dayKind});
    await f.importDay(date,[['09:00:00','in'],['12:00:00','out'],['13:00:00','in'],['18:00:00','out']]);
    expect(await f.read(date)).toMatchObject({workedMinutes,calcTrace:{clockPolicy:{dayClass,pairing}}});
  }
});

it('keeps the mobile clock state open after an ignored Out and accepts the next valid Out',async()=>{
  const f=await fixture(),date=dateAt(1);
  await f.save(date,0,'auto');
  const capture=async(direction:'in'|'out',time:string,millisecond:string)=>{
    const [row]=await owner.db.insert(attendanceClockCapture).values({
      tenantId:base.tenantId,employmentId:f.employmentId,attendanceDate:date,direction,
      requestId:randomUUID(),commandDigest:'a'.repeat(64),serverRecordedAt:new Date(`${date}T${time}.${millisecond}+08:00`),
    }).returning({id:attendanceClockCapture.id});
    await (direction==='in'?checkInTx:checkOutTx)(ctx,{
      employmentId:f.employmentId,date,time,clockCaptureId:row.id,preciseOrder:true,
    });
  };
  await capture('in','09:00:00','750');
  await capture('out','09:02:00','749');
  expect(await f.read(date)).toMatchObject({checkInAt:'09:00:00',checkOutAt:null,workedMinutes:null});
  vi.useFakeTimers({toFake:['Date']});
  try{
    vi.setSystemTime(new Date(`${date}T09:02:01+08:00`));
    expect(await withTenant(ctx,tx=>liveClockStateTx(tx,f.employmentId))).toMatchObject({date,clockedIn:true});
    await capture('out','09:02:00','750');
    expect(await withTenant(ctx,tx=>liveClockStateTx(tx,f.employmentId))).toMatchObject({date,clockedIn:false});
  }finally{vi.useRealTimers();}
  expect(await f.read(date)).toMatchObject({checkInAt:'09:00:00',checkOutAt:'09:02:00',workedMinutes:2});
  const audit=await attendanceClockData(ctx,f.employmentId,date);
  expect(audit.rows).toHaveLength(3);
  expect(audit.rows.filter(row=>row.exclusion==='minimumInterval')).toHaveLength(1);
});

it('leaves a day open when its only Out is filtered and explains the retained punch',async()=>{
  const f=await fixture(),date=dateAt(1);
  await f.save(date,0,'auto');
  await f.importDay(date,[['09:00:00','in'],['09:01:00','out']]);
  expect(await f.read(date)).toMatchObject({checkInAt:'09:00:00',checkOutAt:null,workedMinutes:null,otMinutes:null});
  const audit=await attendanceClockData(ctx,f.employmentId,date);
  expect(audit.clockPolicy).toMatchObject({requiresReview:true});
  expect(audit.rows.find(row=>row.direction==='out')).toMatchObject({exclusion:'minimumInterval',voidedAt:null});
});
