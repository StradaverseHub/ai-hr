/**
 * Global Delegation (Phase 1) — the /delegations feature. Covers, against the real DB + RLS:
 *   • self-service authorization primitives: hasDownline (must have reports), no self-delegate, overlap reject;
 *   • a self-service (non-admin) manager can CREATE a delegate edge under the widened RLS, it is HONOURED at
 *     decision time, and a self-service REVOKE removes authority mid-window;
 *   • read scoping: HR sees every delegation, a self-service user sees only rows they participate in
 *     (delegator or delegate) via app.self_delegations();
 *   • notification dispatch for delegation.started / delegation.ended targets the STAND-IN.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import {
  DelegationError,
  ReportingCycleError,
  endReportingLine,
  hasDownline,
  hireEmployee,
  setReportingLine,
} from '../core/org';
import { delegationsScoped } from '../core/read';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { requestLeave, decideLeave } from '../core/leave';
import { dispatchNotifications } from '../core/notifications';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const A = (base: Base) => adminCtx(base);
const uniq = () => `${randomUUID().slice(0, 8)}@t.local`;

async function hire(name: string) {
  return hireEmployee(A(b), {
    person: { fullName: name, primaryEmail: uniq() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
}
async function adminLine(sub: string, mgr: string, validFrom = '2024-01-01') {
  return setReportingLine(A(b), { subordinateEmploymentId: sub, managerEmploymentId: mgr, lineType: 'administrative', validFrom });
}
async function userCtx(personId: string, role: 'employee' | 'manager'): Promise<SessionContext> {
  const uid = await createAppUser(b.tenantId, personId, role);
  return { tenantId: b.tenantId, userId: uid, roles: [role], personId };
}
async function notificationsFor(employmentId: string) {
  return owner.db
    .select({ kind: schema.notification.kind })
    .from(schema.notification)
    .where(eq(schema.notification.recipientEmploymentId, employmentId));
}

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterEach(() => {
  delete process.env.NOTIFICATIONS_ENABLED;
});

describe('Global Delegation (Phase 1)', () => {
  it('hasDownline: true for a manager with reports, false for a leaf employee', async () => {
    const mgr = await hire('Mgr');
    const sub = await hire('Sub');
    await adminLine(sub.employmentId, mgr.employmentId);
    expect(await hasDownline(A(b), mgr.employmentId, '2026-07-10')).toBe(true);
    expect(await hasDownline(A(b), sub.employmentId, '2026-07-10')).toBe(false);
  });

  it('rejects self-delegation (delegator === delegate)', async () => {
    const mgr = await hire('SelfDeleg');
    await expect(
      setReportingLine(A(b), {
        subordinateEmploymentId: mgr.employmentId,
        managerEmploymentId: mgr.employmentId,
        lineType: 'delegate',
        validFrom: '2026-07-01',
        validTo: '2026-07-31',
      }),
    ).rejects.toBeInstanceOf(ReportingCycleError);
  });

  it('rejects an overlapping active delegation of the same delegator', async () => {
    const mgr = await hire('OverMgr');
    const s1 = await hire('Stand1');
    const s2 = await hire('Stand2');
    await setReportingLine(A(b), { subordinateEmploymentId: mgr.employmentId, managerEmploymentId: s1.employmentId, lineType: 'delegate', validFrom: '2026-07-01', validTo: '2026-07-31' });
    await expect(
      setReportingLine(A(b), { subordinateEmploymentId: mgr.employmentId, managerEmploymentId: s2.employmentId, lineType: 'delegate', validFrom: '2026-07-15', validTo: '2026-08-15' }),
    ).rejects.toBeInstanceOf(DelegationError);
    // A non-overlapping window is accepted.
    await expect(
      setReportingLine(A(b), { subordinateEmploymentId: mgr.employmentId, managerEmploymentId: s2.employmentId, lineType: 'delegate', validFrom: '2026-08-01', validTo: '2026-08-31' }),
    ).resolves.toBeTruthy();
  });

  it('a self-service manager can CREATE a delegation under RLS; it is honoured at decision time; revoke removes authority', async () => {
    const mgr = await hire('LMgr');
    const sub = await hire('LSub');
    await adminLine(sub.employmentId, mgr.employmentId);
    const stand = await hire('Stand');
    // Multi-step chain so the stand-in clears the direct_manager step (advances, no ledger debit).
    await setLeaveApprovalPolicy(A(b), { companyId: b.companyId, enabled: true, levels: ['direct_manager', 'hr_admin'] });
    const { leaveRequestId } = await requestLeave(A(b), {
      employmentId: sub.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
    });

    // The manager (a non-admin) creates their OWN delegation — allowed by the widened reporting_line RLS.
    const mgrCtx = await userCtx(mgr.personId, 'manager');
    const { reportingLineId } = await setReportingLine(mgrCtx, {
      subordinateEmploymentId: mgr.employmentId,
      managerEmploymentId: stand.employmentId,
      lineType: 'delegate',
      validFrom: '2024-01-01',
      validTo: null,
    });
    expect(reportingLineId).toBeTruthy();

    // Honoured: the stand-in can clear the direct_manager step within the window.
    const standCtx = await userCtx(stand.personId, 'manager');
    const res = await decideLeave(standCtx, { leaveRequestId, decision: 'approved' });
    expect(res.status).toBe('pending');
    expect((res as { advancedTo?: string }).advancedTo).toBe('hr_admin');

    // Revoke mid-window (the manager ends their own delegation) removes the stand-in's authority.
    await endReportingLine(mgrCtx, { reportingLineId, endDate: '2020-01-01' });
    const sub2 = await hire('LSub2');
    await adminLine(sub2.employmentId, mgr.employmentId);
    const { leaveRequestId: lr2 } = await requestLeave(A(b), {
      employmentId: sub2.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-07-02',
      endDate: '2026-07-02',
    });
    await expect(decideLeave(standCtx, { leaveRequestId: lr2, decision: 'approved' })).rejects.toThrow();
  });

  it('a self-service manager cannot create a delegation on someone ELSE\'s behalf (RLS)', async () => {
    const other = await hire('OtherMgr');
    const otherSub = await hire('OtherSub');
    await adminLine(otherSub.employmentId, other.employmentId);
    const stand = await hire('Stand3');
    const rogue = await hire('Rogue');
    const rogueCtx = await userCtx(rogue.personId, 'manager');
    // Rogue tries to delegate OTHER's approver duty (subordinate = other, not rogue) → RLS WITH CHECK blocks.
    await expect(
      setReportingLine(rogueCtx, {
        subordinateEmploymentId: other.employmentId,
        managerEmploymentId: stand.employmentId,
        lineType: 'delegate',
        validFrom: '2026-07-01',
        validTo: '2026-07-31',
      }),
    ).rejects.toThrow();
  });

  it('read scoping: HR sees every delegation; a self-service user sees only rows they participate in', async () => {
    const mgrA = await hire('MgrA');
    const standA = await hire('StandA');
    const mgrB = await hire('MgrB');
    const standB = await hire('StandB');
    await setReportingLine(A(b), { subordinateEmploymentId: mgrA.employmentId, managerEmploymentId: standA.employmentId, lineType: 'delegate', validFrom: '2024-01-01', validTo: null });
    await setReportingLine(A(b), { subordinateEmploymentId: mgrB.employmentId, managerEmploymentId: standB.employmentId, lineType: 'delegate', validFrom: '2024-01-01', validTo: null });

    // HR: sees both, with both names resolved.
    const all = await delegationsScoped(A(b), { isAdmin: true, history: false, asOf: '2026-07-10' });
    expect(all).toHaveLength(2);
    expect(all.every((r) => r.delegatorName && r.delegateName)).toBe(true);

    // mgrA (delegator of row 1): sees only row 1 — and the delegate's name resolves.
    const mgrACtx = await userCtx(mgrA.personId, 'manager');
    const mine = await delegationsScoped(mgrACtx, { isAdmin: false, history: false, asOf: '2026-07-10' });
    expect(mine).toHaveLength(1);
    expect(mine[0].delegatorEmploymentId).toBe(mgrA.employmentId);
    expect(mine[0].delegateName).toBe('StandA');

    // standB (delegate of row 2): sees only row 2 — the delegator's name resolves via the definer helper
    // even though a stand-in has no RLS visibility of the delegator's employment.
    const standBCtx = await userCtx(standB.personId, 'employee');
    const asDelegate = await delegationsScoped(standBCtx, { isAdmin: false, history: false, asOf: '2026-07-10' });
    expect(asDelegate).toHaveLength(1);
    expect(asDelegate[0].delegateEmploymentId).toBe(standB.employmentId);
    expect(asDelegate[0].delegatorName).toBe('MgrB');
  });

  it('dispatches delegation.started to the stand-in on create, and delegation.ended on revoke', async () => {
    process.env.NOTIFICATIONS_ENABLED = 'true';
    const mgr = await hire('NMgr');
    const stand = await hire('NStand');
    const { reportingLineId } = await setReportingLine(A(b), {
      subordinateEmploymentId: mgr.employmentId,
      managerEmploymentId: stand.employmentId,
      lineType: 'delegate',
      validFrom: '2026-07-01',
      validTo: '2026-07-31',
    });
    await dispatchNotifications(A(b), {});
    let notes = await notificationsFor(stand.employmentId);
    expect(notes.map((n) => n.kind)).toContain('delegation.started');
    // The delegator (mgr) is NOT notified.
    expect((await notificationsFor(mgr.employmentId)).map((n) => n.kind)).not.toContain('delegation.started');

    await endReportingLine(A(b), { reportingLineId, endDate: '2026-07-15' });
    await dispatchNotifications(A(b), {});
    notes = await notificationsFor(stand.employmentId);
    expect(notes.map((n) => n.kind)).toContain('delegation.ended');
  });
});

// keep `and` referenced for potential future filters without a lint error
void and;
