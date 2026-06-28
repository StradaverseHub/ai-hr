/**
 * ADR-0033 33-3 — Leave-in-lieu (TOIL) core. A worked rest-day's OT is banked as a REPLACEMENT-leave credit
 * instead of cash. The statutory boundary is the spine of these tests: a First-Schedule-eligible (≤ ceiling)
 * employee can only accrue when the company toggle is on, and then with forced convert-on-expiry; the same
 * worked day is cash XOR TOIL (the OT-pay prefill excludes a banked day). Gated by TOIL_ENABLED.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { checkIn, checkOut } from '../core/attendance';
import { setRestDay } from '../core/roster';
import { createBatch, prefillOvertimeFromAttendance } from '../core/payroll';
import {
  accrueToil,
  setToilPolicy,
  ToilAlreadyAccruedError,
  ToilDisabledError,
  ToilNotEligibleError,
  type ToilPolicyInput,
} from '../core/toil';

let b: Base;
const REST_DAY = '2026-07-04'; // a Saturday; setRestDay makes it a rostered rest day regardless
const uniqEmail = () => `toil_${Math.random().toString(36).slice(2)}@t.local`;

const policy = (companyId: string, over: Partial<ToilPolicyInput> = {}): ToilPolicyInput => ({
  companyId,
  enabled: true,
  accrualBasis: 'hours_worked',
  expiryDays: 90,
  onExpiry: 'convert_to_pay',
  allowFirstScheduleEligible: false,
  autoAccrueOnApproval: false,
  carryForwardAtYearEnd: false,
  ...over,
});

/** Hire at a given basic wage and work a full rostered rest day ⇒ dayType rest_day, otMinutes 480. */
async function hireWithWorkedRestDay(basic: number) {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Lieu Worker', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  await setRestDay(a, { employmentId: e.employmentId, shiftDate: REST_DAY });
  await checkIn(a, { employmentId: e.employmentId, date: REST_DAY, time: '08:00:00' });
  await checkOut(a, { employmentId: e.employmentId, date: REST_DAY, time: '17:00:00' }); // 540 span − 60 break = 480 OT
  return { a, employmentId: e.employmentId };
}

async function replacementBalance(employmentId: string): Promise<number> {
  const [row] = await owner.db
    .select({ bal: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .innerJoin(schema.leaveType, eq(schema.leaveType.id, schema.leaveLedger.leaveTypeId))
    .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveType.code, 'REPLACEMENT')));
  return Number(row?.bal ?? 0);
}
const accrualRow = async (employmentId: string) =>
  (await owner.db.select().from(schema.toilAccrual).where(eq(schema.toilAccrual.employmentId, employmentId)))[0];

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
afterEach(() => {
  delete process.env.TOIL_ENABLED;
});

describe('TOIL core (ADR-0033 33-3)', () => {
  it('is gated: accrueToil refuses when TOIL_ENABLED is off', async () => {
    const { a, employmentId } = await hireWithWorkedRestDay(5000);
    await setToilPolicy(a, policy(b.companyId)); // policy row exists, but the env flag is off
    await expect(accrueToil(a, { employmentId, workedDate: REST_DAY })).rejects.toBeInstanceOf(ToilDisabledError);
  });

  it('banks 1.0 day (hours_worked) for a non-First-Schedule employee (> ceiling) — no warning', async () => {
    process.env.TOIL_ENABLED = 'true';
    const { a, employmentId } = await hireWithWorkedRestDay(5000); // > RM4,000 ⇒ not eligible ⇒ TOIL free
    await setToilPolicy(a, policy(b.companyId));
    const r = await accrueToil(a, { employmentId, workedDate: REST_DAY });
    expect(r.daysCredited).toBe(1); // 480 / 480
    expect(r.forcedConvertOnExpiry).toBe(false);
    expect(r.complianceWarning).toBeUndefined();
    expect(await replacementBalance(employmentId)).toBe(1);
    const acc = await accrualRow(employmentId);
    expect(acc.status).toBe('active');
    expect(acc.dayType).toBe('rest_day');
    expect(acc.expiresOn).toBe('2026-10-02'); // REST_DAY + 90d
  });

  it('refuses a First-Schedule employee (≤ ceiling) when the toggle is OFF', async () => {
    process.env.TOIL_ENABLED = 'true';
    const { a, employmentId } = await hireWithWorkedRestDay(3000); // ≤ RM4,000 ⇒ statutory OT applies
    await setToilPolicy(a, policy(b.companyId, { allowFirstScheduleEligible: false }));
    await expect(accrueToil(a, { employmentId, workedDate: REST_DAY })).rejects.toBeInstanceOf(ToilNotEligibleError);
    expect(await replacementBalance(employmentId)).toBe(0);
  });

  it('allows the First-Schedule employee when the toggle is ON + per-election consent — forced convert + compliance warning', async () => {
    process.env.TOIL_ENABLED = 'true';
    const { a, employmentId } = await hireWithWorkedRestDay(3000);
    await setToilPolicy(a, policy(b.companyId, { allowFirstScheduleEligible: true }));
    // Phase-B #14: the toggle ON is no longer enough on its own — explicit per-election consent is required.
    const r = await accrueToil(a, { employmentId, workedDate: REST_DAY, firstScheduleConsent: true });
    expect(r.daysCredited).toBe(1);
    expect(r.forcedConvertOnExpiry).toBe(true);
    expect(r.complianceWarning).toMatch(/convert to pay/i);
    expect(await replacementBalance(employmentId)).toBe(1);
  });

  it('premium_equivalent banks the uplifted time (rest_day ×2)', async () => {
    process.env.TOIL_ENABLED = 'true';
    const { a, employmentId } = await hireWithWorkedRestDay(5000);
    await setToilPolicy(a, policy(b.companyId, { accrualBasis: 'premium_equivalent' }));
    const r = await accrueToil(a, { employmentId, workedDate: REST_DAY });
    expect(r.daysCredited).toBe(2); // 480 / 480 × 2.0
    expect(await replacementBalance(employmentId)).toBe(2);
  });

  it('refuses a second accrual for the same day', async () => {
    process.env.TOIL_ENABLED = 'true';
    const { a, employmentId } = await hireWithWorkedRestDay(5000);
    await setToilPolicy(a, policy(b.companyId));
    await accrueToil(a, { employmentId, workedDate: REST_DAY });
    await expect(accrueToil(a, { employmentId, workedDate: REST_DAY })).rejects.toBeInstanceOf(ToilAlreadyAccruedError);
  });

  it('no double-pay: OT-pay prefill monetises an un-banked day but excludes a TOIL-banked one', async () => {
    process.env.TOIL_ENABLED = 'true';
    // Two eligible employees, same company, both worked the same rest day. One banks it as TOIL.
    const A = await hireWithWorkedRestDay(3000); // not banked ⇒ cash OT
    const B = await hireWithWorkedRestDay(3000); // banked ⇒ excluded from cash OT
    await setToilPolicy(A.a, policy(b.companyId, { allowFirstScheduleEligible: true }));
    await accrueToil(B.a, { employmentId: B.employmentId, workedDate: REST_DAY, firstScheduleConsent: true });
    // One company-wide July batch covers both; only A's rest-day OT should be monetised.
    const { batchId } = await createBatch(A.a, { companyId: b.companyId, payPeriod: '2026-07' });
    expect((await prefillOvertimeFromAttendance(A.a, { batchId })).applied).toBe(1);
  });
});
