/** Bounded tenant-admin expiry purge. Deletes only expired cipher media; immutable claims remain. */
import {and,asc,eq,inArray,lte,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext} from '../db/client';
import {mobileOfflinePhoto} from '../db/schema';
import {actorOf,appendEvent} from '../db/events';
import {withAttendanceTenant} from './module-gate';
export async function purgeExpiredOfflinePhotos(ctx:SessionContext,limit=50){
 const size=z.number().int().min(1).max(100).parse(limit);
 return withAttendanceTenant(ctx,async tx=>{
  const [authority]=await tx.execute(sql`select app.is_group_admin() allowed`);if(authority?.allowed!==true)throw new Error('Only a group administrator may purge expired offline photos.');
  const rows=await tx.select({id:mobileOfflinePhoto.claimId}).from(mobileOfflinePhoto).where(and(eq(mobileOfflinePhoto.tenantId,ctx.tenantId),lte(mobileOfflinePhoto.retainedUntil,sql`clock_timestamp()`))).orderBy(asc(mobileOfflinePhoto.retainedUntil),asc(mobileOfflinePhoto.claimId)).limit(size);
  if(!rows.length)return {purged:0};
  // DELETE obtains row locks and rechecks expiry; concurrent purgers audit only their returned rows.
  const removed=await tx.delete(mobileOfflinePhoto).where(and(eq(mobileOfflinePhoto.tenantId,ctx.tenantId),inArray(mobileOfflinePhoto.claimId,rows.map(r=>r.id)),lte(mobileOfflinePhoto.retainedUntil,sql`clock_timestamp()`))).returning();
  for(const row of removed)await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'mobile-offline-claim',aggregateId:row.claimId,eventType:'mobile.offline.photo.purged',actor:actorOf(ctx),subjectEmploymentId:row.employmentId,payload:{digest:row.photoDigest,retainedUntil:row.retainedUntil.toISOString()}});
  return {purged:removed.length};
 });
}
