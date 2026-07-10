/**
 * Edit / cancel own leave by status (item c9a19e34).
 *
 * Employee self-service on their OWN leave, status-gated (Option A):
 *   • PENDING  → editLeaveRequest (modify details, stays pending) + cancelOwnLeave (immediate self-withdraw).
 *   • APPROVED → cancelOwnLeave is REFUSED (routed to the manager-approved give-back requestLeaveCancellation).
 *   • REJECTED → view-only (both writes refused).
 * Auth is subject-only (enforced in code, not RLS). Pending leave has no ledger debit, so an edit / withdraw
 * moves no balance. Every write appends a distinct DomainEvent (leave-request.edited / .self-cancelled).
 *
 * Future dates (Aug 2026) so no backdating/advance-notice gate interferes. 2026-08-10..12 = Mon–Wed (3 wd).
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import {
  cancelOwnLeave,
  decideLeave,
  editLeaveRequest,
  requestLeave,
  requestLeaveCancellation,
  LeaveCancellationNotAllowedError,
  LeaveEditNotAllowedError,
} from '../core/leave';
import { dispatchNotifications } from '../core/notifications';
import { leaveRequestsFor } from '../core/read';
import type { SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  eventTypesFor,
  latestEventPayload,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;
let subject: { personId: string; employmentId: string };
let subjectCtx: SessionContext;
let other: { personId: string; employmentId: string };
let otherCtx: SessionContext;

const hire = (name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `ecs_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

async function grantAnnual(employmentId: string, days: string) {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    entryType: 'accrual',
    days,
    effectiveOn: '2026-01-01',
  });
}

async function pendingThreeDay(ctx = subjectCtx, employmentId = subject.employmentId) {
  const res = await requestLeave(ctx, {
    employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    startDate: '2026-08-10',
    endDate: '2026-08-12',
  });
  return res.leaveRequestId;
}

async function rowOf(id: string) {
  const [r] = await owner.db
    .select({ status: schema.leaveRequest.status, days: schema.leaveRequest.days, start: schema.leaveRequest.startDate, end: schema.leaveRequest.endDate, reason: schema.leaveRequest.reason })
    .from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.id, id));
  return r;
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  subject = await hire('Subject');
  const u = await createAppUser(b.tenantId, subject.personId, 'employee');
  subjectCtx = { tenantId: b.tenantId, userId: u, personId: subject.personId, roles: ['employee'] };
  other = await hire('Other');
  const uO = await createAppUser(b.tenantId, other.personId, 'manager');
  // Make `other` the subject's manager so RLS lets them SEE the subject's leave — the subject-only rule must
  // still block them in code (RLS being symmetric is the whole reason the check lives in the service).
  await setReportingLine(adminCtx(b), {
    subordinateEmploymentId: subject.employmentId,
    managerEmploymentId: other.employmentId,
    lineType: 'administrative',
    validFrom: '2024-01-01',
  });
  otherCtx = { tenantId: b.tenantId, userId: uO, personId: other.personId, roles: ['manager'] };
  await grantAnnual(subject.employmentId, '20.00');
});
afterAll(async () => {
  await closeAll();
});

describe('editLeaveRequest — pending edit', () => {
  it('edits a pending leave in place, keeps it pending, recomputes days, appends leave-request.edited', async () => {
    const id = await pendingThreeDay();
    expect((await rowOf(id)).days).toBe('3.00');
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(20); // no debit on submit

    const out = await editLeaveRequest(subjectCtx, {
      leaveRequestId: id,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-11', // 2 working days now
      reason: 'shorter trip',
    });
    expect(out.days).toBe(2);

    const r = await rowOf(id);
    expect(r.status).toBe('pending'); // stays pending
    expect(r.days).toBe('2.00');
    expect(r.end).toBe('2026-08-11');
    expect(r.reason).toBe('shorter trip');
    // ledger untouched (pending never debits)
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(20);

    expect(await eventTypesFor(b.tenantId, id)).toContain('leave-request.edited');
    const payload = (await latestEventPayload(b.tenantId, id, 'leave-request.edited')) as any;
    expect(payload?.before?.endDate).toBe('2026-08-12');
    expect(payload?.after?.endDate).toBe('2026-08-11');
    expect(payload?.diff?.endDate?.after).toBe('2026-08-11');
  });

  it('refuses to edit an APPROVED leave (only pending is editable)', async () => {
    const id = await pendingThreeDay();
    await decideLeave(adminCtx(b), { leaveRequestId: id, decision: 'approved' });
    await expect(
      editLeaveRequest(subjectCtx, {
        leaveRequestId: id,
        leaveTypeId: b.annualLeaveTypeId,
        startDate: '2026-08-10',
        endDate: '2026-08-11',
      }),
    ).rejects.toBeInstanceOf(LeaveEditNotAllowedError);
    expect((await rowOf(id)).status).toBe('approved');
  });

  it('subject-only: a manager who can SEE the leave still cannot edit it', async () => {
    const id = await pendingThreeDay();
    await expect(
      editLeaveRequest(otherCtx, {
        leaveRequestId: id,
        leaveTypeId: b.annualLeaveTypeId,
        startDate: '2026-08-10',
        endDate: '2026-08-11',
      }),
    ).rejects.toBeInstanceOf(LeaveEditNotAllowedError);
    expect((await rowOf(id)).days).toBe('3.00'); // unchanged
  });
});

describe('cancelOwnLeave — pending withdraw', () => {
  it('withdraws a pending leave (→ cancelled), no ledger movement, appends leave-request.self-cancelled', async () => {
    const id = await pendingThreeDay();
    const out = await cancelOwnLeave(subjectCtx, { leaveRequestId: id });
    expect(out.previousStatus).toBe('pending');
    expect(out.restoredDays).toBe(0);
    expect((await rowOf(id)).status).toBe('cancelled');
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(20);

    expect(await eventTypesFor(b.tenantId, id)).toContain('leave-request.self-cancelled');
    const payload = (await latestEventPayload(b.tenantId, id, 'leave-request.self-cancelled')) as any;
    expect(payload?.previousStatus).toBe('pending');
    expect(payload?.newStatus).toBe('cancelled');
    // Audit shows the employee themselves as actor.
    const [ev] = await owner.db
      .select({ actorId: schema.domainEvent.actorId })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.aggregateId, id));
    // (multiple events on the aggregate; assert the self-cancelled one carries the subject user)
    const [sc] = await owner.db
      .select({ actorId: schema.domainEvent.actorId, subj: schema.domainEvent.subjectEmploymentId })
      .from(schema.domainEvent)
      .where(eq(schema.domainEvent.eventType, 'leave-request.self-cancelled'));
    expect(sc.actorId).toBe(subjectCtx.userId);
    expect(sc.subj).toBe(subject.employmentId);
    void ev;
  });

  it('refuses to self-cancel an APPROVED leave (routed to the give-back flow instead)', async () => {
    const id = await pendingThreeDay();
    await decideLeave(adminCtx(b), { leaveRequestId: id, decision: 'approved' });
    await expect(cancelOwnLeave(subjectCtx, { leaveRequestId: id })).rejects.toBeInstanceOf(
      LeaveCancellationNotAllowedError,
    );
    expect((await rowOf(id)).status).toBe('approved');

    // The give-back path (manager-approved) is still open for the approved leave — subject can request it.
    const gb = await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: ['2026-08-11'] });
    expect(gb.cancellationRequestId).toBeTruthy();
  });

  it('subject-only: a manager who can SEE the leave cannot self-cancel it', async () => {
    const id = await pendingThreeDay();
    await expect(cancelOwnLeave(otherCtx, { leaveRequestId: id })).rejects.toBeInstanceOf(
      LeaveCancellationNotAllowedError,
    );
    expect((await rowOf(id)).status).toBe('pending');
  });
});

describe('cancelOwnLeave — notification (req 4.v: notify the approver and HR)', () => {
  it('fans out one leave.self-cancelled notice to the manager; the withdrawing employee holds none', async () => {
    const prev = process.env.NOTIFICATIONS_ENABLED;
    process.env.NOTIFICATIONS_ENABLED = 'true';
    try {
      const id = await pendingThreeDay();
      await cancelOwnLeave(subjectCtx, { leaveRequestId: id });
      await dispatchNotifications(adminCtx(b));

      const notes = await owner.db
        .select({ recipient: schema.notification.recipientEmploymentId })
        .from(schema.notification)
        .where(eq(schema.notification.kind, 'leave.self-cancelled'));
      const recipients = notes.map((n) => n.recipient);
      expect(recipients).toContain(other.employmentId); // the approver (subject's manager)
      expect(recipients).not.toContain(subject.employmentId); // never the person who withdrew
    } finally {
      process.env.NOTIFICATIONS_ENABLED = prev;
    }
  });
});

describe('leaveRequestsFor — read surfaces the fields the ESS actions need', () => {
  it('returns leaveTypeId + reason so the Edit dialog can prefill', async () => {
    const id = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
      reason: 'family',
    });
    const rows = await leaveRequestsFor(subjectCtx, subject.employmentId);
    const row = rows.find((r) => r.id === id.leaveRequestId)!;
    expect(row.leaveTypeId).toBe(b.annualLeaveTypeId);
    expect(row.reason).toBe('family');
    expect(row.status).toBe('pending');
  });
});
