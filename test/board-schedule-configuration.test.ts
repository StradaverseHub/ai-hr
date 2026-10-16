import {withTenant} from '../db/client';
import {absenceBreakdownByEmployment} from '../core/absence-days';
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,describe,expect,it,vi} from 'vitest';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {createShift,updateShift,listShiftOtWindows,saveShiftPay,assignDefaultShift,assignShift,setRestDay,clearRoster,assignShiftBulk,setRestDayBulk,copyRoster,setEmploymentScheduleGroup} from '../core/roster';
import {createAttendanceRule,copyAttendanceRule,getAttendanceRule,setRuleShifts,type AttendanceRuleInput} from '../core/attendance-rule';
import {saveScheduleGroupControl} from '../core/schedule-group-controls';
import {getScheduleRotation,saveScheduleRotation} from '../core/attendance-rotation';
import {assignPunchBusinessDays,checkIn,checkOut} from '../core/attendance';
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
  await saveShiftPay(ctx,{...pay,windows:[{...pay.windows[0],id:original[0].id,endTime:'21:00'}]});
  const changed=await listShiftOtWindows(ctx,sh.id);expect(changed[0].id).toBe(original[0].id);expect(changed[0].endTime).toBe('21:00:00');
  await saveShiftPay(ctx,{...pay,windows:[{...pay.windows[0],id:original[0].id}]});
  const beforeBasic=await listShiftOtWindows(ctx,sh.id);
  await updateShift(ctx,{shiftId:sh.id,...input,name:'Renamed',color:'#0aBcDe'});
  const [stored]=await owner.db.select().from(schema.shift).where(eq(schema.shift.id,sh.id));expect(stored.differential).toEqual(pay.differential);expect(stored.color).toBe('#0ABCDE');expect(await listShiftOtWindows(ctx,sh.id)).toEqual(beforeBasic);
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

describe('dated exemptions preserve observations',()=>{
 it('keeps late/early measurements while exempting named decisions and deductions from tomorrow',async()=>{
  const ctx=adminCtx(b),g=await createAttendanceRule(ctx,groupInput()),sh=await createShift(ctx,{...shiftInput(),ruleId:g.id}),e=await hire(sh.id);
  await setEmploymentScheduleGroup(ctx,{employmentId:e.employmentId,attendanceRuleId:g.id});
  await checkIn(ctx,{employmentId:e.employmentId,date:day(),time:'10:00'});await checkOut(ctx,{employmentId:e.employmentId,date:day(),time:'17:00'});
  expect(await attendanceOf(e.employmentId,day())).toMatchObject({status:'late',lateMinutes:60});
  await saveScheduleGroupControl(ctx,{ruleId:g.id,kind:'exception',enabled:true});
  await checkIn(ctx,{employmentId:e.employmentId,date:day(1),time:'10:00'});await checkOut(ctx,{employmentId:e.employmentId,date:day(1),time:'17:00'});
  const after=await attendanceOf(e.employmentId,day(1));expect(after).toMatchObject({status:'late',lateMinutes:60,earlyOutMinutes:59,lateDeductMinutes:0,earlyOutDeductMinutes:0,underMinutes:120});
  expect(after.calcTrace?.exemption?.effectiveFrom).toBe(day(1));expect((await attendanceOf(e.employmentId,day())).calcTrace?.exemption).toBeUndefined();
  const measurement=await withTenant(ctx,tx=>absenceBreakdownByEmployment(tx,day(2),day(2),[e.employmentId],{rules:'scheduled',until:day(2),measurement:'raw'}));
  const decisions=await withTenant(ctx,tx=>absenceBreakdownByEmployment(tx,day(2),day(2),[e.employmentId],{rules:'scheduled',until:day(2)}));
  expect(measurement.get(e.employmentId)?.absentDays).toBe(1);expect(decisions.get(e.employmentId)?.absentDays).toBe(0);
 });
});

it('freezes the full-day normal unit before half-day reduction for future shortfall explanations',async()=>{
 const ctx=adminCtx(b),sh=await createShift(ctx,{...shiftInput(),weeklyPattern:null,halfPattern:[1,2,3,4,5,6,7],normalMinutesOverride:480}),e=await hire(sh.id);
 await checkIn(ctx,{employmentId:e.employmentId,date:day(),time:'09:00'});await checkOut(ctx,{employmentId:e.employmentId,date:day(),time:'13:00'});
 expect((await attendanceOf(e.employmentId,day())).calcTrace?.schedule).toMatchObject({normalMinutesOverride:240,fullDayNormalMinutes:480,fixedClockApplicable:true});
});

it('Full Flexi imports use the real cutoff without fixed anchors, including nonworking days',async()=>{
 const ctx=adminCtx(b),dow=new Date(day()+'T00:00:00Z').getUTCDay()||7;
 const sh=await createShift(ctx,{...shiftInput(),type:'full_flexi',startTime:null,endTime:null,normalMinutesOverride:480,weeklyPattern:[dow===7?1:dow+1],dailyCutoffEnabled:true,dailyCutoffTime:'04:00'}),e=await hire(sh.id);
 const dates=await withTenant(ctx,tx=>assignPunchBusinessDays(tx,[{employmentId:e.employmentId,date:day(),time:'02:00'},{employmentId:e.employmentId,date:day(),time:'04:00'},{employmentId:e.employmentId,date:day(),time:'23:00'}]));
 expect(dates).toEqual([day(-1),day(),day()]);
 for(const [direction,time] of [['in','09:00'],['out','10:00'],['in','12:00'],['out','13:00']] as const)await (direction==='in'?checkIn:checkOut)(ctx,{employmentId:e.employmentId,date:day(),time});
 expect(await attendanceOf(e.employmentId,day())).toMatchObject({dayType:'rest_day',workedMinutes:120,lateMinutes:null,earlyOutMinutes:null,underMinutes:null});
});
it('a copied group keeps the current pool and forward cycle phase without copying past versions',async()=>{
 const ctx=adminCtx(b),g=await createAttendanceRule(ctx,groupInput()),a=await createShift(ctx,shiftInput()),bShift=await createShift(ctx,shiftInput());
 await setRuleShifts(ctx,{ruleId:g.id,shiftIds:[a.id]});const start=day(1),clock=day(2),copyStart=day(3);
 await saveScheduleRotation(ctx,{ruleId:g.id,expectedRevision:(await getScheduleRotation(ctx,g.id)).revision,allowedShiftIds:[bShift.id],cycle:{effectiveFrom:start,anchorDate:start,unit:'day',length:2,days:[{kind:'full',shiftId:bShift.id},{kind:'rest',shiftId:null}]}});
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(clock+'T12:00:00+08:00'));
 try{const copy=await copyAttendanceRule(ctx,{ruleId:g.id}),state=await getScheduleRotation(ctx,copy.id);expect(state.memberships.map(m=>m.shiftId)).toEqual([bShift.id]);expect(state.versions).toHaveLength(1);expect(state.versions[0]).toMatchObject({effectiveFrom:copyStart,anchorDate:start,allowedShiftIds:[bShift.id]});expect((await getScheduleRotation(ctx,g.id)).versions[0].effectiveFrom).toBe(start);}
 finally{vi.useRealTimers();}
});
it('an ungrouped employee cannot enter a Duty Off inherited group or select an archived shift',async()=>{
 const ctx=adminCtx(b),g=await createAttendanceRule(ctx,groupInput()),plain=await createShift(ctx,shiftInput()),controlled=await createShift(ctx,{...shiftInput(),ruleId:g.id}),e=await hire(plain.id);
 await expect(assignShift(ctx,{employmentId:e.employmentId,shiftDate:day(1),shiftId:controlled.id})).rejects.toThrow('Duty Roster Control is Off');
 await owner.db.update(schema.shift).set({archivedAt:new Date()}).where(eq(schema.shift.id,plain.id));
 await expect(assignShift(ctx,{employmentId:e.employmentId,shiftDate:day(1),shiftId:plain.id})).rejects.toThrow('archived shift');
});
