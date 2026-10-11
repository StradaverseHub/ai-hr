import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll,beforeAll,beforeEach,describe,expect,it } from 'vitest';
import { and,eq,sql } from 'drizzle-orm';
import { adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base } from './harness';
import { withTenant,type SessionContext } from '../db/client';
import { hireEmployee,setReportingLine } from '../core/org';
import { todayInKualaLumpur } from '../lib/hr-date';
import { dispatchNotifications } from '../core/notifications';
import { deliverNotificationEmails,type NotificationEmailTransport } from '../core/notification-email-delivery';
import { saveNotificationEmailPolicy,saveNotificationEmailPreferences,readNotificationEmailPreferences,retryNotificationEmail } from '../core/notification-email';
import { erasePersonPii } from '../core/pdpa';
import { workflowEmailDatabaseGrants } from '../deploy/identity-email/database';
import * as schema from '../db/schema';
const raw=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:2});
let b:Base;const issuer='https://hr.test/identity/realms/ai-hr';
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'notifications','active');});afterAll(async()=>{await raw.end();await closeAll();});
async function employee(email='employee@example.test'){
 const e=await hireEmployee(adminCtx(b),{person:{fullName:'Email employee',primaryEmail:email},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const userId=await createAppUser(b.tenantId,e.personId,'employee'),subject=randomUUID();
 await owner.db.insert(schema.appExternalIdentity).values({issuer,subject,appUserId:userId});
 const ctx:SessionContext={tenantId:b.tenantId,userId,personId:e.personId,roles:['employee'],entitlements:harnessSnapshot(b.tenantId)};
 return {...e,ctx,identity:{issuer,subject,email,emailVerified:true}};
}
async function event(employmentId:string,type='leave-request.approved',payload:Record<string,unknown>={}){
 const [ev]=await owner.db.insert(schema.domainEvent).values({tenantId:b.tenantId,aggregateType:'test',aggregateId:randomUUID(),eventType:type,actorType:'system',subjectEmploymentId:employmentId,payload}).returning();return ev;
}
async function consent(e:Awaited<ReturnType<typeof employee>>,category='leave'){
 await saveNotificationEmailPolicy(adminCtx(b),[category]);await saveNotificationEmailPreferences(e.ctx,e.employmentId,[category],'en',e.identity);
}
const deliveries=()=>owner.db.select().from(schema.notificationDelivery).where(eq(schema.notificationDelivery.tenantId,b.tenantId)).orderBy(schema.notificationDelivery.id);
async function lease(id:string){const token=randomUUID();await owner.db.update(schema.notificationDelivery).set({leaseToken:token,leaseUntil:new Date(Date.now()+30_000)}).where(eq(schema.notificationDelivery.id,id));return token;}
const target=(id:string,token:string)=>raw`select * from identity_email.delivery_target(${id}::uuid,${token}::uuid,${issuer})`;
describe('workflow email configuration and outbox in the actual database',()=>{
 it('requires both controls and explicit recorded consent; historical enabled preferences do not opt anyone in',async()=>{
  const e=await employee();await event(e.employmentId);await dispatchNotifications(adminCtx(b));expect(await deliveries()).toEqual([]);
  await saveNotificationEmailPolicy(adminCtx(b),['leave']);
  await owner.db.insert(schema.notificationPref).values({tenantId:b.tenantId,recipientEmploymentId:e.employmentId,category:'leave',channel:'email',enabled:true});
  await event(e.employmentId);await dispatchNotifications(adminCtx(b));expect(await deliveries()).toEqual([]);
  await saveNotificationEmailPreferences(e.ctx,e.employmentId,['leave'],'en',e.identity);
  await event(e.employmentId);await dispatchNotifications(adminCtx(b));expect(await deliveries()).toHaveLength(1);
 });
 it('enabling policy and consent does not email an old backlog, and saving on does not discard future events',async()=>{
  const e=await employee();await event(e.employmentId);await consent(e);await dispatchNotifications(adminCtx(b));expect(await deliveries()).toEqual([]);
  await event(e.employmentId);await saveNotificationEmailPolicy(adminCtx(b),['leave']);await saveNotificationEmailPreferences(e.ctx,e.employmentId,['leave'],'ms',e.identity);
  await dispatchNotifications(adminCtx(b));expect(await deliveries()).toHaveLength(1);
  expect((await readNotificationEmailPreferences(e.ctx)).preferences.find(p=>p.category==='leave')?.emailLocale).toBe('ms');
 });
 it('does not link identities by shared email and refuses forged, unverified or foreign consent',async()=>{
  const a=await employee('shared@example.test'),other=await employee('shared@example.test');
  await expect(saveNotificationEmailPreferences(a.ctx,a.employmentId,['leave'],'en',other.identity)).rejects.toThrow('identityRequired');
  await expect(saveNotificationEmailPreferences(a.ctx,other.employmentId,['leave'],'en',a.identity)).rejects.toThrow('forbidden');
  await expect(saveNotificationEmailPreferences(a.ctx,a.employmentId,['leave'],'en',{...a.identity,emailVerified:false})).rejects.toThrow('identityRequired');
  await consent(a);await event(a.employmentId);await event(other.employmentId);await dispatchNotifications(adminCtx(b));
  expect((await deliveries()).map(d=>d.recipientUserId)).toEqual([a.ctx.userId]);
 });
 it('only a group administrator changes tenant category policy, and preferences remain recipient-only under RLS',async()=>{
  const a=await employee(),other=await employee('other@example.test');await consent(other);
  await expect(saveNotificationEmailPolicy(a.ctx,['leave'])).rejects.toThrow('forbidden');
  await expect(saveNotificationEmailPolicy({...adminCtx(b),grants:[{role:'hr_admin',companyId:b.companyId}]},['leave'])).rejects.toThrow('forbidden');
  expect((await readNotificationEmailPreferences(a.ctx)).preferences).toEqual([]);
  await withTenant(a.ctx,async tx=>expect(await tx.select().from(schema.notificationPref)).toEqual([]));
  const foreign=await seedBase();await expect(withTenant({...a.ctx,tenantId:foreign.tenantId,entitlements:harnessSnapshot(foreign.tenantId)},tx=>tx.execute(sql`select app.notification_email_enqueue(${randomUUID()}::uuid,'leave',0)`))).rejects.toMatchObject({cause:expect.objectContaining({code:'42501'})});
 });
 it('serializes concurrent projection and coalesces concurrent employments for one exact account',async()=>{
  const e=await employee();const second=await hireEmployee(adminCtx(b),{person:{id:e.personId},companyId:b.companyId,departmentId:b.deptB,employmentType:'part_time',hiredOn:todayInKualaLumpur()});
  await consent(e);await saveNotificationEmailPreferences(e.ctx,second.employmentId,['leave'],'en',e.identity);
  await event(e.employmentId);const results=await Promise.all([dispatchNotifications(adminCtx(b)),dispatchNotifications(adminCtx(b))]);
  expect(results.reduce((n,r)=>n+r.created,0)).toBe(1);expect(await deliveries()).toHaveLength(1);
  expect(await owner.db.select().from(schema.notification).where(eq(schema.notification.kind,'leave.approved'))).toHaveLength(1);
  const [original]=await owner.db.select().from(schema.notification).where(eq(schema.notification.kind,'leave.approved'));
  const [ev]=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.id,original.sourceEventId!));
  const duplicateId=randomUUID();await owner.db.insert(schema.notification).values({...original,id:duplicateId,recipientEmploymentId:second.employmentId});
  await withTenant(adminCtx(b),tx=>tx.execute(sql`select app.notification_email_enqueue(${duplicateId}::uuid,'leave',${ev.sequence}::bigint)`));expect(await deliveries()).toHaveLength(1);
 });
 it('rechecks revoked identity, consent, category permission, archived login and employment before private delivery',async()=>{
  const e=await employee();await consent(e);await event(e.employmentId);await dispatchNotifications(adminCtx(b));const [job]=await deliveries(),token=await lease(job.id);
  expect(await target(job.id,token)).toHaveLength(1);
  await owner.db.update(schema.appExternalIdentity).set({revokedAt:new Date()}).where(eq(schema.appExternalIdentity.appUserId,e.ctx.userId!));expect(await target(job.id,token)).toEqual([]);
  await owner.db.update(schema.appExternalIdentity).set({revokedAt:null});await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,e.ctx.userId!));expect(await target(job.id,token)).toEqual([]);
  await owner.db.update(schema.appUser).set({archivedAt:null});
  await saveNotificationEmailPolicy(adminCtx(b),[]);expect(await target(job.id,token)).toEqual([]);
  await owner.db.update(schema.notificationEmailPolicy).set({enabled:true}).where(eq(schema.notificationEmailPolicy.tenantId,b.tenantId));
  await owner.db.update(schema.employment).set({blacklistedAt:todayInKualaLumpur()}).where(eq(schema.employment.id,e.employmentId));expect(await target(job.id,token)).toEqual([]);
  await owner.db.update(schema.employment).set({blacklistedAt:null}).where(eq(schema.employment.id,e.employmentId));
  const foreign=await seedBase();
  expect(await withTenant(adminCtx(foreign),tx=>tx.execute(sql`select * from app.notification_email_due(50)`))).toEqual([]);
  await withTenant(adminCtx(foreign),tx=>tx.execute(sql`select app.notification_email_enqueue(${job.notificationId}::uuid,'leave',0)`));expect(await deliveries()).toHaveLength(1);
  await saveNotificationEmailPreferences(e.ctx,e.employmentId,[],'en',null);expect(await target(job.id,token)).toEqual([]);
 });
 it('does not queue disabled categories or withdrawn consent even when an earlier delivery was eligible',async()=>{
  const e=await employee();await consent(e);await event(e.employmentId);await dispatchNotifications(adminCtx(b));expect(await deliveries()).toHaveLength(1);
  await saveNotificationEmailPolicy(adminCtx(b),[]);await event(e.employmentId);await dispatchNotifications(adminCtx(b));expect(await deliveries()).toHaveLength(1);
  await saveNotificationEmailPolicy(adminCtx(b),['leave']);await saveNotificationEmailPreferences(e.ctx,e.employmentId,[],'en',null);
  await event(e.employmentId);await dispatchNotifications(adminCtx(b));expect(await deliveries()).toHaveLength(1);
 });
 it('rejects a target changed after private identity verification and before the atomic start',async()=>{
  const e=await employee();await consent(e);await event(e.employmentId);await dispatchNotifications(adminCtx(b));const [job]=await deliveries(),token=await lease(job.id),[expected]=await target(job.id,token);
  await owner.db.update(schema.person).set({primaryEmail:'changed@example.test'}).where(eq(schema.person.id,e.personId));
  expect(await target(job.id,token)).toHaveLength(1);
  expect((await raw`select identity_email.start_delivery(${job.id}::uuid,${token}::uuid,${issuer},${raw.json(expected)}::jsonb) as started`)[0].started).toBe(false);
  expect((await deliveries())[0]).toMatchObject({attempts:0,startedAt:null});
 });
 it('prevents two private requests from starting one SMTP attempt, and a duplicate skip cannot overwrite a started attempt',async()=>{
  const e=await employee();await consent(e);await event(e.employmentId);await dispatchNotifications(adminCtx(b));const [job]=await deliveries(),token=await lease(job.id);
  const [expected]=await target(job.id,token);
  const start=()=>raw`select identity_email.start_delivery(${job.id}::uuid,${token}::uuid,${issuer},${raw.json(expected)}::jsonb) as started`;
  const starts=await Promise.all([start(),start()]);expect(starts.filter(r=>r[0].started)).toHaveLength(1);
  expect(await target(job.id,token)).toEqual([]);
  expect((await raw`select identity_email.finish_delivery(${job.id}::uuid,${token}::uuid,'skipped','notEligible') as finished`)[0].finished).toBe(false);
  expect((await deliveries())[0]).toMatchObject({status:'pending',attempts:1});
  await raw`select identity_email.finish_delivery(${job.id}::uuid,${token}::uuid,'sent',null)`;expect((await deliveries())[0].status).toBe('sent');
 });
 it('holds abandoned started sends as uncertain; only an acknowledged administrative retry can reopen them',async()=>{
  const e=await employee();await consent(e);await event(e.employmentId);await dispatchNotifications(adminCtx(b));const [job]=await deliveries(),token=await lease(job.id);
  const [expected]=await target(job.id,token);await raw`select identity_email.start_delivery(${job.id}::uuid,${token}::uuid,${issuer},${raw.json(expected)}::jsonb)`;
  await owner.db.update(schema.notificationDelivery).set({leaseUntil:new Date(Date.now()-1000)}).where(eq(schema.notificationDelivery.id,job.id));
  await withTenant(adminCtx(b),tx=>tx.execute(sql`select * from app.notification_email_due(50)`));expect((await deliveries())[0]).toMatchObject({status:'failed',lastError:'uncertain'});
  await expect(retryNotificationEmail(adminCtx(b),job.id,false)).rejects.toThrow('invalid');await retryNotificationEmail(adminCtx(b),job.id,true);
  expect((await deliveries())[0]).toMatchObject({status:'pending',attempts:0,startedAt:null,lastError:null});
 });
 it('reauthorizes the live manager graph instead of emailing a former approver',async()=>{
  const subject=await employee(),manager=await employee('manager@example.test'),replacement=await employee('replacement@example.test');
  await consent(manager,'attendance');await setReportingLine(adminCtx(b),{subordinateEmploymentId:subject.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:todayInKualaLumpur()});
  await event(subject.employmentId,'attendance-correction.requested',{requestedOtMinutes:120});await dispatchNotifications(adminCtx(b));expect(await deliveries()).toHaveLength(1);
  await owner.db.update(schema.reportingLine).set({managerEmploymentId:replacement.employmentId}).where(eq(schema.reportingLine.subordinateEmploymentId,subject.employmentId));
  const transport:NotificationEmailTransport=async<T>(_request:Parameters<NotificationEmailTransport>[0])=>({version:1,ready:true} as T);
  expect(await deliverNotificationEmails(adminCtx(b),transport)).toMatchObject({attempted:0,skipped:1});expect((await deliveries())[0]).toMatchObject({status:'skipped',lastError:'notEligible'});
 });
 it('revokes external email consent on contact erasure',async()=>{
  const e=await employee();await consent(e);const result=await erasePersonPii(adminCtx(b),{subjectEmploymentId:e.employmentId,scope:'contact',reason:'subject request',requestRef:'EMAIL-ERASURE'});
  expect(result.erased).toContain('workflowEmailConsent');expect((await readNotificationEmailPreferences(e.ctx)).preferences.every(p=>!p.enabled&&p.emailConsentUserId===null)).toBe(true);
 });
 it('grants the service only the private delivery operations and no HR table or shared app helper access',async()=>{
  const role='workflow_email_'+randomUUID().replaceAll('-','');await raw.unsafe(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  try{
   await raw.unsafe(`GRANT USAGE ON SCHEMA identity_email TO "${role}"`);for(const grant of workflowEmailDatabaseGrants(role))await raw.unsafe(grant);
   await raw.begin(async tx=>{await tx.unsafe(`SET LOCAL ROLE "${role}"`);expect((await tx`select has_schema_privilege(current_user,'app','USAGE') allowed`)[0].allowed).toBe(false);expect(await tx`select * from identity_email.delivery_target(${randomUUID()}::uuid,${randomUUID()}::uuid,${issuer})`).toEqual([]);});
   for(const query of ['select * from public.person','select * from public.notification_pref','select * from public.notification_delivery','select app.notification_email_due(50)'])await expect(raw.begin(async tx=>{await tx.unsafe(`SET LOCAL ROLE "${role}"`);return tx.unsafe(query);})).rejects.toThrow(/permission denied/);
   expect((await raw`select has_function_privilege('ai_hr_app','identity_email.delivery_target(uuid,uuid,text)','EXECUTE') allowed`)[0].allowed).toBe(false);
  }finally{await raw.unsafe(`DROP OWNED BY "${role}"`);await raw.unsafe(`DROP ROLE "${role}"`);}
 });
});
