/**
 * r353 · item fda53352 point 1 — EA ITEM 8, "Number of children qualified for tax relief", PER MODE.
 *
 * THE COMPLAINT WAS MODE-DEPENDENT AND r351 ANSWERED FOR ONE MODE. r351 told the reporter that A.8 is
 * "correct as a count", which is true of `child_relief_mode = 'auto'` — `syncChildReliefFromFamily` writes
 * `eligibleChildReliefCount` into `num_children`, so the column IS the qualifying head count. It was never
 * checked for the other two modes, and on 'auto_table' it is wrong: the PCB calculation prices the KEYED
 * s.48 grid (`pricesChildReliefFromGrid`, core/dependents.ts) while `num_children` is a separate stored
 * figure that only a save of the Identification & Tax card keys level with it. So a corrected grid could
 * drive the payslip while item 8 printed a stale hand-keyed number, and D.6 — the ringgit, which r351
 * wired to the kernel's own `pcbMeta.reliefs.children` — could contradict the count printed above it.
 *
 * ⚠️ WHAT THIS DOES NOT DO, AND WHY. The approved plan's build note said to widen
 * `syncChildReliefFromFamily`'s rail-(a) gate from `!== 'auto'` to include 'auto_table', "its grid already
 * derives". It does not: that sync writes `childReliefTable: state.grid` DERIVED FROM THE FAMILY REGISTER
 * and hardcodes `childReliefMode: 'auto'`, while core/dependents.ts records that 'auto_table' "keeps the
 * KEYED grid, because that mode exists precisely for the case where the employee's DECLARED relief differs
 * from what the Family tab holds and there is no register behind it to re-derive from". Widening that gate
 * would have overwritten a declared grid with the register's and silently moved the employee out of
 * 'auto_table' — real tax, on the rail that exists to stop exactly that. The fix is a READ instead, so
 * nothing is written and the stale-ness is structurally impossible rather than merely re-synced.
 *
 * ⚠️ A HEAD COUNT IN EVERY MODE. `childReliefTableHeadCount` sums the grid's per-category COUNTS of
 * children, never their s.48 units: one disabled child in higher education is ONE child on this box and
 * EIGHT qualifying units in the relief amount. The weighted figure is computed below from the PACK's own
 * prices rather than typed, and asserted ABSENT — printing it here would declare that employee as having
 * eight children (core/dependents.ts `eligibleChildReliefCount`, and r343's decision).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setStatutoryProfileMY, setTaxProfileMY } from '../localization/my/statutory';
import { childReliefTableHeadCount, DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';
import { childReliefPrices } from '../localization/my/child-relief';
import { employeeEaStatement } from '../core/reporting';

/** The s.48 weight the resolved ruleset gives a category — read off the pack, never typed. */
const unitsOf = (key: string) => childReliefPrices(DEFAULT_MY_STATUTORY.pcb.reliefs).find((p) => p.key === key)!.units;

/** One eligible child under 18 and one disabled child in higher education: TWO children, many units. */
const GRID = { under_18: { full: 1, half: 0 }, disabled_study: { full: 1, half: 0 } };

describe('r353 · EA item 8 reads the source its child-relief mode makes authoritative', () => {
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

  /** An employee with an IC (which seeds the statutory row) and nothing else this box depends on. */
  async function hire(email: string) {
    const a = adminCtx(base);
    const E = await hireEmployee(a, {
      person: { fullName: 'Child Count', primaryEmail: email },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '900101015555', taxCategory: 3, numChildren: 0 });
    return E;
  }

  const item8 = async (employmentId: string) =>
    (await employeeEaStatement(adminCtx(base), { employmentId, year: '2026' }))!.employee.children;

  it("'manual' — the typed figure is printed, and nothing overwrites it", async () => {
    // Rail (a) exists so a human keeps control of their own tax figure; 71 of 75 employees on production
    // are on this mode, so it is the common case and not the edge.
    const E = await hire('manual@acme.test');
    await setTaxProfileMY(adminCtx(base), { personId: E.personId, childReliefMode: 'manual', numChildren: 3 });
    expect(await item8(E.employmentId)).toBe(3);
  });

  it("'auto' — the synced eligible head count is printed (r351's ruling, and it still stands)", async () => {
    const E = await hire('auto@acme.test');
    await setTaxProfileMY(adminCtx(base), { personId: E.personId, childReliefMode: 'auto', numChildren: 2 });
    expect(await item8(E.employmentId)).toBe(2);
  });

  it("⚠️ 'auto_table' — the KEYED grid decides, not the stale stored count", async () => {
    const E = await hire('table@acme.test');
    // num_children says 5 and the grid claims relief for TWO children: exactly the disagreement the
    // reporter saw, and the state a grid edited without a save of the tax card leaves behind.
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      childReliefMode: 'auto_table',
      numChildren: 5,
      childReliefTable: GRID,
    });
    const printed = await item8(E.employmentId);
    expect(printed, 'item 8 is still printing the stale stored head count').toBe(2);
    expect(printed, 'item 8 is printing the s.48 WEIGHTED figure as a count').not.toBe(
      unitsOf('under_18') + unitsOf('disabled_study'),
    );
    // The helper and the form agree, so the box cannot drift from the grid it reports.
    expect(childReliefTableHeadCount(GRID)).toBe(2);
    // …and the weighting really is the trap this avoids: those two children are worth many more units.
    expect(unitsOf('under_18') + unitsOf('disabled_study')).toBeGreaterThan(2);
  });

  it("'auto_table' with no grid keyed prints 0, because that is what the calculation relieved", async () => {
    // `pricesChildReliefFromGrid` returns true for 'auto_table' unconditionally, so an unkeyed grid claims
    // NO child relief and the employee's PCB was computed with none. Falling back to `num_children` here
    // would print a count above a D.6 of nothing — two contradictory answers on one statutory page.
    const E = await hire('emptytable@acme.test');
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      childReliefMode: 'auto_table',
      numChildren: 4,
      childReliefTable: null,
    });
    expect(await item8(E.employmentId)).toBe(0);
  });

  it('a half-share child is still ONE child on this box', async () => {
    // The grid's `half` column is a child whose relief is SHARED with the other parent — half the ringgit,
    // one whole child. Counting it as 0.5 would print a fraction in a box ruled for a number of people.
    const E = await hire('half@acme.test');
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      childReliefMode: 'auto_table',
      numChildren: 0,
      childReliefTable: { under_18: { full: 1, half: 2 } },
    });
    expect(await item8(E.employmentId)).toBe(3);
  });
});
