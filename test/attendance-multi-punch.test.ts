/**
 * R45 92bdf77a — Attendance Multiple Clocking & Overtime (Stage 1: capture + first-in/last-out summation).
 *
 * A person can now clock in/out more than once a day. Every punch is captured in attendance_punch; the day
 * aggregate's check_in_at / check_out_at / worked / OT are re-derived from the punches (earliest in → latest
 * out, minus the shift break). A day whose in/out punches don't balance (a single clocking, or a forgotten
 * clock-out) keeps check_out_at null so the read-time 'odd' flag surfaces it for review.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { attendancePunchesForRange, checkIn, checkOut } from '../core/attendance';
import { flagOf } from '../core/attendance-derive';

let b: Base;
const uniqEmail = () => `mp_${Math.random().toString(36).slice(2)}@t.local`;
const MON = '2026-07-06'; // a Monday — default Mon–Fri 09:00–18:00 / 60-min break policy ⇒ 540 scheduled

async function hire() {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Multi Punch', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  return { a, employmentId: e.employmentId };
}

const dayRow = (employmentId: string) =>
  owner.db
    .select()
    .from(schema.attendance)
    .where(eq(schema.attendance.employmentId, employmentId))
    .then((r) => r[0]);

const punchCount = (employmentId: string) =>
  owner.db
    .select()
    .from(schema.attendancePunch)
    .where(eq(schema.attendancePunch.employmentId, employmentId))
    .then((r) => r.length);

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

describe('R45 attendance multiple clocking', () => {
  it('captures a second clock-in instead of rejecting it (no more one-pair-per-day)', async () => {
    const { a, employmentId } = await hire();
    await checkIn(a, { employmentId, date: MON, time: '08:00:00' });
    // A second clock-in of the same day is now allowed (was: AlreadyCheckedInError).
    await expect(checkIn(a, { employmentId, date: MON, time: '13:00:00' })).resolves.toBeTruthy();
    expect(await punchCount(employmentId)).toBe(2); // two IN punches so far, one aggregate row
    const rows = await owner.db.select().from(schema.attendance).where(eq(schema.attendance.employmentId, employmentId));
    expect(rows).toHaveLength(1); // still exactly ONE aggregate row per day
  });

  it('sums worked/OT across TWO clock-in/out pairs via first-in / last-out', async () => {
    const { a, employmentId } = await hire();
    // in 08:00, out 12:00 (lunch), in 13:00, out 19:00. First-in=08:00, last-out=19:00 ⇒ span 660 − 60 break.
    await checkIn(a, { employmentId, date: MON, time: '08:00:00' });
    await checkOut(a, { employmentId, date: MON, time: '12:00:00' });
    await checkIn(a, { employmentId, date: MON, time: '13:00:00' });
    const res = await checkOut(a, { employmentId, date: MON, time: '19:00:00' });

    expect(await punchCount(employmentId)).toBe(4);
    const row = await dayRow(employmentId);
    expect(row.checkInAt).toBe('08:00:00'); // earliest in
    expect(row.checkOutAt).toBe('19:00:00'); // latest out
    expect(row.workedMinutes).toBe(600); // 660 span − 60 break
    expect(row.otMinutes).toBe(120); // 600 − 480 scheduled (09:00→18:00 = 540 span − 60 break)
    expect(res.workedMinutes).toBe(600);
    expect(res.otMinutes).toBe(120);

    // The full punch trail is available for the detail view, ordered first → last.
    const trail = (await attendancePunchesForRange(a, employmentId, MON, MON)).get(row.id)!;
    expect(trail.map((p) => `${p.punchAt.slice(0, 5)}:${p.direction}`)).toEqual([
      '08:00:in',
      '12:00:out',
      '13:00:in',
      '19:00:out',
    ]);
  });

  it('flags a single-clocking day for review (unbalanced ⇒ no silent miscount)', async () => {
    const { a, employmentId } = await hire();
    await checkIn(a, { employmentId, date: MON, time: '09:00:00' });
    const row = await dayRow(employmentId);
    expect(row.checkOutAt).toBeNull();
    expect(row.workedMinutes).toBeNull(); // never miscounted — left open for review
    // The read-time 'odd' flag surfaces the single clocking to manager/HR.
    expect(
      flagOf({
        attendanceId: row.id,
        status: row.status,
        checkInAt: row.checkInAt,
        checkOutAt: row.checkOutAt,
        dayType: row.dayType,
        workedMinutes: row.workedMinutes,
        scheduledMinutes: 480,
      }),
    ).toBe('odd');
  });

  it('re-opens the day when an extra clock-in follows a completed pair, then re-closes on the next clock-out', async () => {
    const { a, employmentId } = await hire();
    await checkIn(a, { employmentId, date: MON, time: '09:00:00' });
    await checkOut(a, { employmentId, date: MON, time: '17:00:00' }); // balanced ⇒ closed
    let row = await dayRow(employmentId);
    expect(row.checkOutAt).toBe('17:00:00');
    expect(row.workedMinutes).toBe(420); // 480 span − 60 break

    await checkIn(a, { employmentId, date: MON, time: '18:00:00' }); // now unbalanced (2 in, 1 out)
    row = await dayRow(employmentId);
    expect(row.checkOutAt).toBeNull(); // re-opened
    expect(row.workedMinutes).toBeNull();

    await checkOut(a, { employmentId, date: MON, time: '20:00:00' }); // balanced again (2 in, 2 out)
    row = await dayRow(employmentId);
    expect(row.checkInAt).toBe('09:00:00'); // still earliest in
    expect(row.checkOutAt).toBe('20:00:00'); // latest out
    expect(row.workedMinutes).toBe(600); // 09:00→20:00 = 660 span − 60 break

    // Both punch pairs each logged their day-level domain event.
    const types = await eventTypesFor(b.tenantId, row.id);
    expect(types).toContain('attendance.checked-in');
    expect(types).toContain('attendance.checked-out');
  });

  it('rejects a clock-in earlier than a punch already recorded that day', async () => {
    const { a, employmentId } = await hire();
    await checkIn(a, { employmentId, date: MON, time: '10:00:00' });
    await expect(checkIn(a, { employmentId, date: MON, time: '09:00:00' })).rejects.toThrow(/later than the previous/);
  });
});
