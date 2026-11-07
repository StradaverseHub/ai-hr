import * as schema from '../db/schema';
import {DEFAULT_RATING_SCALE} from '../packs/performance/service';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {dispatchNotifications,dispatchNotificationsFromSweep} from '../core/notifications';
import {hireEmployee} from '../core/org';
import {withTenant} from '../db/client';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule} from './harness';

beforeAll(migrateTestDb);afterAll(closeAll);
async function fixture(){
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'notifications','active');
 const ctx=adminCtx(b),subject=await hireEmployee(ctx,{person:{fullName:'Fictional ledger subject',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 await dispatchNotifications(ctx);return {b,ctx,subject};
}
async function insert(tenant:string,subject:string,eventType='toil.accrued'){
 const id=randomUUID();await owner.client`insert into domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,subject_employment_id,payload)
 values(${id}::uuid,${tenant}::uuid,'ledger-test',${id}::uuid,${eventType},'system',${subject}::uuid,'{"daysCredited":1}'::jsonb)`;return id;
}
it('serializes concurrent consumers and records unmapped events once',async()=>{
 const {b,ctx,subject}=await fixture();
 const mapped=await insert(b.tenantId,subject.employmentId),ignored=await insert(b.tenantId,subject.employmentId,'ledger.unmapped');
 const results=await Promise.all([dispatchNotifications(ctx),dispatchNotifications(ctx),dispatchNotifications(ctx)]);
 expect(results.reduce((n,r)=>n+r.created,0)).toBe(1);expect(results.reduce((n,r)=>n+r.processed,0)).toBe(2);
 const receipts=await owner.client`select event_id,disposition from notification_event_processing where event_id in (${mapped}::uuid,${ignored}::uuid)`;
 expect(receipts).toEqual(expect.arrayContaining([{event_id:mapped,disposition:'processed'},{event_id:ignored,disposition:'ignored'}]));
 expect(await dispatchNotifications(ctx)).toEqual({processed:0,created:0});
});
it('rolls back notifications and receipts together when acknowledgement fails, then recovers',async()=>{
 const {b,ctx,subject}=await fixture(),id=await insert(b.tenantId,subject.employmentId);
 await owner.client.unsafe(`CREATE FUNCTION public.ledger_test_refuse_ack() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_id='${id}'::uuid THEN RAISE EXCEPTION 'controlled acknowledgement failure'; END IF; RETURN NEW; END $$`);
 await owner.client`CREATE TRIGGER ledger_test_refuse_ack BEFORE UPDATE ON notification_event_processing FOR EACH ROW EXECUTE FUNCTION public.ledger_test_refuse_ack()`;
 try{
  await expect(dispatchNotifications(ctx)).rejects.toThrow();
  expect(await owner.client`select id from notification where source_event_id=${id}::uuid`).toHaveLength(0);
  const [pending]=await owner.client`select disposition,processed_at from notification_event_processing where event_id=${id}::uuid`;
  expect(pending).toEqual({disposition:null,processed_at:null});
 }finally{
  await owner.client`DROP TRIGGER ledger_test_refuse_ack ON notification_event_processing`;
  await owner.client`DROP FUNCTION public.ledger_test_refuse_ack()`;
 }
 expect((await dispatchNotifications(ctx)).created).toBe(1);
 expect((await dispatchNotifications(ctx)).created).toBe(0);
});
it.each(['web','sweep'] as const)('does not repeat a projection made by an older dispatcher during overlap (%s)',async mode=>{
 const {b,ctx,subject}=await fixture(),id=await insert(b.tenantId,subject.employmentId);
 await owner.client`insert into notification(tenant_id,recipient_employment_id,kind,title,body,severity,source_event_id)
 values(${b.tenantId}::uuid,${subject.employmentId}::uuid,'toil.accrued','Preserved old projection','Preserved body','info',${id}::uuid)`;
 const result=mode==='web'?await dispatchNotifications(ctx):await dispatchNotificationsFromSweep({...ctx,userId:undefined,personId:undefined},owner);
 expect(result).toEqual({processed:1,created:0});
 const notifications=await owner.client`select title from notification where source_event_id=${id}::uuid`;
 expect(notifications).toEqual([{title:'Preserved old projection'}]);
});
it('does not expose or acknowledge another actor’s projection work through the application role',async()=>{
 const {b,subject}=await fixture(),id=await insert(b.tenantId,subject.employmentId);
 const userId=await createAppUser(b.tenantId,subject.personId,'employee');
 const ctx={tenantId:b.tenantId,userId,personId:subject.personId,roles:['employee']};
 await withTenant(ctx,async tx=>{
  expect(await tx.execute(sql`select event_id from notification_event_processing where event_id=${id}::uuid`)).toHaveLength(0);
  expect(await tx.execute(sql`update notification_event_processing set disposition='processed',processed_at=now() where event_id=${id}::uuid returning event_id`)).toHaveLength(0);
 });
 const [pending]=await owner.client`select disposition from notification_event_processing where event_id=${id}::uuid`;expect(pending.disposition).toBeNull();
});
it('allows owner event retention while retaining already delivered notifications',async()=>{
 const {b,ctx,subject}=await fixture(),id=await insert(b.tenantId,subject.employmentId);
 expect((await dispatchNotifications(ctx)).created).toBe(1);
 expect(await owner.client`select event_id from notification_event_processing where event_id=${id}::uuid`).toHaveLength(1);
 await expect(withTenant(ctx,tx=>tx.execute(sql`delete from notification_event_processing where event_id=${id}::uuid`))).rejects.toThrow();
 expect(await owner.client`delete from domain_event where id=${id}::uuid returning id`).toEqual([{id}]);
 expect(await owner.client`select event_id from notification_event_processing where event_id=${id}::uuid`).toHaveLength(0);
 expect(await owner.client`select source_event_id from notification where source_event_id=${id}::uuid`).toEqual([{source_event_id:id}]);
});
it('upgrades a populated cursor without replaying historical events and enqueues later writes atomically',async()=>{
 const {b,subject}=await fixture();const stop=new Error('Rollback isolated migration rehearsal');
 await expect(owner.client.begin(async tx=>{
  await tx`DROP TRIGGER notification_event_processing_enqueue ON domain_event`;
  await tx`DROP FUNCTION app.notification_event_processing_enqueue()`;
  await tx`DROP TABLE notification_event_processing`;
  await tx`DROP INDEX notification_source_recipient_kind_idx`;
  await tx`DROP FUNCTION app.notification_projection_exists(uuid,uuid,text)`;
  const oldId=randomUUID(),pendingId=randomUUID();
  const [old]=await tx`insert into domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,subject_employment_id,payload) values(${oldId}::uuid,${b.tenantId}::uuid,'ledger-test',${oldId}::uuid,'toil.accrued','system',${subject.employmentId}::uuid,'{}'::jsonb) returning sequence`;
  await tx`update notification_cursor set last_sequence=${old.sequence} where tenant_id=${b.tenantId}::uuid`;
  await tx`insert into domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,subject_employment_id,payload) values(${pendingId}::uuid,${b.tenantId}::uuid,'ledger-test',${pendingId}::uuid,'toil.accrued','system',${subject.employmentId}::uuid,'{}'::jsonb)`;
  const migration=readFileSync(new URL('../db/migrations/2504_notification_event_processing.sql',import.meta.url),'utf8');
  for(const statement of migration.split('--> statement-breakpoint'))if(statement.trim())await tx.unsafe(statement);
  const rows=await tx`select event_id,disposition from notification_event_processing where event_id in (${oldId}::uuid,${pendingId}::uuid)`;
  expect(rows).toEqual(expect.arrayContaining([{event_id:oldId,disposition:'legacy-cursor'},{event_id:pendingId,disposition:null}]));
  const rollbackId=randomUUID();
  await expect(tx.savepoint(async nested=>{
   await nested`insert into domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,payload) values(${rollbackId}::uuid,${b.tenantId}::uuid,'ledger-test',${rollbackId}::uuid,'ledger.unmapped','system','{}'::jsonb)`;
   expect(await nested`select event_id from notification_event_processing where event_id=${rollbackId}::uuid`).toHaveLength(1);
   throw stop;
  })).rejects.toBe(stop);
  expect(await tx`select event_id from notification_event_processing where event_id=${rollbackId}::uuid`).toHaveLength(0);
  throw stop;
 })).rejects.toBe(stop);
});

it('does not let company-A HR consume company-B assessment receipts through broad audit-event visibility',async()=>{
 const {b}=await fixture();
 const [other]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional company B'}).returning();
 await setModule(b.tenantId,'performance','active');
 await setModule(b.tenantId,'notifications','disabled');
 for(const id of [b.companyId,other.id])await setModule(b.tenantId,'notifications','active',id);
 async function actor(companyId:string){
  const userId=await createAppUser(b.tenantId,null,'hr_admin');
  await owner.db.update(schema.roleAssignment).set({companyId}).where(eq(schema.roleAssignment.appUserId,userId));
  return {...adminCtx(b),userId,grants:[{role:'hr_admin',companyId}]};
 }
 const a=await actor(b.companyId),authorized=await actor(other.id);
 const [cycle]=await owner.db.insert(schema.reviewCycle).values({tenantId:b.tenantId,companyId:other.id,name:'Fictional scoped reminder cycle',periodStart:'2026-01-01',periodEnd:'2026-12-31',ratingScale:DEFAULT_RATING_SCALE}).returning();
 const [run]=await owner.db.insert(schema.assessmentReminderRun).values({tenantId:b.tenantId,cycleId:cycle.id,mode:'manual'}).returning();
 const [recipient]=await owner.db.insert(schema.assessmentReminderRecipient).values({tenantId:b.tenantId,runId:run.id,userId:b.adminUserId,outcome:'queued'}).returning();
 const eventId=randomUUID();
 await owner.client`insert into domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,payload)
  values(${eventId}::uuid,${b.tenantId}::uuid,'assessment-reminder',${recipient.id}::uuid,'assessment.reminder-queued','system','{}'::jsonb)`;
 await owner.db.update(schema.assessmentReminderRecipient).set({sourceEventId:eventId}).where(eq(schema.assessmentReminderRecipient.id,recipient.id));
 await withTenant(a,async tx=>{
  expect(await tx.execute(sql`select id from domain_event where id=${eventId}::uuid`)).toHaveLength(1);
  expect(await tx.execute(sql`select id from performance_assessment_reminder_run where id=${run.id}::uuid`)).toHaveLength(0);
  expect(await tx.execute(sql`select event_id from notification_event_processing where event_id=${eventId}::uuid`)).toHaveLength(0);
  expect(await tx.execute(sql`update notification_event_processing set disposition='processed',processed_at=now() where event_id=${eventId}::uuid returning event_id`)).toHaveLength(0);
 });
 expect(await dispatchNotifications(a)).toEqual({processed:0,created:0});
 expect(await owner.client`select consumer,disposition from notification_event_processing where event_id=${eventId}::uuid order by consumer`).toEqual([{consumer:'assessment-reminders',disposition:null},{consumer:'notifications',disposition:null}]);
 await withTenant(authorized,async tx=>{
  expect(await tx.execute(sql`select id from performance_assessment_reminder_run where id=${run.id}::uuid`)).toHaveLength(1);
  expect(await tx.execute(sql`select event_id from notification_event_processing where event_id=${eventId}::uuid`)).toHaveLength(1);
 });
 // This source has no employment recipient: its authorized native outcome is no projection,
 // but only the native cycle administrator may consume that intent.
 expect(await dispatchNotifications(authorized)).toEqual({processed:1,created:0});
 expect(await owner.client`select disposition from notification_event_processing where event_id=${eventId}::uuid and consumer='assessment-reminders'`).toEqual([{disposition:'processed'}]);
});
