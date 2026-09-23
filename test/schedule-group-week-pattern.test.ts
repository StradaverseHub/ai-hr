/**
 * 07ebd04d — THE WORKING WEEK MOVES FROM THE SHIFT TO THE SCHEDULE GROUP, and this pins the seam it moves
 * through plus the two facts the reporter's decision rests on.
 *
 * The approved item splits one Schedule Group into three because "Saturday not applicable" and "Saturday
 * Off Day" are NOT the same working pattern. Step one is a read-only report, not a migration
 * (scripts/report-schedule-group-split.ts). What is built behind it is the single resolver every reader
 * will take once `weekly_pattern` / `half_pattern` / `off_pattern` live on `attendance_rule`:
 * `weekPatternFor(group, shift)`.
 *
 * ⚠️ THE TRAP THE RESOLVER EXISTS TO CLOSE. core/roster.ts assignEmployeeShift records that a NULL or
 * empty weekly pattern "matches NOTHING, falls through to policyBranch('rest_day')" — so a Schedule Group
 * row created WITHOUT its patterns would silently book every working day as a rest day for everyone in
 * that group at once, paying rest-day overtime on ordinary work with no error anywhere. The read
 * therefore falls back to the shift, which is the value that is correct today; the WRITE side must refuse
 * a pattern-less group outright, and that half belongs with the migration.
 *
 * ⚠️ AND THE OFF-vs-REST PAY DIFFERENCE IS TRUE ON ONE BRANCH ONLY. The plan told the reporter that an
 * OFF Saturday pays 1.5x and a REST Saturday 2.0x. That is what `scheduleFor` does on its DEFAULT-SHIFT
 * step — and only there. The rostered step above it is two-way, `roster_assignment.is_rest_day` is a
 * BOOLEAN with nowhere to record "off rather than rest", and core/roster.ts generateRosterFromTemplate
 * writes OFF days into exactly that boolean. The last two cases below pin both halves, because a fact
 * quoted to the reporter that holds on one code path and not the neighbouring one is the kind of thing
 * this file exists to stop being repeated.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { dayTypeFor, weekPatternFor, weekPatternWorkingDayCount } from '../core/attendance';
import { assignDefaultShift, createShift, setRestDay, ShiftHasNoWorkingPatternError } from '../core/roster';
import { assignEmployeeShiftDated } from '../core/shift-arrangement';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

/** 2026-05-09 is a SATURDAY (ISO 6); 2026-05-05 is a Tuesday (ISO 2). */
const SAT = '2026-05-09';

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
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('07ebd04d — weekPatternFor: the ONE resolver, group first and shift second', () => {
  const shiftWeek = { pattern: [1, 2, 3, 4, 5], halfPattern: [], offPattern: [6] };
  const groupWeek = { pattern: [1, 2, 3, 4], halfPattern: [5], offPattern: [] };

  it('a group that declares a working week WINS, and says so', () => {
    const r = weekPatternFor(groupWeek, shiftWeek);
    expect(r.source).toBe('group');
    expect([r.pattern, r.halfPattern, r.offPattern]).toEqual([[1, 2, 3, 4], [5], []]);
  });

  it('NO group ⇒ the shift answers, byte for byte — which is every caller today', () => {
    const r = weekPatternFor(null, shiftWeek);
    expect(r.source).toBe('shift');
    expect([r.pattern, r.halfPattern, r.offPattern]).toEqual([[1, 2, 3, 4, 5], [], [6]]);
    // `undefined` is the same answer as `null`: a column that does not exist yet reads as either.
    expect(weekPatternFor(undefined, shiftWeek).source).toBe('shift');
  });

  it('⚠️ A GROUP WITH NO WORKING DAY DOES NOT WIN — otherwise every day becomes a rest day', () => {
    // This is the whole reason the resolver is not `group ?? shift`. A group row created without its
    // patterns — the single most likely mistake in the migration that moves them — must not silently
    // re-price everybody in it. Three shapes of "no pattern", all of which a fresh row can have.
    for (const empty of [
      { pattern: null, halfPattern: null, offPattern: null },
      { pattern: [], halfPattern: [], offPattern: [] },
      // Off days alone are NOT a working week: Off is a non-working day, like Rest.
      { pattern: [], halfPattern: [], offPattern: [6] },
    ]) {
      const r = weekPatternFor(empty, shiftWeek);
      expect(r.source, JSON.stringify(empty)).toBe('shift');
      expect(r.pattern).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it('weekPatternWorkingDayCount is Full ∪ Half — Off and Rest are not working days', () => {
    expect(weekPatternWorkingDayCount({ pattern: [1, 2, 3, 4, 5], halfPattern: [6], offPattern: [] })).toBe(6);
    // An all-half-days shift IS walkable and must not read as zero, or the backup-shift guards below
    // would start refusing it.
    expect(weekPatternWorkingDayCount({ pattern: null, halfPattern: [1, 2], offPattern: [] })).toBe(2);
    // Overlap cannot inflate the count (the three arrays are disjoint by CHECK, but the union is what the
    // guards mean either way).
    expect(weekPatternWorkingDayCount({ pattern: [1, 2], halfPattern: [2] })).toBe(2);
    expect(weekPatternWorkingDayCount({ pattern: [], halfPattern: [], offPattern: [1, 2, 3, 4, 5, 6, 7] })).toBe(0);
    expect(weekPatternWorkingDayCount({ pattern: null })).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('07ebd04d — the two backup-shift guards share ONE count and still refuse', () => {
  /** A shift with NO working weekday at all: every day of it resolves to a rest day. */
  const patternlessShift = () =>
    createShift(adminCtx(b), {
      name: `NoPat_${randomUUID().slice(0, 6)}`,
      code: `NP_${randomUUID().slice(0, 6)}`,
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      weeklyPattern: null,
    });

  const anEmployee = async () => {
    const a = adminCtx(b);
    const e = await hireEmployee(a, {
      person: { fullName: 'Pattern Case', primaryEmail: `wp_${randomUUID()}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    return { a, employmentId: e.employmentId };
  };

  it('core/roster.ts assignDefaultShift refuses it', async () => {
    const sh = await patternlessShift();
    const { a, employmentId } = await anEmployee();
    await expect(assignDefaultShift(a, { employmentId, shiftId: sh.id })).rejects.toBeInstanceOf(ShiftHasNoWorkingPatternError);
  });

  it('core/shift-arrangement.ts assignEmployeeShiftDated refuses it too — the SECOND writer', async () => {
    // Until 07ebd04d this guard carried its own hand-written copy of the set union. Both now call
    // weekPatternWorkingDayCount; this is the case that proves the second writer did not lose its guard.
    const sh = await patternlessShift();
    const { a, employmentId } = await anEmployee();
    await expect(
      assignEmployeeShiftDated(a, { employmentId, shiftType: 'fixed', shiftId: sh.id, effectiveFrom: '2026-01-01' }),
    ).rejects.toBeInstanceOf(ShiftHasNoWorkingPatternError);
  });

  it('…and an ALL-HALF-DAYS shift is still accepted by both — the guard is not a Full-days check', async () => {
    const sh = await createShift(adminCtx(b), {
      name: `AllHalf_${randomUUID().slice(0, 6)}`,
      code: `AH_${randomUUID().slice(0, 6)}`,
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      weeklyPattern: null,
      halfPattern: [1, 2, 3, 4, 5],
    });
    const { a, employmentId } = await anEmployee();
    await expect(assignDefaultShift(a, { employmentId, shiftId: sh.id })).resolves.toBeTruthy();
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
describe('07ebd04d — what a Saturday OFF day actually resolves to, on each branch', () => {
  const satShift = (extra: Record<string, unknown>) =>
    createShift(adminCtx(b), {
      name: `Sat_${randomUUID().slice(0, 6)}`,
      code: `S_${randomUUID().slice(0, 6)}`,
      startTime: '08:00:00',
      endTime: '17:00:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
      ...extra,
    });

  const employeeOn = async (shiftId: string) => {
    const a = adminCtx(b);
    const e = await hireEmployee(a, {
      person: { fullName: 'Saturday Case', primaryEmail: `sat_${randomUUID()}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
    });
    await assignDefaultShift(a, { employmentId: e.employmentId, shiftId });
    return { a, employmentId: e.employmentId };
  };

  it('THE REPORTER’S QUESTION: off and rest are DIFFERENT day types, so they cannot share a group', async () => {
    // This is the fact the whole split rests on, read off the same resolver the clocking path freezes on
    // to an attendance row. OFF ⇒ a workday with no scheduled hours (every worked minute is s.60A(3)(a)
    // overtime at 1.5x). REST ⇒ rest_day (s.60(3), 2.0x on the excess).
    const off = await satShift({ offPattern: [6] });
    const rest = await satShift({}); // Saturday is in none of the three lists ⇒ Rest, the complement
    const offEmp = await employeeOn(off.id);
    const restEmp = await employeeOn(rest.id);

    expect(await dayTypeFor(offEmp.a, offEmp.employmentId, SAT)).toBe('workday');
    expect(await dayTypeFor(restEmp.a, restEmp.employmentId, SAT)).toBe('rest_day');
  });

  it('⚠️ AND THE DIFFERENCE DISAPPEARS THE MOMENT A ROSTER ROW EXISTS — a pre-existing defect, recorded', async () => {
    // core/attendance.ts scheduleFor: `if (ra?.isRestDay) return { ...policyBranch('rest_day'), … }` with
    // NO off-day branch, because roster_assignment.is_rest_day is a boolean. core/roster.ts
    // generateRosterFromTemplate pushes Rest AND Off into the same restDates list, so generating a roster
    // from an off-pattern shift is precisely what writes these rows.
    //
    // The split is still correct — it is what keeps the two apart where the distinction survives — but the
    // 1.5x promised to the reporter is not in force on any date that has one of these rows. The report
    // script counts them on production so the reporter is told a rate that is true.
    const off = await satShift({ offPattern: [6] });
    const { a, employmentId } = await employeeOn(off.id);
    expect(await dayTypeFor(a, employmentId, SAT)).toBe('workday'); // the off branch, before the roster row

    await setRestDay(a, { employmentId, shiftDate: SAT });
    const [row] = await owner.db
      .select()
      .from(schema.rosterAssignment)
      .where(and(eq(schema.rosterAssignment.employmentId, employmentId), eq(schema.rosterAssignment.shiftDate, SAT)));
    expect(row.isRestDay).toBe(true);

    // The SAME employee, the SAME shift, the SAME Saturday — now a rest day, and paid like one.
    expect(await dayTypeFor(a, employmentId, SAT)).toBe('rest_day');
  });
});
