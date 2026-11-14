/**
 * ad6ed930 — THE EMPLOYEE'S LAST DAY, as payroll reads it, for screens.
 *
 * The owner is `payrollEmploymentEnd` (core/payroll-employment-eligibility.ts): least(terminated_on,
 * resignation_date, last_working_date), where PostgreSQL's least() ignores NULLs. This is the same rule over
 * the same three columns for a client that already holds them (the Individual Transaction employee list), so
 * the date the window caps at is the date the server refuses after. Pure and client-safe. The server re-reads
 * the columns itself; this value is a convenience, never the authority.
 */
export function payrollLeavingDate(d: {
  terminatedOn?: string | null;
  resignationDate?: string | null;
  lastWorkingDate?: string | null;
}): string | null {
  const dates = [d.terminatedOn, d.resignationDate, d.lastWorkingDate].filter(
    (v): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v),
  );
  return dates.length ? [...dates].sort()[0]! : null;
}

/** The payroll month ('YYYY-MM') a calendar date falls in. */
export const payrollMonthOf = (date: string): string => date.slice(0, 7);
