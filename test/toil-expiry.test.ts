/**
 * ADR-0033 33-4 — TOIL expiry sweep. An expired active accrual follows its frozen expiry_action: convert to
 * pay (debit the replacement-leave credit + record the owed ORP value, no auto-disbursement) or lapse (debit +
 * forfeit). The floor protection is verified end-to-end: an eligible employee's TOIL converts (set at accrual),
 * never lapses. Idempotent + gated. today is injected.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import {
  closeAll,
  entitledCtx,
  eventTypesFor,
  migrateTestDb,
  owner,
  resetDb,
  seedBase,
  setModule,
  type Base,
} from './harness';
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
  autoAccrueOnApproval: false,
  carryForwardAtYearEnd: false,
  ...over,
});

/** Hire at a wage, work a rest day, set the policy, and bank the TOIL (1.0 day). Returns the accrual id. */
async function accrue(basic: number, over: Partial<ToilPolicyInput> = {}) {
  // `entitledCtx`, not `adminCtx`: `accrueToil` is gated on the `toil` module, and `adminCtx` carries a
  // snapshot derived from `legacyEnabledModulesIn(process.env)` — a set `toil` is absent from
  // (LEGACY_MODULE_ENV_GATES.toil = 'TOIL_ENABLED', which no tracked env file sets). It therefore reports
  // toil DISABLED no matter what rows the tenant has, so the beforeEach grant below would be invisible to
  // it and every accrual here would throw ToilDisabledError. `entitledCtx` resolves from the actual rows.
  const a = await entitledCtx(b);
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
  // Phase-B #14: pass per-election consent (moot for > ceiling employees, required for First-Schedule ones).
  const r = await accrueToil(a, { employmentId: e.employmentId, workedDate: REST_DAY, firstScheduleConsent: true });
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
  // ADR-0077 slice 3: TOIL is a per-tenant entitlement, not a deployment flag. `seedBase` seeds NO
  // `toil` row (it is absent from LEGACY_ENABLED_MODULE_CODES), and a missing row is DISABLED — so the
  // module has to be switched on for this tenant, which is what the old `TOIL_ENABLED = 'true'` meant.
  // No teardown counterpart is needed: `resetDb()` truncates `tenant_module` before every test.
  await setModule(b.tenantId, 'toil', 'active');
});

describe('TOIL expiry sweep (ADR-0033 33-4)', () => {
  it('converts an eligible employee to pay (forced), debits the credit, records the owed ORP', async () => {
    const { employmentId, accrualId } = await accrue(3000, { allowFirstScheduleEligible: true }); // ≤ ceiling ⇒ convert forced
    expect(await replacementBalance(employmentId)).toBe(1);
    const r = await runToilExpiry(await entitledCtx(b), { today: AFTER_EXPIRY });
    expect(r).toMatchObject({ processed: 1, converted: 1, lapsed: 0, convertedDays: 1 });
    expect(r.convertedAmount).toBe(115.38); // 1 day × (3000 / 26)
    expect(await statusOf(accrualId)).toBe('converted_to_pay');
    expect(await replacementBalance(employmentId)).toBe(0); // credit debited
    expect(await eventTypesFor(b.tenantId, accrualId)).toContain('toil.converted');
  });

  it('lapses when the policy says lapse for a non-First-Schedule employee', async () => {
    const { employmentId, accrualId } = await accrue(5000, { onExpiry: 'lapse' }); // > ceiling ⇒ policy applies
    const r = await runToilExpiry(await entitledCtx(b), { today: AFTER_EXPIRY });
    expect(r).toMatchObject({ processed: 1, converted: 0, lapsed: 1, convertedAmount: 0 });
    expect(await statusOf(accrualId)).toBe('lapsed');
    expect(await replacementBalance(employmentId)).toBe(0); // forfeited
    expect(await eventTypesFor(b.tenantId, accrualId)).toContain('toil.lapsed');
  });

  it('converts a non-eligible employee when the policy says convert_to_pay', async () => {
    const { accrualId } = await accrue(5000, { onExpiry: 'convert_to_pay' });
    const r = await runToilExpiry(await entitledCtx(b), { today: AFTER_EXPIRY });
    expect(r).toMatchObject({ processed: 1, converted: 1, lapsed: 0 });
    expect(await statusOf(accrualId)).toBe('converted_to_pay');
  });

  it('leaves a not-yet-expired accrual untouched', async () => {
    const { employmentId, accrualId } = await accrue(5000, { onExpiry: 'lapse' });
    const r = await runToilExpiry(await entitledCtx(b), { today: BEFORE_EXPIRY });
    expect(r.processed).toBe(0);
    expect(await statusOf(accrualId)).toBe('active');
    expect(await replacementBalance(employmentId)).toBe(1);
  });

  it('is idempotent — a second run processes nothing', async () => {
    await accrue(5000, { onExpiry: 'lapse' });
    // One snapshot, reused: the entitlement does not change between the two runs, and re-resolving would
    // test the resolver rather than the sweep's idempotency.
    const ctx = await entitledCtx(b);
    expect((await runToilExpiry(ctx, { today: AFTER_EXPIRY })).processed).toBe(1);
    expect((await runToilExpiry(ctx, { today: AFTER_EXPIRY })).processed).toBe(0);
  });

  it('is gated — refuses when the tenant is not entitled to the toil module', async () => {
    await accrue(5000, { onExpiry: 'lapse' });
    // Driven through `entitledCtx` — a REAL snapshot resolved from this tenant's rows, so revoking the row
    // below actually changes the answer. (`adminCtx` could not show this either: its snapshot is derived
    // from the env parity set, which never contains `toil`, so it would refuse both before AND after the
    // revocation and prove nothing about the grant.)
    await expect(runToilExpiry(await entitledCtx(b), { today: AFTER_EXPIRY })).resolves.toMatchObject({
      processed: 1,
      lapsed: 1,
    });
    // Now revoke the entitlement (no row ⇒ disabled, C7) and re-resolve — the snapshot is point-in-time.
    await setModule(b.tenantId, 'toil', null);
    const revoked = await entitledCtx(b);
    // Nothing is left to sweep, so an OPEN gate would return processed: 0 here. Only the closed gate throws.
    await expect(runToilExpiry(revoked, { today: AFTER_EXPIRY })).rejects.toBeInstanceOf(ToilDisabledError);
  });
});
