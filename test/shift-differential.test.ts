/**
 * ADR-0032 C5 — shift-differential pay prefill. A shift's configurable differential (flat_per_shift /
 * flat_hourly / percent) is summed from worked differential shifts in the pay period and written to the
 * SHIFT_DIFFERENTIAL batch component. Gated by the `typed_pay_components` MODULE entitlement
 * (ADR-0077 slice 3 — no row / not active ⇒ no-op).
 *
 * The gate is `isModuleEnabled(ctx, 'typed_pay_components')`, so the CONTEXT decides: `adminCtx` is
 * `entitlementsExempt: 'harness'` and answers `true` for every catalogued module, which is right for
 * building fixtures but structurally cannot exercise the gate. Every call to the function UNDER TEST
 * therefore goes through `entitledCtx`, which carries a real snapshot resolved from this tenant's rows
 * — built AFTER the `setModule` call that establishes the state being asserted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { createBatch, prefillShiftDifferentialFromRoster } from '../core/payroll';
import { seedPayComponentCatalog } from '../core/pay-components';
import { assignShift, createShift } from '../core/roster';
import { checkIn, checkOut } from '../core/attendance';
import type { ShiftDifferential } from '../db/schema';

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

async function differentialAmount(batchId: string, employmentId: string): Promise<number | null> {
  const [row] = await owner.db
    .select({ amount: schema.payrollBatchComponent.amount })
    .from(schema.payrollBatchComponent)
    .innerJoin(schema.payComponent, eq(schema.payComponent.id, schema.payrollBatchComponent.componentId))
    .where(and(eq(schema.payrollBatchComponent.batchId, batchId), eq(schema.payrollBatchComponent.employmentId, employmentId), eq(schema.payComponent.code, 'SHIFT_DIFFERENTIAL')));
  return row ? Number(row.amount) : null;
}

/**
 * Hire, comp, seed catalog, create a differential shift, work it on two days, create a 2026-07 batch.
 *
 * Fixture-building only, so it keeps the exempt `adminCtx` (that is what the marker is for). The gate
 * lives in `prefillShiftDifferentialFromRoster`, and every test drives THAT through `entitledCtx`.
 */
async function setup(differential: ShiftDifferential, basic: number) {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Shifter', primaryEmail: `s_${Math.random().toString(36).slice(2)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  await seedPayComponentCatalog(a);
  const shiftId = (await createShift(a, { companyId: b.companyId, name: 'Night', code: 'NIGHT', startTime: '08:00:00', endTime: '17:00:00', breakMinutes: 60, differential })).id;
  for (const d of ['2026-07-01', '2026-07-02']) {
    await assignShift(a, { employmentId: e.employmentId, shiftDate: d, shiftId });
    await checkIn(a, { employmentId: e.employmentId, date: d, time: '08:00:00' });
    await checkOut(a, { employmentId: e.employmentId, date: d, time: '17:00:00' }); // worked 480 = 8h each
  }
  const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });
  return { employmentId: e.employmentId, batchId };
}

/** Turn the module on for this tenant and return a context that RESOLVES that row (not an exempt one). */
async function entitledOn() {
  await setModule(b.tenantId, 'typed_pay_components', 'active');
  return entitledCtx(b);
}

describe('shift differential prefill (ADR-0032 C5)', () => {
  it('flat_hourly: RM2/hr × 8h × 2 days = RM32', async () => {
    const { employmentId, batchId } = await setup({ kind: 'flat_hourly', value: 2 }, 5000);
    const r = await prefillShiftDifferentialFromRoster(await entitledOn(), { batchId });
    expect(r.applied).toBe(1);
    expect(await differentialAmount(batchId, employmentId)).toBe(32);
  });

  it('percent: 10% of ORP (RM25/hr) × 8h × 2 days = RM40', async () => {
    // basic 5200 ⇒ ORP = 5200 / 26 / 8 = RM25/hr; 25 × 8 × 0.10 = 20/day × 2 = 40
    const { employmentId, batchId } = await setup({ kind: 'percent', value: 10 }, 5200);
    await prefillShiftDifferentialFromRoster(await entitledOn(), { batchId });
    expect(await differentialAmount(batchId, employmentId)).toBe(40);
  });

  it('flat_per_shift: RM15 × 2 shifts = RM30', async () => {
    const { employmentId, batchId } = await setup({ kind: 'flat_per_shift', value: 15 }, 5000);
    await prefillShiftDifferentialFromRoster(await entitledOn(), { batchId });
    expect(await differentialAmount(batchId, employmentId)).toBe(30);
  });

  it('is a no-op when the typed_pay_components module is not entitled (gated)', async () => {
    const { employmentId, batchId } = await setup({ kind: 'flat_per_shift', value: 15 }, 5000);
    // seedBase already seeds NO row for this module, so this is a no-op DELETE — kept explicit because
    // what the test asserts is the missing-row (= disabled, C7) path, not an incidental default.
    await setModule(b.tenantId, 'typed_pay_components', null);
    const r = await prefillShiftDifferentialFromRoster(await entitledCtx(b), { batchId });
    expect(r).toMatchObject({ applied: 0, gated: true });
    expect(await differentialAmount(batchId, employmentId)).toBeNull();
  });
});
