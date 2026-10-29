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

/**
 * 5a5309d5 — THE THREE FIGURES THAT STILL SHOWED ONLY A TOTAL.
 *
 *  1. Overtime the ATTENDANCE engine paid is recorded per leg in `statutory.otDetail`, never as a pay item,
 *     so the `ot` bucket is empty and the panel printed one Overtime amount. It now falls back to those
 *     legs — the same preference the printed payslip applies (lib/payslip-pdf.ts `overtimeLinesOf`).
 *  2. A run's own deduction pay items (D0030 MONTHLY PARKING) were stamped into the `deduct` bucket and
 *     folded unnamed into "Other deductions"; only imported history was itemised.
 *  3. Non-payable record lines (BIK, VOLA) sat in the mixed "Itemised payroll items" list.
 *
 * Every list is still handed out ONLY when it adds up to the figure it sits under.
 */
describe('deriveHistoryBreakdown — overtime legs, named deductions and non-payable amounts (5a5309d5)', () => {
  const sum = (rows: { amount: number }[]) => Math.round(rows.reduce((t, r) => t + r.amount, 0) * 100) / 100;
  /** Three statutory legs as the attendance prefill stamps them: qty × rate is each amount to the sen. */
  const otDetail = {
    lines: [
      { kind: 'workday', qty: 4, unit: 'hours', rate: 25, amount: 100 },
      { kind: 'rest_day', qty: 4, unit: 'hours', rate: 20, amount: 80 },
      { kind: 'holiday', qty: 2, unit: 'hours', rate: 30, amount: 60 },
    ],
  };

  it('itemises attendance overtime by leg, with its hours, and the legs sum to the Overtime figure', () => {
    const b = deriveHistoryBreakdown(row({ overtime: '240.00', statutory: { otDetail } }));
    expect(b.overtimeLines).toEqual([
      { code: '', name: '', amount: 100, detail: { qty: 4, rate: 25, unit: 'hours' }, otLeg: 'workday' },
      { code: '', name: '', amount: 80, detail: { qty: 4, rate: 20, unit: 'hours' }, otLeg: 'rest_day' },
      { code: '', name: '', amount: 60, detail: { qty: 2, rate: 30, unit: 'hours' }, otLeg: 'holiday' },
    ]);
    expect(sum(b.overtimeLines)).toBe(240);
    expect(b.overtime).toBe(240);
  });

  it('falls back to the bare Overtime total when the recorded legs do not add up to it', () => {
    expect(deriveHistoryBreakdown(row({ overtime: '300.00', statutory: { otDetail } })).overtimeLines).toEqual([]);
    // A leg in a shape this version does not know is dropped, so the rest fall short and nothing is listed.
    const unknown = { lines: [...otDetail.lines.slice(0, 2), { ...otDetail.lines[2], kind: 'night_shift' }] };
    expect(deriveHistoryBreakdown(row({ overtime: '240.00', statutory: { otDetail: unknown } })).overtimeLines).toEqual([]);
    // A leg whose hours × rate does not make its amount is dropped the same way.
    const wrong = { lines: [...otDetail.lines.slice(0, 2), { ...otDetail.lines[2], qty: 3 }] };
    expect(deriveHistoryBreakdown(row({ overtime: '240.00', statutory: { otDetail: wrong } })).overtimeLines).toEqual([]);
  });

  it('prefers the overtime PAY ITEMS when the run has them, exactly as the printed payslip does', () => {
    const componentLines = [
      { code: 'OT15', name: 'OVERTIME 1.5', amount: 240, buckets: [{ bucket: 'ot' as const, amount: 240 }] },
    ];
    const b = deriveHistoryBreakdown(row({ overtime: '240.00', statutory: { componentLines, otDetail } }));
    expect(b.overtimeLines).toEqual([{ code: 'OT15', name: 'OVERTIME 1.5', amount: 240 }]);
  });

  it('lists a run’s own deduction pay items under Other deductions when they add up to it', () => {
    const componentLines = [
      { code: 'D0030', name: 'MONTHLY PARKING', amount: 20, buckets: [{ bucket: 'deduct' as const, amount: 20 }] },
      { code: 'D0041', name: 'STAFF WELFARE', amount: 5.5, buckets: [{ bucket: 'deduct' as const, amount: 5.5 }] },
    ];
    const b = deriveHistoryBreakdown(row({ otherDeductions: '25.50', statutory: { componentLines } }));
    expect(b.absence.residual).toBe(25.5);
    expect(b.deductionLines).toEqual([
      { code: 'D0030', name: 'MONTHLY PARKING', amount: 20 },
      { code: 'D0041', name: 'STAFF WELFARE', amount: 5.5 },
    ]);
    expect(sum(b.deductionLines)).toBe(b.absence.residual);
  });

  it('shows the bare Other deductions total when the deduction items do not add up to it', () => {
    // A loan instalment (or a clamped deduction) inside the column: the items explain only part of it.
    const componentLines = [
      { code: 'D0030', name: 'MONTHLY PARKING', amount: 20, buckets: [{ bucket: 'deduct' as const, amount: 20 }] },
    ];
    const b = deriveHistoryBreakdown(row({ otherDeductions: '70.00', statutory: { componentLines } }));
    expect(b.absence.residual).toBe(70);
    expect(b.deductionLines).toEqual([]);
  });

  it('does not list a deduction item twice when its money is already the named Unpaid leave row', () => {
    const componentLines = [
      { code: 'UPL', name: 'UNPAID LEAVE', amount: 250, buckets: [{ bucket: 'deduct' as const, amount: 250 }] },
      { code: 'D0030', name: 'MONTHLY PARKING', amount: 20, buckets: [{ bucket: 'deduct' as const, amount: 20 }] },
    ];
    const statutory = { componentLines, unpaidLeave: { days: 1, amount: 250 } };
    // The column holds the 250 ONCE: it is already printed as "Unpaid leave · 1 day", so only the
    // parking item is left to explain the 20.00 residual.
    const once = deriveHistoryBreakdown(row({ otherDeductions: '270.00', statutory }));
    expect(once.absence.unpaidLeave).toEqual({ days: 1, amount: 250 });
    expect(once.absence.residual).toBe(20);
    expect(once.deductionLines).toEqual([{ code: 'D0030', name: 'MONTHLY PARKING', amount: 20 }]);
    // When the column genuinely holds both (the leave engine AND a UPL pay item both charged), both items
    // are separate money in the residual and both are listed.
    const twice = deriveHistoryBreakdown(row({ otherDeductions: '520.00', statutory }));
    expect(twice.absence.residual).toBe(270);
    expect(twice.deductionLines.map((l) => l.code)).toEqual(['UPL', 'D0030']);
    // And when removing the overlap still does not reconcile, the bare total stands.
    expect(deriveHistoryBreakdown(row({ otherDeductions: '300.00', statutory })).deductionLines).toEqual([]);
  });

  it('splits stamped non-payable lines into their own list and leaves everything else itemised', () => {
    const recordLines = [
      { code: 'BIK_HOUSE', name: 'BIK (Household Servant)', amount: 500, nonPayable: true },
      { code: 'TXN_EARNING', name: 'Sunday callout', amount: 120, nonPayable: false },
      { code: 'VOLA', name: 'VOLA', amount: 100, nonPayable: true },
      // Written before the stamp existed (r185): never re-derived, so it stays in the ordinary list.
      { code: 'BIK_CAR', name: 'Car benefit', amount: 300 },
      // A recorded employer contribution is not a non-payable amount for this box.
      { code: 'C0001', name: 'Employer insurance', amount: 40, nonPayable: true, kind: 'contribution' },
    ];
    const b = deriveHistoryBreakdown(row({ statutory: { recordLines } }));
    expect(b.nonPayableLines.map((l) => l.code)).toEqual(['BIK_HOUSE', 'VOLA']);
    expect(b.nonPayableTotal).toBe(600);
    expect(b.itemisedRecordLines.map((l) => l.code)).toEqual(['TXN_EARNING', 'BIK_CAR', 'C0001']);
    // Each line is in exactly one list, and the full stored array (which the export reads) is untouched.
    expect(b.nonPayableLines.length + b.itemisedRecordLines.length).toBe(recordLines.length);
    expect(b.recordLines).toEqual(recordLines);
  });

  it('a payslip with no non-payable lines has an empty Non-payable list and a zero total', () => {
    const b = deriveHistoryBreakdown(row({ statutory: { recordLines: [{ code: 'X', name: 'X', amount: 1, nonPayable: false }] } }));
    expect(b.nonPayableLines).toEqual([]);
    expect(b.nonPayableTotal).toBe(0);
    expect(b.itemisedRecordLines).toHaveLength(1);
  });

  it('INVARIANT: every list the panel renders sums to the figure it sits under, and no figure moves', () => {
    const statutory = {
      componentLines: [
        { code: 'A0010', name: 'Travel Allowance', amount: 100, buckets: [{ bucket: 'wage' as const, amount: 100 }] },
        { code: 'A0011', name: 'Phone Allowance', amount: 50, buckets: [{ bucket: 'wage' as const, amount: 50 }] },
        { code: 'B0001', name: 'Performance Bonus', amount: 500, buckets: [{ bucket: 'bonus' as const, amount: 500 }] },
        { code: 'D0030', name: 'Monthly Parking', amount: 20, buckets: [{ bucket: 'deduct' as const, amount: 20 }] },
      ],
      otDetail,
      recordLines: [{ code: 'BIK_HOUSE', name: 'BIK (Household Servant)', amount: 500, nonPayable: true }],
      epfEmployee: 380, socsoEmployee: 20, eisEmployee: 8, pcb: 30.6,
    };
    const figures = {
      basic: '4000.00', allowance: '150.00', overtime: '240.00', bonus: '500.00', gross: '4890.00',
      otherDeductions: '20.00', totalDeductions: '458.60', net: '4431.40',
    };
    const b = deriveHistoryBreakdown(row({ ...figures, statutory }));
    const pairs: [string, { amount: number }[], number][] = [
      ['allowances', b.allowanceLines, b.allowanceNet],
      ['overtime', b.overtimeLines, b.overtime],
      ['bonus', b.bonusLines, b.bonus],
      ['other deductions', b.deductionLines, b.absence.residual],
      ['non-payable', b.nonPayableLines, b.nonPayableTotal],
    ];
    for (const [name, lines, figure] of pairs) {
      expect(lines.length, `${name} is itemised`).toBeGreaterThan(0);
      expect(sum(lines), `${name} lines sum to the figure`).toBe(figure);
    }
    // Independent expected values, not read back from the derivation.
    expect([b.allowanceNet, b.overtime, b.bonus, b.absence.residual, b.nonPayableTotal]).toEqual([150, 240, 500, 20, 500]);
    // The non-payable amount is outside gross and net: the earnings rows still make gross without it.
    expect(b.basic + b.allowanceNet + b.overtime + b.bonus).toBe(b.gross);
    // Stripping every stamp leaves every figure byte-identical — this is a display change only.
    const bare = deriveHistoryBreakdown(row({ ...figures, statutory: { epfEmployee: 380, socsoEmployee: 20, eisEmployee: 8, pcb: 30.6 } }));
    for (const k of ['basic', 'allowanceNet', 'overtime', 'bonus', 'gross', 'otherDeductions', 'totalDeductions', 'net'] as const) {
      expect(b[k], k).toBe(bare[k]);
    }
    expect(b.absence.residual).toBe(bare.absence.residual);
  });
});
