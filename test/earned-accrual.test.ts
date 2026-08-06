/**
 * ADR-0040 2D-1 — earned leave accrual. An earned configuration (earned_monthly / earned_quarterly) is
 * NOT granted as a lump at hire or year-open; accrueEarnedLeave tops it up to the amount earned by
 * `asOf`, idempotently, pro-rated from the join month. Lump-sum configurations are unaffected.
 *
 * 6e9a126e RELEASE THREE — REPOINTED, NOT REWRITTEN. Every day count below is unchanged; only where the
 * configuration is stored moved. The dropped `leave_policy.accrual` JSONB said two different kinds of
 * thing at once — the DAYS and the RULES — and the two halves now live in the two places 9816a5ad split
 * them into: DAYS in an entitlement template's band (`seedEntitlement`), RULES (earning method, carry
 * cap) on the LEAVE TYPE's own columns, which is where `applyLeaveTypeRules` reads them from. `policy()`
 * below takes the same argument object it always took and routes each key to its new home, so the
 * arithmetic these tests exist for is asserted against exactly the figures it was.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { accrueEarnedLeave } from '../core/leave';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';

let b: Base;
const balanceOf = async (employmentId: string) => {
  const [r] = await owner.db
    .select({ bal: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveLedger.leaveTypeId, b.annualLeaveTypeId)));
  return Number(r.bal);
};
/** The old `leave_policy.accrual` JSONB, split across its two new homes. Days → the entitlement template's
 *  single 0..∞ band; earning method and carry cap → the leave TYPE's rule columns, which is the only place
 *  `applyLeaveTypeRules` looks. Passing NEITHER rule leaves the type unruled, which is the lump-sum path. */
const policy = async (p: { annualDays: number; method?: string; carryForwardMax?: number }) => {
  await seedEntitlement(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays: p.annualDays,
    validFrom: '2026-01-01',
  });
  const rules: Record<string, unknown> = {};
  if (p.method !== undefined) rules.accrualMethod = p.method;
  if (p.carryForwardMax !== undefined) rules.carryForwardMax = String(p.carryForwardMax);
  if (Object.keys(rules).length > 0) {
    await owner.db.update(schema.leaveType).set(rules).where(eq(schema.leaveType.id, b.annualLeaveTypeId));
  }
};
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
