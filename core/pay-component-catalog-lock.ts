/** Catalogue ownership only; never a permission or financial calculation capability. */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {lockAccessConfigurationTx} from './access-configuration-lock';
export async function lockPayComponentCatalogTx(tx:Tx,ctx:SessionContext,tryOnly=false){
 await lockAccessConfigurationTx(tx,ctx.tenantId);
 if(tryOnly){const [row]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':pay-component-catalog'},0)) as owned`);if(row?.owned!==true)throw new Error('Pay catalogue is busy');}
 else await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':pay-component-catalog'},0))`);
}
