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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, and, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
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
import {
  adminCtx,
  closeAll,
  createAppUser,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

let b: Base;
const A = (base: Base) => adminCtx(base);
const uniq = () => `${randomUUID().slice(0, 8)}@t.local`;

async function hire(name: string, departmentId?: string) {
  return hireEmployee(A(b), {
    person: { fullName: name, primaryEmail: uniq() },
    companyId: b.companyId,
    departmentId: departmentId ?? b.deptA,
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
// ADR-0077 slice 3: `notifications` is a per-tenant module row now, so there is no process-wide flag left
// to clean up here — the former `afterEach` delete of NOTIFICATIONS_ENABLED is gone. resetDb() truncates
// tenant_module between tests, and the one test that needs the module grants it explicitly with
// setModule(); every other test in this file is indifferent to it (nothing else calls into dispatch).

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
    // R51 same-level rule: the stand-in must hold the delegator's approval level (manager ⇒ a downline).
    const standSub = await hire('StandSub');
    await adminLine(standSub.employmentId, stand.employmentId);
    // Multi-step chain so the stand-in clears the direct_manager step (advances, no ledger debit).
    await setLeaveApprovalPolicy(A(b), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
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
    // Same level as `other` (manager), so RLS — not the R51 level guard — is what rejects below.
    const standSub3 = await hire('StandSub3');
    await adminLine(standSub3.employmentId, stand.employmentId);
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
    // Grant the `notifications` module to THIS tenant (ADR-0077 slice 3 — dispatchNotifications is gated
    // on isModuleEnabled(ctx, 'notifications'), not on NOTIFICATIONS_ENABLED). The dispatch calls must run
    // under a context resolved AFTER the grant: adminCtx carries a synthetic snapshot derived from
    // legacyEnabledModulesIn(process.env), which would report the module on or off depending on whether the
    // ambient NOTIFICATIONS_ENABLED happens to be set, so the row — not the env — is what opens the gate here.
    await setModule(b.tenantId, 'notifications', 'active');
    const notifyCtx = await entitledCtx(b);
    const mgr = await hire('NMgr');
    const stand = await hire('NStand');
    const { reportingLineId } = await setReportingLine(A(b), {
      subordinateEmploymentId: mgr.employmentId,
      managerEmploymentId: stand.employmentId,
      lineType: 'delegate',
      validFrom: '2026-07-01',
      validTo: '2026-07-31',
    });
    await dispatchNotifications(notifyCtx, {});
    let notes = await notificationsFor(stand.employmentId);
    expect(notes.map((n) => n.kind)).toContain('delegation.started');
    // The delegator (mgr) is NOT notified.
    expect((await notificationsFor(mgr.employmentId)).map((n) => n.kind)).not.toContain('delegation.started');

    await endReportingLine(A(b), { reportingLineId, endDate: '2026-07-15' });
    await dispatchNotifications(notifyCtx, {});
    notes = await notificationsFor(stand.employmentId);
    expect(notes.map((n) => n.kind)).toContain('delegation.ended');
  });
});

describe('Global Delegation (Phase 2 — module/task scope)', () => {
  // Run the scope-aware decision helper under the DELEGATE's own RLS context (as assertCanDecide does).
  async function canDecide(ctx: SessionContext, subject: string, module: string, task: string): Promise<boolean> {
    return withTenant(ctx, async (tx) => {
      const res = await tx.execute(
        sql`SELECT app.can_decide_via_delegation(${subject}, ${module}, ${task}) AS ok`,
      );
      return (res as unknown as { ok: boolean }[])[0]?.ok ?? false;
    });
  }

  it('an UNSCOPED delegation authorizes every module/task (back-compat)', async () => {
    const mgr = await hire('UMgr');
    const sub = await hire('USub');
    await adminLine(sub.employmentId, mgr.employmentId);
    const stand = await hire('UStand');
    // R51 same-level rule: match the delegator's manager level.
    const UStandSub = await hire('UStandSub');
    await adminLine(UStandSub.employmentId, stand.employmentId);
    await setReportingLine(A(b), {
      subordinateEmploymentId: mgr.employmentId,
      managerEmploymentId: stand.employmentId,
      lineType: 'delegate',
      validFrom: '2024-01-01',
      validTo: null,
    });
    const standCtx = await userCtx(stand.personId, 'manager');
    expect(await canDecide(standCtx, sub.employmentId, 'leave', 'leave.application')).toBe(true);
    expect(await canDecide(standCtx, sub.employmentId, 'attendance', 'attendance.correction')).toBe(true);
    expect(await canDecide(standCtx, sub.employmentId, 'claims', 'claims.claim')).toBe(true);
  });

  it('a LEAVE-scoped delegation authorizes leave but NOT attendance/claims', async () => {
    const mgr = await hire('LSMgr');
    const sub = await hire('LSSub');
    await adminLine(sub.employmentId, mgr.employmentId);
    const stand = await hire('LSStand');
    // R51 same-level rule: match the delegator's manager level.
    const LSStandSub = await hire('LSStandSub');
    await adminLine(LSStandSub.employmentId, stand.employmentId);
    await setReportingLine(A(b), {
      subordinateEmploymentId: mgr.employmentId,
      managerEmploymentId: stand.employmentId,
      lineType: 'delegate',
      validFrom: '2024-01-01',
      validTo: null,
      reason: 'Covering leave only',
      scopes: [{ module: 'leave', taskType: null }], // whole leave module
    });
    const standCtx = await userCtx(stand.personId, 'manager');
    expect(await canDecide(standCtx, sub.employmentId, 'leave', 'leave.application')).toBe(true);
    expect(await canDecide(standCtx, sub.employmentId, 'leave', 'leave.cancellation')).toBe(true);
    expect(await canDecide(standCtx, sub.employmentId, 'attendance', 'attendance.correction')).toBe(false);
    expect(await canDecide(standCtx, sub.employmentId, 'claims', 'claims.claim')).toBe(false);
  });

  it('a TASK-scoped delegation (leave.application only) does not authorize leave.cancellation', async () => {
    const mgr = await hire('TSMgr');
    const sub = await hire('TSSub');
    await adminLine(sub.employmentId, mgr.employmentId);
    const stand = await hire('TSStand');
    // R51 same-level rule: match the delegator's manager level.
    const TSStandSub = await hire('TSStandSub');
    await adminLine(TSStandSub.employmentId, stand.employmentId);
    await setReportingLine(A(b), {
      subordinateEmploymentId: mgr.employmentId,
      managerEmploymentId: stand.employmentId,
      lineType: 'delegate',
      validFrom: '2024-01-01',
      validTo: null,
      reason: 'Applications only',
      scopes: [{ module: 'leave', taskType: 'leave.application' }],
    });
    const standCtx = await userCtx(stand.personId, 'manager');
    expect(await canDecide(standCtx, sub.employmentId, 'leave', 'leave.application')).toBe(true);
    expect(await canDecide(standCtx, sub.employmentId, 'leave', 'leave.cancellation')).toBe(false);
  });

  it('a LEAVE-scoped delegate can decide a leave request end-to-end; scope rows + reason persist', async () => {
    const mgr = await hire('E2EMgr');
    const sub = await hire('E2ESub');
    await adminLine(sub.employmentId, mgr.employmentId);
    const stand = await hire('E2EStand');
    // R51 same-level rule: match the delegator's manager level.
    const E2EStandSub = await hire('E2EStandSub');
    await adminLine(E2EStandSub.employmentId, stand.employmentId);
    await setLeaveApprovalPolicy(A(b), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    const { leaveRequestId } = await requestLeave(A(b), {
      employmentId: sub.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
    });
    const { reportingLineId } = await setReportingLine(A(b), {
      subordinateEmploymentId: mgr.employmentId,
      managerEmploymentId: stand.employmentId,
      lineType: 'delegate',
      validFrom: '2024-01-01',
      validTo: null,
      reason: 'Away on holiday',
      scopes: [{ module: 'leave', taskType: null }],
    });
    // Persisted: reason on the edge + one scope row.
    const [edge] = await owner.db
      .select({ reason: schema.reportingLine.reason })
      .from(schema.reportingLine)
      .where(eq(schema.reportingLine.id, reportingLineId));
    expect(edge.reason).toBe('Away on holiday');
    const scopeRows = await owner.db
      .select({ module: schema.reportingLineScope.module, taskType: schema.reportingLineScope.taskType })
      .from(schema.reportingLineScope)
      .where(eq(schema.reportingLineScope.reportingLineId, reportingLineId));
    expect(scopeRows).toEqual([{ module: 'leave', taskType: null }]);
    // Honoured end-to-end: the stand-in clears the direct_manager step within leave scope.
    const standCtx = await userCtx(stand.personId, 'manager');
    const res = await decideLeave(standCtx, { leaveRequestId, decision: 'approved' });
    expect(res.status).toBe('pending');
    expect((res as { advancedTo?: string }).advancedTo).toBe('hr_admin');
  });
});

describe('R51 (20f09fc3) — request-side leaf task types grant zero approval authority', () => {
  async function canDecide(ctx: SessionContext, subject: string, module: string, task: string): Promise<boolean> {
    return withTenant(ctx, async (tx) => {
      const res = await tx.execute(
        sql`SELECT app.can_decide_via_delegation(${subject}, ${module}, ${task}) AS ok`,
      );
      return (res as unknown as { ok: boolean }[])[0]?.ok ?? false;
    });
  }

  async function requestSideSetup(scopes: { module: string; taskType: string | null }[]) {
    const mgr = await hire('RQMgr');
    const sub = await hire('RQSub');
    await adminLine(sub.employmentId, mgr.employmentId);
    // The stand-in + their report live in deptB: same approval level as mgr (R51 rule) WITHOUT the derived
    // department-head visibility of deptA — so the visibility pin below exercises ONLY the delegation route.
    const stand = await hire('RQStand', b.deptB);
    const standSub = await hire('RQStandSub', b.deptB);
    await adminLine(standSub.employmentId, stand.employmentId); // same-level rule
    await setReportingLine(A(b), {
      subordinateEmploymentId: mgr.employmentId,
      managerEmploymentId: stand.employmentId,
      lineType: 'delegate',
      validFrom: '2024-01-01',
      validTo: null,
      reason: 'Request-side duties only',
      scopes,
    });
    return { mgr, sub, stand };
  }

  it('an edge scoped only to leave.request.creation is rejected for BOTH approval tasks and by decideLeave', async () => {
    const { sub, stand } = await requestSideSetup([{ module: 'leave', taskType: 'leave.request.creation' }]);
    const standCtx = await userCtx(stand.personId, 'manager');
    expect(await canDecide(standCtx, sub.employmentId, 'leave', 'leave.application')).toBe(false);
    expect(await canDecide(standCtx, sub.employmentId, 'leave', 'leave.cancellation')).toBe(false);
    const { leaveRequestId } = await requestLeave(A(b), {
      employmentId: sub.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
    });
    await expect(decideLeave(standCtx, { leaveRequestId, decision: 'approved' })).rejects.toThrow();
  });

  it('leave.cancellation_request.creation does NOT authorize leave.cancellation (exact match on prefix-adjacent ids)', async () => {
    const { sub, stand } = await requestSideSetup([
      { module: 'leave', taskType: 'leave.cancellation_request.creation' },
    ]);
    const standCtx = await userCtx(stand.personId, 'manager');
    expect(await canDecide(standCtx, sub.employmentId, 'leave', 'leave.cancellation')).toBe(false);
    expect(await canDecide(standCtx, sub.employmentId, 'leave', 'leave.cancellation_request.creation')).toBe(true);
  });

  it('a request-only delegate still SEES the delegator\'s downline pending leave row (disclosed visibility behaviour)', async () => {
    const { sub, stand } = await requestSideSetup([{ module: 'leave', taskType: 'leave.request.creation' }]);
    const { leaveRequestId } = await requestLeave(A(b), {
      employmentId: sub.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-07-01',
      endDate: '2026-07-01',
    });
    // Row-level visibility flows through the scope-blind 1-arg app.can_decide_via_delegation (0109) — the
    // delegate can READ the routed request even though every decide button refuses. Pinned so a future
    // "hide what cannot be acted on" change is deliberate, not accidental.
    const standCtx = await userCtx(stand.personId, 'manager');
    const visible = await withTenant(standCtx, (tx) =>
      tx
        .select({ id: schema.leaveRequest.id })
        .from(schema.leaveRequest)
        .where(eq(schema.leaveRequest.id, leaveRequestId)),
    );
    expect(visible).toHaveLength(1);
  });
});

// keep `and` referenced for potential future filters without a lint error
void and;
