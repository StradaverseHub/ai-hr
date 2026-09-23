/**
 * a96d320c rev 2 — WHETHER A PAYSLIP PRINTS ITS SKBBK LINE, decided ONCE, from the payslip's own snapshot.
 *
 * THE DEFECT, AND WHY IT IS THE SAME DEFECT IN FOUR PLACES. Four surfaces render one payslip — the printed
 * document (lib/payslip-pdf.ts), the employee's own payslip screen, the admin Individual Payslip and
 * Transaction View → History — and all four asked `socsoSkbbk > 0`. That predicate was standing in for a
 * question it cannot answer. SKBBK (Lindung 24 Jam) is a per-employee ELECTION: `subject_to_skbbk`
 * (db/schema.ts), and when it is off the engine returns 0 for the leg (localization/my/payroll.ts
 * `skbbkOn`). So `> 0` conflates:
 *
 *   · "this employee has no SKBBK election"          → an absent line is right; it asserts nothing, and
 *   · "this employee HAS one and contributed 0.00"    → an absent line is wrong; the zero IS the assertion.
 *
 * CLAUDE.md §8 states the difference in one sentence — "an absent box asserts nothing; 0.00 asserts the
 * money does not exist" — and it is the same sentence that keeps EPF, SOCSO, EIS and PCB printing at 0.00
 * on this document. docs/audits/0085-delta-keys-sign-inventory.md lists all four sites as Class B, the
 * class where a line VANISHES from a money document, which it calls the worst class precisely because
 * there is nothing left on the page for the reader to question.
 *
 * ⚠️ THE ELECTION WAS NOT ON THE PAYSLIP, AND THAT IS WHY THIS FILE HAS TWO CLAUSES RATHER THAN ONE.
 * Before this round the only SKBBK fact the run stamped was `employerBears.skbbk`, which says who FUNDED
 * the leg, not whether there is one. `core/payroll.ts` now stamps `skbbkSubject` on every payslip it
 * writes. Every payslip that already exists carries NO stamp and cannot be given one — the election lives
 * on `employee_statutory_my`, and reading TODAY's row to decide what last January's document says is the
 * re-derivation this whole family of modules exists to refuse (see core/payslip-employer-borne.ts: "a
 * payslip is a historical document"). Worse, it would be actively destructive: unticking the box today
 * would make a real RM50.00 SKBBK deduction disappear off a document that still prints a TOTAL DEDUCTIONS
 * which counts it, so the payslip would stop adding up.
 *
 * Hence: print the line when the slip SAYS the employee is subject, OR when there is a figure to print.
 * The second clause is what makes every existing document render exactly as it does today, and it is also
 * the clause that can never be dropped — a line carrying money is never hidden by an election.
 *
 * `!== 0` rather than `> 0` on that second clause, deliberately: ADR-0085 will let a restatement delta go
 * negative, and a negative that silently removes the line is the Class B failure again. This costs nothing
 * today (the deltas are still clamped at 0) and closes the trapdoor for the unstamped population, which
 * is the population that will still be being read years from now.
 *
 * Pure and dependency-free, like every module beside it: imported by `lib/` and by a CLIENT component.
 */

/** The SKBBK-bearing part of a payslip's statutory snapshot. Deliberately loose — this reads history. */
export type PayslipSkbbkSnapshot = {
  socsoSkbbk?: unknown;
  /** Stamped by core/payroll.ts from a96d320c rev 2 onward. ABSENT on every earlier slip. */
  skbbkSubject?: unknown;
} | null | undefined;

/**
 * Does this payslip RECORD an SKBBK election, and what does it say?
 *
 * `null` means the slip cannot answer — it predates the stamp — and is not the same as `false`. Checked
 * for the literal booleans rather than for truthiness or presence, for the same reason
 * `payslipZakatLine` checks `zakatInTotal === true`: a jsonb blob is not a type, and a value this version
 * does not understand must fall back to the historical rendering instead of being guessed at.
 */
export function payslipSkbbkSubject(statutory: PayslipSkbbkSnapshot): boolean | null {
  const v = (statutory as { skbbkSubject?: unknown } | null | undefined)?.skbbkSubject;
  return v === true ? true : v === false ? false : null;
}

/**
 * Print the SKBBK row?
 *
 * `subject` is what the payslip recorded (`payslipSkbbkSubject`), NEVER today's employee row. `amount` is
 * the figure the row would print — the employee-borne one on the surfaces that net out an employer-bears
 * setting, because that is the number beside the label.
 */
export function payslipSkbbkLineShown(subject: boolean | null, amount: unknown): boolean {
  if (subject === true) return true;
  const n = typeof amount === 'number' ? amount : typeof amount === 'string' ? Number(amount) : NaN;
  return Number.isFinite(n) && n !== 0;
}
