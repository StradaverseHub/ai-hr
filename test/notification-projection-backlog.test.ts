import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {createDb} from '../db/client';
import * as s from '../db/schema';
import {readNotificationProjectionBacklog} from '../scripts/lib/notification-projection-backlog';
import {dispatchNotificationsFromSweep} from '../core/notifications';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{
 await resetDb();b=await seedBase();await setModule(b.tenantId,'notifications','active');
 // Activation can enqueue legitimate processing intent. Drain setup through the
 // canonical owner before seeding independently counted backlog events.
 await dispatchNotificationsFromSweep(maintenance(),owner);
 expect(await readNotificationProjectionBacklog(maintenance(),owner)).toEqual({pending:0,oldest:0});
});
const maintenance=()=>({...adminCtx(b),userId:undefined,personId:undefined});
async function event(tenantId:string,minutes:number,eventType='fixture.pending-notification'){
 const id=randomUUID();await owner.db.insert(s.domainEvent).values({id,tenantId,aggregateType:'fixture',aggregateId:id,eventType,actorType:'system',occurredAt:sql`now()-make_interval(mins=>${minutes})`});return id;
}

describe('native notification processing backlog observations',()=>{
 it('counts only pending intent for the exact tenant/consumer and reports source-event age without changing receipts',async()=>{
  const other=await seedBase();await event(other.tenantId,1000);
  const oldest=await event(b.tenantId,10),newer=await event(b.tenantId,2),processed=await event(b.tenantId,100);
  await owner.db.update(s.notificationEventProcessing).set({disposition:'processed',processedAt:sql`now()`}).where(eq(s.notificationEventProcessing.eventId,processed));
  const before=await owner.db.select().from(s.notificationEventProcessing).where(eq(s.notificationEventProcessing.tenantId,b.tenantId)).orderBy(s.notificationEventProcessing.eventSequence);
  const backlog=await readNotificationProjectionBacklog(maintenance(),owner);
  expect(backlog.pending).toBe(2);expect(backlog.oldest).toBeGreaterThanOrEqual(600);expect(backlog.oldest).toBeLessThan(660);
  expect(await owner.db.select().from(s.notificationEventProcessing).where(eq(s.notificationEventProcessing.tenantId,b.tenantId)).orderBy(s.notificationEventProcessing.eventSequence)).toEqual(before);
  await owner.db.update(s.notificationEventProcessing).set({disposition:'ignored',processedAt:sql`now()`}).where(and(eq(s.notificationEventProcessing.tenantId,b.tenantId),eq(s.notificationEventProcessing.eventId,oldest)));
  expect((await readNotificationProjectionBacklog(maintenance(),owner)).pending).toBe(1);
  await owner.db.update(s.notificationEventProcessing).set({disposition:'ignored',processedAt:sql`now()`}).where(eq(s.notificationEventProcessing.eventId,newer));
  expect(await readNotificationProjectionBacklog(maintenance(),owner)).toEqual({pending:0,oldest:0});
 });
 it('uses the assessment consumer when only company-scoped notification entitlement is active',async()=>{
  await setModule(b.tenantId,'notifications','disabled');await setModule(b.tenantId,'notifications','active',b.companyId);
  await event(b.tenantId,30);await event(b.tenantId,3,'assessment.reminder-queued');
  const backlog=await readNotificationProjectionBacklog(maintenance(),owner);
  expect(backlog.pending).toBe(1);expect(backlog.oldest).toBeGreaterThanOrEqual(180);expect(backlog.oldest).toBeLessThan(240);
 });
 it('refuses logged-in, company-scoped and APP connections rather than reporting a partially visible empty queue',async()=>{
  await expect(readNotificationProjectionBacklog(adminCtx(b),owner)).rejects.toThrow('maintenance context');
  await expect(readNotificationProjectionBacklog({...maintenance(),grants:[{role:'hr_admin',companyId:b.companyId}]},owner)).rejects.toThrow('complete tenant scope');
  const app=createDb(process.env.TEST_DATABASE_URL!);
  try{await expect(readNotificationProjectionBacklog(maintenance(),app)).rejects.toThrow('privileged database connection');}
  finally{await app.client.end();}
 });
});
