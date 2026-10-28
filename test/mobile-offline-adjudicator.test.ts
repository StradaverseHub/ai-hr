/** The deterministic offline-claim adjudicator on draft 0647 (owner decisions O1-O3, 2026-10-28), end to end through
 * the real claim service where the server-proven interval allows it: real signatures, SQL, RLS, payroll, geofence,
 * correction and canonical writer owners. Proven windows wider than a test can wait for are decided directly with the
 * same owners in the employee's transaction. Vendor preparation and the trusted snapshot port are synthetic. */
import {createHash,randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Tx} from '../db/client';
import * as S from '../db/schema';
import {createOfflineClaimService,type OfflineClaimFacts} from '../core/mobile-offline-claim';
import type {OfflineContextIssuePorts} from '../core/mobile-offline-context';
import {createLocation} from '../core/location';
import {hireEmployee} from '../core/org';
import {BUILTIN_MAPPING_ID} from '../lib/clocking-file';
import {setCompensation} from '../core/comp';
import {withAttendanceTenant} from '../core/module-gate';
import {checkIn,decideAttendanceCorrection,requestAttendanceCorrection} from '../core/attendance';
import {createClockingLocation,setClockingControl} from '../core/clocking-location';
import {commitClockingImport} from '../core/attendance-clocking-import';
import {captureOfflineClockTx,createOfflineAdjudicator,offlineEffectiveInstant,readOfflineClockingPolicyTx,setAttendancePolicy} from '../packs/attendance/service';
import {createBatch,generatePayslips,lockPayrollForOwnAttendanceRemoval} from '../packs/payroll/service';
import {offlineClockClaimClientData,type OfflineClockClaimData} from '../lib/mobile-offline-clock';
import type {OfflineClockReportedBounds} from '../lib/mobile-api/offline-clock-time';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,owner,resetDb,seedBase,type Base} from './harness';
import {offlineServiceFixture} from './helpers/mobile-offline-service-fixture';
import {installCustodyDraftForWorker} from './helpers/mobile-custody-draft';
import {installOfflineDraftForWorker} from './helpers/mobile-offline-draft';
let base:Base,restore:(()=>Promise<void>)|undefined,restoreCustody:(()=>Promise<void>)|undefined;
beforeAll(async()=>{restoreCustody=await installCustodyDraftForWorker();restore=await installOfflineDraftForWorker();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','synthetic-offline-adjudicator-fixture-secret-2026');await resetDb();base=await seedBase();});
afterAll(async()=>{try{await resetDb();await restore?.();await restoreCustody?.();}finally{vi.unstubAllEnvs();await closeAll();}});
type Fixture=Awaited<ReturnType<typeof offlineServiceFixture>>;
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
/** The trusted current snapshot the context was signed from; a case changes it to model drift. */
const snapshotOf=(f:Fixture)=>({policy:f.context.policy,sites:f.context.sites,attendance:f.context.attendance,target:f.context.target,permitCount:f.context.permits.length});
function consumer(f:Fixture,snapshot:()=>unknown=()=>snapshotOf(f)){
 const port=vi.fn<OfflineContextIssuePorts['snapshot']>(async()=>snapshot()),adjudicator=createOfflineAdjudicator({snapshot:port});
 const service=createOfflineClaimService({apiOrigin:'https://hr.example.com',photoRetentionMs:3600000},{prepare:async()=>({assertFresh:async()=>{}}),adjudicate:adjudicator.adjudicate,beforeCommit:async()=>{}});
 return {port,adjudicator,service};
}
const fields={workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:15',halfDayBefore:'13:00',workingDays:[1,2,3,4,5]};
/** The company's policy row through its own writer, then the two 0647 settings as the owner (a direct write; the service writer, setOfflineClockingPolicy, is test/mobile-offline-settings). */
async function company(p:{enabled?:boolean;seconds?:number;device?:boolean}={}){
 await setAttendancePolicy(adminCtx(base),{companyId:base.companyId,...fields,requireRegisteredDevice:p.device??false});
 const rows=await owner.db.execute<{enabled:boolean;seconds:number}>(sql`update attendance_policy set offline_clocking_enabled=${p.enabled??true},offline_max_proven_window_seconds=${p.seconds??900}
  where company_id=${base.companyId}::uuid returning offline_clocking_enabled enabled,offline_max_proven_window_seconds seconds`);
 expect([...rows]).toEqual([{enabled:p.enabled??true,seconds:p.seconds??900}]);
}
/** The first whole second inside the fixture's reported interval; `settled` waits on the DB clock until it has passed. */
const whole=(f:{context:{issuedAt:number}})=>Math.ceil(f.context.issuedAt/1000)*1000;
async function settled(f:{context:{issuedAt:number}}){
 await owner.db.execute(sql`select pg_sleep(greatest(0,extract(epoch from (${new Date(whole(f)).toISOString()}::timestamptz-clock_timestamp())))+0.02)`);
 const [row]=await owner.db.execute<{passed:boolean}>(sql`select clock_timestamp()>${new Date(whole(f)).toISOString()}::timestamptz passed`);expect(row.passed).toBe(true);
}
/** Attendance facts for the subject, read as the owner (outside RLS). */
const writes=async(employmentId:string)=>{const [row]=await owner.db.execute<{captures:number;punches:number;days:number}>(sql`select
 (select count(*) from attendance_clock_capture where employment_id=${employmentId}::uuid)::int captures,(select count(*) from attendance_punch where employment_id=${employmentId}::uuid)::int punches,
 (select count(*) from attendance where employment_id=${employmentId}::uuid)::int days`);return {...row};};
/** What the caller's own transaction sees, so "decided before any write" covers uncommitted work too. */
const seen=async(tx:Tx,employmentId:string)=>({captures:(await tx.select({id:S.attendanceClockCapture.id}).from(S.attendanceClockCapture).where(eq(S.attendanceClockCapture.employmentId,employmentId))).length,
 punches:(await tx.select({id:S.attendancePunch.id}).from(S.attendancePunch).where(eq(S.attendancePunch.employmentId,employmentId))).length});
/** Readers' reconstruction, independent of the service: the punch's instant is attendance_date + punch_at in MYT. */
async function exact(punchId:string,at:number){
 const [row]=await owner.db.execute<{exact:boolean}>(sql`select timezone('Asia/Kuala_Lumpur',attendance_date+punch_at)=${new Date(at).toISOString()}::timestamptz exact from attendance_punch where id=${punchId}::uuid`);return row?.exact;
}
async function provenance(captureId:string){
 const [row]=await owner.db.execute<{effectiveMs:string|null;method:string}>(sql`select (extract(epoch from c.effective_at)*1000)::bigint::text "effectiveMs",p.method::text method
  from attendance_clock_capture c join attendance_punch p on p.clock_capture_id=c.id where c.id=${captureId}::uuid`);
 return row&&{effectiveAt:row.effectiveMs==null?null:Number(row.effectiveMs),method:row.method};
}
/** drizzle wraps driver errors; the database's own message is the cause. */
const failure=(work:Promise<unknown>)=>work.then(()=>'resolved',(error:{message?:string;cause?:{message?:string}})=>[error?.message,error?.cause?.message].join(' | '));
const claims=()=>owner.db.select({outcome:S.mobileOfflineClaim.outcome,reason:S.mobileOfflineClaim.reason,captureId:S.mobileOfflineClaim.captureId,effectiveAt:S.mobileOfflineClaim.effectiveAt}).from(S.mobileOfflineClaim);
/** One assigned site far from the fixture's sampled position (3, 101), with the employee's geofencing switch ON. */
async function farSite(f:Fixture){
 const a=adminCtx(base),{id:locationId}=await createLocation(a,{companyId:base.companyId,code:'OFFLINE_FAR',name:'Offline far location'});
 const site=await createClockingLocation(a,{companyIds:[base.companyId],name:'Offline far site',lat:5,lng:103,radiusM:300,locationId});
 await setClockingControl(a,{employmentId:f.e.employmentId,enabled:true,clockingLocationIds:[site.id]});
 expect(await owner.db.select({on:S.employment.geofencingEnabled}).from(S.employment).where(eq(S.employment.id,f.e.employmentId))).toEqual([{on:true}]);
}
/** A real run with this employee's payslip for the claim's day, processed or then closed. */
async function payroll(f:Fixture,status:'processed'|'closed'){
 const a=adminCtx(base),date=todayInKualaLumpur(new Date(whole(f)));
 await setCompensation(a,{employmentId:f.e.employmentId,basicSalary:4000,monthlyAllowance:0,effectiveFrom:'2024-01-01'});
 const {batchId}=await createBatch(a,{companyId:base.companyId,payPeriod:date.slice(0,7)});await generatePayslips(a,{batchId});
 if(status==='closed')await owner.db.update(S.payrollBatch).set({status:'closed'}).where(eq(S.payrollBatch.id,batchId));
 // Non-vacuous: the employee's own coverage read, the owner the adjudicator consults, names this run for that day.
 expect(await withAttendanceTenant(f.ctx,tx=>lockPayrollForOwnAttendanceRemoval(tx,f.e.employmentId,date))).toEqual([{batchId,status}]);
}
/** A day an approved HR clock correction owns. */
async function corrected(f:Fixture){
 const a=adminCtx(base),date=todayInKualaLumpur(new Date(whole(f)));
 await checkIn(a,{employmentId:f.e.employmentId,date,time:'00:00',manual:true});
 const {correctionId}=await requestAttendanceCorrection(a,{employmentId:f.e.employmentId,date,checkIn:'00:00',checkOut:'00:01',reason:'HR verified gate log'});
 await decideAttendanceCorrection(a,{correctionId,decision:'approved'});
 expect(await owner.db.select({status:S.attendanceCorrection.status,date:S.attendanceCorrection.attendanceDate}).from(S.attendanceCorrection).where(eq(S.attendanceCorrection.id,correctionId))).toEqual([{status:'approved',date}]);
}

describe('offline effective instant (owner decision O1)',()=>{
 // Derived from the clock: a whole second an hour ago, and a context issued 390 ms after it.
 const W=Math.floor(Date.now()/1000)*1000-3600000,issuedAt=W+390,expiresAt=issuedAt+3600000;
 const interval=(minimum:number,maximum:number):OfflineClockReportedBounds=>({status:'reported_interval',minimum,maximum});
 const decide=(claimedAt:number,bounds:OfflineClockReportedBounds,maxProvenWindowSeconds=900)=>offlineEffectiveInstant({claimedAt,issuedAt,expiresAt,bounds,maxProvenWindowSeconds});
 it('rounds the claimed time to a whole second and clamps it into the whole seconds of the proven interval',()=>{
  expect(decide(W+2490,interval(issuedAt,W+5000))).toEqual({kind:'instant',effectiveAt:W+2000});
  expect(decide(W+2500,interval(issuedAt,W+5000))).toEqual({kind:'instant',effectiveAt:W+3000});
  // Rounds down to W, below the interval: clamped up to its first whole second.
  expect(decide(issuedAt,interval(issuedAt,W+5000))).toEqual({kind:'instant',effectiveAt:W+1000});
  // Claimed after the interval: clamped down to its last whole second.
  expect(decide(W+9000,interval(issuedAt,W+5600))).toEqual({kind:'instant',effectiveAt:W+5000});
  expect(decide(W+2490,interval(issuedAt,W+900))).toEqual({kind:'needs_review',reason:'time_unverifiable'});
 });
 it('sends a proven interval wider than the company maximum to review, at exactly the configured width',()=>{
  expect(decide(issuedAt+1000,interval(issuedAt,issuedAt+900000))).toMatchObject({kind:'instant'});
  expect(decide(issuedAt+1000,interval(issuedAt,issuedAt+900001))).toEqual({kind:'needs_review',reason:'proven_window_too_wide'});
  expect(decide(issuedAt+1000,interval(issuedAt,issuedAt+900001),1800)).toMatchObject({kind:'instant'});
 });
 it('refuses a claimed time outside the context window and reviews missing or overrunning proof',()=>{
  expect(decide(issuedAt-1,interval(issuedAt,issuedAt+1000))).toEqual({kind:'refused',reason:'outside_context_window'});
  expect(decide(expiresAt+1,interval(issuedAt,issuedAt+1000))).toEqual({kind:'refused',reason:'outside_context_window'});
  expect(decide(issuedAt+1000,interval(expiresAt+1,expiresAt+2000))).toEqual({kind:'refused',reason:'outside_context_window'});
  expect(decide(expiresAt-1000,interval(expiresAt-2000,expiresAt+1000))).toEqual({kind:'needs_review',reason:'outside_context_window'});
  expect(decide(issuedAt+1000,{status:'unavailable',reason:'continuity_unknown'})).toEqual({kind:'needs_review',reason:'continuity_unknown'});
  for(const reason of ['future_interval','invalid_interval'] as const)expect(decide(issuedAt+1000,{status:'unavailable',reason})).toEqual({kind:'needs_review',reason:'time_unverifiable'});
 });
});

describe('per-company offline clocking settings (owner decision O2, draft 0647)',()=>{
 it('defaults OFF and 900 s, bounds the width by CHECK, and survives the full-row attendance policy writer',async()=>{
  const a=adminCtx(base);await setAttendancePolicy(a,{companyId:base.companyId,...fields});
  const raw=()=>owner.db.execute<{enabled:boolean;seconds:number}>(sql`select offline_clocking_enabled enabled,offline_max_proven_window_seconds seconds from attendance_policy where company_id=${base.companyId}::uuid`).then(rows=>[...rows]);
  const read=(companyId:string)=>withAttendanceTenant(a,tx=>readOfflineClockingPolicyTx(tx,companyId));
  expect(await raw()).toEqual([{enabled:false,seconds:900}]);expect(await read(base.companyId)).toEqual({enabled:false,maxProvenWindowSeconds:900});
  expect(await read(randomUUID())).toEqual({enabled:false,maxProvenWindowSeconds:900});
  const width=(seconds:number)=>failure(owner.db.execute(sql`update attendance_policy set offline_max_proven_window_seconds=${seconds} where company_id=${base.companyId}::uuid`));
  for(const seconds of [-1,0,59,86401])expect(await width(seconds)).toMatch(/attendance_policy_offline_window_ck/);
  for(const seconds of [60,86400])expect(await width(seconds)).toBe('resolved');
  expect(await raw()).toEqual([{enabled:false,seconds:86400}]);
  expect(await failure(owner.db.execute(sql`update attendance_policy set offline_clocking_enabled=null where company_id=${base.companyId}::uuid`))).toMatch(/not-null/);
  await owner.db.execute(sql`update attendance_policy set offline_clocking_enabled=true,offline_max_proven_window_seconds=1800 where company_id=${base.companyId}::uuid`);
  // The settings writer's ON CONFLICT update names only its own columns, so it keeps both offline settings.
  await setAttendancePolicy(a,{companyId:base.companyId,...fields,breakMinutes:45});
  expect(await owner.db.select({breakMinutes:S.attendancePolicy.breakMinutes}).from(S.attendancePolicy).where(eq(S.attendancePolicy.companyId,base.companyId))).toEqual([{breakMinutes:45}]);
  expect(await raw()).toEqual([{enabled:true,seconds:1800}]);expect(await read(base.companyId)).toEqual({enabled:true,maxProvenWindowSeconds:1800});
 });
 it('requires the trusted snapshot port',()=>{
  expect(()=>createOfflineAdjudicator({} as never)).toThrow('Offline adjudication unavailable');
 });
});

describe('offline claim adjudication through the claim service',()=>{
 it('accepts a claim proven to the second, writing the punch at the clamped whole-second instant',async()=>{
  await company();const f=await offlineServiceFixture(base),c=consumer(f);await settled(f);
  const result=await c.service.consume(f.ctx,f.signed());
  expect(result).toMatchObject({outcome:'accepted',reason:'clock_accepted',effectiveAt:whole(f)});expect(result.effectiveAt!%1000).toBe(0);
  expect(result.effectiveMaximum!-result.effectiveMinimum!).toBeLessThanOrEqual(900000);expect(c.port).toHaveBeenCalledOnce();
  const [punch]=await owner.db.select().from(S.attendancePunch).where(eq(S.attendancePunch.clockCaptureId,result.captureId!));
  expect(punch).toMatchObject({direction:'out',attendanceDate:todayInKualaLumpur(new Date(result.effectiveAt!)),voidedAt:null});
  expect(await exact(punch.id,result.effectiveAt!)).toBe(true);expect(await provenance(result.captureId!)).toEqual({effectiveAt:whole(f),method:'mobile_offline'});
  expect(await claims()).toMatchObject([{outcome:'accepted',reason:'clock_accepted',captureId:result.captureId}]);
 });
 it('clamps a claimed time later than the proven interval to its last whole second',async()=>{
  await company();const f=await offlineServiceFixture(base),c=consumer(f),claimedAt=f.context.issuedAt+1800000;await settled(f);
  const result=await c.service.consume(f.ctx,f.signed({...f.claim,time:{...f.claim.time,claimedAt}}));
  const last=Math.floor(result.effectiveMaximum!/1000)*1000;
  expect(result).toMatchObject({outcome:'accepted',effectiveAt:last});expect(claimedAt-last).toBeGreaterThan(1790000);
  const [punch]=await owner.db.select().from(S.attendancePunch).where(eq(S.attendancePunch.clockCaptureId,result.captureId!));
  expect(await exact(punch.id,last)).toBe(true);expect(await provenance(result.captureId!)).toEqual({effectiveAt:last,method:'mobile_offline'});
 });
 it.each(['no attendance policy row','offline clocking switched off'] as const)('refuses a claim when the company has %s',async label=>{
  if(label==='offline clocking switched off')await company({enabled:false});
  else expect(await owner.db.select().from(S.attendancePolicy).where(eq(S.attendancePolicy.companyId,base.companyId))).toEqual([]);
  const f=await offlineServiceFixture(base),c=consumer(f);await settled(f);
  expect(await c.service.consume(f.ctx,f.signed())).toMatchObject({outcome:'refused',reason:'offline_disabled',captureId:null,effectiveAt:null});
  expect(await writes(f.e.employmentId)).toEqual({captures:0,punches:0,days:0});expect(await claims()).toMatchObject([{outcome:'refused',reason:'offline_disabled',captureId:null}]);
 });
 it.each([['before the context was issued',-1000],['after the context expired',3600000+1000]] as const)('refuses a claimed time %s',async(_label,offset)=>{
  await company();const f=await offlineServiceFixture(base),c=consumer(f),claimedAt=f.context.issuedAt+offset;
  expect(claimedAt<f.context.issuedAt||claimedAt>f.context.expiresAt).toBe(true);
  expect(await c.service.consume(f.ctx,f.signed({...f.claim,time:{...f.claim.time,claimedAt}}))).toMatchObject({outcome:'refused',reason:'outside_context_window'});
  expect(await writes(f.e.employmentId)).toEqual({captures:0,punches:0,days:0});
 });
 it('reviews a claim with no proven interval',async()=>{
  await company();const f=await offlineServiceFixture(base),c=consumer(f);await settled(f);
  const result=await c.service.consume(f.ctx,f.signed({...f.claim,time:{...f.claim.time,elapsed:{status:'unknown',reason:'continuity_unknown'}}}));
  expect(result).toMatchObject({outcome:'needs_review',reason:'continuity_unknown',effectiveMinimum:null,effectiveMaximum:null,captureId:null});
  expect(await writes(f.e.employmentId)).toEqual({captures:0,punches:0,days:0});
 });
 // Owner decision O3: each failed check is HR review, never refusal, and never an attendance write or SQL abort.
 // A case returns the claim it signs, or prepares the database and returns nothing (the fixture's own claim).
 const causes:[string,string,(f:Fixture)=>Promise<unknown>][]=[
  ['outside every assigned geofence','outside_geofence',farSite],
  ['with a reported mock location','mock_reported',async f=>({...f.claim,evidence:{...f.claim.evidence,mock:true}})],
  ['with a reported simulated location','simulated_reported',async f=>({...f.claim,evidence:{...f.claim.evidence,simulated:true}})],
  ['with a reported location accessory','accessory_reported',async f=>({...f.claim,evidence:{...f.claim.evidence,accessory:true}})],
  ['without the registered device its company requires','device_required',async()=>{await company({device:true});}],
  ['on a day processed payroll covers','payroll_locked',f=>payroll(f,'processed')],
  ['on a day closed payroll covers','payroll_locked',f=>payroll(f,'closed')],
  ['on a day an approved correction owns','corrected_day',corrected],
  ['when not employed on the day','employment_inactive',async f=>{
   await owner.db.update(S.employment).set({joinDate:todayInKualaLumpur(new Date(Date.now()+86400000))}).where(eq(S.employment.id,f.e.employmentId));}],
 ];
 it.each(causes)('reviews a claim %s, writing no attendance',async(_label,reason,prepare)=>{
  await company();const f=await offlineServiceFixture(base),c=consumer(f),prepared=await prepare(f),claim=prepared?prepared as OfflineClockClaimData:f.claim;
  await settled(f);const before=await writes(f.e.employmentId);
  const result=await c.service.consume(f.ctx,f.signed(claim));
  expect(result).toMatchObject({outcome:'needs_review',reason,captureId:null,effectiveAt:null});
  expect(await writes(f.e.employmentId)).toEqual(before);expect(before.captures).toBe(0);
  expect(await claims()).toMatchObject([{outcome:'needs_review',reason,captureId:null,effectiveAt:null}]);
 });
 it.each([['policy','policy_changed',(f:Fixture)=>({...snapshotOf(f),policy:{...f.context.policy,revision:'c'.repeat(64)}})],
  ['site set','site_changed',(f:Fixture)=>({...snapshotOf(f),sites:[{id:randomUUID(),name:'New site',lat:3,lng:101,radiusM:200}]})]] as const)('reviews a claim whose %s changed since its context was signed',async(_label,reason,current)=>{
  await company();const f=await offlineServiceFixture(base),c=consumer(f,()=>current(f));await settled(f);
  expect(await c.service.consume(f.ctx,f.signed())).toMatchObject({outcome:'needs_review',reason});
  expect(c.port).toHaveBeenCalledOnce();expect(c.port.mock.calls[0][2]).toMatchObject({employmentId:f.e.employmentId,companyId:base.companyId,key:{id:f.key.id}});
  expect(await writes(f.e.employmentId)).toEqual({captures:0,punches:0,days:0});
 });
});

describe('proven windows wider than a test can wait for, decided with the same owners',()=>{
 /** A claim proven over `minutes` ending two seconds ago, claimed ten minutes ago (+400 ms, so it rounds down). */
 function wide(f:Fixture,minutes:number){
  const received=Math.floor(Date.now()/1000)*1000-2000,claimedAt=received-600000+400;
  const claim:OfflineClockClaimData={...f.claim,command:{...f.claim.command,requestId:randomUUID()},time:{claimedAt,elapsed:{status:'elapsed',minimumNs:'0',maximumNs:String(minutes*60*1e9),continuity:'same_process'}}};
  const facts:OfflineClaimFacts={claim,context:{...f.context,issuedAt:received-1200000,expiresAt:received+2400000},key:f.key,digest:sha(offlineClockClaimClientData(claim)),
   receivedAt:received,currentCompanyId:f.context.scope.companyId,bounds:{status:'reported_interval',minimum:received-minutes*60000,maximum:received}};
  return {facts,effectiveAt:received-600000};
 }
 it.each([[15,900,'accepted'],[16,900,'needs_review'],[16,1800,'accepted']] as const)('a %i-minute window with a %i s company maximum is %s',async(minutes,seconds,outcome)=>{
  await company({seconds});const f=await offlineServiceFixture(base),c=consumer(f),{facts,effectiveAt}=wide(f,minutes);
  const run=await withAttendanceTenant(f.ctx,async tx=>{
   const decided=await c.adjudicator.decide(tx,f.ctx,facts,null),before=await seen(tx,f.e.employmentId);
   const final=decided.outcome==='accept'?await c.adjudicator.accept(tx,f.ctx,facts,null,decided):decided;
   return {decided,before,final,after:await seen(tx,f.e.employmentId)};
  });
  // Everything is decided before the first write.
  expect(run.before).toEqual({captures:0,punches:0});
  if(outcome==='needs_review'){
   expect(run.final).toEqual({outcome:'needs_review',reason:'proven_window_too_wide'});expect(run.after).toEqual(run.before);
   expect(await writes(f.e.employmentId)).toEqual({captures:0,punches:0,days:0});return;
  }
  expect(run.decided).toEqual({outcome:'accept',effectiveAt});expect(run.final).toMatchObject({outcome:'accepted',reason:'clock_accepted',effectiveAt});expect(run.after).toEqual({captures:1,punches:1});
  const captureId=run.final.outcome==='accepted'?run.final.captureId:'';
  const [punch]=await owner.db.select().from(S.attendancePunch).where(eq(S.attendancePunch.clockCaptureId,captureId));
  expect(await exact(punch.id,effectiveAt)).toBe(true);expect(await provenance(captureId)).toEqual({effectiveAt,method:'mobile_offline'});
 });
});

describe('the clocking import treats an offline-clocked day as an employee-clocked day',()=>{
 const myt=(at:number)=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(at));
 it('lists an uncoded line on an offline-clocked day instead of adding it, and still imports a day with no clockings',async()=>{
  await company();const f=await offlineServiceFixture(base),a=adminCtx(base);
  await owner.db.update(S.employment).set({employeeCode:'OFFLINE1'}).where(eq(S.employment.id,f.e.employmentId));
  const peer=await hireEmployee(a,{person:{fullName:'Offline import control',primaryEmail:randomUUID()+'@import.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01',employeeCode:'OFFLINE2'});
  const at=Math.floor(Date.now()/1000)*1000-120000,date=todayInKualaLumpur(new Date(at));
  expect(await withAttendanceTenant(f.ctx,tx=>captureOfflineClockTx(tx,f.ctx,{employmentId:f.e.employmentId,requestId:randomUUID(),action:'in',lat:3,lng:101,accuracy:5,effectiveAt:new Date(at),claimDigest:sha(randomUUID())}))).toMatchObject({kind:'recorded',date});
  // Non-vacuous: the day's only clocking is mobile_offline, which the former web-only rule did not count.
  expect(await owner.db.select({method:S.attendancePunch.method}).from(S.attendancePunch).where(eq(S.attendancePunch.employmentId,f.e.employmentId))).toEqual([{method:'mobile_offline'}]);
  const text=`staff,time\nOFFLINE1,${date} ${myt(at)}\nOFFLINE2,${date} ${myt(at)}`;
  const run=await commitClockingImport(a,{mappingId:BUILTIN_MAPPING_ID,text,fileName:'offline-day.csv',fileBytes:Buffer.byteLength(text)});
  const lines=await owner.db.select({result:S.clockingImportLine.result}).from(S.clockingImportLine).where(eq(S.clockingImportLine.runId,run.runId!)).orderBy(S.clockingImportLine.lineNo);
  expect(lines.map(line=>line.result)).toEqual(['uncoded_on_clocked_day','imported']);
  expect(await writes(f.e.employmentId)).toEqual({captures:1,punches:1,days:1});
  expect(await owner.db.select({method:S.attendancePunch.method}).from(S.attendancePunch).where(eq(S.attendancePunch.employmentId,peer.employmentId))).toEqual([{method:'import'}]);
 });
});
