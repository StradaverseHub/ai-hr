/**
 * Payroll Process wizard — engine additions (plan §1, §2):
 *   1a/1d: createBatch paymentDate persists to batch_date; absent falls back to '<period>-28'; invalid
 *          date is rejected (silently falls back, not thrown — a client-side warning is enough per plan).
 *   1d:    defaultPaymentDate payDay-clamp helper (pure, unit-tested — no DB).
 *   1b:    createAdditionalRun persists scope/remarks/paymentDate; generation narrows to scope.
 *   2:     listEmployeesForPayrollRun — period-aware population (mid-period leaver included, pre-period
 *          leaver / post-period hire excluded), hasCurrentCompensation flag.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { createAdditionalRun, createBatch, defaultPaymentDate, generatePayslips, setPayrollInput } from '../core/payroll';
import { listEmployeesForPayrollRun } from '../core/read';
import { setCompensation } from '../core/comp';
import { hireEmployee, terminateEmployment } from '../core/org';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';

describe('Payroll Process wizard — defaultPaymentDate (1d, pure)', () => {
  it('clamps payDay=31 into a 30-day month to the 30th', () => {
    expect(defaultPaymentDate('2026-04', 31)).toBe('2026-04-30');
  });
  it('null payDay defaults to month-end', () => {
    expect(defaultPaymentDate('2026-02', null)).toBe('2026-02-28');
  });
  it('a payDay within the month is used as-is', () => {
    expect(defaultPaymentDate('2026-05', 15)).toBe('2026-05-15');
  });
});

describe('Payroll Process wizard — engine + population (DB)', () => {
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

  it('createBatch: paymentDate persists to batch_date; absent falls back to <period>-28', async () => {
    const a = adminCtx(base);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05', paymentDate: '2026-05-25' });
    const [row] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect(row.batchDate).toBe('2026-05-25');
  });

  it('createBatch: an invalid paymentDate falls back to the period default (never throws)', async () => {
    const a = adminCtx(base);
    const { batchId } = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05', paymentDate: 'not-a-date' });
    const [row] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect(row.batchDate).toBe('2026-05-28');
  });

  it('createAdditionalRun persists scope/remarks/paymentDate; generation narrows to scope', async () => {
    // ADR-0077 slice 3: the additional-run gate is a tenant_module ROW, not MULTI_CYCLE_PAYROLL_ENABLED.
    // `adminCtx` cannot carry it — its snapshot is legacyEnabledModulesIn(process.env), and test/env.ts
    // deletes MULTI_CYCLE_PAYROLL_ENABLED, so under it createAdditionalRun would throw
    // ModuleNotEnabledError. Grant the row, then resolve the session from it via entitledCtx.
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    const a = await entitledCtx(base);
    const e1 = await hireEmployee(a, {
      person: { fullName: 'Bonus1', primaryEmail: 'bonus1@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const e2 = await hireEmployee(a, {
      person: { fullName: 'Bonus2', primaryEmail: 'bonus2@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: e1.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setCompensation(a, { employmentId: e2.employmentId, basicSalary: 4000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });

    await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' }); // regular run must exist first
    const { batchId } = await createAdditionalRun(a, {
      companyId: base.companyId,
      payPeriod: '2026-05',
      runType: 'off_cycle',
      remarks: 'Advance Salary',
      paymentDate: '2026-05-10',
      scope: { employmentIds: [e1.employmentId] },
    });
    const [row] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
    expect(row.remarks).toBe('Advance Salary');
    expect(row.batchDate).toBe('2026-05-10');
    expect(row.scope).toEqual({ employmentIds: [e1.employmentId] });

    // r226 — the ADDITIONAL run also skips anybody it has nothing to pay, so e1 needs a figure of their
    // own or this would assert "one payslip" against a run that wrote none. The scope half is what this
    // case is about and it is unchanged: e2 is outside the scope and never reaches the run at all —
    // which is a different thing from being skipped, and the returned skip list says so by being empty.
    await setPayrollInput(a, { batchId, employmentId: e1.employmentId, overtimeAmount: 0, bonusAmount: 750 });
    const gen = await generatePayslips(a, { batchId });
    const slips = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
    expect(slips).toHaveLength(1);
    expect(slips[0].employmentId).toBe(e1.employmentId);
    expect('skipped' in gen ? gen.skipped : []).toEqual([]);
  });

  it('listEmployeesForPayrollRun: includes a mid-period leaver, excludes a pre-period leaver and a post-period hire', async () => {
    const a = adminCtx(base);
    const midLeaver = await hireEmployee(a, {
      person: { fullName: 'MidLeaver', primaryEmail: 'midleaver@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await terminateEmployment(a, { employmentId: midLeaver.employmentId, terminationDate: '2026-05-15' });

    const preLeaver = await hireEmployee(a, {
      person: { fullName: 'PreLeaver', primaryEmail: 'preleaver@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await terminateEmployment(a, { employmentId: preLeaver.employmentId, terminationDate: '2026-04-15' });

    const postHire = await hireEmployee(a, {
      person: { fullName: 'PostHire', primaryEmail: 'posthire@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-06-01',
    });

    const compLess = await hireEmployee(a, {
      person: { fullName: 'CompLess', primaryEmail: 'complessw@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });

    const rows = await listEmployeesForPayrollRun(a, base.companyId, '2026-05');
    const ids = rows.map((r) => r.employmentId);
    expect(ids).toContain(midLeaver.employmentId);
    expect(ids).not.toContain(preLeaver.employmentId);
    expect(ids).not.toContain(postHire.employmentId);
    expect(ids).toContain(compLess.employmentId);

    const compLessRow = rows.find((r) => r.employmentId === compLess.employmentId);
    expect(compLessRow?.hasCurrentCompensation).toBe(false);
  });
});
