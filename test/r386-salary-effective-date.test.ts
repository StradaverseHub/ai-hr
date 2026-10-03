import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { setCompensation } from '../core/comp';
import { hireEmployee } from '../core/org';
import { requirePackFor } from '../localization/registry';
import { PreProcessBlockedError, createAdditionalRun, createBatch, generatePayslips, preProcessAdvisory, prefillOvertimeFromAttendance, reprocessSelectedEmployees, resetProcessedBatch, setPayrollInput } from '../packs/payroll/service';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, setSetting, type Base } from './harness';

// de955416: real writes and payroll generation, using a wholly synthetic employee.
// A future open salary must not replace the salary effective in an earlier payroll month.
describe('r386 payroll resolves basic salary for the batch effective period', () => {
  let base: Base;
  let ctx: SessionContext;
  beforeAll(migrateTestDb);
  beforeEach(async () => {
    await resetDb();
    base = await seedBase();
    ctx = await entitledCtx(base);
  });
  afterAll(closeAll);

  let ic = 880000;

  async function hire() {
    const employee = await hireEmployee(ctx, {
      person: { fullName: 'Synthetic Effective Salary', primaryEmail: `${randomUUID()}@r386.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-08-01',
    });
    await requirePackFor('MY').statutory.set(ctx, {
      personId: employee.personId,
      icNumber: `900101${++ic}`,
    });
    return employee;
  }

  async function salaryHistory() {
    const employee = await hire();
    await setCompensation(ctx, {
      employmentId: employee.employmentId,
      basicSalary: 10000,
      monthlyAllowance: 0,
      effectiveFrom: '2026-08-01',
    });
    await setCompensation(ctx, {
      employmentId: employee.employmentId,
      basicSalary: 15000,
      effectiveFrom: '2026-11-01',
    });
    // Establish the temporal fixture independently of whatever payroll chooses.
    const history = await owner.db.select().from(schema.compensation)
      .where(eq(schema.compensation.employmentId, employee.employmentId))
      .orderBy(schema.compensation.validFrom);
    expect(history.map(row => ({ basic: row.basicSalary, from: row.validFrom, to: row.validTo })))
      .toEqual([
        { basic: '10000.00', from: '2026-08-01', to: '2026-11-01' },
        { basic: '15000.00', from: '2026-11-01', to: null },
      ]);
    return employee;
  }

  async function generatedSlip(period: string, employmentId: string) {
    const { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: period, scope: { employmentIds: [employmentId] } });
    await generatePayslips(ctx, { batchId });
    const slips = await owner.db.select().from(schema.payslip)
      .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
    expect(slips, 'real payroll must save exactly one payslip for the synthetic employee').toHaveLength(1);
    return slips[0];
  }

  it.each(['2026-08', '2026-09', '2026-10', '2026-11', '2026-12'])(
    '%s saves its effective basic despite the future revision being entered already', async period => {
      const employee = await salaryHistory();
      const slip = await generatedSlip(period, employee.employmentId);
      const amount = period < '2026-11' ? '10000.00' : '15000.00';
      expect(slip.basicSalary).toBe(amount);
      expect(slip.grossPay).toBe(amount);
    },
  );

  it.each([false, true])('typed components enabled=%s still use the historical salary', async typed => {
    if (typed) {
      await setModule(base.tenantId, 'typed_pay_components', 'active');
      ctx = await entitledCtx(base);
    }
    const employee = await salaryHistory();
    expect((await generatedSlip('2026-10', employee.employmentId)).basicSalary).toBe('10000.00');
  });

  it('multiple increments and a reduction resolve independently across two years and employees', async () => {
    const first = await salaryHistory();
    await setCompensation(ctx, { employmentId: first.employmentId, basicSalary: 12000, effectiveFrom: '2027-02-01' });
    await setCompensation(ctx, { employmentId: first.employmentId, basicSalary: 18000, effectiveFrom: '2027-06-01' });
    const second = await hire();
    await setCompensation(ctx, { employmentId: second.employmentId, basicSalary: 7000, effectiveFrom: '2026-08-01' });
    await setCompensation(ctx, { employmentId: second.employmentId, basicSalary: 9000, effectiveFrom: '2027-03-01' });
    for (const [period, firstBasic, secondBasic] of [
      ['2026-10', '10000.00', '7000.00'], ['2026-12', '15000.00', '7000.00'],
      ['2027-01', '15000.00', '7000.00'], ['2027-02', '12000.00', '7000.00'],
      ['2027-03', '12000.00', '9000.00'], ['2027-06', '18000.00', '9000.00'],
    ]) {
      const { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: period });
      await generatePayslips(ctx, { batchId });
      const slips = await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId));
      expect(slips).toHaveLength(2);
      expect(slips.find(row => row.employmentId === first.employmentId)?.basicSalary).toBe(firstBasic);
      expect(slips.find(row => row.employmentId === second.employmentId)?.basicSalary).toBe(secondBasic);
    }
  });

  async function slipOf(batchId: string, employmentId: string) {
    return (await owner.db.select().from(schema.payslip)
      .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId))))[0];
  }

  it('saving future salary preserves saved payroll; explicit selected and full reprocessing retain historical money', async () => {
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    await setSetting(base.tenantId, 'payroll.reset_enabled', true);
    ctx = await entitledCtx(base);
    const employee = await hire();
    const other = await hire();
    for (const e of [employee, other]) {
      await setCompensation(ctx, { employmentId: e.employmentId, basicSalary: 10000, effectiveFrom: '2026-08-01' });
    }
    const { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: '2026-08' });
    await generatePayslips(ctx, { batchId });
    const saved = await slipOf(batchId, employee.employmentId);
    const otherSaved = await slipOf(batchId, other.employmentId);
    const histories = await owner.db.select().from(schema.payrollEmployeeResultHistory)
      .where(eq(schema.payrollEmployeeResultHistory.batchId, batchId));
    await setCompensation(ctx, { employmentId: employee.employmentId, basicSalary: 15000, effectiveFrom: '2026-11-01' });
    expect(await slipOf(batchId, employee.employmentId)).toEqual(saved);
    expect(await owner.db.select().from(schema.payrollEmployeeResultHistory)
      .where(eq(schema.payrollEmployeeResultHistory.batchId, batchId))).toEqual(histories);
    const key = randomUUID();
    await reprocessSelectedEmployees(ctx, { batchId, employmentIds: [employee.employmentId], idempotencyKey: key });
    const selected = await slipOf(batchId, employee.employmentId);
    expect(selected.version).toBe(saved.version + 1);
    for (const field of ['basicSalary', 'grossPay', 'netPay', 'totalDeductions', 'employerCost'] as const) {
      expect(selected[field]).toBe(saved[field]);
    }
    expect(selected.statutory).toEqual(saved.statutory);
    expect(await slipOf(batchId, other.employmentId)).toEqual(otherSaved);
    const [job] = await owner.db.select().from(schema.payrollReprocessJob).where(eq(schema.payrollReprocessJob.idempotencyKey, key));
    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({ reprocessed: 1, validationFailed: 0, skipped: 0 });
    const newHistory = await owner.db.select().from(schema.payrollEmployeeResultHistory)
      .where(eq(schema.payrollEmployeeResultHistory.batchId, batchId));
    expect(newHistory).toHaveLength(histories.length + 1);
    await resetProcessedBatch(ctx, { batchId, reason: 'Synthetic effective-date regression verification' });
    expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId))).toHaveLength(0);
    await generatePayslips(ctx, { batchId });
    expect((await slipOf(batchId, employee.employmentId)).basicSalary).toBe('10000.00');
    expect((await slipOf(batchId, other.employmentId)).basicSalary).toBe('10000.00');
  });

  it.each(['future-only', 'history-gap', 'superseded'])(
    'missing applicable salary (%s) blocks before saving any money', async variant => {
      const employee = await hire();
      await setCompensation(ctx, { employmentId: employee.employmentId, basicSalary: 10000, effectiveFrom: '2026-11-01' });
      if (variant !== 'future-only') {
        await owner.db.insert(schema.compensation).values({ tenantId: base.tenantId, employmentId: employee.employmentId,
          basicSalary: '8000.00', validFrom: '2026-08-01', validTo: variant === 'history-gap' ? '2026-09-01' : '2026-11-01',
          supersededAt: variant === 'superseded' ? new Date() : null });
      }
      const { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: '2026-10' });
      const [before] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId));
      expect((await preProcessAdvisory(ctx, batchId)).missingCompensation.map(row => row.employmentId)).toEqual([employee.employmentId]);
      await expect(generatePayslips(ctx, { batchId })).rejects.toBeInstanceOf(PreProcessBlockedError);
      expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId, batchId))).toHaveLength(0);
      expect((await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, batchId)))[0]).toEqual(before);
    },
  );

  it.each(['custom_period', 'zero', 'currency'])(
    'a future %s salary cannot poison earlier readiness or saved salary', async variant => {
      const employee = await hire();
      await setCompensation(ctx, { employmentId: employee.employmentId, basicSalary: 10000, effectiveFrom: '2026-08-01' });
      await setCompensation(ctx, { employmentId: employee.employmentId, basicSalary: variant === 'zero' ? 0 : 15000,
        effectiveFrom: '2026-11-01', payMode: variant === 'custom_period' ? 'custom_period' : 'monthly',
        currency: variant === 'currency' ? 'USD' : 'MYR', remarks: variant === 'zero' ? 'Future unpaid arrangement' : undefined });
      const { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: '2026-10' });
      const checks = await preProcessAdvisory(ctx, batchId);
      for (const key of ['missingCompensation', 'unpayablePayMode', 'zeroBasic', 'nothingPayable', 'currencyMismatch'] as const) {
        expect(checks[key] ?? []).toHaveLength(0);
      }
      await generatePayslips(ctx, { batchId });
      expect((await slipOf(batchId, employee.employmentId)).basicSalary).toBe('10000.00');
    },
  );

  it('legacy allowance is taken from the same historical owner as basic, even if entered much later', async () => {
    const employee = await hire();
    await setCompensation(ctx, { employmentId: employee.employmentId, basicSalary: 10000, monthlyAllowance: 300, effectiveFrom: '2026-08-01' });
    await setCompensation(ctx, { employmentId: employee.employmentId, basicSalary: 15000, monthlyAllowance: 900, effectiveFrom: '2026-11-01' });
    // recordedAt/createdAt describe when an operator entered the data; neither chooses payroll salary.
    await owner.db.update(schema.compensation).set({ recordedAt: new Date('2027-02-01T00:00:00Z'), createdAt: new Date('2027-02-01T00:00:00Z') })
      .where(eq(schema.compensation.employmentId, employee.employmentId));
    const slip = await generatedSlip('2026-10', employee.employmentId);
    expect(slip.basicSalary).toBe('10000.00');
    expect(slip.allowance).toBe('300.00');
    expect(slip.grossPay).toBe('10300.00');
  });

  it('historical hourly mode and rate stay together instead of taking a future monthly revision', async () => {
    const employee = await hire();
    await setCompensation(ctx, { employmentId: employee.employmentId, basicSalary: 4000, payMode: 'hourly', rateAmount: 25, effectiveFrom: '2026-08-01' });
    await setCompensation(ctx, { employmentId: employee.employmentId, basicSalary: 15000, payMode: 'monthly', rateAmount: null, effectiveFrom: '2026-11-01' });
    await owner.db.insert(schema.attendance).values({ tenantId: base.tenantId, employmentId: employee.employmentId,
      attendanceDate: '2026-10-05', checkInAt: '09:00:00', checkOutAt: '17:00:00', status: 'present',
      dayType: 'workday', workedMinutes: 480, otMinutes: 0 });
    const slip = await generatedSlip('2026-10', employee.employmentId);
    expect(slip.basicSalary).toBe('200.00');
    expect(slip.grossPay).toBe('200.00');
  });
  it('OT prefill and saved gross use historical basic plus historical allowance, not future wages above the OT ceiling', async () => {
    const employee = await hire();
    await setCompensation(ctx, { employmentId: employee.employmentId, basicSalary: 2600, monthlyAllowance: 520, effectiveFrom: '2026-08-01' });
    await setCompensation(ctx, { employmentId: employee.employmentId, basicSalary: 6000, monthlyAllowance: 1000, effectiveFrom: '2026-11-01' });
    await owner.db.insert(schema.attendance).values({ tenantId: base.tenantId, employmentId: employee.employmentId,
      attendanceDate: '2026-10-05', checkInAt: '09:00:00', checkOutAt: '18:00:00', status: 'present',
      dayType: 'workday', workedMinutes: 540, otMinutes: 60 });
    const { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: '2026-10' });
    expect(await prefillOvertimeFromAttendance(ctx, { batchId })).toMatchObject({ applied: 1, ineligible: 0 });
    const [input] = await owner.db.select().from(schema.payrollInput)
      .where(and(eq(schema.payrollInput.batchId, batchId), eq(schema.payrollInput.employmentId, employee.employmentId)));
    // One hour: RM3120 / 26 / 8 × 1.5 = RM22.50. The future RM7000 wage would refuse statutory OT.
    expect(input.overtimeAmount).toBe('22.50');
    await generatePayslips(ctx, { batchId });
    const slip = await slipOf(batchId, employee.employmentId);
    expect(slip.basicSalary).toBe('2600.00');
    expect(slip.allowance).toBe('520.00');
    expect(slip.overtimePay).toBe('22.50');
    expect(slip.grossPay).toBe('3142.50');
  });

  it('selected reprocess fails closed on a newly uncovered period and preserves the existing result', async () => {
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    ctx = await entitledCtx(base);
    const employee = await salaryHistory();
    const saved = await generatedSlip('2026-10', employee.employmentId);
    // Simulate a genuine historical gap in synthetic data; the open November salary is still present.
    await owner.db.update(schema.compensation).set({ validTo: '2026-09-01' })
      .where(and(eq(schema.compensation.employmentId, employee.employmentId), eq(schema.compensation.validFrom, '2026-08-01')));
    const [before] = await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, saved.batchId));
    const key = randomUUID();
    await reprocessSelectedEmployees(ctx, { batchId: saved.batchId, employmentIds: [employee.employmentId], idempotencyKey: key });
    const [job] = await owner.db.select().from(schema.payrollReprocessJob).where(eq(schema.payrollReprocessJob.idempotencyKey, key));
    expect(job.status).toBe('completed');
    expect(job.result).toMatchObject({ reprocessed: 0, skipped: 0, validationFailed: 1,
      outcomes: [expect.objectContaining({ employmentId: employee.employmentId, status: 'validation_failed', resultRetained: true,
        payslipId: saved.id, historyId: null, versionBefore: saved.version, versionAfter: saved.version })] });
    expect(await slipOf(saved.batchId, employee.employmentId)).toEqual(saved);
    expect((await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id, saved.batchId)))[0]).toEqual(before);
    expect(await owner.db.select().from(schema.payrollEmployeeResultHistory)
      .where(eq(schema.payrollEmployeeResultHistory.batchId, saved.batchId))).toHaveLength(0);
  });

  it('additional-run saved money matches a control employee when the other has an irrelevant future custom salary', async () => {
    await setModule(base.tenantId, 'multi_cycle_payroll', 'active');
    ctx = await entitledCtx(base);
    const control = await hire();
    const revised = await hire();
    for (const employee of [control, revised]) {
      await setCompensation(ctx, { employmentId: employee.employmentId, basicSalary: 10000, effectiveFrom: '2026-08-01' });
    }
    const regular = await createBatch(ctx, { companyId: base.companyId, payPeriod: '2026-10' });
    await generatePayslips(ctx, { batchId: regular.batchId });
    await setCompensation(ctx, { employmentId: revised.employmentId, basicSalary: 15000, payMode: 'custom_period', effectiveFrom: '2026-11-01' });
    const bonus = await createAdditionalRun(ctx, { companyId: base.companyId, payPeriod: '2026-10', runType: 'bonus' });
    for (const employee of [control, revised]) {
      await setPayrollInput(ctx, { batchId: bonus.batchId, employmentId: employee.employmentId, overtimeAmount: 0, bonusAmount: 1000 });
    }
    await generatePayslips(ctx, { batchId: bonus.batchId });
    const a = await slipOf(bonus.batchId, control.employmentId);
    const b = await slipOf(bonus.batchId, revised.employmentId);
    expect(a.grossPay).toBe('1000.00');
    expect(b.grossPay).toBe('1000.00');
    expect(b.basicSalary).toBe('0.00');
    expect(Number(a.totalDeductions)).toBeGreaterThan(0);
    for (const field of ['bonus', 'netPay', 'totalDeductions', 'employerCost'] as const) {
      expect(b[field]).toBe(a[field]);
    }
  });

});
