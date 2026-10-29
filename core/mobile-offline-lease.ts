/** Cross-carrier stream exclusion. No context issuance or implicit expiry-based release. */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
export class OfflineClockStreamError extends Error{
 constructor(readonly reason:'offline_pending'|'storage_unavailable'){
  super(reason==='offline_pending'?'Reconcile the saved offline clock stream first.':'Offline stream storage unavailable.');this.name='OfflineClockStreamError';
 }
}
/** Call inside the actor admission lock for challenge issuance, and after the registered key lock
 * for proof consumption. Before 0647 is installed there can be no issued lease; preserve online
 * behavior then. Partial/inaccessible storage fails closed rather than hiding an installed lease.
 * The narrow DB function reveals only a boolean, including for an unreadable former employment.
 */
export async function assertNoOfflineClockLeaseTx(tx:Tx,ctx:SessionContext,appInstallationId:string,keyId?:string){
 if(!ctx.userId)throw new OfflineClockStreamError('storage_unavailable');
 const [storage]=await tx.execute(sql`select to_regclass('public.mobile_offline_context') IS NOT NULL installed,
  to_regprocedure('app.mobile_offline_key_leased(uuid,uuid)') IS NOT NULL ready`);
 if(storage?.installed===false&&storage.ready===false)return;
 if(storage?.installed!==true||storage.ready!==true)throw new OfflineClockStreamError('storage_unavailable');
 const [result]=await tx.execute(sql`select app.mobile_offline_key_leased(${appInstallationId}::uuid,${keyId??null}::uuid) leased`);
 if(typeof result?.leased!=='boolean')throw new OfflineClockStreamError('storage_unavailable');
 if(result.leased)throw new OfflineClockStreamError('offline_pending');
}
