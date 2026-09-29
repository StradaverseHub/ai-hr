/**
 * 3-tab notification bell (feedback 1514d366) — the data layer behind the tabs:
 *  • listPendingTasks turns the approvals inbox into individual Task items with deep-links (leave →
 *    /approvals#approvals-leave, cancellations → their section, the rest → /approvals), newest first,
 *    keeping the existing self-exclusions (your own request is never your own task);
 *  • pendingApprovalsCount stays exactly the list's length (dashboard-card parity);
 *  • the notification read filters that split the tabs — Notification = unread non-action,
 *    Task = unread severity-'action', History = read only (and never in the unread counts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base, harnessSnapshot } from './harness';
import type { SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { requestLeave } from '../core/leave';
import { listPendingTasks, pendingApprovalsCount } from '../core/approvals-inbox';
import { listNotifications, markNotificationRead, unreadNotificationCount } from '../core/notifications';

let b: Base;
const uniqEmail = () => `tabs_${randomUUID().slice(0, 8)}@t.local`;

async function hire(name: string) {
  return hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
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

describe('listPendingTasks (Task tab)', () => {
  it("a manager gets a subordinate's pending leave as a deep-linked task; count = list length", async () => {
    const E = await hire('Task Emp');
    const M = await hire('Task Mgr');
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: E.employmentId,
      managerEmploymentId: M.employmentId,
      lineType: 'administrative',
      validFrom: '2024-01-01',
    });
    const uM = await createAppUser(b.tenantId, M.personId, 'manager');
    // r292 — a REAL snapshot on this hand-built context. listPendingTasks fans out into the Claims and
    // Attendance queues, both service-gated now (core/module-gate.ts), and a context with neither a
    // snapshot nor an exemption marker is the state EntitlementsUnresolvedError exists to flag. Taken
    // from adminCtx, so it says exactly what a freshly seeded tenant holds — not a hand-written guess.
    const mgrCtx: SessionContext = { tenantId: b.tenantId, userId: uM, personId: M.personId, roles: ['manager'], entitlements: adminCtx(b).entitlements };
    await requestLeave(adminCtx(b), {
      employmentId: E.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-03',
      endDate: '2026-08-04',
    });

    const tasks = await listPendingTasks(mgrCtx, undefined, { attendance: true, claims: true });
    const leaveTasks = tasks.filter((t) => t.kind === 'leave');
    expect(leaveTasks).toHaveLength(1);
    expect(leaveTasks[0].subjectName).toBe('Task Emp');
    expect(leaveTasks[0].linkPath).toBe('/approvals#approvals-leave');
    expect(Number.isNaN(Date.parse(leaveTasks[0].createdAt))).toBe(false); // serializable ISO timestamp

    // Count parity — the legacy badge figure is exactly the task list's length.
    expect(await pendingApprovalsCount(mgrCtx, undefined, { attendance: true, claims: true })).toBe(tasks.length);
  });

  /**
   * ⚠️ b833a077 (r362) — RE-POINTED, NOT DELETED. This was
   *   it('self-exclusion: your own pending travel request is a task for others, never for you')
   * and it built a pending `travel_request` for the viewer, then asserted
   *   expect(own.some((t) => t.kind === 'travel')).toBe(false);
   * with an admin seeing the same row as a task. My Travel was removed completely, so `travel` is no
   * longer a PendingTaskKind and that fixture cannot be built through any product path.
   *
   * It was the ONLY test covering the bell's self-exclusion rule, so deleting it would have dropped that
   * coverage silently. Leave CANCELLATION self-excludes by exactly the same mechanism — the requester's
   * own pending item is never their own task — so the case is re-pointed at it and the rule stays pinned.
   */
  it('self-exclusion: your own pending leave cancellation is a task for others, never for you', async () => {
    const M = await hire('Self Mgr');
    const uM = await createAppUser(b.tenantId, M.personId, 'manager');
    const mgrCtx: SessionContext = { tenantId: b.tenantId, userId: uM, personId: M.personId, roles: ['manager'], entitlements: adminCtx(b).entitlements };
    // An approved leave request of the viewer's own, then a pending cancellation of it.
    const lr = await requestLeave(adminCtx(b), {
      employmentId: M.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-09-01',
      endDate: '2026-09-02',
    });
    await owner.db
      .update(schema.leaveRequest)
      .set({ status: 'approved' })
      .where(eq(schema.leaveRequest.id, lr.leaveRequestId));
    const [cancellation] = await owner.db
      .insert(schema.leaveCancellationRequest)
      .values({
        tenantId: b.tenantId,
        leaveRequestId: lr.leaveRequestId,
        employmentId: M.employmentId,
        cancelDates: ['2026-09-01'],
        requestedDays: '1.00',
        reason: 'Plans changed',
        status: 'pending',
      })
      .returning({ id: schema.leaveCancellationRequest.id });

    // The requester never sees their own item in their Task tab…
    const own = await listPendingTasks(mgrCtx, undefined, { attendance: true, claims: true });
    expect(own.some((t) => t.id === cancellation.id)).toBe(false);
    // …but an admin (a different person) does, linked to the approvals page.
    const adminTasks = await listPendingTasks(adminCtx(b), undefined, { attendance: true, claims: true });
    const task = adminTasks.find((t) => t.kind === 'leaveCancellation' && t.id === cancellation.id);
    expect(task).toBeDefined();
    expect(task!.linkPath).toBe('/approvals#approvals-leave-cancellation');
    expect(task!.subjectName).toBe('Self Mgr');
  });

  it('a plain employee (no roles, no assigned reviews) has an empty task list and a zero count', async () => {
    const E = await hire('Plain Emp');
    const uE = await createAppUser(b.tenantId, E.personId, 'employee');
    const empCtx: SessionContext = { tenantId: b.tenantId, userId: uE, personId: E.personId, roles: ['employee'], entitlements: adminCtx(b).entitlements };
    expect(await listPendingTasks(empCtx, undefined, { attendance: true, claims: true })).toEqual([]);
    expect(await pendingApprovalsCount(empCtx, undefined, { attendance: true, claims: true })).toBe(0);
  });
});

describe('notification read filters (Notification / Task / History split)', () => {
  async function recipient() {
    const E = await hire('Notif Recipient');
    const uE = await createAppUser(b.tenantId, E.personId, 'employee');
    const ctx: SessionContext = { tenantId: b.tenantId, userId: uE, personId: E.personId, roles: ['employee'], entitlements: harnessSnapshot(b.tenantId) };
    return { employmentId: E.employmentId, ctx };
  }
  const notif = (recipientEmploymentId: string, severity: 'info' | 'action' | 'warning', title: string) => ({
    tenantId: b.tenantId,
    recipientEmploymentId,
    kind: `test.${severity}`,
    title,
    body: 'body',
    linkPath: '/me',
    severity,
  });

  it('splits unread action vs non-action; a read item moves to the History read and out of every unread count', async () => {
    const A = await recipient();
    await owner.db.insert(schema.notification).values([
      notif(A.employmentId, 'info', 'Info one'),
      notif(A.employmentId, 'warning', 'Warn one'),
      notif(A.employmentId, 'action', 'Do something'),
    ]);

    // Badge split: 2 informational (info + warning), 1 task notice.
    expect(await unreadNotificationCount(A.ctx, undefined, { action: false })).toBe(2);
    expect(await unreadNotificationCount(A.ctx, undefined, { action: true })).toBe(1);
    expect(await unreadNotificationCount(A.ctx)).toBe(3); // unfiltered = pre-existing behaviour

    // Notification tab: unread, non-action only.
    const notifTab = await listNotifications(A.ctx, undefined, { read: false, action: false });
    expect(notifTab.map((n) => n.title).sort()).toEqual(['Info one', 'Warn one']);
    // Task tab (notice half): unread action only.
    const taskTab = await listNotifications(A.ctx, undefined, { read: false, action: true });
    expect(taskTab.map((n) => n.title)).toEqual(['Do something']);
    // History tab: nothing read yet.
    expect(await listNotifications(A.ctx, undefined, { read: true })).toHaveLength(0);

    // Completing the task notice (mark read) moves it to History and off the Task badge…
    await markNotificationRead(A.ctx, taskTab[0].id);
    expect(await unreadNotificationCount(A.ctx, undefined, { action: true })).toBe(0);
    expect((await listNotifications(A.ctx, undefined, { read: false, action: true }))).toHaveLength(0);
    const history = await listNotifications(A.ctx, undefined, { read: true });
    expect(history.map((n) => n.title)).toEqual(['Do something']);
    // …without touching the Notification-tab unread count (History never affects it).
    expect(await unreadNotificationCount(A.ctx, undefined, { action: false })).toBe(2);
  });

  it('RLS: the filtered reads stay scoped to the recipient', async () => {
    const A = await recipient();
    const B = await recipient();
    await owner.db.insert(schema.notification).values([notif(B.employmentId, 'action', 'B task')]);
    expect(await listNotifications(A.ctx, undefined, { read: false, action: true })).toHaveLength(0);
    expect(await unreadNotificationCount(A.ctx, undefined, { action: true })).toBe(0);
    expect(await unreadNotificationCount(B.ctx, undefined, { action: true })).toBe(1);
  });
});
