/**
 * 297ae65a — Currency on Basic Salary. Pins the service contract behind the new Currency field:
 *   1. Round-trip: a salary record stores its ISO 4217 currency (add + edit-in-place), the audit events
 *      record `currency` in fieldsChanged (never the pay figures), and history returns it for display.
 *   2. ISO validation: a non-ISO code is rejected server-side on both write paths; case is normalized.
 *   3. MYR-only regression + carry-forward: an omitted currency keeps the prior record's currency (MYR
 *      for a brand-new first record) — zero behavior change for existing data and pre-currency callers,
 *      and a basic-only revision never resets an SGD salary to MYR.
 *   4. Company default: company_payroll_config.default_currency round-trips through setPayrollConfig
 *      (clamp-not-throw: invalid/absent ⇒ 'MYR') — the value the Basic Salary form preselects.
 *   5. Display: the movement snapshot's salary string carries the record's currency.
 *   6. Payroll pre-check: a non-MYR salary under the MY pack surfaces as the NON-BLOCKING
 *      currencyMismatch warning (mixed batch names exactly the non-MYR employees); generation still
 *      succeeds — no math change.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  compensationHistoryDetailed,
  currentCompensation,
  setCompensation,
  updateCompensation,
} from '../core/comp';
import { getPayrollConfig, setPayrollConfig } from '../core/payroll-config';
import { movementDetail, movementHistory } from '../core/movement';
import { createBatch, generatePayslips, preProcessAdvisory } from '../core/payroll';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { hireEmployee } from '../core/org';
import {
  adminCtx,
  closeAll,
  eventTypesFor,
  latestEventPayload,
  migrateTestDb,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;
let icSeq = 0;
const nextIc = () => `9105050${String(10000 + icSeq++).slice(-5)}`;

const hire = (name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@currency.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('297ae65a — salary currency round-trip + validation', () => {
  it('stores the chosen ISO currency on add and edit, records it in the audit events, returns it in history', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire('Sari');
    await setCompensation(a, { employmentId, basicSalary: 7200, currency: 'SGD', effectiveFrom: '2026-01-01' });

    const cur = await currentCompensation(a, employmentId);
    expect(cur?.currency).toBe('SGD');
    // compensation.set audit: `currency` joins fieldsChanged; no cleartext pay/currency VALUES needed —
    // the record itself is the reference (ADR-0030 redact-to-reference is unchanged).
    const setPayload = await latestEventPayload(b.tenantId, cur!.id, 'compensation.set');
    expect(setPayload?.fieldsChanged).toContain('currency');

    // History (the screen's read) carries the currency for display alongside the amount.
    const [row] = await compensationHistoryDetailed(a, employmentId);
    expect(row.currency).toBe('SGD');

    // Edit-in-place: currency is editable on the open row; the compensation.updated audit records it.
    await updateCompensation(a, { compensationId: row.id, employmentId, currency: 'USD' });
    expect((await currentCompensation(a, employmentId))?.currency).toBe('USD');
    const updPayload = await latestEventPayload(b.tenantId, row.id, 'compensation.updated');
    expect(updPayload?.fieldsChanged).toContain('currency');

    // Re-submitting the SAME currency (the edit form always posts it) is not a change: no event appended.
    const eventsBefore = (await eventTypesFor(b.tenantId, row.id)).length;
    await updateCompensation(a, { compensationId: row.id, employmentId, currency: 'USD' });
    expect((await eventTypesFor(b.tenantId, row.id)).length).toBe(eventsBefore);
  });

  it('rejects a non-ISO currency on both write paths and normalizes case', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire('Vera');
    await expect(
      setCompensation(a, { employmentId, basicSalary: 5000, currency: 'ZZZ', effectiveFrom: '2026-01-01' }),
    ).rejects.toThrow(/Unknown currency/);

    // Lowercase input is normalized to the ISO uppercase code, not rejected.
    await setCompensation(a, { employmentId, basicSalary: 5000, currency: 'sgd', effectiveFrom: '2026-01-01' });
    const cur = await currentCompensation(a, employmentId);
    expect(cur?.currency).toBe('SGD');

    await expect(
      updateCompensation(a, { compensationId: cur!.id, employmentId, currency: 'NOPE' }),
    ).rejects.toThrow(/Unknown currency/);
    // The row is untouched by the rejected edit.
    expect((await currentCompensation(a, employmentId))?.currency).toBe('SGD');
  });

  it('MYR-only regression: an omitted currency defaults to MYR and carries forward across revisions', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire('Mona');
    // Pre-currency caller shape (no currency key) — brand-new record lands as MYR, exactly as before.
    await setCompensation(a, { employmentId, basicSalary: 5000, effectiveFrom: '2026-01-01' });
    expect((await currentCompensation(a, employmentId))?.currency).toBe('MYR');
    // …and its audit payload does NOT claim a currency change.
    const [first] = await compensationHistoryDetailed(a, employmentId);
    const p1 = await latestEventPayload(b.tenantId, first.id, 'compensation.set');
    expect(p1?.fieldsChanged).not.toContain('currency');

    // A currency, once set, survives a basic-only revision (carry-forward — never silently reset to MYR).
    await setCompensation(a, { employmentId, basicSalary: 6000, currency: 'SGD', effectiveFrom: '2026-06-01' });
    await setCompensation(a, { employmentId, basicSalary: 6500, effectiveFrom: '2026-09-01' });
    expect((await currentCompensation(a, employmentId))?.currency).toBe('SGD');
  });

  it('company default currency: round-trips via payroll config, invalid/absent clamps to MYR', async () => {
    const a = adminCtx(b);
    // Unset config ⇒ no row; the form-level fallback is MYR.
    expect(await getPayrollConfig(a, b.companyId)).toBeNull();

    // Lowercase in, ISO uppercase out.
    await setPayrollConfig(a, { companyId: b.companyId, defaultCurrency: 'sgd' });
    expect((await getPayrollConfig(a, b.companyId))?.defaultCurrency).toBe('SGD');

    // Clamp-not-throw: junk falls back to MYR rather than corrupting the row.
    await setPayrollConfig(a, { companyId: b.companyId, defaultCurrency: 'NOPE' });
    expect((await getPayrollConfig(a, b.companyId))?.defaultCurrency).toBe('MYR');

    // Absent field ⇒ MYR (the module's full-overwrite semantics, same as every sibling field).
    await setPayrollConfig(a, { companyId: b.companyId, cutOffDay: 25 });
    expect((await getPayrollConfig(a, b.companyId))?.defaultCurrency).toBe('MYR');
  });

  it('movement snapshot shows the salary with its currency', async () => {
    const a = adminCtx(b);
    const { employmentId } = await hire('Ming');
    await setCompensation(a, { employmentId, basicSalary: 7200, currency: 'SGD', effectiveFrom: '2026-01-01' });
    const rows = await movementHistory(a, employmentId);
    const hired = rows.find((r) => r.kind === 'hired')!;
    const detail = await movementDetail(a, employmentId, hired.id);
    expect(detail?.after.salary).toContain('SGD');
    expect(detail?.after.salary).toContain('7200');
  });
});

describe('297ae65a — payroll mixed-currency pre-check (non-blocking notice)', () => {
  /** Hire + salary + full statutory/bank profile so ONLY the currency notice can fire. */
  const hireComplete = async (name: string, currency?: string) => {
    const a = adminCtx(b);
    const e = await hire(name);
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: 4000,
      monthlyAllowance: 0,
      effectiveFrom: '2026-01-01',
      ...(currency ? { currency } : {}),
    });
    await setStatutoryProfileMY(a, {
      personId: e.personId,
      icNumber: nextIc(),
      bankName: 'Maybank',
      bankAccountNo: '1234567890',
    });
    return e;
  };

  it('flags exactly the non-MYR employees as a WARNING and never blocks generation', async () => {
    const a = adminCtx(b);
    const myr = await hireComplete('Ringgit Ross');
    const sgd = await hireComplete('Dollar Dana', 'SGD');

    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-05' });
    const checks = await preProcessAdvisory(a, batchId);

    // Mixed batch: only the SGD employee is named; no other class fires for either employee.
    expect((checks.currencyMismatch ?? []).map((r) => r.employmentId)).toEqual([sgd.employmentId]);
    expect((checks.currencyMismatch ?? []).map((r) => r.employmentId)).not.toContain(myr.employmentId);
    expect(checks.missingCompensation).toHaveLength(0);
    expect(checks.missingStatutory).toHaveLength(0);
    expect(checks.missingBank).toHaveLength(0);

    // NON-BLOCKING notice tier: generation proceeds (amounts processed as entered — no math change).
    await expect(generatePayslips(a, { batchId })).resolves.toMatchObject({ payslips: 2 });
  });

  it('an all-MYR batch raises no currency notice (regression: zero behavior change)', async () => {
    const a = adminCtx(b);
    await hireComplete('Ringgit Rena');
    await hireComplete('Ringgit Remy', 'MYR');
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-05' });
    const checks = await preProcessAdvisory(a, batchId);
    expect(checks.currencyMismatch ?? []).toHaveLength(0);
  });
});
