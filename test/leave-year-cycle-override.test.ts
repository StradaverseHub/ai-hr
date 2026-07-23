/**
 * Leave Year Type override (feedback e1a51aea, migration 0303).
 *
 * The General step's "Leave Year Type" sub-step stores a per-TYPE override of the company leave cycle in
 * leave_type.year_cycle_override: 'a2a' (Anniversary to Anniversary ⇒ the existing 'anniversary'
 * semantics) | 'c2c' (Calendar to Calendar ⇒ the existing 'calendar' semantics) | null (follow the
 * company cycle — today's exact behaviour). Every per-type engine consumer of company.leave_cycle
 * resolves through the ONE resolveLeaveYearCycle helper.
 *
 * Under test:
 *  (1) resolveLeaveYearCycle — a2a/c2c map to anniversary/calendar; null/unknown fall back to company.
 *  (2) updateLeaveType persistence — a2a/c2c store; null clears; tri-state (an unrelated save preserves).
 *  (3) 'a2c' (the disabled-pending-engine hybrid) and garbage values are REJECTED — the option renders
 *      disabled in the UI, and the service refuses a hand-crafted POST rather than storing a value the
 *      engine cannot compute (the plan's explicit no-new-calculation-semantics discipline).
 *  (4) engine honor — earned-monthly accrual anchors its cycle at the type's overridden cycle:
 *      calendar company + a2a override ⇒ hire-anniversary window; anniversary company + c2c override ⇒
 *      calendar window; null ⇒ company cycle (byte-identical fallback).
 */
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createLeavePolicy, setCompanyLeaveCycle, updateLeaveType } from '../core/admin';
import { accrueEarnedLeave, resolveLeaveYearCycle } from '../core/leave';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const uniqEmail = () => `ycycle_${randomUUID().slice(0, 8)}@t.local`;

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

const storedOverride = async () => {
  const [row] = await owner.db
    .select({ v: schema.leaveType.yearCycleOverride })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
  return row?.v ?? null;
};

const setOverride = (v: string | null) =>
  updateLeaveType(adminCtx(b), { id: b.annualLeaveTypeId, name: 'Annual Leave', yearCycleOverride: v });

/** Earned-monthly 12 days/yr policy + one employee hired mid-2025. At asOf 2026-03-31 the elapsed-period
 *  count separates the two cycles cleanly: calendar window (2026-01-01) ⇒ 3 periods ⇒ 3 days; hire-month
 *  anniversary window (2025-07-01) ⇒ 9 periods ⇒ 9 days. */
const ASOF = '2026-03-31';
const seedEarned = async () => {
  await createLeavePolicy(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays: 12,
    method: 'earned_monthly',
    validFrom: '2025-01-01',
  });
  const emp = await hireEmployee(adminCtx(b), {
    person: { fullName: 'Cycle Emp', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2025-07-15',
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });
  return emp.employmentId;
};

describe('e1a51aea — resolveLeaveYearCycle', () => {
  it('a2a/c2c override the company cycle; null/unknown fall back', () => {
    expect(resolveLeaveYearCycle('a2a', 'calendar')).toBe('anniversary');
    expect(resolveLeaveYearCycle('c2c', 'anniversary')).toBe('calendar');
    expect(resolveLeaveYearCycle(null, 'anniversary')).toBe('anniversary');
    expect(resolveLeaveYearCycle(null, 'calendar')).toBe('calendar');
    expect(resolveLeaveYearCycle(undefined, 'calendar')).toBe('calendar');
    // Defensive: an unknown stored value never invents semantics — company cycle wins.
    expect(resolveLeaveYearCycle('a2c', 'calendar')).toBe('calendar');
  });
});

describe('e1a51aea — updateLeaveType persistence + validation', () => {
  it('stores a2a / c2c, clears with null, and an unrelated save preserves it (tri-state)', async () => {
    await setOverride('a2a');
    expect(await storedOverride()).toBe('a2a');

    // Unrelated sub-form save (no yearCycleOverride key) must NOT reset the column.
    await updateLeaveType(adminCtx(b), { id: b.annualLeaveTypeId, name: 'Annual Leave' });
    expect(await storedOverride()).toBe('a2a');

    await setOverride('c2c');
    expect(await storedOverride()).toBe('c2c');

    await setOverride(null);
    expect(await storedOverride()).toBeNull();
  });

  it("rejects the disabled-pending-engine 'a2c' hybrid with its specific message", async () => {
    await expect(setOverride('a2c')).rejects.toThrow(/not available yet/i);
    expect(await storedOverride()).toBeNull();
  });

  it('rejects values outside the closed { a2a, c2c } set', async () => {
    await expect(setOverride('anniversary')).rejects.toThrow(/leave year type/i);
    expect(await storedOverride()).toBeNull();
  });
});

describe('e1a51aea — the earned-accrual engine honors the per-type cycle', () => {
  it('calendar company + a2a override ⇒ the hire-month anniversary window drives accrual', async () => {
    const employmentId = await seedEarned(); // company cycle: calendar (schema default)
    await setOverride('a2a');
    await accrueEarnedLeave(adminCtx(b), { asOf: ASOF });
    // Anniversary window 2025-07-01 → 9 elapsed periods × 1 day.
    expect(await ledgerBalance(employmentId, b.annualLeaveTypeId)).toBe(9);
  });

  it('calendar company + NO override ⇒ unchanged calendar window (backward-compatible fallback)', async () => {
    const employmentId = await seedEarned();
    await accrueEarnedLeave(adminCtx(b), { asOf: ASOF });
    // Calendar window 2026-01-01 → 3 elapsed periods × 1 day.
    expect(await ledgerBalance(employmentId, b.annualLeaveTypeId)).toBe(3);
  });

  it('anniversary company + c2c override ⇒ the calendar window drives accrual', async () => {
    await setCompanyLeaveCycle(adminCtx(b), { companyId: b.companyId, cycle: 'anniversary' });
    const employmentId = await seedEarned();
    await setOverride('c2c');
    await accrueEarnedLeave(adminCtx(b), { asOf: ASOF });
    expect(await ledgerBalance(employmentId, b.annualLeaveTypeId)).toBe(3);
  });

  it('anniversary company + NO override ⇒ unchanged anniversary window (fallback)', async () => {
    await setCompanyLeaveCycle(adminCtx(b), { companyId: b.companyId, cycle: 'anniversary' });
    const employmentId = await seedEarned();
    await accrueEarnedLeave(adminCtx(b), { asOf: ASOF });
    expect(await ledgerBalance(employmentId, b.annualLeaveTypeId)).toBe(9);
  });
});
