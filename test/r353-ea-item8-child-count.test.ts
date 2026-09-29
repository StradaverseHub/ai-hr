/**
 * ⚠️⚠️ REVERSED IN r359 BY THE OWNER, AND BY LHDN'S OWN OUTPUT. READ THIS BEFORE THE BLOCK BELOW.
 *
 * Everything from "r353 · item fda53352 point 1" down to the end of this header was the previous
 * decision: that EA item 8 is a HEAD COUNT of children, resolved per child-relief mode. It is kept
 * verbatim because it was argued at length and a later reader has to see which way the decision went
 * (CLAUDE.md §8: a sentence pinning a decision you are reversing is updated, not deleted).
 *
 * WHAT OVERTURNED IT. The reporter contested r351's answer and then r353's, and the second contest
 * cited the agency's own formula letters. Checking them settles it against us:
 *
 *   PCB 2026 specification, printed p.10 — the variable list for P: "Q  Deduction for qualifying
 *   children" and "C  Number of qualifying children", with the formula carrying the term QC;
 *   printed p.11 — "Value of C = Number of qualifying children", restated per category;
 *   printed p.27 — the category table's OWN column heading: "Relief to be given AS IF THE EMPLOYEE HAS
 *   THIS NUMBER OF CHILDREN", 4 / 4 / 4 / 8.
 *
 * And then the reporter attached LHDN's own generated PCB Calculation Slip for the employee in
 * question (item bf3c9712), whose page 6 prints, in the agency's own document:
 *
 *   Q = Deduction for eligible children   2,000.00
 *   C = Number of eligible children       9.00
 *
 * for an employee with ONE child under 18 and ONE disabled child still studying — 1 + 8 = 9. So "the
 * number of qualifying children" IS the weighted figure, and A.8 asks for it in the same words.
 *
 * WHAT THE CASES BELOW NOW PIN. A.8 is C, derived from the relief the payroll run actually applied
 * (`pcbMeta.reliefs.children` over the ruleset's per-child figure), which is the same stamp D.6 prints
 * — so A.8 x RM2,000 === D.6 by construction. Two of the five answers are UNCHANGED (a mode with no
 * weighting gives the same number either way) and two are reversed; each says which it is. The sixth
 * case is new: no stamped relief means no A.8, because D.6 is absent then too.
 *
 * ── THE PREVIOUS DECISION, KEPT ─────────────────────────────────────────────────────────────────────
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
import { setCompensation } from '../core/comp';
import { createBatch, generatePayslips } from '../core/payroll';
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
    await setCompensation(a, { employmentId: E.employmentId, basicSalary: 8000, effectiveFrom: '2026-01-01' });
    return E;
  }

  /**
   * r359 — RUN THE PAYROLL, because A.8 is now derived from the relief the run applied rather than read
   * off a stored column. Before this round the fixtures needed no payroll at all: the box came straight
   * from `num_children` or the keyed grid, so a configured employee was enough. That is precisely what
   * changed — the box follows the money now, and a fixture with no money has nothing to follow.
   */
  async function payOneMonth(employmentId: string) {
    void employmentId;
    const batch = await createBatch(adminCtx(base), { companyId: base.companyId, payPeriod: '2026-01' });
    await generatePayslips(adminCtx(base), { batchId: batch.batchId });
  }

  const item8 = async (employmentId: string) =>
    (await employeeEaStatement(adminCtx(base), { employmentId, year: '2026' }))!.employee.children;

  it("'manual' — three typed children are three qualifying children (SAME answer, new source)", async () => {
    // Rail (a) exists so a human keeps control of their own tax figure; 71 of 75 employees on production
    // are on this mode, so it is the common case and not the edge. r359: the answer does not move here,
    // because a manual employee's relief is `num_children x perChild` and dividing it back by perChild
    // returns the count. What changed is WHERE the 3 comes from — the relief, not the column.
    const E = await hire('manual@acme.test');
    await setTaxProfileMY(adminCtx(base), { personId: E.personId, childReliefMode: 'manual', numChildren: 3 });
    await payOneMonth(E.employmentId);
    expect(await item8(E.employmentId)).toBe(3);
  });

  it("'auto' — two unweighted children are two qualifying children (SAME answer, new source)", async () => {
    // r351's ruling on this mode survives r359 by arithmetic rather than by exception: with no grid the
    // relief is 2 x perChild, so C comes back 2 either way.
    const E = await hire('auto@acme.test');
    await setTaxProfileMY(adminCtx(base), { personId: E.personId, childReliefMode: 'auto', numChildren: 2 });
    await payOneMonth(E.employmentId);
    expect(await item8(E.employmentId)).toBe(2);
  });

  /**
   * ⚠️ THE REVERSAL ITSELF, AND IT IS THE REPORTER'S OWN EMPLOYEE. This case read "'auto_table' — the
   * KEYED grid decides, not the stale stored count" and asserted:
   *
   *     expect(printed, 'item 8 is still printing the stale stored head count').toBe(2);
   *     expect(printed, 'item 8 is printing the s.48 WEIGHTED figure as a count')
   *       .not.toBe(unitsOf('under_18') + unitsOf('disabled_study'));
   *
   * — the head count 2, with the weighted figure asserted ABSENT. LHDN's own PCB Calculation Slip for
   * this exact shape (one child under 18, one disabled and still studying) prints "C = Number of
   * eligible children  9.00". The assertion that the weighted figure must NOT appear is now the
   * assertion that it MUST, and the two lines above are kept here so that is legible.
   */
  it("⚠️ 'auto_table' — C is the WEIGHTED figure, 9, not the two child records", async () => {
    const E = await hire('table@acme.test');
    // num_children says 5, the grid claims relief for two children, and those two children are worth
    // nine qualifying children between them. All three numbers are different on purpose.
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      childReliefMode: 'auto_table',
      numChildren: 5,
      childReliefTable: GRID,
    });
    await payOneMonth(E.employmentId);
    const printed = await item8(E.employmentId);
    const weighted = unitsOf('under_18') + unitsOf('disabled_study');
    expect(printed, "A.8 is C — LHDN's own slip prints 9.00 for this employee").toBe(weighted);
    expect(printed, 'and it is NOT the stored column').not.toBe(5);
    expect(printed, 'and it is NOT the grid head count either').not.toBe(childReliefTableHeadCount(GRID));
    // The three really are three different numbers, so none of the above can pass by coincidence.
    expect(childReliefTableHeadCount(GRID)).toBe(2);
    expect(weighted).toBe(9);
  });

  it('A.8 x the per-child deduction IS D.6 — the two boxes are one fact', async () => {
    // What makes the form checkable by multiplying, and the reason A.8 is derived from the relief
    // rather than from a second reading of the family register.
    const E = await hire('identity@acme.test');
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      childReliefMode: 'auto_table',
      numChildren: 5,
      childReliefTable: GRID,
    });
    await payOneMonth(E.employmentId);
    const ea = (await employeeEaStatement(adminCtx(base), { employmentId: E.employmentId, year: '2026' }))!;
    expect(ea.employee.children).not.toBeNull();
    expect(ea.employee.children! * DEFAULT_MY_STATUTORY.pcb.reliefs.perChild).toBeCloseTo(ea.partD.childRelief ?? 0, 2);
  });

  it('no stamped relief means NO A.8 — absent, never a stale count', async () => {
    // r359 — the new case. A year whose slips carry no relief snapshot (written before the stamp, or a
    // flat-rate non-resident) leaves D.6 empty already; A.8 is absent with it, because a head count
    // printed beside an empty D.6 is the two-contradictory-answers-on-one-page problem the reversed
    // block above warned about. That warning was right even though its conclusion was not.
    const E = await hire('nopayroll@acme.test');
    await setTaxProfileMY(adminCtx(base), { personId: E.personId, childReliefMode: 'manual', numChildren: 3 });
    // deliberately no payOneMonth
    expect(await item8(E.employmentId)).toBeNull();
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
    await payOneMonth(E.employmentId);
    // r359 — unchanged, and now true by construction rather than by a deliberate refusal to fall back:
    // the relief was zero, so C is zero. The count follows the money, which is what this case always said.
    expect(await item8(E.employmentId)).toBe(0);
  });

  /**
   * ⚠️ ALSO REVERSED, AND THIS ONE IS A JUDGEMENT THE OWNER NOW OWNS. It read "a half-share child is
   * still ONE child on this box", asserting 3 for one full child and two half-share children, with the
   * reason: "Counting it as 0.5 would print a fraction in a box ruled for a number of people."
   *
   * That reason is still a fair objection and the answer is that the box is not ruled for people any
   * more — it is ruled for C, and C is what multiplies with Q to give the relief. A half-share child is
   * half a qualifying child in the money, so it must be half a qualifying child here or A.8 x RM2,000
   * stops reaching D.6. The specification has no half child because it settles a shared claim at the
   * annual assessment; this system supports the share monthly, so the fraction is ours to print
   * honestly rather than round away.
   */
  it('a half-share child is HALF a qualifying child, because the money says so', async () => {
    const E = await hire('half@acme.test');
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      childReliefMode: 'auto_table',
      numChildren: 0,
      childReliefTable: { under_18: { full: 1, half: 2 } },
    });
    await payOneMonth(E.employmentId);
    // One whole child (1 unit) plus two children at half share (0.5 each) = 2.
    expect(await item8(E.employmentId)).toBe(2);
    expect(childReliefTableHeadCount({ under_18: { full: 1, half: 2 } }), 'the head count is still 3').toBe(3);
  });
});
