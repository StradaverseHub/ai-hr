/**
 * Partial Leave Cancellation after Approval (ADR-0065).
 *
 * After an approved multi-day leave, the employee can give back a SUBSET of the dates. On approval the
 * service splits the approved span into contiguous sibling rows (parent_group_id, the Emergency-Leave model),
 * each with its own ledger debit, and flips the cancelled segment(s) to status='cancelled' + reverses their
 * debit. Because every span consumer filters status='approved', the cancelled day disappears from the leave
 * balance, the calendar/plannedAbsences, attendance onLeave, and payroll unpaidDays — for free.
 *
 * Dates: "today" in tests is the real wall-clock date (the service uses new Date()), so all leave dates are in
 * August 2026 (well in the future) so the per-date future gate passes. 10/11/12 Aug 2026 are Mon/Tue/Wed.
 */
import { and, eq, gte, lte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee, setReportingLine } from '../core/org';
import {
  addLeaveAttachment,
  decideLeave,
  decideLeaveCancellation,
  decideLeaveDate,
  getLeaveAttachment,
  requestLeave,
  requestLeaveCancellation,
  splitSpanForCancellation,
  LeaveCancellationNotAllowedError,
  LeaveCancellationTooLateError,
  LeaveCancellationDateInvalidError,
  LeaveCancellationPeriodClosedError,
} from '../core/leave';
import { leaveBalances, leaveEntitlementBreakdown, listLeaveRequests, plannedAbsences } from '../core/read';
import type { SessionContext } from '../db/client';
import {
  adminCtx,
  closeAll,
  createAppUser,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;
let subject: { personId: string; employmentId: string };
let subjectCtx: SessionContext;
let mgrCtx: SessionContext;
let manager: { personId: string; employmentId: string };

const hire = (name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `plc_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

async function grantAnnual(days: string, typeId = b.annualLeaveTypeId) {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId: subject.employmentId,
    leaveTypeId: typeId,
    entryType: 'accrual',
    days,
    effectiveOn: '2026-01-01',
  });
}

/** Status of every row for a leave_request id or its parent group, ordered by start date. */
async function siblingRows(parentGroupId: string) {
  return owner.db
    .select({
      id: schema.leaveRequest.id,
      startDate: schema.leaveRequest.startDate,
      endDate: schema.leaveRequest.endDate,
      days: schema.leaveRequest.days,
      status: schema.leaveRequest.status,
    })
    .from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.parentGroupId, parentGroupId))
    .orderBy(schema.leaveRequest.startDate);
}

/** Mirror core/payroll.ts unpaidDaysByEmployment (private): sum of approved unpaid-type days in the period. */
async function unpaidDaysInPeriod(employmentId: string, periodStart: string, periodEnd: string) {
  const rows = await owner.db
    .select({ days: schema.leaveRequest.days })
    .from(schema.leaveRequest)
    .innerJoin(schema.leaveType, eq(schema.leaveType.id, schema.leaveRequest.leaveTypeId))
    .where(
      and(
        eq(schema.leaveRequest.status, 'approved'),
        eq(schema.leaveType.paid, false),
        eq(schema.leaveRequest.employmentId, employmentId),
        gte(schema.leaveRequest.startDate, periodStart),
        lte(schema.leaveRequest.startDate, periodEnd),
      ),
    );
  return rows.reduce((s, r) => s + Number(r.days), 0);
}

/** Mirror core/attendance.ts onLeave predicate: a full_day approved row covering `date`. */
async function onLeave(employmentId: string, date: string) {
  const rows = await owner.db
    .select({ id: schema.leaveRequest.id })
    .from(schema.leaveRequest)
    .where(
      and(
        eq(schema.leaveRequest.status, 'approved'),
        eq(schema.leaveRequest.durationType, 'full_day'),
        lte(schema.leaveRequest.startDate, date),
        gte(schema.leaveRequest.endDate, date),
        eq(schema.leaveRequest.employmentId, employmentId),
      ),
    );
  return rows.length > 0;
}

/** Submit + single-step approve a 10–12 Aug ANNUAL leave; returns the (single) approved row id. */
async function approvedThreeDay() {
  const res = await requestLeave(subjectCtx, {
    employmentId: subject.employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    startDate: '2026-08-10',
    endDate: '2026-08-12',
  });
  await decideLeave(adminCtx(b), { leaveRequestId: res.leaveRequestId, decision: 'approved' });
  return res.leaveRequestId;
}

/** Submit + single-step approve a 10–14 Aug (Mon–Fri, 5 working-day) ANNUAL leave; returns the row id. */
async function approvedFiveDay() {
  const res = await requestLeave(subjectCtx, {
    employmentId: subject.employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    startDate: '2026-08-10',
    endDate: '2026-08-14',
  });
  await decideLeave(adminCtx(b), { leaveRequestId: res.leaveRequestId, decision: 'approved' });
  return res.leaveRequestId;
}

/** The APPROVED sibling row covering `date` (the survivor the employee would give back next), by parent group. */
async function approvedRowCovering(parentGroupId: string, date: string) {
  const rows = await siblingRows(parentGroupId);
  return rows.find((r) => r.status === 'approved' && r.startDate <= date && date <= r.endDate)!;
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
  manager = await hire('Manager');
  const uM = await createAppUser(b.tenantId, manager.personId, 'manager');
  await setReportingLine(adminCtx(b), {
    subordinateEmploymentId: subject.employmentId,
    managerEmploymentId: manager.employmentId,
    lineType: 'administrative',
    validFrom: '2024-01-01',
  });
  mgrCtx = { tenantId: b.tenantId, userId: uM, personId: manager.personId, roles: ['manager'] };
  await grantAnnual('20.00');
});
afterAll(async () => {
  await closeAll();
});

describe('splitSpanForCancellation (pure)', () => {
  it('puts each cancelled date in its own segment and merges surviving runs', () => {
    const all = ['2026-08-10', '2026-08-11', '2026-08-12'];
    const r = splitSpanForCancellation(all, ['2026-08-11']);
    expect(r.segments).toEqual([
      { from: '2026-08-10', to: '2026-08-10', days: 1 },
      { from: '2026-08-11', to: '2026-08-11', days: 1 },
      { from: '2026-08-12', to: '2026-08-12', days: 1 },
    ]);
    // The middle segment (index 1) is the cancelled one.
    expect(r.cancelledSegmentIndexes).toEqual([1]);
  });
  it('cancelling every date marks every segment cancelled (cancel-all == cancel request)', () => {
    const all = ['2026-08-10', '2026-08-11', '2026-08-12'];
    const r = splitSpanForCancellation(all, all);
    expect(r.cancelledSegmentIndexes).toEqual([0, 1, 2]);
  });
  it('keeps a contiguous surviving block as one segment', () => {
    const all = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13'];
    const r = splitSpanForCancellation(all, ['2026-08-10']);
    expect(r.segments).toEqual([
      { from: '2026-08-10', to: '2026-08-10', days: 1 },
      { from: '2026-08-11', to: '2026-08-13', days: 3 },
    ]);
    expect(r.cancelledSegmentIndexes).toEqual([0]);
  });
});

describe('Partial Leave Cancellation — happy path', () => {
  it('cancelling the middle day splits the span, restores 1 day, keeps the rest approved', async () => {
    const reqId = await approvedThreeDay();
    const balBefore = await leaveBalances(subjectCtx, subject.employmentId);
    const annBefore = balBefore.find((x) => x.leaveTypeId === b.annualLeaveTypeId)!;

    const { cancellationRequestId } = await requestLeaveCancellation(subjectCtx, {
      leaveRequestId: reqId,
      cancelDates: ['2026-08-11'],
    });
    const dec = await decideLeaveCancellation(mgrCtx, { cancellationRequestId, decision: 'approved' });
    expect(dec.status).toBe('approved');
    expect(dec.restoredDays).toBe(1);

    // The original row now belongs to a parent group; siblings are 10 (approved) + 11 (cancelled) + 12 (approved).
    const [orig] = await owner.db
      .select({ parentGroupId: schema.leaveRequest.parentGroupId })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.id, reqId));
    const rows = await siblingRows(orig.parentGroupId!);
    expect(rows.map((r) => [r.startDate, r.status])).toEqual([
      ['2026-08-10', 'approved'],
      ['2026-08-11', 'cancelled'],
      ['2026-08-12', 'approved'],
    ]);

    // Balance restored by exactly 1, taken reduced by 1.
    const balAfter = await leaveBalances(subjectCtx, subject.employmentId);
    const annAfter = balAfter.find((x) => x.leaveTypeId === b.annualLeaveTypeId)!;
    expect(Number(annAfter.balance) - Number(annBefore.balance)).toBeCloseTo(1, 2);
    expect(Number(annBefore.taken) - Number(annAfter.taken)).toBeCloseTo(1, 2);

    // Events on BOTH aggregates.
    const crEvents = await eventTypesFor(b.tenantId, cancellationRequestId);
    expect(crEvents).toContain('leave-cancellation.requested');
    expect(crEvents).toContain('leave-cancellation.approved');
    const cancelledRow = rows.find((r) => r.status === 'cancelled')!;
    expect(await eventTypesFor(b.tenantId, cancelledRow.id)).toContain('leave-request.cancelled');
  });

  it('the cancelled day disappears from attendance, payroll unpaid-days, and plannedAbsences; the others remain', async () => {
    // Use an UNPAID type so the payroll unpaid-days check is meaningful.
    const [upl] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code: 'UNPAID', name: 'Unpaid', paid: false, counting: 'working_days' })
      .returning({ id: schema.leaveType.id });
    await grantAnnual('20.00', upl.id);
    const res = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: upl.id,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
    });
    await decideLeave(adminCtx(b), { leaveRequestId: res.leaveRequestId, decision: 'approved' });

    // Before: all 3 days are unpaid + on-leave.
    expect(await unpaidDaysInPeriod(subject.employmentId, '2026-08-01', '2026-08-31')).toBeCloseTo(3, 2);
    expect(await onLeave(subject.employmentId, '2026-08-11')).toBe(true);

    const { cancellationRequestId } = await requestLeaveCancellation(subjectCtx, {
      leaveRequestId: res.leaveRequestId,
      cancelDates: ['2026-08-11'],
    });
    await decideLeaveCancellation(mgrCtx, { cancellationRequestId, decision: 'approved' });

    // After: 11 Aug is gone from every downstream; 10 + 12 remain.
    expect(await onLeave(subject.employmentId, '2026-08-11')).toBe(false);
    expect(await onLeave(subject.employmentId, '2026-08-10')).toBe(true);
    expect(await onLeave(subject.employmentId, '2026-08-12')).toBe(true);
    expect(await unpaidDaysInPeriod(subject.employmentId, '2026-08-01', '2026-08-31')).toBeCloseTo(2, 2);

    // plannedAbsences renders only approved/pending rows (id is keyed by personId) — the cancelled segment is
    // not drawn, so no drawn span covers 11 Aug while 10 + 12 remain.
    const pa = await plannedAbsences(adminCtx(b), [b.companyId], { from: '2026-08-01', to: '2026-08-31' });
    const mine = pa.find((p) => p.id === subject.personId);
    const covers = (date: string) =>
      (mine?.leaves ?? []).some((l) => l.startDate <= date && date <= l.endDate);
    expect(covers('2026-08-11')).toBe(false);
    expect(covers('2026-08-10')).toBe(true);
    expect(covers('2026-08-12')).toBe(true);
  });
});

describe('Partial Leave Cancellation — reject + cancel-all', () => {
  it('reject leaves all 3 dates approved and the balance unchanged', async () => {
    const reqId = await approvedThreeDay();
    const balBefore = await leaveBalances(subjectCtx, subject.employmentId);
    const before = Number(balBefore.find((x) => x.leaveTypeId === b.annualLeaveTypeId)!.balance);

    const { cancellationRequestId } = await requestLeaveCancellation(subjectCtx, {
      leaveRequestId: reqId,
      cancelDates: ['2026-08-11'],
    });
    const dec = await decideLeaveCancellation(mgrCtx, { cancellationRequestId, decision: 'rejected' });
    expect(dec.status).toBe('rejected');

    const [row] = await owner.db
      .select({ status: schema.leaveRequest.status, parentGroupId: schema.leaveRequest.parentGroupId })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.id, reqId));
    expect(row.status).toBe('approved');
    expect(row.parentGroupId).toBeNull(); // no split on reject

    const balAfter = await leaveBalances(subjectCtx, subject.employmentId);
    const after = Number(balAfter.find((x) => x.leaveTypeId === b.annualLeaveTypeId)!.balance);
    expect(after).toBeCloseTo(before, 2);
    expect(await eventTypesFor(b.tenantId, cancellationRequestId)).toContain('leave-cancellation.rejected');
  });

  it('cancelling all 3 dates is equivalent to cancelling the request (every segment cancelled, full restore)', async () => {
    const reqId = await approvedThreeDay();
    const { cancellationRequestId } = await requestLeaveCancellation(subjectCtx, {
      leaveRequestId: reqId,
      cancelDates: ['2026-08-10', '2026-08-11', '2026-08-12'],
    });
    const dec = await decideLeaveCancellation(mgrCtx, { cancellationRequestId, decision: 'approved' });
    expect(dec.restoredDays).toBe(3);
    expect(dec.remainingDays).toBe(0);

    const [orig] = await owner.db
      .select({ parentGroupId: schema.leaveRequest.parentGroupId })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.id, reqId));
    const rows = await siblingRows(orig.parentGroupId!);
    expect(rows.every((r) => r.status === 'cancelled')).toBe(true);

    // Balance fully restored: taken back to 0 for this type.
    const bal = await leaveBalances(subjectCtx, subject.employmentId);
    expect(Number(bal.find((x) => x.leaveTypeId === b.annualLeaveTypeId)!.taken)).toBeCloseTo(0, 2);
  });
});

describe('Partial Leave Cancellation — gates', () => {
  it('cannot cancel a pending (not yet approved) leave', async () => {
    const res = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
    });
    await expect(
      requestLeaveCancellation(subjectCtx, { leaveRequestId: res.leaveRequestId, cancelDates: ['2026-08-11'] }),
    ).rejects.toBeInstanceOf(LeaveCancellationNotAllowedError);
  });

  it('cannot cancel a half-day leave', async () => {
    // Allow half-day on the ANNUAL type so the request is accepted, then the cancellation gate rejects it.
    await owner.db
      .update(schema.leaveType)
      .set({ durations: ['full_day', 'half_day_am', 'half_day_pm'] })
      .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    const res = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-10',
      durationType: 'half_day_am',
    });
    await decideLeave(adminCtx(b), { leaveRequestId: res.leaveRequestId, decision: 'approved' });
    await expect(
      requestLeaveCancellation(subjectCtx, { leaveRequestId: res.leaveRequestId, cancelDates: ['2026-08-10'] }),
    ).rejects.toBeInstanceOf(LeaveCancellationNotAllowedError);
  });

  it('cannot cancel a REPLACEMENT (time-off-in-lieu) leave', async () => {
    const [repl] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code: 'REPLACEMENT', name: 'Replacement', paid: true, counting: 'working_days' })
      .returning({ id: schema.leaveType.id });
    await grantAnnual('10.00', repl.id);
    const res = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: repl.id,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
    });
    await decideLeave(adminCtx(b), { leaveRequestId: res.leaveRequestId, decision: 'approved' });
    await expect(
      requestLeaveCancellation(subjectCtx, { leaveRequestId: res.leaveRequestId, cancelDates: ['2026-08-11'] }),
    ).rejects.toBeInstanceOf(LeaveCancellationNotAllowedError);
  });

  it('a per-date-approval request (ADR-0068 single row) IS cancellable, but an interior-REJECTED date is not cancel-eligible', async () => {
    // ADR-0068: a per-date-approval WORKING-DAYS request is now a SINGLE parentGroupId=NULL row with per-date
    // sub-rows. It is therefore cancellable (unlike the old split child), BUT only its APPROVED dates are
    // cancel-eligible — an interior REJECTED date is not approved leave and must be rejected as invalid.
    await owner.db
      .update(schema.leaveType)
      .set({ counting: 'working_days', perDateApproval: true })
      .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    const res = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
    });
    expect(res.parentGroupId).toBeNull();
    // Approve 10 & 12, reject 11 (interior).
    await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: '2026-08-10', decision: 'approved' });
    await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: '2026-08-11', decision: 'rejected', rejectReason: 'no' });
    await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: '2026-08-12', decision: 'approved' });
    // Cancelling the REJECTED interior date is invalid (not in the approved/cancel-eligible set).
    await expect(
      requestLeaveCancellation(subjectCtx, { leaveRequestId: res.leaveRequestId, cancelDates: ['2026-08-11'] }),
    ).rejects.toBeInstanceOf(LeaveCancellationDateInvalidError);
    // Cancelling an APPROVED date succeeds.
    const ok = await requestLeaveCancellation(subjectCtx, { leaveRequestId: res.leaveRequestId, cancelDates: ['2026-08-10'] });
    expect(ok.requestedDays).toBe(1);
  });

  it('cannot cancel a date on/before today, but a later future date in the same request is allowed', async () => {
    // Build an approved leave directly spanning [today-10 … today+10] with its own ledger debit (the shape
    // finalizeLeaveApproval produces). Then pick a genuinely PAST working day and a genuinely FUTURE working
    // day from that window, regardless of when the test runs.
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const shift = (delta: number) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + delta);
      return d;
    };
    const isWeekday = (d: Date) => d.getUTCDay() >= 1 && d.getUTCDay() <= 5;
    // Nearest past weekday strictly before today.
    let past = shift(-1);
    while (!isWeekday(past)) past = new Date(Date.UTC(past.getUTCFullYear(), past.getUTCMonth(), past.getUTCDate() - 1));
    // Nearest future weekday strictly after today.
    let future = shift(1);
    while (!isWeekday(future)) future = new Date(Date.UTC(future.getUTCFullYear(), future.getUTCMonth(), future.getUTCDate() + 1));
    const start = iso(shift(-10));
    const end = iso(shift(10));
    const [row] = await owner.db
      .insert(schema.leaveRequest)
      .values({
        tenantId: b.tenantId,
        employmentId: subject.employmentId,
        leaveTypeId: b.annualLeaveTypeId,
        startDate: start,
        endDate: end,
        days: '15.00',
        durationType: 'full_day',
        status: 'approved',
      })
      .returning({ id: schema.leaveRequest.id });
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      entryType: 'debit',
      days: '-15.00',
      sourceRequestId: row.id,
      effectiveOn: start,
    });
    // Cancelling the past working day is too late.
    await expect(
      requestLeaveCancellation(subjectCtx, { leaveRequestId: row.id, cancelDates: [iso(past)] }),
    ).rejects.toBeInstanceOf(LeaveCancellationTooLateError);
    // But a future working day in the SAME request is allowed.
    const ok = await requestLeaveCancellation(subjectCtx, { leaveRequestId: row.id, cancelDates: [iso(future)] });
    expect(ok.cancellationRequestId).toBeTruthy();
  });

  it('cannot cancel a date whose payroll period batch is closed (employee has a finalised payslip)', async () => {
    const reqId = await approvedThreeDay();
    // A closed payroll batch for Aug 2026 in the subject's company, WITH the subject's own payslip in it —
    // mirrors a finalised period (the deduction was already taken; no reversal path).
    const [pp] = await owner.db
      .insert(schema.payPeriod)
      .values({ tenantId: b.tenantId, companyId: b.companyId, period: '2026-08', status: 'closed' })
      .returning({ id: schema.payPeriod.id });
    const [batch] = await owner.db
      .insert(schema.payrollBatch)
      .values({
        tenantId: b.tenantId,
        companyId: b.companyId,
        payPeriodId: pp.id,
        payPeriod: '2026-08',
        batchDate: '2026-08-31',
        status: 'closed',
      })
      .returning({ id: schema.payrollBatch.id });
    await owner.db.insert(schema.payslip).values({
      tenantId: b.tenantId,
      batchId: batch.id,
      employmentId: subject.employmentId,
      basicSalary: '5000.00',
      grossPay: '5000.00',
      statutory: {},
      totalDeductions: '500.00',
      netPay: '4500.00',
      employerCost: '5600.00',
    });
    await expect(
      requestLeaveCancellation(subjectCtx, { leaveRequestId: reqId, cancelDates: ['2026-08-11'] }),
    ).rejects.toBeInstanceOf(LeaveCancellationPeriodClosedError);
  });

  it('cannot cancel a date outside the span', async () => {
    const reqId = await approvedThreeDay();
    await expect(
      requestLeaveCancellation(subjectCtx, { leaveRequestId: reqId, cancelDates: ['2026-08-20'] }),
    ).rejects.toBeInstanceOf(LeaveCancellationDateInvalidError);
  });
});

describe('Partial Leave Cancellation — concurrency', () => {
  it('a second pending request overlapping the first is rejected (no double-restore)', async () => {
    const reqId = await approvedThreeDay();
    await requestLeaveCancellation(subjectCtx, { leaveRequestId: reqId, cancelDates: ['2026-08-11'] });
    // A second request that also targets 11 Aug must be rejected while the first is still pending.
    await expect(
      requestLeaveCancellation(subjectCtx, { leaveRequestId: reqId, cancelDates: ['2026-08-11', '2026-08-12'] }),
    ).rejects.toBeInstanceOf(LeaveCancellationNotAllowedError);
  });
});

describe('Partial Leave Cancellation — authz / RLS', () => {
  it('the subject can request on their own leave but a manager cannot insert one on the subordinate', async () => {
    const reqId = await approvedThreeDay();
    // Manager (who can SEE the leave via RLS) must NOT be able to insert a cancellation — subject-only.
    await expect(
      requestLeaveCancellation(mgrCtx, { leaveRequestId: reqId, cancelDates: ['2026-08-11'] }),
    ).rejects.toBeInstanceOf(LeaveCancellationNotAllowedError);
  });

  it('a non-manager peer cannot decide; self-approval is banned; the manager can', async () => {
    const reqId = await approvedThreeDay();
    const { cancellationRequestId } = await requestLeaveCancellation(subjectCtx, {
      leaveRequestId: reqId,
      cancelDates: ['2026-08-11'],
    });
    // Self-approval: the subject cannot decide their own cancellation.
    await expect(
      decideLeaveCancellation(subjectCtx, { cancellationRequestId, decision: 'approved' }),
    ).rejects.toThrow();
    // A peer with no reporting line over the subject cannot decide.
    const peer = await hire('Peer');
    const uP = await createAppUser(b.tenantId, peer.personId, 'manager');
    const peerCtx: SessionContext = { tenantId: b.tenantId, userId: uP, personId: peer.personId, roles: ['manager'] };
    await expect(
      decideLeaveCancellation(peerCtx, { cancellationRequestId, decision: 'approved' }),
    ).rejects.toThrow();
    // The real administrative manager can.
    const dec = await decideLeaveCancellation(mgrCtx, { cancellationRequestId, decision: 'approved' });
    expect(dec.status).toBe('approved');
  });

  it('the subject CAN read their own cancellation request under RLS (positive grant check)', async () => {
    const reqId = await approvedThreeDay();
    const { cancellationRequestId } = await requestLeaveCancellation(subjectCtx, {
      leaveRequestId: reqId,
      cancelDates: ['2026-08-11'],
    });
    // Read back through the app (RLS) role as the subject — must be visible (not a missing-grant false-green).
    const { withTenant } = await import('../db/client');
    const visible = await withTenant(subjectCtx, async (tx) =>
      tx
        .select({ id: schema.leaveCancellationRequest.id })
        .from(schema.leaveCancellationRequest)
        .where(eq(schema.leaveCancellationRequest.id, cancellationRequestId)),
    );
    expect(visible).toHaveLength(1);
  });
});

describe('Partial Leave Cancellation — carry-forward window consistency', () => {
  it('restores balance/taken without disturbing carryForwardRemaining across the carry-expiry boundary', async () => {
    // The reversing debit is dated at the original debit effectiveOn (the request start), so it lands in the
    // same carry window as the original — net-of-cancellation carryForwardRemaining is unchanged.
    const reqId = await approvedThreeDay();
    const asOf = '2026-08-31';
    const before = await leaveEntitlementBreakdown(subjectCtx, subject.employmentId, b.annualLeaveTypeId, asOf);
    const carryBefore = before?.carryForwardRemaining ?? 0;

    const { cancellationRequestId } = await requestLeaveCancellation(subjectCtx, {
      leaveRequestId: reqId,
      cancelDates: ['2026-08-11'],
    });
    await decideLeaveCancellation(mgrCtx, { cancellationRequestId, decision: 'approved' });

    const after = await leaveEntitlementBreakdown(subjectCtx, subject.employmentId, b.annualLeaveTypeId, asOf);
    const carryAfter = after?.carryForwardRemaining ?? 0;
    expect(carryAfter).toBeCloseTo(carryBefore, 2);
  });
});

// ═══════════════ R5 Build #2 — iterative cancellation + the three bug fixes ═══════════════

describe('R5 Build #2 — iterative (second+) cancellation', () => {
  it('after giving back Wednesday, the Thu–Fri survivor can still give back Thursday (repeat cancellation)', async () => {
    // Mon–Fri (10–14 Aug 2026). First give-back: Wednesday 12 Aug.
    const reqId = await approvedFiveDay();
    const balStart = await leaveBalances(subjectCtx, subject.employmentId);
    const annStart = Number(balStart.find((x) => x.leaveTypeId === b.annualLeaveTypeId)!.balance);

    const c1 = await requestLeaveCancellation(subjectCtx, { leaveRequestId: reqId, cancelDates: ['2026-08-12'] });
    await decideLeaveCancellation(mgrCtx, { cancellationRequestId: c1.cancellationRequestId, decision: 'approved' });

    // The original row now belongs to a cancellation-split group: 10–11 approved, 12 cancelled, 13–14 approved.
    const [orig1] = await owner.db
      .select({ parentGroupId: schema.leaveRequest.parentGroupId })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.id, reqId));
    const rows1 = await siblingRows(orig1.parentGroupId!);
    expect(rows1.map((r) => [r.startDate, r.endDate, r.status])).toEqual([
      ['2026-08-10', '2026-08-11', 'approved'],
      ['2026-08-12', '2026-08-12', 'cancelled'],
      ['2026-08-13', '2026-08-14', 'approved'],
    ]);

    // SECOND give-back on the SURVIVOR (Thu–Fri 13–14) — this is the previously-BLOCKED path.
    const survivor = await approvedRowCovering(orig1.parentGroupId!, '2026-08-13');
    const c2 = await requestLeaveCancellation(subjectCtx, {
      leaveRequestId: survivor.id,
      cancelDates: ['2026-08-13'],
    });
    const dec2 = await decideLeaveCancellation(mgrCtx, {
      cancellationRequestId: c2.cancellationRequestId,
      decision: 'approved',
    });
    expect(dec2.status).toBe('approved');
    expect(dec2.restoredDays).toBe(1);

    // Thursday 13 restored, Friday 14 still approved.
    const [survAfter] = await owner.db
      .select({ parentGroupId: schema.leaveRequest.parentGroupId })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.id, survivor.id));
    const rows2 = await siblingRows(survAfter.parentGroupId!);
    expect(rows2.map((r) => [r.startDate, r.status])).toEqual([
      ['2026-08-13', 'cancelled'],
      ['2026-08-14', 'approved'],
    ]);

    // Net balance: 2 of the 5 days (12 + 13) restored vs the fully-approved start.
    const balEnd = await leaveBalances(subjectCtx, subject.employmentId);
    const annEnd = Number(balEnd.find((x) => x.leaveTypeId === b.annualLeaveTypeId)!.balance);
    expect(annEnd - annStart).toBeCloseTo(2, 2);
  });

  it('a genuine Emergency-Leave child row is still NOT cancellable (Fix A does not open that door)', async () => {
    // Emergency Leave decomposes into ANNUAL + UNPAID child rows sharing a parent_group_id, NONE 'cancelled'.
    // Build that EL-child shape directly (approved ANNUAL child under a group with NO cancelled sibling) — the
    // exact structure Fix A must keep blocked while it now ADMITS cancellation-split survivors.
    const groupId = randomUUID();
    const [child] = await owner.db
      .insert(schema.leaveRequest)
      .values({
        tenantId: b.tenantId,
        employmentId: subject.employmentId,
        leaveTypeId: b.annualLeaveTypeId,
        startDate: '2026-08-17',
        endDate: '2026-08-19',
        days: '3.00',
        durationType: 'full_day',
        status: 'approved',
        parentGroupId: groupId,
      })
      .returning({ id: schema.leaveRequest.id });
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      entryType: 'debit',
      days: '-3.00',
      sourceRequestId: child.id,
      effectiveOn: '2026-08-17',
    });
    // The group has NO 'cancelled' sibling → NOT a cancellation split → still rejected.
    await expect(
      requestLeaveCancellation(subjectCtx, { leaveRequestId: child.id, cancelDates: ['2026-08-18'] }),
    ).rejects.toBeInstanceOf(LeaveCancellationNotAllowedError);
  });
});

describe('R5 Build #2 — MYT date boundary (Fix B)', () => {
  it('the future gate uses the injected MYT today, not the UTC clock', async () => {
    // Approved leave far in the future so real-clock never interferes. Inject a `today` boundary and prove a
    // date one day AFTER it is allowed while a date equal to it is TooLate — deterministically, no wall-clock.
    const reqId = await approvedThreeDay(); // 10–12 Aug 2026
    // With today = 2026-08-10 (MYT), 10 Aug is not-after-today (too late) but 11 Aug is allowed.
    await expect(
      requestLeaveCancellation(subjectCtx, {
        leaveRequestId: reqId,
        cancelDates: ['2026-08-10'],
        today: '2026-08-10',
      }),
    ).rejects.toBeInstanceOf(LeaveCancellationTooLateError);
    const ok = await requestLeaveCancellation(subjectCtx, {
      leaveRequestId: reqId,
      cancelDates: ['2026-08-11'],
      today: '2026-08-10',
    });
    expect(ok.cancellationRequestId).toBeTruthy();
  });

  it('near KL midnight: a date that is "tomorrow" in MYT but "today" in UTC is still cancellable', async () => {
    // 2026-08-11T16:30Z is 2026-08-12 00:30 in Kuala Lumpur (UTC+8). So MYT-today = 12 Aug, UTC-today = 11 Aug.
    // Cancelling 13 Aug must be allowed (future in BOTH frames); cancelling 12 Aug must be TooLate in MYT even
    // though a UTC clock would call it "tomorrow" and wrongly allow it — proving the MYT frame is authoritative.
    const res = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-12',
      endDate: '2026-08-13',
    });
    await decideLeave(adminCtx(b), { leaveRequestId: res.leaveRequestId, decision: 'approved' });
    const mytToday = '2026-08-12'; // what todayInKualaLumpur() returns at 2026-08-11T16:30Z
    // 12 Aug == MYT today → TooLate (a UTC clock would have said 11 Aug and wrongly allowed it).
    await expect(
      requestLeaveCancellation(subjectCtx, {
        leaveRequestId: res.leaveRequestId,
        cancelDates: ['2026-08-12'],
        today: mytToday,
      }),
    ).rejects.toBeInstanceOf(LeaveCancellationTooLateError);
    // 13 Aug > MYT today → allowed.
    const ok = await requestLeaveCancellation(subjectCtx, {
      leaveRequestId: res.leaveRequestId,
      cancelDates: ['2026-08-13'],
      today: mytToday,
    });
    expect(ok.cancellationRequestId).toBeTruthy();
  });
});

describe('R5 Build #2 — holiday / non-Mon-Fri cancellable-days list (Fix C)', () => {
  it('a public holiday inside the span is not offered and is rejected if forced', async () => {
    // National holiday on Tue 11 Aug 2026 (state:null resolves for any employment).
    await owner.db
      .insert(schema.holiday)
      .values({ tenantId: b.tenantId, country: 'MY', state: null, holidayDate: '2026-08-11', name: 'Test National Day' });
    // Approve a 10–12 Aug leave: with 11 Aug a holiday, only 10 + 12 are working days (2 days).
    const res = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
    });
    await decideLeave(adminCtx(b), { leaveRequestId: res.leaveRequestId, decision: 'approved' });

    // Read-layer candidate list (what the pop-up shows) must NOT include the holiday.
    const list = await listLeaveRequests(subjectCtx, [b.companyId]);
    const row = list.find((r) => r.id === res.leaveRequestId)!;
    expect(row.workingDates).toEqual(['2026-08-10', '2026-08-12']);
    expect(row.workingDates).not.toContain('2026-08-11');

    // And the service rejects a forced holiday date (would-be off-roster), with a future today so it's not TooLate.
    await expect(
      requestLeaveCancellation(subjectCtx, {
        leaveRequestId: res.leaveRequestId,
        cancelDates: ['2026-08-11'],
        today: '2026-08-01',
      }),
    ).rejects.toBeInstanceOf(LeaveCancellationDateInvalidError);
    // A real working day (12 Aug) IS accepted.
    const ok = await requestLeaveCancellation(subjectCtx, {
      leaveRequestId: res.leaveRequestId,
      cancelDates: ['2026-08-12'],
      today: '2026-08-01',
    });
    expect(ok.requestedDays).toBe(1);
  });

  it('a 6-day work-week Saturday IS offered and accepted (not hidden by a Mon–Fri assumption)', async () => {
    // Company roster includes Saturday (ISO 6). Span 14–15 Aug (Fri + Sat) → both are working days now.
    await owner.db
      .insert(schema.attendancePolicy)
      .values({ tenantId: b.tenantId, companyId: b.companyId, workingDays: [1, 2, 3, 4, 5, 6] });
    const res = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-14',
      endDate: '2026-08-15',
    });
    await decideLeave(adminCtx(b), { leaveRequestId: res.leaveRequestId, decision: 'approved' });

    // The candidate list offers the Saturday (15 Aug).
    const list = await listLeaveRequests(subjectCtx, [b.companyId]);
    const row = list.find((r) => r.id === res.leaveRequestId)!;
    expect(row.workingDates).toContain('2026-08-15');

    // And the service accepts cancelling the Saturday.
    const ok = await requestLeaveCancellation(subjectCtx, {
      leaveRequestId: res.leaveRequestId,
      cancelDates: ['2026-08-15'],
      today: '2026-08-01',
    });
    expect(ok.requestedDays).toBe(1);
  });
});

describe('R5 Build #2 — discoverable entry point (read-layer projection)', () => {
  it('exposes cancellable working dates + isCancellationSplit so the page can render the button', async () => {
    const reqId = await approvedThreeDay(); // 10–12 Aug
    const before = (await listLeaveRequests(subjectCtx, [b.companyId])).find((r) => r.id === reqId)!;
    // A plain approved full-day row: real working dates surfaced, not a cancellation split (yet).
    expect(before.workingDates).toEqual(['2026-08-10', '2026-08-11', '2026-08-12']);
    expect(before.isCancellationSplit).toBe(false);
    expect(before.parentGroupId).toBeNull();

    // Give back the middle day, then the survivor rows must read as cancellation-split survivors so the page
    // keeps showing the "Cancel dates" button on them (iterative-cancellation discoverability).
    const c = await requestLeaveCancellation(subjectCtx, { leaveRequestId: reqId, cancelDates: ['2026-08-11'] });
    await decideLeaveCancellation(mgrCtx, { cancellationRequestId: c.cancellationRequestId, decision: 'approved' });
    const after = await listLeaveRequests(subjectCtx, [b.companyId]);
    const survivors = after.filter((r) => r.status === 'approved' && r.employmentId === subject.employmentId);
    expect(survivors.length).toBeGreaterThanOrEqual(2);
    for (const s of survivors) {
      expect(s.isCancellationSplit).toBe(true);
      expect(s.workingDates.length).toBeGreaterThan(0);
    }
  });
});

describe('R5 Build #2 — attachment visibility on a non-first surviving segment', () => {
  it('the MC stays visible on the survivor the user sees after cancelling the FIRST date', async () => {
    // Attach an MC to a pending request, approve it, then cancel the FIRST date (10 Aug). Segment[0] (10 Aug)
    // reuses the original row id and is CANCELLED; the survivor (11–12) is a new sibling row. Assert the
    // attachment is still visible on that surviving row the employee actually holds.
    const res = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: '2026-08-10',
      endDate: '2026-08-12',
      hasDocument: true,
    });
    await addLeaveAttachment(subjectCtx, {
      leaveRequestId: res.leaveRequestId,
      fileName: 'mc.pdf',
      mimeType: 'application/pdf',
      content: Buffer.from('%PDF-1.4 test'),
    });
    await decideLeave(adminCtx(b), { leaveRequestId: res.leaveRequestId, decision: 'approved' });

    const c = await requestLeaveCancellation(subjectCtx, {
      leaveRequestId: res.leaveRequestId,
      cancelDates: ['2026-08-10'],
    });
    await decideLeaveCancellation(mgrCtx, { cancellationRequestId: c.cancellationRequestId, decision: 'approved' });

    const [orig] = await owner.db
      .select({ parentGroupId: schema.leaveRequest.parentGroupId })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.id, res.leaveRequestId));
    const survivor = await approvedRowCovering(orig.parentGroupId!, '2026-08-11');
    const att = await getLeaveAttachment(subjectCtx, survivor.id);
    expect(att?.fileName).toBe('mc.pdf');
  });
});
