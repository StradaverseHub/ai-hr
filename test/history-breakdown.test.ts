/**
 * Transaction History detailed-breakdown derivation (feedback 5f8d8395 — R24 5db3ae48's deferred Phase C).
 * Pins the pure logic behind the expandable payslip breakdown on Payroll > Transaction View > History:
 *   1. Earnings/deductions/net pass through unchanged from the already-fetched row.
 *   2. Employer statutory contributions (EPF+SOCSO+EIS employer share) sum to the display total.
 *   3. The OT-converted excess (f3148da1) is taken out of the base allowance so gross still reconciles,
 *      and surfaces as its own line amount.
 *   4. recordLines pass through (itemized allowance/deduction codes the summary row discards).
 *   5. Missing statutory blob / absent keys degrade to zeros (no NaN) — legacy/edge payslips.
 * Pure unit test — no DB (the derivation is presentation-only over a ProcessedPayslipViewRow).
 */
import { describe, expect, it } from 'vitest';
import { deriveHistoryBreakdown } from '../app/payroll/transaction-view/history-breakdown';
import type { ProcessedPayslipViewRow } from '../core/payroll-view';

function row(overrides: Partial<ProcessedPayslipViewRow> = {}): ProcessedPayslipViewRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    employmentId: '00000000-0000-0000-0000-0000000000e1',
    employeeName: 'Aisyah binti Rahman',
    employeeCode: 'E001',
    companyId: '00000000-0000-0000-0000-0000000000c1',
    company: 'Acme Sdn Bhd',
    payPeriod: '2026-06',
    runType: 'regular',
    runSeq: 1,
    batchStatus: 'processed',
    basic: '3000.00',
    allowance: '500.00',
    overtime: '120.00',
    bonus: '0.00',
    gross: '3620.00',
    statutory: {},
    totalDeductions: '430.00',
    net: '3190.00',
    ...overrides,
  };
}

describe('deriveHistoryBreakdown', () => {
  it('passes earnings, deductions and net through from the row', () => {
    const b = deriveHistoryBreakdown(
      row({
        statutory: { epfEmployee: 330, socsoEmployee: 18.65, eisEmployee: 7.9, pcb: 73.45 },
      }),
    );
    expect(b.basic).toBe(3000);
    expect(b.overtime).toBe(120);
    expect(b.bonus).toBe(0);
    expect(b.gross).toBe(3620);
    expect(b.totalDeductions).toBe(430);
    expect(b.net).toBe(3190);
    // Employee-share statutory reachable off b.st for the summary row + deductions section.
    expect(b.st.epfEmployee).toBe(330);
    expect(b.st.pcb).toBe(73.45);
  });

  it('sums employer statutory contributions to the display total', () => {
    const b = deriveHistoryBreakdown(
      row({ statutory: { epfEmployer: 390, socsoEmployer: 65.25, eisEmployer: 7.9 } }),
    );
    expect(b.employerContributions.epf).toBe(390);
    expect(b.employerContributions.socso).toBe(65.25);
    expect(b.employerContributions.eis).toBe(7.9);
    expect(b.employerContributions.total).toBeCloseTo(463.15, 2);
  });

  it('nets the OT-converted excess out of the base allowance and exposes it as its own line', () => {
    const b = deriveHistoryBreakdown(
      row({
        allowance: '500.00', // stored allowance already folds in the 80 converted OT excess
        statutory: { otConvert: { code: 'OTX', name: 'OT excess payout', amount: 80 } },
      }),
    );
    expect(b.allowanceNet).toBe(420); // 500 − 80
    expect(b.otConvertAmount).toBe(80);
  });

  it('passes itemized recordLines through', () => {
    const lines = [
      { code: 'ALLW-TRVL', name: 'Travel allowance', amount: 200 },
      { code: 'DED-LOAN', name: 'Staff loan', amount: 150 },
    ];
    const b = deriveHistoryBreakdown(row({ statutory: { recordLines: lines } }));
    expect(b.recordLines).toEqual(lines);
  });

  it('includes the HRDF levy in the employer total, not just as a line (efece4ce)', () => {
    // The row and the TOTAL are one change, deliberately: showing HRDF as a line while leaving it out of
    // the sum would make the section disagree with its own arithmetic — an HR administrator adding the
    // figures by hand would get a different answer from the bold number underneath them.
    const b = deriveHistoryBreakdown(
      row({ statutory: { epfEmployer: 390, socsoEmployer: 65.25, eisEmployer: 7.9, hrdf: 30 } }),
    );
    expect(b.employerContributions.hrdf).toBe(30);
    expect(b.employerContributions.total).toBeCloseTo(493.15, 2); // 463.15 + 30
  });

  it('reports a zero HRDF levy for a company that does not pay it, without dropping the key', () => {
    // A company with no HRDF Contribution Rate resolves to 'not_registered', so the engine stores 0
    // rather than omitting the key. The breakdown must carry that 0 through — the TABLE decides not to
    // draw a row for it, which is a presentation choice; the derivation stays honest.
    const b = deriveHistoryBreakdown(
      row({ statutory: { epfEmployer: 390, socsoEmployer: 65.25, eisEmployer: 7.9, hrdf: 0 } }),
    );
    expect(b.employerContributions.hrdf).toBe(0);
    expect(b.employerContributions.total).toBeCloseTo(463.15, 2); // unchanged from before HRDF existed
  });

  it('degrades an absent statutory blob to zeros (no NaN)', () => {
    const b = deriveHistoryBreakdown(row({ statutory: null }));
    expect(b.employerContributions.total).toBe(0);
    expect(b.otConvertAmount).toBe(0);
    expect(b.allowanceNet).toBe(500); // full allowance, nothing to net out
    expect(b.recordLines).toEqual([]);
    expect(Number.isNaN(b.employerContributions.total)).toBe(false);
  });
});
