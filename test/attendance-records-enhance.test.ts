/**
 * Attendance Records Table Enhancement (feedback bbada39c).
 *
 * Two halves:
 *  A. PURE derivations (core/attendance-derive.ts) — no fixtures. otByRate sums back to worked minutes and
 *     routes by dayType; flagOf computes Late / Under / Odd / blank; statusOf collapses to the v1 set.
 *  B. LOADER extensions (core/attendance.ts) — the Daily + Individual reads now surface, per row, the
 *     assigned Shift Code, scheduled minutes and shift start/end, and the Individual range row carries the
 *     employee code + name. Shift code resolves for a fixed-shift AND a rostered employee; the four OT
 *     columns sum back to the day's otMinutes + normal hours.
 *
 * Read-only feature: the loaders append no DomainEvent (documented skip).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { createShift, assignDefaultShift, assignShift } from '../core/roster';
import { checkIn, checkOut, attendanceForDate, attendanceForEmploymentRange } from '../core/attendance';
import { otByRate, flagOf, statusOf } from '../core/attendance-derive';

const WORKDAY = '2026-07-01'; // Wednesday (ISO weekday 3) — a working day under Mon–Fri
const REST_DAY = '2026-07-04'; // Saturday

let b: Base;
const uniq = () => Math.random().toString(36).slice(2, 8);

async function hire(fullName: string, defaultShiftId?: string) {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName, primaryEmail: `enh_${uniq()}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  if (defaultShiftId) await assignDefaultShift(a, { employmentId: e.employmentId, shiftId: defaultShiftId });
  return e.employmentId;
}

beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
}, 120_000);

afterAll(closeAll);

// ─────────────────────────── A. Pure derivations ───────────────────────────

describe('otByRate — derive the four rate buckets', () => {
  it('workday OT → 1.5×; the four sum back to workedMinutes', () => {
    // Worked 9h (540m), scheduled 8h → 60m OT on a workday.
    const r = otByRate({ workedMinutes: 540, otMinutes: 60, dayType: 'workday' });
    expect(r).toEqual({ ot10: 480, ot15: 60, ot20: 0, ot30: 0 });
    expect(r.ot10 + r.ot15 + r.ot20 + r.ot30).toBe(540); // = normal + otMinutes
  });
  it('rest-day work is all OT → 2.0×, no normal', () => {
    const r = otByRate({ workedMinutes: 300, otMinutes: 300, dayType: 'rest_day' });
    expect(r).toEqual({ ot10: 0, ot15: 0, ot20: 300, ot30: 0 });
  });
  it('holiday work → 3.0×', () => {
    const r = otByRate({ workedMinutes: 240, otMinutes: 240, dayType: 'holiday' });
    expect(r).toEqual({ ot10: 0, ot15: 0, ot20: 0, ot30: 240 });
  });
  it('no OT → everything is normal 1.0×', () => {
    const r = otByRate({ workedMinutes: 480, otMinutes: 0, dayType: 'workday' });
    expect(r).toEqual({ ot10: 480, ot15: 0, ot20: 0, ot30: 0 });
  });
  it('a no-work day splits to zero', () => {
    expect(otByRate({ workedMinutes: null, otMinutes: null, dayType: null })).toEqual({ ot10: 0, ot15: 0, ot20: 0, ot30: 0 });
  });
});

describe('flagOf — operational irregularities', () => {
  const base = { attendanceId: 'a', status: 'present', checkInAt: '09:00:00', checkOutAt: '18:00:00', dayType: 'workday' as const, workedMinutes: 480, scheduledMinutes: 480 };
  it('clean full workday → no flag', () => expect(flagOf(base)).toBeNull());
  it('late arrival → Late', () => expect(flagOf({ ...base, status: 'late' })).toBe('late'));
  it('single punch → Odd (missing check-out)', () => expect(flagOf({ ...base, checkOutAt: null })).toBe('odd'));
  it('short day from early checkout → Under', () => expect(flagOf({ ...base, workedMinutes: 300 })).toBe('under'));
  it('no attendance row → no flag', () => expect(flagOf({ ...base, attendanceId: null })).toBeNull());
  it('rest-day short worked does NOT flag Under (no required hours)', () =>
    expect(flagOf({ ...base, dayType: 'rest_day', workedMinutes: 120, scheduledMinutes: null })).toBeNull());
});

describe('statusOf — the always-present v1 Status', () => {
  it('present / late / half_day rows all read Present (irregularity is the Flag, not the Status)', () => {
    for (const status of ['present', 'late', 'half_day']) {
      expect(statusOf({ attendanceId: 'a', status, context: null, isRosterRest: false })).toBe('present');
    }
  });
  it('an absent row → Absent', () => expect(statusOf({ attendanceId: 'a', status: 'absent', context: null, isRosterRest: false })).toBe('absent'));
  it('no row, working day → Absent', () => expect(statusOf({ attendanceId: null, status: null, context: null, isRosterRest: false })).toBe('absent'));
  it('leave → On Leave; holiday → PH', () => {
    expect(statusOf({ attendanceId: null, status: null, context: 'on_leave', isRosterRest: false })).toBe('on_leave');
    expect(statusOf({ attendanceId: null, status: null, context: 'holiday', isRosterRest: false })).toBe('ph');
  });
  it('rest_day → Rest when explicitly rostered, else OFF', () => {
    expect(statusOf({ attendanceId: null, status: null, context: 'rest_day', isRosterRest: true })).toBe('rest');
    expect(statusOf({ attendanceId: null, status: null, context: 'rest_day', isRosterRest: false })).toBe('off');
  });
});

// ─────────────────────────── B. Loader extensions ───────────────────────────

describe('attendanceForDate — shift code + scheduled minutes + OT split', () => {
  it('resolves the fixed default shift code and splits workday OT into the 1.5× bucket', async () => {
    const a = adminCtx(b);
    const shiftId = (await createShift(a, { name: `Office ${uniq()}`, code: `OFC${uniq()}`, startTime: '09:00', endTime: '18:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5] })).id;
    const emp = await hire('Fixed Shift Worker', shiftId);
    await checkIn(a, { employmentId: emp, date: WORKDAY, time: '09:00' });
    await checkOut(a, { employmentId: emp, date: WORKDAY, time: '19:00' }); // 10h span − 1h break = 9h worked → 1h OT

    const rows = await attendanceForDate(a, WORKDAY, [b.companyId]);
    const row = rows.find((r) => r.employmentId === emp)!;
    expect(row.shiftCode).toMatch(/^OFC/);
    expect(row.scheduledMinutes).toBe(480); // 8h shift
    expect(row.workedMinutes).toBe(540); // 9h
    expect(row.otMinutes).toBe(60); // 1h workday OT
    const ot = otByRate(row);
    expect(ot).toEqual({ ot10: 480, ot15: 60, ot20: 0, ot30: 0 });
    // Invariant: the four buckets sum back to the day's normal hours + otMinutes.
    expect(ot.ot10 + ot.ot15 + ot.ot20 + ot.ot30).toBe((row.workedMinutes ?? 0));
  });

  it('resolves a rostered shift code (roster wins over any default)', async () => {
    const a = adminCtx(b);
    const rosterShift = (await createShift(a, { name: `Night ${uniq()}`, code: `NGT${uniq()}`, startTime: '08:00', endTime: '16:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5] })).id;
    const emp = await hire('Rostered Worker');
    await assignShift(a, { employmentId: emp, shiftDate: WORKDAY, shiftId: rosterShift });
    await checkIn(a, { employmentId: emp, date: WORKDAY, time: '08:00' });
    await checkOut(a, { employmentId: emp, date: WORKDAY, time: '16:00' });

    const rows = await attendanceForDate(a, WORKDAY, [b.companyId]);
    const row = rows.find((r) => r.employmentId === emp)!;
    expect(row.shiftCode).toMatch(/^NGT/);
    expect(row.scheduledMinutes).toBe(420); // 8h span − 1h break = 7h
    expect(row.shiftStart).toBe('08:00');
    expect(row.shiftEnd).toBe('16:00');
  });

  it('an employee on company policy (no shift) has no shift code but carries the policy scheduled minutes', async () => {
    const a = adminCtx(b);
    const emp = await hire('Policy Worker');
    const rows = await attendanceForDate(a, WORKDAY, [b.companyId]);
    const row = rows.find((r) => r.employmentId === emp)!;
    expect(row.shiftCode).toBeNull();
    expect(row.scheduledMinutes).not.toBeNull(); // policy working-day schedule
  });
});

describe('attendanceForEmploymentRange — identity + shift display on the individual row', () => {
  it('carries employee code + name and the per-day shift code', async () => {
    const a = adminCtx(b);
    const shiftId = (await createShift(a, { name: `Ind ${uniq()}`, code: `IND${uniq()}`, startTime: '09:00', endTime: '18:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5] })).id;
    const emp = await hire('Range Person', shiftId);
    await checkIn(a, { employmentId: emp, date: WORKDAY, time: '09:00' });
    await checkOut(a, { employmentId: emp, date: WORKDAY, time: '18:00' });

    const rows = await attendanceForEmploymentRange(a, emp, WORKDAY, REST_DAY);
    const worked = rows.find((r) => r.date === WORKDAY)!;
    expect(worked.name).toBe('Range Person');
    expect(worked.employeeCode ?? null).not.toBeUndefined(); // present as a field (may be null if unset)
    expect(worked.shiftCode).toMatch(/^IND/);
    expect(worked.scheduledMinutes).toBe(480);

    const rest = rows.find((r) => r.date === REST_DAY)!;
    // Saturday is not in the shift's weekly pattern → OFF, no shift code, no scheduled minutes.
    expect(rest.shiftCode).toBeNull();
    expect(rest.scheduledMinutes).toBeNull();
    expect(statusOf(rest)).toBe('off');
  });
});
