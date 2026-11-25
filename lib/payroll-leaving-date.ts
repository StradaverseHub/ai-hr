/**
 * ad6ed930 — THE EMPLOYEE'S LAST DAY, as payroll reads it, for screens.
 *
 * The owner is `payrollEmploymentEnd` (core/payroll-employment-eligibility.ts). 7da649d3 (owner decision
 * 2026-11-25): coalesce(least(terminated_on, resignation_date), last_working_date) — the employment end date,
 * where PostgreSQL's least() ignores NULLs. The Last Working Day is the final physical working day and may be
 * earlier (annual leave cleared after it); it counts only when both other dates are empty (legacy records).
 * This is the same rule over the same three columns for a client that already holds them (the Individual
 * Transaction employee list, the Movement writer's reprocess threshold), so the date the window caps at is the
 * date the server refuses after. Pure and client-safe. The server re-reads the columns itself; this value is a
 * convenience, never the authority.
 */
export function payrollLeavingDate(d: {
  terminatedOn?: string | null;
  resignationDate?: string | null;
  lastWorkingDate?: string | null;
}): string | null {
  const date = (v: string | null | undefined): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const ends = [d.terminatedOn, d.resignationDate].filter(date);
  if (ends.length) return [...ends].sort()[0]!;
  return date(d.lastWorkingDate) ? d.lastWorkingDate : null;
}

/** The payroll month ('YYYY-MM') a calendar date falls in. */
export const payrollMonthOf = (date: string): string => date.slice(0, 7);
