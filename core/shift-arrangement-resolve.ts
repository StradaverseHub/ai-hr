/**
 * 18504ca6 — WHICH SHIFT WAS IN FORCE ON THAT DATE.
 *
 * This module is a deliberate LEAF: its only value import is db/schema (the `Tx` import is type-only and so
 * erased at runtime). core/attendance.ts depends on it, and core/roster.ts depends on core/attendance.ts —
 * the writer and the card's history read live next door in core/shift-arrangement.ts, which DOES import from
 * core/roster.ts. Keeping the two apart is what stops that import from closing an attendance ↔ roster cycle.
 *
 * THE RULE, stated once so the four call sites cannot drift:
 *   · Rows are the LIVE (superseded_at IS NULL) periods of one employment, ordered by valid_from ascending.
 *   · The answer for a date is the row with the GREATEST valid_from <= date.
 *   · A date BEFORE the earliest row resolves to the EARLIEST row. This is not a nicety — it is the release
 *     promise. Migration 0421 backfills each employee's period from their start date, so nothing before it
 *     is real employment; but a test (or an import) that derives a day before the first recorded period must
 *     keep resolving to the shift it resolves to TODAY, and the earliest row is that shift.
 *   · An employment with NO rows at all returns undefined, and every caller falls back to
 *     employment.default_shift_id exactly as it did before this item. That is what keeps the legacy writer
 *     (core/roster.ts assignEmployeeShift, still used by the b8aa3466 backup-shift backfill and by tests)
 *     byte-identical: it maintains the cache, never the ladder, and an employment it touches has no ladder.
 *
 * `valid_to` is NOT consulted. It is stored for readability and closed to the day before the successor's
 * valid_from when a change is saved; resolving off valid_from alone means a stale or missing valid_to can
 * never open a gap that silently drops an employee onto the flat company policy.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { employmentShiftArrangement } from '../db/schema';

/** One live dated period of an employee's shift arrangement, as the resolvers need it. */
export type ArrangementPeriod = {
  employmentId: string;
  shiftType: 'fixed' | 'roster';
  shiftId: string;
  validFrom: string;
};

const PERIOD_COLS = {
  employmentId: employmentShiftArrangement.employmentId,
  shiftType: employmentShiftArrangement.shiftType,
  shiftId: employmentShiftArrangement.shiftId,
  validFrom: employmentShiftArrangement.validFrom,
} as const;

/**
 * Every LIVE period of the given employments, ascending by (employment, valid_from). ONE query for the whole
 * batch — the Records loaders promise batched reads in their header comments and this must not break that.
 */
export async function liveArrangementsTx(
  tx: Tx,
  employmentIds: string[],
): Promise<Map<string, ArrangementPeriod[]>> {
  const byEmp = new Map<string, ArrangementPeriod[]>();
  if (employmentIds.length === 0) return byEmp;
  const rows = await tx
    .select(PERIOD_COLS)
    .from(employmentShiftArrangement)
    .where(
      and(
        inArray(employmentShiftArrangement.employmentId, employmentIds),
        isNull(employmentShiftArrangement.supersededAt),
      ),
    )
    .orderBy(asc(employmentShiftArrangement.employmentId), asc(employmentShiftArrangement.validFrom));
  for (const r of rows) {
    const list = byEmp.get(r.employmentId);
    if (list) list.push(r);
    else byEmp.set(r.employmentId, [r]);
  }
  return byEmp;
}

/** The live periods of ONE employment, ascending by valid_from. */
export function arrangementsForEmploymentTx(tx: Tx, employmentId: string): Promise<ArrangementPeriod[]> {
  return tx
    .select(PERIOD_COLS)
    .from(employmentShiftArrangement)
    .where(
      and(
        eq(employmentShiftArrangement.employmentId, employmentId),
        isNull(employmentShiftArrangement.supersededAt),
      ),
    )
    .orderBy(asc(employmentShiftArrangement.validFrom));
}

/**
 * The period in force on `date` — greatest valid_from <= date, else the earliest period. `undefined` only
 * when the employment has no periods at all, which is the caller's signal to fall back to the cache
 * (employment.default_shift_id). Pure, so the rule is unit-testable without a database.
 */
export function pickArrangementOn(
  rows: ArrangementPeriod[] | undefined,
  date: string,
): ArrangementPeriod | undefined {
  if (!rows || rows.length === 0) return undefined;
  let chosen: ArrangementPeriod | undefined;
  for (const r of rows) {
    if (r.validFrom <= date) chosen = r;
    else break; // ascending — everything after this starts later still
  }
  return chosen ?? rows[0];
}
