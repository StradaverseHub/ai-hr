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

  it('2D-3: caps carried-forward earned leave at the cycle boundary, honouring the carry cap', async () => {
    await policy({ annualDays: 12, carryForwardMax: 5, method: 'earned_monthly' }); // active from 2026-01-01
    const emp = await hire('2026-01-01');
    await run('2026-12-31'); // full 2026 cycle → 12
    expect(await balanceOf(emp.employmentId)).toBe(12);
    const r = await run('2027-06-15'); // new cycle: forfeit (12 − cap 5) at 1 Jan, then accrue Jan–Jun
    expect(r.forfeits).toBe(1);
    expect(await balanceOf(emp.employmentId)).toBe(11); // 12 − 7 (forfeit) + 6 (2027 earned-to-date)
    const again = await run('2027-06-15'); // idempotent — no second forfeit, no extra accrual
    expect(again.forfeits).toBe(0);
    expect(again.granted).toBe(0);
    expect(await balanceOf(emp.employmentId)).toBe(11);
  });

  it('2D-3: a balance already within the carry cap is not forfeited', async () => {
    await policy({ annualDays: 12, carryForwardMax: 8, method: 'earned_monthly' });
    const emp = await hire('2026-01-01');
    await run('2026-12-31'); // 12 earned in 2026
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: emp.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      entryType: 'debit',
      days: '-6.00',
      effectiveOn: '2026-08-01', // takes 6 → 2026 balance 6, within the 8-day cap
    });
    const r = await run('2027-06-15');
    expect(r.forfeits).toBe(0); // 6 ≤ cap 8 → nothing forfeited
    expect(await balanceOf(emp.employmentId)).toBe(12); // 6 carried + 6 accrued in 2027
  });
});
