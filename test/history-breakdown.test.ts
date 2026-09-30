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
    releasedAt: null,
    version: 1,
    basic: '3000.00',
    allowance: '500.00',
    overtime: '120.00',
    bonus: '0.00',
    gross: '3620.00',
    statutory: {},
    // 970e4143 — ProcessedPayslipViewRow now carries the payslip's stored "Other deductions" column
    // (the two Transaction History surfaces could not reconcile without it). 0 on this baseline.
    otherDeductions: '0.00',
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
    expect(b.allowanceLines).toEqual([]);
  });
});

/**
 * 417d4937 + 6b134681 — THE ALLOWANCE FIGURE IS `wage` PLUS `reimburse`, and a bonus item keeps its name.
 *
 * Two board items, one root cause: a payroll result screen that named money by the box it landed in
 * rather than by the pay item that produced it.
 *
 *  · A0004's Meal Allowance (A0040, PCB_NON-TAXABLE) is paid and is inside the Allowances figure, but a
 *    PCB-exempt amount is stamped into the `reimburse` bucket — which this screen did not itemise. The
 *    money was never missing; the NAME was, and only for the one allowance whose PCB treatment differs.
 *  · A0002's one-off "B0001 — ANGPOW" is additional remuneration, so it lands in the `bonus` bucket and
 *    the screen showed the category word instead of the item.
 */
describe('deriveHistoryBreakdown — the pay item, not the box it landed in', () => {
  const stamped = [
    { code: 'A0027', name: 'HANDPHONE', amount: 100, buckets: [{ bucket: 'wage' as const, amount: 100 }] },
    { code: 'S0008', name: 'REPLACEMENT', amount: 150, buckets: [{ bucket: 'wage' as const, amount: 150 }] },
    // The reporter's own item: PCB non-taxable, so the kernel stamps it into `reimburse`.
    { code: 'A0040', name: 'MEAL ALLOWANCE', amount: 400, buckets: [{ bucket: 'reimburse' as const, amount: 400 }] },
    { code: 'B0001', name: 'ANGPOW', amount: 500, buckets: [{ bucket: 'bonus' as const, amount: 500 }] },
  ];

  it('itemises the PCB-exempt allowance alongside the taxable ones, in fold order', () => {
    const b = deriveHistoryBreakdown(row({ allowance: '650.00', statutory: { componentLines: stamped } }));
    expect(b.allowanceLines).toEqual([
      { code: 'A0027', name: 'HANDPHONE', amount: 100 },
      { code: 'S0008', name: 'REPLACEMENT', amount: 150 },
      { code: 'A0040', name: 'MEAL ALLOWANCE', amount: 400 },
    ]);
    // …and they add up to the figure they sit under, which is the whole licence to print them.
    expect(b.allowanceLines.reduce((t, l) => t + l.amount, 0)).toBeCloseTo(b.allowanceNet, 2);
  });

  it('withholds the allowance lines when they do NOT add up to the Allowances figure', () => {
    // The same stamp under a payslip whose Allowances column is smaller than the stored contributions —
    // the shape a re-routed display_category produces, and the one that made OT/Bonus need this gate.
    // Printing 650.00 of named rows beneath a 400.00 total is the "lost transaction" reading this pair of
    // items exists to remove, so the bare total stands instead.
    const b = deriveHistoryBreakdown(row({ allowance: '400.00', statutory: { componentLines: stamped } }));
    expect(b.allowanceNet).toBeCloseTo(400, 2);
    expect(b.allowanceLines).toEqual([]);
  });

  it('keeps the bonus item’s own code and description under the Bonus figure', () => {
    const b = deriveHistoryBreakdown(row({ bonus: '500.00', statutory: { componentLines: stamped } }));
    expect(b.componentsByBucket.bonus).toEqual([{ code: 'B0001', name: 'ANGPOW', amount: 500 }]);
    // …and because it adds up to the Bonus figure, it is handed to the renderers as a printable list.
    expect(b.bonusLines).toEqual([{ code: 'B0001', name: 'ANGPOW', amount: 500 }]);
    // The bonus item must NOT leak into the allowance lines — it explains a different figure.
    expect(b.allowanceLines.some((l) => l.code === 'B0001')).toBe(false);
  });

  it('hands out overtime lines only when they add up to the Overtime figure', () => {
    const ot = [{ code: 'OT15', name: 'OVERTIME 1.5', amount: 120, buckets: [{ bucket: 'ot' as const, amount: 120 }] }];
    expect(deriveHistoryBreakdown(row({ overtime: '120.00', statutory: { componentLines: ot } })).overtimeLines)
      .toEqual([{ code: 'OT15', name: 'OVERTIME 1.5', amount: 120 }]);
    // The same stamp under a payslip whose Overtime column is 0 (the OT was folded elsewhere): the named
    // row would sit under a figure it does not explain, so the bare total stands.
    const short = deriveHistoryBreakdown(row({ overtime: '0.00', statutory: { componentLines: ot } }));
    expect(short.componentsByBucket.ot).toHaveLength(1); // the stored line is still there to read…
    expect(short.overtimeLines).toEqual([]); // …but it is not licensed to replace the figure
  });

  it('moves no money: every figure is byte-identical to the same run with the stamp stripped', () => {
    const withStamp = deriveHistoryBreakdown(row({ statutory: { componentLines: stamped, pcb: 73.45 } }));
    const without = deriveHistoryBreakdown(row({ statutory: { pcb: 73.45 } }));
    for (const k of ['basic', 'allowanceNet', 'overtime', 'bonus', 'claim', 'gross', 'totalDeductions', 'net'] as const) {
      expect(withStamp[k], k).toBe(without[k]);
    }
    expect(withStamp.st.pcb).toBe(without.st.pcb);
  });
});

/**
 * 6b134681 — THE DISPLAY BOX AND THE KERNEL BUCKET ARE NOT THE SAME QUESTION.
 *
 * This is the case that would have caught the third surface rendering its sub-lines ungated.
 * core/pay-display-category.ts exists precisely because the two diverge: the reporter's Overtime 1.5 pay
 * code is `pcb_remuneration_type = 'additional'` — correct, overtime paid in arrears IS additional
 * remuneration for LHDN — so the kernel routes its cash to the `bonus` BUCKET, while the operator
 * declared `display_category = 'overtime'` so the money shows in the Overtime BOX.
 *
 * A screen that itemises `componentsByBucket.bonus` beneath the Bonus figure then prints an RM500 row
 * under an RM0.00 total, and shows nothing under the RM500 Overtime figure that the money is actually in.
 * The printed payslip and the ESS payslip both refuse to print rows that do not add up; the derivation now
 * refuses on behalf of every renderer, so a fourth surface cannot forget to ask.
 */
describe('deriveHistoryBreakdown — reconcile before replacing (6b134681)', () => {
  /** Declared into the Overtime box, routed by the kernel to the bonus bucket. */
  const reCategorised = {
    componentLines: [
      { code: 'OT15', name: 'OVERTIME 1.5', amount: 500, buckets: [{ bucket: 'bonus' as const, amount: 500 }] },
    ],
    // 3c473773 stamps the overlay ONLY when a declared box differs from the bucket default — as here.
    displayEarnings: { basic: 3000, allowance: 500, overtime: 500, bonus: 0, claim: 0 },
  };

  it('shows NO sub-lines under either figure when the box and the bucket disagree', () => {
    const b = deriveHistoryBreakdown(row({ overtime: '0.00', bonus: '500.00', statutory: reCategorised }));
    // The boxes are the display overlay's, not the stored columns'.
    expect(b.overtime).toBe(500);
    expect(b.bonus).toBe(0);
    // The stored line is still readable — nothing is hidden from a caller that wants the raw stamp…
    expect(b.componentsByBucket.bonus).toEqual([{ code: 'OT15', name: 'OVERTIME 1.5', amount: 500 }]);
    // …but neither figure may be itemised: RM500 of rows under an RM0.00 Bonus total is the one thing a
    // money screen may never print, and the Overtime box has no component line of its own to explain it.
    expect(b.bonusLines).toEqual([]);
    expect(b.overtimeLines).toEqual([]);
  });

  it('never “explains” a figure with an empty list — an unstamped run keeps its bare totals', () => {
    const b = deriveHistoryBreakdown(row({ overtime: '0.00', bonus: '0.00', statutory: { pcb: 73.45 } }));
    expect(b.overtimeLines).toEqual([]);
    expect(b.bonusLines).toEqual([]);
    expect(b.detailNotRecorded).toBe(true);
  });

  it('moves no money: the display overlay decides the boxes, and the sub-lines decide nothing', () => {
    const b = deriveHistoryBreakdown(row({ overtime: '0.00', bonus: '500.00', statutory: reCategorised }));
    expect(b.gross).toBe(3620); // straight from the row, untouched by any of this
    expect(b.net).toBe(3190);
    expect(b.allowanceNet).toBe(500);
  });
});
