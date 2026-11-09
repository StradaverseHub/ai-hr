import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { lockAccessConfigurationTx } from './access-configuration-lock';
import { assertAiPrincipalTx } from './ai-principal';

/** Keep tighter caller deadlines; a real database failure is never an empty result or Busy page. */
export async function boundPersonnelStatementTx(tx: Tx) {
  await tx.execute(sql`select set_config('statement_timeout', least(
    coalesce(nullif(setting::int, 0), 20000), 20000)::text, true)
    from pg_catalog.pg_settings where name = 'statement_timeout'`);
}

/** Standalone projections read authority and data from one REPEATABLE READ / READ ONLY snapshot.
 * They linearize at snapshot admission, not behind an unrelated tenant writer. Committed revocations
 * apply to the next snapshot; already admitted reads may finish. No cross-request result cache.
 * A borrowed transaction may write later: retain its exclusive command barrier and current principal.
 */
export async function withPersonnelRead<T>(ctx: SessionContext, read: (tx: Tx) => Promise<T>, options: { existingTx?: Tx } = {}): Promise<T> {
  if (options.existingTx) {
    await assertAiPrincipalTx(options.existingTx, ctx);
    await lockAccessConfigurationTx(options.existingTx, ctx.tenantId);
    await boundPersonnelStatementTx(options.existingTx);
    return read(options.existingTx);
  }
  return withTenant(ctx, async tx => {
    await boundPersonnelStatementTx(tx);
    return read(tx);
  }, { readOnlySnapshot: true });
}
