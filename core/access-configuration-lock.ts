import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';

/** Join before reading authority or counting recovery administrators in every access-affecting writer. */
export async function lockAccessConfigurationTx(tx:Tx,tenantId:string){
  requireExclusiveDataConfigurationTx(tx);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+tenantId.toLowerCase()},0))`);
}

/** Only for a complete read-only transaction: readers may overlap, while the existing exclusive
 * writer lock still excludes revocation/configuration changes. Never upgrade this lock to write. */
export async function lockAccessConfigurationReadTx(tx:Tx,tenantId:string){
 await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${'access-configuration:'+tenantId.toLowerCase()},0))`);
}

/** Profile/register writers join the physical configuration tuple before policy or subject locks.
 * This is a write barrier, not an access edit or an ESS approval bypass. */
export async function lockProfileValueWritesTx(tx:Tx,tenantId:string){
  await lockAccessConfigurationTx(tx,tenantId);
  await tx.execute(sql`select app.access_profile_policy_write_lock()`);
}

/** Only an explicitly owned, writable ordinary-command transaction may share authority. This map
 * describes lock ownership, never a permission cache. Existing/enclosing transactions stay exclusive. */
const dataCommands=new WeakMap<Tx,string>();
export class DataCommandRequiresExclusive extends Error {
 constructor(){super('This command requires exclusive configuration ownership.');this.name='DataCommandRequiresExclusive';}
}
export function requireExclusiveDataConfigurationTx(tx:Tx):void {
 if(dataCommands.has(tx))throw new DataCommandRequiresExclusive();
}
export function hasDataCommandAuthorityTx(tx:Tx,tenantId:string):boolean {
 return dataCommands.get(tx)===tenantId.toLowerCase();
}
/** Called once at the outer boundary BEFORE authority/dependency reads. SQL remains READ WRITE.
 * True access/workforce writers still use the original exclusive key and therefore cannot revoke
 * authority until all these commands finish. The shared read-only helper remains read-only only. */
export async function beginDataCommandAuthorityTx(tx:Tx,tenantId:string):Promise<void>{
 const [state]=await tx.execute<{valid:boolean}>(sql`select app.current_tenant_id()=${tenantId}::uuid
  and current_setting('transaction_isolation')='read committed'
  and current_setting('transaction_read_only')='off' as valid`);
 if(state?.valid!==true)throw new Error('Writable current tenant transaction required.');
 await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${'access-configuration:'+tenantId.toLowerCase()},0))`);
 dataCommands.set(tx,tenantId.toLowerCase());
}
/** Ordinary data helper; an enclosing owner that did not opt in keeps its original exclusion. */
export async function lockDataCommandAuthorityTx(tx:Tx,tenantId:string):Promise<void>{
 if(hasDataCommandAuthorityTx(tx,tenantId))return;
 await lockAccessConfigurationTx(tx,tenantId);
}
