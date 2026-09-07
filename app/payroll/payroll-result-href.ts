/**
 * b372e923 — ONE PAYROLL RESULT DESTINATION, SPELLED ONCE.
 *
 * The reporter's third requirement is not about a link existing, it is about WHICH screen it opens:
 * "The Payroll Result opened from Reprocess shall use the same screen, layout, information and
 * calculation result as the normal Payroll Process result. There should not be a separate or different
 * payroll-result interface for Reprocess." Their expected-function note names the parameters too —
 * Payroll Year, Payroll Month, Payroll Cycle and Employee ID.
 *
 * That destination already exists and already has one builder's worth of judgement in it: the payroll
 * run screen's own per-employee links (e440991b point 5, app/payroll/[batchId]/page.tsx), which open
 * Transaction View's History tab for that employee on that run. Two screens each writing their own
 * version of that URL is exactly how "the same result screen" quietly stops being the same one — a
 * changed tab, a dropped cycle, a period taken from today instead of from the run. So the run screen
 * and the reprocess result now call THIS function, and there is no second spelling to drift from.
 *
 * THE SELECTION TRAVELS IN THE URL, deliberately — the reasoning is e440991b's and is unchanged.
 * Transaction View scope-guards every parameter it receives: an `employmentId` outside the viewer's
 * employee scope is coerced to "no selection" rather than queried, and `companyId` likewise. Handing
 * the selection over as a link inherits that fence; passing pre-resolved rows across the RSC boundary
 * instead would route around it.
 *
 * WHY NOT THE PERIOD FROM `new Date()`: the run carries its own `payPeriod` and `runType`, and those
 * are what identify the payroll record the operator is looking at. A result screen that resolved the
 * month from the clock would open the wrong run for anyone reviewing last month's payroll.
 */

/** The one payroll result screen. Not a copy, not a reprocess-specific variant. */
export const PAYROLL_RESULT_PATH = '/payroll/transaction-view';

/** The identifying facts of the run whose result is being opened. `payPeriod` is 'YYYY-MM'. */
export type PayrollResultRun = { companyId: string; payPeriod: string; runType: string };

/**
 * The payroll result href for ONE employee on ONE run.
 *
 * @param run          the run being read — its company, period and cycle, never today's
 * @param employmentId the employee whose result to open
 * @param from         the Payroll Process list's own filter query, when the operator arrived carrying
 *                     one, so Back from the result returns the list as they left it. The destination
 *                     resolves it through `payrollProcessBack` → `payrollListReturnTo`, which is the
 *                     single authority on what a `from` may be; omitted entirely when there is none,
 *                     so an unfiltered visit keeps a clean URL.
 */
export function payrollResultHref(run: PayrollResultRun, employmentId: string, from?: string): string {
  const [year, month] = run.payPeriod.split('-').map(Number);
  const q = new URLSearchParams({
    tab: 'history',
    companyId: run.companyId,
    employmentId,
    year: String(year),
    month: String(month),
    cycle: run.runType,
  });
  if (typeof from === 'string' && from !== '') q.set('from', from);
  return `${PAYROLL_RESULT_PATH}?${q.toString()}`;
}
