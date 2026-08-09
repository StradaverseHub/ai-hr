/**
 * e2632276 — the two NAMED absence lines a payslip prints in place of the unnamed lump.
 *
 * THE PROBLEM THIS SOLVES IS A SENTENCE, NOT AN AMOUNT. The unpaid-leave deduction has always run, has
 * always been taken BEFORE EPF / SOCSO / EIS / PCB, and is correct. What the payslip said about it was
 * "Other deductions 387.10" — no name, no day count, nothing anyone could check. The reporter asked for an
 * ABSENT pay code because the figure they wanted was invisible, not because it was missing. Now the kernel
 * stamps `unpaidLeave { days, amount }` and `absent { days, amount }` onto the payslip's statutory blob and
 * this module turns that stamp into rows.
 *
 * THREE RULES, in one place because three surfaces render this (the admin payslip, the employee's own
 * payslip, and the PDF) and they must not each invent their own arithmetic:
 *
 *  1. READ THE PAYSLIP'S OWN BLOB, never today's configuration. A payslip issued before this shipped
 *     carries no stamp, gets no named lines, and keeps printing the single lumped row exactly as it does
 *     now. That is why `otherDeductions` is passed in and returned as `residual` unchanged on that path:
 *     the 67 already-issued payslips are byte-identical.
 *
 *  2. THE SECTION MUST STILL SUM TO `totalDeductions`. The named lines come OUT of the "Other deductions"
 *     figure, they are not added beside it — `residual = otherDeductions − unpaidLeave − absent`. A slip
 *     whose whole other-deductions figure was the absence nets the residual to zero, and `showResidual`
 *     then says not to print it (it currently renders on `> 0`, so a zero row would be a new, empty line).
 *
 *  3. A ZERO HALF PRINTS NOTHING. Zero unpaid days and zero absent days ⇒ neither line appears, which is
 *     the ordinary month for almost every employee.
 *
 * Defensive about shape throughout: the blob is plain jsonb with no validator, so a garbage stamp degrades
 * to the pre-feature path rather than throwing on a payslip screen.
 */

export type PayslipAbsenceLine = {
  /** Day count as recorded on the payslip. May be fractional (a half-day unpaid request contributes 0.5). */
  days: number;
  /** Ringgit amount, already rounded once to 2dp by the kernel. */
  amount: number;
};

export type PayslipAbsenceLines = {
  /** The approved-unpaid-leave half of the old lump, or null when this slip carries no stamp / a zero. */
  unpaidLeave: PayslipAbsenceLine | null;
  /** The absence half (no attendance record, or explicitly marked Absent), or null. */
  absent: PayslipAbsenceLine | null;
  /** What is LEFT of "Other deductions" once the named lines are taken out of it. Never negative. */
  residual: number;
  /** Whether the residual "Other deductions" row should be printed at all (it renders on > 0 today). */
  showResidual: boolean;
  /** True when this payslip carries at least one named line — i.e. it was run after e2632276 shipped. */
  any: boolean;
};

const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};
const r2 = (x: number): number => Math.round(x * 100) / 100;

const lineOf = (raw: unknown): PayslipAbsenceLine | null => {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { days?: unknown; amount?: unknown };
  const amount = r2(n(o.amount));
  // Only a POSITIVE amount is a line. A stamp that somehow recorded zero has nothing to say, and a row
  // reading "Absent · 0 days · RM0.00" is noise.
  if (amount <= 0) return null;
  return { days: n(o.days), amount };
};

/**
 * Split one payslip's "Other deductions" figure into its named absence lines plus the residual.
 *
 * `statutory` is the payslip's stored blob; `otherDeductions` is the payslip's own stored column (string or
 * number — both surfaces read it straight off the row).
 */
export function payslipAbsenceLines(statutory: unknown, otherDeductions: unknown): PayslipAbsenceLines {
  const other = r2(n(otherDeductions));
  const st = (statutory ?? {}) as { unpaidLeave?: unknown; absent?: unknown };
  const unpaidLeave = lineOf(st.unpaidLeave);
  const absent = lineOf(st.absent);
  if (!unpaidLeave && !absent) {
    // Pre-feature (or a slip with nothing to name): render exactly as before.
    return { unpaidLeave: null, absent: null, residual: other, showResidual: other > 0, any: false };
  }
  // Clamped at 0 rather than allowed negative: the stamps are always a subset of `otherDeductions` by
  // construction, so a negative residual could only come from a corrupted blob, and printing a negative
  // "Other deductions" would be worse than printing none.
  const residual = Math.max(0, r2(other - (unpaidLeave?.amount ?? 0) - (absent?.amount ?? 0)));
  return { unpaidLeave, absent, residual, showResidual: residual > 0, any: true };
}
