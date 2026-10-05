import { and, eq, ne, sql } from 'drizzle-orm';
import type { Tx } from './client';
import { tenantSetting } from './schema';
import { chainArmingDecision } from '../core/audit-chain-arming';

export const AUTH_SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** Arm an out-of-session write on its OWN transaction, before appending any event.
 *
 * These callers have no entitlement snapshot. An explicit tenant decision wins; without one, the
 * strict deployment flag is the fallback, including events belonging to the reserved auth tenant.
 * Only the tenant GUC is set for the setting's RLS read — no user, role or grant is invented.
 *
 * This is configuration-based arming, not proof of historical coverage. Pre-auth callers cannot read
 * admin-only event history, so they cannot detect an owner disabling a previously armed setting.
 * Customer provisioning persists true; changing that setting requires a separate history review.
 * Neither this helper nor a hash chain makes the database owner unable to alter audit evidence.
 */
export async function armAuditForTenant(tx: Tx, tenantId: string): Promise<boolean> {
  await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
  const [setting] = await tx.select({ value: tenantSetting.value }).from(tenantSetting)
    .where(and(
      eq(tenantSetting.tenantId, tenantId),
      eq(tenantSetting.key, 'audit.hash_chain_enabled'),
      // Platform-scoped decisions cannot come from a customer, matching the entitlement resolver.
      ne(tenantSetting.source, 'customer'),
    ));
  const decision = chainArmingDecision({
    settingEnabled: typeof setting?.value === 'boolean' ? setting.value : null,
    hasChainedHistory: false, // Not observable by the pre-auth app role; do not forge an admin context.
    envArmed: process.env.AUDIT_HASH_CHAIN_ENABLED === 'true',
  });
  await tx.execute(sql`select set_config('app.audit_hash_chain', ${decision.armed ? 'on' : 'off'}, true)`);
  return decision.armed;
}

/** A tenant ID does not exist yet. Set the flag before provisioning seeders can emit their events. */
export async function armAuditForProvisioning(tx: Tx): Promise<boolean> {
  const armed = process.env.AUDIT_HASH_CHAIN_ENABLED === 'true';
  await tx.execute(sql`select set_config('app.audit_hash_chain', ${armed ? 'on' : 'off'}, true)`);
  return armed;
}
