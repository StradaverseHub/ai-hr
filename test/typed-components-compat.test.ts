/**
 * Wave 3 #9-3 — the byte-identical gate. With TYPED_PAY_COMPONENTS_ENABLED the kernel reads the typed
 * component tables instead of compensation + payroll_input; back-filled from the legacy data it must
 * produce IDENTICAL payslips. We generate a batch with the flag off, reset it, back-fill components,
 * regenerate with the flag on, and assert every payslip column + the full statutory object match.
 * Exercised across basic + allowance + overtime + bonus + taxable claim + HRDF + EPF/SOCSO/EIS/PCB,
 * for a full month and a prorated mid-month joiner.
 */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { setCompanyStatutoryMY } from '../localization/my/company-statutory';
import { createBatch, generatePayslips, setPayrollInput, UnsupportedPayComponentError } from '../core/payroll';
import {
  backfillBatchComponentsFromInput,
  backfillEmploymentComponentsFromCompensation,
  listPayComponents,
  seedPayComponentCatalog,
  setEmploymentPayComponent,
  upsertPayComponent,
} from '../core/pay-components';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

const payslipOf = async (batchId: string) => {
  const [ps] = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
  return ps;
};
// The fields that must be byte-identical between the legacy and typed paths.
const COLS = ['basicSalary', 'allowance', 'overtimePay', 'bonus', 'daysWorked', 'grossPay', 'otherDeductions', 'totalDeductions', 'netPay', 'employerCost'] as const;
const snap = (ps: Record<string, unknown>) => ({
  cols: Object.fromEntries(COLS.map((c) => [c, ps[c]])),
  statutory: ps.statutory,
});

describe('Wave 3 #9-3 — typed components are byte-identical to the legacy kernel', () => {
  let base: Base;
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    delete process.env.TYPED_PAY_COMPONENTS_ENABLED;
  });
  afterEach(() => {
    delete process.env.TYPED_PAY_COMPONENTS_ENABLED;
  });
  afterAll(async () => {
    await closeAll();
  });

  async function runCompat(b: Base, hiredOn: string) {
    const a = adminCtx(b);
    await setCompanyStatutoryMY(a, { companyId: b.companyId, hrdfStatus: 'mandatory' }); // exercise HRDF
    const e = await hireEmployee(a, {
      person: { fullName: 'Compat', primaryEmail: 'compat@acme.test' },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn,
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 500, effectiveFrom: hiredOn });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });

    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-05' });
    await setPayrollInput(a, { batchId, employmentId: e.employmentId, overtimeAmount: 600, bonusAmount: 1000 });
    // A taxable claim allowance (ADR-0021) — set directly so the backfill picks it up as a CLAIM component.
    await owner.db.update(schema.payrollInput).set({ claimAllowance: '200.00' }).where(eq(schema.payrollInput.batchId, batchId));

    // ── Legacy path (flag off) ──
    await generatePayslips(a, { batchId });
    const legacy = snap(await payslipOf(batchId));

    // Reset the batch to draft and clear the payslip so we can regenerate the same period cleanly.
    await owner.db.delete(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    await owner.db.update(schema.payrollBatch).set({ status: 'draft' }).where(eq(schema.payrollBatch.id, batchId));

    // ── Back-fill the components, then the typed path (flag on) ──
    await seedPayComponentCatalog(a);
    await backfillEmploymentComponentsFromCompensation(a);
    await backfillBatchComponentsFromInput(a, batchId);
    process.env.TYPED_PAY_COMPONENTS_ENABLED = 'true';
    await generatePayslips(a, { batchId });
    const typed = snap(await payslipOf(batchId));

    return { legacy, typed };
  }

  it('full month: identical payslip + statutory', async () => {
    const { legacy, typed } = await runCompat(base, '2026-01-01');
    expect(typed.cols).toEqual(legacy.cols);
    expect(typed.statutory).toEqual(legacy.statutory);
    // Sanity: this scenario actually produced non-trivial figures (basic 5000 + allowance 500 +
    // claim 200 + overtime 600 + bonus 1000 = 7300).
    expect(Number((legacy.cols as Record<string, string>).grossPay)).toBeCloseTo(7300, 2);
  });

  it('prorated mid-month joiner: identical payslip + statutory', async () => {
    const { legacy, typed } = await runCompat(base, '2026-05-16');
    expect(typed.cols).toEqual(legacy.cols);
    expect(typed.statutory).toEqual(legacy.statutory);
  });

  it('FAIL-CLOSED: a taxable non-payable (BIK) component is rejected, not silently under-taxed', async () => {
    const a = adminCtx(base);
    const e = await hireEmployee(a, {
      person: { fullName: 'Bik', primaryEmail: 'bik@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: '900101011234' });
    await seedPayComponentCatalog(a);
    // A BIK: taxable (PCB) but non-payable — v1 cannot place it in a cash bucket.
    await upsertPayComponent(a, { code: 'BIK_CAR', name: 'Company car (BIK)', kind: 'non_payable', includedInEpf: false, includedInSocsoEis: false, includedInPcb: true, includedInHrdfBase: false, isNonPayable: true, prorates: false });
    await backfillEmploymentComponentsFromCompensation(a);
    const bikId = (await listPayComponents(a)).find((c) => c.code === 'BIK_CAR')!.id;
    await setEmploymentPayComponent(a, { employmentId: e.employmentId, componentId: bikId, amount: 250, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    process.env.TYPED_PAY_COMPONENTS_ENABLED = 'true';
    await expect(generatePayslips(a, { batchId })).rejects.toBeInstanceOf(UnsupportedPayComponentError);
  });
});
