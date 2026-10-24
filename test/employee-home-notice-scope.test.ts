import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {createDb,withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {createNotice,duplicateNotice,getNotice,listNotices,noticesForEmployment,publishNotice,updateNotice,archiveNotice,deleteNotice,noticeAudiencePreview,noticeAuthoringScope,type NoticeInput} from '../core/notice';
import {createNoticeSweepAccess,noticeSweepReader,noticeSweepEventReader} from '../core/notice-projection';
import {dispatchNotifications,dispatchNotificationsFromSweep,notificationStillTargets} from '../core/notifications';
import {deliverNotificationEmails,type NotificationEmailTransport} from '../core/notification-email-delivery';
import {saveNotificationEmailPolicy,saveNotificationEmailPreferences} from '../core/notification-email';
import {verifyTenantChain} from '../core/audit-chain';
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
  expect(()=>noticeSweepReader(ctx,{...access,recipients:async()=>[]})).toThrow(/match/);
  downgrade=true;await expect(access.recipients(randomUUID())).rejects.toThrow(/privileged/);
  await expect(createNoticeSweepAccess(ctx,connection)).rejects.toThrow(/privileged/);
 });
 it('leaves the global cursor untouched for scoped humans and lets the sweep deliver once',async()=>{
  const n=await published(null,true),hr=await scoped(),system={...adminCtx(b),userId:undefined};
  expect(await dispatchNotifications(hr)).toEqual({processed:0,created:0});
  expect(await owner.db.select().from(s.notificationCursor).where(eq(s.notificationCursor.tenantId,b.tenantId))).toEqual([]);
  const noticeSweep=await createNoticeSweepAccess(system,owner);
  expect(await noticeSweep.recipients(n.id)).toEqual([n.e.employmentId]);
  expect(await dispatchNotificationsFromSweep(system,owner)).toMatchObject({created:1});
  expect(await dispatchNotificationsFromSweep(system,owner)).toMatchObject({created:0});
  const rows=await owner.db.select().from(s.notification).where(and(eq(s.notification.tenantId,b.tenantId),eq(s.notification.kind,'notice.published')));
  expect(rows).toHaveLength(1);expect(rows[0].recipientEmploymentId).toBe(n.e.employmentId);
  expect(await withTenant(system,tx=>notificationStillTargets(tx,rows[0].sourceEventId!,'notice.published','notice',n.e.employmentId,noticeSweepReader(system,noticeSweep),noticeSweepEventReader(system,noticeSweep)))).toBe(true);
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


describe('Notice audit scope and complete notification cursor authority',()=>{
 it('stamps the real company, retains deleted-draft scope and never exposes it to another company',async()=>{
  const [other]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional event owner'}).returning();
  const n=await createNotice(adminCtx(b),input({companyId:other.id})),hr=await scoped();
  const before=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.aggregateId,n.id));
  expect(before.length).toBeGreaterThan(0);expect(before.every(ev=>(ev.payload as {companyId:string}).companyId===other.id)).toBe(true);
  expect(await withTenant(hr,tx=>tx.select().from(s.domainEvent).where(eq(s.domainEvent.aggregateId,n.id)))).toEqual([]);
  await deleteNotice(adminCtx(b),n.id);
  const after=await withTenant(adminCtx(b),tx=>tx.select().from(s.domainEvent).where(eq(s.domainEvent.aggregateId,n.id)).orderBy(s.domainEvent.sequence));
  expect(after.map(ev=>ev.eventType)).toContain('notice.deleted');
  expect(after.every(ev=>(ev.payload as {companyId:string}).companyId===other.id)).toBe(true);
  expect(await withTenant(hr,tx=>tx.select().from(s.domainEvent).where(eq(s.domainEvent.aggregateId,n.id)))).toEqual([]);
  await owner.db.update(s.roleAssignment).set({companyId:other.id}).where(eq(s.roleAssignment.appUserId,hr.userId!));
  const actual={...hr,grants:[{role:'hr_admin',companyId:other.id}]};
  expect((await withTenant(actual,tx=>tx.select().from(s.domainEvent).where(eq(s.domainEvent.aggregateId,n.id)))).length).toBe(after.length);
 });
 it('refuses forged actor, missing/foreign parent and overwrites caller-supplied event scope',async()=>{
  const hr=await scoped(),n=await createNotice(hr,input({companyId:b.companyId}));
  const event={tenantId:b.tenantId,aggregateType:'notice',aggregateId:n.id,eventType:'notice.updated',actorType:'user' as const,actorId:hr.userId!,payload:{companyId:randomUUID()}};
  const [actual]=await withTenant(hr,tx=>tx.insert(s.domainEvent).values(event).returning());
  expect((actual.payload as {companyId:string}).companyId).toBe(b.companyId);
  expect(await code(withTenant(hr,tx=>tx.insert(s.domainEvent).values({...event,actorId:b.adminUserId})))).toBe('42501');
  expect(await code(withTenant(hr,tx=>tx.insert(s.domainEvent).values({...event,aggregateId:randomUUID()})))).toBe('23514');
  const foreignTenant=randomUUID();await owner.db.insert(s.tenant).values({id:foreignTenant,workosOrgId:'fictional-'+foreignTenant,name:'Fictional foreign tenant'});
  expect(await code(owner.db.insert(s.domainEvent).values({...event,tenantId:foreignTenant}))).toBe('23514');
 });
 it('stamps payload before hashing and refuses verification through a partial scoped audit read',async()=>{
  const n=await createNotice(adminCtx(b),input({companyId:b.companyId}));
  await withTenant(adminCtx(b),async tx=>{
   await tx.execute(sql`select set_config('app.audit_hash_chain','on',true)`);
   await tx.insert(s.domainEvent).values({tenantId:b.tenantId,aggregateType:'notice',aggregateId:n.id,eventType:'notice.updated',actorType:'user',actorId:b.adminUserId,payload:{title:'Fictional changed title'}});
  });
  expect(await verifyTenantChain(adminCtx(b))).toMatchObject({valid:true,checked:1,issues:[]});
  await expect(verifyTenantChain(await scoped())).rejects.toThrow(/Complete current tenant audit authority/);
 });
 it('blocks old nil-user and scoped APP global cursor writes while preserving the reminder cursor',async()=>{
  const hr=await scoped(),system={...adminCtx(b),userId:undefined};
  expect(await code(withTenant(system,tx=>tx.insert(s.notificationCursor).values({tenantId:b.tenantId,lastSequence:1})))).toBe('42501');
  expect(await code(withTenant(hr,tx=>tx.insert(s.notificationCursor).values({tenantId:b.tenantId,lastSequence:1})))).toBe('42501');
  await withTenant(hr,tx=>tx.insert(s.notificationCursor).values({tenantId:b.tenantId,assessmentLastSequence:1}));
  await withTenant(adminCtx(b),tx=>tx.update(s.notificationCursor).set({lastSequence:2}).where(eq(s.notificationCursor.tenantId,b.tenantId)));
  expect(await code(withTenant(system,tx=>tx.update(s.notificationCursor).set({lastSequence:3}).where(eq(s.notificationCursor.tenantId,b.tenantId))))).toBe('42501');
  expect(await code(withTenant(hr,tx=>tx.delete(s.notificationCursor).where(eq(s.notificationCursor.tenantId,b.tenantId))))).toBe('42501');
  await withTenant(hr,tx=>tx.update(s.notificationCursor).set({assessmentLastSequence:2}).where(eq(s.notificationCursor.tenantId,b.tenantId)));
 });
 it('does not borrow a definer current_user when the authenticated connection selected APP',async()=>{
  await owner.db.transaction(async tx=>{
   await tx.execute(sql`CREATE FUNCTION pg_temp.notice_owner_borrow_probe() RETURNS boolean LANGUAGE sql SECURITY DEFINER AS 'SELECT app.notice_projection_connection_owner()'`);
   await tx.execute(sql`SET LOCAL ROLE ai_hr_app`);
   const [row]=await tx.execute(sql`select pg_temp.notice_owner_borrow_probe() as allowed`) as unknown as {allowed:boolean}[];
   expect(row.allowed).toBe(false);
  });
  await expect(dispatchNotificationsFromSweep({...adminCtx(b),userId:undefined},createDb(process.env.TEST_DATABASE_URL!))).rejects.toThrow(/privileged/);
  await expect(dispatchNotificationsFromSweep({...adminCtx(b),userId:undefined,grants:[{role:'hr_admin',companyId:b.companyId}]},owner)).rejects.toThrow(/complete tenant scope/);
  await expect(dispatchNotificationsFromSweep(adminCtx(b),owner)).rejects.toThrow(/maintenance context/);
 });
 it('rolls back business writes and cursor together on a failed canonical projection',async()=>{
  const n=await published(null,true),system={...adminCtx(b),userId:undefined};
  const rejector:Parameters<typeof dispatchNotificationsFromSweep>[1]={withTenant:(ctx,fn,options)=>owner.withTenant(ctx,async tx=>{
   await tx.execute(sql`CREATE FUNCTION pg_temp.reject_board1_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF current_user<>'ai_hr_app' THEN RAISE EXCEPTION 'projection bypassed APP'; END IF; RAISE EXCEPTION 'fictional projection refusal'; END; $$`);
   await tx.execute(sql`CREATE TRIGGER board1_projection_refusal BEFORE INSERT ON notification FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_board1_projection()`);
   return fn(tx);
  },options)};
  const refusal=await dispatchNotificationsFromSweep(system,rejector).then(()=>null,error=>error);
  const messages:string[]=[];for(let item=refusal;item;item=item.cause)messages.push(String(item.message));
  expect(messages.join(' ')).toContain('fictional projection refusal');expect(messages.join(' ')).not.toContain('projection bypassed APP');
  expect(await owner.db.select().from(s.notification).where(eq(s.notification.tenantId,b.tenantId))).toEqual([]);
  expect(await owner.db.select().from(s.notificationCursor).where(eq(s.notificationCursor.tenantId,b.tenantId))).toEqual([]);
  expect(await dispatchNotificationsFromSweep(system,owner)).toMatchObject({created:1});
  const [notification]=await owner.db.select().from(s.notification).where(eq(s.notification.sourceEventId,(await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.aggregateId,n.id),eq(s.domainEvent.eventType,'notice.published'))))[0].id));
  expect(notification.recipientEmploymentId).toBe(n.e.employmentId);
 });
 it('releases a partial DDL lock set while an existing event reader finishes through Notice',async()=>{
  const source=readFileSync(new URL('../db/migrations/0582_employee_home_notice_integrity.sql',import.meta.url),'utf8');
  const start=source.indexOf('DO $$'),end=source.indexOf('--> statement-breakpoint',start);
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start+300);
  const lockSql=source.slice(start,end);
  let readerReady!:()=>void,releaseReader!:()=>void;
  const ready=new Promise<void>(resolve=>{readerReady=resolve;}),release=new Promise<void>(resolve=>{releaseReader=resolve;});
  const reader=owner.db.transaction(async tx=>{await tx.execute(sql`select 1 from domain_event limit 1`);readerReady();await release;await tx.execute(sql`select 1 from notice limit 1`);});
  await ready;let migratorPid=0;
  const migrator=owner.db.transaction(async tx=>{const [row]=await tx.execute(sql`select pg_backend_pid() as pid`) as unknown as {pid:number}[];migratorPid=row.pid;await tx.execute(sql`SET LOCAL statement_timeout='5s'`);await tx.execute(sql.raw(lockSql));});
  try{
   await vi.waitFor(async()=>{expect(migratorPid).toBeGreaterThan(0);const [state]=await owner.db.execute(sql`select wait_event from pg_stat_activity where pid=${migratorPid}`);expect(state?.wait_event).toBe('PgSleep');},{timeout:2000,interval:20});
  }finally{releaseReader();}
  await Promise.all([reader,migrator]);
 });
});
