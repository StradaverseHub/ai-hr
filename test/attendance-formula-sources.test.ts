import {afterAll,beforeAll,beforeEach,describe,it,expect} from 'vitest';
import {adminCtx,closeAll,migrateTestDb,resetDb,seedBase,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {checkIn,checkOut,setAttendancePolicy} from '../packs/attendance/service';
import {withTenant,type SessionContext} from '../db/client';
import {todayInKualaLumpur} from '../lib/hr-date';
import {readAttendanceFormulaDaysTx} from '../packs/attendance/formula-sources';
import {evaluateAttendanceFormula} from '../lib/attendance-formula-language';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();base=await seedBase();});
async function fixture(){const ctx=adminCtx(base),date=todayInKualaLumpur();const hired=await hireEmployee(ctx,{person:{fullName:'Fictional formula employee',primaryEmail:'formula-source@example.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});await setAttendancePolicy(ctx,{companyId:base.companyId,workStart:'09:00',workEnd:'17:00',breakMinutes:0,lateAfter:'09:00',halfDayBefore:'13:00',workingDays:[1,2,3,4,5,6,7]});return {ctx,date,employmentId:hired.employmentId,companyId:base.companyId};}
const read=(f:Awaited<ReturnType<typeof fixture>>)=>withTenant(f.ctx,tx=>readAttendanceFormulaDaysTx(tx,f.ctx,{...f,from:f.date,to:f.date}));
describe('native Attendance formula source custody',()=>{
 it('evaluates actual recorded attendance through the same deterministic engine used by tests',async()=>{const f=await fixture();await checkIn(f.ctx,{employmentId:f.employmentId,date:f.date,time:'09:00'});await checkOut(f.ctx,{employmentId:f.employmentId,date:f.date,time:'19:00'});const source=await read(f);expect(source.days).toHaveLength(1);expect(source.days[0].values.TotalWorkingMins).toMatchObject({state:'known',value:{type:'decimal',value:'600'}});expect(evaluateAttendanceFormula({conditions:[],formulas:[{code:'HOURS',source:'Return {#FormulaID}("TotalWorkingMins") / 60'}]},'HOURS',source.days).amount).toBe('10');expect(JSON.stringify(source.days)).not.toContain('basicSalary');});
 it('refuses an incomplete day instead of manufacturing a zero result',async()=>{const f=await fixture();await checkIn(f.ctx,{employmentId:f.employmentId,date:f.date,time:'09:00'});const source=await read(f);expect(source.days[0].values.TotalWorkingMins.state).toBe('unavailable');expect(()=>evaluateAttendanceFormula({conditions:[],formulas:[{code:'HOURS',source:'Return {#FormulaID}("TotalWorkingMins") / 60'}]},'HOURS',source.days)).toThrow(/unavailable/);});
 it('binds the exact source and detects a subsequent attendance change',async()=>{const f=await fixture();await checkIn(f.ctx,{employmentId:f.employmentId,date:f.date,time:'09:00'});await checkOut(f.ctx,{employmentId:f.employmentId,date:f.date,time:'19:00'});const before=await read(f);await checkIn(f.ctx,{employmentId:f.employmentId,date:f.date,time:'20:00'});await checkOut(f.ctx,{employmentId:f.employmentId,date:f.date,time:'21:00'});expect((await read(f)).sourceDigest).not.toBe(before.sourceDigest);});
 it('rejects a real other tenant and an employee caller without administrative authority',async()=>{const f=await fixture();const other=await seedBase(),foreign=adminCtx(other);await expect(withTenant(foreign,tx=>readAttendanceFormulaDaysTx(tx,foreign,{...f,from:f.date,to:f.date}))).rejects.toThrow();const employee:SessionContext={...f.ctx,userId:undefined,roles:['employee'],grants:[{role:'employee',companyId:null}]};await expect(withTenant(employee,tx=>readAttendanceFormulaDaysTx(tx,employee,{...f,from:f.date,to:f.date}))).rejects.toThrow();});
});

it('measures the reporter clock-pair gap as60minutes without deducting it twice from recorded work',async()=>{
 const f=await fixture();for(const [direction,time]of [['in','08:00'],['out','12:00'],['in','13:00'],['out','17:00']] as const){if(direction==='in')await checkIn(f.ctx,{employmentId:f.employmentId,date:f.date,time});else await checkOut(f.ctx,{employmentId:f.employmentId,date:f.date,time});}
 const source=await read(f);expect(source.days[0].values.UnproductiveTime).toMatchObject({state:'known',value:{type:'decimal',value:'60'}});
 expect(evaluateAttendanceFormula({conditions:[],formulas:[{code:'GAP',source:'Return {#FormulaID}("UnproductiveTime")'}]},'GAP',source.days).amount).toBe('60');
});

it('keeps gross flexi work intervals and the captured break allowance distinct',async()=>{
 const {createShift,assignDefaultShift}=await import('../core/roster');const f=await fixture();
 const shift=await createShift(f.ctx,{name:'Fictional frozen flexi shift',code:'FICTIONAL_FLEXI',type:'full_flexi',startTime:'08:00:00',endTime:'18:00:00',breakMinutes:30,breakPeriods:[{start:'12:00',end:'13:00',flexible:true,flexibleMinutes:30}],normalMinutesOverride:480,weeklyPattern:[1,2,3,4,5,6,7]});await assignDefaultShift(f.ctx,{employmentId:f.employmentId,shiftId:shift.id});
 for(const [direction,time]of [['in','08:00'],['out','12:00'],['in','13:00'],['out','17:00']] as const){if(direction==='in')await checkIn(f.ctx,{employmentId:f.employmentId,date:f.date,time});else await checkOut(f.ctx,{employmentId:f.employmentId,date:f.date,time});}
 const source=await read(f),values=source.days[0].values;expect(values.Flex1Interval).toMatchObject({state:'known',value:{value:'240'}});expect(values.Flex2Interval).toMatchObject({state:'known',value:{value:'240'}});expect(values.Break1FlexUsed).toMatchObject({state:'known',value:{value:'30'}});expect(values.UnproductiveTime).toMatchObject({state:'known',value:{value:'60'}});expect(values.TotalWorkingMins).toMatchObject({state:'known',value:{value:'450'}});
});

it('loads approved hourly positions through Leave and preserves its default consumer projection',async()=>{
 const {owner}=await import('./harness'),schema=await import('../db/schema'),{approvedLeaveMeasurementsTx}=await import('../packs/leave/service');const f=await fixture();await checkIn(f.ctx,{employmentId:f.employmentId,date:f.date,time:'10:00'});await checkOut(f.ctx,{employmentId:f.employmentId,date:f.date,time:'17:00'});
 const [request]=await owner.db.insert(schema.leaveRequest).values({tenantId:base.tenantId,employmentId:f.employmentId,leaveTypeId:base.annualLeaveTypeId,startDate:f.date,endDate:f.date,days:'0.13',hours:'1.00',fromTime:'09:00',toTime:'10:00',durationType:'hourly',status:'approved'}).returning();await owner.db.insert(schema.leaveRequestDate).values({tenantId:base.tenantId,leaveRequestId:request.id,subjectEmploymentId:f.employmentId,leaveDate:f.date,days:'0.13',status:'approved'});
 const defaultView=await withTenant(f.ctx,tx=>approvedLeaveMeasurementsTx(tx,{employmentIds:[f.employmentId],from:f.date,to:f.date,today:f.date}));expect(defaultView.get(f.employmentId+':'+f.date)?.leave?.[0]).not.toHaveProperty('from');const source=await read(f);expect(source.days[0].values.OnHourlyLeaveLateIn).toMatchObject({state:'known',value:{value:'60'}});expect(source.days[0].values.OnLeaveDurationMins).toMatchObject({state:'known',value:{value:'60'}});expect(source.days[0].values.LeaveCode1stHalfAll).toMatchObject({state:'known',value:{value:'ANNUAL'}});
});

it('uses retained native TOIL minutes and refuses an unavailable TOIL source instead of returning zero',async()=>{
 const {owner,setModule,entitledCtx}=await import('./harness'),schema=await import('../db/schema');const f=await fixture();await checkIn(f.ctx,{employmentId:f.employmentId,date:f.date,time:'09:00'});await checkOut(f.ctx,{employmentId:f.employmentId,date:f.date,time:'19:00'});await setModule(base.tenantId,'toil','active');
 const readToil=async()=>{const ctx=await entitledCtx(base);return withTenant(ctx,tx=>readAttendanceFormulaDaysTx(tx,ctx,{...f,from:f.date,to:f.date,variables:['OTtoLeave_TotalOTUsed','OTtoLeave_isUtilizeAll']}));};
 expect((await readToil()).days[0].values.OTtoLeave_TotalOTUsed).toMatchObject({state:'known',value:{value:'0'}});
 // A retained pre-existing accrual fixture, not a new credit or approval issued by formula testing.
 await owner.db.insert(schema.toilAccrual).values({tenantId:base.tenantId,employmentId:f.employmentId,workedDate:f.date,dayType:'workday',otMinutes:60,daysCredited:'0.13',accrualBasis:'hours_worked',expiresOn:'2099-12-31'});
 const retained=await readToil();expect(retained.days[0].values.OTtoLeave_TotalOTUsed).toMatchObject({state:'known',value:{value:'60'}});expect(retained.days[0].values.OTtoLeave_isUtilizeAll).toMatchObject({state:'known',value:{value:false}});await setModule(base.tenantId,'toil','disabled');expect((await readToil()).days[0].values.OTtoLeave_TotalOTUsed.state).toBe('unavailable');
});
