/**
 * R33 f21d6eee — Shared shift library. Shift templates are TENANT-GLOBAL: a template is created once and
 * assignable to ANY employee in the tenant, regardless of company. This suite covers the correctness edges
 * of the migration + service change (migration 0197 + core/roster.ts):
 *
 *   1. A shift authored in company A (or tenant-global) is assignable to an employee in company B — the old
 *      ShiftCompanyMismatchError is gone (ArchivedShiftError still applies).
 *   2. listShiftsForTenant returns the FULL shared set (tenant-global + legacy company-stamped rows) — the
 *      single source the shift-settings page, the roster picker and the employee-profile picker all read.
 *   3. Existing default_shift_id assignments are unaffected by the shared-library move (a legacy company
 *      shift assigned as a default reads back unchanged).
 *   4. RLS: the tenant-admin write policy blocks a non-admin from creating/updating shifts, while still
 *      allowing tenant-wide SELECT.
 *   5. Name/code uniqueness is tenant-wide, not per company.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { withTenant, type SessionContext } from '../db/client';
import {
  ArchivedShiftError,
  archiveShift,
  assignEmployeeShift,
  createShift,
  listShifts,
  listShiftsForTenant,
} from '../core/roster';
import { adminCtx, closeAll, createAppUser, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

async function makeCompany(name: string) {
  const [c] = await owner.db
    .insert(schema.company)
    .values({ tenantId: b.tenantId, legalName: name })
    .returning({ id: schema.company.id });
  return c.id;
}

async function makeEmp(companyId: string) {
  const [p] = await owner.db
    .insert(schema.person)
    .values({ tenantId: b.tenantId, fullName: 'SL', primaryEmail: `sl_${randomUUID()}@t.local` })
    .returning({ id: schema.person.id });
  const [e] = await owner.db
    .insert(schema.employment)
    .values({ tenantId: b.tenantId, personId: p.id, companyId, hiredOn: '2020-01-01' })
    .returning({ id: schema.employment.id });
  return { employmentId: e.id, personId: p.id };
}

const storedDefault = async (employmentId: string) => {
  const [row] = await owner.db
    .select({ ds: schema.employment.defaultShiftId, st: schema.employment.shiftType })
    .from(schema.employment)
    .where(eq(schema.employment.id, employmentId));
  return row;
};

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

describe('R33 shared shift library — cross-company assignment', () => {
  it('a shift authored in company A is assignable to an employee in company B', async () => {
    const a = adminCtx(b);
    const companyA = b.companyId;
    const companyB = await makeCompany('Beta Sdn Bhd');
    const { employmentId: empInB } = await makeEmp(companyB);

    // Shift stamped with company A (a legacy per-company row).
    const shiftA = await createShift(a, {
      companyId: companyA,
      name: 'Morning A',
      code: 'AM-A',
      startTime: '09:00:00',
      endTime: '18:00:00',
      breakMinutes: 60,
      // b8aa3466 — a backup shift must declare working days or every date resolves to rest_day. This
      // fixture is about CROSS-COMPANY assignability, so it needs a workable pattern to reach that check.
      weeklyPattern: [1, 2, 3, 4, 5],
    });
    // Assigning it to an employee in company B must SUCCEED (no ShiftCompanyMismatchError).
    await assignEmployeeShift(a, { employmentId: empInB, shiftType: 'fixed', shiftId: shiftA.id });
    expect(await storedDefault(empInB)).toEqual({ ds: shiftA.id, st: 'fixed' });
  });

  it('a tenant-global shift (no company) is assignable, and an archived one is still rejected', async () => {
    const a = adminCtx(b);
    const companyB = await makeCompany('Gamma Sdn Bhd');
    const { employmentId } = await makeEmp(companyB);

    const global = await createShift(a, { name: 'Global Day', code: 'GDAY', startTime: '08:00:00', endTime: '17:00:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5] });
    await assignEmployeeShift(a, { employmentId, shiftType: 'fixed', shiftId: global.id });
    expect((await storedDefault(employmentId)).ds).toBe(global.id);

    // ArchivedShiftError still guards: an archived template cannot be assigned.
    const stale = await createShift(a, { name: 'Stale', code: 'STALE', startTime: '09:00:00', endTime: '18:00:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5] });
    await archiveShift(a, { shiftId: stale.id });
    await expect(
      assignEmployeeShift(a, { employmentId, shiftType: 'fixed', shiftId: stale.id }),
    ).rejects.toBeInstanceOf(ArchivedShiftError);
  });
});

describe('R33 shared shift library — the pickers read the full shared set', () => {
  it('listShiftsForTenant returns tenant-global AND legacy company-stamped rows; listShifts stays company-scoped', async () => {
    const a = adminCtx(b);
    const companyB = await makeCompany('Delta Sdn Bhd');
    const global = await createShift(a, { name: 'Shared', code: 'SHARED', startTime: '09:00:00', endTime: '18:00:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5] });
    const stampedA = await createShift(a, { companyId: b.companyId, name: 'Company A Day', code: 'CADAY', startTime: '08:00:00', endTime: '17:00:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5] });
    const stampedB = await createShift(a, { companyId: companyB, name: 'Company B Day', code: 'CBDAY', startTime: '10:00:00', endTime: '19:00:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5] });

    const lib = await listShiftsForTenant(a);
    expect(new Set(lib.map((s) => s.id))).toEqual(new Set([global.id, stampedA.id, stampedB.id]));

    // Company-scoped list only sees that company's stamped rows (not the tenant-global template).
    const inA = await listShifts(a, b.companyId);
    expect(inA.map((s) => s.id)).toEqual([stampedA.id]);
  });
});

describe('R33 shared shift library — existing assignments unaffected', () => {
  it('a legacy company-shift default reads back unchanged after being assigned', async () => {
    const a = adminCtx(b);
    const { employmentId } = await makeEmp(b.companyId);
    const legacy = await createShift(a, { companyId: b.companyId, name: 'Legacy Day', code: 'LEG', startTime: '09:00:00', endTime: '18:00:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5] });
    await assignEmployeeShift(a, { employmentId, shiftType: 'fixed', shiftId: legacy.id });
    expect(await storedDefault(employmentId)).toEqual({ ds: legacy.id, st: 'fixed' });
    // Re-reading via the library still surfaces the legacy row (it did not change scope).
    expect((await listShiftsForTenant(a)).map((s) => s.id)).toContain(legacy.id);
  });
});

describe('R33 shared shift library — RLS gates writes to tenant admins', () => {
  it('a non-admin cannot INSERT/UPDATE a shift but can SELECT the shared set', async () => {
    const a = adminCtx(b);
    const { personId } = await makeEmp(b.companyId);
    const uE = await createAppUser(b.tenantId, personId, 'employee');
    const empCtx: SessionContext = { tenantId: b.tenantId, userId: uE, roles: ['employee'] };

    const existing = await createShift(a, { name: 'Admin Made', code: 'ADM', startTime: '09:00:00', endTime: '18:00:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5] });

    // Service create (runs inside withTenant → RLS WITH CHECK app.is_admin()) is blocked for a non-admin.
    await expect(
      createShift(empCtx, { name: 'Sneaky', code: 'SNK', startTime: '09:00:00', endTime: '18:00:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5] }),
    ).rejects.toThrow();

    // A raw UPDATE as the employee is also blocked by RLS.
    await expect(
      withTenant(empCtx, (tx) => tx.update(schema.shift).set({ name: 'Hijacked' }).where(eq(schema.shift.id, existing.id))),
    ).rejects.toThrow();

    // But SELECT is tenant-wide — the employee still reads the shared library (the roster picker path).
    const seen = await listShiftsForTenant(empCtx);
    expect(seen.map((s) => s.id)).toContain(existing.id);
  });
});

describe('R33 shared shift library — tenant-wide uniqueness', () => {
  it('rejects a duplicate name or code anywhere in the tenant', async () => {
    const a = adminCtx(b);
    const companyB = await makeCompany('Epsilon Sdn Bhd');
    await createShift(a, { companyId: b.companyId, name: 'Uniq', code: 'UNIQ', startTime: '09:00:00', endTime: '18:00:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5] });
    // Same name in a DIFFERENT company is now rejected (tenant-wide, not per company).
    await expect(
      createShift(a, { companyId: companyB, name: 'Uniq', code: 'UNIQ2', startTime: '08:00:00', endTime: '17:00:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5] }),
    ).rejects.toThrow(/already exists/i);
    await expect(
      createShift(a, { companyId: companyB, name: 'Uniq2', code: 'uniq', startTime: '08:00:00', endTime: '17:00:00', breakMinutes: 60, weeklyPattern: [1, 2, 3, 4, 5] }),
    ).rejects.toThrow(/already exists/i);
  });
});
