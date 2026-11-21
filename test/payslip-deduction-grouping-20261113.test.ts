/**
 * 2026-11-13 — repeated deduction lines of one pay item code print as ONE row on every payslip surface,
 * the way overtime is grouped. Three one-day UNPAID LEAVE (LUPL) transactions at 73.33 / 70.97 / 70.97 are
 * one row "3 days, 215.27". NO DATABASE.
 *
 * Surfaces: the employee payslip screen (`deductionLinesFor`, no quantity sources), the PDF
 * (`payslipDeductionBreakdown` via `buildPayslipPdfData`). Transaction History and the admin Individual
 * Payslip share `deriveHistoryBreakdown`, pinned in test/history-breakdown.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { deductionLinesFor, payslipDeductionBreakdown } from '../core/payslip-imported-lines';
import { buildPayslipPdfData, payslipPresentationRows } from '../lib/payslip-pdf';
import { labels } from './fixtures/payslip-pdf-fixture';

const lupl = (amount: number, days?: number) => ({
  code: 'LUPL', name: 'UNPAID LEAVE', amount, buckets: [{ bucket: 'deduct', amount }],
  ...(days != null ? { inputQuantity: { qty: days, unit: 'days' } } : {}),
});
const parking = { code: 'D0030', name: 'MONTHLY PARKING', amount: 20, buckets: [{ bucket: 'deduct', amount: 20 }] };
const total = (rows: { amount: number }[]) => Math.round(rows.reduce((t, r) => t + r.amount * 100, 0)) / 100;

describe('deduction rows group by code', () => {
  it('employee payslip: three one-day LUPL lines are one row of 3 days, 215.27, reconciling to Other deductions', () => {
    const statutory = { componentLines: [lupl(73.33, 1), parking, lupl(70.97, 1), lupl(70.97, 1)] };
    const lines = deductionLinesFor(statutory, 235.27);
    expect(lines).toEqual([
      { code: 'LUPL', name: 'UNPAID LEAVE', amount: 215.27, inputQuantity: { qty: 3, unit: 'days' } },
      { code: 'D0030', name: 'MONTHLY PARKING', amount: 20 },
    ]);
    expect(total(lines)).toBe(235.27);
    // A residual the rows do not explain still falls back to the bare total.
    expect(deductionLinesFor(statutory, 300)).toEqual([]);
  });

  it('mixed or missing units never invent a day count; the amount still groups', () => {
    const statutory = { componentLines: [lupl(73.33, 1), lupl(70.97)] };
    expect(deductionLinesFor(statutory, 144.3)).toEqual([{ code: 'LUPL', name: 'UNPAID LEAVE', amount: 144.3 }]);
  });

  it('quantity evidence from the consumed transactions restores the day count for a non-ABSENT code', () => {
    const statutory = { componentLines: [lupl(73.33), lupl(70.97), lupl(70.97)] };
    const day = (amount: string) => ({ componentCode: 'LUPL', consumedByThisRun: true, quantityEvidenceCurrent: true, kind: 'deduction', amount, quantity: '1', unit: 'days' });
    const { deductionLines } = payslipDeductionBreakdown(statutory, 215.27, [day('73.33'), day('70.97'), day('70.97')]);
    expect(deductionLines).toEqual([{ code: 'LUPL', name: 'UNPAID LEAVE', amount: 215.27, inputQuantity: { qty: 3, unit: 'days' } }]);
  });

  it('PDF: one "3 days" row for the grouped unpaid leave', () => {
    const d = buildPayslipPdfData({
      employee: 'Fictional', employeeCode: null, company: 'Fictional', companyReg: null, payPeriod: '2026-10',
      basic: 3000, allowance: 0, overtime: 0, bonus: 0, gross: 3000, otherDeductions: 215.27, totalDeductions: 215.27,
      net: 2784.73, employerCost: 3000, daysWorked: 23,
      statutory: { componentLines: [lupl(73.33, 1), lupl(70.97, 1), lupl(70.97, 1)] },
    }, { epf: 'EPF', socso: 'SOCSO', skbbk: 'SKBBK', eis: 'EIS', tax: 'PCB' }, { adminReview: true });
    const rows = payslipPresentationRows(d, { ...labels, periodLabel: 'October 2026', paymentDate: '31 Oct 2026' }, String);
    const unpaid = rows.deductions.filter((r) => r.label === 'UNPAID LEAVE');
    expect(unpaid).toHaveLength(1);
    expect(unpaid[0]).toMatchObject({ quantity: '3 days', amount: 215.27 });
  });
});
