/**
 * 7c834696 POINT 3 — the trace survives the round trip: engine → jsonb → loader → reader.
 *
 * test/attendance-explain-panel.test.ts holds the reader against hand-built traces, which proves the
 * reader but proves nothing about the wiring. This file is the wiring, and it is the half that can break
 * silently: `attendance.calc_trace` is a column the two Records loaders have to SELECT, and a loader that
 * forgets it returns `undefined`, which the reader dutifully reports as "no working was recorded" — an
 * honest-looking panel that is wrong on every row. Types cannot see it (the column is nullable), the
 * screens still render, and the page still returns 200.
 *
 * It also pins the one claim the whole design rests on: the explanation's figures are the STORED figures.
 * If `explainAttendanceDay(row.calcTrace).overtime.minutes` ever disagrees with `row.otMinutes`, the panel
 * is contradicting the number printed beside it, which core/pcb-explain.ts calls worse than no panel.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { createShift, assignDefaultShift } from '../core/roster';
import { checkIn, checkOut, attendanceForDate, attendanceForEmploymentRange } from '../core/attendance';
import { explainAttendanceDay } from '../core/attendance-explain';
import { isAttendanceTrace } from '../core/attendance-trace';

const WORKDAY = '2026-07-01'; // Wednesday (ISO weekday 3) — a working day under Mon–Fri
const NEXT_DAY = '2026-07-02'; // Thursday, deliberately left with no attendance row

let b: Base;
const uniq = () => Math.random().toString(36).slice(2, 8);

async function hireWithShift(fullName: string) {
  const a = adminCtx(b);
  const shiftId = (
    await createShift(a, {
      name: `Trace ${uniq()}`,
      code: `TRC${uniq()}`,
      startTime: '09:00',
      endTime: '18:00',
      breakMinutes: 60,
      weeklyPattern: [1, 2, 3, 4, 5],
    })
  ).id;
  const e = await hireEmployee(a, {
    person: { fullName, primaryEmail: `trace_${uniq()}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await assignDefaultShift(a, { employmentId: e.employmentId, shiftId });
  return e.employmentId;
}

beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
}, 120_000);

afterAll(closeAll);

describe('the Daily loader carries the working', () => {
  it('a full day round-trips, and every explained figure equals the stored figure', async () => {
    const a = adminCtx(b);
    const emp = await hireWithShift('Traced Worker');
    // 09:20 in (20m late against a 09:00 start) and 19:00 out — 9h40 span − 1h break = 8h40 worked,
    // 1h beyond the shift's 18:00 time-out.
    await checkIn(a, { employmentId: emp, date: WORKDAY, time: '09:20' });
    await checkOut(a, { employmentId: emp, date: WORKDAY, time: '19:00' });

    const row = (await attendanceForDate(a, WORKDAY, [b.companyId])).find((r) => r.employmentId === emp)!;
    expect(isAttendanceTrace(row.calcTrace), 'the loader must SELECT calc_trace').toBe(true);

    const e = explainAttendanceDay(row.calcTrace);
    if (e.kind !== 'explained') throw new Error(`expected an explained day, got ${JSON.stringify(e)}`);
    // THE contract: the panel repeats the stored figures rather than recomputing them.
    expect(e.lateness.minutes).toBe(row.lateMinutes);
    expect(e.earlyOut.minutes).toBe(row.earlyOutMinutes);
    expect(e.overtime.minutes).toBe(row.otMinutes);
    expect(e.punch.workedMinutes).toBe(row.workedMinutes);
    // Minutes from midnight on the shift's own anchored timeline, not a clock string.
    expect(e.punch.inAbs).toBe(9 * 60 + 20);
    expect(e.punch.outAbs).toBe(19 * 60);
    expect(e.schedule.startAbs).toBe(9 * 60);
    expect(e.schedule.endAbs).toBe(18 * 60);
    expect(e.schedule.scheduledMinutes).toBe(row.scheduledMinutes);
    // And every section produced working rather than an empty list.
    for (const s of [e.lateness, e.earlyOut, e.overtime]) expect(s.steps.length).toBeGreaterThan(0);
  });

  it('an OPEN day explains the half that is knowable and stays silent about the half that is not', async () => {
    const a = adminCtx(b);
    const emp = await hireWithShift('Open Day Worker');
    await checkIn(a, { employmentId: emp, date: WORKDAY, time: '09:30' });

    const row = (await attendanceForDate(a, WORKDAY, [b.companyId])).find((r) => r.employmentId === emp)!;
    const e = explainAttendanceDay(row.calcTrace);
    if (e.kind !== 'explained') throw new Error('expected an explained day');
    // Lateness is already settled at 09:30 and is exactly what HR asks about mid-morning.
    expect(e.lateness.minutes).toBe(row.lateMinutes);
    expect(e.punch.outAbs).toBeNull();
    // Overtime is unknowable until the clock-out, so it is null — NOT a confident zero.
    expect(e.overtime.minutes).toBeNull();
    expect(e.overtime.steps.map((s) => s.key)).toEqual(['otNotApplicable']);
  });

  it('a day with no attendance row at all carries no trace, and the reader says so', async () => {
    const a = adminCtx(b);
    const emp = await hireWithShift('No Row Worker');
    const row = (await attendanceForDate(a, NEXT_DAY, [b.companyId])).find((r) => r.employmentId === emp)!;
    expect(row.attendanceId).toBeNull();
    expect(explainAttendanceDay(row.calcTrace)).toEqual({ kind: 'unavailable', reason: 'no-trace' });
  });
});

describe('the Individual loader carries the same working', () => {
  it('the range read explains a day identically to the daily read', async () => {
    const a = adminCtx(b);
    const emp = await hireWithShift('Range Traced');
    await checkIn(a, { employmentId: emp, date: WORKDAY, time: '09:00' });
    await checkOut(a, { employmentId: emp, date: WORKDAY, time: '18:30' });

    const daily = (await attendanceForDate(a, WORKDAY, [b.companyId])).find((r) => r.employmentId === emp)!;
    const range = (await attendanceForEmploymentRange(a, emp, WORKDAY, NEXT_DAY)).find((r) => r.date === WORKDAY)!;
    // The two tabs must not be able to explain one day differently — same stored trace, same steps.
    expect(range.calcTrace).toEqual(daily.calcTrace);
    expect(explainAttendanceDay(range.calcTrace)).toEqual(explainAttendanceDay(daily.calcTrace));

    const e = explainAttendanceDay(range.calcTrace);
    if (e.kind !== 'explained') throw new Error('expected an explained day');
    expect(e.overtime.minutes).toBe(range.otMinutes);
    // The split the panel lists is the split the OT columns print.
    expect(e.overtime.steps.filter((s) => s.key === 'otBucket').length).toBeGreaterThan(0);
  });

  it('a no-attendance day in the range carries a null trace rather than a stale neighbour’s', async () => {
    const a = adminCtx(b);
    const emp = await hireWithShift('Range Gap');
    await checkIn(a, { employmentId: emp, date: WORKDAY, time: '09:00' });
    await checkOut(a, { employmentId: emp, date: WORKDAY, time: '18:00' });

    const rows = await attendanceForEmploymentRange(a, emp, WORKDAY, NEXT_DAY);
    const gap = rows.find((r) => r.date === NEXT_DAY)!;
    expect(gap.attendanceId).toBeNull();
    expect(gap.calcTrace).toBeNull();
    expect(explainAttendanceDay(gap.calcTrace)).toEqual({ kind: 'unavailable', reason: 'no-trace' });
  });
});
