import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';

/** Join before reading authority or counting recovery administrators in every access-affecting writer. */
export async function lockAccessConfigurationTx(tx:Tx,tenantId:string){
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+tenantId},0))`);
}

/** Profile/register writers join the physical configuration tuple before policy or subject locks.
 * This is a write barrier, not an access edit or an ESS approval bypass. */
export async function lockProfileValueWritesTx(tx:Tx,tenantId:string){
  await lockAccessConfigurationTx(tx,tenantId);
  await tx.execute(sql`select app.access_profile_policy_write_lock()`);
}
