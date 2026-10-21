import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {createDb,withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {createNotice,duplicateNotice,getNotice,listNotices,noticesForEmployment,publishNotice,updateNotice,archiveNotice,noticeAudiencePreview,noticeAuthoringScope,type NoticeInput} from '../core/notice';
import {createNoticeSweepAccess,noticeSweepReader} from '../core/notice-projection';
import {dispatchNotifications,notificationStillTargets} from '../core/notifications';
import {deliverNotificationEmails,type NotificationEmailTransport} from '../core/notification-email-delivery';
import {saveNotificationEmailPolicy,saveNotificationEmailPreferences} from '../core/notification-email';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'notifications','active');});
const input=(more:Partial<NoticeInput>={}):NoticeInput=>({title:'Fictional scoped notice',body:'Fictional authorized content.',startOn:todayInKualaLumpur(),endOn:todayInKualaLumpur(),...more});
async function scoped(personId?:string){
 personId??=(await employee()).personId;
 const userId=await createAppUser(b.tenantId,personId,'hr_admin');
 await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,userId));
 return {...adminCtx(b),userId,personId,grants:[{role:'hr_admin',companyId:b.companyId}]};
}
async function employee(companyId=b.companyId){
 let departmentId=b.deptA;
 if(companyId!==b.companyId){const [d]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId,name:'Fictional other department'}).returning();departmentId=d.id;}
 const e=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional notice recipient',primaryEmail:randomUUID()+'@example.invalid'},companyId,departmentId,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const userId=await createAppUser(b.tenantId,e.personId,'employee');
 return {...e,ctx:{...adminCtx(b),userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]} as SessionContext};
}
async function code(promise:Promise<unknown>){try{await promise;return null;}catch(error){let item=error as {code?:string;cause?:unknown};while(item){if(item.code)return item.code;item=item.cause as typeof item;}throw error;}}
async function published(companyId?:string|null,notify=false){
 const e=await employee();const n=await createNotice(adminCtx(b),input({companyId,targetMode:'individual',employmentIds:[e.employmentId],notifyOnPublish:notify}));
 await publishNotice(adminCtx(b),n.id);return {...n,e};
}
describe('Notice authoring scope and immutable publication membership',()=>{
 it('permits actual company authoring, retains ownership on copy, and refuses a forged group grant',async()=>{
  const hr=await scoped(),n=await createNotice(hr,input({companyId:b.companyId}));
  expect((await getNotice(hr,n.id))?.ownerCompanyId).toBe(b.companyId);
  expect((await getNotice(hr,(await duplicateNotice(hr,n.id)).id))?.ownerCompanyId).toBe(b.companyId);
  expect(await noticeAuthoringScope(hr)).toMatchObject({groupAllowed:false,companies:[{id:b.companyId}]});
  await expect(updateNotice(hr,n.id,input({companyId:null}))).rejects.toThrow(/fixed/);
  expect(await code(createNotice(hr,input()))).toBe('42501');
  const forged={...hr,grants:[{role:'hr_admin',companyId:null}]};
  expect(await code(createNotice(forged,input({companyId:b.companyId})))).toBe('42501');
  expect(await listNotices(forged)).toEqual([]);
 });
 it('keeps a recipient reading path separate from authority over the administrator editor',async()=>{
  const n=await published(),hr=await scoped(n.e.personId);
  expect((await noticesForEmployment(hr,n.e.employmentId)).map(row=>row.id)).toContain(n.id);
  expect(await getNotice(hr,n.id)).toBeNull();
  await expect(updateNotice(hr,n.id,input())).rejects.toThrow(/found/);
  await expect(archiveNotice(hr,n.id)).rejects.toThrow(/found/);
  await expect(duplicateNotice(hr,n.id)).rejects.toThrow(/found/);
  expect((await getNotice(adminCtx(b),n.id))?.body).toBe(input().body);
 });
 it('refuses a publication containing targets outside its stable company boundary without a partial snapshot',async()=>{
  const own=await employee(),[other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional other notice company'}).returning();
  const foreign=await employee(other.id),n=await createNotice(adminCtx(b),input({companyId:b.companyId,targetMode:'individual',employmentIds:[own.employmentId,foreign.employmentId]}));
  expect(await noticeAudiencePreview(adminCtx(b),n.id)).toEqual({count:1,incomplete:true,unrestricted:false});
  await expect(publishNotice(adminCtx(b),n.id)).rejects.toThrow(/authoring scope/);
  expect(await owner.db.select().from(s.noticeRecipient).where(eq(s.noticeRecipient.noticeId,n.id))).toEqual([]);
  expect((await getNotice(adminCtx(b),n.id))?.publishedAt).toBeNull();
 });
 it('previews an unfiltered company notice within its owner and publishes that exact audience',async()=>{
  const own=await employee(),[other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional excluded company'}).returning();
  await employee(other.id);
  const n=await createNotice(adminCtx(b),input({companyId:b.companyId}));
  expect(await noticeAudiencePreview(adminCtx(b),n.id)).toEqual({count:1,incomplete:false,unrestricted:false});
  expect(await publishNotice(adminCtx(b),n.id)).toEqual({recipients:1});
  const rows=await owner.db.select().from(s.noticeRecipient).where(eq(s.noticeRecipient.noticeId,n.id));expect(rows.map(row=>row.employmentId)).toEqual([own.employmentId]);
 });
 it('refuses direct scope movement, unpublication and published membership insertion/deletion',async()=>{
  const n=await published(b.companyId),extra=await employee(),a=adminCtx(b);
  expect(await code(withTenant(a,tx=>tx.update(s.notice).set({ownerCompanyId:null}).where(eq(s.notice.id,n.id))))).toBe('23514');
  expect(await code(withTenant(a,tx=>tx.update(s.notice).set({publishedAt:null,publishedByUserId:null}).where(eq(s.notice.id,n.id))))).toBe('23514');
  const insertion=await code(withTenant(a,tx=>tx.insert(s.noticeRecipient).values({tenantId:b.tenantId,noticeId:n.id,employmentId:extra.employmentId})));
  expect(insertion).toBe('23514');
  expect(await code(withTenant(a,tx=>tx.delete(s.noticeRecipient).where(eq(s.noticeRecipient.noticeId,n.id))))).toBe('23514');
  expect(await code(withTenant(a,tx=>tx.delete(s.notice).where(eq(s.notice.id,n.id))))).toBe('23514');
 });
});

describe('A maintenance connection supplies only a tenant-bound notice audience read',()=>{
 it('refuses APP, a downgraded effective role, a human context and a changed tenant',async()=>{
  const ctx={...adminCtx(b),userId:undefined},app=createDb(process.env.TEST_DATABASE_URL!);
  await expect(createNoticeSweepAccess(ctx,app)).rejects.toThrow(/privileged/);
  await expect(createNoticeSweepAccess(adminCtx(b),owner)).rejects.toThrow(/maintenance context/);
  let downgrade=false;
  const connection:Parameters<typeof createNoticeSweepAccess>[1]={withTenant:(context,fn,options)=>owner.withTenant(context,async tx=>{if(downgrade)await tx.execute(sql`SET LOCAL ROLE ai_hr_app`);return fn(tx);},options)};
  const access=await createNoticeSweepAccess(ctx,connection);
  expect(()=>noticeSweepReader({...ctx,tenantId:randomUUID()},access)).toThrow(/match/);
  downgrade=true;await expect(access.recipients(randomUUID())).rejects.toThrow(/privileged/);
  await expect(createNoticeSweepAccess(ctx,connection)).rejects.toThrow(/privileged/);
 });
 it('rolls back a partial scoped projection and lets the existing sweep deliver the frozen audience once',async()=>{
  const n=await published(null,true),hr=await scoped(),system={...adminCtx(b),userId:undefined};
  await expect(dispatchNotifications(hr)).rejects.toThrow(/complete authorized audience/);
  expect(await owner.db.select().from(s.notificationCursor).where(eq(s.notificationCursor.tenantId,b.tenantId))).toEqual([]);
  const noticeSweep=await createNoticeSweepAccess(system,owner);
  expect(await noticeSweep.recipients(n.id)).toEqual([n.e.employmentId]);
  expect(await dispatchNotifications(system,{noticeSweep})).toMatchObject({created:1});
  expect(await dispatchNotifications(system,{noticeSweep})).toMatchObject({created:0});
  const rows=await owner.db.select().from(s.notification).where(and(eq(s.notification.tenantId,b.tenantId),eq(s.notification.kind,'notice.published')));
  expect(rows).toHaveLength(1);expect(rows[0].recipientEmploymentId).toBe(n.e.employmentId);
  expect(await withTenant(system,tx=>notificationStillTargets(tx,rows[0].sourceEventId!,'notice.published','notice',n.e.employmentId,noticeSweepReader(system,noticeSweep)))).toBe(true);
  expect(await noticeSweep.recipients(randomUUID())).toEqual([]);
 });
 it('keeps a queued notice email pending on missing scoped authority rather than cancelling it',async()=>{
  const e=await employee(),email=(await owner.db.select().from(s.person).where(eq(s.person.id,e.personId)))[0].primaryEmail!;
  const identity={issuer:'https://fictional-home.example.invalid/identity',subject:randomUUID(),email,emailVerified:true};
  await owner.db.insert(s.appExternalIdentity).values({issuer:identity.issuer,subject:identity.subject,appUserId:e.ctx.userId!});
  await saveNotificationEmailPolicy(adminCtx(b),['notice']);
  await saveNotificationEmailPreferences(e.ctx,e.employmentId,['notice'],'en',identity);
  const n=await createNotice(adminCtx(b),input({targetMode:'individual',employmentIds:[e.employmentId],notifyOnPublish:true}));await publishNotice(adminCtx(b),n.id);
  await dispatchNotifications(adminCtx(b));
  const offline:NotificationEmailTransport=async<T>()=>({version:1,ready:false} as T);
  await expect(deliverNotificationEmails(await scoped(),offline)).rejects.toThrow(/complete authorized audience/);
  const [pending]=await owner.db.select().from(s.notificationDelivery).where(eq(s.notificationDelivery.tenantId,b.tenantId));expect(pending.status).toBe('pending');expect(pending.startedAt).toBeNull();
  const system={...adminCtx(b),userId:undefined},noticeSweep=await createNoticeSweepAccess(system,owner);
  expect(await deliverNotificationEmails(system,offline,{noticeSweep})).toMatchObject({attempted:1,skipped:0,unavailable:true});
  const [final]=await owner.db.select().from(s.notificationDelivery).where(eq(s.notificationDelivery.id,pending.id));expect(final.lastError).toBe('relayUnavailable');
 });
});
