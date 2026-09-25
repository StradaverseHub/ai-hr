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
  pcbSlipSections,
  type PcbChildProfile,
  type PcbExplanation,
  type PcbReliefBreakdown,
  type PcbSlipCatalogueItem,
  type PcbSlipRow,
  type PcbSlipSection,
  type PcbSlipSide,
} from '../core/pcb-explain';
import { TP1_ITEMS, TP1_REBATES } from '../core/tax-relief';
import { hireEmployee } from '../core/org';
import { setStatutoryProfileMY, setTaxProfileMY } from '../localization/my/statutory';
import { pcbSlipData } from '../app/payroll/pcb-detail/slip-data';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

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
    const side: PcbSlipSide = {
      attributed: true,
      amounts: { items: { c4: { amount: 1200, subItems: { a: 900, c: 300 } }, c14: { amount: 350 } } },
      total: 1550,
    };
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

  it('a line with NO declared figure reads "not recorded" — the schedule is never a column of zeroes', () => {
    // THE HEART OF THE ITEM. The declaration exists and is attributed, and C4(b) is simply not in it: the
    // employee did not fill that box. The reference would print 0.00; we say nothing was recorded,
    // because a printed 0.00 asserts the employee claimed nothing under that head.
    const side: PcbSlipSide = {
      attributed: true,
      amounts: { items: { c4: { amount: 1200, subItems: { a: 900, c: 300 } } } },
      total: 1200,
    };
    const sec = byHeading(sections(richRun(), { currentDeduction: side }), 'slipCurrentDeductionHeading');
    for (const caption of ['items.c4.sub.b', 'items.c9.label', 'items.c17.label']) {
      const row = byCaption(sec, caption)!;
      expect(row.first, caption).toEqual({ kind: 'notRecorded' });
      mustNotBeAZero(row, 'an unfilled box');
    }
    // …and a DECLARED zero would still print as a zero, because the employee wrote it. The distinction is
    // the whole contract, so it is asserted in both directions.
    const declaredZero: PcbSlipSide = { attributed: true, amounts: { items: { c9: { amount: 0 } } }, total: 0 };
    const zeroSec = byHeading(
      sections(richRun(), { currentDeduction: declaredZero }),
      'slipCurrentDeductionHeading',
    );
    expect(byCaption(zeroSec, 'items.c9.label')!.first).toEqual({ kind: 'money', amount: 0 });
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
    const rebate: PcbSlipSide = {
      attributed: true,
      amounts: { items: { d1: { amount: 500, subItems: { a: 500 } } } },
      total: 500,
    };
    const sec = byHeading(sections(x, { currentRebate: rebate }), 'slipRebateHeading');
    expect(byCaption(sec, 'rebates.d1.sub.a')!.first).toEqual({ kind: 'money', amount: 500 });
    expect(byCaption(sec, 'rebates.d1.sub.b')!.first).toEqual({ kind: 'notRecorded' });
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
      currentDeduction: { attributed: true, amounts: { items: { c4: { amount: 1200, subItems: { a: 900 } } } }, total: 1200 } as PcbSlipSide,
      accumulatedDeduction: { attributed: true, amounts: { items: { c4: { amount: 3400 } } }, total: 3400 } as PcbSlipSide,
      previousDeduction: { attributed: true, amounts: { items: { c9: { amount: 800 } } }, total: null } as PcbSlipSide,
      currentRebate: { attributed: true, amounts: { items: { d1: { subItems: { a: 500 } } } }, total: 500 } as PcbSlipSide,
    };
    const allowed = numbersIn({ x, over, catalogue: CATALOGUE, rebates: REBATES });
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

// ────────────────── (f) the read, against a real employee and a real stored grid ──────────────────

describe('ad7bc503 — the tax position is read from the employee’s own row', () => {
  let b: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    b = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
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
