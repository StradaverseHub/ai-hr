/** Actor-owned key inventory and revocation remain independent of optional vendor verification. */
import {createHash} from 'node:crypto';
import {and,desc,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {SessionContext,Tx} from '../db/client';
import {mobileIntegrityKey} from '../db/schema';
import {actorOf,appendEvent} from '../db/events';
import {nativeKeyBindingData} from '../lib/mobile-key-enrollment';
import {withAttendanceTenant} from './module-gate';
import {myOwnEmploymentSubjectsTx} from './read';
import {OwnClockEmploymentUnavailableError} from './attendance-clock-subject';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
export class IntegrityKeyError extends Error{
  constructor(readonly reason:'not_found'|'key_unavailable'){super('Device key unavailable');this.name='IntegrityKeyError';}
}
async function own(tx:Tx,ctx:SessionContext,employmentId:string){
  if(!ctx.userId||!ctx.personId||!(await myOwnEmploymentSubjectsTx(tx,ctx,{profileEdit:true})).some(row=>row.employmentId===employmentId))throw new OwnClockEmploymentUnavailableError();
}
export async function requireOwnIntegrityEmployment(ctx:SessionContext,employmentId:string){
  await withAttendanceTenant(ctx,tx=>own(tx,ctx,uuid.parse(employmentId)));
}
/** One receipt mapper for enrollment and recovery; never exposes SDK keys or encrypted vendor receipts. */
export function integrityKeyReceipt(row:typeof mobileIntegrityKey.$inferSelect){
  return {keyId:row.id,originChallengeId:row.originChallengeId,platform:row.platform,appId:row.appId,environment:row.environment,proofKind:row.proofKind,
    nativeKeyBinding:createHash('sha256').update(nativeKeyBindingData(row.originChallengeId,row.vendorKeyId)).digest('hex'),createdAt:row.createdAt.toISOString(),revokedAt:row.revokedAt?.toISOString()??null};
}
const receipt=integrityKeyReceipt;

export async function revokeOwnIntegrityKey(ctx:SessionContext,input:{employmentId:string;keyId:string},options:{platform?:'ios'}={}){
  const employmentId=uuid.parse(input.employmentId),keyId=uuid.parse(input.keyId);
  return withAttendanceTenant(ctx,async tx=>{
    await own(tx,ctx,employmentId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId+':mobile-integrity:'+ctx.userId},0))`);
    const [row]=await tx.select().from(mobileIntegrityKey).where(and(eq(mobileIntegrityKey.id,keyId),eq(mobileIntegrityKey.actorId,ctx.userId!))).limit(1).for('update');
    // Either lock can outlive the subject check made at transaction entry.
    await own(tx,ctx,employmentId);
    if(!row||options.platform&&row.platform!==options.platform)throw new IntegrityKeyError('not_found');if(row.revokedAt)return receipt(row);
    const [revoked]=await tx.update(mobileIntegrityKey).set({revokedAt:sql`clock_timestamp()`}).where(eq(mobileIntegrityKey.id,keyId)).returning();
    if(!revoked)throw new IntegrityKeyError('key_unavailable');
    await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'mobile-integrity-key',aggregateId:keyId,eventType:'mobile.integrity.key.revoked',
      actor:actorOf(ctx),subjectEmploymentId:employmentId,payload:{}});return receipt(revoked);
  });
}
/** Active keys first, followed by bounded recent revoked history; not a complete audit inventory. */
export async function listOwnIntegrityKeys(ctx:SessionContext,employmentId:string,options:{platform?:'ios'}={}){
  return withAttendanceTenant(ctx,async tx=>{
    await own(tx,ctx,uuid.parse(employmentId));
    const rows=await tx.select().from(mobileIntegrityKey).where(and(eq(mobileIntegrityKey.actorId,ctx.userId!),options.platform?eq(mobileIntegrityKey.platform,options.platform):undefined))
      .orderBy(sql`case when ${mobileIntegrityKey.revokedAt} is null then 0 else 1 end`,desc(mobileIntegrityKey.createdAt)).limit(20);
    return rows.map(receipt);
  });
}

/** Exact own-actor lookup is independent of catalog pagination and vendor configuration. Null is an
 * observation at this read, not permission to regenerate a key or repeat a one-use attestation. */
export async function readOwnIntegrityKeyReceipt(ctx:SessionContext,input:{employmentId:string;originChallengeId:string},options:{platform?:'ios'}={}){
  const employmentId=uuid.parse(input.employmentId),originChallengeId=uuid.parse(input.originChallengeId);
  return withAttendanceTenant(ctx,async tx=>{
    await own(tx,ctx,employmentId);
    const [row]=await tx.select().from(mobileIntegrityKey).where(and(eq(mobileIntegrityKey.tenantId,ctx.tenantId),
      eq(mobileIntegrityKey.actorId,ctx.userId!),eq(mobileIntegrityKey.originChallengeId,originChallengeId),options.platform?eq(mobileIntegrityKey.platform,options.platform):undefined)).limit(1);
    return row?receipt(row):null;
  });
}
