/**
 * Item d64d0df4 — "Tax Information": Disabled Individual (OKU).
 *
 * REPRODUCED FIRST. The plan has three bullets and only ONE of them was absent:
 *   · "A Disabled Individual field on the Tax Information card" — ABSENT. Built here.
 *   · "The additional child relief conditions the tax rules distinguish, so each child can be recorded
 *     at the correct relief rate" — ALREADY BUILT. Item 6c635212 shipped the five LHDN s.48 categories
 *     (under_18 / study_preu / study_tertiary / disabled / disabled_study) on the Family tab, stored on
 *     employee_dependent.child_relief_category. That half is a recording feature and it exists.
 *   · "The monthly tax calculation reads these new fields" — built for the disabled-individual flag.
 *     WEIGHTING each child's relief by its category is deliberately NOT done: see the note at the foot
 *     of this file for why doing it would have broken the plan's own promise.
 *
 * THE THING THIS FILE EXISTS TO PIN. The plan tells the reporter, in as many words, that "everyone
 * currently in the system is treated as before until you set the new fields... No existing tax figure
 * changes on the day this ships." That is a promise about a legislated calculation, so it is asserted
 * here as arithmetic identity, not as a spot check:
 *   - `pcbMonth` with the flag absent, false, or a profile that predates the field ⇒ identical output;
 *   - a real payslip for an unflagged employee is identical to one generated before the field existed.
 *
 * SEPARATION OF POWERS. The employee's CIRCUMSTANCE (are they a registered disabled individual?) is
 * tenant data on employee_statutory_my. The DEDUCTION AMOUNT is statutory and lives only in the country
 * pack's ruleset (`pcb.reliefs.disabledIndividual`). The tests below pin that seam by driving the
 * amount from a supplied ruleset and watching P move by exactly that number — so no future change can
 * quietly turn a legislated figure into a tenant setting, and no inline constant can creep into the
 * calculation.
 *
 * ⚠️ The RM7,000 built-in is RATE-ONLY, not verified against the LHDN spec PDF (which now 404s); see
 * docs/architecture/STATUTORY-SOURCES.md §1. These tests deliberately assert the MECHANISM against a
 * ruleset-supplied number, so correcting the figure later changes one constant and no test.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createBatch, generatePayslips } from '../core/payroll';
import { pcbMonth, statutory } from '../localization/my/payroll';
import { DEFAULT_MY_STATUTORY, MY_RELIEFS } from '../localization/my/statutory-tables';
import { validateStatutoryRuleset } from '../localization/my/statutory-config';
import { getStatutoryProfileMY, setStatutoryProfileMY, setTaxProfileMY } from '../localization/my/statutory';
import { adminCtx, closeAll, latestEventPayload, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const root = fileURLToPath(new URL('..', import.meta.url));
const LOCALES = ['en', 'ms', 'zh', 'ta', 'th', 'vi'] as const;

// ── (1) The promise: an employee nobody has flagged computes EXACTLY as before ───────────────────────────
describe('d64d0df4 · defaults reproduce today’s PCB exactly', () => {
  const CASES = [
    { monthlyWage: 8000, epfMonthly: 880, month: 1, profile: { category: 1 as const, children: 0 } },
    { monthlyWage: 12000, epfMonthly: 1320, month: 7, profile: { category: 2 as const, children: 3 } },
    { monthlyWage: 4000, epfMonthly: 440, month: 12, profile: { category: 3 as const, children: 1 } },
    { monthlyWage: 25000, epfMonthly: 2750, month: 5, profile: { category: 2 as const, children: 5 } },
  ];

  it('absent, false, and pre-field profiles are all byte-identical to each other', () => {
    for (const c of CASES) {
      const preField = pcbMonth(c); // exactly the call shape that existed before this item
      const explicitFalse = pcbMonth({ ...c, profile: { ...c.profile, disabled: false } });
      const undefinedFlag = pcbMonth({ ...c, profile: { ...c.profile, disabled: undefined } });
      expect(explicitFalse, `wage ${c.monthlyWage}`).toEqual(preField);
      expect(undefinedFlag, `wage ${c.monthlyWage}`).toEqual(preField);
      // Chargeable income P is the value the deduction acts on — pin it directly, not just the MTD,
      // so a change that cancels out in the rounding still fails here.
      expect(explicitFalse.snapshot.P1).toBe(preField.snapshot.P1);
    }
  });

  it('the LHDN Exhibit-5 golden vector is unmoved (RM110.00 in January)', () => {
    // The spec's own worked example, which slice0 pins for the whole engine. Restated here because it is
    // the single figure that would betray an accidental change to the relief total.
    const before = statutory(5000, { category: 1, children: 0 }, 0, 0, { month: 1 });
    const after = statutory(5000, { category: 1, children: 0, disabled: false }, 0, 0, { month: 1 });
    expect(after.pcb).toBe(before.pcb);
    expect(before.pcb).toBeCloseTo(110, 2);
  });

  it('an employee with NO statutory row at all is unaffected (the kernel’s ?? false)', () => {
    // The kernel builds `disabled: e.disabledIndividual ?? false` — a person with no statutory row reads
    // NULL for every tax column, and a left join hands the kernel that null at runtime whatever the types
    // say. Feed the coalesced result of a genuine null through the calculator: it must land on the
    // unflagged path, not on undefined behaviour.
    // Read through a function so the compiler cannot fold the null away — the point is the RUNTIME
    // coalesce the kernel performs, not a type-level one.
    const nullColumn = (): boolean | null => JSON.parse('null') as boolean | null;
    const fromNullColumn = nullColumn() ?? false;
    const withNull = pcbMonth({
      monthlyWage: 8000,
      epfMonthly: 880,
      month: 3,
      profile: { category: 1, children: 0, disabled: fromNullColumn },
    });
    expect(withNull).toEqual(pcbMonth({ monthlyWage: 8000, epfMonthly: 880, month: 3, profile: { category: 1, children: 0 } }));
  });
});

// ── (2) The mechanism: the AMOUNT comes from the ruleset, never from the calculation ─────────────────────
describe('d64d0df4 · the deduction is pack data, not a constant in the calculation', () => {
  const call = (disabled: boolean, pcb?: typeof DEFAULT_MY_STATUTORY.pcb) =>
    pcbMonth({ monthlyWage: 20000, epfMonthly: 2200, month: 1, profile: { category: 1, children: 0, disabled }, pcb });

  it('flagging an employee lowers chargeable income P by EXACTLY the ruleset’s figure', () => {
    const ruleset = {
      ...DEFAULT_MY_STATUTORY.pcb,
      reliefs: { ...DEFAULT_MY_STATUTORY.pcb.reliefs, disabledIndividual: 1234 },
    };
    const off = call(false, ruleset);
    const on = call(true, ruleset);
    expect(off.snapshot.P1 - on.snapshot.P1).toBeCloseTo(1234, 2);
    // A lower chargeable income means a lower monthly deduction — the whole point of the feature.
    expect(on.total).toBeLessThan(off.total);
  });

  it('a different ruleset figure moves P by that different amount — nothing is hard-coded', () => {
    const shift = (amount: number) => {
      const pcb = { ...DEFAULT_MY_STATUTORY.pcb, reliefs: { ...DEFAULT_MY_STATUTORY.pcb.reliefs, disabledIndividual: amount } };
      return call(false, pcb).snapshot.P1 - call(true, pcb).snapshot.P1;
    };
    expect(shift(3000)).toBeCloseTo(3000, 2);
    expect(shift(9000)).toBeCloseTo(9000, 2);
    expect(shift(0)).toBeCloseTo(0, 2); // a ruleset that sets it to zero grants nothing
  });

  it('a ruleset PREDATING 2026.6 (no such key) falls back to the built-in, not to a silent zero', () => {
    // An admin override saved before this item omits the key entirely. The employee is still entitled to
    // the deduction — falling back to the verified built-in is the same shape hrdfLevy uses for rules.hrdf.
    // d64d0df4 step 3 — `reliefs` is no longer all-scalar (childByCategory is a map), so the cast
    // widens to `unknown` values. The assertion below is unchanged.
    const legacy = { ...DEFAULT_MY_STATUTORY.pcb, reliefs: { ...DEFAULT_MY_STATUTORY.pcb.reliefs } } as {
      bands: typeof DEFAULT_MY_STATUTORY.pcb.bands;
      reliefs: Record<string, unknown>;
    };
    delete legacy.reliefs.disabledIndividual;
    expect(legacy.reliefs.disabledIndividual).toBeUndefined();
    const drop =
      call(false, legacy as unknown as typeof DEFAULT_MY_STATUTORY.pcb).snapshot.P1 -
      call(true, legacy as unknown as typeof DEFAULT_MY_STATUTORY.pcb).snapshot.P1;
    expect(drop).toBeCloseTo(MY_RELIEFS.disabledIndividual, 2);
  });

  it('the bundled ruleset carries the figure and validates; a negative override is refused', () => {
    expect(DEFAULT_MY_STATUTORY.pcb.reliefs.disabledIndividual).toBe(MY_RELIEFS.disabledIndividual);
    expect(validateStatutoryRuleset(DEFAULT_MY_STATUTORY)).toEqual([]);

    const negative = {
      ...DEFAULT_MY_STATUTORY,
      pcb: { ...DEFAULT_MY_STATUTORY.pcb, reliefs: { ...DEFAULT_MY_STATUTORY.pcb.reliefs, disabledIndividual: -1 } },
    };
    expect(validateStatutoryRuleset(negative).some((e) => /disabled-individual/i.test(e))).toBe(true);

    // Absence is legitimate (pre-2026.6 overrides), so it must NOT be an error.
    const omitted = JSON.parse(JSON.stringify(DEFAULT_MY_STATUTORY)) as typeof DEFAULT_MY_STATUTORY;
    delete (omitted.pcb.reliefs as Record<string, unknown>).disabledIndividual;
    expect(validateStatutoryRuleset(omitted)).toEqual([]);
  });
});

// ── (3) i18n: every new key resolves in all six catalogs ────────────────────────────────────────────────
describe('d64d0df4 · i18n', () => {
  it('the Disabled Individual labels + the year-to-date warning exist in all six locales', () => {
    for (const l of LOCALES) {
      const messages = JSON.parse(readFileSync(`${root}messages/${l}.json`, 'utf8'));
      const detail = messages.people.detail;
      for (const k of [
        'disabledIndividualLabel',
        'disabledIndividualYes',
        'disabledIndividualNo',
        'disabledIndividualHint',
      ]) {
        expect(typeof detail[k], `${l}.people.detail.${k}`).toBe('string');
        expect(String(detail[k]).trim(), `${l}.people.detail.${k}`).not.toBe('');
      }
    }
  });
});

// ── (4) DB-backed: capture, audit, and a real payslip ───────────────────────────────────────────────────
describe('d64d0df4 · capture on the Tax Information card + consumption in payroll', () => {
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

  const hire = (a: SessionContext, name: string) =>
    hireEmployee(a, {
      person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@acme.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });

  const slip = async (employmentId: string) => {
    const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.employmentId, employmentId));
    return ps;
  };

  it('a freshly seeded statutory row defaults to No, and the tax card round-trips Yes', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Oku Round Trip');
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101015040' });

    // Migration 0341's default: nobody is claiming anything until an admin says so.
    expect((await getStatutoryProfileMY(a, e.personId))?.disabledIndividual).toBe(false);

    await setTaxProfileMY(a, { personId: e.personId, disabledIndividual: true });
    expect((await getStatutoryProfileMY(a, e.personId))?.disabledIndividual).toBe(true);

    // …and back off again. A relief claim must be revocable, or a mistyped save is permanent.
    await setTaxProfileMY(a, { personId: e.personId, disabledIndividual: false });
    expect((await getStatutoryProfileMY(a, e.personId))?.disabledIndividual).toBe(false);
  });

  it('a caller that omits the field does NOT claim the relief by accident', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Oku Omitted');
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101015041' });
    await setTaxProfileMY(a, { personId: e.personId, taxCategory: 2 }); // no disabledIndividual at all
    expect((await getStatutoryProfileMY(a, e.personId))?.disabledIndividual).toBe(false);
  });

  it('the claim is auditable — employee.tax.updated carries it on both sides of the change', async () => {
    const a = adminCtx(base);
    const e = await hire(a, 'Oku Audited');
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101015042' });
    const row = await getStatutoryProfileMY(a, e.personId);

    await setTaxProfileMY(a, { personId: e.personId, disabledIndividual: true });
    const payload = (await latestEventPayload(base.tenantId, row!.id, 'employee.tax.updated')) as Record<
      string,
      Record<string, unknown>
    >;
    expect(payload.before.disabledIndividual).toBe(false);
    expect(payload.after.disabledIndividual).toBe(true);
  });

  it('a flagged employee’s payslip PCB is lower; an unflagged colleague’s is untouched', async () => {
    const a = adminCtx(base);
    const plain = await hire(a, 'Pcb Plain');
    const oku = await hire(a, 'Pcb Oku');
    for (const emp of [plain, oku]) {
      await setCompensation(a, { employmentId: emp.employmentId, basicSalary: 12000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    }
    await setStatutoryProfileMY(a, { personId: plain.personId, icNumber: '900101015043' });
    await setStatutoryProfileMY(a, { personId: oku.personId, icNumber: '900101015044' });
    await setTaxProfileMY(a, { personId: oku.personId, disabledIndividual: true });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const psPlain = await slip(plain.employmentId);
    const psOku = await slip(oku.employmentId);
    const pcbPlain = Number((psPlain.statutory as Record<string, number>).pcb);
    const pcbOku = Number((psOku.statutory as Record<string, number>).pcb);
    expect(pcbPlain).toBeGreaterThan(0);
    expect(pcbOku).toBeLessThan(pcbPlain);

    // The move is the relief working through the projection, not a coincidence: P falls by exactly the
    // ruleset figure while every other statutory leg is identical (this is an income-tax relief only).
    const metaPlain = (psPlain.statutory as { pcbMeta: { P1: number } }).pcbMeta;
    const metaOku = (psOku.statutory as { pcbMeta: { P1: number } }).pcbMeta;
    expect(metaPlain.P1 - metaOku.P1).toBeCloseTo(MY_RELIEFS.disabledIndividual, 2);
    for (const leg of ['epfEmployee', 'epfEmployer', 'socsoEmployee', 'socsoEmployer', 'eisEmployee', 'eisEmployer'] as const) {
      expect(
        Number((psOku.statutory as Record<string, number>)[leg]),
        `${leg} must be untouched — this is an income-tax relief`,
      ).toBeCloseTo(Number((psPlain.statutory as Record<string, number>)[leg]), 2);
    }
  });
});

/*
 * WHY PER-CATEGORY CHILD RELIEF IS NOT WEIGHTED HERE (item d64d0df4, held with evidence).
 *
 * The plan's second bullet asks that "each child can be recorded at the correct relief rate". The
 * RECORDING exists: item 6c635212 shipped the five LHDN s.48 categories on the Family tab. What is not
 * built is PCB weighting them — `pcbMonth` still computes `children × perChild`, and turning the five
 * categories into five different deduction amounts was rejected for two reasons, either of which alone
 * is disqualifying:
 *
 *  1. IT WOULD BREAK THE PLAN'S OWN PROMISE. The plan tells the reporter "No existing tax figure changes
 *     on the day this ships." Every child already recorded under a category would immediately re-weight,
 *     so every employee with a recorded child — not merely the newly-flagged ones — would see their
 *     monthly tax move on deployment. That is the opposite of what was approved.
 *  2. THE PACK DOES NOT EXPRESS IT. `pcb.reliefs` carries ONE per-child figure. Per-category amounts
 *     (RM2,000 / RM8,000 / RM8,000 / …) are legislated data that the shipped ruleset does not carry, and
 *     the build note is explicit: if the pack does not express a relief, say so rather than approximate
 *     it — a wrong PCB is worse than an absent one.
 *
 * Recorded in docs/architecture/STATUTORY-SOURCES.md §1 under "Known limitations" so it is visible to
 * whoever signs the statutory figures off, rather than living only in this comment.
 */
