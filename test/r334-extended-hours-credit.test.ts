/**
 * r334 · 928f0454 — EXTENDED-HOURS REPLACEMENT LEAVE CREDIT.
 *
 * Until r334 a plain workday's overtime was cash-only: `RL_ELIGIBLE_DAY_TYPES` (core/toil.ts) is a NAMED
 * ENGINE RULE — "RL Control Engine (0113): only work on a Rest Day or Public Holiday is eligible for
 * replacement leave" — not a gap. r334 opens a SEPARATE tiered path beside it, behind a per-company switch
 * that is OFF by default, and this file is what pins that the two paths stay separate.
 *
 * ⚠️ EVERY TEST HERE IS A MONEY TEST. A credit suppresses the worked day's overtime PAY
 * (core/payroll.ts `EXCLUDE_TOIL_BANKED_DAYS`, both reads, unconditional), so the assertions below read the
 * PAYSLIP, not only the leave ledger. A ledger-only assertion would pass over a silently unpaid payslip.
 *
 * Dates are derived from `todayInKualaLumpur()` (CLAUDE.md §8): the worked days sit in LAST calendar month,
 * so they are always in the past and always inside one payroll period.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, entitledCtx, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { checkIn, checkOut } from '../core/attendance';
import { assignShift, createShift, setRestDay } from '../core/roster';
import { createBatch, generatePayslips, prefillOvertimeFromAttendance } from '../core/payroll';
import { todayInKualaLumpur } from '../lib/hr-date';
import {
  accrueToil,
  extendedHoursCreditDays,
  extendedMinutesAfterShiftEnd,
  grantLeaveCredit,
  LeaveCreditError,
  previewLeaveCredit,
  setToilPolicy,
  ToilAlreadyAccruedError,
  ToilExtendedHoursBelowThresholdError,
  ToilFirstScheduleConsentRequiredError,
  ToilNotEligibleError,
  ToilOrdinaryWorkingDayError,
  type ToilPolicyInput,
} from '../core/toil';
import type { SessionContext } from '../db/client';

let b: Base;
let ctx: SessionContext;

const TODAY = todayInKualaLumpur();
/** 'YYYY-MM' of the calendar month before `iso`. */
const monthBefore = (iso: string) => {
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
};
const PERIOD = monthBefore(TODAY);
/** The first date in PERIOD with this ISO weekday (1 = Monday … 7 = Sunday). */
const weekdayIn = (isoWeekday: number) => {
  for (let d = 1; d <= 7; d++) {
    const date = `${PERIOD}-${String(d).padStart(2, '0')}`;
    if ((new Date(`${date}T00:00:00Z`).getUTCDay() || 7) === isoWeekday) return date;
  }
  throw new Error('unreachable');
};
/** A Wednesday and a Thursday: both inside the shift's Mon–Fri pattern, so both are ordinary working days. */
const WORKDAY = weekdayIn(3);
const WORKDAY_2 = weekdayIn(4);
/** A Sunday in the same period, made a rostered rest day — the pinned, unchanged half of the feature. */
const REST_DAY = weekdayIn(7);

const uniqEmail = () => `r334eh_${Math.random().toString(36).slice(2)}@t.local`;

/**
 * THE PRE-r334 REFUSALS, AS LITERALS. Copied out of `main` and asserted byte for byte: the whole point of
 * the switch is that a company which leaves it off cannot tell r334 shipped. A reworded message would be a
 * behaviour change for every existing customer, so these two strings are the contract, not decoration.
 */
const WORKDAY_CASH_ONLY = 'Replacement leave can only be banked for work on a rest day or public holiday.';
const ordinaryWorkingDayMessage = (date: string) =>
  `Only a rest day, off day or public holiday can earn a Leave Credit. ${date} is an ordinary working day for this employee.`;

const policy = (over: Partial<ToilPolicyInput> = {}): ToilPolicyInput => ({
  companyId: b.companyId,
  enabled: true,
  accrualBasis: 'hours_worked',
  expiryDays: 90,
  onExpiry: 'convert_to_pay',
  // Default OFF everywhere below unless a test switches it on — the shape every existing caller already has.
  allowFirstScheduleEligible: false,
  autoAccrueOnApproval: false,
  carryForwardAtYearEnd: false,
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

/**
 * A Mon–Fri 06:00–14:00 shift, so the SCHEDULED SHIFT END is 14:00 and anything clocked past it is the
 * figure this feature is about. 06:00 start leaves room to clock out at 23:00 without crossing midnight,
 * which keeps the `window` OT basis (clock-out minus shift end) the one that runs.
 */
async function hire(basic: number, name = 'Extended Worker') {
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
  return { a, employmentId: e.employmentId, shiftId: shift.id };
}

/** Work one rostered workday, in at `inAt` and out at `outAt`. Returns the engine's own `ot_minutes`. */
async function workShift(
  employmentId: string,
  shiftId: string,
  date: string,
  inAt: string,
  outAt: string,
): Promise<number> {
  const a = adminCtx(b);
  await assignShift(a, { employmentId, shiftDate: date, shiftId });
  await checkIn(a, { employmentId, date, time: inAt });
  await checkOut(a, { employmentId, date, time: outAt });
  const [row] = await owner.db
    .select({ otMinutes: schema.attendance.otMinutes, dayType: schema.attendance.dayType })
    .from(schema.attendance)
    .where(and(eq(schema.attendance.employmentId, employmentId), eq(schema.attendance.attendanceDate, date)));
  // The fixture is only evidence if the engine really saw an ordinary working day.
  expect(row.dayType, 'the fixture must be an ordinary working day').toBe('workday');
  return row.otMinutes ?? 0;
}

/** A full rostered rest day, 08:00–17:00 ⇒ 480 minutes, all of it overtime. The unchanged half. */
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

const accrualRow = async (employmentId: string) =>
  (await owner.db.select().from(schema.toilAccrual).where(eq(schema.toilAccrual.employmentId, employmentId)))[0];

const policyRow = async () =>
  (await owner.db.select().from(schema.toilPolicy).where(eq(schema.toilPolicy.companyId, b.companyId)))[0];

/**
 * ⚠️ THE MONEY READ. Run payroll for PERIOD and return BOTH figures a credit can move: the prefilled
 * `payroll_input.overtime_amount` and the generated `payslip.overtime_pay`. The payslip is the one the brief
 * demands, and it is a different row written by a different function, so asserting only the input would not
 * prove the money moved.
 */
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
describe('r334 · the pure arithmetic (one owner for the tiers, one owner for the hours)', () => {
  const P = { extendedHalfDayMinutes: 240, extendedFullDayMinutes: 480, extendedBreakMinutes: 0, extendedGraceMinutes: 0 };

  it('rounds DOWN with no partial credit, and one day is the cap however long the day ran', () => {
    expect(extendedHoursCreditDays(0, P)).toEqual({ countedMinutes: 0, days: 0 });
    expect(extendedHoursCreditDays(239, P)).toEqual({ countedMinutes: 239, days: 0 });
    expect(extendedHoursCreditDays(240, P)).toEqual({ countedMinutes: 240, days: 0.5 });
    expect(extendedHoursCreditDays(479, P)).toEqual({ countedMinutes: 479, days: 0.5 });
    expect(extendedHoursCreditDays(480, P)).toEqual({ countedMinutes: 480, days: 1 });
    // The cap: three times the full-day threshold is still one day. A proportional basis would say 3.
    expect(extendedHoursCreditDays(1440, P).days).toBe(1);
  });

  it('takes the break and the grace period off BEFORE the thresholds are tested', () => {
    // 4h01m worked past the end, 30m of it an unpaid break ⇒ 211 counted ⇒ nothing. Deducting AFTER the
    // test would have credited half a day for time the policy says was not extended work.
    expect(extendedHoursCreditDays(241, { ...P, extendedBreakMinutes: 30 })).toEqual({ countedMinutes: 211, days: 0 });
    // The grace period is a SUBTRACTION, not a cut-off: 4h15m with a 15-minute grace is exactly 4h counted.
    expect(extendedHoursCreditDays(255, { ...P, extendedGraceMinutes: 15 })).toEqual({ countedMinutes: 240, days: 0.5 });
    // Both, in order, and never below zero.
    expect(extendedHoursCreditDays(10, { ...P, extendedBreakMinutes: 30, extendedGraceMinutes: 30 })).toEqual({
      countedMinutes: 0,
      days: 0,
    });
  });

  it('EARLY CLOCK-IN: takes back the pre-shift minutes a company OT rule folded into ot_minutes', () => {
    // The ordinary case — the `window` basis never folded them in, so nothing is subtracted.
    expect(extendedMinutesAfterShiftEnd({ otMinutes: 360, calcTrace: null })).toBe(360);
    const trace = (over: Record<string, unknown>) => ({
      v: 1,
      schedule: {},
      punch: {},
      overtime: { basis: 'window', earlyMinutes: 0, earlyIncluded: false, ...over },
    });
    expect(extendedMinutesAfterShiftEnd({ otMinutes: 480, calcTrace: trace({ earlyMinutes: 120, earlyIncluded: true }) })).toBe(360);
    // Recorded but NOT folded in (applyToEarlyOt off) ⇒ ot_minutes is already post-shift-end only.
    expect(extendedMinutesAfterShiftEnd({ otMinutes: 360, calcTrace: trace({ earlyMinutes: 120, earlyIncluded: false }) })).toBe(360);
    // A trace of another version, or none at all, is not trusted — the pre-r334 arithmetic stands.
    expect(extendedMinutesAfterShiftEnd({ otMinutes: 480, calcTrace: { v: 99, overtime: { earlyMinutes: 120, earlyIncluded: true } } })).toBe(480);
    expect(extendedMinutesAfterShiftEnd({ otMinutes: null, calcTrace: null })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r334 · (f) the switch OFF reproduces today’s refusal, byte for byte', () => {
  it('the roster election refuses an ordinary working day with the pre-r334 sentence', async () => {
    const { employmentId, shiftId } = await hire(5000);
    expect(await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '23:00:00')).toBe(540);
    await setToilPolicy(ctx, policy()); // enabled, extended hours NOT switched on
    expect((await policyRow()).extendedHoursEnabled, 'the column default must be OFF').toBe(false);
    await expect(accrueToil(ctx, { employmentId, workedDate: WORKDAY })).rejects.toThrow(WORKDAY_CASH_ONLY);
    await expect(accrueToil(ctx, { employmentId, workedDate: WORKDAY })).rejects.toBeInstanceOf(ToilNotEligibleError);
    expect(await accrualRow(employmentId), 'a refused election writes nothing').toBeUndefined();
  });

  it('a company with NO saved policy at all gets the same sentence, not ToilDisabledError', async () => {
    // Ordering matters and is pinned: step 1b has always fired before step 2's "is the policy enabled"
    // check, so a company that never configured TOIL sees the day-type message rather than the module one.
    const { employmentId, shiftId } = await hire(5000);
    await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '23:00:00');
    await expect(accrueToil(ctx, { employmentId, workedDate: WORKDAY })).rejects.toThrow(WORKDAY_CASH_ONLY);
  });

  it('HR’s Add Leave Credit refuses an ordinary working day with the pre-r334 sentence', async () => {
    const { employmentId, shiftId } = await hire(5000);
    await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '23:00:00');
    await setToilPolicy(ctx, policy());
    await expect(
      grantLeaveCredit(ctx, { employmentId, workedDate: WORKDAY, days: 1, reason: 'Stayed late', today: TODAY }),
    ).rejects.toThrow(ordinaryWorkingDayMessage(WORKDAY));
    await expect(
      grantLeaveCredit(ctx, { employmentId, workedDate: WORKDAY, days: 1, reason: 'Stayed late', today: TODAY }),
    ).rejects.toBeInstanceOf(ToilOrdinaryWorkingDayError);
    // And the form says so before save, exactly as before.
    expect(await previewLeaveCredit(ctx, { employmentId, workedDate: WORKDAY })).toMatchObject({
      workedDayKind: 'workday',
      eligibleDay: false,
      extendedHoursEnabled: false,
      extendedHoursMinutes: null,
      extendedHoursDays: null,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r334 · (a)(b)(c) the tiers, and ⚠️ THE PAYSLIP', () => {
  it('(a) below the half-day threshold: no credit, and the day’s overtime is still PAID in full', async () => {
    const { employmentId, shiftId } = await hire(5000);
    // 14:00 shift end, out at 17:59 ⇒ 239 minutes: one minute short of four hours.
    expect(await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '17:59:00')).toBe(239);
    await setToilPolicy(ctx, extendedPolicy());

    await expect(accrueToil(ctx, { employmentId, workedDate: WORKDAY })).rejects.toBeInstanceOf(
      ToilExtendedHoursBelowThresholdError,
    );
    await expect(accrueToil(ctx, { employmentId, workedDate: WORKDAY })).rejects.toThrow(
      `${WORKDAY} is an ordinary working day. Extended hours after the scheduled shift end earn a Leave Credit only from 240 minutes; this day counted 239.`,
    );
    expect(await replacementBalance(employmentId)).toBe(0);
    expect(await accrualRow(employmentId)).toBeUndefined();

    // ⚠️ MONEY — the overtime is untouched on BOTH rows.
    const money = await overtimeMoney(employmentId);
    expect(money.input, 'a refused credit must leave the prefill alone').toBeGreaterThan(0);
    expect(money.payslip, 'and the payslip must still pay the day').toBeCloseTo(money.input, 2);
  });

  it('(b) at the half-day threshold: 0.5 day banked, and THE PAYSLIP’S OVERTIME FIGURE MOVES TO ZERO', async () => {
    const { employmentId, shiftId } = await hire(5000);
    expect(await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '18:00:00')).toBe(240);
    await setToilPolicy(ctx, extendedPolicy());

    // The figure BEFORE any credit exists, measured rather than asserted from a constant — this is what has
    // to move, and a test that did not measure it first could not prove that it did.
    const before = await overtimeMoney(employmentId);
    expect(before.payslip, 'the fixture must really pay overtime, or (b) proves nothing').toBeGreaterThan(0);
    // Delete the run so the credit is added to a clean month (a credit on a date whose payroll has started is
    // refused on the HR path; the roster path has no such guard, and reusing the batch would compare two
    // different runs). Removing the batch cascades its inputs and payslips.
    await owner.db.delete(schema.payrollBatch).where(eq(schema.payrollBatch.tenantId, b.tenantId));

    const r = await accrueToil(ctx, { employmentId, workedDate: WORKDAY });
    expect(r.daysCredited).toBe(0.5);
    expect(await replacementBalance(employmentId)).toBe(0.5);

    const acc = await accrualRow(employmentId);
    expect(acc.workedDayKind, 'the kind that earned it is recorded, never guessed').toBe('workday');
    // ⚠️ MONEY: NULL day type on purpose — the tier rounds DOWN from the measured minutes, so the expiry
    // sweep must not price it through the exact s.60A workday-OT branch. See extendedWorkdayCreditTx.
    expect(acc.dayType).toBeNull();
    expect(acc.otMinutes, 'the counted minutes the tier was decided from').toBe(240);
    expect(Number(acc.daysCredited)).toBe(0.5);

    const after = await overtimeMoney(employmentId);
    expect(after.payslip, 'the credited day’s overtime must stop being paid').toBe(0);
    expect(after.input).toBe(0);
    expect(after.payslip, 'and that must be a MOVE, not the fixture having been zero all along').not.toBeCloseTo(
      before.payslip,
      2,
    );
  });

  it('(c) at or above the full-day threshold: exactly 1.0 day, capped, never more', async () => {
    const { employmentId, shiftId } = await hire(5000);
    // Out at 23:00 ⇒ 540 minutes past the 14:00 end. 540/480 = 1.125 of a "full day" — a proportional basis
    // would bank more than a day, and the reporter's cap says it must not.
    expect(await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '23:00:00')).toBe(540);
    await setToilPolicy(ctx, extendedPolicy());
    const r = await accrueToil(ctx, { employmentId, workedDate: WORKDAY });
    expect(r.daysCredited).toBe(1);
    expect(await replacementBalance(employmentId)).toBe(1);
    expect((await overtimeMoney(employmentId)).payslip, 'a full-day credit suppresses the day’s OT pay too').toBe(0);
  });

  it('the `premium_equivalent` basis does NOT uplift a tier — 1.0 day stays 1.0, not 1.5', async () => {
    // The tiers and the accrual basis are two answers to one question; only the tiers price a working day.
    const { employmentId, shiftId } = await hire(5000);
    await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '23:00:00');
    await setToilPolicy(ctx, extendedPolicy({ accrualBasis: 'premium_equivalent' }));
    const r = await accrueToil(ctx, { employmentId, workedDate: WORKDAY });
    expect(r.daysCredited, 'PREMIUM_MULT.workday is 1.5 and must never reach a tier').toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r334 · (d) one credit per employee per date, and (e) early clock-in', () => {
  it('(d) a second credit on the same date is refused', async () => {
    const { employmentId, shiftId } = await hire(5000);
    await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '18:00:00');
    await setToilPolicy(ctx, extendedPolicy());
    expect((await accrueToil(ctx, { employmentId, workedDate: WORKDAY })).daysCredited).toBe(0.5);
    await expect(accrueToil(ctx, { employmentId, workedDate: WORKDAY })).rejects.toBeInstanceOf(ToilAlreadyAccruedError);
    // And HR's own form cannot get a second one in either.
    await expect(
      grantLeaveCredit(ctx, { employmentId, workedDate: WORKDAY, days: 0.5, reason: 'Again', today: TODAY }),
    ).rejects.toBeInstanceOf(ToilAlreadyAccruedError);
    expect(await replacementBalance(employmentId), 'still exactly one credit').toBe(0.5);
  });

  it('(e) clocking in early contributes nothing: the same clock-out earns the same tier', async () => {
    const { employmentId, shiftId } = await hire(5000);
    // Two hours EARLY (04:00 against a 06:00 start) and out at 20:00 ⇒ six hours past the 14:00 end.
    // If the pre-shift time counted, the figure would be 360 + 120 = 480 and the credit a FULL day.
    const measured = await workShift(employmentId, shiftId, WORKDAY, '04:00:00', '20:00:00');
    expect(measured, 'the engine itself counts only minutes past the shift END').toBe(360);
    await setToilPolicy(ctx, extendedPolicy());
    const r = await accrueToil(ctx, { employmentId, workedDate: WORKDAY });
    expect(r.daysCredited, 'half a day — the two early hours must not have tipped it to a full day').toBe(0.5);
    expect((await accrualRow(employmentId)).otMinutes).toBe(360);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r334 · (g) the First-Schedule consent gate is ridden, not bypassed', () => {
  it('refuses a First-Schedule employee with NO consent, even with the switch and the override both on', async () => {
    const { employmentId, shiftId } = await hire(3000); // ≤ RM4,000 ⇒ statutory OT cash normally applies
    await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '23:00:00');
    await setToilPolicy(ctx, extendedPolicy({ allowFirstScheduleEligible: true }));
    await expect(accrueToil(ctx, { employmentId, workedDate: WORKDAY })).rejects.toBeInstanceOf(
      ToilFirstScheduleConsentRequiredError,
    );
    expect(await accrualRow(employmentId), 'a refused accrual writes nothing').toBeUndefined();
    // ⚠️ MONEY: the statutory overtime cash is still on the payslip, which is the point of refusing.
    expect((await overtimeMoney(employmentId)).payslip).toBeGreaterThan(0);
  });

  it('refuses a First-Schedule employee when the company override is OFF, whatever the extended switch says', async () => {
    const { employmentId, shiftId } = await hire(3000);
    await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '23:00:00');
    await setToilPolicy(ctx, extendedPolicy({ allowFirstScheduleEligible: false }));
    await expect(
      accrueToil(ctx, { employmentId, workedDate: WORKDAY, firstScheduleConsent: true }),
    ).rejects.toThrow(/within the First Schedule/);
  });

  it('banks with the override AND recorded consent, and forces convert-on-expiry', async () => {
    const { employmentId, shiftId } = await hire(3000);
    await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '23:00:00');
    await setToilPolicy(ctx, extendedPolicy({ allowFirstScheduleEligible: true }));
    const r = await accrueToil(ctx, { employmentId, workedDate: WORKDAY, firstScheduleConsent: true });
    expect(r.daysCredited).toBe(1);
    expect(r.forcedConvertOnExpiry).toBe(true);
    const acc = await accrualRow(employmentId);
    expect(acc.firstScheduleConsent).toBe(true);
    expect(acc.expiryAction).toBe('convert_to_pay');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r334 · rest day / off day / holiday are byte-identical', () => {
  it('a rest day still banks through the accrual BASIS, untouched by the tiers', async () => {
    const { employmentId } = await hire(5000);
    await workRestDay(employmentId, REST_DAY);
    // Switch ON, and with thresholds that would have credited 0.5 for 480 minutes if the tiers leaked in.
    await setToilPolicy(ctx, extendedPolicy({ extendedHalfDayMinutes: 240, extendedFullDayMinutes: 960 }));
    const r = await accrueToil(ctx, { employmentId, workedDate: REST_DAY });
    expect(r.daysCredited, '480 measured minutes over a standard day = 1.0, the pre-r334 answer').toBe(1);
    const acc = await accrualRow(employmentId);
    expect(acc.dayType, 'a rest day still stamps its day type — its statutory valuation is exact').toBe('rest_day');
    expect(acc.workedDayKind).toBe('rest_day');
    expect(acc.otMinutes).toBe(480);
  });

  it('a rest day under `premium_equivalent` still uplifts by the day-type multiplier (2x)', async () => {
    const { employmentId } = await hire(5000);
    await workRestDay(employmentId, REST_DAY);
    await setToilPolicy(ctx, extendedPolicy({ accrualBasis: 'premium_equivalent' }));
    expect((await accrueToil(ctx, { employmentId, workedDate: REST_DAY })).daysCredited).toBe(2);
  });

  it('a rest day’s preview answers null to every extended-hours question', async () => {
    const { employmentId } = await hire(5000);
    await workRestDay(employmentId, REST_DAY);
    await setToilPolicy(ctx, extendedPolicy());
    expect(await previewLeaveCredit(ctx, { employmentId, workedDate: REST_DAY })).toMatchObject({
      workedDayKind: 'rest_day',
      eligibleDay: true,
      extendedHoursEnabled: true,
      extendedHoursMinutes: null,
      extendedHoursDays: null,
    });
  });

  it('MEASURED: the roster election has NEVER been able to bank an OFF day, and r334 does not change that', async () => {
    // `attendance_day_type` is a three-value enum and `scheduleFor` resolves an off day as dayType 'workday'
    // with scheduledMinutes 0, so the roster path's day-type refusal has always caught an off day too. r334's
    // fork resolves the TRUE kind and keeps refusing it with the same sentence — running the tiers on an off
    // day would credit a whole day for its entire worked span. Recorded here because the ticket believes an
    // off day is already bankable from the roster; on this path it is not, and that is pre-existing.
    const { employmentId, shiftId } = await hire(5000);
    // A Saturday is outside the Mon–Fri pattern of the assigned shift's OWN week, so the default-shift rest
    // branch is what a real off day needs; this asserts the refusal for whatever kind the ladder resolves.
    await workShift(employmentId, shiftId, WORKDAY_2, '06:00:00', '23:00:00');
    await setToilPolicy(ctx, policy()); // switch OFF
    await expect(accrueToil(ctx, { employmentId, workedDate: WORKDAY_2 })).rejects.toThrow(WORKDAY_CASH_ONLY);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r334 · HR’s Add Leave Credit on a working day', () => {
  it('offers the day, PINS the amount to the tier, and refuses any other figure', async () => {
    const { employmentId, shiftId } = await hire(5000);
    await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '18:00:00'); // 240 ⇒ 0.5 day
    await setToilPolicy(ctx, extendedPolicy());

    expect(await previewLeaveCredit(ctx, { employmentId, workedDate: WORKDAY })).toMatchObject({
      workedDayKind: 'workday',
      eligibleDay: true,
      extendedHoursEnabled: true,
      extendedHoursMinutes: 240,
      extendedHoursDays: 0.5,
      overtimeMinutes: 240,
    });

    // A typed figure that is not the tier is refused — not silently overwritten, and not accepted.
    await expect(
      grantLeaveCredit(ctx, { employmentId, workedDate: WORKDAY, days: 3, reason: 'Stayed very late', today: TODAY }),
    ).rejects.toBeInstanceOf(LeaveCreditError);
    await expect(
      grantLeaveCredit(ctx, { employmentId, workedDate: WORKDAY, days: 1, reason: 'Stayed very late', today: TODAY }),
    ).rejects.toThrow(`${WORKDAY} is an ordinary working day: its extended hours earn exactly 0.5 day.`);
    expect(await accrualRow(employmentId), 'a refused save writes nothing').toBeUndefined();

    const granted = await grantLeaveCredit(ctx, {
      employmentId,
      workedDate: WORKDAY,
      days: 0.5,
      reason: 'Stayed for the month-end close',
      today: TODAY,
    });
    expect(granted.daysCredited).toBe(0.5);
    expect(granted.workedDayKind).toBe('workday');
    // ⚠️ MONEY: the banner figure HR sees, and the payslip that proves it.
    expect(granted.overtimeSuppressedMinutes).toBe(240);
    expect((await overtimeMoney(employmentId)).payslip).toBe(0);
  });

  it('refuses a working day that fell short, and the form says how far', async () => {
    const { employmentId, shiftId } = await hire(5000);
    await workShift(employmentId, shiftId, WORKDAY, '06:00:00', '17:00:00'); // 180 ⇒ nothing
    await setToilPolicy(ctx, extendedPolicy());
    expect(await previewLeaveCredit(ctx, { employmentId, workedDate: WORKDAY })).toMatchObject({
      eligibleDay: false,
      extendedHoursEnabled: true,
      extendedHoursMinutes: 180,
      extendedHoursDays: null,
    });
    await expect(
      grantLeaveCredit(ctx, { employmentId, workedDate: WORKDAY, days: 0.5, reason: 'Stayed late', today: TODAY }),
    ).rejects.toBeInstanceOf(ToilExtendedHoursBelowThresholdError);
  });

  it('a working day nobody clocked has no extended hours to measure', async () => {
    const { employmentId, shiftId } = await hire(5000);
    const a = adminCtx(b);
    await assignShift(a, { employmentId, shiftDate: WORKDAY, shiftId }); // rostered, never clocked
    await setToilPolicy(ctx, extendedPolicy());
    expect(await previewLeaveCredit(ctx, { employmentId, workedDate: WORKDAY })).toMatchObject({
      eligibleDay: false,
      extendedHoursMinutes: null,
      extendedHoursDays: null,
    });
    await expect(
      grantLeaveCredit(ctx, { employmentId, workedDate: WORKDAY, days: 0.5, reason: 'Stayed late', today: TODAY }),
    ).rejects.toBeInstanceOf(ToilExtendedHoursBelowThresholdError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('r334 · the policy row', () => {
  it('persists all five settings across a SECOND save (the upsert update set, not only the insert)', async () => {
    await setToilPolicy(ctx, extendedPolicy({ extendedBreakMinutes: 30, extendedGraceMinutes: 15 }));
    // The second save is where a column present in the insert but missing from the update set goes silently
    // missing — the bug 0113 and 296fc027 both left a note about on this function.
    await setToilPolicy(ctx, extendedPolicy({ extendedBreakMinutes: 45, extendedGraceMinutes: 20, expiryDays: 120 }));
    expect(await policyRow()).toMatchObject({
      extendedHoursEnabled: true,
      extendedHalfDayMinutes: 240,
      extendedFullDayMinutes: 480,
      extendedBreakMinutes: 45,
      extendedGraceMinutes: 20,
      expiryDays: 120,
    });
  });

  it('an omitting caller writes the pre-r334 policy — the switch cannot be turned on by accident', async () => {
    await setToilPolicy(ctx, policy());
    expect(await policyRow()).toMatchObject({
      extendedHoursEnabled: false,
      extendedHalfDayMinutes: 240,
      extendedFullDayMinutes: 480,
      extendedBreakMinutes: 0,
      extendedGraceMinutes: 0,
    });
  });

  it('refuses a full-day threshold at or below the half-day one, which would make 0.5 unreachable', async () => {
    await expect(setToilPolicy(ctx, extendedPolicy({ extendedFullDayMinutes: 240 }))).rejects.toThrow(
      'The full-day threshold must be greater than the half-day threshold, or no day could ever earn half a day.',
    );
    await expect(setToilPolicy(ctx, extendedPolicy({ extendedHalfDayMinutes: 0 }))).rejects.toThrow(
      'The half-day threshold must be a whole number of minutes between 1 and 1440.',
    );
    await expect(setToilPolicy(ctx, extendedPolicy({ extendedBreakMinutes: -1 }))).rejects.toThrow(
      'The break deduction must be a whole number of minutes between 0 and 1440.',
    );
    await expect(setToilPolicy(ctx, extendedPolicy({ extendedGraceMinutes: 1441 }))).rejects.toThrow(
      'The grace period must be a whole number of minutes between 0 and 1440.',
    );
    expect(await policyRow(), 'a refused save writes nothing').toBeUndefined();
  });
});
