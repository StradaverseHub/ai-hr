import { payrollResultHref, type PayrollResultRun } from '../../payroll-result-href';

/**
 * b372e923 — THE PAYROLL RESULT LINK ON EACH ROW OF A COMPLETED REPROCESS.
 *
 * The reprocess result table listed every employee it had just recalculated as plain text: to open one
 * of them you had to leave this screen, return to the Payroll Process list, find the same person on the
 * run and open them from there.
 *
 * THE DESTINATION IS NOT DECIDED HERE. It is `payrollResultHref` (app/payroll/payroll-result-href.ts),
 * the same builder the normal Payroll Process run screen uses for its own per-employee links — which is
 * the reporter's third requirement stated as code rather than as a comment: there is no reprocess
 * variant of the payroll result screen because there is no second place that spells its URL.
 *
 * WHAT THIS MODULE IS FOR, THEN, IS THE JOIN. The failure the reporter named ("it should not
 * accidentally open ... another employee's result") lives entirely in it: the result rows come from
 * `payroll_employee_result_history` and the run's payslips come from `batchDetail`'s `slips`, two
 * independently-ordered lists that share only `employmentId`. A link built from the wrong row's ids
 * renders, looks right, and opens somebody else — and it is invisible to a test that counts anchors.
 * Resolving the whole table here makes that join a pure function of its inputs, so it can be run
 * against a real reprocessed run and checked row by row.
 *
 * WHY `slips` IS STILL READ WHEN THE HREF NO LONGER CARRIES A PAYSLIP ID. It is the guard, not the
 * destination: an employment with no payslip on this run has no result to open, and an anchor that
 * leads to an empty result card is still a promise this screen should not make. `slips` is read on the
 * same render, AFTER the reprocess wrote its results, so an employee this job ADDED already has one and
 * links exactly like a recalculated row rather than being special-cased into plain text.
 */

/**
 * Resolve one Payroll Result href per result row, keyed by the ROW's own id.
 *
 * @param rows  the completed job's result rows (`id` is the history row, `employmentId` the employee)
 * @param slips this run's payslips as `batchDetail` returns them — presence is what makes a row linkable
 * @param run   the run being reprocessed: its company, period and cycle identify the payroll record
 * @param from  the Payroll Process list's own filter query, already whitelisted by shape through
 *              `payrollListReturnTo` by the caller, so Back from the result returns the list as the
 *              operator left it. Absent ⇒ no `from` on the link at all.
 *
 * A row whose employment has no payslip on this run is absent from the map — never mapped to `''` or to
 * some other row's employee.
 */
export function reprocessResultHrefs(
  rows: readonly { id: string; employmentId: string }[],
  slips: readonly { id: string; employmentId: string }[],
  run: PayrollResultRun,
  from?: string,
): Map<string, string> {
  const paidOnThisRun = new Set(slips.map((sl) => sl.employmentId));

  const hrefs = new Map<string, string>();
  for (const row of rows) {
    if (!paidOnThisRun.has(row.employmentId)) continue;
    hrefs.set(row.id, payrollResultHref(run, row.employmentId, from));
  }
  return hrefs;
}
