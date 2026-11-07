/** Aggregate observations through the same complete authenticated maintenance authority as projection.
 * This reads existing processing intent; it never consumes, acknowledges or creates notification work. */
import {and,eq,isNull,sql} from 'drizzle-orm';
import type {SessionContext} from '../../db/client';
import {domainEvent,notificationEventProcessing} from '../../db/schema';
import {isModuleEnabled} from '../../core/entitlements';
import {assertNotificationSweepConnection,type NotificationSweepConnection} from '../../core/notice-projection';

export async function readNotificationProjectionBacklog(ctx:SessionContext,connection:NotificationSweepConnection):Promise<{pending:number;oldest:number}> {
 if(ctx.userId)throw new Error('Projection backlog requires a maintenance context.');
 const allCategories=isModuleEnabled(ctx,'notifications');
 if(!allCategories&&!(ctx.entitlements?.scopedModules.notifications??[]).some(id=>isModuleEnabled(ctx,'notifications',id)))throw new Error('Notification projection is unavailable.');
 return connection.withTenant(ctx,async tx=>{
  await assertNotificationSweepConnection(tx);
  const [scope]=await tx.execute<{allowed:boolean}>(sql`select app.is_group_admin() as allowed`);
  if(!scope?.allowed)throw new Error('Projection backlog requires complete tenant scope.');
  const [backlog]=await tx.select({pending:sql<number>`count(*)::double precision`,oldest:sql<number>`coalesce(greatest(0,extract(epoch from (now()-min(${domainEvent.occurredAt}))))::double precision,0)`})
   .from(notificationEventProcessing).innerJoin(domainEvent,and(eq(domainEvent.id,notificationEventProcessing.eventId),eq(domainEvent.tenantId,notificationEventProcessing.tenantId)))
   .where(and(eq(notificationEventProcessing.tenantId,ctx.tenantId),eq(notificationEventProcessing.consumer,allCategories?'notifications':'assessment-reminders'),isNull(notificationEventProcessing.disposition)));
  if(!backlog||!Number.isSafeInteger(backlog.pending)||backlog.pending<0||!Number.isFinite(backlog.oldest)||backlog.oldest<0)throw new Error('Projection backlog unavailable.');
  return backlog;
 },{readOnlySnapshot:true});
}
