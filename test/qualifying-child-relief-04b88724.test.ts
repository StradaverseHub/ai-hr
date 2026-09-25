/**
 * 04b88724 — PHYSICAL CHILDREN vs QUALIFYING CHILDREN (PCB).
 *
 * The reporter contested the previous round and they were right: LHDN's 2026 computerised-calculation slip
 * prints the per-child RATE and the qualifying-children COUNT as two separate lines, and in the
 * specification's own worked example two children give a count of NINE. `num_children` is a head count —
 * Form E, CP8D and the EA statement all read it — and the screen was showing it under a caption that
 * implied it was also the figure the tax calculation counts in. For 71 of the reporter's 75 employees it is
 * a number somebody typed.
 *
 * `qualifyingChildReliefFor` is what the screen now reads. THE ONE PROPERTY THAT MATTERS HERE is that the
 * count it reports cannot disagree with the money on the payslip, because it is not computed
 * independently — it is the kernel's own ringgit figure divided by the ruleset's per-child rate. So every
 * assertion below compares against the pack function the kernel itself calls
 * (`childReliefAmountFor`, core/payroll.ts ~5625 / core/payroll-view.ts ~1487), never against an
 * expectation this file works out for itself.
 *
 * NOTHING HERE WRITES A PCB FIGURE OR CHANGES ONE. The item surfaces what the kernel already computes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';
import { childReliefAmountFor } from '../localization/my/payroll';
import { setStatutoryProfileMY, setTaxProfileMY } from '../localization/my/statutory';
import { addDependent, qualifyingChildReliefFor } from '../core/dependents';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

/** The built-in reliefs, as the kernel resolves them when a company has overridden nothing. */
const RELIEFS = DEFAULT_MY_STATUTORY.pcb.reliefs;
/** The PACK's figure for a grid — the same call, with the same arguments, the kernel makes. */
const kernelRM = (grid: unknown) => childReliefAmountFor(grid, RELIEFS);

/** Fixed so nothing here depends on the day it runs; ages below are taken against it. */
const ASOF = '2026-06-30';

let base: Base;

/** A hire with an IC already on file: `setTaxProfileMY` refuses to write tax details before one exists
 *  (NoIcYetError), so every fixture below needs the statutory row seeded first. */
let icSeq = 0;
async function hire(name: string) {
  const e = await hireEmployee(adminCtx(base), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}_${randomUUID().slice(0, 8)}@t.local` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  icSeq += 1;
  await setStatutoryProfileMY(adminCtx(base), {
    personId: e.personId,
    icNumber: `9001010${String(100000 + icSeq).slice(-5)}`,
  });
  return e;
}

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

describe("04b88724 · the qualifying count is the KERNEL's ringgit ÷ the ruleset's rate", () => {
  it("auto_table: the reporter's own worked example — one child under 18 plus one disabled child in higher education is NINE qualifying children, not two", async () => {
    const E = await hire('WorkedExample');
    const grid = { under_18: { full: 1, half: 0 }, disabled_study: { full: 1, half: 0 } };
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      // The HEAD count stays two. That is the whole point of the split: Form E still reads two people.
      numChildren: 2,
      childReliefMode: 'auto_table',
      childReliefTable: grid,
    });

    const q = await qualifyingChildReliefFor(adminCtx(base), { personId: E.personId, asOf: ASOF });
    expect(q).not.toBeNull();
    expect(q!.physicalChildren, 'num_children must keep meaning the head count').toBe(2);
    expect(q!.qualifyingChildren, 'two children, nine qualifying children — LHDN s.48 worked example').toBe(9);
    // …and the count is the kernel's money divided by the kernel's rate, not a second arithmetic.
    expect(q!.reliefRM).toBeCloseTo(kernelRM(grid), 2);
    expect(q!.qualifyingChildren * q!.perChild).toBeCloseTo(q!.reliefRM, 2);
    expect(q!.derived).toBe(true);
    expect(q!.mode).toBe('auto_table');
  });

  it('auto_table: every single category reports the count the ruleset prices it at', async () => {
    // Priced ENTIRELY from the ruleset: amount ÷ perChild. Nothing below spells 1, 4 or 8 by hand, so a
    // future correction to childByCategory moves the expectation with it instead of breaking this file.
    for (const key of ['under_18', 'study_preu', 'study_tertiary', 'disabled', 'disabled_study'] as const) {
      const E = await hire(`Cat${key}`);
      const grid = { [key]: { full: 1, half: 0 } };
      await setTaxProfileMY(adminCtx(base), {
        personId: E.personId,
        numChildren: 1,
        childReliefMode: 'auto_table',
        childReliefTable: grid,
      });
      const q = await qualifyingChildReliefFor(adminCtx(base), { personId: E.personId, asOf: ASOF });
      expect(q!.reliefRM, `${key}: must be the pack's own figure`).toBeCloseTo(kernelRM(grid), 2);
      expect(q!.qualifyingChildren, `${key}: count must be that figure ÷ perChild`).toBeCloseTo(
        kernelRM(grid) / RELIEFS.perChild,
        6,
      );
      // One head, several qualifying children — the distinction the item exists to make visible.
      expect(q!.physicalChildren).toBe(1);
    }
  });

  it('auto_table: a 50%-SHARED child is worth HALF its category — in ringgit and in the count, unrounded', async () => {
    const E = await hire('HalfShare');
    const grid = { under_18: { full: 0, half: 1 } };
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      numChildren: 1,
      childReliefMode: 'auto_table',
      childReliefTable: grid,
    });
    const q = await qualifyingChildReliefFor(adminCtx(base), { personId: E.personId, asOf: ASOF });
    expect(q!.reliefRM).toBeCloseTo(kernelRM(grid), 2);
    expect(q!.reliefRM).toBeCloseTo(RELIEFS.perChild / 2, 2);
    // HALF A QUALIFYING CHILD, deliberately not rounded: rounding here would make the count disagree with
    // the money beside it, and the money is what the payslip deducts. See core/dependents.ts for what is
    // and is not known about LHDN's intent on a shared claim.
    expect(q!.qualifyingChildren).toBeCloseTo(0.5, 6);
    expect(q!.qualifyingChildren * q!.perChild).toBeCloseTo(q!.reliefRM, 2);
  });

  it('auto_table with NOTHING keyed claims nothing — the count follows the money to zero, it does not fall back to the head count', async () => {
    const E = await hire('EmptyGrid');
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      numChildren: 3,
      childReliefMode: 'auto_table',
      childReliefTable: null,
    });
    const q = await qualifyingChildReliefFor(adminCtx(base), { personId: E.personId, asOf: ASOF });
    expect(q!.physicalChildren).toBe(3);
    expect(q!.reliefRM).toBeCloseTo(kernelRM(null), 2);
    expect(q!.qualifyingChildren, 'an unkeyed grid is an empty claim, not three flat children').toBe(0);
    expect(q!.breakdown, 'nothing keyed ⇒ nothing to show a line for').toEqual([]);
  });

  it('breakdown: one line per grid cell, split by claim share, and the lines add up to the total', async () => {
    const E = await hire('Breakdown');
    const grid = { under_18: { full: 2, half: 1 }, study_tertiary: { full: 1, half: 0 } };
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      numChildren: 4,
      childReliefMode: 'auto_table',
      childReliefTable: grid,
    });
    const q = await qualifyingChildReliefFor(adminCtx(base), { personId: E.personId, asOf: ASOF });
    expect(q!.breakdown.every((r) => r.kind === 'category')).toBe(true);
    // under_18 at 100%, under_18 at 50%, study_tertiary at 100% — three lines for two categories, because
    // "claimed in full or shared" has to be visible and not averaged away.
    expect(q!.breakdown.map((r) => [r.category, r.sharePercent, r.children])).toEqual([
      ['under_18', 100, 2],
      ['under_18', 50, 1],
      ['study_tertiary', 100, 1],
    ]);
    const sumUnits = q!.breakdown.reduce((s, r) => s + r.units, 0);
    const sumRM = q!.breakdown.reduce((s, r) => s + r.amountRM, 0);
    expect(sumUnits, 'the working must add up to the answer').toBeCloseTo(q!.qualifyingChildren, 6);
    expect(sumRM).toBeCloseTo(q!.reliefRM, 2);
    expect(sumRM).toBeCloseTo(kernelRM(grid), 2);
  });
});

describe('04b88724 · provenance — derived or typed, and never dressed up as the other', () => {
  it('manual is TYPED: derived=false, the qualifying count IS the typed head count, and there is no breakdown', async () => {
    const E = await hire('ManualTyped');
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      numChildren: 3,
      childReliefMode: 'manual',
      // A grid that would price at a COMPLETELY different figure if the mode were ignored.
      childReliefTable: { disabled_study: { full: 2, half: 0 } },
    });
    const q = await qualifyingChildReliefFor(adminCtx(base), { personId: E.personId, asOf: ASOF });
    expect(q!.mode).toBe('manual');
    expect(q!.derived, 'manual is entered by hand — the screen must be able to say so').toBe(false);
    expect(q!.physicalChildren).toBe(3);
    // The kernel's manual-mode child leg is `num_children × perChild`; the count follows it, not the grid.
    expect(q!.reliefRM).toBeCloseTo(3 * RELIEFS.perChild, 2);
    expect(q!.qualifyingChildren).toBe(3);
    expect(q!.breakdown, 'a typed number has no working; a table under it would imply one').toEqual([]);
  });

  it('auto is DERIVED, and its lines are the CHILDREN, each worth one qualifying child — what that mode actually deducts', async () => {
    const E = await hire('AutoDerived');
    await addDependent(adminCtx(base), {
      personId: E.personId,
      fullName: 'Ain',
      relationship: 'child',
      dateOfBirth: '2016-03-04',
      childReliefCategory: 'under_18',
      childReliefPercentage: 100,
    });
    await addDependent(adminCtx(base), {
      personId: E.personId,
      fullName: 'Bala',
      relationship: 'child',
      dateOfBirth: '2005-01-02',
      isStudent: true,
      childTaxRelief: true,
      // Recorded as a tertiary student, which is worth FOUR in the category table…
      childReliefCategory: 'study_tertiary',
      childReliefPercentage: 50,
    });
    // …but this employee is on 'auto', where the mode is switched by the sync itself.
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      numChildren: 2,
      childReliefMode: 'auto',
      childReliefTable: null,
    });

    const q = await qualifyingChildReliefFor(adminCtx(base), { personId: E.personId, asOf: ASOF });
    expect(q!.mode).toBe('auto');
    expect(q!.derived).toBe(true);
    expect(q!.familyChildren, 'two child records on the Family register').toBe(2);
    // …and the deduction is STILL the flat two children, because that is what 'auto' mode's kernel
    // expression is. Reporting "five qualifying children" here would print a figure the payslip denies.
    expect(q!.reliefRM).toBeCloseTo(2 * RELIEFS.perChild, 2);
    expect(q!.qualifyingChildren).toBe(2);
    expect(q!.breakdown.map((r) => [r.kind, r.name, r.category, r.sharePercent, r.units])).toEqual([
      ['child', 'Bala', 'study_tertiary', 50, 1],
      ['child', 'Ain', 'under_18', 100, 1],
    ]);
    expect(
      q!.breakdown.reduce((s, r) => s + r.units, 0),
      'the per-child lines must add up to the figure shown',
    ).toBeCloseTo(q!.qualifyingChildren, 6);
  });

  it('uncategorised eligible children are reported, because a category-priced figure would silently omit them', async () => {
    const E = await hire('NoCategory');
    await addDependent(adminCtx(base), {
      personId: E.personId,
      fullName: 'Cindy',
      relationship: 'child',
      dateOfBirth: '2018-07-07',
      // No childReliefCategory at all — the production shape: 24 of 38 dependents carry one.
    });
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      numChildren: 1,
      childReliefMode: 'auto',
      childReliefTable: null,
    });
    const q = await qualifyingChildReliefFor(adminCtx(base), { personId: E.personId, asOf: ASOF });
    expect(q!.uncategorisedChildren).toBe(1);
    expect(q!.familyRows.map((r) => [r.name, r.category, r.sharePercent])).toEqual([['Cindy', null, 100]]);
  });

  it('the ruleset that priced the figure is named, and the per-category prices travel with it', async () => {
    const E = await hire('Priced');
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      numChildren: 0,
      childReliefMode: 'auto_table',
      childReliefTable: null,
    });
    const q = await qualifyingChildReliefFor(adminCtx(base), { personId: E.personId, asOf: ASOF });
    expect(q!.perChild).toBe(RELIEFS.perChild);
    expect(q!.statutoryVersion, 'a reader must be able to tell which schedule priced this').toBeTruthy();
    // Every category the ruleset prices, with its units = ringgit ÷ perChild. This is what the screen
    // multiplies by the counts the admin keys, so the statutory rule stays in the pack.
    expect(q!.categories.map((c) => c.key)).toEqual([
      'under_18',
      'study_preu',
      'study_tertiary',
      'disabled',
      'disabled_study',
    ]);
    for (const c of q!.categories) {
      expect(c.amountRM).toBe(RELIEFS.childByCategory![c.key]);
      expect(c.units).toBeCloseTo(c.amountRM / RELIEFS.perChild, 6);
    }
  });

  it('a person with no statutory row reports nothing rather than a zero that looks like a figure', async () => {
    // Hired WITHOUT the setStatutoryProfileMY the fixture helper does, so employee_statutory_my is absent.
    const E = await hireEmployee(adminCtx(base), {
      person: { fullName: 'NoStatutoryRow', primaryEmail: `nosr_${randomUUID().slice(0, 8)}@t.local` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    expect(await qualifyingChildReliefFor(adminCtx(base), { personId: E.personId, asOf: ASOF })).toBeNull();
  });
});
