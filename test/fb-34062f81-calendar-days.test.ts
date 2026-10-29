/**
 * 34062f81 — "Basic Salary / Calendar Days in the Month × Days Worked" on a dated one-off transaction.
 *
 *   (a) THE FORMULA SAVES. The pay-rule validator already accepted it; the editor's amber division
 *       advisory only made it LOOK rejected (see fb-34062f81-division-advisory.dom.test.tsx). Pinned here
 *       at the service: it validates, saves through upsertPayComponent and reads back unchanged, while
 *       genuinely invalid formulas (unsupported operand, literal zero divisor) are still refused and a
 *       live divisor that is zero still pays 0 with a notice instead of aborting.
 *   (b) CALENDAR DAYS FOLLOW THE EFFECTIVE DATE. Each dated line divides by the length of ITS OWN month —
 *       leap February included — independently of the pay month and of every other line, through the
 *       preview AND the save, and the saved row keeps its date and Days unit.
 *
 * EXPECTED FIGURES ARE THE REPORTER'S OWN, as literals (RM3,000 basic, 1 day): 28-Sep-2026 100.00,
 * 10-Oct-2026 96.77, 15-Feb-2026 107.14, 15-Feb-2024 103.45, 10-Apr-2026 100.00. They are never recomputed
 * with the code under test.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { scope } = vi.hoisted(() => ({ scope: { s: null as unknown, scopeIds: [] as string[] } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(() => undefined), revalidateTag: vi.fn(() => undefined) }));
vi.mock('@/lib/scope', () => ({ scopedAdmin: vi.fn(async () => scope) }));
vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(async () => (key: string) => key) }));

import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import {
  TxnEffectiveDateInvalidError,
  TxnQuantityRequiredError,
  deriveIndividualTxnAmount,
  listPayComponents,
  seedPayComponentCatalog,
  upsertPayComponent,
} from '../core/pay-components';
import {
  resolvePayRule,
  validatePayRule,
  validatePayRuleAgainstCatalog,
  type PayRule,
  type PayRuleZeroDivisorNotice,
} from '../core/pay-rule';
import {
  createIndividualTxnAction,
  createIndividualTxnDayGridAction,
  previewTxnAmountAction,
  previewTxnAmountsAction,
  updateIndividualTxnAction,
} from '../app/payroll/transactions/individual/actions';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const BASIC = 3000;
/** The pay month every line below is PAID in — deliberately none of the reporter's dates' months but one. */
const PERIOD = '2026-10';

/** The reporter's formula, exactly as the structured builder stores it. */
const REPORTED: PayRule = {
  kind: 'formula',
  start: { ref: 'basic' },
  terms: [
    { op: '/', operand: { ref: 'calendar_days' } },
    { op: '*', operand: { ref: 'days' } },
  ],
};

/** The reporter's table, as independent literals. */
const ONE_DAY: [date: string, amount: string][] = [
  ['2026-09-28', '100.00'],
  ['2026-10-10', '96.77'],
  ['2026-02-15', '107.14'],
  ['2024-02-15', '103.45'],
  ['2026-04-10', '100.00'],
];

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

async function hire(b: Base = base) {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Calendar Days', primaryEmail: `cal${randomUUID()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2020-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: BASIC, monthlyAllowance: 0, effectiveFrom: '2020-01-01' });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
  return e;
}

async function payItem(code: string, name: string, rule: PayRule | null, b: Base = base): Promise<string> {
  const a = adminCtx(b);
  await upsertPayComponent(a, {
    label: name,
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

async function storedRows(employmentId: string) {
  return owner.db.select().from(schema.payrollIndividualTxn).where(eq(schema.payrollIndividualTxn.employmentId, employmentId));
}

const derive = (componentId: string, employmentId: string, over: Partial<Parameters<typeof deriveIndividualTxnAmount>[1]> = {}) =>
  deriveIndividualTxnAmount(adminCtx(base), {
    componentId,
    employmentId,
    companyId: base.companyId,
    payPeriod: PERIOD,
    quantity: 1,
    unit: 'days',
    ...over,
  });

describe('34062f81 (a) — the reported formula is valid and saves; genuine faults are still refused', () => {
  it('validates structurally and against the catalog', () => {
    expect(validatePayRule(REPORTED, false)).toEqual({ ok: true });
    expect(validatePayRuleAgainstCatalog({ code: 'UPL', rule: REPORTED, kind: 'allowance' }, [])).toEqual({ ok: true });
  });

  it('saves through the admin writer and reads back unchanged', async () => {
    const id = await payItem('UPL', 'Unpaid Leave', REPORTED);
    const saved = (await listPayComponents(adminCtx(base))).find((c) => c.id === id)!;
    expect(saved.rule).toEqual(REPORTED);
  });

  it('still refuses an unsupported operand and a literal zero divisor', () => {
    const unsupported = { ...REPORTED, terms: [{ op: '/', operand: { ref: 'salary_of_ceo' } }] } as unknown as PayRule;
    expect(validatePayRule(unsupported, false).ok).toBe(false);
    const zero: PayRule = { ...REPORTED, terms: [{ op: '/', operand: { ref: 'number', value: 0 } }, { op: '*', operand: { ref: 'days' } }] } as PayRule;
    expect(validatePayRule(zero, false)).toEqual({ ok: false, code: 'UNSAFE_DIVISION' });
  });

  it('a missing (absent ⇒ 0) or zero calendar-days divisor pays 0 with a notice instead of failing', () => {
    for (const calendarDays of [undefined, 0]) {
      const notices: PayRuleZeroDivisorNotice[] = [];
      const v = resolvePayRule(REPORTED, { basic: BASIC, daysWorked: 1, hours: 0, ...(calendarDays === undefined ? {} : { calendarDays }) }, 0, notices);
      expect(v).toBe(0);
      expect(notices).toEqual([{ divisor: 'calendar_days', step: 1 }]);
    }
    // Zero days worked is a multiplier, not a divisor: 0 with no notice.
    const notices: PayRuleZeroDivisorNotice[] = [];
    expect(resolvePayRule(REPORTED, { basic: BASIC, daysWorked: 0, hours: 0, calendarDays: 30 }, 0, notices)).toBe(0);
    expect(notices).toEqual([]);
  });
});

describe('34062f81 (b) — calendar days come from each line’s Effective Date', () => {
  it('prices the reporter’s five dates with their own month length (leap February 2024 included)', async () => {
    const e = await hire();
    const id = await payItem('UPL', 'Unpaid Leave', REPORTED);
    for (const [date, amount] of ONE_DAY) {
      const d = await derive(id, e.employmentId, { effectiveDate: date });
      expect(d.derived).toBe(true);
      if (!d.derived) continue;
      expect([date, d.amount.toFixed(2)]).toEqual([date, amount]);
      expect(d.inputUnit).toBe('days');
    }
  });

  it('with NO Effective Date the pay month still decides — existing behaviour unchanged', async () => {
    const e = await hire();
    const id = await payItem('UPL', 'Unpaid Leave', REPORTED);
    const oct = await derive(id, e.employmentId); // October: 3000 / 31
    expect(oct.derived && oct.amount.toFixed(2)).toBe('96.77');
    const sep = await derive(id, e.employmentId, { payPeriod: '2026-09', effectiveDate: null }); // September: / 30
    expect(sep.derived && sep.amount.toFixed(2)).toBe('100.00');
  });

  it('a formula that does not read calendar days is unaffected by the date', async () => {
    const e = await hire();
    const literal: PayRule = { kind: 'formula', start: { ref: 'basic' }, terms: [{ op: '/', operand: { ref: 'number', value: 26 } }, { op: '*', operand: { ref: 'days' } }] };
    const id = await payItem('UPL26', 'Unpaid Leave (26)', literal);
    for (const date of ['2024-02-15', '2026-10-10', undefined]) {
      const d = await derive(id, e.employmentId, { effectiveDate: date });
      expect(d.derived && d.amount.toFixed(2)).toBe('115.38'); // 3000 / 26
    }
  });

  it('refuses a malformed Effective Date rather than re-dating the line', async () => {
    const e = await hire();
    const id = await payItem('UPL', 'Unpaid Leave', REPORTED);
    for (const bad of ['2026-02-30', '2026-13-01', '15-02-2026', '', '0000-01-01']) {
      await expect(derive(id, e.employmentId, { effectiveDate: bad })).rejects.toBeInstanceOf(TxnEffectiveDateInvalidError);
    }
  });

  it('Days stay Days: an Hours quantity is refused for a Days formula', async () => {
    const e = await hire();
    const id = await payItem('UPL', 'Unpaid Leave', REPORTED);
    await expect(derive(id, e.employmentId, { unit: 'hours', effectiveDate: '2026-09-28' })).rejects.toBeInstanceOf(TxnQuantityRequiredError);
  });

  it('Hours stay Hours: an hours formula also divides by its own date’s month', async () => {
    const e = await hire();
    // basic / calendar days / 8 × hours — a fictional hourly variant.
    const hourly: PayRule = {
      kind: 'formula',
      start: { ref: 'basic' },
      terms: [
        { op: '/', operand: { ref: 'calendar_days' } },
        { op: '/', operand: { ref: 'number', value: 8 } },
        { op: '*', operand: { ref: 'hours' } },
      ],
    };
    const id = await payItem('UPLH', 'Unpaid Leave hourly', hourly);
    const sep = await derive(id, e.employmentId, { unit: 'hours', quantity: 8, effectiveDate: '2026-09-28' });
    expect(sep.derived && [sep.inputUnit, sep.amount.toFixed(2)]).toEqual(['hours', '100.00']);
    await expect(derive(id, e.employmentId, { unit: 'days', quantity: 1, effectiveDate: '2026-09-28' })).rejects.toBeInstanceOf(TxnQuantityRequiredError);
  });

  it('answers nothing for an employment in another company, and nothing across tenants', async () => {
    const e = await hire();
    const id = await payItem('UPL', 'Unpaid Leave', REPORTED);
    const otherCompany = (
      await owner.db
        .insert(schema.company)
        .values({ tenantId: base.tenantId, legalName: 'Other Co', registrationNo: `OC-${randomUUID().slice(0, 8)}` })
        .returning({ id: schema.company.id })
    )[0].id;
    expect(await derive(id, e.employmentId, { companyId: otherCompany, effectiveDate: '2026-09-28' })).toEqual({ derived: false });

    const foreign = await seedBase();
    expect(
      await deriveIndividualTxnAmount(adminCtx(foreign), {
        componentId: id,
        employmentId: e.employmentId,
        companyId: base.companyId,
        payPeriod: PERIOD,
        quantity: 1,
        unit: 'days',
        effectiveDate: '2026-09-28',
      }),
    ).toEqual({ derived: false });
  });
});

describe('34062f81 (b) — the screen’s actions: preview and save agree, line by line', () => {
  it('the batched preview prices equal quantities in different months differently', async () => {
    const e = await hire();
    const id = await payItem('UPL', 'Unpaid Leave', REPORTED);
    const r = await previewTxnAmountsAction({
      componentId: id,
      employmentId: e.employmentId,
      companyId: base.companyId,
      payPeriod: PERIOD,
      unit: 'days',
      entries: ONE_DAY.map(([txnDate]) => ({ txnDate, quantity: '1' })),
    });
    expect(r).toMatchObject({ ok: true, derived: true, inputUnit: 'days' });
    if (!r.ok || !r.derived) throw new Error('expected a derived preview');
    expect(r.amounts.map((a) => [a.txnDate, a.quantity, a.amount])).toEqual(ONE_DAY.map(([d, amt]) => [d, '1', amt]));
  });

  it('an undated preview entry is priced against the pay month, as before', async () => {
    const e = await hire();
    const id = await payItem('UPL', 'Unpaid Leave', REPORTED);
    const r = await previewTxnAmountsAction({
      componentId: id,
      employmentId: e.employmentId,
      companyId: base.companyId,
      payPeriod: '2026-09',
      unit: 'days',
      entries: [{ txnDate: '', quantity: '1' }],
    });
    expect(r.ok && r.derived && r.amounts).toEqual([{ txnDate: '', quantity: '1', amount: '100.00' }]);
  });

  it('the preview refuses a malformed date and an out-of-scope company', async () => {
    const e = await hire();
    const id = await payItem('UPL', 'Unpaid Leave', REPORTED);
    const input = { componentId: id, employmentId: e.employmentId, companyId: base.companyId, payPeriod: PERIOD, unit: 'days' };
    expect(await previewTxnAmountsAction({ ...input, entries: [{ txnDate: '2026-02-30', quantity: '1' }] })).toEqual({ ok: false, error: 'invalidEffectiveDate' });
    expect(await previewTxnAmountAction({ ...input, quantity: 1, txnDate: '2026-02-30' })).toEqual({ ok: false, error: 'invalidEffectiveDate' });
    scope.scopeIds = [];
    expect(await previewTxnAmountsAction({ ...input, entries: [{ txnDate: '2026-09-28', quantity: '1' }] })).toEqual({ ok: false, error: 'outOfScope' });
    expect(await createIndividualTxnDayGridAction({
      employmentId: e.employmentId, companyId: base.companyId, payPeriod: PERIOD, batchId: '', kind: 'earning', componentId: id,
      unit: 'days', intendedCycleId: null, lines: [{ txnDate: '2026-09-28', amount: 0, quantity: 1, notes: null }],
    })).toEqual({ ok: false, error: 'outOfScope' });
  });

  it('the single-entry preview follows its Effective Date', async () => {
    const e = await hire();
    const id = await payItem('UPL', 'Unpaid Leave', REPORTED);
    const p = await previewTxnAmountAction({ componentId: id, employmentId: e.employmentId, companyId: base.companyId, payPeriod: PERIOD, quantity: 1, unit: 'days', txnDate: '2024-02-15' });
    expect(p).toMatchObject({ ok: true, derived: true, amount: '103.45', inputUnit: 'days' });
  });

  it('the day grid stores each line at its own figure, with its date and Days unit, matching the preview', async () => {
    const e = await hire();
    const id = await payItem('UPL', 'Unpaid Leave', REPORTED);
    const res = await createIndividualTxnDayGridAction({
      employmentId: e.employmentId,
      companyId: base.companyId,
      payPeriod: PERIOD,
      batchId: '',
      kind: 'earning',
      componentId: id,
      unit: 'days',
      intendedCycleId: null,
      // A tampered typed amount must not survive on a calculating item.
      lines: ONE_DAY.map(([txnDate], i) => ({ txnDate, amount: 999, quantity: 1, notes: `line ${i}` })),
    });
    expect(res).toMatchObject({ ok: true, count: 5 });
    const rows = (await storedRows(e.employmentId)).sort((a, b) => (a.notes! < b.notes! ? -1 : 1));
    expect(rows.map((r) => [r.txnDate, r.amount, Number(r.quantity), r.unit, r.payPeriod])).toEqual(
      ONE_DAY.map(([d, amt]) => [d, amt, 1, 'days', PERIOD]),
    );
  });

  it('single create and edit both re-price by the row’s date; moving the date re-prices', async () => {
    const e = await hire();
    const id = await payItem('UPL', 'Unpaid Leave', REPORTED);
    const created = await createIndividualTxnAction({
      employmentId: e.employmentId, companyId: base.companyId, payPeriod: PERIOD, batchId: '', intendedCycleId: null,
      kind: 'earning', componentId: id, txnDate: '2026-02-15', amount: 0, quantity: 1, unit: 'days', notes: null,
    });
    expect(created).toMatchObject({ ok: true });
    expect((await storedRows(e.employmentId)).map((r) => [r.txnDate, r.amount])).toEqual([['2026-02-15', '107.14']]);

    const rowId = (created as { id: string }).id;
    const updated = await updateIndividualTxnAction({
      id: rowId, companyId: base.companyId, kind: 'earning', componentId: id, txnDate: '2024-02-15', amount: 0, quantity: 1, unit: 'days', notes: null,
    });
    expect(updated).toMatchObject({ ok: true });
    expect((await storedRows(e.employmentId)).map((r) => [r.txnDate, r.amount, r.unit])).toEqual([['2024-02-15', '103.45', 'days']]);

    // A malformed date on save is refused with the screen's own key, and nothing is written.
    const bad = await createIndividualTxnAction({
      employmentId: e.employmentId, companyId: base.companyId, payPeriod: PERIOD, batchId: '', intendedCycleId: null,
      kind: 'earning', componentId: id, txnDate: '2026-02-30', amount: 0, quantity: 1, unit: 'days', notes: null,
    });
    expect(bad).toMatchObject({ ok: false, error: 'invalidEffectiveDate' });
    expect(await storedRows(e.employmentId)).toHaveLength(1);
  });
});
