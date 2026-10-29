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

/**
 * The named imported deduction items behind the "Other deductions" row, or nothing.
 *
 * Handed out ONLY when they add up to the figure that row prints (`residual`, core/payslip-absence-lines.ts),
 * the same reconcile-before-replacing rule every other itemisation follows, so a deductions box can never
 * stop adding up to its TOTAL DEDUCTIONS. An imported "UPL 250.00" and a second deduction print as two rows
 * instead of one lump. Reads `importedLines` only: kernel runs keep their single row exactly as before.
 */
export function deductionLinesFor(statutory: unknown, residual: unknown): NamedPayItemLine[] {
  const lines = payItemLinesForBuckets(importedPayItemLines(statutory), ['deduct']);
  return payItemLinesReconcile(lines, residual) ? lines : [];
}
