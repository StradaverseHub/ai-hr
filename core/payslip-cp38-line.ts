/**
 * 970e4143 — HOW A PAYSLIP SHOULD PRINT ITS CP38, decided once, from the payslip's own snapshot.
 *
 * TWO FAULTS, ONE FILE. The reporter raised the first; the second was found reproducing it and is the
 * worse of the two.
 *
 * FAULT 1 — THE ROWS OVER-ADD. `core/payroll.ts` folds the applied CP38 into the payslip's stored
 * `other_deductions` column (`slipExtraDeduct = manualApplied + cp38Applied`, then
 * `other_deductions = slipUnpaid + slipExtraDeduct + slipLoan + carry-forward delta`). Every renderer
 * printed a CP38 row AND the residual of that same column, so the CP38 was counted twice among the drawn
 * lines while the TOTAL DEDUCTIONS printed underneath them counted it once. Measured on a real run
 * (RM6,500 basic, CP38 450): EPF 715.00 · SOCSO 29.75 · EIS 11.90 · PCB 136.70 · CP38 450.00 ·
 * Other deductions 450.00 above a printed total of 1,343.35 — the lines add to 1,793.35, over by exactly
 * the instalment. Nothing anybody was PAID was wrong; the document's own arithmetic was.
 *
 * FAULT 2 — THE DOCUMENT OVERSTATED MONEY TAKEN. `statutory.cp38` is stamped from the PRE-CLAMP figure:
 * the instruction's amount, not what the EA s.24 net-floor chain could actually recover. Measured: an
 * instalment of 9,000 against 6,500 of pay deducted 5,606.65 and the payslip printed CP38 9,000.00. That
 * is not a line that fails to add up — that is a money document saying more was taken from an employee
 * than was taken. The kernel now stamps `cp38Applied` beside `cp38` so the document can say the truth.
 *
 * WHY THE APPLIED FIGURE WAS NOWHERE TO BE READ BEFORE THIS. The clamp was recorded only in
 * `deductionClampsByEmp`, which reaches a BATCH-level `s24.deduction.clamped` domain event and nothing
 * else. There was no per-slip record of it at all, so no renderer could have printed the truth even if it
 * had wanted to — which is why this item needed a kernel half as well as a display half.
 *
 * ⚠️ READ THE PAYSLIP'S OWN BLOB, never today's CP38 rows. `core/payslip-employer-borne.ts` states the
 * rule this follows in its own words: "A payslip is a historical document." A blob carrying `cp38Applied`
 * was written by an engine that knew what it recovered; a blob without it was not, and the best it can say
 * is the requested figure — which on a legacy CLAMPED slip is MORE than the column it sits in, and
 * `core/payslip-absence-lines.ts` therefore refuses to carve it out and degrades that slip to the single
 * lumped "Other deductions" row. Internally consistent, and the correct answer for a document that cannot
 * be re-issued.
 *
 * WHAT THIS FILE DOES NOT DO: it does not change any figure. `total_deductions` and `net_pay` are read
 * from the stored columns on every surface. It decides only what the CP38 row SAYS.
 *
 * ZAKAT IS NOT AFFECTED and is deliberately untouched: `slipZakat` is its OWN term in the kernel
 * (core/payroll.ts) and is NOT inside `other_deductions`, which is why a zakat row beside the residual has
 * always been arithmetically safe. See core/payslip-zakat-line.ts.
 */

/** The CP38-bearing part of a payslip's statutory snapshot. Deliberately loose — this reads history. */
export type PayslipCp38Snapshot = {
  /** The instalment the LHDN/court direction ASKED for. Stamped since 1.2.3, only when non-zero. */
  cp38?: unknown;
  /** Stamped by core/payroll.ts from 970e4143 onward: what the s.24 chain actually recovered. */
  cp38Applied?: unknown;
} | null | undefined;

export type PayslipCp38Line = {
  /** What the direction asked for this month — `statutory.cp38`, 0 when the slip carries none. */
  requested: number;
  /**
   * What to PRINT: the amount actually deducted.
   *
   * `cp38Applied` when this slip records it, else `requested` — a slip written before the stamp cannot
   * answer, and the requested figure is the only thing it knows. On an unclamped slip the two are equal,
   * so a legacy unclamped slip renders exactly as a stamped one does; on a legacy CLAMPED slip this is an
   * OVERSTATEMENT, which is why `stamped` is exposed and why the carve guard refuses such a slip rather
   * than printing this figure beside a residual it does not fit inside.
   */
  applied: number;
  /**
   * Does this slip RECORD what was recovered? False ⇒ written before 970e4143 ⇒ `applied` is a best
   * effort, not a fact. Tested by KEY PRESENCE, explicitly, never by truthiness: `cp38Applied: 0` is a
   * fully clamped instalment and is a completely different statement from "this slip predates the stamp".
   */
  stamped: boolean;
  /** Print a CP38 row at all? False when nothing was recovered — a "CP38 0.00" row asserts a deduction. */
  show: boolean;
  /**
   * Is `applied` INSIDE the slip's `other_deductions` column?
   *
   * True whenever something was recovered. CP38 has been folded into that column since the feature
   * shipped (core/payroll.ts `slipExtraDeduct`), and it is named here rather than assumed because the
   * whole of fault 1 was a reader that did not know it. A fully clamped instalment recovered nothing, so
   * nothing of it is in the column and nothing is carved back out.
   */
  insideOtherDeductions: boolean;
};

function numeric(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}
const r2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Decide what one payslip's CP38 row says, from that payslip's own statutory blob.
 *
 * Whether the row may be PRINTED beside a carved residual is not decided here: three claims compete for
 * one `other_deductions` column (unpaid leave, absence, CP38) and only the module that carves it can say
 * whether they all fit. That is `core/payslip-absence-lines.ts`, which calls this function and returns the
 * answer as `cp38` on its own result. Every surface reads it from there, so no two can disagree.
 */
export function payslipCp38Line(statutory: PayslipCp38Snapshot): PayslipCp38Line {
  const st = (statutory ?? {}) as { cp38?: unknown; cp38Applied?: unknown };
  const requested = r2(numeric(st.cp38));
  // `!= null` and not `in`: a jsonb blob can carry an explicit null (nothing writes one today, but this
  // reads history and has no validator behind it), and a null answers nothing — it must degrade to the
  // legacy path rather than be read as "recovered 0.00". `cp38Applied: 0` IS a fact and passes this test.
  const stamped = st.cp38Applied != null;
  // Clamped to the request: the recovery can never exceed what was asked for, and a blob is jsonb with no
  // validator. Floored at 0 for the same reason — a negative deduction row is not a thing.
  const applied = stamped ? Math.max(0, Math.min(requested, r2(numeric(st.cp38Applied)))) : requested;
  return { requested, applied, stamped, show: applied > 0, insideOtherDeductions: applied > 0 };
}

/**
 * THE ONE CARVE RULE, in one place, because four different row sets ask it.
 *
 * `other_deductions` is a single stored column with up to three claims folded into it: the unpaid-leave
 * amount, the absence amount and the applied CP38. A surface that names one of them must take it OUT of the
 * residual it prints, and must refuse to name it at all when the claims do not fit inside the column — see
 * `core/payslip-absence-lines.ts` for the measured case where they do not (a deferred carry-forward
 * shortfall subtracts from the column while the stamps record the full amounts) and for the legacy clamped
 * CP38 that exceeds it on its own.
 *
 * `namedAbsence` is how much of the column the CALLING surface is already naming in its own rows. The two
 * payslip screens and the document name the absence lines, so they pass that total; the Payroll Register
 * and the Transaction Detail report print no absence rows at all, so they pass 0 and their residual keeps
 * the absence money inside it. Same rule, different row set — which is precisely why the rule is a
 * parameterised function rather than copied arithmetic.
 */
export function payslipCp38Carve(
  statutory: PayslipCp38Snapshot,
  otherDeductions: unknown,
  namedAbsence = 0,
): {
  /** The facts off the blob, unmodified. */
  line: PayslipCp38Line;
  /** How much of the CP38 was taken out of the residual: the applied amount, or 0 when it did not fit. */
  carved: number;
  /** May this surface print a CP38 row? False ⇒ its money stays inside the residual below. */
  show: boolean;
  /** What is left of the column for THIS surface once `namedAbsence` and `carved` come out. Never negative. */
  residual: number;
} {
  const line = payslipCp38Line(statutory);
  const other = r2(numeric(otherDeductions));
  const named = r2(numeric(namedAbsence));
  const fits = line.insideOtherDeductions && r2(named + line.applied) <= other + 0.005;
  const carved = fits ? line.applied : 0;
  return { line, carved, show: carved > 0, residual: Math.max(0, r2(other - named - carved)) };
}
