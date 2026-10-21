import {sql} from 'drizzle-orm';
import type {Tx} from '../db/client';

/** Join before reading authority or counting recovery administrators in every access-affecting writer. */
export async function lockAccessConfigurationTx(tx:Tx,tenantId:string){
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+tenantId},0))`);
}
