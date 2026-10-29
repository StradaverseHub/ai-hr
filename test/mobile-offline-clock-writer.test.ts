/** Canonical offline attendance writer on draft 0647: provenance, effective-instant ordering, typed refusals with no
 * write, the punch guard and capture CHECK backstops, and the unchanged online writer. Actual SQL, RLS and triggers. */
import {createHash,randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext,Tx} from '../db/client';
import * as S from '../db/schema';
import {hireEmployee} from '../core/org';
import {createShift} from '../core/roster';
import {withAttendanceTenant} from '../core/module-gate';
import {captureEmployeeClock,captureOfflineClockTx,checkInTx,planOfflineClockTx,setAttendancePolicy,type OfflineClockCommand} from '../packs/attendance/service';
import {clockCommandContext} from '../lib/clock-command-context';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,owner,resetDb,seedBase,type Base} from './harness';
import {installOfflineDraftForWorker} from './helpers/mobile-offline-draft';
// Delegates to the real audit writer; one test turns it into a JS-level failure AFTER the capture and punch writes.
const audit=vi.hoisted(()=>({fail:false}));
vi.mock('../db/events',async original=>{
 const actual=await original<typeof import('../db/events')>();
 return {...actual,appendEvent:async(...args:Parameters<typeof actual.appendEvent>)=>{if(audit.fail&&args[1].eventType==='attendance.clock.captured')throw new Error('synthetic audit failure');return actual.appendEvent(...args);}};
});
let base:Base,restore:(()=>Promise<void>)|undefined;
beforeAll(async()=>{restore=await installOfflineDraftForWorker();});
beforeEach(async()=>{audit.fail=false;vi.stubEnv('AIHR_MOBILE_CLOCK_POLICY','');await resetDb();base=await seedBase();
 await setAttendancePolicy(adminCtx(base),{companyId:base.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:15',halfDayBefore:'13:00',workingDays:[1,2,3,4,5]});});
afterAll(async()=>{try{await resetDb();await restore?.();}finally{vi.unstubAllEnvs();await closeAll();}});
async function employee(){
 const e=await hireEmployee(adminCtx(base),{person:{fullName:'Offline writer employee',primaryEmail:randomUUID()+'@writer.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'}),userId=await createAppUser(base.tenantId,e.personId,'employee');
 const ctx:SessionContext={tenantId:base.tenantId,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}],entitlements:harnessSnapshot(base.tenantId)};
 return {employmentId:e.employmentId,ctx};
}
/** A whole-second instant `ago` ms before now, from the clock; MYT days and wall times below derive from it. */
const second=(ago:number)=>Math.floor(Date.now()/1000)*1000-ago;
const myt=(at:number)=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(at));
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const command=(employmentId:string,action:'in'|'out',at:number,extra:Partial<OfflineClockCommand>={}):OfflineClockCommand=>
 ({employmentId,requestId:randomUUID(),action,lat:3,lng:101,accuracy:5,effectiveAt:new Date(at),claimDigest:sha(randomUUID()),...extra});
// `string`, as ClockIntent.requestId is: a bare default would infer randomUUID()'s template type and refuse a command's ID.
const online=(ctx:SessionContext,employmentId:string,action:'in'|'out',requestId:string=randomUUID())=>
 captureEmployeeClock(ctx,{action,requestId,lat:3,lng:101,accuracy:5,employmentId,clockContext:clockCommandContext(ctx.tenantId,ctx.userId,employmentId)});
type PunchRow={direction:string;method:string;date:string;time:string;effectiveMs:string|null;later:boolean|null;digest:string|null};
/** The subject's punches with their captures' provenance, read as the owner (outside RLS). */
const punches=(employmentId:string)=>owner.db.execute<PunchRow>(sql`select p.direction::text direction,p.method::text method,p.attendance_date::text date,p.punch_at::text "time",
 (extract(epoch from c.effective_at)*1000)::bigint::text "effectiveMs",c.server_recorded_at>c.effective_at later,c.command_digest digest
 from attendance_punch p left join attendance_clock_capture c on c.id=p.clock_capture_id where p.employment_id=${employmentId}::uuid order by p.direction,p.punch_at,p.id`).then(rows=>[...rows]);
const counts=async(employmentId:string)=>{const [row]=await owner.db.execute<{captures:number;punches:number;days:number;events:number}>(sql`select
 (select count(*) from attendance_clock_capture where employment_id=${employmentId}::uuid)::int captures,(select count(*) from attendance_punch where employment_id=${employmentId}::uuid)::int punches,
 (select count(*) from attendance where employment_id=${employmentId}::uuid)::int days,
 (select count(*) from domain_event where event_type='attendance.clock.captured' and subject_employment_id=${employmentId}::uuid)::int events`);return {...row};};
/** Rows the caller's own transaction sees for this subject, so "writes nothing" also covers uncommitted work. */
const visible=async(tx:Tx,employmentId:string)=>({captures:(await tx.select({id:S.attendanceClockCapture.id}).from(S.attendanceClockCapture).where(eq(S.attendanceClockCapture.employmentId,employmentId))).length,
 punches:(await tx.select({id:S.attendancePunch.id}).from(S.attendancePunch).where(eq(S.attendancePunch.employmentId,employmentId))).length,
 days:(await tx.select({id:S.attendance.id}).from(S.attendance).where(eq(S.attendance.employmentId,employmentId))).length});
/** drizzle wraps driver errors; the database's own message is the cause. */
const failure=(work:Promise<unknown>)=>work.then(()=>'resolved',(error:{message?:string;cause?:{message?:string}})=>[error?.message,error?.cause?.message].join(' | '));
describe('canonical offline attendance writer',()=>{
 it('records an offline in/out as mobile_offline with the exact effective instant, past the online 120 s fresh-sample rule',async()=>{
  const {employmentId,ctx}=await employee(),inAt=second(600000),outAt=second(300000),first=command(employmentId,'in',inAt),last=command(employmentId,'out',outAt);
  const written=await withAttendanceTenant(ctx,async tx=>[await captureOfflineClockTx(tx,ctx,first),await captureOfflineClockTx(tx,ctx,last)]);
  expect(written.map(row=>row.kind)).toEqual(['recorded','recorded']);
  expect(written.map(row=>row.kind==='recorded'?[row.effectiveAt,row.date]:null)).toEqual([[inAt,todayInKualaLumpur(new Date(inAt))],[outAt,todayInKualaLumpur(new Date(outAt))]]);
  expect(await punches(employmentId)).toEqual([
   {direction:'in',method:'mobile_offline',date:todayInKualaLumpur(new Date(inAt)),time:myt(inAt),effectiveMs:String(inAt),later:true,digest:sha(JSON.stringify(['mobile_offline',first.claimDigest]))},
   {direction:'out',method:'mobile_offline',date:todayInKualaLumpur(new Date(outAt)),time:myt(outAt),effectiveMs:String(outAt),later:true,digest:sha(JSON.stringify(['mobile_offline',last.claimDigest]))}]);
  const [day]=await owner.db.select({checkInMethod:S.attendance.checkInMethod}).from(S.attendance).where(and(eq(S.attendance.employmentId,employmentId),eq(S.attendance.attendanceDate,todayInKualaLumpur(new Date(inAt)))));
  expect(day.checkInMethod).toBe('mobile_offline');
  const events=await owner.db.execute<{payload:Record<string,unknown>}>(sql`select payload from domain_event where event_type='attendance.clock.captured' and subject_employment_id=${employmentId}::uuid order by payload->>'effectiveAt'`);
  expect([...events].map(row=>[row.payload.clientSource,row.payload.effectiveAt,row.payload.direction])).toEqual([['mobile_offline',new Date(inAt).toISOString(),'in'],['mobile_offline',new Date(outAt).toISOString(),'out']]);
 });
 it('files an overnight offline out on the open session start day, with punch_at the instant\'s own wall time',async()=>{
  const {employmentId,ctx}=await employee(),outAt=second(60000),start=todayInKualaLumpur(new Date(outAt-86400000));
  const shift=await createShift(adminCtx(base),{name:'Offline writer night',code:'OFFLINE_WRITER_NIGHT',startTime:'22:00',endTime:'06:00'});
  await owner.db.insert(S.rosterAssignment).values({tenantId:base.tenantId,employmentId,shiftDate:start,shiftId:shift.id});
  // HR opens the session (an authorised admin method): the capture guard refuses an employee's own uncaptured punch.
  const hr=adminCtx(base);await withAttendanceTenant(hr,tx=>checkInTx(hr,{employmentId,date:start,time:'22:00:00',geo:{lat:3,lng:101,accuracy:5}},tx));
  expect(start).not.toBe(todayInKualaLumpur(new Date(outAt)));
  const written=await withAttendanceTenant(ctx,tx=>captureOfflineClockTx(tx,ctx,command(employmentId,'out',outAt)));
  expect(written).toMatchObject({kind:'recorded',date:start,effectiveAt:outAt});
  expect((await punches(employmentId)).map(row=>[row.direction,row.method,row.date,row.time,row.effectiveMs])).toEqual([['in','web',start,'22:00:00',null],['out','mobile_offline',start,myt(outAt),String(outAt)]]);
  const [row]=await owner.db.execute<{exact:boolean}>(sql`select timezone('Asia/Kuala_Lumpur',attendance_date+1+punch_at)=${new Date(outAt).toISOString()}::timestamptz exact from attendance_punch where method::text='mobile_offline'`);
  expect(row.exact).toBe(true);
 });
 it('conflicts an online replay of an offline request ID, and refuses an offline retry of it, writing nothing more',async()=>{
  const {employmentId,ctx}=await employee(),offline=command(employmentId,'in',second(60000));
  expect((await withAttendanceTenant(ctx,tx=>captureOfflineClockTx(tx,ctx,offline))).kind).toBe('recorded');const recorded=await counts(employmentId);
  expect(recorded).toEqual({captures:1,punches:1,days:1,events:1});
  await expect(online(ctx,employmentId,'in',offline.requestId)).rejects.toThrow('This request already recorded a different clock action');
  expect(await withAttendanceTenant(ctx,tx=>captureOfflineClockTx(tx,ctx,offline))).toMatchObject({kind:'refused',reason:'clock_conflict'});
  expect(await counts(employmentId)).toEqual(recorded);expect((await punches(employmentId)).map(row=>row.method)).toEqual(['mobile_offline']);
 });
 it('guards punch provenance in the database: mobile_offline needs its effective capture, web needs an online one',async()=>{
  const {employmentId,ctx}=await employee(),at=second(60000);
  await withAttendanceTenant(ctx,tx=>captureOfflineClockTx(tx,ctx,command(employmentId,'in',at)));
  const [day]=await owner.db.select({id:S.attendance.id,date:S.attendance.attendanceDate}).from(S.attendance).where(eq(S.attendance.employmentId,employmentId));
  const capture=async(effective:string|null)=>{const id=randomUUID();await owner.db.execute(sql`insert into attendance_clock_capture(id,tenant_id,employment_id,attendance_date,direction,request_id,server_recorded_at,command_digest,effective_at)
   values(${id}::uuid,${base.tenantId}::uuid,${employmentId}::uuid,${day.date}::date,'out',${randomUUID()}::uuid,clock_timestamp(),${'d'.repeat(64)},${effective}::timestamptz)`);return id;};
  // The current-day check-in above recorded this day's overtime source (core/attendance.ts first-in capture), so 0592's
  // input guard requires tenant and subject authority even of the owner: still the owner role, with HR's session context.
  const hr=adminCtx(base);
  const punch=(method:string,captureId:string|null,time:string)=>owner.withTenant(hr,tx=>tx.execute(sql`insert into attendance_punch(tenant_id,attendance_id,employment_id,attendance_date,punch_at,direction,method,clock_capture_id)
   values(${base.tenantId}::uuid,${day.id}::uuid,${employmentId}::uuid,${day.date}::date,${time}::time,'out',${method}::clock_method,${captureId}::uuid)`));
  const offlineCapture=await capture(new Date(at).toISOString()),onlineCapture=await capture(null);
  expect(await failure(punch('mobile_offline',null,'23:59:57'))).toMatch(/Offline clocking requires its attendance capture/);
  expect(await failure(punch('web',offlineCapture,'23:59:58'))).toMatch(/Invalid attendance capture reference/);
  expect(await failure(punch('mobile_offline',onlineCapture,'23:59:59'))).toMatch(/Invalid attendance capture reference/);
  // Non-vacuous: each capture accepts the method it proves, so the refusals above are the method/provenance rule.
  expect(await failure(punch('mobile_offline',offlineCapture,'23:59:58'))).toBe('resolved');expect(await failure(punch('web',onlineCapture,'23:59:59'))).toBe('resolved');
  expect((await punches(employmentId)).map(row=>[row.method,row.effectiveMs!==null])).toEqual([['mobile_offline',true],['mobile_offline',true],['web',false]]);
 });
 it('checks effective_at: whole seconds, never after the receipt',async()=>{
  const {employmentId}=await employee(),recorded=second(0);
  const insert=(effectiveMs:number)=>owner.db.execute(sql`insert into attendance_clock_capture(tenant_id,employment_id,attendance_date,direction,request_id,server_recorded_at,command_digest,effective_at)
   values(${base.tenantId}::uuid,${employmentId}::uuid,${todayInKualaLumpur(new Date(recorded))}::date,'in',${randomUUID()}::uuid,${new Date(recorded).toISOString()}::timestamptz,${'e'.repeat(64)},${new Date(effectiveMs).toISOString()}::timestamptz)`);
  expect(await failure(insert(recorded-1500))).toMatch(/attendance_clock_capture_effective_at_ck/);
  expect(await failure(insert(recorded+1000))).toMatch(/attendance_clock_capture_effective_at_ck/);
  expect(await failure(insert(recorded))).toBe('resolved');expect(await failure(insert(recorded-60000))).toBe('resolved');
  expect((await counts(employmentId)).captures).toBe(2);
 });
 it('plans without writing, and refuses with a usable transaction and nothing written',async()=>{
  const {employmentId,ctx}=await employee(),at=second(60000);
  const outcome=await withAttendanceTenant(ctx,async tx=>{
   const before=await visible(tx,employmentId),plan=await planOfflineClockTx(tx,ctx,command(employmentId,'in',at));
   const refused=[await planOfflineClockTx(tx,ctx,command(employmentId,'in',at+500)),await planOfflineClockTx(tx,ctx,command(employmentId,'in',second(-5000))),
    await captureOfflineClockTx(tx,ctx,command(employmentId,'in',at,{claimDigest:'not a digest'}))];
   return {before,plan,refused,after:await visible(tx,employmentId)};
  });
  expect(outcome.plan).toMatchObject({kind:'plan',date:todayInKualaLumpur(new Date(at)),time:myt(at)});
  expect(outcome.refused.map(row=>row.kind==='refused'?row.reason:row.kind)).toEqual(['effective_time_invalid','effective_time_invalid','invalid_command']);
  expect(outcome.before).toEqual({captures:0,punches:0,days:0});expect(outcome.after).toEqual(outcome.before);
  await owner.db.update(S.employment).set({attendancePhotoSetting:'required'}).where(eq(S.employment.id,employmentId));
  expect(await withAttendanceTenant(ctx,tx=>captureOfflineClockTx(tx,ctx,command(employmentId,'in',at)))).toMatchObject({kind:'refused',reason:'photo_required'});
  expect(await counts(employmentId)).toEqual({captures:0,punches:0,days:0,events:0});
 });
 it('orders against an earlier online punch by the effective instant, not by the later offline receipt',async()=>{
  const {employmentId,ctx}=await employee();await online(ctx,employmentId,'in');
  const [anchor]=await owner.db.select({at:S.attendanceClockCapture.serverRecordedAt}).from(S.attendanceClockCapture).where(eq(S.attendanceClockCapture.employmentId,employmentId));
  // Effective a minute before the online punch: refused although this receipt is later than the online one.
  const earlier=Math.floor(anchor.at.getTime()/1000)*1000-60000;
  expect(await withAttendanceTenant(ctx,tx=>captureOfflineClockTx(tx,ctx,command(employmentId,'out',earlier)))).toMatchObject({kind:'refused',reason:'clock_conflict',message:'Clocking must follow the previous accepted event'});
  const later=Math.ceil((anchor.at.getTime()+1)/1000)*1000;await new Promise(resolve=>setTimeout(resolve,Math.max(0,later-Date.now())+20));
  expect(await withAttendanceTenant(ctx,tx=>captureOfflineClockTx(tx,ctx,command(employmentId,'out',later)))).toMatchObject({kind:'recorded',effectiveAt:later});
  expect((await punches(employmentId)).map(row=>[row.direction,row.method,row.effectiveMs])).toEqual([['in','web',null],['out','mobile_offline',String(later)]]);
 });
 it('aborts the caller transaction when a write fails after the first insert, even if the caller catches it',async()=>{
  const {employmentId,ctx}=await employee(),seen:{error?:string|null;next?:string}={};audit.fail=true;
  // The callback swallows the failure and resolves; only an aborted transaction keeps the partial writes out.
  await withAttendanceTenant(ctx,async tx=>{
   seen.error=await captureOfflineClockTx(tx,ctx,command(employmentId,'in',second(60000))).then(()=>null,(caught:Error)=>caught.message);
   seen.next=await tx.execute(sql`select 1`).then(()=>'usable',()=>'aborted');
  }).catch(()=>undefined);
  expect(seen).toEqual({error:'synthetic audit failure',next:'aborted'});
  expect(await counts(employmentId)).toEqual({captures:0,punches:0,days:0,events:0});
 });
 it('leaves online clocking unchanged: web punches, no effective_at, server instant ordering',async()=>{
  const {employmentId,ctx}=await employee(),first=await online(ctx,employmentId,'in');
  await new Promise(resolve=>setTimeout(resolve,20));const last=await online(ctx,employmentId,'out');
  expect([first.direction,last.direction]).toEqual(['in','out']);
  expect((await punches(employmentId)).map(row=>[row.direction,row.method,row.effectiveMs,row.later])).toEqual([['in','web',null,null],['out','web',null,null]]);
  const [day]=await owner.db.select({checkInMethod:S.attendance.checkInMethod,checkOutMethod:S.attendance.checkOutMethod}).from(S.attendance).where(eq(S.attendance.employmentId,employmentId));
  expect(day).toEqual({checkInMethod:'web',checkOutMethod:'web'});
  const events=await owner.db.execute<{payload:Record<string,unknown>}>(sql`select payload from domain_event where event_type='attendance.clock.captured' and subject_employment_id=${employmentId}::uuid order by payload->>'serverRecordedAt'`);
  expect([...events].map(row=>[row.payload.direction,'clientSource' in row.payload,'effectiveAt' in row.payload])).toEqual([['in',false,false],['out',false,false]]);
 });
});
