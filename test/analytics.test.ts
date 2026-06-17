/**
 * Wave 4B — HR analytics read layer. Active headcount (terminated excluded), new-hire / termination
 * cohorts by period, the standard turnover KPI (leavers ÷ avg headcount), and master-data export with
 * compensation gated to the includeComp flag (admin-only; Wave 1 #5).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import { hireEmployee, terminateEmployment } from '../core/org';
import { setCompensation } from '../core/comp';
import { headcountSummary, masterDataExport, newHires, terminations, turnoverRate } from '../core/analytics';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

const hire = (ctx: SessionContext, b: Base, name: string, hiredOn: string) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });

describe('Wave 4B — analytics read layer', () => {
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

  // E1 active (Jan), E2 active (Mar), E3 hired Feb + terminated 20 May (voluntary), E4 active (Jun 1).
  async function cohort() {
    const a = adminCtx(base);
    const e1 = await hire(a, base, 'Ann', '2026-01-15');
    const e2 = await hire(a, base, 'Bob', '2026-03-01');
    const e3 = await hire(a, base, 'Cara', '2026-02-10');
    const e4 = await hire(a, base, 'Dan', '2026-06-01');
    await terminateEmployment(a, { employmentId: e3.employmentId, terminationDate: '2026-05-20', terminationType: 'voluntary' });
    return { a, e1, e2, e3, e4 };
  }

  it('headcount: counts only active employees as of the date', async () => {
    const { a } = await cohort();
    const hc = await headcountSummary(a, undefined, { asOf: '2026-06-17' });
    expect(hc.total).toBe(3); // Ann, Bob, Dan active; Cara terminated 20 May
    expect(hc.byCompany.reduce((s, r) => s + r.count, 0)).toBe(3);
  });

  it('new hires: only those hired within the window', async () => {
    const { a } = await cohort();
    expect((await newHires(a, undefined, { from: '2026-06-01', to: '2026-06-30' })).map((r) => r.name)).toEqual(['Dan']);
    expect((await newHires(a, undefined, { from: '2026-01-01', to: '2026-12-31' })).length).toBe(4);
  });

  it('terminations: the leaver cohort with classification', async () => {
    const { a } = await cohort();
    const rows = await terminations(a, undefined, { from: '2026-05-01', to: '2026-05-31' });
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ name: 'Cara', terminationType: 'voluntary', terminatedOn: '2026-05-20' });
  });

  it('turnover %: leavers ÷ average headcount × 100', async () => {
    const { a } = await cohort();
    const t = await turnoverRate(a, undefined, { from: '2026-05-01', to: '2026-05-31' });
    // Start (1 May) = Ann, Bob, Cara = 3; End (31 May) = Ann, Bob = 2; avg = 2.5; leavers = 1 → 40%.
    expect(t).toMatchObject({ leavers: 1, headcountStart: 3, headcountEnd: 2, avgHeadcount: 2.5, turnoverPct: 40 });
  });

  it('master-data export: compensation gated to the includeComp flag', async () => {
    const { a, e1 } = await cohort();
    await setCompensation(a, { employmentId: e1.employmentId, basicSalary: 5000, monthlyAllowance: 300, effectiveFrom: '2026-01-15' });

    const without = await masterDataExport(a, undefined, { includeComp: false });
    expect(without.every((r) => r.basicSalary === undefined)).toBe(true);

    const withComp = await masterDataExport(a, undefined, { includeComp: true });
    const ann = withComp.find((r) => r.name === 'Ann');
    expect(ann?.basicSalary).toBe('5000.00');
    expect(ann?.currency).toBe('MYR');
    // Active roster excludes the terminated employee by default.
    expect(withComp.some((r) => r.name === 'Cara')).toBe(false);
  });
});
