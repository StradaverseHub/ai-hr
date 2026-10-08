/**
 * 1e9145d4 · PLAN OT — overtime agreed BEFORE it is worked.
 *
 * The premise was PARTLY BUILT. An OT-only attendance_correction (ADR-0069) could always be FILED for a
 * future date — nothing bounded the date — but it could never be APPROVED: decideAttendanceCorrection's
 * OT-only branch looked up the day's attendance row and threw "No attendance record exists for this date to
 * attach overtime to", which is true of every day nobody has worked yet. So the form advertised
 * pre-approval and the approver hit a wall.
 *
 * WHAT THIS FILE PINS, in the order the risk sits:
 *
 *  1 · The blocker is gone: a future-dated plan APPROVES, and writes NOTHING to attendance (a placeholder
 *      row would corrupt attendanceMonthSummary's absence/leave counting and the payroll OT prefill).
 *  2 · The hours LAND when the day materialises — on clock-out, and on a terminal import — resolved
 *      against what was actually clocked through each of the four ot_approval_calculation options.
 *  3 · They land AT MOST ONCE, and a later punch cannot silently wipe them.
 *  4 · *** THE SILENT REGRESSION. *** The replacement-leave credit that a rest-day / public-holiday OT
 *      approval mints today must SURVIVE pre-approval. maybeAutoAccrueOnApprovalTx throws
 *      ToilNoOvertimeError when there is no attendance row, and decideAttendanceCorrection SWALLOWS that
 *      error so auto-accrual never blocks an approval — so a naive deferred branch would stop minting the
 *      credit with no error anywhere. The accrual therefore moves to the application step, and the credit's
 *      Request Date must still be the employee's request date (00307068), not the clock-out date.
 *  5 · THE REGRESSION LINE: a PAST-dated OT request with no attendance row still throws, byte-identically.
 *      Pre-approval must not become "overtime can be banked against a day nobody worked".
 *  6 · One approved plan per date, withdrawal in each allowed and disallowed state, the cap arithmetic at
 *      exactly 104 hours, and rest-day / public-holiday classification on a FUTURE date.
 *
 * FIXED FUTURE DATES (2027) rather than "today + 1": the deferral discriminator is the real calendar day,
 * and a test that computes its own future date drifts into the past the moment it is pinned to a month.
 * checkIn/checkOut take the date explicitly, so a 2027 day can be clocked here without touching the clock.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
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
import { importPunchCsv, previewPunchCsv } from './helpers/punch-import';
import { resolveEntitlementsTx } from '../core/entitlements';
import { hireEmployee, setReportingLine } from '../core/org';
import { dispatchNotifications } from '../core/notifications';
import { setCompensation } from '../core/comp';
import {
  cancelPlannedOvertime,
  checkIn,
  checkOut,
  dayTypeFor,
  decideAttendanceCorrection,
  myOvertimePlans,
  otMonthToDateMinutes,
  OT_CAP_MINUTES,
  // ec30b2e9 (r364) — the two typed refusals of a second overtime figure for one date. Asserted by CLASS,
  // not only by message text: the action layer branches on the class to pick which localized sentence the
  // employee reads, so a test that only matched the English words would pass with the wrong branch wired.
  AttendanceCorrectionFutureDateError,
  OvertimeAlreadyCountedError,
  OvertimePlanAlreadyApprovedError,
  requestAttendanceCorrection,
  resolveApprovedOt,
  setAttendancePolicy,
  type OtApprovalMethod,
} from '../core/attendance';
import { setRestDay } from '../core/roster';
import { setToilPolicy, type ToilPolicyInput } from '../core/toil';
import type { SessionContext } from '../db/client';
import { todayInKualaLumpur } from '../lib/hr-date';

let b: Base;

// 2027-06-02 is a Wednesday (an ordinary working day under the default Mon–Fri policy); 2027-06-05 is the
// Saturday of the same week, made a rostered rest day where a test needs one. 2025 is unambiguously past.
const FUTURE = '2027-06-02';
const FUTURE_2 = '2027-06-03';
const FUTURE_REST = '2027-06-05';
const FUTURE_HOLIDAY = '2027-06-04';
const PAST = '2025-06-04';
// ec30b2e9 (r364) — the Saturday of the same past week, made an explicit rostered rest day where the
// replacement-leave case needs one. PAST is a Wednesday; 2025-06-07 is the Saturday, derived once here
// rather than computed from the clock (the deferral discriminator is the real calendar day, §header).
const PAST_REST = '2025-06-07';

const uniqEmail = () => `planot_${Math.random().toString(36).slice(2)}@t.local`;

const BASE_POLICY = (companyId: string) => ({
  companyId,
  workStart: '09:00',
  workEnd: '18:00',
  breakMinutes: 60,
  lateAfter: '09:15',
  halfDayBefore: '13:00',
  workingDays: [1, 2, 3, 4, 5],
});

async function hire(code?: string) {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Plan OT Worker', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
    ...(code ? { employeeCode: code } : {}),
  });
  await setCompensation(a, {
    employmentId: e.employmentId,
    basicSalary: 5000,
    monthlyAllowance: 0,
    effectiveFrom: '2024-01-01',
  });
  return { a, employmentId: e.employmentId, personId: e.personId };
}

/** A SessionContext for the hired employee themselves — withdrawal is subject-only, so it cannot be
 *  exercised through the admin fixture context. */
async function employeeCtx(personId: string): Promise<SessionContext> {
  const userId = await createAppUser(b.tenantId, personId, 'employee');
  // r292: resolve a REAL entitlement snapshot. The pack services are now bound to withModuleTenant(),
  // so a context with no snapshot throws EntitlementsUnresolvedError. Do NOT swap this for
  // `entitlementsExempt`: every gated pack (attendance, payroll, claims, performance) is billable: true,
  // and an exempt context asked about a billable module throws EntitlementsExemptForBillableError by
  // design — an exemption asserts "entitlements do not apply to me", true only of a core module.
  const entitlements = await owner.db.transaction((tx) => resolveEntitlementsTx(tx, b.tenantId));
  return { tenantId: b.tenantId, userId, personId, roles: ['employee'], entitlements } as SessionContext;
}

const attendanceRow = async (employmentId: string, date: string) =>
  (
    await owner.db
      .select()
      .from(schema.attendance)
      .where(and(eq(schema.attendance.employmentId, employmentId), eq(schema.attendance.attendanceDate, date)))
  )[0];

const correctionRow = async (correctionId: string) =>
  (
    await owner.db
      .select()
      .from(schema.attendanceCorrection)
      .where(eq(schema.attendanceCorrection.id, correctionId))
  )[0];

const toilPolicyInput = (companyId: string, over: Partial<ToilPolicyInput> = {}): ToilPolicyInput => ({
  companyId,
  enabled: true,
  accrualBasis: 'hours_worked',
  expiryDays: 90,
  onExpiry: 'convert_to_pay',
  allowFirstScheduleEligible: false,
  autoAccrueOnApproval: true,
  carryForwardAtYearEnd: false,
  ...over,
});

/** Notifications minted for one employment, newest first. */
const notificationsFor = async (employmentId: string) =>
  owner.db
    .select({ kind: schema.notification.kind, title: schema.notification.title, body: schema.notification.body })
    .from(schema.notification)
    .where(eq(schema.notification.recipientEmploymentId, employmentId));

const replacementBalance = async (employmentId: string): Promise<number> => {
  const [row] = await owner.db
    .select({ bal: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .innerJoin(schema.leaveType, eq(schema.leaveType.id, schema.leaveLedger.leaveTypeId))
    .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveType.code, 'REPLACEMENT')));
  return Number(row?.bal ?? 0);
};

/** File an OT-only plan the way the Apply OT Plan form does. */
const filePlan = (
  ctx: SessionContext,
  employmentId: string,
  date: string,
  minutes: number,
  over: Partial<Parameters<typeof requestAttendanceCorrection>[1]> = {},
) =>
  requestAttendanceCorrection(ctx, {
    employmentId,
    date,
    requestedOtMinutes: minutes,
    reason: 'Cut-over rehearsal for the new server',
    plannedStartTime: '18:00',
    plannedEndTime: '21:00',
    otReasonCategory: 'project_deadline',
    ...over,
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
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('1 · approval works AHEAD of the date (the item)', () => {
  it('approves a FUTURE-dated OT plan, stamps the plan, and writes NOTHING to attendance', async () => {
    const { a, employmentId } = await hire();
    const { correctionId } = await filePlan(a, employmentId, FUTURE, 180);

    const res = await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    expect(res.status).toBe('approved');
    expect(res.deferred, 'a future-dated plan is HELD, not applied').toBe(true);

    const row = await correctionRow(correctionId);
    expect(row.status).toBe('approved');
    // The figure the approver agreed to, and the rule that will resolve it on the day.
    expect(row.approvedOtMinutes).toBe(180);
    expect(row.otApprovalMethod).toBeTruthy();
    expect(row.appliedAt, 'not counted yet').toBeNull();
    // The form's own fields survived the round trip.
    expect(row.plannedStartTime).toBe('18:00:00');
    expect(row.plannedEndTime).toBe('21:00:00');
    expect(row.otReasonCategory).toBe('project_deadline');

    // NO PLACEHOLDER ROW. This is the assertion that protects attendanceMonthSummary (absence/leave/45h)
    // and prefillOvertimeFromAttendance from a day nobody has lived through.
    expect(await attendanceRow(employmentId, FUTURE)).toBeUndefined();
  });

  it('THE REGRESSION LINE: a PAST-dated OT request with no attendance row still refuses', async () => {
    const { a, employmentId } = await hire();
    const { correctionId } = await filePlan(a, employmentId, PAST, 120);
    await expect(decideAttendanceCorrection(a, { correctionId, decision: 'approved' })).rejects.toThrow(
      /No attendance record exists/i,
    );
  });

  it('a past-dated OT request against a WORKED day still applies immediately (unchanged)', async () => {
    const { a, employmentId } = await hire();
    await setAttendancePolicy(a, { ...BASE_POLICY(b.companyId), otApprovalCalculation: 'requested' });
    await checkIn(a, { employmentId, date: PAST, time: '09:00' });
    await checkOut(a, { employmentId, date: PAST, time: '20:00' });
    const { correctionId } = await filePlan(a, employmentId, PAST, 180, { plannedStartTime: null, plannedEndTime: null });

    const res = await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    expect(res.deferred, 'past dates keep the immediate path').toBe(false);
    expect((await attendanceRow(employmentId, PAST)).otMinutes).toBe(180);
    // applied_at means "these hours are on the day", so the immediate path stamps it too. Only a DEFERRED
    // approval leaves it null. The two assertions below are what that buys.
    expect((await correctionRow(correctionId)).appliedAt).not.toBeNull();
  });

  it('an IMMEDIATELY approved OT figure is not double-counted against the monthly ceiling', async () => {
    // If the immediate path left applied_at null, an already-counted approval would still match
    // "approved, unapplied" — and its minutes would be added to the attendance row's own.
    const { a, employmentId } = await hire();
    await setAttendancePolicy(a, { ...BASE_POLICY(b.companyId), otApprovalCalculation: 'requested' });
    await checkIn(a, { employmentId, date: PAST, time: '09:00' });
    await checkOut(a, { employmentId, date: PAST, time: '20:00' });
    const { correctionId } = await filePlan(a, employmentId, PAST, 180, { plannedStartTime: null, plannedEndTime: null });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });

    const cap = await otMonthToDateMinutes(a, employmentId, PAST);
    expect(cap.recordedMinutes).toBe(180);
    expect(cap.plannedMinutes, 'already on the day ⇒ no longer "planned"').toBe(0);
    expect(cap.totalMinutes).toBe(180);
  });

  it('an IMMEDIATELY approved OT figure cannot be landed a second time by a later clocking', async () => {
    const { a, employmentId } = await hire();
    await setAttendancePolicy(a, { ...BASE_POLICY(b.companyId), otApprovalCalculation: 'requested' });
    await checkIn(a, { employmentId, date: PAST, time: '09:00' });
    await checkOut(a, { employmentId, date: PAST, time: '20:00' });
    const { correctionId } = await filePlan(a, employmentId, PAST, 180, { plannedStartTime: null, plannedEndTime: null });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    const stampedAt = (await correctionRow(correctionId)).appliedAt;

    await checkIn(a, { employmentId, date: PAST, time: '21:00' });
    await checkOut(a, { employmentId, date: PAST, time: '22:00' });

    expect((await correctionRow(correctionId)).appliedAt?.getTime()).toBe(stampedAt?.getTime());
    // And, as a bonus of the same rule, the approved figure survives the later punch instead of being
    // silently re-derived away — which is what happened before this change.
    expect((await attendanceRow(employmentId, PAST)).otMinutes).toBe(180);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('2 · the plan LANDS when the day is worked', () => {
  // Clocked 09:00→20:00 = 660 span − 60 break = 600 worked against a 480 schedule ⇒ engine OT = 120.
  // The plan asks for 180. Each company rule resolves that pair differently, and the resolution must
  // happen at APPLICATION time (against the real clocking), not at approval time (against nothing).
  const SYSTEM_OT = 120;
  const REQUESTED = 180;
  const methods: OtApprovalMethod[] = ['requested', 'system_calculated', 'smaller_of', 'greater_of'];

  it.each(methods)('ot_approval_calculation = %s resolves against what was actually clocked', async (method) => {
    const { a, employmentId } = await hire();
    await setAttendancePolicy(a, { ...BASE_POLICY(b.companyId), otApprovalCalculation: method });
    const { correctionId } = await filePlan(a, employmentId, FUTURE, REQUESTED);
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });

    await checkIn(a, { employmentId, date: FUTURE, time: '09:00' });
    const out = await checkOut(a, { employmentId, date: FUTURE, time: '20:00' });

    const expected = resolveApprovedOt(REQUESTED, SYSTEM_OT, method);
    expect(out.otMinutes, 'the clock-out reports the figure that landed, not the raw derived one').toBe(expected);
    expect((await attendanceRow(employmentId, FUTURE)).otMinutes).toBe(expected);

    const row = await correctionRow(correctionId);
    expect(row.appliedAt, 'stamped the moment it landed').not.toBeNull();
    expect(row.approvedOtMinutes, 'the plan records the FINAL figure, not the provisional one').toBe(expected);
  });

  it('the per-rate split is rewritten from the figure that landed (the buckets still sum)', async () => {
    const { a, employmentId } = await hire();
    await setAttendancePolicy(a, { ...BASE_POLICY(b.companyId), otApprovalCalculation: 'requested' });
    const { correctionId } = await filePlan(a, employmentId, FUTURE, REQUESTED);
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    await checkIn(a, { employmentId, date: FUTURE, time: '09:00' });
    await checkOut(a, { employmentId, date: FUTURE, time: '20:00' });

    const row = await attendanceRow(employmentId, FUTURE);
    const split =
      (row.otFlatMinutes ?? 0) +
      (row.ot00Minutes ?? 0) +
      (row.ot10Minutes ?? 0) +
      (row.ot15Minutes ?? 0) +
      (row.ot20Minutes ?? 0) +
      (row.ot30Minutes ?? 0);
    expect(split).toBe(row.otMinutes);
    expect(row.otMinutes).toBe(REQUESTED);
  });

  it('lands EXACTLY ONCE — a later clocking cannot re-bank it, and cannot wipe it either', async () => {
    const { a, employmentId } = await hire();
    // system_calculated makes the landed figure (120) DIFFERENT from what a re-derivation would produce
    // after the extra punches, so a silent re-resolution would be visible here.
    await setAttendancePolicy(a, { ...BASE_POLICY(b.companyId), otApprovalCalculation: 'system_calculated' });
    const { correctionId } = await filePlan(a, employmentId, FUTURE, REQUESTED);
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });

    await checkIn(a, { employmentId, date: FUTURE, time: '09:00' });
    await checkOut(a, { employmentId, date: FUTURE, time: '20:00' });
    const landedAt = (await correctionRow(correctionId)).appliedAt;
    expect(landedAt).not.toBeNull();
    expect((await attendanceRow(employmentId, FUTURE)).otMinutes).toBe(SYSTEM_OT);

    // A second in/out pair on the same day. recomputeDayFromPunches re-derives ot_minutes from first-in /
    // last-out, which without the re-assertion would quietly overwrite the approved figure.
    await checkIn(a, { employmentId, date: FUTURE, time: '21:00' });
    await checkOut(a, { employmentId, date: FUTURE, time: '22:00' });

    const after = await correctionRow(correctionId);
    expect(after.appliedAt?.getTime(), 'the applied stamp is claimed once and never re-claimed').toBe(
      landedAt?.getTime(),
    );
    expect(after.approvedOtMinutes, 'the approved figure is not re-resolved behind the approver').toBe(SYSTEM_OT);
    expect(
      (await attendanceRow(employmentId, FUTURE)).otMinutes,
      'the hours a human approved survive a later punch',
    ).toBe(SYSTEM_OT);
  });

  it('a TERMINAL IMPORT of the day lands the plan too', async () => {
    const { a, employmentId } = await hire('PLANOT1');
    await setAttendancePolicy(a, { ...BASE_POLICY(b.companyId), otApprovalCalculation: 'requested' });
    const { correctionId } = await filePlan(a, employmentId, FUTURE, REQUESTED);
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });

    // r424 — a clocking file can no longer carry a FUTURE date (Import Clocking Data refuses one, plan
    // item 13), and the clock cannot be moved in a test. So the approved, not-yet-landed plan's day is
    // moved into the past — which is exactly what the passing of time does to it — and the import of
    // that day is what lands it.
    await owner.db.update(schema.attendanceCorrection).set({ attendanceDate: PAST }).where(eq(schema.attendanceCorrection.id, correctionId));
    const csv = `staff,time\nPLANOT1,${PAST} 09:00:00\nPLANOT1,${PAST} 20:00:00`;
    const r = await importPunchCsv(a, csv);
    expect(r.imported).toBe(1);
    expect((await attendanceRow(employmentId, PAST)).otMinutes).toBe(REQUESTED);
    expect((await correctionRow(correctionId)).appliedAt).not.toBeNull();
  });

  it('a DRY-RUN import consumes nothing', async () => {
    const { a, employmentId } = await hire('PLANOT2');
    const { correctionId } = await filePlan(a, employmentId, FUTURE, REQUESTED);
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });

    // r424 — Validate is the dry run; the plan's day is moved into the past as in the case above, so the
    // lines are VALID and the only thing standing between them and the plan is that nothing is written.
    await owner.db.update(schema.attendanceCorrection).set({ attendanceDate: PAST }).where(eq(schema.attendanceCorrection.id, correctionId));
    const csv = `staff,time\nPLANOT2,${PAST} 09:00:00\nPLANOT2,${PAST} 20:00:00`;
    const p = await previewPunchCsv(a, csv);
    expect(p.counts.valid).toBe(2);
    expect((await correctionRow(correctionId)).appliedAt).toBeNull();
    expect(await attendanceRow(employmentId, PAST)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('3 · *** the replacement-leave credit survives pre-approval ***', () => {
  it('a pre-approved REST-DAY plan mints the RL credit when the day is worked, dated to the REQUEST', async () => {
    const { employmentId } = await hire(); // hiring is fixture work and runs on adminCtx inside hire()
    await setModule(b.tenantId, 'toil', 'active');
    const a = await entitledCtx(b); // a REAL snapshot, resolved AFTER the module row exists
    await setAttendancePolicy(a, { ...BASE_POLICY(b.companyId), otApprovalCalculation: 'requested' });
    await setToilPolicy(a, toilPolicyInput(b.companyId)); // autoAccrueOnApproval on
    await setRestDay(a, { employmentId, shiftDate: FUTURE_REST });

    const { correctionId } = await filePlan(a, employmentId, FUTURE_REST, 240, {
      reason: 'Weekend cut-over cover',
    });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });

    // Nothing yet — and this is CORRECT, not the bug. There is no worked day to bank against.
    expect(await replacementBalance(employmentId)).toBe(0);

    await checkIn(a, { employmentId, date: FUTURE_REST, time: '08:00' });
    await checkOut(a, { employmentId, date: FUTURE_REST, time: '17:00' });

    // 240 approved minutes / 480 standard day = 0.5 day, on the hours_worked basis — the same arithmetic
    // the immediate path produces today. If the accrual had been left at the approval step this would be 0
    // and NOTHING would have said so.
    expect(await replacementBalance(employmentId)).toBe(0.5);

    // 00307068 — the credit's Request Date is the day the EMPLOYEE asked, not the day they clocked out.
    const [accrual] = await owner.db
      .select({ requestedOn: schema.toilAccrual.requestedOn })
      .from(schema.toilAccrual)
      .where(eq(schema.toilAccrual.employmentId, employmentId));
    // ⚠️ THE KUALA LUMPUR DATE (r324), matching what the code now stamps. This derived the expectation
    // with `.toISOString()` — a UTC date from an instant, which CLAUDE.md §8 forbids "fixtures included"
    // — and so disagreed with the stamped value for any run between midnight and 08:00 MYT. The code
    // side of the same defect is fixed in core/attendance.ts in this round.
    const requestedOnCorrection = todayInKualaLumpur((await correctionRow(correctionId)).createdAt);
    expect(accrual?.requestedOn).toBe(requestedOnCorrection);
  });

  it('does not mint a SECOND credit when the day is clocked again', async () => {
    const { employmentId } = await hire();
    await setModule(b.tenantId, 'toil', 'active');
    const a = await entitledCtx(b);
    await setAttendancePolicy(a, { ...BASE_POLICY(b.companyId), otApprovalCalculation: 'requested' });
    await setToilPolicy(a, toilPolicyInput(b.companyId));
    await setRestDay(a, { employmentId, shiftDate: FUTURE_REST });
    const { correctionId } = await filePlan(a, employmentId, FUTURE_REST, 240, { reason: 'Weekend cover' });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });

    await checkIn(a, { employmentId, date: FUTURE_REST, time: '08:00' });
    await checkOut(a, { employmentId, date: FUTURE_REST, time: '17:00' });
    await checkIn(a, { employmentId, date: FUTURE_REST, time: '18:00' });
    await checkOut(a, { employmentId, date: FUTURE_REST, time: '19:00' });

    expect(await replacementBalance(employmentId)).toBe(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('4 · one approved plan per date', () => {
  it('refuses a second OT plan for a date that already has an APPROVED, unapplied one', async () => {
    const { a, employmentId } = await hire();
    const { correctionId } = await filePlan(a, employmentId, FUTURE, 180);
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });

    await expect(filePlan(a, employmentId, FUTURE, 60)).rejects.toThrow(/already have an approved overtime plan/i);
  });

  it('a WITHDRAWN plan leaves the date free again', async () => {
    const { a, employmentId, personId } = await hire();
    const emp = await employeeCtx(personId);
    const { correctionId } = await filePlan(a, employmentId, FUTURE, 180);
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    await cancelPlannedOvertime(emp, { correctionId });

    await expect(filePlan(a, employmentId, FUTURE, 60)).resolves.toBeTruthy();
  });

  it('a REJECTED plan leaves the date free (nothing was agreed)', async () => {
    const { a, employmentId } = await hire();
    const { correctionId } = await filePlan(a, employmentId, FUTURE, 180);
    await decideAttendanceCorrection(a, { correctionId, decision: 'rejected', rejectReason: 'Fixture rejection explanation' });
    await expect(filePlan(a, employmentId, FUTURE, 60)).resolves.toBeTruthy();
  });

  it('a future CLOCK correction is refused even when an approved OT plan exists', async () => {
    // The guard is about two overtime figures for one day, not about punches. A clock fix is a different
    // request answering a different question, and blocking it would be scope the plan does not ask for.
    const { a, employmentId } = await hire();
    const { correctionId } = await filePlan(a, employmentId, FUTURE, 180);
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    await expect(
      requestAttendanceCorrection(a, { employmentId, date: FUTURE, checkIn: '09:00', reason: 'forgot' }),
    ).rejects.toBeInstanceOf(AttendanceCorrectionFutureDateError);
  });

  // ── ec30b2e9 (r364) · THE WINDOW THE FOUR CASES ABOVE DID NOT COVER ────────────────────────────────
  //
  // THE EXISTING FIRST CASE IN THIS BLOCK PINS "approved, unapplied" AND NOTHING ELSE, and that state is
  // reachable only for a FUTURE date. For a date that is today or past — which is every date on which a
  // first plan can already have LANDED — approval writes the hours and stamps applied_at in the same
  // transaction, so the plan is never "approved and unapplied" and `liveOtPlanTx` never sees it. A second
  // plan was therefore accepted, and approving it ran a bare `update attendance set ot_minutes = …`:
  // REPLACE, not add, at approval time, with nothing on any screen saying a figure had been displaced.
  //
  // EVERY ASSERTION BELOW IS A MONEY ASSERTION, so each one first asserts ITS OWN PREMISE — that the day
  // really does carry a non-zero approved figure. A fixture whose day has no overtime on it makes the
  // whole block pass whatever the service does.
  //
  // (b) IS NOT A COURTESY CASE. It is (a)'s non-vacuity partner: the guard (a) needs sits inside
  // `if (hasOt)`, and `hasOt` is ALSO true of the clock correction the refusal tells the employee to use.
  // Without (b), widening the guard to every OT-bearing request would pass (a) and would refuse the remedy
  // in the same breath as recommending it.
  //
  // d16237da (r366) — AND IT IS (e)'s PARTNER TOO, which is the sharper version of the same point. (e)
  // widens WHAT COUNTS the day; (b) pins WHICH INCOMING REQUEST is refused. Making (e) pass by dropping the
  // call site's `checkIn == null` instead of the helper's `proposed_check_in IS NULL` turns (b) red, and
  // that is the only thing separating this round from a refusal that refuses its own recommended remedy.
  describe('once the hours have been COUNTED (r364)', () => {
    /** A past day worked 09:00→20:00 (engine OT = 120) with a 180-minute plan approved and LANDED on it. */
    async function countedPastDay() {
      const { a, employmentId } = await hire();
      await setAttendancePolicy(a, { ...BASE_POLICY(b.companyId), otApprovalCalculation: 'requested' });
      await checkIn(a, { employmentId, date: PAST, time: '09:00' });
      await checkOut(a, { employmentId, date: PAST, time: '20:00' });
      const { correctionId } = await filePlan(a, employmentId, PAST, 180, {
        plannedStartTime: null,
        plannedEndTime: null,
      });
      await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
      // THE PREMISE, ASSERTED IN ITS OWN RIGHT — not as a by-product of the case under test.
      expect((await attendanceRow(employmentId, PAST)).otMinutes, 'the first plan must really have counted').toBe(180);
      expect(
        (await correctionRow(correctionId)).appliedAt,
        '"counted" means applied_at is stamped — without it this fixture is testing the wrong window',
      ).not.toBeNull();
      return { a, employmentId, planId: correctionId };
    }

    it('(a) REFUSES a second OT-ONLY plan on a date whose overtime has already been counted', async () => {
      const { a, employmentId } = await countedPastDay();

      await expect(
        filePlan(a, employmentId, PAST, 30, { plannedStartTime: null, plannedEndTime: null }),
      ).rejects.toThrow(OvertimeAlreadyCountedError);
      // The sentence has to say which day and has to point at the correction route, or the refusal is a
      // dead end. The employee reads a LOCALIZED version of this (me.otAlreadyCountedForDate); the raw
      // message is what any other caller sees.
      await expect(
        filePlan(a, employmentId, PAST, 30, { plannedStartTime: null, plannedEndTime: null }),
      ).rejects.toThrow(new RegExp(`${PAST}.*already been approved and counted`));

      // Refused AT THE DOOR: no second row, and the counted figure did not move.
      expect((await attendanceRow(employmentId, PAST)).otMinutes).toBe(180);
      const rows = await owner.db
        .select({ id: schema.attendanceCorrection.id })
        .from(schema.attendanceCorrection)
        .where(
          and(
            eq(schema.attendanceCorrection.employmentId, employmentId),
            eq(schema.attendanceCorrection.attendanceDate, PAST),
          ),
        );
      expect(rows.length, 'a refused request writes nothing').toBe(1);
    });

    it('(b) *** but a CLOCK CORRECTION carrying overtime is STILL ACCEPTED on that same counted date ***', async () => {
      // ⚠️ (a)'s NON-VACUITY PARTNER. If this one ever goes red the refusal message has become a lie: it
      // recommends exactly this route. The distinguishing fact is the proposed clock-in, which is why the
      // service tests `checkIn == null` and not `hasOt`.
      const { a, employmentId } = await countedPastDay();

      await expect(
        requestAttendanceCorrection(a, {
          employmentId,
          date: PAST,
          checkIn: '09:00',
          checkOut: '21:00',
          requestedOtMinutes: 300,
          reason: 'Stayed later than the plan said; correcting the punches and the hours together',
        }),
        'the correction route the refusal points at must stay open on a counted date',
      ).resolves.toBeTruthy();

      // And a PLAIN clock fix carrying no overtime at all is untouched by any of this.
      await expect(
        requestAttendanceCorrection(a, { employmentId, date: FUTURE, checkIn: '09:00', reason: 'forgot' }),
      ).rejects.toBeInstanceOf(AttendanceCorrectionFutureDateError);
    });

    it("(c) an approved correction's overtime survives a later clock-out — it is not reverted to the plan's", async () => {
      // THE SECOND DEFECT, and the one that made (b) unsafe. applyApprovedOtPlanTx re-asserts a day's
      // approved overtime after any re-derivation (a second clock-out, a terminal re-import). Its selection
      // used to exclude rows with a proposed clock-in and order by created_at, so a CORRECTION that revised
      // a counted day was invisible to it and the next punch put the OLDER PLAN's figure back.
      //
      // THREE DISTINCT NUMBERS, deliberately: 180 is the plan's (what the defect produces), 240 is what the
      // engine derives from 09:00→22:00, and 300 is the correction's (the only right answer). A fixture in
      // which any two of them coincided would pass either way.
      const { a, employmentId } = await countedPastDay();
      const { correctionId } = await requestAttendanceCorrection(a, {
        employmentId,
        date: PAST,
        checkIn: '09:00',
        checkOut: '21:00',
        requestedOtMinutes: 300,
        reason: 'Stayed later than the plan said',
      });
      await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
      expect(
        (await attendanceRow(employmentId, PAST)).otMinutes,
        "the correction's figure must be on the day before anything can revert it",
      ).toBe(300);

      // The re-derivation: one more clock-out of the same day.
      await checkOut(a, { employmentId, date: PAST, time: '22:00' });

      expect(
        (await attendanceRow(employmentId, PAST)).otMinutes,
        'the LATEST approved decision about the day stands — 180 here is the older plan winning',
      ).toBe(300);
      // The plan is not re-landed either: a re-assertion resolves nothing and stamps nothing.
      expect((await correctionRow(correctionId)).approvedOtMinutes).toBe(300);
    });

    it('(d) the replacement-leave register still holds EXACTLY ONE credit for the date', async () => {
      // On a rest day the first approval also MINTS a replacement-leave day, and toil_accrual_emp_date_uq
      // stops a second one for the same date. That index is why the business note on the item is true: when
      // a second figure replaced the hours, the credit silently kept the FIRST figure's size. Refusing the
      // second plan removes the disagreement; the index is NOT relaxed, here or anywhere.
      const { employmentId } = await hire();
      await setModule(b.tenantId, 'toil', 'active');
      const a = await entitledCtx(b);
      await setAttendancePolicy(a, { ...BASE_POLICY(b.companyId), otApprovalCalculation: 'requested' });
      await setToilPolicy(a, toilPolicyInput(b.companyId));
      await setRestDay(a, { employmentId, shiftDate: PAST_REST });
      await checkIn(a, { employmentId, date: PAST_REST, time: '08:00' });
      await checkOut(a, { employmentId, date: PAST_REST, time: '17:00' });

      const first = await filePlan(a, employmentId, PAST_REST, 240, {
        plannedStartTime: null,
        plannedEndTime: null,
        reason: 'Weekend cut-over cover',
      });
      await decideAttendanceCorrection(a, { correctionId: first.correctionId, decision: 'approved' });
      // THE PREMISE: a non-zero counted figure AND a credit that actually exists. 240 approved minutes over
      // a 480-minute standard day is 0.5 of a day on the hours_worked basis.
      expect((await attendanceRow(employmentId, PAST_REST)).otMinutes).toBe(240);
      expect(await replacementBalance(employmentId)).toBe(0.5);

      // A second PLAN cannot be filed at all now, so it can neither move the hours nor be blamed for the
      // credit standing still.
      await expect(
        filePlan(a, employmentId, PAST_REST, 480, { plannedStartTime: null, plannedEndTime: null }),
      ).rejects.toThrow(OvertimeAlreadyCountedError);

      // The route that IS open moves the hours — and the register still holds one credit, at the first
      // figure's size, because the unique index refuses a second. That disagreement is NAMED on the item
      // rather than fixed here: correcting it changes what a credit is worth, which is a separate decision.
      const { correctionId } = await requestAttendanceCorrection(a, {
        employmentId,
        date: PAST_REST,
        checkIn: '08:00',
        checkOut: '20:00',
        requestedOtMinutes: 480,
        reason: 'Worked longer than the plan; correcting punches and hours together',
      });
      await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
      expect((await attendanceRow(employmentId, PAST_REST)).otMinutes).toBe(480);

      const credits = await owner.db
        .select({ id: schema.toilAccrual.id, days: schema.toilAccrual.daysCredited })
        .from(schema.toilAccrual)
        .where(
          and(
            eq(schema.toilAccrual.employmentId, employmentId),
            eq(schema.toilAccrual.workedDate, PAST_REST),
          ),
        );
      expect(credits.length, 'exactly one replacement-leave credit for the date').toBe(1);
      expect(Number(credits[0].days)).toBe(0.5);
      expect(await replacementBalance(employmentId)).toBe(0.5);
    });

    // ── d16237da (r366) · THE DOOR (a) LEFT OPEN — COUNTED BY A CORRECTION, NOT BY A PLAN ────────────
    //
    // (a) pins a day counted by an earlier PLAN. The guard behind it asked `proposed_check_in IS NULL` of
    // the ALREADY-COUNTED row as well as of the incoming one, so a day counted by an approved CLOCK
    // CORRECTION — the very route the refusal recommends — was invisible to it. An OT-only request filed
    // afterwards was accepted, and approving it replaced the corrected figure.
    //
    // THE FIXTURE CARRIES NO PLAN AT ALL, deliberately: the only approved, applied, OT-bearing row on the
    // day is a correction, so nothing but the widened helper can produce this refusal. Restore
    // `isNull(proposed_check_in)` in countedOtPlanTx and this case goes red on its own.
    //
    // THREE DISTINCT NUMBERS, as (c) has: 60 is what the punches alone earned (the day's starting figure,
    // asserted in its own right — a day carrying no overtime would pass this whatever the code does), 240
    // is the correction's approved figure and the only thing that may stand at the end, and 30 is what the
    // refused request asks for. 180 — what the engine would derive from the corrected 09:00→21:00 punches
    // — is a fourth distinct number, so `requested` really is the rule being exercised.
    it('(e) REFUSES an OT-ONLY request on a date counted by an approved CLOCK CORRECTION (r366)', async () => {
      const { a, employmentId } = await hire();
      await setAttendancePolicy(a, { ...BASE_POLICY(b.companyId), otApprovalCalculation: 'requested' });
      await checkIn(a, { employmentId, date: PAST, time: '09:00' });
      await checkOut(a, { employmentId, date: PAST, time: '19:00' });

      // PREMISE 1 — the day starts with a real, non-zero figure that is NOT the one under test.
      expect(
        (await attendanceRow(employmentId, PAST)).otMinutes,
        'the punches alone must earn 60 — a day with no overtime makes this case vacuous',
      ).toBe(60);

      const { correctionId } = await requestAttendanceCorrection(a, {
        employmentId,
        date: PAST,
        checkIn: '09:00',
        checkOut: '21:00',
        requestedOtMinutes: 240,
        reason: 'Forgot to clock out; correcting the punches and the hours together',
      });
      await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });

      // PREMISE 2 — the CORRECTION is what counted the day, and "counted" means applied_at is stamped.
      expect(
        (await attendanceRow(employmentId, PAST)).otMinutes,
        "the correction's figure must be on the day before a second request can threaten it",
      ).toBe(240);
      expect(
        (await correctionRow(correctionId)).appliedAt,
        '"counted" means applied_at is stamped — without it this fixture is testing the wrong window',
      ).not.toBeNull();

      // THE CASE. Same refusal, same sentence: the rule has no exception for which route counted the day.
      await expect(
        filePlan(a, employmentId, PAST, 30, { plannedStartTime: null, plannedEndTime: null }),
      ).rejects.toThrow(OvertimeAlreadyCountedError);
      await expect(
        filePlan(a, employmentId, PAST, 30, { plannedStartTime: null, plannedEndTime: null }),
      ).rejects.toThrow(new RegExp(`${PAST}.*already been approved and counted`));

      // Refused AT THE DOOR: the corrected figure stands, and no second row was written.
      expect(
        (await attendanceRow(employmentId, PAST)).otMinutes,
        '240 must still stand — 30 is the refused request winning, 60 is the correction being undone',
      ).toBe(240);
      const rows = await owner.db
        .select({ id: schema.attendanceCorrection.id })
        .from(schema.attendanceCorrection)
        .where(
          and(
            eq(schema.attendanceCorrection.employmentId, employmentId),
            eq(schema.attendanceCorrection.attendanceDate, PAST),
          ),
        );
      expect(rows.length, 'a refused request writes nothing — only the correction should be here').toBe(1);
    });

    it('a FUTURE-dated plan is still refused by the UNAPPLIED guard, with its own distinct error', async () => {
      // The two refusals are not interchangeable: one says "withdraw it", the other says "that is a
      // correction". Withdrawal is possible in exactly the first state and refused in the second, so a
      // screen that showed the wrong one would send the employee somewhere that cannot help them.
      const { a, employmentId } = await hire();
      const { correctionId } = await filePlan(a, employmentId, FUTURE, 180);
      await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
      await expect(filePlan(a, employmentId, FUTURE, 60)).rejects.toThrow(OvertimePlanAlreadyApprovedError);
      await expect(filePlan(a, employmentId, FUTURE, 60)).rejects.toThrow(/Withdraw it first/i);
      const err = await filePlan(a, employmentId, FUTURE, 60).catch((e: unknown) => e);
      expect(
        err instanceof OvertimeAlreadyCountedError,
        'the two refusals must not collapse into one — they send the employee to different places',
      ).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('5 · withdraw', () => {
  it('the subject may withdraw a PENDING plan', async () => {
    const { a, employmentId, personId } = await hire();
    const emp = await employeeCtx(personId);
    const { correctionId } = await filePlan(a, employmentId, FUTURE, 180);
    await expect(cancelPlannedOvertime(emp, { correctionId })).resolves.toEqual({ status: 'cancelled' });
    expect((await correctionRow(correctionId)).status).toBe('cancelled');
  });

  it('the subject may withdraw an APPROVED plan whose day has not been worked', async () => {
    const { a, employmentId, personId } = await hire();
    const emp = await employeeCtx(personId);
    const { correctionId } = await filePlan(a, employmentId, FUTURE, 180);
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    await expect(cancelPlannedOvertime(emp, { correctionId })).resolves.toEqual({ status: 'cancelled' });
  });

  it('REFUSES once the hours have landed — that is a correction, not a withdrawal', async () => {
    const { a, employmentId, personId } = await hire();
    const emp = await employeeCtx(personId);
    await setAttendancePolicy(a, { ...BASE_POLICY(b.companyId), otApprovalCalculation: 'requested' });
    const { correctionId } = await filePlan(a, employmentId, FUTURE, 180);
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    await checkIn(a, { employmentId, date: FUTURE, time: '09:00' });
    await checkOut(a, { employmentId, date: FUTURE, time: '20:00' });

    await expect(cancelPlannedOvertime(emp, { correctionId })).rejects.toThrow(/already been counted/i);
    expect((await correctionRow(correctionId)).status).toBe('approved');
  });

  it('REFUSES an approved plan whose overtime date has passed', async () => {
    const { a, employmentId, personId } = await hire();
    const emp = await employeeCtx(personId);
    const { correctionId } = await filePlan(a, employmentId, FUTURE, 180);
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    // `today` is injectable so the boundary can be exercised without waiting a year for it.
    await expect(cancelPlannedOvertime(emp, { correctionId, today: '2027-06-03' })).rejects.toThrow(
      /date has passed/i,
    );
  });

  it('allows it ON the overtime date itself (on or after, not strictly after)', async () => {
    const { a, employmentId, personId } = await hire();
    const emp = await employeeCtx(personId);
    const { correctionId } = await filePlan(a, employmentId, FUTURE, 180);
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    await expect(cancelPlannedOvertime(emp, { correctionId, today: FUTURE })).resolves.toEqual({
      status: 'cancelled',
    });
  });

  it('REFUSES anyone who is not the subject — a manager rejects, they do not withdraw', async () => {
    const { a, employmentId } = await hire();
    const { correctionId } = await filePlan(a, employmentId, FUTURE, 180);
    await expect(cancelPlannedOvertime(a, { correctionId })).rejects.toThrow(/Only the employee/i);
  });

  it('REFUSES a rejected plan and a plan already withdrawn', async () => {
    const { a, employmentId, personId } = await hire();
    const emp = await employeeCtx(personId);
    const rejected = await filePlan(a, employmentId, FUTURE, 180);
    await decideAttendanceCorrection(a, { correctionId: rejected.correctionId, decision: 'rejected', rejectReason: 'Fixture rejection explanation' });
    await expect(cancelPlannedOvertime(emp, { correctionId: rejected.correctionId })).rejects.toThrow(
      /not approved/i,
    );

    const withdrawn = await filePlan(a, employmentId, FUTURE_2, 60);
    await cancelPlannedOvertime(emp, { correctionId: withdrawn.correctionId });
    await expect(cancelPlannedOvertime(emp, { correctionId: withdrawn.correctionId })).rejects.toThrow(
      /already been withdrawn/i,
    );
  });

  it('a withdrawn plan never lands, even when the day is worked', async () => {
    const { a, employmentId, personId } = await hire();
    const emp = await employeeCtx(personId);
    await setAttendancePolicy(a, { ...BASE_POLICY(b.companyId), otApprovalCalculation: 'requested' });
    const { correctionId } = await filePlan(a, employmentId, FUTURE, 180);
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    await cancelPlannedOvertime(emp, { correctionId });

    await checkIn(a, { employmentId, date: FUTURE, time: '09:00' });
    await checkOut(a, { employmentId, date: FUTURE, time: '20:00' });

    // The engine's own figure stands; nothing was banked from the withdrawn plan.
    expect((await attendanceRow(employmentId, FUTURE)).otMinutes).toBe(120);
    expect((await correctionRow(correctionId)).appliedAt).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('6 · the two warnings — the kind of day, and the monthly ceiling', () => {
  it('names an ordinary working day, a rest day and a public holiday on a FUTURE date', async () => {
    const { a, employmentId } = await hire();
    await setAttendancePolicy(a, BASE_POLICY(b.companyId));
    expect(await dayTypeFor(a, employmentId, FUTURE)).toBe('workday');

    await setRestDay(a, { employmentId, shiftDate: FUTURE_REST });
    expect(await dayTypeFor(a, employmentId, FUTURE_REST)).toBe('rest_day');

    await owner.db.insert(schema.holiday).values({
      tenantId: b.tenantId,
      country: 'MY',
      state: null,
      companyId: b.companyId,
      holidayDate: FUTURE_HOLIDAY,
      name: 'Group Founders Day',
    });
    expect(await dayTypeFor(a, employmentId, FUTURE_HOLIDAY)).toBe('holiday');
  });

  it('the cap figure counts approved-but-not-yet-counted plans, and 104h exactly is NOT over', async () => {
    const { a, employmentId } = await hire();
    expect(OT_CAP_MINUTES).toBe(104 * 60);

    const before = await otMonthToDateMinutes(a, employmentId, FUTURE);
    expect(before).toMatchObject({ recordedMinutes: 0, plannedMinutes: 0, totalMinutes: 0, capMinutes: OT_CAP_MINUTES });

    // One approved plan for the exact ceiling. The warning fires on STRICTLY MORE than the cap, so this is
    // the boundary that must NOT warn — and the figure must count even though no day has been worked.
    const { correctionId } = await filePlan(a, employmentId, FUTURE, OT_CAP_MINUTES);
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });

    const atCap = await otMonthToDateMinutes(a, employmentId, FUTURE);
    expect(atCap.plannedMinutes).toBe(OT_CAP_MINUTES);
    expect(atCap.totalMinutes).toBe(OT_CAP_MINUTES);
    expect(atCap.totalMinutes > atCap.capMinutes, 'exactly 104 hours is within the limit').toBe(false);

    // One more minute on another day of the same month, and it is over.
    const more = await filePlan(a, employmentId, FUTURE_2, 1);
    await decideAttendanceCorrection(a, { correctionId: more.correctionId, decision: 'approved' });
    const over = await otMonthToDateMinutes(a, employmentId, FUTURE);
    expect(over.totalMinutes > over.capMinutes).toBe(true);
  });

  it('does NOT double-count a plan once its hours are on the day', async () => {
    const { a, employmentId } = await hire();
    await setAttendancePolicy(a, { ...BASE_POLICY(b.companyId), otApprovalCalculation: 'requested' });
    const { correctionId } = await filePlan(a, employmentId, FUTURE, 180);
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    expect((await otMonthToDateMinutes(a, employmentId, FUTURE)).totalMinutes).toBe(180);

    await checkIn(a, { employmentId, date: FUTURE, time: '09:00' });
    await checkOut(a, { employmentId, date: FUTURE, time: '20:00' });

    const after = await otMonthToDateMinutes(a, employmentId, FUTURE);
    expect(after.recordedMinutes).toBe(180);
    expect(after.plannedMinutes, 'a landed plan stops being "planned"').toBe(0);
    expect(after.totalMinutes).toBe(180);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('7 · the Plan OT list', () => {
  it('returns OT plans only, newest overtime date first, uncapped by the old five-row limit', async () => {
    const { a, employmentId } = await hire();
    // A clock-time correction must NOT appear — mixing the two is the complaint the item was raised about.
    await requestAttendanceCorrection(a, { employmentId, date: PAST, checkIn: '09:00', reason: 'forgot to clock out' });
    for (const [i, d] of ['2027-06-07', '2027-06-08', '2027-06-09', '2027-06-10', '2027-06-11', '2027-06-14'].entries()) {
      await filePlan(a, employmentId, d, 60 * (i + 1));
    }

    const plans = await myOvertimePlans(a, employmentId, { limit: 100 });
    expect(plans, 'all six, not the five most recent').toHaveLength(6);
    expect(plans.map((p) => p.attendanceDate)).toEqual([
      '2027-06-14',
      '2027-06-11',
      '2027-06-10',
      '2027-06-09',
      '2027-06-08',
      '2027-06-07',
    ]);
    // The columns the buried list did not have.
    expect(plans[0].reason).toBeTruthy();
    expect(plans[0].otReasonCategory).toBe('project_deadline');
    expect(plans[0].plannedStartTime).toBe('18:00:00');
    expect(plans.every((p) => p.appliedAt === null)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('8 · BULK approve reaches the deferred branch', () => {
  it('a bulk decision runs through the SAME service, so a future-dated plan is deferred there too', async () => {
    // The bulk loop dispatches each item to the same core decide* the row-level button calls, so the
    // property under test is that decideAttendanceCorrection handles a decider id — the one thing the bulk
    // path supplies and the single-decide form does not. Pinned as source below so the routing itself
    // cannot be re-pointed at a fork.
    const { a, employmentId } = await hire();
    const decider = await hire();
    const { correctionId } = await filePlan(a, employmentId, FUTURE, 180);
    const res = await decideAttendanceCorrection(a, {
      correctionId,
      decision: 'approved',
      deciderEmploymentId: decider.employmentId,
    });
    expect(res.deferred).toBe(true);
    const row = await correctionRow(correctionId);
    expect(row.decidedByEmploymentId).toBe(decider.employmentId);
    expect(row.appliedAt).toBeNull();
    expect(await attendanceRow(employmentId, FUTURE)).toBeUndefined();
  });

  it('the bulk loop still routes attendance items to decideAttendanceCorrection (no fork)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../app/approvals/actions.ts'), 'utf8');
    expect(src).toContain("case 'attendance':");
    expect(src).toMatch(/case 'attendance':[\s\S]{0,200}decideAttendanceCorrection\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('9 · notifications — the superior on arrival, the subject on the answer', () => {
  it('tells the SUPERIOR a plan has arrived, and the subject when it is approved', async () => {
    const mgr = await hire();
    const sub = await hire();
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: sub.employmentId,
      managerEmploymentId: mgr.employmentId,
      lineType: 'administrative',
      validFrom: '2024-01-01',
    });
    await setModule(b.tenantId, 'notifications', 'active');
    const a = adminCtx(b);

    const { correctionId } = await filePlan(a, sub.employmentId, FUTURE, 180);
    await dispatchNotifications(a, {});
    const onArrival = await notificationsFor(mgr.employmentId);
    expect(onArrival.map((n) => n.kind)).toContain('attendance.ot-requested');
    expect(onArrival[0].body).toMatch(/3\.0 hours/);
    // NOT to the person who filed it.
    expect((await notificationsFor(sub.employmentId)).map((n) => n.kind)).not.toContain('attendance.ot-requested');

    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    await dispatchNotifications(a, {});
    const answered = await notificationsFor(sub.employmentId);
    const approved = answered.find((n) => n.kind === 'attendance.ot-approved');
    expect(approved, 'the subject is told the answer').toBeTruthy();
    // The deferred wording — approved is not the same as counted, and the notice has to say so.
    expect(approved!.body).toMatch(/counted once the day is worked/i);
  });

  it('says nothing about a plain CLOCK correction — scoped to overtime on purpose', async () => {
    const mgr = await hire();
    const sub = await hire();
    await setReportingLine(adminCtx(b), {
      subordinateEmploymentId: sub.employmentId,
      managerEmploymentId: mgr.employmentId,
      lineType: 'administrative',
      validFrom: '2024-01-01',
    });
    await setModule(b.tenantId, 'notifications', 'active');
    const a = adminCtx(b);

    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId: sub.employmentId,
      date: PAST,
      checkIn: '09:00',
      checkOut: '18:00',
      reason: 'forgot to clock out',
    });
    await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
    await dispatchNotifications(a, {});

    // Widening these three notices to clock corrections is a defensible improvement and a one-line change,
    // but it is a behaviour change on a neighbouring flow that this item did not ask for.
    expect(await notificationsFor(mgr.employmentId)).toHaveLength(0);
    expect((await notificationsFor(sub.employmentId)).map((n) => n.kind)).not.toContain('attendance.ot-approved');
  });

  it('tells the subject when a plan is REJECTED', async () => {
    const { employmentId } = await hire();
    await setModule(b.tenantId, 'notifications', 'active');
    // The context must be built AFTER setModule: adminCtx carries a point-in-time entitlement snapshot,
    // and dispatchNotifications is a no-op for a context that does not have the module.
    const a = adminCtx(b);
    const { correctionId } = await filePlan(a, employmentId, FUTURE, 180);
    await decideAttendanceCorrection(a, { correctionId, decision: 'rejected', rejectReason: 'Fixture rejection explanation' });
    await dispatchNotifications(a, {});
    expect((await notificationsFor(employmentId)).map((n) => n.kind)).toContain('attendance.ot-rejected');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('10 · request-time validation of the planned window', () => {
  it('accepts an earlier end as an overnight plan and refuses equal times', async () => {
    const { a, employmentId } = await hire();
    const request = await filePlan(a, employmentId, FUTURE, 1260, { plannedStartTime: '21:00', plannedEndTime: '18:00' });
    expect((await correctionRow(request.correctionId)).requestedOtMinutes).toBe(1260);
    await expect(filePlan(a, employmentId, todayInKualaLumpur(new Date(new Date(FUTURE + 'T12:00:00+08:00').getTime() + 86400000)), 0, { plannedStartTime: '18:00', plannedEndTime: '18:00' })).rejects.toThrow(/different valid start and end/i);
  });

  it('refuses half a window', async () => {
    const { a, employmentId } = await hire();
    await expect(
      filePlan(a, employmentId, FUTURE, 180, { plannedStartTime: '18:00', plannedEndTime: null }),
    ).rejects.toThrow(/both a start time and an end time/i);
  });

  it('still accepts an hours-only plan with no window at all (the path that already worked)', async () => {
    const { a, employmentId } = await hire();
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: FUTURE,
      requestedOtMinutes: 90,
      reason: 'Claimed after the fact',
    });
    const row = await correctionRow(correctionId);
    expect(row.plannedStartTime).toBeNull();
    expect(row.otReasonCategory).toBeNull();
    expect(row.requestedOtMinutes).toBe(90);
  });
});
