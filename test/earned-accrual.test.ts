/**
 * ADR-0040 2D-1 — earned leave accrual. An earned policy (earned_monthly / earned_quarterly) is NOT
 * granted as a lump at hire or year-open; accrueEarnedLeave tops it up to the amount earned by `asOf`,
 * idempotently, pro-rated from the join month. Over a full cycle the total equals max(EA-floor, policy
 * days), so the statutory floor still holds. Lump-sum policies are unaffected.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { accrueEarnedLeave } from '../core/leave';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const balanceOf = async (employmentId: string) => {
  const [r] = await owner.db
    .select({ bal: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveLedger.leaveTypeId, b.annualLeaveTypeId)));
  return Number(r.bal);
};
const policy = (accrual: unknown) =>
  owner.db
    .insert(schema.leavePolicy)
    .values({ tenantId: b.tenantId, leaveTypeId: b.annualLeaveTypeId, accrual, validFrom: '2026-01-01' });
const hire = (hiredOn: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Acc', primaryEmail: `acc_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });
const run = (asOf: string) => accrueEarnedLeave(adminCtx(b), { asOf });

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

describe('ADR-0040 2D-1 — earned leave accrual', () => {
  it('earned_monthly accrues pro-rata, idempotently, reaching the full entitlement by year-end', async () => {
    await policy({ annualDays: 12, method: 'earned_monthly' });
    const emp = await hire('2026-01-01');
    expect(await balanceOf(emp.employmentId)).toBe(0); // earned → no hire lump
    await run('2026-06-15');
    expect(await balanceOf(emp.employmentId)).toBe(6); // Jan–Jun
    await run('2026-06-15'); // idempotent — no double grant
    expect(await balanceOf(emp.employmentId)).toBe(6);
    await run('2026-12-31');
    expect(await balanceOf(emp.employmentId)).toBe(12); // full cycle = max(floor, policy) ≥ floor
  });

  it('a mid-year joiner accrues pro-rata from their join month', async () => {
    await policy({ annualDays: 12, method: 'earned_monthly' });
    const emp = await hire('2026-07-01');
    await run('2026-12-31');
    expect(await balanceOf(emp.employmentId)).toBe(6); // Jul–Dec
  });

  it('earned_quarterly accrues per quarter', async () => {
    await policy({ annualDays: 12, method: 'earned_quarterly' });
    const emp = await hire('2026-01-01');
    await run('2026-04-15'); // Q1 + Q2 started → 2 × 3
    expect(await balanceOf(emp.employmentId)).toBe(6);
  });

  it('lump-sum policies grant on hire and are ignored by accrueEarnedLeave', async () => {
    await policy({ annualDays: 12 }); // no method → lump
    const emp = await hire('2026-01-01'); // Jan hire → full pro-rated grant
    expect(await balanceOf(emp.employmentId)).toBe(12);
    const { granted } = await run('2026-06-15');
    expect(granted).toBe(0);
    expect(await balanceOf(emp.employmentId)).toBe(12);
  });
});
