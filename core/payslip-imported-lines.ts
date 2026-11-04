import type { PayslipAbsenceLines } from './payslip-absence-lines';
/**
 * b240c0ff — THE PAY ITEM LINES AN IMPORTED PAYROLL-HISTORY MONTH KEEPS, and how a payslip surface reads them.
 *
 * The history import (core/payroll-history-import.ts `importedComponentLines`) stamps the file's own pay
 * item lines on the payslip and its revision snapshot as `statutory.importedLines`, in exactly the kernel's
 * `componentLines` shape ({code, name, amount, buckets}).
 *
 * WHY A KEY OF ITS OWN, NOT `componentLines`. `componentLines` is EVIDENCE as well as display: the EA
 * pay-item → box routing and its completeness test (localization/my/ea-routing.ts), the payroll comparison
 * report and the "is this pay item in use" check all read it. Imported history has never been EA routing
 * evidence and the approved plan forbids moving a single EA or statutory figure, so the imported lines are
 * kept where only the DISPLAY readers below look. Kernel runs never carry the key, so nothing about how an
 * ordinary payroll run renders can change through this file.
 *
 * Pure and DB-free (client-safe), like core/payslip-earning-lines.ts beside it.
 */
import {
  payItemLinesForBuckets,
  payItemLinesReconcile,
  storedComponentLines,
  type NamedPayItemLine,
  type StoredComponentLine,
} from './payslip-earning-lines';

/** The imported pay item lines on a payslip, or [] (every kernel run, and every month imported before this). */
export function importedPayItemLines(statutory: unknown): StoredComponentLine[] {
  const st = (statutory ?? {}) as { importedLines?: unknown };
  return Array.isArray(st.importedLines) ? (st.importedLines as StoredComponentLine[]) : [];
}

/**
 * The lines a payslip SCREEN or DOCUMENT itemises its figures from: the kernel's stamp plus, for imported
 * history, the file's own lines. Display only — never hand this to an EA, statutory or comparison reader.
 */
export function displayComponentLines(statutory: unknown): StoredComponentLine[] {
  const imported = importedPayItemLines(statutory);
  const stored = storedComponentLines(statutory);
  return imported.length ? [...stored, ...imported] : stored;
}

/** Named saved deduction items shared by History, Review and the PDF. Replace a grouped residual only
 * when their stored contributions reconcile; the named absence carve is applied once on every surface. */
export function deductionLinesFor(statutory: unknown, residual: unknown, absence?: PayslipAbsenceLines): NamedPayItemLine[] {
  const lines = payItemLinesForBuckets(displayComponentLines(statutory), ['deduct']);
  if (payItemLinesReconcile(lines, residual)) return lines;
  // Same carve as History: a named absence row already owns this money. Never print it twice.
  const remaining = [...lines];
  for (const named of [absence?.unpaidLeave, absence?.absent]) {
    if (!named) continue;
    const at = remaining.findIndex(line => Math.round(line.amount * 100) === Math.round(named.amount * 100));
    if (at >= 0) remaining.splice(at, 1);
  }
  return remaining.length < lines.length && payItemLinesReconcile(remaining, residual) ? remaining : [];
}
