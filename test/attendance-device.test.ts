/**
 * Feedback 5249d43f — Employee Clock in/out web portal: device registration + the registered-device gate.
 *
 * Covers: register/revoke round-trip with its audit events; the policy switch round-trip
 * (attendance_policy.require_registered_device via set/listAttendancePolicies); checkIn with the policy
 * OFF needing no token (regression for every existing flow); policy ON with a valid / absent / revoked /
 * other-employment token; the ordering refusal unchanged under the gate; a full multi-punch day (lunch
 * pair) with the gate ON reaching the same aggregate the ungated engine derives; the terminal-import
 * exemption; and RLS (self-service insert for own employment, no cross-employee writes).
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { checkIn, checkOut, listAttendancePolicies, setAttendancePolicy } from '../core/attendance';
import { importPunchCsv } from './helpers/punch-import';
import {
  DeviceNotRegisteredError,
  deviceGateRequired,
  enforceDeviceGateTx,
  listMyDevices,
  listRegisteredDevices,
  registerDevice,
  revokeDevice,
} from '../core/attendance-device';
import { type SessionContext } from '../db/client';

let b: Base;
const uniqEmail = () => `dev_${randomUUID().slice(0, 8)}@t.local`;
const MON = '2026-07-06'; // a Monday — default Mon–Fri 09:00–18:00 / 60-min break ⇒ 480 net scheduled

const POLICY_BASE = (companyId: string) => ({
  companyId,
  workStart: '09:00',
  workEnd: '18:00',
  breakMinutes: 60,
  lateAfter: '09:15',
  halfDayBefore: '13:00',
  workingDays: [1, 2, 3, 4, 5],
});

async function hire(name = 'Device Emp') {
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

/** Flip the company's require_registered_device switch through the real service. */
const setRequireDevice = (a: SessionContext, on: boolean) =>
  setAttendancePolicy(a, { ...POLICY_BASE(b.companyId), requireRegisteredDevice: on });

/** A plain-employee SessionContext scoped to one person (self-service + RLS checks). */
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
  owner.db
    .select()
    .from(schema.attendance)
    .where(eq(schema.attendance.employmentId, employmentId))
    .then((r) => r[0]);

const deviceRow = (deviceId: string) =>
  owner.db
    .select()
    .from(schema.employeeDevice)
    .where(eq(schema.employeeDevice.id, deviceId))
    .then((r) => r[0]);

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

describe('device registration round-trip (5249d43f)', () => {
  it('registers a device (server-minted token), lists it, and appends attendance.device.registered', async () => {
    const { a, employmentId } = await hire();
    const { deviceId, deviceToken } = await registerDevice(a, { employmentId, label: '  Chrome   on MacBook ' });
    expect(deviceToken).toMatch(/^[0-9a-f-]{36}$/i);

    const row = await deviceRow(deviceId);
    expect(row.label).toBe('Chrome on MacBook'); // whitespace collapsed
    expect(row.revokedAt).toBeNull();
    expect(row.lastUsedAt).toBeNull();

    const mine = await listMyDevices(a, employmentId);
    expect(mine.map((d) => d.id)).toContain(deviceId);

    const types = await eventTypesFor(b.tenantId, deviceId);
    expect(types).toContain('attendance.device.registered');
    // The bearer token must never leak into the audit payload.
    const [ev] = await owner.db
      .select()
      .from(schema.domainEvent)
      .where(and(eq(schema.domainEvent.aggregateId, deviceId), eq(schema.domainEvent.eventType, 'attendance.device.registered')));
    expect(JSON.stringify(ev.payload)).not.toContain(deviceToken);
  });

  it('revoke marks the row, drops it from the lists, appends the event, and is idempotent', async () => {
    const { a, employmentId } = await hire();
    const { deviceId } = await registerDevice(a, { employmentId, label: 'Old phone' });
    await revokeDevice(a, { deviceId });
    const row = await deviceRow(deviceId);
    expect(row.revokedAt).not.toBeNull();
    expect((await listMyDevices(a, employmentId)).map((d) => d.id)).not.toContain(deviceId);
    expect((await listRegisteredDevices(a, [b.companyId])).map((d) => d.id)).not.toContain(deviceId);
    expect(await eventTypesFor(b.tenantId, deviceId)).toContain('attendance.device.revoked');

    // Idempotent second revoke: no throw, no second event.
    await revokeDevice(a, { deviceId });
    const evs = await eventTypesFor(b.tenantId, deviceId);
    expect(evs.filter((t) => t === 'attendance.device.revoked')).toHaveLength(1);
  });

  it('rejects a blank device label', async () => {
    const { a, employmentId } = await hire();
    await expect(registerDevice(a, { employmentId, label: '   ' })).rejects.toThrow(/name is required/);
  });

  it('policy switch round-trips through set/listAttendancePolicies (default off)', async () => {
    const a = adminCtx(b);
    await setAttendancePolicy(a, POLICY_BASE(b.companyId));
    let [pol] = await listAttendancePolicies(a, [b.companyId]);
    expect(pol.requireRegisteredDevice).toBe(false); // absent ⇒ shipping default OFF

    await setRequireDevice(a, true);
    [pol] = await listAttendancePolicies(a, [b.companyId]);
    expect(pol.requireRegisteredDevice).toBe(true);

    const { employmentId } = await hire();
    expect(await deviceGateRequired(a, employmentId)).toBe(true);
  });
});

describe('registered-device gate on checkIn/checkOut (5249d43f)', () => {
  it('policy OFF: no token needed — the pre-existing clock flow is untouched (regression)', async () => {
    const { a, employmentId } = await hire();
    await checkIn(a, { employmentId, date: MON, time: '09:00' });
    await checkOut(a, { employmentId, date: MON, time: '18:00' });
    const row = await dayRow(employmentId);
    expect(row.checkInAt).toBe('09:00:00');
    expect(row.checkOutAt).toBe('18:00:00');
    expect(row.workedMinutes).toBe(480);
  });

  it('policy ON + no token: DeviceNotRegisteredError, NO row written', async () => {
    const { a, employmentId } = await hire();
    await setRequireDevice(a, true);
    await expect(checkIn(a, { employmentId, date: MON, time: '09:00' })).rejects.toBeInstanceOf(
      DeviceNotRegisteredError,
    );
    expect(await dayRow(employmentId)).toBeUndefined();
  });

  it('policy ON + valid token: punch recorded, last_used_at touched', async () => {
    const { a, employmentId } = await hire();
    await setRequireDevice(a, true);
    const { deviceId, deviceToken } = await registerDevice(a, { employmentId, label: 'Laptop' });
    await checkIn(a, { employmentId, date: MON, time: '09:00', deviceToken });
    const row = await dayRow(employmentId);
    expect(row.checkInAt).toBe('09:00:00');
    expect((await deviceRow(deviceId)).lastUsedAt).not.toBeNull();
  });

  it('policy ON + revoked token: blocked (per-device restriction survives revocation)', async () => {
    const { a, employmentId } = await hire();
    await setRequireDevice(a, true);
    const { deviceId, deviceToken } = await registerDevice(a, { employmentId, label: 'Lost phone' });
    await revokeDevice(a, { deviceId });
    await expect(checkIn(a, { employmentId, date: MON, time: '09:00', deviceToken })).rejects.toBeInstanceOf(
      DeviceNotRegisteredError,
    );
    expect(await dayRow(employmentId)).toBeUndefined();
  });

  it("policy ON + a COLLEAGUE's token: blocked — the restriction is per device per employee", async () => {
    const { a, employmentId } = await hire('Emp One');
    const other = await hire('Emp Two');
    await setRequireDevice(a, true);
    const { deviceToken } = await registerDevice(a, { employmentId: other.employmentId, label: 'Two Laptop' });
    await expect(checkIn(a, { employmentId, date: MON, time: '09:00', deviceToken })).rejects.toBeInstanceOf(
      DeviceNotRegisteredError,
    );
  });

  it('policy ON + malformed token: typed error, not a raw uuid-cast failure', async () => {
    const { a, employmentId } = await hire();
    await setRequireDevice(a, true);
    await expect(
      checkIn(a, { employmentId, date: MON, time: '09:00', deviceToken: 'not-a-uuid' }),
    ).rejects.toBeInstanceOf(DeviceNotRegisteredError);
  });

  it('gate ON: check-out is gated too, and the ordering refusal is unchanged under the gate', async () => {
    const { a, employmentId } = await hire();
    await setRequireDevice(a, true);
    const { deviceToken } = await registerDevice(a, { employmentId, label: 'Laptop' });
    await checkIn(a, { employmentId, date: MON, time: '09:00', deviceToken });
    // Check-out without a token is refused by the gate (same rule as check-in).
    await expect(checkOut(a, { employmentId, date: MON, time: '18:00' })).rejects.toBeInstanceOf(
      DeviceNotRegisteredError,
    );
    // The engine's non-later-clocking refusal still applies WITH a valid token (regression).
    await expect(checkIn(a, { employmentId, date: MON, time: '08:00', deviceToken })).rejects.toThrow(
      /later than the previous/,
    );
  });

  it('full lunch-pair day with the gate ON: aggregate recompute identical to the ungated engine', async () => {
    const { a, employmentId } = await hire();
    await setRequireDevice(a, true);
    const { deviceToken } = await registerDevice(a, { employmentId, label: 'Laptop' });
    await checkIn(a, { employmentId, date: MON, time: '08:00', deviceToken });
    await checkOut(a, { employmentId, date: MON, time: '12:00', deviceToken });
    await checkIn(a, { employmentId, date: MON, time: '13:00', deviceToken });
    await checkOut(a, { employmentId, date: MON, time: '19:00', deviceToken });
    const row = await dayRow(employmentId);
    expect(row.checkInAt).toBe('08:00:00'); // earliest in
    expect(row.checkOutAt).toBe('19:00:00'); // latest out
    expect(row.workedMinutes).toBe(600); // 660 span − 60 break — same figures as attendance-multi-punch
    expect(row.otMinutes).toBe(120);
  });

  it('terminal import stays exempt while the policy is ON (documented bypass, like geofencing)', async () => {
    const a = adminCtx(b);
    await setRequireDevice(a, true);
    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName: 'Import Emp', primaryEmail: uniqEmail() })
      .returning({ id: schema.person.id });
    const [emp] = await owner.db
      .insert(schema.employment)
      .values({ tenantId: b.tenantId, personId: p.id, companyId: b.companyId, hiredOn: '2024-01-01', employeeCode: 'DEV1' })
      .returning({ id: schema.employment.id });
    const csv = 'Staff ID,Timestamp\nDEV1,2026-07-06 09:00:00\nDEV1,2026-07-06 18:00:00';
    const result = await importPunchCsv(a, csv);
    expect(result.imported).toBe(1);
    const row = await dayRow(emp.id);
    expect(row.checkInMethod).toBe('import');
  });

  it('enforceDeviceGateTx is a no-op when the company has no saved policy row (engine default OFF)', async () => {
    const { employmentId } = await hire();
    // No attendance_policy row exists for the company at all — the gate must not block.
    await owner.db.transaction(async (tx) => {
      await expect(enforceDeviceGateTx(tx, { employmentId })).resolves.toBeUndefined();
    });
  });
});

describe('employee_device RLS (per-person pattern)', () => {
  it('the subject employee registers + revokes their OWN device (self-service)', async () => {
    const { a, employmentId, personId } = await hire();
    const empCtx = await employeeCtxFor(personId);
    const { deviceId, deviceToken } = await registerDevice(empCtx, { employmentId, label: 'My phone' });
    expect(deviceToken).toBeTruthy();
    expect((await listMyDevices(empCtx, employmentId)).map((d) => d.id)).toContain(deviceId);
    await revokeDevice(empCtx, { deviceId });
    expect((await listMyDevices(empCtx, employmentId)).map((d) => d.id)).not.toContain(deviceId);
    expect(a).toBeTruthy();
  });

  it("a plain employee cannot register a device against a COLLEAGUE's employment", async () => {
    const { personId } = await hire('Emp One');
    const other = await hire('Emp Two');
    const empCtx = await employeeCtxFor(personId);
    await expect(
      registerDevice(empCtx, { employmentId: other.employmentId, label: 'Sneaky' }),
    ).rejects.toThrow();
  });

  it("a plain employee cannot see or revoke a COLLEAGUE's devices", async () => {
    const { a, personId } = await hire('Emp One');
    const other = await hire('Emp Two');
    const { deviceId } = await registerDevice(a, { employmentId: other.employmentId, label: 'Two phone' });
    const empCtx = await employeeCtxFor(personId);
    expect((await listMyDevices(empCtx, other.employmentId)).length).toBe(0); // RLS filters the rows
    // Revoke resolves the row under RLS first — invisible row reads as "not found".
    await expect(revokeDevice(empCtx, { deviceId })).rejects.toThrow(/not found/);
    const row = await deviceRow(deviceId);
    expect(row.revokedAt).toBeNull(); // untouched
  });

  it('the admin device list is company-scoped and joins employee identity', async () => {
    const { a, employmentId } = await hire('List Emp');
    await registerDevice(a, { employmentId, label: 'Work laptop' });
    const rows = await listRegisteredDevices(a, [b.companyId]);
    const mine = rows.find((r) => r.employmentId === employmentId);
    expect(mine).toBeDefined();
    expect(mine!.employee).toBe('List Emp');
    expect(mine!.label).toBe('Work laptop');
    expect(mine!.companyId).toBe(b.companyId);
    expect(await listRegisteredDevices(a, [])).toEqual([]);
  });
});
