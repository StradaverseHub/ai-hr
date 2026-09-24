/**
 * 99b2d6c0 (r336) — CHILD RELIEF REVIEW: the report, and the four money claims it rests on.
 *
 * ═══ WHAT THIS ITEM DID AND DID NOT BUILD ═══
 *
 * The per-category child relief itself SHIPPED IN RULESET 2026.7 (item d64d0df4) and is not rebuilt here:
 * `childByCategory`, `childReliefAmountFor`, the grid on the Identification & Tax card and the
 * `auto_table` mode all existed before this round. What this round adds is REACHABILITY (a screen that
 * lists every parent with a link straight to their grid) and a REPORT that says, in ringgit, whose tax
 * would move and by how much — shown BEFORE anything is changed.
 *
 * ═══ THE GAP THIS FILE CLOSES, WHICH IS ABOUT MONEY AND NOT ABOUT THE SCREEN ═══
 *
 * The kernel's `auto_table` gates — `core/payroll.ts` (the payslip) and `core/payroll-view.ts`
 * (`currentPcbReliefs`, the PCB drill-down) — were NOT PINNED BY ANY TEST before this file. A repo-wide
 * grep for `auto_table` across `test/` returned three files, none of which reaches either gate:
 * test/statutory-disabled-spouse-child-table.test.ts asserts the PURE pricing function and hands
 * `pcbMonth` an already-worked `childReliefAmount`, so deleting the mode read in the kernel would have
 * left the whole suite green while every `auto_table` employee silently reverted to flat counting. That
 * is a wrong PCB on a statutory return with nothing on screen saying so, which is exactly the class
 * CLAUDE.md §8 calls out. Both gates are now pinned END TO END, against a real payslip and a real read
 * model, by the amount the ruleset prices — never by an inline constant.
 *
 * ═══ ⚠️ WHAT IS NOT ASSERTED HERE, DELIBERATELY ═══
 *
 * Not one assertion below names a RINGGIT FIGURE of its own. Every expected amount is derived from the
 * ruleset handed to the code under test, so correcting a statutory figure changes one constant in
 * localization/my/statutory-tables.ts and no test. That matters more than usual for this item: the five
 * `childByCategory` amounts are marked RATE-ONLY, NOT YET VERIFIED in that file — sourced from a
 * published summary, not from the LHDN spec — and the two OKU relief amounts are on the same footing.
 * This round changed none of them and this file pins none of them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MY_STATUTORY,
  MY_RELIEFS,
  CHILD_RELIEF_CATEGORY_KEYS,
  type StatutoryRuleset,
} from '../localization/my/statutory-tables';
import { childReliefAmountFor, pcbMonth } from '../localization/my/payroll';
import {
  ChildReliefReviewAccessError,
  childReliefGridFromFamily,
  childReliefReview,
  childReliefReviewFigures,
} from '../core/child-relief-review';
import { setStatutoryProfileMY, setTaxProfileMY } from '../localization/my/statutory';
import { addDependent } from '../core/dependents';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createBatch, generatePayslips } from '../core/payroll';
import { currentPcbReliefs } from '../core/payroll-view';
import { payslip as payslipTable } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { type SessionContext } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

/** The built-in reliefs, as the kernel resolves them when a company has overridden nothing. */
const RELIEFS = DEFAULT_MY_STATUTORY.pcb.reliefs;
/** The pack's own pricing function, bound to those reliefs — the SAME binding the report makes. */
const priceWith =
  (reliefs: StatutoryRuleset['pcb']['reliefs']) =>
  (table: unknown): number =>
    childReliefAmountFor(table, reliefs);

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// (a) An 'auto_table' employee with ONE tertiary-study child is worth the TERTIARY figure, not the flat
//     one — read through the MODE, which is the thing this round had to prove is actually consulted.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('99b2d6c0 · (a) the mode decides which figure is used', () => {
  const ONE_TERTIARY = { study_tertiary: { full: 1, half: 0 } };

  it('auto_table with one tertiary-study child reports the TERTIARY amount, not children × perChild', () => {
    const f = childReliefReviewFigures({
      mode: 'auto_table',
      numChildren: 1,
      storedGrid: ONE_TERTIARY,
      familyGrid: null,
      perChild: RELIEFS.perChild,
      amountFor: priceWith(RELIEFS),
    });
    // Both sides come from the ruleset. The POINT is that they are different numbers and the mode picks.
    expect(f.todayRM).toBeCloseTo(RELIEFS.childByCategory!.study_tertiary, 2);
    expect(f.todayRM).not.toBeCloseTo(1 * RELIEFS.perChild, 2);
    expect(f.switchRM).toBeCloseTo(f.todayRM, 2);
    expect(f.deltaRM).toBeCloseTo(0, 2);
  });

  it('the SAME grid on a manual employee is still priced flat today, and the report says what switching is worth', () => {
    const f = childReliefReviewFigures({
      mode: 'manual',
      numChildren: 1,
      storedGrid: ONE_TERTIARY,
      familyGrid: null,
      perChild: RELIEFS.perChild,
      amountFor: priceWith(RELIEFS),
    });
    expect(f.todayRM).toBeCloseTo(1 * RELIEFS.perChild, 2);
    expect(f.switchRM).toBeCloseTo(RELIEFS.childByCategory!.study_tertiary, 2);
    expect(f.deltaRM).toBeCloseTo(RELIEFS.childByCategory!.study_tertiary - RELIEFS.perChild, 2);
  });

  it('⚠️ switching with NO grid keyed prices the children at ZERO — the report states the rise as a negative change', () => {
    for (const stored of [null, undefined, {}, { under_18: { full: 0, half: 0 } }]) {
      const f = childReliefReviewFigures({
        mode: 'manual',
        numChildren: 3,
        storedGrid: stored,
        familyGrid: null,
        perChild: RELIEFS.perChild,
        amountFor: priceWith(RELIEFS),
      });
      expect(f.gridKeyed, `an empty grid (${JSON.stringify(stored)}) must not read as keyed`).toBe(false);
      expect(f.switchRM).toBeCloseTo(0, 2);
      expect(f.deltaRM).toBeCloseTo(-3 * RELIEFS.perChild, 2);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// (b) 'manual' and 'auto' employees are byte-identical to today.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('99b2d6c0 · (b) manual and auto keep the flat arithmetic to the cent', () => {
  it.each(['manual', 'auto'])('%s is exactly children × perChild, whatever grid happens to be stored', (mode) => {
    for (const children of [0, 1, 4, 7]) {
      const f = childReliefReviewFigures({
        mode,
        numChildren: children,
        // A grid that would price at a COMPLETELY different number if the mode were ignored.
        storedGrid: { disabled_study: { full: 2, half: 1 } },
        familyGrid: null,
        perChild: RELIEFS.perChild,
        amountFor: priceWith(RELIEFS),
      });
      expect(f.todayRM, `${mode} with ${children} children`).toBeCloseTo(children * RELIEFS.perChild, 2);
    }
  });

  it('pcbMonth with no supplied child amount is byte-identical to the expression it always used', () => {
    for (const children of [0, 2, 5]) {
      const before = pcbMonth({ monthlyWage: 9000, epfMonthly: 990, month: 4, profile: { category: 1, children } });
      const withUndefined = pcbMonth({
        monthlyWage: 9000,
        epfMonthly: 990,
        month: 4,
        profile: { category: 1, children, childReliefAmount: undefined },
      });
      expect(withUndefined).toEqual(before);
      expect(before.snapshot.reliefs.children).toBeCloseTo(children * RELIEFS.perChild, 2);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// (c) The disabled-spouse relief applies to CATEGORY 2 ONLY.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('99b2d6c0 · (c) the disabled-spouse relief is gated to tax category 2', () => {
  const withSpouseAmount = (amount: number): StatutoryRuleset['pcb'] => ({
    ...DEFAULT_MY_STATUTORY.pcb,
    reliefs: { ...RELIEFS, disabledSpouse: amount },
  });
  const P1of = (profile: Parameters<typeof pcbMonth>[0]['profile'], pcb: StatutoryRuleset['pcb']) =>
    pcbMonth({ monthlyWage: 12000, epfMonthly: 1320, month: 3, profile, pcb }).snapshot.P1;

  it('category 2 moves by EXACTLY the ruleset figure; categories 1 and 3 move by ZERO', () => {
    for (const amount of [1000, 5000, 12345]) {
      const pcb = withSpouseAmount(amount);
      const cat2 =
        P1of({ category: 2, children: 0, disabledSpouse: false }, pcb) -
        P1of({ category: 2, children: 0, disabledSpouse: true }, pcb);
      expect(cat2, `category 2 must claim exactly ${amount}`).toBeCloseTo(amount, 2);
      for (const category of [1, 3] as const) {
        const moved =
          P1of({ category, children: 0, disabledSpouse: false }, pcb) -
          P1of({ category, children: 0, disabledSpouse: true }, pcb);
        expect(moved, `category ${category} has no spouse deduction to add to`).toBeCloseTo(0, 2);
      }
    }
  });

  it('the snapshot the payslip records agrees: disabledSpouse is 0.00 outside category 2', () => {
    const pcb = withSpouseAmount(5000);
    for (const category of [1, 3] as const) {
      const snap = pcbMonth({
        monthlyWage: 12000,
        epfMonthly: 1320,
        month: 3,
        profile: { category, disabledSpouse: true },
        pcb,
      }).snapshot;
      expect(snap.reliefs.disabledSpouse, `category ${category}`).toBe(0);
    }
    const snap2 = pcbMonth({
      monthlyWage: 12000,
      epfMonthly: 1320,
      month: 3,
      profile: { category: 2, disabledSpouse: true },
      pcb,
    }).snapshot;
    expect(snap2.reliefs.disabledSpouse).toBeCloseTo(5000, 2);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// (d) A company override that omits the optional fields still gets the built-in fallback.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('99b2d6c0 · (d) an override that omits an optional relief falls back to the built-in', () => {
  /** A ruleset slice shaped like an override written before the optional keys existed. */
  const withoutOptional = () => {
    const reliefs = { ...RELIEFS } as Record<string, unknown>;
    delete reliefs.childByCategory;
    delete reliefs.disabledSpouse;
    delete reliefs.disabledIndividual;
    return reliefs as unknown as StatutoryRuleset['pcb']['reliefs'];
  };

  it('the category map falls back — a legacy override does not price every child at zero', () => {
    const legacy = withoutOptional();
    expect(legacy.childByCategory).toBeUndefined();
    for (const key of CHILD_RELIEF_CATEGORY_KEYS) {
      expect(
        childReliefAmountFor({ [key]: { full: 1, half: 0 } }, legacy),
        `${key} must fall back to the pack's built-in figure`,
      ).toBeCloseTo(MY_RELIEFS.childByCategory[key], 2);
    }
  });

  it('the report priced through a legacy override reports the built-in amounts, not zero', () => {
    const legacy = withoutOptional();
    const f = childReliefReviewFigures({
      mode: 'auto_table',
      numChildren: 1,
      storedGrid: { study_tertiary: { full: 1, half: 0 } },
      familyGrid: null,
      perChild: legacy.perChild,
      amountFor: priceWith(legacy),
    });
    expect(f.todayRM).toBeCloseTo(MY_RELIEFS.childByCategory.study_tertiary, 2);
  });

  it('both OKU reliefs fall back through pcbMonth rather than silently becoming zero', () => {
    const pcb = { ...DEFAULT_MY_STATUTORY.pcb, reliefs: withoutOptional() };
    const P1of = (profile: Parameters<typeof pcbMonth>[0]['profile']) =>
      pcbMonth({ monthlyWage: 12000, epfMonthly: 1320, month: 3, profile, pcb }).snapshot.P1;
    expect(P1of({ category: 2 }) - P1of({ category: 2, disabled: true })).toBeCloseTo(
      MY_RELIEFS.disabledIndividual,
      2,
    );
    expect(P1of({ category: 2 }) - P1of({ category: 2, disabledSpouse: true })).toBeCloseTo(
      MY_RELIEFS.disabledSpouse,
      2,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// The Family register → a suggested grid.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('99b2d6c0 · the Family register suggestion', () => {
  const child = (over: Record<string, unknown> = {}) => ({
    relationship: 'child',
    dateOfBirth: '2015-01-01',
    isStudent: false,
    isDeceased: false,
    archivedAt: null,
    childTaxRelief: null,
    childReliefCategory: 'under_18',
    childReliefPercentage: 100,
    ...over,
  });

  it('counts only ELIGIBLE children, by the one eligibility rule the auto head count uses', () => {
    const asOf = new Date('2026-06-01T00:00:00+08:00');
    const r = childReliefGridFromFamily(
      [
        child(),
        child({ isDeceased: true }),
        child({ archivedAt: new Date() }),
        child({ relationship: 'spouse' }),
        child({ childTaxRelief: false }),
      ],
      asOf,
    );
    expect(r.eligible).toBe(1);
    expect(r.categorised).toBe(1);
    expect(r.grid).toEqual({ under_18: { full: 1, half: 0 } });
  });

  it('a 50% share lands in the half column and is worth exactly half that category', () => {
    const asOf = new Date('2026-06-01T00:00:00+08:00');
    const r = childReliefGridFromFamily([child({ childReliefPercentage: 50 })], asOf);
    expect(r.grid).toEqual({ under_18: { full: 0, half: 1 } });
    expect(childReliefAmountFor(r.grid, RELIEFS)).toBeCloseTo(RELIEFS.childByCategory!.under_18 / 2, 2);
  });

  it('a child with NO recorded category is counted as eligible but contributes nothing, and is reported', () => {
    const asOf = new Date('2026-06-01T00:00:00+08:00');
    const r = childReliefGridFromFamily([child(), child({ childReliefCategory: null })], asOf);
    expect(r.eligible).toBe(2);
    // The suggestion covers one of two — the screen says so rather than understating the relief in silence.
    expect(r.categorised).toBe(1);
    expect(childReliefAmountFor(r.grid, RELIEFS)).toBeCloseTo(RELIEFS.childByCategory!.under_18, 2);
  });

  it('an unrecorded share counts as the FULL claim, which is the default and not an invention', () => {
    const asOf = new Date('2026-06-01T00:00:00+08:00');
    const r = childReliefGridFromFamily([child({ childReliefPercentage: null })], asOf);
    expect(r.grid).toEqual({ under_18: { full: 1, half: 0 } });
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// THE REPORT, against the real database — and the two KERNEL gates it is a report ABOUT.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('99b2d6c0 · the report and the kernel gates, against a real database', () => {
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

  const hire = (ctx: SessionContext, name: string) =>
    hireEmployee(ctx, {
      person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });

  const slip = async (employmentId: string) => {
    const rows = await owner.db
      .select()
      .from(payslipTable)
      .where(and(eq(payslipTable.tenantId, base.tenantId), eq(payslipTable.employmentId, employmentId)));
    expect(rows.length, 'exactly one payslip for this employment').toBe(1);
    return rows[0];
  };

  it('refuses a caller who is not an admin — the service boundary, not only the page guard', async () => {
    const notAdmin: SessionContext = { ...adminCtx(base), roles: ['employee'] };
    await expect(childReliefReview(notAdmin)).rejects.toBeInstanceOf(ChildReliefReviewAccessError);
  });

  it('lists only people with children or a grid, in name order, with the today / switch / change figures', async () => {
    const a = adminCtx(base);
    const flat = await hire(a, 'Aaa Flat');
    const table = await hire(a, 'Bbb Table');
    const childless = await hire(a, 'Ccc Childless');
    await setStatutoryProfileMY(a, { personId: flat.personId, icNumber: '900101010101' });
    await setStatutoryProfileMY(a, { personId: table.personId, icNumber: '900101010102' });
    await setStatutoryProfileMY(a, { personId: childless.personId, icNumber: '900101010103' });
    await setTaxProfileMY(a, { personId: flat.personId, childReliefMode: 'manual', numChildren: 2 });
    await setTaxProfileMY(a, {
      personId: table.personId,
      childReliefMode: 'auto_table',
      numChildren: 1,
      childReliefTable: { study_tertiary: { full: 1, half: 0 } },
    });
    await setTaxProfileMY(a, { personId: childless.personId, childReliefMode: 'manual', numChildren: 0 });

    const view = await childReliefReview(a);
    expect(view.people.map((p) => p.name)).toEqual(['Aaa Flat', 'Bbb Table']);

    const flatRow = view.people.find((p) => p.name === 'Aaa Flat')!;
    expect(flatRow.todayRM).toBeCloseTo(2 * RELIEFS.perChild, 2);
    // ⚠️ The finding: this person has no grid, so switching them would claim NOTHING.
    expect(flatRow.gridKeyed).toBe(false);
    expect(flatRow.switchRM).toBeCloseTo(0, 2);
    expect(flatRow.deltaRM).toBeCloseTo(-2 * RELIEFS.perChild, 2);

    const tableRow = view.people.find((p) => p.name === 'Bbb Table')!;
    expect(tableRow.todayRM).toBeCloseTo(RELIEFS.childByCategory!.study_tertiary, 2);
    expect(tableRow.switchRM).toBeCloseTo(tableRow.todayRM, 2);
    expect(tableRow.deltaRM).toBeCloseTo(0, 2);

    expect(view.totals.people).toBe(2);
    expect(view.totals.children).toBe(3);
    expect(view.totals.todayRM).toBeCloseTo(2 * RELIEFS.perChild + RELIEFS.childByCategory!.study_tertiary, 2);
    expect(view.totals.deltaRM).toBeCloseTo(-2 * RELIEFS.perChild, 2);
    // The version that priced it is the ruleset's own stamp — this screen adds no second year marker.
    expect(view.statutoryVersion).toBe(DEFAULT_MY_STATUTORY.version);
    expect(view.perChild).toBeCloseTo(RELIEFS.perChild, 2);
  });

  it('derives the Family-register suggestion from the categories recorded against each child', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Ddd Family');
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101010104' });
    await addDependent(a, {
      personId: e.personId,
      fullName: 'Older',
      relationship: 'child',
      dateOfBirth: '2005-03-03',
      isStudent: true,
      childReliefCategory: 'study_tertiary',
      childReliefPercentage: 100,
    });
    await addDependent(a, {
      personId: e.personId,
      fullName: 'Younger',
      relationship: 'child',
      dateOfBirth: '2018-03-03',
      childReliefCategory: null,
    });
    await setTaxProfileMY(a, { personId: e.personId, childReliefMode: 'manual', numChildren: 2 });

    const view = await childReliefReview(a);
    const row = view.people.find((p) => p.name === 'Ddd Family')!;
    expect(row.familyEligible).toBe(2);
    expect(row.familyCategorised).toBe(1);
    expect(row.familyRM).toBeCloseTo(RELIEFS.childByCategory!.study_tertiary, 2);
    // And the suggestion changed NOTHING: what PCB deducts today is still the flat arithmetic.
    expect(row.todayRM).toBeCloseTo(2 * RELIEFS.perChild, 2);
  });

  it('reports one ROW per person, not one per job, so the ringgit total is not double counted', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Eee Twojobs');
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101010105' });
    await setTaxProfileMY(a, { personId: e.personId, childReliefMode: 'manual', numChildren: 2 });
    // A SECOND employment for the same person — the supported shape, not a duplicate.
    await hireEmployee(a, {
      person: { id: e.personId },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'part_time',
      hiredOn: '2026-02-01',
    });

    const view = await childReliefReview(a);
    const rows = view.people.filter((p) => p.name === 'Eee Twojobs');
    expect(rows.length, 'one person, one tax position, one row').toBe(1);
    expect(rows[0].jobs.length, 'both jobs listed, so either record reaches the grid').toBe(2);
    expect(view.totals.todayRM).toBeCloseTo(2 * RELIEFS.perChild, 2);
  });

  it('an empty population reports an honest zero rather than an invented figure', async () => {
    const a = adminCtx(base);
    const view = await childReliefReview(a);
    expect(view.people).toEqual([]);
    expect(view.totals).toEqual({ people: 0, children: 0, todayRM: 0, switchRM: 0, deltaRM: 0 });
    expect(view.perChild).toBeNull();
  });

  // ─── THE KERNEL GATE ON THE PAYSLIP (core/payroll.ts). Unpinned before this file. ────────────────
  it('an auto_table employee’s PAYSLIP prices their child by category; a manual colleague is unmoved', async () => {
    const a = adminCtx(base);
    const flat = await hire(a, 'Pcb Flat');
    const table = await hire(a, 'Pcb Table');
    for (const emp of [flat, table]) {
      await setCompensation(a, {
        employmentId: emp.employmentId,
        basicSalary: 12000,
        monthlyAllowance: 0,
        effectiveFrom: '2026-01-01',
      });
    }
    await setStatutoryProfileMY(a, { personId: flat.personId, icNumber: '900101010106' });
    await setStatutoryProfileMY(a, { personId: table.personId, icNumber: '900101010107' });
    await setTaxProfileMY(a, { personId: flat.personId, childReliefMode: 'manual', numChildren: 1 });
    await setTaxProfileMY(a, {
      personId: table.personId,
      childReliefMode: 'auto_table',
      numChildren: 1,
      childReliefTable: { study_tertiary: { full: 1, half: 0 } },
    });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const metaFlat = ((await slip(flat.employmentId)).statutory as { pcbMeta: { P1: number; reliefs: { children: number } } })
      .pcbMeta;
    const metaTable = ((await slip(table.employmentId)).statutory as { pcbMeta: { P1: number; reliefs: { children: number } } })
      .pcbMeta;
    // The child leg the slip itself recorded — the mode read, visible on the document.
    expect(metaFlat.reliefs.children).toBeCloseTo(1 * RELIEFS.perChild, 2);
    expect(metaTable.reliefs.children, 'the auto_table employee must be priced by CATEGORY').toBeCloseTo(
      RELIEFS.childByCategory!.study_tertiary,
      2,
    );
    // And P moves by exactly the difference between the two ruleset figures — nothing else changed.
    expect(metaFlat.P1 - metaTable.P1).toBeCloseTo(
      RELIEFS.childByCategory!.study_tertiary - RELIEFS.perChild,
      2,
    );
  });

  // ─── THE KERNEL GATE ON THE PCB DRILL-DOWN (core/payroll-view.ts). Unpinned before this file. ────
  it('currentPcbReliefs reads the mode too — the drill-down cannot disagree with the payslip', async () => {
    const a = adminCtx(base);
    const flat = await hire(a, 'Drill Flat');
    const table = await hire(a, 'Drill Table');
    await setStatutoryProfileMY(a, { personId: flat.personId, icNumber: '900101010108' });
    await setStatutoryProfileMY(a, { personId: table.personId, icNumber: '900101010109' });
    await setTaxProfileMY(a, { personId: flat.personId, childReliefMode: 'manual', numChildren: 1 });
    await setTaxProfileMY(a, {
      personId: table.personId,
      childReliefMode: 'auto_table',
      numChildren: 1,
      childReliefTable: { study_tertiary: { full: 1, half: 0 } },
    });

    const asOf = '2026-05-31';
    const flatView = await currentPcbReliefs(a, {
      companyIds: [base.companyId],
      employmentId: flat.employmentId,
      asOf,
    });
    const tableView = await currentPcbReliefs(a, {
      companyIds: [base.companyId],
      employmentId: table.employmentId,
      asOf,
    });
    expect(flatView?.children).toBeCloseTo(1 * RELIEFS.perChild, 2);
    expect(tableView?.children, 'the drill-down must price auto_table by CATEGORY').toBeCloseTo(
      RELIEFS.childByCategory!.study_tertiary,
      2,
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// i18n — present in all six, and DISTINCT, because i18n/request.ts deep-merges each locale over English
// so a missing key renders ENGLISH rather than MISSING_MESSAGE. Presence alone proves nothing.
// ══════════════════════════════════════════════════════════════════════════════════════════════════
describe('99b2d6c0 · i18n across all six locales', () => {
  /** Every key the screen and its table render, including the five dynamic category keys. */
  const KEYS = [
    'title',
    'description',
    'backToPersonnel',
    'howToReadTitle',
    'howToReadToday',
    'howToReadSwitch',
    'howToReadFamily',
    'howToReadNothingChanges',
    'statPeople',
    'statChildren',
    'statTodayRM',
    'statSwitchRM',
    'statDeltaRM',
    'activeOnlyNote',
    'amountsTitle',
    'pricedBy',
    'amountPerChild',
    'amountsPendingSignOff',
    'colEmployee',
    'colMode',
    'colChildren',
    'colToday',
    'colSwitch',
    'colChange',
    'colFamily',
    'modeManual',
    'modeAuto',
    'modeAutoTable',
    'alreadyOnTable',
    'gridEmptyWarning',
    'familyNone',
    'familyPartial',
    'openRecord',
    'emptyTitle',
    'emptyBody',
    'shareNote',
    ...CHILD_RELIEF_CATEGORY_KEYS.map((k) => `cat_${k}`),
  ];

  const catalog = (loc: string) => JSON.parse(readFileSync(`${root}messages/${loc}.json`, 'utf8'));

  it.each(LOCALES)('%s carries every key this screen renders', (loc) => {
    const m = catalog(loc);
    for (const k of KEYS) expect(m.people.childRelief[k], `people.childRelief.${k}`).toBeTruthy();
    expect(m.people.list.childReliefReview, 'people.list.childReliefReview').toBeTruthy();
    expect(m.people.detail.childReliefModeAutoTableHint, 'people.detail.childReliefModeAutoTableHint').toBeTruthy();
    expect(m.admin.users.screen.childReliefReview, 'admin.users.screen.childReliefReview').toBeTruthy();
    expect(m.admin.users.scope.childReliefReview, 'admin.users.scope.childReliefReview').toBeTruthy();
  });

  it('every sentence-bearing string is DISTINCT across the six — a locale that merely inherits English fails', () => {
    const catalogs = Object.fromEntries(LOCALES.map((l) => [l, catalog(l)]));
    // The column headers and short labels are excluded: "RM" and a one-word noun can legitimately
    // coincide. Every SENTENCE below is prose, and six identical sentences means an untranslated locale.
    const PROSE = [
      'title',
      'description',
      'howToReadTitle',
      'howToReadToday',
      'howToReadSwitch',
      'howToReadFamily',
      'howToReadNothingChanges',
      'activeOnlyNote',
      'amountsTitle',
      'amountsPendingSignOff',
      'gridEmptyWarning',
      'emptyTitle',
      'emptyBody',
      'shareNote',
      'alreadyOnTable',
      'familyNone',
      'openRecord',
    ];
    for (const k of PROSE) {
      const values = LOCALES.map((l) => catalogs[l].people.childRelief[k] as string);
      expect(new Set(values).size, `people.childRelief.${k} is identical in ${LOCALES.length} locales`).toBe(
        LOCALES.length,
      );
    }
    for (const [ns, key] of [
      ['list', 'childReliefReview'],
      ['detail', 'childReliefModeAutoTableHint'],
    ] as const) {
      const values = LOCALES.map((l) => catalogs[l].people[ns][key] as string);
      expect(new Set(values).size, `people.${ns}.${key} is identical across locales`).toBe(LOCALES.length);
    }
    for (const path of ['screen', 'scope'] as const) {
      const values = LOCALES.map((l) => catalogs[l].admin.users[path].childReliefReview as string);
      expect(new Set(values).size, `admin.users.${path}.childReliefReview is identical`).toBe(LOCALES.length);
    }
  });
});
