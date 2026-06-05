import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTenant, type SessionContext } from '../db/client';
import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  createAppUser,
  eventTypesFor,
  ledgerBalance,
  migrateTestDb,
  resetDb,
  seedBase,
  type Base,
} from './harness';
import {
  getAssignmentAsOf,
  hireEmployee,
  ReportingCycleError,
  setReportingLine,
  terminateEmployment,
  transferEmployee,
} from '../core/org';
import { decideLeave, InsufficientLeaveBalanceError, requestLeave } from '../core/leave';
import { reportingLinesFor } from '../core/read';
import { createCompany } from '../core/admin';

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

const hire = (ctx: SessionContext, b: Base, name: string, opts?: { annual?: boolean }) =>
  hireEmployee(ctx, {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}@acme.test` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
    annualLeaveTypeId: opts?.annual ? b.annualLeaveTypeId : undefined,
  });

describe('UC8 — tenant isolation', () => {
  it('a session cannot see another tenant’s companies, and zero without a tenant', async () => {
    const other = await seedBase();
    const seen = await withTenant(adminCtx(base), (tx) => tx.select().from(schema.company));
    expect(seen.length).toBe(1);
    expect(seen[0].tenantId).toBe(base.tenantId);
    expect(seen.some((c) => c.tenantId === other.tenantId)).toBe(false);

    const none = await withTenant(
      { tenantId: '00000000-0000-0000-0000-000000000000' },
      (tx) => tx.select().from(schema.company),
    );
    expect(none.length).toBe(0);
  });
});

describe('UC2 — bitemporal transfer & as-of', () => {
  it('reconstructs department before and after an effective-dated transfer', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hire(a, base, 'Aisyah');
    await transferEmployee(a, { employmentId, effectiveDate: '2026-04-01', departmentId: base.deptB });

    const before = await getAssignmentAsOf(a, employmentId, '2026-03-31');
    const after = await getAssignmentAsOf(a, employmentId, '2026-04-01');
    expect(before?.departmentId).toBe(base.deptA);
    expect(after?.departmentId).toBe(base.deptB);

    const all = await withTenant(a, (tx) =>
      tx.select().from(schema.assignment).where(eq(schema.assignment.employmentId, employmentId)),
    );
    expect(all.length).toBe(2); // history preserved
  });
});

describe('UC4 — reporting cycle guard', () => {
  it('rejects an administrative cycle (and a self-loop)', async () => {
    const a = adminCtx(base);
    const A = await hire(a, base, 'Anya');
    const B = await hire(a, base, 'Bo');
    const C = await hire(a, base, 'Cara');
    const line = (sub: string, mgr: string) =>
      setReportingLine(a, {
        subordinateEmploymentId: sub,
        managerEmploymentId: mgr,
        lineType: 'administrative',
        validFrom: '2026-01-01',
      });
    await line(A.employmentId, B.employmentId);
    await line(B.employmentId, C.employmentId);

    await expect(line(C.employmentId, A.employmentId)).rejects.toBeInstanceOf(ReportingCycleError);
    await expect(line(A.employmentId, A.employmentId)).rejects.toBeInstanceOf(ReportingCycleError);
  });
});

describe('UC6 — leave approval atomicity & balance', () => {
  it('approves within balance; rejects over-balance without debiting', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hire(a, base, 'Bala', { annual: true });
    expect(await ledgerBalance(employmentId, base.annualLeaveTypeId)).toBe(16);

    const r1 = await requestLeave(a, {
      employmentId,
      leaveTypeId: base.annualLeaveTypeId,
      startDate: '2026-02-02',
      endDate: '2026-02-04', // 3 days
    });
    await decideLeave(a, { leaveRequestId: r1.leaveRequestId, decision: 'approved' });
    expect(await ledgerBalance(employmentId, base.annualLeaveTypeId)).toBe(13);

    const r2 = await requestLeave(a, {
      employmentId,
      leaveTypeId: base.annualLeaveTypeId,
      startDate: '2026-03-01',
      endDate: '2026-03-31', // 31 days
    });
    await expect(
      decideLeave(a, { leaveRequestId: r2.leaveRequestId, decision: 'approved' }),
    ).rejects.toBeInstanceOf(InsufficientLeaveBalanceError);
    expect(await ledgerBalance(employmentId, base.annualLeaveTypeId)).toBe(13); // unchanged (atomic)

    const evs = await eventTypesFor(base.tenantId, r1.leaveRequestId);
    expect(evs).toContain('leave-request.submitted');
    expect(evs).toContain('leave-request.approved');
  });
});

describe('UC9 — ABAC visibility', () => {
  it('a manager sees a report’s leave but not a peer’s', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Emp', { annual: true });
    const M = await hire(a, base, 'Mgr');
    const X = await hire(a, base, 'Peer');
    const uM = await createAppUser(base.tenantId, M.personId, 'manager');
    const uX = await createAppUser(base.tenantId, X.personId, 'employee');
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-01',
    });
    await requestLeave(a, {
      employmentId: E.employmentId,
      leaveTypeId: base.annualLeaveTypeId,
      startDate: '2026-02-02',
      endDate: '2026-02-03',
    });

    const mgrCtx: SessionContext = { tenantId: base.tenantId, userId: uM, roles: ['manager'] };
    const peerCtx: SessionContext = { tenantId: base.tenantId, userId: uX, roles: ['employee'] };

    const mgrSeesReport = await withTenant(mgrCtx, (tx) =>
      tx.select().from(schema.leaveRequest).where(eq(schema.leaveRequest.employmentId, E.employmentId)),
    );
    const peerSeesReport = await withTenant(peerCtx, (tx) =>
      tx.select().from(schema.leaveRequest).where(eq(schema.leaveRequest.employmentId, E.employmentId)),
    );
    expect(mgrSeesReport.length).toBe(1);
    expect(peerSeesReport.length).toBe(0);
  });
});

describe('UC3 — terminate', () => {
  it('closes the open assignment, sets terminatedOn, and emits an event', async () => {
    const a = adminCtx(base);
    const { employmentId } = await hire(a, base, 'Tariq');
    await terminateEmployment(a, { employmentId, terminationDate: '2026-06-30' });

    const [emp] = await withTenant(a, (tx) =>
      tx.select().from(schema.employment).where(eq(schema.employment.id, employmentId)),
    );
    expect(emp.terminatedOn).toBe('2026-06-30');

    const assignments = await withTenant(a, (tx) =>
      tx.select().from(schema.assignment).where(eq(schema.assignment.employmentId, employmentId)),
    );
    expect(assignments[0].validTo).toBe('2026-06-30');

    const evs = await eventTypesFor(base.tenantId, employmentId);
    expect(evs).toContain('employment.hired');
    expect(evs).toContain('employment.terminated');
  });
});

describe('reporting lines — valid edge', () => {
  it('creates and lists a manager relationship both directions', async () => {
    const a = adminCtx(base);
    const E = await hire(a, base, 'Suba');
    const M = await hire(a, base, 'Boss');
    await setReportingLine(a, {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M.employmentId,
      lineType: 'administrative',
      validFrom: '2026-01-01',
    });
    const sub = await reportingLinesFor(a, E.employmentId);
    expect(sub.managers.map((m) => m.employmentId)).toContain(M.employmentId);
    const mgr = await reportingLinesFor(a, M.employmentId);
    expect(mgr.reports.map((r) => r.employmentId)).toContain(E.employmentId);
  });
});

describe('hardening — role-gated writes', () => {
  it('a non-admin session cannot create a company (RLS denies)', async () => {
    const employee: SessionContext = { tenantId: base.tenantId, userId: base.adminUserId, roles: ['employee'] };
    await expect(createCompany(employee, { legalName: 'Sneaky Sdn Bhd' })).rejects.toThrow();
  });
});
