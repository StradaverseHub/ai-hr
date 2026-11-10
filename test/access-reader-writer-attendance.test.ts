/**
 * Reader/writer Access lock, attendance, roster, holiday and leave wave. Real PostgreSQL through the
 * repository harness; each case holds real transactions open on separate connections.
 *
 * Strict mode is on for every application session in this file: the connection carries
 * app.access_lock_strict, so a trigger refuses (AL001) a write made without the Access mode it needs, and
 * AIHR_ACCESS_LOCK_STRICT refuses a shared holder that asks for the exclusive lock. Owner connections, used
 * for fixtures and lock holders, are not strict.
 *
 * For every site moved to the shared lock here:
 *  - it completes while another writer holds the shared lock, so it does not take the exclusive lock;
 *  - an access editor holding the exclusive lock keeps it out until the editor commits;
 *  - two writers for the same employee serialise, with no lock refusal and a consistent result;
 *  - two writers for different employees both commit.
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
vi.hoisted(()=>{
 const url=new URL(process.env.DATABASE_URL!);
 url.searchParams.set('app.access_lock_strict','on');
 process.env.DATABASE_URL=url.toString();
 process.env.AIHR_ACCESS_LOCK_STRICT='on';
});
import {and,eq,sql as dsql} from 'drizzle-orm';
import postgres from 'postgres';
import {randomUUID} from 'node:crypto';
import {withTenant} from '../db/client';
import * as schema from '../db/schema';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {hireEmployee} from '../core/org';
import {ensureStandardRule} from '../core/attendance-rule';
import {saveScheduleGroupControl} from '../core/schedule-group-controls';
import {assignEmployeeShift,assignShift,assignShiftBulk,clearRoster,createShift,setEmploymentScheduleGroup,setRestDay} from '../core/roster';
import {assignEmployeeShiftDated,removeShiftArrangement} from '../core/shift-arrangement';
import {reconcileReplacementHolidays} from '../core/holiday-replacements';
import {saveEmploymentHolidayCalendarAssignment} from '../core/holiday-calendar-assignment';
import {reprojectEntitlementForEmployment} from '../core/leave';
import {decideAttendanceCorrection,lockAttendanceClockDependenciesTx,requestAttendanceCorrection} from '../core/attendance';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {configureAttendanceSubmissionFixtures,restoreHistoricalAttendanceSubmission} from './helpers/attendance-submission-fixture';
import {todayInKualaLumpur} from '../lib/hr-date';

const barrier=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const lockKey=(tenantId:string)=>`hashtextextended('access-configuration:${tenantId}',0)`;
const addDays=(date:string,n:number)=>new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
async function settled<T>(promise:Promise<T>,ms=4000):Promise<'timeout'|{value:T}>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise.then(value=>({value})),new Promise<'timeout'>(resolve=>{timer=setTimeout(()=>resolve('timeout'),ms);})]);}
 finally{if(timer)clearTimeout(timer);}
}
const sqlState=(reason:unknown)=>{
 let current=reason as {code?:unknown;cause?:unknown}|undefined;
 for(let depth=0;current&&depth<6;depth++){if(typeof current.code==='string')return current.code;current=current.cause as typeof current;}
 return undefined;
};
/** A refusal that comes from locking rather than from the business rule: bound reached, deadlock, strict mode. */
const lockRefusals=(results:PromiseSettledResult<unknown>[])=>results
 .filter((result):result is PromiseRejectedResult=>result.status==='rejected')
 .map(result=>`${sqlState(result.reason)}|${result.reason?.name}|${result.reason?.message}`)
 .filter(reason=>/55P03|40P01|40001|AL001|strict mode|Leave source is unavailable|busy/i.test(reason));

let b:Base;
let raw:postgres.Sql;
beforeAll(async()=>{await migrateTestDb();raw=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:8,onnotice:()=>{}});});
beforeEach(async()=>{await resetDb();b=await seedBase();});
afterAll(async()=>{await raw.end({timeout:5});await closeAll();});

/** Another transaction holding the Access lock in the given mode until the returned release is called. */
async function holdAccess(mode:'shared'|'exclusive'){
 const held=barrier(),release=barrier();
 const holder=raw.begin(async tx=>{
  await tx.unsafe(`select ${mode==='shared'?'pg_advisory_xact_lock_shared':'pg_advisory_xact_lock'}(${lockKey(b.tenantId)})`);
  held.resolve();await release.promise;
 });
 await held.promise;
 return async()=>{release.resolve();await holder;};
}
/** Completes beside a shared holder: the site takes the shared lock, never the exclusive one. */
async function completesBesideSharedHolder(run:()=>Promise<unknown>){
 const release=await holdAccess('shared');
 try{await expect(settled(run(),30000)).resolves.not.toBe('timeout');}
 finally{await release();}
}
/** Waits while an access editor holds the exclusive lock, then completes once the editor commits. */
async function waitsBehindEditor(run:()=>Promise<unknown>){
 const release=await holdAccess('exclusive');
 const writer=run();
 try{expect(await settled(writer,800)).toBe('timeout');}
 finally{await release();}
 await writer;
}
async function hire(label:string,hiredOn=todayInKualaLumpur()){
 const hired=await hireEmployee(adminCtx(b),{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn,
  person:{fullName:`Fictional wave ${label}`,primaryEmail:`wave-${label}-${randomUUID()}@example.invalid`}});
 return hired.employmentId;
}
async function scheduleFixture(){
 const ctx=adminCtx(b),rule=await ensureStandardRule(ctx);
 await saveScheduleGroupControl(ctx,{ruleId:rule.id,kind:'duty',enabled:true});
 const shift=await createShift(ctx,{name:'Fictional Wave Shift',code:`FWS${randomUUID().slice(0,4)}`,companyId:b.companyId,
  startTime:'09:00',endTime:'18:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5],ruleId:rule.id});
 return {ctx,rule,shift};
}

describe('roster cells under the shared lock',()=>{
 const date=addDays(todayInKualaLumpur(),3);
 it('assigns, rests and clears a cell beside another shared writer, and waits behind an access editor',async()=>{
  const {ctx,shift}=await scheduleFixture(),employmentId=await hire('cell');
  await completesBesideSharedHolder(()=>assignShift(ctx,{employmentId,shiftDate:date,shiftId:shift.id}));
  await completesBesideSharedHolder(()=>setRestDay(ctx,{employmentId,shiftDate:date}));
  await completesBesideSharedHolder(()=>clearRoster(ctx,{employmentId,shiftDate:date}));
  await waitsBehindEditor(()=>assignShift(ctx,{employmentId,shiftDate:date,shiftId:shift.id}));
 },90000);
 it('serialises two edits of one employee’s day into one row and two audit events',async()=>{
  const {ctx,shift}=await scheduleFixture(),employmentId=await hire('same-cell');
  const results=await Promise.allSettled([assignShift(ctx,{employmentId,shiftDate:date,shiftId:shift.id}),setRestDay(ctx,{employmentId,shiftDate:date})]);
  expect(lockRefusals(results)).toEqual([]);
  expect(results.map(result=>result.status)).toEqual(['fulfilled','fulfilled']);
  const rows=await owner.db.select().from(schema.rosterAssignment).where(and(eq(schema.rosterAssignment.employmentId,employmentId),eq(schema.rosterAssignment.shiftDate,date)));
  expect(rows).toHaveLength(1);
  const events=await owner.db.select({type:schema.domainEvent.eventType}).from(schema.domainEvent)
   .where(and(eq(schema.domainEvent.tenantId,b.tenantId),eq(schema.domainEvent.eventType,'roster.manual-changes')));
  expect(events).toHaveLength(2);
 },90000);
 it('lets two employees on the same shift be rostered at the same moment',async()=>{
  const {ctx,shift}=await scheduleFixture(),[first,second]=[await hire('cell-a'),await hire('cell-b')];
  const results=await Promise.allSettled([first,second].map(employmentId=>assignShift(ctx,{employmentId,shiftDate:date,shiftId:shift.id})));
  expect(lockRefusals(results)).toEqual([]);
  expect(results.map(result=>result.status)).toEqual(['fulfilled','fulfilled']);
 },90000);
 it('keeps a bulk batch on the exclusive lock until it runs as a chunked job',async()=>{
  const {ctx,shift}=await scheduleFixture(),employmentId=await hire('bulk');
  const release=await holdAccess('shared');
  const bulk=assignShiftBulk(ctx,{employmentIds:[employmentId],shiftDates:[date],shiftId:shift.id});
  try{expect(await settled(bulk,800)).toBe('timeout');}
  finally{await release();}
  await expect(bulk).resolves.toMatchObject({assigned:1});
 },60000);
});

describe('one employee’s schedule under the shared lock',()=>{
 it('seats a group, sets a backup shift and edits the dated ladder beside a shared writer and behind an editor',async()=>{
  const {ctx,rule,shift}=await scheduleFixture(),employmentId=await hire('ladder'),today=todayInKualaLumpur();
  await completesBesideSharedHolder(()=>setEmploymentScheduleGroup(ctx,{employmentId,attendanceRuleId:rule.id}));
  await completesBesideSharedHolder(()=>assignEmployeeShift(ctx,{employmentId,shiftType:'fixed',shiftId:shift.id}));
  await completesBesideSharedHolder(()=>assignEmployeeShiftDated(ctx,{employmentId,shiftType:'fixed',shiftId:shift.id,effectiveFrom:today}));
  await waitsBehindEditor(()=>assignEmployeeShiftDated(ctx,{employmentId,shiftType:'roster',shiftId:shift.id,effectiveFrom:addDays(today,1)}));
  const [newest]=await owner.db.select().from(schema.employmentShiftArrangement).where(and(eq(schema.employmentShiftArrangement.employmentId,employmentId),eq(schema.employmentShiftArrangement.validFrom,addDays(today,1))));
  await completesBesideSharedHolder(()=>removeShiftArrangement(ctx,{employmentId,arrangementId:newest.id}));
  const [row]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,employmentId));
  expect(row).toMatchObject({attendanceRuleId:rule.id,defaultShiftId:shift.id});
 },120000);
 it('serialises a group change and a backup-shift change for one employee, keeping both',async()=>{
  const {ctx,rule,shift}=await scheduleFixture(),employmentId=await hire('both');
  const results=await Promise.allSettled([
   setEmploymentScheduleGroup(ctx,{employmentId,attendanceRuleId:rule.id}),
   assignEmployeeShift(ctx,{employmentId,shiftType:'fixed',shiftId:shift.id}),
  ]);
  expect(lockRefusals(results)).toEqual([]);
  expect(results.map(result=>result.status)).toEqual(['fulfilled','fulfilled']);
  const [row]=await owner.db.select().from(schema.employment).where(eq(schema.employment.id,employmentId));
  expect(row).toMatchObject({attendanceRuleId:rule.id,defaultShiftId:shift.id,shiftType:'fixed'});
 },90000);
 it('lets two employees’ ladders change at the same moment',async()=>{
  const {ctx,shift}=await scheduleFixture(),today=todayInKualaLumpur(),[first,second]=[await hire('ladder-a'),await hire('ladder-b')];
  const results=await Promise.allSettled([first,second].map(employmentId=>assignEmployeeShiftDated(ctx,{employmentId,shiftType:'fixed',shiftId:shift.id,effectiveFrom:today})));
  expect(lockRefusals(results)).toEqual([]);
  expect(results.map(result=>result.status)).toEqual(['fulfilled','fulfilled']);
 },90000);
});

describe('holiday calendars and replacement holidays under the shared lock',()=>{
 beforeEach(async()=>{
  await setModule(b.tenantId,'attendance','active');await setModule(b.tenantId,'payroll','active');
  await owner.db.update(schema.company).set({defaultWorkState:'Selangor'}).where(eq(schema.company.id,b.companyId));
 });
 const assign=(employmentId:string,state:string)=>saveEmploymentHolidayCalendarAssignment(adminCtx(b),{employmentId,startDate:addDays(todayInKualaLumpur(),1),endDate:null,selection:{kind:'state',state}});
 it('assigns a calendar and reconciles replacements beside a shared writer and behind an editor',async()=>{
  const employmentId=await hire('calendar',addDays(todayInKualaLumpur(),-400));
  await completesBesideSharedHolder(()=>assign(employmentId,'Johor'));
  await completesBesideSharedHolder(()=>reconcileReplacementHolidays(adminCtx(b),employmentId));
  await waitsBehindEditor(()=>reconcileReplacementHolidays(adminCtx(b),employmentId));
 },90000);
 it('serialises two reconciliations of one employee and lets two employees’ calendars change together',async()=>{
  const [first,second]=[await hire('calendar-a',addDays(todayInKualaLumpur(),-400)),await hire('calendar-b',addDays(todayInKualaLumpur(),-400))];
  const same=await Promise.allSettled([reconcileReplacementHolidays(adminCtx(b),first),reconcileReplacementHolidays(adminCtx(b),first)]);
  expect(lockRefusals(same)).toEqual([]);
  expect(same.map(result=>result.status)).toEqual(['fulfilled','fulfilled']);
  const both=await Promise.allSettled([assign(first,'Johor'),assign(second,'Johor')]);
  expect(lockRefusals(both)).toEqual([]);
  expect(both.map(result=>result.status)).toEqual(['fulfilled','fulfilled']);
 },90000);
});

describe('entitlement reprojection for one employment under the shared lock',()=>{
 const reproject=(employmentId:string)=>reprojectEntitlementForEmployment(adminCtx(b),{employmentId,trigger:'grade'});
 it('completes beside a shared writer, waits behind an editor, and serialises or overlaps by employee',async()=>{
  const [first,second]=[await hire('reproject-a'),await hire('reproject-b')];
  await completesBesideSharedHolder(()=>reproject(first));
  await waitsBehindEditor(()=>reproject(first));
  const same=await Promise.allSettled([reproject(first),reproject(first)]);
  expect(lockRefusals(same)).toEqual([]);
  expect(same.map(result=>result.status)).toEqual(['fulfilled','fulfilled']);
  const both=await Promise.allSettled([reproject(first),reproject(second)]);
  expect(both.map(result=>result.status)).toEqual(['fulfilled','fulfilled']);
 },90000);
});

describe('attendance corrections in a caller’s transaction and the fallback rejection course',()=>{
 beforeEach(async()=>{await setModule(b.tenantId,'attendance','active');});
 /** A pending overtime-bearing request, restored as a historical row so no routing fixture is involved. */
 const pendingOvertime=async(employmentId:string,date:string)=>(await restoreHistoricalAttendanceSubmission(b,{
  employmentId,attendanceDate:date,status:'pending',requestKind:'other',proposedCheckIn:'09:00',proposedCheckOut:'18:00',
  requestedOtMinutes:60,reason:'Fictional overtime claim',
  originalClockSnapshot:{version:1,attendanceId:null,originalCheckIn:null,originalCheckOut:null,capturedAt:new Date().toISOString()},
 })).id;
 const reject=(correctionId:string,tx?:Parameters<typeof decideAttendanceCorrection>[2])=>decideAttendanceCorrection(adminCtx(b),
  {correctionId,decision:'rejected',rejectReason:'Fictional refusal'},tx);
 it('files and decides inside a caller-owned transaction on the shared lock',async()=>{
  await configureAttendanceSubmissionFixtures(b);
  const employmentId=await hire('caller-tx','2020-01-01'),ctx=adminCtx(b);
  let correctionId='';
  await completesBesideSharedHolder(async()=>{correctionId=(await withTenant(ctx,tx=>requestAttendanceCorrection(ctx,
   {employmentId,date:'2026-06-03',checkIn:'09:00',checkOut:'18:00',reason:'Fictional caller-owned request'},tx))).correctionId;});
  await completesBesideSharedHolder(()=>withTenant(ctx,tx=>reject(correctionId,tx)));
  const [row]=await owner.db.select({status:schema.attendanceCorrection.status}).from(schema.attendanceCorrection).where(eq(schema.attendanceCorrection.id,correctionId));
  expect(row.status).toBe('rejected');
 },90000);
 it('rejects an overtime request beside a shared writer, behind an editor, and only once when two deciders race',async()=>{
  const employmentId=await hire('reject','2020-01-01');
  const [first,second,third]=[await pendingOvertime(employmentId,'2026-06-03'),await pendingOvertime(employmentId,'2026-06-04'),await pendingOvertime(employmentId,'2026-06-05')];
  await completesBesideSharedHolder(()=>reject(first));
  await waitsBehindEditor(()=>reject(second));
  const results=await Promise.allSettled([reject(third),reject(third)]);
  expect(lockRefusals(results)).toEqual([]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  const events=await owner.db.select().from(schema.domainEvent).where(and(eq(schema.domainEvent.aggregateId,third),eq(schema.domainEvent.eventType,'attendance-correction.rejected')));
  expect(events).toHaveLength(1);
 },120000);
});

describe('clock dependencies never upgrade a shared holder',()=>{
 it('keeps the shared mode when the replacement leave type is missing and the caller already shares',async()=>{
  const employmentId=await hire('no-upgrade');
  // No entitlement snapshot: the TOIL gate cannot rule the replacement type out, so only the held mode decides.
  const ctx={...adminCtx(b),entitlements:undefined};
  const mode=await withTenant(ctx,async tx=>{
   await lockAccessConfigurationTx(tx,b.tenantId);
   await lockAttendanceClockDependenciesTx(tx,ctx,[employmentId]);
   const [row]=await tx.execute<{mode:string}>(dsql`select app.access_lock_mode_held(${b.tenantId}::uuid) as mode`);return row.mode;
  });
  expect(mode).toBe('S');
 },30000);
});
