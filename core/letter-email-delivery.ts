/** The canonical email outbox, addressed by account, with a real maintenance connection and private IPC. */
import {randomUUID} from 'node:crypto';
import {and,asc,eq,isNull,lte,or,sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {notificationDelivery,notification} from '../db/schema';
import type {NotificationSweepConnection} from './notice-projection';
import {assertLetterNotificationConnection} from './letter-notifications';
import {lockPayrollHistoryReadTx} from './payroll-history-lock';
import {lockAccessConfigurationTx} from './access-configuration-lock';
import {resolveEntitlementsTx,isModuleEnabled} from './entitlements';
import {readNotificationEmailTransport,type NotificationEmailTransport} from './notification-email-delivery';
import {notificationEmailIpc} from '../lib/notification-email-ipc';
function context(ctx:SessionContext){if(ctx.userId||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(ctx.tenantId))throw Error('Letters email requires its tenant-bound maintenance context.');}
async function locks(tx:Tx,ctx:SessionContext){
 await assertLetterNotificationConnection(tx);await lockPayrollHistoryReadTx(tx,ctx.tenantId);await lockAccessConfigurationTx(tx,ctx.tenantId);await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'letters:'+ctx.tenantId},0))`);
}
export async function deliverLetterEmailsFromSweep(ctx:SessionContext,connection:NotificationSweepConnection,transport:NotificationEmailTransport=notificationEmailIpc){
 context(ctx);
 const due=await connection.withTenant(ctx,async tx=>{await assertLetterNotificationConnection(tx);return tx.select({id:notificationDelivery.id}).from(notificationDelivery).where(and(eq(notificationDelivery.tenantId,ctx.tenantId),eq(notificationDelivery.category,'letters'),eq(notificationDelivery.channel,'email'),eq(notificationDelivery.status,'pending'),lte(notificationDelivery.nextAttemptAt,sql`now()`),or(isNull(notificationDelivery.leaseUntil),sql`${notificationDelivery.leaseUntil}<now()`))).orderBy(asc(notificationDelivery.createdAt),asc(notificationDelivery.id)).limit(50);},{readOnlySnapshot:true});
 const status=await readNotificationEmailTransport(transport),result={attempted:0,skipped:0,failedUnstarted:0,uncertain:0,failed:0,unavailable:status?.ready!==true||status.letters!==true,cappedOut:due.length===50};
 for(const {id}of due){try{
  const claim=await connection.withTenant(ctx,async tx=>{
   await locks(tx,ctx);const [job]=await tx.select().from(notificationDelivery).where(and(eq(notificationDelivery.id,id),eq(notificationDelivery.tenantId,ctx.tenantId),eq(notificationDelivery.category,'letters'),eq(notificationDelivery.status,'pending'),lte(notificationDelivery.nextAttemptAt,sql`now()`),or(isNull(notificationDelivery.leaseUntil),sql`${notificationDelivery.leaseUntil}<now()`))).for('update');if(!job)return {state:'busy' as const};
   if(job.startedAt){await tx.update(notificationDelivery).set({status:'failed',lastError:'uncertain',leaseToken:null,leaseUntil:null,updatedAt:sql`now()`}).where(eq(notificationDelivery.id,id));return {state:'uncertain' as const};}
   const [routing]=await tx.select({companyId:notification.companyId,jobId:notification.letterJobId}).from(notification).where(and(eq(notification.id,job.notificationId),eq(notification.tenantId,ctx.tenantId)));
   const [before]=await tx.execute<{stamp:string}>(sql`select identity_email.letter_commercial_stamp(${ctx.tenantId}::uuid) as stamp`),entitlements=await resolveEntitlementsTx(tx,ctx.tenantId),[after]=await tx.execute<{stamp:string}>(sql`select identity_email.letter_commercial_stamp(${ctx.tenantId}::uuid) as stamp`);
   if(!before?.stamp||!after?.stamp)throw Error('Letters commercial witness unavailable');if(before.stamp!==after.stamp)return {state:'busy' as const};
   const [current]=routing?.jobId?await tx.execute<{ok:boolean}>(sql`select identity_email.letter_job_current(${ctx.tenantId}::uuid,${routing.jobId}::uuid) as ok`):[];
   if(!routing?.companyId||!current?.ok||!isModuleEnabled({...ctx,entitlements},'notifications',routing.companyId)){
    await tx.update(notificationDelivery).set({status:'skipped',lastError:'notEligible',updatedAt:sql`now()`,leaseToken:null,leaseUntil:null}).where(eq(notificationDelivery.id,id));return {state:'skipped' as const};
   }
   if(!status?.ready||!status.letters){await tx.update(notificationDelivery).set({status:'failed',lastError:'relayUnavailable',attempts:job.attempts+1,updatedAt:sql`now()`,leaseToken:null,leaseUntil:null}).where(eq(notificationDelivery.id,id));return {state:'offline' as const};}
   const token=randomUUID(),until=sql`least(now()+interval '60 seconds',coalesce((select min(expires_at) from tenant_module where tenant_id=${ctx.tenantId}::uuid and status in ('active','trial') and expires_at>now()),now()+interval '60 seconds'))`;
   await tx.update(notificationDelivery).set({leaseToken:token,leaseUntil:until,letterPreparedStamp:after.stamp,letterPreparedUntil:until,updatedAt:sql`now()`}).where(eq(notificationDelivery.id,id));return {state:'claimed' as const,token};
  });
  if(claim.state==='skipped'){result.skipped++;continue;}if(claim.state==='offline'){result.failedUnstarted++;continue;}if(claim.state==='uncertain'){result.uncertain++;continue;}if(claim.state!=='claimed')continue;
  result.attempted++;
  try{
   const outcome=await transport<{outcome?:string}>({op:'send',deliveryId:id,leaseToken:claim.token});
   if(outcome?.outcome==='unavailable'){
    result.unavailable=true;const fresh=await readNotificationEmailTransport(transport);
    await connection.withTenant(ctx,async tx=>{await assertLetterNotificationConnection(tx);const rows=await tx.update(notificationDelivery).set({status:'failed',lastError:fresh?.ready&&fresh.letters?'recipientUnavailable':'relayUnavailable',attempts:sql`${notificationDelivery.attempts}+1`,leaseToken:null,leaseUntil:null,updatedAt:sql`now()`}).where(and(eq(notificationDelivery.id,id),eq(notificationDelivery.tenantId,ctx.tenantId),eq(notificationDelivery.category,'letters'),eq(notificationDelivery.status,'pending'),eq(notificationDelivery.leaseToken,claim.token),isNull(notificationDelivery.startedAt))).returning({id:notificationDelivery.id});result.failedUnstarted+=rows.length;});
   }
  }catch{/* The private service owns SMTP outcomes. Expired started requests become uncertain, never blind retries. */}
 }catch{result.failed++;}}
 return result;
}
