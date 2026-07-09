/**
 * Pre-processing validation (feedback f1564110, Phase 1) — validate employee master data BEFORE the
 * payroll run is calculated, per the reporter's "maintain → validate → process" workflow.
 *
 *   • preProcessAdvisory classifies the batch's scoped, period-active employees into
 *     missingCompensation (BLOCKER — these were previously SILENTLY dropped by the generation
 *     employee query's inner join), missingStatutory and missingBank (warnings).
 *   • generatePayslips hard-blocks (PreProcessBlockedError) while any in-scope employee has no
 *     current compensation row — the silent-skip fix. Fails closed BEFORE any write.
 *   • Warning-class gaps do NOT block the kernel: the explicit confirm lives in generateAction
 *     (the ConfirmSubmit dialog posts ackWarnings=1), so the service stays byte-identical for
 *     complete-blocker-free runs.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { PreProcessBlockedError, createBatch, generatePayslips, preProcessAdvisory } from '../core/payroll';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

async function hire(a: ReturnType<typeof adminCtx>, name: string) {
  return hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@precheck.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
}

const slipsFor = (batchId: string) =>
  owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));

const batchStatus = async (batchId: string) => {
  const [row] = await owner.db
    .select({ status: schema.payrollBatch.status })
    .from(schema.payrollBatch)
    .where(eq(schema.payrollBatch.id, batchId));
  return row?.status;
};

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('f1564110 Phase 1 — pre-processing validation', () => {
  it('classifies missing compensation (blocker), missing statutory and missing bank (warnings)', async () => {
    const a = adminCtx(b);
    // Complete: compensation + statutory profile with bank details.
    const complete = await hire(a, 'Complete One');
    await setCompensation(a, { employmentId: complete.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: complete.personId, icNumber: '900101010001', bankName: 'Maybank', bankAccountNo: '1234567890' });
    // Blocker: no compensation row at all (statutory is complete).
    const noComp = await hire(a, 'No Comp');
    await setStatutoryProfileMY(a, { personId: noComp.personId, icNumber: '900101010002', bankName: 'CIMB', bankAccountNo: '9876543210' });
    // Warning: compensation but no statutory profile (⇒ also no bank, but reported ONCE, as missingStatutory).
    const noStat = await hire(a, 'No Statutory');
    await setCompensation(a, { employmentId: noStat.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    // Warning: statutory profile exists but bank details are absent.
    const noBank = await hire(a, 'No Bank');
    await setCompensation(a, { employmentId: noBank.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: noBank.personId, icNumber: '900101010003' });

    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-05' });
    const checks = await preProcessAdvisory(a, batchId);

    expect(checks.missingCompensation.map((r) => r.employmentId)).toEqual([noComp.employmentId]);
    expect(checks.missingStatutory.map((r) => r.employmentId)).toEqual([noStat.employmentId]);
    expect(checks.missingBank.map((r) => r.employmentId)).toEqual([noBank.employmentId]);
    // The statutory-less employee is NOT double-reported under missingBank.
    expect(checks.missingBank.map((r) => r.employmentId)).not.toContain(noStat.employmentId);
    // The complete employee appears nowhere.
    for (const list of [checks.missingCompensation, checks.missingStatutory, checks.missingBank]) {
      expect(list.map((r) => r.employmentId)).not.toContain(complete.employmentId);
    }
  });

  it('hard-blocks generation while an in-scope employee has no salary record (the silent-skip fix)', async () => {
    const a = adminCtx(b);
    const paid = await hire(a, 'Paid One');
    await setCompensation(a, { employmentId: paid.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: paid.personId, icNumber: '900101010004', bankName: 'Maybank', bankAccountNo: '111222333' });
    await hire(a, 'Comp Less'); // no compensation ⇒ previously silently dropped from the run

    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-05' });
    await expect(generatePayslips(a, { batchId })).rejects.toBeInstanceOf(PreProcessBlockedError);

    // Fails closed BEFORE any write: no payslips, batch still draft.
    expect(await slipsFor(batchId)).toHaveLength(0);
    expect(await batchStatus(batchId)).toBe('draft');
  });

  it('warnings (missing statutory / bank) do NOT block the kernel — confirm-to-proceed is enforced in generateAction', async () => {
    const a = adminCtx(b);
    const noStat = await hire(a, 'Warn NoStat');
    await setCompensation(a, { employmentId: noStat.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    const noBank = await hire(a, 'Warn NoBank');
    await setCompensation(a, { employmentId: noBank.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: noBank.personId, icNumber: '900101010005' });

    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: '2026-05' });
    const checks = await preProcessAdvisory(a, batchId);
    expect(checks.missingCompensation).toHaveLength(0);
    expect(checks.missingStatutory).toHaveLength(1);
    expect(checks.missingBank).toHaveLength(1);

    await generatePayslips(a, { batchId }); // warnings alone never throw at the service layer
    expect(await slipsFor(batchId)).toHaveLength(2);
    expect(await batchStatus(batchId)).toBe('processed');
  });

  it('respects the batch scope: a comp-less employee OUTSIDE the scope neither appears nor blocks', async () => {
    const a = adminCtx(b);
    const paid = await hire(a, 'Scoped Paid');
    await setCompensation(a, { employmentId: paid.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: paid.personId, icNumber: '900101010006', bankName: 'RHB', bankAccountNo: '444555666' });
    await hire(a, 'Out Of Scope'); // comp-less, but excluded by the explicit scope below

    const { batchId } = await createBatch(a, {
      companyId: b.companyId,
      payPeriod: '2026-05',
      scope: { employmentIds: [paid.employmentId] },
    });

    const checks = await preProcessAdvisory(a, batchId);
    expect(checks.missingCompensation).toHaveLength(0);
    expect(checks.missingStatutory).toHaveLength(0);
    expect(checks.missingBank).toHaveLength(0);

    await generatePayslips(a, { batchId });
    const slips = await slipsFor(batchId);
    expect(slips).toHaveLength(1);
    expect(slips[0].employmentId).toBe(paid.employmentId);
  });
});
