/**
 * ADR-0040 2D-2 — anniversary earned-accrual cycle. With company.leave_cycle='anniversary', each
 * employee's earned-accrual cycle is anchored to their hire-month anniversary (not the calendar 1 Jan).
 * accrueEarnedLeave then accrues from the most-recent anniversary on/before asOf, idempotently. The
 * entitlement here is 12 days on a 12-month cycle, so earned-to-date == elapsed periods.
 *
 * 6e9a126e RELEASE THREE — REPOINTED. Same 12 days, same cycle, same expected balances; the configuration
 * moved. The days come from an entitlement template valid from 2024-01-01 (covering every asOf below) and
 * the earning method from the leave TYPE's `accrual_method` column. No carry cap is configured in either
 * place, exactly as the old JSONB configured none — which is what makes the anniversary forfeit assertion
 * below still forfeit the whole 12.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { accrueEarnedLeave } from '../core/leave';
import { setCompanyLeaveCycle } from '../core/admin';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';

let b: Base;
const balanceOf = async (employmentId: string) => {
  const [r] = await owner.db
    .select({ bal: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveLedger.leaveTypeId, b.annualLeaveTypeId)));
  return Number(r.bal);
};
const setCycle = (cycle: string) => setCompanyLeaveCycle(adminCtx(b), { companyId: b.companyId, cycle });
const earnedPolicy = async () => {
  await seedEntitlement(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays: 12,
    validFrom: '2024-01-01',
  });
  await owner.db
    .update(schema.leaveType)
    .set({ accrualMethod: 'earned_monthly' })
    .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
};
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

  it('is idempotent within a cycle and forfeits the uncapped carry at the next anniversary (2D-3)', async () => {
    await setCycle('anniversary');
    const emp = await hire('2024-07-15');
    await run('2025-06-30'); // full cycle 2024-07..2025-06 = 12
    expect(await balanceOf(emp.employmentId)).toBe(12);
    const again = await run('2025-06-30'); // idempotent — nothing new (no accrual, no forfeit)
    expect(again.granted).toBe(0);
    expect(again.forfeits).toBe(0);
    expect(await balanceOf(emp.employmentId)).toBe(12);
    const next = await run('2025-07-15'); // crossed the 2025 anniversary
    expect(next.granted).toBe(1); // new cycle's first month accrues
    expect(next.forfeits).toBe(1); // 2D-3: prior cycle's 12 days forfeit (this policy sets no carry cap)
    expect(await balanceOf(emp.employmentId)).toBe(1); // 12 − 12 (forfeit) + 1 (new accrual)
    const reRun = await run('2025-07-15'); // idempotent — forfeit not posted twice
    expect(reRun.forfeits).toBe(0);
    expect(await balanceOf(emp.employmentId)).toBe(1);
  });

  it('the calendar cycle (default) accrues from 1 Jan for the same hire — proving the switch matters', async () => {
    await setCycle('calendar');
    const emp = await hire('2024-07-15');
    await run('2026-01-15'); // calendar: only Jan 2026 has elapsed this cycle → 1
    expect(await balanceOf(emp.employmentId)).toBe(1);
  });
});
