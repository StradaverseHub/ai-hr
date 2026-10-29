/** The production offline clock snapshot on draft 0647: each signed value read from its owner, the site set
 * resolveGeofence matches, a deterministic policy revision, refusal of what a signed context cannot represent, and
 * the one port feeding both context issuance and the adjudicator end to end through the real claim service (real
 * signatures, SQL, RLS, geofence and canonical writer owners). Vendor preparation is synthetic. */
import {randomUUID} from 'node:crypto';
import {eq,inArray,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as S from '../db/schema';
import {createOfflineClaimService} from '../core/mobile-offline-claim';
import {OfflineContextIssueError,type OfflineContextIssuePorts} from '../core/mobile-offline-context';
import {createCompany} from '../core/admin';
import {checkIn,OutsideGeofenceError,resolveGeofence} from '../core/attendance';
import {archiveClockingLocation,createClockingLocation,setAttendancePhotoSetting,setClockingControl} from '../core/clocking-location';
import {ownClockToday,ownClockTodaySummary} from '../core/attendance-clock-read';
import {withAttendanceTenant} from '../core/module-gate';
import {assignedClockingSitesTx,createOfflineAdjudicator,offlineClockPolicyRevision,offlineClockSnapshotPort,readOfflineClockingPolicyTx,readOfflineClockSnapshotTx,setAttendancePolicy,type OfflineClockSnapshotDeployment} from '../packs/attendance/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,owner,resetDb,seedBase,type Base} from './harness';
import {offlineServiceFixture} from './helpers/mobile-offline-service-fixture';
import {installCustodyDraftForWorker} from './helpers/mobile-custody-draft';
import {installOfflineDraftForWorker} from './helpers/mobile-offline-draft';
let base:Base,restore:(()=>Promise<void>)|undefined,restoreCustody:(()=>Promise<void>)|undefined;
beforeAll(async()=>{restoreCustody=await installCustodyDraftForWorker();restore=await installOfflineDraftForWorker();});
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','synthetic-offline-snapshot-fixture-secret-2026');await resetDb();base=await seedBase();});
afterAll(async()=>{try{await resetDb();await restore?.();await restoreCustody?.();}finally{vi.unstubAllEnvs();await closeAll();}});
type Fixture=Awaited<ReturnType<typeof offlineServiceFixture>>;
/** The fixture's iOS key target; window and permit count are deployment-owned. */
const D:OfflineClockSnapshotDeployment={target:{platform:'ios',appId:'ABCDEFGHIJ.ai.hr',environment:'production'},windowMs:3600000,permitCount:2};
const fields={workStart:'09:00',workEnd:'18:00',breakMinutes:60,lateAfter:'09:15',halfDayBefore:'13:00',workingDays:[1,2,3,4,5]};
/** The company's policy row through its own writer (accuracy cap included), then 0647's switch as the owner. */
async function company(p:{accuracy?:number|null;breakMinutes?:number}={}){
 await setAttendancePolicy(adminCtx(base),{companyId:base.companyId,...fields,breakMinutes:p.breakMinutes??60,geofenceMaximumAccuracyM:p.accuracy??null});
 const rows=await owner.db.execute<{enabled:boolean;accuracy:number|null}>(sql`update attendance_policy set offline_clocking_enabled=true where company_id=${base.companyId}::uuid
  returning offline_clocking_enabled enabled,geofence_maximum_accuracy_m accuracy`);
 expect([...rows]).toEqual([{enabled:true,accuracy:p.accuracy??null}]);
}
const read=(f:Fixture,deployment:OfflineClockSnapshotDeployment=D,companyId=base.companyId)=>
 withAttendanceTenant(f.ctx,tx=>readOfflineClockSnapshotTx(tx,f.ctx,{employmentId:f.e.employmentId,companyId,key:f.key},deployment));
let seq=0;
/** `n` sites open to the base company, 0.1 degree (~11 km) apart and at least 2 degrees from the claim position (3, 101),
 * so standing on one never matches another. */
async function sites(n:number,radiusM=200){
 const out:{id:string;lat:number;lng:number}[]=[];
 for(let i=0;i<n;i++){const lat=5+(seq%40)*0.1,lng=100+Math.floor(seq/40)*0.1,name=`Snapshot site ${++seq}`;
  out.push({id:(await createClockingLocation(adminCtx(base),{companyIds:[base.companyId],name,lat,lng,radiusM})).id,lat,lng});}
 return out;
}
const assign=(employmentId:string,ids:string[])=>setClockingControl(adminCtx(base),{employmentId,enabled:true,clockingLocationIds:ids});
const unrepresentable={name:'OfflineContextIssueError',reason:'configuration_unavailable'};
/** The fixture's claim position (3, 101), so a site there passes the canonical geofence. */
const here=(name:string)=>createClockingLocation(adminCtx(base),{companyIds:[base.companyId],name,lat:3,lng:101,radiusM:300});
function consumer(port:OfflineContextIssuePorts['snapshot']){
 const adjudicator=createOfflineAdjudicator({snapshot:port});
 return createOfflineClaimService({apiOrigin:'https://hr.example.com',photoRetentionMs:3600000},{prepare:async()=>({assertFresh:async()=>{}}),adjudicate:adjudicator.adjudicate,beforeCommit:async()=>{}});
}
const whole=(f:{context:{issuedAt:number}})=>Math.ceil(f.context.issuedAt/1000)*1000;
async function settled(f:{context:{issuedAt:number}}){
 await owner.db.execute(sql`select pg_sleep(greatest(0,extract(epoch from (${new Date(whole(f)).toISOString()}::timestamptz-clock_timestamp())))+0.02)`);
}
const writes=async(employmentId:string)=>{const [row]=await owner.db.execute<{captures:number;punches:number}>(sql`select
 (select count(*) from attendance_clock_capture where employment_id=${employmentId}::uuid)::int captures,(select count(*) from attendance_punch where employment_id=${employmentId}::uuid)::int punches`);return {...row};};
const claims=()=>owner.db.select({outcome:S.mobileOfflineClaim.outcome,reason:S.mobileOfflineClaim.reason,captureId:S.mobileOfflineClaim.captureId}).from(S.mobileOfflineClaim);
const signedPart=(f:Fixture)=>({policy:f.context.policy,sites:f.context.sites,attendance:f.context.attendance,target:f.context.target,permitCount:f.context.permits.length});

describe('production offline clock snapshot: values from their owners',()=>{
 it('reads every signed value from its owner and the deployment values from the deployment',async()=>{
  await company({accuracy:50});const f=await offlineServiceFixture(base),a=adminCtx(base),employmentId=f.e.employmentId;
  await checkIn(a,{employmentId,date:todayInKualaLumpur(),time:'00:00',manual:true});
  const [north,south]=await sites(2);await assign(employmentId,[north.id,south.id]);await setAttendancePhotoSetting(a,{employmentId,setting:'required'});
  const snapshot=await read(f);
  // Each owner, read independently.
  const offline=await withAttendanceTenant(f.ctx,tx=>readOfflineClockingPolicyTx(tx,base.companyId));
  const [emp]=await owner.db.select({on:S.employment.geofencingEnabled,photo:S.employment.attendancePhotoSetting}).from(S.employment).where(eq(S.employment.id,employmentId));
  const [policy]=await owner.db.select({maximum:S.attendancePolicy.geofenceMaximumAccuracyM}).from(S.attendancePolicy).where(eq(S.attendancePolicy.companyId,base.companyId));
  const stored=await owner.db.select({id:S.clockingLocation.id,name:S.clockingLocation.name,lat:S.clockingLocation.lat,lng:S.clockingLocation.lng,radiusM:S.clockingLocation.radiusM}).from(S.clockingLocation).where(inArray(S.clockingLocation.id,[north.id,south.id])).orderBy(S.clockingLocation.id);
  const summary=await ownClockTodaySummary(f.ctx,employmentId),today=await ownClockToday(f.ctx,undefined,employmentId);
  // Non-vacuous: every owner holds a non-default value.
  expect([offline.enabled,emp.on,policy.maximum,emp.photo,summary.clockedIn,stored.length]).toEqual([true,true,50,'required',true,2]);
  const p={offlineEnabled:offline.enabled,windowMs:D.windowMs,geofencingRequired:emp.on,maximumAccuracyM:policy.maximum,photoRequirement:emp.photo};
  expect(snapshot).toEqual({policy:{revision:offlineClockPolicyRevision(p),...p},sites:stored,
   attendance:{baseline:today.removalBaseline,date:summary.date,clockedIn:summary.clockedIn,openSince:Date.parse(summary.openSince!)},target:D.target,permitCount:D.permitCount});
  expect(snapshot.policy.revision).toMatch(/^[a-f0-9]{64}$/);
  // Deployment-owned values come only from the deployment argument.
  const other:OfflineClockSnapshotDeployment={target:{platform:'android',appId:'ai.hr',environment:null},windowMs:7200000,permitCount:5};
  const moved=await read(f,other);
  expect(moved).toEqual({...snapshot,policy:{...snapshot.policy,windowMs:7200000,revision:offlineClockPolicyRevision({...p,windowMs:7200000})},target:other.target,permitCount:5});
  for(const bad of [{...D,permitCount:0},{...D,permitCount:33},{...D,windowMs:0},{...D,target:{platform:'web'}}])
   await expect(read(f,bad as OfflineClockSnapshotDeployment)).rejects.toMatchObject(unrepresentable);
  expect(()=>offlineClockSnapshotPort({...D,permitCount:33})).toThrow(OfflineContextIssueError);
 });
 it('keeps the revision stable across calls and moves it only with a policy field',async()=>{
  await company({accuracy:50});const f=await offlineServiceFixture(base),a=adminCtx(base),employmentId=f.e.employmentId;
  await assign(employmentId,(await sites(1)).map(s=>s.id));
  const first=await read(f);expect(await read(f)).toEqual(first);
  const {revision,...p}=first.policy;expect(offlineClockPolicyRevision(p)).toBe(revision);
  // An unrelated company setting is not a policy field.
  await company({accuracy:50,breakMinutes:45});expect((await read(f)).policy.revision).toBe(revision);
  await setAttendancePhotoSetting(a,{employmentId,setting:'optional'});
  const photo=await read(f);expect(photo.policy).toMatchObject({photoRequirement:'optional'});expect(photo.policy.revision).not.toBe(revision);
  await company({accuracy:80});
  const accuracy=await read(f);expect(accuracy.policy).toMatchObject({maximumAccuracyM:80});expect(new Set([revision,photo.policy.revision,accuracy.policy.revision]).size).toBe(3);
  expect((await read(f,{...D,windowMs:1800000})).policy.revision).not.toBe(accuracy.policy.revision);
 });
 it('signs no accuracy limit and no site while geofencing is off, so editing them is not drift',async()=>{
  await company({accuracy:50});const f=await offlineServiceFixture(base);
  const off=await read(f);expect(off.policy).toMatchObject({geofencingRequired:false,maximumAccuracyM:null});expect(off.sites).toEqual([]);
  await company({accuracy:80});await sites(1);expect(await read(f)).toEqual(off);
 });
 it('signs exactly the sites resolveGeofence matches: not archived, assigned, open to the company, with a radius',async()=>{
  await company();const f=await offlineServiceFixture(base),a=adminCtx(base),employmentId=f.e.employmentId;
  const [kept,archived,unassigned,radiusless]=await sites(4),{id:coB}=await createCompany(a,{legalName:'Snapshot Co B Sdn Bhd'});
  const closed={lat:4,lng:102,id:(await createClockingLocation(a,{companyIds:[coB],name:'Snapshot closed site',lat:4,lng:102,radiusM:200})).id};
  await assign(employmentId,[kept.id,archived.id,radiusless.id]);await archiveClockingLocation(a,{clockingLocationId:archived.id});
  await owner.db.update(S.clockingLocation).set({radiusM:null}).where(eq(S.clockingLocation.id,radiusless.id));
  // The assignment writer refuses a site not open to the company; a pre-transfer row looks like this.
  await owner.db.insert(S.employeeClockingLocation).values({tenantId:base.tenantId,employmentId,clockingLocationId:closed.id});
  const snapshot=await read(f);expect(snapshot.sites.map(s=>s.id)).toEqual([kept.id]);
  // The extracted owner returns the radiusless row as stored; only the snapshot, which cannot sign it, drops it.
  expect((await withAttendanceTenant(f.ctx,tx=>assignedClockingSitesTx(tx,employmentId,base.companyId))).map(s=>s.id).sort()).toEqual([kept.id,radiusless.id].sort());
  // Behavioural equality: standing on each candidate, resolveGeofence matches exactly the signed set.
  const matched:string[]=[];
  for(const site of [kept,archived,unassigned,radiusless,closed]){
   const hit=await withAttendanceTenant(f.ctx,tx=>resolveGeofence(tx,{employmentId,date:todayInKualaLumpur(),time:'09:00',lat:site.lat,lng:site.lng,accuracy:1,punch:'in'})
    .then(r=>r.enforced?r.clockingLocationId:null,error=>{if(error instanceof OutsideGeofenceError)return null;throw error;}));
   if(hit)matched.push(hit);
  }
  expect(matched).toEqual(snapshot.sites.map(s=>s.id));
 });
 it('refuses what a signed context cannot represent, before issuance signs anything',async()=>{
  await company();const f=await offlineServiceFixture(base),employmentId=f.e.employmentId,many=await sites(33);
  await assign(employmentId,many.slice(0,32).map(s=>s.id));expect((await read(f)).sites).toHaveLength(32);
  await owner.db.update(S.clockingLocation).set({name:'N'.repeat(200)}).where(eq(S.clockingLocation.id,many[0].id));expect((await read(f)).sites).toHaveLength(32);
  await owner.db.update(S.clockingLocation).set({name:'N'.repeat(201)}).where(eq(S.clockingLocation.id,many[0].id));await expect(read(f)).rejects.toMatchObject(unrepresentable);
  await owner.db.update(S.clockingLocation).set({name:'Snapshot renamed'}).where(eq(S.clockingLocation.id,many[0].id));
  await assign(employmentId,many.map(s=>s.id));await expect(read(f)).rejects.toMatchObject(unrepresentable);
  // Through the real issuance service: its own typed refusal, and no context, permit or event for that employee.
  let other='';
  await expect(offlineServiceFixture(base,'ios',{snapshot:offlineClockSnapshotPort(D),prepare:async id=>{other=id;await assign(id,many.map(s=>s.id));}})).rejects.toMatchObject(unrepresentable);
  expect(other).not.toBe('');expect(await owner.db.select().from(S.mobileOfflineContext).where(eq(S.mobileOfflineContext.employmentId,other))).toEqual([]);
  // Only the first fixture's context exists.
  expect(await owner.db.select({id:S.mobileOfflineContext.id}).from(S.mobileOfflineContext)).toEqual([{id:f.context.id}]);
  expect(await owner.db.select().from(S.domainEvent).where(eq(S.domainEvent.eventType,'mobile.offline.context.issued'))).toHaveLength(1);
 });
 it('refuses a subject company other than the employment\'s own as a changed binding',async()=>{
  await company();const f=await offlineServiceFixture(base);
  await expect(read(f,D,randomUUID())).rejects.toMatchObject({name:'OfflineContextIssueError',reason:'binding_conflict'});
 });
});

describe('one snapshot port feeds context issuance and the adjudicator',()=>{
 async function issued(port:OfflineContextIssuePorts['snapshot'],extra=0){
  return offlineServiceFixture(base,'ios',{snapshot:port,prepare:async id=>{const near=await here('Snapshot gate '+randomUUID());await assign(id,[near.id,...(await sites(extra)).map(s=>s.id)]);}});
 }
 it('an unchanged world signs and compares identical values, so the claim is accepted with no drift',async()=>{
  await company({accuracy:50});const port=vi.fn(offlineClockSnapshotPort(D)),f=await issued(port);
  // Issuance signed exactly what the port reads now.
  expect(signedPart(f)).toEqual(await read(f));expect(f.context.policy).toMatchObject({offlineEnabled:true,geofencingRequired:true,maximumAccuracyM:50});expect(f.context.sites).toHaveLength(1);
  port.mockClear();await settled(f);
  const result=await consumer(port).consume(f.ctx,f.signed());
  expect(result).toMatchObject({outcome:'accepted',reason:'clock_accepted',effectiveAt:whole(f)});expect(port).toHaveBeenCalledOnce();
  expect(await claims()).toMatchObject([{outcome:'accepted',reason:'clock_accepted',captureId:result.captureId}]);
 });
 it.each([
  ['a policy field','policy_changed',async(f:Fixture)=>{await setAttendancePhotoSetting(adminCtx(base),{employmentId:f.e.employmentId,setting:'optional'});}],
  ['the site set','site_changed',async(f:Fixture)=>{await archiveClockingLocation(adminCtx(base),{clockingLocationId:f.context.sites.find(s=>s.name.startsWith('Snapshot site'))!.id});}],
 ] as const)('real drift in %s since signing is %s review',async(_label,reason,change)=>{
  await company({accuracy:50});const port=offlineClockSnapshotPort(D),f=await issued(port,1);expect(f.context.sites).toHaveLength(2);
  await change(f);await settled(f);
  expect(await consumer(port).consume(f.ctx,f.signed())).toMatchObject({outcome:'needs_review',reason,captureId:null});
  expect(await writes(f.e.employmentId)).toEqual({captures:0,punches:0});
 });
 it.each([
  ['more than 32 current sites',async(f:Fixture)=>{await assign(f.e.employmentId,[...f.context.sites.map(s=>s.id),...(await sites(32)).map(s=>s.id)]);}],
  ['a current site name over 200 characters',async(f:Fixture)=>{await owner.db.update(S.clockingLocation).set({name:'N'.repeat(201)}).where(eq(S.clockingLocation.id,f.context.sites[0].id));}],
 ] as const)('a current snapshot with %s is a site_changed review, never a stuck claim',async(_label,change)=>{
  await company({accuracy:50});const port=offlineClockSnapshotPort(D),f=await issued(port);
  await change(f);
  // Non-vacuous: the port itself refuses this world; only the adjudicator's mapping turns that into review.
  await expect(withAttendanceTenant(f.ctx,tx=>port(tx,f.ctx,{employmentId:f.e.employmentId,companyId:base.companyId,key:f.key}))).rejects.toMatchObject(unrepresentable);
  await settled(f);
  expect(await consumer(port).consume(f.ctx,f.signed())).toMatchObject({outcome:'needs_review',reason:'site_changed',captureId:null,effectiveAt:null});
  expect(await writes(f.e.employmentId)).toEqual({captures:0,punches:0});expect(await claims()).toMatchObject([{outcome:'needs_review',reason:'site_changed',captureId:null}]);
 });
 it('an unparsable current snapshot from any port is site_changed; a rebound subject is scope_changed; other failures throw',async()=>{
  await company();
  const cases:[OfflineContextIssuePorts['snapshot'],string][]=[[async()=>({policy:'unparsable'}),'site_changed'],[async()=>{throw new OfflineContextIssueError('binding_conflict');},'scope_changed']];
  for(const [port,reason] of cases){
   const f=await offlineServiceFixture(base);await settled(f);
   expect(await consumer(port).consume(f.ctx,f.signed())).toMatchObject({outcome:'needs_review',reason,captureId:null});
   expect(await writes(f.e.employmentId)).toEqual({captures:0,punches:0});
  }
  const f=await offlineServiceFixture(base);await settled(f);const before=(await claims()).length;
  await expect(consumer(async()=>{throw new Error('synthetic owner failure');}).consume(f.ctx,f.signed())).rejects.toThrow('synthetic owner failure');
  expect(await claims()).toHaveLength(before);expect(await writes(f.e.employmentId)).toEqual({captures:0,punches:0});
 });
});
