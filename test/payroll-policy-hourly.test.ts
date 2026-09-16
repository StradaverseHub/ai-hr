/**
 * 2.1.3 Hourly Payroll Policy — the in-scope surface only (per the approved plan):
 *  - payableHoursForCycle(): the ONE genuinely-new behaviour. ON clamps each day's worked minutes to the
 *    rostered shift's scheduled minutes (OT excluded); OFF returns the unclamped worked total; a day with no
 *    rostered shift → 0 when ON; a rostered rest day → 0 when ON; a cross-midnight shift clamps per start-date
 *    row against that shift's span.
 *  - hourly config validation through the shared service: a per_hour rule (with/without the toggle) is accepted;
 *    the shift toggle is rejected on a non-per_hour (per_day) rule; the per-hour rate is range-validated.
 *  - CRUD/copy via the shared service: create/edit/copy/activate/deactivate/delete an hourly policy emits the
 *    existing payroll-policy.* events with policyType 'hourly'; COPY carries the pay_rule (incl. toggle) verbatim.
 *  - resolveAssignedPolicy returns the assigned ACTIVE hourly policy (the only resolution that exists — a single
 *    FK, no priority machinery).
 *  - RLS: one thin regression that an hourly row obeys the existing 0128 policy (tenant-wide read, admin write).
 *
 * NOT covered here (owned elsewhere): the live end-to-end hourly payslip compute (deferred follow-up, gated on
 * the rate-storage decision) — so there is NO generatePayslips assertion for an hourly worker in this slice.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import { hireEmployee } from '../core/org';
import { payableHoursForCycle } from '../core/attendance';
import {
  assignPolicy,
  copyPolicy,
  createPolicy,
  deletePolicy,
  DuplicatePolicyNameError,
  getPolicy,
  resolveAssignedPolicy,
  setStatus,
  updatePolicy,
} from '../core/payroll-policy';
import {
  adminCtx,
  closeAll,
  createAppUser,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
  harnessSnapshot,
} from './harness';

let b: Base;

const hire = (name: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: name, primaryEmail: `ph_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });

/** Seed a reusable company shift (owner bypasses RLS, mirroring the harness seed pattern). */
async function seedShift(p: {
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes?: number;
  crossesMidnight?: boolean;
}): Promise<string> {
  const [s] = await owner.db
    .insert(schema.shift)
    .values({
      tenantId: b.tenantId,
      companyId: b.companyId,
      name: p.name,
      startTime: p.startTime,
      endTime: p.endTime,
      breakMinutes: p.breakMinutes ?? 0,
      crossesMidnight: p.crossesMidnight ?? false,
    })
    .returning({ id: schema.shift.id });
  return s.id;
}

/** Roster one (employment, date) onto a shift OR mark it a rest day (shift-xor-rest DB invariant). */
async function roster(p: { employmentId: string; date: string; shiftId?: string; isRestDay?: boolean }) {
  await owner.db.insert(schema.rosterAssignment).values({
    tenantId: b.tenantId,
    employmentId: p.employmentId,
    shiftDate: p.date,
    shiftId: p.shiftId ?? null,
    isRestDay: p.isRestDay ?? false,
  });
}

/** Seed an attendance row directly (worked minutes are the only field the clamp reads). */
async function att(p: {
  employmentId: string;
  date: string;
  checkInAt: string;
  checkOutAt: string;
  workedMinutes: number;
  otMinutes?: number;
  dayType?: 'workday' | 'rest_day' | 'holiday';
}) {
  await owner.db.insert(schema.attendance).values({
    tenantId: b.tenantId,
    employmentId: p.employmentId,
    attendanceDate: p.date,
    checkInAt: p.checkInAt,
    checkOutAt: p.checkOutAt,
    status: 'present',
    dayType: p.dayType ?? 'workday',
    workedMinutes: p.workedMinutes,
    otMinutes: p.otMinutes ?? 0,
  });
}

const hoursIn = (ctx: SessionContext, employmentId: string, on: boolean, win = { from: '2026-07-01', to: '2026-07-31' }) =>
  withTenant(ctx, (tx) => payableHoursForCycle(tx, employmentId, win, { onlyPullHoursWithinShiftSchedule: on }));

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
});
afterAll(async () => {
  await closeAll();
});

describe('2.1.3 Hourly — payableHoursForCycle (shift-bounded hours)', () => {
  it('OFF: returns the unclamped worked total across the window (all worked hours count)', async () => {
    const a = adminCtx(b);
    const e = await hire('OffWorker');
    const day = await seedShift({ name: 'Day8', startTime: '09:00:00', endTime: '17:00:00' }); // 8h scheduled
    await roster({ employmentId: e.employmentId, date: '2026-07-01', shiftId: day });
    await att({ employmentId: e.employmentId, date: '2026-07-01', checkInAt: '09:00:00', checkOutAt: '19:00:00', workedMinutes: 600 }); // 10h worked
    await att({ employmentId: e.employmentId, date: '2026-07-02', checkInAt: '09:00:00', checkOutAt: '13:00:00', workedMinutes: 240 }); // 4h, no roster row
    // OFF → 600 + 240 = 840 minutes = 14h, regardless of roster.
    expect(await hoursIn(a, e.employmentId, false)).toBeCloseTo(14, 6);
  });

  it('ON, rostered workday: clamps to the shift span — overtime beyond the shift is NOT payable', async () => {
    const a = adminCtx(b);
    const e = await hire('OtWorker');
    const day = await seedShift({ name: 'Day8b', startTime: '09:00:00', endTime: '17:00:00' }); // 8h
    await roster({ employmentId: e.employmentId, date: '2026-07-01', shiftId: day });
    await att({ employmentId: e.employmentId, date: '2026-07-01', checkInAt: '09:00:00', checkOutAt: '19:00:00', workedMinutes: 600, otMinutes: 120 }); // worked 10h, 2h OT
    // ON → min(600, 480) = 480 min = 8h. OT (2h) is excluded.
    expect(await hoursIn(a, e.employmentId, true)).toBeCloseTo(8, 6);
  });

  it('ON, rostered workday, worked under the shift: paid the worked amount (not padded up to the shift)', async () => {
    const a = adminCtx(b);
    const e = await hire('UnderWorker');
    const day = await seedShift({ name: 'Day8c', startTime: '09:00:00', endTime: '17:00:00' }); // 8h scheduled
    await roster({ employmentId: e.employmentId, date: '2026-07-01', shiftId: day });
    await att({ employmentId: e.employmentId, date: '2026-07-01', checkInAt: '09:00:00', checkOutAt: '15:00:00', workedMinutes: 360 }); // 6h
    // ON → min(360, 480) = 360 min = 6h (worked < scheduled, so the worked amount stands; no padding up).
    expect(await hoursIn(a, e.employmentId, true)).toBeCloseTo(6, 6);
  });

  it('ON, no rostered shift that day: 0 payable (worked-but-not-rostered is excluded)', async () => {
    const a = adminCtx(b);
    const e = await hire('NoRoster');
    // Attendance exists but there is NO roster row for the date.
    await att({ employmentId: e.employmentId, date: '2026-07-03', checkInAt: '09:00:00', checkOutAt: '17:00:00', workedMinutes: 480 });
    expect(await hoursIn(a, e.employmentId, true)).toBeCloseTo(0, 6);
    // OFF still counts the worked hours (8h) — the toggle is the only difference.
    expect(await hoursIn(a, e.employmentId, false)).toBeCloseTo(8, 6);
  });

  it('ON, rostered REST day: 0 payable (a rest-day roster is not an assigned shift)', async () => {
    const a = adminCtx(b);
    const e = await hire('RestDay');
    await roster({ employmentId: e.employmentId, date: '2026-07-05', isRestDay: true });
    await att({ employmentId: e.employmentId, date: '2026-07-05', checkInAt: '10:00:00', checkOutAt: '14:00:00', workedMinutes: 240, dayType: 'rest_day', otMinutes: 240 });
    expect(await hoursIn(a, e.employmentId, true)).toBeCloseTo(0, 6);
    // OFF: rest-day work still counts the worked total (4h).
    expect(await hoursIn(a, e.employmentId, false)).toBeCloseTo(4, 6);
  });

  it('ON, cross-midnight shift (22:00→06:00): clamps the start-date row against the shift span', async () => {
    const a = adminCtx(b);
    const e = await hire('NightWorker');
    // Night shift 22:00→06:00, 60m break ⇒ shiftSpan 480 − 60 = 420 scheduled minutes (7h).
    const night = await seedShift({ name: 'Night', startTime: '22:00:00', endTime: '06:00:00', breakMinutes: 60, crossesMidnight: true });
    await roster({ employmentId: e.employmentId, date: '2026-07-10', shiftId: night });
    // The punch importer keys a night shift to its START date; worked 9h (e.g. 21:00→07:00 less break) on that row.
    await att({ employmentId: e.employmentId, date: '2026-07-10', checkInAt: '22:00:00', checkOutAt: '06:00:00', workedMinutes: 540, otMinutes: 120 });
    // ON → min(540, 420) = 420 min = 7h (the scheduled night span; the extra 2h is excluded).
    expect(await hoursIn(a, e.employmentId, true)).toBeCloseTo(7, 6);
    // OFF → the full 9h worked counts.
    expect(await hoursIn(a, e.employmentId, false)).toBeCloseTo(9, 6);
  });

  it('ON, mixed window: only rostered-shift days within their span contribute', async () => {
    const a = adminCtx(b);
    const e = await hire('MixedWorker');
    const day = await seedShift({ name: 'Mix8', startTime: '09:00:00', endTime: '17:00:00' }); // 8h
    // Day 1: rostered, worked 9h → clamp to 8h. Day 2: no roster, worked 5h → 0. Day 3: rest day, worked 3h → 0.
    await roster({ employmentId: e.employmentId, date: '2026-07-20', shiftId: day });
    await att({ employmentId: e.employmentId, date: '2026-07-20', checkInAt: '09:00:00', checkOutAt: '18:00:00', workedMinutes: 540 });
    await att({ employmentId: e.employmentId, date: '2026-07-21', checkInAt: '09:00:00', checkOutAt: '14:00:00', workedMinutes: 300 });
    await roster({ employmentId: e.employmentId, date: '2026-07-22', isRestDay: true });
    await att({ employmentId: e.employmentId, date: '2026-07-22', checkInAt: '10:00:00', checkOutAt: '13:00:00', workedMinutes: 180, dayType: 'rest_day' });
    expect(await hoursIn(a, e.employmentId, true)).toBeCloseTo(8, 6); // only the rostered day, clamped
    expect(await hoursIn(a, e.employmentId, false)).toBeCloseTo((540 + 300 + 180) / 60, 6); // 17h unclamped
  });

  it('empty window: no attendance rows → 0 hours both ON and OFF', async () => {
    const a = adminCtx(b);
    const e = await hire('Idle');
    expect(await hoursIn(a, e.employmentId, true)).toBe(0);
    expect(await hoursIn(a, e.employmentId, false)).toBe(0);
  });
});

describe('2.1.3 Hourly — config validation (per_hour + shift toggle) via the shared service', () => {
  it('accepts a minimal valid per_hour rule, and one carrying the shift toggle (both true and false)', async () => {
    const a = adminCtx(b);
    const { id: noFlag } = await createPolicy(a, {
      companyId: b.companyId,
      name: 'Hourly Plain',
      policyType: 'hourly',
      payRule: { kind: 'per_hour', rate: 25 },
    });
    expect((await getPolicy(a, noFlag))?.payRule).toEqual({ kind: 'per_hour', rate: 25 });

    const { id: onFlag } = await createPolicy(a, {
      companyId: b.companyId,
      name: 'Hourly Within',
      policyType: 'hourly',
      payRule: { kind: 'per_hour', rate: 30, onlyPullHoursWithinShiftSchedule: true },
    });
    expect((await getPolicy(a, onFlag))?.payRule).toEqual({ kind: 'per_hour', rate: 30, onlyPullHoursWithinShiftSchedule: true });

    const { id: offFlag } = await createPolicy(a, {
      companyId: b.companyId,
      name: 'Hourly AllHours',
      policyType: 'hourly',
      payRule: { kind: 'per_hour', rate: 18, onlyPullHoursWithinShiftSchedule: false },
    });
    expect((await getPolicy(a, offFlag))?.payRule).toEqual({ kind: 'per_hour', rate: 18, onlyPullHoursWithinShiftSchedule: false });
  });

  it('rejects an hourly policy with no pay rule, a wrong-kind rule, and an out-of-range rate', async () => {
    const a = adminCtx(b);
    await expect(createPolicy(a, { companyId: b.companyId, name: 'BadHourly', policyType: 'hourly' })).rejects.toThrow(
      /Daily\/Hourly policy requires a pay rule/,
    );
    await expect(
      createPolicy(a, { companyId: b.companyId, name: 'BadHourly2', policyType: 'hourly', payRule: { kind: 'per_day', rate: 100 } }),
    ).rejects.toThrow(/requires a per_hour rule/);
    await expect(
      createPolicy(a, { companyId: b.companyId, name: 'BadHourly3', policyType: 'hourly', payRule: { kind: 'per_hour', rate: -5 } }),
    ).rejects.toThrow(/Invalid pay rule/);
  });

  it('rejects the shift toggle on a non-per_hour (per_day) rule', async () => {
    const a = adminCtx(b);
    // A per_day rule that smuggles in the hourly-only flag (runtime JSONB) is rejected by resolveRule.
    const sneaky = { kind: 'per_day', rate: 100, onlyPullHoursWithinShiftSchedule: true } as unknown as schema.PayRule;
    await expect(
      createPolicy(a, { companyId: b.companyId, name: 'DailyWithFlag', policyType: 'daily', payRule: sneaky }),
    ).rejects.toThrow(/only valid on an hourly/);
  });
});

describe('2.1.3 Hourly — CRUD / copy via the shared service + substrate', () => {
  it('creates, edits the rate + toggle, copies (pay_rule verbatim), toggles status, deletes — emitting payroll-policy.* events', async () => {
    const a = adminCtx(b);
    const { id } = await createPolicy(a, {
      companyId: b.companyId,
      name: 'Site Hourly',
      policyType: 'hourly',
      payRule: { kind: 'per_hour', rate: 20, onlyPullHoursWithinShiftSchedule: true },
    });
    expect(await getPolicy(a, id)).toMatchObject({ name: 'Site Hourly', policyType: 'hourly', status: 'active' });

    // Edit: bump rate + flip the toggle off.
    await updatePolicy(a, { id, payRule: { kind: 'per_hour', rate: 22.5, onlyPullHoursWithinShiftSchedule: false } });
    expect((await getPolicy(a, id))?.payRule).toEqual({ kind: 'per_hour', rate: 22.5, onlyPullHoursWithinShiftSchedule: false });

    // Copy carries the per_hour rule (incl. the toggle) verbatim under a new unique name; starts active.
    await updatePolicy(a, { id, payRule: { kind: 'per_hour', rate: 22.5, onlyPullHoursWithinShiftSchedule: true } });
    const { id: copyId } = await copyPolicy(a, { sourceId: id, name: 'Site Hourly (copy)' });
    const copied = await getPolicy(a, copyId);
    expect(copied).toMatchObject({ name: 'Site Hourly (copy)', policyType: 'hourly', status: 'active' });
    expect(copied?.payRule).toEqual({ kind: 'per_hour', rate: 22.5, onlyPullHoursWithinShiftSchedule: true });

    // Status + delete are type-agnostic and work on an hourly policy.
    await setStatus(a, { id: copyId, status: 'inactive' });
    expect((await getPolicy(a, copyId))?.status).toBe('inactive');
    await expect(deletePolicy(a, { id: copyId })).resolves.toMatchObject({ id: copyId });

    expect(await eventTypesFor(b.tenantId, id)).toEqual(
      expect.arrayContaining(['payroll-policy.created', 'payroll-policy.updated']),
    );
    expect(await eventTypesFor(b.tenantId, copyId)).toEqual(
      expect.arrayContaining(['payroll-policy.created', 'payroll-policy.deactivated', 'payroll-policy.deleted']),
    );
  });

  it('enforces the per-company unique name for hourly policies too', async () => {
    const a = adminCtx(b);
    await createPolicy(a, { companyId: b.companyId, name: 'HourlyUniq', policyType: 'hourly', payRule: { kind: 'per_hour', rate: 15 } });
    await expect(
      createPolicy(a, { companyId: b.companyId, name: 'HourlyUniq', policyType: 'hourly', payRule: { kind: 'per_hour', rate: 16 } }),
    ).rejects.toBeInstanceOf(DuplicatePolicyNameError);
  });

  it('resolveAssignedPolicy returns the assigned ACTIVE hourly policy (single-FK resolution, no priority)', async () => {
    const a = adminCtx(b);
    const { id } = await createPolicy(a, {
      companyId: b.companyId,
      name: 'ResolvableHourly',
      policyType: 'hourly',
      payRule: { kind: 'per_hour', rate: 25, onlyPullHoursWithinShiftSchedule: true },
    });
    const e = await hire('HourlyAssignee');
    await assignPolicy(a, { employmentId: e.employmentId, policyId: id });
    const resolved = await withTenant(a, (tx) => resolveAssignedPolicy(tx, e.employmentId));
    expect(resolved?.id).toBe(id);
    expect(resolved?.policyType).toBe('hourly');
    expect(resolved?.payRule).toEqual({ kind: 'per_hour', rate: 25, onlyPullHoursWithinShiftSchedule: true });
    // Inactive → falls back to null (monthly default), exactly as every other type.
    await setStatus(a, { id, status: 'inactive' });
    expect(await withTenant(a, (tx) => resolveAssignedPolicy(tx, e.employmentId))).toBeNull();
  });
});

describe('2.1.3 Hourly — RLS regression (inherits the 0128 policy)', () => {
  it('an hourly row is tenant-wide readable but admin-only writable', async () => {
    const a = adminCtx(b);
    const { id } = await createPolicy(a, {
      companyId: b.companyId,
      name: 'HourlyRls',
      policyType: 'hourly',
      payRule: { kind: 'per_hour', rate: 19, onlyPullHoursWithinShiftSchedule: true },
    });
    // A non-admin employee in the tenant CAN read the hourly row (kernel resolves under the caller's session).
    const e = await hire('NonAdminHourly');
    const uE = await createAppUser(b.tenantId, e.personId, 'employee');
    const empCtx: SessionContext = { tenantId: b.tenantId, userId: uE, roles: ['employee'], entitlements: harnessSnapshot(b.tenantId) };
    const seen = await withTenant(empCtx, (tx) =>
      tx.select().from(schema.payrollPolicy).where(eq(schema.payrollPolicy.id, id)),
    );
    expect(seen.length).toBe(1);
    // But the non-admin CANNOT write it.
    await expect(
      withTenant(empCtx, (tx) =>
        tx.update(schema.payrollPolicy).set({ name: 'Hacked' }).where(eq(schema.payrollPolicy.id, id)),
      ),
    ).rejects.toThrow();
  });
});
