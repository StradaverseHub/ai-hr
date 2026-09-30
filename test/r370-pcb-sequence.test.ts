/**
 * r370 / item db1e7b9d — THE PCB / MTD CALCULATION DETAIL IS ONE DOCUMENT IN TEN NUMBERED SEQUENCES,
 * AND THE SCREEN AND THE DOWNLOADED PDF ARE THE SAME DOCUMENT.
 *
 * WHAT THE DEFECT ACTUALLY WAS. Nine of the reporter's ten sections already existed with his own headings
 * and already in his order (r361 / r362); thirty-one headings rendered. What did not exist was the
 * NUMBERING, the container for sequence 9 — its working was fourteen separate top-level cards — and one
 * ordered list. The screen's order was hand-placed JSX in `app/payroll/pcb-detail/pcb-detail-view.tsx`;
 * the document's was a run of `sections.push` calls in `app/payroll/pcb-detail/shared.ts`. Two independent
 * layouts of one document, and they had already drifted:
 *
 *   · `reliefsHeading`, `bracketHeading`, `priorHeading`, `additionalHeading` and `sourceHeading` were on
 *     the screen and absent from the PDF entirely;
 *   · `netHeading` and `yearHeading` were each emitted TWICE on the PDF, `pHeading` twice in a bonus month;
 *   · the currency note was on the screen only;
 *   · the payroll month printed as the stored `2026-06` on the PDF and as `June 2026` on the screen.
 *
 * The reporter's criteria 19 ("the PDF follows exactly the same sequence as the screen"), 20 ("the screen
 * and PDF display the same calculation values") and 21 ("no section is skipped, merged, or moved") were
 * all FALSE, and no test could see it because each surface was asserted against its own expectations.
 *
 * ⚠️ SO THIS FILE ASSERTS THE ORDER ONCE, OVER THE SHARED LIST, AND NOT TWICE OVER TWO SURFACES. That is
 * the whole point: two parallel expectations are what drifted. `pcbDetailLayout` in core/pcb-explain.ts is
 * the single ordered list of what this document contains, in what order, under which number; both surfaces
 * iterate it and switch EXHAUSTIVELY over its closed slot union. A section added, moved or renumbered moves
 * on both surfaces, and a slot neither has drawn fails `tsc` — the `never` in each default branch is
 * load-bearing, because `React.ReactNode` admits `undefined` and a plain fall-through would compile.
 *
 * ⚠️ AND IT IS A PRESENTATION ROUND. No figure changes: every assertion below is about an order, a number,
 * a caption or an absence. `core/pcb-explain.ts` still holds no arithmetic below its marker
 * (test/7f251381-pcb-lhdn-worksheet.test.ts) and `formulas.ts` still holds none at all
 * (test/pcb-detail.test.ts). This file needs no database for the same reason: the layout is a pure
 * function of a stamp.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pcbMonth } from '../localization/my/payroll';
import {
  PCB_CHILD_CATEGORIES,
  explainPcb,
  pcbChildSection,
  pcbClosingSections,
  pcbDetailLayout,
  pcbSlipSections,
  pcbWorksheet,
  type PcbChildHeadCount,
  type PcbDetailEntry,
  type PcbExplanation,
  type PcbReliefBreakdown,
  type PcbSlipCatalogueItem,
  type PcbWorksheetValue,
} from '../core/pcb-explain';
import { TP1_ITEMS, TP1_REBATES } from '../core/tax-relief';
import { monthYearLabel } from '../lib/month-name';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source with comments stripped. These files EXPLAIN at length what they refuse to do, and a guard that
 *  matched the explanation would pass on prose alone — twice in one day in this repo. */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const code = (rel: string) => strip(read(rel));

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const VIEW = 'app/payroll/pcb-detail/pcb-detail-view.tsx';
const SHARED = 'app/payroll/pcb-detail/shared.ts';
const EXPLAIN = 'core/pcb-explain.ts';

const CATALOGUE = TP1_ITEMS as readonly PcbSlipCatalogueItem[];
const REBATES = TP1_REBATES as readonly PcbSlipCatalogueItem[];

const CURRENT: PcbReliefBreakdown = {
  individual: 9000, spouse: 0, children: 6000, disabledIndividual: 0, disabledSpouse: 0, lp: 0, total: 15000,
};

/** One month of the ENGINE, with every limb alive so no two figures under test share a zero. A bonus is
 *  paid, so §D.2 runs and the P₂ / additional-remuneration legs exist — which is the month in which the
 *  document used to print `pHeading` twice. */
function richRun(): Extract<PcbExplanation, { kind: 'mtd' }> {
  const r = pcbMonth({
    monthlyWage: 14000,
    epfMonthly: 1540,
    month: 7,
    profile: { category: 2, children: 3 },
    acc: { netRemuneration: 63000, epfClaimed: 800, pcbPaid: 4100, zakatPaid: 250, lpAccumulated: 480 },
    additional: 26000,
    epfOnAdditional: 600,
    lpCurrent: 90,
    zakatCurrent: 60,
  });
  const x = explainPcb(
    { pcb: r.total, pcbBonus: r.additional, epfEmployee: 1540, zakat: 60, lp: 570, pcbMeta: r.snapshot },
    CURRENT,
  );
  if (x.kind !== 'mtd') throw new Error('unreachable — a resident month is an MTD month');
  return x;
}

/** The layout for a payslip that has everything, which is the case the reporter's criteria are about. */
function fullLayout(headCount: PcbChildHeadCount | null = { count: 2, source: 'grid' }): PcbDetailEntry[] {
  const x = richRun();
  return pcbDetailLayout({
    explanation: x,
    worksheet: pcbWorksheet(x, null),
    slip: pcbSlipSections(x, {
      profile: { mode: 'auto_table', table: { under_18: { full: 2, half: 0 } }, disabledIndividual: false, disabledSpouse: false },
      childHeadCount: headCount,
      catalogue: CATALOGUE,
      rebateCatalogue: REBATES,
      currentDeduction: null,
      accumulatedDeduction: null,
      previousDeduction: null,
      currentRebate: null,
      accumulatedRebate: null,
      accumulatedRemuneration: null,
    }),
    closing: pcbClosingSections(x),
  });
}

const labelsOf = (l: PcbDetailEntry[], band: string) =>
  l.filter((e) => e.band === band).flatMap((e) => (e.label == null ? [] : [e.label]));

// ─────────────────────── (a) exactly ten numbered sequences, in the reporter's order ───────────────────────

describe('r370 — the detail is ten numbered sequences, and the numbers are in the list', () => {
  it('criteria 1 to 11: exactly ten sequences, numbered 1 to 10, in the order the reporter set out', () => {
    const l = fullLayout();
    expect(labelsOf(l, 'sequence'), 'ten, in order, with nothing missing and nothing extra').toEqual([
      '1', '2', '3', '4', '5', '6', '7', '8', '9', '10',
    ]);
    // …and each number is against the heading the reporter named it by. Pinned as PAIRS, because ten
    // numbers in ascending order says nothing about which section carries which.
    expect(l.filter((e) => e.band === 'sequence').map((e) => [e.label, e.heading])).toEqual([
      ['1', 'identificationHeading'],
      ['2', 'slipChildHeading'],
      ['3', 'slipAccHeading'],
      ['4', 'slipPrevDeductionHeading'],
      ['5', 'slipCurrentHeading'],
      ['6', 'slipAdditionalRemHeading'],
      ['7', 'slipCurrentDeductionHeading'],
      ['8', 'slipRebateHeading'],
      ['9', 'mtdCalculationHeading'],
      ['10', 'slipResultHeading'],
    ]);
  });

  it('criterion 12: sequence 9 is ONE section, and its working is numbered 9.1 to 9.9 beneath it', () => {
    const l = fullLayout();
    expect(labelsOf(l, 'step'), 'nine sub-steps, in the specification’s own order').toEqual([
      '9.1', '9.2', '9.3', '9.4', '9.5', '9.6', '9.7', '9.8', '9.9',
    ]);
    /**
     * THE ORDER IS THE BOARD'S, NOT THE ORDER THIS SCREEN GREW IN. Its worked examples (printed pp. 44-46
     * of docs/forms/pcb-spec-2026-computerised-calculation.pdf — printed page = PDF page minus one) run:
     * [A] category → [B] chargeable income, inside which "Firstly determine value K2" precedes the P
     * substitution → [C] the monthly deduction, with M, R and B read off Table 1 once P is known → [D] the
     * net deduction → [E] the year's total → Steps 2 to 5 for additional remuneration. Tax relief and the
     * remuneration legs used to sit BELOW the P formula that consumes them, and the calculation summary
     * above everything; both moved.
     */
    const steps = l.filter((e) => e.band === 'step').map((e) => [e.label, e.heading]);
    expect(steps).toEqual([
      ['9.1', 'stepAHeading'],
      ['9.2', 'reliefsHeading'],
      ['9.3', 'k2Heading'],
      ['9.4', 'pHeading'],
      ['9.5', 'formulaHeading'],
      // The agency's [C] covers four of our boxes — the formula, the Table 1 row, the accumulators it
      // subtracts and §E's floors. A continuation carries NO number: repeating "9.5" over four consecutive
      // cards would defeat the one thing the numbering is for, which is being able to point at a step.
      [null, 'bracketHeading'],
      [null, 'priorHeading'],
      [null, 'floorHeading'],
      ['9.6', 'netHeading'],
      [null, 'summaryHeading'],
      ['9.7', 'yearHeading'],
      ['9.8', 'additionalHeading'],
      ['9.9', 'stepsHeading'],
      // The agency prints its own two numbered items UNDER its "MTD CALCULATION" heading, so they are the
      // closing steps of sequence 9 and not sections of their own.
      [null, 'slipStep1Heading'],
      [null, 'slipStep2Heading'],
    ]);
    // FOURTEEN TOP-LEVEL CARDS BECAME FIFTEEN UNDER ONE HEADING. The extra one is 9.3, which is the
    // remuneration legs lifted out of the P card so that K₂ has the numbered place the reporter asked for.
    expect(steps.length, 'every card of the old working is still there, under sequence 9').toBe(15);
  });

  it('criterion 21: the numbered run is contiguous, and every section outside it says what it is', () => {
    const l = fullLayout();
    const bands = l.map((e) => e.band);
    // The numbered run — sequences and their steps — is ONE unbroken stretch. A card or an appendix inside
    // it is what put the reporter's sequence 2 in eighth place on the page.
    const first = bands.findIndex((b) => b === 'sequence' || b === 'step');
    const last = bands.length - 1 - [...bands].reverse().findIndex((b) => b === 'sequence' || b === 'step');
    for (let i = first; i <= last; i += 1) {
      expect(['sequence', 'step'], `entry ${i} (${l[i].heading}) interrupts the numbered run`).toContain(bands[i]);
    }
    // LHDN's own worksheet order becomes an unnumbered APPENDIX at the foot. It used to be the second thing
    // on the page — seven headings between the reporter's sequences 1 and 2 — and every figure on it
    // appears again in the numbered run, which is why it moved rather than being deleted.
    const appendix = l.filter((e) => e.band === 'appendix');
    expect(appendix.map((e) => e.heading)).toEqual(['worksheetHeading']);
    expect(appendix[0].label, 'an appendix carries no sequence number').toBeNull();
    // …and "Calculation source" becomes an unnumbered FOOTER: it is provenance for the page, not a step.
    const footer = l.filter((e) => e.band === 'footer');
    expect(footer.map((e) => e.heading)).toEqual(['sourceHeading']);
    expect(footer[0].label).toBeNull();
    expect(l[l.length - 1].heading, 'the footer is last on both surfaces').toBe('sourceHeading');
    expect(l[l.length - 2].heading, 'and the appendix immediately above it').toBe('worksheetHeading');
  });

  it('no heading is printed twice — which is the PDF defect, stated as a property of the list', () => {
    // The document emitted `Step 1 [D]` and `Step 1 [E]` twice each, and `Step 1 [B]` twice in a bonus
    // month, because it pushed one section per formula block AND a second section for the rows beside it.
    // The fixture PAYS A BONUS, so `fb.p2` exists and the old duplication would be live.
    const headings = fullLayout().map((e) => e.heading);
    const seen = new Map<string, number>();
    for (const h of headings) seen.set(h, (seen.get(h) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1), 'a heading appearing twice is a section printed twice').toEqual([]);
  });

  it('a payslip with no recorded working, and a flat-rate payee, are not handed a run of ten', () => {
    // Three bands of "not recorded" would assert a monthly MTD calculation exists and merely went unsaved.
    const bare = explainPcb({ pcb: 402.65, epfEmployee: 0, zakat: 15 }, CURRENT);
    const l = pcbDetailLayout({ explanation: bare, worksheet: pcbWorksheet(bare, null), slip: [], closing: [] });
    expect(labelsOf(l, 'sequence'), 'only the section it actually has').toEqual(['1']);
    expect(l.filter((e) => e.band === 'step'), 'and no working to number').toEqual([]);
    expect(l.filter((e) => e.band === 'card').map((e) => e.heading)).toContain('summaryHeading');
  });
});

// ──────────── (b) the load-bearing property: ONE list, and both surfaces iterate it ────────────

describe('r370 — the screen and the PDF cannot disagree about which sections there are or in what order', () => {
  it('both surfaces iterate `pcbDetailLayout`, over the same four members, and neither owns an order', () => {
    const view = code(VIEW);
    const shared = code(SHARED);
    expect(view, 'the screen builds the list from its own props').toContain(
      'pcbDetailLayout({ explanation, worksheet, slip, closing })',
    );
    expect(shared, 'and the document from the identical members of the model').toMatch(
      /pcbDetailLayout\(\{\s*explanation: model\.explanation,\s*worksheet: model\.worksheet,\s*slip: model\.slip,\s*closing: model\.closing,\s*\}\)/,
    );
    // ⚠️ AND THE DOCUMENT HAS EXACTLY ONE PLACE THAT APPENDS A SECTION. The defect was a run of eleven
    // `sections.push` calls whose order was the document's layout; one push inside one loop over the shared
    // list is what makes "the PDF follows exactly the same sequence as the screen" structural.
    expect(
      (shared.match(/sections\.push\(/g) ?? []).length,
      'a second push is a second ordering in prospect',
    ).toBe(1);
    expect((shared.match(/for \(const e of layout\)/g) ?? []).length, 'one loop over the list').toBe(1);
    expect((view.match(/layout\.map\(/g) ?? []).length, 'and one map over it').toBe(1);
  });

  it('every slot in the closed union is drawn by BOTH surfaces — no slot reaches one and not the other', () => {
    /**
     * THE COMPILE-TIME HALF OF THIS IS THE `never` IN EACH DEFAULT BRANCH, and it is why that line exists:
     * `React.ReactNode` admits `undefined`, so a `switch` on a closed union that simply fell through would
     * COMPILE and silently draw nothing. What is asserted HERE is that the two switches cover the SAME set
     * and that the set is the union core declares — a slot drawn on the screen and quietly absent from the
     * paper is the exact shape of the defect this round fixes, and it must fail here even if some future
     * `default: return null` ever hid the type error.
     */
    const union = (() => {
      const src = code(EXPLAIN);
      const at = src.indexOf('export type PcbDetailBodySlot');
      expect(at, 'the slot union').toBeGreaterThan(-1);
      const decl = src.slice(at, src.indexOf(';', at));
      return new Set([...decl.matchAll(/'([A-Za-z0-9]+)'/g)].map((m) => m[1]));
    })();
    expect(union.size, 'the union is not empty').toBeGreaterThan(15);
    const drawn = (rel: string) => new Set([...code(rel).matchAll(/case '([A-Za-z0-9]+)':/g)].map((m) => m[1]));
    const onScreen = drawn(VIEW);
    const onPaper = drawn(SHARED);
    for (const slot of union) {
      expect(onScreen, `${VIEW} does not draw ${slot}`).toContain(slot);
      expect(onPaper, `${SHARED} does not draw ${slot}`).toContain(slot);
    }
    // …and the `never` guard itself, in both files, because it is what makes an addition fail to build.
    for (const rel of [VIEW, SHARED]) {
      expect(code(rel), `${rel} must fail to compile on an undrawn slot`).toContain('const unhandled: never = slot');
    }
  });

  it('the payroll month is named by ONE formatter, so the two documents spell it the same way', () => {
    // The PDF printed the stored `2026-06` in its masthead and its section 1 where the screen printed
    // `June 2026`, for the same payslip. Criterion 20 is that the two show the same values.
    expect(monthYearLabel('2026-06', 'en')).toBe('June 2026');
    expect(monthYearLabel('2026-06', 'ms')).toBe('Jun 2026');
    // An unreadable period is returned AS STORED, never as "Invalid Date" and never as a guessed month.
    expect(monthYearLabel('2026-13', 'en')).toBe('2026-13');
    expect(monthYearLabel('', 'en')).toBe('');
    expect(monthYearLabel(null, 'en')).toBe('');
    for (const rel of ['app/payroll/pcb-detail/page.tsx', SHARED]) {
      expect(code(rel), `${rel} must use the shared formatter`).toContain('monthYearLabel(');
      expect(code(rel), `${rel} must not mint a second one`).not.toContain("month: 'long', year: 'numeric'");
    }
    // The document resolves it in the language the document is issued in, not the reader's UI locale:
    // `slip-pdf.ts` embeds Helvetica and cannot print the other four.
    expect(code(SHARED), 'the document’s own allowlisted language').toContain('monthYearLabel(row.payPeriod, lang)');
  });

  it('the five sections the PDF used to drop are in the list, so both surfaces carry them', () => {
    const headings = fullLayout().map((e) => e.heading);
    for (const h of ['reliefsHeading', 'bracketHeading', 'priorHeading', 'additionalHeading', 'sourceHeading']) {
      expect(headings, `${h} was on the screen and absent from the PDF`).toContain(h);
    }
    // The currency note travelled with [D] on the screen only. It is not a section, so it is pinned where
    // it is emitted: the document's own [D] body.
    const netBody = code(SHARED).slice(code(SHARED).indexOf("case 'mtdNet':"), code(SHARED).indexOf("case 'mtdSummary':"));
    expect(netBody, 'the unit is stated once on the paper too').toContain("t('currencyNote'");
  });
});

// ─────────── (c) sequence 2: the count and the weighted figure are two numbers, labelled as two ───────────

describe('r370 — sequence 2 shows how many children are on record AND the weighted C, never one for the other', () => {
  const childValue = (headCount: PcbChildHeadCount | null, caption: string): PcbWorksheetValue | undefined =>
    pcbChildSection(
      { mode: 'auto_table', table: { under_18: { full: 1, half: 0 }, disabled_study: { full: 1, half: 0 } }, disabledIndividual: false, disabledSpouse: false },
      { kind: 'money', amount: 18000 },
      { kind: 'count', count: 9 },
      { kind: 'money', amount: 2000 },
      headCount,
    ).rows.find((r) => r.caption === caption)?.first;

  it('the head count and C are different rows, different captions and different numbers', () => {
    /**
     * ⚠️ THE TRAP THIS PRODUCT HAS ALREADY FALLEN INTO. LHDN's specification defines "Q  Deduction for
     * qualifying children" and "C  Number of qualifying children" (printed p.10), and decides C on printed
     * p.27 under "Relief to be given AS IF THE EMPLOYEE HAS THIS NUMBER OF CHILDREN" — 1 / 1 / 4 / 4 / 8.
     * So the agency's own C is WEIGHTED: one child under 18 plus one disabled child in tertiary study is
     * two children and a C of NINE, which is exactly what the reporter's specimen prints (C = 9.00 beside a
     * grid of 1 and 1). r359 printed the weighted figure where a form meant the head count, on the EA, and
     * the reporter caught it; r364 fixed the EA and expressly protected this slip's Q and C, which were
     * right. Both numbers are legitimate here — the section the agency titles "Category of number of
     * children / qualification rate" is a count AND a rate — so both are printed, and the only thing that
     * makes that safe is that the captions cannot be read as each other.
     */
    const sec = pcbChildSection(
      { mode: 'auto_table', table: { under_18: { full: 1, half: 0 }, disabled_study: { full: 1, half: 0 } }, disabledIndividual: false, disabledSpouse: false },
      { kind: 'money', amount: 18000 },
      { kind: 'count', count: 9 },
      { kind: 'money', amount: 2000 },
      { count: 2, source: 'grid' },
    );
    const captions = sec.rows.map((r) => r.caption);
    expect(captions, 'the head count').toContain('slipChildOnRecordGrid');
    expect(captions, 'and the agency’s own C, still here').toContain('slipChildCount');
    // The head count is read FIRST: a reader meets the plain number of children before the weighted one.
    expect(captions.indexOf('slipChildOnRecordGrid')).toBeLessThan(captions.indexOf('slipChildCount'));
    expect(sec.rows.find((r) => r.caption === 'slipChildOnRecordGrid')?.first).toEqual({ kind: 'count', count: 2 });
    expect(sec.rows.find((r) => r.caption === 'slipChildCount')?.first).toEqual({ kind: 'count', count: 9 });
    // The head count carries NO agency line marker: it is not one of the specification's letters, and
    // putting a 'C' beside it is precisely how the two would be read as one number.
    expect(sec.rows.find((r) => r.caption === 'slipChildOnRecordGrid')?.line).toBe('');
    expect(sec.rows.find((r) => r.caption === 'slipChildCount')?.line).toBe('C');
    // …and the English captions must actually distinguish them, or the rows are two numbers under one idea.
    const en = (JSON.parse(read('messages/en.json')) as { payroll: { pcbDetail: Record<string, string> } }).payroll.pcbDetail;
    expect(en.slipChildOnRecordGrid.toLowerCase(), 'the head count says it is a record of children').toContain('on record');
    expect(en.slipChildCount.toLowerCase(), 'and C says it is weighted').toContain('weighted');
    expect(en.slipChildOnRecordGrid).not.toBe(en.slipChildCount);
  });

  it('a count that was never recorded says so, and never 0 — the r369 decision, on the new row', () => {
    // CLAUDE.md §8: an absent box asserts nothing; `0` asserts the employee has no children. A payslip
    // whose employee is set to the per-category grid but has never had one keyed is a real, reviewable
    // state (core/child-relief-review.ts), and so is an employment with no `employee_statutory_my` row.
    expect(childValue(null, 'slipChildOnRecordKeyed')).toEqual({ kind: 'notRecorded' });
    // …and the caption still says which record was consulted, so the absence is about a named record.
    expect(childValue({ count: 2, source: 'keyed' }, 'slipChildOnRecordKeyed')).toEqual({ kind: 'count', count: 2 });
    expect(childValue({ count: 2, source: 'grid' }, 'slipChildOnRecordKeyed')).toBeUndefined();
    const en = (JSON.parse(read('messages/en.json')) as { payroll: { pcbDetail: Record<string, string> } }).payroll.pcbDetail;
    expect(en.slipChildOnRecordKeyed.toLowerCase(), 'the keyed caption names the single total').toContain('single total');
    expect(en.slipChildOnRecordGrid.toLowerCase(), 'the grid caption names the five categories').toContain('categories');
  });

  it('the SUM lives in the read layer, because core/ holds no arithmetic', () => {
    // core/pcb-explain.ts must not be able to produce a figure — test/7f251381 refuses an operator below
    // its marker — so the grid is added up beside the other sum on this surface, `priorRemuneration`.
    const reads = code('app/payroll/pcb-detail/slip-data.ts');
    expect(reads, 'the head count is computed in the read layer').toContain('function childHeadCountOf');
    expect(reads, 'and reads the keyed total for a manual employee').toContain('employeeStatutoryMy.numChildren');
    expect(code(EXPLAIN), 'core only carries the shape').toContain('export type PcbChildHeadCount');
    // The five categories the grid is keyed by are the taxonomy core declares; the read must not restate it.
    expect(reads, 'the taxonomy is read, not re-transcribed').toContain('PCB_CHILD_CATEGORIES');
    expect(PCB_CHILD_CATEGORIES.map((c) => c.key)).toEqual([
      'under_18', 'study_preu', 'study_tertiary', 'disabled', 'disabled_study',
    ]);
  });

  it('the Q caption names the product it holds, which is QC and not Q', () => {
    // `pcbDetail.reliefChildren` renders `explanation.reliefs.children` — the relief that was actually
    // netted off P, i.e. Q × C — and was captioned "Q — child relief". r359 corrected this vocabulary
    // everywhere except here. The surrounding rows already say `Q × C`: `worksheetQc` and
    // `slipChildReliefTotal` both do.
    for (const loc of LOCALES) {
      const blk = (JSON.parse(read(`messages/${loc}.json`)) as {
        payroll: { pcbDetail: Record<string, string> };
      }).payroll.pcbDetail;
      expect(blk.reliefChildren, `${loc}.reliefChildren must name the product, not Q`).toContain('QC');
      expect(blk.reliefChildren, `${loc}.reliefChildren must show the two factors`).toContain('Q × C');
      // And the two captions for the WEIGHTED figure must not read as a plain head count any more.
      for (const k of ['reliefChildCount', 'slipChildCount', 'worksheetC'] as const) {
        expect(blk[k], `${loc}.${k}`).toBeTruthy();
        expect(blk[k], `${loc}.${k} must not take an ICU argument`).not.toMatch(/[{}]/);
      }
    }
  });

  it('r369 still holds: both screen rows and the PDF row guard the FIELD, not the trace', () => {
    // The rows moved (9.1 and 9.2 now), and the guard is the pin on exactly the confusion this round works
    // next to. test/r369-pcb-child-count-null.test.ts counts TWO screen sites; that count is re-asserted
    // here so a body moved into the new switch cannot quietly drop one.
    const view = code(VIEW);
    expect((view.match(/trace\?\.childCount\s*!=\s*null/g) ?? []).length, 'both screen rows').toBe(2);
    expect(code(SHARED), 'and the PDF, which printed the literal "null"').toContain('trace?.childCount != null');
  });
});

// ─────────────────────── (d) the new captions, in all six catalogues ───────────────────────

describe('r370 — every caption the layout resolves exists in all six catalogues', () => {
  /** The keys the LAYOUT names. They are computed `t()` keys — invisible to the i18n coverage scan — and
   *  they are not reached by the `worksheet*` or `slip*` sweeps in the two older suites. */
  const KEYS = [
    'mtdCalculationHeading', 'k2Heading', 'traceNotRecordedHeading', 'appendixLabel',
    'slipChildOnRecordGrid', 'slipChildOnRecordKeyed',
  ];

  it('the list above is exhaustive — every heading the layout can emit is in the catalogue', () => {
    // Derived back out of the layout rather than trusted: a heading added to `pcbDetailLayout` and
    // forgotten here would ship untranslated in five languages, because i18n/request.ts deep-merges each
    // locale over English and a MISSING key renders as fluent English rather than as MISSING_MESSAGE.
    const x = richRun();
    const emitted = new Set(
      pcbDetailLayout({
        explanation: x, worksheet: pcbWorksheet(x, null), slip: [], closing: pcbClosingSections(x),
      }).map((e) => e.heading),
    );
    const en = (JSON.parse(read('messages/en.json')) as { payroll: { pcbDetail: Record<string, string> } }).payroll.pcbDetail;
    for (const k of emitted) expect(en[k], `payroll.pcbDetail.${k} — a heading the layout emits`).toBeTruthy();
    for (const k of KEYS) expect(en[k], `payroll.pcbDetail.${k}`).toBeTruthy();
  });

  it('all six carry them, with no ICU argument, and none is the English string left in place', () => {
    const en = (JSON.parse(read('messages/en.json')) as { payroll: { pcbDetail: Record<string, string> } }).payroll.pcbDetail;
    for (const loc of LOCALES) {
      const blk = (JSON.parse(read(`messages/${loc}.json`)) as {
        payroll: { pcbDetail: Record<string, string> };
      }).payroll.pcbDetail;
      for (const k of KEYS) {
        expect(blk[k], `payroll.pcbDetail.${k} in ${loc}`).toBeTruthy();
        // A stray brace throws at render and paints the key path onto a tax document.
        expect(blk[k], `payroll.pcbDetail.${k} in ${loc} must take no ICU argument`).not.toMatch(/[{}]/);
        if (loc !== 'en') {
          expect(blk[k], `${loc}.${k} is still the English string`).not.toBe(en[k]);
        }
      }
    }
  });
});
