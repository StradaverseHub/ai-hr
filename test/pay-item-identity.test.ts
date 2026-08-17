/**
 * 6b134681 + 417d4937 — ONE PAY ITEM, ONE IDENTITY, ON EVERY SURFACE THAT SHOWS IT.
 *
 * Two board items, one root cause. A0002's one-off "B0001 — ANGPOW RM500" printed as "Bonus RM500.00",
 * and A0004's "A0040 — MEAL ALLOWANCE RM400" was recorded under a previous item's remark and left out of
 * the History itemisation. In both, the money was correct and stored, the code and the description were
 * on the payslip, and the RENDERER answered with the category (or a note) instead of the item.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE PER-RENDERER TESTS. The hazard the plan named is not that one
 * screen is wrong — it is that three screens each derive the answer for themselves and DRIFT. The PDF has
 * its own builder, Transaction View → History has its own derivation, and the ESS payslip had neither.
 * So this pins the CONTRACT they now share (core/payslip-earning-lines.ts) and then walks the same stored
 * payslip through each consumer, asserting the same label and the same amount come out — and that not one
 * money figure moved, because the whole change is a display change.
 *
 * The ESS payslip page is an async server component and cannot be rendered here; what is asserted for it
 * is the exact derivation it calls (`storedComponentLines` → `payItemLinesForBuckets` →
 * `payItemLinesReconcile` → `payItemLabel`), which is the same call chain the PDF builder uses. The
 * History grid is rendered for real in test/history-table-pay-item.dom.test.tsx.
 */
import { describe, expect, it } from 'vitest';
import {
  payItemLabel,
  payItemLinesForBuckets,
  payItemLinesReconcile,
  storedComponentLines,
} from '../core/payslip-earning-lines';
import { buildPayslipPdfData } from '../lib/payslip-pdf';
import { deriveHistoryBreakdown } from '../app/payroll/transaction-view/history-breakdown';
import type { ProcessedPayslipViewRow } from '../core/payroll-view';

/**
 * A0002's January payslip, in the shape production stores it: a one-off keyed as B0001 / ANGPOW that the
 * kernel routed to the bonus bucket (additional remuneration for EPF/PCB), beside two ordinary allowances
 * and one PCB-exempt one — which is A0004's item, folded in so a single fixture carries both reports.
 */
const componentLines = [
  { code: 'A0027', name: 'HANDPHONE', amount: 100, buckets: [{ bucket: 'wage', amount: 100 }] },
  { code: 'S0008', name: 'REPLACEMENT', amount: 150, buckets: [{ bucket: 'wage', amount: 150 }] },
  { code: 'A0040', name: 'MEAL ALLOWANCE', amount: 400, buckets: [{ bucket: 'reimburse', amount: 400 }] },
  { code: 'B0001', name: 'ANGPOW', amount: 500, buckets: [{ bucket: 'bonus', amount: 500 }] },
];

const statutory = {
  epfEmployee: 616, socsoEmployee: 27.75, eisEmployee: 11.1, pcb: 1680,
  epfEmployer: 672, socsoEmployer: 97.15, eisEmployer: 11.1, hrdf: 56,
  componentLines,
  // The record line the kernel now names from the pay item (core/payroll.ts) — the very string that used
  // to read "A0020 — DIRECTOR FEE" on the reporter's own payslip.
  recordLines: [{ code: 'A0040', name: 'MEAL ALLOWANCE', amount: 400, nonPayable: false }],
};

/** The columns as stored: allowance 650 (100 + 150 + 400), bonus 500. */
const stored = {
  employee: 'Ismail', employeeCode: 'A0002', company: 'Isedecor Bina Sdn Bhd', companyReg: null,
  payPeriod: '2026-01', basic: '5000.00', allowance: '650.00', overtime: '0', bonus: '500.00',
  gross: '6150.00', otherDeductions: '0', totalDeductions: '2334.85', net: '3815.15',
  employerCost: '6986.25', daysWorked: '31', statutory,
};
const borne = { epf: 'EPF', socso: 'SOCSO', skbbk: 'SKBBK', eis: 'EIS', tax: 'PCB' } as const;

function historyRow(): ProcessedPayslipViewRow {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    employmentId: '00000000-0000-0000-0000-0000000000e1',
    employeeName: 'Ismail',
    employeeCode: 'A0002',
    companyId: '00000000-0000-0000-0000-0000000000c1',
    company: 'Isedecor Bina Sdn Bhd',
    payPeriod: '2026-01',
    runType: 'regular',
    runSeq: 1,
    batchStatus: 'processed',
    releasedAt: null,
    version: 1,
    basic: '5000.00',
    allowance: '650.00',
    overtime: '0.00',
    bonus: '500.00',
    gross: '6150.00',
    statutory,
    totalDeductions: '2334.85',
    net: '3815.15',
  } as ProcessedPayslipViewRow;
}

describe('the shared contract — core/payslip-earning-lines', () => {
  it('labels a pay item by CODE and DESCRIPTION, never by the box it landed in', () => {
    expect(payItemLabel({ code: 'B0001', name: 'ANGPOW' })).toBe('B0001 · ANGPOW');
    expect(payItemLabel({ code: 'A0040', name: 'MEAL ALLOWANCE' })).toBe('A0040 · MEAL ALLOWANCE');
  });

  it('degrades to whichever half it has rather than printing an empty prefix', () => {
    expect(payItemLabel({ code: null, name: 'One-off earning' })).toBe('One-off earning');
    expect(payItemLabel({ code: 'TXN_EARNING', name: '' })).toBe('TXN_EARNING');
    expect(payItemLabel({})).toBe('');
  });

  it('selects the lines that explain a figure, and drops the ones that contributed nothing to it', () => {
    const lines = storedComponentLines(statutory);
    expect(payItemLinesForBuckets(lines, ['bonus'])).toEqual([{ code: 'B0001', name: 'ANGPOW', amount: 500 }]);
    expect(payItemLinesForBuckets(lines, ['ot'])).toEqual([]);
    expect(payItemLinesForBuckets(lines, ['wage', 'reimburse']).map((l) => l.code)).toEqual(['A0027', 'S0008', 'A0040']);
  });

  it('refuses to reconcile an EMPTY list, so a payslip with no stamp never “explains” its total with nothing', () => {
    expect(payItemLinesReconcile([], 0)).toBe(false);
    expect(payItemLinesReconcile([], 500)).toBe(false);
  });

  it('reconciles only against the figure the lines actually add up to', () => {
    const bonus = payItemLinesForBuckets(storedComponentLines(statutory), ['bonus']);
    expect(payItemLinesReconcile(bonus, 500)).toBe(true);
    expect(payItemLinesReconcile(bonus, 500.004)).toBe(true); // half a sen — every input is already rounded
    expect(payItemLinesReconcile(bonus, 450)).toBe(false); // a display category moved money: keep the lump
  });

  it('reads a payslip with no stamp at all as “nothing recorded”, not as an error', () => {
    expect(storedComponentLines(null)).toEqual([]);
    expect(storedComponentLines({})).toEqual([]);
    expect(storedComponentLines({ componentLines: 'nonsense' })).toEqual([]);
  });
});

describe('the same payslip, through all three renderers (rule 17)', () => {
  it('PDF — B0001 · ANGPOW replaces the lumped Bonus row, and the allowance rows keep the PCB-exempt item', () => {
    const d = buildPayslipPdfData(stored, borne);
    expect(d.bonusLines).toEqual([{ code: 'B0001', name: 'ANGPOW', amount: 500 }]);
    expect(d.earningLines).toEqual([
      { code: 'A0027', name: 'HANDPHONE', amount: 100 },
      { code: 'S0008', name: 'REPLACEMENT', amount: 150 },
      { code: 'A0040', name: 'MEAL ALLOWANCE', amount: 400 },
    ]);
    // Each list adds up to its OWN stored figure — the guard that licenses printing them.
    expect(payItemLinesReconcile(d.bonusLines!, d.bonus)).toBe(true);
    expect(payItemLinesReconcile(d.earningLines!, d.allowance)).toBe(true);
    // The bonus item never leaks into the allowance rows and vice versa.
    expect(d.earningLines!.some((l) => l.code === 'B0001')).toBe(false);
    expect(d.bonusLines!.some((l) => l.code === 'A0040')).toBe(false);
  });

  it('ESS payslip — the page’s own derivation yields the same label and the same amount', () => {
    // Verbatim the chain app/me/payslip/[payslipId]/page.tsx runs.
    const lines = storedComponentLines(stored.statutory);
    const bonusLines = payItemLinesForBuckets(lines, ['bonus']);
    const otLines = payItemLinesForBuckets(lines, ['ot']);
    expect(payItemLinesReconcile(bonusLines, 500)).toBe(true);
    expect(bonusLines.map(payItemLabel)).toEqual(['B0001 · ANGPOW']);
    expect(bonusLines[0].amount).toBe(500);
    // No OT component on this run ⇒ no OT sub-lines, and the bare Overtime figure stands.
    expect(payItemLinesReconcile(otLines, 0)).toBe(false);
  });

  it('History — the grid’s derivation yields the same label and the same amount', () => {
    const b = deriveHistoryBreakdown(historyRow());
    expect(b.componentsByBucket.bonus.map(payItemLabel)).toEqual(['B0001 · ANGPOW']);
    expect(b.componentsByBucket.bonus[0].amount).toBe(500);
    expect(b.allowanceLines.map(payItemLabel)).toEqual([
      'A0027 · HANDPHONE',
      'S0008 · REPLACEMENT',
      'A0040 · MEAL ALLOWANCE',
    ]);
    expect(b.allowanceLines.reduce((t, l) => t + l.amount, 0)).toBeCloseTo(b.allowanceNet, 2);
  });

  it('the three agree LINE FOR LINE — this is the drift the plan was written to prevent', () => {
    const pdf = buildPayslipPdfData(stored, borne);
    const hist = deriveHistoryBreakdown(historyRow());
    const ess = payItemLinesForBuckets(storedComponentLines(stored.statutory), ['bonus']);
    const shape = (ls: { code: string | null; name: string; amount: number }[]) =>
      ls.map((l) => `${payItemLabel(l)} ${l.amount.toFixed(2)}`);
    expect(shape(pdf.bonusLines!)).toEqual(['B0001 · ANGPOW 500.00']);
    expect(shape(ess)).toEqual(shape(pdf.bonusLines!));
    expect(shape(hist.componentsByBucket.bonus)).toEqual(shape(pdf.bonusLines!));
    expect(shape(pdf.earningLines!)).toEqual(shape(hist.allowanceLines));
  });

  it('NOT ONE FIGURE MOVES — the change is display, and the arithmetic is byte-identical', () => {
    const withStamp = buildPayslipPdfData(stored, borne);
    // The same payslip with its per-item stamp stripped: the state every pre-862ed0ad run is in.
    const { componentLines: _drop, ...bare } = statutory;
    const without = buildPayslipPdfData({ ...stored, statutory: bare }, borne);
    for (const k of [
      'basic', 'allowance', 'overtime', 'bonus', 'claim', 'gross', 'epfEmployee', 'socsoEmployee',
      'eisEmployee', 'pcb', 'cp38', 'otherDeductions', 'totalDeductions', 'net', 'epfEmployer',
      'socsoEmployer', 'eisEmployer', 'employerCost', 'hrdf',
    ] as const) {
      expect(withStamp[k], k).toBe(without[k]);
    }
    // …and the stripped one falls back to the grouped rows it always printed.
    expect(without.bonusLines).toEqual([]);
    expect(without.earningLines).toEqual([]);
    expect(without.detailNotRecorded).toBe(true);

    const hist = deriveHistoryBreakdown(historyRow());
    expect(hist.gross).toBe(6150);
    expect(hist.net).toBe(3815.15);
    expect(hist.bonus).toBe(500);
    expect(hist.allowanceNet).toBe(650);
  });
});
