/**
 * Active Malaysian statutory ruleset loader (ADR-0019).
 *
 * Resolves the ruleset in effect for a pay period: the latest non-archived `statutory_ruleset` row
 * for country 'MY' with `effective_from ≤ asOf`. An empty table (the norm) falls back to the
 * verified, code-shipped `DEFAULT_MY_STATUTORY`, so behaviour is identical until an admin creates an
 * override. Pure read; RLS scopes rows to the caller's tenant (this runs inside `withTenant`).
 * `core/payroll.ts` calls it once per run and threads the result into the pure/synchronous
 * calculators — no DB read inside the per-payslip loop.
 */
import { and, desc, eq, isNull, lte } from 'drizzle-orm';
import type { Tx } from '../../db/client';
import { statutoryRuleset } from '../../db/schema';
import { DEFAULT_MY_STATUTORY, type StatutoryRuleset } from './statutory-tables';

export async function getActiveStatutoryMY(tx: Tx, p: { asOf: string }): Promise<StatutoryRuleset> {
  const [row] = await tx
    .select({ data: statutoryRuleset.data })
    .from(statutoryRuleset)
    .where(
      and(
        eq(statutoryRuleset.country, 'MY'),
        isNull(statutoryRuleset.archivedAt),
        lte(statutoryRuleset.effectiveFrom, p.asOf),
      ),
    )
    .orderBy(desc(statutoryRuleset.effectiveFrom))
    .limit(1);
  return (row?.data as StatutoryRuleset | undefined) ?? DEFAULT_MY_STATUTORY;
}
