/** Attendance punch readers over accepted offline punches (draft 0647): the true instant coalesce(effective_at,
 * server_recorded_at) orders and times every reader, HR raw clock data exposes both instants, and an employee
 * cannot remove an offline punch. The same readers first run on a database WITHOUT the draft's column. */
import {randomUUID} from 'node:crypto';
import {and,asc,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as S from '../db/schema';
import {hireEmployee} from '../core/org';
import {withAttendanceTenant} from '../core/module-gate';
import {attendanceClockData,captureEmployeeClock,captureOfflineClockTx,ownClockCaptures,ownClockToday,ownClockTodaySummary,requestOwnClockRemoval,
 setAttendancePolicy,type OfflineClockCommand} from '../packs/attendance/service';
import {recordedPolicyClockSourceTx} from '../packs/attendance/policy-clock-input';
import {clockCommandContext} from '../lib/clock-command-context';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {installOfflineDraftForWorker} from './helpers/mobile-offline-draft';
let base:Base;
beforeAll(migrateTestDb);
beforeEach(async()=>{vi.stubEnv('AIHR_MOBILE_CLOCK_POLICY','');await resetDb();base=await seedBase();
 await setAttendancePolicy(adminCtx(base),{companyId:base.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:15',halfDayBefore:'13:00',workingDays:[1,2,3,4,5]});});
afterAll(async()=>{try{await resetDb();}finally{vi.unstubAllEnvs();await closeAll();}});
async function employee(){
 const e=await hireEmployee(adminCtx(base),{person:{fullName:'Offline reader employee',primaryEmail:randomUUID()+'@readers.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'}),userId=await createAppUser(base.tenantId,e.personId,'employee');
 const ctx:SessionContext={tenantId:base.tenantId,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}],entitlements:harnessSnapshot(base.tenantId)};
 return {employmentId:e.employmentId,ctx};
}
/** `n` ascending whole-second instants of today's MYT day, each at least a second before now, derived from the clock. */
function instants(n:number){
 const now=Math.floor(Date.now()/1000)*1000-1000,midnight=Date.parse(todayInKualaLumpur(new Date(now))+'T00:00:00+08:00');
 const step=Math.max(1000,Math.min(120000,Math.floor((now-midnight)/(n+1)/1000)*1000));
 return Array.from({length:n},(_,i)=>now-(n-i)*step);
}
const command=(employmentId:string,action:'in'|'out',at:number):OfflineClockCommand=>
 ({employmentId,requestId:randomUUID(),action,lat:3,lng:101,accuracy:5,effectiveAt:new Date(at),claimDigest:randomUUID().replace(/-/g,'').padEnd(64,'0')});
const online=(ctx:SessionContext,employmentId:string,action:'in'|'out')=>
 captureEmployeeClock(ctx,{action,requestId:randomUUID(),lat:3,lng:101,accuracy:5,employmentId,clockContext:clockCommandContext(ctx.tenantId,ctx.userId,employmentId)});
const effectiveColumn=async()=>{const [row]=await owner.db.execute<{present:boolean}>(sql`select exists(select 1 from pg_attribute where attrelid='attendance_clock_capture'::regclass and attname='effective_at' and not attisdropped) present`);return row.present;};
/** Received (server) instants by capture, read as the owner. */
const received=async(employmentId:string)=>new Map((await owner.db.select({id:S.attendanceClockCapture.id,at:S.attendanceClockCapture.serverRecordedAt}).from(S.attendanceClockCapture)
 .where(eq(S.attendanceClockCapture.employmentId,employmentId)).orderBy(asc(S.attendanceClockCapture.serverRecordedAt),asc(S.attendanceClockCapture.id))).map(row=>[row.id,row.at]));
/** The canonical policy clock source over the day's stored punches, as HR reads it. */
async function policySource(employmentId:string,date:string){
 const [day]=await owner.db.select({id:S.attendance.id}).from(S.attendance).where(and(eq(S.attendance.employmentId,employmentId),eq(S.attendance.attendanceDate,date)));
 const punches=await owner.db.select().from(S.attendancePunch).where(eq(S.attendancePunch.attendanceId,day.id)).orderBy(asc(S.attendancePunch.punchAt),asc(S.attendancePunch.id));
 const hr=adminCtx(base);
 return withTenant(hr,tx=>recordedPolicyClockSourceTx(tx,hr,{attendanceId:day.id,employmentId,date,punches}));
}

// Re-pinned 29 October 2026: 0647 is journaled for the staging release, so no worker lacks effective_at any more. The
// invariant kept: an online punch is read by its server instant, with effective_at NULL.
describe('attendance punch readers over online punches (effective_at NULL)',()=>{
 it('read online punches by their server instant, with no effective instant',async()=>{
  expect(await effectiveColumn()).toBe(true);
  const {employmentId,ctx}=await employee();await online(ctx,employmentId,'in');
  // punch_at is whole seconds and punch readers break ties by random id: the out must land in a later second.
  await new Promise(resolve=>setTimeout(resolve,1100));await online(ctx,employmentId,'out');
  const date=todayInKualaLumpur(),times=[...(await received(employmentId)).values()];expect(times).toHaveLength(2);
  const live=await ownClockToday(ctx,undefined,employmentId);
  expect(live.captures.map(c=>[c.direction,c.recordedAt,c.removalBlocked])).toEqual([['in',times[0].toISOString(),false],['out',times[1].toISOString(),false]]);
  expect(live).toMatchObject({clockedIn:false,workedSeconds:Math.floor((times[1].getTime()-times[0].getTime())/1000)});
  expect((await ownClockTodaySummary(ctx,employmentId)).clockedIn).toBe(false);
  expect((await ownClockCaptures(ctx,employmentId,date)).map(c=>[c.direction,c.recordedAt.toISOString()])).toEqual([['out',times[1].toISOString()],['in',times[0].toISOString()]]);
  expect((await attendanceClockData(adminCtx(base),employmentId,date)).rows.map(r=>[r.direction,r.method,r.clockSource,r.effectiveAt,r.receivedAt]))
   .toEqual([['in','web','online',null,null],['out','web','online',null,null]]);
  const source=await policySource(employmentId,date),midnight=Date.parse(date+'T00:00:00+08:00');
  expect(source.state==='known'?source.clocks.map(c=>[c.direction,c.atMilliseconds]):source).toEqual([['in',times[0].getTime()-midnight],['out',times[1].getTime()-midnight]]);
 });
});

describe('attendance punch readers over accepted offline punches (draft 0647)',()=>{
 let restore:(()=>Promise<void>)|undefined;
 beforeAll(async()=>{restore=await installOfflineDraftForWorker();});
 afterAll(async()=>{try{await resetDb();}finally{await restore?.();}});
 it('order, time and attribute offline punches by their effective instant, never by their later arrival',async()=>{
  expect(await effectiveColumn()).toBe(true);
  const {employmentId,ctx}=await employee(),[inAt,outAt]=instants(2),date=todayInKualaLumpur(new Date(inAt));
  expect(todayInKualaLumpur(new Date(outAt))).toBe(date);
  const written=await withAttendanceTenant(ctx,async tx=>[await captureOfflineClockTx(tx,ctx,command(employmentId,'in',inAt)),await captureOfflineClockTx(tx,ctx,command(employmentId,'out',outAt))]);
  expect(written.map(row=>row.kind)).toEqual(['recorded','recorded']);
  const ids=written.map(row=>row.kind==='recorded'?row.captureId:''),arrivals=await received(employmentId);
  // Non-vacuous: every arrival is later than its effective instant, so a server_recorded_at reader answers differently.
  expect(ids.map((id,i)=>arrivals.get(id)!.getTime()>[inAt,outAt][i])).toEqual([true,true]);
  const live=await ownClockToday(ctx,undefined,employmentId);
  expect(live.captures.map(c=>[c.id,c.direction,c.recordedAt,c.removalBlocked])).toEqual([[ids[0],'in',new Date(inAt).toISOString(),true],[ids[1],'out',new Date(outAt).toISOString(),true]]);
  expect(live).toMatchObject({clockedIn:false,openSince:null,workedSeconds:(outAt-inAt)/1000});
  expect(await ownClockTodaySummary(ctx,employmentId)).toMatchObject({date,clockedIn:false,workedSeconds:(outAt-inAt)/1000});
  expect((await ownClockCaptures(ctx,employmentId,date)).map(c=>[c.id,c.recordedAt.getTime()])).toEqual([[ids[1],outAt],[ids[0],inAt]]);
  expect((await attendanceClockData(adminCtx(base),employmentId,date)).rows.map(r=>[r.captureId,r.direction,r.method,r.clockSource,r.effectiveAt,r.receivedAt])).toEqual([
   [ids[0],'in','mobile_offline','offline',new Date(inAt).toISOString(),arrivals.get(ids[0])!.toISOString()],
   [ids[1],'out','mobile_offline','offline',new Date(outAt).toISOString(),arrivals.get(ids[1])!.toISOString()]]);
  // The policy source corroborates punch_at against the effective instant; the arrival instant's label would mismatch.
  const source=await policySource(employmentId,date),midnight=Date.parse(date+'T00:00:00+08:00');
  expect(source.state==='known'?source.clocks.map(c=>[c.captureId,c.direction,c.atMilliseconds,c.recordedAt]):source).toEqual([
   [ids[0],'in',inAt-midnight,new Date(inAt).toISOString()],[ids[1],'out',outAt-midnight,new Date(outAt).toISOString()]]);
 });
 it('reads an online punch beside the draft as online, with no effective or received instant',async()=>{
  const {employmentId,ctx}=await employee();await online(ctx,employmentId,'in');
  const [at]=[...(await received(employmentId)).values()],date=todayInKualaLumpur();
  expect((await ownClockToday(ctx,undefined,employmentId)).captures.map(c=>[c.recordedAt,c.removalBlocked])).toEqual([[at.toISOString(),false]]);
  expect((await attendanceClockData(adminCtx(base),employmentId,date)).rows.map(r=>[r.method,r.clockSource,r.effectiveAt,r.receivedAt])).toEqual([['web','online',null,null]]);
 });
 it('refuses an employee\'s own removal of an offline punch, while the same removal of an online punch is accepted',async()=>{
  const offlineWorker=await employee(),onlineWorker=await employee(),[at]=instants(1);
  expect((await withAttendanceTenant(offlineWorker.ctx,tx=>captureOfflineClockTx(tx,offlineWorker.ctx,command(offlineWorker.employmentId,'in',at)))).kind).toBe('recorded');
  await online(onlineWorker.ctx,onlineWorker.employmentId,'in');
  const removal=async({employmentId,ctx}:Awaited<ReturnType<typeof employee>>)=>{
   const live=await ownClockToday(ctx,undefined,employmentId);expect(live.captures).toHaveLength(1);
   return {blocked:live.captures[0].removalBlocked,result:await requestOwnClockRemoval(ctx,{employmentId,punchId:live.captures[0].punchId!,requestId:randomUUID(),
    baseline:live.removalBaseline,clockContext:live.clockContext,reason:'Fictional accidental clock'}).then(()=>'requested',(error:Error)=>error.message)};
  };
  expect(await removal(offlineWorker)).toEqual({blocked:true,result:'This active Web Clocking record is not available for removal.'});
  expect(await removal(onlineWorker)).toEqual({blocked:false,result:'requested'});
  const corrections=await owner.db.select({employmentId:S.attendanceCorrection.employmentId,status:S.attendanceCorrection.status}).from(S.attendanceCorrection)
   .where(eq(S.attendanceCorrection.tenantId,base.tenantId)).orderBy(asc(S.attendanceCorrection.employmentId));
  expect(corrections).toEqual([{employmentId:onlineWorker.employmentId,status:'pending'}]);
  // The offline punch stays active evidence; HR's correction path is the way to change it.
  const [punch]=await owner.db.select({method:S.attendancePunch.method,voidedAt:S.attendancePunch.voidedAt}).from(S.attendancePunch).where(eq(S.attendancePunch.employmentId,offlineWorker.employmentId));
  expect(punch).toEqual({method:'mobile_offline',voidedAt:null});
 });
});
