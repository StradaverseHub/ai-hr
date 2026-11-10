/** Home Today: app.home_own_clock_day (draft 5082) answers the own clock and schedule reads exactly.
 *
 * For each clock state the live owners and the bundled owners run inside ONE read-only snapshot at ONE frozen
 * instant (the clock's `now`), and every result must be identical to the byte: the own clock summary, the work
 * location names, and for yesterday and today the complete resolved schedule, the clock schedule and the worked day
 * kind. States: not clocked in, clocked in, on a break, back from a break, clocked out (a legacy day row), a rostered
 * rest day, a company holiday, approved leave, offline punches whose arrival is later than their instant, an open
 * overnight shift from yesterday, and a Schedule Group employee with a dated shift arrangement, OT windows, a
 * group rule with OT rows and a future rotation, and a day adjustment naming another shift. Clock writes use the unchanged writers. */
import {randomUUID} from 'node:crypto';
import {eq} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
vi.mock('../lib/session',()=>({getSession:async()=>undefined}));
vi.mock('next-intl/server',()=>({getLocale:async()=>'en',getTranslations:async()=>(key:string)=>key}));
import * as S from '../db/schema';
import {client,withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {createLocation} from '../core/location';
import {withAttendanceTenant} from '../core/module-gate';
import {captureEmployeeClock,captureOfflineClockTx,clockScheduleForTx,employeeClockingLocationLabelsTx,ensureStandardRule,ownClockTodayHomeTx,
 ownClockTodaySummaryTx,readOwnClockDayInputsTx,resolvedScheduleForTx,setAttendancePolicy,workedDayKindForTx,type OfflineClockCommand} from '../packs/attendance/service';
import {readEmployeeHomeToday} from '../core/employee-home-today';
import {clockCommandContext} from '../lib/clock-command-context';
import {todayInKualaLumpur} from '../lib/hr-date';
import {stagedHomeToday} from './helpers/home-staged-cards';
import {withStagedHomeReads} from '../core/calendar-window-inputs';
import {seedAttendanceSubmissionBase} from './helpers/attendance-submission-fixture';
import {installOfflineDraftForWorker} from './helpers/mobile-offline-draft';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,type Base} from './harness';

let base:Base,restoreOffline:(()=>Promise<void>)|undefined;
type Subject={name:string;employmentId:string;ctx:SessionContext};
const subjects:Subject[]=[];
const TODAY=todayInKualaLumpur(),YESTERDAY=todayInKualaLumpur(new Date(Date.now()-86400000));
const pause=()=>new Promise(resolve=>setTimeout(resolve,1100));
async function employee(name:string,companyId=base.companyId,departmentId=base.deptA){
 const hired=await hireEmployee(adminCtx(base),{person:{fullName:'Fictional '+name,primaryEmail:randomUUID()+'@clock-day.test'},companyId,departmentId,
  employmentType:'full_time',hiredOn:'2024-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,'employee');
 const ctx:SessionContext={tenantId:base.tenantId,userId,personId:hired.personId,roles:['employee'],grants:[{role:'employee',companyId}],entitlements:harnessSnapshot(base.tenantId)};
 return {name,employmentId:hired.employmentId,ctx};
}
const online=(subject:Subject,action:'in'|'out')=>captureEmployeeClock(subject.ctx,{action,requestId:randomUUID(),lat:3,lng:101,accuracy:5,
 employmentId:subject.employmentId,clockContext:clockCommandContext(subject.ctx.tenantId,subject.ctx.userId,subject.employmentId)});
const offline=(employmentId:string,action:'in'|'out',at:number):OfflineClockCommand=>({employmentId,requestId:randomUUID(),action,lat:3,lng:101,accuracy:5,
 effectiveAt:new Date(at),claimDigest:randomUUID().replace(/-/g,'').padEnd(64,'0')});
async function shiftRow(values:Partial<typeof S.shift.$inferInsert>){
 const code='CD'+randomUUID().replace(/-/g,'').slice(0,8).toUpperCase();
 const [row]=await owner.db.insert(S.shift).values({tenantId:base.tenantId,companyId:base.companyId,code,name:code,startTime:'09:00:00',endTime:'18:00:00',
  breakMinutes:60,weeklyPattern:[1,2,3,4,5,6,7],...values}).returning({id:S.shift.id});
 return row.id;
}
function same(bundled:unknown,live:unknown,label:string){
 expect(JSON.stringify(bundled),label).toBe(JSON.stringify(live));
 expect(bundled,label).toStrictEqual(live);
}
async function statements<T>(work:()=>Promise<T>){
 const options=client.options as {debug?:unknown},sent:string[]=[],previous=options.debug;
 options.debug=(_connection:number,query:string)=>{sent.push(query.replace(/\s+/g,' ').trim());};
 try{return {result:await work(),sent};}finally{options.debug=previous;}
}

beforeAll(async()=>{
 vi.stubEnv('AIHR_MOBILE_CLOCK_POLICY','');
 await migrateTestDb();await resetDb();
 base=await seedAttendanceSubmissionBase();
 restoreOffline=await installOfflineDraftForWorker();
 await setAttendancePolicy(adminCtx(base),{companyId:base.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:15',halfDayBefore:'13:00',workingDays:[1,2,3,4,5]});
 await ensureStandardRule(adminCtx(base));
 subjects.push(await employee('not clocked in'));
 const clockedIn=await employee('clocked in');await online(clockedIn,'in');subjects.push(clockedIn);
 const onBreak=await employee('on break');await online(onBreak,'in');await pause();await online(onBreak,'out');subjects.push(onBreak);
 const back=await employee('back from break');await online(back,'in');await pause();await online(back,'out');await pause();await online(back,'in');subjects.push(back);
 const out=await employee('clocked out');
 await owner.db.insert(S.attendance).values({tenantId:base.tenantId,employmentId:out.employmentId,attendanceDate:TODAY,checkInAt:'09:00',checkOutAt:'17:00',status:'present',workedMinutes:480,otMinutes:0} as never);
 subjects.push(out);
 const rest=await employee('rest day');
 await owner.db.insert(S.rosterAssignment).values({tenantId:base.tenantId,employmentId:rest.employmentId,shiftDate:TODAY,isRestDay:true});subjects.push(rest);
 const [holidayCompany]=await owner.db.insert(S.company).values({tenantId:base.tenantId,legalName:'Fictional Holiday Sdn Bhd',country:'MY'}).returning({id:S.company.id});
 const [holidayDepartment]=await owner.db.insert(S.department).values({tenantId:base.tenantId,companyId:holidayCompany.id,name:'Fictional holiday team'}).returning({id:S.department.id});
 await owner.db.insert(S.holiday).values({tenantId:base.tenantId,country:'MY',companyId:holidayCompany.id,holidayDate:TODAY,name:'Fictional company holiday'});
 subjects.push(await employee('company holiday',holidayCompany.id,holidayDepartment.id));
 const leave=await employee('on leave');
 await owner.db.insert(S.leaveRequest).values({tenantId:base.tenantId,employmentId:leave.employmentId,leaveTypeId:base.annualLeaveTypeId,startDate:TODAY,endDate:TODAY,days:'1',status:'approved'});
 subjects.push(leave);
 const off=await employee('offline punches');
 const now=Math.floor(Date.now()/1000)*1000-1000,midnight=Date.parse(TODAY+'T00:00:00+08:00'),step=Math.max(1000,Math.min(120000,Math.floor((now-midnight)/3/1000)*1000));
 const written=await withAttendanceTenant(off.ctx,async tx=>[await captureOfflineClockTx(tx,off.ctx,offline(off.employmentId,'in',now-2*step)),
  await captureOfflineClockTx(tx,off.ctx,offline(off.employmentId,'out',now-step))]);
 expect(written.map(row=>row.kind)).toEqual(['recorded','recorded']);subjects.push(off);
 const night=await employee('overnight');
 const nightShift=await shiftRow({startTime:'22:00:00',endTime:'06:00:00',crossesMidnight:true,breakMinutes:30});
 await owner.db.insert(S.rosterAssignment).values({tenantId:base.tenantId,employmentId:night.employmentId,shiftDate:YESTERDAY,shiftId:nightShift,isRestDay:false});
 await owner.db.insert(S.attendance).values({tenantId:base.tenantId,employmentId:night.employmentId,attendanceDate:YESTERDAY,checkInAt:'22:00',status:'present'} as never);
 subjects.push(night);
 const group=await employee('schedule group');
 // A Schedule Group and its OT rows are overtime configuration: their snapshot trigger needs an administrator transaction.
 const rule=await withTenant(adminCtx(base),async tx=>{
  const [row]=await tx.insert(S.attendanceRule).values({tenantId:base.tenantId,name:'Fictional schedule group',isDefault:false} as never).returning({id:S.attendanceRule.id});
  await tx.insert(S.attendanceRuleOtRow).values([{tenantId:base.tenantId,ruleId:row.id,fromMinutes:0,toMinutes:120,rate:'1.50',sortOrder:0},
   {tenantId:base.tenantId,ruleId:row.id,fromMinutes:120,toMinutes:0,rate:'2.00',phRate:'3.00',sortOrder:1}]);
  return row;
 });
 const fixed=await shiftRow({ruleId:rule.id,lateGraceMinutes:10});
 await owner.db.insert(S.shiftOtWindow).values([{tenantId:base.tenantId,shiftId:fixed,sortOrder:0,label:'Evening',startTime:'18:30:00',endTime:'21:00:00',minMinutes:30}]);
 const other=await shiftRow({startTime:'08:00:00',endTime:'17:00:00'});
 // A rotation version can only start tomorrow or later: the bundle carries it and its shift, and the lookup finds no
 // version in force on yesterday or today, exactly as the live lookup does.
 const rotated=await shiftRow({startTime:'07:00:00',endTime:'16:00:00'}),tomorrow=todayInKualaLumpur(new Date(Date.now()+86400000));
 await owner.db.insert(S.attendanceRotation).values({tenantId:base.tenantId,ruleId:rule.id,effectiveFrom:tomorrow,anchorDate:tomorrow,unit:'day',length:1,
  allowedShiftIds:[rotated],days:[{kind:'full',shiftId:rotated}],createdBy:base.adminUserId} as never);
 await owner.db.update(S.employment).set({attendanceRuleId:rule.id} as never).where(eq(S.employment.id,group.employmentId));
 await owner.db.insert(S.employmentShiftArrangement).values({tenantId:base.tenantId,employmentId:group.employmentId,shiftType:'fixed',shiftId:fixed,validFrom:'2024-01-01',validTo:null,createdBy:null});
 await owner.db.insert(S.attendanceDayAdjustment).values({tenantId:base.tenantId,employmentId:group.employmentId,attendanceDate:TODAY,shiftId:other,reason:'Fictional dated shift',updatedBy:base.adminUserId});
 const location=await createLocation(adminCtx(base),{companyId:base.companyId,code:'CLOCKDAY',name:'Fictional clock site'});
 for(const name of ['Fictional North','Fictional Alpha','Fictional Zulu','Fictional Middle']){
  const [site]=await owner.db.insert(S.clockingLocation).values({tenantId:base.tenantId,name,lat:3,lng:101,radiusM:200,locationId:location.id}).returning({id:S.clockingLocation.id});
  await owner.db.insert(S.clockingLocationCompany).values({tenantId:base.tenantId,clockingLocationId:site.id,companyId:base.companyId});
  await owner.db.insert(S.employeeClockingLocation).values({tenantId:base.tenantId,employmentId:group.employmentId,clockingLocationId:site.id});
 }
 subjects.push(group);
},300_000);
afterAll(async()=>{try{await resetDb();}finally{await restoreOffline?.();vi.unstubAllEnvs();await closeAll();}});

describe('the own clock day from one bundled statement',()=>{
 it('answers every clock state, schedule and work location exactly as the live owners do',async()=>{
  const frozen=new Date();
  vi.useFakeTimers({toFake:['Date'],now:frozen});
  try{
   const today=todayInKualaLumpur(frozen),yesterday=todayInKualaLumpur(new Date(frozen.getTime()-86400000));
   const summaries:Record<string,unknown>={};
   for(const subject of subjects){
    await withTenant(subject.ctx,async tx=>{
     const live=await ownClockTodaySummaryTx(tx,subject.ctx,subject.employmentId);
     const liveLocations=await employeeClockingLocationLabelsTx(tx,subject.employmentId);
     const {result:bundled,sent}=await statements(()=>ownClockTodayHomeTx(tx,subject.ctx,subject.employmentId));
     same(bundled.clock,live,subject.name+' clock');
     same(bundled.workLocations,liveLocations,subject.name+' locations');
     summaries[subject.name]={clockedIn:live.clockedIn,date:live.date,dayKind:live.dayKind,workedSeconds:live.workedSeconds,shift:live.shift.code,bundledStatements:sent.length};
     const pre=await readOwnClockDayInputsTx(tx,subject.employmentId,frozen);
     for(const date of [yesterday,today]){
      same(await resolvedScheduleForTx(tx,subject.employmentId,date,pre.memo(date)),await resolvedScheduleForTx(tx,subject.employmentId,date),`${subject.name} schedule ${date}`);
      same(await clockScheduleForTx(tx,subject.employmentId,date,pre.memo(date)),await clockScheduleForTx(tx,subject.employmentId,date),`${subject.name} clock schedule ${date}`);
      same(await workedDayKindForTx(tx,subject.employmentId,date,pre.memo(date)),await workedDayKindForTx(tx,subject.employmentId,date),`${subject.name} day kind ${date}`);
     }
    },{readOnlySnapshot:true});
   }
   console.info('[home-clock-day-bundle] '+JSON.stringify(summaries));
   // Non-vacuity: the states are the ones named.
   const state=(name:string)=>summaries[name] as {clockedIn:boolean;date:string;dayKind:string;workedSeconds:number;shift:string|null};
   expect(state('not clocked in')).toMatchObject({clockedIn:false,workedSeconds:0});
   expect(state('clocked in').clockedIn).toBe(true);
   expect(state('on break')).toMatchObject({clockedIn:false});expect(state('on break').workedSeconds).toBeGreaterThan(0);
   expect(state('back from break').clockedIn).toBe(true);
   expect(state('clocked out')).toMatchObject({clockedIn:false,workedSeconds:8*3600});
   expect(state('rest day').dayKind).toBe('rest_day');
   expect(state('company holiday').dayKind).toBe('holiday');
   expect(state('offline punches').workedSeconds).toBeGreaterThan(0);
   expect(state('overnight')).toMatchObject({clockedIn:true,date:yesterday});
   expect(state('schedule group').shift).not.toBeNull();
   // Yesterday resolves through the dated arrangement's shift and today through the day adjustment's dated shift.
   const group=subjects.find(s=>s.name==='schedule group')!;
   const [arrangedDay,datedDay]=await withTenant(group.ctx,tx=>Promise.all([yesterday,today].map(date=>clockScheduleForTx(tx,group.employmentId,date))),{readOnlySnapshot:true});
   expect([arrangedDay.start,datedDay.start]).toEqual(['09:00:00','08:00:00']);
   await withTenant(group.ctx,async tx=>expect((await readOwnClockDayInputsTx(tx,group.employmentId,frozen)).memo(today)).toBeTruthy(),{readOnlySnapshot:true});
  }finally{vi.useRealTimers();}
 },120_000);
 it('returns exactly the staged Home Today card, leave presence included, with fewer statements',async()=>{
  const frozen=new Date();
  vi.useFakeTimers({toFake:['Date'],now:frozen});
  try{
   for(const subject of subjects){
    const staged=await statements(()=>stagedHomeToday(subject.ctx,subject.employmentId));
    const bundled=await statements(()=>readEmployeeHomeToday(subject.ctx,subject.employmentId));
    same(bundled.result,staged.result,subject.name);
    console.info('[home-today-bundle] '+JSON.stringify({subject:subject.name,stagedStatements:staged.sent.length,bundledStatements:bundled.sent.length}));
    expect(bundled.sent.length).toBeLessThan(staged.sent.length);
    expect(bundled.sent.filter(text=>/from "attendance"|"attendance_punch"|"roster_assignment"|"attendance_rule"|"employee_clocking_location"/.test(text))).toEqual([]);
    // The holiday calendar, replacement days and leave presence ride in the clock day statement (core/calendar-window-inputs.ts).
    expect(bundled.sent.filter(text=>/"holiday"|"employment_holiday_calendar"|"replacement_holiday"|leave_calendar_presence/.test(text)
     &&!text.includes('app.home_own_clock_day'))).toEqual([]);
    // Under withStagedHomeReads the bundled clock day keeps those owners' own reads, to the same card.
    const unbundled=await statements(()=>withStagedHomeReads(()=>readEmployeeHomeToday(subject.ctx,subject.employmentId)));
    same(unbundled.result,staged.result,subject.name+' staged calendar');
    expect(bundled.sent.length).toBeLessThan(unbundled.sent.length);
   }
   const leave=await readEmployeeHomeToday(subjects.find(s=>s.name==='on leave')!.ctx,subjects.find(s=>s.name==='on leave')!.employmentId);
   expect(leave.leavePresence).toBe('full_day');
   const group=subjects.find(s=>s.name==='schedule group')!;
   expect((await readEmployeeHomeToday(group.ctx,group.employmentId)).workLocations).toEqual({total:4,names:['Fictional Alpha','Fictional Middle','Fictional North']});
  }finally{vi.useRealTimers();}
 },120_000);
 it('reads nothing for a foreign employment and answers only under the caller\'s own row security',async()=>{
  const [own,foreign]=[subjects[0],subjects.find(s=>s.name==='clocked in')!];
  await withTenant(own.ctx,async tx=>{
   await expect(ownClockTodayHomeTx(tx,own.ctx,foreign.employmentId)).rejects.toThrow();
  },{readOnlySnapshot:true});
  // The function itself is SECURITY INVOKER: called directly for another employee's employment it returns only
  // what the caller's RLS shows, which for an ordinary employee is none of that employee's rows.
  await withTenant(own.ctx,async tx=>{
   const pre=await readOwnClockDayInputsTx(tx,foreign.employmentId,new Date());
   expect({openDay:pre.openDay,days:pre.days,punches:pre.punches}).toEqual({openDay:null,days:[],punches:[]});
   expect({employment:pre.calendar?.employment,presence:pre.calendar?.presence}).toEqual({employment:null,presence:{approved:[],pending:[]}});
  },{readOnlySnapshot:true});
 });
});
