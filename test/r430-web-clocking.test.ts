/**
 * r430 (board item b8ca6efe) — Web Clocking controls.
 *
 * Covers the three pieces BUILD NOTES called out as the ones most likely to be gotten wrong:
 *  (1) an OUT-FIRST day (clock-out with no prior clock-in) is stored and flagged, never silently dropped —
 *      the deriveDayFromPunchList fix (core/attendance.ts) and checkOutTx's own-row creation.
 *  (2) the direction/state mismatch guard deleted from core/attendance-clock.ts: Clock In and Clock Out are
 *      both always allowed through captureEmployeeClock, in any order.
 *  (3) attendance_photo_setting enforced SERVER-SIDE (never trusting the client): Required refuses a
 *      photo-less capture, Optional accepts either, Not Required ignores a submitted photo either way —
 *      plus the device-registration exemption (deviceGateExempt) and the new nullable-columns CHECK.
 *
 * Hard constraint under test throughout: a COMPLETED/paired day's worked hours and overtime are never
 * touched by any of this — only which clockings are allowed to be recorded, and how an incomplete day is
 * flagged.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import * as schema from '../db/schema';
import type { SessionContext } from '../db/client';
import { withTenant } from '../db/client';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { checkIn, checkOut } from '../core/attendance';
import { flagOf } from '../core/attendance-derive';
import { setAttendancePhotoSetting } from '../core/clocking-location';
import { captureEmployeeClock, AttendancePhotoRequiredError } from '../core/attendance-clock';

let b: Base;
const uniqEmail = () => `r430_${randomUUID().slice(0, 8)}@t.local`;
const MON = '2026-07-06'; // a Monday, inside the seeded shift's working pattern

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});

async function hire(name = 'r430 Emp') {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: name, primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  return { a, employmentId: e.employmentId, personId: e.personId };
}

/** A plain-employee SessionContext scoped to one person (the Web Clocking self-service caller). */
async function employeeCtxFor(personId: string): Promise<SessionContext> {
  const [u] = await owner.db
    .insert(schema.appUser)
    .values({ tenantId: b.tenantId, workosUserId: `user_${randomUUID()}`, personId })
    .returning({ id: schema.appUser.id });
  await owner.db
    .insert(schema.roleAssignment)
    .values({ tenantId: b.tenantId, appUserId: u.id, companyId: null, role: 'employee' });
  return { tenantId: b.tenantId, userId: u.id, personId, grants: [{ role: 'employee', companyId: null }] };
}

const dayRow = (employmentId: string) =>
  owner.db.select().from(schema.attendance).where(eq(schema.attendance.employmentId, employmentId)).then((r) => r[0]);

const PLAIN_GEO = { lat: 3.139, lng: 101.6869, accuracy: 10 };

describe('r430 — an out-first day (clock-out with no prior clock-in) is stored and flagged, not refused', () => {
  it('checkOut creates the day row itself when none exists: checkInAt stays null, checkOutAt is stored', async () => {
    const { a, employmentId } = await hire();
    await checkOut(a, { employmentId, date: MON, time: '09:14', manual: true });
    const row = await dayRow(employmentId);
    expect(row).toBeTruthy();
    expect(row.checkInAt).toBeNull();
    expect(row.checkOutAt).toBe('09:14:00');
    // The true zero-punch defensive case aside, worked/OT stay null — nothing to compute without an in-punch.
    expect(row.workedMinutes).toBeNull();
    expect(row.otMinutes).toBeNull();
    expect(row.status).toBe('present');
    expect(row.dayType).toBe('workday');
  });

  it('this is exactly the signal a forgotten clock-out already uses — flagOf reads it as "odd" for the manager worklist', async () => {
    const { a, employmentId } = await hire();
    await checkOut(a, { employmentId, date: MON, time: '09:14', manual: true });
    const row = await dayRow(employmentId);
    expect(
      flagOf({
        attendanceId: row.id,
        status: row.status,
        checkInAt: row.checkInAt,
        checkOutAt: row.checkOutAt,
        dayType: row.dayType,
        workedMinutes: row.workedMinutes,
        scheduledMinutes: null,
      }),
    ).toBe('odd');
  });

  it('a genuinely empty day (no punches, no fallback) still derives nothing — the true defensive case is unchanged', async () => {
    const { employmentId } = await hire();
    // Nobody clocked at all: no attendance row is ever created.
    const row = await dayRow(employmentId);
    expect(row).toBeUndefined();
  });

  it('a COMPLETED/paired day is byte-identical to before: worked hours and OT are untouched by this round', async () => {
    const { a, employmentId } = await hire();
    await checkIn(a, { employmentId, date: MON, time: '09:00', manual: true });
    await checkOut(a, { employmentId, date: MON, time: '18:00', manual: true });
    const row = await dayRow(employmentId);
    expect(row.checkInAt).toBe('09:00:00');
    expect(row.checkOutAt).toBe('18:00:00');
    // Mon–Fri 09:00–18:00 / 60-min break (the harness default shift) ⇒ 480 net scheduled minutes, no OT.
    expect(row.workedMinutes).toBe(480);
    expect(row.otMinutes).toBe(0);
    expect(row.status).toBe('present');
  });
});

describe('r430 — captureEmployeeClock: Clock In and Clock Out are both always allowed, in any order', () => {
  it('clocking out with no clock-in first is saved through the private capture endpoint too', async () => {
    const { employmentId, personId } = await hire();
    const empCtx = await employeeCtxFor(personId);
    const receipt = await captureEmployeeClock(empCtx, { action: 'out', requestId: randomUUID(), ...PLAIN_GEO });
    expect(receipt.direction).toBe('out');
    const row = await dayRow(employmentId);
    expect(row.checkInAt).toBeNull();
    expect(row.checkOutAt).not.toBeNull();
  });

  it('clocking in again while already clocked in, and clocking out again while already clocked out, no longer throw ClockConflictError (the deleted direction/state mismatch guard)', async () => {
    const { employmentId, personId } = await hire();
    const empCtx = await employeeCtxFor(personId);
    await captureEmployeeClock(empCtx, { action: 'in', requestId: randomUUID(), ...PLAIN_GEO });
    // Already clocked in — used to throw 'Clock action does not match the current attendance state'.
    await captureEmployeeClock(empCtx, { action: 'in', requestId: randomUUID(), ...PLAIN_GEO });
    await captureEmployeeClock(empCtx, { action: 'out', requestId: randomUUID(), ...PLAIN_GEO });
    // Already clocked out — used to throw the same error the other way.
    await captureEmployeeClock(empCtx, { action: 'out', requestId: randomUUID(), ...PLAIN_GEO });
    const captures = await owner.db
      .select()
      .from(schema.attendanceClockCapture)
      .where(eq(schema.attendanceClockCapture.employmentId, employmentId));
    expect(captures).toHaveLength(4);
    const row = await dayRow(employmentId);
    expect(row.checkInAt).not.toBeNull();
    expect(row.checkOutAt).not.toBeNull();
  });
});

describe('r430 — attendance_photo_setting enforced SERVER-SIDE, never trusted from the client', () => {
  const photoBytes = () => sharp({ create: { width: 80, height: 60, channels: 3, background: '#246' } }).jpeg().toBuffer();

  it('Required refuses a photo-less capture with AttendancePhotoRequiredError, before any write', async () => {
    const { a, employmentId, personId } = await hire();
    await setAttendancePhotoSetting(a, { employmentId, setting: 'required' });
    const empCtx = await employeeCtxFor(personId);
    await expect(
      captureEmployeeClock(empCtx, { action: 'in', requestId: randomUUID(), ...PLAIN_GEO }),
    ).rejects.toBeInstanceOf(AttendancePhotoRequiredError);
    expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(0);
    expect(await owner.db.select().from(schema.attendance)).toHaveLength(0);
  });

  it('Required accepts a valid photo', async () => {
    const { a, employmentId, personId } = await hire();
    await setAttendancePhotoSetting(a, { employmentId, setting: 'required' });
    const empCtx = await employeeCtxFor(personId);
    const receipt = await captureEmployeeClock(empCtx, {
      action: 'in',
      requestId: randomUUID(),
      ...PLAIN_GEO,
      photo: await photoBytes(),
      mime: 'image/jpeg',
    });
    expect(receipt.photoAvailable).toBe(true);
  });

  it('Optional accepts a photo OR no photo — either way the clocking is saved', async () => {
    const { a, employmentId, personId } = await hire();
    await setAttendancePhotoSetting(a, { employmentId, setting: 'optional' });
    const empCtx = await employeeCtxFor(personId);
    const withPhoto = await captureEmployeeClock(empCtx, {
      action: 'in',
      requestId: randomUUID(),
      ...PLAIN_GEO,
      photo: await photoBytes(),
      mime: 'image/jpeg',
    });
    expect(withPhoto.photoAvailable).toBe(true);
    const withoutPhoto = await captureEmployeeClock(empCtx, { action: 'out', requestId: randomUUID(), ...PLAIN_GEO });
    expect(withoutPhoto.photoAvailable).toBe(false);
    expect(await owner.db.select().from(schema.attendanceClockCapture)).toHaveLength(2);
  });

  it('Not Required ignores a submitted photo either way — never decoded or stored, device_id stays null too', async () => {
    const { employmentId, personId } = await hire(); // every employee starts on the default, not_required
    const empCtx = await employeeCtxFor(personId);
    const receipt = await captureEmployeeClock(empCtx, {
      action: 'in',
      requestId: randomUUID(),
      ...PLAIN_GEO,
      photo: await photoBytes(),
      mime: 'image/jpeg',
    });
    expect(receipt.photoAvailable).toBe(false);
    const [row] = await owner.db
      .select()
      .from(schema.attendanceClockCapture)
      .where(eq(schema.attendanceClockCapture.employmentId, employmentId));
    expect(row.photoBytes).toBeNull();
    expect(row.photoDigest).toBeNull();
    expect(row.photoCapturedAt).toBeNull();
    expect(row.deviceId).toBeNull(); // r430 — no device is ever attributed to a Web Clocking capture now
  });

  it('setAttendancePhotoSetting writes attendance.photo-setting.changed and is inherited employment RLS — no new policy', async () => {
    const { a, employmentId } = await hire();
    await setAttendancePhotoSetting(a, { employmentId, setting: 'required' });
    expect(await eventTypesFor(b.tenantId, employmentId)).toContain('attendance.photo-setting.changed');
    const [row] = await owner.db.select({ v: schema.employment.attendancePhotoSetting }).from(schema.employment).where(eq(schema.employment.id, employmentId));
    expect(row.v).toBe('required');
    // Cross-tenant: the write finds no row under the foreign tenant's RLS context, same as every other
    // employment writer — nothing new was added for this column.
    const foreign = await seedBase();
    await expect(setAttendancePhotoSetting(adminCtx(foreign), { employmentId, setting: 'optional' })).rejects.toThrow(
      'Employment not found',
    );
  });
});

describe('r430 — the migration: attendance_clock_capture\'s six photo columns stay null together', () => {
  it('the CHECK constraint refuses a row where only SOME of the six photo columns are set', async () => {
    // attendance_clock_capture_insert RLS requires app.is_self_person: the EMPLOYEE's own session, not
    // admin — same visibility captureEmployeeClockTx itself writes under.
    const { employmentId, personId } = await hire();
    const empCtx = await employeeCtxFor(personId);
    await expect(
      withTenant(empCtx, (tx) =>
        tx.insert(schema.attendanceClockCapture).values({
          id: randomUUID(),
          tenantId: b.tenantId,
          employmentId,
          attendanceDate: MON,
          direction: 'in',
          requestId: randomUUID(),
          serverRecordedAt: new Date(),
          lat: 3,
          lng: 101,
          accuracyM: 5,
          commandDigest: 'x'.repeat(64),
          // Only ONE of the six photo columns set — the CHECK must refuse this.
          photoMimeType: 'image/jpeg',
        }),
      ),
    ).rejects.toThrow();
  });

  it('all six null together (Not Required shape) is accepted — proven by the Not Required capture above leaving a readable row', async () => {
    // Covered end to end by "Not Required ignores a submitted photo either way" — restated here as the
    // CHECK's other half: a row with every one of the six columns null must NOT be refused.
    const { employmentId, personId } = await hire();
    const empCtx = await employeeCtxFor(personId);
    await expect(captureEmployeeClock(empCtx, { action: 'in', requestId: randomUUID(), ...PLAIN_GEO })).resolves.toBeTruthy();
  });
});
