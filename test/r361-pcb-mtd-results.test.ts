/**
 * r361 / bf3c9712 — THE ACCUMULATED REMUNERATION BLOCK AND THE CALCULATION RESULTS BLOCK.
 *
 * WHAT THE ITEM ADDED, AND THEREFORE WHAT IS WORTH ASSERTING. The screen and its PDF already carried
 * every letter of the agency's page 6 (7f251381) and every itemisation behind the totals (ad7bc503).
 * The two bands that BRACKET that working were missing, and they are the two a reader opens the document
 * for: what the year has accumulated (official page 1) and what was finally deducted (official page 7).
 *
 *   docs/forms/pcb-calculation-slip-specimen-2026-12.pdf — a FILLED SPECIMEN slip for "Employee A",
 *   NOT an agency publication: its metadata is Chrome/Skia (document title "ReportEx2026"), and it is
 *   a filled December 2026 calculation for a fictional employee. Its arithmetic reconciles and it is
 *   useful as a layout and vocabulary reference, but where it disagrees with
 *   docs/forms/pcb-spec-2026-computerised-calculation.pdf, THE SPECIFICATION WINS.
 *   print date 29/09/2026, committed with this round. Page 1 is the accumulated block, page 6 the two
 *   numbered steps, page 7 CALCULATION RESULTS. It is the structure these builders reproduce.
 *
 * THREE THINGS THAT COULD GO WRONG HERE, AND WHICH NO ASSERTION ABOUT A TOTAL WOULD CATCH:
 *
 *   1. THE LAST LINE COULD STOP BEING THE PAYSLIP'S. The agency's final line is "MTD for the month to be
 *      deducted (after rounding to the nearest upper 5 cent)", and the obvious way to build it is to take
 *      the working's answer and round it. That would be a SECOND calculation of the one figure this whole
 *      screen exists to explain, and on any payslip whose PCB was set by hand or whose run deducted only
 *      the month's increase it would print an amount nobody deducted. It is `statutory.pcb`, read, and
 *      the cases below drive a stored figure that is deliberately not a multiple of 5 sen so that a
 *      re-rounding anywhere on the path fails loudly.
 *
 *   2. THE ITEMISED LINES AND THE ACCUMULATOR TOTALS COULD BE PRESENTED AS ONE COLUMN. They are two
 *      different measures — what was PAID, against the base PCB is CHARGED on, seeded by a Form TP3 the
 *      payslips cannot see — and a reader who adds the first six lines will not reach Y. They are in two
 *      columns and the note says why, in all six languages.
 *
 *   3. THE PRINTED 0.00 AGAINST BENEFIT-IN-KIND AND VALUE OF LIVING ACCOMMODATION COULD LOSE ITS NOTE.
 *      CLAUDE.md §8: an absent box asserts nothing, `0.00` asserts the money does not exist. The plan
 *      chose to print the two lines because the agency's form has them; the note is the only thing that
 *      keeps that honest, so it is asserted to exist, to be translated, and to be attached to the
 *      section that carries the zeroes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pcbMonth } from '../localization/my/payroll';
import {
  explainPcb,
  pcbAccumulatedRemunerationSection,
  pcbCalculationResultsSection,
  pcbClosingSections,
  pcbDetailLayout,
  pcbWorksheet,
  pcbMtdStep1Section,
  pcbMtdStep2Section,
  pcbSlipSections,
  type PcbExplanation,
  type PcbReliefBreakdown,
  type PcbSlipCatalogueItem,
  type PcbSlipSection,
} from '../core/pcb-explain';
import { TP1_ITEMS, TP1_REBATES } from '../core/tax-relief';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips, setPayrollInput } from '../core/payroll';
import { currentPcbReliefs, listProcessedPayslipsAcross, payslipForReview } from '../core/payroll-view';
import { pcbSlipData } from '../app/payroll/pcb-detail/slip-data';
import { pcbDetailModel } from '../app/payroll/pcb-detail/shared';
import { pcbPdfText } from '../app/payroll/pcb-detail/slip-pdf';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source with comments stripped: these files EXPLAIN at length what they refuse to do, and a guard that
 *  matched the explanation would pass on the prose alone. */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const code = (rel: string) => strip(read(rel));

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const VIEW = 'app/payroll/pcb-detail/pcb-detail-view.tsx';
const SHARED = 'app/payroll/pcb-detail/shared.ts';
const EXPLAIN = 'core/pcb-explain.ts';
const READS = 'app/payroll/pcb-detail/slip-data.ts';

const CATALOGUE = TP1_ITEMS as readonly PcbSlipCatalogueItem[];
const REBATES = TP1_REBATES as readonly PcbSlipCatalogueItem[];

const CURRENT: PcbReliefBreakdown = {
  individual: 9000, spouse: 0, children: 6000, disabledIndividual: 0, disabledSpouse: 0, lp: 0, total: 15000,
};

/** One month of the engine, with every limb of the working alive so no two figures share a zero. */
const run = () =>
  pcbMonth({
    monthlyWage: 14000,
    epfMonthly: 1540,
    month: 7,
    profile: { category: 2, children: 3 },
    acc: {
      netRemuneration: 63000,
      epfClaimed: 800,
      pcbPaid: 4100,
      zakatPaid: 250,
      lpAccumulated: 480,
      // 4011903e — Y as the engine stamps it. Present here so the accumulated block's Y row is the
      // STAMPED figure; the `notSeparatelyRecorded` fallback for a slip written before it has its own case.
      grossRemuneration: 63800,
    },
    additional: 26000,
    epfOnAdditional: 600,
    lpCurrent: 90,
    zakatCurrent: 60,
  });

/** …as `explainPcb` reads it off a payslip. `over` replaces keys of the stored `statutory` blob. */
function richRun(over: Record<string, unknown> = {}) {
  const r = run();
  const x = explainPcb(
    { pcb: r.total, pcbBonus: r.additional, epfEmployee: 1540, zakat: 60, lp: 570, pcbMeta: r.snapshot, ...over },
    CURRENT,
  );
  if (x.kind !== 'mtd') throw new Error('unreachable — a resident month is an MTD month');
  return x;
}

const PAID = { grossSalary: 91000, allowances: 3300, additional: 26500 };

/** `applyStatutoryAdjustment`'s own stamp shape — `{ reason, lines: { pcb: { system, applied } } }`.
 *  Spelled the way `readOverride` reads it, so this fixture is the writer's shape and not a guess. */
const OVERRIDE = { reason: 'Agreed with LHDN', lines: { pcb: { system: 987.65, applied: 1234.56 } } };

const byCaption = (sec: PcbSlipSection, caption: string) => sec.rows.find((r) => r.caption === caption);
const captionOf = (sec: PcbSlipSection, caption: string) => {
  const row = byCaption(sec, caption);
  expect(row, `the section must carry a ${caption} row`).toBeTruthy();
  return row!;
};

// ───────────────── (a) the accumulated remuneration block: official page 1 ─────────────────

describe('r361 — the accumulated block itemises what was paid and states what it cannot itemise', () => {
  it('lays the agency’s page-1 lines out in its own order, in two columns', () => {
    const sec = pcbAccumulatedRemunerationSection(richRun(), PAID);
    expect(sec.heading).toBe('slipAccHeading');
    // The itemisation is the AMOUNT column; the accumulators the run used are the TOTAL column. One
    // column would invite a reader to add the first six lines and expect to reach Y, which they will not.
    expect(sec.firstColumn).toBe('slipColAmount');
    expect(sec.secondColumn).toBe('slipColTotal');
    expect(sec.rows.map((r) => r.caption)).toEqual([
      'slipAccGrossSalary',
      'slipAccFeesCommission',
      'slipAccTipsAllowances',
      'slipAccBik',
      'slipAccVola',
      'slipAccAdditional',
      'slipAccGross',
      'slipAccEpf',
      'slipAccNet',
      'slipAccMtd',
      'slipAccZakat',
      'slipAccLevy',
    ]);
    // The four accumulator rows carry LHDN's own symbols, untranslated, so the two sheets match on a row.
    expect(sec.rows.filter((r) => r.line !== '').map((r) => r.line)).toEqual(['Y', 'K', 'Σ(Y−K)', 'X', 'Z']);
  });

  it('the itemised lines come from the PAYSLIPS and the totals come from the RUN’s own stamp', () => {
    // ⚠️ THE ANTI-DRIFT RULE THE PLAN NAMES IN WRITING: "take them from the trace rather than re-summing,
    // so the block and the working cannot disagree". A second summation of K, Σ(Y−K), X or Z here could
    // land on a different figure from the one the calculation above it actually used.
    const x = richRun();
    const sec = pcbAccumulatedRemunerationSection(x, PAID);
    expect(captionOf(sec, 'slipAccGrossSalary').first).toEqual({ kind: 'money', amount: PAID.grossSalary });
    expect(captionOf(sec, 'slipAccTipsAllowances').first).toEqual({ kind: 'money', amount: PAID.allowances });
    expect(captionOf(sec, 'slipAccAdditional').first).toEqual({ kind: 'money', amount: PAID.additional });
    expect(captionOf(sec, 'slipAccGross').second).toEqual({ kind: 'money', amount: x.ytdGross });
    expect(captionOf(sec, 'slipAccEpf').first).toEqual({ kind: 'money', amount: x.epfClaimedYtd });
    expect(captionOf(sec, 'slipAccNet').second).toEqual({ kind: 'money', amount: x.ytdNetRemuneration });
    expect(captionOf(sec, 'slipAccMtd').second).toEqual({ kind: 'money', amount: x.pcbPaidYtd });
    expect(captionOf(sec, 'slipAccZakat').second).toEqual({ kind: 'money', amount: x.trace!.Z });
  });

  it('every figure it emits was already in what it was handed — nothing is summed or re-derived here', () => {
    // The sweep that needs no assertion per row, borrowed from test/ad7bc503-pcb-slip.test.ts: any sum,
    // difference or re-rounding introduced into this builder produces a number that is not in the inputs.
    const numbersIn = (v: unknown, out = new Set<number>()): Set<number> => {
      if (typeof v === 'number') out.add(v);
      else if (v && typeof v === 'object') for (const k of Object.values(v as Record<string, unknown>)) numbersIn(k, out);
      return out;
    };
    const x = richRun();
    const allowed = numbersIn({ x, paid: PAID });
    // Zero is the one literal this builder prints (BIK and VOLA), and it is in the inputs many times over.
    expect(allowed.has(0), 'the premise for the two printed zeroes').toBe(true);
    for (const row of pcbAccumulatedRemunerationSection(x, PAID).rows) {
      for (const v of [row.first, row.second]) {
        if (v?.kind === 'money') {
          expect(allowed.has(v.amount), `${row.caption}: ${v.amount} was computed, not read`).toBe(true);
        }
      }
    }
  });

  it('legacy BIK and VOLA remain unavailable alongside their saved accumulated totals', () => {
    // Missing old benefit provenance is not a recorded zero.
    const sec = pcbAccumulatedRemunerationSection(richRun(), PAID);
    expect(captionOf(sec, 'slipAccBik').first).toEqual({ kind: 'notRecorded' });
    expect(captionOf(sec, 'slipAccVola').first).toEqual({ kind: 'notRecorded' });
    expect(sec.note).toBe('slipAccNote');
    const en = JSON.parse(read('messages/en.json')).payroll.pcbDetail as Record<string, string>;
    for (const phrase of ['benefit in kind', 'value of living accommodation', 'not recorded']) {
      expect(en.slipAccNote.toLowerCase(), `the note must say "${phrase}"`).toContain(phrase);
    }
  });

  it('three lines we cannot split say so, and not one of them says 0.00', () => {
    const sec = pcbAccumulatedRemunerationSection(richRun(), PAID);
    // There is no fees / director's-fee / commission column: such a pay item is paid through `allowance`
    // or `bonus` and is never persisted apart from them.
    expect(captionOf(sec, 'slipAccFeesCommission').first).toEqual({ kind: 'notSeparatelyRecorded' });
    // Z is the specification's own COMBINED column — rule 5 heads it "zakat and departure levy", and
    // `foldPriorSlipIntoAccumulators` folds `zakat` together with the TP1 rebate that carries the levy.
    // So there is no separate accumulated levy figure to print, and printing 0.00 would deny one exists.
    expect(captionOf(sec, 'slipAccLevy').second).toEqual({ kind: 'notSeparatelyRecorded' });
    // And Y on a payslip written before the engine stamped it (4011903e) — never reconstructed as Σ(Y−K)+K.
    const old = richRun();
    const noY = { ...old, ytdGross: undefined } as PcbExplanation & { kind: 'mtd' };
    expect(captionOf(pcbAccumulatedRemunerationSection(noY, PAID), 'slipAccGross').second).toEqual({
      kind: 'notSeparatelyRecorded',
    });
  });

  it('an unread year says nothing was recorded, under its OWN note — never zeroes', () => {
    const sec = pcbAccumulatedRemunerationSection(richRun(), null);
    for (const k of ['slipAccGrossSalary', 'slipAccTipsAllowances', 'slipAccAdditional']) {
      expect(captionOf(sec, k).first, `${k} must be an absence, never a zero`).toEqual({ kind: 'notRecorded' });
    }
    expect(sec.note, 'and the reader is told which absence this is').toBe('slipAccNoteUnread');
    // The accumulator totals are unaffected: they never came from the itemisation in the first place.
    expect(captionOf(sec, 'slipAccNet').second).toEqual({ kind: 'money', amount: richRun().ytdNetRemuneration });
  });

  it('it is section THREE of the slip — between the child grid and the accumulated deductions', () => {
    // The whole point of the item is that the two documents read down in step. The agency prints this
    // block on page 1 under the child table; appending it to the end would have been easier and useless.
    const headings = pcbSlipSections(richRun(), {
      profile: null,
      catalogue: CATALOGUE,
      rebateCatalogue: REBATES,
      currentDeduction: null,
      accumulatedDeduction: null,
      previousDeduction: null,
      currentRebate: null,
      accumulatedRebate: null,
      accumulatedRemuneration: PAID,
    }).map((s) => s.heading);
    expect(headings).toEqual([
      'slipChildHeading',
      'slipAccHeading',
      'slipPrevDeductionHeading',
      'slipCurrentHeading',
      'slipAdditionalRemHeading',
      'slipCurrentDeductionHeading',
      'slipRebateHeading',
    ]);
  });
});

// ───────────────── (b) the closing trio: official pages 6 and 7 ─────────────────

describe('r361 — the official’s two numbered steps and its CALCULATION RESULTS band', () => {
  it('comes out in the agency’s order, and only for a month that HAS a monthly calculation', () => {
    expect(pcbClosingSections(richRun()).map((s) => s.heading)).toEqual([
      'slipStep1Heading',
      'slipStep2Heading',
      'slipResultHeading',
    ]);
    // A flat-rate payee has no monthly MTD calculation whose steps could be numbered, and a payslip that
    // recorded no working has one only in the sense that nobody wrote it down. Three bands of "not
    // recorded" would assert that a computerised calculation exists and merely went unsaved.
    const flat = explainPcb({ pcb: 300, pcbMeta: { flatRate: 0.3, nonResident: true } }, CURRENT);
    expect(flat.kind).toBe('flat');
    expect(pcbClosingSections(flat), 'a flat-rate payee gets no numbered steps').toEqual([]);
    expect(pcbClosingSections(explainPcb({ pcb: 120 }, CURRENT)), 'nor does an unexplained payslip').toEqual([]);
  });

  it('step 1 lands on the two figures the agency prints under it, both read from the run', () => {
    const x = richRun();
    const sec = pcbMtdStep1Section(x);
    expect(captionOf(sec, 'slipStep1CurrentMtd').first).toEqual({ kind: 'money', amount: x.trace!.mtdNormalCalc });
    expect(captionOf(sec, 'slipStep1NetMtd').first).toEqual({ kind: 'money', amount: x.pcbNormal });
    expect(sec.note).toBe('slipStep1Note');
  });

  it('a run with no recorded working gets an absence in step 1, not a zero', () => {
    const noTrace = explainPcb(
      {
        pcb: 402.65,
        epfEmployee: 0,
        zakat: 15,
        pcbMeta: {
          month: 1, n: 11, ytdNet: 1234.5, epfClaimed: 200, pcbPaid: 90, P1: 75956.07,
          reliefs: { individual: 9000, spouse: 0, children: 0, disabledIndividual: 0, disabledSpouse: 0, lp: 0, total: 9000 },
        },
      },
      CURRENT,
    );
    if (noTrace.kind !== 'mtd') throw new Error('unreachable');
    expect(noTrace.trace, 'the premise: this run has no trace').toBeNull();
    expect(captionOf(pcbMtdStep1Section(noTrace), 'slipStep1CurrentMtd').first).toEqual({ kind: 'notRecorded' });
    const res = pcbCalculationResultsSection(noTrace);
    expect(captionOf(res, 'slipResultProjected').first).toEqual({ kind: 'notRecorded' });
    expect(captionOf(res, 'slipResultAnnualTax').first).toEqual({ kind: 'notRecorded' });
    // …but the deducted figure is on the payslip whether or not the working is, so it is still printed.
    expect(captionOf(res, 'slipResultFinal').first).toEqual({ kind: 'money', amount: 402.65 });
  });
});

// ───────────────── (c) the line the whole item is about: the figure that was deducted ─────────────────

describe('r361 — the results band prints the figure the PAYSLIP paid, and never re-rounds it', () => {
  it('the three highlighted figures are the two legs and the payslip’s own stored MTD', () => {
    const x = richRun();
    const sec = pcbCalculationResultsSection(x);
    expect(sec.heading).toBe('slipResultHeading');
    expect(captionOf(sec, 'slipResultNetMtd').first).toEqual({ kind: 'money', amount: x.pcbNormal });
    expect(captionOf(sec, 'slipResultAdditional').first).toEqual({ kind: 'money', amount: x.pcbAdditional });
    expect(captionOf(sec, 'slipResultFinal').first).toEqual({ kind: 'money', amount: x.pcb });
    // The agency's two closing notes carry a figure each, and a caption in this namespace may take no ICU
    // argument (it is resolved with a bare `t()` and a stray brace throws at render), so each figure is a
    // row of its own rather than an interpolation.
    expect(captionOf(sec, 'slipResultProjected').first).toEqual({ kind: 'money', amount: x.trace!.mtdNormalCalc });
    expect(captionOf(sec, 'slipResultAnnualTax').first).toEqual({ kind: 'money', amount: x.trace!.taxOnP1 });
    expect(sec.note).toBe('slipResultNote');
  });

  it('⚠️ A STORED FIGURE THAT IS NOT A MULTIPLE OF 5 SEN IS PRINTED UNCHANGED', () => {
    // THE DEFECT THIS EXISTS TO STOP. The agency's own caption is "MTD for the month to be deducted
    // (AFTER ROUNDING TO THE NEAREST UPPER 5 CENT)", which reads like an instruction to round here. The
    // engine already did it (§E.1 truncate, §E.2 round up to 5 sen) before it deducted anything, so a
    // second application on this page can only move the figure AWAY from the payslip. `1234.56` is not a
    // multiple of 5 sen and would become `1234.60` under any re-rounding on the path.
    const x = richRun({ pcb: 1234.56, adjustment: OVERRIDE });
    const cell = captionOf(pcbCalculationResultsSection(x), 'finalPcbDeducted').first;
    expect(cell).toEqual({ kind: 'money', amount: 1234.56 });
    expect(pcbMtdStep2Section(x).rows.at(-1)!.first).toEqual({ kind: 'money', amount: 1234.56 });
  });

  it('a hand-set PCB keeps the working’s figure and the deduction on two separately captioned rows', () => {
    // The screen's standing rule, applied to the new bands: the deduction is never the quiet answer to a
    // working that did not produce it. `pcbBasisLabels` is the ONE caption decision and both bands use it.
    const x = richRun({ pcb: 1234.56, adjustment: OVERRIDE });
    expect(x.basis?.kind, 'the premise: the working explains a different figure').toBe('manual');
    const res = pcbCalculationResultsSection(x);
    expect(res.rows.map((r) => r.caption)).toEqual([
      'slipResultNetMtd', 'slipResultAdditional', 'finalPcbSystem', 'finalPcbDeducted',
      'slipResultProjected', 'slipResultAnnualTax',
    ]);
    expect(byCaption(res, 'slipResultFinal'), 'the neutral caption must NOT be used here').toBeUndefined();
    expect(captionOf(res, 'finalPcbSystem').first).toEqual({ kind: 'money', amount: x.pcbSystem });
    expect(captionOf(res, 'finalPcbDeducted').first).toEqual({ kind: 'money', amount: 1234.56 });
    const step2 = pcbMtdStep2Section(x);
    expect(step2.rows.map((r) => r.caption)).toEqual(['finalPcbSystem', 'finalPcbDeducted']);
    expect(step2.note, 'and the reason the two differ is carried under the band').toBe('overrideNote');
  });

  it('an ADDITIONAL run says the month’s total is the month’s, not what this run deducted', () => {
    // ADR-0024: an additional run deducts the month's INCREASE while `pcbMeta` is carried through as the
    // CUMULATIVE month. Every figure in the working therefore describes 1,500.25 while the payslip took
    // 310.40, and a results band whose last line said "MTD to be deducted 1,500.25" would be a competent-
    // looking statement of an amount nobody deducted — the exact failure this screen exists to remove.
    const withDelta = explainPcb(
      {
        pcb: 310.4,
        pcbBonus: 200.1,
        epfEmployee: 1540,
        zakat: 60,
        lp: 570,
        pcbMeta: {
          ...run().snapshot,
          delta: { cumulative: 1500.25, prior: 1189.85, cumulativeBonus: 200.1 },
        },
      },
      CURRENT,
    );
    if (withDelta.kind !== 'mtd') throw new Error('unreachable');
    expect(withDelta.basis?.kind, 'the premise').toBe('additionalRun');
    const res = pcbCalculationResultsSection(withDelta);
    expect(res.rows.map((r) => r.caption)).toContain('finalPcbMonth');
    expect(res.rows.map((r) => r.caption)).toContain('finalPcbRun');
    expect(captionOf(res, 'finalPcbMonth').first).toEqual({ kind: 'money', amount: 1500.25 });
    expect(captionOf(res, 'finalPcbRun').first, 'what THIS run deducted').toEqual({ kind: 'money', amount: 310.4 });
  });
});

// ───────────────── (d) both surfaces, one list, and every caption in six languages ─────────────────

describe('r361 — the screen and the downloaded document cannot disagree about the closing bands', () => {
  it('both iterate the SAME list, built in core/, and neither composes a band of its own', () => {
    expect(code(EXPLAIN), 'the trio is assembled once').toContain('export function pcbClosingSections');
    const shared = code(SHARED);
    expect(shared, 'the model carries it').toContain('closing: pcbClosingSections(explanation)');
    /**
     * r372 — THE ORDERING CLAIM MOVED FROM TWO SOURCE MATCHES TO THE LIST ITSELF, WHICH IS WHY IT CAN NOW
     * FAIL. This used to compare the positions of two `pushSlipSections` calls in shared.ts and the
     * presence of one JSX expression in the view — a pair of independent claims about two independent
     * orderings, which is exactly the arrangement that let five sections drift off the paper. Both
     * surfaces now iterate `pcbDetailLayout`, so the assertion is about the ORDER THAT LIST RETURNS, once,
     * and both surfaces inherit it. The closing trio's own placement — the agency's two numbered items as
     * the last steps of sequence 9, its CALCULATION RESULTS band as sequence 10 — is asserted here and
     * again, with the whole run of ten, in test/r372-pcb-sequence.test.ts.
     */
    expect(code(VIEW), 'the screen iterates the shared list').toContain('pcbDetailLayout({ explanation, worksheet, slip, closing })');
    expect(shared, 'and so does the document').toContain('pcbDetailLayout({');
    const x = richRun();
    const order = pcbDetailLayout({
      explanation: x,
      worksheet: pcbWorksheet(x, null),
      slip: pcbSlipSections(x, {
        profile: null, catalogue: CATALOGUE, rebateCatalogue: REBATES,
        currentDeduction: null, accumulatedDeduction: null, previousDeduction: null,
        currentRebate: null, accumulatedRebate: null, accumulatedRemuneration: null,
      }),
      closing: pcbClosingSections(x),
    }).map((e) => e.heading);
    expect(order.indexOf('slipStep1Heading'), 'the trio comes after the lettered steps, not before them')
      .toBeGreaterThan(order.indexOf('stepsHeading'));
    expect(order.indexOf('slipResultHeading'), 'and CALCULATION RESULTS is the last numbered section')
      .toBeGreaterThan(order.indexOf('slipStep2Heading'));
  });

  it('the document MODEL carries the trio, behaviourally and not merely by a source match', () => {
    // ⚠️ `pcbDetailModel` was named in prose across three files as the thing a test drives over both
    // paths, and no test drove it — the claim outlived the code (CLAUDE.md §8 on prose). The source
    // matches above would survive a `closing` that came back empty, so the model is actually CALLED here
    // and its trio compared, field for field, with the one the screen is handed.
    const x = richRun();
    const model = pcbDetailModel({
      statutory: { pcb: x.pcb, pcbBonus: x.pcbAdditional, epfEmployee: 1540, zakat: 60, lp: 570, pcbMeta: run().snapshot },
      fallbackReliefs: CURRENT,
      previousEmployment: null,
      slipData: null,
    });
    expect(model.closing.map((s) => s.heading)).toEqual([
      'slipStep1Heading', 'slipStep2Heading', 'slipResultHeading',
    ]);
    expect(model.closing).toEqual(pcbClosingSections(model.explanation));
  });

  it('the new bands hold no arithmetic, and the read that sums payslips is not in core/', () => {
    // test/7f251381-pcb-lhdn-worksheet.test.ts already refuses an operator anywhere below its marker in
    // core/pcb-explain.ts, which is where all three builders live. What is asserted HERE is the other
    // half: the one place that DOES add — the itemisation — is a read in the app layer, beside the
    // screen, exactly as `localization/my/reports.ts` eaStatement sums the year for the EA.
    const reads = code(READS);
    expect(reads, 'the sum lives in the read layer').toContain('function priorRemuneration');
    expect(reads, 'and it is PRIOR months only: the current month is the section below it').toContain(
      'lt(payrollBatch.payPeriod, boundary)',
    );
    expect(reads, 'CLAUDE.md §8 — an asserted array from a query carries an ORDER BY').toContain(
      'orderBy(payrollBatch.payPeriod)',
    );
    // …and core/ still cannot reach an engine.
    const imports = read(EXPLAIN).split('\n').filter((l) => l.trimStart().startsWith('import '));
    for (const forbidden of ['pcbMonth', 'localization/my/payroll', 'statutory-tables']) {
      expect(imports.join('\n'), `core/pcb-explain.ts must not import ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('every caption the three builders can emit resolves in all six catalogues, with no ICU argument', () => {
    // The basis-dependent captions are COMPUTED keys chosen through `pcbBasisLabels`, so the repo's i18n
    // coverage scan (literal keys in a single-namespace file) cannot see them. They are collected from
    // the ASSEMBLY ITSELF over fixtures that between them reach every branch, never from a hand-kept list.
    const manual = richRun({ pcb: 1234.56, adjustment: OVERRIDE });
    const keys = new Set<string>();
    for (const x of [richRun(), manual]) {
      for (const sec of [...pcbClosingSections(x), pcbAccumulatedRemunerationSection(x, PAID), pcbAccumulatedRemunerationSection(x, null)]) {
        keys.add(sec.heading);
        keys.add(sec.firstColumn);
        if (sec.secondColumn) keys.add(sec.secondColumn);
        if (sec.note) keys.add(sec.note);
        for (const r of sec.rows) if (r.ns === 'pcbDetail') keys.add(r.caption);
      }
    }
    expect(keys.size, 'the assembly names captions').toBeGreaterThan(25);
    for (const loc of LOCALES) {
      const blk = JSON.parse(read(`messages/${loc}.json`)).payroll.pcbDetail as Record<string, string>;
      for (const k of keys) {
        expect(blk[k], `payroll.pcbDetail.${k} in ${loc}`).toBeTruthy();
        expect(blk[k], `payroll.pcbDetail.${k} in ${loc} must take no ICU argument`).not.toMatch(/[{}]/);
      }
    }
  });

  it('nothing the new bands put on the PDF folds to a question mark', () => {
    // Helvetica is WinAnsi and pdf-lib folds an unmappable codepoint to '?'. The Σ in the accumulated
    // block's own line marker is exactly the class of character that shipped as "?(Y - K)" until r351.
    const fold = pcbPdfText;
    for (const sec of [pcbAccumulatedRemunerationSection(richRun(), PAID), ...pcbClosingSections(richRun())]) {
      for (const r of sec.rows) {
        expect(fold(r.line), `the line marker ${r.line} folds to a '?'`).not.toContain('?');
      }
    }
    expect(fold('Σ(Y−K)'), 'and it is LEGIBLE, not merely not-a-question-mark').toBe('Σ(Y−K)');
    for (const loc of ['en', 'ms'] as const) {
      const blk = JSON.parse(read(`messages/${loc}.json`)).payroll.pcbDetail as Record<string, string>;
      for (const k of ['slipAccHeading', 'slipAccNote', 'slipStep1Heading', 'slipResultHeading', 'slipResultNote']) {
        if (blk[k].includes('?')) continue;
        expect(fold(blk[k]), `${loc}.${k} folds to a '?' on the PDF`).not.toContain('?');
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// (e) against a real payroll run: the band must never print a figure the payslip did not pay
// ══════════════════════════════════════════════════════════════════════════════════════════════════

let base: Base;
beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});

describe('r361 — against a real run, end to end', () => {
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
  });

  const employee = async (name: string, email: string) => {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: name, primaryEmail: email },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: 12000,
      monthlyAllowance: 800,
      effectiveFrom: '2026-01-01',
    });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011601', taxCategory: 1 });
    return e;
  };

  /**
   * ⚠️ THE BONUS AND THE ZAKAT ARE NOT DECORATION. On a plain regular month with neither, the net MTD,
   * the normal leg and the deduction are all the SAME number, and a case written over one cannot tell
   * the three apart — it would pass just as happily against a band that printed a leg where the
   * deduction belongs. `bonusAmount` forces the additional leg into existence and `zakat` moves the net
   * figure off the calculated one, so the three cells under test are three distinct amounts.
   */
  const runMonth = async (payPeriod: string, p: { employmentId?: string; bonus?: number; zakat?: number } = {}) => {
    const a = adminCtx(base);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod });
    if (p.employmentId && (p.bonus || p.zakat)) {
      await setPayrollInput(a, {
        batchId,
        employmentId: p.employmentId,
        overtimeAmount: 0,
        bonusAmount: p.bonus ?? 0,
        zakat: p.zakat ?? 0,
      });
    }
    await generatePayslips(a, { batchId });
  };

  it('THE RESULTS BAND PRINTS `statutory.pcb` — the amount the payslip actually deducted', async () => {
    // ⚠️ THE CASE THE BRIEF ASKS FOR IN SO MANY WORDS: "the screen must never print a figure the payslip
    // did not pay". A unit test over a hand-built blob cannot make this statement, because the blob is
    // the thing under suspicion. This reads the payslip back out of the database, hands it to the same
    // chain the screen uses, and compares the printed cell with the stored deduction.
    const a = adminCtx(base);
    const e = await employee('Results Band', 'results.band@acme.test');
    await runMonth('2026-03', { employmentId: e.employmentId, bonus: 30000, zakat: 40 });

    const rows = await listProcessedPayslipsAcross(a, { companyIds: [base.companyId], employmentId: e.employmentId });
    const row = await payslipForReview(a, { companyIds: [base.companyId], payslipId: rows[0].id });
    const stored = Number((row!.statutory as { pcb: number }).pcb);
    expect(stored, 'the premise: this month really deducted something').toBeGreaterThan(0);

    const fallback = await currentPcbReliefs(a, {
      companyIds: [base.companyId],
      employmentId: e.employmentId,
      asOf: '2026-03-28',
    });
    const x = explainPcb(row!.statutory, fallback);
    if (x.kind !== 'mtd') throw new Error('unreachable');
    const res = pcbCalculationResultsSection(x);
    const leg = (k: string) => (captionOf(res, k).first as { amount: number }).amount;
    // THE PREMISE THAT MAKES THIS CASE ABLE TO FAIL: the three cells are three DIFFERENT amounts, so a
    // band that printed a leg where the deduction belongs could not pass by coincidence.
    expect(leg('slipResultAdditional'), 'the bonus produced an additional leg').toBeGreaterThan(0);
    expect(leg('slipResultNetMtd'), 'so the normal leg is not the whole deduction').not.toBe(stored);
    expect(x.trace!.mtdNormalCalc, 'and the zakat moved the net figure off the calculated one')
      .not.toBe(leg('slipResultNetMtd'));

    expect(captionOf(res, 'slipResultFinal').first).toEqual({ kind: 'money', amount: stored });
    expect(pcbMtdStep2Section(x).rows.at(-1)!.first).toEqual({ kind: 'money', amount: stored });
    // …and the two legs the band opens with add back to that figure on an ordinary regular run, which is
    // the reconciliation a reader will do with their finger down the agency's page 7.
    expect(Math.round((leg('slipResultNetMtd') + leg('slipResultAdditional')) * 100) / 100).toBe(stored);
  });

  it('the accumulated itemisation counts the PRIOR months of the year and NOT the month being explained', async () => {
    // The agency's block is headed "for previous month's in the current year". Counting this month too
    // double-counts it against the CURRENT MONTH'S REMUNERATION section further down the same document,
    // and — because the accumulator totals beside it genuinely exclude it — would put two figures on one
    // page that cannot both be right.
    const a = adminCtx(base);
    const e = await employee('Prior Months', 'prior.months@acme.test');
    await runMonth('2026-01');
    await runMonth('2026-02');
    await runMonth('2026-03');

    const march = await pcbSlipData(a, {
      companyIds: [base.companyId],
      employmentId: e.employmentId,
      taxYear: 2026,
      month: 3,
    });
    const acc = march.accumulatedRemuneration!;
    expect(acc, 'the itemisation was read').toBeTruthy();
    // Two prior months at 12,000 basic and 800 allowance.
    expect(acc.grossSalary).toBe(24000);
    expect(acc.allowances).toBe(1600);
    expect(acc.additional).toBe(0);

    // January has no prior month at all, and that is a real, readable answer: zero, not "not recorded".
    const jan = await pcbSlipData(a, {
      companyIds: [base.companyId],
      employmentId: e.employmentId,
      taxYear: 2026,
      month: 1,
    });
    expect(jan.accumulatedRemuneration).toEqual({ grossSalary: 0, allowances: 0, additional: 0 });
  });

  it('the itemisation is counted over the SAME slips the run’s own accumulators were replayed from', () => {
    // Not a behavioural case but the reason the predicate is what it is: `core/payroll.ts` replays the
    // accumulators over `employment_id … LIKE '<year>-%' … < '<this month>'` with no company predicate,
    // and this read must select the same set or the two columns describe different years.
    const kernel = code('core/payroll.ts');
    expect(kernel, 'the kernel’s own predicate').toContain("like(payrollBatch.payPeriod, `${pYear}-%`)");
    expect(kernel).toContain('lt(payrollBatch.payPeriod, payPeriod)');
    const reads = code(READS);
    expect(reads).toContain('like(payrollBatch.payPeriod, `${p.taxYear}-%`)');
    expect(reads, 'no company predicate, for the reason the header records').not.toMatch(/payrollBatch\.companyId/);
  });
});
