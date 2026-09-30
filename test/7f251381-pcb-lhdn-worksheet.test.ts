/**
 * Feedback 7f251381 — THE PCB WORKING IN LHDN'S OWN SHAPE.
 *
 * WHAT THIS ITEM IS, AND EQUALLY WHAT IT IS NOT. The reporter asked for three things. The first — "the
 * calculation must use the relevant TP3 values" — is item 1bb09a73 and shipped already; nothing here
 * re-does it. What is left is presentation and traceability: the same recorded figures, re-ordered the
 * way LHDN's own calculation sheet orders them and printed under LHDN's symbols, so the two sheets can be
 * laid side by side and a disagreement lands on a ROW instead of on a total.
 *
 * SO THE THING THAT CAN BE WRONG IS THE MAPPING, AND ONLY THE MAPPING. No figure is computed: every one
 * is read out of the payslip's own `pcbMeta` stamp through `explainPcb`. A symbol pointing at the wrong
 * stored member is therefore invisible to every assertion about totals — the sheet still adds up, it is
 * just about a different number — and is exactly the failure this file is written to catch. Hence:
 *
 *   (a) EVERY SYMBOL, FIELD BY FIELD. `SYMBOL_SOURCE` below names, for each LHDN symbol, the stored
 *       member it must equal, and the assertion is identity against the run's own trace. Swap two
 *       entries in `pcbWorksheet` and the named row fails by name.
 *   (e) AND NOTHING ELSE MAY APPEAR AT ALL. A separate sweep collects every number reachable inside the
 *       explanation and the TP3 seed and requires every amount on the sheet to be one of them, so an
 *       arithmetic expression introduced anywhere in the builder fails even on a row nobody wrote an
 *       assertion for. The screen is source-guarded to touch the row list and nothing else.
 *   (b) A RUN WITH NO TRACE GETS AN HONEST SHEET, NOT A RECONSTRUCTED ONE. `localization/my/payroll.ts`
 *       records that there is "no honest way to reconstruct" a missing trace, and an LHDN-shaped sheet of
 *       RM 0.00 would be more convincing and more wrong than our own layout ever was.
 *   (c) A FLAT-RATE PAYEE HAS NO WORKSHEET, and says so rather than drawing empty M / R / B rows.
 *   (d) THE PREVIOUS-EMPLOYMENT ROWS ARE THE ONES THE CASE TURNS ON, always present, always a figure —
 *       RM 0.00 where nothing is declared, never a blank.
 *
 * NOTHING ABOUT ANY PAYSLIP CHANGES. This screen explains a calculation; it does not perform one, does
 * not write, and does not touch the blob it reads. Asserted below on a real generated payslip.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pcbMonth } from '../localization/my/payroll';
import {
  explainPcb,
  pcbDetailLayout,
  pcbWorksheet,
  type PcbExplanation,
  type PcbPreviousEmployment,
  type PcbReliefBreakdown,
  type PcbWorksheet,
  type PcbWorksheetRow,
} from '../core/pcb-explain';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import {
  currentPcbReliefs,
  listProcessedPayslipsAcross,
  payslipForReview,
  previousEmploymentForPayslip,
} from '../core/payroll-view';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source with comments stripped — these files EXPLAIN at length what they do not do, and a guard that
 *  matched the explanation would pass on prose alone. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const code = (rel: string) => strip(read(rel));

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const VIEW = 'app/payroll/pcb-detail/pcb-detail-view.tsx';
const PAGE = 'app/payroll/pcb-detail/page.tsx';
const EXPLAIN = 'core/pcb-explain.ts';
/** The banner this item's additions to core/pcb-explain.ts begin at. Source guards slice from HERE so the
 *  arithmetic the rest of that file legitimately does is never what they are asserting about. */
const MARKER = "7f251381 — LHDN's own worksheet order";

const CURRENT: PcbReliefBreakdown = {
  individual: 9000, spouse: 0, children: 0, disabledIndividual: 0, disabledSpouse: 0, lp: 0, total: 9000,
};

const flat = (w: PcbWorksheet): PcbWorksheetRow[] => w.sections.flatMap((s) => s.rows);
const bySymbol = (w: PcbWorksheet, symbol: string) => flat(w).filter((r) => r.symbol === symbol);
const byCaption = (w: PcbWorksheet, caption: string) => flat(w).find((r) => r.caption === caption);
const amountOf = (r: PcbWorksheetRow | undefined) => {
  expect(r, 'the row must exist').toBeTruthy();
  expect(r!.value.kind, `${r!.caption} must carry a figure, not "${r!.value.kind}"`).toBe('money');
  return (r!.value as { kind: 'money'; amount: number }).amount;
};

/**
 * A MONTH WITH EVERY LIMB OF THE WORKING ALIVE AT ONCE: a bonus (so §D.2 runs and Yₜ / Kₜ / K₂ₜ and the
 * two year totals are real), accumulated months (so Σ(Y − K), K and X are non-zero), prior and current
 * zakat (Z and Z₁), and an LP split. A month with a zero in half the trace cannot tell a correct mapping
 * from one that points two symbols at the same stored zero.
 */
function richRun() {
  const r = pcbMonth({
    monthlyWage: 14000,
    epfMonthly: 1540,
    month: 7,
    profile: { category: 2, children: 3 },
    // The accumulated EPF is deliberately well under the annual relief cap: with the cap already used up
    // the engine correctly produces K₂ = Kₜ = K₂ₜ = 0, and three symbols sharing one zero is a fixture
    // that cannot tell a right mapping from a wrong one. The distinctness case below enforces that.
    acc: { netRemuneration: 63000, epfClaimed: 800, pcbPaid: 4100, zakatPaid: 250, lpAccumulated: 480 },
    additional: 26000,
    epfOnAdditional: 600,
    lpCurrent: 90,
    zakatCurrent: 60,
  });
  const statutory = {
    pcb: r.total,
    pcbBonus: r.additional,
    epfEmployee: 1540,
    zakat: 60,
    lp: 570,
    pcbMeta: r.snapshot,
  };
  const x = explainPcb(statutory, CURRENT);
  if (x.kind !== 'mtd') throw new Error('unreachable — a resident month is an MTD month');
  return { run: r, statutory, x };
}

const SEED: PcbPreviousEmployment = {
  declaredYear: 2026,
  applies: true,
  netRemuneration: 60000,
  epfClaimed: 3600,
  pcbPaid: 8979,
  zakatPaid: 120,
  // ∑LP from the previous employment — Form TP3 Section D (item 20837372, migration 0488).
  lp: 2500,
};

// ─────────────────────────── (a) every symbol is the stored member it claims ───────────────────────────

describe('7f251381 — each LHDN symbol prints the figure the run recorded under it', () => {
  /**
   * THE MAPPING, WRITTEN OUT ONCE, AS THE THING UNDER TEST. Each entry is an LHDN symbol and the member
   * of the recorded working it must equal — nothing derived, nothing rounded on the way. Point any symbol
   * at a different member in `pcbWorksheet` and that symbol's case fails, naming the symbol.
   */
  const SYMBOL_SOURCE: [symbol: string, source: (x: Extract<PcbExplanation, { kind: 'mtd' }>) => number][] = [
    ['Σ(Y−K)', (x) => x.ytdNetRemuneration],
    ['K', (x) => x.epfClaimedYtd],
    ['Y1', (x) => x.trace!.Y1],
    ['K1', (x) => x.trace!.K1],
    ['Y2', (x) => x.trace!.Y2],
    ['K2', (x) => x.trace!.K2],
    ['Yt', (x) => x.trace!.Yt],
    ['Kt', (x) => x.trace!.Kt],
    ['K2t', (x) => x.trace!.K2t],
    ['D', (x) => x.reliefs.individual],
    ['S', (x) => x.reliefs.spouse],
    ['Du', (x) => x.reliefs.disabledIndividual],
    ['Su', (x) => x.reliefs.disabledSpouse],
    // ⚠️ r359 fda53352 — Q IS NO LONGER THE TOTAL. It mapped to `x.reliefs.children`, the RM child
    // relief; LHDN's specification, printed p.10, defines "Q  Deduction for qualifying children" and
    // "C  Number of qualifying children" with the formula carrying Q x C, so Q is the PER-CHILD figure
    // and the total is their product. The product has its own row, asserted below.
    // r362 — Q and C are `number | null` now, absent on any run stamped before r359. This table runs
    // over a CURRENT fixture, which stamps both; the absent case has its own case in
    // test/ad7bc503-pcb-slip.test.ts, where it must read notRecorded rather than RM0.00.
    ['Q', (x) => (x.kind === 'mtd' && x.trace?.childDeductionPerChild != null ? x.trace.childDeductionPerChild : 0)],
    ['QC', (x) => x.reliefs.children],
    ['ΣLP', (x) => x.trace!.lpAccumulated],
    ['LP1', (x) => x.trace!.lpCurrent],
    ['P', (x) => x.chargeableIncome],
    ['P2', (x) => x.chargeableIncomeWithAdditional!],
    ['M', (x) => x.trace!.M],
    ['B', (x) => x.trace!.B],
    ['Z', (x) => x.trace!.Z],
    ['X', (x) => x.pcbPaidYtd],
    ['Z1', (x) => x.trace!.zakatCurrent],
    ['A', (x) => x.trace!.mtdNormalFloored],
    ['E', (x) => x.trace!.mtdAdditionalFloored],
  ];

  it('every money symbol is identical to the member of the working it names', () => {
    const { x } = richRun();
    const w = pcbWorksheet(x, SEED);
    for (const [symbol, source] of SYMBOL_SOURCE) {
      const rows = bySymbol(w, symbol);
      expect(rows.length, `exactly one ${symbol} row`).toBe(1);
      expect(amountOf(rows[0]), `${symbol} must be the stored figure, to the sen`).toBe(source(x));
    }
  });

  it('A RUN STAMPED BEFORE r359 HAS NO Q AND NO C, AND THE WORKSHEET SAYS SO INSTEAD OF PRINTING ZERO', () => {
    // r362 — THIS DEFECT WAS LIVE ON EVERY HISTORIC PAYSLIP. r359 added `childDeductionPerChild` and
    // redefined `childCount`, and `readTrace` put both through `n()`, which turns `undefined` into 0.
    // A payslip stamped before 2026-09-29 therefore rendered Q = RM0.00 and C = 0 beside a QC holding
    // the real relief — three cells that visibly do not multiply, on the screen a payroll officer uses
    // to defend a figure, with nothing saying the split was simply never recorded for that run.
    //
    // `explainPcb`'s own doc states the rule that was broken: a member a run predates is "not recorded
    // for this run", and it "does NOT render the legs as zeroes". Absence now stays absent.
    const { statutory } = richRun();
    const snap = JSON.parse(JSON.stringify(statutory.pcbMeta)) as { trace?: Record<string, unknown> };
    if (!snap.trace) throw new Error('the fixture must carry a trace to strip fields from');
    delete snap.trace.childCount;
    delete snap.trace.childDeductionPerChild;

    const x = explainPcb({ ...statutory, pcbMeta: snap }, CURRENT);
    if (x.kind !== 'mtd' || x.trace == null) throw new Error('stripping two fields must not lose the trace');
    // The premise, asserted so this case cannot pass by accidentally having no trace at all.
    expect(x.trace.M, 'the bracket survived — this is the "old stamp" case, not the "no trace" case').toBeGreaterThan(0);

    const w = pcbWorksheet(x, SEED);
    expect(bySymbol(w, 'Q')[0].value, 'Q is not recorded for this run — RM0.00 would be a false figure').toEqual({
      kind: 'notRecorded',
    });
    expect(bySymbol(w, 'C')[0].value, 'and neither is C — a count of 0 children would be a false figure').toEqual({
      kind: 'notRecorded',
    });
    // QC still prints: the RELIEF was on the old stamp, only the split into Q and C was not. That
    // asymmetry is the reason the guard is on the FIELD rather than on the trace.
    expect(bySymbol(w, 'QC')[0].value, 'the relief itself IS recorded and still prints').toEqual({
      kind: 'money',
      amount: x.reliefs.children,
    });
  });

  it('…and the figures it is matched against are actually different from one another', () => {
    // WITHOUT THIS THE CASE ABOVE IS VACUOUS. If half the fixture's trace were zero, a mapping that
    // pointed six symbols at one member would still pass. Y₂ IS Y₁ by construction (the projection
    // repeats the current month) and Du / Su are both zero for an employee claiming neither, so those
    // three are excluded BY NAME rather than by loosening the check.
    const { x } = richRun();
    const excluded = new Set(['Y2', 'Du', 'Su']);
    const values = SYMBOL_SOURCE.filter(([s]) => !excluded.has(s)).map(([s, f]) => [s, f(x)] as const);
    const seen = new Map<number, string>();
    for (const [symbol, v] of values) {
      const prior = seen.get(v);
      expect(prior, `${symbol} and ${prior} share the value ${v} — this fixture cannot tell them apart`).toBeUndefined();
      seen.set(v, symbol);
    }
    expect(values.length).toBeGreaterThan(15);
  });

  it('R is the bracket RATE, printed as a rate and not as an amount', () => {
    const { x } = richRun();
    const w = pcbWorksheet(x, SEED);
    const r = bySymbol(w, 'R')[0];
    expect(r.value).toEqual({ kind: 'rate', rate: x.trace!.R });
    // n and the child COUNT are counts, not money — an RM prefix on "3 children" is a claim about money.
    expect(byCaption(w, 'worksheetN')!.value).toEqual({ kind: 'count', count: x.remainingMonths });
    expect(byCaption(w, 'worksheetC')!.value).toEqual({ kind: 'count', count: x.trace!.childCount });
  });

  // ⚠️ 4011903e — THIS CASE IS INVERTED, AND WHAT IT WAS PROTECTING IS ASSERTED HARDER BELOW.
  //
  // It used to read: "LHDN's gross Y is reported as not recorded separately — never Σ(Y − K) + K", and
  // it swept every money row refusing any figure equal to that sum. That was right: Σ(Y − K) + K IS
  // arithmetically LHDN's Y, and printing it would have been a number this system never produced.
  //
  // The engine now ACCUMULATES Y itself (core/payroll.ts `grossRemuneration`), from the same list and the
  // same per-month figure as Σ(Y−K), and stamps it as `pcbMeta.ytdGross`. So the row prints a stored
  // figure. The old value-sweep cannot survive that, because a correctly stamped Y EQUALS the sum by
  // construction — keeping it would forbid the right answer.
  //
  // The protection therefore moves from the VALUE to the SOURCE: Y may be printed only when the engine
  // stamped one, and a slip that carries none must still say so rather than have one computed for it.
  it('prints Y when the engine stamped it — the figure is the stamp, not a reconstruction', () => {
    const { x } = richRun();
    const w = pcbWorksheet({ ...x, ytdGross: 120000 }, SEED);
    const y = bySymbol(w, 'Y')[0];
    expect(y.value.kind).toBe('money');
    expect(y.value.kind === 'money' && y.value.amount, 'the stamped figure, verbatim').toBe(120000);
  });

  it('a slip with NO stamped Y still says the figure is not recorded — it is never reconstructed', () => {
    // THE OLD BEHAVIOUR, KEPT AS THE FALLBACK. Every payslip written before 4011903e carries no
    // `ytdGross`, and for those the honest answer is still that we did not write the figure down.
    const { x } = richRun();
    expect(x.ytdGross, 'the fixture must genuinely lack a stamp, or this proves nothing').toBeUndefined();
    const w = pcbWorksheet(x, SEED);
    const y = bySymbol(w, 'Y')[0];
    expect(y.value.kind).toBe('notSeparatelyRecorded');
    const sum = x.ytdNetRemuneration + x.epfClaimedYtd;
    for (const row of flat(w)) {
      if (row.value.kind === 'money') {
        expect(row.value.amount, `no row may print the reconstructed gross Y (${sum})`).not.toBe(sum);
      }
    }
  });

  it('the sheet ends on the figure the working lands on, and on nothing else', () => {
    const { x } = richRun();
    const w = pcbWorksheet(x, SEED);
    // A plain regular run: one final line, captioned as the deduction, because they are one number.
    expect(x.basis).toBeNull();
    expect(byCaption(w, 'worksheetMtd')!.value).toEqual({ kind: 'money', amount: x.pcbSystem });
    expect(byCaption(w, 'worksheetMtdSystem'), 'no system/deducted split when there is no gap').toBeUndefined();
    expect(byCaption(w, 'worksheetMtdDeducted')).toBeUndefined();
  });

  it('when the deduction is NOT what the working produced, the deduction gets its own labelled row', () => {
    // A hand-set PCB. `pcb-detail-view.tsx` states the rule this pins: a figure appears "as a labelled
    // line — never as the quiet answer to a formula that did not produce it."
    const { statutory, x: plain } = richRun();
    const overridden = {
      ...statutory,
      pcb: 99,
      adjustment: { reason: 'agreed with LHDN', lines: { pcb: { system: plain.pcb, applied: 99 } } },
    };
    const x = explainPcb(overridden, CURRENT);
    const w = pcbWorksheet(x, SEED);
    expect(x.basis!.kind).toBe('manual');
    expect(byCaption(w, 'worksheetMtdSystem')!.value).toEqual({ kind: 'money', amount: x.pcbSystem });
    expect(byCaption(w, 'worksheetMtdDeducted')!.value).toEqual({ kind: 'money', amount: 99 });
    expect(byCaption(w, 'worksheetMtd'), 'the ambiguous single caption is gone').toBeUndefined();
  });

  it('a month with no additional remuneration says §D.2 did not run — it does not print P₂ as zero', () => {
    const r = pcbMonth({
      monthlyWage: 9000, epfMonthly: 990, month: 4,
      profile: { category: 1 },
      acc: { netRemuneration: 24000, epfClaimed: 2970, pcbPaid: 500, zakatPaid: 0, lpAccumulated: 0 },
    });
    const x = explainPcb({ pcb: r.total, epfEmployee: 990, pcbMeta: r.snapshot }, CURRENT);
    const w = pcbWorksheet(x, null);
    expect(bySymbol(w, 'P2')[0].value).toEqual({ kind: 'didNotRun' });
    // …while Yₜ and Kₜ ARE recorded zeroes for that month, and print as zeroes, because the engine wrote
    // them down. "Did not run" and "ran and produced nothing" are two different sentences.
    expect(bySymbol(w, 'Yt')[0].value).toEqual({ kind: 'money', amount: 0 });
  });
});

// ─────────────────────── (e) nothing on the sheet is computed, by core or by the view ───────────────────

describe('7f251381 — the worksheet derives nothing', () => {
  /** Every number reachable inside the objects the builder was handed. */
  const numbersIn = (v: unknown, out = new Set<number>()): Set<number> => {
    if (typeof v === 'number') out.add(v);
    else if (v && typeof v === 'object') for (const k of Object.values(v as Record<string, unknown>)) numbersIn(k, out);
    return out;
  };

  it('every figure on the sheet is a number that was already in the stored working', () => {
    // THE SWEEP THAT DOES NOT NEED A HAND-WRITTEN ASSERTION PER ROW. Any sum, difference, re-rounding or
    // unit change introduced into `pcbWorksheet` produces a number that is not in the inputs, and fails
    // here naming the caption — including on rows added after this file was written.
    const { x } = richRun();
    const w = pcbWorksheet(x, SEED);
    const allowed = numbersIn({ x, seed: SEED });
    for (const row of flat(w)) {
      if (row.value.kind === 'money') {
        expect(allowed.has(row.value.amount), `${row.symbol || row.caption}: ${row.value.amount} was computed, not read`).toBe(true);
      }
      if (row.value.kind === 'rate') {
        expect(allowed.has(row.value.rate), `${row.symbol}: the rate was computed, not read`).toBe(true);
      }
      if (row.value.kind === 'count') {
        expect(allowed.has(row.value.count), `${row.caption}: the count was computed, not read`).toBe(true);
      }
    }
  });

  it('the builder contains no arithmetic at all', () => {
    // Source-level, because the sweep above can only see the rows a fixture reaches. The slice starts at
    // this item's banner and runs to the end of the file, so the arithmetic the REST of core/pcb-explain
    // legitimately does (r2, the normal/additional split) is not what is being asserted about.
    const src = read(EXPLAIN);
    // Sliced from the BANNER line, not from inside the doc comment beneath it: starting mid-comment
    // leaves the comment unterminated, `strip` cannot match it, and its prose would be searched for
    // arithmetic — which is how this guard first passed a `+` that was only ever in a sentence.
    const at = src.indexOf(MARKER);
    expect(at, 'the item’s section marker').toBeGreaterThan(-1);
    const body = strip(src.slice(at));
    for (const op of ['+', '*', 'Math.', 'round', 'toFixed']) {
      expect(body, `the worksheet builder must not use ${op}`).not.toContain(op);
    }
  });

  it('the screen paints the row list and never reaches back into the figures', () => {
    const view = code(VIEW);
    /**
     * r372 — THE ANCHOR MOVED, AND THE DECISION IT PINS GOT STRONGER RATHER THAN WEAKER.
     *
     * "Absent rather than drawn empty" used to be a `worksheet.shape !== 'unavailable'` test inside this
     * component, so this guard sliced from it. The sheet is now an unnumbered APPENDIX placed by
     * `pcbDetailLayout`, and that decision therefore lives in core/ where it can be driven directly — the
     * case below does exactly that, for the shape AND for a null sheet, which the string match could not.
     * What is still asserted HERE is the other half: the body paints and computes nothing.
     */
    const at = view.indexOf("case 'lhdnWorksheet':");
    expect(at, 'the worksheet body').toBeGreaterThan(-1);
    const block = view.slice(at, view.indexOf("case 'source':", at));
    expect(block.length, 'the slice found a body to assert about').toBeGreaterThan(200);
    expect(block, 'the block renders values through the switch').toContain('wsValue(r.value)');
    expect(block, 'and must not read the explanation itself').not.toContain('explanation.');
    expect(block, 'nor the trace').not.toContain('trace.');
    expect(block, 'nor format a figure of its own').not.toContain('rm(');
    // …and the absence decision itself, driven rather than matched.
    const gone = pcbDetailLayout({
      explanation: { kind: 'unavailable', pcb: 100, pcbSystem: 100, pcbNormal: 100, pcbAdditional: 0, basis: null } as PcbExplanation,
      worksheet: null,
      slip: [],
      closing: [],
    });
    const slots = gone.flatMap((e) => (e.kind === 'body' ? [e.slot] : []));
    expect(slots, 'a sheet that could not be built is ABSENT, not drawn empty').not.toContain('lhdnWorksheet');

    // The value switch itself: a formatter chooser, with no arithmetic and no coercion of its own.
    const sw = view.slice(view.indexOf('const wsValue ='), view.indexOf('const cycleKey'));
    expect(sw.length).toBeGreaterThan(100);
    for (const op of ['+', '*', 'Math.', 'Number(']) {
      expect(sw, `the value switch must not use ${op}`).not.toContain(op);
    }
  });

  it('the screen still cannot recompute the tax, and the sheet did not give it a way in', () => {
    for (const f of [PAGE, VIEW]) {
      const imports = read(f).split('\n').filter((l) => l.trimStart().startsWith('import '));
      for (const forbidden of ['pcbMonth', 'localization/my/payroll', 'statutory-tables', 'packFor']) {
        expect(imports.join('\n'), `${f} must not import ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('the symbols are DATA from core, not strings translated in the component', () => {
    // The symbols are language-neutral; the captions are not. A Malay caption hardcoded in the component
    // is the failure mode this asserts against, and a "translated" symbol would break the very matching
    // the sheet exists for.
    const src = read(EXPLAIN);
    const body = src.slice(src.indexOf(MARKER));
    for (const sym of ['Y1', 'K1', 'Y2', 'K2', 'Yt', 'Kt', 'K2t', 'ΣLP', 'LP1', 'Σ(Y−K)']) {
      expect(body, `${sym} is declared in core`).toContain(`symbol: '${sym}'`);
    }
    const view = code(VIEW);
    expect(view, 'the component receives symbols, it does not mint them').toContain('symbol={r.symbol}');
    expect(view, 'and resolves every caption through the catalogue').toContain('label={t(r.caption)}');
  });
});

// ─────────────────────────── (b) a run with no trace gets an honest sheet ───────────────────────────

describe('7f251381 — a run that recorded no working is not handed one in LHDN’s shape', () => {
  const noTrace = {
    pcb: 402.65,
    epfEmployee: 0,
    zakat: 15,
    pcbMeta: {
      month: 1, n: 11, ytdNet: 1234.5, epfClaimed: 200, pcbPaid: 90, P1: 75956.07,
      reliefs: { individual: 9000, spouse: 0, children: 0, disabledIndividual: 0, disabledSpouse: 0, lp: 0, total: 9000 },
    },
  };

  it('every trace-fed row reads "not recorded", and not one of them reads 0.00', () => {
    const x = explainPcb(noTrace, CURRENT);
    if (x.kind !== 'mtd') throw new Error('unreachable');
    expect(x.trace, 'the premise: this run has no trace').toBeNull();
    const w = pcbWorksheet(x, null);
    for (const sym of ['Y1', 'K1', 'Y2', 'K2', 'Yt', 'Kt', 'K2t', 'ΣLP', 'LP1', 'M', 'R', 'B', 'Z', 'A', 'E']) {
      expect(bySymbol(w, sym)[0].value, `${sym} must be "not recorded", never a zero`).toEqual({ kind: 'notRecorded' });
    }
    expect(byCaption(w, 'worksheetC')!.value).toEqual({ kind: 'notRecorded' });
    expect(byCaption(w, 'worksheetTaxOnP')!.value).toEqual({ kind: 'notRecorded' });
  });

  it('what WAS recorded still prints, so the absence is scoped to what is absent', () => {
    const x = explainPcb(noTrace, CURRENT);
    const w = pcbWorksheet(x, null);
    expect(amountOf(bySymbol(w, 'Σ(Y−K)')[0])).toBe(1234.5);
    expect(amountOf(bySymbol(w, 'K')[0])).toBe(200);
    expect(amountOf(bySymbol(w, 'X')[0])).toBe(90);
    expect(amountOf(bySymbol(w, 'P')[0])).toBe(75956.07);
    // Z₁ is stamped on the blob independently of the trace, so it is a real figure even here.
    expect(amountOf(bySymbol(w, 'Z1')[0])).toBe(15);
    expect(amountOf(byCaption(w, 'worksheetMtd'))).toBe(402.65);
  });

  it('a payslip with NO working at all gets no sheet, rather than a sheet of dashes', () => {
    const x = explainPcb({ pcb: 77 }, CURRENT);
    expect(x.kind).toBe('unavailable');
    const w = pcbWorksheet(x, SEED);
    expect(w.shape).toBe('unavailable');
    expect(w.sections, 'an empty LHDN sheet asserts that this employee HAS one').toEqual([]);
    /**
     * …and NEITHER SURFACE DRAWS IT — which r372 moved out of this component and into the shared list.
     *
     * The screen used to decide this itself with a `worksheet.shape !== 'unavailable'` test in its JSX, so
     * this guard matched that string. The order of both surfaces is now `pcbDetailLayout`'s answer, so the
     * decision is driven instead of matched — and the driven version is strictly stronger: it covers the
     * `worksheet: null` case too, which a string match in one component never could, and it covers the
     * DOWNLOADED DOCUMENT, which this assertion never reached at all.
     */
    for (const sheet of [w, null]) {
      const slots = pcbDetailLayout({ explanation: x, worksheet: sheet, slip: [], closing: [] })
        .flatMap((e) => (e.kind === 'body' ? [e.slot] : []));
      expect(slots, 'a sheet with no rows is ABSENT, not drawn as dashes').not.toContain('lhdnWorksheet');
    }
    // The "unavailable" card is what says so in words, and it is still in the run.
    expect(
      pcbDetailLayout({ explanation: x, worksheet: w, slip: [], closing: [] })
        .flatMap((e) => (e.kind === 'body' ? [e.slot] : [])),
      'the card that says it in words',
    ).toContain('unavailableCard');
  });
});

// ─────────────────────────────── (c) the flat-rate shape, decided ───────────────────────────────

describe('7f251381 — a flat-rate payee has no LHDN worksheet, and the sheet says so', () => {
  const flatBlob = (trace?: unknown) => ({
    pcb: 1650,
    pcbBonus: 0,
    pcbMeta: { nonResident: true, flatRate: 0.3, rate: 0.3, ...(trace !== undefined ? { trace } : {}) },
  });

  it('shows the three lines that exist and NOT one empty bracket or relief row', () => {
    // THE DECISION. A non-resident / REP / knowledge-worker deduction returns from the flat branch of
    // `statutory()` before `pcbMonth` is ever called, so P, the M/R/B bracket, D/S/Q, Z, X and the
    // accumulators do not exist for this employee — they were not merely unsaved. Drawing them with
    // "not recorded" beside them would assert that they do.
    const x = explainPcb(flatBlob({ remuneration: 5000, additional: 500, rate: 0.3 }), CURRENT);
    if (x.kind !== 'flat') throw new Error('unreachable');
    const w = pcbWorksheet(x, SEED);
    expect(w.shape).toBe('flat');
    // R IS ON THIS LIST ON PURPOSE. R is the rate of the tax-table bracket, and a flat-rate payee has no
    // bracket; the flat percentage is a different mechanism and carries no LHDN symbol at all.
    for (const absent of ['P', 'P2', 'M', 'R', 'B', 'D', 'S', 'Q', 'Du', 'Su', 'Z', 'Z1', 'X', 'K', 'K1', 'Σ(Y−K)', 'A', 'E', 'ΣLP', 'LP1']) {
      expect(bySymbol(w, absent), `a flat-rate sheet must draw no ${absent} row`).toEqual([]);
    }
    expect(amountOf(bySymbol(w, 'Y')[0])).toBe(5000);
    expect(amountOf(bySymbol(w, 'Yt')[0])).toBe(500);
    expect(byCaption(w, 'worksheetFlatRate')!.value).toEqual({ kind: 'rate', rate: 0.3 });
    expect(byCaption(w, 'worksheetFlatRate')!.symbol, 'and it borrows no symbol').toBe('');
    expect(amountOf(byCaption(w, 'worksheetMtd'))).toBe(1650);
  });

  it('the previous-employment section is absent too, because the seed never reaches a flat rate', () => {
    // Read out of the engine, not assumed: the flat branch returns without touching `acc`, so a TP3
    // declaration cannot move a flat-rate deduction. A section showing RM 60,000 beside a figure it did
    // not enter would be worse than no section.
    const x = explainPcb(flatBlob({ remuneration: 5000, additional: 0, rate: 0.3 }), CURRENT);
    const w = pcbWorksheet(x, SEED);
    expect(flat(w).some((r) => r.previousEmployment), 'no previous-employment rows on a flat sheet').toBe(false);
    expect(w.note).toBe('worksheetFlatNote');
    const en = JSON.parse(read('messages/en.json')).payroll.pcbDetail as Record<string, string>;
    expect(en.worksheetFlatNote.toLowerCase(), 'and the note must say why there is nothing to compare')
      .toContain('no calculation worksheet');
    expect(en.worksheetFlatNote.toLowerCase(), 'and that a previous employer does not enter it')
      .toContain('previous employer');
  });

  it('an old flat-rate run says its remuneration is not recorded, rather than nil', () => {
    const x = explainPcb(flatBlob(), CURRENT);
    const w = pcbWorksheet(x, null);
    expect(bySymbol(w, 'Y')[0].value).toEqual({ kind: 'notRecorded' });
    expect(bySymbol(w, 'Yt')[0].value).toEqual({ kind: 'notRecorded' });
    // The RATE is stamped outside the trace and is still a fact about this deduction.
    expect(byCaption(w, 'worksheetFlatRate')!.value).toEqual({ kind: 'rate', rate: 0.3 });
  });
});

// ────────────────────── (d) the previous-employment rows, always a figure ──────────────────────

describe('7f251381 — the previous-employment lines are their own rows, never a blank', () => {
  it('a declaration for this tax year prints its four figures and says it was used', () => {
    const { x } = richRun();
    const w = pcbWorksheet(x, SEED);
    expect(amountOf(byCaption(w, 'worksheetPrevNet'))).toBe(60000);
    expect(amountOf(byCaption(w, 'worksheetPrevEpf'))).toBe(3600);
    expect(amountOf(byCaption(w, 'worksheetPrevPcb'))).toBe(8979);
    expect(amountOf(byCaption(w, 'worksheetPrevZakat'))).toBe(120);
    // Item 20837372 — ∑LP is the FIFTH declared figure, and the exact-set count below is UPDATED rather
    // than loosened: a fifth row that the count does not know about is a row nothing is pinning.
    expect(amountOf(byCaption(w, 'worksheetPrevLp'))).toBe(2500);
    expect(byCaption(w, 'worksheetPrevYear')!.value).toEqual({ kind: 'text', text: '2026' });
    expect(byCaption(w, 'worksheetPrevApplies')!.value).toEqual({ kind: 'caption', caption: 'worksheetPrevAppliesYes' });
    expect(flat(w).filter((r) => r.previousEmployment).length, 'five money rows, flagged').toBe(5);
  });

  it('NOTHING declared is RM 0.00 on all five rows — a visible zero, not an absent box', () => {
    // §8: an absent box asserts nothing; 0.00 asserts the money does not exist. "Did this employee bring
    // previous-employment income into this tax year" is the question the reporter's case turned on, and a
    // blank is how the answer went unread for a year.
    const { x } = richRun();
    for (const p of [null, { declaredYear: null, applies: false, netRemuneration: 0, epfClaimed: 0, pcbPaid: 0, zakatPaid: 0, lp: 0 }]) {
      const w = pcbWorksheet(x, p);
      for (const cap of ['worksheetPrevNet', 'worksheetPrevEpf', 'worksheetPrevPcb', 'worksheetPrevZakat', 'worksheetPrevLp']) {
        const row = byCaption(w, cap);
        // PRESENCE FIRST, AND BY NAME. Dropping the row entirely is the exact regression this case is
        // about, and asserting straight into `.value` would report it as a TypeError about undefined
        // rather than as "the row is missing".
        expect(row, `${cap} must still be a ROW when nothing is declared — an absent box asserts nothing`).toBeTruthy();
        expect(row!.value, `${cap} with no declaration`).toEqual({ kind: 'money', amount: 0 });
      }
      expect(byCaption(w, 'worksheetPrevYear')!.value).toEqual({ kind: 'caption', caption: 'worksheetPrevNone' });
      expect(byCaption(w, 'worksheetPrevApplies')!.value).toEqual({ kind: 'caption', caption: 'worksheetPrevAppliesNo' });
    }
  });

  it('a declaration for a DIFFERENT year still prints, and says the run started from zero', () => {
    // The case item 1bb09a73 now BLOCKS at pre-processing, and the case every already-filed payslip in
    // the archive can still be in. The figures are real and they did not enter this run; both halves are
    // said, because either alone misleads.
    const { x } = richRun();
    const w = pcbWorksheet(x, { ...SEED, declaredYear: 2025, applies: false });
    expect(byCaption(w, 'worksheetPrevYear')!.value).toEqual({ kind: 'text', text: '2025' });
    expect(byCaption(w, 'worksheetPrevApplies')!.value).toEqual({ kind: 'caption', caption: 'worksheetPrevAppliesNo' });
    expect(amountOf(byCaption(w, 'worksheetPrevPcb'))).toBe(8979);
  });

  it('the section is the FIRST one on the sheet and carries the sentence about where it was read from', () => {
    const { x } = richRun();
    const w = pcbWorksheet(x, SEED);
    expect(w.sections[0].heading).toBe('worksheetPreviousHeading');
    expect(w.sections[0].note).toBe('worksheetPreviousNote');
    const en = JSON.parse(read('messages/en.json')).payroll.pcbDetail as Record<string, string>;
    expect(en.worksheetPreviousNote, 'it must say these are read from the TP3 record, not the payslip')
      .toContain('not from the payslip');
    expect(en.worksheetPreviousNote, 'and name the four LHDN lines they are folded into').toContain('Y, K, X and Z');
  });
});

// ───────────────────────────── the six catalogues, asserted explicitly ─────────────────────────────

describe('7f251381 — every caption the sheet resolves exists in all six catalogues', () => {
  /** Every key `pcbWorksheet` can emit, plus the two absence markers and the block’s own chrome. A
   *  worksheet caption is a COMPUTED t() key, invisible to test/i18n-coverage.ts check C, so this list is
   *  the only thing standing between a missing caption and a MISSING_MESSAGE on a tax screen. */
  const KEYS = [
    'worksheetHeading', 'worksheetNote', 'worksheetNotSeparate', 'worksheetDidNotRun',
    'worksheetPreviousHeading', 'worksheetPreviousNote', 'worksheetPrevYear', 'worksheetPrevNone',
    'worksheetPrevApplies', 'worksheetPrevAppliesYes', 'worksheetPrevAppliesNo',
    'worksheetPrevNet', 'worksheetPrevEpf', 'worksheetPrevPcb', 'worksheetPrevZakat',
    // Item 20837372 — the previous employment's ∑LP. On the EXHAUSTIVE list, not appended silently:
    // this list is what stands between a computed caption key and a MISSING_MESSAGE on a tax screen.
    'worksheetPrevLp',
    'worksheetIncomeHeading', 'worksheetIncomeNote', 'worksheetY', 'worksheetSumYK', 'worksheetK',
    'worksheetY1', 'worksheetK1', 'worksheetY2', 'worksheetK2', 'worksheetN',
    'worksheetAdditionalHeading', 'worksheetYt', 'worksheetKt', 'worksheetK2t',
    'worksheetReliefHeading', 'worksheetD', 'worksheetS', 'worksheetDu', 'worksheetSu', 'worksheetQ', 'worksheetQc',
    'worksheetC', 'worksheetLpAccumulated', 'worksheetLpCurrent',
    'worksheetBracketHeading', 'worksheetP', 'worksheetP2', 'worksheetM', 'worksheetR', 'worksheetB',
    'worksheetTaxOnP',
    'worksheetResultHeading', 'worksheetZ', 'worksheetX', 'worksheetZ1', 'worksheetA', 'worksheetE',
    'worksheetMtd', 'worksheetMtdSystem', 'worksheetMtdDeducted',
    'worksheetFlatHeading', 'worksheetFlatY', 'worksheetFlatYt', 'worksheetFlatRate', 'worksheetFlatNote',
  ];

  it('the list above is EXHAUSTIVE — every key the builder can emit is on it', () => {
    // A key added to `pcbWorksheet` and forgotten here would ship untranslated in five languages and the
    // catalogue check would never see it, because a computed key is invisible to the coverage scan. So
    // the list is derived back out of the builder’s own source and compared as a set.
    const src = read(EXPLAIN);
    const body = src.slice(src.indexOf(MARKER));
    const emitted = new Set<string>();
    for (const m of body.matchAll(/'(worksheet[A-Za-z0-9]*)'/g)) emitted.add(m[1]);
    // The view adds the block heading, its note and the two absence markers.
    for (const k of ['worksheetHeading', 'worksheetNotSeparate', 'worksheetDidNotRun']) emitted.add(k);
    expect([...emitted].sort(), 'the catalogue list and the builder must not drift').toEqual([...KEYS].sort());
  });

  it('all six catalogues carry every one of them, with no ICU argument', () => {
    // i18n/request.ts deep-merges each locale over English, so a MISSING key renders ENGLISH rather than
    // MISSING_MESSAGE: a clean render log is NOT evidence of coverage, and this is. A stray brace would
    // throw at render and paint the key path onto a tax screen, so the no-argument rule is checked too.
    for (const loc of LOCALES) {
      const blk = JSON.parse(read(`messages/${loc}.json`)).payroll.pcbDetail as Record<string, string>;
      for (const k of KEYS) {
        expect(blk[k], `payroll.pcbDetail.${k} in ${loc}`).toBeTruthy();
        expect(blk[k], `payroll.pcbDetail.${k} in ${loc} must take no ICU argument`).not.toMatch(/[{}]/);
      }
    }
  });

  it('and the five translations are actually translated, not the English string copied across', () => {
    const en = JSON.parse(read('messages/en.json')).payroll.pcbDetail as Record<string, string>;
    for (const loc of LOCALES.filter((l) => l !== 'en')) {
      const blk = JSON.parse(read(`messages/${loc}.json`)).payroll.pcbDetail as Record<string, string>;
      // The long prose keys are the ones a copy-paste would hide in; short captions can legitimately
      // coincide across languages, so the check is scoped to the sentences.
      //
      // ⚠️ THIS LIST IS EXTENDED DELIBERATELY, NEVER LEFT TO DRIFT. It is the one place on this screen
      // that says which sentences must actually have been translated, and `i18n/request.ts` deep-merges
      // each locale over English — so an untranslated key renders as fluent English rather than as
      // MISSING_MESSAGE and no render check can ever catch it. r361 (item bf3c9712) adds four sentences:
      // the accumulated-remuneration note, which is what keeps the printed 0.00 against benefit-in-kind
      // and value of living accommodation honest (CLAUDE.md §8), its unread counterpart, and the two
      // notes under the agency's numbered steps. They live under the `slip` prefix rather than the
      // `worksheet` one, so the EXHAUSTIVE builder sweep above does not reach them and this does.
      for (const k of [
        'worksheetNote', 'worksheetPreviousNote', 'worksheetIncomeNote', 'worksheetFlatNote',
        'slipAccNote', 'slipAccNoteUnread', 'slipStep1Note', 'slipResultNote',
      ]) {
        expect(blk[k], `${loc}.${k} is still the English sentence`).not.toBe(en[k]);
      }
    }
  });

  it('the symbols themselves are NOT in any catalogue — they are language-neutral', () => {
    // A locale that "translated" Y₁ or ΣLP would break the one thing the sheet exists to do. They live in
    // core/pcb-explain.ts as data and reach the screen untranslated.
    for (const loc of LOCALES) {
      const blk = JSON.parse(read(`messages/${loc}.json`)).payroll.pcbDetail as Record<string, string>;
      for (const sym of ['Y1', 'K2t', 'Σ(Y−K)']) {
        expect(Object.keys(blk), `${loc} must not key a catalogue entry on the symbol ${sym}`).not.toContain(sym);
      }
    }
  });
});

// ─────────────────────── a real run, end to end, and no payslip changed ───────────────────────

let base: Base;
beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('7f251381 — a generated payslip fills the sheet, and the payslip is untouched', () => {
  const hire = async (a: Awaited<ReturnType<typeof adminCtx>>, name: string, email: string, ic: string) => {
    const e = await hireEmployee(a, {
      person: { fullName: name, primaryEmail: email },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: 15000,
      monthlyAllowance: 0,
      effectiveFrom: '2026-01-01',
    });
    return e;
  };

  it('reads the TP3 columns the KERNEL seeds from, and the sheet prints them as their own rows', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Lhdn Sheet', 'lhdn.sheet@acme.test', '900101011611');
    // The same five columns core/payroll.ts reads at :3323-3327 and gates at :3957.
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: '900101011611',
      taxCategory: 1,
      tp3Year: 2026,
      tp3NetRemuneration: 60000,
      tp3EpfClaimed: 3600,
      tp3PcbPaid: 8979,
      tp3ZakatPaid: 120,
    });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-07' });
    await generatePayslips(a, { batchId });

    const rows = await listProcessedPayslipsAcross(a, { companyIds: [base.companyId], employmentId: e.employmentId });
    const row = await payslipForReview(a, { companyIds: [base.companyId], payslipId: rows[0].id });
    const before = JSON.stringify(row!.statutory);
    const fallback = await currentPcbReliefs(a, {
      companyIds: [base.companyId],
      employmentId: e.employmentId,
      asOf: '2026-07-28',
    });
    const previous = await previousEmploymentForPayslip(a, {
      companyIds: [base.companyId],
      employmentId: e.employmentId,
      taxYear: 2026,
    });
    expect(previous, 'the read resolves for an in-scope employment').not.toBeNull();
    expect(previous!.applies, 'a 2026 form against a 2026 payslip').toBe(true);
    expect(previous!.netRemuneration).toBe(60000);

    const x = explainPcb(row!.statutory, fallback);
    const w = pcbWorksheet(x, previous);
    expect(w.shape).toBe('mtd');
    expect(amountOf(byCaption(w, 'worksheetPrevPcb'))).toBe(8979);
    // And the seeded figures are genuinely IN the run's accumulators, which is what makes the two rows
    // worth reading against each other: X for a July payslip cannot be under the previous employer's own
    // 8,979 unless the seed reached it.
    if (x.kind !== 'mtd') throw new Error('unreachable');
    expect(x.pcbPaidYtd, 'the seed reached the accumulator (item 1bb09a73)').toBeGreaterThanOrEqual(8979);

    // NOTHING ABOUT THE PAYSLIP CHANGED. The screen explains a calculation; it does not perform one, and
    // it does not touch the blob it read.
    expect(JSON.stringify(row!.statutory)).toBe(before);
    const again = await payslipForReview(a, { companyIds: [base.companyId], payslipId: rows[0].id });
    expect(JSON.stringify(again!.statutory)).toBe(before);
  });

  it('an employee with no Form TP3 gets four zero rows, and X is the run’s own months', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'No Tp3', 'no.tp3@acme.test', '900101011612');
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011612', taxCategory: 1 });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-07' });
    await generatePayslips(a, { batchId });
    const rows = await listProcessedPayslipsAcross(a, { companyIds: [base.companyId], employmentId: e.employmentId });
    const row = await payslipForReview(a, { companyIds: [base.companyId], payslipId: rows[0].id });
    const previous = await previousEmploymentForPayslip(a, {
      companyIds: [base.companyId],
      employmentId: e.employmentId,
      taxYear: 2026,
    });
    expect(previous!.declaredYear, 'a profile with no TP3 year at all').toBeNull();
    expect(previous!.applies).toBe(false);
    const w = pcbWorksheet(explainPcb(row!.statutory, null), previous);
    for (const cap of ['worksheetPrevNet', 'worksheetPrevEpf', 'worksheetPrevPcb', 'worksheetPrevZakat', 'worksheetPrevLp']) {
      expect(byCaption(w, cap)!.value, cap).toEqual({ kind: 'money', amount: 0 });
    }
  });

  it('the read fails CLOSED — an out-of-scope employment yields nothing at all', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Scope Fence', 'scope.fence@acme.test', '900101011613');
    await setStatutoryProfileMY(a, {
      personId: e.personId, icNumber: '900101011613', taxCategory: 1,
      tp3Year: 2026, tp3NetRemuneration: 60000, tp3EpfClaimed: 3600, tp3PcbPaid: 8979, tp3ZakatPaid: 0,
    });
    // Empty scope, and a scope that does not contain this employment's company: both are null, so a
    // tampered id cannot be told apart from an employment that does not exist.
    expect(await previousEmploymentForPayslip(a, { companyIds: [], employmentId: e.employmentId, taxYear: 2026 })).toBeNull();
    expect(
      await previousEmploymentForPayslip(a, {
        companyIds: ['00000000-0000-0000-0000-000000000000'],
        employmentId: e.employmentId,
        taxYear: 2026,
      }),
    ).toBeNull();
  });

  it('the screen reads it under the SAME scope fence as the payslip itself', () => {
    const page = code(PAGE);
    expect(page).toContain('previousEmploymentForPayslip');
    expect(page, 'the same companyIds the payslip read is fenced on').toMatch(
      /previousEmploymentForPayslip\(s,\s*\{\s*companyIds:\s*scopeIds/,
    );
    expect(page, 'and it writes nothing').not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
  });
});
