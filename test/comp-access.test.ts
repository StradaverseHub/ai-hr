/**
 * Consultant feedback #5 — compensation read access. Base pay is ADMIN-OR-SELF only: a manager must
 * NOT be able to read a direct report's compensation (the old can_see_employment policy leaked it).
 * RLS migration 0060 enforces this; this test pins the contract.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import { currentCompensation, setCompensation } from '../core/comp';
import { hireEmployee, setReportingLine } from '../core/org';
import { employeeDetail } from '../core/read';
import { adminCtx, closeAll, createAppUser, migrateTestDb, resetDb, seedBase, type Base } from './harness';

describe('compensation access — admin-or-self only (consultant #5)', () => {
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

  async function setup() {
    const a = adminCtx(base);
    const hire = (name: string) =>
      hireEmployee(a, {
        person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
        companyId: base.companyId,
        departmentId: base.deptA,
        employmentType: 'full_time',
        hiredOn: '2026-01-01',
      });
    const M = await hire('Manager');
    const E1 = await hire('Report');
    await setReportingLine(a, {
      subordinateEmploymentId: E1.employmentId,
      managerEmploymentId: M.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-01',
    });
    await setCompensation(a, { employmentId: E1.employmentId, basicSalary: 7000, effectiveFrom: '2026-01-01' });

    const uM = await createAppUser(base.tenantId, M.personId, 'manager');
    const mCtx: SessionContext = { tenantId: base.tenantId, userId: uM, roles: ['manager'], personId: M.personId };
    const uE = await createAppUser(base.tenantId, E1.personId, 'employee');
    const eCtx: SessionContext = { tenantId: base.tenantId, userId: uE, roles: ['employee'], personId: E1.personId };
    return { a, M, E1, mCtx, eCtx };
  }

  it('admin can read a report’s compensation', async () => {
    const { a, E1 } = await setup();
    const comp = await currentCompensation(a, E1.employmentId);
    expect(Number(comp?.basicSalary)).toBe(7000);
  });

  it('the employee can read their OWN compensation', async () => {
    const { eCtx, E1 } = await setup();
    const comp = await currentCompensation(eCtx, E1.employmentId);
    expect(Number(comp?.basicSalary)).toBe(7000);
  });

  it('a MANAGER cannot read a direct report’s compensation', async () => {
    const { mCtx, E1 } = await setup();
    const comp = await currentCompensation(mCtx, E1.employmentId);
    expect(comp).toBeFalsy();
  });

  it('but the manager can still see the report’s non-pay record (we only restricted comp)', async () => {
    const { mCtx, E1 } = await setup();
    const detail = await employeeDetail(mCtx, E1.employmentId);
    expect(detail?.name).toBe('Report');
  });
});
