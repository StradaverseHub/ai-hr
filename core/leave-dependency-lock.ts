/** SOURCE ONLY, not yet joined by legacy writers or Assistant confirmation. These advisory locks
 * protect only participating transactions; they are NOT a universal database constraint or authority.
 * Caller owns fresh access checks, complete dependency coverage and whole-transaction rollback on
 * refusal. Acquire before protected reads; do not catch a busy refusal and continue to write. */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Tx } from '../db/client';

export class LeaveDependencyUnavailable extends Error {
  constructor() { super('Leave source is unavailable; review it again.'); this.name = 'LeaveDependencyUnavailable'; }
}
const uuid = z.string().uuid();

async function acquire(tx: Tx, tenantId: string, key: string, shared: boolean): Promise<void> {
  // CASE prevents a mismatched carrier from acquiring a foreign tenant's advisory lock. No waiting:
  // a busy source requires a fresh review rather than an unbounded response or an automatic retry.
  const [row] = await tx.execute<{ acquired: boolean }>(sql`select case
    when app.current_tenant_id()=${tenantId}::uuid
      and current_setting('transaction_isolation')='read committed'
      and current_setting('transaction_read_only')='off'
    then ${shared ? sql`pg_try_advisory_xact_lock_shared(hashtextextended(${key},0))`
      : sql`pg_try_advisory_xact_lock(hashtextextended(${key},0))`}
    else false end as acquired`);
  if (row?.acquired !== true) throw new LeaveDependencyUnavailable();
}

/** Configuration writers must join exclusively before changing any participating dependency.
 * Existing Access/annual-role/payroll/credit/row lock order still needs complete owner integration.
 * This helper intentionally supplies no claim that a caller already owns those prerequisites. */
export async function lockLeaveDependencyConfigurationTx(tx: Tx, tenantId: string): Promise<void> {
  if (!uuid.safeParse(tenantId).success) throw new LeaveDependencyUnavailable();
  await acquire(tx, tenantId, `leave-dependency-configuration:${tenantId}`, false);
}

/** Ordinary commands share stable configuration, then serialize each affected employment, covering
 * all its borrower types rather than only the selected leave type. IDs are server-owned, deduplicated
 * and sorted before the first await. Partial acquisition is released by the required outer rollback. */
export async function lockLeaveDependenciesTx(tx: Tx, tenantId: string, employmentIds: readonly string[]): Promise<void> {
  if (!uuid.safeParse(tenantId).success || employmentIds.length === 0
    || employmentIds.some(id => !uuid.safeParse(id).success)) throw new LeaveDependencyUnavailable();
  const subjects = [...new Set(employmentIds)].sort();
  await acquire(tx, tenantId, `leave-dependency-configuration:${tenantId}`, true);
  for (const id of subjects) await acquire(tx, tenantId, `leave-dependency-employment:${tenantId}:${id}`, false);
}
