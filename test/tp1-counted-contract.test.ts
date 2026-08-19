/**
 * r209 / item 7ad37961 — THE CONTRACT BETWEEN THE SCREEN AND THE PAYROLL FEED.
 *
 * ══ WHY THIS FILE EXISTS AND WHY IT IS NOT PART OF test/tp1-2026-form.test.ts ═══════════════════════
 *
 * The 2026 TP1 e-form was built, tested and HELD. Every half of it passed its own tests throughout. The
 * defect was in the CONTRACT between two files:
 *
 *   · `prefillTp1FromSelfRelief` (core/payroll) SUMMED `tp1_amount` over the approved rows in force, so a
 *     declaration carried forward from before the form contributed its FULL amount to payroll;
 *   · the limit check and the screen's Remaining strip (core/tax-relief) accumulated through the C1–C17
 *     catalogue, and a carried-forward row has no catalogue attribution, so it contributed ZERO.
 *
 * HR was shown "Remaining: RM 8,000", keyed RM 8,000 against it, and payroll received that plus an
 * RM 9,000 nobody had been shown. Nothing errored. The screen and the payslip each looked right alone.
 * A unit test of EITHER half passed the whole time — which is exactly AGENTS rule 17, and exactly why
 * every case below drives BOTH paths from ONE fixture and asserts they agree, rather than asserting a
 * property of one of them.
 *
 * ══ THE FIX THESE CASES PIN ═════════════════════════════════════════════════════════════════════════
 *
 * ONE rule, expressed once and consumed twice: `tp1EffectiveFromMonth` (when a declaration starts
 * counting) and `tp1CountForYear` (what the year's approved rows add up to, attributed or not), both in
 * core/tax-relief.ts. The payroll feed calls it with `throughMonth` = the batch's month; the screen and
 * the limit check call it for the whole year with the month being keyed left out. Neither side has a
 * month predicate or a sum of its own any more, and section D below asserts exactly that about the
 * SOURCE of both files — because a shape assertion is the only thing that survives somebody re-forking
 * the rule and making the numbers agree again by coincidence.
 *
 * ══ NON-VACUITY ═════════════════════════════════════════════════════════════════════════════════════
 *
 * Three reverts were run against these cases, each from a `cp` copy, each watched failing:
 *   1. `tp1CountForYear` skips unattributed rows (`accumulate`'s pre-r209 behaviour) → section A fails
 *      `month 3: the screen and payroll must be the same number: expected 9500 to be +0`, plus three more.
 *   2. `tp1EffectiveFromMonth` ignores `approvedMonth`, and 0449 goes back to `approved_month = 1` (the
 *      r201 rule) → six cases fail, including `row 0 approved from month: expected 1 to be 3` against
 *      the migration's own SQL.
 *   3. The `approved_month` predicate goes back into the payroll feed's WHERE clause → only section D
 *      fails, which is what it is for: the numbers still agreed.
 */
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, prefillTp1FromSelfRelief } from '../core/payroll';
import {
  approveTp1ForPerson,
  getTp1AccumulatedForPerson,
  reconcileTp1ForYear,
  submitTp1ForPerson,
  tp1CountForYear,
  tp1EffectiveFromMonth,
  TP1_ITEMS,
} from '../core/tax-relief';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const YEAR = 2026;
const ROOT = path.resolve(__dirname, '..');

describe('TP1 — the counted-for-the-year contract', () => {
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

  let icSeq = 0;
  const hire = async (name: string, email: string) => {
    const admin = adminCtx(base);
    const e = await hireEmployee(admin, {
      person: { fullName: name, primaryEmail: email },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(admin, { employmentId: e.employmentId, basicSalary: 9000, effectiveFrom: '2026-01-01' });
    // Distinct per employee: employee_statutory_my_ic_uq is unique per tenant.
    icSeq += 1;
    await setStatutoryProfileMY(admin, {
      personId: e.personId,
      icNumber: `9001010150${String(10 + icSeq).slice(-2)}`,
    });
    return e;
  };

  /**
   * What payroll ACTUALLY writes, month by month — the real feed, one draft batch per pay period.
   * ONE PASS OVER THE YEAR, because `payroll_batch_one_regular_uq` allows exactly one regular batch per
   * period: a second `createBatch` for a month already walked would fail rather than re-read it.
   * No payslips are generated in this file, so ∑LP is 0 and the delta method feeds the annual whole —
   * which is what makes this a clean read of `tp1CountForYear`'s figure rather than of the delta.
   */
  async function fedByMonth(): Promise<Record<number, Record<string, number>>> {
    const admin = adminCtx(base);
    const out: Record<number, Record<string, number>> = {};
    for (let month = 1; month <= 12; month++) {
      const { batchId } = await createBatch(admin, {
        companyId: base.companyId,
        payPeriod: `${YEAR}-${String(month).padStart(2, '0')}`,
      });
      await prefillTp1FromSelfRelief(admin, { batchId });
      const inputs = await owner.db
        .select()
        .from(schema.payrollInput)
        .where(eq(schema.payrollInput.batchId, batchId));
      out[month] = Object.fromEntries(inputs.map((r) => [r.employmentId, Number(r.tp1Deduction ?? 0)]));
    }
    return out;
  }

  /** What the SCREEN accounts for as in force by `month`, read from the panel's own source list. */
  async function countedThroughMonth(personId: string, formMonth: number | null, month: number): Promise<number> {
    const acc = await getTp1AccumulatedForPerson(adminCtx(base), {
      personId,
      assessmentYear: YEAR,
      deductionMonth: formMonth,
    });
    return Math.round(
      acc.sources.filter((s) => s.effectiveFrom <= month).reduce((sum, s) => sum + s.amount, 0) * 100,
    ) / 100;
  }

  const cat = (code: string, amount: number) => {
    const def = TP1_ITEMS.find((d) => d.code === code)!;
    return {
      form: 'tp1-2026',
      items:
        def.subItems.length === 0
          ? { [code]: { amount } }
          : { [code]: { subItems: { [def.subItems[0].code]: amount } } },
      rebates: {},
    };
  };

  // ═══════════════════ A. The defect, driven from ONE fixture through BOTH paths ═══════════════════

  /**
   * THE CASE THE HOLD WAS ABOUT. A carried-forward eight-key declaration (RM 9,500, no C1–C17
   * attribution) approved from March, plus an ordinary catalogue declaration for June.
   *
   * For EVERY month of the year the money the screen accounts for and the money payroll writes must be
   * the same number. Before r209, March fed 9,500 and the screen accounted for 0 — HR keyed the year's
   * increments against a baseline missing the whole carried-forward claim.
   *
   * REVERT-AGAINST-ME: make `tp1CountForYear` skip rows whose categories are not the 2026 shape (that
   * was `accumulate`'s behaviour) and this case fails at March — the screen still lists the RM 9,500 and
   * the feed drops it, `expected 9500 to be +0`.
   */
  it('the screen accounts for every ringgit payroll takes, month by month, including carried-forward money', async () => {
    const admin = adminCtx(base);
    const e = await hire('Contract', 'contract@acme.test');

    // The carried-forward declaration: the eight-key shape, no deduction month — exactly the row every
    // employee has in production the day this ships. Approved from MARCH, per the round's rule.
    const legacy = await submitTp1ForPerson(admin, {
      personId: e.personId,
      assessmentYear: YEAR,
      categories: { individual: 9000, lifestyle: 500 },
    });
    await approveTp1ForPerson(admin, {
      personId: e.personId,
      id: legacy.id,
      approvedMonth: 3,
      approvedYear: YEAR,
    });

    // An ordinary 2026 declaration keyed for June and approved from June.
    const june = await submitTp1ForPerson(admin, {
      personId: e.personId,
      assessmentYear: YEAR,
      deductionMonth: 6,
      categories: cat('c9', 400),
      declarationAccepted: true,
    });
    await approveTp1ForPerson(admin, { personId: e.personId, id: june.id, approvedMonth: 6, approvedYear: YEAR });

    const fed = await fedByMonth();
    for (let month = 1; month <= 12; month++) {
      // The panel is read with NO bucket excluded — 99 is not a month any row is in — so this is the
      // whole year's ledger exactly as the screen prints it, filtered to what is in force by `month`.
      const counted = await countedThroughMonth(e.personId, 99, month);
      expect(counted, `month ${month}: the screen and payroll must be the same number`).toBe(
        fed[month][e.employmentId] ?? 0,
      );
    }

    // …and the figures themselves, so a future edit that makes both sides agree on the WRONG number is
    // not silently green.
    expect(fed[2][e.employmentId] ?? 0, 'nothing is in force before March').toBe(0);
    expect(fed[3][e.employmentId], 'the carried-forward claim, from its approval month').toBe(9500);
    expect(fed[6][e.employmentId], 'plus June').toBe(9900);
  });

  /**
   * THE SAME CONTRACT AT THE LIMIT CHECK. HR opens JUNE. What the screen tells them is already counted
   * for the year must include the carried-forward money, and it must say that money is not itemised —
   * because it cannot appear in any item's Accumulated, and a Remaining figure that silently ignores
   * RM 9,500 is the exact number HR keyed against when this build was held.
   */
  it('the screen names the carried-forward money and says it is not itemised', async () => {
    const admin = adminCtx(base);
    const e = await hire('Panel', 'panel@acme.test');

    const legacy = await submitTp1ForPerson(admin, {
      personId: e.personId,
      assessmentYear: YEAR,
      categories: { individual: 9000, lifestyle: 500 },
    });
    await approveTp1ForPerson(admin, { personId: e.personId, id: legacy.id, approvedMonth: 3, approvedYear: YEAR });
    const jan = await submitTp1ForPerson(admin, {
      personId: e.personId,
      assessmentYear: YEAR,
      deductionMonth: 1,
      categories: cat('c9', 400),
      declarationAccepted: true,
    });
    await approveTp1ForPerson(admin, { personId: e.personId, id: jan.id, approvedMonth: 1, approvedYear: YEAR });

    const acc = await getTp1AccumulatedForPerson(admin, {
      personId: e.personId,
      assessmentYear: YEAR,
      deductionMonth: 6,
    });
    // The per-item strip is unchanged and still cannot see the carried-forward money…
    expect(acc.items.c9).toBe(400);
    // …so the money is stated in its own right, and named as unattributed.
    expect(acc.total, 'every counted ringgit, itemised or not').toBe(9900);
    expect(acc.unattributedTotal).toBe(9500);
    const carried = acc.sources.find((s) => !s.attributed)!;
    expect(carried, 'the carried-forward row is on the screen').toBeTruthy();
    expect(carried.amount).toBe(9500);
    expect(carried.deductionMonth, 'no month was ever keyed on it — none is invented').toBeNull();
    expect(carried.effectiveFrom, 'it counts from the month it was approved').toBe(3);
    expect(acc.sources.find((s) => s.attributed)?.amount).toBe(400);
  });

  // ═══════════════════ B. The one rule: effective from the month of approval ═══════════════════

  /**
   * The rule the reporter chose, at the level it is expressed. A carried-forward row is NOT effective
   * all year: it is effective from its Section F month. The r201 backfill wrote 1 here, which is what
   * put money into January that HR would only be told about in March.
   */
  it('tp1EffectiveFromMonth: Section F wins, then the claimed month, then January', () => {
    expect(tp1EffectiveFromMonth({ deductionMonth: null, approvedMonth: 6 })).toBe(6);
    expect(tp1EffectiveFromMonth({ deductionMonth: 3, approvedMonth: 6 }), 'approval, not the claim').toBe(6);
    // A hand-inserted row that never went through the approve action names only the month it claimed.
    expect(tp1EffectiveFromMonth({ deductionMonth: 4, approvedMonth: null })).toBe(4);
    // A month-less whole-year declaration with no approval month is effective all year, as it always was.
    expect(tp1EffectiveFromMonth({ deductionMonth: null, approvedMonth: null })).toBe(1);
    // `approved_month` is a smallint with no CHECK — a 0 or a 13 must not make a row effective before
    // January or never at all.
    expect(tp1EffectiveFromMonth({ deductionMonth: null, approvedMonth: 0 })).toBe(1);
    expect(tp1EffectiveFromMonth({ deductionMonth: null, approvedMonth: 13 })).toBe(12);
  });

  /**
   * THE MIGRATION'S OWN RULE, EXECUTED — not read. 0449's backfill is the only place the production
   * carried-forward rows get their effective month, and it is a `.sql` file no unit test would otherwise
   * touch. So the file's UPDATE is lifted out and run against rows in the shapes it will meet.
   */
  it('migration 0449 stamps each carried-forward row with the month it was approved', async () => {
    const sqlText = fs.readFileSync(path.join(ROOT, 'db/migrations/0449_tp1_approval.sql'), 'utf8');
    const update = sqlText
      .split('--> statement-breakpoint')
      .map((chunk) => chunk.trim())
      .find((chunk) => /^UPDATE "tp1_relief"/m.test(chunk.replace(/^--.*$/gm, '').trim()))!;
    expect(update, 'the backfill statement is still in the file').toBeTruthy();

    const e = await hire('Backfill', 'backfill@acme.test');
    const rows = [
      // Submitted in March of the assessment year → effective from March.
      { at: new Date(Date.UTC(2026, 2, 15, 4, 0)), year: YEAR, expect: 3 },
      // Submitted at 00:30 on 1 January Kuala Lumpur = 31 Dec 16:30 UTC. The migration names the zone,
      // so this is January — not December, and not "whatever the deploy box's TimeZone was".
      { at: new Date(Date.UTC(2025, 11, 31, 16, 30)), year: YEAR, expect: 1 },
      // Declared ahead of the year → already in force when the year began.
      { at: new Date(Date.UTC(2025, 8, 1, 4, 0)), year: YEAR, expect: 1 },
      // Approved after the year closed → the year's last month; it cannot reduce a deduction already
      // remitted for March.
      { at: new Date(Date.UTC(2027, 4, 1, 4, 0)), year: YEAR, expect: 12 },
    ];
    const ids: string[] = [];
    for (const r of rows) {
      const [ins] = await owner.db
        .insert(schema.tp1Relief)
        .values({
          tenantId: base.tenantId,
          personId: e.personId,
          assessmentYear: r.year,
          status: 'submitted',
          tp1Amount: '1000.00',
          submittedAt: r.at,
        })
        .returning({ id: schema.tp1Relief.id });
      ids.push(ins.id);
    }
    await owner.db.execute(sql.raw(update));
    const after = await owner.db
      .select({ id: schema.tp1Relief.id, status: schema.tp1Relief.status, m: schema.tp1Relief.approvedMonth })
      .from(schema.tp1Relief)
      .where(eq(schema.tp1Relief.personId, e.personId));
    const byId = new Map(after.map((r) => [r.id, r]));
    rows.forEach((r, i) => {
      const got = byId.get(ids[i])!;
      expect(got.status, 'grandfathered to approved').toBe('approved');
      expect(got.m, `row ${i} approved from month`).toBe(r.expect);
    });
  });

  // ═══════════════════ C. Every declaration through both paths ═══════════════════

  /**
   * THE RECONCILIATION THE PLAN PROMISED: every existing declaration, through both paths, employee by
   * employee. Three employees with deliberately awkward shapes — carried-forward money, a superseded
   * correction that is still `approved` in the table, a month-less self-service row, and a mid-year
   * approval — and for each, every month of the year is checked against what payroll actually writes.
   */
  it('reconciles every declaration against what payroll actually writes, for every month', async () => {
    const admin = adminCtx(base);

    const carried = await hire('Carried', 'carried@acme.test');
    const c1 = await submitTp1ForPerson(admin, {
      personId: carried.personId,
      assessmentYear: YEAR,
      categories: { individual: 4000 },
    });
    await approveTp1ForPerson(admin, { personId: carried.personId, id: c1.id, approvedMonth: 5, approvedYear: YEAR });

    const corrected = await hire('Corrected', 'corrected@acme.test');
    const first = await submitTp1ForPerson(admin, {
      personId: corrected.personId,
      assessmentYear: YEAR,
      deductionMonth: 1,
      categories: cat('c9', 500),
      declarationAccepted: true,
    });
    await approveTp1ForPerson(admin, {
      personId: corrected.personId,
      id: first.id,
      approvedMonth: 1,
      approvedYear: YEAR,
    });
    // A correction appends; the superseded row is STILL `approved` and must count nowhere.
    const fixed = await submitTp1ForPerson(admin, {
      personId: corrected.personId,
      assessmentYear: YEAR,
      deductionMonth: 1,
      categories: cat('c9', 350),
      declarationAccepted: true,
    });
    await approveTp1ForPerson(admin, {
      personId: corrected.personId,
      id: fixed.id,
      approvedMonth: 1,
      approvedYear: YEAR,
    });

    const mixed = await hire('Mixed', 'mixed@acme.test');
    const mLegacy = await submitTp1ForPerson(admin, {
      personId: mixed.personId,
      assessmentYear: YEAR,
      categories: { lifestyle: 2500 },
    });
    await approveTp1ForPerson(admin, { personId: mixed.personId, id: mLegacy.id, approvedMonth: 2, approvedYear: YEAR });
    const mAug = await submitTp1ForPerson(admin, {
      personId: mixed.personId,
      assessmentYear: YEAR,
      deductionMonth: 8,
      categories: cat('c9', 700),
      declarationAccepted: true,
    });
    await approveTp1ForPerson(admin, { personId: mixed.personId, id: mAug.id, approvedMonth: 8, approvedYear: YEAR });

    const people = [carried, corrected, mixed];
    // The feed writes every employee of the batch at once, so one batch per month answers all three.
    const fed = await fedByMonth();

    for (const p of people) {
      const rec = await reconcileTp1ForYear(admin, { personId: p.personId, assessmentYear: YEAR });
      expect(rec.agrees, `${p.personId}: the two paths disagree`).toBe(true);
      for (const m of rec.months) {
        expect(m.fed, `person ${p.personId} month ${m.month}`).toBe(fed[m.month][p.employmentId] ?? 0);
      }
    }

    // The superseded correction counted once, at its corrected figure — not 850, and not twice.
    const rec = await reconcileTp1ForYear(admin, { personId: corrected.personId, assessmentYear: YEAR });
    expect(rec.sources).toHaveLength(1);
    expect(rec.sources[0].amount).toBe(350);
    // …and the carried-forward employee's money is reported as unattributed rather than quietly counted.
    const carriedRec = await reconcileTp1ForYear(admin, { personId: carried.personId, assessmentYear: YEAR });
    expect(carriedRec.unattributedTotal).toBe(4000);
    expect(carriedRec.months.find((m) => m.month === 4)!.fed).toBe(0);
    expect(carriedRec.months.find((m) => m.month === 5)!.fed).toBe(4000);
  });

  /**
   * The pure reduction, on the two questions the two sides ask. Same rows, same function, different
   * argument — which is the shape the fix has to keep: if these ever need different INPUT rows or
   * different code, the contract has been re-forked.
   */
  it('tp1CountForYear answers the annual question and the as-at-month question from one input', () => {
    const rows = [
      {
        id: 'a',
        deductionMonth: null,
        approvedMonth: 6,
        createdAt: new Date('2026-01-01'),
        tp1Amount: '9000.00',
        categories: { individual: 9000 } as never,
      },
      {
        id: 'b',
        deductionMonth: 1,
        approvedMonth: 1,
        createdAt: new Date('2026-01-02'),
        tp1Amount: '400.00',
        categories: { form: 'tp1-2026', items: { c9: { amount: 400 } }, rebates: {} } as never,
      },
    ];
    // Payroll in March: only January's row is in force.
    expect(tp1CountForYear(rows, { throughMonth: 3 }).total).toBe(400);
    // Payroll in June: both.
    expect(tp1CountForYear(rows, { throughMonth: 6 }).total).toBe(9400);
    // The limit check, keying February: the whole year counts, because an annual limit is annual — a
    // relief already approved from June consumes 2026's allowance while HR is still keying February.
    const annual = tp1CountForYear(rows, { throughMonth: null, excluding: { deductionMonth: 2 } });
    expect(annual.total).toBe(9400);
    expect(annual.items.c9).toBe(400);
    expect(annual.unattributedTotal).toBe(9000);
    // Keying JANUARY: January's own row is not "already claimed", so it drops out of both the money and
    // the attribution — one exclusion, not two rules.
    const jan = tp1CountForYear(rows, { throughMonth: null, excluding: { deductionMonth: 1 } });
    expect(jan.total).toBe(9000);
    expect(jan.items.c9).toBeUndefined();
  });

  // ═══════════════════ D. There is only ONE spelling of the rule ═══════════════════

  /**
   * THE SOURCE-SHAPE ASSERTION, and the reason this file has one at all.
   *
   * Every numeric case above would still pass if somebody re-implemented the effective-month predicate
   * inside the payroll feed and happened to get the same answers for these fixtures — which is precisely
   * how the held build got here: two implementations that agreed on the cases anybody had written down.
   * So the fact being pinned is structural: neither side compares `approved_month` itself, and the
   * payroll feed reaches the reduction through core/tax-relief rather than summing rows on its own.
   */
  it('neither side spells the effective-month rule for itself', () => {
    const strip = (src: string) =>
      src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*)/.test(l))
        .join('\n');
    const payroll = strip(fs.readFileSync(path.join(ROOT, 'core/payroll.ts'), 'utf8'));
    const relief = strip(fs.readFileSync(path.join(ROOT, 'core/tax-relief.ts'), 'utf8'));

    // The payroll feed must not filter on the column — that WHERE clause was one of the two spellings.
    expect(payroll).not.toMatch(/tp1Relief\.approvedMonth/);
    // …and it must reach the reduction through core/tax-relief.
    expect(payroll).toMatch(/tp1CountForYear\(/);

    // core/tax-relief may read the column, but only inside the ONE function that defines the rule.
    const rule = relief.slice(
      relief.indexOf('export function tp1EffectiveFromMonth'),
      relief.indexOf('export type Tp1CountedSource'),
    );
    expect(rule).toMatch(/approvedMonth/);
    const rest = relief.replace(rule, '');
    // Elsewhere the column is only ever SELECTED or WRITTEN, never compared.
    expect(rest).not.toMatch(/lte\(\s*tp1Relief\.approvedMonth/);
    expect(rest).not.toMatch(/isNull\(\s*tp1Relief\.approvedMonth/);
  });

  /**
   * ⚠️ A CORRECTION MUST NOT REACH BACK AND DELETE THE MONEY IT SUPERSEDED.
   *
   * `collapseTp1ApprovedByMonth` is newest-wins per deduction month, and `tp1CountForYear` also narrows
   * to what is effective by a given month. THE ORDER OF THOSE TWO STEPS IS THE WHOLE CORRECTNESS OF THE
   * FUNCTION. Collapse first and March's bucket is won by an August correction; filter that result by
   * "effective by May" and the bucket vanishes entirely — so March contributes nothing to May even though
   * the row the correction replaced was approved from March and was in force the whole time.
   *
   * That is money, it is silent, and it is reachable through the shipped UI: HR opens the March TP1
   * screen, submits a correction in August, and types 8 into the free 1–12 Section F "approved for the
   * deduction of MONTH" box. Every batch for March–July created or reprocessed afterwards then feeds 0.
   *
   * r201 filtered before collapsing and did not have this; the r209 rework reordered them.
   */
  it('an August correction does not erase the March figure from the months before it', () => {
    const march = {
      id: 'orig',
      deductionMonth: 3,
      approvedMonth: 3,
      createdAt: new Date('2026-03-10'),
      tp1Amount: '1000.00',
      categories: { individual: 1000 } as never,
    };
    const correction = {
      id: 'corr',
      deductionMonth: 3,
      approvedMonth: 8,
      createdAt: new Date('2026-08-10'),
      tp1Amount: '1500.00',
      categories: { individual: 1500 } as never,
    };

    // Through May the correction is not yet in force, so the ORIGINAL still stands.
    expect(
      tp1CountForYear([march, correction], { throughMonth: 5 }).total,
      'the August correction deleted March money from May',
    ).toBe(1000);
    // …and it is the same answer the original gives on its own — the correction changed nothing yet.
    expect(tp1CountForYear([march], { throughMonth: 5 }).total).toBe(1000);

    // From August the correction supersedes it — one row for the month, the newer amount, not the sum.
    expect(tp1CountForYear([march, correction], { throughMonth: 8 }).total).toBe(1500);
    expect(tp1CountForYear([march, correction], { throughMonth: null }).total).toBe(1500);
  });

});
