/** The per-company offline clocking settings write (setOfflineClockingPolicy) and its read, on draft 0647 and on a
 * database without it: the attendance policy's own permission (can_admin_payroll_for), the 60..86400 s bounds, one
 * audit event with the previous and new values, every other attendance_policy column untouched, and a clean refusal
 * where the columns do not exist; and the card's two counts, including the definer "phones offline now" count that only
 * the same administrator reads. Real RLS as the application role; the owner reads facts. */
import {randomUUID} from 'node:crypto';
import {and,asc,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as S from '../db/schema';
import {countOfflineClaimsAwaitingReview,countOpenOfflineContexts,readOfflineClockingSettings,setAttendancePolicy,setOfflineClockingPolicy} from '../packs/attendance/service';
import {closeOwnOfflineContext} from '../core/mobile-offline-context';
import {adminCtx,closeAll,harnessSnapshot,owner,resetDb,seedBase,type Base} from './harness';
import {installCustodyDraftForWorker} from './helpers/mobile-custody-draft';
import {installOfflineDraftForWorker} from './helpers/mobile-offline-draft';
import {offlineServiceFixture} from './helpers/mobile-offline-service-fixture';

let base:Base,other:string;
beforeEach(async()=>{
 await resetDb();base=await seedBase();
 [{id:other}]=await owner.db.insert(S.company).values({tenantId:base.tenantId,legalName:'Offline Settings Other Sdn Bhd'}).returning({id:S.company.id});
});
afterAll(async()=>{try{await resetDb();}finally{await closeAll();}});

/** A login with one company-scoped grant, recorded in role_assignment as the session states it. */
async function scopedUser(role:'hr_admin'|'employee',companyId:string):Promise<SessionContext>{
 const [p]=await owner.db.insert(S.person).values({tenantId:base.tenantId,fullName:`Offline settings ${role}`,primaryEmail:`settings_${randomUUID()}@t.local`}).returning({id:S.person.id});
 const [u]=await owner.db.insert(S.appUser).values({tenantId:base.tenantId,workosUserId:`user_${randomUUID()}`,personId:p.id}).returning({id:S.appUser.id});
 await owner.db.insert(S.roleAssignment).values({tenantId:base.tenantId,appUserId:u.id,companyId,role});
 return {tenantId:base.tenantId,userId:u.id,personId:p.id,roles:[role],grants:[{role,companyId}],entitlements:harnessSnapshot(base.tenantId)};
}
const fields={workStart:'08:30',workEnd:'17:30',breakMinutes:45,lateAfter:'08:45',halfDayBefore:'12:30',workingDays:[1,2,3,4,5,6],requireRegisteredDevice:true,geofenceMaximumAccuracyM:40};
/** Every attendance_policy column, read as the owner by name (the draft columns are not in db/schema.ts). */
const row=async(companyId:string)=>(await owner.db.execute<Record<string,unknown>>(sql`select to_jsonb(p) - 'created_at' as row from attendance_policy p where company_id=${companyId}::uuid`)).map(r=>r.row as Record<string,unknown>);
const audit=(companyId:string)=>owner.db.select({eventType:S.domainEvent.eventType,actorId:S.domainEvent.actorId,payload:S.domainEvent.payload}).from(S.domainEvent)
 .where(and(eq(S.domainEvent.tenantId,base.tenantId),eq(S.domainEvent.eventType,'attendance-policy.offline-clocking.updated'),sql`${S.domainEvent.payload}->>'companyId'=${companyId}`)).orderBy(asc(S.domainEvent.sequence));
const installed=async()=>(await owner.db.execute<{installed:boolean}>(sql`select exists(select 1 from pg_attribute where attrelid='attendance_policy'::regclass and attname='offline_clocking_enabled' and not attisdropped) installed`))[0].installed;

// 0647 is journaled for the staging release, so a worker now has its two settings columns. The absent-columns path is
// still the settings owner's defensive refusal (a database the release has not reached), so this case removes exactly
// those two columns for its own duration and restores them byte-for-byte as 0647 defines them.
const OFFLINE_SETTINGS_COLUMNS=sql.raw(`ALTER TABLE attendance_policy ADD COLUMN offline_clocking_enabled boolean NOT NULL DEFAULT false,
 ADD COLUMN offline_max_proven_window_seconds integer NOT NULL DEFAULT 900
  CONSTRAINT attendance_policy_offline_window_ck CHECK(offline_max_proven_window_seconds BETWEEN 60 AND 86400)`);
describe('on a database without draft 0647',()=>{
 let removed=false;
 beforeAll(async()=>{if(await installed()){await owner.db.execute(sql`ALTER TABLE attendance_policy DROP COLUMN offline_clocking_enabled, DROP COLUMN offline_max_proven_window_seconds`);removed=true;}});
 afterAll(async()=>{if(removed){await resetDb();await owner.db.execute(OFFLINE_SETTINGS_COLUMNS);expect(await installed()).toBe(true);}});
 it('refuses the save cleanly, writes nothing, and reads the engine default with no columns',async()=>{
  // Non-vacuous: the columns really are absent here.
  expect(await installed()).toBe(false);
  await setAttendancePolicy(adminCtx(base),{companyId:base.companyId,...fields});
  const before=await row(base.companyId);
  await expect(setOfflineClockingPolicy(adminCtx(base),{companyId:base.companyId,enabled:true,maxProvenWindowSeconds:900})).rejects.toMatchObject({name:'OfflineClockingSettingsError',reason:'unavailable'});
  expect(await row(base.companyId)).toEqual(before);expect(await audit(base.companyId)).toEqual([]);
  expect(await readOfflineClockingSettings(adminCtx(base),base.companyId)).toEqual({columns:false,canEdit:true,policy:{enabled:false,maxProvenWindowSeconds:900}});
  // Only the two settings columns are removed here; 0647's claim and context tables stay, empty, so the counts are zero.
  expect(await countOfflineClaimsAwaitingReview(adminCtx(base),[base.companyId])).toBe(0);
  expect(await countOpenOfflineContexts(adminCtx(base),base.companyId)).toBe(0);
 });
});

describe('on draft 0647',()=>{
 let restore:(()=>Promise<void>)|undefined,restoreCustody:(()=>Promise<void>)|undefined;
 beforeAll(async()=>{restoreCustody=await installCustodyDraftForWorker();restore=await installOfflineDraftForWorker();});
 afterAll(async()=>{await resetDb();await restore?.();await restoreCustody?.();});

 it('writes only the two settings, keeps every other column, and audits the previous and new values',async()=>{
  expect(await installed()).toBe(true);
  const admin=adminCtx(base);
  await setAttendancePolicy(admin,{companyId:base.companyId,...fields});
  const [before]=await row(base.companyId);
  expect(before).toMatchObject({offline_clocking_enabled:false,offline_max_proven_window_seconds:900,work_start:'08:30:00',break_minutes:45,require_registered_device:true});
  const result=await setOfflineClockingPolicy(admin,{companyId:base.companyId,enabled:true,maxProvenWindowSeconds:1800});
  expect(result).toMatchObject({previous:{stored:true,enabled:false,maxProvenWindowSeconds:900},next:{enabled:true,maxProvenWindowSeconds:1800}});
  const [after]=await row(base.companyId);
  expect(after).toEqual({...before,offline_clocking_enabled:true,offline_max_proven_window_seconds:1800});
  await setOfflineClockingPolicy(admin,{companyId:base.companyId,enabled:false,maxProvenWindowSeconds:60});
  expect(await audit(base.companyId)).toEqual([
   {eventType:'attendance-policy.offline-clocking.updated',actorId:admin.userId,payload:{companyId:base.companyId,previous:{stored:true,enabled:false,maxProvenWindowSeconds:900},next:{enabled:true,maxProvenWindowSeconds:1800}}},
   {eventType:'attendance-policy.offline-clocking.updated',actorId:admin.userId,payload:{companyId:base.companyId,previous:{stored:true,enabled:true,maxProvenWindowSeconds:1800},next:{enabled:false,maxProvenWindowSeconds:60}}}]);
  expect(await readOfflineClockingSettings(admin,base.companyId)).toEqual({columns:true,canEdit:true,policy:{enabled:false,maxProvenWindowSeconds:60}});
  // A later save of the schedule keeps the offline settings (it names its own columns only).
  await setAttendancePolicy(admin,{companyId:base.companyId,...fields,breakMinutes:30});
  expect((await row(base.companyId))[0]).toMatchObject({offline_clocking_enabled:false,offline_max_proven_window_seconds:60,break_minutes:30});
 });

 it('creates the row with table defaults for every other column when the company had none, recording the engine default as previous',async()=>{
  expect(await row(other)).toEqual([]);
  const result=await setOfflineClockingPolicy(adminCtx(base),{companyId:other,enabled:true,maxProvenWindowSeconds:86400});
  expect(result.previous).toEqual({stored:false,enabled:false,maxProvenWindowSeconds:900});
  const [created]=await row(other);
  expect(created).toMatchObject({company_id:other,tenant_id:base.tenantId,offline_clocking_enabled:true,offline_max_proven_window_seconds:86400,work_start:'09:00:00',work_end:'18:00:00',
   break_minutes:60,working_days:[1,2,3,4,5],half_working_days:[],require_registered_device:false,geofence_maximum_accuracy_m:null});
 });

 it('refuses values outside 60 to 86400 whole seconds before any write',async()=>{
  const admin=adminCtx(base);
  for(const maxProvenWindowSeconds of [59,86401,0,-60,90.5,Number.NaN])
   await expect(setOfflineClockingPolicy(admin,{companyId:base.companyId,enabled:true,maxProvenWindowSeconds})).rejects.toMatchObject({reason:'invalid_input'});
  await expect(setOfflineClockingPolicy(admin,{companyId:'not-a-company',enabled:true,maxProvenWindowSeconds:900})).rejects.toMatchObject({reason:'invalid_input'});
  expect(await row(base.companyId)).toEqual([]);expect(await audit(base.companyId)).toEqual([]);
  // The bounds themselves are accepted.
  for(const maxProvenWindowSeconds of [60,86400])await setOfflineClockingPolicy(admin,{companyId:base.companyId,enabled:false,maxProvenWindowSeconds});
  expect((await row(base.companyId))[0]).toMatchObject({offline_max_proven_window_seconds:86400});
 });

 it('lets only an administrator of the company\'s attendance policy write, as the policy itself requires',async()=>{
  const own=await scopedUser('hr_admin',base.companyId),foreign=await scopedUser('hr_admin',other),employee=await scopedUser('employee',base.companyId);
  for(const ctx of [foreign,employee])
   await expect(setOfflineClockingPolicy(ctx,{companyId:base.companyId,enabled:true,maxProvenWindowSeconds:900})).rejects.toMatchObject({reason:'forbidden'});
  expect(await row(base.companyId)).toEqual([]);expect(await audit(base.companyId)).toEqual([]);
  expect(await readOfflineClockingSettings(foreign,base.companyId)).toMatchObject({columns:true,canEdit:false});
  // A company of another tenant is refused as forbidden, not created.
  await expect(setOfflineClockingPolicy(own,{companyId:randomUUID(),enabled:true,maxProvenWindowSeconds:900})).rejects.toMatchObject({reason:'forbidden'});
  // Non-vacuous: the company's own administrator does write.
  expect((await setOfflineClockingPolicy(own,{companyId:base.companyId,enabled:true,maxProvenWindowSeconds:600})).next).toEqual({enabled:true,maxProvenWindowSeconds:600});
  expect((await audit(base.companyId)).map(event=>event.actorId)).toEqual([own.userId]);
  expect(await readOfflineClockingSettings(own,base.companyId)).toEqual({columns:true,canEdit:true,policy:{enabled:true,maxProvenWindowSeconds:600}});
 });

 it('counts no waiting punches for a company without held claims, and none for an empty company list',async()=>{
  expect(await countOfflineClaimsAwaitingReview(adminCtx(base),[base.companyId,other])).toBe(0);
  expect(await countOfflineClaimsAwaitingReview(adminCtx(base),[])).toBe(0);
 });

 it('counts a company\'s open offline contexts (not closed, not expired) for its attendance policy administrators only',async()=>{
  vi.stubEnv('AI_CONFIG_SECRET','synthetic-offline-settings-fixture-secret-2026');
  try{
   const [{id:otherDept}]=await owner.db.insert(S.department).values({tenantId:base.tenantId,companyId:other,name:'Offline Settings Other Dept'}).returning({id:S.department.id});
   const open=await offlineServiceFixture(base),closed=await offlineServiceFixture(base);
   await closeOwnOfflineContext(closed.ctx,{contextId:closed.context.id,closeRequestId:randomUUID(),consumedThrough:0});
   // A one-second window, then wait on the DB clock until it has passed.
   const expired=await offlineServiceFixture(base,'ios',{snapshot:async()=>({policy:{revision:'a'.repeat(64),offlineEnabled:true,windowMs:1000,geofencingRequired:false,maximumAccuracyM:null,photoRequirement:'optional'},
    sites:[],attendance:{baseline:'b'.repeat(64),date:'2026-10-27',clockedIn:false,openSince:null},target:{platform:'ios',appId:'ABCDEFGHIJ.ai.hr',environment:'production'},permitCount:2})});
   await offlineServiceFixture({...base,companyId:other,deptA:otherDept});
   const until=new Date(expired.context.expiresAt).toISOString();
   await owner.db.execute(sql`select pg_sleep(greatest(0,extract(epoch from (${until}::timestamptz-clock_timestamp())))+0.05)`);
   // Non-vacuous: the four contexts are what the case says, read as the owner.
   const facts=await owner.db.execute<{id:string;company:string;closed:boolean;expired:boolean}>(sql`select id,company_id company,closed_at is not null closed,expires_at<=clock_timestamp() expired
    from mobile_offline_context order by id`);
   const byId=new Map(facts.map(f=>[f.id,f]));
   expect(facts).toHaveLength(4);
   expect(byId.get(open.context.id)).toMatchObject({company:base.companyId,closed:false,expired:false});
   expect(byId.get(closed.context.id)).toMatchObject({company:base.companyId,closed:true,expired:false});
   expect(byId.get(expired.context.id)).toMatchObject({company:base.companyId,closed:false,expired:true});
   expect(facts.filter(f=>f.company===other)).toMatchObject([{closed:false,expired:false}]);
   // The premise: an administrator's own read of the actor-only rows is a false zero, so the count needs the definer.
   const [direct]=await withTenant(adminCtx(base),tx=>tx.execute<{count:number}>(sql`select count(*)::int count from mobile_offline_context`));
   expect(direct.count).toBe(0);
   const own=await scopedUser('hr_admin',base.companyId),foreign=await scopedUser('hr_admin',other),employee=await scopedUser('employee',base.companyId);
   expect(await countOpenOfflineContexts(adminCtx(base),base.companyId)).toBe(1);
   expect(await countOpenOfflineContexts(own,base.companyId)).toBe(1);
   expect(await countOpenOfflineContexts(adminCtx(base),other)).toBe(1);
   expect(await countOpenOfflineContexts(foreign,other)).toBe(1);
   // Anyone without the settings card's authority gets no count, not a zero: another company's administrator, an
   // employee, and the context's own actor.
   for(const ctx of [foreign,employee,open.ctx])expect(await countOpenOfflineContexts(ctx,base.companyId)).toBeNull();
   const [refused]=await withTenant(employee,tx=>tx.execute<{count:number|null}>(sql`select app.mobile_offline_open_context_count(${base.companyId}::uuid) count`));
   expect(refused.count).toBeNull();
   // A company of no tenant this session reaches, and a value that is not a company id.
   expect(await countOpenOfflineContexts(adminCtx(base),randomUUID())).toBeNull();
   expect(await countOpenOfflineContexts(adminCtx(base),'not-a-company')).toBeNull();
  }finally{vi.unstubAllEnvs();}
 });
});
