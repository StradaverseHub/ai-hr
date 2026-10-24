/** Current human actor reads for this one action. Not a confirmation capability or AI pause check. */
import { sql } from 'drizzle-orm';
import type { SessionContext, Tx } from '../../db/client';
import { lockAccessConfigurationTx } from '../access-configuration-lock';
import { mayUseAssistant } from '../assistant-grant';
import { resolveEntitlementsTx } from '../entitlements';

/** Keep the supplied authority narrow: never replace claimed grants with a more privileged principal.
 * The shared principal proof refuses stale roles/scopes; the explicit person predicate additionally
 * refuses a relinked login. Refresh module/settings reads in the same transaction, without retaining
 * a failed old entitlement resolution. Access writers participating in the existing tenant lock
 * cannot change that identity proof until this transaction ends. Refuse an older repeatable-read
 * snapshot: this read must take a new statement snapshot after acquiring the access lock.
 *
 * This does NOT fence Assistant-grant, module, leave-policy or balance writers, nor check AI pauses.
 * The future command must close those dependencies before using this context to execute. No nested
 * transaction, provider call, model admission, action record or domain event is created here. */
export async function readOwnLeaveActorTx(tx: Tx, ctx: SessionContext): Promise<SessionContext | null> {
  if (!ctx.userId || !ctx.personId || ctx.entitlementsExempt !== undefined
    || ctx.statutoryOverride !== undefined) return null;
  // Match withTenant's carrier serialization, including its legacy roles-only context. Checking
  // only login/person would let a different context reuse this transaction's principal proof.
  const grants = ctx.grants ?? (ctx.roles ?? []).map(role => ({ role, companyId: null }));
  const roles = ctx.roles ?? Array.from(new Set(grants.map(grant => grant.role)));
  await lockAccessConfigurationTx(tx, ctx.tenantId);
  const rows = await tx.execute(sql`select u.id from public.app_user u
    where u.id=${ctx.userId}::uuid and u.tenant_id=${ctx.tenantId}::uuid
      and current_setting('transaction_isolation')='read committed'
      and u.id=app.current_user_id() and u.tenant_id=app.current_tenant_id()
      and current_setting('app.roles',true)=${roles.join(',')}
      and current_setting('app.grants',true)::jsonb=${JSON.stringify(grants)}::jsonb
      and u.person_id=${ctx.personId}::uuid and u.archived_at is null
      and not app.login_blocked(u.id) and app.principal_snapshot_current()`);
  if ((rows as unknown as { id: string }[]).length !== 1) return null;
  const fresh: SessionContext = { ...ctx, entitlementsError: undefined,
    entitlements: await resolveEntitlementsTx(tx, ctx.tenantId) };
  return (await mayUseAssistant(fresh, tx)).allowed ? fresh : null;
}
