/**
 * r343 FIX PASS · item 03f89c0f — WHICH EMPLOYEES THE DISAGREEMENT SCREEN LISTS, AND WHAT ITS TWO HEADLINE
 * MONEY FIGURES ADD UP.
 *
 * ═══ WHY THIS FILE EXISTS ═══
 *
 * The build shipped `childReliefRecordDisagreement` (the PURE per-person finding) pinned by
 * test/child-relief-disagreement-r343.test.ts, and the table's six-locale render pinned by
 * test/child-relief-disagreement-locales-r343.dom.test.tsx. Neither of them touches the SUBSET. Adversarial
 * verification widened the filter in core/child-relief-review.ts from
 *
 *     people.filter((x) => (x.typedExcess ?? 0) > 0)   →   people.filter((x) => x.typedExcess != null)
 *
 * and six related test files / 131 tests stayed GREEN. Under that change the screen headed "Typed child
 * counts above the Family record" would have listed every 'manual' employee — including the five whose
 * figures AGREE with their Family record and anyone whose figure is BELOW it — and the subset IS the whole
 * point of the screen. The two stat tiles above the table ("Children the records do not account for" and
 * "Relief those children carry (RM)", the RM104,000-equivalent figure) would have summed a mixture of
 * signs. This file is that hole closed, through `childReliefReview` against a real database, which is the
 * function the page actually calls.
 *
 * ═══ HOW THE TOTALS ARE ASSERTED, AND WHY IT IS NOT CIRCULAR ═══
 *
 * A total asserted only as "Σ over the rows shown" moves with the filter and so cannot catch a widened one.
 * So each headline figure is pinned THREE ways at once: against the rows shown, against the one arithmetic
 * identity that only holds when every row is a typed-ABOVE row (`excessReliefRM === excessChildren ×
 * perChild` — false the moment a zero or negative row joins, because `excessRM` takes only the positive
 * part), and against membership by NAME. No ringgit literal appears below: every amount comes from the
 * pack's own `perChild`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_MY_STATUTORY } from '../localization/my/statutory-tables';
import { childReliefReview, type ChildReliefReviewPerson } from '../core/child-relief-review';
import { setStatutoryProfileMY, setTaxProfileMY } from '../localization/my/statutory';
import { addDependent } from '../core/dependents';
import { hireEmployee } from '../core/org';
import { type SessionContext } from '../db/client';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const RELIEFS = DEFAULT_MY_STATUTORY.pcb.reliefs;
const PER_CHILD = RELIEFS.perChild;

describe('03f89c0f · the disagreement subset and its two headline figures, against a real database', () => {
  let base: Base;
  let ic = 900101010200;

  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    ic = 900101010200;
  });
  afterAll(async () => {
    await closeAll();
  });

  /**
   * One employee, built in the order the real system builds them: hire, key the IC (which seeds the
   * statutory row), record the children, THEN set the tax figure.
   *
   * ⚠️ THE ORDER IS LOAD-BEARING FOR THE 'auto' CASE. `addDependent` runs `syncChildReliefFromFamily`,
   * which overwrites `num_children` for an employee already on 'auto'. Recording the children first and
   * setting the tax profile last is what lets an 'auto' employee hold a head count that DISAGREES with
   * their Family record — the shape production actually has (three employees are stored 'auto' and one
   * carries a leftover figure), and the shape that makes the mode exclusion below non-vacuous.
   */
  const person = async (
    ctx: SessionContext,
    p: { name: string; mode: string; numChildren: number; children: number; childReliefTable?: unknown },
  ) => {
    const e = await hireEmployee(ctx, {
      person: { fullName: p.name, primaryEmail: `${p.name.toLowerCase().replace(/\s+/g, '.')}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setStatutoryProfileMY(ctx, { personId: e.personId, icNumber: String(++ic) });
    for (let i = 0; i < p.children; i += 1) {
      await addDependent(ctx, {
        personId: e.personId,
        fullName: `${p.name} child ${i + 1}`,
        relationship: 'child',
        dateOfBirth: '2016-01-01',
        childReliefCategory: 'under_18',
        childReliefPercentage: 100,
      });
    }
    await setTaxProfileMY(ctx, {
      personId: e.personId,
      childReliefMode: p.mode,
      numChildren: p.numChildren,
      ...(p.childReliefTable ? { childReliefTable: p.childReliefTable } : {}),
    });
    return e;
  };

  /** The five shapes that decide membership, plus a second typed-above row so the totals sum more than one. */
  const population = async (ctx: SessionContext) => {
    // TYPED ABOVE — 4 typed, 1 child on file ⇒ +3. This is the 22.
    await person(ctx, { name: 'Aaa Above', mode: 'manual', numChildren: 4, children: 1 });
    // AGREES — 2 typed, 2 on file. The five.
    await person(ctx, { name: 'Bbb Agree', mode: 'manual', numChildren: 2, children: 2 });
    // TYPED BELOW — 1 typed, 3 on file ⇒ −2. Under-claims: a different conversation, not this screen's.
    await person(ctx, { name: 'Ccc Below', mode: 'manual', numChildren: 1, children: 3 });
    // 'auto' WITH FIGURES THAT DISAGREE — nothing was TYPED, so it cannot be a typed disagreement.
    await person(ctx, { name: 'Ddd Auto', mode: 'auto', numChildren: 5, children: 1 });
    // 'auto_table' likewise, and its grid prices a category rather than a head count.
    await person(ctx, {
      name: 'Eee Autotable',
      mode: 'auto_table',
      numChildren: 5,
      children: 1,
      childReliefTable: { under_18: { full: 1, half: 0 } },
    });
    // TYPED ABOVE — A00001's shape: 9 typed over one child on file ⇒ +8.
    await person(ctx, { name: 'Fff Above', mode: 'manual', numChildren: 9, children: 1 });
  };

  const byName = (people: ChildReliefReviewPerson[]) => people.map((p) => p.name);

  it('lists ONLY the typed-above employees — an agreeing figure, a figure typed below, and both auto modes are absent', async () => {
    const a = adminCtx(base);
    await population(a);

    const view = await childReliefReview(a);
    const listed = view.recordDisagreement.people;

    // The whole population is on the report above; the subset is a SUBSET, in the report's own order.
    expect(byName(view.people)).toEqual([
      'Aaa Above',
      'Bbb Agree',
      'Ccc Below',
      'Ddd Auto',
      'Eee Autotable',
      'Fff Above',
    ]);
    expect(byName(listed), 'only the typed-above employees').toEqual(['Aaa Above', 'Fff Above']);

    // Every listed row, as a PROPERTY and not only as a set: typed, and typed above.
    for (const r of listed) {
      expect(r.typedFigure, `${r.name} must be a typed figure`).toBe(true);
      expect(r.typedExcess ?? 0, `${r.name} must be typed ABOVE the record`).toBeGreaterThan(0);
      expect(r.excessRM, `${r.name} must carry unsupported relief`).toBeGreaterThan(0);
    }

    // ⚠️ THE ABSENCES, EACH FOR ITS OWN STATED REASON — this is what a widened filter breaks.
    const of = (name: string) => view.people.find((p) => p.name === name)!;
    expect(of('Bbb Agree').typedExcess, 'the figures agree').toBe(0);
    expect(of('Ccc Below').typedExcess, 'typed BELOW the record').toBe(-2);
    for (const name of ['Bbb Agree', 'Ccc Below', 'Ddd Auto', 'Eee Autotable']) {
      expect(byName(listed), `${name} must not be listed`).not.toContain(name);
    }
    // And the two auto rows are excluded BY MODE, not because their numbers happen to agree: both hold a
    // head count well above their Family record and are still off the list.
    for (const name of ['Ddd Auto', 'Eee Autotable']) {
      const r = of(name);
      expect(r.typedFigure, `${name} is not a typed figure`).toBe(false);
      expect(r.typedExcess, `${name} has nothing typed to disagree`).toBeNull();
      expect(r.numChildren, `${name}'s stored head count must exceed its record, or this proves nothing`).toBeGreaterThan(
        r.familyEligible,
      );
    }
  });

  it('both headline figures are the rows the screen shows — not the whole population, and not a net of signs', async () => {
    const a = adminCtx(base);
    await population(a);

    const view = await childReliefReview(a);
    const d = view.recordDisagreement;

    // (1) Against the rows shown.
    expect(d.excessChildren).toBe(d.people.reduce((n, r) => n + (r.typedExcess ?? 0), 0));
    expect(d.excessReliefRM).toBeCloseTo(
      d.people.reduce((n, r) => n + r.excessRM, 0),
      2,
    );
    // (2) The identity that ONLY holds when every row is typed above: 'Ccc Below' contributes −2 children
    //     and RM0 of excess, so admitting it would break this equality even though (1) would still hold.
    expect(d.excessChildren, '(4−1) + (9−1)').toBe(11);
    expect(d.excessReliefRM).toBeCloseTo(d.excessChildren * PER_CHILD, 2);
    expect(view.perChild, 'the screen prices with the pack, and so does this test').toBeCloseTo(PER_CHILD, 2);
    // (3) And they are not the whole population's figures: the report above counts six people and 23
    //     children, which is what the subset must NOT be.
    expect(view.people.length).toBe(6);
    expect(d.people.length).toBe(2);
    expect(d.excessChildren).toBeLessThan(view.totals.children);
  });

  it('a population where every typed figure agrees reports an honest nothing, so the screen prints no Card', async () => {
    const a = adminCtx(base);
    await person(a, { name: 'Ggg Agree', mode: 'manual', numChildren: 2, children: 2 });
    await person(a, { name: 'Hhh Below', mode: 'manual', numChildren: 1, children: 2 });
    await person(a, { name: 'Iii Auto', mode: 'auto', numChildren: 4, children: 1 });

    const view = await childReliefReview(a);
    // The page gates both the stat Card and the table on `people.length > 0`, so this is the state in which
    // the screen must say nothing at all rather than print a zero-row "finding".
    expect(view.recordDisagreement.people).toEqual([]);
    expect(view.recordDisagreement.excessChildren).toBe(0);
    expect(view.recordDisagreement.excessReliefRM).toBe(0);
    // The report itself still lists them — nothing here hides anybody.
    expect(view.people.length).toBe(3);
  });
});
