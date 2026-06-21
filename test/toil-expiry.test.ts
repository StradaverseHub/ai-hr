/**
 * ADR-0033 33-4 — TOIL expiry sweep. An expired active accrual follows its frozen expiry_action: convert to
 * pay (debit the replacement-leave credit + record the owed ORP value, no auto-disbursement) or lapse (debit +
 * forfeit). The floor protection is verified end-to-end: an eligible employee's TOIL converts (set at accrual),
 * never lapses. Idempotent + gated. today is injected.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { adminCtx, closeAll, eventTypesFor, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';
import { hireEmployee } from '../core/org';
import { setCompensation } from '../core/comp';
import { checkIn, checkOut } from '../core/attendance';
import { setRestDay } from '../core/roster';
import { accrueToil, runToilExpiry, setToilPolicy, ToilDisabledError, type ToilPolicyInput } from '../core/toil';

let b: Base;
const REST_DAY = '2026-07-04';
const AFTER_EXPIRY = '2026-10-15'; // > REST_DAY + 90d (2026-10-02)
const BEFORE_EXPIRY = '2026-09-01';
const uniqEmail = () => `tex_${Math.random().toString(36).slice(2)}@t.local`;

const policy = (companyId: string, over: Partial<ToilPolicyInput> = {}): ToilPolicyInput => ({
  companyId,
  enabled: true,
  accrualBasis: 'hours_worked',
  expiryDays: 90,
  onExpiry: 'convert_to_pay',
  allowFirstScheduleEligible: false,
  ...over,
});

/** Hire at a wage, work a rest day, set the policy, and bank the TOIL (1.0 day). Returns the accrual id. */
async function accrue(basic: number, over: Partial<ToilPolicyInput> = {}) {
  const a = adminCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Exp', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: '2024-01-01',
  });
  await setCompensation(a, { employmentId: e.employmentId, basicSalary: basic, monthlyAllowance: 0, effectiveFrom: '2024-01-01' });
  await setToilPolicy(a, policy(b.companyId, over));
  await setRestDay(a, { employmentId: e.employmentId, shiftDate: REST_DAY });
  await checkIn(a, { employmentId: e.employmentId, date: REST_DAY, time: '08:00:00' });
  await checkOut(a, { employmentId: e.employmentId, date: REST_DAY, time: '17:00:00' });
  const r = await accrueToil(a, { employmentId: e.employmentId, workedDate: REST_DAY });
  return { a, employmentId: e.employmentId, accrualId: r.accrualId };
}

async function replacementBalance(employmentId: string): Promise<number> {
  const [row] = await owner.db
    .select({ bal: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .innerJoin(schema.leaveType, eq(schema.leaveType.id, schema.leaveLedger.leaveTypeId))
    .where(and(eq(schema.leaveLedger.employmentId, employmentId), eq(schema.leaveType.code, 'REPLACEMENT')));
  return Number(row?.bal ?? 0);
}
const statusOf = async (accrualId: string) =>
  (await owner.db.select({ s: schema.toilAccrual.status }).from(schema.toilAccrual).where(eq(schema.toilAccrual.id, accrualId)))[0]?.s;

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  process.env.TOIL_ENABLED = 'true';
});
afterEach(() => {
  delete process.env.TOIL_ENABLED;
});

describe('TOIL expiry sweep (ADR-0033 33-4)', () => {
  it('converts an eligible employee to pay (forced), debits the credit, records the owed ORP', async () => {
    const { employmentId, accrualId } = await accrue(3000, { allowFirstScheduleEligible: true }); // ≤ ceiling ⇒ convert forced
    expect(await replacementBalance(employmentId)).toBe(1);
    const r = await runToilExpiry(adminCtx(b), { today: AFTER_EXPIRY });
    expect(r).toMatchObject({ processed: 1, converted: 1, lapsed: 0, convertedDays: 1 });
    expect(r.convertedAmount).toBe(115.38); // 1 day × (3000 / 26)
    expect(await statusOf(accrualId)).toBe('converted_to_pay');
    expect(await replacementBalance(employmentId)).toBe(0); // credit debited
    expect(await eventTypesFor(b.tenantId, accrualId)).toContain('toil.converted');
  });

  it('lapses when the policy says lapse for a non-First-Schedule employee', async () => {
    const { employmentId, accrualId } = await accrue(5000, { onExpiry: 'lapse' }); // > ceiling ⇒ policy applies
    const r = await runToilExpiry(adminCtx(b), { today: AFTER_EXPIRY });
    expect(r).toMatchObject({ processed: 1, converted: 0, lapsed: 1, convertedAmount: 0 });
    expect(await statusOf(accrualId)).toBe('lapsed');
    expect(await replacementBalance(employmentId)).toBe(0); // forfeited
    expect(await eventTypesFor(b.tenantId, accrualId)).toContain('toil.lapsed');
  });

  it('converts a non-eligible employee when the policy says convert_to_pay', async () => {
    const { accrualId } = await accrue(5000, { onExpiry: 'convert_to_pay' });
    const r = await runToilExpiry(adminCtx(b), { today: AFTER_EXPIRY });
    expect(r).toMatchObject({ processed: 1, converted: 1, lapsed: 0 });
    expect(await statusOf(accrualId)).toBe('converted_to_pay');
  });

  it('leaves a not-yet-expired accrual untouched', async () => {
    const { employmentId, accrualId } = await accrue(5000, { onExpiry: 'lapse' });
    const r = await runToilExpiry(adminCtx(b), { today: BEFORE_EXPIRY });
    expect(r.processed).toBe(0);
    expect(await statusOf(accrualId)).toBe('active');
    expect(await replacementBalance(employmentId)).toBe(1);
  });

  it('is idempotent — a second run processes nothing', async () => {
    await accrue(5000, { onExpiry: 'lapse' });
    expect((await runToilExpiry(adminCtx(b), { today: AFTER_EXPIRY })).processed).toBe(1);
    expect((await runToilExpiry(adminCtx(b), { today: AFTER_EXPIRY })).processed).toBe(0);
  });

  it('is gated — refuses when TOIL_ENABLED is off', async () => {
    await accrue(5000, { onExpiry: 'lapse' });
    delete process.env.TOIL_ENABLED;
    await expect(runToilExpiry(adminCtx(b), { today: AFTER_EXPIRY })).rejects.toBeInstanceOf(ToilDisabledError);
  });
});
