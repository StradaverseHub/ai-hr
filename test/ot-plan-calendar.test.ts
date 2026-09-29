/**
 * ce5ded11 (r362) · THE OT CALENDAR'S MONTH READ — `otPlanCalendarMonth`.
 *
 * The Apply OT Plan screen went calendar-first, which means something has to answer "what kind of day is
 * each of these thirty-one dates" in ONE read rather than thirty-one resolutions. That answer must be the
 * SAME one the engine gives, and this file is what makes "the same ladder" a checked property instead of
 * a comment in the source.
 *
 * ⚠️ SECTION 1 IS THE WHOLE POINT. It walks an entire month — a rostered shift, a rostered rest day, two
 * public holidays (one of them landing on an off day), the default shift's own working week and its off
 * pattern — and asserts DATE BY DATE that the batched read agrees with `dayTypeFor`, which is the thin
 * public wrapper over `scheduleFor`. If the batched ladder ever drifts from the engine's, one of thirty
 * dates disagrees and this fails naming the date.
 *
 * SECTION 5 pins the contract the Apply screen's server action now depends on: a requested figure of ZERO
 * reaches the planned-window checks, which is what makes "The planned end time must be after the planned
 * start time." reachable from a screen where the hours are derived rather than typed. The action derives
 * the figure; the SERVICE refuses. Both halves are pinned, here and in
 * test/plan-ot-calendar-screen.test.ts, because the defect lives in the contract between two files.
 *
 * FIXED 2027 DATES, like test/plan-ot.test.ts and for the same reason: a test that computes its own month
 * drifts, and the weekday of a date is load-bearing here. 2027-06-01 is a TUESDAY, 2027-06-05 the first
 * Saturday, and June 2027 has 30 days.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import {
  dayTypeFor,
  myOvertimePlans,
  otPlanCalendarMonth,
  requestAttendanceCorrection,
  setAttendancePolicy,
  type OtPlanCalendarDay,
} from '../core/attendance';
import { assignDefaultShift, assignShift, createShift, setRestDay } from '../core/roster';
import { isoWeekdayOf, monthDates } from '../lib/roster-month';

let b: Base;

const MONTH = '2027-06';
const WED = '2027-06-02'; // an ordinary Wednesday
const THU = '2027-06-03';
const FRI = '2027-06-04';
const SAT = '2027-06-05'; // the first Saturday
const SUN = '2027-06-06';

const uniq = () => `otcal_${Math.random().toString(36).slice(2)}@t.local`;

const BASE_POLICY = (companyId: string) => ({
  companyId,
  workStart: '09:00',
  workEnd: '18:00',
  breakMinutes: 60,
  lateAfter: '09:15',
  halfDayBefore: '13:00',
  workingDays: [1, 2, 3, 4, 5],
});

async function hire() {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'OT Calendar Worker', primaryEmail: uniq() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(a, {
    employmentId: e.employmentId,
    basicSalary: 5000,
    monthlyAllowance: 0,
    effectiveFrom: '2024-01-01',
  });
  await setAttendancePolicy(a, BASE_POLICY(b.companyId));
  return { a, employmentId: e.employmentId };
}

const addHoliday = (date: string, name: string) =>
  owner.db.insert(schema.holiday).values({
    tenantId: b.tenantId,
    country: 'MY',
    state: null,
    companyId: b.companyId,
    holidayDate: date,
    name,
  });

const dayOf = (rows: OtPlanCalendarDay[], date: string): OtPlanCalendarDay => {
  const d = rows.find((r) => r.date === date);
  if (!d) throw new Error(`no calendar row for ${date}`);
  return d;
};

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
describe('1 · the batched month agrees with the engine, date by date', () => {
  it('every date of a month with all five rungs classifies exactly as dayTypeFor does', async () => {
    const { a, employmentId } = await hire();

    // The employee's usual week: Mon–Fri work, Saturday OFF, Sunday (in none of the three arrays) REST.
    // Those two are different days in the statute and must not read the same on the calendar.
    const usual = await createShift(a, {
      companyId: b.companyId,
      name: 'OTCAL Usual Day',
      code: 'OTCAL-U',
      startTime: '09:00:00',
      endTime: '17:00:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
      offPattern: [6],
    });
    await assignDefaultShift(a, { employmentId, shiftId: usual.id });

    // …and, over the top of it, one rostered shift, one rostered rest day, and two public holidays —
    // one on an ordinary Friday, one on the Saturday the usual shift calls an off day.
    const rostered = await createShift(a, {
      companyId: b.companyId,
      name: 'OTCAL Evening',
      code: 'OTCAL-E',
      startTime: '14:00:00',
      endTime: '22:00:00',
      breakMinutes: 30,
      weeklyPattern: [1, 2, 3, 4, 5, 6, 7],
    });
    await assignShift(a, { employmentId, shiftDate: WED, shiftId: rostered.id });
    await setRestDay(a, { employmentId, shiftDate: THU });
    await addHoliday(FRI, 'OTCAL Founders Day');
    await addHoliday(SAT, 'OTCAL Second Day');

    const rows = await otPlanCalendarMonth(a, employmentId, MONTH);
    expect(rows.map((r) => r.date)).toEqual(monthDates(MONTH));

    // THE AGREEMENT. dayTypeFor has three answers; the calendar has four, and an OFF day is a WORKDAY to
    // the engine (b8aa3466: a workday with a zero-minute normal day, so every minute is workday overtime).
    const asDayType = (k: OtPlanCalendarDay['kind']) => (k === 'off_day' ? 'workday' : k);
    const disagreements: string[] = [];
    for (const row of rows) {
      const engine = await dayTypeFor(a, employmentId, row.date);
      if (asDayType(row.kind) !== engine) {
        disagreements.push(`${row.date}: calendar ${row.kind} (→ ${asDayType(row.kind)}) vs engine ${engine}`);
      }
    }
    expect(disagreements, disagreements.join('\n')).toEqual([]);

    // …and the month genuinely contained every rung, so the agreement above is not vacuous.
    const kinds = new Set(rows.map((r) => r.kind));
    expect(kinds, 'the fixture must exercise all four kinds').toEqual(new Set(['workday', 'rest_day', 'off_day', 'holiday']));
    const sources = new Set(rows.map((r) => r.source));
    expect(sources.has('roster-shift')).toBe(true);
    expect(sources.has('roster-rest')).toBe(true);
    expect(sources.has('default-shift')).toBe(true);
    expect(sources.has('default-shift-rest')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('2 · which rung answered, and what the day card may print', () => {
  it('a ROSTERED SHIFT on a public holiday keeps its shift and is still classified holiday', async () => {
    const { a, employmentId } = await hire();
    const sh = await createShift(a, {
      companyId: b.companyId,
      name: 'OTCAL Standard Day',
      code: 'SH-01',
      startTime: '09:00:00',
      endTime: '17:30:00',
      breakMinutes: 60,
      breakPeriods: [{ start: '13:00', end: '14:00' }],
      weeklyPattern: [1, 2, 3, 4, 5],
    });
    await assignShift(a, { employmentId, shiftDate: FRI, shiftId: sh.id });
    await addHoliday(FRI, 'OTCAL Founders Day');

    const d = dayOf(await otPlanCalendarMonth(a, employmentId, MONTH), FRI);
    // The rostered shift still DEFINES the schedule on a holiday — the day type comes from the calendar so
    // the premium is right, and the hours come from the roster because that is what the person works.
    expect(d.kind).toBe('holiday');
    expect(d.source).toBe('roster-shift');
    expect(d.shiftCode).toBe('SH-01');
    expect(d.shiftName).toBe('OTCAL Standard Day');
    expect(d.scheduleStart).toBe('09:00');
    expect(d.scheduleEnd).toBe('17:30');
    expect(d.breakStart).toBe('13:00');
    expect(d.breakEnd).toBe('14:00');
    expect(await dayTypeFor(a, employmentId, FRI)).toBe('holiday');
  });

  it('a rostered REST day reads as a rest day, with no schedule to print', async () => {
    const { a, employmentId } = await hire();
    await setRestDay(a, { employmentId, shiftDate: WED });
    const d = dayOf(await otPlanCalendarMonth(a, employmentId, MONTH), WED);
    expect(d).toMatchObject({
      kind: 'rest_day',
      source: 'roster-rest',
      shiftCode: null,
      shiftName: null,
      scheduleStart: null,
      scheduleEnd: null,
    });
  });

  it('a HOLIDAY on a rostered rest day falls to the policy rung, exactly as scheduleFor does', async () => {
    const { a, employmentId } = await hire();
    await setRestDay(a, { employmentId, shiftDate: WED });
    await addHoliday(WED, 'OTCAL Founders Day');
    const d = dayOf(await otPlanCalendarMonth(a, employmentId, MONTH), WED);
    // The holiday premium (3x) beats the rest-day premium (2x), and the rung scheduleFor RETURNS from is
    // policyBranch('holiday') — so `source` says policy, and the card names the holiday calendar rather
    // than claiming a schedule that does not exist.
    expect(d.kind).toBe('holiday');
    expect(d.source).toBe('policy');
    expect(d.scheduleStart).toBeNull();
    expect(await dayTypeFor(a, employmentId, WED)).toBe('holiday');
  });

  it('with NO roster and NO usual shift the company hours apply on a working day, and nothing on a rest day', async () => {
    const { a, employmentId } = await hire();
    const rows = await otPlanCalendarMonth(a, employmentId, MONTH);
    const wed = dayOf(rows, WED);
    expect(wed).toMatchObject({ kind: 'workday', source: 'policy', shiftCode: null, scheduleStart: '09:00', scheduleEnd: '18:00' });
    const sun = dayOf(rows, SUN);
    expect(sun).toMatchObject({ kind: 'rest_day', source: 'policy', scheduleStart: null, scheduleEnd: null });
    // Every date on this fixture is the policy rung, which is what the calendar draws as "No roster entry".
    expect(new Set(rows.map((r) => r.source))).toEqual(new Set(['policy']));
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('3 · an OFF DAY is only ever the usual shift’s own, and a rostered day can never be one', () => {
  it('the usual shift’s off pattern is an off day; a weekday in none of the three arrays is a rest day', async () => {
    const { a, employmentId } = await hire();
    const usual = await createShift(a, {
      companyId: b.companyId,
      name: 'OTCAL Usual Day',
      code: 'OTCAL-U',
      startTime: '09:00:00',
      endTime: '17:00:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
      offPattern: [6],
    });
    await assignDefaultShift(a, { employmentId, shiftId: usual.id });

    const rows = await otPlanCalendarMonth(a, employmentId, MONTH);
    expect(dayOf(rows, SAT)).toMatchObject({ kind: 'off_day', source: 'default-shift-rest', scheduleStart: null });
    expect(dayOf(rows, SUN)).toMatchObject({ kind: 'rest_day', source: 'default-shift-rest', scheduleStart: null });
    // Both are Saturdays / Sundays across the whole month, not just the two named above.
    for (const row of rows) {
      const dow = isoWeekdayOf(row.date);
      if (dow === 6) expect(row.kind, `${row.date} is a Saturday`).toBe('off_day');
      if (dow === 7) expect(row.kind, `${row.date} is a Sunday`).toBe('rest_day');
    }
  });

  it('a ROSTER ROW on that same Saturday makes it a working day — roster_assignment cannot say "off"', async () => {
    const { a, employmentId } = await hire();
    const usual = await createShift(a, {
      companyId: b.companyId,
      name: 'OTCAL Usual Day',
      code: 'OTCAL-U',
      startTime: '09:00:00',
      endTime: '17:00:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
      offPattern: [6],
    });
    await assignDefaultShift(a, { employmentId, shiftId: usual.id });
    const weekend = await createShift(a, {
      companyId: b.companyId,
      name: 'OTCAL Weekend',
      code: 'OTCAL-W',
      startTime: '10:00:00',
      endTime: '16:00:00',
      breakMinutes: 30,
      weeklyPattern: [1, 2, 3, 4, 5, 6, 7],
    });
    // Every Saturday of the month is rostered. roster_assignment holds a shift_id and an is_rest_day flag
    // and NOTHING ELSE, so a rostered off day is unrepresentable — the calendar must not draw one.
    const saturdays = monthDates(MONTH).filter((d) => isoWeekdayOf(d) === 6);
    expect(saturdays.length).toBeGreaterThan(3);
    for (const d of saturdays) await assignShift(a, { employmentId, shiftDate: d, shiftId: weekend.id });

    const rows = await otPlanCalendarMonth(a, employmentId, MONTH);
    for (const d of saturdays) {
      expect(dayOf(rows, d), `${d} is rostered`).toMatchObject({ kind: 'workday', source: 'roster-shift', shiftCode: 'OTCAL-W' });
    }
    expect(rows.filter((r) => r.kind === 'off_day').map((r) => r.date), 'no rostered date may be an off day').toEqual([]);
  });

  it('a HALF day ends where the engine ends it — half the shift’s clock span', async () => {
    const { a, employmentId } = await hire();
    const usual = await createShift(a, {
      companyId: b.companyId,
      name: 'OTCAL Half Week',
      code: 'OTCAL-H',
      startTime: '09:00:00',
      endTime: '17:00:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4],
      halfPattern: [5],
    });
    await assignDefaultShift(a, { employmentId, shiftId: usual.id });
    const rows = await otPlanCalendarMonth(a, employmentId, MONTH);
    // Friday is a working HALF day: the schedule ends halfway through the 8-hour span, which is the end
    // overtime is measured past — and therefore the time the form prefills the overtime start with.
    expect(dayOf(rows, FRI)).toMatchObject({ kind: 'workday', source: 'default-shift', scheduleStart: '09:00', scheduleEnd: '13:00' });
    expect(dayOf(rows, THU)).toMatchObject({ kind: 'workday', scheduleEnd: '17:00' });
    expect(await dayTypeFor(a, employmentId, FRI)).toBe('workday');
  });

  it('two break windows print no single window — naming one of them "your break" would be false', async () => {
    const { a, employmentId } = await hire();
    const sh = await createShift(a, {
      companyId: b.companyId,
      name: 'OTCAL Two Breaks',
      code: 'OTCAL-2B',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 75,
      breakPeriods: [
        { start: '13:00', end: '14:00' },
        { start: '16:00', end: '16:15' },
      ],
      weeklyPattern: [1, 2, 3, 4, 5],
    });
    await assignShift(a, { employmentId, shiftDate: WED, shiftId: sh.id });
    const d = dayOf(await otPlanCalendarMonth(a, employmentId, MONTH), WED);
    expect(d.breakStart).toBeNull();
    expect(d.breakEnd).toBeNull();
    expect(d.breakMinutes).toBe(75);
  });

  it('a malformed month is an empty month, never a thrown page', async () => {
    const { a, employmentId } = await hire();
    expect(await otPlanCalendarMonth(a, employmentId, '2027-13')).toEqual([]);
    expect(await otPlanCalendarMonth(a, employmentId, 'nonsense')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('4 · the overtime-date window on myOvertimePlans', () => {
  const file = (ctx: Parameters<typeof requestAttendanceCorrection>[0], employmentId: string, date: string) =>
    requestAttendanceCorrection(ctx, {
      employmentId,
      date,
      requestedOtMinutes: 120,
      reason: 'Cut-over rehearsal',
      plannedStartTime: '18:00',
      plannedEndTime: '20:00',
    });

  it('bounds the rows to the month asked for, and no window returns everything as before', async () => {
    const { a, employmentId } = await hire();
    await file(a, employmentId, WED); // June
    await file(a, employmentId, '2027-07-07'); // July
    await file(a, employmentId, '2027-05-05'); // May

    const june = await myOvertimePlans(a, employmentId, { from: '2027-06-01', to: '2027-06-30', limit: 200 });
    expect(june.map((p) => p.attendanceDate)).toEqual([WED]);

    const july = await myOvertimePlans(a, employmentId, { from: '2027-07-01', to: '2027-07-31', limit: 200 });
    expect(july.map((p) => p.attendanceDate)).toEqual(['2027-07-07']);

    // Absent ⇒ byte-identical to before: every month, newest overtime date first.
    const all = await myOvertimePlans(a, employmentId, { limit: 100 });
    expect(all.map((p) => p.attendanceDate)).toEqual(['2027-07-07', WED, '2027-05-05']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('5 · a ZERO requested figure reaches the planned-window refusals', () => {
  /**
   * THE CONTRACT THE APPLY SCREEN'S ACTION NOW DEPENDS ON. The hours on that screen are DERIVED from the
   * two times, so an inverted pair yields nothing and the hidden field posts blank — which used to mean
   * "no overtime at all" and produced the generic at-least-one message about a field the employee could
   * not fill in. myRequestOvertime now derives the figure from the window and hands the service a ZERO,
   * so the window checks downstream of the at-least-one test get to run and refuse in their own words.
   * `hasOt` is `!= null`, so zero must satisfy the first test — that is the property pinned here.
   */
  it('an inverted window is refused as an inverted window, not as "no hours"', async () => {
    const { a, employmentId } = await hire();
    await expect(
      requestAttendanceCorrection(a, {
        employmentId,
        date: WED,
        requestedOtMinutes: 0,
        reason: 'Typed the times the wrong way round',
        plannedStartTime: '21:00',
        plannedEndTime: '18:00',
      }),
    ).rejects.toThrow('The planned end time must be after the planned start time.');
  });

  it('half a window is refused as half a window', async () => {
    const { a, employmentId } = await hire();
    await expect(
      requestAttendanceCorrection(a, {
        employmentId,
        date: WED,
        requestedOtMinutes: 0,
        reason: 'Only filled in the start',
        plannedStartTime: '18:00',
        plannedEndTime: null,
      }),
    ).rejects.toThrow('A planned overtime window needs both a start time and an end time.');
  });

  it('and a plan with no hours and no window at all still gets the generic message, which is the true one', async () => {
    const { a, employmentId } = await hire();
    await expect(
      requestAttendanceCorrection(a, {
        employmentId,
        date: WED,
        requestedOtMinutes: null,
        reason: 'Nothing filled in',
      }),
    ).rejects.toThrow('Provide at least one of a clock-in time, a clock-out time, or overtime hours.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('6 · the remark and the attachment the Apply screen now offers are stored where they already lived', () => {
  it('a remark posted with an overtime plan lands on the same column the correction form uses', async () => {
    const { a, employmentId } = await hire();
    const { correctionId } = await requestAttendanceCorrection(a, {
      employmentId,
      date: WED,
      requestedOtMinutes: 120,
      reason: 'Cut-over rehearsal',
      remark: 'Client asked for the window in writing',
      plannedStartTime: '18:00',
      plannedEndTime: '20:00',
    });
    const [row] = await owner.db
      .select({ remark: schema.attendanceCorrection.remark, ot: schema.attendanceCorrection.requestedOtMinutes })
      .from(schema.attendanceCorrection)
      .where(and(eq(schema.attendanceCorrection.id, correctionId)));
    expect(row.remark).toBe('Client asked for the window in writing');
    expect(row.ot).toBe(120);
  });
});
