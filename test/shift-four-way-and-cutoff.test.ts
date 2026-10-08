/**
 * b8aa3466 — the shift form's field set, asserted where it actually lands.
 *
 * Four of this item's nine sub-items move the SCHEDULING RULE, which is what decides how much of a day is
 * overtime, which is money. So the load-bearing assertions here run the whole path — punch in, punch out,
 * the engine, the payroll prefill, a generated payslip — and read RINGGIT, not row shape. The pure-shape
 * assertions (storage round-trips, refusals) sit alongside them because the storage contract is what the
 * engine reads.
 *
 * THE HEADLINE NUMBER, from the reporter's own production row. SemiFlex01 is stored 07:00-20:00 with a
 * 60-minute break and NO normal-hours figure, so netScheduledMinutes reads 780 - 60 = 720 and a normal day
 * on that shift is TWELVE HOURS. A day worked 07:00 -> 17:00 therefore earns nothing. With the 8 hours the
 * reporter described, that same day is 9 hours of work against an 8 hour day = 1 hour of overtime. Both
 * halves of that are asserted below, in ringgit, so "it is a correction, not a regression" is a measured
 * claim rather than an assurance.
 *
 * Figures are chosen so a ringgit is readable at a glance: basic RM2,080 => ORP 2080/26 = RM80 and hourly
 * RM10 (s.60I(1A)), so one hour of workday overtime at 1.5x is RM15.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { checkIn, checkOut, isWorkingDayKind, shiftDayKindFor } from '../core/attendance';
import { assignDefaultShift, createShift, updateShift } from '../core/roster';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { setStatutoryProfileMY } from '../localization/my/statutory';
import { createBatch, generatePayslips, prefillOvertimeFromAttendance } from '../core/payroll';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';

/** 2026-05-05 is a TUESDAY (ISO 2) and sits inside the 2026-05 pay period. 2026-05-09 is a SATURDAY (6). */
const TUE = '2026-05-05';
const SAT = '2026-05-09';
const PERIOD = '2026-05';
const BASIC = 2080;
/** One hour of workday overtime at 1.5x on an RM10 hourly rate. */
const ONE_HOUR_OT = 15;

let b: Base;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  // The legacy comp + payroll_input earnings path is what carries the prefilled OT onto the slip. With
  // typed pay components enabled the slip's overtime would come from the component tables (which this file
  // seeds none of) and the money assertions below would silently read zero rather than fail.
  await setModule(b.tenantId, 'typed_pay_components', null);
});

let icSeq = 0;
const randomIc = () => `9101010${String(10000 + (icSeq += 1)).slice(-5)}`;

/** A whole employee, paid and statutory-profiled, on the given shift as their DEFAULT shift — which is the
 *  branch that reads the weekly row (a rostered row would bypass it). */
async function employeeOn(shiftId: string, email: string) {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Shift Case', primaryEmail: email },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  await setCompensation(a, {
    employmentId: e.employmentId,
    basicSalary: BASIC,
    monthlyAllowance: 0,
    effectiveFrom: '2026-01-01',
  });
  await setStatutoryProfileMY(a, { personId: e.personId, icNumber: randomIc() });
  await assignDefaultShift(a, { employmentId: e.employmentId, shiftId });
  return { a, employmentId: e.employmentId };
}

/** SemiFlex01 as production stores it, with the normal-hours figure supplied or not. */
const semiFlexiShift = (normalMinutes: number | null) =>
  createShift(adminCtx(b), {
    name: `SemiFlex_${randomUUID().slice(0, 6)}`,
    code: `SF_${randomUUID().slice(0, 6)}`,
    type: 'semi_flexi',
    startTime: '07:00:00',
    endTime: '20:00:00',
    breakMinutes: 60,
    normalMinutesOverride: normalMinutes,
    weeklyPattern: [1, 2, 3, 4, 5],
  });

/** The prefilled overtime amount for ONE employment in a batch, in ringgit. seedBase hires other people
 *  into the same company, so a batch-only filter would read whichever row came back first. No row at all
 *  means no overtime was prefilled for them, which is RM0 — the same answer, stated rather than crashed. */
const otAmountOf = async (batchId: string, employmentId: string) => {
  const [row] = await owner.db
    .select()
    .from(schema.payrollInput)
    .where(and(eq(schema.payrollInput.batchId, batchId), eq(schema.payrollInput.employmentId, employmentId)));
  return row ? Number(row.overtimeAmount) : 0;
};

/** The DERIVED attendance row for one employment+date. */
const attendanceOf = async (employmentId: string, date: string) => {
  const [row] = await owner.db
    .select()
    .from(schema.attendance)
    .where(and(eq(schema.attendance.employmentId, employmentId), eq(schema.attendance.attendanceDate, date)));
  return row;
};

/** drizzle wraps a Postgres error, so the constraint name is on the CAUSE, not the message. Asserting on
 *  `rejects.toThrow(/name/)` alone passes on the WRONG throw — it would match any failure whose message
 *  happened to contain the text, and miss the real one entirely. */
async function expectPgConstraint(run: Promise<unknown>, constraint: string) {
  const err = await run.then(
    () => null,
    (e: unknown) => e as { message?: string; cause?: { constraint_name?: string; message?: string } },
  );
  expect(err, `expected the write to be refused by ${constraint}`).not.toBeNull();
  const detail = `${err?.cause?.constraint_name ?? ''} ${err?.cause?.message ?? ''} ${err?.message ?? ''}`;
  expect(detail).toContain(constraint);
}

/** Punch one day and read what the ENGINE made of it. No payroll — a batch is unique per company+period,
 *  so a test that needs two employees cannot create two of them. */
async function punchDay(shiftId: string, date: string, inAt: string, outAt: string, email: string) {
  const { a, employmentId } = await employeeOn(shiftId, email);
  await checkIn(a, { employmentId, date, time: inAt });
  const out = await checkOut(a, { employmentId, date, time: outAt });
  return { a, employmentId, out };
}

/** Punch a day and monetise it end to end, returning both the minutes and the ringgit. */
async function dayThroughPayroll(shiftId: string, date: string, inAt: string, outAt: string, email: string) {
  const { a, employmentId, out } = await punchDay(shiftId, date, inAt, outAt, email);
  const { batchId } = await createBatch(a, { companyId: b.companyId, payPeriod: PERIOD });
  await prefillOvertimeFromAttendance(a, { batchId });
  const amount = await otAmountOf(batchId, employmentId);
  return { a, employmentId, batchId, out, amount };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('b8aa3466 item 4 — the Semi Flexi normal-hours figure, in ringgit', () => {
  it('WITHOUT the figure, the reporter’s own 07:00→17:00 day earns nothing — a 12-hour normal day', async () => {
    const shift = await semiFlexiShift(null);
    const { out, amount } = await dayThroughPayroll(shift.id, TUE, '07:00:00', '17:00:00', `sf_none_${randomUUID()}@t.local`);
    // 600 minutes of span, less the 60-minute break = 540 worked, against a 720-minute "normal day".
    expect(out.workedMinutes).toBe(540);
    expect(out.otMinutes).toBe(0);
    expect(amount).toBeCloseTo(0, 2);
  });

  it('WITH 8 hours, the SAME day is one hour of overtime — RM15 on a payslip', async () => {
    const shift = await semiFlexiShift(480);
    const { a, batchId, employmentId, out, amount } = await dayThroughPayroll(
      shift.id,
      TUE,
      '07:00:00',
      '17:00:00',
      `sf_480_${randomUUID()}@t.local`,
    );
    expect(out.workedMinutes).toBe(540);
    expect(out.otMinutes).toBe(60);
    expect(amount).toBeCloseTo(ONE_HOUR_OT, 2);

    // And it reaches a GENERATED PAYSLIP, not just the input row — the row-shape-only assertion is exactly
    // what let a double-pay bug ship on this path before.
    await generatePayslips(await entitledCtx(b), { batchId });
    const [ps] = await owner.db
      .select()
      .from(schema.payslip)
      .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
    expect(Number(ps.overtimePay)).toBeCloseTo(ONE_HOUR_OT, 2);
    void a;
  });

  it('STORAGE STAYS MINUTES — 8 hours is stored as 480, not as 8', async () => {
    const shift = await semiFlexiShift(480);
    const [row] = await owner.db.select().from(schema.shift).where(eq(schema.shift.id, shift.id));
    expect(row.normalMinutesOverride).toBe(480);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('b8aa3466 item 8 — the half-day cut-off', () => {
  it('Semi Flexi DERIVES it: half the required hours of work from the earliest time in', async () => {
    // 8h required ⇒ 4h of work ⇒ 07:00 + 4h = 11:00. Clocking out at 10:30 is before it, so the day is a
    // half day; clocking out at 11:30 is after it, so it is not.
    const shift = await semiFlexiShift(480);
    const early = await punchDay(shift.id, TUE, '07:00:00', '10:30:00', `sf_half_${randomUUID()}@t.local`);
    expect(early.out.status).toBe('half_day');
    const late = await punchDay(shift.id, TUE, '07:00:00', '11:30:00', `sf_full_${randomUUID()}@t.local`);
    expect(late.out.status).not.toBe('half_day');
  });

  it('an EXPLICIT half-day cut-off still wins on a Semi Flexi shift', async () => {
    const shift = await semiFlexiShift(480);
    await updateShift(adminCtx(b), {
      shiftId: shift.id,
      name: `SemiFlexE_${randomUUID().slice(0, 6)}`,
      code: `SFE_${randomUUID().slice(0, 6)}`,
      type: 'semi_flexi',
      startTime: '07:00:00',
      endTime: '20:00:00',
      breakMinutes: 60,
      normalMinutesOverride: 480,
      weeklyPattern: [1, 2, 3, 4, 5],
      halfDayFirstOut: '09:00:00',
    });
    // With the explicit 09:00, a 10:30 clock-out is now AFTER the cut-off and is no longer a half day.
    const d = await punchDay(shift.id, TUE, '07:00:00', '10:30:00', `sf_expl_${randomUUID()}@t.local`);
    expect(d.out.status).not.toBe('half_day');
  });

  it('a NORMAL shift keeps exactly the threshold it has today', async () => {
    const shift = await createShift(adminCtx(b), {
      name: `MB28_${randomUUID().slice(0, 6)}`,
      code: `MB_${randomUUID().slice(0, 6)}`,
      startTime: '08:00:00',
      endTime: '17:00:00',
      breakMinutes: 60,
      halfDayFirstOut: '12:00:00',
      weeklyPattern: [1, 2, 3, 4, 5],
    });
    const before = await punchDay(shift.id, TUE, '08:00:00', '11:30:00', `n_half_${randomUUID()}@t.local`);
    expect(before.out.status).toBe('half_day');
    const after = await punchDay(shift.id, TUE, '08:00:00', '12:30:00', `n_full_${randomUUID()}@t.local`);
    expect(after.out.status).not.toBe('half_day');
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('b8aa3466 item 9 — four-way working days', () => {
  const mb28 = (extra: Record<string, unknown> = {}) =>
    createShift(adminCtx(b), {
      name: `Day_${randomUUID().slice(0, 6)}`,
      code: `D_${randomUUID().slice(0, 6)}`,
      startTime: '08:00:00',
      endTime: '17:00:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
      ...extra,
    });

  it('the resolver: Full / Half / Off explicit, Rest the complement', () => {
    const sh = { pattern: [1, 2], halfPattern: [3], offPattern: [4] };
    expect(shiftDayKindFor(sh, '2026-05-04')).toBe('full'); // Monday
    expect(shiftDayKindFor(sh, '2026-05-06')).toBe('half'); // Wednesday
    expect(shiftDayKindFor(sh, '2026-05-07')).toBe('off'); // Thursday
    expect(shiftDayKindFor(sh, '2026-05-08')).toBe('rest'); // Friday — in nothing
    // Half is a working day; Off is not. That distinction is the whole of the pay difference below.
    expect([isWorkingDayKind('full'), isWorkingDayKind('half'), isWorkingDayKind('rest'), isWorkingDayKind('off')]).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it('A ROW WRITTEN BEFORE 0429 IS BYTE-IDENTICAL: ticked ⇒ Full, unticked ⇒ Rest', async () => {
    const shift = await mb28();
    const [row] = await owner.db.select().from(schema.shift).where(eq(schema.shift.id, shift.id));
    expect(row.weeklyPattern).toEqual([1, 2, 3, 4, 5]);
    expect(row.halfPattern).toEqual([]);
    expect(row.offPattern).toEqual([]);
    expect(shiftDayKindFor({ pattern: row.weeklyPattern, halfPattern: row.halfPattern, offPattern: row.offPattern }, TUE)).toBe(
      'full',
    );
    expect(shiftDayKindFor({ pattern: row.weeklyPattern, halfPattern: row.halfPattern, offPattern: row.offPattern }, SAT)).toBe(
      'rest',
    );
  });

  it('a HALF day starts paying overtime after HALF a day — RM15 on a payslip', async () => {
    // Saturday is Half. The shift is 08:00-17:00, a 540-minute span, so a half day ends 270 minutes in, at
    // 12:30. Clocking 08:00 -> 13:30 is therefore 60 minutes past the half day's own time-out = one hour of
    // overtime. (Worked is 330: the 60-minute break only comes off a span of 6h or more.)
    const shift = await mb28({ weeklyPattern: [1, 2, 3, 4, 5], halfPattern: [6] });
    const { out, amount, batchId, employmentId } = await dayThroughPayroll(
      shift.id,
      SAT,
      '08:00:00',
      '13:30:00',
      `half_${randomUUID()}@t.local`,
    );
    expect(out.workedMinutes).toBe(330);
    expect(out.otMinutes).toBe(60);
    expect(amount).toBeCloseTo(ONE_HOUR_OT, 2);
    await generatePayslips(await entitledCtx(b), { batchId });
    const [ps] = await owner.db
      .select()
      .from(schema.payslip)
      .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
    expect(Number(ps.overtimePay)).toBeCloseTo(ONE_HOUR_OT, 2);
  });

  it('the SAME Saturday as a FULL day pays no overtime — the halving is what produced it', async () => {
    const shift = await mb28({ weeklyPattern: [1, 2, 3, 4, 5, 6] });
    const { out, amount } = await dayThroughPayroll(shift.id, SAT, '08:00:00', '13:30:00', `full6_${randomUUID()}@t.local`);
    expect(out.workedMinutes).toBe(330);
    expect(out.otMinutes).toBe(0);
    expect(amount).toBeCloseTo(0, 2);
  });

  it('a half day HALVES the scheduled minutes too, so short hours are measured against half a day', async () => {
    const shift = await mb28({ weeklyPattern: [1, 2, 3, 4, 5], halfPattern: [6] });
    // 08:00 -> 11:00 is 180 worked against a 240-minute half day ⇒ 60 minutes short. Against the FULL 480
    // it would have read 300 short, which is the figure a screen would have shown before this change.
    const { out, employmentId } = await punchDay(shift.id, SAT, '08:00:00', '11:00:00', `halfshort_${randomUUID()}@t.local`);
    expect(out.workedMinutes).toBe(180);
    expect((await attendanceOf(employmentId, SAT)).underMinutes).toBe(60);
  });

  it('an OFF day pays WORKDAY overtime from the first minute — 1.5x, not rest-day rates', async () => {
    // EA s.60A(3)(a). Six hours worked on an off day = 6 x RM15 = RM90 of workday OT.
    const shift = await mb28({ weeklyPattern: [1, 2, 3, 4, 5], offPattern: [6] });
    const { out, amount, batchId, employmentId } = await dayThroughPayroll(
      shift.id,
      SAT,
      '08:00:00',
      '14:00:00',
      `off_${randomUUID()}@t.local`,
    );
    expect(out.workedMinutes).toBe(300);
    // Every worked minute is overtime: the normal day is zero minutes long.
    expect(out.otMinutes).toBe(300);
    expect(amount).toBeCloseTo(5 * ONE_HOUR_OT, 2);

    // The DAY TYPE is what proves it is not being paid on the rest-day leg: rest-day pay is half/full day
    // ORP plus 2x on the excess, which for this day would have been RM40+, not RM75.
    expect((await attendanceOf(employmentId, SAT)).dayType).toBe('workday');
    await generatePayslips(await entitledCtx(b), { batchId });
    const [ps] = await owner.db
      .select()
      .from(schema.payslip)
      .where(and(eq(schema.payslip.batchId, batchId), eq(schema.payslip.employmentId, employmentId)));
    expect(Number(ps.overtimePay)).toBeCloseTo(5 * ONE_HOUR_OT, 2);
  });

  it('a REST day still pays rest-day rates — Off did not swallow Rest', async () => {
    const shift = await mb28({ weeklyPattern: [1, 2, 3, 4, 5] }); // Saturday is in nothing ⇒ Rest
    const { employmentId } = await punchDay(shift.id, SAT, '08:00:00', '14:00:00', `rest_${randomUUID()}@t.local`);
    expect((await attendanceOf(employmentId, SAT)).dayType).toBe('rest_day');
  });

  it('the three lists must be disjoint, and the refusal names the real reason', async () => {
    await expect(mb28({ weeklyPattern: [1, 2], halfPattern: [2] })).rejects.toThrow(
      /Each weekday can only be one of Full, Half, Rest or Off/,
    );
    // …and the DB says the same thing, so a path that bypasses the service cannot store nonsense either.
    const shift = await mb28();
    await expectPgConstraint(
      owner.db.update(schema.shift).set({ halfPattern: [1] }).where(eq(schema.shift.id, shift.id)),
      'shift_day_kinds_disjoint',
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('b8aa3466 item 7 — the daily cut-off', () => {
  const nightShift = (extra: Record<string, unknown> = {}) =>
    createShift(adminCtx(b), {
      name: `Night_${randomUUID().slice(0, 6)}`,
      code: `N_${randomUUID().slice(0, 6)}`,
      startTime: '22:00:00',
      endTime: '06:00:00',
      breakMinutes: 0,
      weeklyPattern: [1, 2, 3, 4, 5, 6, 7],
      ...extra,
    });

  it('OFF (every shift today) keeps the hard-coded 12-hour placement byte-identically', async () => {
    const shift = await nightShift();
    const { out } = await punchDay(shift.id, TUE, '22:00:00', '06:00:00', `noco_${randomUUID()}@t.local`);
    expect(out.workedMinutes).toBe(480);
  });

  it('enabling it with no time is REFUSED, by the service and by the database', async () => {
    await expect(nightShift({ dailyCutoffEnabled: true })).rejects.toThrow(/daily cut-off needs a time/);
    const shift = await nightShift();
    await expectPgConstraint(
      owner.db.update(schema.shift).set({ dailyCutoffEnabled: true }).where(eq(schema.shift.id, shift.id)),
      'shift_daily_cutoff_time_required',
    );
  });

  it('ON, it is the boundary that decides which day a punch belongs to', async () => {
    const shift = await nightShift({ dailyCutoffEnabled: true, dailyCutoffTime: '02:00:00' });
    const [row] = await owner.db.select().from(schema.shift).where(eq(schema.shift.id, shift.id));
    expect(row.dailyCutoffEnabled).toBe(true);
    expect(row.dailyCutoffTime).toBe('02:00:00');
    // A 22:00 -> 06:00 night still measures eight hours: 22:00 is after the 02:00 cut-off so it opens this
    // shift-day, and 06:00 is placed on the same timeline by the same rule.
    const { out } = await punchDay(shift.id, TUE, '22:00:00', '06:00:00', `co_${randomUUID()}@t.local`);
    expect(out.workedMinutes).toBe(480);
  });

  /**
   * r429 (f6819e19) · D6 — A WRAPPED BREAK, WITH THE DAILY CUT-OFF ALSO ON. Two independent anchoring
   * rules (core/attendance.ts anchorToShift for the punch and the break window; core/shift-break-rules.ts
   * breakRowMinutes for the row's own stored length) must agree on where "23:45–00:15" sits once the
   * shift has its OWN cut-off clock instead of the hard-coded 12-hour guess. Pinned because the plan's own
   * BUILD NOTES call this combination out by name.
   */
  it('a break that crosses midnight is still deducted correctly with the daily cut-off ALSO on', async () => {
    const shift = await nightShift({
      dailyCutoffEnabled: true,
      dailyCutoffTime: '02:00:00',
      breakPeriods: [{ start: '23:45:00', end: '00:15:00' }],
    });
    const row = await owner.db.select().from(schema.shift).where(eq(schema.shift.id, shift.id)).then((r) => r[0]);
    expect(row.breakMinutes, 'wrap-aware length, not negative').toBe(30);
    // 480-minute span (22:00→06:00) less the 30-minute wrapped break = 450.
    const { out } = await punchDay(shift.id, TUE, '22:00:00', '06:00:00', `wrapco_${randomUUID()}@t.local`);
    expect(out.workedMinutes).toBe(450);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('b8aa3466 item 6 — the break Fixed tick', () => {
  const withBreaks = (periods: { start: string; end: string; paid?: boolean; flexible?: boolean }[]) =>
    createShift(adminCtx(b), {
      name: `Brk_${randomUUID().slice(0, 6)}`,
      code: `B_${randomUUID().slice(0, 6)}`,
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      breakPeriods: periods,
      weeklyPattern: [1, 2, 3, 4, 5],
    });

  it('a window with no flags round-trips byte-identically — { start, end } and nothing else', async () => {
    const shift = await withBreaks([{ start: '12:00', end: '13:00' }]);
    const [row] = await owner.db.select().from(schema.shift).where(eq(schema.shift.id, shift.id));
    expect(row.breakPeriods).toEqual([{ start: '12:00:00', end: '13:00:00' }]);
  });

  it('FLEXIBLE is stored when set, and does NOT change the deducted break minutes', async () => {
    const fixed = await withBreaks([{ start: '12:00', end: '13:00' }]);
    const flexi = await withBreaks([{ start: '12:00', end: '13:00', flexible: true }]);
    const [f] = await owner.db.select().from(schema.shift).where(eq(schema.shift.id, fixed.id));
    const [x] = await owner.db.select().from(schema.shift).where(eq(schema.shift.id, flexi.id));
    expect((x.breakPeriods as { flexible?: boolean }[])[0].flexible).toBe(true);
    // break_minutes is the sum of the UNPAID windows and nothing else. Only Paid may change it.
    expect(x.breakMinutes).toBe(f.breakMinutes);
    expect(x.breakMinutes).toBe(60);
  });

  it('PAID is what changes the deduction, and still does', async () => {
    const paid = await withBreaks([{ start: '12:00', end: '13:00', paid: true }]);
    const [p] = await owner.db.select().from(schema.shift).where(eq(schema.shift.id, paid.id));
    expect(p.breakMinutes).toBe(0);
  });
});
