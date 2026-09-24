/**
 * r336 · cbfa8b0b — THE LEAVE CREDIT REQUEST SCREEN: one modal, two kinds of claim, and the
 * double-claim check that runs in BOTH directions.
 *
 * WHAT THIS FILE DEFENDS, in the order the risk sits:
 *
 *  1. THE TWO SECTIONS ARE VALIDATED AGAINST OPPOSITE FACTS. Section A needs a NON-working day, Section B
 *     needs a WORKING day, and each refusal names the other section. A single shared "is this date
 *     claimable" check would pass one of these and fail the other silently.
 *  2. SECTION B'S CREDIT IS DERIVED, NEVER TYPED. The claim narrows a measured figure and can never widen
 *     it, which is the safety property: the screen cannot mint minutes, so it cannot mint a credit, so it
 *     cannot suppress overtime pay for time nobody worked.
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
import { eligibleExtendedMinutes, extendedHoursCreditDays } from '../lib/extended-hours';
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

  it('the claimed window NARROWS the measured figure and can never widen it', () => {
    const day = { shiftEnd: '14:00:00', actualClockOut: '22:00:00', measuredExtendedMinutes: 480 };
    // Claiming the whole measured span gives the whole measured span.
    expect(eligibleExtendedMinutes({ claimStart: '14:00', claimEnd: '22:00', ...day })).toBe(480);
    // Claiming LESS gives less — an employee may claim only part of what they worked.
    expect(eligibleExtendedMinutes({ claimStart: '14:00', claimEnd: '18:00', ...day })).toBe(240);
    // Claiming MORE gives no more: the measured cap holds even when the window is a whole day.
    expect(eligibleExtendedMinutes({ claimStart: '00:00', claimEnd: '23:59', ...day })).toBe(480);
    // ⚠️ THE SAFETY PROPERTY. A day the engine measured at ZERO extended minutes can never be claimed,
    // however wide the window — which is what stops the screen minting minutes, and therefore pay.
    expect(
      eligibleExtendedMinutes({ claimStart: '14:00', claimEnd: '22:00', shiftEnd: '14:00:00', actualClockOut: '22:00:00', measuredExtendedMinutes: 0 }),
    ).toBe(0);
  });

  it('clips to the scheduled shift end and the actual clock-out so the figure matches the times printed beside it', () => {
    // An hour claimed BEFORE the shift ended is not extended work.
    expect(
      eligibleExtendedMinutes({ claimStart: '13:00', claimEnd: '18:00', shiftEnd: '14:00:00', actualClockOut: '18:00:00', measuredExtendedMinutes: 600 }),
    ).toBe(240);
    // An hour claimed AFTER the clock-out was not worked.
    expect(
      eligibleExtendedMinutes({ claimStart: '14:00', claimEnd: '19:00', shiftEnd: '14:00:00', actualClockOut: '18:00:00', measuredExtendedMinutes: 600 }),
    ).toBe(240);
    // Cross-midnight: 18:00 → 00:30 is six and a half hours, not a negative span.
    expect(
      eligibleExtendedMinutes({ claimStart: '18:00', claimEnd: '00:30', shiftEnd: '18:00:00', actualClockOut: '00:30:00', measuredExtendedMinutes: 600 }),
    ).toBe(390);
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
    await decideAttendanceCorrection(ctx, { correctionId, decision: 'rejected' });
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
