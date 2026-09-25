/**
 * Item ad7bc503 — THE PCB / MTD CALCULATION DETAIL, CARRYING ALL TEN SECTIONS OF THE REPORTER'S SLIP.
 *
 * WHAT THIS ITEM IS NOT. The reporter opened with "displaying only a summary PCB amount". That premise is
 * wrong and the approved plan says so at the top: sections 3, 9 and 10 have been on this screen since
 * 7f251381 (`test/7f251381-pcb-lhdn-worksheet.test.ts` pins them field by field) and section 1 needed
 * extra FIELDS, not a new section. So nothing here re-asserts the worksheet. What is under test is the
 * DETAIL THAT SAT BEHIND THE TOTALS — the children grid behind Q, the seventeen-line relief schedules
 * behind ΣLP and LP1, the component split behind Y1 and Yt, and the rebate lines behind Z1 — plus the
 * download.
 *
 * ⚠️ AND THE ONE THING THAT MATTERS MOST IS AN ABSENCE, WHICH IS WHY IT IS ASSERTED FIRST AND HARDEST.
 * CLAUDE.md §8: an absent box asserts nothing, 0.00 asserts the money does not exist. The reporter's
 * reference prints 0.00 down every unclaimed line because the employee filed the form and the answer
 * genuinely was nothing; our records are frequently not in that position. A schedule of seventeen zeroes
 * would state, on a tax document, that this employee claimed nothing in each category — and it would look
 * MORE finished and be MORE wrong than saying so. Every case below that names an absence also checks that
 * the cell is not a zero, because a builder that returned `{ kind: 'money', amount: 0 }` would satisfy a
 * "the row exists" assertion perfectly.
 *
 * ⚠️ THE CONTRACT IS BETWEEN TWO FILES, so it is checked on both sides (the plan asks for exactly this):
 * `core/pcb-explain.ts` must EMIT the absence kinds, and `app/payroll/pcb-detail/pcb-detail-view.tsx` plus
 * `app/payroll/pcb-detail/shared.ts` must RENDER each of them as its own sentence. A core that emits
 * `notRecorded` and a renderer that prints it as "0.00" is the same defect with a different address.
 *
 * NOTHING ABOUT ANY PAYSLIP CHANGES. Every figure is read; no arithmetic is introduced (the source guard
 * in 7f251381's file already refuses an operator anywhere below its marker, which is where this item's
 * builders live), nothing is written, and no domain event is appended.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pcbMonth } from '../localization/my/payroll';
import {
  PCB_CHILD_CATEGORIES,
  explainPcb,
  pcbBasisSection,
  pcbSlipSections,
  type PcbChildProfile,
  type PcbExplanation,
  type PcbReliefBreakdown,
  type PcbSlipCatalogueItem,
  type PcbSlipRow,
  type PcbSlipSection,
  type PcbSlipSide,
} from '../core/pcb-explain';
import {
  TP1_ITEMS,
  TP1_REBATES,
  approveTp1ForPerson,
  getTp1ByIdForPerson,
  submitTp1ForPerson,
  tp1CountForYear,
  TP1_COUNTABLE_COLUMNS,
  tp1CountableWhere,
} from '../core/tax-relief';
import { TP3_SECTION_D, saveTp3 } from '../core/tp3';
import { MY_RELIEFS } from '../localization/my/statutory-tables';
import { hireEmployee } from '../core/org';
import { setStatutoryProfileMY, setTaxProfileMY } from '../localization/my/statutory';
import { pcbSlipData } from '../app/payroll/pcb-detail/slip-data';
import { tp1Relief } from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Source with comments stripped: these files EXPLAIN at length what they refuse to do, and a guard that
 *  matched the explanation would pass on prose alone. */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const code = (rel: string) => strip(read(rel));

const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
const VIEW = 'app/payroll/pcb-detail/pcb-detail-view.tsx';
const PAGE = 'app/payroll/pcb-detail/page.tsx';
const SHARED = 'app/payroll/pcb-detail/shared.ts';
const ROUTE = 'app/payroll/pcb-detail/download/route.ts';
const PDF = 'app/payroll/pcb-detail/slip-pdf.ts';
const READS = 'app/payroll/pcb-detail/slip-data.ts';

const CURRENT: PcbReliefBreakdown = {
  individual: 9000, spouse: 0, children: 6000, disabledIndividual: 0, disabledSpouse: 0, lp: 0, total: 15000,
};

const CATALOGUE = TP1_ITEMS as readonly PcbSlipCatalogueItem[];
const REBATES = TP1_REBATES as readonly PcbSlipCatalogueItem[];

/** A month with every limb of the working alive, so no two figures under test share one zero. */
function richRun() {
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

const GRID: PcbChildProfile = {
  mode: 'auto_table',
  table: {
    under_18: { full: 2, half: 1 },
    study_preu: { full: 0, half: 0 },
    study_tertiary: { full: 1, half: 0 },
    disabled: { full: 0, half: 0 },
    disabled_study: { full: 0, half: 0 },
  },
  disabledIndividual: true,
  disabledSpouse: false,
};

type Sides = Parameters<typeof pcbSlipSections>[1];

const noSides: Sides = {
  profile: null,
  catalogue: CATALOGUE,
  rebateCatalogue: REBATES,
  currentDeduction: null,
  accumulatedDeduction: null,
  previousDeduction: null,
  currentRebate: null,
  accumulatedRebate: null,
};

const sections = (x: PcbExplanation, over: Partial<Sides> = {}) =>
  pcbSlipSections(x, { ...noSides, ...over });
const byHeading = (s: PcbSlipSection[], heading: string) => {
  const found = s.find((sec) => sec.heading === heading);
  expect(found, `the slip must carry a ${heading} section`).toBeTruthy();
  return found!;
};
const byCaption = (sec: PcbSlipSection, caption: string) => sec.rows.find((r) => r.caption === caption);
/** Every cell in a section, both columns, flattened — what a reader actually sees. */
const cells = (sec: PcbSlipSection) =>
  sec.rows.flatMap((r) => [r.first, ...(r.second ? [r.second] : [])]);

/** The assertion this whole item turns on, written once. */
const mustNotBeAZero = (row: PcbSlipRow, where: string) => {
  for (const v of [row.first, row.second]) {
    if (!v) continue;
    expect(
      v.kind === 'money' || v.kind === 'count',
      `${where} (${row.caption}): an unrecorded line must state that it is unrecorded, never print a figure`,
    ).toBe(false);
  }
};

/**
 * ⚠️ A STORED DECLARATION IN THE SHAPE THE REAL WRITERS ACTUALLY PERSIST — WHICH IS **DENSE** OVER THE
 * NUMBERED LINES AND **SPARSE** OVER THE LETTERED ONES.
 *
 * This helper exists because the first version of this file was green over fixtures neither writer can
 * produce. It wrote `{ items: { c4: {…} } }` — sixteen numbered lines simply absent — and every assertion
 * about an unrecorded line was therefore about a state that never reaches this screen. What both writers
 * actually do (`core/tp3.ts` `readGroup`, `core/tax-relief.ts` `validateCatalogueCategories.readGroup`) is
 * walk the WHOLE catalogue and write `out[def.code] = subItems ? { amount, subItems } : { amount }` for
 * EVERY def, with `validateAmount(undefined) === 0`, while writing a sub-line only `if (v > 0)`.
 *
 * So this mirrors those two loops exactly, and `the helper is the writer` below PROVES it does, by saving a
 * real declaration through `submitTp1ForPerson` and comparing what came back out of the database against
 * what this function produced from the same input. A fixture helper that drifted from the writer would put
 * this whole file back where it was.
 *
 * Input spelling follows test/tp1-2026-form.test.ts's `payload`: a bare number on an item with lettered
 * boxes lands in its FIRST box, because the server recomputes an item's amount from its boxes and ignores
 * any total a client sends.
 */
const writerShape = (
  declared: Record<string, number | Record<string, number>>,
  catalogue: readonly PcbSlipCatalogueItem[] = CATALOGUE,
): Record<string, { amount: number; subItems?: Record<string, number> }> => {
  const out: Record<string, { amount: number; subItems?: Record<string, number> }> = {};
  for (const def of catalogue) {
    const v = declared[def.code];
    if (def.subItems.length > 0) {
      const subs: Record<string, number> = {};
      let sum = 0;
      for (const sub of def.subItems) {
        const n =
          typeof v === 'number'
            ? sub.code === def.subItems[0].code
              ? v
              : 0
            : Number((v ?? {})[sub.code] ?? 0);
        if (n > 0) subs[sub.code] = n;
        sum += n;
      }
      out[def.code] = Object.keys(subs).length > 0 ? { amount: sum, subItems: subs } : { amount: sum };
    } else {
      out[def.code] = { amount: typeof v === 'number' ? v : 0 };
    }
  }
  return out;
};

/** …and the same shape as one side of the schedule, with the roll-up the server would have stored. */
const denseSide = (
  declared: Record<string, number | Record<string, number>>,
  catalogue: readonly PcbSlipCatalogueItem[] = CATALOGUE,
): PcbSlipSide => {
  const items = writerShape(declared, catalogue);
  return {
    attributed: true,
    amounts: { items },
    total: Object.values(items).reduce((n, e) => n + e.amount, 0),
  };
};

/**
 * THE INVARIANT THE ROUND'S CENTRAL §8 CONTRACT REDUCES TO, CHECKED OVER A WHOLE SECTION.
 *
 * A numbered line's amount IS the server's own sum of its lettered boxes, so the two can never disagree
 * about whether the line was recorded: a parent printing RM 0.00 above sub-lines reading "nothing was
 * recorded" is one document making two incompatible statements about the same money, and
 * `slipPdfProvenance` tells the reader that a line stating nothing was recorded is one NO DECLARATION WAS
 * CAPTURED FOR. This walks every numbered line of a section and requires its sub-lines to carry the SAME
 * kind of answer it does, in both columns.
 */
const assertFamiliesAgree = (sec: PcbSlipSection, catalogue: readonly PcbSlipCatalogueItem[], where: string) => {
  const find = (caption: string) => sec.rows.find((r) => r.caption === caption);
  for (const def of catalogue) {
    const parent = find(`items.${def.code}.label`) ?? find(`rebates.${def.code}.label`);
    expect(parent, `${where}: ${def.code.toUpperCase()} must have a numbered row`).toBeTruthy();
    for (const sub of def.subItems) {
      const child = find(`items.${def.code}.sub.${sub.code}`) ?? find(`rebates.${def.code}.sub.${sub.code}`);
      expect(child, `${where}: ${def.code.toUpperCase()}(${sub.code}) must have a row`).toBeTruthy();
      for (const col of ['first', 'second'] as const) {
        expect(
          child![col]?.kind,
          `${where}: ${def.code.toUpperCase()} reads "${parent![col]?.kind}" in the ${col} column while ` +
            `its own box (${sub.code}) reads "${child![col]?.kind}" — the parent amount IS the sum of ` +
            `those boxes, so one of the two sentences is false`,
        ).toBe(parent![col]?.kind);
      }
    }
  }
};

// ───────────────────────── (a) section 2 — the children grid behind Q ─────────────────────────

describe('ad7bc503 — the children grid, and the split that was never recorded', () => {
  it('reports each category at the full and the half rate, from the stored grid', () => {
    const x = richRun();
    const sec = byHeading(sections(x, { profile: GRID }), 'slipChildHeading');
    // THE ROW COUNT THE FORM IS RULED FOR (CLAUDE.md §8): five categories, and five is the taxonomy's own
    // length rather than a literal typed twice.
    expect(PCB_CHILD_CATEGORIES.length).toBe(5);
    for (const c of PCB_CHILD_CATEGORIES) {
      expect(sec.rows.some((r) => r.caption === c.caption), `${c.key} has a row`).toBe(true);
    }
    expect(byCaption(sec, 'slipChildUnder18')!.first).toEqual({ kind: 'count', count: 2 });
    expect(byCaption(sec, 'slipChildUnder18')!.second).toEqual({ kind: 'count', count: 1 });
    expect(byCaption(sec, 'slipChildStudyTertiary')!.first).toEqual({ kind: 'count', count: 1 });
    // Q and C are the figures the RUN applied, not a re-derivation from the grid: two children at the
    // full rate plus one at half is not what this section may compute, and the screen must not try.
    expect(byCaption(sec, 'slipChildRelief')!.first).toEqual({ kind: 'money', amount: x.reliefs.children });
    expect(byCaption(sec, 'slipChildCount')!.first).toEqual({ kind: 'count', count: x.trace!.childCount });
    expect(byCaption(sec, 'slipDisabledIndividual')!.first).toEqual({ kind: 'caption', caption: 'slipYes' });
    expect(byCaption(sec, 'slipDisabledSpouse')!.first).toEqual({ kind: 'caption', caption: 'slipNo' });
  });

  it('a MANUAL employee gets "not recorded" per category — never five zeroes', () => {
    // The reporter's own reference prints a count in every category. A manual employee has ONE keyed
    // total and no split at all; five zeroes would assert HR entered zero in each, which is a statement
    // about a tax position nobody took.
    const x = richRun();
    const sec = byHeading(
      sections(x, { profile: { ...GRID, mode: 'manual' } }),
      'slipChildHeading',
    );
    for (const c of PCB_CHILD_CATEGORIES) {
      const row = byCaption(sec, c.caption)!;
      expect(row.first, `${c.key} at the full rate`).toEqual({ kind: 'notRecorded' });
      expect(row.second, `${c.key} at the half rate`).toEqual({ kind: 'notRecorded' });
      mustNotBeAZero(row, 'manual mode');
    }
    // …and the note says WHICH of the two the reader is looking at. A silent difference between the two
    // renderings is how a manual employee's screen reads as a completed grid.
    expect(sec.note).toBe('slipChildNoteManual');
    expect(byHeading(sections(x, { profile: GRID }), 'slipChildHeading').note).toBe('slipChildNoteTable');
  });

  it('no statutory row at all is "not recorded", and NOT a row of Nos', () => {
    // An employment with no `employee_statutory_my` row is a real state. `false` for "disabled
    // individual" is an answer; an absent row is not, and printing "No" would invent one.
    const sec = byHeading(sections(richRun(), { profile: null }), 'slipChildHeading');
    expect(byCaption(sec, 'slipDisabledIndividual')!.first).toEqual({ kind: 'notRecorded' });
    expect(byCaption(sec, 'slipDisabledSpouse')!.first).toEqual({ kind: 'notRecorded' });
  });
});

// ──────────────── (b) sections 5 and 6 — a split payroll does not persist, said plainly ────────────────

describe('ad7bc503 — the component split payroll never stored', () => {
  it('shows the combined figure the engine charged, and says the components were not stored apart', () => {
    // THE FACT THIS SECTION'S SCOPE TURNS ON, asserted rather than assumed: `pcbMonth` is handed ONE
    // monthly wage and ONE additional figure, so Y1 and Yt are all that exists. Inventing "gross salary
    // 12,000 / benefits-in-kind 2,000" out of a single 14,000 would put amounts nobody recorded on a tax
    // document — which is the one thing this screen exists to stop doing.
    const x = richRun();
    const s = sections(x);
    const cur = byHeading(s, 'slipCurrentHeading');
    expect(byCaption(cur, 'slipCurrentTotal')!.first).toEqual({ kind: 'money', amount: x.trace!.Y1 });
    expect(byCaption(cur, 'slipCurrentEpf')!.first).toEqual({ kind: 'money', amount: x.trace!.K1 });
    for (const caption of [
      'slipCompGrossSalary',
      'slipCompFeesCommission',
      'slipCompTipsAwards',
      'slipCompBenefitsInKind',
      'slipCompLivingAccommodation',
    ]) {
      const row = byCaption(cur, caption)!;
      expect(row.first, caption).toEqual({ kind: 'notSeparatelyRecorded' });
      mustNotBeAZero(row, 'current remuneration');
    }

    const add = byHeading(s, 'slipAdditionalRemHeading');
    expect(byCaption(add, 'slipAdditionalTotal')!.first).toEqual({ kind: 'money', amount: x.trace!.Yt });
    expect(byCaption(add, 'slipAdditionalEpf')!.first).toEqual({ kind: 'money', amount: x.trace!.Kt });
    for (const caption of [
      'slipAddBonus',
      'slipAddArrears',
      'slipAddCommission',
      'slipAddGratuity',
      'slipAddCompensation',
      'slipAddDirectorFee',
      'slipAddTaxBorne',
      'slipAddOther',
    ]) {
      const row = byCaption(add, caption)!;
      expect(row.first, caption).toEqual({ kind: 'notSeparatelyRecorded' });
      mustNotBeAZero(row, 'additional remuneration');
    }
  });

  it('a run with no recorded working says so on the combined lines too', () => {
    // A payslip predating 45df860a has no trace. The combined figure is then unavailable as well, and it
    // must not fall back to zero: the components read "recorded only in combination" and the total reads
    // "not recorded", which are two true and different sentences.
    const x = explainPcb(
      {
        pcb: 402.65,
        epfEmployee: 0,
        pcbMeta: {
          month: 1, n: 11, ytdNet: 1234.5, epfClaimed: 200, pcbPaid: 90, P1: 75956.07,
          reliefs: CURRENT,
        },
      },
      CURRENT,
    );
    if (x.kind !== 'mtd') throw new Error('unreachable');
    expect(x.trace, 'the premise: this run recorded no working').toBeNull();
    const cur = byHeading(sections(x), 'slipCurrentHeading');
    expect(byCaption(cur, 'slipCurrentTotal')!.first).toEqual({ kind: 'notRecorded' });
    expect(byCaption(cur, 'slipAdditionalTotal' as string)).toBeUndefined();
    const add = byHeading(sections(x), 'slipAdditionalRemHeading');
    expect(byCaption(add, 'slipAdditionalTotal')!.first).toEqual({ kind: 'notRecorded' });
  });
});

// ────────── (c) sections 4, 7 and 8 — the seventeen-line schedule, and the absences in it ──────────

describe('ad7bc503 — the relief schedules, itemised', () => {
  /** Item lines plus every lettered sub-line: the row count the agency's own schedule is ruled for. */
  const RULED_ROWS = CATALOGUE.length + CATALOGUE.reduce((n, d) => n + d.subItems.length, 0);

  it('draws every numbered line and every lettered sub-line of the agency schedule', () => {
    const x = richRun();
    // The declaration as the SERVER stores it: C4(a) 900 and C4(c) 300 keyed, C14 350 keyed, every other
    // line of the catalogue written as the zero the employee left in it.
    const side = denseSide({ c4: { a: 900, c: 300 }, c14: 350 });
    expect(side.total, "the roll-up is the server's own sum of the lines").toBe(1550);
    const sec = byHeading(sections(x, { currentDeduction: side }), 'slipCurrentDeductionHeading');
    expect(RULED_ROWS).toBe(41); // 17 numbered lines + 24 lettered boxes on TP1 (1/2026)
    // …plus the roll-up line the section ends on.
    expect(sec.rows.length).toBe(RULED_ROWS + 1);
    expect(sec.rows.filter((r) => r.sub).length).toBe(24);
    // The line markers and captions come from the CATALOGUE, so the form and the screen cannot drift.
    expect(sec.rows[0].line).toBe('C1');
    expect(sec.rows[0].caption).toBe('items.c1.label');
    expect(sec.rows[0].ns).toBe('taxRelief');
    expect(sec.rows[1]).toMatchObject({ line: 'a', caption: 'items.c1.sub.a', sub: true });
    // A group limit rides on the item line; a "(Limited RM…)" sub-line carries its own.
    expect(byCaption(sec, 'items.c4.label')!.limit).toBe(10000);
    expect(byCaption(sec, 'items.c4.sub.c')!.limit).toBe(1000);
    // C16 gives each house-price band its OWN limit and no group limit — `perSubLimit`, not a group.
    expect(byCaption(sec, 'items.c16.label')!.limit).toBeNull();
    expect(byCaption(sec, 'items.c16.sub.a')!.limit).toBe(7000);
    // The declared figures, read straight through.
    expect(byCaption(sec, 'items.c4.label')!.first).toEqual({ kind: 'money', amount: 1200 });
    expect(byCaption(sec, 'items.c4.sub.a')!.first).toEqual({ kind: 'money', amount: 900 });
    expect(byCaption(sec, 'slipDeductionTotal')!.first).toEqual({ kind: 'money', amount: 1550 });
  });

  it('THE HEART OF THE ITEM — a captured declaration prints figures; an uncaptured line prints none', () => {
    // ⚠️ THE DISTINCTION IS PER **DECLARATION**, NOT PER BOX, AND THAT IS WHAT THE FIRST BUILD GOT WRONG.
    // A stored declaration is DENSE over the numbered lines: the employee was shown all seventeen and the
    // server wrote a zero into each one they left blank, so those zeroes ARE the recorded answer and the
    // reporter's reference prints them as 0.00 for exactly that reason. The line the plan promises will not
    // print a zero is the line NO DECLARATION WAS CAPTURED FOR — and `slipPdfProvenance` says so to the
    // reader in as many words, which is why "nothing was recorded" may not appear inside a captured form.
    const side = denseSide({ c4: { a: 900, c: 300 } });
    const sec = byHeading(sections(richRun(), { currentDeduction: side }), 'slipCurrentDeductionHeading');
    // C4 was claimed; C9 and C17 were offered and left empty; C4(b) is a box of a line that WAS filled.
    expect(byCaption(sec, 'items.c4.label')!.first).toEqual({ kind: 'money', amount: 1200 });
    expect(byCaption(sec, 'items.c4.sub.a')!.first).toEqual({ kind: 'money', amount: 900 });
    for (const caption of ['items.c4.sub.b', 'items.c9.label', 'items.c17.label']) {
      expect(byCaption(sec, caption)!.first, caption).toEqual({ kind: 'money', amount: 0 });
    }
    // …and NOTHING in the populated column says "nothing was recorded", because a declaration WAS captured.
    // (The Accumulated column is not populated by this fixture and correctly reads as an absence.)
    for (const row of sec.rows) {
      expect(row.first.kind, `a captured declaration has no unrecorded line (${row.caption})`).not.toBe('notRecorded');
    }
    // …and no numbered line ever disagrees with its own boxes. This is the assertion the round turns on.
    assertFamiliesAgree(sec, CATALOGUE, 'a captured declaration');

    // THE OTHER DIRECTION, which is the one the plan promises in writing: a side that carries NO entry for
    // a line says nothing about it, on the line AND on every box under it — never a zero. Reachable in
    // production for a payload stored before a line joined the schedule, and for the whole side when no
    // declaration exists at all (the case below).
    const partial: PcbSlipSide = { attributed: true, amounts: { items: { c4: { amount: 900, subItems: { a: 900 } } } }, total: 900 };
    const gaps = byHeading(sections(richRun(), { currentDeduction: partial }), 'slipCurrentDeductionHeading');
    for (const caption of ['items.c9.label', 'items.c17.label', 'items.c1.sub.a']) {
      const row = byCaption(gaps, caption)!;
      expect(row.first, caption).toEqual({ kind: 'notRecorded' });
      mustNotBeAZero(row, 'a line the side carries no entry for');
    }
    assertFamiliesAgree(gaps, CATALOGUE, 'a side with gaps');
  });

  it('no declaration at all is "not recorded" on every line, including the total', () => {
    const sec = byHeading(sections(richRun()), 'slipCurrentDeductionHeading');
    for (const row of sec.rows) {
      expect(row.first.kind, row.caption).toBe('notRecorded');
      mustNotBeAZero(row, 'no declaration');
    }
    // And the previous-employment schedule, likewise, when no TP3 Section D was captured for the year.
    const prev = byHeading(sections(richRun()), 'slipPrevDeductionHeading');
    for (const row of prev.rows) expect(row.first.kind, row.caption).toBe('notRecorded');
  });

  it('a LEGACY declaration reads "recorded only in combination", which is not the same as unrecorded', () => {
    // `core/tax-relief.ts` states it: a pre-catalogue eight-key row's money is real, counts in the total,
    // and "there is no honest way to split" it across C1–C17. Reporting it as `notRecorded` would deny
    // money the payroll actually relieved; reporting it as zeroes would deny it twice.
    const legacy: PcbSlipSide = { attributed: false, amounts: null, total: 9000 };
    const sec = byHeading(sections(richRun(), { currentDeduction: legacy }), 'slipCurrentDeductionHeading');
    expect(byCaption(sec, 'items.c1.label')!.first).toEqual({ kind: 'notSeparatelyRecorded' });
    expect(byCaption(sec, 'items.c1.sub.a')!.first).toEqual({ kind: 'notSeparatelyRecorded' });
    // …while the authoritative roll-up IS a figure, because that figure is what was relieved.
    expect(byCaption(sec, 'slipDeductionTotal')!.first).toEqual({ kind: 'money', amount: 9000 });
  });

  it('the rebate section keeps zakat-through-salary on its OWN line, never folded into D1(a)', () => {
    // D1(a) is expressly zakat "other than that paid through monthly salary deductions" — the exclusion
    // is the whole point of the line, and it is what stops one payment being relieved twice.
    const x = richRun();
    const rebate = denseSide({ d1: { a: 500 } }, REBATES);
    const sec = byHeading(sections(x, { currentRebate: rebate }), 'slipRebateHeading');
    expect(byCaption(sec, 'rebates.d1.sub.a')!.first).toEqual({ kind: 'money', amount: 500 });
    // D1(b) is a box of a line the form DID carry, so it is the declared nil and not an absence.
    expect(byCaption(sec, 'rebates.d1.sub.b')!.first).toEqual({ kind: 'money', amount: 0 });
    assertFamiliesAgree(sec, REBATES, 'the rebate section');
    const z1 = byCaption(sec, 'slipRebateZakatSalary')!;
    expect(z1.line).toBe('Z1');
    expect(z1.first).toEqual({ kind: 'money', amount: x.trace!.zakatCurrent });
    // Nothing anywhere in the section is the sum of the two.
    for (const v of cells(sec)) {
      if (v.kind === 'money') expect(v.amount).not.toBe(560);
    }
  });

  it('a flat-rate payee gets NO slip sections at all, rather than five empty ones', () => {
    // A non-resident / REP / knowledge-worker deduction returns from the flat branch before `pcbMonth` is
    // ever called: there is no Q, no ΣLP, no LP1 and no Z1 for them. They were not merely unsaved, so
    // drawing them with "not recorded" beside them would assert that they exist.
    const x = explainPcb(
      { pcb: 1650, pcbMeta: { nonResident: true, flatRate: 0.3, rate: 0.3, trace: { remuneration: 5000, additional: 500, rate: 0.3 } } },
      CURRENT,
    );
    expect(x.kind).toBe('flat');
    expect(sections(x, { profile: GRID })).toEqual([]);
  });

  it('every figure emitted was already present in what the builders were handed', () => {
    // THE SWEEP THAT NEEDS NO ASSERTION PER ROW. Any sum, difference or re-rounding introduced into these
    // builders produces a number that is not in the inputs and fails here, naming the caption — including
    // on rows added long after this file was written.
    const numbersIn = (v: unknown, out = new Set<number>()): Set<number> => {
      if (typeof v === 'number') out.add(v);
      else if (v && typeof v === 'object') for (const k of Object.values(v as Record<string, unknown>)) numbersIn(k, out);
      return out;
    };
    const x = richRun();
    const over = {
      profile: GRID,
      currentDeduction: denseSide({ c4: { a: 900 } }),
      accumulatedDeduction: denseSide({ c4: { a: 3400 } }),
      previousDeduction: denseSide({ c9: 800 }),
      currentRebate: denseSide({ d1: { a: 500 } }, REBATES),
    };
    // PCB_CHILD_CATEGORIES joins the inputs because the weighting column is READ from it, exactly as the
    // limit column is read from the catalogue. It is not a loosening: a weighting this file computed rather
    // than read would still not be in the set.
    const allowed = numbersIn({ x, over, catalogue: CATALOGUE, rebates: REBATES, childCategories: PCB_CHILD_CATEGORIES });
    for (const sec of sections(x, over)) {
      for (const row of sec.rows) {
        for (const v of [row.first, row.second]) {
          if (v?.kind === 'money') {
            expect(allowed.has(v.amount), `${sec.heading}/${row.caption}: ${v.amount} was computed, not read`).toBe(true);
          }
          if (v?.kind === 'count') {
            expect(allowed.has(v.count), `${sec.heading}/${row.caption}: the count was computed, not read`).toBe(true);
          }
        }
      }
    }
  });
});

// ─────────────────── (d) the other half of the contract: what the two renderers do ───────────────────

describe('ad7bc503 — the screen and the document render each absence as its own sentence', () => {
  it('the view resolves every caption through a catalogue and formats no figure of its own', () => {
    const view = code(VIEW);
    const at = view.indexOf('slip.map((sec)');
    expect(at, 'the slip block').toBeGreaterThan(-1);
    const block = view.slice(at, view.indexOf('))}', view.indexOf('sec.note', at)));
    expect(block, 'values go through the same switch the worksheet uses').toContain('wsValue(r.first)');
    expect(block, 'and the second column likewise').toContain('wsValue(r.second)');
    expect(block, 'the caption is resolved, never minted').toContain("r.ns === 'taxRelief' ? tr(r.caption) : t(r.caption)");
    expect(block, 'the line marker is passed through, not composed').toContain('line={r.line}');
    for (const forbidden of ['explanation.', 'trace.', "'0.00'", 'Number(']) {
      expect(block, `the slip block must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the PDF is handed strings, so it has no number it could default to a zero', () => {
    const pdf = code(PDF);
    // The renderer must not own a money formatter: the moment it does, an empty cell becomes "0.00" in
    // the one artefact that leaves the building, and the §8 decision is undone where nobody looks.
    for (const forbidden of ['formatMoney', 'toFixed', 'minimumFractionDigits', "'0.00'"]) {
      expect(pdf, `slip-pdf.ts must not contain ${forbidden}`).not.toContain(forbidden);
    }
    // `cells` is the only channel for a figure, and it is typed as strings.
    expect(pdf).toContain('cells: string[]');
    // …and the one place a value becomes a string words all three absences.
    const shared = code(SHARED);
    for (const key of ['notRecordedShort', 'worksheetNotSeparate', 'worksheetDidNotRun']) {
      expect(shared, `the document must word ${key}`).toContain(key);
    }
  });

  it('every new caption is in all six catalogues, and takes no ICU argument', () => {
    // i18n/request.ts deep-merges each locale over English, so a MISSING key renders ENGLISH rather than
    // MISSING_MESSAGE: a clean render log is NOT evidence of coverage, and this is. A stray brace would
    // throw at render and paint a key path onto a tax document.
    const used = new Set<string>();
    for (const m of code(VIEW).matchAll(/t\('(slip[A-Za-z0-9]*)'\)/g)) used.add(m[1]);
    for (const m of code(SHARED).matchAll(/t\('(slip[A-Za-z0-9]*)'\)/g)) used.add(m[1]);
    for (const m of code('core/pcb-explain.ts').matchAll(/'(slip[A-Za-z0-9]*)'/g)) used.add(m[1]);
    for (const m of code(PAGE).matchAll(/t\('(slip[A-Za-z0-9]*)'\)/g)) used.add(m[1]);
    expect(used.size, 'the item adds captions').toBeGreaterThan(30);
    for (const loc of LOCALES) {
      const blk = (JSON.parse(read(`messages/${loc}.json`)) as { payroll: { pcbDetail: Record<string, string> } })
        .payroll.pcbDetail;
      for (const k of used) {
        expect(blk[k], `payroll.pcbDetail.${k} in ${loc}`).toBeTruthy();
        expect(blk[k], `payroll.pcbDetail.${k} in ${loc} must take no ICU argument`).not.toMatch(/[{}]/);
      }
    }
  });

  it('the seventeen agency lines are resolved from the EXISTING taxRelief catalogue, not re-transcribed', () => {
    // A second transcription of the agency's own wording is a second thing to keep in step with the form,
    // which is what localization/my/statutory-tables.ts refuses for the catalogue itself.
    for (const loc of LOCALES) {
      const tr = (JSON.parse(read(`messages/${loc}.json`)) as {
        taxRelief: { items: Record<string, { label?: string; sub?: Record<string, string> }>; rebates: Record<string, { sub?: Record<string, string> }> };
      }).taxRelief;
      for (const def of CATALOGUE) {
        expect(tr.items[def.code]?.label, `taxRelief.items.${def.code}.label in ${loc}`).toBeTruthy();
        for (const sub of def.subItems) {
          expect(tr.items[def.code]?.sub?.[sub.code], `taxRelief.items.${def.code}.sub.${sub.code} in ${loc}`).toBeTruthy();
        }
      }
      for (const def of REBATES) {
        for (const sub of def.subItems) {
          expect(tr.rebates[def.code]?.sub?.[sub.code], `taxRelief.rebates.${def.code}.sub.${sub.code} in ${loc}`).toBeTruthy();
        }
      }
    }
  });
});

// ────────────────────────────── (e) section 11 — the download ──────────────────────────────

describe('ad7bc503 — the download is the screen’s own model, behind the screen’s own gate', () => {
  it('the route is four lines of delegation, with the gate next door', () => {
    const route = code(ROUTE);
    expect(route, 'the body lives in ../shared.ts').toContain("from '../shared'");
    expect(route, 'pdf-lib needs the Node runtime').toContain("runtime = 'nodejs'");
    expect(route).toContain("pcbDetailPdfResponse(req, 'attachment')");
    // The gate must NOT be re-implemented here: a second copy is a second door, and the copy that drifts
    // is the one nobody looks at again (app/payroll/statutory-forms/pcb2ii/shared.ts says so at length).
    for (const forbidden of ['scopedAdmin', 'payslipForReview', 'UUID', 'status: 404']) {
      expect(route, `the route must not re-implement ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the shared body carries the whole gate, and the same bare 404 for every refusal', () => {
    const shared = code(SHARED);
    expect(shared, 'admin AND company scope, not isAdmin').toContain('scopedAdmin()');
    expect(shared, 'the same scope-fenced read the screen uses').toMatch(
      /payslipForReview\(s,\s*\{\s*companyIds:\s*scopeIds/,
    );
    expect(shared, 'the ESS release gate must not be borrowed or widened').not.toContain('payslipDetail');
    expect(shared, 'the id is shape-checked before any query').toContain('UUID.test(payslipId)');
    expect(shared, 'one bare 404 for every refusal').toContain("new Response('Not found', { status: 404 })");
    expect(shared, 'the document is not cached by anything in between').toContain("'private, no-store'");
    expect(shared, 'the language is allowlisted, not handed on').toContain("LANGS.includes(langParam as SlipLang)");
    // Rendering a statement is a READ. No event, no write, no recompute.
    for (const forbidden of ['appendEvent', 'DomainEvent', 'insert(', 'update(', 'pcbMonth']) {
      expect(shared, `the download must not ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('the document is built from the SAME four shaping calls the screen makes', () => {
    // "The downloaded document must contain the same calculation details displayed on screen." The only
    // durable way to keep that promise is for both to go through one model, so a figure cannot differ.
    const shared = code(SHARED);
    for (const fn of ['explainPcb', 'pcbWorksheet', 'pcbSlipSections', 'pcbSlipData']) {
      expect(shared, `the document goes through ${fn}`).toContain(fn);
    }
    expect(code(PAGE), 'and so does the screen').toContain('pcbSlipSections');
    // All ten of the reporter's sections reach the document: 1 from the identification rows, 3/9/10 from
    // the worksheet, and 2/4/5/6/7/8 from the slip.
    expect(shared).toContain('model.worksheet.sections');
    expect(shared).toContain('model.slip');
    expect(shared).toContain("t('identificationHeading')");
  });

  it('the screen offers the download, as a GET and not as an action', () => {
    const page = code(PAGE);
    expect(page).toContain('/payroll/pcb-detail/download?');
    expect(page).toContain("t('slipDownload')");
    // Nothing is posted and nothing is recorded, so there is no form and no server action here.
    expect(page, 'a download is a read').not.toContain('<form');
  });

  it('the reads stay out of core/pcb-explain.ts, which must remain incapable of a second calculation', () => {
    const explain = read('core/pcb-explain.ts');
    for (const forbidden of ['db/client', 'db/schema', 'drizzle-orm', 'withTenant', 'localization/my/payroll']) {
      expect(explain, `core/pcb-explain.ts must not import ${forbidden}`).not.toContain(`from '${forbidden}`);
    }
    // …and the screen's own files still cannot reach the engine or the statutory tables.
    for (const f of [PAGE, VIEW, READS, SHARED]) {
      const imports = read(f).split('\n').filter((l) => l.trimStart().startsWith('import '));
      for (const forbidden of ['pcbMonth', 'localization/my/payroll', 'statutory-tables', 'packFor']) {
        expect(imports.join('\n'), `${f} must not import ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

/**
 * ⚠️ ONE DATABASE LIFECYCLE FOR THE WHOLE FILE, AT FILE SCOPE — the house pattern (see
 * test/20837372-tp3-section-d-lp.test.ts). Two describes each owning their own `afterAll(closeAll)` ends
 * the shared pool while the next describe still needs it, and every test in it then fails with
 * `write CONNECTION_ENDED 127.0.0.1:5433` — a failure that says nothing about the code. Each DB describe
 * keeps its own `beforeEach`, so the pure sections above pay nothing for this.
 */
beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});

// ────────────────── (f) the read, against a real employee and a real stored grid ──────────────────

describe('ad7bc503 — the tax position is read from the employee’s own row', () => {
  let b: Base;
  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
  });

  it('returns the stored grid, the mode and both disability flags — and nothing for an employee with no row', async () => {
    const s = adminCtx(b);
    const hired = await hireEmployee(s, {
      person: { fullName: 'Slip Test', primaryEmail: `slip-${Date.now()}@example.com` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    // No statutory row yet: the screen must say nothing rather than print a row of Nos.
    const before = await pcbSlipData(s, {
      companyIds: [b.companyId],
      employmentId: hired.employmentId,
      taxYear: 2026,
      month: 7,
    });
    expect(before.profile, 'an employment with no statutory row asserts nothing').toBeNull();

    await setStatutoryProfileMY(s, { personId: hired.personId, icNumber: '900101015432', taxCategory: 2 });
    await setTaxProfileMY(s, {
      personId: hired.personId,
      taxCategory: 2,
      numChildren: 3,
      childReliefMode: 'auto_table',
      disabledIndividual: true,
      disabledSpouse: false,
      childReliefTable: {
        under_18: { full: 2, half: 1 },
        study_tertiary: { full: 1, half: 0 },
      },
    });

    const after = await pcbSlipData(s, {
      companyIds: [b.companyId],
      employmentId: hired.employmentId,
      taxYear: 2026,
      month: 7,
    });
    expect(after.profile).toBeTruthy();
    expect(after.profile!.taxCategory).toBe(2);
    expect(after.profile!.mode).toBe('auto_table');
    expect(after.profile!.disabledIndividual).toBe(true);
    expect(after.profile!.disabledSpouse).toBe(false);
    expect(after.profile!.table).toMatchObject({ under_18: { full: 2, half: 1 } });
    // …and the section built from it carries those counts, not a re-derivation of them.
    const sec = byHeading(sections(richRun(), { profile: after.profile }), 'slipChildHeading');
    expect(byCaption(sec, 'slipChildUnder18')!.first).toEqual({ kind: 'count', count: 2 });
    expect(byCaption(sec, 'slipChildUnder18')!.second).toEqual({ kind: 'count', count: 1 });

    // No TP1 and no TP3 for this person: every schedule line is "not recorded", never a zero.
    expect(after.currentDeduction).toBeNull();
    expect(after.previousDeduction).toBeNull();
  });

  it('fails CLOSED on an empty scope, like every read on this screen', async () => {
    const s = adminCtx(b);
    const hired = await hireEmployee(s, {
      person: { fullName: 'Scope Test', primaryEmail: `scope-${Date.now()}@example.com` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setStatutoryProfileMY(s, { personId: hired.personId, icNumber: '900101015433', taxCategory: 1 });
    const out = await pcbSlipData(s, { companyIds: [], employmentId: hired.employmentId, taxYear: 2026, month: 7 });
    expect(out.profile, 'no scope, no figures').toBeNull();
    expect(out.currentDeduction).toBeNull();
    expect(out.accumulatedDeduction).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════════
// (g) THE SECTION THE WHOLE SCREEN EXISTS FOR, AGAINST WHAT THE WRITERS AND THE PAYROLL FEED REALLY DO
// ══════════════════════════════════════════════════════════════════════════════════════════════════════

describe('ad7bc503 — the relief schedule against real stored declarations', () => {
  const YEAR = 2026;
  let b: Base;
  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
  });

  const hire = (name: string) =>
    hireEmployee(adminCtx(b), {
      person: { fullName: name, primaryEmail: `${name.replace(/\W+/g, '-').toLowerCase()}-${Date.now()}@example.com` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: `${YEAR}-01-01`,
    });

  /** The RAW form input for the same declaration `writerShape` predicts the stored shape of. Spelled the
   *  way test/tp1-2026-form.test.ts spells it: a bare number lands in the item's FIRST lettered box. */
  const formInput = (declared: Record<string, number | Record<string, number>>) => ({
    form: 'tp1-2026',
    items: Object.fromEntries(
      Object.entries(declared).map(([code, v]) => {
        const def = CATALOGUE.find((d) => d.code === code)!;
        if (typeof v !== 'number') return [code, { subItems: v }];
        return def.subItems.length === 0 ? [code, { amount: v }] : [code, { subItems: { [def.subItems[0].code]: v } }];
      }),
    ),
    rebates: {},
  });

  const declare = async (personId: string, p: { month?: number; items: Record<string, number | Record<string, number>> }) => {
    const { id } = await submitTp1ForPerson(adminCtx(b), {
      personId,
      assessmentYear: YEAR,
      deductionMonth: p.month,
      declarationAccepted: true,
      categories: formInput(p.items),
    });
    await approveTp1ForPerson(adminCtx(b), { personId, id, approvedMonth: p.month ?? 1, approvedYear: YEAR });
    return id;
  };

  /** What `core/payroll.ts` itself would feed for this batch month — its own query, its own reduction. */
  const fedByPayroll = async (personId: string, month: number) => {
    const rows = await owner.db.select(TP1_COUNTABLE_COLUMNS).from(tp1Relief).where(tp1CountableWhere(personId, YEAR));
    return tp1CountForYear(rows, { throughMonth: month }).total;
  };

  const slip = async (employmentId: string, month: number) => {
    const data = await pcbSlipData(adminCtx(b), {
      companyIds: [b.companyId],
      employmentId,
      taxYear: YEAR,
      month,
    });
    return {
      data,
      sections: pcbSlipSections(richRun(), {
        profile: data.profile,
        catalogue: CATALOGUE,
        rebateCatalogue: REBATES,
        currentDeduction: data.currentDeduction,
        accumulatedDeduction: data.accumulatedDeduction,
        previousDeduction: data.previousDeduction,
        currentRebate: data.currentRebate,
        accumulatedRebate: data.accumulatedRebate,
      }),
    };
  };

  it('the fixture helper IS the writer — the stored payload and `writerShape` are the same object', async () => {
    // Without this, every dense fixture in this file is a guess about the writers and the whole §8 contract
    // above is asserted over a shape that may not exist. With it, the guess is checked against the database.
    const e = await hire('Writer Shape');
    const declared = { c4: { a: 900, c: 300 }, c14: 350 };
    const id = await declare(e.personId, { month: 1, items: declared });
    const row = await getTp1ByIdForPerson(adminCtx(b), { personId: e.personId, id });
    expect((row!.categories as { items: unknown }).items).toEqual(writerShape(declared));
    // …and DENSE: every numbered line of the catalogue is present, carrying a figure.
    const stored = (row!.categories as { items: Record<string, { amount: number }> }).items;
    expect(Object.keys(stored).sort()).toEqual(CATALOGUE.map((d) => d.code).sort());
    // …while the lettered boxes are SPARSE: only the two that were filled were written.
    expect(stored.c4).toEqual({ amount: 1200, subItems: { a: 900, c: 300 } });
    expect((stored.c1 as { subItems?: unknown }).subItems, 'an untouched line stores no boxes').toBeUndefined();
  });

  it('SUMS the declarations in force, exactly as the payroll feed sums them — never the newest alone', async () => {
    // ⚠️ THE DEFECT THIS PINS. `core/payroll.ts` feeds `tp1CountForYear(rows, { throughMonth: pMonth }).total`
    // and says in capitals why: "ONE ROW PER MONTH, SUMMED — NOT 'LATEST WINS' … January 3,000 then June
    // 2,000 would feed 2,000, not 5,000 — silently, with no error anywhere." An earlier build of
    // slip-data.ts sorted the collapsed rows and itemised `[0]`, so this screen showed 2,000 where the
    // kernel had used 5,000 — on the page whose entire purpose is to reconcile with the payroll figure.
    const e = await hire('Summed Relief');
    await declare(e.personId, { month: 1, items: { c4: { a: 3000 } } });
    await declare(e.personId, { month: 6, items: { c4: { a: 2000 } } });

    const fedJune = await fedByPayroll(e.personId, 6);
    expect(fedJune, 'the premise: the kernel was fed the sum').toBe(5000);

    const june = await slip(e.employmentId, 6);
    const sec = byHeading(june.sections, 'slipCurrentDeductionHeading');
    expect(byCaption(sec, 'items.c4.label')!.first).toEqual({ kind: 'money', amount: fedJune });
    expect(byCaption(sec, 'items.c4.sub.a')!.first).toEqual({ kind: 'money', amount: fedJune });
    expect(byCaption(sec, 'slipDeductionTotal')!.first).toEqual({ kind: 'money', amount: fedJune });

    // …and the month BEFORE the second declaration takes effect still shows only the first, because the
    // Section F effective-from rule is inside `tp1CountForYear` and this screen never re-spells it.
    const march = await slip(e.employmentId, 3);
    const marchSec = byHeading(march.sections, 'slipCurrentDeductionHeading');
    expect(await fedByPayroll(e.personId, 3), 'the premise').toBe(3000);
    expect(byCaption(marchSec, 'items.c4.label')!.first).toEqual({ kind: 'money', amount: 3000 });

    // The ACCUMULATED column is the whole assessment year, which is the annual question the limit check
    // asks — so it carries both declarations in March too, and it must not exclude any bucket.
    expect(byCaption(marchSec, 'items.c4.label')!.second).toEqual({ kind: 'money', amount: 5000 });
    expect(byCaption(marchSec, 'slipDeductionTotal')!.second).toEqual({ kind: 'money', amount: 5000 });
  });

  it('a WHOLE-YEAR declaration reaches the accumulated column, rather than being excluded from it', async () => {
    // `getTp1AccumulatedForPerson(…, { deductionMonth: null })` means "count every month EXCEPT the
    // month-less bucket" — its `deductionMonth` is the bucket to leave OUT. Reading it as "the whole year"
    // dropped every pre-r209 declaration's money out of the Accumulated column silently.
    const e = await hire('Whole Year');
    await declare(e.personId, { items: { c4: { a: 1800 } } }); // no deduction month: the month-less bucket
    const sec = byHeading((await slip(e.employmentId, 7)).sections, 'slipCurrentDeductionHeading');
    expect(byCaption(sec, 'slipDeductionTotal')!.second).toEqual({ kind: 'money', amount: 1800 });
    expect(byCaption(sec, 'slipDeductionTotal')!.first).toEqual({ kind: 'money', amount: 1800 });
  });

  it('NO numbered line contradicts its own boxes, on either column, for a really-filed TP1', async () => {
    // ⚠️ THE ROUND'S CENTRAL §8 CONTRACT, ON THE DATA PATH RATHER THAN ON A FIXTURE. Before this fix every
    // numbered line printed RM 0.00 while its own lettered boxes printed "nothing was recorded" — 27
    // contradicting sub-lines per schedule, on a document `slipPdfProvenance` tells the reader to read as
    // "no declaration was captured for it".
    const e = await hire('Dense Real');
    await declare(e.personId, { month: 1, items: { c8: 1234 } });
    const { sections: secs } = await slip(e.employmentId, 7);
    const sec = byHeading(secs, 'slipCurrentDeductionHeading');
    assertFamiliesAgree(sec, CATALOGUE, 'a really-filed TP1, section 7');
    assertFamiliesAgree(byHeading(secs, 'slipRebateHeading'), REBATES, 'a really-filed TP1, section 8');
    // The line that WAS filled, and a line that was not: both carry a figure, because both were captured.
    expect(byCaption(sec, 'items.c8.label')!.first).toEqual({ kind: 'money', amount: 1234 });
    expect(byCaption(sec, 'items.c1.label')!.first).toEqual({ kind: 'money', amount: 0 });
    expect(byCaption(sec, 'items.c1.sub.a')!.first).toEqual({ kind: 'money', amount: 0 });
    for (const v of cells(sec)) {
      expect(v.kind, 'a captured declaration has no unrecorded line, in EITHER column').not.toBe('notRecorded');
    }
  });

  it('…and neither does the PREVIOUS employer schedule, for a really-saved TP3 Section D', async () => {
    // The other writer, the other reporter section, the same contract. `core/tp3.ts` `readGroup` is dense
    // over TP3_SECTION_D in exactly the same way, so section 4 had the identical defect.
    const e = await hire('Dense TP3');
    await setStatutoryProfileMY(adminCtx(b), { personId: e.personId, icNumber: '900101015440', taxCategory: 1 });
    await saveTp3(adminCtx(b), {
      personId: e.personId,
      assessmentYear: YEAR,
      sectionC: { c1: { amount: 60000 }, c3: { amount: 6000 }, c5: { amount: 900 } },
      sectionD: { c8: { amount: 1234 } },
    });
    const { data, sections: secs } = await slip(e.employmentId, 7);
    expect(data.previousDeduction, 'the premise: a Section D was captured').toBeTruthy();
    const sec = byHeading(secs, 'slipPrevDeductionHeading');
    assertFamiliesAgree(sec, CATALOGUE, 'a really-saved TP3 Section D');
    expect(byCaption(sec, 'items.c8.label')!.first).toEqual({ kind: 'money', amount: 1234 });
    expect(byCaption(sec, 'items.c1.label')!.first).toEqual({ kind: 'money', amount: 0 });
    expect(byCaption(sec, 'items.c1.sub.a')!.first).toEqual({ kind: 'money', amount: 0 });
    // TP3's Section D is keyed by the SAME codes, which is why one builder reads both sides.
    expect(TP3_SECTION_D.map((d) => d.code).sort()).toEqual(CATALOGUE.map((d) => d.code).sort());
  });

  it('and an employee with NO declaration still gets absences, not a column of zeroes', async () => {
    const e = await hire('Nothing Filed');
    const { data, sections: secs } = await slip(e.employmentId, 7);
    expect(data.currentDeduction, 'no approved declaration ⇒ nothing is asserted').toBeNull();
    expect(data.accumulatedDeduction).toBeNull();
    for (const heading of ['slipCurrentDeductionHeading', 'slipPrevDeductionHeading', 'slipRebateHeading']) {
      for (const row of byHeading(secs, heading).rows) {
        if (row.caption === 'slipRebateZakatSalary') continue; // the payroll's own zakat, a real figure
        expect(row.first.kind, `${heading}/${row.caption}`).toBe('notRecorded');
        mustNotBeAZero(row, heading);
      }
    }
  });
});

// ─────────────── (h) the child note: one sentence per state, and each of them true ───────────────

describe('ad7bc503 — the children note says what is actually recorded', () => {
  const noteFor = (profile: PcbChildProfile | null) =>
    byHeading(sections(richRun(), { profile }), 'slipChildHeading').note;

  it('names each of the FOUR states, and claims a manual total only for a manual employee', () => {
    // ⚠️ THE NOTE WAS CHOSEN FROM WHETHER THE GRID RESOLVED, WHICH IS NOT THE SAME QUESTION AS THE MODE.
    // Two reachable states therefore printed "this employee's children are recorded as a single total
    // rather than split across the five categories" — a specific claim about what HR keyed — when nobody
    // had keyed that. core/child-relief-review.ts:18 documents the first of them by name.
    expect(noteFor(GRID), 'auto_table WITH a grid').toBe('slipChildNoteTable');
    expect(noteFor({ ...GRID, table: null }), 'auto_table with NO grid ever keyed').toBe('slipChildNoteTableEmpty');
    expect(noteFor({ ...GRID, mode: 'manual' }), 'a manual total').toBe('slipChildNoteManual');
    expect(noteFor(null), 'no employee_statutory_my row at all').toBe('slipChildNoteNoProfile');
    // …and each of those is a DIFFERENT sentence, not the same key under four names.
    const notes = [noteFor(GRID), noteFor({ ...GRID, table: null }), noteFor({ ...GRID, mode: 'manual' }), noteFor(null)];
    expect(new Set(notes).size, 'four states, four sentences').toBe(4);
    // The manual sentence is the one with the factual claim in it, so only the manual state may carry it.
    const en = (JSON.parse(read('messages/en.json')) as { payroll: { pcbDetail: Record<string, string> } }).payroll.pcbDetail;
    expect(en.slipChildNoteManual.toLowerCase()).toContain('single total');
    expect(en.slipChildNoteTableEmpty.toLowerCase(), 'the empty-grid sentence must not claim a single total')
      .not.toContain('single total');
    expect(en.slipChildNoteNoProfile.toLowerCase(), 'nor may the no-row sentence').not.toContain('single total');
  });

  it('an auto_table employee with no grid still gets no figure invented for them', () => {
    const sec = byHeading(sections(richRun(), { profile: { ...GRID, table: null } }), 'slipChildHeading');
    for (const c of PCB_CHILD_CATEGORIES) mustNotBeAZero(byCaption(sec, c.caption)!, 'auto_table, no grid');
  });
});

// ─────────── (i) the plan's weighting column: the QC the agency's own table carries ───────────

describe('ad7bc503 — the weighting each child category carries', () => {
  it('prints the qualifying-children weighting as its own column, in every state', () => {
    // The approved plan promises "how many children are claimed at the full rate and how many at half, THE
    // WEIGHTING EACH CATEGORY CARRIES, and the relief that produces". The weighting is a property of the
    // CATEGORY, so it is stated even where this employee's counts are not recorded.
    for (const profile of [GRID, { ...GRID, mode: 'manual' }, null] as (PcbChildProfile | null)[]) {
      const sec = byHeading(sections(richRun(), { profile }), 'slipChildHeading');
      expect(sec.thirdColumn, 'the section declares the column').toBe('slipColWeighting');
      for (const c of PCB_CHILD_CATEGORIES) {
        expect(byCaption(sec, c.caption)!.third, `${c.key} weighting`).toEqual({ kind: 'count', count: c.qc });
      }
    }
    // C, Q and the two disability rows are not categories and carry no weighting.
    const sec = byHeading(sections(richRun(), { profile: GRID }), 'slipChildHeading');
    for (const caption of ['slipChildCount', 'slipChildRelief', 'slipDisabledIndividual', 'slipDisabledSpouse']) {
      expect(byCaption(sec, caption)!.third, caption).toBeUndefined();
    }
  });

  it('the weighting and the country pack cannot drift: qc × perChild IS childByCategory', () => {
    // `localization/my/statutory-tables.ts` carries this same fact as MONEY and says so — "Every value
    // below is the spec's qualifying-children count × the RM2,000 per-child relief" — and deliberately
    // carries no QC integer. A country pack must not be imported from core/, so the integer lives in
    // core/pcb-explain.ts and the equivalence is asserted here, exactly as
    // test/child-relief-figures-04b88724.test.ts asserts the pack's own figures.
    expect(MY_RELIEFS.perChild).toBe(2000);
    for (const c of PCB_CHILD_CATEGORIES) {
      expect(
        c.qc * MY_RELIEFS.perChild,
        `PCB_CHILD_CATEGORIES ${c.key} weighting ${c.qc} × RM${MY_RELIEFS.perChild} must equal ` +
          `MY_RELIEFS.childByCategory.${c.key} (RM${MY_RELIEFS.childByCategory[c.key]})`,
      ).toBe(MY_RELIEFS.childByCategory[c.key]);
    }
    // …and over exactly the same five keys, in the same order.
    expect(PCB_CHILD_CATEGORIES.map((c) => c.key)).toEqual(Object.keys(MY_RELIEFS.childByCategory));
  });
});

// ──────── (j) the document is the screen: section 1 in full, the banner, and the reader's language ────────

describe('ad7bc503 — what the downloaded document carries that it used to leave out', () => {
  it('section 1 carries the marital tax status and the payroll cycle, like the screen', () => {
    // Requirement 11 is "the same calculation details displayed on screen", and the reporter's section 1
    // lists Marital Tax Status by name. The document built seven kv rows where the screen renders eight
    // plus the cycle, because CATEGORY_LABEL and CYCLE_LABEL were private to the React component.
    const shared = code(SHARED);
    for (const key of ['fieldMaritalStatus', 'fieldCycle']) {
      expect(shared, `the document must print ${key}`).toContain(`t('${key}')`);
    }
    expect(shared, 'resolved through the same map the screen uses, not a second copy').toContain('CATEGORY_LABEL[category]');
    expect(shared, 'and likewise the cycle').toContain('CYCLE_LABEL[row.runType]');
    // The maps now live in core/, so there is exactly one of each.
    const explain = code('core/pcb-explain.ts');
    expect(explain, 'the cycle map is in core').toContain('export const CYCLE_LABEL');
    expect(explain, 'and so is the category map').toContain('export const CATEGORY_LABEL');
    expect(code(VIEW), 'the view reads them rather than owning them').toContain('CATEGORY_LABEL, CYCLE_LABEL');
  });

  it('the override / additional-run banner reaches the document, from ONE caption decision', () => {
    // pcb-detail-view.tsx's own comment: "Rendering the working without this makes the screen a
    // competent-looking derivation of an amount nobody deducted." That was true of the PDF, which carried
    // no banner at all — only the two differently-captioned result rows.
    // The caption decision is what is under test, so each basis kind is driven directly — which is exactly
    // what the document is handed by `pcbDetailModel`.
    const sec = pcbBasisSection({
      ...richRun(),
      basis: { kind: 'manual', system: 900, applied: 500, prior: null, engineRun: null, reason: 'Agreed' },
    } as PcbExplanation);
    expect(sec, 'a payslip whose working does not explain the deduction gets a block').toBeTruthy();
    expect(sec!.heading).toBe('overrideHeading');
    expect(sec!.note, 'the prose the screen shows, not just the figures').toBe('overrideBanner');
    expect(sec!.rows.map((r) => r.caption)).toEqual(['overrideSystem', 'overrideApplied', 'overrideReason']);
    expect(sec!.rows[0].first).toEqual({ kind: 'money', amount: 900 });
    expect(sec!.rows[1].first).toEqual({ kind: 'money', amount: 500 });
    expect(sec!.rows[2].first).toEqual({ kind: 'text', text: 'Agreed' });

    // An additional run: the working is the WHOLE MONTH, the prior figure gets its own line, and there is
    // no operator reason to report because no operator was asked for one.
    const delta = pcbBasisSection({
      ...richRun(),
      basis: { kind: 'additionalRun', system: 900, applied: 300, prior: 600, engineRun: null, reason: '' },
    } as PcbExplanation);
    expect(delta!.heading).toBe('deltaHeading');
    expect(delta!.rows.map((r) => r.caption)).toEqual(['deltaMonthTotal', 'deltaPrior', 'deltaApplied']);

    // …and no block at all when the working explains exactly what was deducted.
    expect(pcbBasisSection(richRun()), 'the ordinary case needs no banner').toBeNull();
    // The document renders it: heading, rows and the prose.
    const shared = code(SHARED);
    expect(shared, 'the document builds the block').toContain('pcbBasisSection(model.explanation)');
    expect(shared, 'including the prose, which is the part that was missing').toContain('basisSection.note');
  });

  it('the Download link hands the reader’s own locale to the allowlist', () => {
    // shared.ts comments the provenance pair as "the reader's own language AND in English". With no `lang`
    // on the link the allowlist saw null every time, so the Malay branch was unreachable from the product
    // and both lines resolved against English.
    const page = code(PAGE);
    expect(page, 'the locale is handed on').toContain('lang: locale');
    expect(code(SHARED), 'and allowlisted, never trusted').toContain('LANGS.includes(langParam as SlipLang)');
    // The Malay provenance line must actually BE Malay, or the pair is English twice however it is wired.
    const en = (JSON.parse(read('messages/en.json')) as { payroll: { pcbDetail: Record<string, string> } }).payroll.pcbDetail;
    const ms = (JSON.parse(read('messages/ms.json')) as { payroll: { pcbDetail: Record<string, string> } }).payroll.pcbDetail;
    expect(ms.slipPdfProvenance, 'the reader-language line is not the English one').not.toBe(en.slipPdfProvenance);
    expect(ms.slipPdfProvenanceEn, 'while the English line stays English on purpose').toBe(en.slipPdfProvenanceEn);
  });
});
