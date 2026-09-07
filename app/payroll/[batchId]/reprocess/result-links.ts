/**
 * b372e923 — THE PAYROLL RESULT LINK ON EACH ROW OF A COMPLETED REPROCESS.
 *
 * The reprocess result table listed every employee it had just recalculated as plain text: to open one
 * of them you had to leave this screen, return to the Payroll Process list, find the same person on the
 * run and open them from there. The destination is NOT new — `/payroll/individual-payslip` is the same
 * HR-facing payroll result screen `app/payroll/pcb-detail/page.tsx` and
 * `app/payroll/statutory-detail/page.tsx` already send their Back links to, and it is deliberately the
 * ONLY one: a second payroll-result surface built for reprocessing could print figures that disagree
 * with the run's.
 *
 * WHY THIS IS A MODULE AND NOT FOUR LINES IN THE PAGE. The failure the reporter named ("it should not
 * accidentally open ... another employee's result") lives entirely in the JOIN: the result rows come
 * from `payroll_employee_result_history` and the payslip ids come from `batchDetail`'s `slips`, two
 * independently-ordered lists that share only `employmentId`. A link built from the wrong row's ids
 * renders, looks right, and opens somebody else — and it is invisible to a test that counts anchors.
 * Resolving the whole table here makes that join a pure function of its two inputs, so it can be run
 * against a real reprocessed run and checked row by row.
 *
 * PAYSLIP ID, NOT EMPLOYMENT ID ALONE. `slips` is read on this same render, after the reprocess has
 * written its results, so the id resolved here is the payslip that exists NOW on this run — including
 * one an ADD created moments ago, which is why an addition links like every other row rather than being
 * special-cased into plain text.
 *
 * NO ROW IS GIVEN A DEAD LINK. An employment with no payslip on this run resolves to nothing and the
 * caller renders plain text; `/payroll/individual-payslip` shape-checks the id it is handed, but an
 * anchor that leads to a "not found" card is still a promise this screen should not make.
 */

/** The one payroll result screen. Shared with pcb-detail / statutory-detail, never a second copy. */
export const PAYROLL_RESULT_PATH = '/payroll/individual-payslip';

/**
 * Resolve one Payroll Result href per result row, keyed by the ROW's own id.
 *
 * @param rows  the completed job's result rows (`id` is the history row, `employmentId` the employee)
 * @param slips this run's payslips as `batchDetail` returns them (`id` is the payslip)
 * @param from  the Payroll Process list's own filter query, exactly as this screen received it, so Back
 *              from the payslip returns the list as the operator left it. Forwarded VERBATIM and
 *              URL-encoded: the destination whitelists it by shape through `payrollListReturnTo`
 *              (`lib/return-to.ts`), which is the single authority on what a `from` may be, and
 *              re-implementing that judgement here would give the product two answers.
 *
 * A row whose employment has no payslip on this run is absent from the map — never mapped to `''` or to
 * some other row's payslip.
 */
export function reprocessResultHrefs(
  rows: readonly { id: string; employmentId: string }[],
  slips: readonly { id: string; employmentId: string }[],
  from?: string,
): Map<string, string> {
  const payslipIdOf = new Map<string, string>();
  for (const sl of slips) payslipIdOf.set(sl.employmentId, sl.id);

  const hrefs = new Map<string, string>();
  for (const row of rows) {
    const payslipId = payslipIdOf.get(row.employmentId);
    if (!payslipId) continue;
    const q = new URLSearchParams({ employmentId: row.employmentId, payslipId });
    if (typeof from === 'string' && from !== '') q.set('from', from);
    hrefs.set(row.id, `${PAYROLL_RESULT_PATH}?${q.toString()}`);
  }
  return hrefs;
}
