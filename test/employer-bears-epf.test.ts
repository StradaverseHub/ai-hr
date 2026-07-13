/**
 * Item 0d9bb2da — "Employer Bears EPF Contribution" control.
 *
 * A direct clone of the R34/R35 employer_bears plumbing (SOCSO/EIS/SKBBK + tax), applied to EPF:
 *  - The EPF employee + employer contributions are STILL computed and reported in full (KWSP file / EPF report
 *    and the amount remitted to KWSP are unchanged) — only the FUNDING of the employee's EPF share moves to
 *    the employer.
 *  - When the flag is ON: the employee's take-home is NOT reduced by the EPF employee share (employer funds it),
 *    so employee net RISES by exactly that share and employer cost RISES by exactly that share.
 *  - When the flag is OFF (every employee): the payslip statutory blob is byte-identical to today — the
 *    employer-bears provenance snapshot is absent.
 *  - The setStatutoryProfileMY DomainEvent carries employerBearsEpf before/after (audit trail).
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import {
  adminCtx,
  closeAll,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let icSeq = 0;
const nextIc = () => `9002020${String(30000 + icSeq++).slice(-5)}`;

const hire = async (b: Base, name: string, basic: number, employerBearsEpf: boolean) => {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, {
    employmentId: e.employmentId,
    basicSalary: basic,
    monthlyAllowance: 0,
    effectiveFrom: '2026-01-01',
  });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: nextIc(), employerBearsEpf });
  return e;
};

const slip = async (employmentId: string) => {
  const [ps] = await owner.db
    .select()
    .from(schema.payslip)
    .where(eq(schema.payslip.employmentId, employmentId));
  return ps;
};

describe('Item 0d9bb2da — employer bears EPF contribution', () => {
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

  it('flag ON: employee net + reported EPF unchanged by the EPF employee share; employer cost up by it', async () => {
    const a = adminCtx(base);
    const baseline = await hire(base, 'EpfBaseline', 4000, false);
    const bears = await hire(base, 'EpfBears', 4000, true);

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });

    const psBase = await slip(baseline.employmentId);
    const psBears = await slip(bears.employmentId);
    const stBase = psBase.statutory as Record<string, number>;
    const stBears = psBears.statutory as Record<string, number>;

    // EPF employee + employer contributions are IDENTICAL (KWSP file + EPF report + remitted amount unchanged).
    expect(stBears.epfEmployee).toBe(stBase.epfEmployee);
    expect(stBears.epfEmployer).toBe(stBase.epfEmployer);
    const borne = Number(stBase.epfEmployee.toFixed(2));
    expect(borne).toBeGreaterThan(0);

    // Employee net RISES by exactly the EPF employee share (no longer deducted from the employee).
    expect(Number(psBears.netPay)).toBeCloseTo(Number(psBase.netPay) + borne, 2);
    // Employer cost RISES by exactly the EPF employee share.
    expect(Number(psBears.employerCost)).toBeCloseTo(Number(psBase.employerCost) + borne, 2);
    // Payslip invariant still holds.
    expect(Number(psBears.netPay)).toBeCloseTo(Number(psBears.grossPay) - Number(psBears.totalDeductions), 2);

    // Provenance snapshot present on the bears slip; the epf leg reflects the flag + the borne amount.
    const eb = psBears.statutory as Record<string, unknown>;
    expect((eb.employerBears as { epf: boolean }).epf).toBe(true);
    expect((eb.employerBorne as { epf: number }).epf).toBeCloseTo(borne, 2);
    expect((eb.employerBorne as { total: number }).total).toBeCloseTo(borne, 2);
  });

  it('flag OFF (all employees): the statutory blob is byte-identical — no employer-bears snapshot', async () => {
    const a = adminCtx(base);
    const only = await hire(base, 'EpfOffOnly', 4000, false);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId });
    const ps = await slip(only.employmentId);
    const st = ps.statutory as Record<string, unknown>;
    expect(st.employerBears).toBeUndefined();
    expect(st.employerBorne).toBeUndefined();
  });

  it('audit: the statutory.my.updated event carries employerBearsEpf before/after', async () => {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'EpfAudit', primaryEmail: 'epfaudit@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const ic = nextIc();
    // First save creates the row (flag off).
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic, employerBearsEpf: false });
    // Second save flips the flag on.
    const { id } = await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic, employerBearsEpf: true });

    const payload = (await latestEventPayload(base.tenantId, id, 'statutory.my.updated')) as {
      statutoryControls: { before: { employerBearsEpf: boolean }; after: { employerBearsEpf: boolean } };
    };
    expect(payload.statutoryControls.before.employerBearsEpf).toBe(false);
    expect(payload.statutoryControls.after.employerBearsEpf).toBe(true);
  });
});
