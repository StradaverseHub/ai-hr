/**
 * r301 hand-fix (board 83511d3b) · CANCEL APPROVED LEAVE — what the adversarial verification broke.
 *
 * Each arm is the verifier's own reproduction (it went red on 775bb9c8) turned into the invariant it violated:
 *   1. RACE: two automatic approvals at the same moment give a day back ONCE, and the approved rows never cover a
 *      day twice — the leave row is locked for the whole request.
 *   2. PER-DATE: a per-date-approved leave with a rejected day splits over its APPROVED dates; the rejected day
 *      never becomes approved leave, the give-back equals what was charged, and each date's approval record
 *      moves to the row that holds the date (approvedLeaveDates reads exactly the dates still on leave).
 *   3. CLOSED MONTH AT DECISION: the last approval of a chain is refused when the month closed after the request.
 *   4. ONE PENDING PER LEAVE: a second request is refused while one waits; a second pending one that already
 *      exists (from before this rule) is refused at approval instead of "approved" with 0 days back.
 *
 * Dates derive from todayInKualaLumpur() (three weeks out, a Monday..Friday) — never hard-coded.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { updateLeaveType } from '../core/admin';
import {
  approvedLeaveDates,
  decideLeave,
  decideLeaveCancellation,
  decideLeaveDate,
  LeaveCancellationNotAllowedError,
  LeaveCancellationPeriodClosedError,
  requestLeave,
  requestLeaveCancellation,
} from '../core/leave';
import { employeeCancelOffers, listLeaveRequests } from '../core/read';
import { todayInKualaLumpur } from '../lib/hr-date';
import { adminCtx, closeAll, createAppUser, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
let subject: { personId: string; employmentId: string };
let subjectCtx: SessionContext;
let manager: { personId: string; employmentId: string };
let mgrCtx: SessionContext;
let hr: { personId: string; employmentId: string };
let hrCtx: SessionContext;

const TODAY = todayInKualaLumpur();
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const MON = (() => {
  let d = addDays(TODAY, 21);
  while ((new Date(`${d}T00:00:00Z`).getUTCDay() || 7) !== 1) d = addDays(d, 1);
  return d;
})();
const TUE = addDays(MON, 1);
const WED = addDays(MON, 2);
const THU = addDays(MON, 3);
const FRI = addDays(MON, 4);

const hire = (name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `r302cf_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
const ctxOf = async (emp: { personId: string }, role: string): Promise<SessionContext> => ({
  tenantId: b.tenantId,
  userId: await createAppUser(b.tenantId, emp.personId, role),
  personId: emp.personId,
  roles: [role],
});
const setRule = (p: { employeeCancelApproved?: boolean; cancelNoticeDays?: number; cancelAutoApprove?: boolean; cancelNotify?: boolean }) =>
  updateLeaveType(adminCtx(b), { id: b.annualLeaveTypeId, name: 'Annual Leave', ...p });
const balance = () => ledgerBalance(subject.employmentId, b.annualLeaveTypeId);

async function approvedWeekTwoLevels() {
  const res = await requestLeave(subjectCtx, {
    employmentId: subject.employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    startDate: MON,
    endDate: FRI,
    today: TODAY,
  });
  expect((await decideLeave(mgrCtx, { leaveRequestId: res.leaveRequestId, decision: 'approved' })).status).toBe('pending');
  expect((await decideLeave(hrCtx, { leaveRequestId: res.leaveRequestId, decision: 'approved' })).status).toBe('approved');
  return res.leaveRequestId;
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
  await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
  subject = await hire('Subject');
  subjectCtx = await ctxOf(subject, 'employee');
  manager = await hire('Manager');
  mgrCtx = await ctxOf(manager, 'manager');
  hr = await hire('HR Person');
  hrCtx = await ctxOf(hr, 'hr_admin');
  await setReportingLine(adminCtx(b), {
    subordinateEmploymentId: subject.employmentId,
    managerEmploymentId: manager.employmentId,
    lineType: 'administrative',
    validFrom: '2024-01-01',
  });
  await owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId: subject.employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    entryType: 'accrual',
    days: '30.00',
    effectiveOn: TODAY,
  });
});


const leaveRows = () =>
  owner.db
    .select({ id: schema.leaveRequest.id, start: schema.leaveRequest.startDate, end: schema.leaveRequest.endDate, status: schema.leaveRequest.status, days: schema.leaveRequest.days })
    .from(schema.leaveRequest)
    .where(eq(schema.leaveRequest.employmentId, subject.employmentId))
    .orderBy(schema.leaveRequest.startDate, schema.leaveRequest.status);

/** Every date covered by more than one APPROVED row — must always be empty. */
async function doublyApprovedDates() {
  const seen = new Map<string, number>();
  for (const r of (await leaveRows()).filter((x) => x.status === 'approved')) {
    for (let d = r.start; d <= r.end; d = addDays(d, 1)) seen.set(d, (seen.get(d) ?? 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([d]) => d);
}

async function perDateWeekWithTuesdayRejected() {
  await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager'] });
  await owner.db.update(schema.leaveType).set({ counting: 'working_days', perDateApproval: true }).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
  const res = await requestLeave(subjectCtx, { employmentId: subject.employmentId, leaveTypeId: b.annualLeaveTypeId, startDate: MON, endDate: FRI, today: TODAY });
  for (const d of [MON, WED, THU, FRI]) await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: d, decision: 'approved' });
  await decideLeaveDate(mgrCtx, { leaveRequestId: res.leaveRequestId, leaveDate: TUE, decision: 'rejected', rejectReason: 'cover' });
  return res.leaveRequestId;
}

const onLeave = async () =>
  [...((await withTenant(adminCtx(b), (tx) => approvedLeaveDates(tx, [subject.employmentId], MON, FRI))).get(subject.employmentId) ?? [])].sort();

describe('1 · RACE — the leave row is locked for the whole request', () => {
  it('two automatic approvals of the SAME date at once give it back once; no day is approved twice', async () => {
    const id = await approvedWeekTwoLevels();
    await setRule({ employeeCancelApproved: true, cancelAutoApprove: true });
    const before = await balance();
    const results = await Promise.allSettled([
      requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [WED], today: TODAY }),
      requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [WED], today: TODAY }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await balance()).toBeCloseTo(before + 1, 2);
    expect(await doublyApprovedDates()).toEqual([]);
  });

  it('two automatic approvals of DIFFERENT dates at once: days back = requests that succeeded, approved days = 5 − that', async () => {
    const id = await approvedWeekTwoLevels();
    await setRule({ employeeCancelApproved: true, cancelAutoApprove: true });
    const before = await balance();
    const results = await Promise.allSettled([
      requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [TUE], today: TODAY }),
      requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [THU], today: TODAY }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBeGreaterThanOrEqual(1);
    const approvedDays = (await leaveRows()).filter((r) => r.status === 'approved').reduce((s, r) => s + Number(r.days), 0);
    expect((await balance()) - before).toBeCloseTo(ok, 2);
    expect(approvedDays).toBeCloseTo(5 - ok, 2);
    expect(await doublyApprovedDates()).toEqual([]);
  });
});

describe('2 · PER-DATE — a rejected day never becomes approved leave', () => {
  it('giving back one approved date restores exactly one day; the rejected Tuesday stays off every approved row', async () => {
    const id = await perDateWeekWithTuesdayRejected();
    expect(await onLeave()).toEqual([MON, WED, THU, FRI]);
    const t1 = await balance();
    await setRule({ employeeCancelApproved: true, cancelAutoApprove: true });
    const out = await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [THU], today: TODAY });
    expect(out).toMatchObject({ status: 'approved', restoredDays: 1 });
    expect((await balance()) - t1).toBeCloseTo(1, 2);
    // Exactly the dates still on leave — neither the rejected Tuesday nor the cancelled Thursday.
    expect(await onLeave()).toEqual([MON, WED, FRI]);
    // The per-date rows moved with their dates: every surviving approved row carries its own.
    const rows = await leaveRows();
    for (const r of rows.filter((x) => x.status === 'approved')) {
      const own = await owner.db.select({ d: schema.leaveRequestDate.leaveDate, s: schema.leaveRequestDate.status }).from(schema.leaveRequestDate).where(eq(schema.leaveRequestDate.leaveRequestId, r.id));
      expect(own.filter((x) => x.s === 'approved').length).toBeGreaterThan(0);
      expect(own.every((x) => x.d >= r.start && x.d <= r.end)).toBe(true);
    }
    const [thu] = await owner.db.select({ s: schema.leaveRequestDate.status }).from(schema.leaveRequestDate).innerJoin(schema.leaveRequest, eq(schema.leaveRequest.id, schema.leaveRequestDate.leaveRequestId)).where(and(eq(schema.leaveRequest.employmentId, subject.employmentId), eq(schema.leaveRequestDate.leaveDate, THU)));
    expect(thu.s).toBe('cancelled');
  });

  it('giving back every approved date returns the balance to where it started and offers no Tuesday to cancel', async () => {
    const start = await balance();
    const id = await perDateWeekWithTuesdayRejected();
    await setRule({ employeeCancelApproved: true, cancelAutoApprove: true });
    await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [MON, WED, THU, FRI], today: TODAY });
    expect((await balance()) - start).toBeCloseTo(0, 2);
    const listed = await listLeaveRequests(subjectCtx, [b.companyId]);
    const covering = listed.filter((r) => r.status === 'approved' && r.startDate <= TUE && r.endDate >= TUE);
    expect(covering).toEqual([]);
    expect(await onLeave()).toEqual([]);
  });

  it('a split that keeps the rejected day INSIDE a surviving span still never offers or counts it', async () => {
    const id = await perDateWeekWithTuesdayRejected();
    await setRule({ employeeCancelApproved: true, cancelAutoApprove: true });
    // Cancel Thursday: Monday..Wednesday survives as one row whose span contains the rejected Tuesday.
    await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [THU], today: TODAY });
    const listed = await listLeaveRequests(subjectCtx, [b.companyId]);
    const monWed = listed.find((r) => r.status === 'approved' && r.startDate === MON);
    expect(monWed).toBeDefined();
    // As /leave passes it: the row's span working dates. The read must offer the approved ones and drop Tuesday.
    const offers = await employeeCancelOffers(subjectCtx, [{ ...monWed!, workingDates: [MON, TUE, WED] }], TODAY);
    expect(offers.get(monWed!.id)).toEqual([MON, WED]);
    await expect(requestLeaveCancellation(subjectCtx, { leaveRequestId: monWed!.id, cancelDates: [TUE], today: TODAY })).rejects.toThrow();
    expect(await onLeave()).toEqual([MON, WED, FRI]);
  });
});

describe('3 · CLOSED PAYROLL MONTH — asked again when the cancellation is decided', () => {
  it('the last level is refused when the month closed after the request, and nothing is given back', async () => {
    const id = await approvedWeekTwoLevels();
    const c = await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [WED], today: TODAY });
    await decideLeaveCancellation(mgrCtx, { cancellationRequestId: c.cancellationRequestId, decision: 'approved' });
    const period = WED.slice(0, 7);
    const [pp] = await owner.db.insert(schema.payPeriod).values({ tenantId: b.tenantId, companyId: b.companyId, period, status: 'closed' }).returning({ id: schema.payPeriod.id });
    const [batch] = await owner.db
      .insert(schema.payrollBatch)
      .values({ tenantId: b.tenantId, companyId: b.companyId, payPeriodId: pp.id, payPeriod: period, batchDate: `${period}-28`, status: 'closed' })
      .returning({ id: schema.payrollBatch.id });
    await owner.db.insert(schema.payslip).values({
      tenantId: b.tenantId, batchId: batch.id, employmentId: subject.employmentId, basicSalary: '5000.00', grossPay: '5000.00',
      statutory: {}, totalDeductions: '500.00', netPay: '4500.00', employerCost: '5600.00',
    });
    const before = await balance();
    await expect(decideLeaveCancellation(hrCtx, { cancellationRequestId: c.cancellationRequestId, decision: 'approved' })).rejects.toBeInstanceOf(LeaveCancellationPeriodClosedError);
    expect(await balance()).toBeCloseTo(before, 2);
    const [cr] = await owner.db.select({ status: schema.leaveCancellationRequest.status }).from(schema.leaveCancellationRequest).where(eq(schema.leaveCancellationRequest.id, c.cancellationRequestId));
    expect(cr.status).toBe('pending');
  });
});

describe('4 · ONE PENDING CANCELLATION PER LEAVE', () => {
  it('a second request on the same leave is refused while one waits, even for a different date', async () => {
    const id = await approvedWeekTwoLevels();
    await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [TUE], today: TODAY });
    const e = await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [THU], today: TODAY }).catch((x) => x);
    expect(e).toBeInstanceOf(LeaveCancellationNotAllowedError);
    expect((e as LeaveCancellationNotAllowedError).refusal).toBe('already_pending');
  });

  it('a second pending one that already exists is refused at approval, not approved with 0 days back', async () => {
    const id = await approvedWeekTwoLevels();
    const c1 = await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [TUE], today: TODAY });
    // As it could exist before this rule: a second pending request on the same leave, for Thursday.
    const [c2] = await owner.db
      .insert(schema.leaveCancellationRequest)
      .values({ tenantId: b.tenantId, leaveRequestId: id, employmentId: subject.employmentId, cancelDates: [THU], requestedDays: '1.00', status: 'pending' })
      .returning({ id: schema.leaveCancellationRequest.id });
    await decideLeaveCancellation(mgrCtx, { cancellationRequestId: c1.cancellationRequestId, decision: 'approved' });
    await decideLeaveCancellation(hrCtx, { cancellationRequestId: c1.cancellationRequestId, decision: 'approved' });
    const before = await balance();
    const e = await decideLeaveCancellation(mgrCtx, { cancellationRequestId: c2.id, decision: 'approved' }).catch((x) => x);
    expect(e).toBeInstanceOf(LeaveCancellationNotAllowedError);
    expect((e as LeaveCancellationNotAllowedError).refusal).toBe('no_longer_cancellable');
    expect(await balance()).toBeCloseTo(before, 2);
    const thuApproved = (await leaveRows()).filter((r) => r.status === 'approved' && r.start <= THU && r.end >= THU);
    expect(thuApproved).toHaveLength(1);
    // The approver can still clear it.
    expect((await decideLeaveCancellation(mgrCtx, { cancellationRequestId: c2.id, decision: 'rejected' })).status).toBe('rejected');
  });
});
