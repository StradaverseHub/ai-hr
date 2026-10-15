import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,describe,expect,it} from 'vitest';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {createShift,updateShift,listShiftOtWindows,saveShiftPay,assignDefaultShift,assignShift,setRestDay,clearRoster,assignShiftBulk,setRestDayBulk,copyRoster,setEmploymentScheduleGroup} from '../core/roster';
import {createAttendanceRule,getAttendanceRule,setRuleShifts,type AttendanceRuleInput} from '../core/attendance-rule';
import {saveScheduleGroupControl} from '../core/schedule-group-controls';
import {getScheduleRotation,saveScheduleRotation} from '../core/attendance-rotation';
import {checkIn,checkOut} from '../core/attendance';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import * as schema from '../db/schema';
let b:Base;
beforeAll(async()=>{await migrateTestDb();});beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(async()=>{await closeAll();});
const day=(n=0)=>new Date(Date.parse(todayInKualaLumpur()+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const groupInput=():AttendanceRuleInput=>({name:`Group ${randomUUID()}`,label:'Crew',lateGracePeriodMinutes:0,lateAfterMinutes:5,lateDeductMinutes:5,includeGraceInLateness:false,earlyGracePeriodMinutes:1,earlyAfterMinutes:5,earlyDeductMinutes:5,includeGraceInEarlyOut:false,applyDeductions:true,applyToEarlyOt:false,weeklyPattern:[1,2,3,4,5,6,7],otRows:[]});
const shiftInput=()=>({name:`Shift ${randomUUID()}`,code:randomUUID().slice(0,8),startTime:'09:00',endTime:'18:00',weeklyPattern:[1,2,3,4,5,6,7]});
const hire=async(shiftId:string)=>{const e=await hireEmployee(adminCtx(b),{person:{fullName:'Schedule Fixture',primaryEmail:`${randomUUID()}@t.local`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:day(-366)});await assignDefaultShift(adminCtx(b),{employmentId:e.employmentId,shiftId});return e;};
const attendanceOf=async(employmentId:string,date:string)=>{const [row]=await owner.db.select().from(schema.attendance).where(and(eq(schema.attendance.employmentId,employmentId),eq(schema.attendance.attendanceDate,date)));return row;};
describe('approved shift configuration behavior',()=>{
 it('creates Full Flexi without fixed anchors and counts eight recorded hours across a lunch clock-out',async()=>{
  const ctx=adminCtx(b),sh=await createShift(ctx,{...shiftInput(),type:'full_flexi',startTime:null,endTime:null,normalMinutesOverride:480,breakPeriods:[{start:'12:00',end:'13:00'}]});
  const [stored]=await owner.db.select().from(schema.shift).where(eq(schema.shift.id,sh.id));expect([stored.startTime,stored.endTime]).toEqual([null,null]);
  const e=await hire(sh.id);await checkIn(ctx,{employmentId:e.employmentId,date:day(),time:'09:00'});await checkOut(ctx,{employmentId:e.employmentId,date:day(),time:'12:00'});await checkIn(ctx,{employmentId:e.employmentId,date:day(),time:'13:00'});await checkOut(ctx,{employmentId:e.employmentId,date:day(),time:'18:00'});
  expect(await attendanceOf(e.employmentId,day())).toMatchObject({workedMinutes:480,underMinutes:0,lateMinutes:null,earlyOutMinutes:null,status:'present'});
 });
 it.each([null,0,-1,1441,1.5])('refuses Full Flexi required duration %s',async required=>{await expect(createShift(adminCtx(b),{...shiftInput(),type:'full_flexi',startTime:null,endTime:null,normalMinutesOverride:required})).rejects.toThrow();});
 it('basic shift edits preserve OT window identity and premium; dedicated clearing requires confirmation',async()=>{
  const ctx=adminCtx(b),input=shiftInput(),sh=await createShift(ctx,input);
  const pay={shiftId:sh.id,windows:[{label:'After work',startTime:'18:00',endTime:'20:00'}],differential:{kind:'flat_per_shift' as const,value:20},confirmClear:false};
  await saveShiftPay(ctx,pay);const original=await listShiftOtWindows(ctx,sh.id);await saveShiftPay(ctx,pay);expect(await listShiftOtWindows(ctx,sh.id)).toEqual(original);
  await updateShift(ctx,{shiftId:sh.id,...input,name:'Renamed',color:'#0aBcDe'});
  const [stored]=await owner.db.select().from(schema.shift).where(eq(schema.shift.id,sh.id));expect(stored.differential).toEqual(pay.differential);expect(stored.color).toBe('#0ABCDE');expect(await listShiftOtWindows(ctx,sh.id)).toEqual(original);
  await expect(saveShiftPay(ctx,{shiftId:sh.id,windows:[],differential:null,confirmClear:false})).rejects.toThrow('Confirm clearing');
  await saveShiftPay(ctx,{shiftId:sh.id,windows:[],differential:null,confirmClear:true});expect(await listShiftOtWindows(ctx,sh.id)).toEqual([]);
 });
});
describe('reusable shifts and controlled roster changes',()=>{
 it('two group pools share a shift without detaching either or changing the legacy default',async()=>{
  const ctx=adminCtx(b),a=await createAttendanceRule(ctx,groupInput()),c=await createAttendanceRule(ctx,{...groupInput(),label:'Crew B'}),sh=await createShift(ctx,{...shiftInput(),ruleId:a.id});
  await setRuleShifts(ctx,{ruleId:c.id,shiftIds:[sh.id]});const [stored]=await owner.db.select().from(schema.shift).where(eq(schema.shift.id,sh.id));expect(stored.ruleId).toBe(a.id);
  expect((await owner.db.select().from(schema.attendanceRuleShift).where(eq(schema.attendanceRuleShift.shiftId,sh.id))).map(r=>r.ruleId).sort()).toEqual([a.id,c.id].sort());
  const e=await hire(sh.id);await setEmploymentScheduleGroup(ctx,{employmentId:e.employmentId,attendanceRuleId:c.id});
  for(const operation of [()=>assignShift(ctx,{employmentId:e.employmentId,shiftDate:day(1),shiftId:sh.id}),()=>setRestDay(ctx,{employmentId:e.employmentId,shiftDate:day(1)}),()=>clearRoster(ctx,{employmentId:e.employmentId,shiftDate:day(1)}),()=>assignShiftBulk(ctx,{employmentIds:[e.employmentId],shiftDates:[day(1)],shiftId:sh.id}),()=>setRestDayBulk(ctx,{employmentIds:[e.employmentId],shiftDates:[day(1)],anchorId:b.companyId})])await expect(operation()).rejects.toThrow('Duty Roster Control is Off');
  await saveScheduleGroupControl(ctx,{ruleId:c.id,kind:'duty',enabled:true});await assignShift(ctx,{employmentId:e.employmentId,shiftDate:day(1),shiftId:sh.id});
  await saveScheduleGroupControl(ctx,{ruleId:c.id,kind:'duty',enabled:false});await expect(copyRoster(ctx,{employmentIds:[e.employmentId],sourceFrom:day(1),sourceTo:day(1),targetFrom:day(2)})).rejects.toThrow('Duty Roster Control is Off');
  expect((await getAttendanceRule(ctx,c.id))?.dutyRosterControl).toBe(false);
 });
 it('rejects unknown, duplicate and archived newly selected shifts without changing the pool',async()=>{
  const ctx=adminCtx(b),a=await createAttendanceRule(ctx,groupInput()),sh=await createShift(ctx,shiftInput());
  await expect(setRuleShifts(ctx,{ruleId:a.id,shiftIds:[randomUUID()]})).rejects.toThrow('unavailable');await expect(setRuleShifts(ctx,{ruleId:a.id,shiftIds:[sh.id,sh.id]})).rejects.toThrow('once');
  await owner.db.update(schema.shift).set({archivedAt:new Date()}).where(eq(schema.shift.id,sh.id));await expect(setRuleShifts(ctx,{ruleId:a.id,shiftIds:[sh.id]})).rejects.toThrow('archived');
 });
 it('shared shifts support independent future rotation versions and optimistic concurrency',async()=>{
  const ctx=adminCtx(b),a=await createAttendanceRule(ctx,groupInput()),c=await createAttendanceRule(ctx,groupInput()),sh=await createShift(ctx,shiftInput());
  for(const g of [a,c])await setRuleShifts(ctx,{ruleId:g.id,shiftIds:[sh.id]});
  const state=await getScheduleRotation(ctx,a.id);await saveScheduleRotation(ctx,{ruleId:a.id,expectedRevision:state.revision,allowedShiftIds:[sh.id],cycle:{effectiveFrom:day(1),anchorDate:day(1),unit:'day',length:2,days:[{kind:'full',shiftId:sh.id},{kind:'rest',shiftId:null}]}});
  await expect(saveScheduleRotation(ctx,{ruleId:a.id,expectedRevision:state.revision,allowedShiftIds:[sh.id],cycle:{effectiveFrom:day(3),anchorDate:day(3),unit:'day',length:1,days:[{kind:'full',shiftId:sh.id}]}})).rejects.toThrow('another administrator');
  const other=await getScheduleRotation(ctx,c.id);expect(other.versions).toEqual([]);expect(other.memberships.map(m=>m.shiftId)).toEqual([sh.id]);
 });
});
