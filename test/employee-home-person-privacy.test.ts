import {randomUUID} from 'node:crypto';
import {and,asc,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {appUser,domainEvent,employeeHomePersonPrivacyRevision,person,roleAssignment} from '../db/schema';
import {readOwnHomePersonPrivacy,saveOwnHomePersonPrivacy,HomePersonPrivacyAccessError,HomePersonPrivacyChangedError} from '../core/employee-home-person-privacy';
import {resetEmployeeHomePreferences} from '../core/dashboard-prefs';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,caller:SessionContext;
vi.mock('../lib/session',()=>({getSession:async()=>caller}));
const cache=vi.hoisted(()=>vi.fn());
vi.mock('next/cache',()=>({revalidatePath:cache}));
vi.mock('next/navigation',()=>({redirect:(path:string)=>{throw Error('confirmed-redirect:'+path);},unstable_rethrow:()=>{}}));
const {saveHomePersonPrivacyAction}=await import('../app/(app)/me/home/privacy-actions');
async function login(personId?:string):Promise<SessionContext>{
 if(!personId){const [row]=await owner.db.insert(person).values({tenantId:b.tenantId,fullName:'Fictional privacy owner',primaryEmail:randomUUID()+'@example.invalid'}).returning({id:person.id});personId=row.id;}
 const userId=await createAppUser(b.tenantId,personId,'employee');
 return {tenantId:b.tenantId,userId,personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
}
const choices=(expectedOrdinal=0,hideBirthday=true,hideAnniversary=false)=>({expectedOrdinal,hideBirthday,hideAnniversary});
const versions=()=>owner.db.select().from(employeeHomePersonPrivacyRevision).orderBy(asc(employeeHomePersonPrivacyRevision.ordinal));
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{vi.clearAllMocks();await resetDb();b=await seedBase();caller=await login();});
describe('Own-person celebration privacy under real application RLS',()=>{
 it('saves separately across two logins for one person, retaining history and independent cosmetic reset',async()=>{
  const second=await login(caller.personId!);
  expect(await readOwnHomePersonPrivacy(caller)).toEqual({version:1,ordinal:0,hideBirthday:false,hideAnniversary:false});
  expect(await saveOwnHomePersonPrivacy(caller,choices())).toEqual({version:1,ordinal:1,hideBirthday:true,hideAnniversary:false});
  expect(await readOwnHomePersonPrivacy(second)).toEqual({version:1,ordinal:1,hideBirthday:true,hideAnniversary:false});
  await resetEmployeeHomePreferences(caller);expect(await readOwnHomePersonPrivacy(caller)).toMatchObject({ordinal:1,hideBirthday:true});
  await saveOwnHomePersonPrivacy(second,choices(1,true,true));await saveOwnHomePersonPrivacy(second,choices(2,true,true));
  const rows=await versions();expect(rows.map(row=>[row.ordinal,row.hideBirthday,row.hideAnniversary,row.createdByUserId])).toEqual([[1,true,false,caller.userId],[2,true,true,second.userId]]);
  const events=await owner.db.select({payload:domainEvent.payload,actor:domainEvent.actorId}).from(domainEvent)
   .where(and(eq(domainEvent.tenantId,b.tenantId),eq(domainEvent.eventType,'employee-home.person-privacy.updated'))).orderBy(asc(domainEvent.sequence));
  expect(events).toEqual(rows.map(row=>({payload:{revisionId:row.id,ordinal:row.ordinal},actor:row.createdByUserId})));
 });
 it('refuses stale and simultaneous edits rather than allowing another login to silently re-enable disclosure',async()=>{
  const second=await login(caller.personId!);
  const results=await Promise.allSettled([saveOwnHomePersonPrivacy(caller,choices(0,true,false)),saveOwnHomePersonPrivacy(second,choices(0,false,true))]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  const refused=results.find(result=>result.status==='rejected');expect(refused?.status==='rejected'&&refused.reason).toBeInstanceOf(HomePersonPrivacyChangedError);
  const saved=await readOwnHomePersonPrivacy(caller);expect(saved?.ordinal).toBe(1);expect(await readOwnHomePersonPrivacy(second)).toEqual(saved);
  await expect(saveOwnHomePersonPrivacy(caller,choices(0,false,false))).rejects.toBeInstanceOf(HomePersonPrivacyChangedError);expect(await versions()).toHaveLength(1);
 });
 it('limits peers and administrators to their own person, even with broad HR authority',async()=>{
  await saveOwnHomePersonPrivacy(caller,choices());const foreign=await login();
  expect(await readOwnHomePersonPrivacy(foreign)).toMatchObject({ordinal:0,hideBirthday:false});
  expect(await withTenant(foreign,tx=>tx.select().from(employeeHomePersonPrivacyRevision))).toEqual([]);
  expect(await withTenant(adminCtx(b),tx=>tx.select().from(employeeHomePersonPrivacyRevision))).toEqual([]);
  for(const forged of [{...foreign,personId:caller.personId},{...adminCtx(b),personId:caller.personId},{...caller,tenantId:randomUUID()}]){
   await expect(readOwnHomePersonPrivacy(forged)).rejects.toBeInstanceOf(HomePersonPrivacyAccessError);
   await expect(saveOwnHomePersonPrivacy(forged,choices())).rejects.toBeInstanceOf(HomePersonPrivacyAccessError);
  }
  await expect(withTenant(foreign,tx=>tx.insert(employeeHomePersonPrivacyRevision).values({tenantId:b.tenantId,personId:caller.personId!,ordinal:2,hideBirthday:false,hideAnniversary:false,createdByUserId:foreign.userId!}))).rejects.toThrow();
  expect(await versions()).toHaveLength(1);
 });
 it('distinguishes an unlinked login from a load failure and refuses archived or revoked principals',async()=>{
  expect(await readOwnHomePersonPrivacy(adminCtx(b))).toBeNull();
  await expect(saveOwnHomePersonPrivacy(adminCtx(b),choices())).rejects.toBeInstanceOf(HomePersonPrivacyAccessError);
  await owner.db.update(appUser).set({archivedAt:new Date()}).where(eq(appUser.id,caller.userId!));
  await expect(readOwnHomePersonPrivacy(caller)).rejects.toBeInstanceOf(HomePersonPrivacyAccessError);
  await expect(saveOwnHomePersonPrivacy(caller,choices())).rejects.toBeInstanceOf(HomePersonPrivacyAccessError);
  const revoked=await login();await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,revoked.userId!));
  await expect(saveOwnHomePersonPrivacy(revoked,choices())).rejects.toBeInstanceOf(HomePersonPrivacyAccessError);expect(await versions()).toEqual([]);
 });
 it('attests the actual actor and current server time on direct app inserts and refuses ordinal gaps',async()=>{
  const before=Date.now(),fakeDate=new Date(before-86400000);
  const [row]=await withTenant(caller,tx=>tx.insert(employeeHomePersonPrivacyRevision).values({tenantId:b.tenantId,personId:caller.personId!,ordinal:1,hideBirthday:true,hideAnniversary:false,createdByUserId:b.adminUserId,createdAt:fakeDate}).returning());
  expect(row.createdByUserId).toBe(caller.userId);expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before-1000);expect(row.createdAt.getTime()).toBeLessThanOrEqual(Date.now()+1000);
  await expect(withTenant(caller,tx=>tx.insert(employeeHomePersonPrivacyRevision).values({tenantId:b.tenantId,personId:caller.personId!,ordinal:3,hideBirthday:false,hideAnniversary:false,createdByUserId:caller.userId!}))).rejects.toThrow();
  expect(await versions()).toHaveLength(1);
 });
 it('keeps history immutable through the app role and offers no update/delete/truncate grants',async()=>{
  await saveOwnHomePersonPrivacy(caller,choices());
  await expect(withTenant(caller,tx=>tx.update(employeeHomePersonPrivacyRevision).set({hideBirthday:false}))).rejects.toThrow();
  await expect(withTenant(caller,tx=>tx.delete(employeeHomePersonPrivacyRevision))).rejects.toThrow();
  const grants=await owner.db.execute(sql`SELECT privilege,has_table_privilege('ai_hr_app','public.employee_home_person_privacy_revision',privilege) AS allowed FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) privilege ORDER BY privilege`);
  expect([...grants].map(row=>[row.privilege,row.allowed])).toEqual([['DELETE',false],['INSERT',true],['SELECT',true],['TRUNCATE',false],['UPDATE',false]]);
  expect(await readOwnHomePersonPrivacy(caller)).toMatchObject({ordinal:1,hideBirthday:true});
 });
 it('saves and reopens through the rendered form action, while a stale form gets a safe refusal',async()=>{
  const form=new FormData();form.set('expectedOrdinal','0');form.set('hideBirthday','1');
  await expect(saveHomePersonPrivacyAction({error:null},form)).rejects.toThrow('confirmed-redirect:/me/home?privacySaved=1');
  expect(await readOwnHomePersonPrivacy(caller)).toMatchObject({ordinal:1,hideBirthday:true,hideAnniversary:false});
  expect(cache.mock.calls.map(row=>row[0])).toEqual(['/me/home','/','/me/calendar']);
  const unchanged=new FormData();unchanged.set('expectedOrdinal','1');unchanged.set('hideBirthday','1');
  expect(await saveHomePersonPrivacyAction({error:null},unchanged)).toEqual({error:null,alreadySaved:true});expect(await versions()).toHaveLength(1);
  expect(cache).toHaveBeenCalledTimes(3);
  expect(await saveHomePersonPrivacyAction({error:null},form)).toEqual({error:'changed'});
  form.set('personId',randomUUID());expect(await saveHomePersonPrivacyAction({error:null},form)).toEqual({error:'invalid'});expect(await versions()).toHaveLength(1);
 });
});
