import { randomUUID } from 'node:crypto';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import { notificationDelivery } from '../db/schema';
import { isAdmin } from '../lib/authz-model';
import { notificationEmailIpc } from '../lib/notification-email-ipc';
import type { NotificationEmailRequest, NotificationEmailStatus } from '../lib/notification-email-model';
import { isModuleEnabled } from './entitlements';
import { notificationStillTargets } from './notifications';
import {noticeSweepReader,noticeSweepEventReader,type NoticeSweepAccess} from './notice-projection';

export type NotificationEmailTransport = <T>(request:NotificationEmailRequest)=>Promise<T>;
export async function readNotificationEmailTransport(transport:NotificationEmailTransport=notificationEmailIpc):Promise<NotificationEmailStatus|null> {
  try {const status=await transport<NotificationEmailStatus>({op:'status'});return status?.version===1&&typeof status.ready==='boolean'?status:null;}catch{return null;}
}
/** A definitive pre-send failure is terminal until an administrator chooses to retry it. */
async function failUnstartedDelivery(ctx:SessionContext,id:string,leaseToken:string,error:'relayUnavailable'|'recipientUnavailable') {
  return withTenant(ctx,async tx=>{
    const rows=await tx.update(notificationDelivery).set({status:'failed',lastError:error,
      attempts:sql`${notificationDelivery.attempts}+1`,leaseToken:null,leaseUntil:null,updatedAt:sql`now()`})
      .where(and(eq(notificationDelivery.id,id),eq(notificationDelivery.channel,'email'),eq(notificationDelivery.status,'pending'),
        eq(notificationDelivery.leaseToken,leaseToken),isNull(notificationDelivery.startedAt))).returning({id:notificationDelivery.id});
    return rows.length;
  });
}
/** Short atomic leases permit multiple schedulers without duplicate sends. No traffic or tenant uses a fake entitlement snapshot. */
export async function deliverNotificationEmails(ctx:SessionContext,transport:NotificationEmailTransport=notificationEmailIpc,options:{noticeSweep?:NoticeSweepAccess}={}) {
  const noticeReader=noticeSweepReader(ctx,options.noticeSweep),noticeEventReader=noticeSweepEventReader(ctx,options.noticeSweep);
  if (!isAdmin(ctx)) throw new Error('Notification dispatcher required');
  const allCategories=isModuleEnabled(ctx,'notifications');
  if(!allCategories&&!(ctx.entitlements?.scopedModules.notifications??[]).some(companyId=>isModuleEnabled(ctx,'notifications',companyId)))return {attempted:0,skipped:0,unavailable:false};
  const due=await withTenant(ctx,async tx=>tx.execute(sql`select * from app.notification_email_due(50)`)) as unknown as {id:string;recipient_employment_id:string;source_event_id:string;kind:string;category:string}[];
  const status=await readNotificationEmailTransport(transport);
  let attempted=0,skipped=0,unavailable=!status?.ready;
  for (const job of due) {
    if(!allCategories&&job.kind!=='performance.reminder')continue;
    if(status?.ready&&job.kind==='performance.reminder'&&(!status.assessmentReminders||!status.assessmentReminderWords)){unavailable=true;continue;}
    const leaseToken=randomUUID();
    const claimed=await withTenant(ctx,async tx=>{
      if (!await notificationStillTargets(tx,job.source_event_id,job.kind,job.category,job.recipient_employment_id,noticeReader,noticeEventReader)) {
        await tx.update(notificationDelivery).set({status:'skipped',lastError:'notEligible',updatedAt:sql`now()`}).where(and(eq(notificationDelivery.id,job.id),eq(notificationDelivery.status,'pending'),isNull(notificationDelivery.startedAt),or(isNull(notificationDelivery.leaseUntil),sql`${notificationDelivery.leaseUntil}<now()`)));
        return 'skipped';
      }
      const rows=await tx.update(notificationDelivery).set({leaseToken,leaseUntil:sql`now()+interval '60 seconds'`,updatedAt:sql`now()`})
        .where(and(eq(notificationDelivery.id,job.id),eq(notificationDelivery.status,'pending'),isNull(notificationDelivery.startedAt),or(isNull(notificationDelivery.leaseUntil),sql`${notificationDelivery.leaseUntil}<now()`))).returning({id:notificationDelivery.id});
      return rows.length?'claimed':'busy';
    });
    if (claimed==='skipped') {skipped++;continue;}
    if (claimed!=='claimed') continue;
    if (!status?.ready) {
      attempted+=await failUnstartedDelivery(ctx,job.id,leaseToken,'relayUnavailable');
      continue;
    }
    attempted++;
    try {
      const result=await transport<{outcome?:string}>({op:'send',deliveryId:job.id,leaseToken});
      if(result?.outcome==='unavailable'){
        // The private service explicitly refused before SMTP. Recheck which prerequisite failed;
        // the row/token/start guard also protects a concurrent or already-started SMTP request.
        unavailable=true;
        const current=await readNotificationEmailTransport(transport);
        await failUnstartedDelivery(ctx,job.id,leaseToken,current?.ready?'recipientUnavailable':'relayUnavailable');
      }
    }
    catch {
      // The service may have accepted the request. It owns the durable result. Expired started leases
      // are held as uncertain; an unstarted expired lease may be claimed by a later sweep.
    }
  }
  return {attempted,skipped,unavailable,cappedOut:due.length===50};
}
