/**
 * #f88f0a63 — Min-service unit selection. The Minimum-service eligibility rule can now be measured in
 * 'months' (whole completed months — the legacy behaviour) or 'days' (elapsed whole days). Additive JSONB:
 * minServiceMonths stays the numeric carrier, minServiceUnit is the new unit. ABSENT unit ⇒ 'months', so
 * every pre-existing row keeps its exact old meaning with no migration/backfill.
 *
 * Coverage:
 *   - isLeaveEligible (pure): months unit unchanged; days unit 90-in eligible / 89 ineligible; absent unit
 *     resolves as months (legacy compat).
 *   - requestLeave (DB): days-unit gate enforces at the submission boundary; message reads in the chosen unit.
 *   - cleanEligibility via updateLeaveType (DB): absent unit defaults to months; explicit days persists;
 *     a bad unit rejects; a lone unit (value 0) drops the whole rule; a legacy row re-saved via an
 *     unrelated field never invents a unit; before/after event carries the reshaped object.
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { updateLeaveType } from '../core/admin';
import { isLeaveEligible, LeaveIneligibleError, requestLeave } from '../core/leave';
import {
  adminCtx,
  closeAll,
  latestEventPayload,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  type Base,
} from './harness';

let b: Base;

const req = (employmentId: string, leaveTypeId: string) =>
  requestLeave(adminCtx(b), { employmentId, leaveTypeId, startDate: '2026-07-01', endDate: '2026-07-01' });

async function hire(hiredOn: string) {
  const e = await hireEmployee(adminCtx(b), {
    person: { fullName: 'MSU', primaryEmail: `msu_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
  });
  await owner.db
    .update(schema.person)
    .set({ gender: 'male', maritalStatus: 'married' })
    .where(eq(schema.person.id, e.personId));
  return e;
}
async function leaveType(code: string, eligibility: unknown) {
  const [row] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code, name: code, paid: true, counting: 'calendar_days', eligibility })
    .returning({ id: schema.leaveType.id });
  return row.id;
}
const eligibilityOf = async (id: string) => {
  const [row] = await owner.db
    .select({ e: schema.leaveType.eligibility })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.id, id));
  return row.e;
};

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

describe('#f88f0a63 — min-service unit (pure enforcement)', () => {
  const emp = (hiredOn: string) => ({ gender: 'male', marital: 'married', hiredOn });
  const asOf = '2026-07-01';

  it('months unit compares completed months (unchanged behaviour)', () => {
    // 12 months rule: hire 2025-07-01 = exactly 12 months → eligible; 2025-08-01 = 11 months → ineligible.
    expect(isLeaveEligible({ minServiceMonths: 12, minServiceUnit: 'months' }, emp('2025-07-01'), asOf)).toBe(true);
    expect(isLeaveEligible({ minServiceMonths: 12, minServiceUnit: 'months' }, emp('2025-08-01'), asOf)).toBe(false);
  });

  it('absent unit resolves as months (legacy compat — identical to an explicit months rule)', () => {
    expect(isLeaveEligible({ minServiceMonths: 12 }, emp('2025-07-01'), asOf)).toBe(true);
    expect(isLeaveEligible({ minServiceMonths: 12 }, emp('2025-08-01'), asOf)).toBe(false);
    // A months-unit rule with the SAME value would (mis)treat these as days if the unit were ignored — prove
    // the absent-unit row is NOT read as days: 12 days before asOf (2026-06-19) would pass a days rule but
    // fails the (correct) months reading.
    expect(isLeaveEligible({ minServiceMonths: 12 }, emp('2026-06-19'), asOf)).toBe(false);
  });

  it('days unit compares elapsed whole days: 90 served eligible, 89 ineligible', () => {
    // daysBetween(2026-04-02, 2026-07-01) = 90; daysBetween(2026-04-03, 2026-07-01) = 89.
    expect(isLeaveEligible({ minServiceMonths: 90, minServiceUnit: 'days' }, emp('2026-04-02'), asOf)).toBe(true);
    expect(isLeaveEligible({ minServiceMonths: 90, minServiceUnit: 'days' }, emp('2026-04-03'), asOf)).toBe(false);
  });
});

describe('#f88f0a63 — min-service unit (requestLeave gate)', () => {
  it('a 90-day rule blocks 89 days served and admits 90 days served', async () => {
    const t = await leaveType('PROBATION90', { minServiceMonths: 90, minServiceUnit: 'days' });
    const eligible = await hire('2026-04-02'); // 90 days by 2026-07-01
    const short = await hire('2026-04-03'); // 89 days
    await expect(req(eligible.employmentId, t)).resolves.toMatchObject({ days: 1 });
    await expect(req(short.employmentId, t)).rejects.toBeInstanceOf(LeaveIneligibleError);
  });

  it('the rejection message names the configured unit (days)', async () => {
    const t = await leaveType('PROBATION90B', { minServiceMonths: 90, minServiceUnit: 'days' });
    const short = await hire('2026-06-01');
    await expect(req(short.employmentId, t)).rejects.toThrow(/90 days of service/);
  });
});

describe('#f88f0a63 — min-service unit (cleanEligibility via updateLeaveType)', () => {
  it('an explicit days unit persists alongside the value', async () => {
    const t = await leaveType('DUNIT', null);
    await updateLeaveType(adminCtx(b), {
      id: t,
      name: 'DUNIT',
      eligibility: { minServiceMonths: 90, minServiceUnit: 'days' },
    });
    expect(await eligibilityOf(t)).toEqual({ minServiceMonths: 90, minServiceUnit: 'days' });
  });

  it('an absent unit defaults to months when a positive value survives (legacy compat)', async () => {
    const t = await leaveType('MUNIT', null);
    await updateLeaveType(adminCtx(b), { id: t, name: 'MUNIT', eligibility: { minServiceMonths: 6 } });
    expect(await eligibilityOf(t)).toEqual({ minServiceMonths: 6, minServiceUnit: 'months' });
  });

  it('a bad unit rejects', async () => {
    const t = await leaveType('BAD', null);
    await expect(
      updateLeaveType(adminCtx(b), {
        id: t,
        name: 'BAD',
        eligibility: { minServiceMonths: 3, minServiceUnit: 'years' } as never,
      }),
    ).rejects.toThrow();
  });

  it('a lone unit with no/zero value never persists (whole rule drops)', async () => {
    const t = await leaveType('LONE', null);
    // value 0 + a unit: 0 drops the service floor, so the unit must not survive on its own → open to all.
    await updateLeaveType(adminCtx(b), {
      id: t,
      name: 'LONE',
      eligibility: { minServiceMonths: 0, minServiceUnit: 'days' } as never,
    });
    expect(await eligibilityOf(t)).toBeNull();
  });

  it('re-saving a legacy months rule via a gender-only edit never invents a days unit', async () => {
    // A pre-unit row stored the bare {minServiceMonths} shape (no unit) before this feature existed.
    const t = await leaveType('LEGACY', { minServiceMonths: 12 });
    // HR opens the eligibility form and ticks gender only; the form re-posts the existing min-service value
    // with the default 'months' unit. The stored meaning stays months — a legacy-safe re-save.
    await updateLeaveType(adminCtx(b), {
      id: t,
      name: 'LEGACY',
      eligibility: { gender: 'male', minServiceMonths: 12, minServiceUnit: 'months' },
    });
    expect(await eligibilityOf(t)).toEqual({ gender: ['male'], minServiceMonths: 12, minServiceUnit: 'months' });
  });

  it('appends leave-type.updated with before/after carrying the reshaped eligibility', async () => {
    const t = await leaveType('EVT', null);
    await updateLeaveType(adminCtx(b), {
      id: t,
      name: 'EVT',
      eligibility: { minServiceMonths: 30, minServiceUnit: 'days' },
    });
    const payload = (await latestEventPayload(b.tenantId, t, 'leave-type.updated')) as {
      after: { eligibility: unknown };
    };
    expect(payload.after.eligibility).toEqual({ minServiceMonths: 30, minServiceUnit: 'days' });
  });
});
