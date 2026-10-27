import {sql} from 'drizzle-orm';
import type {SessionContext,Tx} from '../db/client';
import {lockLeaveDependencyConfigurationTx} from './leave-dependency-lock';
/** Native callers keep their existing RLS/field-owner authority. This interval creates no marker,
 * role or table grant. Null-user provisioning keeps its original SYSTEM semantics. */
export const captureStatutorySourceContext=(ctx:SessionContext):SessionContext=>({...ctx,roles:ctx.roles?.slice(),grants:ctx.grants?.map(g=>({...g}))});
/** NATIVE statutory writers (profile, tax selection, hire/transfer initialization, TP3, split cards).
 * Same write barrier and configuration interval the reviewed owner joins, so reviewed custody and native
 * writers still serialize, but NO principal refusal of its own: the writer's existing RLS, field-owner
 * and own-identity checks stay the authority and keep their existing outcomes (not_found etc.). */
export async function lockStatutorySourceTx(tx:Tx,ctx:SessionContext){
 ctx=captureStatutorySourceContext(ctx);
 await tx.execute(sql`select app.access_workforce_write_lock()`);
 await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
}
/** REVIEWED (Assistant custody) statutory owners: the same interval, but a USER carrier must still match
 * the actual current principal before any protected stored/default/epoch read. */
export async function lockReviewedStatutorySourceTx(tx:Tx,ctx:SessionContext){
 ctx=captureStatutorySourceContext(ctx);
 await tx.execute(sql`select app.access_workforce_write_lock()`);
 if(ctx.userId){const [principal]=await tx.execute<{ok:boolean}>(sql`select app.current_tenant_id()=${ctx.tenantId}::uuid and app.current_user_id()=${ctx.userId}::uuid and exists(select 1 from public.app_user u where u.id=${ctx.userId}::uuid and u.tenant_id=${ctx.tenantId}::uuid and u.person_id is not distinct from ${ctx.personId??null}::uuid and u.archived_at is null and not app.login_blocked(u.id)) and app.principal_snapshot_current() as ok`);if(principal?.ok!==true)throw new Error('Statutory authority unavailable');}
 await lockLeaveDependencyConfigurationTx(tx,ctx.tenantId);
}
