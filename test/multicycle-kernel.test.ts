/**
 * Wave 2C #4 — multi-cycle payroll KERNEL integration (ADR-0024). Proves the gated additional-run path
 * (createAdditionalRun + generatePayslips' increment method) reproduces the §7 accountant sign-off
 * figures through the real DB kernel, and that the per-run deltas sum to the single-batch month:
 *   - the regular run is normal remuneration; the bonus run is additional remuneration (Steps 1–5);
 *   - SOCSO/EIS are charged ONCE (only the regular run); the bonus run adds RM0 (Act 4 s.6(7)/6(9));
 *   - EPF is the combined-month round-up, employer rate anchored to the normal wage.
 * Gated behind MULTI_CYCLE_PAYROLL_ENABLED, so it never runs for real payroll until the §7 sign-off.
 */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createAdditionalRun, createBatch, generatePayslips, setPayrollInput } from '../core/payroll';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

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
    base = await seedBase();
    process.env.MULTI_CYCLE_PAYROLL_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.MULTI_CYCLE_PAYROLL_ENABLED;
  });
  afterAll(async () => {
    await closeAll();
  });

  it('May RM5,000 regular + RM10,000 bonus: per-run deltas reproduce the §7 worksheet and sum to the month', async () => {
    const a = adminCtx(base);
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

    // §7 #1/#2 — EPF combined: 11% of (5,000 + 10,000) = RM1,650 employee; employer anchored at 13% = RM1,950.
    expect(round2(r1.epfEmployee + r2.epfEmployee)).toBe(1650);
    expect(round2(r1.epfEmployer + r2.epfEmployer)).toBe(1950);
  });

  it('createAdditionalRun is GATED behind MULTI_CYCLE_PAYROLL_ENABLED', async () => {
    delete process.env.MULTI_CYCLE_PAYROLL_ENABLED;
    const a = adminCtx(base);
    await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await expect(
      createAdditionalRun(a, { companyId: base.companyId, payPeriod: '2026-05', runType: 'bonus' }),
    ).rejects.toThrow(/not enabled/i);
  });
});
