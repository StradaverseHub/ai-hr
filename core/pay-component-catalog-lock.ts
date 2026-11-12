/** Catalogue ownership only; never a permission or financial calculation capability. */
import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {lockAccessConfigurationTx,lockAccessConfigurationWriteTx} from './access-configuration-lock';
/** Catalogue editors: the exclusive Access lock (the catalogue is configuration other writers read)
 * and the exclusive catalogue key, so a pay run or a fixed-item writer never sees half an edit. */
export async function lockPayComponentCatalogTx(tx:Tx,ctx:SessionContext,tryOnly=false){
 await lockAccessConfigurationWriteTx(tx,ctx.tenantId);
 if(tryOnly){const [row]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':pay-component-catalog'},0)) as owned`);if(row?.owned!==true)throw new Error('Pay catalogue is busy');}
 else await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':pay-component-catalog'},0))`);
}

/** Catalogue readers (pay runs, fixed-item and one-off writers, individual calculation): the shared
 * Access lock and the shared catalogue key pin catalogue revisions and overlap each other; only a
 * catalogue editor excludes them. A reader must not ask for the editor lock later in the same
 * transaction. */
export async function lockPayComponentCatalogReadTx(tx:Tx,ctx:SessionContext){
 await lockAccessConfigurationTx(tx,ctx.tenantId);
 await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${ctx.tenantId + ':pay-component-catalog'},0))`);
}
