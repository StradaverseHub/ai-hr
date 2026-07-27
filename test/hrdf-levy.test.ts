/**
 * Wave 2A — HRD Corp (HRDF) levy (PSMB Act 2001). Two layers:
 *   • calculator (hrdfLevy): rate by registration band, employer-only, 2dp, floor at 0.
 *   • kernel (generatePayslips): the levy rides the payslip (employer-only) + batch totals + employer
 *     cost; the HRDF base is basic + FIXED allowance net of unpaid leave — NOT the EPF/SOCSO wage
 *     (overtime and bonus are excluded); and a not-registered company is byte-identical to pre-HRDF.
 * Sourced + re-verified in docs/wave2-payroll-design.md.
 *
 * ADR-0077 slice 3 — WHY THIS FILE DRIVES THE KERNEL THROUGH `entitledCtx`, NOT `adminCtx`.
 * Every assertion below is about the LEGACY earnings path: the HRDF base is `compensation.basic +
 * compensation.monthly_allowance`, and overtime/bonus come from `payroll_input`. That path is selected
 * by `typed_pay_components` being OFF (core/payroll.ts `earningsOf`) — under the typed path the kernel
 * reads the component tables instead, and a tenant with no `employment_pay_component` rows would
 * contribute a ZERO allowance, silently turning the 4500 base into 4000 and the 3200 base into 3000.
 * The gate used to be `process.env.TYPED_PAY_COMPONENTS_ENABLED`, which test/env.ts deletes, so
 * `adminCtx` was fine. It is a per-tenant entitlement now, and when this file was converted `adminCtx`
 * was `entitlementsExempt: 'harness'` — an exempt context answered TRUE for every catalogued module,
 * which would have put this file on the TYPED path and broken the very arithmetic it exists to pin.
 * (`adminCtx` now derives its snapshot from `legacyEnabledModulesIn(process.env)` and agrees with the
 * old env read; the hazard is recorded because it is what these figures are defended against.)
 * `entitledCtx` resolves a REAL snapshot from this tenant's rows; seedBase seeds no
 * `typed_pay_components` row (it is not in this process's parity set), and a missing row is disabled
 * (C7), so the legacy path is genuinely selected. Not a weakening: no assertion changed.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hrdfLevy } from '../localization/my/payroll';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { setCompensation } from '../core/comp';
import { createBatch, generatePayslips, setPayrollInput } from '../core/payroll';
import { hireEmployee } from '../core/org';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const hire = (ctx: SessionContext, b: Base, name: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });

const payslipFor = async (batchId: string) => {
  const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
  return ps;
};
const st = (ps: { statutory: unknown }) => ps.statutory as Record<string, number>;

describe('Wave 2A — hrdfLevy calculator', () => {
  it('is 0 when the employer is not registered (regardless of base)', () => {
    expect(hrdfLevy(5000, 'not_registered')).toBe(0);
  });
  it('mandatory band = 1% of the HRDF base', () => {
    expect(hrdfLevy(5000, 'mandatory')).toBe(50);
    expect(hrdfLevy(3210, 'mandatory')).toBe(32.1);
  });
  it('optional band = 0.5% of the HRDF base', () => {
    expect(hrdfLevy(5000, 'optional')).toBe(25);
    expect(hrdfLevy(4000, 'optional')).toBe(20);
  });
  it('carries sen, rounded to 2dp (HRD Corp prescribes no round-up-to-ringgit)', () => {
    expect(hrdfLevy(3333.33, 'mandatory')).toBe(33.33);
    expect(hrdfLevy(1234.5, 'optional')).toBe(6.17); // 6.1725 → 6.17
  });
  it('floors at 0 for a zero/negative base', () => {
    expect(hrdfLevy(0, 'mandatory')).toBe(0);
    expect(hrdfLevy(-100, 'mandatory')).toBe(0);
  });
});

describe('Wave 2A — HRDF in the payroll kernel', () => {
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

  it('not-registered company ⇒ no levy, byte-identical to pre-HRDF', async () => {
    const a = await entitledCtx(base);
    const e = await hire(a, base, 'NoHrdf');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 500, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const ps = await payslipFor(batchId);
    expect(st(ps).hrdf).toBe(0);
    const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect((batch.totals as Record<string, number>).hrdfEmployer).toBe(0);
  });

  it('mandatory (1%): levy = 1% of basic + fixed allowance; on the payslip, batch total, and employer cost', async () => {
    const a = await entitledCtx(base);
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'mandatory' });
    const e = await hire(a, base, 'Hrdf1');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 4000, monthlyAllowance: 500, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const ps = await payslipFor(batchId);
    // HRDF base = 4000 + 500 = 4500 → 1% = 45.00.
    expect(st(ps).hrdf).toBeCloseTo(45, 2);
    // Employer-only: no employee deduction line moved; net is unaffected by the levy.
    expect(Number(ps.netPay)).toBeCloseTo(Number(ps.grossPay) - Number(ps.totalDeductions), 2);
    // Employer cost includes the levy.
    const empCostNoHrdf = 4500 + st(ps).epfEmployer + st(ps).socsoEmployer + st(ps).eisEmployer;
    expect(Number(ps.employerCost)).toBeCloseTo(empCostNoHrdf + 45, 2);

    const [batch] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect((batch.totals as Record<string, number>).hrdfEmployer).toBeCloseTo(45, 2);
  });

  it('optional (0.5%): HRDF base EXCLUDES overtime and bonus (unlike the SOCSO/PCB base)', async () => {
    const a = await entitledCtx(base);
    await setCompanyStatutoryMY(a, { companyId: base.companyId, hrdfStatus: 'optional' });
    const e = await hire(a, base, 'Hrdf2');
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 3000, monthlyAllowance: 200, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    // Overtime + bonus are paid this month but must NOT enter the HRDF base.
    await setPayrollInput(a, { batchId, employmentId: e.employmentId, overtimeAmount: 600, bonusAmount: 1000 });
    await generatePayslips(a, { batchId });

    const ps = await payslipFor(batchId);
    // HRDF base = basic 3000 + fixed allowance 200 = 3200 → 0.5% = 16.00 (NOT 0.5% of 3200+600+1000).
    expect(st(ps).hrdf).toBeCloseTo(16, 2);
  });
});
