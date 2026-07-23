/**
 * R37 62e370b0 → feedback 64fb5e48 — "Basic salary source for payroll processing".
 *
 * History: with TYPED_PAY_COMPONENTS_ENABLED on, the typed earnings path used to read basic from the
 * employee's BASIC employment_pay_component, and pre-processing BLOCKED any employee who had a
 * compensation row but no BASIC component (missingBasicComponent). Feedback 64fb5e48 corrects the design:
 * the Personnel Basic Salary record (compensation) is the SINGLE authoritative source of basic pay — a
 * BASIC pay item is never a processing prerequisite, and its amount never overrides the Personnel record.
 *
 * This suite pins the new semantics:
 *   1. SOURCE — the typed earnings path always pays basic from the compensation record; a missing BASIC
 *      component changes nothing (exercised through a subset reprocess AND a full run).
 *   2. NO BLOCKER — a compensation-present / no-BASIC-component employee passes pre-processing and a FULL
 *      run generates their payslip from the Personnel basic (the exact Fiamma scenario in the feedback).
 *
 * The legacy path (flag off) and the statutory math are untouched.
 */
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips, preProcessAdvisory } from '../core/payroll';
import { backfillEmploymentComponentsFromCompensation, seedPayComponentCatalog } from '../core/pay-components';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

const payslipOf = async (batchId: string, employmentId: string) => {
  const rows = await owner.db
    .select()
    .from(schema.payslip)
    .where(eq(schema.payslip.batchId, batchId));
  return rows.find((ps) => ps.employmentId === employmentId);
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

describe('feedback 64fb5e48 — Personnel Basic Salary is the authoritative pay source (no BASIC pay item required)', () => {
  it('SOURCE: typed path with compensation present but no BASIC component pays basic from compensation, not zero', async () => {
    const a = adminCtx(b);
    const emp = await hire(a, 'Arjun Kumar', '900101010001');
    await setCompensation(a, { employmentId: emp.employmentId, basicSalary: 7200, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });

    // Process the batch on the LEGACY path (flag off) so we have a processed run to reprocess. Legacy
    // reads basic straight from compensation, so this baseline is correctly 7200.
    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });
    await generatePayslips(a, { batchId });
    const legacy = await payslipOf(batchId, emp.employmentId);
    expect(legacy?.basicSalary).toBe('7200.00');

    // Now the typed path goes live but this employee still has NO BASIC employment_pay_component. A
    // subset reprocess exercises the typed earnings source directly.
    process.env.TYPED_PAY_COMPONENTS_ENABLED = 'true';
    await generatePayslips(a, { batchId, reprocessSubset: { employmentIds: [emp.employmentId] } });

    const reprocessed = await payslipOf(batchId, emp.employmentId);
    expect(reprocessed?.basicSalary).toBe('7200.00');
    expect(Number(reprocessed?.grossPay)).toBeGreaterThan(0);
    expect(await batchStatus(batchId)).toBe('processed');
  });

  it('NO BLOCKER: a compensation-present / no-BASIC-component employee passes pre-processing and a FULL run pays them (feedback 64fb5e48)', async () => {
    const a = adminCtx(b);
    // Employee WITH a BASIC component (via backfill).
    const withBasic = await hire(a, 'Has Basic', '900101010002');
    await setCompensation(a, { employmentId: withBasic.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await seedPayComponentCatalog(a);
    await backfillEmploymentComponentsFromCompensation(a);
    // Employee with compensation but NO BASIC component (added AFTER the backfill, so it stays un-backfilled) —
    // the exact reported Fiamma case: an active Basic Salary in Personnel, no internal BASIC pay item.
    const noBasic = await hire(a, 'Eee Lee Yong', '900101010003');
    await setCompensation(a, { employmentId: noBasic.employmentId, basicSalary: 7200, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-07' });

    // Flag ON: nobody is blocked — the old missingBasicComponent gate is gone, and the strengthened checks
    // find nothing wrong (both employees have an active, period-covering, positive Personnel basic).
    process.env.TYPED_PAY_COMPONENTS_ENABLED = 'true';
    const checks = await preProcessAdvisory(a, batchId);
    expect(checks.missingCompensation).toHaveLength(0);
    expect(checks.zeroBasic ?? []).toHaveLength(0);
    // Neither employee's BASIC state is stale: one mirrors compensation, the other has no component at all.
    expect(checks.staleBasicComponent ?? []).toHaveLength(0);

    // The FULL run processes and pays BOTH employees from their Personnel basic.
    await generatePayslips(a, { batchId });
    expect((await payslipOf(batchId, noBasic.employmentId))?.basicSalary).toBe('7200.00');
    expect((await payslipOf(batchId, withBasic.employmentId))?.basicSalary).toBe('5000.00');
    expect(await batchStatus(batchId)).toBe('processed');
  });
});
