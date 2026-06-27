/**
 * 1.2.6 EA Data Overwrite — service + merge. An EA-ONLY amendment layer: HR overrides specific EA-form
 * fields and the read overlays them onto the payroll-derived statement, WITHOUT mutating any payslip. We
 * assert: the baseline statement; an `allowances` override re-reads amended + recomputes partB.gross so the
 * lines sum to the total (the load-bearing §0 fix); the payslip row is unchanged (the "no payroll mutation"
 * guarantee, asserted directly); an explicit `gross` override wins over the component recompute; a no-op
 * (amended == derived) is treated as a clear; a zero-payroll-year override is allowed (baseline 0);
 * validation rejects negative / bad-year / empty-reason / unknown-field; and the domain events fire with the
 * right subject + before/after.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { adminCtx, closeAll, latestEventPayload, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { employeeEaStatement } from '../core/reporting';
import { setEaOverride, clearEaOverride, listEaOverrides, EaOverrideError } from '../core/ea-override';

async function seedEmployeeWithPayslip(base: Base) {
  const a = adminCtx(base);
  const E = await hireEmployee(a, {
    person: { fullName: 'Owner A', primaryEmail: 'owner.a@acme.test' },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, { employmentId: E.employmentId, basicSalary: 5000, effectiveFrom: '2026-01-01' });
  await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '900101015555', taxCategory: 1, numChildren: 0 });
  const batch = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-01' });
  await generatePayslips(a, { batchId: batch.batchId });
  return E;
}

describe('1.2.6 EA Data Overwrite — service + merge', () => {
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

  it('baseline statement has no overrides; allowances override re-reads amended + recomputes gross', async () => {
    const a = adminCtx(base);
    const E = await seedEmployeeWithPayslip(base);

    const before = await employeeEaStatement(a, { employmentId: E.employmentId, year: '2026' });
    expect(before).not.toBeNull();
    expect(before!.overrides).toEqual([]);
    const derivedAllow = before!.partB.allowances;
    const derivedGross = before!.partB.gross;

    // Capture the payslip BEFORE the override so we can prove it is untouched after.
    const [psBefore] = await owner.db
      .select({ id: schema.payslip.id, allowance: schema.payslip.allowance, gross: schema.payslip.grossPay })
      .from(schema.payslip)
      .where(eq(schema.payslip.employmentId, E.employmentId));

    const amended = derivedAllow + 1000;
    const r = await setEaOverride(a, { employmentId: E.employmentId, year: '2026', field: 'allowances', amount: amended, reason: 'arrears adjustment' });
    expect(r.cleared).toBe(false);

    const after = await employeeEaStatement(a, { employmentId: E.employmentId, year: '2026' });
    expect(after!.partB.allowances).toBeCloseTo(amended, 2);
    // §0: partB.gross is recomputed from post-overlay components so the lines sum to the total.
    expect(after!.partB.gross).toBeCloseTo(after!.partB.grossSalary + after!.partB.bonus + after!.partB.allowances, 2);
    expect(after!.partB.gross).toBeCloseTo(derivedGross + 1000, 2);
    expect(after!.overrides).toEqual([
      { field: 'allowances', original: derivedAllow, amended, reason: 'arrears adjustment' },
    ]);

    // The "no payroll mutation" guarantee — assert the payslip row is byte-identical.
    const [psAfter] = await owner.db
      .select({ id: schema.payslip.id, allowance: schema.payslip.allowance, gross: schema.payslip.grossPay })
      .from(schema.payslip)
      .where(eq(schema.payslip.employmentId, E.employmentId));
    expect(psAfter).toEqual(psBefore);

    // Domain event: ea.override.set with the right subject + before/after.
    const types = await eventTypesFor(base.tenantId, await firstOverrideId(base.tenantId, E.employmentId));
    expect(types).toContain('ea.override.set');
    const payload = await latestEventPayload(base.tenantId, await firstOverrideId(base.tenantId, E.employmentId), 'ea.override.set');
    expect(payload).toMatchObject({ field: 'allowances', before: derivedAllow, after: amended, reason: 'arrears adjustment' });
  });

  it('an explicit gross override wins over the component recompute', async () => {
    const a = adminCtx(base);
    const E = await seedEmployeeWithPayslip(base);

    await setEaOverride(a, { employmentId: E.employmentId, year: '2026', field: 'allowances', amount: 99999, reason: 'x' });
    await setEaOverride(a, { employmentId: E.employmentId, year: '2026', field: 'gross', amount: 12345.67, reason: 'known total' });

    const ea = await employeeEaStatement(a, { employmentId: E.employmentId, year: '2026' });
    // Even though allowances was bumped, the explicit gross override wins.
    expect(ea!.partB.gross).toBeCloseTo(12345.67, 2);
  });

  it('a no-op (amended == derived) is treated as a clear, not a redundant override', async () => {
    const a = adminCtx(base);
    const E = await seedEmployeeWithPayslip(base);
    const base0 = await employeeEaStatement(a, { employmentId: E.employmentId, year: '2026' });
    const derivedMtd = base0!.partD.mtd;

    const r = await setEaOverride(a, { employmentId: E.employmentId, year: '2026', field: 'mtd', amount: derivedMtd, reason: 'no change' });
    expect(r.cleared).toBe(true);
    const rows = await listEaOverrides(a, { employmentId: E.employmentId, year: '2026' });
    expect(rows.find((x) => x.field === 'mtd')).toBeUndefined();
  });

  it('allows an override on a zero-payroll year (baseline 0)', async () => {
    const a = adminCtx(base);
    const E = await hireEmployee(a, {
      person: { fullName: 'No Pay', primaryEmail: 'nopay@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setStatutoryProfileMY(a, { personId: E.personId, icNumber: '900202025555', taxCategory: 1, numChildren: 0 });

    const r = await setEaOverride(a, { employmentId: E.employmentId, year: '2027', field: 'bonus', amount: 2000, reason: 'HR-known figure' });
    expect(r.cleared).toBe(false);
    const ea = await employeeEaStatement(a, { employmentId: E.employmentId, year: '2027' });
    expect(ea!.partB.bonus).toBeCloseTo(2000, 2);
    const payload = await latestEventPayload(base.tenantId, await firstOverrideId(base.tenantId, E.employmentId), 'ea.override.set');
    expect(payload).toMatchObject({ field: 'bonus', before: 0, after: 2000 });
  });

  it('validation: rejects negative amount, bad year, empty reason, unknown field', async () => {
    const a = adminCtx(base);
    const E = await seedEmployeeWithPayslip(base);
    await expect(setEaOverride(a, { employmentId: E.employmentId, year: '2026', field: 'epf', amount: -5, reason: 'x' })).rejects.toThrow(EaOverrideError);
    await expect(setEaOverride(a, { employmentId: E.employmentId, year: '26', field: 'epf', amount: 5, reason: 'x' })).rejects.toThrow(EaOverrideError);
    await expect(setEaOverride(a, { employmentId: E.employmentId, year: '2026', field: 'epf', amount: 5, reason: '   ' })).rejects.toThrow(EaOverrideError);
    await expect(setEaOverride(a, { employmentId: E.employmentId, year: '2026', field: 'unknown', amount: 5, reason: 'x' })).rejects.toThrow(EaOverrideError);
  });

  it('clearEaOverride hard-deletes + appends ea.override.cleared with the prior value', async () => {
    const a = adminCtx(base);
    const E = await seedEmployeeWithPayslip(base);
    await setEaOverride(a, { employmentId: E.employmentId, year: '2026', field: 'socso', amount: 42.5, reason: 'fix' });
    const id = await firstOverrideId(base.tenantId, E.employmentId);

    const r = await clearEaOverride(a, { employmentId: E.employmentId, year: '2026', field: 'socso' });
    expect(r.cleared).toBe(true);
    const rows = await listEaOverrides(a, { employmentId: E.employmentId, year: '2026' });
    expect(rows.find((x) => x.field === 'socso')).toBeUndefined();

    const types = await eventTypesFor(base.tenantId, id);
    expect(types).toContain('ea.override.cleared');
    const payload = await latestEventPayload(base.tenantId, id, 'ea.override.cleared');
    expect(payload).toMatchObject({ field: 'socso', before: 42.5 });
  });

  it('zeroing a derived figure is allowed (>= 0 rule)', async () => {
    const a = adminCtx(base);
    const E = await seedEmployeeWithPayslip(base);
    const r = await setEaOverride(a, { employmentId: E.employmentId, year: '2026', field: 'bonus', amount: 0, reason: 'no bonus paid' });
    // bonus derived is 0 here too (no bonus), so this is a no-op clear — but the >=0 rule itself must not reject.
    expect(typeof r.cleared).toBe('boolean');
  });
});

/** The id of the (single) ea_override row for an employment, via the owner connection (RLS-bypassed). */
async function firstOverrideId(tenantId: string, employmentId: string): Promise<string> {
  const [row] = await owner.db
    .select({ id: schema.eaOverride.id })
    .from(schema.eaOverride)
    .where(and(eq(schema.eaOverride.tenantId, tenantId), eq(schema.eaOverride.employmentId, employmentId)));
  return row?.id ?? '00000000-0000-0000-0000-000000000000';
}
