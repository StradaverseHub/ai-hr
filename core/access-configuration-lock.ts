import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';

const accessConfigurationKey = (tenantId: string) => 'access-configuration:' + tenantId;

/** Join before reading authority or counting recovery administrators in every access-affecting writer. */
export async function lockAccessConfigurationTx(tx:Tx,tenantId:string){
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${accessConfigurationKey(tenantId)},0))`);
}

/** Personnel readers must not occupy pool connections while waiting for the same tenant. */
export async function tryLockAccessConfigurationTx(tx: Tx, tenantId: string): Promise<boolean> {
  const [row] = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${accessConfigurationKey(tenantId)},0)) as acquired`);
  return row.acquired;
}

/** Read-only Personnel transactions may overlap, while access writers remain exclusive. */
export async function tryLockAccessConfigurationReadTx(tx: Tx, tenantId: string): Promise<boolean> {
  const [row] = await tx.execute<{ acquired: boolean }>(sql`select pg_try_advisory_xact_lock_shared(hashtextextended(${accessConfigurationKey(tenantId)},0)) as acquired`);
  return row.acquired;
}

/** Profile/register writers join the physical configuration tuple before policy or subject locks.
 * This is a write barrier, not an access edit or an ESS approval bypass. */
export async function lockProfileValueWritesTx(tx:Tx,tenantId:string){
  await lockAccessConfigurationTx(tx,tenantId);
  await tx.execute(sql`select app.access_profile_policy_write_lock()`);
}
