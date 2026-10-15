import {randomUUID} from 'node:crypto';
import {and,asc,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {createShift,assignDefaultShift,updateShift,setEmploymentScheduleGroup} from '../core/roster';
import {createAttendanceRule,setRuleShifts} from '../core/attendance-rule';
import {saveScheduleRotation,getScheduleRotation} from '../core/attendance-rotation';
import {assignEmployeeShiftDated} from '../core/shift-arrangement';
import {checkIn,checkOut,setAttendancePolicy,rawScheduleDaysTx} from '../packs/attendance/service';
import {workingDatesForSpan} from '../packs/leave/service';
import {holidayDatesFor,holidayDatesByEmployment,originalHolidayCalendarFor} from '../core/holidays';
import {adjustReplacementHoliday,reconcileReplacementHolidays,saveReplacementHolidayPolicy} from '../core/holiday-replacements';
import {listReplacementHolidays,replacementHolidayHistory} from '../core/holiday-replacement-read';
import {addHolidayDays} from '../lib/holiday-replacement';
import {todayInKualaLumpur} from '../lib/hr-date';
import {setCompensation} from '../core/comp';
import {createBatch,generatePayslips} from '../packs/payroll/service';
let b:Base;
const day=(n=0)=>addHolidayDays(todayInKualaLumpur(),n),dow=(date:string)=>new Date(date+'T00:00:00Z').getUTCDay()||7;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();await owner.db.update(schema.company).set({defaultWorkState:'Selangor'}).where(eq(schema.company.id,b.companyId));});
async function fixture(extraRest:number[]=[]){
 const ctx=adminCtx(b),sourceDate=day(1),restDays=[dow(sourceDate),...extraRest],shiftInput={name:randomUUID(),code:randomUUID().slice(0,8),startTime:'09:00',endTime:'18:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5,6,7].filter(d=>!restDays.includes(d))};
 const sh=await createShift(ctx,shiftInput),e=await hireEmployee(ctx,{person:{fullName:'Replacement fixture',primaryEmail:`${randomUUID()}@test.local`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-366)});await assignDefaultShift(ctx,{employmentId:e.employmentId,shiftId:sh.id});
 await setAttendancePolicy(ctx,{companyId:b.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:00',halfDayBefore:'13:00',workingDays:[1,2,3,4,5,6,7]});
 const [h]=await owner.db.insert(schema.holiday).values({tenantId:b.tenantId,country:'MY',companyId:b.companyId,holidayDate:sourceDate,name:'Original public holiday'}).returning();
 await saveReplacementHolidayPolicy(ctx,{companyId:b.companyId,effectiveFrom:day(),regime:'company_confirmed',confirmed:true,restMode:'scheduled_rest',halfEligible:false,searchDays:30,reason:'Confirmed fictional company policy and calendar entitlement.'});
 return {ctx,sh,e,h,sourceDate,shiftInput};
}
const rows=async(employmentId:string)=>listReplacementHolidays(adminCtx(b),{employmentId});
describe('employee replacement owner and shared calendar',()=>{
 it.each(['A','B','C'])('scenario %s preserves originals and uses an eligible subsequent working date',async scenario=>{
  const f=await fixture(scenario==='C'?[dow(day(2))]:[]);
  if(scenario==='B')await owner.db.insert(schema.holiday).values({tenantId:b.tenantId,country:'MY',companyId:b.companyId,holidayDate:day(2),name:'Existing next holiday'});
  await reconcileReplacementHolidays(f.ctx,f.e.employmentId);
  const [row]=await rows(f.e.employmentId),replacement=day(scenario==='A'?2:3);expect(row).toMatchObject({sourceHolidayId:f.h.id,sourceDate:f.sourceDate,replacementDate:replacement,status:'allocated'});
  expect((await owner.db.select().from(schema.holiday).where(eq(schema.holiday.id,f.h.id)))[0].holidayDate).toBe(f.sourceDate);
  expect((await withTenant(f.ctx,tx=>rawScheduleDaysTx(tx,f.e.employmentId,f.sourceDate,f.sourceDate))).get(f.sourceDate)).toBe('rest');
  expect(await withTenant(f.ctx,tx=>holidayDatesFor(tx,{employmentId:f.e.employmentId,startDate:replacement,endDate:replacement}))).toEqual(new Set([replacement]));
  expect(await withTenant(f.ctx,tx=>workingDatesForSpan(tx,f.e.employmentId,replacement,replacement))).toEqual([]);
  await checkIn(f.ctx,{employmentId:f.e.employmentId,date:replacement,time:'09:00'});await checkOut(f.ctx,{employmentId:f.e.employmentId,date:replacement,time:'19:00'});
  const [record]=await owner.db.select().from(schema.attendance).where(and(eq(schema.attendance.employmentId,f.e.employmentId),eq(schema.attendance.attendanceDate,replacement)));expect(record.dayType).toBe('holiday');expect(record.ot30Minutes).toBeGreaterThan(0);
 });
 it('repeat and concurrent processing preserve one allocation and unchanged revision counts',async()=>{
  const f=await fixture();await reconcileReplacementHolidays(f.ctx,f.e.employmentId);const [before]=await rows(f.e.employmentId),history=await replacementHolidayHistory(f.ctx,before.id);
  const results=await Promise.all([reconcileReplacementHolidays(f.ctx,f.e.employmentId),reconcileReplacementHolidays(f.ctx,f.e.employmentId)]);expect(results.map(r=>r.changed)).toEqual([0,0]);expect(await rows(f.e.employmentId)).toEqual([before]);expect(await replacementHolidayHistory(f.ctx,before.id)).toEqual(history);
  await expect(owner.db.update(schema.replacementHolidayRevision).set({createdBy:'rewritten'}).where(eq(schema.replacementHolidayRevision.id,history[0].id))).rejects.toThrow('immutable');
 });
 it('the annual original-calendar winner is identical in day, month and year windows, independently across years',async()=>{
  const f=await fixture(),national=day(5);await owner.db.insert(schema.holiday).values({tenantId:b.tenantId,country:'MY',holidayDate:national,name:'National outside company calendar'});
  const y=national.slice(0,4),month=national.slice(0,7),nextYear=String(Number(y)+1)+'-01-02';await owner.db.insert(schema.holiday).values({tenantId:b.tenantId,country:'MY',holidayDate:nextYear,name:'Next year national'});
  for(const [from,to] of [[national,national],[month+'-01',addHolidayDays(month+'-01',31)],[y+'-01-01',y+'-12-31']]){const values=await withTenant(f.ctx,tx=>holidayDatesFor(tx,{employmentId:f.e.employmentId,startDate:from,endDate:to}));expect(values.has(national)).toBe(false);}
  const all=await withTenant(f.ctx,tx=>originalHolidayCalendarFor(tx,{employmentId:f.e.employmentId,startDate:y+'-01-01',endDate:nextYear}));expect(all.map(h=>h.id)).toContain(f.h.id);expect(all.some(h=>h.date===nextYear)).toBe(true);
 });
 it('employee-specific replacements do not leak through shared original-calendar memos',async()=>{
  const f=await fixture(),second=await createShift(f.ctx,{...f.shiftInput,name:randomUUID(),code:randomUUID().slice(0,8),weeklyPattern:[1,2,3,4,5,6,7].filter(d=>![dow(day(1)),dow(day(2))].includes(d))}),other=await hireEmployee(f.ctx,{person:{fullName:'Other schedule',primaryEmail:`${randomUUID()}@test.local`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-366)});await assignDefaultShift(f.ctx,{employmentId:other.employmentId,shiftId:second.id});
  await reconcileReplacementHolidays(f.ctx,f.e.employmentId);await reconcileReplacementHolidays(f.ctx,other.employmentId);
  const calendars=await withTenant(f.ctx,tx=>holidayDatesByEmployment(tx,{employmentIds:[f.e.employmentId,other.employmentId],startDate:day(2),endDate:day(3)}));expect(calendars.get(f.e.employmentId)).toEqual(new Set([day(2)]));expect(calendars.get(other.employmentId)).toEqual(new Set([day(3)]));
 });
 it('reconciles a dated shift change and retains immutable source and allocation history',async()=>{
  const f=await fixture();await reconcileReplacementHolidays(f.ctx,f.e.employmentId);const [before]=await rows(f.e.employmentId);
  const next=await createShift(f.ctx,{...f.shiftInput,name:randomUUID(),code:randomUUID().slice(0,8),weeklyPattern:[1,2,3,4,5,6,7].filter(d=>![dow(day(1)),dow(day(2))].includes(d))});await assignEmployeeShiftDated(f.ctx,{employmentId:f.e.employmentId,shiftId:next.id,shiftType:'fixed',effectiveFrom:day(2)});
  await reconcileReplacementHolidays(f.ctx,f.e.employmentId);const [after]=await rows(f.e.employmentId);expect(after.id).toBe(before.id);expect(after.replacementDate).toBe(day(3));expect((await replacementHolidayHistory(f.ctx,after.id)).map(h=>(h.snapshot.after as {replacementDate:string}).replacementDate)).toEqual([day(2),day(3)]);
 });
 it('manual decisions survive automatic reruns and cannot collide with another original holiday',async()=>{
  const f=await fixture();await reconcileReplacementHolidays(f.ctx,f.e.employmentId);const [row]=await rows(f.e.employmentId);
  await adjustReplacementHoliday(f.ctx,{allocationId:row.id,date:day(3),reason:'Authorized fictional alternate working day.'});expect((await reconcileReplacementHolidays(f.ctx,f.e.employmentId)).changed).toBe(0);expect((await rows(f.e.employmentId))[0]).toMatchObject({manual:true,replacementDate:day(3)});
  await expect(adjustReplacementHoliday(f.ctx,{allocationId:row.id,date:f.sourceDate,reason:'Invalid original holiday reuse.'})).rejects.toThrow();
 });
 it('flags recorded attendance instead of rewriting it when a replacement moves',async()=>{
  const f=await fixture();await reconcileReplacementHolidays(f.ctx,f.e.employmentId);await checkIn(f.ctx,{employmentId:f.e.employmentId,date:day(2),time:'09:00'});await checkOut(f.ctx,{employmentId:f.e.employmentId,date:day(2),time:'18:00'});
  const before=await owner.db.select().from(schema.attendance).where(eq(schema.attendance.employmentId,f.e.employmentId));await updateShift(f.ctx,{...f.shiftInput,shiftId:f.sh.id,weeklyPattern:[1,2,3,4,5,6,7].filter(d=>![dow(day(1)),dow(day(2))].includes(d))});
  await reconcileReplacementHolidays(f.ctx,f.e.employmentId);expect((await rows(f.e.employmentId))[0]).toMatchObject({status:'review',reason:'recorded_attendance',replacementDate:day(2),proposedDate:day(3)});expect(await owner.db.select().from(schema.attendance).where(eq(schema.attendance.employmentId,f.e.employmentId))).toEqual(before);
 });
 it.each(['processed','closed'] as const)('leaves %s payroll snapshots intact and flags the proposed new holiday',async status=>{
  const f=await fixture();await setCompensation(f.ctx,{employmentId:f.e.employmentId,basicSalary:4000,monthlyAllowance:0,effectiveFrom:day(-366)});const {batchId}=await createBatch(f.ctx,{companyId:b.companyId,payPeriod:day(2).slice(0,7)});await generatePayslips(f.ctx,{batchId});if(status==='closed')await owner.db.update(schema.payrollBatch).set({status}).where(eq(schema.payrollBatch.id,batchId));
  const paid=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));await reconcileReplacementHolidays(f.ctx,f.e.employmentId);expect((await rows(f.e.employmentId))[0]).toMatchObject({status:'review',reason:'payroll_protected',replacementDate:null,proposedDate:day(2)});expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId))).toEqual(paid);
 });
 it('does not allow an employee to adjust or read another employee’s replacement',async()=>{
  const f=await fixture();await reconcileReplacementHolidays(f.ctx,f.e.employmentId);const [row]=await rows(f.e.employmentId),other=await hireEmployee(f.ctx,{person:{fullName:'Unrelated',primaryEmail:`${randomUUID()}@test.local`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-366)});
  const user=await createAppUser(b.tenantId,other.personId,'employee');const ctx:SessionContext={...f.ctx,userId:user,personId:other.personId,roles:['employee'],grants:[{role:'employee',companyId:b.companyId}]};
  expect(await listReplacementHolidays(ctx,{employmentId:f.e.employmentId})).toEqual([]);await expect(adjustReplacementHoliday(ctx,{allocationId:row.id,date:day(3),reason:'Forged employee adjustment.'})).rejects.toThrow('HR administrator');
 });
});
