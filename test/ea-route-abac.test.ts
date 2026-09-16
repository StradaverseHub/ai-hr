/**
 * EA PDF route authorization. The /me/ea/[employmentId]/pdf route's ABAC is entirely inherited from
 * employeeEaStatement → the MY pack's RLS-gated eaStatement: the read returns null unless the caller may
 * see the employment, and the route maps null → 404. We assert that contract directly with three session
 * contexts: the owner and an admin get a statement; a peer employee (no relationship) gets null, which the
 * route surfaces as 404. This is the load-bearing guard that an employee cannot pull a colleague's EA.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminCtx, closeAll, createAppUser, migrateTestDb, resetDb, seedBase, type Base, harnessSnapshot } from './harness';
import type { SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips } from '../core/payroll';
import { employeeEaStatement } from '../core/reporting';

describe('EA PDF route — authorization (RLS null → 404)', () => {
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

  it('owner + admin get a statement; an unrelated peer gets null (→ 404 at the route)', async () => {
    const a = adminCtx(base);

    // Employee A — has a 2026 payslip, so a real EA statement exists.
    const A = await hireEmployee(a, {
      person: { fullName: 'Owner A', primaryEmail: 'owner.a@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await setCompensation(a, { employmentId: A.employmentId, basicSalary: 5000, effectiveFrom: '2026-01-01' });
    await setStatutoryProfileMY(a, { personId: A.personId, icNumber: '900101015555', taxCategory: 1, numChildren: 0 });
    const batch = await createBatch(a, { companyId: base.companyId, payPeriod: '2026-01' });
    await generatePayslips(a, { batchId: batch.batchId });

    // Employee B — an unrelated peer (no reporting line, not an admin).
    const B = await hireEmployee(a, {
      person: { fullName: 'Peer B', primaryEmail: 'peer.b@acme.test' },
      companyId: base.companyId,
      departmentId: base.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });

    const uA = await createAppUser(base.tenantId, A.personId, 'employee');
    const uB = await createAppUser(base.tenantId, B.personId, 'employee');
    const ownerCtx: SessionContext = { tenantId: base.tenantId, userId: uA, personId: A.personId, roles: ['employee'], entitlements: harnessSnapshot(base.tenantId) };
    const peerCtx: SessionContext = { tenantId: base.tenantId, userId: uB, personId: B.personId, roles: ['employee'], entitlements: harnessSnapshot(base.tenantId) };

    // Owner sees their own EA.
    const own = await employeeEaStatement(ownerCtx, { employmentId: A.employmentId, year: '2026' });
    expect(own).not.toBeNull();
    expect(own!.employee.name).toBe('Owner A');

    // Peer cannot — RLS returns null, which the route maps to 404.
    const foreign = await employeeEaStatement(peerCtx, { employmentId: A.employmentId, year: '2026' });
    expect(foreign).toBeNull();

    // Admin can pull any employee's EA in their scope.
    const asAdmin = await employeeEaStatement(a, { employmentId: A.employmentId, year: '2026' });
    expect(asAdmin).not.toBeNull();
  });
});
