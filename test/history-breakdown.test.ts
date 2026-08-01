/**
 * Transaction History detailed-breakdown derivation (feedback 5f8d8395 — R24 5db3ae48's deferred Phase C).
 * Pins the pure logic behind the expandable payslip breakdown on Payroll > Transaction View > History:
 *   1. Earnings/deductions/net pass through unchanged from the already-fetched row.
 *   2. Employer statutory contributions (EPF+SOCSO+EIS employer share) sum to the display total.
 *   3. The OT-converted excess (f3148da1) is taken out of the base allowance so gross still reconciles,
 *      and surfaces as its own line amount.
 *   4. recordLines pass through (itemized allowance/deduction codes the summary row discards).
 *   5. Missing statutory blob / absent keys degrade to zeros (no NaN) — legacy/edge payslips.
 *   6. componentLines (862ed0ad) group under the figure each explains, and a run stamped before that
 *      change reports detailNotRecorded rather than an empty breakdown.
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
    // rather than omitting the key. The breakdown must carry that 0 through; how the TABLE presents it is
    // a separate decision (efece4ce re-fix: it now labels the row "Not registered" rather than hiding it,
    // because a hidden row read as a failed calculation — see test/hrdf-registration-visibility.test.ts).
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

/**
 * Feedback 862ed0ad — the per-item detail behind each summarised figure.
 *
 * The request was to break an "Allowance MYR 200.00" line into the allowances behind it. That could not be
 * done from stored data: core/payroll.ts earningsOf summed recurring pay items into the wage/ot/bonus/
 * reimburse/deduct buckets and kept nothing per item. It is now stamped at generate time, FORWARD ONLY —
 * so these tests cover both the stamped shape and the historical one, because both are live on production.
 */
describe('deriveHistoryBreakdown — per-item component detail (862ed0ad)', () => {
  const lines = [
    { code: 'ALLOW_TRAVEL', name: 'Travel Allowance', amount: 120, buckets: [{ bucket: 'wage' as const, amount: 120 }] },
    { code: 'ALLOW_PHONE', name: 'Phone Allowance', amount: 80, buckets: [{ bucket: 'wage' as const, amount: 80 }] },
    { code: 'OT_SHIFT', name: 'Shift Premium', amount: 45, buckets: [{ bucket: 'ot' as const, amount: 45 }] },
    { code: 'DED_PARK', name: 'Parking', amount: 30, buckets: [{ bucket: 'deduct' as const, amount: 30 }] },
  ];

  it('groups each item under the figure it contributed to', () => {
    const b = deriveHistoryBreakdown(row({ statutory: { componentLines: lines } }));
    expect(b.detailNotRecorded).toBe(false);
    expect(b.componentsByBucket.wage).toEqual([
      { code: 'ALLOW_TRAVEL', name: 'Travel Allowance', amount: 120 },
      { code: 'ALLOW_PHONE', name: 'Phone Allowance', amount: 80 },
    ]);
    expect(b.componentsByBucket.ot).toEqual([{ code: 'OT_SHIFT', name: 'Shift Premium', amount: 45 }]);
    expect(b.componentsByBucket.deduct).toEqual([{ code: 'DED_PARK', name: 'Parking', amount: 30 }]);
    expect(b.componentsByBucket.bonus).toEqual([]);
  });

  // THE INVARIANT THE PLAN MADE A PRECONDITION: a breakdown that can disagree with the total beside it is
  // worse than no breakdown. It holds because both come from the same stamp — nothing is recomputed here.
  it('sums, per bucket, to the figure it explains', () => {
    const b = deriveHistoryBreakdown(row({ statutory: { componentLines: lines } }));
    const sum = (rows: { amount: number }[]) => rows.reduce((t, r) => t + r.amount, 0);
    expect(sum(b.componentsByBucket.wage)).toBe(200); // the reporter's own MYR 200.00 allowance
    expect(sum(b.componentsByBucket.ot)).toBe(45);
    expect(sum(b.componentsByBucket.deduct)).toBe(30);
  });

  // One item, two figures: the exempt portion is paid untaxed while the remainder is taxable. Flattening
  // that to a single bucket would misstate where the money went.
  it('keeps an item that split across two figures in both', () => {
    const split = [
      { code: 'ALLOW_MEAL', name: 'Meal Allowance', amount: 300, buckets: [
        { bucket: 'reimburse' as const, amount: 200 },
        { bucket: 'wage' as const, amount: 100 },
      ] },
    ];
    const b = deriveHistoryBreakdown(row({ statutory: { componentLines: split } }));
    expect(b.componentsByBucket.reimburse).toEqual([{ code: 'ALLOW_MEAL', name: 'Meal Allowance', amount: 200 }]);
    expect(b.componentsByBucket.wage).toEqual([{ code: 'ALLOW_MEAL', name: 'Meal Allowance', amount: 100 }]);
    expect(b.componentLines[0].amount).toBe(300);
  });

  // The 18 runs already on production. They must not render an empty breakdown under a non-zero total.
  it('reports detailNotRecorded for a run stamped before the change', () => {
    const b = deriveHistoryBreakdown(row({ statutory: { recordLines: [] } }));
    expect(b.detailNotRecorded).toBe(true);
    expect(b.componentLines).toEqual([]);
    expect(b.componentsByBucket.wage).toEqual([]);
  });

  it('degrades without a statutory blob at all', () => {
    const b = deriveHistoryBreakdown(row({ statutory: null as never }));
    expect(b.detailNotRecorded).toBe(true);
    expect(b.componentsByBucket).toEqual({ wage: [], ot: [], bonus: [], reimburse: [], deduct: [] });
  });
});
