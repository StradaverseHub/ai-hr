import { randomUUID } from 'node:crypto';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { notificationDelivery } from '../db/schema';
import { isAdmin } from '../lib/authz';
import { notificationEmailIpc } from '../lib/notification-email-ipc';
import type { NotificationEmailRequest, NotificationEmailStatus } from '../lib/notification-email-model';
import { isModuleEnabled } from './entitlements';
import { notificationStillTargets } from './notifications';

export type NotificationEmailTransport = <T>(request:NotificationEmailRequest)=>Promise<T>;
export async function readNotificationEmailTransport(transport:NotificationEmailTransport=notificationEmailIpc):Promise<NotificationEmailStatus|null> {
  try {const status=await transport<NotificationEmailStatus>({op:'status'});return status?.version===1&&typeof status.ready==='boolean'?status:null;}catch{return null;}
}
/** Short atomic leases permit multiple schedulers without duplicate sends. No traffic or tenant uses a fake entitlement snapshot. */
export async function deliverNotificationEmails(ctx:SessionContext,transport:NotificationEmailTransport=notificationEmailIpc) {
  if (!isAdmin(ctx)) throw new Error('Notification dispatcher required');
  if (!isModuleEnabled(ctx,'notifications')) return {attempted:0,skipped:0,unavailable:false};
  const status=await readNotificationEmailTransport(transport);
  if (!status?.ready) return {attempted:0,skipped:0,unavailable:true};
  const due=await withTenant(ctx,async tx=>tx.execute(sql`select * from app.notification_email_due(50)`)) as unknown as {id:string;recipient_employment_id:string;source_event_id:string;kind:string;category:string}[];
  let attempted=0,skipped=0;
  for (const job of due) {
    const leaseToken=randomUUID();
    const claimed=await withTenant(ctx,async tx=>{
      if (!await notificationStillTargets(tx,job.source_event_id,job.kind,job.category,job.recipient_employment_id)) {
        await tx.update(notificationDelivery).set({status:'skipped',lastError:'notEligible',updatedAt:sql`now()`}).where(and(eq(notificationDelivery.id,job.id),eq(notificationDelivery.status,'pending'),isNull(notificationDelivery.startedAt),or(isNull(notificationDelivery.leaseUntil),sql`${notificationDelivery.leaseUntil}<now()`)));
        return 'skipped';
      }
      const rows=await tx.update(notificationDelivery).set({leaseToken,leaseUntil:sql`now()+interval '30 seconds'`,updatedAt:sql`now()`})
        .where(and(eq(notificationDelivery.id,job.id),eq(notificationDelivery.status,'pending'),isNull(notificationDelivery.startedAt),or(isNull(notificationDelivery.leaseUntil),sql`${notificationDelivery.leaseUntil}<now()`))).returning({id:notificationDelivery.id});
      return rows.length?'claimed':'busy';
    });
    if (claimed==='skipped') {skipped++;continue;}
    if (claimed!=='claimed') continue;
    attempted++;
    try {await transport({op:'send',deliveryId:job.id,leaseToken});}
    catch {
      // The service may have accepted the request. It owns the durable result. Expired started leases
      // are held as uncertain; an unstarted expired lease may be claimed by a later sweep.
    }
  }
  return {attempted,skipped,unavailable:false,cappedOut:due.length===50};
}
