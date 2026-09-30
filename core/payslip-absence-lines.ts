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
 *     figure, they are not added beside it — `residual = otherDeductions − unpaidLeave − absent − cp38`.
 *     A slip whose whole other-deductions figure was the absence nets the residual to zero, and
 *     `showResidual` then says not to print it (it renders on `> 0`, so a zero row would be an empty line).
 *
 *     ── 970e4143 added the CP38 term, and it is the same defect a second time ──────────────────────────
 *     The applied CP38 is folded into `other_deductions` by the kernel (`slipExtraDeduct`), exactly as the
 *     unpaid-leave amount is, and every renderer printed a CP38 row BESIDE the residual that still
 *     contained it. Measured on a real run: EPF 715.00 · SOCSO 29.75 · EIS 11.90 · PCB 136.70 ·
 *     CP38 450.00 · Other deductions 450.00 above a printed TOTAL DEDUCTIONS of 1,343.35 — the rows add to
 *     1,793.35, over by exactly the instalment. So the CP38 is a THIRD claim on one column and is carved
 *     out here with the other two, and this module — not any renderer — decides whether its row prints.
 *     Zakat is NOT a claim on this column: `slipZakat` is its own term in the kernel, outside
 *     `other_deductions`, which is why a zakat row beside the residual has always been safe.
 *
 *  3. A ZERO HALF PRINTS NOTHING. Zero unpaid days and zero absent days ⇒ neither line appears, which is
 *     the ordinary month for almost every employee.
 *
 * Defensive about shape throughout: the blob is plain jsonb with no validator, so a garbage stamp degrades
 * to the pre-feature path rather than throwing on a payslip screen.
 */

import { payslipCp38Carve, type PayslipCp38Snapshot } from './payslip-cp38-line';

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
  /**
   * 970e4143 — THE CP38 ROW, decided here because it competes for the same column.
   *
   * `amount` is what was ACTUALLY deducted (core/payslip-cp38-line.ts `applied`), never the instalment the
   * direction asked for. `show` is false whenever the amount could not be carved out of
   * `other_deductions` — on that slip the residual still contains it, so a CP38 row beside the residual
   * would double-count it, and a document that adds up matters more than a breakdown.
   *
   * EVERY SURFACE MUST READ THE ROW FROM HERE and not from `statutory.cp38`: the carve decision and the
   * row are one answer, and seven surfaces got it wrong independently by each deciding for itself.
   */
  cp38: { amount: number; show: boolean };
  /** What is LEFT of "Other deductions" once the named lines AND the applied CP38 are taken out. Never negative. */
  residual: number;
  /** Whether the residual "Other deductions" row should be printed at all (it renders on > 0 today). */
  showResidual: boolean;
  /** True when this payslip carries at least one named line — i.e. it was run after e2632276 shipped. */
  any: boolean;
};

/**
 * "2 days" / "1 day", composed from two static literals rather than an ICU plural. Every surface that
 * prints a named absence line uses this, so the day count reads the same on the screen, the employee's
 * own payslip and the PDF. Deliberately NOT `{days, plural, …}`: a placeholder called without its
 * argument throws at render behind a 200, and locales whose singular and plural coincide (ms, zh, vi, th)
 * simply carry the same word twice.
 */
export const absenceDaysLabel = (days: number, one: string, many: string): string =>
  `${days} ${days === 1 ? one : many}`;

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
  const named = r2((unpaidLeave?.amount ?? 0) + (absent?.amount ?? 0));
  // 970e4143 — the third claim on this column, read off the slip's own blob (its applied figure when the
  // slip records one, else the requested figure, which is all a pre-970e4143 slip knows) and put through
  // THE SAME carve rule the register and the detail report use, with the absence lines this surface names
  // passed in. REFUSE TO CARVE OUT MORE THAN WE WERE GIVEN, which is the rule already stated below.
  //
  // A LEGACY CLAMPED slip is exactly the case that does not fit: no `cp38Applied` stamp, so `applied` is
  // the 9,000 the direction asked for while the column holds only the 5,606.65 that was recovered. Carving
  // it out would print a negative residual; printing the row beside an uncarved residual would double-count
  // it. Neither document adds up, so the CP38 row is withheld and its money stays inside the lumped figure
  // — internally consistent, and the only honest answer available from a slip that never recorded what it
  // took.
  const carve = payslipCp38Carve(st as PayslipCp38Snapshot, other, named);
  const cp38Carved = carve.carved;
  const cp38Row = { amount: carve.line.applied, show: carve.show };
  if (!unpaidLeave && !absent) {
    // Pre-feature (or a slip with nothing to name): the absence half renders exactly as before, and the
    // residual still loses whatever CP38 could be carved out of it (0 on every slip without one ⇒ byte-
    // identical for every payslip that has no CP38, which is all but a handful).
    const residual = Math.max(0, r2(other - cp38Carved));
    return { unpaidLeave: null, absent: null, cp38: cp38Row, residual, showResidual: residual > 0, any: false };
  }
  // THE STAMPS ARE NOT ALWAYS A SUBSET OF otherDeductions, which an earlier version of this comment
  // asserted. core/payroll.ts builds otherDeductions as slipUnpaid + extras PLUS
  // (carryForward.applied - carryForward.added), and a DEFERRED shortfall SUBTRACTS — while the kernel
  // stamps the full absent/unpaid amounts regardless. So under a negativeNet:'carry_forward' policy the
  // named amounts can exceed the column they are being carved out of.
  // MEASURED: basic RM6,000, 21 scheduled days all absent, custom divisor 10 -> statutory.absent
  // {days:21, amount:12600} against other_deductions 5,999.65. Clamping the residual to 0 printed
  // "Absent 12,600.00" inside a deductions block totalling 6,000.00 — a payslip that does not add up.
  //
  // So: REFUSE TO CARVE OUT MORE THAN WE WERE GIVEN. When the named lines exceed the column, fall back
  // to the pre-feature single lumped row, which is always internally consistent. Losing the breakdown
  // on a deferred-shortfall slip is strictly better than printing a document that contradicts itself.
  if (named > r2(other) + 0.005) {
    // The named lines alone exceed the column. Everything lumps — including the CP38, whose row must go
    // with it for the same reason (`cp38Carved` is already 0 here by construction: named alone is over).
    return {
      unpaidLeave: null, absent: null, cp38: { amount: carve.line.applied, show: false },
      residual: other, showResidual: other > 0, any: false,
    };
  }
  const residual = Math.max(0, r2(other - named - cp38Carved));
  return { unpaidLeave, absent, cp38: cp38Row, residual, showResidual: residual > 0, any: true };
}
