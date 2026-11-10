import { sql } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { lockAccessConfigurationWriteTx } from './access-configuration-lock';
import { assertAiPrincipalTx, assertAiPresentationPrincipalTx } from './ai-principal';

/** Keep tighter caller deadlines; a real database failure is never an empty result or Busy page. */
export async function boundPersonnelStatementTx(tx: Tx) {
  await tx.execute(sql`select set_config('statement_timeout', least(
    coalesce(nullif(setting::int, 0), 20000), 20000)::text, true)
    from pg_catalog.pg_settings where name = 'statement_timeout'`);
}

/** Compose presentation reads in one borrowed snapshot whose identity and read-only
 * isolation PostgreSQL can prove. Command callers keep the existing Access barrier. */
export async function withPersonnelPresentationReadTx<T>(
  supplied: SessionContext, tx: Tx, read: (tx: Tx, ctx: SessionContext) => Promise<T>,
): Promise<T> {
  const ctx = structuredClone(supplied);
  if (ctx.agent) throw new Error('Personnel presentation requires a human session.');
  await assertAiPresentationPrincipalTx(tx, ctx);
  await boundPersonnelStatementTx(tx);
  return read(tx, ctx);
}

/** Standalone projections read authority and data from one REPEATABLE READ / READ ONLY snapshot.
 * They linearize at snapshot admission, not behind an unrelated tenant writer. Committed revocations
 * apply to the next snapshot; already admitted reads may finish. No cross-request result cache.
 * A borrowed transaction may write later: retain its exclusive command barrier and current principal.
 */
export async function withPersonnelRead<T>(ctx: SessionContext, read: (tx: Tx) => Promise<T>, options: { existingTx?: Tx } = {}): Promise<T> {
  if (options.existingTx) {
    await assertAiPrincipalTx(options.existingTx, ctx);
    await lockAccessConfigurationWriteTx(options.existingTx, ctx.tenantId);
    // The command owner keeps its timeout through subsequent writes and COMMIT.
    return read(options.existingTx);
  }
  return withTenant(ctx, async tx => {
    await boundPersonnelStatementTx(tx);
    return read(tx);
  }, { readOnlySnapshot: true });
}
