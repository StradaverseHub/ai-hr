/**
 * R37 62e370b0 — "Basic Salary Not Reflected During Payroll Processing".
 *
 * Root cause: with TYPED_PAY_COMPONENTS_ENABLED on, generatePayslips reads basic from the employee's
 * BASIC employment_pay_component. An employee whose compensation was never backfilled into the typed
 * component tables has NO BASIC row, so the typed earnings path resolved basic to 0 and produced a
 * payslip with basicSalary '0.00' — the reported zero-pay bug (EMP-0004 had RM7,200 on file yet was
 * paid nothing).
 *
 * This suite pins BOTH halves of the fix:
 *   1. FALLBACK — in the typed earnings path, a missing BASIC component falls back to the compensation
 *      basicSalary (exactly what the legacy path reads), so a missing backfill can never silently zero
 *      someone's pay. Exercised through a subset reprocess, which is the remediation flow that skips the
 *      pre-processing gate.
 *   2. PRE-CHECK BLOCKER — preProcessChecksTx flags a compensation-present / no-BASIC-component employee
 *      as missingBasicComponent (only when the typed path is live) and generatePayslips fails closed,
 *      so a full run can no longer be processed with the data gap present.
 *
 * The legacy path (flag off) and the statutory math are untouched.
 */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { PreProcessBlockedError, createBatch, generatePayslips, preProcessAdvisory } from '../core/payroll';
import { backfillEmploymentComponentsFromCompensation, seedPayComponentCatalog } from '../core/pay-components';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

const payslipOf = async (batchId: string, employmentId: string) => {
  const [ps] = await owner.db
    .select()
    .from(schema.payslip)
    .where(eq(schema.payslip.batchId, batchId));
  return ps && ps.employmentId === employmentId ? ps : undefined;
};

const batchStatus = async (batchId: string) => {
  const [row] = await owner.db
    .select({ status: schema.payrollBatch.status })
    .from(schema.payrollBatch)
    .where(eq(schema.payrollBatch.id, batchId));
  return row?.status;
};

async function hire(a: ReturnType<typeof adminCtx>, name: string, ic: string) {
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@basicfb.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic, bankName: 'Maybank', bankAccountNo: '1234567890' });
  return e;
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  delete process.env.TYPED_PAY_COMPONENTS_ENABLED;
});
afterEach(() => {
  delete process.env.TYPED_PAY_COMPONENTS_ENABLED;
});
afterAll(async () => {
  await closeAll();
});

describe('R37 62e370b0 — basic salary is never silently zeroed by a missing BASIC component', () => {
  it('FALLBACK: typed path with compensation present but no BASIC component pays basic from compensation, not zero', async () => {
    const a = adminCtx(b);
    const emp = await hire(a, 'Arjun Kumar', '900101010001');
    await setCompensation(a, { employmentId: emp.employmentId, basicSalary: 7200, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });

    // Process the batch on the LEGACY path (flag off) so we have a processed run to reprocess. Legacy
    // reads basic straight from compensation, so this baseline is correctly 7200.
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });
    await generatePayslips(a, { batchId });
    const legacy = await payslipOf(batchId, emp.employmentId);
    expect(legacy?.basicSalary).toBe('7200.00');

    // Now the typed path goes live but this employee still has NO BASIC employment_pay_component (the
    // un-backfilled state that caused the bug). A subset reprocess skips the pre-check, so it exercises
    // the earnings fallback directly.
    process.env.TYPED_PAY_COMPONENTS_ENABLED = 'true';
    await generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [emp.employmentId] } });

    const reprocessed = await payslipOf(batchId, emp.employmentId);
    // The bug would have made this '0.00'; the fallback keeps it at the compensation basic.
    expect(reprocessed?.basicSalary).toBe('7200.00');
    expect(Number(reprocessed?.grossPay)).toBeGreaterThan(0);
    expect(await batchStatus(batchId)).toBe('processed');
  });

  it('PRE-CHECK: flags compensation-present / no-BASIC-component as a blocker and fails closed (typed path only)', async () => {
    const a = adminCtx(b);
    // Employee WITH a BASIC component (via backfill) — must NOT be flagged.
    const withBasic = await hire(a, 'Has Basic', '900101010002');
    await setCompensation(a, { employmentId: withBasic.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await seedPayComponentCatalog(a);
    await backfillEmploymentComponentsFromCompensation(a);
    // Employee with compensation but NO BASIC component (added AFTER the backfill, so it stays un-backfilled).
    const noBasic = await hire(a, 'No Basic', '900101010003');
    await setCompensation(a, { employmentId: noBasic.employmentId, basicSalary: 7200, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });

    // Gated: with the flag OFF the legacy path reads compensation directly, so a BASIC component is
    // irrelevant and nobody is flagged.
    const offChecks = await preProcessAdvisory(a, batchId);
    expect(offChecks.missingBasicComponent).toHaveLength(0);

    // Flag ON: the no-BASIC employee is a blocker; the backfilled one is not; neither is missingCompensation.
    process.env.TYPED_PAY_COMPONENTS_ENABLED = 'true';
    const checks = await preProcessAdvisory(a, batchId);
    expect(checks.missingBasicComponent.map((r) => r.employmentId)).toEqual([noBasic.employmentId]);
    expect(checks.missingBasicComponent.map((r) => r.employmentId)).not.toContain(withBasic.employmentId);
    expect(checks.missingCompensation).toHaveLength(0);

    // Generation fails closed BEFORE any write.
    await expect(generatePayslips(a, { batchId })).rejects.toBeInstanceOf(PreProcessBlockedError);
    const slips = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect(slips).toHaveLength(0);
    expect(await batchStatus(batchId)).toBe('draft');
  });
});
