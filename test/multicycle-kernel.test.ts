/**
 * Wave 2C #4 — multi-cycle payroll KERNEL integration (ADR-0024). Proves the gated additional-run path
 * (createAdditionalRun + generatePayslips' increment method) reproduces the §7 accountant sign-off
 * figures through the real DB kernel, and that the per-run deltas sum to the single-batch month:
 *   - the regular run is normal remuneration; the bonus run is additional remuneration (Steps 1–5);
 *   - SOCSO/EIS are charged ONCE (only the regular run); the bonus run adds RM0 (Act 4 s.6(7)/6(9));
 *   - EPF is ONE Third Schedule lookup on the month's normal wage plus its additional remuneration
 *     (bdf7d248, r210), except the employer under KWSP's Part A bonus note: a ≤RM5,000 normal wage whose
 *     bonus takes the month above RM5,000 pays 13% of the month (7f5cc653, 2026-11-16 — which is why the
 *     employer assertion below moved from RM1,800 back to RM1,950).
 * Gated behind the `multi_cycle_payroll` MODULE ENTITLEMENT (ADR-0077 slice 3 — it was the
 * MULTI_CYCLE_PAYROLL_ENABLED deployment flag until the gate moved into `tenant_module`), so it never
 * runs for real payroll until the §7 sign-off.
 *
 * BOTH TESTS DRIVE `entitledCtx`, NOT `adminCtx`. `adminCtx` carries a SYNTHETIC snapshot derived from
 * `legacyEnabledModulesIn(process.env)` — the same helper `seedBase` uses — so it reads
 * `multi_cycle_payroll` and `typed_pay_components` OFF under the suite's env, and a `setModule` grant
 * reaches it only through the harness's in-memory mirror of that write. `entitledCtx` resolves a REAL
 * snapshot from this tenant's ROWS, so the row IS the gate with nothing in between. (Until slice 3
 * `adminCtx` was `entitlementsExempt: 'harness'` and answered TRUE for every catalogued module, which
 * would have moved the earnings source off the legacy path these figures were signed off against —
 * the reason this file was converted, kept on the record.)
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createAdditionalRun, createBatch, generatePayslips, setPayrollInput } from '../core/payroll';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

const round2 = (n: number) => Math.round(n * 100) / 100;
const stOf = async (batchId: string): Promise<Record<string, number>> => {
  const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
  return (ps.statutory ?? {}) as Record<string, number>;
};

describe('Wave 2C #4 — multi-cycle kernel (ADR-0024 §7 sign-off figures)', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    // No module grant here: `seedBase` seeds NO `multi_cycle_payroll` row (it narrows the parity set by
    // the live env, and test/env.ts deletes the flag), and a missing row is DISABLED (C7). Each test
    // states its own gate — on via `setModule(..., 'active')`, off by leaving the row absent — so the
    // per-test grant is visible at the assertion it supports rather than hidden in a shared hook.
    base = await seedBase();
  });
  afterAll(async () => {
    await closeAll();
  });

  it('May RM5,000 regular + RM10,000 bonus: per-run deltas reproduce the §7 worksheet and sum to the month', async () => {
    // Gate ON for this tenant — the entitlement row IS what createAdditionalRun now reads.
    // `entitledCtx` snapshots point-in-time, so the grant must be written BEFORE the context is built.
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Worksheet', primaryEmail: 'ws@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2025-01-01',
    });
    await setCompensation(a, {
      employmentId: e.employmentId,
      basicSalary: 5000,
      monthlyAllowance: 0,
      effectiveFrom: '2025-01-01',
    });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });

    // Jan–Apr 2026: a single normal RM5,000 month each → seeds May's prior-month PCB accumulators.
    for (const m of ['2026-01', '2026-02', '2026-03', '2026-04']) {
      const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: m });
      await generatePayslips(a, { batchId });
    }

    // May run 1 — regular (normal remuneration, Y1 = 5,000).
    const reg = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: reg.batchId });
    const r1 = await stOf(reg.batchId);

    // May run 2 — bonus RM10,000 (additional remuneration, increment method).
    const bonusRun = await createAdditionalRun(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      runType: 'bonus',
    });
    await setPayrollInput(a, { batchId: bonusRun.batchId, employmentId: e.employmentId, overtimeAmount: 0, bonusAmount: 10000 });
    await generatePayslips(a, { batchId: bonusRun.batchId });
    const r2 = await stOf(bonusRun.batchId);

    // §7 #5/#6/#7 — PCB: run 1 normal MTD, run 2 additional MTD, sum == single monthly MTD.
    expect(r1.pcb).toBeCloseTo(110, 2);
    expect(r2.pcb).toBeCloseTo(950, 2);
    expect(round2(r1.pcb + r2.pcb)).toBeCloseTo(1060, 2);

    // §7 #3/#4 — SOCSO/EIS charged ONCE for the month (only the regular run); the bonus run adds RM0.
    expect(r1.socsoEmployee).toBeGreaterThan(0);
    expect(r1.eisEmployee).toBeGreaterThan(0);
    expect(r2.socsoEmployee).toBe(0);
    expect(r2.socsoEmployer).toBe(0);
    expect(r2.eisEmployee).toBe(0);
    expect(r2.eisEmployer).toBe(0);

    // §7 #1/#2 — employee: the Third Schedule read ONCE for the month (bdf7d248): RM5,000 + RM10,000 is
    // a RM15,000 month, ceil(11% × 15,000) = RM1,650.
    // RESTATED 2026-11-16 FOR ITEM 7f5cc653 (ADR-0024 addendum 2026-11-16): employer was 1,800 (the 12%
    // row for RM15,000) under bdf7d248's combined reading. KWSP's Part A bonus note keeps a ≤RM5,000
    // earner whose bonus crosses RM5,000 at 13% of the month's wages: 15,000 × 13% = RM1,950 (was 1,800).
    expect(round2(r1.epfEmployee + r2.epfEmployee)).toBe(1650);
    expect(round2(r1.epfEmployer + r2.epfEmployer)).toBe(1950);
  });

  it('createAdditionalRun is GATED behind the multi_cycle_payroll entitlement', async () => {
    // Gate OFF = NO row (C7: a missing row is disabled, and that is a different state from an explicit
    // status='disabled' row). Written explicitly rather than relying on seedBase's omission, so the
    // disabled state this test asserts is stated where it is asserted.
    await setModule(base.tenantId, 'multi_cycle_payroll', null);
    const a = await entitledCtx(base);
    await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await expect(
      createAdditionalRun(a, { companyId: base.companyId, payPeriod: '2026-05', runType: 'bonus' }),
    ).rejects.toThrow(/not enabled/i);
  });
});
