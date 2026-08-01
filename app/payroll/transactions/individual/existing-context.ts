/**
 * ec845c7d — pure derivation of the Individual-Transaction wizard's "already entered / still unpaid"
 * panel from two reads that already exist. No React, no db, no i18n, so the arithmetic is unit-testable
 * (test/existing-txn-context.test.ts).
 *
 * Both inputs are EXISTING reads and that is deliberate:
 *   - `listIndividualTxnsAcross` gives everything keyed for the company + month;
 *   - `listUnattachedTxnSummary` gives the subset that never reached a payslip — d0d2c9d1's population.
 * The approved plan was explicit that this screen must surface the unpaid money rather than repeat the
 * blind spot, and equally explicit that it must NOT invent a second definition of "unpaid". So nothing
 * here decides what unpaid means; it only joins the two by employment.
 *
 * Money is summed in CENTS throughout. Adding the decimal strings as floats would drift on exactly the
 * four-figure bonuses this disclosure exists to catch.
 */

/** The two fields this module needs from an IndividualTxnViewRow. */
export type TxnAmountRow = { employmentId: string; amount: string };

/** The four fields this module needs from an UnattachedGroupRow. */
export type UnattachedSummaryRow = {
  employmentId: string;
  count: number;
  totalAmount: string;
  runState: 'none' | 'draft' | 'processed' | 'closed';
  arrivedAfterProcessing: boolean;
};

export type ExistingTxnContextRow = {
  employmentId: string;
  /** Rows already keyed for this employee + month, whatever their run state. */
  count: number;
  /** Sum of those rows, in ringgit, as a fixed-2 string. */
  total: string;
  /** The subset of `count` that has NOT reached a payslip. */
  unpaidCount: number;
  unpaidTotal: string;
  /**
   * True when the month's run has already gone without these rows — either they were keyed after it was
   * processed, or the run is past draft and they are still unattached. This is the difference between
   * "not paid YET" (the run has not happened) and "not paid, and the chance has passed", and the panel
   * colours them differently because only the second one needs acting on today.
   */
  missedTheRun: boolean;
};

const cents = (v: string) => Math.round(Number(v ?? 0) * 100);
const rm = (c: number) => (c / 100).toFixed(2);

/**
 * Join the two reads for exactly the wizard's selected employees. Employees with nothing keyed still get
 * a row (count 0) so the caller can render "nothing yet" per person without a second lookup; an id that
 * is not in `employmentIds` is dropped whatever the reads returned.
 */
export function deriveExistingTxnContext(
  employmentIds: readonly string[],
  txns: readonly TxnAmountRow[],
  unattached: readonly UnattachedSummaryRow[],
): ExistingTxnContextRow[] {
  const wanted = new Set(employmentIds.filter(Boolean));

  const all = new Map<string, { count: number; cents: number }>();
  for (const r of txns) {
    if (!wanted.has(r.employmentId)) continue;
    const a = all.get(r.employmentId) ?? { count: 0, cents: 0 };
    a.count += 1;
    a.cents += cents(r.amount);
    all.set(r.employmentId, a);
  }

  const unpaid = new Map<string, { count: number; cents: number; missed: boolean }>();
  for (const g of unattached) {
    if (!wanted.has(g.employmentId)) continue;
    const u = unpaid.get(g.employmentId) ?? { count: 0, cents: 0, missed: false };
    u.count += g.count;
    u.cents += cents(g.totalAmount);
    u.missed = u.missed || g.arrivedAfterProcessing || g.runState === 'processed' || g.runState === 'closed';
    unpaid.set(g.employmentId, u);
  }

  return [...wanted].map((employmentId) => {
    const a = all.get(employmentId) ?? { count: 0, cents: 0 };
    const u = unpaid.get(employmentId) ?? { count: 0, cents: 0, missed: false };
    return {
      employmentId,
      count: a.count,
      total: rm(a.cents),
      unpaidCount: u.count,
      unpaidTotal: rm(u.cents),
      missedTheRun: u.count > 0 && u.missed,
    };
  });
}
