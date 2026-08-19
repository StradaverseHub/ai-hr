/**
 * Feedback 5a29686c — which Year and Month the Individual Payslip dropdowns may offer.
 *
 * THE DEFECT. The Year dropdown was `Array.from({ length: 11 }, (_, i) => nowYear + 1 - i)` — the same
 * eleven years for every employee, whether or not any of them held a payslip. A reader could choose
 * 2031, or a year before this person was hired, and get a blank screen that said nothing about why.
 * For most employees nine of the eleven options led nowhere. The request that raised it read the
 * screen's "Payroll runs in this selection" card as a history list and asked for a Year / Month /
 * Cycle selector instead; reproducing it found the selector already built and THIS the real gap.
 *
 * WHY IT IS PURE AND SEPARATE. The rules below are the whole of the change, and every one of them is a
 * judgement that can be got wrong quietly — a dropdown that omits the value it is displaying, or that
 * empties itself before an employee is chosen, still renders and still returns 200. Kept out of the
 * page so they are asserted directly, the way `history-breakdown.ts` is.
 *
 * THE THREE RULES, and the reason for each:
 *
 *   1. THE OPTIONS ARE THE EMPLOYEE'S OWN PERIODS. `periods` is the distinct 'YYYY-MM' set from that
 *      employee's payslips (core/payroll-view.ts `listPayslipPeriodsFor`), already fenced on the
 *      caller's companies. Every option therefore leads to a payslip.
 *
 *   2. THE SELECTED VALUE IS ALWAYS AN OPTION, even when it has no payslip. A <select> whose value is
 *      absent from its options silently displays the first option instead, so a URL carrying
 *      ?year=2031 would FILTER on 2031 while the control read "All" — the screen would be lying about
 *      what it applied. Carrying the guarded selection in is what keeps control and query agreeing.
 *      It is not a dead option: it is there BECAUSE it is what is currently being asked for.
 *
 *   3. NO PERIODS ⇒ THE OLD WINDOW, deliberately. Before an employee is chosen, and for an employee
 *      with no payslips at all, there is nothing to derive from. An empty Year dropdown is worse than
 *      a wide one, so the screen degrades to exactly the behaviour it had before this change — never
 *      to nothing.
 */

/** Every month, in the order a dropdown shows them. The no-periods fallback for `months`. */
export const ALL_MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;

/** How many years the fallback window spans, and how far ahead it reaches — unchanged from the fixed
 *  window this replaced, so "no employee chosen" looks exactly as it always has. */
const FALLBACK_YEARS = 11;
const FALLBACK_AHEAD = 1;

export type PeriodOptions = {
  /** Newest year first — the order the dropdown lists them, and the order the payslip read returns. */
  years: number[];
  /** '01'..'12', ascending. */
  months: string[];
};

/**
 * @param periods  distinct 'YYYY-MM' this employee has a payslip for (any order; deduped here anyway).
 * @param selected the GUARDED current selection — what the query is actually filtering on, not the raw
 *                 query string. `year` absent means "All"; `month` is 1..12.
 * @param nowYear  today's year, injected so the fallback window is testable without mocking the clock.
 */
export function payslipPeriodOptions(
  periods: readonly string[],
  selected: { year?: number; month?: number },
  nowYear: number,
): PeriodOptions {
  // Only well-formed 'YYYY-MM' contributes. A malformed row would otherwise produce a NaN year that
  // sorts unpredictably and renders as an empty option nobody can select.
  const clean = periods.filter((p) => /^\d{4}-(0[1-9]|1[0-2])$/.test(p));

  const periodYears = [...new Set(clean.map((p) => Number(p.slice(0, 4))))];
  const years = periodYears.length
    ? [...new Set([...(selected.year != null ? [selected.year] : []), ...periodYears])].sort((a, b) => b - a)
    : Array.from({ length: FALLBACK_YEARS }, (_, i) => nowYear + FALLBACK_AHEAD - i);

  // Months narrow to the CHOSEN year. With no year chosen they are every month this employee was ever
  // paid in — still strictly fewer dead options than all twelve, and it keeps the two dropdowns
  // consistent rather than having Month ignore what Year already said.
  const periodMonths = [
    ...new Set(
      clean.filter((p) => selected.year == null || Number(p.slice(0, 4)) === selected.year).map((p) => p.slice(5, 7)),
    ),
  ];
  const selectedMonth = selected.month != null ? [String(selected.month).padStart(2, '0')] : [];
  // THE FALLBACK CONDITION IS `clean`, NOT `periodMonths` — and the difference is the whole defect over
  // again. An employee WITH payslips who is looking at a year that holds none has no month worth
  // offering: falling back to all twelve there would put twelve dead options back on the screen under a
  // different name. It offers the selected month alone (rule 2), or nothing but "All". Only an employee
  // with no payslips AT ALL gets the wide list, for the reason in rule 3.
  const months = clean.length ? [...new Set([...selectedMonth, ...periodMonths])].sort() : [...ALL_MONTHS];

  return { years, months };
}
