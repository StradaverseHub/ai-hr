import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as s from '../db/schema';
import { withTenant,type SessionContext } from '../db/client';
import { adminCtx,createAppUser,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base } from './harness';
import { hireEmployee,setReportingLine } from '../core/org';
import { createShift,assignDefaultShift,deleteShift,archiveShift,ShiftInUseError } from '../core/roster';
import { createAttendanceRule,updateAttendanceRuleSection } from '../core/attendance-rule';
import { importPunchCsv } from './helpers/punch-import';
import { todayInKualaLumpur } from '../lib/hr-date';
import { attendanceDayEditor,saveAttendanceDayEdit,amendExistingAttendanceApplication,attendanceIrregularitiesForDate } from '../packs/attendance/day-adjustment';
import { attendanceForEmploymentRange,attendanceForDate,workedDayKindForTx,requestAttendanceCorrection,decideAttendanceCorrection } from '../core/attendance';
import { recomputeAttendance } from '../core/attendance-recompute';
import { saveAttendanceWorkflow,setAttendanceWorkflowEnabled } from '../core/attendance-workflow';
import { attendanceApplicationDetail } from '../core/attendance-application-history';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch,generatePayslips } from '../packs/payroll/service';

let b:Base,CALLER:SessionContext;
vi.mock('../lib/scope',()=>({scopedAdmin:async()=>({s:CALLER,scopeIds:[b.companyId]})}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
const {adminCorrectAttendanceDayAction}=await import('../app/(app)/attendance/individual/[date]/actions');
const DATE=()=>todayInKualaLumpur(new Date(Date.now()-86400000));
const nextDay=(date:string)=>new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10);
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();CALLER=adminCtx(b);});
async function hire(name='Date worker'){
  const e=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:`${randomUUID()}@day.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  const [row]=await owner.db.select({code:s.employment.employeeCode}).from(s.employment).where(eq(s.employment.id,e.employmentId));return {...e,code:row.code!};
}
async function shift(code:string,end='17:00',ruleId?:string){return createShift(adminCtx(b),{code,name:code,startTime:'08:00',endTime:end,breakMinutes:60,weeklyPattern:[1,2,3,4,5,6,7],ruleId});}
async function fixture(){
  const e=await hire(),sh=await shift('DATE_BASE');await assignDefaultShift(adminCtx(b),{employmentId:e.employmentId,shiftId:sh.id});
  await importPunchCsv(adminCtx(b),`staff,time\n${e.code},${DATE()} 08:00:00\n${e.code},${DATE()} 20:00:00`);
  return {e,sh};
}
const day=async(id:string)=>(await owner.db.select().from(s.attendance).where(and(eq(s.attendance.employmentId,id),eq(s.attendance.attendanceDate,DATE()))))[0];
async function saveSchedule(id:string,shiftId:string|null,dayKind:'workday'|'off_day'|'rest_day'|'holiday'|null,consent=false){
  const editor=(await attendanceDayEditor(adminCtx(b),id,DATE()))!;
  return saveAttendanceDayEdit(adminCtx(b),{employmentId:id,date:DATE(),baseline:editor.baseline,reason:'Verified date correction',confirmPayrollRecalculation:consent,kind:'schedule',shiftId,dayKind});
}
describe('date-only Attendance Detail corrections',()=>{
  it('changes only the chosen date, preserves raw evidence and recurring schedules, and agrees across Records and the canonical day kind',async()=>{
    const {e,sh}=await fixture(),changed=await shift('DATE_ONLY','18:00');
    const original=await day(e.employmentId),punches=await owner.db.select().from(s.attendancePunch).where(eq(s.attendancePunch.employmentId,e.employmentId));
    await saveSchedule(e.employmentId,changed.id,'workday');
    expect((await day(e.employmentId)).otMinutes).toBe(120);
    expect((await day(e.employmentId)).checkInAt).toBe(original.checkInAt);expect((await day(e.employmentId)).checkOutAt).toBe(original.checkOutAt);
    expect(await owner.db.select().from(s.attendancePunch).where(eq(s.attendancePunch.employmentId,e.employmentId))).toEqual(punches);
    const [employment]=await owner.db.select().from(s.employment).where(eq(s.employment.id,e.employmentId));expect(employment.defaultShiftId).toBe(sh.id);
    expect((await owner.db.select().from(s.shift).where(eq(s.shift.id,sh.id)))[0].endTime).toBe('17:00:00');
    const range=await attendanceForEmploymentRange(adminCtx(b),e.employmentId,DATE(),nextDay(DATE()));
    expect(range.find(r=>r.date===DATE())?.shiftCode).toBe('DATE_ONLY');expect(range.find(r=>r.date===nextDay(DATE()))?.shiftCode).toBe('DATE_BASE');
    const daily=await attendanceForDate(adminCtx(b),DATE(),[b.companyId]);expect(daily.find(r=>r.employmentId===e.employmentId)?.shiftCode).toBe('DATE_ONLY');
    expect(await withTenant(adminCtx(b),tx=>workedDayKindForTx(tx,e.employmentId,DATE()))).toBe('workday');
    expect((await attendanceDayEditor(adminCtx(b),e.employmentId,DATE()))?.history).toHaveLength(1);
  });
  it.each(['off_day','rest_day','holiday'] as const)('persists %s and the canonical resolver agrees after reopening and recomputing',async kind=>{
    const {e}=await fixture();await saveSchedule(e.employmentId,null,kind);
    expect((await attendanceDayEditor(adminCtx(b),e.employmentId,DATE()))?.schedule.dayKind).toBe(kind);
    expect(await withTenant(adminCtx(b),tx=>workedDayKindForTx(tx,e.employmentId,DATE()))).toBe(kind);
    await recomputeAttendance(adminCtx(b),{companyId:b.companyId,employmentIds:[e.employmentId],from:DATE(),to:DATE(),dryRun:false});
    expect((await day(e.employmentId)).dayType).toBe(kind==='holiday'?'holiday':kind==='rest_day'?'rest_day':'workday');
  });
  it.each(['full_day','half_day_am','half_day_pm','hourly'])('preserves %s leave ownership and refuses replacing Day Type',async durationType=>{
    const {e}=await fixture();
    const [leave]=await owner.db.insert(s.leaveRequest).values({tenantId:b.tenantId,employmentId:e.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:DATE(),endDate:DATE(),days:'1',durationType,status:'approved'}).returning();
    const before=(await attendanceDayEditor(adminCtx(b),e.employmentId,DATE()))!;expect(before.leave).toMatchObject([{duration:durationType}]);
    await expect(saveSchedule(e.employmentId,null,'holiday')).rejects.toThrow('Leave owns');
    expect((await owner.db.select().from(s.leaveRequest).where(eq(s.leaveRequest.id,leave.id)))[0]).toEqual(leave);
    expect(await owner.db.select().from(s.attendanceDayAdjustment)).toEqual([]);
  });
  it('retains the selected shift as dated correction history and offers Archive instead of a raw delete failure',async()=>{
    const {e}=await fixture(),chosen=await shift('DATE_HISTORY');await saveSchedule(e.employmentId,chosen.id,'workday');
    await expect(deleteShift(adminCtx(b),{shiftId:chosen.id})).rejects.toBeInstanceOf(ShiftInUseError);
    await archiveShift(adminCtx(b),{shiftId:chosen.id});expect((await attendanceDayEditor(adminCtx(b),e.employmentId,DATE()))?.schedule.shiftCode).toBe('DATE_HISTORY');
  });
  it('enforces the selected employment’s allowed shifts and company-scoped administrator access',async()=>{
    const {e}=await fixture(),a=adminCtx(b);
    const rule=await createAttendanceRule(a,{name:'Restricted date group',status:'active',lateGracePeriodMinutes:0,lateAfterMinutes:0,lateDeductMinutes:0,includeGraceInLateness:false,earlyGracePeriodMinutes:0,earlyAfterMinutes:0,earlyDeductMinutes:0,includeGraceInEarlyOut:false,applyToEarlyOt:false,otRows:[]});
    const allowed=await shift('DATE_ALLOWED','17:00',rule.id),foreign=await shift('DATE_NOT_ALLOWED');
    await owner.db.update(s.employment).set({attendanceRuleId:rule.id}).where(eq(s.employment.id,e.employmentId));
    const editor=(await attendanceDayEditor(a,e.employmentId,DATE()))!;expect(editor.shifts.map(row=>row.id)).toEqual([allowed.id]);
    await expect(saveSchedule(e.employmentId,foreign.id,'workday')).rejects.toThrow('not allowed');
    expect(await owner.db.select().from(s.attendanceDayAdjustment)).toEqual([]);
    await saveSchedule(e.employmentId,allowed.id,'workday');
    const [otherCompany]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Other company'}).returning();
    const restricted={...a,grants:[{role:'hr_admin' as const,companyId:otherCompany.id}]};
    expect(await attendanceDayEditor(restricted,e.employmentId,DATE())).toBeNull();
    await expect(saveAttendanceDayEdit(restricted,{employmentId:e.employmentId,date:DATE(),baseline:editor.baseline,reason:'Outside company',confirmPayrollRecalculation:false,kind:'schedule',shiftId:allowed.id,dayKind:'holiday'})).rejects.toThrow('scope');
  });
  it('refuses stale saves, self corrections, non-admins, and a different tenant’s subject',async()=>{
    const {e}=await fixture(),old=(await attendanceDayEditor(adminCtx(b),e.employmentId,DATE()))!;await saveSchedule(e.employmentId,null,'workday');
    const input={employmentId:e.employmentId,date:DATE(),baseline:old.baseline,reason:'Stale',confirmPayrollRecalculation:false,kind:'schedule' as const,shiftId:null,dayKind:'holiday' as const};
    await expect(saveAttendanceDayEdit(adminCtx(b),input)).rejects.toThrow('changed');
    await expect(saveAttendanceDayEdit({...adminCtx(b),personId:e.personId},input)).rejects.toThrow('own attendance');
    const employee={...adminCtx(b),personId:e.personId,roles:['employee'],grants:[{role:'employee' as const,companyId:null}]};
    expect(await attendanceDayEditor(employee,e.employmentId,DATE())).toBeNull();await expect(saveAttendanceDayEdit(employee,input)).rejects.toThrow('scope');
    const other=await seedBase();expect(await attendanceDayEditor(adminCtx(other),e.employmentId,DATE())).toBeNull();await expect(saveAttendanceDayEdit(adminCtx(other),input)).rejects.toThrow('scope');
  });
});

describe('per-configured-row overtime decisions',()=>{
  it('preserves other manual rows, the original calculation and recomputation, then resets only the selected row to Auto',async()=>{
    const a=adminCtx(b),e=await hire();
    const rule=await createAttendanceRule(a,{name:'Date overtime bands',status:'active',lateGracePeriodMinutes:0,lateAfterMinutes:0,lateDeductMinutes:0,includeGraceInLateness:false,earlyGracePeriodMinutes:0,earlyAfterMinutes:0,earlyDeductMinutes:0,includeGraceInEarlyOut:false,applyToEarlyOt:false,otRows:[
      {fromMinutes:0,toMinutes:60,ratePattern:'variable',rate:1.5,roundingMode:'none',roundToMinutes:null},
      {fromMinutes:61,toMinutes:0,ratePattern:'variable',rate:2,roundingMode:'none',roundToMinutes:null},
    ]});
    const sh=await shift('ROW_BANDS','17:00',rule.id);await assignDefaultShift(a,{employmentId:e.employmentId,shiftId:sh.id});
    await importPunchCsv(a,`staff,time\n${e.code},${DATE()} 08:00:00\n${e.code},${DATE()} 20:00:00`);await saveSchedule(e.employmentId,sh.id,'workday');
    let editor=(await attendanceDayEditor(a,e.employmentId,DATE()))!;expect(editor.rows.map(r=>r.calculatedMinutes)).toEqual([60,120]);
    const keys=editor.rows.map(r=>r.key);
    const save=async(rows:{key:string;minutes:number|null}[])=>{editor=(await attendanceDayEditor(a,e.employmentId,DATE()))!;return saveAttendanceDayEdit(a,{employmentId:e.employmentId,date:DATE(),baseline:editor.baseline,reason:'Reviewed OT row',confirmPayrollRecalculation:false,kind:'overtime',rows});};
    await save([{key:keys[0],minutes:30},{key:keys[1],minutes:90}]);expect((await day(e.employmentId)).otMinutes).toBe(120);
    const trace=(await day(e.employmentId)).calcTrace!;expect(trace.overtime?.calculatedMinutes).toBe(180);expect(trace.overtime?.rows?.map(r=>r.effectiveMinutes)).toEqual([30,90]);
    await updateAttendanceRuleSection(a,{ruleId:rule.id,section:'attendance',fields:{lateGracePeriodMinutes:3}});
    editor=(await attendanceDayEditor(a,e.employmentId,DATE()))!;
    expect(editor.rows.map(row=>row.key)).toEqual(keys);
    expect(editor.rows.map(row=>row.effectiveMinutes)).toEqual([30,90]);
    expect(editor.rows.some(row=>row.orphan)).toBe(false);
    await recomputeAttendance(a,{companyId:b.companyId,employmentIds:[e.employmentId],from:DATE(),to:DATE(),dryRun:false});expect((await day(e.employmentId)).otMinutes).toBe(120);
    await save([{key:keys[0],minutes:null}]);editor=(await attendanceDayEditor(a,e.employmentId,DATE()))!;expect(editor.rows.map(r=>r.effectiveMinutes)).toEqual([60,90]);expect(editor.rows[1].manual?.calculatedMinutes).toBe(120);
    expect((await day(e.employmentId)).ot15Minutes).toBe(60);expect((await day(e.employmentId)).ot20Minutes).toBe(90);
    await expect(save([{key:keys[1],minutes:1.5}])).rejects.toThrow('whole');
    await expect(save([{key:keys[1],minutes:1440}])).rejects.toThrow('exceeds');
    expect((await day(e.employmentId)).otMinutes).toBe(150);
    await updateAttendanceRuleSection(a,{ruleId:rule.id,section:'general',name:'Date overtime bands',description:null,status:'active',applyDeductions:false,
      otRows:[{fromMinutes:0,toMinutes:60,ratePattern:'variable',rate:1.5}]});
    editor=(await attendanceDayEditor(a,e.employmentId,DATE()))!;expect(editor.rows.find(row=>row.key===keys[1])?.orphan).toBe(true);
    await expect(saveSchedule(e.employmentId,sh.id,'workday')).rejects.toThrow('Return that row to Auto');
    await save([{key:keys[1],minutes:null}]);expect((await attendanceDayEditor(a,e.employmentId,DATE()))?.rows.some(row=>row.orphan)).toBe(false);
  });
});

describe('manual overtime and pre-existing approval/configuration contracts',()=>{
  async function fullFlexiRecordedDay(){
    const e=await hire('Full Flexi split sessions'),a=adminCtx(b);
    const sh=await createShift(a,{code:'FULL_FLEXI_CLOSED_PAIRS',name:'Full Flexi recorded pairs',type:'full_flexi',normalMinutesOverride:480,
      weeklyPattern:[1,2,3,4,5,6,7],breakPeriods:[{start:'12:00',end:'13:00',flexible:true,flexibleMinutes:30}]});
    await assignDefaultShift(a,{employmentId:e.employmentId,shiftId:sh.id});
    await importPunchCsv(a,`staff,time\n${e.code},${DATE()} 09:00:00\n${e.code},${DATE()} 12:00:00\n${e.code},${DATE()} 13:00:00\n${e.code},${DATE()} 18:30:00`);
    return {e,a};
  }

  it('reads the Full Flexi editor Auto rows from closed sessions without changing stored attendance',async()=>{
    const {e,a}=await fullFlexiRecordedDay(),before=await day(e.employmentId);
    expect(before).toMatchObject({workedMinutes:480,otMinutes:0});
    const editor=(await attendanceDayEditor(a,e.employmentId,DATE()))!;
    expect(editor.complete).toBe(true);
    expect(editor.rows.length).toBeGreaterThan(0);
    expect(editor.rows.reduce((total,row)=>total+row.calculatedMinutes,0)).toBe(0);
    expect(editor.rows.reduce((total,row)=>total+row.autoEffectiveMinutes,0)).toBe(0);
    expect(editor.rows.reduce((total,row)=>total+row.effectiveMinutes,0)).toBe(0);
    expect(await day(e.employmentId)).toEqual(before);
  });

  it('preserves Full Flexi closed sessions through a manual OT decision and explicit reset to Auto',async()=>{
    const {e,a}=await fullFlexiRecordedDay();
    const save=async(minutes:number|null)=>{
      const editor=(await attendanceDayEditor(a,e.employmentId,DATE()))!;
      await saveAttendanceDayEdit(a,{employmentId:e.employmentId,date:DATE(),baseline:editor.baseline,reason:'Review split sessions',confirmPayrollRecalculation:false,
        kind:'overtime',rows:[{key:editor.rows[0].key,minutes}]});
    };
    await save(15);
    expect(await day(e.employmentId)).toMatchObject({workedMinutes:480,otMinutes:15});
    await save(null);
    expect(await day(e.employmentId)).toMatchObject({workedMinutes:480,otMinutes:0});
    const editor=(await attendanceDayEditor(a,e.employmentId,DATE()))!;
    expect(editor.rows.reduce((total,row)=>total+row.effectiveMinutes,0)).toBe(0);
  });

  it('recomputes Full Flexi from the same closed sessions rather than the first-to-last envelope',async()=>{
    const {e,a}=await fullFlexiRecordedDay();
    const punches=await owner.db.select().from(s.attendancePunch).where(eq(s.attendancePunch.employmentId,e.employmentId)).orderBy(s.attendancePunch.id);
    await recomputeAttendance(a,{companyId:b.companyId,employmentIds:[e.employmentId],from:DATE(),to:DATE(),dryRun:false});
    expect(await day(e.employmentId)).toMatchObject({workedMinutes:480,otMinutes:0,underMinutes:0});
    expect(await owner.db.select().from(s.attendancePunch).where(eq(s.attendancePunch.employmentId,e.employmentId)).orderBy(s.attendancePunch.id)).toEqual(punches);
  });

  it('keeps the approved Auto baseline and restores it after an explicit manual reset',async()=>{
    const {e}=await fixture(),a=adminCtx(b);
    await owner.db.insert(s.attendanceCorrection).values({tenantId:b.tenantId,employmentId:e.employmentId,attendanceDate:DATE(),reason:'Existing approved overtime',requestedOtMinutes:120,approvedOtMinutes:120,status:'approved',decidedAt:new Date(),appliedAt:new Date()});
    let editor=(await attendanceDayEditor(a,e.employmentId,DATE()))!;const key=editor.rows[0].key;
    expect(editor.approvedOtMinutes).toBe(120);expect(editor.rows[0].calculatedMinutes).toBe(180);expect(editor.rows[0].autoEffectiveMinutes).toBe(120);
    const save=async(minutes:number|null)=>{editor=(await attendanceDayEditor(a,e.employmentId,DATE()))!;await saveAttendanceDayEdit(a,{employmentId:e.employmentId,date:DATE(),baseline:editor.baseline,reason:'Reviewed approved baseline',confirmPayrollRecalculation:false,kind:'overtime',rows:[{key,minutes}]});};
    await save(45);await recomputeAttendance(a,{companyId:b.companyId,employmentIds:[e.employmentId],from:DATE(),to:DATE(),dryRun:false});expect((await day(e.employmentId)).otMinutes).toBe(45);
    await save(null);expect((await day(e.employmentId)).otMinutes).toBe(120);expect((await attendanceDayEditor(a,e.employmentId,DATE()))?.rows[0].calculatedMinutes).toBe(180);
  });
  it('retains manual minutes and original calculation when the dated day type changes its default premium rate',async()=>{
    const {e}=await fixture(),a=adminCtx(b);let editor=(await attendanceDayEditor(a,e.employmentId,DATE()))!;const key=editor.rows[0].key;
    const save=async(minutes:number|null)=>{editor=(await attendanceDayEditor(a,e.employmentId,DATE()))!;await saveAttendanceDayEdit(a,{employmentId:e.employmentId,date:DATE(),baseline:editor.baseline,reason:'Reviewed manual row',confirmPayrollRecalculation:false,kind:'overtime',rows:[{key,minutes}]});};
    await save(45);await saveSchedule(e.employmentId,null,'holiday');
    editor=(await attendanceDayEditor(a,e.employmentId,DATE()))!;expect(editor.schedule.dayKind).toBe('holiday');expect(editor.rows[0].effectiveMinutes).toBe(45);expect(editor.rows[0].manual?.calculatedMinutes).toBe(180);expect((await day(e.employmentId)).ot30Minutes).toBe(45);
    await save(null);expect((await day(e.employmentId)).ot30Minutes).toBe(660);
  });
});

describe('existing irregularity application identity and stages',()=>{
  it('leaves an empty section empty and rejects the old create-on-save action when there is no matching application',async()=>{
    const {e}=await fixture();expect(await attendanceIrregularitiesForDate(adminCtx(b),e.employmentId,DATE())).toEqual([]);
    const fd=new FormData();for(const [key,value]of Object.entries({employmentId:e.employmentId,date:DATE(),checkIn:'08:00',checkOut:'19:00',reason:'No application'}))fd.set(key,value);
    const result=await adminCorrectAttendanceDayAction(fd).catch(()=>({ok:false as const}));expect(result.ok).toBe(false);expect(await owner.db.select().from(s.attendanceCorrection)).toEqual([]);
  });
  it('amends and approves the same employee application, retaining its requester, original proposal and administrator event',async()=>{
    const {e}=await fixture(),userId=await createAppUser(b.tenantId,e.personId,'employee');
    const self={...adminCtx(b),userId,personId:e.personId,roles:['employee'],grants:[{role:'employee' as const,companyId:null}]};
    const {correctionId}=await requestAttendanceCorrection(self,{employmentId:e.employmentId,date:DATE(),checkIn:'08:00',checkOut:'19:00',reason:'Employee original request',remark:'Employee original remark'});
    const before=(await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,correctionId)))[0];
    const editor=(await attendanceDayEditor(adminCtx(b),e.employmentId,DATE()))!;
    const result=await amendExistingAttendanceApplication(adminCtx(b),{employmentId:e.employmentId,date:DATE(),correctionId,baseline:editor.baseline,reason:'Administrator checked the gate log',checkIn:'08:00',checkOut:'18:00'});expect(result.status).toBe('approved');
    const after=(await owner.db.select().from(s.attendanceCorrection).where(eq(s.attendanceCorrection.id,correctionId)))[0];
    expect(after.proposedCheckOut).toBe(before.proposedCheckOut);expect(after.reason).toBe(before.reason);expect(after.remark).toBe(before.remark);const requested=(await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,correctionId),eq(s.domainEvent.eventType,'attendance-correction.requested'))))[0];expect(requested.actorId).toBe(userId);
    expect(after.adminAmendment).toMatchObject({checkOut:'18:00',actorId:b.adminUserId});expect((await day(e.employmentId)).checkOutAt).toBe('18:00:00');
    const history=await attendanceApplicationDetail(adminCtx(b),[b.companyId],correctionId);expect(history?.events.some(e=>e.eventType==='attendance-correction.admin-amended'&&e.actorId===b.adminUserId)).toBe(true);
    const stranger=await hire('Other employee');expect(await attendanceIrregularitiesForDate(adminCtx(b),stranger.employmentId,DATE())).toEqual([]);expect(await attendanceIrregularitiesForDate(adminCtx(b),e.employmentId,nextDay(DATE()))).toEqual([]);
  });
  it('completes only the allowed stage, exposes the amendment for the next approver, and refuses rewriting after an earlier decision',async()=>{
    const {e}=await fixture(),a=adminCtx(b);
    await saveAttendanceWorkflow(a,{companyId:b.companyId,code:'DAY_REVIEW',name:'Two reviews',description:'Two authorised reviews',applicationType:'irregularity',priority:100,criteria:{departmentIds:[b.deptA]},active:true,stages:[{name:'First review',level:{kind:'hr_admin',employmentId:null,alternates:[]}},{name:'Final review',level:{kind:'hr_admin',employmentId:null,alternates:[]}}]});
    await setAttendanceWorkflowEnabled(a,b.companyId,'irregularity',true);
    const {correctionId}=await requestAttendanceCorrection(a,{employmentId:e.employmentId,date:DATE(),checkIn:'08:00',checkOut:'19:00',reason:'Original request'});
    let editor=(await attendanceDayEditor(a,e.employmentId,DATE()))!;
    const first=await amendExistingAttendanceApplication(a,{employmentId:e.employmentId,date:DATE(),correctionId,baseline:editor.baseline,reason:'First review correction',checkIn:'08:00',checkOut:'18:00',expectedStageIndex:0});expect(first.status).toBe('pending');expect((await day(e.employmentId)).checkOutAt).toBe('20:00:00');
    editor=(await attendanceDayEditor(a,e.employmentId,DATE()))!;expect(editor.applications[0].adminAmendment?.checkOut).toBe('18:00');
    await expect(amendExistingAttendanceApplication(a,{employmentId:e.employmentId,date:DATE(),correctionId,baseline:editor.baseline,reason:'Rewrite after approval',checkIn:'08:00',checkOut:'17:00',expectedStageIndex:1})).rejects.toThrow('earlier approval');
    const final=await amendExistingAttendanceApplication(a,{employmentId:e.employmentId,date:DATE(),correctionId,baseline:editor.baseline,reason:'Final review confirms correction',checkIn:'08:00',checkOut:'18:00',expectedStageIndex:1});expect(final.status).toBe('approved');expect((await day(e.employmentId)).checkOutAt).toBe('18:00:00');
  });
});

it('requires processed-payroll consent, marks recalculation without changing the payslip, and refuses closed payroll atomically',async()=>{
  const {e}=await fixture(),a=adminCtx(b);
  await setCompensation(a,{employmentId:e.employmentId,basicSalary:4000,monthlyAllowance:0,effectiveFrom:'2020-01-01'});
  await setStatutoryProfileMY(a,{personId:e.personId,icNumber:'900101011234'});
  const {batchId}=await createBatch(a,{companyId:b.companyId,payPeriod:DATE().slice(0,7)});await generatePayslips(a,{batchId});
  const before=await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId,batchId));
  await expect(saveSchedule(e.employmentId,null,'holiday')).rejects.toThrow('Confirm');expect(await owner.db.select().from(s.attendanceDayAdjustment)).toEqual([]);
  await saveSchedule(e.employmentId,null,'holiday',true);
  expect((await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,batchId)))[0].needsRecalcAt).not.toBeNull();
  expect(await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId,batchId))).toEqual(before);
  await owner.db.update(s.payrollBatch).set({status:'closed'}).where(eq(s.payrollBatch.id,batchId));
  const adjustment=await owner.db.select().from(s.attendanceDayAdjustment);
  await expect(saveSchedule(e.employmentId,null,'workday',true)).rejects.toThrow('closed payroll');expect(await owner.db.select().from(s.attendanceDayAdjustment)).toEqual(adjustment);
});


it('protects an existing Leave Credit instead of changing its attendance evidence',async()=>{
  const {e}=await fixture();
  const expires=nextDay(DATE());
  const [credit]=await owner.db.insert(s.toilAccrual).values({tenantId:b.tenantId,employmentId:e.employmentId,workedDate:DATE(),dayType:'workday',otMinutes:60,daysCredited:'1.00',accrualBasis:'hours_worked',expiresOn:expires,source:'hr_manual_grant'}).returning();
  const before=await day(e.employmentId);
  await expect(saveSchedule(e.employmentId,null,'holiday')).rejects.toThrow('dependent Leave Credit');
  expect(await day(e.employmentId)).toEqual(before);expect(await owner.db.select().from(s.attendanceDayAdjustment)).toEqual([]);
  expect((await owner.db.select().from(s.toilAccrual).where(eq(s.toilAccrual.id,credit.id)))[0]).toEqual(credit);
});
