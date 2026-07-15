/**
 * Partial Leave Approval — single-request model (ADR-0068, supersedes 0131's child-row split).
 *
 * A multi-day per-date-approval request is now ONE leave_request row (parent_group_id NULL) with one
 * leave_request_date sub-row per working date. The approver decides each date via decideLeaveDate; the request
 * itself stays a single inbox row. The CENTRAL correctness point (the panel's finding): every span consumer —
 * attendance daily+monthly, roster onLeave, plannedAbsences, unpaid-leave payroll — must count ONLY the
 * approved dates, so a rejected mid-span date is never treated as leave anywhere. Non-contiguous approvals
 * (approve day1+day3, reject day2) must read correctly through the per-date rows.
 *
 * Covers (per the approved plan §8):
 *  1. submit → ONE request (no parent_group_id, no child requests) + 3 leave_request_date rows; one inbox row.
 *  2. approve 2 + reject 1 → aggregate 'approved', single ledger debit = 2.00, rejected date carries reason.
 *  3. blank reject reason → MissingRejectReasonError, nothing written.
 *  4. all rejected → 'rejected', no debit, reasons captured.
 *  5. all approved → single debit = full span, 'approved'.
 *  6. span-consumer correctness: day-2 rejected ⇒ attendance daily+monthly, plannedAbsences, roster, and
 *     unpaid payroll count only days 1 & 3; plus a non-contiguous (approve 1+3, reject 2) case.
 *  7. balance-short at finalization; 7b two concurrent per-date requests (deferred-gate characterization).
 *  8. non-opted-in / half / single-day → NO date rows, decideLeave unchanged.
 *  9. RLS: a non-manager cannot read the breakdown or decide another's date; a manager who sees the parent
 *     sees its date rows (RLS parity).
 * 11. REPLACEMENT guard: per_date_approval on a REPLACEMENT type creates NO date rows, uses decideLeave.
 * 12. Multi-step company guard: per_date_approval in a leaveMultiApproval company creates NO date rows.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { type SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import {
  decideLeave,
  decideLeaveDate,
  decideLeaveDates,
  requestLeave,
  InsufficientLeaveBalanceError,
  MissingRejectReasonError,
} from '../core/leave';
import { leaveRequestDateBreakdown, plannedAbsences } from '../core/read';
import { attendanceForDate, attendanceMonthSummary } from '../core/attendance';
import { rosterVariance, createShift, assignShift } from '../core/roster';
import { unpaidLeaveDaysForPeriod } from '../core/payroll';
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

/** The per-date sub-rows for a request, ordered by date. */
async function dateRows(leaveRequestId: string) {
  return owner.db
    .select({
      id: schema.leaveRequestDate.id,
      leaveDate: schema.leaveRequestDate.leaveDate,
      days: schema.leaveRequestDate.days,
      status: schema.leaveRequestDate.status,
      rejectReason: schema.leaveRequestDate.rejectReason,
    })
    .from(schema.leaveRequestDate)
    .where(eq(schema.leaveRequestDate.leaveRequestId, leaveRequestId))
    .orderBy(schema.leaveRequestDate.leaveDate);
}

async function requestRow(leaveRequestId: string) {
  const [row] = await owner.db
    .select({
      status: schema.leaveRequest.status,
      parentGroupId: schema.leaveRequest.parentGroupId,
      startDate: schema.leaveRequest.startDate,
      endDate: schema.leaveRequest.endDate,
      days: schema.leaveRequest.days,
    })
    .from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.id, leaveRequestId));
  return row;
}

async function debitRows(leaveRequestId: string) {
  return owner.db
    .select({ days: schema.leaveLedger.days })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.sourceRequestId, leaveRequestId),
        eq(schema.leaveLedger.entryType, 'debit'),
      ),
    );
}

async function grant(leaveTypeId: string, days: string, employmentId = subject.employmentId) {
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType: 'accrual',
    days,
    effectiveOn: '2026-01-01',
  });
}

/** seedBase's ANNUAL type, set to working_days + per_date_approval for the per-date path. */
async function enablePerDate(leaveTypeId: string) {
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
  await enablePerDate(b.annualLeaveTypeId);
});
afterAll(async () => {
  await closeAll();
});

const requestSpan = (start: string, end: string, employmentId = subject.employmentId) =>
  requestLeave(adminCtx(b), { employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: start, endDate: end });

// 2026-08-10 Mon, -11 Tue, -12 Wed — all working days.
const D10 = '2026-08-10';
const D11 = '2026-08-11';
const D12 = '2026-08-12';

describe('Partial Leave Approval — submission (single request + per-date rows)', () => {
  it('a 3-working-day opted-in request → ONE request (no parent_group_id, no children) + 3 pending date rows', async () => {
    const res = await requestSpan(D10, D12);
    expect(res.parentGroupId).toBeNull();
    expect(res.children).toHaveLength(1);
    const req = await requestRow(res.leaveRequestId);
    expect(req.parentGroupId).toBeNull();
    expect(req.startDate).toBe(D10);
    expect(req.endDate).toBe(D12);
    // No sibling leave_request rows were created (the whole point vs the 0131 split).
    const all = await owner.db.select({ id: schema.leaveRequest.id }).from(schema.leaveRequest);
    expect(all).toHaveLength(1);
    const rows = await dateRows(res.leaveRequestId);
    expect(rows.map((r) => r.leaveDate)).toEqual([D10, D11, D12]);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(rows.reduce((s, r) => s + Number(r.days), 0)).toBe(3);
    // The submitted event carries the per-date breakdown.
    const initEvt = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.per-date.initialized');
    expect((initEvt?.perDate as unknown[]).length).toBe(3);
  });

  it('leaveRequestDateBreakdown returns the ordered date rows for the detail view', async () => {
    const res = await requestSpan(D10, D12);
    const bd = await leaveRequestDateBreakdown(adminCtx(b), res.leaveRequestId);
    expect(bd.map((r) => r.leaveDate)).toEqual([D10, D11, D12]);
    expect(bd.every((r) => r.status === 'pending')).toBe(true);
  });
});

describe('Partial Leave Approval — per-date decisions + finalization', () => {
  it('approve 2 + reject 1 → aggregate approved; single ledger debit = 2.00; rejected date carries the reason', async () => {
    await grant(b.annualLeaveTypeId, '20.00');
    const res = await requestSpan(D10, D12);

    expect((await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D10, decision: 'approved' })).status).toBe('pending');
    expect((await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D11, decision: 'approved' })).status).toBe('pending');
    const last = await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D12, decision: 'rejected', rejectReason: 'Coverage needed on the 12th' });
    expect(last.status).toBe('approved');

    // Balance reflects ONLY the 2 approved dates: 20 − 2 = 18.
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(18);
    // Exactly one debit row against the single request, for 2.00.
    const debits = await debitRows(res.leaveRequestId);
    expect(debits).toHaveLength(1);
    expect(Number(debits[0].days)).toBe(-2);

    expect((await requestRow(res.leaveRequestId)).status).toBe('approved');
    const rows = await dateRows(res.leaveRequestId);
    expect(rows.find((r) => r.leaveDate === D12)!.status).toBe('rejected');
    expect(rows.find((r) => r.leaveDate === D12)!.rejectReason).toBe('Coverage needed on the 12th');

    // Events: 3× date.decided + one leave-request.approved (finalization).
    const types = (
      await owner.db
        .select({ t: schema.domainEvent.eventType })
        .from(schema.domainEvent)
        .where(eq(schema.domainEvent.aggregateId, res.leaveRequestId))
    ).map((r) => r.t);
    expect(types.filter((t) => t === 'leave-request.date.decided')).toHaveLength(3);
    expect(types.filter((t) => t === 'leave-request.approved')).toHaveLength(1);
    const rej = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.date.decided');
    expect(rej?.rejectReason).toBe('Coverage needed on the 12th');
  });

  it('rejecting a date with a blank reason throws MissingRejectReasonError and writes nothing', async () => {
    await grant(b.annualLeaveTypeId, '20.00');
    const res = await requestSpan(D10, D12);
    await expect(
      decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D12, decision: 'rejected', rejectReason: '   ' }),
    ).rejects.toBeInstanceOf(MissingRejectReasonError);
    await expect(
      decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D12, decision: 'rejected' }),
    ).rejects.toBeInstanceOf(MissingRejectReasonError);
    const rows = await dateRows(res.leaveRequestId);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(await debitRows(res.leaveRequestId)).toHaveLength(0);
  });

  it('all rejected → aggregate rejected, no debit, reasons captured', async () => {
    await grant(b.annualLeaveTypeId, '20.00');
    const res = await requestSpan(D10, D12);
    await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D10, decision: 'rejected', rejectReason: 'no' });
    await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D11, decision: 'rejected', rejectReason: 'no' });
    const last = await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D12, decision: 'rejected', rejectReason: 'no' });
    expect(last.status).toBe('rejected');
    expect((await requestRow(res.leaveRequestId)).status).toBe('rejected');
    expect(await debitRows(res.leaveRequestId)).toHaveLength(0);
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(20);
    const finalRej = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.rejected');
    expect(typeof finalRej?.rejectReason).toBe('string');
  });

  it('all approved → single debit = full 3-day span, aggregate approved', async () => {
    await grant(b.annualLeaveTypeId, '20.00');
    const res = await requestSpan(D10, D12);
    for (const d of [D10, D11, D12]) {
      await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: d, decision: 'approved' });
    }
    expect((await requestRow(res.leaveRequestId)).status).toBe('approved');
    const debits = await debitRows(res.leaveRequestId);
    expect(debits).toHaveLength(1);
    expect(Number(debits[0].days)).toBe(-3);
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(17);
  });
});

describe('Partial Leave Approval — batch decideLeaveDates (R17 600be8ac)', () => {
  it('a mixed batch in ONE call → correct row states, one date.decided per date, single debit = approved sum, mixed + perDateOutcome payload', async () => {
    await grant(b.annualLeaveTypeId, '20.00');
    const res = await requestSpan(D10, D12);
    const out = await decideLeaveDates(mgrCtx, {
      leaveRequestId: res.leaveRequestId,
      decisions: [
        { leaveDate: D10, decision: 'approved' },
        { leaveDate: D11, decision: 'approved' },
        { leaveDate: D12, decision: 'rejected', rejectReason: 'Business operational requirement on the 12th' },
      ],
    });
    expect(out.status).toBe('approved');
    // Only the 2 approved dates are debited: 20 − 2 = 18, exactly one debit row.
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(18);
    const debits = await debitRows(res.leaveRequestId);
    expect(debits).toHaveLength(1);
    expect(Number(debits[0].days)).toBe(-2);
    const rows = await dateRows(res.leaveRequestId);
    expect(rows.find((r) => r.leaveDate === D12)!.status).toBe('rejected');
    expect(rows.find((r) => r.leaveDate === D12)!.rejectReason).toBe('Business operational requirement on the 12th');
    // One date.decided event per date + one terminal approved event.
    const types = (
      await owner.db
        .select({ t: schema.domainEvent.eventType })
        .from(schema.domainEvent)
        .where(eq(schema.domainEvent.aggregateId, res.leaveRequestId))
    ).map((r) => r.t);
    expect(types.filter((t) => t === 'leave-request.date.decided')).toHaveLength(3);
    expect(types.filter((t) => t === 'leave-request.approved')).toHaveLength(1);
    // The mixed approved event carries the per-date outcome so the notification can list dates + reason.
    const evt = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.approved');
    expect(evt?.mixed).toBe(true);
    const pdo = evt?.perDateOutcome as { approved: string[]; rejected: { date: string; reason: string | null }[] };
    expect(pdo.approved.sort()).toEqual([D10, D11]);
    expect(pdo.rejected).toEqual([{ date: D12, reason: 'Business operational requirement on the 12th' }]);
  });

  it('a blank reject reason anywhere in the batch throws and writes nothing', async () => {
    await grant(b.annualLeaveTypeId, '20.00');
    const res = await requestSpan(D10, D12);
    await expect(
      decideLeaveDates(mgrCtx, {
        leaveRequestId: res.leaveRequestId,
        decisions: [
          { leaveDate: D10, decision: 'approved' },
          { leaveDate: D12, decision: 'rejected', rejectReason: '   ' },
        ],
      }),
    ).rejects.toBeInstanceOf(MissingRejectReasonError);
    const rows = await dateRows(res.leaveRequestId);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(await debitRows(res.leaveRequestId)).toHaveLength(0);
  });

  it('an unknown or already-decided date in the batch throws and leaves the request untouched', async () => {
    await grant(b.annualLeaveTypeId, '20.00');
    const res = await requestSpan(D10, D12);
    await expect(
      decideLeaveDates(mgrCtx, {
        leaveRequestId: res.leaveRequestId,
        decisions: [{ leaveDate: '2026-08-20', decision: 'approved' }],
      }),
    ).rejects.toThrow();
    // Now decide D10, then a second batch naming D10 again must throw (already decided).
    await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D10, decision: 'approved' });
    await expect(
      decideLeaveDates(mgrCtx, {
        leaveRequestId: res.leaveRequestId,
        decisions: [{ leaveDate: D10, decision: 'approved' }],
      }),
    ).rejects.toThrow();
  });

  it('a partial batch (2 of 3 dates) leaves the request pending; a follow-up single decision finalizes', async () => {
    await grant(b.annualLeaveTypeId, '20.00');
    const res = await requestSpan(D10, D12);
    const out = await decideLeaveDates(mgrCtx, {
      leaveRequestId: res.leaveRequestId,
      decisions: [
        { leaveDate: D10, decision: 'approved' },
        { leaveDate: D11, decision: 'approved' },
      ],
    });
    expect(out.status).toBe('pending');
    expect((await requestRow(res.leaveRequestId)).status).toBe('pending');
    expect(await debitRows(res.leaveRequestId)).toHaveLength(0);
    const last = await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D12, decision: 'approved' });
    expect(last.status).toBe('approved');
    expect(Number((await debitRows(res.leaveRequestId))[0].days)).toBe(-3);
  });
});

describe('Partial Leave Approval — mixed-outcome notification signal', () => {
  it('a MIXED finalization (approve 2, reject 1) tags the leave-request.approved event payload mixed: true', async () => {
    await grant(b.annualLeaveTypeId, '20.00');
    const res = await requestSpan(D10, D12);
    await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D10, decision: 'approved' });
    await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D11, decision: 'approved' });
    await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D12, decision: 'rejected', rejectReason: 'no' });
    const evt = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.approved');
    expect(evt?.mixed).toBe(true);
  });

  it('an ALL-APPROVED per-date finalization does NOT tag mixed (byte-identical to a whole-request approval)', async () => {
    await grant(b.annualLeaveTypeId, '20.00');
    const res = await requestSpan(D10, D12);
    for (const d of [D10, D11, D12]) {
      await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: d, decision: 'approved' });
    }
    const evt = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.approved');
    expect(evt).not.toHaveProperty('mixed');
  });

  it('backward-compat: a plain (non-per-date) whole-request approval carries NO mixed field', async () => {
    // Flag OFF ⇒ no date rows ⇒ the ordinary decideLeave whole-request path (the majority approval path).
    await owner.db.update(schema.leaveType).set({ perDateApproval: false }).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    await grant(b.annualLeaveTypeId, '20.00');
    const res = await requestSpan(D10, D12);
    expect(await dateRows(res.leaveRequestId)).toHaveLength(0);
    await decideLeave(mgrCtx, { leaveRequestId: res.leaveRequestId, decision: 'approved' });
    const evt = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.approved');
    expect(evt).not.toHaveProperty('mixed');
  });
});

describe('Partial Leave Approval — span-consumer correctness (the central fix)', () => {
  // Approve D10 + D12, reject D11 (interior + non-contiguous). Every consumer must count only D10 & D12.
  async function approveWithMiddleRejected(reqId: string) {
    await decideLeaveDate(mgrCtx, { leaveRequestId: reqId, leaveDate: D10, decision: 'approved' });
    await decideLeaveDate(mgrCtx, { leaveRequestId: reqId, leaveDate: D11, decision: 'rejected', rejectReason: 'no' });
    await decideLeaveDate(mgrCtx, { leaveRequestId: reqId, leaveDate: D12, decision: 'approved' });
  }

  it('attendance daily: only D10 & D12 are on_leave; the rejected D11 is not', async () => {
    await grant(b.annualLeaveTypeId, '20.00');
    const res = await requestSpan(D10, D12);
    await approveWithMiddleRejected(res.leaveRequestId);
    const ctxOf = (date: string) => attendanceForDate(adminCtx(b), date).then((rows) => rows.find((r) => r.employmentId === subject.employmentId)?.context);
    expect(await ctxOf(D10)).toBe('on_leave');
    expect(await ctxOf(D11)).not.toBe('on_leave');
    expect(await ctxOf(D12)).toBe('on_leave');
  });

  it('attendance monthly: leaveDays counts only the 2 approved dates', async () => {
    await grant(b.annualLeaveTypeId, '20.00');
    const res = await requestSpan(D10, D12);
    await approveWithMiddleRejected(res.leaveRequestId);
    const summary = await attendanceMonthSummary(adminCtx(b), { month: '2026-08', today: '2026-08-31' });
    const mine = summary.find((r) => r.employmentId === subject.employmentId)!;
    expect(mine.leaveDays).toBe(2);
  });

  it('plannedAbsences: renders only the approved dates (D11 excluded from the span)', async () => {
    await grant(b.annualLeaveTypeId, '20.00');
    const res = await requestSpan(D10, D12);
    await approveWithMiddleRejected(res.leaveRequestId);
    const rows = await plannedAbsences(adminCtx(b), undefined, { from: '2026-08-01', to: '2026-08-31' });
    const mine = rows.find((r) => r.id === subject.personId)!;
    // The approved dates are D10 and D12; D11 must NOT be covered by any rendered leave segment.
    const covers = (d: string) => mine.leaves.some((l) => l.startDate <= d && d <= l.endDate);
    expect(covers(D10)).toBe(true);
    expect(covers(D11)).toBe(false);
    expect(covers(D12)).toBe(true);
  });

  it('roster onLeave: a rostered rejected date IS a no-show; approved dates are suppressed', async () => {
    await grant(b.annualLeaveTypeId, '20.00');
    const res = await requestSpan(D10, D12);
    await approveWithMiddleRejected(res.leaveRequestId);
    const ctx = adminCtx(b);
    const shiftId = (await createShift(ctx, { companyId: b.companyId, name: 'Day', code: 'DAY', startTime: '08:00:00', endTime: '17:00:00', breakMinutes: 60 })).id;
    for (const d of [D10, D11, D12]) await assignShift(ctx, { employmentId: subject.employmentId, shiftDate: d, shiftId });
    const rows = await rosterVariance(ctx, { from: '2026-08-01', to: '2026-08-31', today: '2026-08-20' });
    const kind = (d: string) => rows.find((r) => r.employmentId === subject.employmentId && r.shiftDate === d)?.kind;
    expect(kind(D10)).toBeUndefined(); // approved leave ⇒ suppressed
    expect(kind(D11)).toBe('no_show'); // rejected date ⇒ still a no-show
    expect(kind(D12)).toBeUndefined();
  });

  it('unpaid-leave payroll: an unpaid per-date type returns 2, not 3', async () => {
    const [unpaid] = await owner.db
      .insert(schema.leaveType)
      .values({ allowNegativeBalance: true, tenantId: b.tenantId, code: 'UNPAIDWD', name: 'Unpaid (working days)', paid: false, counting: 'working_days', perDateApproval: true })
      .returning({ id: schema.leaveType.id });
    await grant(unpaid.id, '20.00');
    const res = await requestLeave(adminCtx(b), { employmentId: subject.employmentId, leaveTypeId: unpaid.id, startDate: D10, endDate: D12 });
    await approveWithMiddleRejected(res.leaveRequestId);
    const unpaidDays = await unpaidLeaveDaysForPeriod(adminCtx(b), '2026-08-01', '2026-08-31');
    expect(unpaidDays.get(subject.employmentId)).toBe(2);
  });
});

describe('Partial Leave Approval — balance gate at finalization', () => {
  it('approving dates beyond balance throws InsufficientLeaveBalanceError at finalization; the request stays pending', async () => {
    await grant(b.annualLeaveTypeId, '2.00'); // only enough for 2 of the 3 dates
    const res = await requestSpan(D10, D12);
    await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D10, decision: 'approved' });
    await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D11, decision: 'approved' });
    // The LAST date is what triggers finalization; the 3-day debit exceeds the 2-day balance ⇒ throws.
    await expect(
      decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D12, decision: 'approved' }),
    ).rejects.toBeInstanceOf(InsufficientLeaveBalanceError);
    // The failing decision rolled back: request still pending, no debit, balance intact.
    expect((await requestRow(res.leaveRequestId)).status).toBe('pending');
    expect(await debitRows(res.leaveRequestId)).toHaveLength(0);
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(2);
  });

  it('an under-balance partial (approve 2, reject 1) succeeds even when the full span would exceed balance', async () => {
    await grant(b.annualLeaveTypeId, '2.00');
    const res = await requestSpan(D10, D12);
    await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D10, decision: 'approved' });
    await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D11, decision: 'approved' });
    const last = await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D12, decision: 'rejected', rejectReason: 'no' });
    expect(last.status).toBe('approved');
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(0); // 2 granted − 2 approved
  });

  it('7b: two concurrent per-date requests together exceeding balance — the deferred gate is last-writer-loses', async () => {
    // Only 2 days of balance. Two separate 2-day per-date requests each finalize against the LIVE balance at
    // their own finalization: the first debits 2 (balance → 0), the second then fails the gate. Characterizes
    // the documented no-incremental-hold semantics (ADR-0068 §4E) — the terminal gate is the authority.
    await grant(b.annualLeaveTypeId, '2.00');
    const r1 = await requestSpan(D10, D11);
    const r2 = await requestSpan(D12, '2026-08-13'); // Wed..Thu, both working days
    // Fully approve r1 first → debits 2, balance 0.
    await decideLeaveDate(mgrCtx, { leaveRequestId: r1.leaveRequestId, leaveDate: D10, decision: 'approved' });
    await decideLeaveDate(mgrCtx, { leaveRequestId: r1.leaveRequestId, leaveDate: D11, decision: 'approved' });
    expect((await requestRow(r1.leaveRequestId)).status).toBe('approved');
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(0);
    // Now r2's finalization gate fails (0 balance, needs 2).
    await decideLeaveDate(mgrCtx, { leaveRequestId: r2.leaveRequestId, leaveDate: D12, decision: 'approved' });
    await expect(
      decideLeaveDate(mgrCtx, { leaveRequestId: r2.leaveRequestId, leaveDate: '2026-08-13', decision: 'approved' }),
    ).rejects.toBeInstanceOf(InsufficientLeaveBalanceError);
  });
});

describe('Partial Leave Approval — no-regression for un-split shapes', () => {
  it('a single-day opted-in request has NO date rows and goes through decideLeave', async () => {
    await grant(b.annualLeaveTypeId, '20.00');
    const res = await requestSpan(D10, D10);
    expect(res.parentGroupId).toBeNull();
    expect(await dateRows(res.leaveRequestId)).toHaveLength(0);
    const ok = await decideLeave(mgrCtx, { leaveRequestId: res.leaveRequestId, decision: 'approved' });
    expect(ok.status).toBe('approved');
    expect(Number((await debitRows(res.leaveRequestId))[0].days)).toBe(-1);
  });

  it('flag OFF → a multi-day request has NO date rows and behaves as today', async () => {
    await owner.db.update(schema.leaveType).set({ perDateApproval: false }).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    await grant(b.annualLeaveTypeId, '20.00');
    const res = await requestSpan(D10, D12);
    expect(await dateRows(res.leaveRequestId)).toHaveLength(0);
    expect(res.days).toBe(3);
    // whole-request reject still requires a reason (unchanged decideLeave behaviour).
    await expect(
      decideLeave(mgrCtx, { leaveRequestId: res.leaveRequestId, decision: 'rejected' }),
    ).rejects.toBeInstanceOf(MissingRejectReasonError);
    const ok = await decideLeave(mgrCtx, { leaveRequestId: res.leaveRequestId, decision: 'rejected', rejectReason: 'declined' });
    expect(ok.status).toBe('rejected');
  });

  it('calendar-counted type with the flag on is NOT decomposed', async () => {
    const [cal] = await owner.db
      .insert(schema.leaveType)
      .values({ allowNegativeBalance: true, tenantId: b.tenantId, code: 'UNPAIDCAL', name: 'Unpaid (calendar)', paid: false, counting: 'calendar_days', perDateApproval: true })
      .returning({ id: schema.leaveType.id });
    const res = await requestLeave(adminCtx(b), { employmentId: subject.employmentId, leaveTypeId: cal.id, startDate: D10, endDate: D12 });
    expect(await dateRows(res.leaveRequestId)).toHaveLength(0);
  });

  it('half-day opted-in request (single day by definition) has NO date rows', async () => {
    await owner.db.update(schema.leaveType).set({ durations: ['full_day', 'half_day_am'] }).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    const res = await requestLeave(adminCtx(b), { employmentId: subject.employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: D10, endDate: D10, durationType: 'half_day_am' });
    expect(await dateRows(res.leaveRequestId)).toHaveLength(0);
    expect(res.days).toBe(0.5);
  });
});

describe('Partial Leave Approval — REPLACEMENT + multi-step guards', () => {
  it('11: a REPLACEMENT type with per_date_approval creates NO date rows and uses decideLeave', async () => {
    const [repl] = await owner.db
      .insert(schema.leaveType)
      .values({ allowNegativeBalance: true, tenantId: b.tenantId, code: 'REPLACEMENT', name: 'Replacement (TOIL)', paid: true, counting: 'working_days', perDateApproval: true })
      .returning({ id: schema.leaveType.id });
    await grant(repl.id, '20.00');
    const res = await requestLeave(adminCtx(b), { employmentId: subject.employmentId, leaveTypeId: repl.id, startDate: D10, endDate: D12 });
    expect(await dateRows(res.leaveRequestId)).toHaveLength(0);
    const ok = await decideLeave(mgrCtx, { leaveRequestId: res.leaveRequestId, decision: 'approved' });
    expect(ok.status).toBe('approved');
  });

  it('12: a per_date_approval type in a leaveMultiApproval company creates NO date rows (falls back to the chain)', async () => {
    await owner.db.update(schema.company).set({ leaveMultiApproval: true }).where(eq(schema.company.id, b.companyId));
    const res = await requestSpan(D10, D12);
    expect(await dateRows(res.leaveRequestId)).toHaveLength(0);
    // A multi-step chain was generated instead (the whole-request path is intact).
    const steps = await owner.db
      .select({ id: schema.leaveApprovalStep.id })
      .from(schema.leaveApprovalStep)
      .where(eq(schema.leaveApprovalStep.leaveRequestId, res.leaveRequestId));
    expect(steps.length).toBeGreaterThan(0);
  });

  it('in-flight: a company flipping to multi-step mid-request does NOT strand already-created per-date rows', async () => {
    // The gate is read ONCE at requestLeave time; decideLeaveDate never re-checks the company flag. So a
    // per-date request that already has its date rows continues to resolve via decideLeaveDate regardless of a
    // later company-level flip — confirming, not assuming, the documented in-flight behaviour.
    await grant(b.annualLeaveTypeId, '20.00');
    const res = await requestSpan(D10, D12);
    expect(await dateRows(res.leaveRequestId)).toHaveLength(3);
    // Decide one date, THEN flip the company to multi-step.
    await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D10, decision: 'approved' });
    await owner.db.update(schema.company).set({ leaveMultiApproval: true }).where(eq(schema.company.id, b.companyId));
    // The remaining dates still resolve through the per-date path and finalize correctly.
    await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D11, decision: 'approved' });
    const last = await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D12, decision: 'rejected', rejectReason: 'no' });
    expect(last.status).toBe('approved');
    // Mixed outcome ⇒ only the 2 approved dates debited (20 − 2 = 18), and the event carries mixed: true.
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBe(18);
    const evt = await latestEventPayload(b.tenantId, res.leaveRequestId, 'leave-request.approved');
    expect(evt?.mixed).toBe(true);
  });
});

describe('Partial Leave Approval — RLS', () => {
  it('a non-manager cannot read the breakdown or decide another employee\'s date; a manager who sees the parent sees the date rows', async () => {
    const res = await requestSpan(D10, D12);
    // The manager (can see the subject) sees all 3 date rows — RLS parity with the parent request.
    const mgrView = await leaveRequestDateBreakdown(mgrCtx, res.leaveRequestId);
    expect(mgrView).toHaveLength(3);

    const other = await hire('Outsider');
    const uOther = await createAppUser(b.tenantId, other.personId, 'employee');
    const otherCtx: SessionContext = { tenantId: b.tenantId, userId: uOther, personId: other.personId, roles: ['employee'] };
    // A plain employee cannot see the subject's date rows…
    expect(await leaveRequestDateBreakdown(otherCtx, res.leaveRequestId)).toHaveLength(0);
    // …and cannot decide one (the request/date is not visible to them).
    await expect(
      decideLeaveDate(otherCtx, { leaveRequestId: res.leaveRequestId, leaveDate: D10, decision: 'approved' }),
    ).rejects.toThrow();
  });
});
