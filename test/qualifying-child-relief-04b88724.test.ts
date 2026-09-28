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
 * `qualifyingChildReliefFor` is what the Personnel screen reads. THE ONE PROPERTY THAT MATTERS HERE is that
 * the count it reports cannot disagree with the money on the payslip, because the two are not computed
 * independently — they are two fields of ONE pack call, `pack.payroll.childReliefFor`, whose `.amountRM` is
 * literally what `pack.payroll.childReliefAmountFor` returns (localization/my/child-relief.ts). So every
 * assertion below compares against the pack function the kernel itself calls (`childReliefAmountFor`,
 * core/payroll.ts ~5625 / core/payroll-view.ts ~1487), never against an expectation this file works out for
 * itself.
 *
 * r340 fix pass — what this file could NOT see, and now does not have to: the figures it proves here were
 * for a while proved for a function THE SCREEN DID NOT READ. The card had its own copy of the arithmetic and
 * under-stated the relief. The screen's own figures are pinned against the kernel in
 * test/identity-tax-qualifying-children-04b88724.dom.test.tsx; this file pins the server's.
 *
 * NOTHING HERE WRITES A PCB FIGURE OR CHANGES ONE. The item surfaces what the kernel already computes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';
import { childReliefAmountFor } from '../localization/my/payroll';
import { setStatutoryProfileMY, setTaxProfileMY } from '../localization/my/statutory';
import {
  addDependent,
  eligibleChildReliefCount,
  listDependents,
  qualifyingChildReliefFor,
} from '../core/dependents';
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
    /**
     * ⚠️ r351 REVERSED THIS ASSERTION, AND THE PAIR IS THE POINT.
     *
     * It used to read "the deduction is STILL the flat two children, because that is what 'auto' mode's
     * kernel expression is", pinning `reliefRM` at 2 × perChild. That was the DEFECT the reporter
     * reported: both children here are classified, so the register supports Ain (under_18, 1 unit) plus
     * Bala (study_tertiary, 4 units at a 50% share = 2) = 3 units = RM6,000, and the card was printing
     * the stored head count instead.
     *
     * The card now shows the REGISTER's figure. What has NOT moved is the payslip: `core/payroll.ts`
     * still prices from the stored columns, so `storedReliefRM` is still 2 × perChild. r351 deliberately
     * did not move the kernel — that is a three-consumer money change and this repo already split this
     * item once for exactly that reason (r343 the card, a5f21891/r344 the payslip).
     *
     * So the assertion is the PAIR, in both directions: the box shows what the records support, the
     * amber line names what payroll will actually deduct, and neither figure can be hidden.
     */
    expect(q!.reliefRM, 'the register supports 3 units').toBeCloseTo(3 * RELIEFS.perChild, 2);
    expect(q!.qualifyingChildren).toBe(3);
    expect(q!.storedReliefRM, 'but the payslip still deducts the stored head count').toBeCloseTo(
      2 * RELIEFS.perChild,
      2,
    );
    expect(q!.storedQualifyingChildren).toBe(2);
    expect(q!.reliefRM, 'and the two must differ here, or this case proves nothing').not.toBeCloseTo(
      q!.storedReliefRM,
      2,
    );
    expect(q!.breakdown.map((r) => [r.kind, r.name, r.category, r.sharePercent, r.units])).toEqual([
      ['child', 'Bala', 'study_tertiary', 50, 2],
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
    expect(q!.breakdown.map((r) => [r.name, r.category, r.sharePercent])).toEqual([['Cindy', null, 100]]);
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

/* ══════════════════════════════════════════════════════════════════════════════════════════════════════
 * r340 FIX PASS → r351 REVERSAL — THE STORED FIGURE, THE FAMILY REGISTER, AND ONE INSTANT
 *
 * The r340 blocking defect was not in the arithmetic: it was in WHICH NUMBER the screen multiplied. The
 * screen worked the relief out from its own count of eligible children while the payslip multiplied the
 * STORED `num_children`, and printed a figure RM2,000 short of the payslip with nothing saying so. r340
 * settled that by making this function report the STORED figure, and the case below pinned it.
 *
 * ⚠️ r351 REVERSES WHICH FIGURE IS REPORTED, AND KEEPS THE RULE THAT r340 WAS ENFORCING. Reporting the
 * stored column made the screen agree with the payslip, but it also meant the figure under the caption
 * "Qualifying children (PCB)" described a column that only an unrelated family edit ever moves —
 * `syncChildReliefFromFamily` fires on a family add / materialise / update / archive and a backfill script,
 * and on NOTHING ELSE. Nothing fires on the passage of time. A child who turned 18 and is not in further
 * education therefore stayed in the figure indefinitely; the Family tab, which recomputes eligibility on
 * every render, said the opposite about the same child; and the card's own working printed one row worth 1
 * under a total of 2.
 *
 * So the figure now follows the register as of `asOf`, and the r340 rule — never print a figure the kernel
 * contradicts without naming what the kernel does — is kept by returning BOTH: `reliefRM` is what the
 * records support and `storedReliefRM` is what payroll deducts until the record is saved. The card prints
 * the first and states the second in amber. One instant, one list, two disclosed figures.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════════ */
describe('04b88724 · the stored head count and the eligible children, from one instant', () => {
  it('a child who has aged out: the figure follows the REGISTER, and the stored figure payroll still uses is reported beside it', async () => {
    const E = await hire('AgedOut');
    // Eligible on ASOF (2026-06-30).
    await addDependent(adminCtx(base), {
      personId: E.personId,
      fullName: 'Young',
      relationship: 'child',
      dateOfBirth: '2016-04-01',
      childReliefCategory: 'under_18',
    });
    // 20 on ASOF, not a student, no explicit child-relief decision — aged out of the eligible count.
    await addDependent(adminCtx(base), {
      personId: E.personId,
      fullName: 'Grown',
      relationship: 'child',
      dateOfBirth: '2006-04-01',
    });
    // The stored head count still says two, because nothing rewrote it after the birthday.
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      numChildren: 2,
      childReliefMode: 'auto',
      childReliefTable: null,
    });

    const q = await qualifyingChildReliefFor(adminCtx(base), { personId: E.personId, asOf: ASOF });
    expect(q!.mode).toBe('auto');
    expect(q!.familyChildren, 'two children are on the Family register').toBe(2);
    expect(q!.eligibleChildren, 'but only one of them is eligible on this date').toBe(1);
    // `num_children` IS NOT REPURPOSED AND IS NOT REWRITTEN BY A READ. Form E, CP8D and the EA statement
    // read that column as a head count (r343), so it comes back exactly as stored — the birthday did not
    // touch it and neither does this function.
    expect(q!.physicalChildren, 'the stored head count is untouched by the birthday and by this read').toBe(2);

    // ── THE REVERSAL. The figure is the ONE eligible child, priced from the register's own category. ──
    // The surviving child carries `under_18`, so the derived grid is complete and the figure is priced by
    // category — which for that category is 1 unit, RM2,000. What it is NOT is the stored head count of 2.
    expect(q!.qualifyingChildren, 'one eligible child on this date, so one qualifying child').toBe(1);
    expect(q!.reliefRM).toBeCloseTo(kernelRM({ under_18: { full: 1, half: 0 } }), 2);
    expect(q!.pricedFromGrid, 'the register can be priced by category, so it is').toBe(true);
    expect(q!.derivedGrid, 'and the grid handed to the card is the register, not the stored column').toEqual({
      under_18: { full: 1, half: 0 },
    });

    // ── AND THE OTHER HALF, WHICH IS WHAT KEEPS r340's RULE. What payroll deducts TODAY, from the stored
    // columns, in the kernel's own expression: `num_children × perChild`, because no grid is stored. The
    // card is required to state this beside the figure above, so no screen prints one without the other.
    expect(q!.storedQualifyingChildren, 'payroll is still on the stored head count').toBe(2);
    expect(q!.storedReliefRM).toBeCloseTo(2 * RELIEFS.perChild, 2);

    // NON-VACUITY, IN THE DIRECTION THE REVERSAL RUNS. The two figures must be distinguishable or nothing
    // above is proved — and it is the pair, not either one, that this case exists to pin.
    expect(
      q!.reliefRM,
      'the register figure must differ from the stored one, or this fixture proves nothing',
    ).not.toBeCloseTo(q!.storedReliefRM, 2);
    expect(q!.reliefRM, 'and it is the eligible-child figure, not the stored one').toBeCloseTo(
      q!.eligibleChildren * RELIEFS.perChild,
      2,
    );

    // THE WORKING SUMS TO THE FIGURE PRINTED ABOVE IT. This is the defect the reporter could see: one row
    // worth 1 under a total of 2. Both now come from the same `eligible` list at the same date.
    expect(q!.breakdown.length, 'one line per eligible child').toBe(1);
    expect(q!.breakdown.reduce((s, r) => s + r.units, 0)).toBeCloseTo(q!.qualifyingChildren, 6);
    expect(q!.breakdown.reduce((s, r) => s + r.amountRM, 0)).toBeCloseTo(q!.reliefRM, 2);
  });

  it('a register whose children ALL aged out claims nothing, and says what payroll is still deducting', async () => {
    // The reporter's exact scenario, taken to its end: every child 18 or over and not in education. The
    // rules give no relief; the stored column still has payroll giving two children of it. Both facts have
    // to come back, because the screen has to print the first and disclose the second.
    const E = await hire('AllAgedOut');
    for (const [name, dob] of [
      ['GrownA', '2006-04-01'],
      ['GrownB', '2004-04-01'],
    ] as const) {
      await addDependent(adminCtx(base), {
        personId: E.personId,
        fullName: name,
        relationship: 'child',
        dateOfBirth: dob,
      });
    }
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      numChildren: 2,
      childReliefMode: 'auto',
      childReliefTable: null,
    });

    const q = await qualifyingChildReliefFor(adminCtx(base), { personId: E.personId, asOf: ASOF });
    expect(q!.familyChildren, 'the children ARE recorded — the retired message claimed they were not').toBe(2);
    expect(q!.eligibleChildren).toBe(0);
    expect(q!.qualifyingChildren, 'nothing the rules support').toBe(0);
    expect(q!.reliefRM).toBe(0);
    expect(q!.derivedGrid, 'no eligible children ⇒ no grid, rather than an empty one that prices at zero').toBeNull();
    expect(q!.pricedFromGrid, 'so the head-count branch decides, over ZERO eligible children').toBe(false);
    // …and the money that is nonetheless still going out, which the card must not deny.
    expect(q!.storedReliefRM).toBeCloseTo(2 * RELIEFS.perChild, 2);
    expect(q!.storedReliefRM, 'or this case cannot distinguish the two figures at all').toBeGreaterThan(0);
  });

  it('a child with NO date of birth is NAMED, not silently counted zero', async () => {
    const E = await hire('NoDob');
    await addDependent(adminCtx(base), {
      personId: E.personId,
      fullName: 'Undated Child',
      relationship: 'child',
      dateOfBirth: null,
    });
    await addDependent(adminCtx(base), {
      personId: E.personId,
      fullName: 'Dated Child',
      relationship: 'child',
      dateOfBirth: '2016-04-01',
      childReliefCategory: 'under_18',
    });
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      numChildren: 2,
      childReliefMode: 'auto',
      childReliefTable: null,
    });

    const q = await qualifyingChildReliefFor(adminCtx(base), { personId: E.personId, asOf: ASOF });
    expect(q!.familyChildren).toBe(2);
    expect(q!.eligibleChildren, 'an unconfirmable age is not eligible — that rule is unchanged').toBe(1);
    expect(
      q!.undatedChildren,
      'the name, because a count sends an administrator through the whole register to find which',
    ).toEqual(['Undated Child']);
  });

  it('…but a child recorded as a STUDENT with no date of birth is eligible, and is not reported as undated', async () => {
    // The eligibility rule makes a full-time student eligible at any age, so no date of birth is needed and
    // nothing is being dropped. Reporting that child as "not counted" would be the opposite of the truth.
    const E = await hire('StudentNoDob');
    await addDependent(adminCtx(base), {
      personId: E.personId,
      fullName: 'Student No Dob',
      relationship: 'child',
      dateOfBirth: null,
      isStudent: true,
    });
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      numChildren: 1,
      childReliefMode: 'auto',
      childReliefTable: null,
    });

    const q = await qualifyingChildReliefFor(adminCtx(base), { personId: E.personId, asOf: ASOF });
    expect(q!.eligibleChildren).toBe(1);
    expect(q!.undatedChildren, 'eligible without a date of birth ⇒ nothing was dropped').toEqual([]);
  });

  it('the date every figure was taken at is echoed back, so a screen can say which day it describes', async () => {
    const E = await hire('AsOfEcho');
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      numChildren: 0,
      childReliefMode: 'auto',
      childReliefTable: null,
    });
    const q = await qualifyingChildReliefFor(adminCtx(base), { personId: E.personId, asOf: ASOF });
    expect(q!.asOf).toBe(ASOF);
  });

  it("'manual' mode short-circuits exactly as before: the typed figure is reported, register untouched", async () => {
    // r351 changes the AUTO modes only. A manual record has nothing to derive from — locking its figure to a
    // register the admin has not opted into would move somebody's tax without being asked.
    const E = await hire('ManualUnmoved');
    await addDependent(adminCtx(base), {
      personId: E.personId,
      fullName: 'Grown',
      relationship: 'child',
      dateOfBirth: '2006-04-01',
    });
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      numChildren: 3,
      childReliefMode: 'manual',
      childReliefTable: null,
    });

    const q = await qualifyingChildReliefFor(adminCtx(base), { personId: E.personId, asOf: ASOF });
    expect(q!.mode).toBe('manual');
    expect(q!.qualifyingChildren, 'the number somebody typed, unchanged by the register').toBe(3);
    expect(q!.reliefRM).toBeCloseTo(3 * RELIEFS.perChild, 2);
    expect(q!.eligibleChildren, 'the register is still REPORTED — that is the disagreement the card shows').toBe(0);
    // In manual mode the two figures are one figure: there is no gap to disclose, so the card shows none.
    expect(q!.storedReliefRM).toBeCloseTo(q!.reliefRM, 2);
  });

  it('ONE INSTANT: the eligible count and the breakdown lines are the same list, filtered once', async () => {
    const E = await hire('OneInstant');
    // An 18th birthday exactly ON the date the figure is taken — the one day the eligibility rule turns on,
    // and the day two different instants used to give two different answers.
    await addDependent(adminCtx(base), {
      personId: E.personId,
      fullName: 'BirthdayToday',
      relationship: 'child',
      dateOfBirth: '2008-06-30',
    });
    await addDependent(adminCtx(base), {
      personId: E.personId,
      fullName: 'Small',
      relationship: 'child',
      dateOfBirth: '2019-02-02',
    });
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      numChildren: 2,
      childReliefMode: 'auto',
      childReliefTable: null,
    });
    const q = await qualifyingChildReliefFor(adminCtx(base), { personId: E.personId, asOf: ASOF });
    expect(
      q!.breakdown.length,
      'the screen shows this count in one box and these lines in the table below it; they must be the same list',
    ).toBe(q!.eligibleChildren);
    // …and it agrees with the helper the page used to call separately, AT THE SAME INSTANT. Called with the
    // real `new Date()` default instead, this is the assertion that would drift for eight hours a day.
    const rows = await listDependents(adminCtx(base), { personId: E.personId });
    expect(eligibleChildReliefCount(rows, new Date(`${ASOF}T00:00:00Z`))).toBe(q!.eligibleChildren);
  });

  it('manual mode still reports the eligible count, because the screen shows it as the disagreement', async () => {
    // The production shape: 71 of 75 employees on a typed figure. Nothing derives here, but the Family
    // register still holds children, and the whole point of the split screen is that you can see both.
    const E = await hire('ManualWithFamily');
    await addDependent(adminCtx(base), {
      personId: E.personId,
      fullName: 'Kid',
      relationship: 'child',
      dateOfBirth: '2017-05-05',
    });
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      numChildren: 5,
      childReliefMode: 'manual',
      childReliefTable: null,
    });
    const q = await qualifyingChildReliefFor(adminCtx(base), { personId: E.personId, asOf: ASOF });
    expect(q!.physicalChildren).toBe(5);
    expect(q!.eligibleChildren).toBe(1);
    expect(q!.reliefRM, 'the kernel multiplies the typed figure in manual mode').toBeCloseTo(
      5 * RELIEFS.perChild,
      2,
    );
    expect(q!.breakdown, 'a typed number has no working').toEqual([]);
  });
});
