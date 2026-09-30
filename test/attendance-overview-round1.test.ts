/**
 * 67268d83 (r367) ROUND ONE — Attendance Overview: the day list, and the truncation it must not do.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM test/attendance-my-records-split.test.ts ───────────────────
 * That file is source-shaped, and necessarily so: a guarded page resolves a real session the node harness
 * cannot mint. It can therefore pin that the page bounds its range against the kernel's constant, but it
 * cannot show that the kernel would otherwise have LOST DAYS. This file does the behavioural half against
 * real seeded attendance.
 *
 * ── THE TRAP THIS FILE IS BUILT AROUND, STATED FIRST ────────────────────────────────────────────────
 * `pnpm db:seed` creates no shifts, no roster rows and no attendance. A fixture whose range holds nothing
 * makes every assertion below pass whatever the code does: "400 rows" and "0 rows" are both consistent with
 * an empty employee, "only these dates came back" is trivially true of an empty array, and a status map that
 * rendered nothing at all would look identical. So the fixture seeds EIGHT consecutive days in FOUR
 * statuses and THREE flags, and the first case asserts those counts before anything else is checked. If that
 * case fails, nothing after it is evidence.
 *
 * ── WHAT IS PINNED ──────────────────────────────────────────────────────────────────────────────────
 *  A. The resolver (app/attendance/my-records/range.ts) — pure, no DB: the defaults, that an explicitly
 *     asked-for range is HONOURED, the ceiling boundary, and the inverted range.
 *  B. The fixture, asserted as counts per status and per flag, through the SAME statusOf / flagOf the
 *     screen renders through.
 *  C. THE HAZARD. `attendanceForEmploymentRange` walks at most ATTENDANCE_RANGE_MAX_DAYS days and then
 *     STOPS, silently: over a 501-day window it returns 400 rows and every seeded day in this fixture is
 *     missing from them, with no error and no flag on the result. The screen never issues that read because
 *     the resolver refuses the span first — and the refusal boundary is pinned at exactly the number the
 *     loop obeys, not at a number typed twice.
 *  D. That the range filter genuinely narrows the read.
 *
 * Read-only throughout: these are enquiry reads and derivations, and nothing here appends a DomainEvent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { createShift, assignDefaultShift } from '../core/roster';
import { createHoliday } from '../core/admin';
import { ATTENDANCE_RANGE_MAX_DAYS, attendanceForEmploymentRange } from '../core/attendance';
import { checkIn, checkOut } from '../core/attendance';
import { flagOf, statusOf, type AttendanceFlag, type AttendanceStatus } from '../core/attendance-derive';
import { dayCountInclusive, firstOfMonth, resolveMyAttendanceRange } from '../app/attendance/my-records/range';
import { todayInKualaLumpur } from '../lib/hr-date';

const MS_DAY = 86_400_000;
const isoAdd = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * MS_DAY).toISOString().slice(0, 10);
/** 0 = Sunday, 1 = Monday — UTC, because an attendance date is a plain calendar date. */
const utcDow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();

/**
 * The fixture window: the first Monday at or before 90 days ago, so the eight days are all safely in the
 * PAST whenever this runs. Derived from the clock through todayInKualaLumpur() — never a hardcoded date,
 * which is what rots a fixture into a future-dated one (CLAUDE.md §8).
 */
const TODAY = todayInKualaLumpur();
let MON = isoAdd(TODAY, -90);
while (utcDow(MON) !== 1) MON = isoAdd(MON, -1);
const D = (n: number) => isoAdd(MON, n);
const [TUE, WED, THU, FRI, SAT, SUN, MON2] = [D(1), D(2), D(3), D(4), D(5), D(6), D(7)];
const WINDOW_FROM = MON;
const WINDOW_TO = MON2; // eight calendar days, both ends included

let b: Base;
let emp: string;
const uniq = () => Math.random().toString(36).slice(2, 8);

beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
  const a = adminCtx(b);

  // A fixed Mon–Fri 09:00–18:00 shift with an hour's break → 480 scheduled minutes on a working day, and
  // Saturday / Sunday outside the weekly pattern, which is what makes them non-working days.
  const shiftId = (
    await createShift(a, {
      name: `Overview ${uniq()}`,
      code: `OVW${uniq()}`,
      startTime: '09:00',
      endTime: '18:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
    })
  ).id;
  const hired = await hireEmployee(a, {
    person: { fullName: 'Attendance Overview Reader', primaryEmail: `ovw_${uniq()}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  emp = hired.employmentId;
  await assignDefaultShift(a, { employmentId: emp, shiftId });

  // A national public holiday on the Thursday — no state, no company, no group, so it resolves for anyone
  // in a company whose country matches. THU therefore carries no attendance row and the `holiday` context.
  await createHoliday(a, { country: 'MY', holidayDate: THU, name: `Overview PH ${uniq()}` });

  // MON — a clean full day.
  await checkIn(a, { employmentId: emp, date: MON, time: '09:00' });
  await checkOut(a, { employmentId: emp, date: MON, time: '18:00' });
  // TUE — arrived at 11:00, well past any grace: a PRESENT day carrying the Late flag. This is the pair the
  // reporter wanted drawn as two statuses, and the one the kernel refuses to collapse.
  await checkIn(a, { employmentId: emp, date: TUE, time: '11:00' });
  await checkOut(a, { employmentId: emp, date: TUE, time: '18:00' });
  // WED — one punch only: PRESENT with the Odd flag (the reporter's "Incomplete").
  await checkIn(a, { employmentId: emp, date: WED, time: '09:00' });
  // THU — public holiday, no punches.
  // FRI — a working day with no punches at all: Absent.
  // SAT + SUN — outside the weekly pattern: Off.
  // MON2 — on time, left at 14:00: PRESENT with the Under flag (short of the scheduled hours).
  await checkIn(a, { employmentId: emp, date: MON2, time: '09:00' });
  await checkOut(a, { employmentId: emp, date: MON2, time: '14:00' });
}, 180_000);

afterAll(closeAll);

// ───────────────────── A. The resolver — pure, and the range filter's whole contract ─────────────────────

describe('67268d83 — resolveMyAttendanceRange', () => {
  const MAX = ATTENDANCE_RANGE_MAX_DAYS;

  it('counts calendar days with BOTH ends included', () => {
    expect(dayCountInclusive('2026-03-01', '2026-03-01'), 'one day is 1, not 0').toBe(1);
    expect(dayCountInclusive('2026-03-01', '2026-03-31')).toBe(31);
    // Across a leap day and a year boundary — the two places an off-by-one hides.
    expect(dayCountInclusive('2024-02-28', '2024-03-01')).toBe(3);
    expect(dayCountInclusive('2025-12-31', '2026-01-01')).toBe(2);
    expect(dayCountInclusive('2026-03-31', '2026-03-01'), 'inverted answers 0, never a negative').toBe(0);
  });

  it('opens on the current month up to today when the address carries no dates', () => {
    const r = resolveMyAttendanceRange({}, '2026-09-30', MAX);
    expect(r).toEqual({ from: '2026-09-01', to: '2026-09-30', days: 30, refusal: null });
    expect(firstOfMonth('2026-09-30')).toBe('2026-09-01');
  });

  it('HONOURS the dates the reader asked for — this is the filter working at all', () => {
    // The defect this catches is the cheapest one to write by accident: a screen that renders the filter,
    // reads the address, and then issues the default month anyway. Every other assertion in this file would
    // still pass, because the default month is a perfectly good range.
    const r = resolveMyAttendanceRange({ from: '2026-03-05', to: '2026-03-09' }, '2026-09-30', MAX);
    expect(r.from, 'Date From is the reader’s, not the first of the current month').toBe('2026-03-05');
    expect(r.to, 'Date To is the reader’s, not today').toBe('2026-03-09');
    expect(r).toMatchObject({ days: 5, refusal: null });
  });

  it('a malformed date falls back to its own default and leaves the other end alone', () => {
    expect(resolveMyAttendanceRange({ from: 'last tuesday', to: '2026-09-20' }, '2026-09-30', MAX)).toEqual({
      from: '2026-09-01',
      to: '2026-09-20',
      days: 20,
      refusal: null,
    });
    expect(resolveMyAttendanceRange({ from: '2026-09-02', to: '' }, '2026-09-30', MAX)).toMatchObject({
      from: '2026-09-02',
      to: '2026-09-30',
    });
  });

  it('REFUSES past the kernel’s ceiling, and the boundary is exact', () => {
    // Exactly at the ceiling is allowed: the loop walks that many days, so the answer is complete.
    const at = resolveMyAttendanceRange({ from: isoAdd('2026-09-30', -(MAX - 1)), to: '2026-09-30' }, '2026-09-30', MAX);
    expect(at.days, 'the widest honest range is exactly the ceiling').toBe(MAX);
    expect(at.refusal, 'and it is NOT refused').toBeNull();
    // One day more is the first range the loop would cut short, so it is the first one refused.
    const over = resolveMyAttendanceRange({ from: isoAdd('2026-09-30', -MAX), to: '2026-09-30' }, '2026-09-30', MAX);
    expect(over.days).toBe(MAX + 1);
    expect(over.refusal, 'one day past the ceiling refuses rather than truncating').toBe('too_long');
    // The asked-for dates survive the refusal, so the filter boxes still hold what the reader typed.
    expect(over.from).toBe(isoAdd('2026-09-30', -MAX));
    expect(over.to).toBe('2026-09-30');
  });

  it('an inverted range says so instead of reading as an empty record', () => {
    const r = resolveMyAttendanceRange({ from: '2026-09-30', to: '2026-09-01' }, '2026-09-30', MAX);
    expect(r.refusal).toBe('inverted');
    expect(r.days).toBe(0);
  });
});

// ───────────────────── B. The fixture — asserted BEFORE anything is concluded from it ─────────────────────

describe('67268d83 — the eight-day fixture really holds four statuses and three flags', () => {
  it('THE NON-VACUITY ANCHOR: the counts, through the same derivations the screen renders through', async () => {
    const rows = await attendanceForEmploymentRange(adminCtx(b), emp, WINDOW_FROM, WINDOW_TO);
    expect(rows.length, 'one row per calendar day, both ends included').toBe(8);

    const byStatus = new Map<AttendanceStatus, string[]>();
    for (const r of rows) {
      const k = statusOf(r);
      byStatus.set(k, [...(byStatus.get(k) ?? []), r.date]);
    }
    // Four DISTINCT statuses on real seeded days. An empty or single-status fixture fails here, which is the
    // whole point of putting this case first.
    expect([...byStatus.keys()].sort(), 'four of the six statuses are genuinely present').toEqual([
      'absent',
      'off',
      'ph',
      'present',
    ]);
    expect(byStatus.get('present')!.sort(), 'the three clocked days plus the short one').toEqual(
      [MON, TUE, WED, MON2].sort(),
    );
    expect(byStatus.get('ph'), 'the national holiday, with no punches, is not an absence').toEqual([THU]);
    expect(byStatus.get('absent'), 'a working day with no punches and no reason IS one').toEqual([FRI]);
    expect(byStatus.get('off')!.sort(), 'the weekend, outside the shift’s weekly pattern').toEqual([SAT, SUN].sort());

    const byFlag = new Map<Exclude<AttendanceFlag, null>, string[]>();
    let unflagged = 0;
    for (const r of rows) {
      const f = flagOf(r);
      if (f) byFlag.set(f, [...(byFlag.get(f) ?? []), r.date]);
      else unflagged += 1;
    }
    expect([...byFlag.keys()].sort(), 'all three flags occur').toEqual(['late', 'odd', 'under']);
    expect(byFlag.get('late'), 'the 11:00 arrival').toEqual([TUE]);
    expect(byFlag.get('odd'), 'the day with one punch').toEqual([WED]);
    expect(byFlag.get('under'), 'the day that finished five hours short').toEqual([MON2]);
    expect(unflagged, 'the clean day, the holiday, the absence and the two weekend days').toBe(5);
  });

  it('LATE AND INCOMPLETE ARE NOT STATUSES — the day is Present, and the flag is the second axis', async () => {
    const rows = await attendanceForEmploymentRange(adminCtx(b), emp, TUE, WED);
    const tue = rows.find((r) => r.date === TUE)!;
    const wed = rows.find((r) => r.date === WED)!;
    // This is the reporter's eight-status list, adjudicated. Drawing "Late" where "Present" belongs would
    // assert a choice the kernel never makes, and would make this screen disagree with HR's about one day.
    expect(statusOf(tue), 'a late day is a day you were PRESENT for').toBe('present');
    expect(flagOf(tue), 'the lateness is the note beside it').toBe('late');
    expect(statusOf(wed), 'a day with a punch missing is also a present day').toBe('present');
    expect(flagOf(wed), 'the reporter’s "Incomplete"').toBe('odd');
    // And the stored figures the screen's hour columns read are really there, so the columns are not em
    // dashes over a fixture with no engine behind it.
    expect(tue.scheduledMinutes, 'the 8-hour shift').toBe(480);
    expect(tue.workedMinutes, '11:00→18:00 less the hour break').toBe(360);
  });

  it('the range filter NARROWS the read — the dates outside it are not fetched', async () => {
    const sub = resolveMyAttendanceRange({ from: TUE, to: THU }, TODAY, ATTENDANCE_RANGE_MAX_DAYS);
    expect(sub).toMatchObject({ from: TUE, to: THU, days: 3, refusal: null });
    const rows = await attendanceForEmploymentRange(adminCtx(b), emp, sub.from, sub.to);
    expect([...rows.map((r) => r.date)].sort(), 'exactly the three days asked for').toEqual([TUE, WED, THU].sort());
    // …and the seeded days on either side are genuinely absent rather than the range being ignored.
    expect(rows.some((r) => r.date === MON), 'the day before Date From is not returned').toBe(false);
    expect(rows.some((r) => r.date === FRI), 'nor the day after Date To').toBe(false);
  });
});

// ───────────────────── C. The hazard: what the ceiling does, and what the refusal prevents ─────────────────────

describe('67268d83 — the 400-day silent truncation, and the refusal that closes it', () => {
  it('THE HAZARD IS REAL: a 501-day read returns 400 rows and DROPS every seeded day, silently', async () => {
    const longFrom = isoAdd(WINDOW_TO, -500);
    expect(dayCountInclusive(longFrom, WINDOW_TO), 'the window asked for').toBe(501);

    const rows = await attendanceForEmploymentRange(adminCtx(b), emp, longFrom, WINDOW_TO);
    // No error, no empty array, no marker on the result — just a short one. That is the defect.
    expect(rows.length, 'the loop stops at the ceiling and says nothing about it').toBe(ATTENDANCE_RANGE_MAX_DAYS);
    const dates = new Set(rows.map((r) => r.date));
    // Membership, not position: the last day the loop reaches is present and the next one is not.
    expect(dates.has(isoAdd(longFrom, ATTENDANCE_RANGE_MAX_DAYS - 1)), 'the last day walked IS returned').toBe(true);
    expect(dates.has(isoAdd(longFrom, ATTENDANCE_RANGE_MAX_DAYS)), 'the day after the ceiling is NOT').toBe(false);
    // And this is why it matters rather than being a curiosity: every day this fixture seeded — the clean
    // day, the late day, the incomplete day, the holiday, the absence, the short day — falls past the
    // ceiling and is missing from a result that looks complete.
    for (const d of [MON, TUE, WED, THU, FRI, SAT, SUN, MON2]) {
      expect(dates.has(d), `${d} was seeded and is silently absent from the truncated read`).toBe(false);
    }
    expect(dates.has(WINDOW_TO), 'including the very day the reader asked to see LAST').toBe(false);
  });

  it('THE REFUSAL CLOSES IT: the screen never issues that read, and the two numbers are one number', () => {
    const longFrom = isoAdd(WINDOW_TO, -500);
    const r = resolveMyAttendanceRange({ from: longFrom, to: WINDOW_TO }, TODAY, ATTENDANCE_RANGE_MAX_DAYS);
    expect(r.refusal, 'the exact span the loop would have cut short is refused').toBe('too_long');
    expect(r.days, 'and the reader is told how long their range actually was').toBe(501);
    // The bound is the KERNEL's own constant, so it cannot drift away from the loop it protects. A second
    // hand-typed 400 in the page is how the cliff would come back after someone raised the loop's cap.
    expect(ATTENDANCE_RANGE_MAX_DAYS, 'the published ceiling').toBe(400);
  });

  it('a range at the ceiling is served IN FULL — the refusal is a bound, not a shrug', async () => {
    const from = isoAdd(WINDOW_TO, -(ATTENDANCE_RANGE_MAX_DAYS - 1));
    const r = resolveMyAttendanceRange({ from, to: WINDOW_TO }, TODAY, ATTENDANCE_RANGE_MAX_DAYS);
    expect(r.refusal, 'exactly at the ceiling is honest, so it is allowed').toBeNull();
    const rows = await attendanceForEmploymentRange(adminCtx(b), emp, r.from, r.to);
    expect(rows.length, 'and every day of it comes back').toBe(ATTENDANCE_RANGE_MAX_DAYS);
    const dates = new Set(rows.map((r2) => r2.date));
    // The widest range the screen will serve still reaches the seeded days at BOTH ends of the window.
    for (const d of [MON, TUE, WED, THU, FRI, SAT, SUN, MON2]) {
      expect(dates.has(d), `${d} is inside the widest allowed range and must be returned`).toBe(true);
    }
  });
});
