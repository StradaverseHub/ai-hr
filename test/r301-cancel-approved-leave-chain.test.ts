/**
 * r301 (board 83511d3b) · CANCEL APPROVED LEAVE — the SAME APPROVAL CHAIN, and who is told.
 *
 * The plan's promise: "When a cancellation needs re-approval, it goes through the same approval chain as the
 * original leave request, level by level, to the same people. While it waits, the leave shows as Pending
 * Cancellation. Approved: the leave is cancelled and the days go back. Rejected: the leave stays Approved and
 * nothing changes." And: "The employee is told when their cancellation is approved or rejected, and the
 * approver and HR are told when one is requested, if that setting is ticked."
 *
 * Arms:
 *   · a 2-level chain is COPIED onto the cancellation and walked in order — the level-1 approver cannot clear
 *     level 2, nothing is given back until the last level approves;
 *   · a rejection at level 2 leaves the leave approved and the balance untouched;
 *   · a survivor of an earlier partial cancellation (a NEW row, no steps of its own) copies the ORIGINAL
 *     request's steps — including a named approver — by following leave-request.split's splitFromRequestId;
 *   · the employee is notified on approval and on rejection (always); the approver + HR on request only when
 *     the leave type's notify box is ticked;
 *   · /approvals and the employee's own record read the current level.
 */
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { hireEmployee, setReportingLine } from '../core/org';
import { setLeaveApprovalPolicy } from '../core/leave-approval-policy';
import { assignApprovalTemplate, createApprovalTemplate } from '../core/leave-approval-template';
import { updateLeaveType } from '../core/admin';
import { adminCancelLeave, decideLeave, decideLeaveCancellation, requestLeave, requestLeaveCancellation } from '../core/leave';
import { dispatchNotifications } from '../core/notifications';
import { listPendingLeaveCancellations, pendingCancellationProgress } from '../core/read';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  adminCtx,
  closeAll,
  createAppUser,
  entitledCtx,
  eventTypesFor,
  ledgerBalance,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

let b: Base;
let subject: { personId: string; employmentId: string };
let subjectCtx: SessionContext;
let manager: { personId: string; employmentId: string };
let mgrCtx: SessionContext;
/** An HR administrator who IS an employee, so the notification fan-out has somebody to reach. */
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
    person: { fullName: name, primaryEmail: `r301c_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

const setRule = (p: { employeeCancelApproved?: boolean; cancelNoticeDays?: number; cancelAutoApprove?: boolean; cancelNotify?: boolean }) =>
  updateLeaveType(adminCtx(b), { id: b.annualLeaveTypeId, name: 'Annual Leave', ...p });

const stepsOf = (cancellationRequestId: string) =>
  owner.db
    .select({
      stepIndex: schema.leaveCancellationStep.stepIndex,
      kind: schema.leaveCancellationStep.approverKind,
      approver: schema.leaveCancellationStep.approverEmploymentId,
      status: schema.leaveCancellationStep.status,
    })
    .from(schema.leaveCancellationStep)
    .where(eq(schema.leaveCancellationStep.cancellationRequestId, cancellationRequestId))
    .orderBy(schema.leaveCancellationStep.stepIndex);

const crStatus = async (id: string) =>
  (
    await owner.db
      .select({ s: schema.leaveCancellationRequest.status })
      .from(schema.leaveCancellationRequest)
      .where(eq(schema.leaveCancellationRequest.id, id))
  )[0]?.s;

const leaveStatus = async (id: string) =>
  (await owner.db.select({ s: schema.leaveRequest.status }).from(schema.leaveRequest).where(eq(schema.leaveRequest.id, id)))[0]?.s;

const balance = () => ledgerBalance(subject.employmentId, b.annualLeaveTypeId);

/** Submit a Mon–Fri Annual Leave and walk the (2-level) chain to approval: manager, then HR. */
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

const notesOfKind = (kind: string) =>
  owner.db
    .select({ recipient: schema.notification.recipientEmploymentId, title: schema.notification.title, body: schema.notification.body })
    .from(schema.notification)
    .where(and(eq(schema.notification.tenantId, b.tenantId), eq(schema.notification.kind, kind)));

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
  subjectCtx = {
    tenantId: b.tenantId,
    userId: await createAppUser(b.tenantId, subject.personId, 'employee'),
    personId: subject.personId,
    roles: ['employee'],
  };
  manager = await hire('Manager');
  mgrCtx = {
    tenantId: b.tenantId,
    userId: await createAppUser(b.tenantId, manager.personId, 'manager'),
    personId: manager.personId,
    roles: ['manager'],
  };
  hr = await hire('HR Person');
  hrCtx = {
    tenantId: b.tenantId,
    userId: await createAppUser(b.tenantId, hr.personId, 'hr_admin'),
    personId: hr.personId,
    roles: ['hr_admin'],
  };
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

describe('RE-APPROVAL WALKS THE ORIGINAL 2-LEVEL CHAIN, IN ORDER', () => {
  it('copies both levels; level 1 cannot clear level 2; nothing comes back until the last level approves', async () => {
    const id = await approvedWeekTwoLevels();
    const start = await balance();
    const { cancellationRequestId: crId, status } = await requestLeaveCancellation(subjectCtx, {
      leaveRequestId: id,
      cancelDates: [WED],
      today: TODAY,
    });
    expect(status).toBe('pending');
    expect(await stepsOf(crId)).toEqual([
      { stepIndex: 0, kind: 'direct_manager', approver: null, status: 'pending' },
      { stepIndex: 1, kind: 'hr_admin', approver: null, status: 'pending' },
    ]);

    // /approvals reads the current level: level 1 of 2, the manager's.
    const [row1] = (await listPendingLeaveCancellations(hrCtx, [b.companyId])).filter((c) => c.id === crId);
    expect(row1).toMatchObject({ currentStepKind: 'direct_manager', currentStepIndex: 0, stepCount: 2 });
    // The employee's own record reads the same, as levels only.
    expect((await pendingCancellationProgress(subjectCtx, [crId])).get(crId)?.levels).toEqual([
      { stepIndex: 0, status: 'pending' },
      { stepIndex: 1, status: 'pending' },
    ]);

    // Level 1 — the manager.
    const d1 = await decideLeaveCancellation(mgrCtx, { cancellationRequestId: crId, decision: 'approved', deciderEmploymentId: manager.employmentId });
    expect(d1).toEqual({ status: 'pending', advancedTo: 'hr_admin' });
    expect(await crStatus(crId)).toBe('pending');
    expect(await leaveStatus(id)).toBe('approved');
    expect(await balance()).toBeCloseTo(start, 2);
    expect((await stepsOf(crId)).map((s) => s.status)).toEqual(['approved', 'pending']);
    expect(await eventTypesFor(b.tenantId, crId)).toEqual(['leave-cancellation.requested', 'leave-cancellation.step.approved']);
    const [row2] = (await listPendingLeaveCancellations(hrCtx, [b.companyId])).filter((c) => c.id === crId);
    expect(row2).toMatchObject({ currentStepKind: 'hr_admin', currentStepIndex: 1, stepCount: 2 });

    // The manager cannot clear the HR level — the order is enforced, not merely displayed.
    await expect(
      decideLeaveCancellation(mgrCtx, { cancellationRequestId: crId, decision: 'approved' }),
    ).rejects.toThrow(/Only HR can decide this leave cancellation/);
    // The employee cannot approve their own cancellation at any level.
    await expect(
      decideLeaveCancellation(subjectCtx, { cancellationRequestId: crId, decision: 'approved' }),
    ).rejects.toThrow();

    // Level 2 — HR. Now, and only now, the day comes back.
    const d2 = await decideLeaveCancellation(hrCtx, { cancellationRequestId: crId, decision: 'approved', deciderEmploymentId: hr.employmentId });
    expect(d2.status).toBe('approved');
    expect(d2.restoredDays).toBe(1);
    expect(await crStatus(crId)).toBe('approved');
    expect(await balance()).toBeCloseTo(start + 1, 2);
    expect((await stepsOf(crId)).map((s) => s.status)).toEqual(['approved', 'approved']);
  });

  it('a rejection at level 2 leaves the leave approved and the balance exactly as it was', async () => {
    const id = await approvedWeekTwoLevels();
    const start = await balance();
    const { cancellationRequestId: crId } = await requestLeaveCancellation(subjectCtx, {
      leaveRequestId: id,
      cancelDates: [WED, THU],
      today: TODAY,
    });
    await decideLeaveCancellation(mgrCtx, { cancellationRequestId: crId, decision: 'approved' });
    const d2 = await decideLeaveCancellation(hrCtx, { cancellationRequestId: crId, decision: 'rejected' });
    expect(d2.status).toBe('rejected');
    expect(await crStatus(crId)).toBe('rejected');
    expect((await stepsOf(crId)).map((s) => s.status)).toEqual(['approved', 'rejected']);
    expect(await leaveStatus(id)).toBe('approved');
    const [row] = await owner.db
      .select({ start: schema.leaveRequest.startDate, end: schema.leaveRequest.endDate, g: schema.leaveRequest.parentGroupId })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.id, id));
    expect(row).toEqual({ start: MON, end: FRI, g: null }); // never split
    expect(await balance()).toBeCloseTo(start, 2);
    const payload = (
      await owner.db
        .select({ p: schema.domainEvent.payload })
        .from(schema.domainEvent)
        .where(and(eq(schema.domainEvent.aggregateId, crId), eq(schema.domainEvent.eventType, 'leave-cancellation.rejected')))
    )[0].p as Record<string, unknown>;
    expect(payload).toMatchObject({ step: 1, kind: 'hr_admin' });
  });
});

describe('A SPLIT SURVIVOR COPIES THE ORIGINAL REQUEST’S STEPS', () => {
  it('a new row cut by an earlier cancellation has no steps of its own; its cancellation copies the original’s, named approver included', async () => {
    // The original chain names a PERSON at level 2, so "the same people" is observable on the copy. The named
    // person is the manager's own manager: a named approver must be able to SEE the request (a stranger cannot
    // — test/r293-approval-builder.test.ts pins that pre-existing limit), and being named is what lets them
    // clear the level, not the reporting line (the level's kind is specific_employee, not manager_manager).
    const named = await hire('Named Approver');
    const namedCtx: SessionContext = {
      tenantId: b.tenantId,
      userId: await createAppUser(b.tenantId, named.personId, 'manager'),
      personId: named.personId,
      roles: ['manager'],
    };
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: manager.employmentId,
      managerEmploymentId: named.employmentId,
      lineType: 'administrative',
      validFrom: '2024-01-01',
    });
    const { id: templateId } = await createApprovalTemplate(adminCtx(b), {
      name: `T ${randomUUID().slice(0, 6)}`,
      description: null,
      levels: ['direct_manager', { kind: 'specific_employee', employmentId: named.employmentId }],
    });
    await assignApprovalTemplate(adminCtx(b), { templateId, companyIds: [b.companyId], leaveTypeIds: [b.annualLeaveTypeId] });

    const res = await requestLeave(subjectCtx, {
      employmentId: subject.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      startDate: MON,
      endDate: FRI,
      today: TODAY,
    });
    await decideLeave(mgrCtx, { leaveRequestId: res.leaveRequestId, decision: 'approved' });
    await decideLeave(namedCtx, { leaveRequestId: res.leaveRequestId, decision: 'approved' });

    // First cancellation: give back Tuesday. Walk both levels. The week splits: Mon (the reused original row),
    // Tue (cancelled), Wed–Fri (a NEW row, cut from the original).
    const c1 = await requestLeaveCancellation(subjectCtx, { leaveRequestId: res.leaveRequestId, cancelDates: [TUE], today: TODAY });
    await decideLeaveCancellation(mgrCtx, { cancellationRequestId: c1.cancellationRequestId, decision: 'approved' });
    await decideLeaveCancellation(namedCtx, { cancellationRequestId: c1.cancellationRequestId, decision: 'approved' });
    const [orig] = await owner.db
      .select({ g: schema.leaveRequest.parentGroupId })
      .from(schema.leaveRequest)
      .where(eq(schema.leaveRequest.id, res.leaveRequestId));
    const [survivor] = await owner.db
      .select({ id: schema.leaveRequest.id })
      .from(schema.leaveRequest)
      .where(and(eq(schema.leaveRequest.parentGroupId, orig.g!), eq(schema.leaveRequest.startDate, WED)));
    expect(survivor.id).not.toBe(res.leaveRequestId);
    const survivorOwnSteps = await owner.db
      .select({ id: schema.leaveApprovalStep.id })
      .from(schema.leaveApprovalStep)
      .where(eq(schema.leaveApprovalStep.leaveRequestId, survivor.id));
    expect(survivorOwnSteps).toEqual([]);

    // Second cancellation, on the survivor: the ORIGINAL chain is copied — same kinds, same named person.
    const c2 = await requestLeaveCancellation(subjectCtx, { leaveRequestId: survivor.id, cancelDates: [THU], today: TODAY });
    expect(await stepsOf(c2.cancellationRequestId)).toEqual([
      { stepIndex: 0, kind: 'direct_manager', approver: null, status: 'pending' },
      { stepIndex: 1, kind: 'specific_employee', approver: named.employmentId, status: 'pending' },
    ]);
    // …and it is walked by the same people: the manager, then the named approver (a bystander cannot).
    await decideLeaveCancellation(mgrCtx, { cancellationRequestId: c2.cancellationRequestId, decision: 'approved' });
    const bystander = await hire('Bystander');
    const bystanderCtx: SessionContext = {
      tenantId: b.tenantId,
      userId: await createAppUser(b.tenantId, bystander.personId, 'manager'),
      personId: bystander.personId,
      roles: ['manager'],
    };
    await expect(
      decideLeaveCancellation(bystanderCtx, { cancellationRequestId: c2.cancellationRequestId, decision: 'approved' }),
    ).rejects.toThrow();
    const d = await decideLeaveCancellation(namedCtx, { cancellationRequestId: c2.cancellationRequestId, decision: 'approved' });
    expect(d.status).toBe('approved');
    expect(d.restoredDays).toBe(1);
  });
});

describe('WHO IS TOLD (in-app notifications)', () => {
  it('the employee is told on approval and on rejection; with notify ON the approver and HR are told on request', async () => {
    await setModule(b.tenantId, 'notifications', 'active');
    await setRule({ employeeCancelApproved: true, cancelNotify: true });
    const id = await approvedWeekTwoLevels();

    const c1 = await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [WED], today: TODAY });
    await dispatchNotifications(await entitledCtx(b));
    const requested = await notesOfKind('leave.cancellation-requested');
    const requestedTo = requested.map((n) => n.recipient).sort();
    // Level 1's approver (the manager) and HR — never the employee who asked.
    expect(requestedTo).toEqual([hr.employmentId, manager.employmentId].sort());
    expect(requested[0].body).toContain('Annual Leave');

    await decideLeaveCancellation(mgrCtx, { cancellationRequestId: c1.cancellationRequestId, decision: 'approved' });
    await decideLeaveCancellation(hrCtx, { cancellationRequestId: c1.cancellationRequestId, decision: 'approved' });
    const c2 = await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [MON], today: TODAY });
    await decideLeaveCancellation(mgrCtx, { cancellationRequestId: c2.cancellationRequestId, decision: 'rejected' });
    await dispatchNotifications(await entitledCtx(b));

    const approved = await notesOfKind('leave.cancellation-approved');
    expect(approved.map((n) => n.recipient)).toEqual([subject.employmentId]);
    expect(approved[0].body).toContain(WED);
    expect(approved[0].body).toContain('1 day(s) went back to your balance');
    const rejected = await notesOfKind('leave.cancellation-rejected');
    expect(rejected.map((n) => n.recipient)).toEqual([subject.employmentId]);
    expect(rejected[0].body).toContain('The leave stays approved');
  });

  it('with notify OFF nobody is told about the request — the employee is still told the outcome', async () => {
    await setModule(b.tenantId, 'notifications', 'active');
    await setRule({ employeeCancelApproved: true, cancelNotify: false });
    const id = await approvedWeekTwoLevels();
    const c = await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [WED], today: TODAY });
    await decideLeaveCancellation(mgrCtx, { cancellationRequestId: c.cancellationRequestId, decision: 'approved' });
    await decideLeaveCancellation(hrCtx, { cancellationRequestId: c.cancellationRequestId, decision: 'approved' });
    await dispatchNotifications(await entitledCtx(b));
    expect(await notesOfKind('leave.cancellation-requested')).toEqual([]);
    expect((await notesOfKind('leave.cancellation-approved')).map((n) => n.recipient)).toEqual([subject.employmentId]);
  });

  it('an automatic approval tells the employee it was approved automatically', async () => {
    await setModule(b.tenantId, 'notifications', 'active');
    await setRule({ employeeCancelApproved: true, cancelAutoApprove: true });
    const id = await approvedWeekTwoLevels();
    await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [FRI], today: TODAY });
    await dispatchNotifications(await entitledCtx(b));
    const approved = await notesOfKind('leave.cancellation-approved');
    expect(approved.map((n) => n.recipient)).toEqual([subject.employmentId]);
    expect(approved[0].body).toContain('approved automatically');
  });

  it('HR cancelling the whole leave closes a pending give-back WITHOUT telling the employee "not approved"', async () => {
    await setModule(b.tenantId, 'notifications', 'active');
    const id = await approvedWeekTwoLevels();
    await requestLeaveCancellation(subjectCtx, { leaveRequestId: id, cancelDates: [WED], today: TODAY });
    await adminCancelLeave(hrCtx, { leaveRequestId: id, cancelledByEmploymentId: hr.employmentId });
    await dispatchNotifications(await entitledCtx(b));
    expect(await notesOfKind('leave.cancellation-rejected')).toEqual([]);
    expect((await notesOfKind('leave.admin-cancelled')).map((n) => n.recipient)).toEqual([subject.employmentId]);
  });
});
