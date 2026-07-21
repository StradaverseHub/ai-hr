/**
 * ADR-0034 34-2 — notification dispatch + recipient reads. The sweep projects mapped domain events into
 * recipient-scoped notifications; RLS confines reads/mark-read to the recipient (A cannot see B's). Keyset
 * cursor ⇒ idempotent. Gated by NOTIFICATIONS_ENABLED.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import type { SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { requestLeave } from '../core/leave';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import {
  dispatchNotifications,
  listNotifications,
  markNotificationRead,
  unreadNotificationCount,
} from '../core/notifications';

let b: Base;
const uniqEmail = () => `notif_${randomUUID().slice(0, 8)}@t.local`;

async function makeEmployee() {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Notif', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  const userId = await createAppUser(b.tenantId, e.personId, 'employee');
  const ctx: SessionContext = { tenantId: b.tenantId, userId, roles: ['employee'], personId: e.personId };
  return { employmentId: e.employmentId, ctx };
}

const event = (eventType: string, subjectEmploymentId: string, payload: Record<string, unknown>) => ({
  tenantId: b.tenantId,
  aggregateType: 'test',
  aggregateId: randomUUID(),
  eventType,
  actorType: 'system' as const,
  subjectEmploymentId,
  payload,
});

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  process.env.NOTIFICATIONS_ENABLED = 'true';
});
afterEach(() => {
  delete process.env.NOTIFICATIONS_ENABLED;
});

describe('notification dispatch + reads (ADR-0034 34-2)', () => {
  it('projects mapped events to the subject; recipient-only RLS isolates them', async () => {
    const A = await makeEmployee();
    const B = await makeEmployee();
    await owner.db.insert(schema.domainEvent).values([
      event('toil.accrued', A.employmentId, { daysCredited: 1, workedDate: '2026-07-04' }),
      event('leave-request.approved', B.employmentId, { decision: 'approved' }),
      event('employee.hired', A.employmentId, {}), // unmapped ⇒ no notification
    ]);

    const r = await dispatchNotifications(adminCtx(b), {});
    expect(r.created).toBe(2); // only the two mapped events

    // A sees only A's (a TOIL one); B sees only B's (a leave one).
    const aList = await listNotifications(A.ctx, A.employmentId);
    expect(aList).toHaveLength(1);
    expect(aList[0].kind).toBe('toil.accrued');
    expect(aList[0].body).toContain('1 day');
    expect((await listNotifications(B.ctx, B.employmentId))[0].kind).toBe('leave.approved');

    // RLS: A cannot read B's notifications even when asking for B's employment id.
    expect(await listNotifications(A.ctx, B.employmentId)).toHaveLength(0);
  });

  it('a MIXED leave-request.approved (payload.mixed=true) renders the "partially approved" body + /me deep-link', async () => {
    const A = await makeEmployee();
    await owner.db.insert(schema.domainEvent).values([
      // A mixed per-date outcome tags the approved event with mixed: true (see core/leave finalizeLeaveApproval).
      event('leave-request.approved', A.employmentId, { decision: 'approved', mixed: true }),
    ]);
    expect((await dispatchNotifications(adminCtx(b), {})).created).toBe(1);
    const [n] = await listNotifications(A.ctx, A.employmentId);
    expect(n.kind).toBe('leave.approved');
    expect(n.title).toBe('Leave partially approved');
    expect(n.body).toMatch(/partially|breakdown|some dates/i);
    expect(n.linkPath).toBe('/me');
  });

  it('a MIXED approval carrying perDateOutcome lists the approved + rejected dates and the reason (R17 600be8ac)', async () => {
    const A = await makeEmployee();
    await owner.db.insert(schema.domainEvent).values([
      event('leave-request.approved', A.employmentId, {
        decision: 'approved',
        mixed: true,
        perDateOutcome: {
          approved: ['2026-08-01', '2026-08-02'],
          rejected: [{ date: '2026-08-03', reason: 'Business operational requirement on 03-Aug.' }],
        },
      }),
    ]);
    expect((await dispatchNotifications(adminCtx(b), {})).created).toBe(1);
    const [n] = await listNotifications(A.ctx, A.employmentId);
    expect(n.body).toContain('2026-08-01');
    expect(n.body).toContain('2026-08-03');
    expect(n.body).toContain('Business operational requirement on 03-Aug.');
  });

  it('a plain (non-mixed) leave-request.approved keeps the flat "Leave approved" body', async () => {
    const A = await makeEmployee();
    await owner.db.insert(schema.domainEvent).values([event('leave-request.approved', A.employmentId, { decision: 'approved' })]);
    await dispatchNotifications(adminCtx(b), {});
    const [n] = await listNotifications(A.ctx, A.employmentId);
    expect(n.title).toBe('Leave approved');
    expect(n.body).toBe('Your leave request was approved.');
  });

  it('unread count + mark read', async () => {
    const A = await makeEmployee();
    await owner.db.insert(schema.domainEvent).values(event('toil.accrued', A.employmentId, { daysCredited: 2, workedDate: '2026-07-05' }));
    await dispatchNotifications(adminCtx(b), {});
    expect(await unreadNotificationCount(A.ctx, A.employmentId)).toBe(1);
    const [n] = await listNotifications(A.ctx, A.employmentId);
    await markNotificationRead(A.ctx, n.id);
    expect(await unreadNotificationCount(A.ctx, A.employmentId)).toBe(0);
  });

  it('is idempotent — re-dispatch with no new events creates nothing (cursor)', async () => {
    const A = await makeEmployee();
    await owner.db.insert(schema.domainEvent).values(event('toil.lapsed', A.employmentId, { daysCredited: 1 }));
    expect((await dispatchNotifications(adminCtx(b), {})).created).toBe(1);
    expect((await dispatchNotifications(adminCtx(b), {})).created).toBe(0);
    expect(await unreadNotificationCount(A.ctx, A.employmentId)).toBe(1); // not duplicated
  });

  it('is gated — dispatch is a no-op when NOTIFICATIONS_ENABLED is off', async () => {
    const A = await makeEmployee();
    await owner.db.insert(schema.domainEvent).values(event('toil.accrued', A.employmentId, { daysCredited: 1 }));
    delete process.env.NOTIFICATIONS_ENABLED;
    expect(await dispatchNotifications(adminCtx(b), {})).toEqual({ processed: 0, created: 0 });
    expect(await unreadNotificationCount(A.ctx, A.employmentId)).toBe(0);
  });

  // ── 34-2b producers: the remaining approval decisions + the payslip-ready fan-out ──

  it('34-2b: resignation / claim / profile-change decisions notify the subject', async () => {
    const A = await makeEmployee();
    await owner.db.insert(schema.domainEvent).values([
      event('resignation.accepted', A.employmentId, { decision: 'accepted' }),
      event('claim-request.approved', A.employmentId, { taxable: false }),
      event('profile-change.rejected', A.employmentId, { decision: 'rejected' }),
    ]);
    expect((await dispatchNotifications(adminCtx(b), {})).created).toBe(3);
    const kinds = (await listNotifications(A.ctx, A.employmentId)).map((n) => n.kind).sort();
    expect(kinds).toEqual(['claim.approved', 'profile.rejected', 'resignation.accepted']);
  });

  it('34-2b: payroll-batch.closed fans out a payslip-ready notification to every employee in the batch', async () => {
    const A = await makeEmployee();
    const B = await makeEmployee();
    // A minimal closed batch with one payslip each (owner bypasses RLS).
    const [pp] = await owner.db
      .insert(schema.payPeriod)
      .values({ tenantId: b.tenantId, companyId: b.companyId, period: '2026-07' })
      .returning({ id: schema.payPeriod.id });
    const [batch] = await owner.db
      .insert(schema.payrollBatch)
      .values({ tenantId: b.tenantId, companyId: b.companyId, payPeriodId: pp.id, payPeriod: '2026-07', batchDate: '2026-07-25', status: 'closed' })
      .returning({ id: schema.payrollBatch.id });
    const slip = (employmentId: string) => ({
      tenantId: b.tenantId,
      batchId: batch.id,
      employmentId,
      basicSalary: '3000',
      grossPay: '3000',
      statutory: {},
      totalDeductions: '330',
      netPay: '2670',
      employerCost: '3390',
    });
    await owner.db.insert(schema.payslip).values([slip(A.employmentId), slip(B.employmentId)]);
    // The batch-closed event has NO subject — the registry fan-out resolves recipients from its payslips.
    await owner.db.insert(schema.domainEvent).values({
      tenantId: b.tenantId,
      aggregateType: 'payroll-batch',
      aggregateId: batch.id,
      eventType: 'payroll-batch.closed',
      actorType: 'system',
      subjectEmploymentId: null,
      payload: {},
    });

    expect((await dispatchNotifications(adminCtx(b), {})).created).toBe(2); // one per employee in the batch
    expect((await listNotifications(A.ctx, A.employmentId))[0].kind).toBe('payslip.ready');
    expect((await listNotifications(B.ctx, B.employmentId))[0].kind).toBe('payslip.ready');
  });
});

// ── R51 722904dc/71b9143a: leave approval escalation — dispatch-time freshness re-check + fan-out ──
describe('leave-request.escalation-due (R51)', () => {
  /** A pending request with a generated approval chain, for a subject with an administrative manager. */
  async function stuckRequest(levels: string[]) {
    const subject = await makeEmployee();
    const manager = await makeEmployee();
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: subject.employmentId,
      managerEmploymentId: manager.employmentId,
      lineType: 'administrative',
      validFrom: '2024-01-01',
    });
    await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, enabled: true, levels });
    const { leaveRequestId } = await requestLeave(adminCtx(b), {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-03',
      endDate: '2026-08-04',
    });
    return { subject, manager, leaveRequestId };
  }

  /** The event shape the sweep (core/leave-escalation.ts) appends. */
  const escalationEvent = (
    subjectEmploymentId: string,
    leaveRequestId: string,
    targetKind: string | null,
    stepIndex = 0,
  ) =>
    event('leave-request.escalation-due', subjectEmploymentId, {
      groupKey: leaveRequestId,
      leaveRequestId,
      stepIndex,
      currentKind: 'direct_manager',
      nextKind: targetKind,
      targetKind,
      daysWaiting: 3,
      leaveTypeName: 'Annual Leave',
      startDate: '2026-08-03',
      endDate: '2026-08-04',
    });

  const escalationNotifs = () =>
    owner.db
      .select({
        recipient: schema.notification.recipientEmploymentId,
        linkPath: schema.notification.linkPath,
        severity: schema.notification.severity,
        body: schema.notification.body,
      })
      .from(schema.notification)
      .where(and(eq(schema.notification.tenantId, b.tenantId), eq(schema.notification.kind, 'leave.escalation')));

  it('fans out to the resolved target approver and never to the requester', async () => {
    const { subject, manager, leaveRequestId } = await stuckRequest(['hr_admin', 'direct_manager']);
    await owner.db
      .insert(schema.domainEvent)
      .values(escalationEvent(subject.employmentId, leaveRequestId, 'direct_manager'));
    expect((await dispatchNotifications(adminCtx(b), {})).created).toBe(1);
    const rows = await escalationNotifs();
    expect(rows.map((r) => r.recipient)).toEqual([manager.employmentId]);
    expect(rows[0].linkPath).toBe('/approvals');
    expect(rows[0].severity).toBe('action');
    expect(rows[0].body).toContain('working day');
    expect(rows.some((r) => r.recipient === subject.employmentId)).toBe(false);
  });

  it('freshness re-check: a step decided between sweep and dispatch produces NO notification', async () => {
    const { subject, leaveRequestId } = await stuckRequest(['direct_manager', 'hr_admin']);
    await owner.db.insert(schema.domainEvent).values(escalationEvent(subject.employmentId, leaveRequestId, 'hr_admin'));
    // The approver acted in the meantime — the step is no longer pending.
    await owner.db
      .update(schema.leaveApprovalStep)
      .set({ status: 'approved', decidedAt: new Date() })
      .where(and(eq(schema.leaveApprovalStep.leaveRequestId, leaveRequestId), eq(schema.leaveApprovalStep.stepIndex, 0)));
    expect((await dispatchNotifications(adminCtx(b), {})).created).toBe(0);
    expect(await escalationNotifs()).toHaveLength(0);
  });

  it('a target that resolves to nobody (unset department head) falls back to HR admins, never silently vanishing', async () => {
    const { subject, leaveRequestId } = await stuckRequest(['direct_manager', 'hr_admin']);
    // An HR admin WITH an employment in the company (the seed admin user has none).
    const hrEmp = await hireEmployee(adminCtx(b), {
      person: { fullName: 'HR Admin', primaryEmail: uniqEmail() },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await createAppUser(b.tenantId, hrEmp.personId, 'hr_admin');
    // deptA has no head_employment_id ⇒ the department_head branch resolves to [] ⇒ HR fallback.
    await owner.db
      .insert(schema.domainEvent)
      .values(escalationEvent(subject.employmentId, leaveRequestId, 'department_head'));
    expect((await dispatchNotifications(adminCtx(b), {})).created).toBe(1);
    expect((await escalationNotifs()).map((r) => r.recipient)).toEqual([hrEmp.employmentId]);
  });
});
