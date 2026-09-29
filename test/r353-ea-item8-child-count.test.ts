/**
 * ⚠️⚠️ REVERSED AGAIN IN r364 (fda53352 rev 8). READ THIS BEFORE THE r359 BANNER BELOW.
 *
 * EA ITEM 8 IS A COUNT OF CHILDREN. r353 said so, r359 overturned it to LHDN's s.48-weighted C, and the
 * reporter reversed that within a day. r359's whole header is kept verbatim underneath (CLAUDE.md §8: a
 * guard pinning a decision you are reversing is updated, not deleted) — including its own citations,
 * because they are real and they are about the wrong document.
 *
 * WHAT SETTLES IT, AND IT IS INSIDE THE VERY FILE r359 CITED. docs/forms/pcb-calculation-slip-official-
 * 2026-12.pdf is LHDN's own generated slip for this exact employee. Page 1 prints a child grid headed
 * "Number of children / Qualification rate 100% 50%" with "(a) Under 18 years old  1" and "(e) Disabled
 * and still studying in Malaysia or abroad  1" — TWO children, each a whole child. Page 6 of the SAME
 * document prints "Q = Deduction for eligible children  2,000.00" and "C = Number of eligible children
 * 9.00". The agency prints 2 where it means children and 9.00 where it means C. r359 read page 6 and not
 * page 1, and carried a rule out of the MONTHLY TAX specification onto an ANNUAL statement it does not
 * speak to.
 *
 * AND THE FORM'S OWN ENGLISH. docs/forms/ea-cp8a-pin-2023-official-en.pdf, section A: "8. Number of
 * children qualified for tax relief", printed in the left column of particulars between "6. EPF No." and
 * "9. If the period of employment is less than a year", with a short rule and no RM heading over it. The
 * weighted ringgit has its own box in the money column: "6. Total qualifying child relief". The Bahasa
 * Malaysia sheet agrees — "Bilangan anak yang layak untuk pelepasan cukai"; *bilangan* is a count.
 *
 * WHAT THE CASES BELOW PIN NOW.
 *   · 'manual' 3 and 'auto' 2 — the SAME answers r359 printed, from a different source. Their fixtures no
 *     longer run payroll at all, and that is the point: A.8 is a fact about the employee's tax record, so
 *     a fixture with no payroll still has one. Under r359 these two passed only by arithmetic accident
 *     (an unweighted relief divided by the per-child figure returns the count).
 *   · 'auto_table' with the reporter's own grid — 2, the grid's head count, NOT 9 and NOT the stored
 *     column. REVERSED.
 *   · a 50%-shared child — ONE child. So 1 full + 2 half prints 3. REVERSED.
 *   · no payroll at all — A.8 still prints the count while D.6 is empty. REVERSED: r359 made A.8 absent
 *     whenever D.6 was, on the grounds that "the two boxes are one fact". They are two facts.
 *   · A.8 x the per-child deduction is NOT D.6, asserted as the FALSE invariant it is. This case replaces
 *     r359's identity assertion, quoted in full where it stood.
 *   · 'auto_table' with no grid keyed — 0, unchanged, re-argued without the slogan that caused r359.
 *   · no statutory row at all — NULL, an empty rule. Unrecorded is not zero.
 *
 * ⚠️ THE 50% SHARE AFFECTS THE RELIEF, NOT THE HEAD COUNT, AND THREE IN-TREE SOURCES SAY SO.
 * `childReliefTableHeadCount` (localization/my/statutory-tables.ts) floors and sums `full` + `half` as
 * whole children; `eligibleChildReliefCount`'s header in core/dependents.ts states that one eligible child
 * is ONE whatever category is recorded against it; and LHDN's slip counts its own 50% column in whole
 * children. r359 made this box fractional, so a live form could read "4.5 children". It cannot again:
 * both branches return integers.
 *
 * ── r359's HEADER, KEPT VERBATIM ─────────────────────────────────────────────────────────────────────
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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
   * ⚠️ r364 — PAYROLL IS NO LONGER A PRECONDITION OF A.8, AND ONLY THE D.6 CASES CALL THIS.
   *
   * r359's version of this helper was called by every case, with the header: "RUN THE PAYROLL, because
   * A.8 is now derived from the relief the run applied rather than read off a stored column. Before this
   * round the fixtures needed no payroll at all: the box came straight from `num_children` or the keyed
   * grid, so a configured employee was enough. That is precisely what changed — the box follows the money
   * now, and a fixture with no money has nothing to follow."
   *
   * That is what is reversed. A.8 answers "how many children qualify for relief", which the employee's
   * tax record answers on its own; D.6 answers "what was the relief worth", which only a payroll run can.
   * The cases that assert D.6 run this; the cases that assert only A.8 deliberately do not, and the fact
   * that they still get an answer is itself the reversal.
   */
  async function payOneMonth(employmentId: string) {
    void employmentId;
    const batch = await createBatch(adminCtx(base), { companyId: base.companyId, payPeriod: '2026-01' });
    await generatePayslips(adminCtx(base), { batchId: batch.batchId });
  }

  const item8 = async (employmentId: string) =>
    (await employeeEaStatement(adminCtx(base), { employmentId, year: '2026' }))!.employee.children;

  it("'manual' — three typed children are three qualifying children (SAME answer, source restored)", async () => {
    // Rail (a) exists so a human keeps control of their own tax figure; 71 of 75 employees on production
    // are on this mode, so it is the common case and not the edge. r364: the answer does not move from
    // r359 here, but its source does — the stored column again, and NO payroll run is needed to read it.
    const E = await hire('manual@acme.test');
    await setTaxProfileMY(adminCtx(base), { personId: E.personId, childReliefMode: 'manual', numChildren: 3 });
    expect(await item8(E.employmentId)).toBe(3);
  });

  it("'auto' — two unweighted children are two qualifying children (SAME answer, source restored)", async () => {
    // r351's ruling on this mode is right for the reason r351 gave: `syncChildReliefFromFamily` writes
    // `eligibleChildReliefCount` — a head count over the one eligibility ladder in
    // lib/dependent-vocabulary.ts `childReliefEligible` — into `num_children`, so the column IS the
    // qualifying count. Under r359 this case passed by arithmetic accident instead: with no grid the
    // relief was 2 x perChild, so dividing it back gave 2 whatever the box meant.
    const E = await hire('auto@acme.test');
    await setTaxProfileMY(adminCtx(base), { personId: E.personId, childReliefMode: 'auto', numChildren: 2 });
    expect(await item8(E.employmentId)).toBe(2);
  });

  /**
   * ⚠️ THE REVERSAL ITSELF, AND IT IS THE REPORTER'S OWN EMPLOYEE. r359 turned this case into
   * "'auto_table' — C is the WEIGHTED figure, 9, not the two child records" and asserted:
   *
   *     expect(printed, "A.8 is C — LHDN's own slip prints 9.00 for this employee").toBe(weighted);
   *     expect(printed, 'and it is NOT the grid head count either').not.toBe(childReliefTableHeadCount(GRID));
   *
   * Page 1 of that same slip prints the employee's children as 1 + 1. The assertion that the head count
   * must NOT appear is again the assertion that it MUST, and both lines are kept here so that is legible.
   * This is the case that goes vacuous if the fixture is simplified: an employee with no children, or
   * with no weighted category, gives the same number either way and proves nothing.
   */
  it("⚠️ 'auto_table' — the KEYED grid's HEAD COUNT, 2, not the weighted 9 and not the stored column", async () => {
    const E = await hire('table@acme.test');
    // num_children says 5, the grid claims relief for two children, and those two children are worth
    // nine qualifying children between them. All three numbers are different on purpose.
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      childReliefMode: 'auto_table',
      numChildren: 5,
      childReliefTable: GRID,
    });
    const printed = await item8(E.employmentId);
    const weighted = unitsOf('under_18') + unitsOf('disabled_study');
    expect(printed, "A.8 is the count of children — LHDN's own slip prints 1 + 1 for this employee").toBe(
      childReliefTableHeadCount(GRID),
    );
    expect(printed, 'and it is NOT the s.48-weighted figure, which is what D.6 prices').not.toBe(weighted);
    expect(printed, 'and it is NOT the stale stored column, which the grid supersedes in this mode').not.toBe(5);
    // The three really are three different numbers, so none of the above can pass by coincidence.
    expect(childReliefTableHeadCount(GRID)).toBe(2);
    expect(weighted).toBe(9);
  });

  /**
   * ⚠️ THE FALSE INVARIANT, ASSERTED FALSE. This case replaces r359's, which read "A.8 x the per-child
   * deduction IS D.6 — the two boxes are one fact" and asserted:
   *
   *     expect(ea.employee.children).not.toBeNull();
   *     expect(ea.employee.children! * DEFAULT_MY_STATUTORY.pcb.reliefs.perChild)
   *       .toBeCloseTo(ea.partD.childRelief ?? 0, 2);
   *
   * The s.48 weighting is exactly why that identity is false: two children really can be worth RM18,000.
   * Deleting the case would leave nothing standing where it stood, so it is inverted instead — the
   * invariant is now pinned FALSE and cannot come back silently.
   */
  it('A.8 x the per-child deduction is NOT D.6 — the weighting is why, and two children are RM18,000', async () => {
    const E = await hire('identity@acme.test');
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      childReliefMode: 'auto_table',
      numChildren: 5,
      childReliefTable: GRID,
    });
    await payOneMonth(E.employmentId);
    const ea = (await employeeEaStatement(adminCtx(base), { employmentId: E.employmentId, year: '2026' }))!;
    const perChild = DEFAULT_MY_STATUTORY.pcb.reliefs.perChild;
    // ⚠️ THE NEGATION GOES FIRST, so that a reversal fails on THIS line and not on a figure assertion
    // beneath it. Restoring r359's derivation makes the identity hold again, and this is the line that
    // says out loud that holding is the defect.
    expect(ea.employee.children! * perChild, 'A.8 x perChild must NOT equal D.6 — the s.48 weighting is why').not.toBeCloseTo(
      ea.partD.childRelief ?? 0,
      2,
    );
    // Both boxes are filled, and they answer different questions.
    expect(ea.employee.children, 'A.8 — the number of children qualified for tax relief').toBe(2);
    expect(ea.partD.childRelief, 'D.6 — the s.48-weighted ringgit the kernel actually allowed').toBeCloseTo(18000, 2);
    expect(ea.employee.children! * perChild, 'RM4,000 is what the false invariant would have claimed').toBeCloseTo(
      4000,
      2,
    );
  });

  it('r364 — A.8 prints the count even when NO payroll ran, because it is not a fact about payroll', async () => {
    /**
     * ⚠️ REVERSES r359's ONE NEW CASE. It read "no stamped relief means NO A.8 — absent, never a stale
     * count", with the reason: "A year whose slips carry no relief snapshot (written before the stamp, or
     * a flat-rate non-resident) leaves D.6 empty already; A.8 is absent with it, because a head count
     * printed beside an empty D.6 is the two-contradictory-answers-on-one-page problem."
     *
     * There is no contradiction, because the two boxes do not answer the same question. "This employee has
     * three children who qualify for relief" and "this year's payroll recorded no relief figure" can both
     * be true — a flat-rate non-resident is precisely that person. Withholding a true particular because
     * a different box is empty is not caution, it is a second wrong answer.
     */
    const E = await hire('nopayroll@acme.test');
    await setTaxProfileMY(adminCtx(base), { personId: E.personId, childReliefMode: 'manual', numChildren: 3 });
    // deliberately no payOneMonth
    const ea = (await employeeEaStatement(adminCtx(base), { employmentId: E.employmentId, year: '2026' }))!;
    expect(ea.employee.children, 'A.8 stands on its own').toBe(3);
    // D.6 has nothing to state: no slip stamped a relief, so the figure is 0 here and lib/ea-pdf.ts's
    // `manual()` suppresses a zero to the agency's empty rule rather than printing "RM 0.00".
    expect(ea.partD.childRelief, 'and D.6 is empty, which is honest and unrelated').toBe(0);
  });

  it("'auto_table' with no grid keyed prints 0, because the grid declares relief for nobody", async () => {
    // `pricesChildReliefFromGrid` returns true for 'auto_table' unconditionally, so an unkeyed grid claims
    // NO child relief: zero children qualify, and that is a fact about this employee's tax record rather
    // than about any payroll run — which is why this case no longer runs payroll either.
    //
    // ⚠️ r364 — THE ANSWER IS r353's AND THE REASON IS NOT r359's. r359 kept the 0 and re-justified it as
    // "now true by construction … the relief was zero, so C is zero. The count follows the money, which is
    // what this case always said." The 0 stays; "the count follows the money" is retired. It is the slogan
    // that turned a count into a price.
    const E = await hire('emptytable@acme.test');
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      childReliefMode: 'auto_table',
      numChildren: 4,
      childReliefTable: null,
    });
    expect(await item8(E.employmentId)).toBe(0);
    // 0 is a claim ("no child qualifies"), so it must NOT be the stale stored column that a save of the
    // Identification & Tax card left behind.
    expect(await item8(E.employmentId)).not.toBe(4);
  });

  /**
   * ⚠️ ALSO REVERSED, AND THE TREE AGREED WITH r353 IN THREE PLACES WHILE r359 SHIPPED THE OPPOSITE. r359
   * read "a half-share child is HALF a qualifying child, because the money says so" and asserted 2 for one
   * full child and two half-share children, reasoning: "the box is not ruled for people any more — it is
   * ruled for C … A half-share child is half a qualifying child in the money, so it must be half a
   * qualifying child here or A.8 x RM2,000 stops reaching D.6 … the fraction is ours to print honestly
   * rather than round away."
   *
   * The box IS ruled for people, so r353's original objection stands: "Counting it as 0.5 would print a
   * fraction in a box ruled for a number of people." A live EA could read "4.5 children". LHDN's own slip
   * counts its 50% column in whole children, `childReliefTableHeadCount` floors and sums full + half, and
   * `eligibleChildReliefCount`'s header says a shared eligible child is still one eligible child. The
   * share changes what the relief is WORTH, which is D.6's box.
   */
  it('a 50%-shared child is ONE child — 1 full + 2 half prints 3, never a fraction', async () => {
    const E = await hire('half@acme.test');
    const halfGrid = { under_18: { full: 1, half: 2 } };
    await setTaxProfileMY(adminCtx(base), {
      personId: E.personId,
      childReliefMode: 'auto_table',
      numChildren: 0,
      childReliefTable: halfGrid,
    });
    const printed = await item8(E.employmentId);
    expect(printed, 'three children qualify; two of them at a 50% share').toBe(3);
    expect(childReliefTableHeadCount(halfGrid), 'the head count is the same 3').toBe(3);
    // The figure r359 printed here, and the class of value this box can no longer hold.
    expect(printed, 'A.8 must not be the s.48 units of a shared claim').not.toBe(2);
    expect(Number.isInteger(printed), 'A.8 is always a whole number of children').toBe(true);
  });

  it('r364 — no statutory row at all means UNRECORDED, which prints an empty rule rather than 0', async () => {
    // The one behaviour that is not literally r353's: r353 coerced a missing `num_children` to 0. An
    // employee with no MY statutory record has no number of children on file, and 0 asserts that no child
    // qualifies. CLAUDE.md §8 — an absent box asserts nothing; lib/ea-pdf.ts prints the agency's empty
    // rule for null, exactly as the blank form carries it.
    const a = adminCtx(base);
    const E = await hireEmployee(a, {
      person: { fullName: 'No Statutory Row', primaryEmail: 'norow@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    expect(await item8(E.employmentId)).toBeNull();
  });

  /**
   * r364 — THE SCREEN'S OWN CLAIM ABOUT WHICH DOCUMENT READS WHICH FIGURE, PINNED.
   *
   * The Identification & Tax card's two hints name the forms each box feeds, and r359 pointed the WEIGHTED
   * box's hint at "Form EA item 8". That sentence is how an administrator would check the form, so it is a
   * statutory claim on a screen and it was false. It cannot be pinned through the component (the DOM tests
   * read the same dictionary the card does, so they agree with whatever it says), so it is pinned against
   * the catalogue itself. No database, no render: just the two sentences.
   */
  it('the card says Form EA item 8 reads the COUNT, and never says it reads the weighting', () => {
    const en = JSON.parse(readFileSync(resolve(__dirname, '../messages/en.json'), 'utf8')) as {
      people: { detail: Record<string, string> };
    };
    const d = en.people.detail;
    expect(d.childrenPhysicalDoc, 'the count box must name Form EA item 8').toMatch(/Form EA item 8/);
    expect(d.childrenQualifying, 'the weighted box must not be captioned as a number of children').not.toMatch(
      /children/i,
    );
    expect(d.childrenQualifyingDoc, 'the weighted box must NOT claim Form EA item 8 reads it').not.toMatch(
      /Form EA item 8/,
    );
    // …and it must still name the document that DOES read it, and the box the relief lands in.
    expect(d.childrenQualifyingDoc, 'the PCB slip half of r359 stays true and stays said').toMatch(/PCB/);
    expect(d.childrenQualifyingDoc, 'the relief belongs to Section D item 6').toMatch(/Section D item 6/);
    expect(d.childReliefAmountHint, 'the ringgit names its own box too').toMatch(/Section D item 6/);
  });
});
