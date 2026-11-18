/**
 * 3a092cf0 — HOW A PAYSLIP SHOULD PRINT ITS ZAKAT, decided once, from the payslip's own snapshot.
 *
 * THE ENGINE FIX AND THIS FILE ARE TWO HALVES OF ONE CHANGE, and shipping either alone is worse than
 * shipping neither.
 *
 * The engine half: `st.zakat` now joins `statDeductions` in core/payroll.ts, so a slip written from this
 * round on reconciles — its deduction lines sum to its stored `total_deductions`, and Net Pay follows.
 * That is the defect the reporter raised: SIG01's January slip showed EPF 410.00 + SOCSO 18.75 + EIS 7.50
 * + PCB 0.00 + Zakat 30.00 beside a total of 436.25, so RM30.00 was shown but never taken.
 *
 * ⚠️ THE HALF THAT IS EASY TO MISS: EVERY SLIP ALREADY STORED HAS THE OLD TOTAL. Nine of them carry a
 * zakat (4 employees, 7 runs, 2,569.23). If the PDF and the screens simply began printing zakat as a
 * counted deduction, every one of those documents would start contradicting itself — lines summing to
 * 466.25 above a printed total of 436.25 — which is the SAME complaint that raised this item, inflicted
 * on history. Two of them are on CLOSED runs, frozen at trigger level by migration 0011, so for those it
 * would be permanent and unfixable.
 *
 * SO THE DISPLAY ASKS THE SLIP, NOT TODAY'S CODE. `core/payslip-employer-borne.ts` states the rule this
 * follows, in its own words: "READ THE PAYSLIP'S OWN BLOB. Never re-derive from the employee's CURRENT
 * flags. A payslip is a historical document." A blob carrying `zakatInTotal` was written by an engine
 * that counted the zakat; a blob without it was not, and must render EXACTLY as it does today — the
 * muted, explicitly informational line it has always had.
 *
 * WHAT THIS FILE DOES NOT DO: it does not change any figure. `total_deductions` and `net_pay` are read
 * from the stored columns on both paths. This decides only how the zakat line is LABELLED and whether the
 * reader is told it sits outside the total.
 */

/** The zakat-bearing part of a payslip's statutory snapshot. Deliberately loose — this reads history. */
export type PayslipZakatSnapshot = {
  zakat?: unknown;
  /** Stamped by core/payroll.ts from 3a092cf0 onward. Absent on every earlier slip. */
  zakatInTotal?: unknown;
} | null | undefined;

export type PayslipZakatLine = {
  /** The amount to print, 0 when there is none. Never re-derived — straight off the snapshot. */
  amount: number;
  /** Print a zakat line at all? False when the slip carries no zakat. */
  show: boolean;
  /**
   * TRUE  — this slip's stored total already includes the zakat, so print it as an ordinary counted
   *         deduction and the section adds up.
   * FALSE — a pre-3a092cf0 slip. The stored total EXCLUDES it, so print it the way it has always been
   *         printed: muted, with the note saying it sits outside the total. Rendering it as counted
   *         would make the document lie about its own arithmetic.
   */
  countedInTotal: boolean;
};

function numeric(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Decide how one payslip prints its zakat, from that payslip's own statutory blob.
 *
 * ⚠️ `zakatInTotal` is checked for the literal `true`, not for truthiness or mere presence. A blob is
 * jsonb read back from the database and a future writer could set it to something else; only the engine
 * that actually put zakat in the total writes `true`, and anything else must fall back to the historical
 * rendering rather than guess. Same reason `payslipEmployerBorne` treats a missing key as the identity
 * path instead of inferring one.
 */
export function payslipZakatLine(statutory: PayslipZakatSnapshot): PayslipZakatLine {
  const amount = numeric((statutory as { zakat?: unknown } | null | undefined)?.zakat);
  const countedInTotal = (statutory as { zakatInTotal?: unknown } | null | undefined)?.zakatInTotal === true;
  return { amount, show: amount > 0, countedInTotal };
}
