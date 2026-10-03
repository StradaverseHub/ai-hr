import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { setCompensation } from '../core/comp';
import { hireEmployee } from '../core/org';
import { requirePackFor } from '../localization/registry';
import { createBatch, generatePayslips } from '../packs/payroll/service';
import { closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

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

  async function salaryHistory() {
    const employee = await hireEmployee(ctx, {
      person: { fullName: 'Synthetic Effective Salary', primaryEmail: `${randomUUID()}@r386.test` },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-08-01',
    });
    await requirePackFor('MY').statutory.set(ctx, {
      personId: employee.personId,
      icNumber: '900101880001',
    });
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
    const { batchId } = await createBatch(ctx, { companyId: base.companyId, payPeriod: period });
    await generatePayslips(ctx, { batchId });
    const slips = await owner.db.select().from(schema.payslip)
      .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
    expect(slips, 'real payroll must save exactly one payslip for the synthetic employee').toHaveLength(1);
    return slips[0];
  }

  it('August 2026 saved basic is 10000 despite the open 15000 salary effective November 2026', async () => {
    const employee = await salaryHistory();
    const slip = await generatedSlip('2026-08', employee.employmentId);
    expect(slip.basicSalary, 'August payroll must save the August-effective 10000 basic, not future November 15000')
      .toBe('10000.00');
  });

  it('November 2026 saves 15000 when that future salary becomes effective', async () => {
    const employee = await salaryHistory();
    const slip = await generatedSlip('2026-11', employee.employmentId);
    expect(slip.basicSalary, 'November payroll must save the newly effective 15000 basic').toBe('15000.00');
  });
});
