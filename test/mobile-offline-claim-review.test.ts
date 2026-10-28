/** HR review and human resolution of offline claims on draft 0647 (owner decisions 2026-10-28, protocol decision 6):
 * real claim custody, RLS as the application role, the attendance-correction owner that records an accept, payroll and
 * the canonical offline writer for the employee's own later clockings. The claim service's vendor preparation and
 * adjudication policy are synthetic: they only decide which outcome is held or accepted. */
import {createHash,randomUUID} from 'node:crypto';
import {and,asc,eq,inArray,isNull,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {SessionContext} from '../db/client';
import * as S from '../db/schema';
import {createOfflineClaimService,type OfflineClaimPorts} from '../core/mobile-offline-claim';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {withAttendanceTenant} from '../core/module-gate';
import {AttendancePayrollClosedError,ClockDataChangedError,attendanceClockData,captureOfflineClockTx,planOfflineClockTx} from '../packs/attendance/service';
import {listOfflineClaimsForReview,ownOfflineClaimResolution,readOfflineClaimPhotoForReview,readOfflineClaimResolutionBaselineTx,resolveOfflineClaim} from '../packs/attendance/mobile-offline-claim-review';
import {createBatch,generatePayslips,lockPayrollForAttendanceChange} from '../packs/payroll/service';
import type {OfflineClockClaimData} from '../lib/mobile-offline-clock';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,owner,resetDb,seedBase,type Base} from './harness';
import {offlineServiceFixture} from './helpers/mobile-offline-service-fixture';
import {installCustodyDraftForWorker} from './helpers/mobile-custody-draft';
import {installOfflineDraftForWorker} from './helpers/mobile-offline-draft';
let base:Base,other:string,restore:(()=>Promise<void>)|undefined,restoreCustody:(()=>Promise<void>)|undefined;
beforeAll(async()=>{restoreCustody=await installCustodyDraftForWorker();restore=await installOfflineDraftForWorker();});
beforeEach(async()=>{
 vi.stubEnv('AI_CONFIG_SECRET','synthetic-offline-claim-review-fixture-secret-2026');await resetDb();base=await seedBase();
 [{id:other}]=await owner.db.insert(S.company).values({tenantId:base.tenantId,legalName:'Offline Review Other Sdn Bhd'}).returning({id:S.company.id});
});
afterAll(async()=>{try{await resetDb();await restore?.();await restoreCustody?.();}finally{vi.unstubAllEnvs();await closeAll();}});
type Fixture=Awaited<ReturnType<typeof offlineServiceFixture>>;
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
/** A login with one company-scoped grant, recorded in role_assignment as the session states it, and its own person. */
async function scopedUser(role:'hr_admin'|'employee',companyId:string):Promise<SessionContext>{
 const [p]=await owner.db.insert(S.person).values({tenantId:base.tenantId,fullName:`Offline review ${role}`,primaryEmail:`review_${randomUUID()}@t.local`}).returning({id:S.person.id});
 const [u]=await owner.db.insert(S.appUser).values({tenantId:base.tenantId,workosUserId:`user_${randomUUID()}`,personId:p.id}).returning({id:S.appUser.id});
 await owner.db.insert(S.roleAssignment).values({tenantId:base.tenantId,appUserId:u.id,companyId,role});
 return {tenantId:base.tenantId,userId:u.id,personId:p.id,roles:[role],grants:[{role,companyId}],entitlements:harnessSnapshot(base.tenantId)};
}
/** A colleague in the claim's own company with no HR grant. */
async function colleague():Promise<SessionContext>{
 const e=await hireEmployee(adminCtx(base),{person:{fullName:'Offline review colleague',primaryEmail:randomUUID()+'@review.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 const userId=await createAppUser(base.tenantId,e.personId,'employee');
 return {tenantId:base.tenantId,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}],entitlements:harnessSnapshot(base.tenantId)};
}
/** Waits on the database clock, which stamps receipt, until `at` has passed. */
async function after(at:number){
 await owner.db.execute(sql`select pg_sleep(greatest(0,extract(epoch from (${new Date(at).toISOString()}::timestamptz-clock_timestamp())))+0.02)`);
 const [row]=await owner.db.execute<{passed:boolean}>(sql`select clock_timestamp()>${new Date(at).toISOString()}::timestamptz passed`);expect(row.passed).toBe(true);
}
const ONE_SECOND={status:'elapsed',minimumNs:'0',maximumNs:'1000000000',continuity:'same_process'} as const;
const THREE_SECONDS={status:'elapsed',minimumNs:'0',maximumNs:'3000000000',continuity:'same_process'} as const;
/** One claim through the real claim service, held with `decision` (default: review). Its proven interval is
 * [issuedAt, issuedAt + reported maximum] once that has passed: one whole second by default, three with THREE_SECONDS. */
async function held(f:Fixture,p:{decision?:unknown;photo?:Buffer;elapsed?:OfflineClockClaimData['time']['elapsed'];retentionMs?:number;action?:'in'|'out'}={}){
 const claim:OfflineClockClaimData={...f.claim,time:{...f.claim.time,elapsed:p.elapsed??ONE_SECOND},
  command:{...f.claim.command,action:p.action??f.claim.command.action,photo:p.photo?{sha256:digest(p.photo),byteLength:p.photo.length,mimeType:'image/jpeg'}:null}},elapsed=claim.time.elapsed;
 const ports:OfflineClaimPorts={prepare:async()=>({assertFresh:async()=>{}}),adjudicate:async()=>p.decision??{outcome:'needs_review',reason:'mock_reported'},beforeCommit:async()=>{}};
 await after(f.context.issuedAt+(elapsed.status==='elapsed'?Math.ceil(Number(elapsed.maximumNs)/1e6):0));
 return createOfflineClaimService({apiOrigin:'https://hr.example.com',photoRetentionMs:p.retentionMs??3600000},ports).consume(f.ctx,f.signed(claim),p.photo?{bytes:Buffer.from(p.photo),mimeType:'image/jpeg'}:undefined);
}
const whole=(f:Fixture)=>Math.ceil(f.context.issuedAt/1000)*1000;
/** The employee's next claim in the same context (sequence 2), accepted by a synthetic policy through the canonical
 * offline writer at `at`: a real later clocking, with its capture, that the live rules order a held claim behind. */
async function acceptedLater(f:Fixture,previous:{digest:string},at:number,action:'in'|'out'='out'){
 const claim:OfflineClockClaimData={...f.claim,permit:f.context.permits[1],chain:{sequence:2,previousSha256:previous.digest},time:{...f.claim.time,elapsed:THREE_SECONDS},
  command:{...f.claim.command,requestId:randomUUID(),action,photo:null}};
 const ports:OfflineClaimPorts={prepare:async()=>({assertFresh:async()=>{}}),beforeCommit:async()=>{},adjudicate:async(tx,ctx,facts)=>{
  const c=facts.claim.command,written=await captureOfflineClockTx(tx,ctx,{employmentId:facts.claim.scope.employmentId,requestId:c.requestId,action:c.action,lat:c.lat,lng:c.lng,accuracy:c.accuracy,effectiveAt:new Date(at),claimDigest:facts.digest});
  if(written.kind!=='recorded')throw new Error('Canonical offline writer refused: '+written.reason);
  return {outcome:'accepted',reason:'clock_accepted',captureId:written.captureId,effectiveAt:at};}};
 await after(Math.max(at,f.context.issuedAt+3000));
 return createOfflineClaimService({apiOrigin:'https://hr.example.com',photoRetentionMs:3600000},ports).consume(f.ctx,f.signed(claim));
}
/** Attendance facts, corrections and resolutions for the subject, read as the owner (outside RLS). */
const writes=async(employmentId:string)=>{const [row]=await owner.db.execute<{captures:number;punches:number;days:number;resolutions:number;corrections:number}>(sql`select
 (select count(*) from attendance_clock_capture where employment_id=${employmentId}::uuid)::int captures,(select count(*) from attendance_punch where employment_id=${employmentId}::uuid)::int punches,
 (select count(*) from attendance where employment_id=${employmentId}::uuid)::int days,(select count(*) from mobile_offline_claim_resolution where employment_id=${employmentId}::uuid)::int resolutions,
 (select count(*) from attendance_correction where employment_id=${employmentId}::uuid)::int corrections`);return {...row};};
async function exact(punchId:string,at:number){
 const [row]=await owner.db.execute<{exact:boolean}>(sql`select timezone('Asia/Kuala_Lumpur',attendance_date+punch_at)=${new Date(at).toISOString()}::timestamptz exact from attendance_punch where id=${punchId}::uuid`);return row?.exact;
}
/** The provenance chain of an accepted claim, joined as the owner: claim -> resolution -> punch and the correction that
 * added it (its punch-added audit event names that correction). */
async function chain(claimId:string){
 const [row]=await owner.db.execute<{claimId:string;correctionId:string;punchId:string;method:string;captureId:string|null;status:string;effectiveMs:string;exact:boolean;added:boolean}>(sql`select
  c.id "claimId",r.correction_id "correctionId",p.id "punchId",p.method::text method,p.clock_capture_id "captureId",k.status::text status,(extract(epoch from r.effective_at)*1000)::bigint::text "effectiveMs",
  timezone('Asia/Kuala_Lumpur',p.attendance_date+p.punch_at)=r.effective_at exact,
  exists(select 1 from domain_event e where e.aggregate_id=p.id and e.event_type='attendance.punch.added' and e.payload->>'correctionId'=k.id::text) added
  from mobile_offline_claim c join mobile_offline_claim_resolution r on r.claim_id=c.id join attendance_punch p on p.id=r.punch_id join attendance_correction k on k.id=r.correction_id where c.id=${claimId}::uuid`);
 if(!row)return null;const {effectiveMs,...rest}=row;return {...rest,effectiveAt:Number(effectiveMs)};
}
/** MYT wall time, as punch_at and the correction entries hold it. */
const wall=(at:number)=>new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kuala_Lumpur',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(at));
const dayRow=(employmentId:string,date:string)=>owner.db.select().from(S.attendance).where(and(eq(S.attendance.employmentId,employmentId),eq(S.attendance.attendanceDate,date))).then(rows=>rows[0]);
/** What the live clock rules would decide for the held claim now, as the employee: a plan only, nothing written. */
const livePlan=(f:Fixture,receipt:{digest:string},p:{action:'in'|'out';at:number;requestId?:string})=>withAttendanceTenant(f.ctx,tx=>planOfflineClockTx(tx,f.ctx,{employmentId:f.e.employmentId,
 requestId:p.requestId??f.claim.command.requestId,action:p.action,lat:f.claim.command.lat,lng:f.claim.command.lng,accuracy:f.claim.command.accuracy,effectiveAt:new Date(p.at),claimDigest:receipt.digest}));
const events=(claimId:string)=>owner.db.select({eventType:S.domainEvent.eventType,actorId:S.domainEvent.actorId,payload:S.domainEvent.payload}).from(S.domainEvent)
 .where(and(eq(S.domainEvent.aggregateId,claimId),inArray(S.domainEvent.eventType,['mobile.offline.claim.reviewed','mobile.offline.photo.reviewed','mobile.offline.claim.resolved']))).orderBy(asc(S.domainEvent.sequence));
/** What the application role sees under the session's RLS, ordered. */
const visible=(ctx:SessionContext)=>withAttendanceTenant(ctx,async tx=>({
 claims:(await tx.select({id:S.mobileOfflineClaim.id}).from(S.mobileOfflineClaim).orderBy(asc(S.mobileOfflineClaim.id))).map(row=>row.id),
 photos:(await tx.select({id:S.mobileOfflinePhoto.claimId}).from(S.mobileOfflinePhoto).orderBy(asc(S.mobileOfflinePhoto.claimId))).map(row=>row.id),
 resolutions:(await tx.select({id:S.mobileOfflineClaimResolution.claimId}).from(S.mobileOfflineClaimResolution).orderBy(asc(S.mobileOfflineClaimResolution.claimId))).map(row=>row.id)}));
/** drizzle wraps driver errors; the database's own message is the cause. */
const failure=(work:Promise<unknown>)=>work.then(()=>'resolved',(error:{message?:string;cause?:{message?:string}})=>[error?.message,error?.cause?.message].join(' | '));

describe('HR read access to offline claims (owner decision 2026-10-28)',()=>{
 it('lets HR with correction rights for the company list claims and read an unexpired photo, auditing every read',async()=>{
  const f=await offlineServiceFixture(base),bytes=Buffer.from('held offline photo'),receipt=await held(f,{photo:bytes}),hr=await scopedUser('hr_admin',base.companyId);
  // Non-vacuous: the owner sees the claim and its retained custody.
  expect(await owner.db.select({id:S.mobileOfflineClaim.id,outcome:S.mobileOfflineClaim.outcome}).from(S.mobileOfflineClaim)).toEqual([{id:receipt.id,outcome:'needs_review'}]);
  expect(await owner.db.select({id:S.mobileOfflinePhoto.claimId}).from(S.mobileOfflinePhoto)).toEqual([{id:receipt.id}]);
  expect(await visible(hr)).toEqual({claims:[receipt.id],photos:[receipt.id],resolutions:[]});
  const page=await listOfflineClaimsForReview(hr);
  expect(page.claims).toHaveLength(1);expect(page.next).toBeNull();
  expect(page.claims[0]).toMatchObject({id:receipt.id,employmentId:f.e.employmentId,companyId:base.companyId,actorId:f.ctx.userId,outcome:'needs_review',reason:'mock_reported',
   effectiveMinimum:f.context.issuedAt,effectiveMaximum:f.context.issuedAt+1000,effectiveAt:null,captureId:null,command:{action:'out',lat:3,lng:101,accuracy:5},
   photo:{sha256:digest(bytes),retained:true},resolution:null});
  expect(JSON.stringify(page)).not.toContain(bytes.toString('base64'));expect(JSON.stringify(page)).not.toContain(bytes.toString());
  const photo=await readOfflineClaimPhotoForReview(hr,receipt.id);
  expect(photo.bytes).toEqual(bytes);expect(photo).toMatchObject({mimeType:'image/jpeg',sha256:digest(bytes),retainedUntil:receipt.photo!.retainedUntil});
  expect(await events(receipt.id)).toEqual([{eventType:'mobile.offline.claim.reviewed',actorId:hr.userId,payload:{reason:'review'}},
   {eventType:'mobile.offline.photo.reviewed',actorId:hr.userId,payload:{reason:'review',digest:digest(bytes),retainedUntil:new Date(receipt.photo!.retainedUntil).toISOString()}}]);
  // The employee keeps reading only their own claim and custody.
  expect(await visible(f.ctx)).toEqual({claims:[receipt.id],photos:[receipt.id],resolutions:[]});
  await expect(readOfflineClaimPhotoForReview(f.ctx,receipt.id)).rejects.toMatchObject({reason:'forbidden'});
 });
 it('shows HR of another company and a plain colleague nothing, through RLS as the application role',async()=>{
  const f=await offlineServiceFixture(base),bytes=Buffer.from('another company may not see this'),receipt=await held(f,{photo:bytes});
  const foreign=await scopedUser('hr_admin',other),peer=await colleague();
  expect((await owner.db.select({id:S.mobileOfflineClaim.id}).from(S.mobileOfflineClaim)).map(row=>row.id)).toEqual([receipt.id]);
  expect((await owner.db.select({id:S.mobileOfflinePhoto.claimId}).from(S.mobileOfflinePhoto)).map(row=>row.id)).toEqual([receipt.id]);
  for(const ctx of [foreign,peer]){
   expect(await visible(ctx)).toEqual({claims:[],photos:[],resolutions:[]});
   expect(await listOfflineClaimsForReview(ctx)).toEqual({claims:[],next:null});
   await expect(listOfflineClaimsForReview(ctx,{employmentId:f.e.employmentId})).rejects.toMatchObject({reason:'forbidden'});
   await expect(readOfflineClaimPhotoForReview(ctx,receipt.id)).rejects.toMatchObject({reason:'not_found'});
   await expect(resolveOfflineClaim(ctx,{claimId:receipt.id,decision:'rejected',reason:'Not mine to decide'})).rejects.toMatchObject({reason:'not_found'});
  }
  expect(await events(receipt.id)).toEqual([]);expect(await writes(f.e.employmentId)).toEqual({captures:0,punches:0,days:0,resolutions:0,corrections:0});
 });
 it('still keeps a group admin to expired photos only, while its correction rights read the claim',async()=>{
  const f=await offlineServiceFixture(base),bytes=Buffer.from('retained, not for the group admin'),receipt=await held(f,{photo:bytes}),admin=adminCtx(base);
  expect(await withAttendanceTenant(admin,async tx=>(await tx.execute<{group:boolean;correct:boolean}>(sql`select app.is_group_admin() "group",app.can_correct_attendance(${f.e.employmentId}::uuid) "correct"`))[0])).toEqual({group:true,correct:true});
  expect(await owner.db.select({id:S.mobileOfflinePhoto.claimId}).from(S.mobileOfflinePhoto)).toEqual([{id:receipt.id}]);
  expect(await visible(admin)).toEqual({claims:[receipt.id],photos:[],resolutions:[]});
  await expect(readOfflineClaimPhotoForReview(admin,receipt.id)).rejects.toMatchObject({reason:'forbidden'});
  // An accept is an HR punch correction and writes no capture, so it hands the retained photo to nobody: the group
  // admin's reasoned accept is recorded without reading the photo, and photo custody is unchanged.
  expect(await resolveOfflineClaim(admin,{claimId:receipt.id,decision:'accepted',effectiveAt:whole(f),reason:'Seen elsewhere'})).toMatchObject({decision:'accepted',resolvedBy:admin.userId});
  expect(await writes(f.e.employmentId)).toEqual({captures:0,punches:1,days:1,resolutions:1,corrections:1});
  expect((await events(receipt.id)).filter(event=>event.eventType==='mobile.offline.photo.reviewed')).toEqual([]);
  expect(await owner.db.select({id:S.mobileOfflinePhoto.claimId}).from(S.mobileOfflinePhoto)).toEqual([{id:receipt.id}]);
 });
 it('refuses an expired photo cleanly, and a claim that has none',async()=>{
  const f=await offlineServiceFixture(base),hr=await scopedUser('hr_admin',base.companyId),receipt=await held(f,{photo:Buffer.from('short retention'),retentionMs:2000});
  await after(receipt.photo!.retainedUntil);
  expect(await owner.db.select({id:S.mobileOfflinePhoto.claimId}).from(S.mobileOfflinePhoto)).toEqual([{id:receipt.id}]);
  expect(await visible(hr)).toEqual({claims:[receipt.id],photos:[],resolutions:[]});
  await expect(readOfflineClaimPhotoForReview(hr,receipt.id)).rejects.toMatchObject({reason:'photo_unavailable'});
  const g=await offlineServiceFixture(base),bare=await held(g);
  await expect(readOfflineClaimPhotoForReview(hr,bare.id)).rejects.toMatchObject({reason:'no_photo'});
  expect((await events(receipt.id)).filter(event=>event.eventType==='mobile.offline.photo.reviewed')).toEqual([]);
 });
});

describe('human resolution of a claim held for review',()=>{
 it('accepts at the instant HR chooses inside the proven interval, as an HR punch correction linked to the claim',async()=>{
  const f=await offlineServiceFixture(base),receipt=await held(f,{elapsed:THREE_SECONDS}),hr=await scopedUser('hr_admin',base.companyId),at=whole(f)+2000;
  expect(at).toBeGreaterThanOrEqual(receipt.effectiveMinimum!);expect(at).toBeLessThanOrEqual(receipt.effectiveMaximum!);expect(at).not.toBe(whole(f));
  expect(await writes(f.e.employmentId)).toEqual({captures:0,punches:0,days:0,resolutions:0,corrections:0});
  const baseline=await withAttendanceTenant(hr,tx=>readOfflineClaimResolutionBaselineTx(tx,hr,{claimId:receipt.id,effectiveAt:at}));
  expect(baseline.date).toBe(todayInKualaLumpur(new Date(at)));expect(baseline.revision).toMatch(/^[a-f0-9]{64}$/);
  const result=await resolveOfflineClaim(hr,{claimId:receipt.id,decision:'accepted',effectiveAt:at,reason:'  Gate log confirms the clock-out  ',expectedRevision:baseline.revision});
  expect(result).toMatchObject({claimId:receipt.id,decision:'accepted',effectiveAt:at,reason:'Gate log confirms the clock-out',resolvedBy:hr.userId,dayRevision:baseline.revision,replayed:false});
  expect(result.correctionId).toMatch(/^[0-9a-f-]{36}$/);expect(result.punchId).toMatch(/^[0-9a-f-]{36}$/);
  const [punch]=await owner.db.select().from(S.attendancePunch).where(eq(S.attendancePunch.id,result.punchId!));
  expect(punch).toMatchObject({employmentId:f.e.employmentId,direction:'out',method:'admin',clockCaptureId:null,attendanceDate:baseline.date,voidedAt:null});
  expect(await exact(punch.id,at)).toBe(true);
  // Provenance: claim -> resolution -> the correction's own added punch, at the effective instant, not server time.
  expect(await chain(receipt.id)).toEqual({claimId:receipt.id,correctionId:result.correctionId,punchId:result.punchId,method:'admin',captureId:null,status:'approved',effectiveAt:at,exact:true,added:true});
  expect(await writes(f.e.employmentId)).toEqual({captures:0,punches:1,days:1,resolutions:1,corrections:1});
  // The correction is the resolver's own, with the resolution's reason, against the baseline the resolver decided on.
  expect(await owner.db.select({reason:S.attendanceCorrection.reason,status:S.attendanceCorrection.status,date:S.attendanceCorrection.attendanceDate,clockChanges:S.attendanceCorrection.clockChanges})
   .from(S.attendanceCorrection).where(eq(S.attendanceCorrection.id,result.correctionId!))).toEqual([{reason:'Gate log confirms the clock-out',status:'approved',date:baseline.date,
   clockChanges:{version:1,baseline:baseline.revision,entries:[{punchAt:wall(at),direction:'out'}]}}]);
  const [approved]=await owner.db.select({actorId:S.domainEvent.actorId}).from(S.domainEvent).where(and(eq(S.domainEvent.aggregateId,result.correctionId!),eq(S.domainEvent.eventType,'attendance-correction.approved')));
  expect(approved).toEqual({actorId:hr.userId});
  // Displayed as a correction by HR: the raw clock data shows an 'admin' punch with no offline capture.
  expect((await attendanceClockData(hr,f.e.employmentId,baseline.date)).rows).toEqual([expect.objectContaining({id:result.punchId,method:'admin',captureId:null,clockSource:null,effectiveAt:null})]);
  // The claim row is untouched; the resolution is the decision of record and links the correction and its punch.
  expect(await owner.db.select({outcome:S.mobileOfflineClaim.outcome,reason:S.mobileOfflineClaim.reason,captureId:S.mobileOfflineClaim.captureId,effectiveAt:S.mobileOfflineClaim.effectiveAt}).from(S.mobileOfflineClaim))
   .toEqual([{outcome:'needs_review',reason:'mock_reported',captureId:null,effectiveAt:null}]);
  expect(await owner.db.select({decision:S.mobileOfflineClaimResolution.decision,correctionId:S.mobileOfflineClaimResolution.correctionId,punchId:S.mobileOfflineClaimResolution.punchId,
   effectiveAt:S.mobileOfflineClaimResolution.effectiveAt,resolvedBy:S.mobileOfflineClaimResolution.resolvedBy}).from(S.mobileOfflineClaimResolution))
   .toEqual([{decision:'accepted',correctionId:result.correctionId,punchId:result.punchId,effectiveAt:new Date(at),resolvedBy:hr.userId}]);
  expect(await events(receipt.id)).toEqual([{eventType:'mobile.offline.claim.resolved',actorId:hr.userId,payload:{decision:'accepted',reason:'Gate log confirms the clock-out',heldFor:'mock_reported',
   effectiveAt:new Date(at).toISOString(),correctionId:result.correctionId,punchId:result.punchId,date:baseline.date,dayRevision:baseline.revision}}]);
  // An identical retry, even with the now-stale baseline, returns the recorded resolution and writes nothing.
  expect(await resolveOfflineClaim(hr,{claimId:receipt.id,decision:'accepted',effectiveAt:at,reason:'Gate log confirms the clock-out',expectedRevision:baseline.revision})).toEqual({...result,replayed:true});
  expect(await writes(f.e.employmentId)).toEqual({captures:0,punches:1,days:1,resolutions:1,corrections:1});
  // The employee's own receipt view shows the outcome; it is not anyone else's.
  expect(await ownOfflineClaimResolution(f.ctx,receipt.id)).toEqual({claimId:receipt.id,outcome:'needs_review',reason:'mock_reported',
   resolution:{decision:'accepted',effectiveAt:at,correctionId:result.correctionId,punchId:result.punchId,resolvedAt:result.resolvedAt}});
  expect(await ownOfflineClaimResolution(hr,receipt.id)).toBeNull();
  expect(await visible(f.ctx)).toMatchObject({resolutions:[receipt.id]});
 });
 it('accepts behind the employee\'s later clocking that day, which the live rules refuse, and recomputes the day',async()=>{
  const f=await offlineServiceFixture(base),receipt=await held(f,{elapsed:THREE_SECONDS,action:'in'}),hr=await scopedUser('hr_admin',base.companyId),at=whole(f),later=whole(f)+2000;
  const second=await acceptedLater(f,receipt,later),date=todayInKualaLumpur(new Date(at));
  expect(second).toMatchObject({outcome:'accepted',effectiveAt:later});expect(todayInKualaLumpur(new Date(later))).toBe(date);
  const before=await dayRow(f.e.employmentId,date);
  expect(before).toMatchObject({checkInAt:null});expect(before?.checkOutAt?.slice(0,8)).toBe(wall(later));expect(before?.remarks).not.toBe('Corrected');
  // Non-vacuous: the live clock rules (the previous accept path) refuse this instant behind the later capture.
  expect(await livePlan(f,receipt,{action:'in',at})).toMatchObject({kind:'refused',reason:'clock_conflict'});
  const result=await resolveOfflineClaim(hr,{claimId:receipt.id,decision:'accepted',effectiveAt:at,reason:'Badge log shows the clock-in'});
  expect(result).toMatchObject({decision:'accepted',effectiveAt:at,replayed:false});
  // The day recalculates as any punch correction does: the clock-in lands, the later clock-out is kept, remarks Corrected.
  const after_=await dayRow(f.e.employmentId,date);
  expect(after_?.checkInAt?.slice(0,8)).toBe(wall(at));expect(after_?.checkOutAt?.slice(0,8)).toBe(wall(later));expect(after_?.remarks).toBe('Corrected');
  const live=await owner.db.select({id:S.attendancePunch.id,direction:S.attendancePunch.direction,method:S.attendancePunch.method,captureId:S.attendancePunch.clockCaptureId}).from(S.attendancePunch)
   .where(and(eq(S.attendancePunch.employmentId,f.e.employmentId),isNull(S.attendancePunch.voidedAt))).orderBy(asc(S.attendancePunch.punchAt),asc(S.attendancePunch.id));
  expect(live).toEqual([{id:result.punchId,direction:'in',method:'admin',captureId:null},{id:expect.any(String),direction:'out',method:'mobile_offline',captureId:second.captureId}]);
  expect(await chain(receipt.id)).toMatchObject({punchId:result.punchId,correctionId:result.correctionId,method:'admin',status:'approved',effectiveAt:at,exact:true,added:true});
  expect(await writes(f.e.employmentId)).toEqual({captures:1,punches:2,days:1,resolutions:1,corrections:1});
  // The approved correction now owns the day, as every HR punch correction does: a further clocking there is held.
  await after(later+1000);
  expect(await livePlan(f,receipt,{action:'out',at:later+1000,requestId:randomUUID()})).toMatchObject({kind:'refused',reason:'corrected_day'});
 });
 /** A claim held for `reason` whose employment setting still makes the live rules refuse it for that reason. */
 async function overridden(setting:Partial<typeof S.employment.$inferInsert>,reason:string){
  const f=await offlineServiceFixture(base),receipt=await held(f,{decision:{outcome:'needs_review',reason}}),hr=await scopedUser('hr_admin',base.companyId),at=whole(f);
  await owner.db.update(S.employment).set(setting).where(eq(S.employment.id,f.e.employmentId));
  // Non-vacuous: the live clock rules (the previous accept path) still refuse this claim for the held reason.
  expect(await livePlan(f,receipt,{action:'out',at})).toMatchObject({kind:'refused',reason});
  const result=await resolveOfflineClaim(hr,{claimId:receipt.id,decision:'accepted',effectiveAt:at,reason:'Supervisor confirms the employee was on site'});
  expect(result).toMatchObject({decision:'accepted',effectiveAt:at,replayed:false});
  expect(await chain(receipt.id)).toEqual({claimId:receipt.id,correctionId:result.correctionId,punchId:result.punchId,method:'admin',captureId:null,status:'approved',effectiveAt:at,exact:true,added:true});
  expect(await writes(f.e.employmentId)).toEqual({captures:0,punches:1,days:1,resolutions:1,corrections:1});
  expect(await events(receipt.id)).toMatchObject([{eventType:'mobile.offline.claim.resolved',actorId:hr.userId,payload:{decision:'accepted',heldFor:reason,reason:'Supervisor confirms the employee was on site'}}]);
 }
 it('overrides a geofence hold with HR\'s reasoned decision',async()=>{await overridden({geofencingEnabled:true},'outside_geofence');});
 it('overrides a photo hold with HR\'s reasoned decision',async()=>{await overridden({attendancePhotoSetting:'required'},'photo_required');});
 it('refuses an instant outside the proven interval or not a whole second, and a stale day baseline, writing nothing',async()=>{
  const f=await offlineServiceFixture(base),receipt=await held(f,{elapsed:THREE_SECONDS}),hr=await scopedUser('hr_admin',base.companyId),w=whole(f);
  expect(receipt).toMatchObject({effectiveMinimum:f.context.issuedAt,effectiveMaximum:f.context.issuedAt+3000});
  for(const at of [w-1000,w+4000,w+1500,receipt.effectiveMaximum!+1]){
   await expect(resolveOfflineClaim(hr,{claimId:receipt.id,decision:'accepted',effectiveAt:at,reason:'Outside the evidence'})).rejects.toMatchObject({reason:'effective_time_invalid'});
  }
  await expect(resolveOfflineClaim(hr,{claimId:receipt.id,decision:'accepted',effectiveAt:w,reason:'Stale view',expectedRevision:'f'.repeat(64)})).rejects.toBeInstanceOf(ClockDataChangedError);
  await expect(resolveOfflineClaim(hr,{claimId:receipt.id,decision:'accepted',reason:'No instant'} as never)).rejects.toMatchObject({reason:'invalid_input'});
  await expect(resolveOfflineClaim(hr,{claimId:receipt.id,decision:'accepted',effectiveAt:w,reason:'   '})).rejects.toMatchObject({reason:'invalid_input'});
  expect(await writes(f.e.employmentId)).toEqual({captures:0,punches:0,days:0,resolutions:0,corrections:0});expect(await events(receipt.id)).toEqual([]);
  // Non-vacuous: the same claim accepts at an instant inside the interval.
  expect(await resolveOfflineClaim(hr,{claimId:receipt.id,decision:'accepted',effectiveAt:w+1000,reason:'Inside the evidence'})).toMatchObject({decision:'accepted',effectiveAt:w+1000});
  expect(await writes(f.e.employmentId)).toEqual({captures:0,punches:1,days:1,resolutions:1,corrections:1});
 });
 it('rejects with the resolution alone and no attendance write',async()=>{
  const f=await offlineServiceFixture(base),receipt=await held(f),hr=await scopedUser('hr_admin',base.companyId);
  const result=await resolveOfflineClaim(hr,{claimId:receipt.id,decision:'rejected',reason:'Employee was on leave'});
  expect(result).toMatchObject({decision:'rejected',effectiveAt:null,correctionId:null,punchId:null,dayRevision:null,reason:'Employee was on leave',resolvedBy:hr.userId,replayed:false});
  expect(await writes(f.e.employmentId)).toEqual({captures:0,punches:0,days:0,resolutions:1,corrections:0});
  expect(await events(receipt.id)).toEqual([{eventType:'mobile.offline.claim.resolved',actorId:hr.userId,payload:{decision:'rejected',reason:'Employee was on leave',heldFor:'mock_reported',
   effectiveAt:null,correctionId:null,punchId:null,date:null,dayRevision:null}}]);
  expect(await ownOfflineClaimResolution(f.ctx,receipt.id)).toMatchObject({resolution:{decision:'rejected',effectiveAt:null,correctionId:null,punchId:null}});
  await expect(resolveOfflineClaim(hr,{claimId:receipt.id,decision:'rejected',reason:'With a revision',expectedRevision:'a'.repeat(64)} as never)).rejects.toMatchObject({reason:'invalid_input'});
 });
 it('makes an identical retry idempotent and any different second resolution a conflict',async()=>{
  const f=await offlineServiceFixture(base),receipt=await held(f),hr=await scopedUser('hr_admin',base.companyId),second=await scopedUser('hr_admin',base.companyId);
  const first=await resolveOfflineClaim(hr,{claimId:receipt.id,decision:'rejected',reason:'Duplicate of a web clocking'});
  expect(await resolveOfflineClaim(hr,{claimId:receipt.id,decision:'rejected',reason:'Duplicate of a web clocking'})).toEqual({...first,replayed:true});
  for(const [ctx,input] of [[hr,{decision:'rejected',reason:'A different reason'}],[hr,{decision:'accepted',effectiveAt:whole(f),reason:'Duplicate of a web clocking'}],
   [second,{decision:'rejected',reason:'Duplicate of a web clocking'}]] as const)
   await expect(resolveOfflineClaim(ctx,{claimId:receipt.id,...input})).rejects.toMatchObject({reason:'resolution_conflict'});
  expect(await writes(f.e.employmentId)).toEqual({captures:0,punches:0,days:0,resolutions:1,corrections:0});
  expect((await events(receipt.id)).map(event=>event.eventType)).toEqual(['mobile.offline.claim.resolved']);
 });
 it('refuses on a day closed payroll covers, with the existing reopen error and no writes',async()=>{
  const f=await offlineServiceFixture(base),receipt=await held(f),hr=await scopedUser('hr_admin',base.companyId),a=adminCtx(base),at=whole(f),date=todayInKualaLumpur(new Date(at));
  await setCompensation(a,{employmentId:f.e.employmentId,basicSalary:4000,monthlyAllowance:0,effectiveFrom:'2024-01-01'});
  const {batchId}=await createBatch(a,{companyId:base.companyId,payPeriod:date.slice(0,7)});await generatePayslips(a,{batchId});
  await owner.db.update(S.payrollBatch).set({status:'closed'}).where(eq(S.payrollBatch.id,batchId));
  // Non-vacuous: the correction lock owner, under the resolver's session, names this closed run for that day.
  expect(await withAttendanceTenant(hr,tx=>lockPayrollForAttendanceChange(tx,f.e.employmentId,date))).toEqual([{batchId,status:'closed'}]);
  const refused=resolveOfflineClaim(hr,{claimId:receipt.id,decision:'accepted',effectiveAt:at,reason:'Payroll already closed'});
  await expect(refused).rejects.toBeInstanceOf(AttendancePayrollClosedError);await expect(refused).rejects.toThrow(/Reopen the payroll/);
  expect(await writes(f.e.employmentId)).toEqual({captures:0,punches:0,days:0,resolutions:0,corrections:0});expect(await events(receipt.id)).toEqual([]);
 });
 it('resolves only claims held for review, and accepts only one with a proven interval',async()=>{
  const hr=await scopedUser('hr_admin',base.companyId);
  const f=await offlineServiceFixture(base),refused=await held(f,{decision:{outcome:'refused',reason:'offline_disabled'}});
  expect(refused).toMatchObject({outcome:'refused',reason:'offline_disabled'});
  await expect(resolveOfflineClaim(hr,{claimId:refused.id,decision:'rejected',reason:'Already refused'})).rejects.toMatchObject({reason:'not_resolvable'});
  await expect(resolveOfflineClaim(hr,{claimId:refused.id,decision:'accepted',effectiveAt:whole(f),reason:'Override'})).rejects.toMatchObject({reason:'not_resolvable'});
  const g=await offlineServiceFixture(base),unproven=await held(g,{elapsed:{status:'unknown',reason:'continuity_unknown'}});
  expect(unproven).toMatchObject({outcome:'needs_review',effectiveMinimum:null,effectiveMaximum:null});
  await expect(resolveOfflineClaim(hr,{claimId:unproven.id,decision:'accepted',effectiveAt:whole(g),reason:'Guessing the time'})).rejects.toMatchObject({reason:'effective_time_invalid'});
  expect(await resolveOfflineClaim(hr,{claimId:unproven.id,decision:'rejected',reason:'No proof of time'})).toMatchObject({decision:'rejected'});
  for(const e of [f.e,g.e])expect(await writes(e.employmentId)).toMatchObject({captures:0,punches:0,days:0});
  // The employee reads their own claim but holds no correction rights over it; nobody resolves a claim on their own
  // employment, even holding company HR rights.
  const h=await offlineServiceFixture(base),own=await held(h),self={...h.ctx,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:base.companyId}]};
  await expect(resolveOfflineClaim(h.ctx,{claimId:own.id,decision:'accepted',effectiveAt:whole(h),reason:'Accept my own claim'})).rejects.toMatchObject({reason:'forbidden'});
  await expect(resolveOfflineClaim(self,{claimId:own.id,decision:'rejected',reason:'My own claim'})).rejects.toMatchObject({reason:'self_resolution'});
  await expect(resolveOfflineClaim(self,{claimId:own.id,decision:'accepted',effectiveAt:whole(h),reason:'My own claim'})).rejects.toMatchObject({reason:'self_resolution'});
  expect(await writes(h.e.employmentId)).toEqual({captures:0,punches:0,days:0,resolutions:0,corrections:0});
 });
 it('keeps resolution rows immutable and server-bound',async()=>{
  const f=await offlineServiceFixture(base),receipt=await held(f),hr=await scopedUser('hr_admin',base.companyId);
  const result=await resolveOfflineClaim(hr,{claimId:receipt.id,decision:'rejected',reason:'Immutable decision'});
  const id=sql`${receipt.id}::uuid`;
  for(const statement of [sql`update mobile_offline_claim_resolution set reason='changed' where claim_id=${id}`,sql`delete from mobile_offline_claim_resolution where claim_id=${id}`])
   expect(await failure(owner.db.execute(statement))).toMatch(/Offline evidence is immutable/);
  // The application role has no UPDATE or DELETE grant at all.
  for(const statement of [sql`update mobile_offline_claim_resolution set reason='changed' where claim_id=${id}`,sql`delete from mobile_offline_claim_resolution where claim_id=${id}`])
   expect(await failure(withAttendanceTenant(hr,tx=>tx.execute(statement)))).toMatch(/permission denied/);
  // A second row for the claim, and a direct insert not stamped as the session's own resolver, are refused.
  const row={claim_id:receipt.id,tenant_id:base.tenantId,actor_id:f.ctx.userId,employment_id:f.e.employmentId};
  expect(await failure(withAttendanceTenant(hr,tx=>tx.execute(sql`insert into mobile_offline_claim_resolution(claim_id,tenant_id,actor_id,employment_id,decision,reason,input_digest,resolved_by)
   values(${row.claim_id}::uuid,${row.tenant_id}::uuid,${row.actor_id}::uuid,${row.employment_id}::uuid,'rejected','Again',${'b'.repeat(64)},${hr.userId}::uuid)`)))).toMatch(/duplicate key|mobile_offline_claim_resolution_pkey/);
  // The BEFORE trigger stamps and checks the resolver before the insert policy is evaluated.
  const g=await offlineServiceFixture(base),unresolved=await held(g);
  expect(await failure(withAttendanceTenant(hr,tx=>tx.execute(sql`insert into mobile_offline_claim_resolution(claim_id,tenant_id,actor_id,employment_id,decision,reason,input_digest,resolved_by)
   values(${unresolved.id}::uuid,${base.tenantId}::uuid,${g.ctx.userId}::uuid,${g.e.employmentId}::uuid,'rejected','Forged resolver',${'b'.repeat(64)},${f.ctx.userId}::uuid)`)))).toMatch(/Offline claim resolution unavailable/);
  expect(await writes(g.e.employmentId)).toMatchObject({resolutions:0});
  expect(await owner.db.select({reason:S.mobileOfflineClaimResolution.reason,resolvedAt:S.mobileOfflineClaimResolution.resolvedAt}).from(S.mobileOfflineClaimResolution))
   .toEqual([{reason:'Immutable decision',resolvedAt:new Date(result.resolvedAt)}]);
 });
 it('binds a direct accepted insert to a correction that added its punch for that claim\'s employment',async()=>{
  const f=await offlineServiceFixture(base),receipt=await held(f),hr=await scopedUser('hr_admin',base.companyId);
  const accepted=await resolveOfflineClaim(hr,{claimId:receipt.id,decision:'accepted',effectiveAt:whole(f),reason:'Gate log'});
  const g=await offlineServiceFixture(base),unresolved=await held(g),insert=(correctionId:string,punchId:string)=>withAttendanceTenant(hr,tx=>tx.execute(sql`insert into mobile_offline_claim_resolution
   (claim_id,tenant_id,actor_id,employment_id,decision,effective_at,correction_id,punch_id,day_revision,reason,input_digest,resolved_by)
   values(${unresolved.id}::uuid,${base.tenantId}::uuid,${g.ctx.userId}::uuid,${g.e.employmentId}::uuid,'accepted',${new Date(whole(g)).toISOString()}::timestamptz,${correctionId}::uuid,${punchId}::uuid,
   ${'a'.repeat(64)},'Borrowed correction',${'b'.repeat(64)},${hr.userId}::uuid)`));
  // Another employment's correction and punch, and identifiers that exist nowhere, are both refused by the trigger.
  for(const [correctionId,punchId] of [[accepted.correctionId!,accepted.punchId!],[randomUUID(),randomUUID()]])
   expect(await failure(insert(correctionId,punchId))).toMatch(/Offline claim resolution correction binding mismatch/);
  expect(await writes(g.e.employmentId)).toEqual({captures:0,punches:0,days:0,resolutions:0,corrections:0});
 });
});
