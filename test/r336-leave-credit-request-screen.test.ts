/**
 * r336 · cbfa8b0b — THE LEAVE CREDIT REQUEST SCREEN: one modal, two kinds of claim, and the
 * double-claim check that runs in BOTH directions.
 *
 * WHAT THIS FILE DEFENDS, in the order the risk sits:
 *
 *  1. THE TWO SECTIONS ARE VALIDATED AGAINST OPPOSITE FACTS. Section A needs a NON-working day, Section B
 *     needs a WORKING day, and each refusal names the other section. A single shared "is this date
 *     claimable" check would pass one of these and fail the other silently.
 *  2. ⚠️ REVERSED IN r353 — SECTION B'S CREDIT IS THE EMPLOYEE'S OWN WINDOW, AND THE CHECK IS THE APPROVER'S.
 *     This point used to read: "SECTION B'S CREDIT IS DERIVED, NEVER TYPED. The claim narrows a measured
 *     figure and can never widen it, which is the safety property: the screen cannot mint minutes, so it
 *     cannot mint a credit, so it cannot suppress overtime pay for time nobody worked." The owner reversed
 *     that on cbfa8b0b after the reporter's own repro was traced to returning ZERO twice over (the clock-out
 *     clip AND the measured cap each gave 0 on their own). The window is now the claim, floored at the
 *     scheduled shift end; the discrepancy against the recorded clock-out is RETURNED by
 *     `assessExtendedClaim` and drawn as an amber warning on the employee's row and on the approvals queue.
 *     ⚠️ MONEY: this loosens a control rather than moving it — replacement leave blocks overtime pay for the
 *     same hours and converts to cash on expiry, so the line manager is now the only check. The cases below
 *     therefore assert that a claim past the clock-out CREDITS and WARNS, not that it is refused.
 *  3. THE OVERLAP CHECK RUNS BOTH WAYS FROM ONE PREDICATE, and releases on a rejection.
 *  4. ⚠️ MONEY — the credit still suppresses the day's overtime pay exactly as r334 left it, and
 *     `toil_accrual.day_type` is still NULL on an extended-hours credit so `convertAmountFor` cannot price
 *     a rounded-down tier as exact statutory cash. r334's own file is the byte-identical pin; this adds the
 *     employee-request path r334 did not have.
 *
 * Dates derive from `todayInKualaLumpur()` (CLAUDE.md §8) and sit in LAST calendar month, so they are
 * always in the past and always inside one payroll period.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { checkIn, checkOut, decideAttendanceCorrection, requestAttendanceCorrection } from '../core/attendance';
import { assignDefaultShift, assignShift, createShift, setRestDay } from '../core/roster';
import { createBatch, generatePayslips, prefillOvertimeFromAttendance } from '../core/payroll';
import { todayInKualaLumpur } from '../lib/hr-date';
import { setToilPolicy, LeaveCreditSectionMismatchError, ToilExtendedHoursBelowThresholdError, type ToilPolicyInput } from '../core/toil';
import { assessExtendedClaim, claimCrossesMidnight, eligibleExtendedMinutes, extendedHoursCreditDays } from '../lib/extended-hours';
import {
  decideReplacementLeaveRequest,
  extendedHoursOfferForEmployment,
  listPendingReplacementLeaveRequests,
  submitReplacementLeaveRequest,
  workedDayKindForEmployment,
  ReplacementRequestInvalidError,
} from '../core/replacement-request';
import { BLOCKING_STATUSES, ClaimOverlapError } from '../core/credit-ot-overlap';
import type { SessionContext } from '../db/client';

let b: Base;
let ctx: SessionContext;

const TODAY = todayInKualaLumpur();
const monthBefore = (iso: string) => {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
};
const PERIOD = monthBefore(TODAY);
const weekdayIn = (isoWeekday: number, nth = 1) => {
  let seen = 0;
  for (let d = 1; d <= 28; d++) {
    const date = `${PERIOD}-${String(d).padStart(2, '0')}`;
    if ((new Date(`${date}T00:00:00Z`).getUTCDay() || 7) === isoWeekday && ++seen === nth) return date;
  }
  throw new Error('unreachable');
};
/** Three Mon–Fri dates inside the shift pattern: ordinary working days. */
const WORKDAY = weekdayIn(3);
const WORKDAY_2 = weekdayIn(4);
const WORKDAY_3 = weekdayIn(3, 2);
/** A Sunday in the same period, made a rostered rest day. */
const REST_DAY = weekdayIn(7);
const REST_DAY_2 = weekdayIn(7, 2);
/** The approval instant, well after every worked date so an expiry anchored elsewhere would be visible. */
const DECIDED_AT = new Date(`${PERIOD}-28T03:00:00.000Z`);

const uniqEmail = () => `r336_${Math.random().toString(36).slice(2)}@t.local`;

const policy = (over: Partial<ToilPolicyInput> = {}): ToilPolicyInput => ({
  companyId: b.companyId,
  enabled: true,
  accrualBasis: 'hours_worked',
  expiryDays: 90,
  onExpiry: 'convert_to_pay',
  allowFirstScheduleEligible: false,
  autoAccrueOnApproval: false,
  carryForwardAtYearEnd: false,
  employeeRequestEnabled: true,
  ...over,
});
/** The same policy with r334's switch on and the reporter's stated defaults. */
const extendedPolicy = (over: Partial<ToilPolicyInput> = {}): ToilPolicyInput =>
  policy({
    extendedHoursEnabled: true,
    extendedHalfDayMinutes: 240,
    extendedFullDayMinutes: 480,
    extendedBreakMinutes: 0,
    extendedGraceMinutes: 0,
    ...over,
  });

/** Mon–Fri 06:00–14:00, so the SCHEDULED SHIFT END is 14:00 and OT is measured past it. */
async function hire(basic = 8000, name = 'Credit Claimant') {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  const shift = await createShift(a, {
    companyId: b.companyId,
    name: `Day ${Math.random().toString(36).slice(2, 7)}`,
    code: `D_${Math.random().toString(36).slice(2, 8)}`,
    startTime: '06:00:00',
    endTime: '14:00:00',
    breakMinutes: 60,
    weeklyPattern: [1, 2, 3, 4, 5],
  });
  return { employmentId: e.employmentId, shiftId: shift.id };
}

/** Work one rostered workday and return the engine's own `ot_minutes` for it. */
async function workShift(employmentId: string, shiftId: string, date: string, inAt: string, outAt: string): Promise<number> {
  const a = adminCtx(b);
  await assignShift(a, { employmentId, shiftDate: date, shiftId });
  await checkIn(a, { employmentId, date, time: inAt });
  await checkOut(a, { employmentId, date, time: outAt });
  const [row] = await owner.db
    .select({ otMinutes: schema.attendance.otMinutes, dayType: schema.attendance.dayType })
    .from(schema.attendance)
    .where(and(eq(schema.attendance.employmentId, employmentId), eq(schema.attendance.attendanceDate, date)));
  expect(row.dayType, 'the fixture must be an ordinary working day').toBe('workday');
  return row.otMinutes ?? 0;
}

/** A full rostered rest day: 08:00–17:00. */
async function workRestDay(employmentId: string, date: string) {
  const a = adminCtx(b);
  await setRestDay(a, { employmentId, shiftDate: date });
  await checkIn(a, { employmentId, date, time: '08:00:00' });
  await checkOut(a, { employmentId, date, time: '17:00:00' });
}

const replacementBalance = async (employmentId: string): Promise<number> => {
  const [row] = await owner.db
    .select({ bal: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .innerJoin(schema.leaveType, eq(schema.leaveType.id, schema.leaveLedger.leaveTypeId))
    .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveType.code, 'REPLACEMENT')));
  return Number(row?.bal ?? 0);
};

const claimLines = (employmentId: string) =>
  owner.db
    .select()
    .from(schema.replacementLeaveRequestDate)
    .where(eq(schema.replacementLeaveRequestDate.subjectEmploymentId, employmentId))
    .orderBy(schema.replacementLeaveRequestDate.workedDate);

const accruals = (employmentId: string) =>
  owner.db
    .select()
    .from(schema.toilAccrual)
    .where(eq(schema.toilAccrual.employmentId, employmentId))
    .orderBy(schema.toilAccrual.workedDate);

/** ⚠️ THE MONEY READ: run payroll for PERIOD and return the prefilled input AND the generated payslip. */
async function overtimeMoney(employmentId: string): Promise<{ input: number; payslip: number }> {
  const { batchId } = await createBatch(ctx, { companyId: b.companyId, payPeriod: PERIOD });
  await prefillOvertimeFromAttendance(ctx, { batchId });
  await generatePayslips(ctx, { batchId });
  const [input] = await owner.db
    .select({ amount: schema.payrollInput.overtimeAmount })
    .from(schema.payrollInput)
    .where(and(eq(schema.payrollInput.batchId, batchId), eq(schema.payrollInput.employmentId, employmentId)));
  const [slip] = await owner.db
    .select({ ot: schema.payslip.overtimePay })
    .from(schema.payslip)
    .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
  return { input: Number(input?.amount ?? 0), payslip: Number(slip?.ot ?? 0) };
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
  await setModule(b.tenantId, 'toil', 'active');
  ctx = await entitledCtx(b);
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r336 · the derived figures, as pure arithmetic', () => {
  const TIERS = { extendedHalfDayMinutes: 240, extendedFullDayMinutes: 480, extendedBreakMinutes: 0, extendedGraceMinutes: 0 };

  it('(d) 240 and 479 give 0.5, 480 gives 1.0, and 960 is STILL 1.0 — the cap, not a proportion', () => {
    expect(extendedHoursCreditDays(239, TIERS).days).toBe(0);
    expect(extendedHoursCreditDays(240, TIERS).days).toBe(0.5);
    expect(extendedHoursCreditDays(479, TIERS).days).toBe(0.5);
    expect(extendedHoursCreditDays(480, TIERS).days).toBe(1);
    expect(extendedHoursCreditDays(960, TIERS).days).toBe(1);
  });

  /**
   * ⚠️⚠️ REVERSED BY THE OWNER ON cbfa8b0b (r353), AND THE OLD ASSERTION IS QUOTED SO THE DECISION IS READABLE
   * FROM HERE. CLAUDE.md §8: a guard pinning a decision you are reversing is UPDATED, not deleted.
   *
   * This case used to be called "the claimed window NARROWS the measured figure and can never widen it", and
   * its last expectation was the one that mattered:
   *
   *     // ⚠️ THE SAFETY PROPERTY. A day the engine measured at ZERO extended minutes can never be claimed,
   *     // however wide the window — which is what stops the screen minting minutes, and therefore pay.
   *     expect(eligibleExtendedMinutes({ claimStart: '14:00', claimEnd: '22:00', shiftEnd: '14:00:00',
   *       actualClockOut: '22:00:00', measuredExtendedMinutes: 0 })).toBe(0);
   *
   * WHY IT IS INVERTED. The reporter's own repro — a shift ending 18:00, clocked out at 18:00, nothing
   * measured, 18:00–23:51 typed — returned ZERO, and it returned zero twice over: the clock-out clip alone
   * gave 0, and with the clip removed the measured cap still gave 0. So the reporter's proposed fix (drop the
   * clock-out) would not have fixed the reporter's own example. The owner reversed the rule: the employee's
   * entered window IS the claim, and the clock-out is the APPROVER's reference. `measuredExtendedMinutes` is
   * not a parameter of this function any more — the signature itself is the pin, because a parameter left in
   * place is how a cap comes back.
   *
   * WHERE THE SAFETY PROPERTY WENT: to `assessExtendedClaim`'s `exceedsClockOut` / `hasClockOut` and the two
   * screens that print them, asserted below and in test/r343-leave-credit-table.dom.test.tsx. It is a WARNING
   * now, not a refusal, which is the loosening the owner accepted.
   */
  it('⚠️ the entered window IS the claim now — a day the engine measured at ZERO still credits it', () => {
    // THE REPORTER'S OWN REPRO, BY NUMBER. 18:00 shift end, clocked out 18:00, nothing measured. Before
    // r353 this was 0 and the request was refused under the half-day threshold; it is 351 minutes and half a
    // day. This is the named assertion the non-vacuity check reverts the fix against.
    expect(
      eligibleExtendedMinutes({ claimStart: '18:00', claimEnd: '23:51', shiftEnd: '18:00:00', actualClockOut: '18:00:00' }),
    ).toBe(351);
    expect(extendedHoursCreditDays(351, TIERS).days).toBe(0.5);
    // Claiming less than the window still gives less: an employee may claim part of what they worked.
    expect(
      eligibleExtendedMinutes({ claimStart: '14:00', claimEnd: '18:00', shiftEnd: '14:00:00', actualClockOut: '22:00:00' }),
    ).toBe(240);
    // A window that runs from midnight is floored at the SHIFT END, not at what was measured: 14:00 → 23:59.
    expect(
      eligibleExtendedMinutes({ claimStart: '00:00', claimEnd: '23:59', shiftEnd: '14:00:00', actualClockOut: '22:00:00' }),
    ).toBe(599);
  });

  /**
   * ⚠️ THE OTHER HALF OF THE REVERSAL, AND WHAT SURVIVED IT. This case used to read "clips to the scheduled
   * shift end AND THE ACTUAL CLOCK-OUT so the figure matches the times printed beside it", and its middle
   * expectation was the clock-out clip itself:
   *
   *     // An hour claimed AFTER the clock-out was not worked.
   *     expect(eligibleExtendedMinutes({ claimStart: '14:00', claimEnd: '19:00', shiftEnd: '14:00:00',
   *       actualClockOut: '18:00:00', measuredExtendedMinutes: 600 })).toBe(240);
   *
   * That is 300 now, and the difference is reported to the approver rather than silently applied. The
   * SHIFT-END FLOOR is kept and is asserted here unchanged, because it is the definition of extended work
   * rather than a check on the person claiming it.
   */
  it('⚠️ the shift-end FLOOR is kept; the clock-out CEILING is gone and is reported instead', () => {
    // KEPT: an hour claimed BEFORE the shift ended is not extended work, whoever types it.
    expect(
      eligibleExtendedMinutes({ claimStart: '13:00', claimEnd: '18:00', shiftEnd: '14:00:00', actualClockOut: '18:00:00' }),
    ).toBe(240);
    // REVERSED: an hour claimed after the clock-out is credited — and flagged.
    const past = assessExtendedClaim({ claimStart: '14:00', claimEnd: '19:00', shiftEnd: '14:00:00', actualClockOut: '18:00:00' });
    expect(past.minutes, 'the claim used to be clipped to 240 by the clock-out').toBe(300);
    expect(past.exceedsClockOut).toBe(true);
    expect(past.hasClockOut).toBe(true);
    // Cross-midnight: 18:00 → 00:30 is six and a half hours, not a negative span. Unchanged by r353.
    expect(
      eligibleExtendedMinutes({ claimStart: '18:00', claimEnd: '00:30', shiftEnd: '18:00:00', actualClockOut: '00:30:00' }),
    ).toBe(390);
  });

  /**
   * ⚠️ A ZERO-LENGTH WINDOW IS ZERO, NOT TWENTY-FOUR HOURS — a defect the removed cap was hiding.
   *
   * The roll tested `end <= start`, so 18:00 → 18:00 became 1440 minutes. With the measured cap in front of
   * it that was cut back to whatever was measured; with the cap gone it was A FULL DAY OF CREDIT from an
   * obvious mis-entry. Verified by execution on the new function before the `<=` was narrowed to `<`.
   */
  it('18:00 → 18:00 is a zero-length window, not a 24-hour claim', () => {
    const a = assessExtendedClaim({ claimStart: '18:00', claimEnd: '18:00', shiftEnd: '18:00:00', actualClockOut: '18:00:00' });
    expect(a.minutes).toBe(0);
    expect(extendedHoursCreditDays(a.minutes, TIERS).days).toBe(0);
  });

  /**
   * ⚠️ r362 58424c7f · THE ROLL IS UNCHANGED, AND ITS CONDITION IS NOW A NAMED EXPORT.
   *
   * The reporter asked Leave Credit to REFUSE an end earlier than the start. It is deliberately allowed —
   * that is how a shift across midnight is entered — and what shipped instead is the request row SAYING how
   * the window was read. The screen must not decide that by parsing the two times a second time, or the
   * note and the minutes printed beside it disagree the first time either moves, so `claimCrossesMidnight`
   * IS the roll's condition and `assessExtendedClaim` asks it.
   *
   * THIS CASE IS THE "NOTHING MOVED" HALF. Every pair is checked BOTH ways: the predicate's answer, and the
   * minutes the roll produced for the same pair. A predicate that drifted from the roll would pass one and
   * fail the other. ⚠️ 18:00→18:00 is in the table on purpose: `<` rather than `<=` is r353's money fix
   * (a zero-length window used to roll to 1440 and earn a whole day), and a predicate that called it a
   * cross-midnight row would be that defect coming back through the screen.
   */
  it('⚠️ `claimCrossesMidnight` IS the roll’s condition — same answer, same minutes, zero-length excluded', () => {
    const CASES: { start: string; end: string; crosses: boolean; minutesNoFloor: number }[] = [
      { start: '22:00', end: '02:00', crosses: true, minutesNoFloor: 240 },
      { start: '18:00', end: '00:30', crosses: true, minutesNoFloor: 390 },
      { start: '14:00', end: '09:00', crosses: true, minutesNoFloor: 1140 },
      { start: '09:00', end: '14:00', crosses: false, minutesNoFloor: 300 },
      { start: '18:00', end: '23:51', crosses: false, minutesNoFloor: 351 },
      { start: '18:00', end: '18:00', crosses: false, minutesNoFloor: 0 },
      { start: '00:00', end: '23:59', crosses: false, minutesNoFloor: 1439 },
    ];
    for (const c of CASES) {
      expect(claimCrossesMidnight(c.start, c.end), `${c.start}→${c.end}`).toBe(c.crosses);
      // No shift end, so the floor is the start and the span IS the roll's output — which is what makes
      // this an assertion about the roll rather than about the floor.
      const m = eligibleExtendedMinutes({ claimStart: c.start, claimEnd: c.end, shiftEnd: null, actualClockOut: null });
      expect(m, `${c.start}→${c.end} minutes`).toBe(c.minutesNoFloor);
      // The two must agree: a rolled pair is one that produced MORE minutes than the plain difference.
      const plain = Number(c.end.slice(0, 2)) * 60 + Number(c.end.slice(3)) - (Number(c.start.slice(0, 2)) * 60 + Number(c.start.slice(3)));
      expect(m > plain, `${c.start}→${c.end}: the predicate and the roll must agree`).toBe(c.crosses);
    }
    // An unparseable time describes no reading at all, and `assessExtendedClaim` returns zero for the same.
    expect(claimCrossesMidnight('', '02:00')).toBe(false);
    expect(claimCrossesMidnight('22:00', '')).toBe(false);
  });

  /**
   * THE REPORTER'S SEVEN ARITHMETIC CASES, AS ONE TABLE. Six of the seven passed before this round and the
   * plan told the reporter so; the fifth row is the one that did not, and it is their own example. The shift
   * ends at 18:00 throughout, which is the shift end in the ticket.
   *
   * ⚠️ `actualClockOut` IS DELIBERATELY THE SHIFT END ON EVERY ROW — i.e. the worst case, a day nobody
   * clocked out of after the release. Before r353 every row but the fourth would have returned 0 through the
   * clip; that they now return the claimed span is the whole point of the table.
   */
  const SEVEN: { name: string; start: string; end: string; minutes: number; days: number }[] = [
    { name: '239 minutes earns nothing — under the half-day threshold', start: '18:00', end: '21:59', minutes: 239, days: 0 },
    { name: '240 minutes earns half a day, exactly at the threshold', start: '18:00', end: '22:00', minutes: 240, days: 0.5 },
    { name: '480 minutes ACROSS MIDNIGHT earns a full day', start: '18:00', end: '02:00', minutes: 480, days: 1 },
    { name: 'a 17:00 start is floored UP to the 18:00 shift end: 240, not 300', start: '17:00', end: '22:00', minutes: 240, days: 0.5 },
    { name: "⚠️ THE TICKET'S OWN EXAMPLE: 18:00–23:51 is 351 minutes and half a day", start: '18:00', end: '23:51', minutes: 351, days: 0.5 },
    { name: '720 minutes is STILL one day — the tier cap, which r353 keeps', start: '18:00', end: '06:00', minutes: 720, days: 1 },
    { name: 'a zero-length window earns nothing', start: '18:00', end: '18:00', minutes: 0, days: 0 },
  ];
  for (const c of SEVEN) {
    it(`(reporter) ${c.name}`, () => {
      const minutes = eligibleExtendedMinutes({ claimStart: c.start, claimEnd: c.end, shiftEnd: '18:00:00', actualClockOut: '18:00:00' });
      expect(minutes, `${c.start}–${c.end}`).toBe(c.minutes);
      expect(extendedHoursCreditDays(minutes, TIERS).days, `${c.start}–${c.end} in days`).toBe(c.days);
    });
  }

  /**
   * THE DISCREPANCY IS RETURNED, FROM ONE COMPUTATION — the property that lets the request table and the
   * approvals queue print the same warning without either of them re-deriving it.
   */
  it('⚠️ the approver’s two questions are answered beside the minutes, not instead of them', () => {
    // A claim that ends after the clock-out: flagged AND still credited.
    const past = assessExtendedClaim({ claimStart: '18:00', claimEnd: '23:51', shiftEnd: '18:00:00', actualClockOut: '18:00:00' });
    expect(past).toEqual({ minutes: 351, hasClockOut: true, exceedsClockOut: true });
    // A claim inside the clock-out: nothing to say.
    const inside = assessExtendedClaim({ claimStart: '18:00', claimEnd: '22:00', shiftEnd: '18:00:00', actualClockOut: '22:00:00' });
    expect(inside).toEqual({ minutes: 240, hasClockOut: true, exceedsClockOut: false });
    // NO CLOCK-OUT AT ALL is a DIFFERENT answer from "clocked out earlier", because it is a different
    // question for an approver: a missing fact rather than a contradicted one. And it still credits.
    const none = assessExtendedClaim({ claimStart: '18:00', claimEnd: '23:51', shiftEnd: '18:00:00', actualClockOut: null });
    expect(none).toEqual({ minutes: 351, hasClockOut: false, exceedsClockOut: false });
    // No assigned shift ⇒ no scheduled end ⇒ the claimed start is the floor. A narrower answer, never wider.
    expect(assessExtendedClaim({ claimStart: '18:00', claimEnd: '22:00', shiftEnd: null, actualClockOut: null }).minutes).toBe(240);
    // `eligibleExtendedMinutes` is a PROJECTION of the same call, never a second reading of the row.
    for (const c of SEVEN) {
      const p = { claimStart: c.start, claimEnd: c.end, shiftEnd: '18:00:00', actualClockOut: '18:00:00' };
      expect(eligibleExtendedMinutes(p), c.name).toBe(assessExtendedClaim(p).minutes);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r336 · (a) A-only, B-only and both-in-one-request', () => {
  it('submits Section A alone and totals it in days', async () => {
    await setToilPolicy(ctx, extendedPolicy());
    const { employmentId } = await hire();
    await workRestDay(employmentId, REST_DAY);
    const res = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [{ workedDate: REST_DAY, days: 1, sourceType: 'non_working_day' }],
      today: TODAY,
    });
    expect(res.totalDays).toBe(1);
    const lines = await claimLines(employmentId);
    expect(lines).toHaveLength(1);
    expect(lines[0].sourceType).toBe('non_working_day');
    expect(lines[0].workedDayKind).toBe('rest_day');
    // Section A stores nothing about a shift it does not claim against.
    expect(lines[0].eligibleMinutes).toBeNull();
  });

  it('submits Section B alone, DERIVING the credit from the attendance row', async () => {
    await setToilPolicy(ctx, extendedPolicy());
    const { employmentId, shiftId } = await hire();
    // 06:00 → 18:00 on a Mon–Fri shift ending 14:00 ⇒ the engine measures 240 minutes past the end.
    const measured = await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '18:00:00');
    expect(measured, 'the fixture must give the engine exactly four hours past the shift end').toBe(240);
    const res = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      // NO days figure is posted. The credit is derived.
      lines: [{ workedDate: WORKDAY, fromTime: '14:00', toTime: '18:00', sourceType: 'extended_hours' }],
      today: TODAY,
    });
    expect(res.totalDays).toBe(0.5);
    const [line] = await claimLines(employmentId);
    expect(line.sourceType).toBe('extended_hours');
    expect(line.workedDayKind).toBe('workday');
    expect(line.eligibleMinutes).toBe(240);
    expect(Number(line.days)).toBe(0.5);
    // The two read-only facts the screen showed are STORED, so an approver reads what the employee saw.
    expect(line.shiftEnd).toBe('14:00:00');
    expect(line.actualClockOut).toBe('18:00:00');
  });

  it('submits BOTH sections in one request and totals them together', async () => {
    await setToilPolicy(ctx, extendedPolicy());
    const { employmentId, shiftId } = await hire();
    await workRestDay(employmentId, REST_DAY);
    await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '22:00:00'); // 480 min past 14:00
    const res = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [
        { workedDate: REST_DAY, days: 0.5, sourceType: 'non_working_day' },
        { workedDate: WORKDAY, fromTime: '14:00', toTime: '22:00', sourceType: 'extended_hours' },
      ],
      today: TODAY,
    });
    // 0.5 from Section A + 1.0 from Section B.
    expect(res.totalDays).toBe(1.5);
    const lines = await claimLines(employmentId);
    expect(lines.map((l) => l.sourceType).sort()).toEqual(['extended_hours', 'non_working_day']);
    // And approving it mints BOTH credits, with the ledger agreeing with the grand total.
    await decideReplacementLeaveRequest(ctx, { requestId: res.requestId, decision: 'approved', decidedAt: DECIDED_AT });
    expect(await replacementBalance(employmentId)).toBe(1.5);
    const rows = await accruals(employmentId);
    expect(rows.map((r) => r.workedDayKind).sort()).toEqual(['rest_day', 'workday']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r336 · (b) each section refuses the OTHER section’s day, by name', () => {
  it('a WORKING day in Section A is refused with the named sentence', async () => {
    await setToilPolicy(ctx, extendedPolicy());
    const { employmentId, shiftId } = await hire();
    await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '18:00:00');
    const submit = submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [{ workedDate: WORKDAY, days: 1, sourceType: 'non_working_day' }],
      today: TODAY,
    });
    await expect(submit).rejects.toThrow(LeaveCreditSectionMismatchError);
    await expect(submit).rejects.toThrow('This date is a working day. Use Extended ordinary-day work instead.');
  });

  it('a NON-working day in Section B is refused with the mirror sentence', async () => {
    await setToilPolicy(ctx, extendedPolicy());
    const { employmentId } = await hire();
    await workRestDay(employmentId, REST_DAY);
    const submit = submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [{ workedDate: REST_DAY, fromTime: '17:00', toTime: '21:00', sourceType: 'extended_hours' }],
      today: TODAY,
    });
    await expect(submit).rejects.toThrow(LeaveCreditSectionMismatchError);
    await expect(submit).rejects.toThrow('This date is not a working day. Use Non-working-day work instead.');
  });

  it('the APPROVAL re-resolves the day too, so a roster that moves between submit and approve is caught', async () => {
    await setToilPolicy(ctx, extendedPolicy());
    const { employmentId, shiftId } = await hire();
    await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '22:00:00');
    const res = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [{ workedDate: WORKDAY, fromTime: '14:00', toTime: '22:00', sourceType: 'extended_hours' }],
      today: TODAY,
    });
    // The manager makes the same date a rest day after the employee submitted.
    await setRestDay(adminCtx(b), { employmentId, shiftDate: WORKDAY });
    await expect(
      decideReplacementLeaveRequest(ctx, { requestId: res.requestId, decision: 'approved', decidedAt: DECIDED_AT }),
    ).rejects.toThrow('This date is not a working day. Use Non-working-day work instead.');
    // And nothing was half-granted: the request is approved as a unit or not at all.
    expect(await replacementBalance(employmentId)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r336 · (c) under the half-day threshold blocks the submission', () => {
  it('239 eligible minutes is refused, and 240 is not', async () => {
    await setToilPolicy(ctx, extendedPolicy());
    const { employmentId, shiftId } = await hire();
    // Out at 17:59 ⇒ 239 minutes past a 14:00 shift end.
    const measured = await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '17:59:00');
    expect(measured).toBe(239);
    await expect(
      submitReplacementLeaveRequest(ctx, {
        employmentId,
        unit: 'day',
        lines: [{ workedDate: WORKDAY, fromTime: '14:00', toTime: '17:59', sourceType: 'extended_hours' }],
        today: TODAY,
      }),
    ).rejects.toThrow(ToilExtendedHoursBelowThresholdError);

    // A second day, one minute longer, is accepted — so the refusal is the threshold and not the fixture.
    const measured2 = await workShift(employmentId, shiftId, WORKDAY_2, '06:00:00', '18:00:00');
    expect(measured2).toBe(240);
    const ok = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [{ workedDate: WORKDAY_2, fromTime: '14:00', toTime: '18:00', sourceType: 'extended_hours' }],
      today: TODAY,
    });
    expect(ok.totalDays).toBe(0.5);
  });

  it('a claim NARROWED below the threshold is refused even though the day itself qualified', async () => {
    await setToilPolicy(ctx, extendedPolicy());
    const { employmentId, shiftId } = await hire();
    await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '22:00:00'); // 480 measured
    // The employee claims only two hours of it. The DAY would have earned a full day; the CLAIM earns none.
    await expect(
      submitReplacementLeaveRequest(ctx, {
        employmentId,
        unit: 'day',
        lines: [{ workedDate: WORKDAY, fromTime: '14:00', toTime: '16:00', sourceType: 'extended_hours' }],
        today: TODAY,
      }),
    ).rejects.toThrow(ToilExtendedHoursBelowThresholdError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * ⚠️⚠️ r353 cbfa8b0b · THE REVERSAL, END TO END THROUGH A REAL ATTENDANCE ROW AND A REAL APPROVAL.
 *
 * The pure cases above prove the arithmetic; these two prove that nothing between the form and the ledger
 * puts the ceiling back — `submitReplacementLeaveRequest` re-derives at submit and
 * `accrueExtendedWorkdayToilTx` re-derives again at approval, and either of them re-applying a cap of its own
 * would be invisible to a unit test of lib/extended-hours.ts.
 *
 * ⚠️ BOTH CASES WERE REFUSED BEFORE THIS ROUND, with `ToilExtendedHoursBelowThresholdError` at 0 counted
 * minutes. That is the non-vacuity: they are not new shapes that happen to pass, they are the reporter's
 * complaint reproduced through the whole stack.
 */
describe('r353 · a claim past the clock-out, and a day with no attendance row, both CREDIT', () => {
  it('⚠️ THE TICKET: clocked out AT the shift end, nothing measured, 351 minutes claimed ⇒ half a day banked', async () => {
    await setToilPolicy(ctx, extendedPolicy());
    const { employmentId, shiftId } = await hire();
    // Out at exactly the 14:00 shift end: the engine measures ZERO extended minutes, which is the reporter's
    // 18:00/18:00 pair with this fixture's shift times.
    const measured = await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '14:00:00');
    expect(measured, 'the fixture must measure nothing, or this case proves nothing').toBe(0);

    // 14:00 → 19:51 is 351 minutes. Under the old rule the clip gave 0 and the cap gave 0, and the submit
    // was refused; the claim is now the employee's window.
    const res = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [{ workedDate: WORKDAY, fromTime: '14:00', toTime: '19:51', sourceType: 'extended_hours' }],
      today: TODAY,
    });
    expect(res.totalDays).toBe(0.5);
    const [line] = await claimLines(employmentId);
    expect(line.eligibleMinutes).toBe(351);
    // The two times the approver's warning is derived FROM are stored on the line — no new column, no
    // migration, and the discrepancy is recomputable from them by `assessExtendedClaim`.
    expect(line.shiftEnd).toBe('14:00:00');
    expect(line.actualClockOut).toBe('14:00:00');
    expect(
      assessExtendedClaim({ claimStart: line.fromTime!, claimEnd: line.toTime!, shiftEnd: line.shiftEnd, actualClockOut: line.actualClockOut }),
    ).toEqual({ minutes: 351, hasClockOut: true, exceedsClockOut: true });

    // AND IT BANKS. The approval re-reads the live attendance row, so this is the second place a cap could
    // have survived.
    await decideReplacementLeaveRequest(ctx, { requestId: res.requestId, decision: 'approved', decidedAt: DECIDED_AT });
    expect(await replacementBalance(employmentId)).toBe(0.5);
    const [accrual] = await accruals(employmentId);
    expect(Number(accrual.daysCredited)).toBe(0.5);
    expect(accrual.otMinutes).toBe(351);
    // ⚠️ MONEY, UNCHANGED BY r353: `day_type` stays NULL on an extended-hours credit so `convertAmountFor`
    // cannot price a rounded-down tier as exact statutory cash. r334's decision, restated because this round
    // widened what can be claimed and therefore widened what could be mispriced.
    expect(accrual.dayType).toBeNull();
    expect(accrual.workedDayKind).toBe('workday');
  });

  it('a rostered working day with NO ATTENDANCE ROW credits, and the line records no clock-out', async () => {
    await setToilPolicy(ctx, extendedPolicy());
    const { employmentId, shiftId } = await hire();
    // Rostered, never clocked: `extendedHoursDayForTx` returns `actualClockOut: null` and 0 measured.
    await assignShift(adminCtx(b), { employmentId, shiftDate: WORKDAY, shiftId });

    const res = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [{ workedDate: WORKDAY, fromTime: '14:00', toTime: '19:51', sourceType: 'extended_hours' }],
      today: TODAY,
    });
    expect(res.totalDays).toBe(0.5);
    const [line] = await claimLines(employmentId);
    expect(line.eligibleMinutes).toBe(351);
    expect(line.actualClockOut, 'no row ⇒ no clock-out, which is what the screens print as "No record"').toBeNull();
    const a = assessExtendedClaim({
      claimStart: line.fromTime!,
      claimEnd: line.toTime!,
      shiftEnd: line.shiftEnd,
      actualClockOut: line.actualClockOut,
    });
    // "No record" and "clocked out earlier" are distinguished, and neither blocks the credit.
    expect(a.hasClockOut).toBe(false);
    expect(a.exceedsClockOut).toBe(false);
    await decideReplacementLeaveRequest(ctx, { requestId: res.requestId, decision: 'approved', decidedAt: DECIDED_AT });
    expect(await replacementBalance(employmentId)).toBe(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r336 · (d) the tiers, end to end through a real attendance row', () => {
  const cases: { out: string; measured: number; days: number }[] = [
    { out: '18:00:00', measured: 240, days: 0.5 },
    { out: '21:59:00', measured: 479, days: 0.5 },
    { out: '22:00:00', measured: 480, days: 1 },
    // Well past the full-day threshold and STILL one day — the cap, proved on real data rather than only
    // on the pure function.
    { out: '23:59:00', measured: 599, days: 1 },
  ];
  for (const c of cases) {
    it(`${c.measured} eligible minutes earns ${c.days} day(s)`, async () => {
      await setToilPolicy(ctx, extendedPolicy());
      const { employmentId, shiftId } = await hire();
      const measured = await workShift(employmentId, shiftId, WORKDAY, '06:00:00', c.out);
      expect(measured).toBe(c.measured);
      const res = await submitReplacementLeaveRequest(ctx, {
        employmentId,
        unit: 'day',
        lines: [{ workedDate: WORKDAY, fromTime: '14:00', toTime: c.out.slice(0, 5), sourceType: 'extended_hours' }],
        today: TODAY,
      });
      expect(res.totalDays).toBe(c.days);
      await decideReplacementLeaveRequest(ctx, { requestId: res.requestId, decision: 'approved', decidedAt: DECIDED_AT });
      expect(await replacementBalance(employmentId)).toBe(c.days);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r336 · (e)(f) the double-claim check, in BOTH directions, from ONE predicate', () => {
  it('the two status enums the one predicate serves carry the same blocking pair', () => {
    // BLOCKING_STATUSES is shared by both directions; this asserts the shared list is a valid member of
    // BOTH enums rather than assuming the two will stay identical.
    for (const s of BLOCKING_STATUSES) {
      expect(schema.replacementLeaveRequestStatusEnum.enumValues).toContain(s);
      expect(schema.attendanceCorrectionStatusEnum.enumValues).toContain(s);
    }
  });

  it('DIRECTION 1 — an open overtime claim blocks the Leave Credit for the same date', async () => {
    await setToilPolicy(ctx, extendedPolicy());
    const { employmentId, shiftId } = await hire();
    await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '22:00:00');
    await requestAttendanceCorrection(ctx, {
      employmentId,
      date: WORKDAY,
      requestedOtMinutes: 240,
      reason: 'Stayed late on the release',
    });
    const submit = submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [{ workedDate: WORKDAY, fromTime: '14:00', toTime: '22:00', sourceType: 'extended_hours' }],
      today: TODAY,
    });
    await expect(submit).rejects.toThrow(ClaimOverlapError);
    await expect(submit).rejects.toThrow(`An overtime claim is already open for ${WORKDAY}.`);
  });

  it('DIRECTION 2 — an open Leave Credit claim blocks the overtime claim for the same date', async () => {
    await setToilPolicy(ctx, extendedPolicy());
    const { employmentId } = await hire();
    await workRestDay(employmentId, REST_DAY);
    await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [{ workedDate: REST_DAY, days: 1, sourceType: 'non_working_day' }],
      today: TODAY,
    });
    const ot = requestAttendanceCorrection(ctx, {
      employmentId,
      date: REST_DAY,
      requestedOtMinutes: 480,
      reason: 'Worked the rest day',
    });
    await expect(ot).rejects.toThrow(ClaimOverlapError);
    await expect(ot).rejects.toThrow(`A Leave Credit request is already open for ${REST_DAY}.`);
  });

  it('DIRECTION 2 does NOT block a plain clock-time correction — only an overtime claim', async () => {
    await setToilPolicy(ctx, extendedPolicy());
    const { employmentId } = await hire();
    await workRestDay(employmentId, REST_DAY);
    await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [{ workedDate: REST_DAY, days: 1, sourceType: 'non_working_day' }],
      today: TODAY,
    });
    // A forgotten punch is not a claim on the day's hours, and a live credit must not make the day
    // un-correctable.
    const fix = await requestAttendanceCorrection(ctx, {
      employmentId,
      date: REST_DAY,
      checkIn: '08:05:00',
      checkOut: '17:00:00',
      reason: 'Badge reader was down',
    });
    expect(fix.correctionId).toBeTruthy();
  });

  it('(f) REJECTING the overtime claim releases the block, and an APPROVED one still holds it', async () => {
    await setToilPolicy(ctx, extendedPolicy());
    const { employmentId, shiftId } = await hire();
    await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '22:00:00');
    const { correctionId } = await requestAttendanceCorrection(ctx, {
      employmentId,
      date: WORKDAY,
      requestedOtMinutes: 240,
      reason: 'Stayed late',
    });
    const claim = () =>
      submitReplacementLeaveRequest(ctx, {
        employmentId,
        unit: 'day',
        lines: [{ workedDate: WORKDAY, fromTime: '14:00', toTime: '22:00', sourceType: 'extended_hours' }],
        today: TODAY,
      });
    await expect(claim()).rejects.toThrow(ClaimOverlapError);
    await decideAttendanceCorrection(ctx, { correctionId, decision: 'rejected', rejectReason: 'Fixture rejection explanation' });
    // Released. The employee whose overtime was refused may now claim the credit instead, which is the
    // whole point of asking.
    const res = await claim();
    expect(res.totalDays).toBe(1);
  });

  it('an APPROVED overtime claim keeps blocking — only rejected and cancelled release', async () => {
    await setToilPolicy(ctx, extendedPolicy());
    const { employmentId, shiftId } = await hire();
    await workShift(employmentId, shiftId, WORKDAY_3, '06:00:00', '22:00:00');
    const { correctionId } = await requestAttendanceCorrection(ctx, {
      employmentId,
      date: WORKDAY_3,
      requestedOtMinutes: 240,
      reason: 'Stayed late',
    });
    await decideAttendanceCorrection(ctx, { correctionId, decision: 'approved' });
    await expect(
      submitReplacementLeaveRequest(ctx, {
        employmentId,
        unit: 'day',
        lines: [{ workedDate: WORKDAY_3, fromTime: '14:00', toTime: '22:00', sourceType: 'extended_hours' }],
        today: TODAY,
      }),
    ).rejects.toThrow(ClaimOverlapError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r336 · (g) ⚠️ MONEY — payroll behaves exactly as r334 left it', () => {
  it('an approved Section B credit suppresses the day’s overtime pay, and day_type stays NULL', async () => {
    await setToilPolicy(ctx, extendedPolicy());
    const { employmentId, shiftId } = await hire(3000); // below the ceiling: statutory OT would apply
    await setToilPolicy(ctx, extendedPolicy({ allowFirstScheduleEligible: true }));
    await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '22:00:00');

    const res = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [{ workedDate: WORKDAY, fromTime: '14:00', toTime: '22:00', sourceType: 'extended_hours' }],
      firstScheduleConsent: true,
      today: TODAY,
    });
    await decideReplacementLeaveRequest(ctx, { requestId: res.requestId, decision: 'approved', decidedAt: DECIDED_AT });

    const [row] = await accruals(employmentId);
    // ⚠️ THE GUARD r299 AND r334 BOTH CLOSED. `convertAmountFor` prices a First-Schedule credit as exact
    // statutory cash over `ot_minutes` ONLY when `day_type` is non-null, and the tier ROUNDS DOWN — so a
    // stamped day type would cash out time this credit never banked. NULL is what routes it to the ORP
    // fallback. `eligible_minutes` on the claim line is a RECORD, and this is the assertion that keeps it
    // from becoming a cash input.
    expect(row.dayType).toBeNull();
    expect(row.workedDayKind).toBe('workday');
    expect(row.otMinutes).toBe(480);
    expect(Number(row.daysCredited)).toBe(1);

    // And the money: the banked day is out of the overtime prefill AND off the payslip.
    const money = await overtimeMoney(employmentId);
    expect(money.input).toBe(0);
    expect(money.payslip).toBe(0);
  });

  it('a day with NO credit still pays its overtime — the suppression is the credit, not this round', async () => {
    await setToilPolicy(ctx, extendedPolicy());
    const { employmentId, shiftId } = await hire(3000);
    await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '22:00:00');
    const money = await overtimeMoney(employmentId);
    expect(money.input).toBeGreaterThan(0);
    expect(money.payslip).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r336 · the screen’s own contracts', () => {
  it('the unit is always Day: an Hour request carrying a Section B row is refused', async () => {
    await setToilPolicy(ctx, extendedPolicy());
    const { employmentId, shiftId } = await hire();
    await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '22:00:00');
    await expect(
      submitReplacementLeaveRequest(ctx, {
        employmentId,
        unit: 'hour',
        lines: [{ workedDate: WORKDAY, fromTime: '14:00', toTime: '22:00', sourceType: 'extended_hours' }],
        today: TODAY,
      }),
    ).rejects.toThrow(ReplacementRequestInvalidError);
  });

  it('a TAGGED Section A row is 1 or 0.5 only; an UNTAGGED legacy row keeps the old contract', async () => {
    await setToilPolicy(ctx, extendedPolicy());
    const { employmentId } = await hire();
    await workRestDay(employmentId, REST_DAY);
    await workRestDay(employmentId, REST_DAY_2);
    await expect(
      submitReplacementLeaveRequest(ctx, {
        employmentId,
        unit: 'day',
        lines: [{ workedDate: REST_DAY, days: 2, sourceType: 'non_working_day' }],
        today: TODAY,
      }),
    ).rejects.toThrow(ReplacementRequestInvalidError);
    // The pre-r336 caller, unchanged: no sourceType, any figure above zero.
    const legacy = await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [{ workedDate: REST_DAY_2, days: 2 }],
      today: TODAY,
    });
    expect(legacy.totalDays).toBe(2);
    const lines = await claimLines(employmentId);
    // NULL, not 'non_working_day': the column's documented meaning is "written before r336 ⇒ Section A",
    // and stamping a value on a caller that never said one would erase that distinction.
    expect(lines.find((l) => l.workedDate === REST_DAY_2)!.sourceType).toBeNull();
  });

  it('Section B is not offered at all where the company switch is off, and the service refuses it too', async () => {
    await setToilPolicy(ctx, policy()); // extendedHoursEnabled defaults to false
    const { employmentId, shiftId } = await hire();
    await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '22:00:00');
    expect(await extendedHoursOfferForEmployment(ctx, employmentId)).toBeNull();
    await expect(
      submitReplacementLeaveRequest(ctx, {
        employmentId,
        unit: 'day',
        lines: [{ workedDate: WORKDAY, fromTime: '14:00', toTime: '22:00', sourceType: 'extended_hours' }],
        today: TODAY,
      }),
    ).rejects.toThrow('Extended hours on an ordinary working day are not switched on for this company.');
  });

  it('the offer carries the COMPANY’s tier figures, so the screen cannot promise r334 defaults', async () => {
    await setToilPolicy(ctx, extendedPolicy({ extendedHalfDayMinutes: 180, extendedFullDayMinutes: 360, extendedGraceMinutes: 15 }));
    const { employmentId } = await hire();
    expect(await extendedHoursOfferForEmployment(ctx, employmentId)).toEqual({
      extendedHalfDayMinutes: 180,
      extendedFullDayMinutes: 360,
      extendedBreakMinutes: 0,
      extendedGraceMinutes: 15,
    });
  });

  it('the approver’s queue names the credit source per row and carries Section B’s four facts', async () => {
    await setToilPolicy(ctx, extendedPolicy());
    const { employmentId, shiftId } = await hire();
    await workRestDay(employmentId, REST_DAY);
    await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '22:00:00');
    await submitReplacementLeaveRequest(ctx, {
      employmentId,
      unit: 'day',
      lines: [
        { workedDate: REST_DAY, days: 1, sourceType: 'non_working_day' },
        { workedDate: WORKDAY, fromTime: '14:00', toTime: '22:00', sourceType: 'extended_hours' },
      ],
      today: TODAY,
    });
    const [req] = await listPendingReplacementLeaveRequests(ctx, { companyIds: [b.companyId] });
    const a = req.dates.find((d) => d.workedDate === REST_DAY)!;
    const bLine = req.dates.find((d) => d.workedDate === WORKDAY)!;
    expect(a.sourceType).toBe('non_working_day');
    expect(bLine.sourceType).toBe('extended_hours');
    expect(bLine.shiftEnd).toBe('14:00:00');
    expect(bLine.actualClockOut).toBe('22:00:00');
    expect(bLine.fromTime).toBe('14:00:00');
    expect(bLine.toTime).toBe('22:00:00');
    expect(bLine.eligibleMinutes).toBe(480);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r336 · the OFF-day finding, measured rather than assumed', () => {
  /**
   * r334 recorded that an OFF day has never been bankable FROM THE ROSTER ELECTION, because
   * `attendance.day_type` says 'workday' for one and `extendedWorkdayCreditTx` then refuses it. The ticket
   * lists an off day under Section A, so this round has to know whether the EMPLOYEE REQUEST path agrees.
   * It does not, and that is the correct behaviour rather than a divergence to close: `workedDayKindForTx`
   * resolves an off day as its own kind, and Section A accepts every non-working kind.
   */
  it('an OFF day resolves as its own kind and IS claimable in Section A', async () => {
    await setToilPolicy(ctx, extendedPolicy());
    const a = adminCtx(b);
    const e = await hireEmployee(a, {
      person: { fullName: 'Off Day Claimant', primaryEmail: uniqEmail() },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2024-01-01',
    });
    await setCompensation(a, { employmentId: e.employmentId, basicSalary: 8000, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
    // b8aa3466's four-way weekly row: Mon–Fri are working days, SATURDAY is the OFF day, and Sunday — in
    // none of the three arrays — is the statutory rest day. The shift is the employment's DEFAULT, with no
    // roster entry for the Saturday at all: it is the PATTERN that decides, which is the branch
    // `workedDayKindForTx` reads `source: 'default-shift-rest'` from.
    const shift = await createShift(a, {
      companyId: b.companyId,
      name: `Off ${Math.random().toString(36).slice(2, 7)}`,
      code: `O_${Math.random().toString(36).slice(2, 8)}`,
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
      offPattern: [6],
    });
    await assignDefaultShift(a, { employmentId: e.employmentId, shiftId: shift.id });
    const SATURDAY = weekdayIn(6);
    // MEASURED, not assumed: the kind this round reports on.
    const resolvedKind = await workedDayKindForEmployment(ctx, e.employmentId, SATURDAY);
    expect(resolvedKind).toBe('off_day');
    const res = await submitReplacementLeaveRequest(ctx, {
      employmentId: e.employmentId,
      unit: 'day',
      lines: [{ workedDate: SATURDAY, days: 1, sourceType: 'non_working_day' }],
      today: TODAY,
    });
    const [line] = await claimLines(e.employmentId);
    // The recorded finding: the employee-request path stores the OFF day as its own kind and credits it,
    // where the ROSTER election refuses the same day. See this describe block's header.
    expect(line.workedDayKind).toBe('off_day');
    expect(res.totalDays).toBe(1);
  });
});
