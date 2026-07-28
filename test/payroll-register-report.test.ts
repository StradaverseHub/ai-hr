/**
 * Payroll Register custom report (feedback 622e12eb) — the dataset end-to-end through the SHARED runner
 * (`runReportSpec`), not just the raw read. Pins what the reporter actually asked for:
 *   • a saved spec naming payroll_register validates against the closed registry
 *   • the run projects the chosen register columns with the English header labels
 *   • the Payroll Period / Department default filters narrow the result at run time
 *   • a summary row totals the currency columns (the register's footer line)
 * Company scope is the caller's authorised set, so an empty scope fails closed like every other dataset.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import type { CustomReportSpec } from '../db/schema';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { getDataset, runReportSpec, validateReportSpec } from '../core/report-registry';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const COLUMNS = ['employeeCode', 'employeeName', 'department', 'payPeriod', 'gross', 'epfEmployee', 'epfEmployer', 'net'];

const spec = (over: Partial<CustomReportSpec> = {}): CustomReportSpec => ({
  datasetId: 'payroll_register',
  columns: COLUMNS,
  ...over,
});

describe('payroll register report (622e12eb)', () => {
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

  /** Hire + compensation + statutory profile so generatePayslips produces a full statutory blob. */
  async function hirePayrollReady(a: SessionContext, deptId: string, name: string, ic: string) {
    const e = await hireEmployee(a, {
      person: { fullName: name, primaryEmail: `${name.toLowerCase().replace(/\s+/g, '')}@acme.test` },
      companyId: base.companyId,
      departmentId: deptId,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 3000, monthlyAllowance: 0, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: e.personId, icNumber: ic });
    return e;
  }

  it('a register spec validates and runs, projecting register columns with English headers', async () => {
    const a = adminCtx(base);
    await hirePayrollReady(a, base.deptA, 'Reg Runner', '900101011234');
    const b = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: b.batchId });

    expect(validateReportSpec(spec()).ok).toBe(true);

    const data = await runReportSpec(a, [base.companyId], spec());
    expect(data.columns).toEqual([
      'Employee ID',
      'Employee Name',
      'Department',
      'Payroll Period',
      'Total Earnings (Gross)',
      'EPF (Employee)',
      'EPF (Employer)',
      'Nett Wage',
    ]);
    expect(data.rows).toHaveLength(1);
    const row = data.rows[0];
    expect(row[1]).toBe('Reg Runner');
    expect(row[2]).toBe('Finance');
    expect(row[3]).toBe('2026-05');
    expect(Number(row[4])).toBeGreaterThan(0); // gross
    expect(Number(row[6])).toBeGreaterThan(0); // employer EPF — the column payroll_history cannot produce
  });

  it('default filters narrow at run time (period + department) and an empty scope fails closed', async () => {
    const a = adminCtx(base);
    await hirePayrollReady(a, base.deptA, 'Fin One', '900101011234');
    await hirePayrollReady(a, base.deptB, 'Ops One', '900202021235');
    const may = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    const jun = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-06' });
    await generatePayslips(a, { batchId: may.batchId });
    await generatePayslips(a, { batchId: jun.batchId });

    expect((await runReportSpec(a, [base.companyId], spec())).rows).toHaveLength(4);

    const mayOnly = await runReportSpec(a, [base.companyId], spec({ filters: { payPeriod: '2026-05' } }));
    expect(mayOnly.rows.map((r) => r[3])).toEqual(['2026-05', '2026-05']);

    const finance = await runReportSpec(a, [base.companyId], spec({ filters: { department: 'Finance' } }));
    expect(finance.rows.map((r) => r[2])).toEqual(['Finance', 'Finance']);

    // A malformed period never reaches the DB read (it would be a bad predicate); the runner's shared
    // contains-filter still applies it to the projected column, so it simply matches nothing.
    expect((await runReportSpec(a, [base.companyId], spec({ filters: { payPeriod: 'nonsense' } }))).rows).toEqual([]);

    expect((await runReportSpec(a, [], spec())).rows).toEqual([]);
  });

  it('summary totals the register currency columns (the footer line)', async () => {
    const a = adminCtx(base);
    await hirePayrollReady(a, base.deptA, 'Sum A', '900101011234');
    await hirePayrollReady(a, base.deptA, 'Sum B', '900202021235');
    const b = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-05' });
    await generatePayslips(a, { batchId: b.batchId });

    const data = await runReportSpec(a, [base.companyId], spec({ layout: { summary: ['gross', 'net'] } }));
    expect(data.rows).toHaveLength(3); // 2 employees + the Total line
    const [r1, r2, total] = data.rows;
    expect(Number(total[4])).toBeCloseTo(Number(r1[4]) + Number(r2[4]), 2);
    expect(Number(total[7])).toBeCloseTo(Number(r1[7]) + Number(r2[7]), 2);
  });

  it('the register is the payroll dataset the builder opens by default', () => {
    // The Reports → Payroll "New report" button links datasetsForCategory('payroll')[0].
    expect(getDataset('payroll_register')?.category).toBe('payroll');
  });
});
