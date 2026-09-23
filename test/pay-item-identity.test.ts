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
 *
 * FOUR SURFACES, NOT THREE. Payroll → Individual Payslip (app/payroll/individual-payslip/page.tsx) is the
 * admin preview of the same slip, and it reads `deriveHistoryBreakdown` — so its itemisation is pinned
 * here through that derivation, including the reconciliation gate the last describe below is about.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  earningRowShown,
  payItemLabel,
  payItemLinesForBuckets,
  payItemLinesReconcile,
  recordLineIdentity,
  storedComponentLines,
} from '../core/payslip-earning-lines';
import { payslipSkbbkLineShown, payslipSkbbkSubject } from '../core/payslip-skbbk-line';
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

/** A source file with its comments stripped — prose describing a rule must never be what satisfies a
 *  source-shape guard. Module-level because three describes below assert across the same files. */
const SRC_ROOT = path.resolve(__dirname, '..');
const readSrc = (rel: string) =>
  fs
    .readFileSync(path.join(SRC_ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

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

  it('Individual Payslip — the admin preview itemises from the SAME gated lists, not the raw buckets', () => {
    const b = deriveHistoryBreakdown(historyRow());
    // What app/payroll/individual-payslip/page.tsx renders under Bonus and under Overtime.
    expect(b.bonusLines.map(payItemLabel)).toEqual(['B0001 · ANGPOW']);
    expect(b.bonusLines[0].amount).toBe(500);
    expect(b.overtimeLines).toEqual([]); // no OT component on this run ⇒ the bare Overtime figure stands
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

/**
 * 6b134681 — THE DISPLAY BOX IS NOT THE KERNEL BUCKET, AND THE FOURTH SURFACE MUST KNOW IT.
 *
 * THE CASE THAT WOULD HAVE CAUGHT THE MISS. Three of the four surfaces gated their new Overtime/Bonus
 * sub-lines behind `payItemLinesReconcile`; Payroll → Individual Payslip mapped the raw
 * `componentsByBucket` instead, which is a DIFFERENT list from the figure printed above it:
 *
 *   · the figure comes from `payslipDisplayEarnings` — the DISPLAY box the operator declared;
 *   · `componentsByBucket` is grouped by the KERNEL bucket, the statutory routing.
 *
 * core/pay-display-category.ts exists precisely because those two diverge. The reporter's own Overtime 1.5
 * code is `pcb_remuneration_type = 'additional'` (correct — arrears overtime IS additional remuneration
 * for LHDN), so the kernel routes its cash to `bonus` while the declared box is `overtime`. On the
 * ungated screen that printed "OT15 · OVERTIME 1.5  RM500.00" underneath a "Bonus RM0.00" row, and left
 * the RM500.00 Overtime figure — the box the money is actually in — with nothing under it.
 *
 * Every surface must reach the SAME verdict on this payslip: keep the grouped rows.
 */
describe('display box vs kernel bucket — all four surfaces keep the lump (6b134681)', () => {
  const divergent = {
    epfEmployee: 550, epfEmployer: 600, socsoEmployee: 24.75, eisEmployee: 9.9, pcb: 320,
    componentLines: [
      { code: 'OT15', name: 'OVERTIME 1.5', amount: 500, buckets: [{ bucket: 'bonus', amount: 500 }] },
    ],
    // 3c473773 stamps the overlay ONLY when a declared box differs from the bucket default — as here.
    displayEarnings: { basic: 5000, allowance: 0, overtime: 500, bonus: 0, claim: 0 },
  };
  const divergentStored = {
    ...stored, allowance: '0', overtime: '0', bonus: '500.00', gross: '5500.00', statutory: divergent,
  };

  it('PDF — neither figure may be itemised, so both grouped rows stand', () => {
    const d = buildPayslipPdfData(divergentStored, borne);
    expect(d.overtime).toBe(500); // the DISPLAY box…
    expect(d.bonus).toBe(0);
    expect(d.bonusLines).toEqual([{ code: 'OT15', name: 'OVERTIME 1.5', amount: 500 }]); // …vs the BUCKET
    expect(d.overtimeLines).toEqual([]);
    // The predicate `earningsRowsOf` applies before it may replace a grouped row, on both figures.
    expect(payItemLinesReconcile(d.bonusLines!, d.bonus)).toBe(false);
    expect(payItemLinesReconcile(d.overtimeLines!, d.overtime)).toBe(false);
  });

  it('ESS payslip — the page’s own chain reaches the same verdict', () => {
    const lines = storedComponentLines(divergentStored.statutory);
    expect(payItemLinesReconcile(payItemLinesForBuckets(lines, ['bonus']), 0)).toBe(false);
    expect(payItemLinesReconcile(payItemLinesForBuckets(lines, ['ot']), 500)).toBe(false);
  });

  it('History and Individual Payslip — the gated lists are EMPTY where the raw buckets are not', () => {
    const b = deriveHistoryBreakdown({ ...historyRow(), overtime: '0.00', bonus: '500.00', statutory: divergent });
    expect(b.overtime).toBe(500);
    expect(b.bonus).toBe(0);
    // The raw stamp is still readable — this is what the screen used to render, ungated…
    expect(b.componentsByBucket.bonus.map(payItemLabel)).toEqual(['OT15 · OVERTIME 1.5']);
    // …and this is what it renders now: nothing, because RM500 of rows under an RM0.00 total is the one
    // thing a money screen may never print.
    expect(b.bonusLines).toEqual([]);
    expect(b.overtimeLines).toEqual([]);
  });

  it('and not one figure moves — the gate withholds rows, never ringgit', () => {
    const d = buildPayslipPdfData(divergentStored, borne);
    const b = deriveHistoryBreakdown({ ...historyRow(), overtime: '0.00', bonus: '500.00', statutory: divergent });
    expect(d.basic).toBe(5000);
    expect(d.overtime + d.bonus).toBe(500); // the money is in one box or the other, and stays whole
    expect(b.overtime + b.bonus).toBe(500);
  });
});

/**
 * 6b134681 — THE GATE IS ON ALL FOUR RENDERERS, PROVED IN THE SOURCE.
 *
 * The behavioural cases above prove what the DERIVATIONS decide. They cannot prove that a renderer asked:
 * three of the four surfaces gated their Overtime/Bonus sub-lines behind `payItemLinesReconcile` while the
 * fourth mapped the raw kernel bucket, and every unit test still passed, because the defect lives in the
 * CONTRACT BETWEEN the derivation and the JSX rather than inside either. That is the shape rule 17 names,
 * and the answer is a source-shape assertion across both halves.
 *
 * Two of the four are async server components and one is a PDF builder, so none can be rendered here;
 * `app/payroll/transaction-view/history-table.tsx` IS rendered, in test/history-table-pay-item.dom.test.tsx.
 * Comments are stripped first — prose describing the rule must never be what satisfies the guard.
 */
describe('every payroll-result surface asks before it itemises (6b134681)', () => {
  const ROOT = path.resolve(__dirname, '..');
  const code = (rel: string) =>
    fs
      .readFileSync(path.join(ROOT, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('the printed payslip reconciles each earnings figure before replacing its grouped row', () => {
    const pdf = code('lib/payslip-pdf.ts');
    expect(pdf).toContain('payItemLinesReconcile(named, total)');
    for (const call of ['push(d.earningLines, d.allowance', 'push(d.overtimeLines, d.overtime', 'push(d.bonusLines, d.bonus']) {
      expect(pdf, `${call} …) — each list against its OWN total`).toContain(call);
    }
  });

  it('the ESS payslip gates its two sub-line lists', () => {
    const ess = code('app/me/payslip/[payslipId]/page.tsx');
    expect(ess).toContain('payItemLinesReconcile(otLines, disp.overtime)');
    expect(ess).toContain('payItemLinesReconcile(bonusLines, disp.bonus)');
    expect(ess).toContain('{showOtLines && <SubLines lines={otLines} />}');
    expect(ess).toContain('{showBonusLines && <SubLines lines={bonusLines} />}');
  });

  it('the History grid and Individual Payslip read the RECONCILED lists, never the raw buckets', () => {
    const breakdown = code('app/payroll/transaction-view/history-breakdown.ts');
    expect(breakdown).toContain('payItemLinesReconcile(lines, total) ? lines : []');
    expect(breakdown).toContain('overtimeLines: reconciled(byBucket.ot, disp.overtime)');
    expect(breakdown).toContain('bonusLines: reconciled(byBucket.bonus, disp.bonus)');

    // THE MISS ITSELF: mapping `componentsByBucket.ot` / `.bonus` beside a figure that comes from
    // `payslipDisplayEarnings` prints rows that need not add up to the total above them.
    for (const rel of ['app/payroll/individual-payslip/page.tsx', 'app/payroll/transaction-view/history-table.tsx']) {
      const src = code(rel);
      expect(src, `${rel} still itemises the raw ot bucket`).not.toContain('componentsByBucket.ot');
      expect(src, `${rel} still itemises the raw bonus bucket`).not.toContain('componentsByBucket.bonus');
      expect(src, `${rel} must read the gated overtime lines`).toMatch(/b\.overtimeLines/);
      expect(src, `${rel} must read the gated bonus lines`).toMatch(/b\.bonusLines/);
    }
  });
});

/**
 * a96d320c rev 2 — TWO ROW PREDICATES, ONE COPY EACH, AND THE SURFACES THAT USE THEM.
 *
 * RULE 17 AGAIN, AND THIS TIME THE AUDIT HAD ALREADY WRITTEN THE LESSON DOWN.
 * docs/audits/0085-delta-keys-sign-inventory.md found `socsoSkbbk > 0` copied into FOUR renderers and
 * wrong in all four: SKBBK is a per-employee election, so `> 0` conflated "this employee has no SKBBK"
 * with "has SKBBK, contributed 0.00 this run" — and on the second of those the zero is the assertion.
 * The empty-earning-line rule the reporter asked for this round would have been a fifth such copy across
 * three surfaces, so both predicates live in `core/` and the renderers call them.
 *
 * Two of the surfaces are async server components and one is a PDF builder, so none can be rendered
 * here; the source-shape half is the only way to pin the contract between the predicate and the JSX.
 * Comments are stripped first — prose describing the rule must never be what satisfies the guard.
 */
describe('a96d320c rev 2 — the empty-line rules, shared rather than copied', () => {
  const ROOT = path.resolve(__dirname, '..');
  const code = (rel: string) =>
    fs
      .readFileSync(path.join(ROOT, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('an earning row is shown when it carries money, INCLUDING a negative', () => {
    expect(earningRowShown(500)).toBe(true);
    expect(earningRowShown(0)).toBe(false);
    expect(earningRowShown('0.00')).toBe(false);
    // Class B of the audit: a figure that went negative must be visible, not vanished. It is also what
    // keeps the printed rows adding up to the total beside them.
    expect(earningRowShown(-250)).toBe(true);
    // Rounded to the sen first, so a float round-trip cannot print a row that reads `0.00`.
    expect(earningRowShown(0.0000001)).toBe(false);
    expect(earningRowShown(0.005)).toBe(true);
    expect(earningRowShown(null)).toBe(false);
    expect(earningRowShown(undefined)).toBe(false);
  });

  it('the SKBBK line follows the ELECTION the payslip recorded, and falls back to the amount', () => {
    // `null` is not `false`: a slip written before the stamp cannot answer, and must render as it does
    // today rather than lose a line its printed TOTAL DEDUCTIONS still counts.
    expect(payslipSkbbkSubject({ skbbkSubject: true })).toBe(true);
    expect(payslipSkbbkSubject({ skbbkSubject: false })).toBe(false);
    expect(payslipSkbbkSubject({})).toBeNull();
    expect(payslipSkbbkSubject(null)).toBeNull();
    // A jsonb blob is not a type: a value this version does not understand is not guessed at.
    expect(payslipSkbbkSubject({ skbbkSubject: 'yes' })).toBeNull();
    expect(payslipSkbbkSubject({ skbbkSubject: 1 })).toBeNull();

    // THE FIX: subject, contributed nothing ⇒ the line prints, and its 0.00 is the assertion.
    expect(payslipSkbbkLineShown(true, 0)).toBe(true);
    // Not subject, nothing contributed ⇒ absent, which asserts nothing — the truth.
    expect(payslipSkbbkLineShown(false, 0)).toBe(false);
    // No stamp ⇒ exactly today's behaviour, which is what leaves every existing document alone.
    expect(payslipSkbbkLineShown(null, 0)).toBe(false);
    expect(payslipSkbbkLineShown(null, 12.5)).toBe(true);
    // A figure is NEVER hidden by an election, whatever its sign.
    expect(payslipSkbbkLineShown(false, 12.5)).toBe(true);
    expect(payslipSkbbkLineShown(false, -12.5)).toBe(true);
  });

  it('all FOUR payslip surfaces ask the shared SKBBK predicate, and none still tests the amount', () => {
    const surfaces = [
      'lib/payslip-pdf.ts',
      'app/me/payslip/[payslipId]/page.tsx',
      'app/payroll/individual-payslip/page.tsx',
      'app/payroll/transaction-view/history-table.tsx',
    ];
    for (const rel of surfaces) {
      const src = code(rel);
      expect(src, `${rel} must ask the shared predicate`).toContain('payslipSkbbkLineShown(');
      // THE DEFECT ITSELF, in every spelling the four sites used.
      expect(src, `${rel} still renders SKBBK on the amount alone`).not.toMatch(/socsoSkbbk\s*\)?\s*>\s*0/);
    }
  });

  it('the payslip DOCUMENT and the two payslip SCREENS all gate their zero earning rows', () => {
    // The printed document decides through `earningsRowsOf`; the two screens gate the JSX row itself.
    const pdf = code('lib/payslip-pdf.ts');
    expect(pdf).toContain('earningRowShown(total)');
    expect(pdf).toContain('earningRowShown(l.amount)');
    expect(pdf).toContain('earningRowShown(d.claim)');

    for (const [rel, figures] of [
      ['app/me/payslip/[payslipId]/page.tsx', ['allowanceNet', 'disp.overtime', 'disp.bonus', 'disp.claim']],
      ['app/payroll/individual-payslip/page.tsx', ['b.allowanceNet', 'b.overtime', 'b.bonus', 'b.claim']],
    ] as const) {
      const src = code(rel);
      for (const f of figures) {
        expect(src, `${rel} must gate its ${f} row`).toContain(`earningRowShown(${f})`);
      }
    }
  });

  it('a row that owns sub-lines is never hidden out from under them', () => {
    // THE ONE WAY THIS RULE COULD MAKE A PAYSLIP HARDER TO READ. Both screens print the named pay items
    // UNDER their figure. `payItemLinesForBuckets` drops a zero contribution but not a pair that cancels
    // out, so a figure can be 0.00 with two real items beneath it — and gating the heading on the figure
    // alone would leave the detail orphaned under nothing. The escape hatch is the list itself.
    const ess = code('app/me/payslip/[payslipId]/page.tsx');
    expect(ess).toContain('(earningRowShown(disp.overtime) || showOtLines)');
    expect(ess).toContain('(earningRowShown(disp.bonus) || showBonusLines)');
    const admin = code('app/payroll/individual-payslip/page.tsx');
    expect(admin).toContain('(earningRowShown(b.allowanceNet) || b.allowanceLines.length > 0)');
    expect(admin).toContain('(earningRowShown(b.overtime) || b.overtimeLines.length > 0)');
    expect(admin).toContain('(earningRowShown(b.bonus) || b.bonusLines.length > 0)');

    // The printed document cannot have the defect BY CONSTRUCTION, and that is worth pinning rather than
    // trusting: `earningsRowsOf` prints either the named rows INSTEAD of the grouped one, or the grouped
    // one alone — never a heading with a list under it — so there is no heading to orphan.
    const pdf = code('lib/payslip-pdf.ts');
    expect(pdf).toContain('} else if (earningRowShown(total)) {');
  });

  it('Transaction View - History deliberately KEEPS its zero rows, and that is pinned', () => {
    // NOT AN OVERSIGHT, AND NOT A ROW TO TIDY. The reporter asked for empty lines to come off THE
    // PAYSLIP. This panel is the operator's reconciliation grid for a whole run: it is read column-wise
    // against the neighbouring employees and against the CSV `history-export.ts` writes, and that export
    // emits Allowance, Overtime and Bonus as FIXED columns. Hiding the rows here would make one
    // employee's panel a different shape from the next AND put the screen out of step with its own
    // download. If that judgement is ever reversed, this guard is what makes it a decision rather than
    // a drift — and the CSV columns have to move with it.
    const grid = code('app/payroll/transaction-view/history-table.tsx');
    expect(grid, 'History must not have picked up the payslip row rule by accident').not.toContain('earningRowShown(');
    const csv = code('app/payroll/transaction-view/history-export.ts');
    expect(csv, 'the CSV still emits the Allowance column unconditionally').toContain('money(b.allowanceNet)');
  });
});

/**
 * 6b134681 rev 2 — THE BONUS RUN, WHICH IS WHERE THE REPORTER ACTUALLY LIVES.
 *
 * Everything above this point exercises a REGULAR run, and that is why r196 shipped green and reached
 * nobody. Measured on production 2026-08-18: regular runs, 62 payslips of which 24 carry a stamp; bonus
 * runs, 19 payslips of which ZERO did. On a bonus payslip there was no `componentLines` for any of these
 * four surfaces to read, so every one of them fell back to the box label — "Bonus" — and the reporter's
 * BOOO1 · ANGPOW (the letter O three times, not zeros) appeared nowhere at all.
 *
 * The kernel half of the fix is pinned in test/bonus-run-item-stamp-6b134681.test.ts, against real
 * generated payslips. THIS is the other half: given the stamp a bonus run now writes, do the renderers
 * actually print it, and does the money stay exactly where it was? Rule 17 — the defect lived in the
 * contract between the kernel and the renderers, so the stamp and the figures are asserted together.
 */
describe('a BONUS run payslip, through every renderer (6b134681 rev 2)', () => {
  /** What the kernel now stamps on an additional run: the bonus-bucket lines, and only those. */
  const bonusStatutory = {
    epfEmployee: 55, epfEmployer: 65, socsoEmployee: 0, socsoEmployer: 0, eisEmployee: 0, eisEmployer: 0,
    pcb: 60, hrdf: 0,
    componentLines: [
      { code: 'BOOO1', name: 'ANGPOW', amount: 500, buckets: [{ bucket: 'bonus', amount: 500 }] },
    ],
  };
  /** An additional run pays only its additional remuneration: basic/allowance/OT are 0, gross IS the bonus. */
  const bonusStored = {
    ...stored,
    basic: '0.00', allowance: '0.00', overtime: '0.00', bonus: '500.00', gross: '500.00',
    otherDeductions: '0', totalDeductions: '115.00', net: '385.00', employerCost: '565.00',
    statutory: bonusStatutory,
  };
  const bonusHistoryRow = (): ProcessedPayslipViewRow => ({
    ...historyRow(),
    runType: 'bonus',
    runSeq: 2,
    basic: '0.00', allowance: '0.00', overtime: '0.00', bonus: '500.00', gross: '500.00',
    statutory: bonusStatutory,
    totalDeductions: '115.00',
    net: '385.00',
  });

  it('PDF — the printed payslip reads BOOO1 · ANGPOW instead of the box label', () => {
    const d = buildPayslipPdfData(bonusStored, borne);
    expect(d.bonusLines).toEqual([{ code: 'BOOO1', name: 'ANGPOW', amount: 500 }]);
    expect(d.bonusLines!.map(payItemLabel)).toEqual(['BOOO1 · ANGPOW']);
    // Nothing leaks into the allowance rows: the recurring items this run did NOT pay were never stamped.
    expect(d.earningLines).toEqual([]);
    expect(payItemLinesReconcile(d.bonusLines!, d.bonus)).toBe(true);
    // On an additional run the bonus IS the gross, so the same rows explain both.
    expect(payItemLinesReconcile(d.bonusLines!, d.gross)).toBe(true);
  });

  it('ESS payslip — the page’s own chain names the item the employee was paid', () => {
    const lines = storedComponentLines(bonusStored.statutory);
    const bonusLines = payItemLinesForBuckets(lines, ['bonus']);
    expect(payItemLinesReconcile(bonusLines, 500)).toBe(true);
    expect(bonusLines.map(payItemLabel)).toEqual(['BOOO1 · ANGPOW']);
    expect(bonusLines[0].amount).toBe(500);
  });

  it('History and Individual Payslip — the gated list is populated, and the caption stops firing', () => {
    const b = deriveHistoryBreakdown(bonusHistoryRow());
    expect(b.bonusLines.map(payItemLabel)).toEqual(['BOOO1 · ANGPOW']);
    expect(b.componentsByBucket.bonus.map(payItemLabel)).toEqual(['BOOO1 · ANGPOW']);
    // The screen no longer tells the reader the detail was never recorded, because now it was.
    expect(b.detailNotRecorded).toBe(false);
    // No allowance was paid by this run and none is claimed: an empty list never "reconciles" to 0.
    expect(b.allowanceLines).toEqual([]);
    expect(b.allowanceNet).toBe(0);
  });

  it('the surfaces agree LINE FOR LINE on the bonus run too', () => {
    const pdf = buildPayslipPdfData(bonusStored, borne);
    const hist = deriveHistoryBreakdown(bonusHistoryRow());
    const ess = payItemLinesForBuckets(storedComponentLines(bonusStored.statutory), ['bonus']);
    const shape = (ls: { code: string | null; name: string; amount: number }[]) =>
      ls.map((l) => `${payItemLabel(l)} ${l.amount.toFixed(2)}`);
    expect(shape(pdf.bonusLines!)).toEqual(['BOOO1 · ANGPOW 500.00']);
    expect(shape(ess)).toEqual(shape(pdf.bonusLines!));
    expect(shape(hist.bonusLines)).toEqual(shape(pdf.bonusLines!));
  });

  it('NOT ONE FIGURE MOVES — the same bonus payslip with and without its stamp', () => {
    const withStamp = buildPayslipPdfData(bonusStored, borne);
    const { componentLines: _drop, ...bare } = bonusStatutory;
    const without = buildPayslipPdfData({ ...bonusStored, statutory: bare }, borne);
    for (const k of [
      'basic', 'allowance', 'overtime', 'bonus', 'claim', 'gross', 'epfEmployee', 'socsoEmployee',
      'eisEmployee', 'pcb', 'cp38', 'otherDeductions', 'totalDeductions', 'net', 'epfEmployer',
      'socsoEmployer', 'eisEmployer', 'employerCost', 'hrdf',
    ] as const) {
      expect(withStamp[k], k).toBe(without[k]);
    }
    // The unstamped one is exactly what every bonus payslip issued before this item looks like.
    expect(without.bonusLines).toEqual([]);
    expect(without.detailNotRecorded).toBe(true);

    const hist = deriveHistoryBreakdown(bonusHistoryRow());
    expect(hist.gross).toBe(500);
    expect(hist.bonus).toBe(500);
    expect(hist.net).toBe(385);
    expect(hist.totalDeductions).toBe(115);
  });
});

/**
 * 417d4937 FIX D — THE READ-TIME REPAIR, AND THE ONE PLACE RULE (a) IS DELIBERATELY REVERSED.
 *
 * r196 named a consumed one-off's record line from the pay item rather than from the transaction's
 * free-text remark, and said in its own commit message that it was forward-only. Nothing re-derives a
 * payslip after it is calculated and there is no button that would, so "A0020 - DIRECTOR FEE" against
 * pay item A0040 survives on every run that was already calculated — which is precisely what the
 * reporter re-opened Transaction View and saw.
 *
 * THE REVERSAL IS SCOPED TO `recordLines` AND NOTHING ELSE. `componentLines` keep the stamped-name rule:
 * they were never wrong, and the grid rows built from them were correct all along.
 */
describe('recordLineIdentity — repairing a stale record-line label (417d4937)', () => {
  const catalogue = { A0040: 'MEAL ALLOWANCE', A0020: 'DIRECTOR FEE', B0001: 'ANGPOW' };

  it('shows the pay item’s own description against the stored code, with the typed words as the remark', () => {
    const id = recordLineIdentity({ code: 'A0040', name: 'A0020 - DIRECTOR FEE' }, catalogue);
    expect(id.label).toBe('A0040 · MEAL ALLOWANCE');
    expect(id.name).toBe('MEAL ALLOWANCE');
    // NOTHING IS DELETED — the original wording is handed back to be printed, not discarded.
    expect(id.remark).toBe('A0020 - DIRECTOR FEE');
  });

  it('says nothing extra when the stored words already match the catalogue', () => {
    const id = recordLineIdentity({ code: 'A0040', name: 'MEAL ALLOWANCE' }, catalogue);
    expect(id.label).toBe('A0040 · MEAL ALLOWANCE');
    expect(id.remark).toBeNull();
  });

  it('leaves a synthetic TXN_ line alone BY CONSTRUCTION — no branch, nothing to remember', () => {
    // TXN_OVERTIME / TXN_UNPAID / TXN_LEAVE / TXN_EARNING / TXN_DEDUCTION can never match a
    // pay_component code, so their remark-derived names survive without a special case.
    for (const code of ['TXN_OVERTIME', 'TXN_UNPAID', 'TXN_LEAVE', 'TXN_EARNING', 'TXN_DEDUCTION']) {
      const id = recordLineIdentity({ code, name: 'Sunday callout' }, catalogue);
      expect(id.label, code).toBe(`${code} · Sunday callout`);
      expect(id.remark, code).toBeNull();
    }
  });

  it('falls back to the stored words for a code the catalogue does not hold, and with no catalogue at all', () => {
    expect(recordLineIdentity({ code: 'Z9999', name: 'RETIRED ITEM' }, catalogue).label)
      .toBe('Z9999 · RETIRED ITEM');
    expect(recordLineIdentity({ code: 'A0040', name: 'A0020 - DIRECTOR FEE' }).label)
      .toBe('A0040 · A0020 - DIRECTOR FEE');
    expect(recordLineIdentity({ code: 'A0040', name: 'A0020 - DIRECTOR FEE' }, {}).remark).toBeNull();
    // A blank catalogue entry is not an instruction to blank the row.
    expect(recordLineIdentity({ code: 'A0040', name: 'KEEP ME' }, { A0040: '   ' }).label)
      .toBe('A0040 · KEEP ME');
  });

  it('a line with no code at all is never repaired — there is nothing to match on', () => {
    expect(recordLineIdentity({ code: null, name: 'One-off earning' }, catalogue))
      .toEqual({ label: 'One-off earning', name: 'One-off earning', remark: null });
  });

  it('a stamped BIK line is NOT repaired — its stored name is the item’s own description', () => {
    // `statutory.recordLines` is an explicitly MIXED array (core/payroll.ts `PayslipRecordLine`). The
    // txn-derived half may carry a stale free-text remark, which is what this rule repairs; the BIK half
    // is pushed as { code: c.code, name: c.name, nonPayable: true } — the pay item's OWN description as
    // the run folded it, i.e. genuine provenance. Repairing it would print today's naming about a month
    // already paid AND caption it "Entered as …", asserting an operator typed words the system generated.
    const bik = recordLineIdentity({ code: 'A0040', name: 'MEDICAL BIK', nonPayable: true }, catalogue);
    expect(bik.label).toBe('A0040 · MEDICAL BIK');
    expect(bik.name).toBe('MEDICAL BIK');
    expect(bik.remark).toBeNull();
    // The very same line without the flag is the population the rule DOES serve.
    expect(recordLineIdentity({ code: 'A0040', name: 'MEDICAL BIK', nonPayable: false }, catalogue).name)
      .toBe('MEAL ALLOWANCE');
  });

  it('an UNFLAGGED line is repaired — one list, exactly as nonPayableLinesOf reads one', () => {
    // `nonPayable` is stamped at write time from f35f758a (r185) onward, so every payslip calculated
    // before it carries no flag on any line. The kernel's rule for that population is that it stays ONE
    // list, and lib/payslip-pdf.ts `nonPayableLinesOf` implements exactly that by taking `=== true` and
    // leaving everything else in the ordinary population. Withholding the repair here would instead
    // strand the reporter's own case, whose payslips predate r185.
    expect(recordLineIdentity({ code: 'A0040', name: 'A0020 - DIRECTOR FEE' }, catalogue).name)
      .toBe('MEAL ALLOWANCE');
    const pdf = readSrc('lib/payslip-pdf.ts');
    expect(pdf, 'the flag is read as === true here too, or the two readers disagree').toContain(
      '.filter((l) => l?.nonPayable === true)',
    );
  });

  it('the kernel stamps the flag this rule branches on — both BIK sites and the txn helper', () => {
    // The discriminator is only trustworthy while the kernel keeps writing it. Source-shape because the
    // defect would live in the contract between the kernel's write and this read, and a unit test of
    // either half passes throughout.
    const kernel = readSrc('core/payroll.ts');
    expect(kernel).toContain('list.push({ ...line, nonPayable: false });');
    expect(
      kernel.match(/recordLines\.push\(\{ code: c\.code, name: c\.name, amount: applied, nonPayable: true \}\)/g)
        ?.length,
      'both BIK push sites must stamp nonPayable: true',
    ).toBe(2);
  });

  it('componentLines are NOT repaired — rule (a) still holds for the per-item stamp', () => {
    // A description edited in March must not rewrite what January's payslip said about January's money.
    // The stamped line is provenance; a record line's pre-r196 name never was.
    const src = readSrc('core/payslip-earning-lines.ts');
    expect(src).toContain('export function payItemLinesForBuckets');
    expect(src.split('export function payItemLinesForBuckets')[1]).not.toContain('names');
  });
});

/**
 * 417d4937 — THE WIRING IS THE FIX. A correct helper that no screen is handed a catalogue for is inert,
 * which is the shape of failure this pair has already produced twice (r196's kernel fix could not reach
 * an old run; r196's display fix could not reach a bonus run). Source-shape guards, because the defect
 * lives in the CONTRACT between the server page and the renderer and a unit test of either half passes.
 */
describe('417d4937 — every record-line surface is actually handed the catalogue', () => {
  it('Transaction View reads the catalogue for the HISTORY tab, not only for the grid', () => {
    const page = readSrc('app/payroll/transaction-view/page.tsx');
    // The read used to be `tab === 'grid'` alone, which would have left the repair inert on the tab the
    // reporter opens.
    expect(page).toContain("tab === 'grid' || tab === 'history' ? listPayComponents(s, { includeArchived: true })");
    expect(page).toContain('const payItemNames: Record<string, string> = Object.fromEntries(');
    // Plain data across the RSC boundary — a function prop 500s at runtime while tsc and next build pass.
    expect(page).toContain('payItemNames={payItemNames}');
    expect(page).toContain('payItemNames,\n        })'); // …and into the pure pivot for Transaction Detail
  });

  it('the History table, the pivot, Individual Payslip and the ESS payslip all call the shared rule', () => {
    for (const rel of [
      'app/payroll/transaction-view/history-table.tsx',
      'app/payroll/transaction-view/history-pivot.ts',
      'app/payroll/individual-payslip/page.tsx',
      'app/me/payslip/[payslipId]/page.tsx',
    ]) {
      expect(readSrc(rel), `${rel} must repair record lines through the shared rule`).toContain('recordLineIdentity(');
    }
  });

  it('the ESS payslip prints the DESCRIPTION, not an internal code, to the employee', () => {
    // The employee's copy has always read as words. "TXN_OVERTIME · Overtime (one-off)" would be a worse
    // answer than the remark it replaces, so that surface takes `name` while the admin screens take `label`.
    const ess = readSrc('app/me/payslip/[payslipId]/page.tsx');
    expect(ess).toContain('id.name');
    expect(ess).not.toContain('label={id.label}');
  });
});
