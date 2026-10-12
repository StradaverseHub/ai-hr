import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { and,eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import { hireEmployee } from '../core/org';
import { createShift,assignDefaultShift,assignShift,setRestDay,usualShiftsFor,updateShift,deleteShift } from '../core/roster';
import { getScheduleRotation,saveScheduleRotation } from '../core/attendance-rotation';
import { allowanceScheduleFactsTx,attendanceForEmploymentRange,otPlanCalendarMonth,checkIn,checkOut,workingShiftSchedule } from '../core/attendance';
import { setRuleShifts } from '../core/attendance-rule';
import { previewLeaveDeduction,workingDatesForSpan,leaveWorkingDaysCounterTx } from '../core/leave';
import { absenceBreakdownByEmployment } from '../core/absence-days';
import { createBatch,generatePayslips } from '../packs/payroll/service';
import { setCompensation } from '../core/comp';
import { todayInKualaLumpur } from '../lib/hr-date';
import { assignEmployeeShiftDated } from '../core/shift-arrangement';
import { resolveRosterCell } from '../lib/roster-month';
import type { RotationCycle } from '../core/week-pattern';
import { adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base } from './harness';
let b:Base;
const add=(date:string,n:number)=>new Date(Date.parse(`${date}T00:00:00Z`)+n*86_400_000).toISOString().slice(0,10);
const future=()=>add(todayInKualaLumpur(),8);
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();});
async function fixture(){
  const a=adminCtx(b);
  const [rule]=await owner.db.insert(schema.attendanceRule).values({tenantId:b.tenantId,name:'Rotating security',weeklyPattern:[1,2,3,4,5]}).returning();
  const morning=await createShift(a,{name:'Morning',code:'AM',startTime:'08:00',endTime:'17:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5],ruleId:rule.id});
  const night=await createShift(a,{name:'Night',code:'PM',startTime:'20:00',endTime:'05:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5],ruleId:rule.id});
  const e=await hireEmployee(a,{person:{fullName:'Rotation worker',primaryEmail:'rotation@test.local'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  await assignDefaultShift(a,{employmentId:e.employmentId,shiftId:morning.id});
  await owner.db.update(schema.employment).set({attendanceRuleId:rule.id}).where(eq(schema.employment.id,e.employmentId));
  const date=future();
  const cycle:RotationCycle={unit:'day',length:4,effectiveFrom:date,anchorDate:date,days:[{kind:'full',shiftId:morning.id},{kind:'half',shiftId:night.id},{kind:'off',shiftId:null},{kind:'rest',shiftId:null}]};
  return {a,rule,morning,night,e,date,cycle};
}
async function save(f:Awaited<ReturnType<typeof fixture>>,cycle=f.cycle,allowed=[f.morning.id,f.night.id]){
  const state=await getScheduleRotation(f.a,f.rule.id);
  return saveScheduleRotation(f.a,{ruleId:f.rule.id,expectedRevision:state.revision,allowedShiftIds:allowed,cycle});
}
const facts=(f:Awaited<ReturnType<typeof fixture>>,date:string)=>withTenant(f.a,tx=>allowanceScheduleFactsTx(tx,f.e.employmentId,date));
describe('approved Schedule Group rotation workflow',()=>{
  it('retains the next-day boundary for a half night shift',()=>{
    expect(workingShiftSchedule({start:'20:00',end:'05:00',crosses:true,breakMinutes:60},'half')).toMatchObject({shiftEnd:'00:30',crosses:true,normalMinutes:240});
  });
  it('clock-in/out derives against the rotation half shift rather than the profile shift',async()=>{
    const f=await fixture();await save(f);const date=add(f.date,1);
    await checkIn(f.a,{employmentId:f.e.employmentId,date,time:'20:00',manual:true});
    await checkOut(f.a,{employmentId:f.e.employmentId,date,time:'00:30',manual:true});
    const [record]=await owner.db.select().from(schema.attendance).where(and(eq(schema.attendance.employmentId,f.e.employmentId),eq(schema.attendance.attendanceDate,date)));
    expect(record.dayType).toBe('workday');expect(record.otMinutes).toBe(0);
    expect(record.lateMinutes).toBe(0);expect(record.earlyOutMinutes).toBe(0);
  });
  it('holiday classification overrides off/rest while a working rotation retains shift hours',async()=>{
    const f=await fixture();await save(f);
    await owner.db.insert(schema.holiday).values([f.date,add(f.date,2),add(f.date,3)].map(holidayDate=>({tenantId:b.tenantId,country:'MY',holidayDate,name:'Rotation holiday'})));
    expect(await facts(f,f.date)).toEqual({shiftId:f.morning.id,kind:'holiday',scheduledMinutes:480});
    expect((await facts(f,add(f.date,2))).kind).toBe('holiday');
    expect((await facts(f,add(f.date,3))).kind).toBe('holiday');
  });

  it('saves pool and complete cycle atomically; authoritative day facts select the working shift and half duration',async()=>{
    const f=await fixture();await save(f);
    expect(await facts(f,f.date)).toEqual({shiftId:f.morning.id,kind:'full',scheduledMinutes:480});
    expect(await facts(f,add(f.date,1))).toEqual({shiftId:f.night.id,kind:'half',scheduledMinutes:240});
    expect(await facts(f,add(f.date,2))).toEqual({shiftId:null,kind:'off',scheduledMinutes:0});
    expect(await facts(f,add(f.date,3))).toEqual({shiftId:null,kind:'rest',scheduledMinutes:0});
    expect(await facts(f,add(f.date,4))).toEqual({shiftId:f.morning.id,kind:'full',scheduledMinutes:480});
    expect((await getScheduleRotation(f.a,f.rule.id)).versions).toHaveLength(1);
  });
  it('retains explicit shift/rest roster precedence over cycles',async()=>{
    const f=await fixture();await save(f);
    await assignShift(f.a,{employmentId:f.e.employmentId,shiftId:f.night.id,shiftDate:f.date});
    await setRestDay(f.a,{employmentId:f.e.employmentId,shiftDate:add(f.date,1)});
    expect(await facts(f,f.date)).toEqual({shiftId:f.night.id,kind:'full',scheduledMinutes:480});
    expect((await facts(f,add(f.date,1))).kind).toBe('rest');
  });
  it('legacy dates stay unchanged and later immutable versions take effect only from their date',async()=>{
    const f=await fixture();const before=await facts(f,add(f.date,-1));await save(f);
    const next={...f.cycle,effectiveFrom:add(f.date,8),days:f.cycle.days.map(d=>d.kind==='full'?{...d,shiftId:f.night.id}:d)};
    await save(f,next);
    expect(await facts(f,add(f.date,-1))).toEqual(before);
    expect((await facts(f,add(f.date,4))).shiftId).toBe(f.morning.id);
    expect((await facts(f,add(f.date,8))).shiftId).toBe(f.night.id);
    await expect(save(f,{...next,effectiveFrom:add(f.date,7)})).rejects.toThrow(/later than every saved version/);
  });
  it('rejects stale administrators and invalid pool edits without partial writes',async()=>{
    const f=await fixture();const stale=await getScheduleRotation(f.a,f.rule.id);await save(f);
    await expect(saveScheduleRotation(f.a,{ruleId:f.rule.id,expectedRevision:stale.revision,allowedShiftIds:[f.morning.id],cycle:f.cycle})).rejects.toThrow(/another administrator/);
    const state=await getScheduleRotation(f.a,f.rule.id);
    await expect(save(f,{...f.cycle,effectiveFrom:add(f.date,8)},[f.morning.id])).rejects.toThrow(/Shifts Allowed/);
    expect((await getScheduleRotation(f.a,f.rule.id)).revision).toBe(state.revision);
    expect((await owner.db.select().from(schema.shift).where(eq(schema.shift.id,f.night.id)))[0].ruleId).toBe(f.rule.id);
  });
  it('rejects current/backdated dates before writing a version',async()=>{
    const f=await fixture();await expect(save(f,{...f.cycle,effectiveFrom:todayInKualaLumpur()})).rejects.toThrow(/tomorrow/);
    expect((await getScheduleRotation(f.a,f.rule.id)).versions).toHaveLength(0);
  });
  it('refuses foreign tenant shifts and employee mutation',async()=>{
    const f=await fixture(),other=await seedBase();const foreign=await createShift(adminCtx(other),{name:'Foreign',startTime:'08:00',endTime:'17:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5]});
    await expect(save(f,{...f.cycle,days:f.cycle.days.map(d=>d.kind==='full'?{...d,shiftId:foreign.id}:d)},[foreign.id,f.night.id])).rejects.toThrow(/unavailable in this tenant/);
    const userId=await createAppUser(b.tenantId,f.e.personId,'employee');
    await expect(saveScheduleRotation({...f.a,userId,personId:f.e.personId,roles:['employee']},{ruleId:f.rule.id,expectedRevision:(await getScheduleRotation(f.a,f.rule.id)).revision,allowedShiftIds:[f.morning.id,f.night.id],cycle:f.cycle})).rejects.toThrow(/group-wide HR/);
    expect((await getScheduleRotation(f.a,f.rule.id)).versions).toHaveLength(0);
  });
  it('retains an inherited group when a shift leaves the dated allowed pool',async()=>{
    const f=await fixture();await owner.db.update(schema.employment).set({attendanceRuleId:null}).where(eq(schema.employment.id,f.e.employmentId));
    const before=await facts(f,add(f.date,-1));await save(f);
    const later={...f.cycle,effectiveFrom:add(f.date,8),days:f.cycle.days.map(d=>d.shiftId===f.morning.id?{...d,shiftId:f.night.id}:d)};
    await save(f,later,[f.night.id]);
    expect((await owner.db.select().from(schema.shift).where(eq(schema.shift.id,f.morning.id)))[0].ruleId).toBe(f.rule.id);
    expect(await facts(f,add(f.date,-1))).toEqual(before);
    expect((await facts(f,f.date)).shiftId).toBe(f.morning.id);
    expect((await facts(f,add(f.date,8))).shiftId).toBe(f.night.id);
    expect((await getScheduleRotation(f.a,f.rule.id)).versions[1].allowedShiftIds).toEqual([f.night.id]);
  });
  it('refuses a shift belonging to another group and an ungrouped inherited employee shift',async()=>{
    const f=await fixture();const [other]=await owner.db.insert(schema.attendanceRule).values({tenantId:b.tenantId,name:'Another crew'}).returning();
    const foreign=await createShift(f.a,{name:'Other crew',startTime:'09:00',endTime:'17:00',ruleId:other.id});
    await expect(save(f,{...f.cycle,days:f.cycle.days.map(d=>d.kind==='full'?{...d,shiftId:foreign.id}:d)},[foreign.id,f.night.id])).rejects.toThrow(/another Schedule Group/);
    const ungrouped=await createShift(f.a,{name:'Ungrouped used',startTime:'09:00',endTime:'17:00',weeklyPattern:[1,2,3,4,5]});
    await owner.db.update(schema.employment).set({attendanceRuleId:null,defaultShiftId:ungrouped.id}).where(eq(schema.employment.id,f.e.employmentId));
    await expect(save(f,{...f.cycle,days:f.cycle.days.map(d=>d.kind==='full'?{...d,shiftId:ungrouped.id}:d)},[ungrouped.id,f.night.id])).rejects.toThrow(/without an explicit Schedule Group/);
    expect((await owner.db.select().from(schema.shift).where(eq(schema.shift.id,ungrouped.id)))[0].ruleId).toBeNull();
  });
  it('roster rotation inheritance follows the dated arrangement instead of the current cache',async()=>{
    const f=await fixture();await save(f);
    await owner.db.update(schema.employment).set({attendanceRuleId:null}).where(eq(schema.employment.id,f.e.employmentId));
    const later=await createShift(f.a,{name:'Later ungrouped',startTime:'09:00',endTime:'17:00',weeklyPattern:[1,2,3,4,5]});
    await assignEmployeeShiftDated(f.a,{employmentId:f.e.employmentId,shiftType:'fixed',shiftId:f.morning.id,effectiveFrom:'2020-01-01'});
    await assignEmployeeShiftDated(f.a,{employmentId:f.e.employmentId,shiftType:'fixed',shiftId:later.id,effectiveFrom:add(f.date,10)});
    const [usual]=await usualShiftsFor(f.a,[f.e.employmentId]);
    expect(resolveRosterCell(add(f.date,1),null,usual)).toEqual({kind:'usual',shiftId:f.night.id});
    expect((await facts(f,add(f.date,1))).shiftId).toBe(f.night.id);
  });
  it('rejects a company-scoped HR administrator even with a forged broad session role',async()=>{
    const f=await fixture();const userId=await createAppUser(b.tenantId,f.e.personId,'hr_admin');
    await owner.db.update(schema.roleAssignment).set({companyId:b.companyId}).where(eq(schema.roleAssignment.appUserId,userId));
    await expect(saveScheduleRotation({...f.a,userId,personId:f.e.personId,roles:['hr_admin']},{ruleId:f.rule.id,expectedRevision:(await getScheduleRotation(f.a,f.rule.id)).revision,allowedShiftIds:[f.morning.id,f.night.id],cycle:f.cycle})).rejects.toThrow(/group-wide HR/);
  });
  it('keeps archived version references and prevents legacy writers from changing the new pool',async()=>{
    const f=await fixture();await save(f);await owner.db.update(schema.shift).set({archivedAt:new Date()}).where(eq(schema.shift.id,f.night.id));
    expect((await facts(f,add(f.date,1))).shiftId).toBe(f.night.id);
    await expect(save(f,{...f.cycle,effectiveFrom:add(f.date,8)})).rejects.toThrow(/archived/);
    await expect(setRuleShifts(f.a,{ruleId:f.rule.id,shiftIds:[f.morning.id]})).rejects.toThrow(/together/);
    await expect(updateShift(f.a,{shiftId:f.morning.id,name:'Morning',code:'AM',startTime:'08:00',endTime:'17:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5],ruleId:null})).rejects.toThrow(/together/);
    await expect(deleteShift(f.a,{shiftId:f.night.id})).rejects.toThrow(/rotation|referenced/i);
  });
  it('attendance displays, OT calendar and roster ghosts use the saved cycle',async()=>{
    const f=await fixture();await save(f);
    const rows=await attendanceForEmploymentRange(f.a,f.e.employmentId,f.date,add(f.date,3));
    expect(rows.map(r=>r.shiftCode)).toEqual(['AM','PM',null,null]);
    const calendar=await otPlanCalendarMonth(f.a,f.e.employmentId,add(f.date,1).slice(0,7));
    expect(calendar.find(d=>d.date===add(f.date,1))?.shiftCode).toBe('PM');
    const [usual]=await usualShiftsFor(f.a,[f.e.employmentId]);
    expect(resolveRosterCell(add(f.date,1),null,usual)).toEqual({kind:'usual',shiftId:f.night.id});
  });
  it('leave weights and absence use rotation dates including half, off and rest',async()=>{
    const f=await fixture();await save(f);
    const leave=await previewLeaveDeduction(f.a,{employmentId:f.e.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:f.date,endDate:add(f.date,3),includeDayRows:true});
    expect(leave.days).toBe(1.5);
    const count=await withTenant(f.a,tx=>leaveWorkingDaysCounterTx(tx,f.e.employmentId));
    expect(count(f.date,add(f.date,3),new Set())).toBe(2);
    expect(count(f.date,add(f.date,3),new Set([f.date]))).toBe(1);
    expect(leave.dayRows?.map(d=>d.days)).toEqual([1,0.5,0,0]);
    expect(await withTenant(f.a,tx=>workingDatesForSpan(tx,f.e.employmentId,f.date,add(f.date,3)))).toEqual([f.date,add(f.date,1)]);
    for(const rules of ['legacy','scheduled'] as const){const absence=await withTenant(f.a,tx=>absenceBreakdownByEmployment(tx,f.date,add(f.date,3),[f.e.employmentId],{rules,until:add(f.date,3)}));expect(absence.get(f.e.employmentId)?.absentDays).toBe(2);}
  });
  it.each(['processed','closed'] as const)('protects %s payroll even when the recurring effective date is earlier than the run window',async status=>{
    const f=await fixture();await setCompensation(f.a,{employmentId:f.e.employmentId,basicSalary:4000,monthlyAllowance:0,effectiveFrom:'2020-01-01'});
    const {batchId}=await createBatch(f.a,{companyId:b.companyId,payPeriod:add(f.date,40).slice(0,7)});await generatePayslips(f.a,{batchId});
    if(status==='closed'){
      await owner.db.update(schema.payrollBatch).set({status:'closed'}).where(eq(schema.payrollBatch.id,batchId));
      await expect(save(f)).rejects.toThrow(/closed payroll/);
      expect((await getScheduleRotation(f.a,f.rule.id)).versions).toHaveLength(0);
    }else{
      await save(f);const [batch]=await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,batchId));
      expect(batch.needsRecalcAt).not.toBeNull();expect(batch.recalcEmploymentIds).toContain(f.e.employmentId);
    }
  });
});
