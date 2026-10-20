import {randomUUID} from 'node:crypto';
import {and,asc,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {createHolidayGroup} from '../core/admin';
import {setCompensation} from '../core/comp';
import {saveEmploymentHolidayCalendarAssignment,employmentHolidayCalendarHistory,holidayCalendarInclusiveEnd} from '../core/holiday-calendar-assignment';
import {holidayDatesFor,holidayDatesByEmployment} from '../core/holidays';
import {reconcileReplacementHolidaysTx,saveReplacementHolidayPolicy,listReplacementHolidays} from '../core/holiday-replacements';
import {workingDatesForSpan} from '../packs/leave/service';
import {createShift,assignDefaultShift,checkIn,checkOut,setAttendancePolicy} from '../packs/attendance/service';
import {createBatch,generatePayslips,closeBatch} from '../packs/payroll/service';
import {requirePackFor} from '../localization/registry';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
const today=todayInKualaLumpur(),add=(date:string,n:number)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const nextMonday=(()=>{let date=add(today,1);while(new Date(date+'T00:00:00Z').getUTCDay()!==1)date=add(date,1);return date;})();
const previousPeriod=add(today.slice(0,7)+'-01',-1).slice(0,7);
const priorMonday=(()=>{let date=previousPeriod+'-01';while(new Date(date+'T00:00:00Z').getUTCDay()!==1)date=add(date,1);return date;})();
let b:Base,ctx:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'attendance','active');await setModule(b.tenantId,'payroll','active');ctx=adminCtx(b);await owner.db.update(schema.company).set({defaultWorkState:'Selangor'}).where(eq(schema.company.id,b.companyId));});
async function hire(name='Dated calendar employee'){
 return hireEmployee(ctx,{person:{fullName:name,primaryEmail:randomUUID()+'@calendar.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:add(today,-800)});
}
const stateHoliday=(date:string,state:string)=>owner.db.insert(schema.holiday).values({tenantId:b.tenantId,country:'MY',state,holidayDate:date,name:'Fictional '+state+' holiday'});
const save=(employmentId:string,startDate:string,endDate:string|null,state='Johor',replacesId?:string)=>saveEmploymentHolidayCalendarAssignment(ctx,{employmentId,startDate,endDate,selection:{kind:'state',state},replacesId});
const records=(employmentId:string)=>owner.db.select().from(schema.employmentHolidayCalendar).where(eq(schema.employmentHolidayCalendar.employmentId,employmentId)).orderBy(asc(schema.employmentHolidayCalendar.recordedAt),asc(schema.employmentHolidayCalendar.id));
const events=()=>owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId,b.tenantId)).orderBy(asc(schema.domainEvent.sequence));

describe('dated calendar owner and shared consumers',()=>{
 it('uses adjacent half-open dates and legacy gaps consistently in individual, bulk and leave readers',async()=>{
  const first=await hire(),second=await hire('Legacy fallback colleague'),tuesday=add(nextMonday,1),wednesday=add(nextMonday,2);
  await stateHoliday(nextMonday,'Selangor');await stateHoliday(tuesday,'Johor');await stateHoliday(wednesday,'Selangor');
  await save(first.employmentId,nextMonday,nextMonday,'Selangor');await save(first.employmentId,tuesday,tuesday);
  const individual=await withTenant(ctx,tx=>holidayDatesFor(tx,{employmentId:first.employmentId,startDate:nextMonday,endDate:wednesday}));
  expect([...individual].sort()).toEqual([nextMonday,tuesday,wednesday]);
  const bulk=await withTenant(ctx,tx=>holidayDatesByEmployment(tx,{employmentIds:[first.employmentId,second.employmentId],startDate:nextMonday,endDate:wednesday}));
  expect(bulk.get(first.employmentId)).toEqual(individual);expect([...bulk.get(second.employmentId)!].sort()).toEqual([nextMonday,wednesday]);
  expect(await withTenant(ctx,tx=>workingDatesForSpan(tx,first.employmentId,tuesday,tuesday))).toEqual([]);
  expect(await withTenant(ctx,tx=>workingDatesForSpan(tx,second.employmentId,tuesday,tuesday))).toEqual([tuesday]);
  const rows=await records(first.employmentId);expect(rows[0].validTo).toBe(tuesday);expect(holidayCalendarInclusiveEnd(rows[0].validTo)).toBe(nextMonday);
  const [employment]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,first.employmentId));
  expect(employment.workState).toBeNull();expect(employment.holidayGroupId).toBeNull();
 });
 it('refuses overlap and stale replacement references, preserving immutable revision history',async()=>{
  const e=await hire(),first=await save(e.employmentId,nextMonday,add(nextMonday,2));
  await expect(save(e.employmentId,add(nextMonday,1),null)).rejects.toMatchObject({code:'overlap'});
  const replacement=await save(e.employmentId,nextMonday,nextMonday,'Selangor',first.id);
  await expect(save(e.employmentId,nextMonday,nextMonday,'Johor',first.id)).rejects.toMatchObject({code:'changed'});
  const rows=await records(e.employmentId);expect(rows).toHaveLength(2);expect(rows.find(row=>row.id===first.id)?.supersededAt).not.toBeNull();
  expect(rows.find(row=>row.id===replacement.id)).toMatchObject({replacesId:first.id,validFrom:nextMonday,validTo:add(nextMonday,1)});
  await expect(withTenant(ctx,tx=>tx.update(schema.employmentHolidayCalendar).set({workState:'Sabah'}).where(eq(schema.employmentHolidayCalendar.id,replacement.id)))).rejects.toThrow(/immutable/);
 });
 it('serializes simultaneous overlapping adds so exactly one assignment survives',async()=>{
  const e=await hire();const results=await Promise.allSettled([save(e.employmentId,nextMonday,null),save(e.employmentId,nextMonday,null,'Selangor')]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(results.filter(result=>result.status==='rejected')).toHaveLength(1);
  expect(await records(e.employmentId)).toHaveLength(1);
 });
 it('retains an archived current calendar for shortening while refusing new archived assignments',async()=>{
  const e=await hire(),group=await createHolidayGroup(ctx,{name:'Fictional calendar',states:['Selangor']});
  const first=await saveEmploymentHolidayCalendarAssignment(ctx,{employmentId:e.employmentId,startDate:nextMonday,endDate:add(nextMonday,3),selection:{kind:'group',groupId:group.id}});
  await owner.db.update(schema.holidayGroup).set({active:false}).where(eq(schema.holidayGroup.id,group.id));
  await saveEmploymentHolidayCalendarAssignment(ctx,{employmentId:e.employmentId,replacesId:first.id,startDate:nextMonday,endDate:add(nextMonday,1),selection:{kind:'group',groupId:group.id}});
  await expect(saveEmploymentHolidayCalendarAssignment(ctx,{employmentId:e.employmentId,startDate:add(nextMonday,4),selection:{kind:'group',groupId:group.id}})).rejects.toMatchObject({code:'calendar'});
 });
 it('refuses employee/foreign-company writes and foreign group references without changing history',async()=>{
  const e=await hire(),userId=await createAppUser(b.tenantId,e.personId,'employee');
  const employee={tenantId:b.tenantId,userId,personId:e.personId,roles:['employee'],entitlements:harnessSnapshot(b.tenantId)};
  await expect(saveEmploymentHolidayCalendarAssignment(employee,{employmentId:e.employmentId,startDate:nextMonday,selection:{kind:'none'}})).rejects.toMatchObject({code:'scope'});
  const other=await seedBase(),foreignGroup=await createHolidayGroup(adminCtx(other),{name:'Foreign calendar',states:['Selangor']});
  await expect(saveEmploymentHolidayCalendarAssignment(ctx,{employmentId:e.employmentId,startDate:nextMonday,selection:{kind:'group',groupId:foreignGroup.id}})).rejects.toMatchObject({code:'calendar'});
  await expect(employmentHolidayCalendarHistory(adminCtx(other),e.employmentId)).rejects.toMatchObject({code:'scope'});
  expect(await records(e.employmentId)).toEqual([]);
 });
 it('treats an unchanged save as a no-op and rejects impossible dates before a write',async()=>{
  const e=await hire(),first=await save(e.employmentId,nextMonday,null),before=await events();
  expect(await save(e.employmentId,nextMonday,null,'Johor',first.id)).toMatchObject({id:first.id,changed:false,updated:0});
  expect(await events()).toEqual(before);expect(await records(e.employmentId)).toHaveLength(1);
  await expect(save(e.employmentId,today.slice(0,4)+'-02-30',null)).rejects.toMatchObject({code:'dates'});
 });
 it('reconciles an explicitly requested future source outside the default horizon',async()=>{
  const e=await hire(),future=`${Number(today.slice(0,4))+2}-06-14`,dow=new Date(future+'T00:00:00Z').getUTCDay()||7;
  const shift=await createShift(ctx,{name:'Future rest day',code:'FUTURE',startTime:'09:00',endTime:'18:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5,6,7].filter(day=>day!==dow)});
  await assignDefaultShift(ctx,{employmentId:e.employmentId,shiftId:shift.id});await stateHoliday(future,'Selangor');
  await saveReplacementHolidayPolicy(ctx,{companyId:b.companyId,effectiveFrom:today,regime:'company_confirmed',confirmed:true,restMode:'scheduled_rest',halfEligible:false,searchDays:30,reason:'Fictional confirmed future policy.'});
  await withTenant(ctx,tx=>reconcileReplacementHolidaysTx(tx,ctx,e.employmentId,{sourceWindow:{from:future,to:future}}));
  const futureRows=(await listReplacementHolidays(ctx,{employmentId:e.employmentId})).filter(row=>row.sourceDate===future);
  expect(futureRows).toHaveLength(1);expect(futureRows[0]).toMatchObject({status:'allocated',replacementDate:add(future,1)});
 });
});

describe('calendar recalculation honors paid payroll',()=>{
 async function payrollFixture(closed:boolean){
  const e=await hire();await setCompensation(ctx,{employmentId:e.employmentId,basicSalary:4000,effectiveFrom:add(today,-800)});
  await requirePackFor('MY').statutory.set(ctx,{personId:e.personId,icNumber:'900101015201'});
  await stateHoliday(priorMonday,'Selangor');
  const {batchId}=await createBatch(ctx,{companyId:b.companyId,payPeriod:previousPeriod,scope:{employmentIds:[e.employmentId]}});
  await generatePayslips(ctx,{batchId});if(closed)await closeBatch(ctx,{batchId});return {...e,batchId};
 }
 it('refuses a change to an implicit holiday in closed payroll and rolls back assignment, event and payslip changes',async()=>{
  const e=await payrollFixture(true),beforeEvents=await events(),slips=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,e.batchId));
  await expect(save(e.employmentId,priorMonday,priorMonday)).rejects.toMatchObject({code:'closedPayroll'});
  expect(await records(e.employmentId)).toEqual([]);expect(await events()).toEqual(beforeEvents);
  expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,e.batchId))).toEqual(slips);
 });
 it('marks processed payroll stale and recomputes a complete Attendance day through its owner',async()=>{
  const e=await hire();await setAttendancePolicy(ctx,{companyId:b.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:00',halfDayBefore:'13:00',workingDays:[1,2,3,4,5,6,7]});
  await setCompensation(ctx,{employmentId:e.employmentId,basicSalary:4000,effectiveFrom:add(today,-800)});
  await requirePackFor('MY').statutory.set(ctx,{personId:e.personId,icNumber:'900101015201'});await stateHoliday(priorMonday,'Selangor');
  await checkIn(ctx,{employmentId:e.employmentId,date:priorMonday,time:'09:00'});await checkOut(ctx,{employmentId:e.employmentId,date:priorMonday,time:'19:00'});
  const {batchId}=await createBatch(ctx,{companyId:b.companyId,payPeriod:previousPeriod,scope:{employmentIds:[e.employmentId]}});await generatePayslips(ctx,{batchId});
  const result=await save(e.employmentId,priorMonday,priorMonday);
  expect(result.updated).toBe(1);
  const [batch]=await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,batchId));expect(batch.needsRecalcAt).not.toBeNull();expect(batch.recalcEmploymentIds).toContain(e.employmentId);
  const [day]=await owner.db.select().from(schema.attendance).where(and(eq(schema.attendance.employmentId,e.employmentId),eq(schema.attendance.attendanceDate,priorMonday)));
  expect(day.dayType).toBe('workday');
 });
});
