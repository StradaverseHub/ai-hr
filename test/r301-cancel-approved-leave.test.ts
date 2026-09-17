/**
 * r301 (board 83511d3b) · CANCEL APPROVED LEAVE — the leave type's own rule.
 *
 * What the approved plan promised the reporter, arm by arm, against the real service and a real database:
 *   · switched OFF ⇒ the employee has no cancel option (the server-computed button offer is null, on /leave and
 *     on the Team Leave Tracker) AND the service refuses, saying which type does not allow it; HR's on-behalf
 *     cancellation is untouched by the switch;
 *   · the notice period is counted PER LEAVE DATE from the tenant-local today: a started leave's later dates can
 *     still be given back when each is far enough away, nearer ones are refused as too close, 0 keeps today's
 *     "strictly after today" rule;
 *   · approved automatically ⇒ cancelled and days back in the same request, recorded as a SYSTEM decision; a
 *     closed payroll month is still refused (and nothing is written);
 *   · a leave with unpaid days is refused at REQUEST time now (it used to be accepted and refused only when an
 *     approver tried to approve it), with no button offered;
 *   · every type that existed before 0471 reads today's behaviour; every type created afterwards starts OFF;
 *   · the card's service contract: tri-state, dormant sub-settings, validation, Replacement Leave never auto.
 *
 * Dates derive from todayInKualaLumpur(); `today` is injected into the service where an arm needs a date to be
 * "started" or "near" — never a hard-coded future date.
 */
import { and, eq, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { createLeaveType, updateLeaveType } from '../core/admin';
import {
  adminCancelLeave,
  cancelApprovedSettingOf,
  cancelDateRefusal,
  decideLeave,
  decideLeaveCancellation,
  employeeCancellableDates,
  requestLeave,
  requestLeaveCancellation,
  LeaveCancellationNotAllowedError,
  LeaveCancellationPeriodClosedError,
  LeaveCancellationTooCloseError,
  LeaveCancellationTooLateError,
} from '../core/leave';
import { employeeCancelOffers, listLeaveRequests, plannedAbsences } from '../core/read';
import { todayInKualaLumpur } from '../lib/hr-date';
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
let manager: { personId: string; employmentId: string };
let mgrCtx: SessionContext;

const TODAY = todayInKualaLumpur();
const addDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Monday of the first full week starting at least 21 days from today — every date below is future. */
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
    person: { fullName: name, primaryEmail: `r301_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

/** The harness Annual Leave type, through the SERVICE the card posts to (so the tri-state is under test too). */
const setRule = (p: {
  employeeCancelApproved?: boolean;
  cancelNoticeDays?: number;
  cancelAutoApprove?: boolean;
  cancelNotify?: boolean;
}) => updateLeaveType(adminCtx(b), { id: b.annualLeaveTypeId, name: 'Annual Leave', ...p });

const ruleRow = async (id = b.annualLeaveTypeId) => {
  const [r] = await owner.db
    .select({
      allowed: schema.leaveType.employeeCancelApproved,
      notice: schema.leaveType.cancelNoticeDays,
      auto: schema.leaveType.cancelAutoApprove,
      notify: schema.leaveType.cancelNotify,
    })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.id, id));
  return r;
};

/** Submit + (single-level) approve a Mon–Fri Annual Leave; returns its id. */
async function approvedWeek() {
  const res = await requestLeave(subjectCtx, {
    employmentId: subject.employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    startDate: MON,
    endDate: FRI,
    today: TODAY,
  });
  await decideLeave(mgrCtx, { leaveRequestId: res.leaveRequestId, decision: 'approved' });
  return res.leaveRequestId;
}

const cancellationRows = (leaveRequestId: string) =>
  owner.db
    .select({ id: schema.leaveCancellationRequest.id, status: schema.leaveCancellationRequest.status })
    .from(schema.leaveCancellationRequest)
    .where(eq(schema.leaveCancellationRequest.leaveRequestId, leaveRequestId));

const leaveStatus = async (id: string) =>
  (await owner.db.select({ s: schema.leaveRequest.status }).from(schema.leaveRequest).where(eq(schema.leaveRequest.id, id)))[0]?.s;

/** The /leave button offer for one row, computed by the SAME server read the page calls. */
async function offerOnLeavePage(leaveRequestId: string, today = TODAY) {
  const rows = await listLeaveRequests(subjectCtx, [b.companyId]);
  const row = rows.find((r) => r.id === leaveRequestId)!;
  const offers = await employeeCancelOffers(subjectCtx, [row], today);
  return offers.get(leaveRequestId);
}

/** The Team Leave Tracker's candidate dates for one row (plannedAbsences, as app/leave/tracker/page.tsx calls it). */
async function offerOnTracker(leaveRequestId: string, today = TODAY) {
  const pa = await plannedAbsences(subjectCtx, [b.companyId], { from: MON, to: FRI }, today, {
    personIds: [subject.personId],
  });
  const pill = pa.flatMap((p) => p.leaves).find((l) => l.id === leaveRequestId)!;
  return pill.candidateCancelDates;
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
  // A ONE-level chain, so these arms are about the leave type's rule and not about re-approval routing (the
  // copied multi-level chain has its own file, test/r301-cancel-approved-leave-chain.test.ts).
  await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager'] });
  subject = await hire('Subject');
  const u = await createAppUser(b.tenantId, subject.personId, 'employee');
  subjectCtx = { tenantId: b.tenantId, userId: u, personId: subject.personId, roles: ['employee'] };
  manager = await hire('Manager');
  const uM = await createAppUser(b.tenantId, manager.personId, 'manager');
  mgrCtx = { tenantId: b.tenantId, userId: uM, personId: manager.personId, roles: ['manager'] };
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

describe('SWITCHED OFF — no cancel option, the service refuses, HR can still cancel on the employee’s behalf', () => {
  it('no button on /leave or the tracker, and the refusal names the type', async () => {
    const id = await approvedWeek();
    // ON (the harness type is a pre-0471 type): the button is offered with the whole future week.
    expect(await offerOnLeavePage(id)).toEqual([MON, TUE, WED, THU, FRI]);
    expect(await offerOnTracker(id)).toEqual([MON, TUE, WED, THU, FRI]);

    await setRule({ employeeCancelApproved: false });
    expect((await ruleRow()).allowed).toBe(false);
    // OFF: null ⇒ the /leave page renders NO CancelDatesDialog; the tracker gets no candidate dates, and its
    // client gate (candidateCancelDates.length > 0) renders nothing.
    expect(await offerOnLeavePage(id)).toBeNull();
    expect(await offerOnTracker(id)).toEqual([]);

    const refusal = await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [WED], today: TODAY }).catch(
      (e) => e,
    );
    expect(refusal).toBeInstanceOf(LeaveCancellationNotAllowedError);
    expect((refusal as LeaveCancellationNotAllowedError).refusal).toBe('type_off');
    expect((refusal as LeaveCancellationNotAllowedError).leaveTypeName).toBe('Annual Leave');
    expect(await cancellationRows(id)).toEqual([]);
    expect(await leaveStatus(id)).toBe('approved');

    // HR's on-behalf cancel does not read the switch.
    const before = await ledgerBalance(subject.employmentId, b.annualLeaveTypeId);
    const out = await adminCancelLeave(adminCtx(b), { leaveRequestId: id });
    expect(out.restoredDays).toBe(5);
    expect(await leaveStatus(id)).toBe('cancelled');
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBeCloseTo(before + 5, 2);
  });

  it('switching it off leaves the three settings dormant; switching back on restores them', async () => {
    await setRule({ employeeCancelApproved: true, cancelNoticeDays: 4, cancelAutoApprove: true, cancelNotify: true });
    await setRule({ employeeCancelApproved: false });
    expect(await ruleRow()).toEqual({ allowed: false, notice: 4, auto: true, notify: true });
    // An unrelated card's save never touches the four columns (the tri-state).
    await updateLeaveType(adminCtx(b), { id: b.annualLeaveTypeId, name: 'Annual Leave', perDateApproval: false });
    expect(await ruleRow()).toEqual({ allowed: false, notice: 4, auto: true, notify: true });
    await setRule({ employeeCancelApproved: true });
    expect(await ruleRow()).toEqual({ allowed: true, notice: 4, auto: true, notify: true });
    // The audit diff records the card.
    const payload = await latestEventPayload(b.tenantId, b.annualLeaveTypeId, 'leave-type.updated');
    expect(payload?.before).toMatchObject({ employeeCancelApproved: false });
    expect(payload?.after).toMatchObject({ employeeCancelApproved: true, cancelNoticeDays: 4 });
  });
});

describe('NOTICE DAYS — counted per leave date, from the tenant-local today', () => {
  it('a started leave keeps its later dates cancellable when each is far enough away; nearer ones are refused', async () => {
    const id = await approvedWeek();
    await setRule({ employeeCancelApproved: true, cancelNoticeDays: 2 });
    // "Today" is the Wednesday of the leave: Mon–Wed have started, Thu is 1 day away, Fri is 2.
    const today = WED;
    expect(cancelDateRefusal(TUE, today, 2)).toBe('started');
    expect(cancelDateRefusal(THU, today, 2)).toBe('too_close');
    expect(cancelDateRefusal(FRI, today, 2)).toBeNull();

    // The button offers exactly Friday — on /leave and on the tracker, through the one predicate.
    expect(await offerOnLeavePage(id, today)).toEqual([FRI]);
    expect(await offerOnTracker(id, today)).toEqual([FRI]);

    const tooClose = await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [THU], today }).catch((e) => e);
    expect(tooClose).toBeInstanceOf(LeaveCancellationTooCloseError);
    expect(tooClose).toMatchObject({ date: THU, noticeDays: 2, leaveTypeName: 'Annual Leave' });
    await expect(
      requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [TUE], today }),
    ).rejects.toBeInstanceOf(LeaveCancellationTooLateError);
    // One near date in the set refuses the whole request — nothing is half-written.
    await expect(
      requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [THU, FRI], today }),
    ).rejects.toBeInstanceOf(LeaveCancellationTooCloseError);
    expect(await cancellationRows(id)).toEqual([]);

    const ok = await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [FRI], today });
    expect(ok.status).toBe('pending');
    expect(ok.requestedDays).toBe(1);
  });

  it('0 is today’s rule unchanged: today refused as started, tomorrow allowed', async () => {
    const id = await approvedWeek();
    expect((await ruleRow()).notice).toBe(0);
    await expect(
      requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [TUE], today: TUE }),
    ).rejects.toBeInstanceOf(LeaveCancellationTooLateError);
    expect(await offerOnLeavePage(id, TUE)).toEqual([WED, THU, FRI]);
    const ok = await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [WED], today: TUE });
    expect(ok.status).toBe('pending');
  });
});

describe('AUTO-APPROVE — cancelled and days back in the same request, as a system decision', () => {
  it('cancels, restores the days, and records the system as the actor with the reason', async () => {
    const id = await approvedWeek();
    await setRule({ employeeCancelApproved: true, cancelAutoApprove: true });
    const before = await ledgerBalance(subject.employmentId, b.annualLeaveTypeId);

    const out = await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [WED], today: TODAY });
    expect(out.status).toBe('approved');
    expect(out.restoredDays).toBe(1);
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBeCloseTo(before + 1, 2);

    const [cr] = await cancellationRows(id);
    expect(cr.status).toBe('approved');
    // No chain was copied — there is nobody to walk.
    const steps = await owner.db
      .select({ id: schema.leaveCancellationStep.id })
      .from(schema.leaveCancellationStep)
      .where(eq(schema.leaveCancellationStep.cancellationRequestId, cr.id));
    expect(steps).toEqual([]);
    // requested (by the employee) then approved (by the system), on the cancellation's own aggregate.
    expect(await eventTypesFor(b.tenantId, cr.id)).toEqual(['leave-cancellation.requested', 'leave-cancellation.approved']);
    const [approvedEv] = await owner.db
      .select({ actorType: schema.domainEvent.actorType, actorId: schema.domainEvent.actorId, payload: schema.domainEvent.payload })
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, cr.id), eq(schema.domainEvent.eventType, 'leave-cancellation.approved')));
    expect(approvedEv.actorType).toBe('system');
    expect(approvedEv.actorId).toBeNull();
    expect(approvedEv.payload).toMatchObject({ autoApproved: true, reason: 'auto-approved by leave type setting', restoredDays: 1 });

    // The cancelled day is a 'cancelled' segment; the rest of the week stays approved.
    const [orig] = await owner.db
      .select({ g: schema.leaveRequest.parentGroupId })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.id, id));
    const siblings = await owner.db
      .select({ from: schema.leaveRequest.startDate, status: schema.leaveRequest.status })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.parentGroupId, orig.g!))
      .orderBy(schema.leaveRequest.startDate);
    expect(siblings).toEqual([
      { from: MON, status: 'approved' },
      { from: WED, status: 'cancelled' },
      { from: THU, status: 'approved' },
    ]);
  });

  it('a closed payroll month is still refused, and nothing is written', async () => {
    const id = await approvedWeek();
    await setRule({ employeeCancelApproved: true, cancelAutoApprove: true });
    const period = WED.slice(0, 7);
    const [pp] = await owner.db
      .insert(schema.payPeriod)
      .values({ tenantId: b.tenantId, companyId: b.companyId, period, status: 'closed' })
      .returning({ id: schema.payPeriod.id });
    const [batch] = await owner.db
      .insert(schema.payrollBatch)
      .values({ tenantId: b.tenantId, companyId: b.companyId, payPeriodId: pp.id, payPeriod: period, batchDate: `${period}-28`, status: 'closed' })
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
    const before = await ledgerBalance(subject.employmentId, b.annualLeaveTypeId);
    await expect(
      requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [WED], today: TODAY }),
    ).rejects.toBeInstanceOf(LeaveCancellationPeriodClosedError);
    expect(await cancellationRows(id)).toEqual([]);
    expect(await leaveStatus(id)).toBe('approved');
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBeCloseTo(before, 2);
  });
});

describe('UNPAID DAYS — refused at REQUEST time now, and never offered', () => {
  /** An approved leave carrying unpaid days, in the shape Allow Unpaid Leave (a7fab30b) approves. */
  async function approvedWithUnpaidDays() {
    const [row] = await owner.db
      .insert(schema.leaveRequest)
      .values({
        tenantId: b.tenantId,
        employmentId: subject.employmentId,
        leaveTypeId: b.annualLeaveTypeId,
        startDate: MON,
        endDate: FRI,
        days: '5.00',
        unpaidDays: '2.00',
        durationType: 'full_day',
        status: 'approved',
      })
      .returning({ id: schema.leaveRequest.id });
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      entryType: 'debit',
      days: '-3.00',
      sourceRequestId: row.id,
      effectiveOn: MON,
    });
    return row.id;
  }

  it('manual re-approval: refused when asked, with no pending card left for an approver', async () => {
    const id = await approvedWithUnpaidDays();
    const e = await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [WED], today: TODAY }).catch((x) => x);
    expect(e).toBeInstanceOf(LeaveCancellationNotAllowedError);
    expect((e as LeaveCancellationNotAllowedError).refusal).toBe('unpaid_days');
    expect(await cancellationRows(id)).toEqual([]);
    expect(await offerOnLeavePage(id)).toBeNull();
    expect(await offerOnTracker(id)).toEqual([]);
  });

  it('auto-approve: refused just the same — the automatic path never reaches the split', async () => {
    const id = await approvedWithUnpaidDays();
    await setRule({ employeeCancelApproved: true, cancelAutoApprove: true });
    const before = await ledgerBalance(subject.employmentId, b.annualLeaveTypeId);
    const e = await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [WED], today: TODAY }).catch((x) => x);
    expect((e as LeaveCancellationNotAllowedError).refusal).toBe('unpaid_days');
    expect(await cancellationRows(id)).toEqual([]);
    expect(await ledgerBalance(subject.employmentId, b.annualLeaveTypeId)).toBeCloseTo(before, 2);
  });
});

describe('EXISTING TYPES UNCHANGED, NEW TYPES OFF', () => {
  it('0471 gives every EXISTING row today’s behaviour and every row inserted afterwards OFF — without an UPDATE', async () => {
    // The mechanism the migration uses, executed on a probe table: rows present BEFORE the ADD COLUMN read
    // the value it was added with; rows inserted after the default moves read the new default.
    const migration = readFileSync(new URL('../db/migrations/0471_cancel_approved_leave.sql', import.meta.url), 'utf8');
    const leaveTypeDdl = migration
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('ALTER TABLE "leave_type"'));
    expect(leaveTypeDdl).toEqual([
      'ALTER TABLE "leave_type" ADD COLUMN "employee_cancel_approved" boolean DEFAULT true NOT NULL;',
      'ALTER TABLE "leave_type" ALTER COLUMN "employee_cancel_approved" SET DEFAULT false;',
      'ALTER TABLE "leave_type" ADD COLUMN "cancel_notice_days" integer DEFAULT 0 NOT NULL;',
      'ALTER TABLE "leave_type" ADD COLUMN "cancel_auto_approve" boolean DEFAULT false NOT NULL;',
      'ALTER TABLE "leave_type" ADD COLUMN "cancel_notify" boolean DEFAULT false NOT NULL;',
    ]);
    expect(/\bUPDATE\s+"?leave_type"?/i.test(migration)).toBe(false);
    const probe = await owner.db.transaction(async (tx) => {
      await tx.execute(sql`CREATE TEMP TABLE r301_probe (id int) ON COMMIT DROP`);
      await tx.execute(sql`INSERT INTO r301_probe VALUES (1), (2)`);
      for (const stmt of leaveTypeDdl) await tx.execute(sql.raw(stmt.replace('"leave_type"', 'r301_probe')));
      await tx.execute(sql`INSERT INTO r301_probe (id) VALUES (3)`);
      return (await tx.execute(
        sql`SELECT id, employee_cancel_approved AS allowed, cancel_notice_days AS notice, cancel_auto_approve AS auto, cancel_notify AS notify FROM r301_probe ORDER BY id`,
      )) as unknown as { id: number; allowed: boolean; notice: number; auto: boolean; notify: boolean }[];
    });
    expect(probe.map((r) => ({ ...r }))).toEqual([
      { id: 1, allowed: true, notice: 0, auto: false, notify: false },
      { id: 2, allowed: true, notice: 0, auto: false, notify: false },
      { id: 3, allowed: false, notice: 0, auto: false, notify: false },
    ]);
    // …and the live column default is what the probe says.
    const [col] = (await owner.db.execute(
      sql`SELECT column_default FROM information_schema.columns WHERE table_name = 'leave_type' AND column_name = 'employee_cancel_approved'`,
    )) as unknown as { column_default: string }[];
    expect(col.column_default).toBe('false');
  });

  it('an existing type (on, 0 notice, re-approval, no notify) behaves exactly as before', async () => {
    const id = await approvedWeek();
    expect(await ruleRow()).toEqual({ allowed: true, notice: 0, auto: false, notify: false });
    const out = await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [WED], today: TODAY });
    expect(out.status).toBe('pending');
    // A single-level chain: nothing copied, and the manager decides as always.
    const steps = await owner.db
      .select({ id: schema.leaveCancellationStep.id })
      .from(schema.leaveCancellationStep)
      .where(eq(schema.leaveCancellationStep.cancellationRequestId, out.cancellationRequestId));
    expect(steps).toEqual([]);
    const dec = await decideLeaveCancellation(mgrCtx, { cancellationRequestId: out.cancellationRequestId, decision: 'approved' });
    expect(dec.status).toBe('approved');
    expect(dec.restoredDays).toBe(1);
  });

  it('a type created from now on starts switched OFF — through HR’s form, and through any other insert', async () => {
    const created = await createLeaveType(adminCtx(b), { code: 'STUDY', name: 'Study Leave' });
    expect(await ruleRow(created.id)).toEqual({ allowed: false, notice: 0, auto: false, notify: false });
    const [raw] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code: 'EXAM', name: 'Exam Leave' })
      .returning({ id: schema.leaveType.id });
    expect((await ruleRow(raw.id)).allowed).toBe(false);

    // …and it bites: approved leave of the new type cannot be cancelled by the employee.
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: subject.employmentId,
      leaveTypeId: created.id,
      entryType: 'accrual',
      days: '5.00',
      effectiveOn: TODAY,
    });
    const res = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: created.id,
      startDate: MON,
      endDate: TUE,
      today: TODAY,
    });
    await decideLeave(mgrCtx, { leaveRequestId: res.leaveRequestId, decision: 'approved' });
    const e = await requestLeaveCancellation(subjectCtx, { leaveRequestId: res.leaveRequestId, cancelDates: [TUE], today: TODAY }).catch(
      (x) => x,
    );
    expect((e as LeaveCancellationNotAllowedError).refusal).toBe('type_off');
    expect((e as LeaveCancellationNotAllowedError).leaveTypeName).toBe('Study Leave');
  });
});

describe('THE CARD’S SERVICE CONTRACT', () => {
  it('validates the notice as a whole number of days from 0 to 365', async () => {
    for (const bad of [-1, 1.5, 366, Number.NaN]) {
      await expect(setRule({ employeeCancelApproved: true, cancelNoticeDays: bad })).rejects.toThrow(/0 to 365/);
    }
    await setRule({ employeeCancelApproved: true, cancelNoticeDays: 365 });
    expect((await ruleRow()).notice).toBe(365);
  });

  it('Replacement Leave refuses automatic approval at save, and reads as re-approval if it ever holds one', async () => {
    const [repl] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code: 'REPLACEMENT', name: 'Replacement Leave', employeeCancelApproved: true })
      .returning({ id: schema.leaveType.id });
    await expect(
      updateLeaveType(adminCtx(b), { id: repl.id, name: 'Replacement Leave', employeeCancelApproved: true, cancelAutoApprove: true }),
    ).rejects.toThrow(/Replacement Leave cancellations always need approval/);
    expect((await ruleRow(repl.id)).auto).toBe(false);
    // Defence in depth: a stored true (written behind the service) still reads as re-approval.
    expect(cancelApprovedSettingOf({ role: 'replacement', employeeCancelApproved: true, cancelAutoApprove: true }).autoApprove).toBe(false);
  });

  it('Emergency Leave reads today’s behaviour whatever its columns say', () => {
    expect(cancelApprovedSettingOf({ role: 'emergency', employeeCancelApproved: false, cancelNoticeDays: 9, cancelAutoApprove: true })).toEqual({
      allowed: true,
      noticeDays: 0,
      autoApprove: false,
      notify: false,
    });
    expect(cancelApprovedSettingOf({ code: 'EMERGENCY', employeeCancelApproved: false }).allowed).toBe(true);
    // A missing type fails closed.
    expect(cancelApprovedSettingOf(null).allowed).toBe(false);
  });

  it('the pure button predicate refuses every row the service refuses before looking at a date', () => {
    const on = cancelApprovedSettingOf({ code: 'ANNUAL', employeeCancelApproved: true });
    const row = { status: 'approved', durationType: 'full_day', parentGroupId: null, pendingCancellationId: null, unpaidDays: '0' };
    expect(employeeCancellableDates(row, [TODAY, MON], on, TODAY)).toEqual([MON]);
    expect(employeeCancellableDates({ ...row, status: 'pending' }, [MON], on, TODAY)).toBeNull();
    expect(employeeCancellableDates({ ...row, durationType: 'half_day_am' }, [MON], on, TODAY)).toBeNull();
    expect(employeeCancellableDates({ ...row, parentGroupId: 'g' }, [MON], on, TODAY)).toBeNull();
    expect(employeeCancellableDates({ ...row, parentGroupId: 'g', isCancellationSplit: true }, [MON], on, TODAY)).toEqual([MON]);
    expect(employeeCancellableDates({ ...row, pendingCancellationId: 'c' }, [MON], on, TODAY)).toBeNull();
    expect(employeeCancellableDates({ ...row, unpaidDays: '0.50' }, [MON], on, TODAY)).toBeNull();
    expect(employeeCancellableDates(row, [MON], { ...on, allowed: false }, TODAY)).toBeNull();
  });
});

describe('leave_cancellation_step — GRANT and RLS (CLAUDE.md §6)', () => {
  it('the app role holds its privileges, RLS is on, and the subject reads their own copied steps', async () => {
    const [grant] = (await owner.db.execute(
      sql`SELECT has_table_privilege('ai_hr_app', 'public.leave_cancellation_step', 'SELECT, INSERT, UPDATE, DELETE') AS ok,
                 (SELECT relrowsecurity FROM pg_class WHERE relname = 'leave_cancellation_step') AS rls`,
    )) as unknown as { ok: boolean; rls: boolean }[];
    expect(grant).toEqual({ ok: true, rls: true });

    await setLeaveApprovalPolicy(adminCtx(b), { companyId: b.companyId, levels: ['direct_manager', 'hr_admin'] });
    const res = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: MON,
      endDate: FRI,
      today: TODAY,
    });
    await decideLeave(mgrCtx, { leaveRequestId: res.leaveRequestId, decision: 'approved' });
    await decideLeave(adminCtx(b), { leaveRequestId: res.leaveRequestId, decision: 'approved' });
    const out = await requestLeaveCancellation(subjectCtx, { leaveRequestId: res.leaveRequestId, cancelDates: [WED], today: TODAY });

    const mine = await withTenant(subjectCtx, (tx) =>
      tx
        .select({ kind: schema.leaveCancellationStep.approverKind })
        .from(schema.leaveCancellationStep)
        .where(eq(schema.leaveCancellationStep.cancellationRequestId, out.cancellationRequestId))
        .orderBy(schema.leaveCancellationStep.stepIndex),
    );
    expect(mine.map((r) => r.kind)).toEqual(['direct_manager', 'hr_admin']);

    // A colleague with no line over the subject sees none of it.
    const peer = await hire('Peer');
    const uP = await createAppUser(b.tenantId, peer.personId, 'employee');
    const peerCtx: SessionContext = { tenantId: b.tenantId, userId: uP, personId: peer.personId, roles: ['employee'] };
    const theirs = await withTenant(peerCtx, (tx) =>
      tx
        .select({ id: schema.leaveCancellationStep.id })
        .from(schema.leaveCancellationStep)
        .where(eq(schema.leaveCancellationStep.cancellationRequestId, out.cancellationRequestId)),
    );
    expect(theirs).toEqual([]);
  });
});
