/**
 * ADR-0040 2D-2 — anniversary earned-accrual cycle. With company.leave_cycle='anniversary', each
 * employee's earned-accrual cycle is anchored to their hire-month anniversary (not the calendar 1 Jan).
 * accrueEarnedLeave then accrues from the most-recent anniversary on/before asOf, idempotently. The
 * entitlement here is max(EA-floor 8, policy 12) = 12 on a 12-month cycle, so earned-to-date == periods.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { accrueEarnedLeave } from '../core/leave';
import { setCompanyLeaveCycle } from '../core/admin';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const balanceOf = async (employmentId: string) => {
  const [r] = await owner.db
    .select({ bal: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveLedger.leaveTypeId, b.annualLeaveTypeId)));
  return Number(r.bal);
};
const setCycle = (cycle: string) => setCompanyLeaveCycle(adminCtx(b), { companyId: b.companyId, cycle });
const earnedPolicy = () =>
  owner.db
    .insert(schema.leavePolicy)
    .values({
      tenantId: b.tenantId,
      leaveTypeId: b.annualLeaveTypeId,
      accrual: { annualDays: 12, method: 'earned_monthly' },
      validFrom: '2024-01-01',
    });
const hire = (hiredOn: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Anniv', primaryEmail: `anniv_${randomUUID().slice(0, 8)}@t.local` },
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
  await earnedPolicy();
});
afterAll(async () => {
  await closeAll();
});

describe('ADR-0040 2D-2 — anniversary earned-accrual cycle', () => {
  it('accrues from the most-recent hire-month anniversary, not 1 Jan', async () => {
    await setCycle('anniversary');
    const emp = await hire('2024-07-15');
    // asOf 2026-01-15: the current cycle started 2025-07-01 (last July ≤ Jan 2026); Jul→Jan = 7 months.
    await run('2026-01-15');
    expect(await balanceOf(emp.employmentId)).toBe(7);
  });

  it("a joiner's first cycle starts at their hire month (auto pro-ration)", async () => {
    await setCycle('anniversary');
    const emp = await hire('2026-03-10'); // hire month March, asOf June → Mar..Jun = 4 months
    await run('2026-06-15');
    expect(await balanceOf(emp.employmentId)).toBe(4);
  });

  it('is idempotent within a cycle and starts a fresh accrual window at the next anniversary', async () => {
    await setCycle('anniversary');
    const emp = await hire('2024-07-15');
    await run('2025-06-30'); // full cycle 2024-07..2025-06 = 12
    expect(await balanceOf(emp.employmentId)).toBe(12);
    const again = await run('2025-06-30'); // idempotent — nothing new
    expect(again.granted).toBe(0);
    expect(await balanceOf(emp.employmentId)).toBe(12);
    const next = await run('2025-07-15'); // crossed the 2025 anniversary → new cycle's first month
    expect(next.granted).toBe(1);
    // The new cycle accrues 1 fresh day; the prior cycle's 12 still carry (cycle-boundary forfeit is the
    // deferred 2D-3 — until then earned leave carries forward uncapped). So balance = 12 + 1.
    expect(await balanceOf(emp.employmentId)).toBe(13);
  });

  it('the calendar cycle (default) accrues from 1 Jan for the same hire — proving the switch matters', async () => {
    await setCycle('calendar');
    const emp = await hire('2024-07-15');
    await run('2026-01-15'); // calendar: only Jan 2026 has elapsed this cycle → 1
    expect(await balanceOf(emp.employmentId)).toBe(1);
  });
});
