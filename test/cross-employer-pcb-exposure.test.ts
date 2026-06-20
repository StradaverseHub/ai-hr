/**
 * ADR-0029 (G2 Slice 2c) — `crossEmployerPcbExposure` end-to-end through the real kernel. A person paid
 * by two of the tenant's companies: generate both payrolls (per-employer, the status quo), then the
 * exposure read shows the COMBINED-month MTD exceeds the SUMMED filed MTD — the under-deduction the
 * employee carries to annual assessment. Read-only: it never changes a payslip.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { crossEmployerPcbExposure } from '../localization/my/reports';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

describe('crossEmployerPcbExposure (ADR-0029)', () => {
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

  it('shows the combined-month MTD exceeding the summed per-employer MTD', async () => {
    const a = adminCtx(base);
    // RM8,000 at company A and RM8,000 at company B (same person).
    const e1 = await hireEmployee(a, {
      person: { fullName: 'Director', primaryEmail: 'dir@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2025-01-01',
    });
    await setCompensation(a, { employmentId: e1.employmentId, basicSalary: 8000, effectiveFrom: '2025-01-01' });
    await setStatutoryProfileMY(a, { personId: e1.personId, icNumber: '900101012345' });

    const [c2] = await owner.db
      .insert(schema.company)
      .values({ tenantId: base.tenantId, legalName: 'Acme Two Sdn Bhd' })
      .returning({ id: schema.company.id });
    const [e2] = await owner.db
      .insert(schema.employment)
      .values({ tenantId: base.tenantId, personId: e1.personId, companyId: c2.id, hiredOn: '2025-01-01' })
      .returning({ id: schema.employment.id });
    await setCompensation(a, { employmentId: e2.id, basicSalary: 8000, effectiveFrom: '2025-01-01' });

    // Per-employer payroll for the month in BOTH companies (the status quo).
    for (const companyId of [base.companyId, c2.id]) {
      const { batchId } = await createBatch(a, { companyId, payPeriod: '2026-05' });
      await generatePayslips(a, { batchId });
    }

    const rows = await crossEmployerPcbExposure(a, '2026-05');
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.personId).toBe(e1.personId);
    expect(r.employments).toHaveLength(2);
    expect(r.indicative).toBe(false); // no bonus → exact
    expect(r.summedMtd).toBeGreaterThan(0);
    expect(r.combinedMtd).toBeGreaterThan(r.summedMtd); // the under-deduction the gate closes
    expect(r.delta).toBeCloseTo(Math.round((r.combinedMtd - r.summedMtd) * 100) / 100, 2);
  });

  it('returns nothing when no one has concurrent employments', async () => {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Solo', primaryEmail: 'solo@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2025-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 8000, effectiveFrom: '2025-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101012346' });
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    expect(await crossEmployerPcbExposure(a, '2026-05')).toEqual([]);
  });
});
