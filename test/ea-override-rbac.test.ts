/**
 * 1.2.6 EA Data Overwrite — RBAC / RLS. The write is gated TWICE: the service guard (isAdmin /
 * canManagePayroll) is the primary gate, and the ea_override RLS WITH CHECK = can_admin_employment is the
 * SQL backstop. We assert: an admin can write; a plain employee (the subject) and an unrelated manager
 * CANNOT write; but the subject CAN READ their own amended EA (the amended figures land on their own form);
 * an unrelated peer cannot read the override at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import { adminCtx, closeAll, createAppUser, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { employeeEaStatement } from '../core/reporting';
import { setEaOverride, EaOverrideError } from '../core/ea-override';

describe('1.2.6 EA Data Overwrite — RBAC / RLS', () => {
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

  it('admin writes; subject + unrelated manager cannot; subject reads own amended EA; peer cannot read', async () => {
    const a = adminCtx(base);

    // Subject A — has a 2026 payslip, so a real EA exists.
    const A = await hireEmployee(a, {
      person: { fullName: 'Subject A', primaryEmail: 'subject.a@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: A.employmentId, basicSalary: 5000, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: A.personId, icNumber: '900101015555', taxCategory: 1, numChildren: 0 });
    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-01' });
    await generatePayslips(a, { batchId: batch.batchId });

    // Peer B — unrelated employee. Manager M — an unrelated manager (no admin grant over A's company).
    const B = await hireEmployee(a, {
      person: { fullName: 'Peer B', primaryEmail: 'peer.b@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    const M = await hireEmployee(a, {
      person: { fullName: 'Manager M', primaryEmail: 'manager.m@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptB,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });

    const uA = await createAppUser(base.tenantId, A.personId, 'employee');
    const uB = await createAppUser(base.tenantId, B.personId, 'employee');
    const uM = await createAppUser(base.tenantId, M.personId, 'manager');
    const subjectCtx: SessionContext = { tenantId: base.tenantId, userId: uA, personId: A.personId, roles: ['employee'] };
    const peerCtx: SessionContext = { tenantId: base.tenantId, userId: uB, personId: B.personId, roles: ['employee'] };
    const mgrCtx: SessionContext = { tenantId: base.tenantId, userId: uM, personId: M.personId, roles: ['manager'] };

    // Admin can amend.
    await setEaOverride(a, { employmentId: A.employmentId, year: '2026', field: 'allowances', amount: 1234.56, reason: 'admin amend' });

    // The subject (plain employee) cannot amend — the service guard rejects.
    await expect(
      setEaOverride(subjectCtx, { employmentId: A.employmentId, year: '2026', field: 'allowances', amount: 9, reason: 'self' }),
    ).rejects.toThrow(EaOverrideError);
    // An unrelated manager cannot amend either.
    await expect(
      setEaOverride(mgrCtx, { employmentId: A.employmentId, year: '2026', field: 'allowances', amount: 9, reason: 'mgr' }),
    ).rejects.toThrow(EaOverrideError);

    // Even bypassing the service guard, the RLS WITH CHECK = can_admin_employment blocks a direct write by a
    // non-admin (the SQL backstop). A plain employee's direct insert must be rejected.
    await expect(
      withTenant(peerCtx, (tx) =>
        tx.insert(schema.eaOverride).values({
          tenantId: base.tenantId,
          employmentId: A.employmentId,
          year: '2026',
          field: 'bonus',
          amount: '5.00',
          reason: 'rls bypass attempt',
        }),
      ),
    ).rejects.toThrow();

    // The subject CAN read their own amended EA (RLS USING = can_see_employment allows self-read).
    const subjectEa = await employeeEaStatement(subjectCtx, { employmentId: A.employmentId, year: '2026' });
    expect(subjectEa).not.toBeNull();
    expect(subjectEa!.partB.allowances).toBeCloseTo(1234.56, 2);
    expect(subjectEa!.overrides.some((o) => o.field === 'allowances')).toBe(true);

    // An unrelated peer cannot read the override row at all (RLS USING fails closed).
    const peerRows = await withTenant(peerCtx, (tx) =>
      tx
        .select()
        .from(schema.eaOverride)
        .where(and(eq(schema.eaOverride.employmentId, A.employmentId), eq(schema.eaOverride.year, '2026'))),
    );
    expect(peerRows).toEqual([]);
    // And the peer's EA read for A returns null (no relationship).
    const peerEa = await employeeEaStatement(peerCtx, { employmentId: A.employmentId, year: '2026' });
    expect(peerEa).toBeNull();
  });
});
