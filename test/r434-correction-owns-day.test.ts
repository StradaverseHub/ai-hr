/**
 * r434 — an approved correction OWNS the day: no later clocking, from any path, recomputes it.
 *
 * Found in r430's follow-up: decideAttendanceCorrection upserts the day aggregate and never writes
 * attendance_punch, and checkInTx/checkOutTx rebuild the aggregate from punches. The Web Clocking path
 * (captureEmployeeClockTx) and the file import already refuse a corrected day; the shared writers did not,
 * so the administrator's manual check-in/check-out (checkIn/checkOut with manual:true) could silently undo
 * an approved correction. These tests pin that every writer refuses, and that the day is left untouched.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { checkIn, checkOut, requestAttendanceCorrection, decideAttendanceCorrection } from '../core/attendance';
import { CorrectedClockConflictError } from '../core/attendance-clock';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const DATE = '2026-07-27';
const uniqEmail = () => `r434_${Math.random().toString(36).slice(2, 10)}@t.local`;

async function hire(name: string) {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  return e.employmentId;
}
const dayRow = (employmentId: string) =>
  owner.db
    .select()
    .from(schema.attendance)
    .where(eq(schema.attendance.employmentId, employmentId))
    .then((r) => r.find((x) => x.attendanceDate === DATE));
const punchCount = (employmentId: string) =>
  owner.db
    .select()
    .from(schema.attendancePunch)
    .where(eq(schema.attendancePunch.employmentId, employmentId))
    .then((r) => r.length);

/** A day with stored punches (08:02 / 17:00), then an APPROVED correction to 09:00 / 18:00. */
async function correctedDay(name: string) {
  const a = adminCtx(b);
  const employmentId = await hire(name);
  await checkIn(a, { employmentId, date: DATE, time: '08:02', manual: true });
  await checkOut(a, { employmentId, date: DATE, time: '17:00', manual: true });
  const { correctionId } = await requestAttendanceCorrection(a, {
    employmentId, date: DATE, checkIn: '09:00', checkOut: '18:00', reason: 'gate log shows 09:00 to 18:00',
  });
  await decideAttendanceCorrection(a, { correctionId, decision: 'approved' });
  return { a, employmentId };
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
});

describe('r434 — an approved correction owns the day', () => {
  it('baseline: the correction set the day to 09:00 to 18:00', async () => {
    const { employmentId } = await correctedDay('Baseline Bea');
    const row = await dayRow(employmentId);
    expect(row?.checkInAt?.slice(0, 5)).toBe('09:00');
    expect(row?.checkOutAt?.slice(0, 5)).toBe('18:00');
  });

  it('a manual check-in on a corrected day is refused and the day is untouched', async () => {
    const { a, employmentId } = await correctedDay('Manual In Ivan');
    const punches = await punchCount(employmentId);
    await expect(checkIn(a, { employmentId, date: DATE, time: '07:30', manual: true })).rejects.toBeInstanceOf(
      CorrectedClockConflictError,
    );
    const row = await dayRow(employmentId);
    expect(row?.checkInAt?.slice(0, 5), 'the correction still stands').toBe('09:00');
    expect(row?.checkOutAt?.slice(0, 5)).toBe('18:00');
    expect(await punchCount(employmentId), 'no punch was written').toBe(punches);
  });

  it('a manual check-out on a corrected day is refused and the day is untouched', async () => {
    const { a, employmentId } = await correctedDay('Manual Out Olu');
    const punches = await punchCount(employmentId);
    await expect(checkOut(a, { employmentId, date: DATE, time: '21:00', manual: true })).rejects.toBeInstanceOf(
      CorrectedClockConflictError,
    );
    const row = await dayRow(employmentId);
    expect(row?.checkOutAt?.slice(0, 5), 'the correction still stands').toBe('18:00');
    expect(await punchCount(employmentId)).toBe(punches);
  });

  it('a day with NO correction still accepts manual clockings (the guard is not blanket)', async () => {
    const a = adminCtx(b);
    const employmentId = await hire('Free Fay');
    await checkIn(a, { employmentId, date: DATE, time: '08:30', manual: true });
    await checkOut(a, { employmentId, date: DATE, time: '17:30', manual: true });
    const row = await dayRow(employmentId);
    expect(row?.checkInAt?.slice(0, 5)).toBe('08:30');
    expect(row?.checkOutAt?.slice(0, 5)).toBe('17:30');
  });

  it('a correction on a DIFFERENT date does not lock this one', async () => {
    const { a, employmentId } = await correctedDay('Other Day Odi');
    await checkIn(a, { employmentId, date: '2026-07-28', time: '08:00', manual: true });
    const [other] = await owner.db
      .select()
      .from(schema.attendance)
      .where(eq(schema.attendance.employmentId, employmentId))
      .then((r) => r.filter((x) => x.attendanceDate === '2026-07-28'));
    expect(other?.checkInAt?.slice(0, 5)).toBe('08:00');
  });
});
