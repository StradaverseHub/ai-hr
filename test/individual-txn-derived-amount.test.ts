/**
 * 2da9937a — Formula Builder for payroll items: the Individual Transaction screen finally consults the
 * picked pay item's RULE.
 *
 * THE DEFECT THIS FILE PINS. The individual-transaction write path never looked at the pay item at all. It
 * demanded an Amount and asserted it was greater than zero, so an item configured "RM x per hour" was
 * arithmetic the operator had to do by hand — and if they typed the wrong number, the wrong number was
 * paid. The reporter's Overtime 1.5 was configured correctly the whole time; nothing reached it.
 *
 * THIS CHANGES MONEY, so every assertion here is on a FIGURE or on a REFUSAL, never on "the save
 * succeeded". Four things have to be true at once and each has its own test:
 *   A. the derived figure is what the EVALUATOR produces for the same inputs — not a second multiply
 *      living in the transaction screen (the preview-cannot-drift contract);
 *   B. a typed amount on a calculating item is IGNORED, because otherwise the derivation is advisory and
 *      a tampered post still pays whatever it likes;
 *   C. a calculating item REFUSES a save with no quantity — falling back to the employee's attendance
 *      total would quietly pay a whole month of overtime for a row meant to be ten hours;
 *   D. an item with no rule (or a `fixed` one) is byte-identical to before, and a row already on file
 *      keeps its amount even after its item later gains a rule.
 *
 * The refusals assert the exact error key rather than "it failed", because on this subject the wrong
 * failure is a wrong payslip that got lucky.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the vi.mock factories (hoisted to top-of-file) can reference them safely — the same shape
// test/fixed-transaction-action.test.ts uses for an action under test.
const { scope } = vi.hoisted(() => ({ scope: { s: null as unknown, scopeIds: [] as string[] } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
// The zero-divisor sentence is localised in the action (the precedent previewPayRuleAction set). There is
// no next-intl request context in a unit test, so the translator is stubbed to echo its key — the tests
// below assert FIGURES, never the wording.
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import {
  OvertimeReferenceUnusableError,
  listPayComponents,
  seedOvertimeMultipliers,
  seedPayComponentCatalog,
  upsertPayComponent,
} from '../core/pay-components';
import {
  DERIVED_AMOUNT_RULE_KINDS,
  payRuleDerivesAmount,
  payRuleInputUnit,
  resolvePayComponentSet,
  type PayRule,
} from '../core/pay-rule';
import {
  createIndividualTxnAction,
  previewTxnAmountAction,
  updateIndividualTxnAction,
} from '../app/payroll/transactions/individual/actions';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const PERIOD = '2026-05';
const TXN_DATE = '2026-05-10';
const BASIC = 5200;

/** One hourly rate, used by every per-hour fixture here so a wrong figure is obvious on sight. */
const HOURLY_1_5 = 16.5;

let base: Base;

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
  const a = adminCtx(base);
  await seedPayComponentCatalog(a);
  scope.s = a;
  scope.scopeIds = [base.companyId];
});
afterAll(async () => {
  await closeAll();
});

/** Hire one employee with a compensation record — the authoritative `basic` every rule reads. */
async function hire() {
  const a = adminCtx(base);
  const e = await hireEmployee(a, {
    person: { fullName: 'Derived Amt', primaryEmail: `derived${randomUUID()}@acme.test` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: BASIC, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
  return e;
}

/** Create (or re-rule) a catalog allowance and return its id. */
async function payItem(code: string, name: string, rule: PayRule | null): Promise<string> {
  const a = adminCtx(base);
  await upsertPayComponent(a, {
    code,
    name,
    kind: 'allowance',
    includedInEpf: false,
    includedInSocsoEis: false,
    includedInPcb: true,
    includedInHrdfBase: false,
    isNonPayable: false,
    prorates: false,
    rule,
  });
  const cat = await listPayComponents(a);
  return cat.find((c) => c.code === code)!.id;
}

/** The one-off row this employee has, straight from the table — the stored amount is what payroll pays. */
async function storedRows(employmentId: string) {
  return owner.db
    .select()
    .from(schema.payrollIndividualTxn)
    .where(eq(schema.payrollIndividualTxn.employmentId, employmentId));
}

/** The write the screen makes: period-keyed (no run exists yet for the month), one employee, one row. */
function post(employmentId: string, over: Partial<Parameters<typeof createIndividualTxnAction>[0]> = {}) {
  return createIndividualTxnAction({
    employmentId,
    companyId: base.companyId,
    payPeriod: PERIOD,
    batchId: '',
    kind: 'earning',
    componentId: null,
    txnDate: TXN_DATE,
    amount: 0,
    quantity: null,
    unit: null,
    notes: null,
    ...over,
  });
}

describe('2da9937a — a one-off transaction takes its amount from the pay item that calculates it', () => {
  // ── A. the derived figure IS the evaluator's figure ──

  it('a per_hour item keyed with 10 hours stores the figure resolvePayComponentSet produces, not a typed one', async () => {
    const e = await hire();
    const rule: PayRule = { kind: 'per_hour', rate: HOURLY_1_5 };
    const componentId = await payItem('OT1_5', 'Overtime 1.5', rule);

    const res = await post(e.employmentId, { componentId, quantity: 10, unit: 'hours', amount: 0 });
    expect(res).toMatchObject({ ok: true });

    // THE CONTRACT: the figure written equals what THE evaluator returns for the same inputs. Asserting
    // 165 alone would pass against a hard-coded multiply in the action; this pins that there is only one
    // implementation, which is the whole point of routing through resolvePayComponentSet.
    const [viaEvaluator] = resolvePayComponentSet(
      [{ code: 'OT1_5', rule, amount: 0, resolutionOrder: 0, kind: 'allowance' }],
      { basic: BASIC, daysWorked: 31, hours: 10, components: { BASIC: BASIC } },
    );
    expect(viaEvaluator).toBeCloseTo(165, 4);

    const rows = await storedRows(e.employmentId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].amount)).toBeCloseTo(viaEvaluator, 2);
    // The keyed quantity survives on the row: it is the input the figure came from, and a reader who
    // cannot see it cannot check the arithmetic.
    expect(Number(rows[0].quantity)).toBeCloseTo(10, 2);
    expect(rows[0].unit).toBe('hours');
  });

  it('a formula reading `hours` uses the KEYED hours, not the employee’s attendance total', async () => {
    const e = await hire();
    // (basic / 26 / 8) × 1.5 × hours — the reporter's own worked shape, with literal divisors.
    const rule: PayRule = {
      kind: 'formula',
      start: { ref: 'basic' },
      terms: [
        { op: '/', operand: { ref: 'number', value: 26 } },
        { op: '/', operand: { ref: 'number', value: 8 } },
        { op: '*', operand: { ref: 'number', value: 1.5 } },
        { op: '*', operand: { ref: 'hours' } },
      ],
    };
    const componentId = await payItem('OTF', 'Overtime by formula', rule);

    // The employee has a full month of attendance. If the derivation read the PERIOD aggregate instead of
    // the keyed quantity, the figure would be ~16× larger — which is the silent overpayment this asserts
    // cannot happen.
    await owner.db.insert(schema.attendance).values(
      Array.from({ length: 20 }, (_, i) => ({
        tenantId: base.tenantId,
        employmentId: e.employmentId,
        attendanceDate: `2026-05-${String(i + 1).padStart(2, '0')}`,
        workedMinutes: 480,
      })),
    );

    const res = await post(e.employmentId, { componentId, quantity: 10, unit: 'hours', amount: 0 });
    expect(res).toMatchObject({ ok: true });

    const expected = (BASIC / 26 / 8) * 1.5 * 10;
    const rows = await storedRows(e.employmentId);
    expect(Number(rows[0].amount)).toBeCloseTo(expected, 2);
  });

  // ── B. a typed amount does not get a vote ──

  it('a typed amount on a calculating item is IGNORED — the item’s own figure is stored', async () => {
    const e = await hire();
    const componentId = await payItem('OT1_5', 'Overtime 1.5', { kind: 'per_hour', rate: HOURLY_1_5 });

    // 999 is what a tampered post (or a stale browser) would send. The screen makes the box read-only;
    // this is the half that matters, because a read-only box is a suggestion until the server enforces it.
    const res = await post(e.employmentId, { componentId, quantity: 10, unit: 'hours', amount: 999 });
    expect(res).toMatchObject({ ok: true });

    const rows = await storedRows(e.employmentId);
    expect(Number(rows[0].amount)).toBeCloseTo(165, 2);
    expect(Number(rows[0].amount)).not.toBeCloseTo(999, 2);
  });

  it('an edit re-derives: changing the hours changes the stored amount', async () => {
    const e = await hire();
    const componentId = await payItem('OT1_5', 'Overtime 1.5', { kind: 'per_hour', rate: HOURLY_1_5 });
    const created = await post(e.employmentId, { componentId, quantity: 10, unit: 'hours', amount: 0 });
    expect(created).toMatchObject({ ok: true });
    const id = (created as { ok: true; id?: string }).id!;

    const res = await updateIndividualTxnAction({
      id,
      companyId: base.companyId,
      kind: 'earning',
      componentId,
      txnDate: TXN_DATE,
      amount: 165,
      quantity: 12,
      unit: 'hours',
      notes: null,
    });
    expect(res).toMatchObject({ ok: true });
    const rows = await storedRows(e.employmentId);
    expect(Number(rows[0].amount)).toBeCloseTo(198, 2); // 16.50 × 12
  });

  // ── C. the refusals ──

  it('a per_hour item saved with NO hours is refused with quantityRequiredHours, and writes nothing', async () => {
    const e = await hire();
    const componentId = await payItem('OT1_5', 'Overtime 1.5', { kind: 'per_hour', rate: HOURLY_1_5 });

    // The exact key matters: this refusal must be about the missing HOURS, not the old
    // "amount must be greater than zero" complaint about a box the operator can no longer fill.
    const res = await post(e.employmentId, { componentId, quantity: null, unit: null, amount: 250 });
    expect(res).toEqual({ ok: false, error: 'quantityRequiredHours' });
    expect(await storedRows(e.employmentId)).toHaveLength(0);
  });

  it('a per_hour item saved with a quantity in the WRONG unit is refused too', async () => {
    const e = await hire();
    const componentId = await payItem('OT1_5', 'Overtime 1.5', { kind: 'per_hour', rate: HOURLY_1_5 });
    // 10 DAYS against a per-hour rate would otherwise resolve to a plausible-looking figure from the
    // employee's attendance hours while the operator believed they had keyed the input.
    const res = await post(e.employmentId, { componentId, quantity: 10, unit: 'days', amount: 0 });
    expect(res).toEqual({ ok: false, error: 'quantityRequiredHours' });
    expect(await storedRows(e.employmentId)).toHaveLength(0);
  });

  it('a per_day item asks for DAYS', async () => {
    const e = await hire();
    const componentId = await payItem('UNPAID_D', 'Unpaid day', { kind: 'per_day', rate: 100 });
    expect(await post(e.employmentId, { componentId, quantity: null, unit: null, amount: 5 })).toEqual({
      ok: false,
      error: 'quantityRequiredDays',
    });
    const ok = await post(e.employmentId, { componentId, quantity: 3, unit: 'days', amount: 0 });
    expect(ok).toMatchObject({ ok: true });
    const rows = await storedRows(e.employmentId);
    expect(Number(rows[0].amount)).toBeCloseTo(300, 2);
  });

  it('the magnitude rule SURVIVES on a plain amount item — zero is still refused', async () => {
    const e = await hire();
    // No rule at all: the amount is the operator's, and "greater than zero" is the right thing to say.
    const componentId = await payItem('MEAL', 'Meal allowance', null);
    expect(await post(e.employmentId, { componentId, amount: 0 })).toEqual({ ok: false, error: 'amountNotPositive' });
    expect(await post(e.employmentId, { componentId, amount: -5 })).toEqual({ ok: false, error: 'amountNotPositive' });
    expect(await storedRows(e.employmentId)).toHaveLength(0);
  });

  // ── D. nothing that already worked changes ──

  it('an item with no rule keeps the typed amount byte-identical', async () => {
    const e = await hire();
    const componentId = await payItem('MEAL', 'Meal allowance', null);
    expect(await post(e.employmentId, { componentId, amount: 123.45 })).toMatchObject({ ok: true });
    const rows = await storedRows(e.employmentId);
    expect(rows[0].amount).toBe('123.45');
  });

  it('a `fixed` rule is the legacy path too — the typed amount stands', async () => {
    const e = await hire();
    const componentId = await payItem('MEAL', 'Meal allowance', { kind: 'fixed' });
    expect(await post(e.employmentId, { componentId, amount: 123.45 })).toMatchObject({ ok: true });
    const rows = await storedRows(e.employmentId);
    // A `fixed` rule is NOT imposed on a one-off. `fixed` means "the stored amount", and on this ledger
    // the stored amount is the one that was keyed.
    expect(rows[0].amount).toBe('123.45');
  });

  it('a transaction already on file keeps its amount when its pay item LATER gains a rule', async () => {
    const e = await hire();
    const componentId = await payItem('OT1_5', 'Overtime 1.5', null);
    expect(await post(e.employmentId, { componentId, amount: 250 })).toMatchObject({ ok: true });

    // The item is reconfigured to calculate. Every row already keyed is money someone has agreed to; this
    // change is about what the screen ASKS FOR, not about revaluing history.
    await payItem('OT1_5', 'Overtime 1.5', { kind: 'per_hour', rate: HOURLY_1_5 });
    const rows = await storedRows(e.employmentId);
    expect(rows[0].amount).toBe('250.00');
  });

  it('a row with no pay item at all (a generic kind) is untouched by any of this', async () => {
    const e = await hire();
    expect(await post(e.employmentId, { kind: 'overtime', componentId: null, amount: 77.5 })).toMatchObject({ ok: true });
    const rows = await storedRows(e.employmentId);
    expect(rows[0].amount).toBe('77.50');
  });

  // ── the preview the operator sees is the same call the save makes ──

  it('the previewed figure is the figure that gets stored', async () => {
    const e = await hire();
    const componentId = await payItem('OT1_5', 'Overtime 1.5', { kind: 'per_hour', rate: HOURLY_1_5 });

    const preview = await previewTxnAmountAction({
      componentId,
      employmentId: e.employmentId,
      companyId: base.companyId,
      payPeriod: PERIOD,
      quantity: 7.5,
      unit: 'hours',
    });
    expect(preview).toMatchObject({ ok: true, derived: true, amount: '123.75', inputUnit: 'hours' });

    await post(e.employmentId, { componentId, quantity: 7.5, unit: 'hours', amount: 0 });
    const rows = await storedRows(e.employmentId);
    expect(rows[0].amount).toBe('123.75');
  });

  it('the preview reports a plain item as NOT derived, so the screen keeps its Amount box', async () => {
    const e = await hire();
    const componentId = await payItem('MEAL', 'Meal allowance', null);
    expect(
      await previewTxnAmountAction({
        componentId,
        employmentId: e.employmentId,
        companyId: base.companyId,
        payPeriod: PERIOD,
        quantity: null,
        unit: null,
      }),
    ).toEqual({ ok: true, derived: false });
  });

  it('the preview will not answer for an employee in a DIFFERENT company', async () => {
    // RLS isolates tenants, not companies. Without the employment↔company check an admin scoped to one
    // company could read another company's employee's basic salary back out of a formula's figure. The
    // answer is "nothing derived" — the write path's own company guard is what refuses a save.
    const e = await hire();
    const otherCompany = (
      await owner.db
        .insert(schema.company)
        .values({ tenantId: base.tenantId, legalName: 'Other Co', registrationNo: `OC-${randomUUID().slice(0, 8)}` })
        .returning({ id: schema.company.id })
    )[0].id;
    const componentId = await payItem('OT1_5', 'Overtime 1.5', { kind: 'per_hour', rate: HOURLY_1_5 });
    scope.scopeIds = [base.companyId, otherCompany];
    expect(
      await previewTxnAmountAction({
        componentId,
        employmentId: e.employmentId, // belongs to base.companyId
        companyId: otherCompany,
        payPeriod: PERIOD,
        quantity: 10,
        unit: 'hours',
      }),
    ).toEqual({ ok: true, derived: false });
  });

  it('the preview refuses a company outside the caller’s scope', async () => {
    const e = await hire();
    const componentId = await payItem('OT1_5', 'Overtime 1.5', { kind: 'per_hour', rate: HOURLY_1_5 });
    scope.scopeIds = []; // the admin administers no company
    expect(
      await previewTxnAmountAction({
        componentId,
        employmentId: e.employmentId,
        companyId: base.companyId,
        payPeriod: PERIOD,
        quantity: 10,
        unit: 'hours',
      }),
    ).toEqual({ ok: false, error: 'outOfScope' });
  });
});

describe('2da9937a — payRuleDerivesAmount / payRuleInputUnit', () => {
  // The screen and the write path both branch on these two, so which rule kinds they claim IS the
  // behaviour. A silent widening would take the Amount box away from an item that has no input to
  // replace it with.
  it('names exactly the three kinds that work an amount out from the operator’s input', () => {
    expect(payRuleDerivesAmount(null)).toBe(false);
    expect(payRuleDerivesAmount({ kind: 'fixed' })).toBe(false);
    expect(payRuleDerivesAmount({ kind: 'percent_of', base: 'basic', pct: 10 })).toBe(false);
    expect(payRuleDerivesAmount({ kind: 'flat_capped', value: 10, cap: 5 })).toBe(false);
    expect(payRuleDerivesAmount({ kind: 'per_hour', rate: 1 })).toBe(true);
    expect(payRuleDerivesAmount({ kind: 'per_day', rate: 1 })).toBe(true);
    // qty_rate is NOT here, and that is the point: it has no operator input to derive FROM
    // (payRuleInputUnit returns null for it), so deriving would mean overwriting the typed amount with a
    // catalog constant. See DERIVED_AMOUNT_RULE_KINDS.
    expect(payRuleDerivesAmount({ kind: 'qty_rate', qty: 2, rate: 3 })).toBe(false);
  });

  it('asks for the input the rule actually reads', () => {
    expect(payRuleInputUnit(null)).toBeNull();
    expect(payRuleInputUnit({ kind: 'per_hour', rate: 1 })).toBe('hours');
    expect(payRuleInputUnit({ kind: 'per_day', rate: 1 })).toBe('days');
    // qty_rate has nothing for the operator to key, which is exactly why it does not derive either.
    expect(payRuleInputUnit({ kind: 'qty_rate', qty: 2, rate: 3 })).toBeNull();
    expect(
      payRuleInputUnit({ kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '*', operand: { ref: 'hours' } }] }),
    ).toBe('hours');
    expect(
      payRuleInputUnit({ kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '/', operand: { ref: 'days' } }] }),
    ).toBe('days');
    // A formula that reads neither is fully determined by the employee's own figures.
    expect(
      payRuleInputUnit({ kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '*', operand: { ref: 'number', value: 2 } }] }),
    ).toBeNull();
  });
});

describe('2da9937a — the screen’s new copy resolves in every locale', () => {
  /**
   * THE DYNAMIC KEYS ARE THE ONES THAT BITE. `quantityLabel.<unit>` and `derivedAmountHint.<unit>` are
   * built from payRuleInputUnit's answer at render time, so a missing branch is not a compile error and
   * not a 500 — it is a MISSING_MESSAGE that renders as the raw key on a payroll entry screen. The static
   * keys are covered by scripts/i18n-check.mjs's parity gate; these are the ones it cannot see.
   */
  it('every quantityLabel.* / derivedAmountHint.* branch resolves non-empty in all 6 locales', () => {
    const LOCALES = ['en', 'ms', 'ta', 'th', 'vi', 'zh'] as const;
    const MESSAGES = path.resolve(__dirname, '../messages');
    // Exactly the values payRuleInputUnit can return, plus the 'none' branch the form uses when it
    // returns null — so this list cannot drift from the code without the type changing.
    const UNITS: ReadonlyArray<'hours' | 'days'> = ['hours', 'days'];
    for (const loc of LOCALES) {
      const ind = JSON.parse(fs.readFileSync(path.join(MESSAGES, `${loc}.json`), 'utf8')).payroll.transactions.individual;
      for (const u of UNITS) {
        expect(String(ind.quantityLabel?.[u] ?? '').trim().length, `${loc} quantityLabel.${u}`).toBeGreaterThan(0);
        expect(String(ind.derivedAmountHint?.[u] ?? '').trim().length, `${loc} derivedAmountHint.${u}`).toBeGreaterThan(0);
      }
      expect(String(ind.derivedAmountHint?.none ?? '').trim().length, `${loc} derivedAmountHint.none`).toBeGreaterThan(0);
      // The two refusal keys the ACTION returns and the form resolves with t(res.error) — a bare error key
      // on screen is the same class of fault as a bare label.
      for (const k of ['quantityRequiredHours', 'quantityRequiredDays', 'derivedAmountUnavailable', 'derivedAmountPending', 'derivedAmountLabel']) {
        expect(String(ind[k] ?? '').trim().length, `${loc} ${k}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('2da9937a — the worked overtime examples', () => {
  it('seeds Overtime 2.0 and 3.0 by SCALING the tenant’s own 1.5 rate, through the admin writer', async () => {
    const a = adminCtx(base);
    await payItem('OT1_5', 'Overtime 1.5', { kind: 'per_hour', rate: HOURLY_1_5 });

    const res = await seedOvertimeMultipliers(a);
    expect(res.created).toEqual(['OT2_0', 'OT3_0']);
    expect(res.hourlyRate).toBeCloseTo(11, 4); // 16.50 at 1.5× ⇒ RM 11.00 plain

    const cat = await listPayComponents(a);
    const ot2 = cat.find((c) => c.code === 'OT2_0')!;
    const ot3 = cat.find((c) => c.code === 'OT3_0')!;
    expect(ot2.rule).toMatchObject({ kind: 'per_hour', rate: 22 });
    expect(ot3.rule).toMatchObject({ kind: 'per_hour', rate: 33 });
    // The statutory treatment is COPIED, never re-decided: 2× of the same payment is taxed the same way.
    const ref = cat.find((c) => c.code === 'OT1_5')!;
    for (const c of [ot2, ot3]) {
      expect({
        kind: c.kind,
        includedInEpf: c.includedInEpf,
        includedInSocsoEis: c.includedInSocsoEis,
        includedInPcb: c.includedInPcb,
        includedInHrdfBase: c.includedInHrdfBase,
        isNonPayable: c.isNonPayable,
        prorates: c.prorates,
        displayCategory: c.displayCategory,
      }).toEqual({
        kind: ref.kind,
        includedInEpf: ref.includedInEpf,
        includedInSocsoEis: ref.includedInSocsoEis,
        includedInPcb: ref.includedInPcb,
        includedInHrdfBase: ref.includedInHrdfBase,
        isNonPayable: ref.isNonPayable,
        prorates: ref.prorates,
        displayCategory: ref.displayCategory,
      });
    }
    // It went through the same writer the admin screen uses, so it left the same audit trail.
    expect(await eventTypesFor(base.tenantId, ot2.id)).toContain('pay-component.created');
  });

  it('a re-run SKIPS what exists rather than overwriting a rate someone has since corrected', async () => {
    const a = adminCtx(base);
    await payItem('OT1_5', 'Overtime 1.5', { kind: 'per_hour', rate: HOURLY_1_5 });
    await seedOvertimeMultipliers(a);
    // The admin corrects OT2_0 by hand.
    await payItem('OT2_0', 'Overtime 2.0', { kind: 'per_hour', rate: 25 });

    const again = await seedOvertimeMultipliers(a);
    expect(again.created).toEqual([]);
    expect(again.skipped).toEqual(['OT2_0', 'OT3_0']);
    const cat = await listPayComponents(a);
    expect(cat.find((c) => c.code === 'OT2_0')!.rule).toMatchObject({ kind: 'per_hour', rate: 25 });
  });

  it('refuses to invent a rate when there is nothing to scale from', async () => {
    const a = adminCtx(base);
    // No OT1_5 at all.
    await expect(seedOvertimeMultipliers(a)).rejects.toBeInstanceOf(OvertimeReferenceUnusableError);
    // Present, but as a plain stored amount — there is no hourly figure in it.
    await payItem('OT1_5', 'Overtime 1.5', null);
    await seedOvertimeMultipliers(a).then(
      () => expect.unreachable('expected OvertimeReferenceUnusableError'),
      (e: unknown) => expect((e as OvertimeReferenceUnusableError).reason).toBe('not_per_hour'),
    );
    expect((await listPayComponents(a)).some((c) => c.code === 'OT2_0')).toBe(false);
  });
});

describe('2da9937a — a qty_rate item keeps the operator\'s typed amount', () => {
  /**
   * FOUND IN VERIFICATION, and it was a money defect.
   *
   * qty_rate was in DERIVED_AMOUNT_RULE_KINDS, which locks the Amount box and overwrites the typed figure.
   * But payRuleInputUnit returns null for qty_rate — there IS no quantity box — so resolvePayComponentSet
   * computed rule.qty * rule.rate from the CATALOG. A COMMISSION item configured {qty: 1, rate: 50} would
   * take a keyed 600 for twelve units and pay 50, on a payslip, with nothing on screen to say so.
   *
   * Deriving is only safe when the operator has a box that feeds the derivation.
   */
  it('does NOT derive: the amount the operator keys is the amount written', () => {
    const rule = { kind: 'qty_rate', qty: 1, rate: 50 } as const;
    expect(payRuleDerivesAmount(rule), 'qty_rate must not lock the Amount box').toBe(false);
    expect(payRuleInputUnit(rule), 'and it has no quantity box to key into').toBeNull();
  });

  it('the three kinds that DO derive each have a box that feeds them', () => {
    // The other half: every kind we do derive must name the input the operator supplies, or it repeats
    // exactly the qty_rate mistake under a different name.
    for (const kind of DERIVED_AMOUNT_RULE_KINDS) {
      if (kind === 'formula') continue; // a formula may be fully determined by the employee's own figures
      const rule = { kind, rate: 10 } as unknown as Parameters<typeof payRuleInputUnit>[0];
      expect(payRuleInputUnit(rule), `${kind} must name the quantity the operator keys`).not.toBeNull();
    }
  });
});
