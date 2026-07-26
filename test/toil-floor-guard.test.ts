/**
 * Phase-B #14 (audit #14) — TOIL OT-floor guard + safer First-Schedule default (ADR-0033 addendum, 2026-06-28).
 *
 * Three statutory-floor invariants for First-Schedule (≤ RM4,000) employees:
 *  1. Accrual is BLOCKED without an explicit per-election consent flag, even when the company toggle is ON
 *     (the toggle alone must not be a blanket default). > RM4,000 employees are unaffected.
 *  2. Convert-to-pay reconciles to the EXACT s.60(3)/s.60D(3) cash for the worked day-type (reusing the
 *     localization overtimePay math), NOT a generic daysCredited × ORP — so a premium_equivalent-banked
 *     rest day (2 banked days) still converts to exactly 1 day's ORP per s.60(3)(b).
 *  3. premium_equivalent banking for a First-Schedule employee surfaces a warning (the banked credit may
 *     not reproduce the exact statutory cash) without hard-blocking the consent-gated election.
 *
 * ADR-0077 slice 3: the whole-module gate is the per-tenant `toil` ENTITLEMENT ROW, not the TOIL_ENABLED
 * deployment flag. Nothing in this file TESTS that gate — every invariant above is a statutory-floor rule
 * that lives BEHIND it — so the module is simply granted for the tenant in `beforeEach`, which is exactly
 * what the old `TOIL_ENABLED = 'true'` env write meant here. The gate itself (a missing row ⇒
 * ToilDisabledError) is covered by test/toil.test.ts.
 *
 * The gated entry points (`accrueToil`, `runToilExpiry`) are driven through `entitledCtx` — a REAL
 * snapshot resolved from this tenant's rows. `adminCtx` derives its snapshot from
 * `legacyEnabledModulesIn(process.env)`, and `toil` is not in that parity set, so an adminCtx can never
 * see the grant no matter what is written to the database. Un-gated setup calls (hire, compensation,
 * roster, attendance, `setToilPolicy`) are unaffected either way.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import {
  adminCtx,
  closeAll,
  entitledCtx,
  latestEventPayload,
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
import { accrueToil, runToilExpiry, setToilPolicy, ToilNotEligibleError, type ToilPolicyInput } from '../core/toil';

let b: Base;
const REST_DAY = '2026-07-04';
const AFTER_EXPIRY = '2026-10-15'; // > REST_DAY + 90d (2026-10-02)
const uniqEmail = () => `tfg_${Math.random().toString(36).slice(2)}@t.local`;

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

/**
 * Hire at a basic wage and work a full rostered rest day ⇒ dayType rest_day, otMinutes 480.
 *
 * Returns an `entitledCtx` (slice 3): every caller goes on to call `accrueToil`, which is module-gated,
 * and the `toil` row granted in `beforeEach` is only visible through a real snapshot. Resolving it here
 * is safe because the grant happened before the test body ran — the snapshot is a point-in-time read.
 */
async function hireWithWorkedRestDay(basic: number) {
  const a = await entitledCtx(b);
  const e = await hireEmployee(a, {
    person: { fullName: 'Floor Guard', primaryEmail: uniqEmail() },
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

beforeAll(async () => {
  await migrateTestDb();
});
afterAll(async () => {
  await closeAll();
});
beforeEach(async () => {
  await resetDb();
  b = await seedBase();
  // ADR-0077 slice 3: TOIL is a per-tenant MODULE ENTITLEMENT, not a deployment flag. `toil` is absent
  // from LEGACY_ENABLED_MODULE_CODES, so seedBase seeds NO row for it and a missing row is DISABLED
  // (C7) — granting it here is precisely what the old `TOIL_ENABLED = 'true'` env write meant. No
  // afterEach counterpart is needed: resetDb() truncates tenant_module before every test, so OFF is the
  // baseline by construction rather than by teardown.
  await setModule(b.tenantId, 'toil', 'active');
});

describe('TOIL OT-floor guard — safer First-Schedule default (consent)', () => {
  it('blocks a First-Schedule accrual when the toggle is ON but no per-election consent is given', async () => {
    const { a, employmentId } = await hireWithWorkedRestDay(3000); // ≤ RM4,000 ⇒ First Schedule
    await setToilPolicy(a, policy(b.companyId, { allowFirstScheduleEligible: true }));
    // Toggle ON but NO firstScheduleConsent ⇒ still refused (the toggle alone is not a blanket default).
    await expect(accrueToil(a, { employmentId, workedDate: REST_DAY })).rejects.toBeInstanceOf(ToilNotEligibleError);
    expect(await replacementBalance(employmentId)).toBe(0);
  });

  it('allows a First-Schedule accrual when the toggle is ON AND per-election consent is given', async () => {
    const { a, employmentId } = await hireWithWorkedRestDay(3000);
    await setToilPolicy(a, policy(b.companyId, { allowFirstScheduleEligible: true }));
    const r = await accrueToil(a, { employmentId, workedDate: REST_DAY, firstScheduleConsent: true });
    expect(r.daysCredited).toBe(1);
    expect(r.forcedConvertOnExpiry).toBe(true);
    expect(await replacementBalance(employmentId)).toBe(1);
  });

  it('consent flag is ignored for a non-First-Schedule (> RM4,000) employee — path unchanged, no consent needed', async () => {
    const { a, employmentId } = await hireWithWorkedRestDay(5000); // > RM4,000 ⇒ not First Schedule
    await setToilPolicy(a, policy(b.companyId));
    const r = await accrueToil(a, { employmentId, workedDate: REST_DAY }); // no consent param
    expect(r.daysCredited).toBe(1);
    expect(r.forcedConvertOnExpiry).toBe(false);
    expect(r.complianceWarning).toBeUndefined();
    expect(await replacementBalance(employmentId)).toBe(1);
  });
});

describe('TOIL OT-floor guard — exact-quantum convert-to-pay (s.60(3))', () => {
  it('a premium_equivalent-banked First-Schedule rest day converts to exactly 1 day ORP per s.60(3)(b), not 2× the banked days', async () => {
    // premium_equivalent banks 2.0 days for a full rest day, but the statutory cash is 1 day's ORP.
    const { a, employmentId } = await hireWithWorkedRestDay(3000);
    await setToilPolicy(a, policy(b.companyId, { allowFirstScheduleEligible: true, accrualBasis: 'premium_equivalent' }));
    const acc = await accrueToil(a, { employmentId, workedDate: REST_DAY, firstScheduleConsent: true });
    expect(acc.daysCredited).toBe(2); // 480/480 × 2.0 banked
    expect(await replacementBalance(employmentId)).toBe(2);

    // `runToilExpiry` is module-gated: entitledCtx, not adminCtx, is what carries this tenant's `toil` row.
    const r = await runToilExpiry(await entitledCtx(b), { today: AFTER_EXPIRY });
    expect(r.converted).toBe(1);
    // Exact s.60(3)(b): a full normal-hours rest day = 1 day's ORP = 3000/26 = 115.38 — NOT 2 × 115.38.
    expect(r.convertedAmount).toBe(115.38);

    const payload = await latestEventPayload(b.tenantId, acc.accrualId, 'toil.converted');
    expect(payload?.amountOwed).toBe(115.38);
    expect(payload?.valuationBasis).toBe('statutory_exact'); // reconciled to s.60(3)/s.60D(3), not generic ORP×days
  });

  it('a > RM4,000 employee still converts at the generic ORP × banked-days basis (path unchanged)', async () => {
    const { a, employmentId } = await hireWithWorkedRestDay(5000); // not First Schedule
    await setToilPolicy(a, policy(b.companyId, { accrualBasis: 'premium_equivalent', onExpiry: 'convert_to_pay' }));
    const acc = await accrueToil(a, { employmentId, workedDate: REST_DAY });
    expect(acc.daysCredited).toBe(2); // 2.0 banked days

    const r = await runToilExpiry(await entitledCtx(b), { today: AFTER_EXPIRY });
    expect(r.converted).toBe(1);
    // Generic basis: 2 banked days × (5000/26) = 2 × 192.31 = 384.62 (contractual, no statutory floor applies).
    expect(r.convertedAmount).toBe(384.62);

    const payload = await latestEventPayload(b.tenantId, acc.accrualId, 'toil.converted');
    expect(payload?.valuationBasis).toBe('generic_orp');
  });
});

describe('TOIL OT-floor guard — premium_equivalent warning for First-Schedule', () => {
  it('warns at accrual when premium_equivalent banking is used for a First-Schedule employee', async () => {
    const { a, employmentId } = await hireWithWorkedRestDay(3000);
    await setToilPolicy(a, policy(b.companyId, { allowFirstScheduleEligible: true, accrualBasis: 'premium_equivalent' }));
    const r = await accrueToil(a, { employmentId, workedDate: REST_DAY, firstScheduleConsent: true });
    expect(r.premiumEquivalentWarning).toMatch(/statutory/i);
    const payload = await latestEventPayload(b.tenantId, r.accrualId, 'toil.accrued');
    expect(payload?.premiumEquivalentWarning).toBe(true);
  });

  it('does not warn for the hours_worked basis (exact-quantum is reproducible)', async () => {
    const { a, employmentId } = await hireWithWorkedRestDay(3000);
    await setToilPolicy(a, policy(b.companyId, { allowFirstScheduleEligible: true, accrualBasis: 'hours_worked' }));
    const r = await accrueToil(a, { employmentId, workedDate: REST_DAY, firstScheduleConsent: true });
    expect(r.premiumEquivalentWarning).toBeUndefined();
  });

  it('warns at policy save when premium_equivalent + allowFirstScheduleEligible are both set', async () => {
    const a = adminCtx(b);
    const r = await setToilPolicy(a, policy(b.companyId, { accrualBasis: 'premium_equivalent', allowFirstScheduleEligible: true }));
    expect(r.premiumEquivalentWarning).toMatch(/statutory/i);
  });

  it('no policy-save warning for hours_worked or when First-Schedule staff are not allowed', async () => {
    const a = adminCtx(b);
    const r1 = await setToilPolicy(a, policy(b.companyId, { accrualBasis: 'premium_equivalent', allowFirstScheduleEligible: false }));
    expect(r1.premiumEquivalentWarning).toBeUndefined();
    const r2 = await setToilPolicy(a, policy(b.companyId, { accrualBasis: 'hours_worked', allowFirstScheduleEligible: true }));
    expect(r2.premiumEquivalentWarning).toBeUndefined();
  });
});
