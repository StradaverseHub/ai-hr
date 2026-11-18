/** Canonical tenure/cut-off/working-day proration. Counts stay integer ratios so
 * Formula Builder can apply exact decimal money without duplicating the payroll calendar owner. */
const daysInMonth=(year:number,month:number)=>new Date(Date.UTC(year,month,0)).getUTCDate();
export function payrollProrationRatio(
  payPeriod: string,
  hiredOn: string,
  terminatedOn: string | null,
  opts?: {
    divisorDays?: number;
    workingDayBasis?: { roster: number[]; holidays: Set<string> };
    // c7fdfcf6 (Payroll Schedule) — the SALARY cut-off window overriding the calendar-month bounds. Absent ⇒
    // the calendar month `[M-01 … M-end]` (byte-identical to the legacy formula). When a policy/company cut-off
    // is configured, the join-date / resignation proration is counted against this window (e.g. anchor 26 ⇒
    // [26 of M-1 … 25 of M]) and the denominator is the window's own length in days — delivering the reporter's
    // "salary cut-off determines Basic Salary / Join-Date / Resignation proration".
    window?: { start: string; end: string };
  },
): {numerator:number;denominator:number} {
  const [year, month1] = payPeriod.split('-').map(Number);
  const dim = daysInMonth(year, month1);
  const periodStart = opts?.window?.start ?? `${payPeriod}-01`;
  const periodEnd = opts?.window?.end ?? `${payPeriod}-${String(dim).padStart(2, '0')}`;
  // Inclusive length of the window in days (cross-month safe). For the calendar-month default this equals `dim`.
  const windowDays =
    Math.round((Date.parse(`${periodEnd}T00:00:00Z`) - Date.parse(`${periodStart}T00:00:00Z`)) / 86_400_000) + 1;
  const start = hiredOn > periodStart ? hiredOn : periodStart;
  const end = terminatedOn && terminatedOn < periodEnd ? terminatedOn : periodEnd;
  if (start > periodEnd || end < periodStart) return {numerator:0,denominator:1};
  const denom = opts?.divisorDays && opts.divisorDays > 0 ? opts.divisorDays : windowDays;
  if (opts?.workingDayBasis) {
    // Count the employee's WORKING days within [start, end] vs the working days across the whole period.
    const { roster, holidays } = opts.workingDayBasis;
    const isWork = (d: string): boolean => {
      const dt = new Date(`${d}T00:00:00Z`);
      const iso = ((dt.getUTCDay() + 6) % 7) + 1; // 1=Mon … 7=Sun
      return roster.includes(iso) && !holidays.has(d);
    };
    let eligibleWork = 0;
    for (let t = Date.parse(`${start}T00:00:00Z`); t <= Date.parse(`${end}T00:00:00Z`); t += 86_400_000) {
      if (isWork(new Date(t).toISOString().slice(0, 10))) eligibleWork++;
    }
    // Working-day denominator: the configured CustomDays divisor when set, else the period's own working days.
    let denomWork = opts.divisorDays && opts.divisorDays > 0 ? opts.divisorDays : 0;
    if (denomWork === 0) {
      for (let t = Date.parse(`${periodStart}T00:00:00Z`); t <= Date.parse(`${periodEnd}T00:00:00Z`); t += 86_400_000) {
        if (isWork(new Date(t).toISOString().slice(0, 10))) denomWork++;
      }
    }
    if (denomWork === 0) return {numerator:0,denominator:1};
    return {numerator:Math.min(denomWork,eligibleWork),denominator:denomWork};
  }
  // Cross-month-safe eligible-day count (inclusive). For a same-month calendar window this is identical to the
  // legacy `end.day − start.day + 1`.
  const eligibleDays =
    Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
  return {numerator:Math.min(denom,Math.max(0,eligibleDays)),denominator:denom};
}

/** Existing payroll keeps its original Number quotient and monetary rounding contract. */
export function payrollProrationFactor(...args:Parameters<typeof payrollProrationRatio>):number{
 const {numerator,denominator}=payrollProrationRatio(...args);return numerator/denominator;
}
