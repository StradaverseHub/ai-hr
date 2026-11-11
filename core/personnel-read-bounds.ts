import { sql, type SQL } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { joinAccessConfigurationTx } from './workforce-lock-mode';
import { assertAiPrincipalTx, assertAiPresentationPrincipalTx } from './ai-principal';

/** Keep tighter caller deadlines; a real database failure is never an empty result or Busy page. */
export async function boundPersonnelStatementTx(tx: Tx) {
  await tx.execute(sql`select set_config('statement_timeout', least(
    coalesce(nullif(setting::int, 0), 20000), 20000)::text, true)
    from pg_catalog.pg_settings where name = 'statement_timeout'`);
}

/** boundPersonnelStatementTx, and in the same statement whether a reader a later migration adds is installed
 * (`procedure` is a regprocedure signature), so a database that migration has not reached keeps the previous reader. */
export async function boundPersonnelStatementWithProbeTx(tx: Tx, procedure: string): Promise<boolean> {
  const [row] = await tx.execute<{ installed: boolean }>(sql`select set_config('statement_timeout', least(
    coalesce(nullif(setting::int, 0), 20000), 20000)::text, true) as bound,
    to_regprocedure(${procedure}::text) is not null as installed
    from pg_catalog.pg_settings where name = 'statement_timeout'`);
  return row?.installed === true;
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
 * A borrowed transaction may write later: retain its command barrier and current principal. A command that
 * already holds the shared Access lock reads under it and never upgrades; any other keeps the exclusive lock.
 */
export async function withPersonnelRead<T>(ctx: SessionContext, read: (tx: Tx) => Promise<T>, options: { existingTx?: Tx } = {}): Promise<T> {
  if (options.existingTx) {
    await assertAiPrincipalTx(options.existingTx, ctx);
    await joinAccessConfigurationTx(options.existingTx, ctx.tenantId);
    // The command owner keeps its timeout through subsequent writes and COMMIT.
    return read(options.existingTx);
  }
  return withTenant(ctx, async tx => {
    await boundPersonnelStatementTx(tx);
    return read(tx);
  }, { readOnlySnapshot: true });
}

/** The Personnel overview snapshot, with its statement bound, the bounded overview's interpreted
 * execution and the typed-projection probe in the one statement the snapshot already spends. The probe
 * names migration 5020's functions, so a database it has not reached keeps the previous readers. */
export type PersonnelOverviewSnapshot = { previousJit: string; typedFacts: boolean; databaseToday: string; extra?: unknown };
const PERSONNEL_TYPED_FACTS = [
  'app.personnel_overview_facts(date,uuid[])', 'app.personnel_private_search_entries(text,uuid[])',
  'app.personnel_list_rows_for_ids(date,uuid[],uuid[])', 'app.personnel_overview_page_rows_typed(date,uuid[],uuid[])',
];
export async function personnelOverviewSnapshotTx(tx: Tx, extra?: SQL): Promise<PersonnelOverviewSnapshot> {
  // The bounded overview's measured compile cost dominates the small page, so it is interpreted. The
  // previous value is captured first; readers that fall back to the exact owner restore it.
  const [row] = await tx.execute<{ jit: string; typed: boolean; today: string; extra: unknown }>(sql`
    with previous as materialized (select current_setting('jit') as jit)
    select previous.jit,
      set_config('statement_timeout', least(coalesce(nullif(s.setting::int, 0), 20000), 20000)::text, true) as timeout,
      set_config('jit', 'off', true) as interpreted,
      (select bool_and(to_regprocedure(name) is not null)
        from unnest(${sql.raw(`array['${PERSONNEL_TYPED_FACTS.join("','")}']`)}::text[]) name) as typed,
      ((now() at time zone 'Asia/Kuala_Lumpur')::date)::text as today,
      ${extra ?? sql`null::jsonb`} as extra
    from previous, pg_catalog.pg_settings s where s.name = 'statement_timeout'
  `);
  return { previousJit: row.jit, typedFacts: row.typed === true, databaseToday: row.today, extra: row.extra };
}

/** A standalone read-only Personnel overview snapshot (see withPersonnelRead), in one bounds statement.
 * `extra` is a caller-owned scalar expression evaluated in that statement (for example page scope). */
export function withPersonnelOverviewRead<T>(
  ctx: SessionContext, read: (tx: Tx, snapshot: PersonnelOverviewSnapshot) => Promise<T>, options?: { extra?: SQL },
): Promise<T> {
  return withTenant(ctx, async tx => read(tx, await personnelOverviewSnapshotTx(tx, options?.extra)), { readOnlySnapshot: true });
}
