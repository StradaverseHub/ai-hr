/**
 * Employee clocking-device registration (feedback 5249d43f) — the "registered device" gate for web
 * clock-in/out.
 *
 * Each employee self-registers the browsers/devices they clock from (one tap on the Clock in/out page).
 * Registration mints a random UUID token SERVER-side, hands it back exactly once, and the client stores it
 * (localStorage — see lib/device-token.ts). Every web punch then presents the token; when the employee's
 * company policy has `require_registered_device` ON, checkIn/checkOut (core/attendance.ts) call
 * `enforceDeviceGateTx` and an absent / unknown / revoked / other-employment token throws the typed
 * DeviceNotRegisteredError BEFORE any row is written. Policy OFF (the shipping default) skips the gate
 * entirely — a regression-free rollout, flipped per company from the Attendance policy screen.
 *
 * Terminal imports (method='import') never pass through checkIn/checkOut, so they are exempt by
 * construction — the same disclosed bypass as the geofence exemption (ADR-0070, core/attendance.ts:2308).
 *
 * Substrate (ADR-0006): register/revoke append attendance.device.registered / .revoked. The gate's
 * `last_used_at` touch is high-volume bookkeeping that rolls up into the day-level attendance.checked-in/
 * -out events (the CLAUDE.md documented skip for per-item writes with their own trail).
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { withTenant, type SessionContext, type Tx } from '../db/client';
import { actorOf, appendEvent } from '../db/events';
import { attendancePolicy, employeeDevice, employment, person } from '../db/schema';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LABEL_LEN = 80;

/** Thrown when the company policy requires a registered device and this punch presented no valid token.
 *  Client-side precondition — nothing happened in the domain, so no event is appended for it (the same
 *  contract as GeolocationRequiredError, ADR-0070 §5). */
export class DeviceNotRegisteredError extends Error {
  constructor() {
    super(
      'This device is not registered for clocking. Register it on the Clock in/out page, then try again.',
    );
    this.name = 'DeviceNotRegisteredError';
  }
}

function cleanLabel(v: string | undefined): string {
  const s = (v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) throw new Error('Device name is required');
  return s.slice(0, MAX_LABEL_LEN);
}

/**
 * Register a device for one employment. Self-service by design: the subject employee registers their own
 * browser/phone (RLS WITH CHECK via can_see_employment's self branch); an admin may also register on
 * behalf. The token is returned EXACTLY once — it is never re-readable from any list (bearer secret), and
 * it is deliberately kept OUT of the event payload.
 */
export async function registerDevice(
  ctx: SessionContext,
  p: { employmentId: string; label: string },
): Promise<{ deviceId: string; deviceToken: string }> {
  const label = cleanLabel(p.label);
  const deviceToken = randomUUID();
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .insert(employeeDevice)
      .values({ tenantId: ctx.tenantId, employmentId: p.employmentId, label, deviceToken })
      .returning({ id: employeeDevice.id });
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-device',
      aggregateId: row.id,
      eventType: 'attendance.device.registered',
      actor: actorOf(ctx),
      subjectEmploymentId: p.employmentId,
      payload: { employmentId: p.employmentId, label }, // never the token — it is a bearer secret
    });
    return { deviceId: row.id, deviceToken };
  });
}

/** Revoke one device (soft mark — the row and its events stay auditable). Idempotent: revoking an
 *  already-revoked device is a no-op. Admins revoke from the Attendance policy screen; the subject
 *  employee may also revoke their own (lost-phone self-service). */
export async function revokeDevice(ctx: SessionContext, p: { deviceId: string }) {
  return withTenant(ctx, async (tx) => {
    const [row] = await tx
      .select({
        employmentId: employeeDevice.employmentId,
        label: employeeDevice.label,
        revokedAt: employeeDevice.revokedAt,
      })
      .from(employeeDevice)
      .where(eq(employeeDevice.id, p.deviceId))
      .limit(1);
    if (!row) throw new Error('Device not found');
    if (row.revokedAt) return { deviceId: p.deviceId };
    await tx.update(employeeDevice).set({ revokedAt: new Date() }).where(eq(employeeDevice.id, p.deviceId));
    await appendEvent(tx, {
      tenantId: ctx.tenantId,
      aggregateType: 'employee-device',
      aggregateId: p.deviceId,
      eventType: 'attendance.device.revoked',
      actor: actorOf(ctx),
      subjectEmploymentId: row.employmentId,
      payload: { employmentId: row.employmentId, label: row.label },
    });
    return { deviceId: p.deviceId };
  });
}

export type MyDeviceView = {
  id: string;
  label: string;
  registeredAt: Date;
  lastUsedAt: Date | null;
};

/** The ACTIVE (unrevoked) devices of one employment — the Clock in/out page's "this employee has n
 *  registered devices" read. RLS scopes to self/manager/admin. Read-only, no DomainEvent. */
export function listMyDevices(ctx: SessionContext, employmentId: string): Promise<MyDeviceView[]> {
  return withTenant(ctx, (tx) =>
    tx
      .select({
        id: employeeDevice.id,
        label: employeeDevice.label,
        registeredAt: employeeDevice.registeredAt,
        lastUsedAt: employeeDevice.lastUsedAt,
      })
      .from(employeeDevice)
      .where(and(eq(employeeDevice.employmentId, employmentId), isNull(employeeDevice.revokedAt)))
      .orderBy(desc(employeeDevice.registeredAt)),
  );
}

export type RegisteredDeviceRow = MyDeviceView & {
  employmentId: string;
  employee: string;
  employeeCode: string | null;
  companyId: string;
};

/** Every ACTIVE registered device across the given companies, for the admin list on the Attendance policy
 *  screen (revoke lives next to each row). Read-only, no DomainEvent. */
export function listRegisteredDevices(
  ctx: SessionContext,
  companyIds: string[],
): Promise<RegisteredDeviceRow[]> {
  return withTenant(ctx, async (tx) => {
    if (companyIds.length === 0) return [];
    return tx
      .select({
        id: employeeDevice.id,
        label: employeeDevice.label,
        registeredAt: employeeDevice.registeredAt,
        lastUsedAt: employeeDevice.lastUsedAt,
        employmentId: employeeDevice.employmentId,
        employee: person.fullName,
        employeeCode: employment.employeeCode,
        companyId: employment.companyId,
      })
      .from(employeeDevice)
      .innerJoin(employment, eq(employment.id, employeeDevice.employmentId))
      .innerJoin(person, eq(person.id, employment.personId))
      .where(and(inArray(employment.companyId, companyIds), isNull(employeeDevice.revokedAt)))
      .orderBy(person.fullName, desc(employeeDevice.registeredAt));
  });
}

async function requireRegisteredDeviceTx(tx: Tx, employmentId: string): Promise<boolean> {
  const [row] = await tx
    .select({ required: attendancePolicy.requireRegisteredDevice })
    .from(employment)
    .leftJoin(attendancePolicy, eq(attendancePolicy.companyId, employment.companyId))
    .where(eq(employment.id, employmentId))
    .limit(1);
  return row?.required ?? false; // no saved policy row ⇒ engine default: OFF
}

/** Whether this employment's company policy requires a registered device for web clocking — the Clock
 *  in/out page's RSC read (decides whether to surface the register-first block). Read-only. */
export function deviceGateRequired(ctx: SessionContext, employmentId: string): Promise<boolean> {
  return withTenant(ctx, (tx) => requireRegisteredDeviceTx(tx, employmentId));
}

/**
 * The enforcement gate — called INSIDE checkInTx/checkOutTx (core/attendance.ts) before any write, so a
 * blocked punch rolls the whole transaction back (no row, no event — mirroring GeolocationRequiredError).
 * Policy OFF ⇒ no-op (the hot path stays lean, like resolveGeofence's OFF branch). Policy ON ⇒ the token
 * must match an UNREVOKED device row of the SAME employment (per-device, per-employee — a token registered
 * to a colleague's employment never passes). A valid punch touches last_used_at.
 */
export async function enforceDeviceGateTx(
  tx: Tx,
  p: { employmentId: string; deviceToken?: string },
): Promise<void> {
  const required = await requireRegisteredDeviceTx(tx, p.employmentId);
  if (!required) return;
  const token = (p.deviceToken ?? '').trim();
  // Reject malformed tokens BEFORE the query — an arbitrary string would fail the uuid-column cast with a
  // raw Postgres error instead of the typed, translatable DeviceNotRegisteredError.
  if (!UUID_RE.test(token)) throw new DeviceNotRegisteredError();
  const [dev] = await tx
    .select({ id: employeeDevice.id })
    .from(employeeDevice)
    .where(
      and(
        eq(employeeDevice.employmentId, p.employmentId),
        eq(employeeDevice.deviceToken, token),
        isNull(employeeDevice.revokedAt),
      ),
    )
    .limit(1);
  if (!dev) throw new DeviceNotRegisteredError();
  await tx.update(employeeDevice).set({ lastUsedAt: new Date() }).where(eq(employeeDevice.id, dev.id));
}
