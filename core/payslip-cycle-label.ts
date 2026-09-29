/**
 * r360 (feedback 1fe55a23) — WHAT A PAYSLIP CALLS ITS PAY CYCLE, decided ONCE.
 *
 * The reporter read "Payroll payslip · Regular" on the document and asked for the company's own Pay Cycle
 * name instead ("Payroll payslip · Monthly"). "Regular" is `payroll_batch.run_type`, one of the four fixed
 * behavioural types the kernel gates on; "Monthly" is `payroll_cycle.name`, the admin-maintained label the
 * Payroll Process wizard offered when the run was opened (ADR-0069). The batch records WHICH configured
 * cycle opened it (`payroll_batch.payroll_cycle_id`, c11e81aa / migration 0441).
 *
 * WHY A MODULE FOR TWO LINES OF CODE. Three surfaces print this string — the Individual Payslip screen,
 * the preview and the downloaded PDF (the last two are one route, `?inline=1`) — and each resolves it from
 * a different read. Written out twice, the rule "the cycle name, or the run-type word when there is none"
 * is one edit away from a downloaded file disagreeing with the screen it came from, which is the class of
 * defect app/payroll/individual-payslip and lib/payslip-pdf.ts are both full of notes about. So the rule
 * is a function, and both callers hand it their own strings.
 *
 * PURE AND DB-FREE, like core/payslip-segment.ts beside it: the caller's read supplies the cycle name and
 * the caller's i18n supplies the run-type word, so nothing about the label depends on a database handle or
 * a request context and the rule is unit-testable on its own.
 *
 * NOTHING HERE IS A PAYROLL DECISION. This chooses DISPLAY TEXT. `run_type` remains the only thing the
 * kernel gates on, and no figure, gate or cycle configuration is read or written through this file.
 */

/**
 * The cycle name the run was opened under, or the run-type word when it was opened under no cycle.
 *
 * `cycleName` IS NULL ON A REACHABLE PRODUCTION STATE, not just in theory: `payroll_batch.payroll_cycle_id`
 * is nullable, every batch created before migration 0441 carries null, and so does every batch created by a
 * caller that names no cycle (tests, the legacy single-company create form — see the column's own comment
 * in db/schema.ts). Those payslips keep printing exactly the word they print today, which is why this
 * returns the fallback rather than an empty string or a dash.
 *
 * `runTypeLabel` is nullable too, and for one reason only: `lib/payslip-pdf-strings.ts` resolves the
 * run-type word through a CLOSED LIST and yields null for a stored value outside it, rather than
 * interpolating an unknown enum into `t()` and raising MISSING_MESSAGE behind a 200. A payslip whose run
 * type is unrecognised but which DID name a cycle still prints the cycle's name; one with neither prints
 * nothing at all, and the letterhead subtitle drops the segment as it already does for a null label.
 *
 * WHITESPACE IS NOT A NAME. `payroll_cycle.name` is NOT NULL but it is free text an admin typed, and a
 * name of spaces would print as a blank where a word belongs — worse than the run-type word, because the
 * reader cannot tell a missing label from a rendering fault. It falls back.
 */
export function payslipCycleLabel(p: {
  cycleName: string | null | undefined;
  runTypeLabel: string | null | undefined;
}): string | null {
  const name = typeof p.cycleName === 'string' ? p.cycleName.trim() : '';
  if (name) return name;
  const fallback = typeof p.runTypeLabel === 'string' ? p.runTypeLabel.trim() : '';
  return fallback || null;
}
