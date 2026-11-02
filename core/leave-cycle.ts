/** Pure leave-year cycle policy, shared by leave, TOIL and imports. No database or runtime dependencies. */

/** ADR-0040 2D-2: the start of an employee's current earned-accrual cycle as of `asOf`.
 *  calendar → 1 Jan of asOf's year. anniversary → the most-recent hire-month anniversary on/before
 *  asOf (so each employee's cycle is anchored to their hire month; a joiner's first cycle starts at
 *  hire). Returns ISO yyyy-mm-01. */
export function earnedCycleStart(hiredOn: string, asOf: string, cycle: string | null | undefined): string {
  if (cycle !== 'anniversary') return `${asOf.slice(0, 4)}-01-01`;
  const hireMonth = hiredOn.slice(5, 7);
  const [ay, am] = asOf.split('-').map(Number);
  const cycleYear = am >= Number(hireMonth) ? ay : ay - 1;
  return `${cycleYear}-${hireMonth}-01`;
}

/**
 * c8052ae3 — THE LAST DAY OF THE CYCLE THAT OPENS AT `cycleStart`, inclusive.
 *
 * ⚠️ THIS EXISTS BECAUSE A CYCLE HAD A START AND NO END, AND THAT COST A CUSTOMER 147 LEDGER ROWS.
 * Every "how much has this cycle already granted" sum in this file filtered ledger rows on
 * `effectiveOn >= cycleStart` with NO UPPER BOUND. A tenant that had opened the 2027 and 2028 leave
 * years ahead therefore had those years' 1-January grants counted as "already granted THIS cycle": the
 * profile recalc read 180.00 posted against a single-year expectation of 60.00 and clawed back −120.00,
 * driving Hospitalization Leave to −60.00 on an ordinary profile save. The recalc audit says so in its
 * own words (previous 180.00 → new 60.00).
 *
 * Calendar cycle (`YYYY-01-01`) ⇒ `YYYY-12-31`. Anniversary cycle (`YYYY-MM-01`) ⇒ the day before the
 * next anniversary. Pure UTC calendar arithmetic on a date-only string — it derives nothing from an
 * instant, so no tenant-timezone question arises (the DATES rule is about `new Date()`, not about
 * adding a year to a stored ISO date).
 *
 * INCLUSIVE, because ledger comparisons here are `<=`: a 31-December accrual belongs to its own year.
 */
export function leaveCycleEnd(cycleStart: string): string {
  const [y, m, d] = cycleStart.split('-').map(Number);
  return new Date(Date.UTC(y + 1, m - 1, d) - 86_400_000).toISOString().slice(0, 10);
}

/** Leave Year Type override (feedback e1a51aea, extended by f3a64d90 → adcdf215): the LIVE per-type override
 *  values. 'a2a' and 'c2c' reuse the existing anniversary/calendar semantics; 'a2c' (Anniversary to Calendar)
 *  went live with f3a64d90 — its leave YEAR is the calendar year (see resolveLeaveYearCycle), and the ONLY
 *  novel behaviour is the HIRE-year ANNUAL up-front part-year entitlement (a2cFirstYearEntitledToDate).
 *  Migration 0310 widened the DB CHECK to match this set (defence-in-depth). */
export const LEAVE_YEAR_CYCLE_OVERRIDES = ['a2a', 'c2c', 'a2c'] as const;
export type LeaveYearCycleOverride = (typeof LEAVE_YEAR_CYCLE_OVERRIDES)[number];

/** Anniversary to Calendar (feedback f3a64d90): the raw stored override string. Deliberately NOT a third
 *  cycle token — a2c's leave YEAR is calendar (Jan-1 boundary, calendar carry/forfeit anchoring, full
 *  calendar grant from year two). Only the first-year ANNUAL proration rides this raw value. */
export const A2C_OVERRIDE = 'a2c';

/**
 * Leave Year Type override (feedback e1a51aea): resolve the EFFECTIVE cycle for one (leave type, company)
 * pair. A per-type override wins where set — 'a2a' maps to the existing 'anniversary' semantics, 'c2c' to
 * 'calendar' — and null/undefined (every pre-existing type) falls back to the company cycle exactly as
 * today, so behaviour is byte-identical until HR makes an explicit per-type choice. Every engine consumer
 * of company.leave_cycle in a per-type computation resolves through this ONE function (accrueEarnedLeave,
 * the two recalc kernels' callers, leaveEntitlementBreakdown) so the override cannot half-apply.
 *
 * Anniversary to Calendar (f3a64d90 → adcdf215) maps to 'calendar' — NOT a new third cycle. Its year runs
 * 1 Jan → 31 Dec like any calendar type; only the employee's FIRST (hire) year is prorated (join → 31 Dec)
 * and granted UP FRONT from the join date. Mapping it here keeps earnedCycleStart, the carry/forfeit
 * anchoring, openLeaveYear's year-two grant and every resolve call-site byte-identical, and gets
 * year-two-onward behaviour for free.
 */
export function resolveLeaveYearCycle(
  override: string | null | undefined,
  companyCycle: string | null | undefined,
): string | null | undefined {
  if (override === 'a2a') return 'anniversary';
  if (override === 'c2c' || override === A2C_OVERRIDE) return 'calendar';
  return companyCycle;
}

