/**
 * Feedback 64fb5e48 — "Correct Basic Salary Source for Payroll Processing".
 *
 * The Personnel Basic Salary record (Personnel (Admin) → Employee → Payroll → Basic Salary =
 * `compensation`) is the SINGLE authoritative source of basic pay. This suite pins the strengthened
 * pre-processing checks that replaced the removed missingBasicComponent blocker, and the precedence flip
 * in the typed earnings path:
 *
 *   • STALE OVERRIDE FIXED — a leftover BASIC employment_pay_component whose amount drifted from the
 *     Personnel record used to silently OVERRIDE pay; now the Personnel record wins and pre-processing
 *     surfaces a staleBasicComponent WARNING (never a blocker — the run still processes).
 *   • zeroBasic BLOCKER — a Personnel record that would pay nothing (monthly basic <= 0, or a
 *     daily/hourly rate <= 0 on a legacy row that predates the write-time guard) fails closed.
 *   • PERIOD COVERAGE — a salary record effective only AFTER the pay period blocks as
 *     missingCompensation; a future-dated REVISION whose predecessor covers the period does not.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { PreProcessBlockedError, createBatch, generatePayslips, preProcessAdvisory } from '../core/payroll';
import { backfillEmploymentComponentsFromCompensation, seedPayComponentCatalog } from '../core/pay-components';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

let b: Base;
const PERIOD = '2026-07';

const payslipOf = async (batchId: string, employmentId: string) => {
  const rows = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
  return rows.find((ps) => ps.employmentId === employmentId);
};

async function hire(a: ReturnType<typeof adminCtx>, name: string, ic: string, hiredOn = '2026-01-01') {
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '.')}@basicsource.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic, bankName: 'Maybank', bankAccountNo: '1234567890' });
  return e;
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  // ADR-0077 slice 3 — no explicit "turn typed components off" step. `seedBase` seeds NO
  // `tenant_module` row for typed_pay_components (test/env.ts deletes TYPED_PAY_COMPONENTS_ENABLED, so
  // it is outside this process's parity set) and a MISSING row is disabled (C7). The two tests that
  // need the typed path grant the row themselves and re-resolve the snapshot.
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('feedback 64fb5e48 — stale BASIC pay item never overrides the Personnel record', () => {
  it('pay follows the Personnel basic, a staleBasicComponent WARNING is emitted, and the run still processes', async () => {
    const a = adminCtx(b);
    const emp = await hire(a, 'Stale Case', '900101020001');
    await setCompensation(a, { employmentId: emp.employmentId, basicSalary: 6500, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    // Mirror the old figure into a BASIC component (the one-time migration path), THEN revise the salary in
    // Personnel — the component is now stale at 6500 while Personnel says 7000.
    await seedPayComponentCatalog(a);
    await backfillEmploymentComponentsFromCompensation(a);
    await setCompensation(a, { employmentId: emp.employmentId, basicSalary: 7000, effectiveFrom: '2026-02-01' });

    // Grant typed_pay_components to THIS tenant and re-resolve: the snapshot is point-in-time, so the
    // setup context `a` would still read the module as off. The typed path is what makes the BASIC
    // component visible to pre-processing at all — the whole point of this test.
    await setModule(b.tenantId, 'typed_pay_components', 'active');
    const on = await entitledCtx(b);
    const { batchId } = await createBatch(on, { companyId: b.companyId, payPeriod: PERIOD });
    const checks = await preProcessAdvisory(on, batchId);
    // WARNING, not a blocker — and precisely this employee.
    expect((checks.staleBasicComponent ?? []).map((r) => r.employmentId)).toEqual([emp.employmentId]);
    expect(checks.missingCompensation).toHaveLength(0);
    expect(checks.zeroBasic ?? []).toHaveLength(0);

    // The run processes (warnings never fail closed) and the PERSONNEL record wins: 7000, not the stale 6500
    // the old component-precedence would have paid.
    await generatePayslips(on, { batchId });
    expect((await payslipOf(batchId, emp.employmentId))?.basicSalary).toBe('7000.00');
  });

  it('a backfilled component that MATCHES the Personnel record is not flagged', async () => {
    const a = adminCtx(b);
    const emp = await hire(a, 'In Sync', '900101020002');
    await setCompensation(a, { employmentId: emp.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await seedPayComponentCatalog(a);
    await backfillEmploymentComponentsFromCompensation(a);

    // Same grant + re-resolve as above: with the module OFF pre-processing never reads the component
    // tables, so an empty staleBasicComponent list would prove nothing. It must be empty WITH the typed
    // path live and the backfilled BASIC component in scope.
    await setModule(b.tenantId, 'typed_pay_components', 'active');
    const on = await entitledCtx(b);
    const { batchId } = await createBatch(on, { companyId: b.companyId, payPeriod: PERIOD });
    const checks = await preProcessAdvisory(on, batchId);
    expect(checks.staleBasicComponent ?? []).toHaveLength(0);
  });
});

describe('feedback 64fb5e48 — zeroBasic blocker (the checks that actually matter)', () => {
  /**
   * r369 (item eb949191) REVERSED THIS ONE ASSERTION, AND IT IS THE POINT OF THAT ROUND.
   *
   * This test used to read "a monthly employee with basic 0 is a zeroBasic blocker and generation fails
   * closed" — which was true, and was the fault the reporter rejected: a Director paid fees quarterly has no
   * monthly basic, and one such record stopped the whole company's run because the batch is all-or-nothing.
   * The guard is UPDATED rather than deleted, because the behaviour it pins is still load-bearing in both
   * directions: the monthly leg must NOT block, and the run must NOT pay them either (it skips the month,
   * which test/r369-zero-basic-skip.test.ts pins together with the below-zero payslip that proves why).
   *
   * The daily/hourly rate leg below is untouched and still fails the run closed.
   */
  it('a monthly employee with basic 0 is NO LONGER a blocker — the run proceeds and leaves them out', async () => {
    const a = adminCtx(b);
    const zero = await hire(a, 'Zero Basic', '900101020003');
    // r369 — a zero basic needs the reporter's own confirmation gesture at the point of entry: a remark
    // saying why. The kernel never reads it to decide money (core/comp.ts SalaryRemarkRequiredError).
    await setCompensation(a, {
      employmentId: zero.employmentId,
      basicSalary: 0,
      monthlyAllowance: 0,
      remarks: 'Paid by quarterly director fees',
      effectiveFrom: '2026-01-01',
    });
    const paid = await hire(a, 'Paid Fine', '900101020004');
    await setCompensation(a, { employmentId: paid.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });

    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
    const checks = await preProcessAdvisory(a, batchId);
    // The blocker list is empty and the NOTICE list names them — the third, neutral readiness state.
    expect(checks.zeroBasic ?? []).toHaveLength(0);
    expect((checks.nothingPayable ?? []).map((r) => r.employmentId)).toEqual([zero.employmentId]);
    expect(checks.missingCompensation).toHaveLength(0);

    const gen = await generatePayslips(a, { batchId });
    const slips = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect(slips.map((s) => s.employmentId), 'the company is paid; the Director is left out').toEqual([
      paid.employmentId,
    ]);
    expect('skipped' in gen ? (gen.skipped ?? []).map((s) => s.employmentId) : []).toEqual([zero.employmentId]);
  });

  it('a legacy daily row with rate 0 blocks (write guard bypassed); a positive-rate daily employee passes', async () => {
    const a = adminCtx(b);
    const okDaily = await hire(a, 'Daily Ok', '900101020005');
    await setCompensation(a, { employmentId: okDaily.employmentId, basicSalary: 4600, monthlyAllowance: 0, payMode: 'daily', rateAmount: 250, effectiveFrom: '2026-01-01' });
    const badDaily = await hire(a, 'Daily Zero', '900101020006');
    await setCompensation(a, { employmentId: badDaily.employmentId, basicSalary: 4600, monthlyAllowance: 0, payMode: 'daily', rateAmount: 200, effectiveFrom: '2026-01-01' });
    // assertRateForMode guards NEW writes; simulate a legacy row that predates it (rate zeroed in place).
    await owner.db
      .update(schema.compensation)
      .set({ rateAmount: '0.00' })
      .where(and(eq(schema.compensation.employmentId, badDaily.employmentId), isNull(schema.compensation.validTo)));

    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
    const checks = await preProcessAdvisory(a, batchId);
    expect((checks.zeroBasic ?? []).map((r) => r.employmentId)).toEqual([badDaily.employmentId]);
    // The daily employee's basic_salary (monthly-equivalent) is irrelevant to zeroBasic — the RATE decides.
    expect((checks.zeroBasic ?? []).map((r) => r.employmentId)).not.toContain(okDaily.employmentId);
  });
});

describe('feedback 64fb5e48 — effective-date coverage of the pay period', () => {
  it('a first salary record effective only AFTER the period blocks as missingCompensation', async () => {
    const a = adminCtx(b);
    const future = await hire(a, 'Future Start', '900101020007');
    await setCompensation(a, { employmentId: future.employmentId, basicSalary: 5200, monthlyAllowance: 0, effectiveFrom: '2026-08-01' });

    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
    const checks = await preProcessAdvisory(a, batchId);
    expect(checks.missingCompensation.map((r) => r.employmentId)).toEqual([future.employmentId]);
    await expect(generatePayslips(a, { batchId })).rejects.toBeInstanceOf(PreProcessBlockedError);
  });

  it('a future-dated REVISION does not block: the superseded record still covers the period', async () => {
    const a = adminCtx(b);
    const emp = await hire(a, 'Sept Raise', '900101020008');
    await setCompensation(a, { employmentId: emp.employmentId, basicSalary: 5000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setCompensation(a, { employmentId: emp.employmentId, basicSalary: 5500, effectiveFrom: '2026-09-01' });

    const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
    const checks = await preProcessAdvisory(a, batchId);
    expect(checks.missingCompensation).toHaveLength(0);
    expect(checks.zeroBasic ?? []).toHaveLength(0);
  });
});
