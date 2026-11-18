/**
 * 510f4bd1 — IS THIS ONE-OFF TRANSACTION IN THE EMPLOYEE'S LATEST PAYSLIP?
 *
 * PURE, db-free, framework-free, and imports nothing — so the same rule can be applied by the SERVER
 * read (core/payroll-view.ts, which feeds the Transaction View grid, its status filter and its CSV) and
 * by the CLIENT panel derivation (app/payroll/transactions/individual/existing-context.ts) without either
 * of them re-implementing it. Two implementations of "has this been recalculated yet" is two answers
 * waiting to disagree on the same row, which is the exact confusion the request is about.
 *
 * NOTHING NEW IS DETECTED HERE AND NO STATUS IS STORED. `payroll_individual_txn` has no status column and
 * needs none. 49e7e0a2 already ships the DETECTION: `markBatchNeedsRecalc` (core/payroll.ts) stamps
 * `payroll_batch.needs_recalc_at` + `recalc_employment_ids` in the same transaction as every add / edit /
 * delete that lands on a processed run, `closeBatch` refuses to close while it stands, and the Reprocess
 * screen arrives with exactly those employments pre-ticked. What was missing was only the DISPLAY — the
 * Individual Transaction screen went on calling every row on a processed run `Processed`.
 *
 * THE ROW RULE. A row is waiting to be reprocessed when its run has been PROCESSED and the row is not in
 * the payslip that run last produced for this employee:
 *
 *   - no payslip on the run for this employment  ⇒  this money has never been calculated for them;
 *   - coalesce(txn.updated_at, txn.created_at) LATER THAN payslip.created_at  ⇒  it was keyed or changed
 *     after the payslip was worked out.
 *
 * WHY payslip.created_at IS A SOUND "LAST CALCULATED" INSTANT: selective reprocess DELETEs and re-INSERTs
 * the employee's payslip rather than updating it (core/payroll.ts reprocessBatchSelective), so the row on
 * file always carries the instant of the LAST calculation, not the first. `payslip_batch_employment_uq`
 * means the (batch, employment) join can never multiply a transaction into several rows.
 *
 * THE coalesce IS LOAD-BEARING, NOT DEFENSIVE. `payroll_individual_txn.updated_at` is NULL on a row that
 * has never been edited since it was keyed (db/schema.ts), so comparing `updated_at` alone would call
 * every never-edited row fresh — including one ADDED after the run was processed, which is precisely case
 * 3 of the request ("the new transaction has never been included in the previous payroll calculation").
 *
 * A CLOSED RUN IS NEVER STALE. Adding, editing and deleting are all refused on a closed run (the ledger's
 * own guard, and the 0011 database triggers underneath it), and `closeBatch` will not close a run that is
 * still marked — so `closed` can only mean "calculated and frozen". Same for `draft` and for an unattached
 * row: neither has a payslip to be out of date with.
 *
 * A STATUS THIS BUILD DOES NOT RECOGNISE IS NEVER CALLED STALE EITHER. The failure directions are not
 * symmetric — see txnStatusOf in existing-context.ts, which keeps the original asymmetry (an unknown
 * status degrades to "not yet paid", never to "paid").
 */

/** The facts one row needs for the rule. All of them already exist in the database; none is new. */
export type IndividualTxnStatusFacts = {
  /** The owning run's status, or null/undefined for an UNATTACHED row (keyed before the run existed). */
  batchStatus: string | null | undefined;
  /** `coalesce(txn.updated_at, txn.created_at)` as a fixed-width UTC instant string. */
  changedAt: string | null | undefined;
  /**
   * `payslip.created_at` for this (batch, employment) as a fixed-width UTC instant string; `null` when the
   * employee has NO payslip on the run. `undefined` means the caller did not supply the fact at all, which
   * is deliberately NOT the same thing: it yields no claim rather than the strongest possible one.
   */
  payslipCalculatedAt: string | null | undefined;
};

/**
 * True when this row is not in the payslip its processed run last produced for this employee.
 *
 * Both instants are compared as STRINGS on purpose: the two callers format them identically, fixed-width
 * and in UTC, so a lexicographic comparison is a chronological one and no Date crosses a serialization
 * boundary to be re-parsed in a second timezone.
 */
export function individualTxnReprocessRequired(f: IndividualTxnStatusFacts): boolean {
  // Only a PROCESSED run has payslips that a change can invalidate. Draft recalculates by being generated;
  // closed cannot be written at all; unattached has no run yet.
  if (f.batchStatus !== 'processed') return false;
  // The caller did not supply the payslip fact — make no claim rather than the worst-case one.
  if (f.payslipCalculatedAt === undefined) return false;
  // Processed run, no payslip for this employee: this money has never been calculated for them.
  if (f.payslipCalculatedAt === null) return true;
  if (f.changedAt == null) return false;
  return f.changedAt > f.payslipCalculatedAt;
}
