/**
 * Consultant feedback #5 — compensation read access. Base pay is ADMIN-OR-SELF only: a manager must
 * NOT be able to read a direct report's compensation (the old can_see_employment policy leaked it).
 * RLS migration 0060 enforces this; this test pins the contract.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { currentCompensation, setCompensation } from '../core/comp';
import { hireEmployee, setReportingLine } from '../core/org';
import { employeeDetail } from '../core/read';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

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

  it('ADR-0078: a payroll partner’s row read carries the three new pay-structure columns', async () => {
    const { a, E1 } = await setup();
    // Give the report a non-monthly structure so the columns carry real values, not defaults.
    await setCompensation(a, {
      employmentId: E1.employmentId,
      basicSalary: 7200,
      payMode: 'daily',
      paymentTerm: 'weekly',
      rateAmount: 280,
      effectiveFrom: '2026-02-01',
    });
    // A payroll partner for the company (0099 widened comp READ so payslip generation can join it).
    const [uP] = await owner.db
      .insert(schema.appUser)
      .values({ tenantId: base.tenantId, workosUserId: `user_${randomUUID()}`, personId: null })
      .returning({ id: schema.appUser.id });
    await owner.db
      .insert(schema.roleAssignment)
      .values({ tenantId: base.tenantId, appUserId: uP.id, companyId: base.companyId, role: 'payroll_partner' });
    const pCtx: SessionContext = {
      tenantId: base.tenantId,
      userId: uP.id,
      grants: [{ role: 'payroll_partner', companyId: base.companyId }],
    };
    const comp = await currentCompensation(pCtx, E1.employmentId);
    expect(comp?.payMode).toBe('daily');
    expect(comp?.paymentTerm).toBe('weekly');
    expect(Number(comp?.rateAmount)).toBe(280);
  });
});
