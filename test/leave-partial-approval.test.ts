/**
 * Partial Leave Approval (0131) — a manager approves SOME dates and rejects OTHERS within one multi-day
 * leave request, and rejecting any date requires a reason.
 *
 * Design (reuses the Emergency-Leave parentGroupId decomposition, NOT a new decision-time split): when a
 * leave type sets per_date_approval, a multi-day FULL-DAY WORKING-DAYS request is split at submission into one
 * full-day child per working date, sharing one parent_group_id. Each child is an independent `pending` request
 * the manager decides via the existing decideLeave path — so balance/calendar/notifications/audit reuse the
 * unchanged code, and only the approved dates debit the balance.
 *
 * Covers (per the approved plan):
 *  1. submission splits a 3-day request into 3 full-day children sharing one parentGroupId; sum(days)===3.00.
 *  2. approve 2 + reject 1 → ledger debit is exactly 2 days; the rejected child carries no debit and its
 *     rejected event payload contains the reason.
 *  3. rejecting any child with a blank reason throws MissingRejectReasonError and writes nothing.
 *  4. per-date events: 2 approved + 1 rejected on the child aggregates; each fans out exactly one notification.
 *  5. self-approval ban + non-manager rejection still enforced on each child.
 *  6. calendar-counted / half / hourly / single-day / flag-off requests are NOT split.
 *  7. balance-short: approving all 3 with only 2 days' balance → the 3rd throws InsufficientLeaveBalanceError
 *     independently; the first 2 stay approved+debited (each is its own committed transaction).
 *  8. payroll-signal: a sendToPayroll unpaid-equivalent type, split + one child approved → exactly one
 *     payrollImpact per APPROVED child, none for rejected children.
 *  9. RLS: a non-manager, non-admin viewer cannot see / decide another employee's child requests.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { type SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import {
  decideLeave,
  requestLeave,
  InsufficientLeaveBalanceError,
  MissingRejectReasonError,
} from '../core/leave';
import { dispatchNotifications } from '../core/notifications';
import {
  adminCtx,
  closeAll,
  createAppUser,
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
let manager: { personId: string; employmentId: string };
let mgrCtx: SessionContext;

const hire = (name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `pla_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

/** The split children for a request, ordered by date. */
async function childRows(parentGroupId: string) {
  return owner.db
    .select({
      id: schema.leaveRequest.id,
      startDate: schema.leaveRequest.startDate,
      endDate: schema.leaveRequest.endDate,
      days: schema.leaveRequest.days,
      status: schema.leaveRequest.status,
      parentGroupId: schema.leaveRequest.parentGroupId,
      leaveTypeId: schema.leaveRequest.leaveTypeId,
    })
    .from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.parentGroupId, parentGroupId))
    .orderBy(schema.leaveRequest.startDate);
}

async function debitRows(leaveRequestId: string) {
  return owner.db
    .select({ days: schema.leaveLedger.days })
    .from(schema.leaveLedger)
    .where(eq(schema.leaveLedger.sourceRequestId, leaveRequestId));
}

async function grant(leaveTypeId: string, days: string) {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId: subject.employmentId,
    leaveTypeId,
    entryType: 'accrual',
    days,
    effectiveOn: '2026-01-01',
  });
}

/** seedBase's ANNUAL type, set to working_days + per_date_approval for the split path. */
async function enableSplit(leaveTypeId: string) {
  await owner.db
    .update(schema.leaveType)
    .set({ counting: 'working_days', perDateApproval: true })
    .where(eq(schema.leaveType.id, leaveTypeId));
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  subject = await hire('Subject');
  manager = await hire('Manager');
  const uM = await createAppUser(b.tenantId, manager.personId, 'manager');
  await setReportingLine(adminCtx(b), {
    subordinateEmploymentId: subject.employmentId,
    managerEmploymentId: manager.employmentId,
    lineType: 'administrative',
    validFrom: '2024-01-01',
  });
  mgrCtx = { tenantId: b.tenantId, userId: uM, personId: manager.personId, roles: ['manager'] };
  await enableSplit(b.annualLeaveTypeId);
});
afterAll(async () => {
  await closeAll();
});

const requestSpan = (start: string, end: string) =>
  requestLeave(adminCtx(b), {
    employmentId: subject.employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    startDate: start,
    endDate: end,
  });

describe('Partial Leave Approval (0131) — submission-time per-date split', () => {
  it('splits a 3-day working-days request into 3 full-day children sharing one parentGroupId; sum(days)===3.00', async () => {
    const res = await requestSpan('2026-08-10', '2026-08-12'); // Mon..Wed, all working days
    expect(res.parentGroupId).toBeTruthy();
    const rows = await childRows(res.parentGroupId!);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.startDate)).toEqual(['2026-08-10', '2026-08-11', '2026-08-12']);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(rows.every((r) => r.startDate === r.endDate)).toBe(true);
    expect(new Set(rows.map((r) => r.parentGroupId)).size).toBe(1);
    // Guards the fractional-drift edge: each child is one whole working day → exactly 3.00 across the span.
    const sum = rows.reduce((s, r) => s + Number(r.days), 0);
    expect(sum).toBe(3);
    expect(rows.every((r) => Number(r.days) === 1)).toBe(true);
  });

  it('approve 2 dates + reject 1 (with reason) → ledger debit is exactly 2 days; rejected child has no debit and its event carries the reason', async () => {
    await grant(b.annualLeaveTypeId, '20.00');
    const res = await requestSpan('2026-08-10', '2026-08-12');
    const rows = await childRows(res.parentGroupId!);
    const [d10, d11, d12] = rows;

    await decideLeave(mgrCtx, { leaveRequestId: d10.id, decision: 'approved' });
    await decideLeave(mgrCtx, { leaveRequestId: d11.id, decision: 'approved' });
    await decideLeave(mgrCtx, {
      leaveRequestId: d12.id,
      decision: 'rejected',
      rejectReason: 'Coverage needed on the 12th',
    });

    // Balance reflects ONLY the approved dates: 20 granted − 2 debited = 18.
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(18);
    // The rejected child carries no ledger debit.
    expect(await debitRows(d12.id)).toHaveLength(0);
    // Each approved child debited exactly one day.
    expect(await debitRows(d10.id)).toHaveLength(1);
    expect(await debitRows(d11.id)).toHaveLength(1);

    const after = await childRows(res.parentGroupId!);
    expect(after.find((r) => r.id === d10.id)!.status).toBe('approved');
    expect(after.find((r) => r.id === d11.id)!.status).toBe('approved');
    expect(after.find((r) => r.id === d12.id)!.status).toBe('rejected');

    // The reject reason is on the rejected child's event payload (the audit trail of the per-date decision).
    const payload = await latestEventPayload(b.tenantId, d12.id, 'leave-request.rejected');
    expect(payload?.rejectReason).toBe('Coverage needed on the 12th');
  });

  it('rejecting a child with a blank reason throws MissingRejectReasonError and writes nothing', async () => {
    await grant(b.annualLeaveTypeId, '20.00');
    const res = await requestSpan('2026-08-10', '2026-08-12');
    const rows = await childRows(res.parentGroupId!);
    const target = rows[2];

    await expect(
      decideLeave(mgrCtx, { leaveRequestId: target.id, decision: 'rejected', rejectReason: '   ' }),
    ).rejects.toBeInstanceOf(MissingRejectReasonError);
    await expect(
      decideLeave(mgrCtx, { leaveRequestId: target.id, decision: 'rejected' }),
    ).rejects.toBeInstanceOf(MissingRejectReasonError);

    // Nothing persisted: the child is still pending and there is no rejected event / ledger row for it.
    const reread = await childRows(res.parentGroupId!);
    expect(reread.find((r) => r.id === target.id)!.status).toBe('pending');
    expect(await debitRows(target.id)).toHaveLength(0);
    expect(await latestEventPayload(b.tenantId, target.id, 'leave-request.rejected')).toBeNull();
  });

  it('per-date events: 2 approved + 1 rejected on the child aggregates, each fanning out exactly one notification', async () => {
    process.env.NOTIFICATIONS_ENABLED = 'true';
    try {
      await grant(b.annualLeaveTypeId, '20.00');
      const res = await requestSpan('2026-08-10', '2026-08-12');
      const rows = await childRows(res.parentGroupId!);
      await decideLeave(mgrCtx, { leaveRequestId: rows[0].id, decision: 'approved' });
      await decideLeave(mgrCtx, { leaveRequestId: rows[1].id, decision: 'approved' });
      await decideLeave(mgrCtx, { leaveRequestId: rows[2].id, decision: 'rejected', rejectReason: 'no' });

      // The decision events live on the CHILD aggregates (no parent row exists to pollute).
      expect(await latestEventPayload(b.tenantId, rows[0].id, 'leave-request.approved')).not.toBeNull();
      expect(await latestEventPayload(b.tenantId, rows[1].id, 'leave-request.approved')).not.toBeNull();
      expect(await latestEventPayload(b.tenantId, rows[2].id, 'leave-request.rejected')).not.toBeNull();

      // Exactly 3 notifications fan out to the subject (one per decision; submitted events don't notify).
      const { created } = await dispatchNotifications(adminCtx(b), {});
      expect(created).toBe(3);
      const notes = await owner.db
        .select({ id: schema.notification.id })
        .from(schema.notification)
        .where(eq(schema.notification.recipientEmploymentId, subject.employmentId));
      expect(notes).toHaveLength(3);
    } finally {
      delete process.env.NOTIFICATIONS_ENABLED;
    }
  });

  it('self-approval ban + non-manager rejection still enforced on each child', async () => {
    await grant(b.annualLeaveTypeId, '20.00');
    const res = await requestSpan('2026-08-10', '2026-08-12');
    const rows = await childRows(res.parentGroupId!);

    // Self-approval: the subject (an employee) cannot decide their own child request.
    const uSubject = await createAppUser(b.tenantId, subject.personId, 'employee');
    const subjectCtx: SessionContext = {
      tenantId: b.tenantId,
      userId: uSubject,
      personId: subject.personId,
      roles: ['employee'],
    };
    await expect(
      decideLeave(subjectCtx, { leaveRequestId: rows[0].id, decision: 'approved' }),
    ).rejects.toThrow();

    // A non-manager employee (not in the reporting line) cannot reject another's child request.
    const other = await hire('Bystander');
    const uOther = await createAppUser(b.tenantId, other.personId, 'employee');
    const otherCtx: SessionContext = {
      tenantId: b.tenantId,
      userId: uOther,
      personId: other.personId,
      roles: ['employee'],
    };
    await expect(
      decideLeave(otherCtx, { leaveRequestId: rows[0].id, decision: 'rejected', rejectReason: 'no' }),
    ).rejects.toThrow();
    expect((await childRows(res.parentGroupId!)).every((r) => r.status === 'pending')).toBe(true);
  });
});

describe('Partial Leave Approval (0131) — no-regression for un-split shapes', () => {
  it('a single-day request of a split-enabled type is NOT split (no parentGroupId)', async () => {
    const res = await requestSpan('2026-08-10', '2026-08-10');
    expect(res.parentGroupId).toBeNull();
    expect(res.children).toHaveLength(1);
  });

  it('flag OFF → a multi-day request behaves exactly as today (single request, no split)', async () => {
    await owner.db
      .update(schema.leaveType)
      .set({ perDateApproval: false })
      .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    const res = await requestSpan('2026-08-10', '2026-08-12');
    expect(res.parentGroupId).toBeNull();
    expect(res.children).toHaveLength(1);
    expect(res.days).toBe(3);
  });

  it('calendar-counted type is NOT split even with the flag on', async () => {
    const [cal] = await owner.db
      .insert(schema.leaveType)
      .values({
        tenantId: b.tenantId,
        code: 'UNPAID',
        name: 'Unpaid',
        paid: false,
        counting: 'calendar_days',
        perDateApproval: true,
      })
      .returning({ id: schema.leaveType.id });
    const res = await requestLeave(adminCtx(b), {
      employmentId: subject.employmentId,
      leaveTypeId: cal.id,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
    });
    expect(res.parentGroupId).toBeNull();
    expect(res.children).toHaveLength(1);
  });

  it('half-day request of a split-enabled type is NOT split (single-day by definition)', async () => {
    await owner.db
      .update(schema.leaveType)
      .set({ durations: ['full_day', 'half_day_am'] })
      .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    const res = await requestLeave(adminCtx(b), {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-10',
      durationType: 'half_day_am',
    });
    expect(res.parentGroupId).toBeNull();
    expect(res.children).toHaveLength(1);
    expect(res.days).toBe(0.5);
  });

  it('whole-request reject on a NON-split (flag off) multi-day request still requires a reason', async () => {
    await owner.db
      .update(schema.leaveType)
      .set({ perDateApproval: false })
      .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    await grant(b.annualLeaveTypeId, '20.00');
    const res = await requestSpan('2026-08-10', '2026-08-12');
    await expect(
      decideLeave(mgrCtx, { leaveRequestId: res.leaveRequestId, decision: 'rejected' }),
    ).rejects.toBeInstanceOf(MissingRejectReasonError);
    // With a reason it rejects cleanly (no debit).
    const ok = await decideLeave(mgrCtx, {
      leaveRequestId: res.leaveRequestId,
      decision: 'rejected',
      rejectReason: 'declined',
    });
    expect(ok.status).toBe('rejected');
    expect(await debitRows(res.leaveRequestId)).toHaveLength(0);
  });
});

describe('Partial Leave Approval (0131) — independent per-child balance gate', () => {
  it('approving all 3 with only 2 days balance → the 3rd throws InsufficientLeaveBalanceError; first 2 stay approved+debited', async () => {
    await grant(b.annualLeaveTypeId, '2.00'); // only enough for 2 of the 3 dates
    const res = await requestSpan('2026-08-10', '2026-08-12');
    const rows = await childRows(res.parentGroupId!);

    await decideLeave(mgrCtx, { leaveRequestId: rows[0].id, decision: 'approved' });
    await decideLeave(mgrCtx, { leaveRequestId: rows[1].id, decision: 'approved' });
    await expect(
      decideLeave(mgrCtx, { leaveRequestId: rows[2].id, decision: 'approved' }),
    ).rejects.toBeInstanceOf(InsufficientLeaveBalanceError);

    // The first two were each their own committed transaction — they stay approved + debited.
    const after = await childRows(res.parentGroupId!);
    expect(after.find((r) => r.id === rows[0].id)!.status).toBe('approved');
    expect(after.find((r) => r.id === rows[1].id)!.status).toBe('approved');
    // The third remains pending and debitless (the failing decision rolled back).
    expect(after.find((r) => r.id === rows[2].id)!.status).toBe('pending');
    expect(await debitRows(rows[2].id)).toHaveLength(0);
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(0);
  });
});

describe('Partial Leave Approval (0131) — payroll signal counts approved children only', () => {
  it('a sendToPayroll working-days unpaid-equivalent type, split + one child approved → exactly one payrollImpact, none for rejected', async () => {
    const [paidToPayroll] = await owner.db
      .insert(schema.leaveType)
      .values({
        tenantId: b.tenantId,
        code: 'NOPAY',
        name: 'No-Pay (working days)',
        paid: false,
        counting: 'working_days',
        sendToPayroll: true,
        perDateApproval: true,
      })
      .returning({ id: schema.leaveType.id });
    await grant(paidToPayroll.id, '20.00');
    const res = await requestLeave(adminCtx(b), {
      employmentId: subject.employmentId,
      leaveTypeId: paidToPayroll.id,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
    });
    const rows = await childRows(res.parentGroupId!);
    await decideLeave(mgrCtx, { leaveRequestId: rows[0].id, decision: 'approved' });
    await decideLeave(mgrCtx, { leaveRequestId: rows[1].id, decision: 'rejected', rejectReason: 'no' });
    await decideLeave(mgrCtx, { leaveRequestId: rows[2].id, decision: 'rejected', rejectReason: 'no' });

    // The approved child carries a payrollImpact; the rejected children carry none.
    const approved = await latestEventPayload(b.tenantId, rows[0].id, 'leave-request.approved');
    expect(approved?.payrollImpact).toMatchObject({ approvalStatus: 'approved', leaveTypeCode: 'NOPAY' });
    expect(await latestEventPayload(b.tenantId, rows[1].id, 'leave-request.approved')).toBeNull();
    expect(await latestEventPayload(b.tenantId, rows[2].id, 'leave-request.approved')).toBeNull();

    const rej1 = await latestEventPayload(b.tenantId, rows[1].id, 'leave-request.rejected');
    expect(rej1?.payrollImpact).toBeUndefined();
  });
});

describe('Partial Leave Approval (0131) — RLS', () => {
  it('a non-manager, non-admin employee cannot see another employee child request rows', async () => {
    const res = await requestSpan('2026-08-10', '2026-08-12');
    const rows = await childRows(res.parentGroupId!);
    expect(rows).toHaveLength(3);

    const other = await hire('Outsider');
    const uOther = await createAppUser(b.tenantId, other.personId, 'employee');
    const otherCtx: SessionContext = {
      tenantId: b.tenantId,
      userId: uOther,
      personId: other.personId,
      roles: ['employee'],
    };
    // RLS confines a plain employee to their own requests — decideLeave can't even load the subject's child.
    await expect(
      decideLeave(otherCtx, { leaveRequestId: rows[0].id, decision: 'approved' }),
    ).rejects.toThrow(/not found|not visible|decide/i);
  });
});
