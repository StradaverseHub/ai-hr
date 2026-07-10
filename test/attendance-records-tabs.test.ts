/**
 * Attendance > Records tabs, Phase 1 (feedback 314ea061). The tab reorg is presentation-only, but it
 * relies on two read-layer additions that this test pins:
 *
 *  • attendanceForEmploymentRange — the Individual tab's per-employee date-range read. One row per calendar
 *    day in [from, to]: an attendance row when present, else the context (approved full-day leave > public
 *    holiday > rest day) that explains a no-attendance day — the range analogue of attendanceForDate.
 *  • attendanceForDate({ departmentId }) — the Daily tab's Department filter narrows to a single department
 *    via the employee's CURRENT assignment; absent = every department (unchanged behaviour).
 *
 * Both are read-only (no DomainEvent — the reorg persists nothing new).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { checkIn, checkOut, attendanceForDate, attendanceForEmploymentRange } from '../core/attendance';

let b: Base;
const uniqEmail = () => `atttabs_${Math.random().toString(36).slice(2)}@t.local`;

const WORKDAY = '2026-07-01'; // Wednesday
const ABSENT_WORKDAY = '2026-07-02'; // Thursday, no attendance
const REST_DAY = '2026-07-04'; // Saturday (default Mon–Fri schedule → rest day)

async function hire(departmentId: string, fullName: string) {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName, primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  return e.employmentId;
}

beforeAll(async () => {
  await migrateTestDb();
  await resetDb();
  b = await seedBase();
}, 120_000);

afterAll(closeAll);

describe('attendanceForEmploymentRange (Individual tab)', () => {
  it('returns one row per calendar day with attendance / context resolved', async () => {
    const a = adminCtx(b);
    const emp = await hire(b.deptA, 'Range Worker');
    await checkIn(a, { employmentId: emp, date: WORKDAY, time: '09:00' });
    await checkOut(a, { employmentId: emp, date: WORKDAY, time: '18:00' });

    const rows = await attendanceForEmploymentRange(a, emp, WORKDAY, REST_DAY);
    // 2026-07-01 … 2026-07-04 inclusive = 4 days, in ascending order.
    expect(rows.map((r) => r.date)).toEqual([WORKDAY, ABSENT_WORKDAY, '2026-07-03', REST_DAY]);

    const worked = rows.find((r) => r.date === WORKDAY)!;
    expect(worked.attendanceId).not.toBeNull();
    expect(worked.checkInAt?.slice(0, 5)).toBe('09:00');
    expect(worked.context).toBeNull(); // has a row → no explanatory context

    const absent = rows.find((r) => r.date === ABSENT_WORKDAY)!;
    expect(absent.attendanceId).toBeNull();
    expect(absent.context).toBeNull(); // a plain no-show workday: absent, no leave/holiday/rest context

    const rest = rows.find((r) => r.date === REST_DAY)!;
    expect(rest.attendanceId).toBeNull();
    expect(rest.context).toBe('rest_day'); // Saturday under the default Mon–Fri schedule
  });

  it('returns [] for an out-of-order range', async () => {
    const a = adminCtx(b);
    const emp = await hire(b.deptA, 'Reversed Range');
    expect(await attendanceForEmploymentRange(a, emp, REST_DAY, WORKDAY)).toEqual([]);
  });
});

describe('attendanceForDate department filter (Daily tab)', () => {
  it('narrows to the requested department; absent = all departments', async () => {
    const a = adminCtx(b);
    const inA = await hire(b.deptA, 'Dept A Worker');
    const inB = await hire(b.deptB, 'Dept B Worker');

    const filtered = await attendanceForDate(a, WORKDAY, [b.companyId], { departmentId: b.deptA });
    const filteredIds = filtered.map((r) => r.employmentId);
    expect(filteredIds).toContain(inA);
    expect(filteredIds).not.toContain(inB);

    const unfiltered = await attendanceForDate(a, WORKDAY, [b.companyId]);
    const allIds = unfiltered.map((r) => r.employmentId);
    expect(allIds).toContain(inA);
    expect(allIds).toContain(inB); // no filter → both departments visible
  });
});
