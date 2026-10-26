import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../../db/client';
import {lockLeaveDependencyConfigurationTx} from '../../core/leave-dependency-lock';
/** Native callers keep their existing RLS/field-owner authority. This interval creates no marker,
 * role or table grant. Null-user provisioning keeps its original SYSTEM semantics. USER carriers
 * must still match the actual current principal before any protected stored/default/epoch read. */
export const captureStatutoryContext=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
export async function statutoryWriteIntervalMYTx(tx:Tx,ctx:SessionContext){
 ctx=captureStatutoryContext(ctx);
 await tx.execute(sql`select app.access_workforce_write_lock()`);
 if(ctx.userId){const [principal]=await tx.execute<{ok:boolean}>(sql`select app.current_tenant_id()=${ctx.tenantId}::uuid and app.current_user_id()=${ctx.userId}::uuid and exists(select 1 from public.app_user u where u.id=${ctx.userId}::uuid and u.tenant_id=${ctx.tenantId}::uuid and u.person_id is not distinct from ${ctx.personId??null}::uuid and u.archived_at is null and not app.login_blocked(u.id)) and app.principal_snapshot_current() as ok`);if(principal?.ok!==true)throw new Error('Statutory authority unavailable');}
 await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
}

