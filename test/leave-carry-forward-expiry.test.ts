/**
 * ADR-0038 (carry-forward enhancement) — carry-forward expiry / auto-forfeit for ANNUAL leave.
 *
 * "Maximum Carry Forward Days" (the carryForwardMax cap) already exists and is applied at year-open by
 * openLeaveYear. This suite covers the SECOND, later forfeit added here: the still-unconsumed carried
 * portion is forfeited on the policy's configured expiry date (carryForwardExpiryMonth/Day) via a dated
 * negative `adjustment`. No new schema; carried days stay folded into the plain `accrual` row, so read
 * aggregates and the earned path's `already`-sum are untouched.
 *
 * The anti-over-forfeit core (case b): forfeit = min(unconsumedCarry, currentBalance) — it caps at what
 * is actually still in the balance, so taking leave reduces what is forfeited and fresh entitlement is
 * never taxed.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createJobGrade, createLeavePolicy, updateLeavePolicy } from '../core/admin';
import {
  carryEnabled,
  expireCarriedLeave,
  isValidMonthDay,
  lastRealDayOfMonth,
  openLeaveYear,
  resolveGradePolicy,
} from '../core/leave';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;

const balance = (employmentId: string) => ledgerBalance(employmentId, b.annualLeaveTypeId);

/** Insert a leave_type by code (e.g. SICK) so we can prove non-annual types are untouched. */
const addType = async (code: string, name: string) => {
  const [t] = await owner.db
    .insert(schema.leaveType)
    .values({ tenantId: b.tenantId, code, name, paid: true })
    .returning({ id: schema.leaveType.id });
  return t.id;
};

/** Post a raw ledger row (owner role, bypasses RLS) for precise scenario construction. */
const post = (
  employmentId: string,
  leaveTypeId: string,
  entryType: 'accrual' | 'debit' | 'adjustment',
  days: number,
  effectiveOn: string,
) =>
  owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId,
    entryType,
    days: days.toFixed(2),
    effectiveOn,
  });

/** Count adjustment rows for an (emp, type) at a given effective date — proves idempotency. */
const adjustmentsAt = async (employmentId: string, leaveTypeId: string, effectiveOn: string) => {
  const [r] = await owner.db
    .select({ n: sql<string>`count(*)` })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.employmentId, employmentId),
        eq(schema.leaveLedger.leaveTypeId, leaveTypeId),
        eq(schema.leaveLedger.entryType, 'adjustment'),
        eq(schema.leaveLedger.effectiveOn, effectiveOn),
      ),
    );
  return Number(r.n);
};

const hire = (hiredOn: string, gradeId: string | null = null) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'CF', primaryEmail: `cf_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    gradeId,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

/** Annual policy active from `from` with carry cap + optional expiry offset. */
const annualPolicy = (
  p: {
    annualDays?: number;
    carryForwardMax?: number;
    expiry?: { month: number; day: number } | null;
    from?: string;
    /** Carry-forward enhancement: explicit on/off switch. undefined ⇒ back-compat (cap > 0) default. */
    carryForwardEnabled?: boolean;
    carryForwardIncludeEarned?: boolean;
  },
) =>
  createLeavePolicy(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays: p.annualDays ?? 12,
    carryForwardMax: p.carryForwardMax ?? 5,
    carryForwardExpiryMonth: p.expiry?.month ?? null,
    carryForwardExpiryDay: p.expiry?.day ?? null,
    carryForwardEnabled: p.carryForwardEnabled,
    carryForwardIncludeEarned: p.carryForwardIncludeEarned,
    validFrom: p.from ?? '2025-01-01',
  });

/** Read back a leave_policy's raw accrual JSONB (owner role bypasses RLS) — for round-trip assertions. */
const readAccrual = async (leaveTypeId: string): Promise<Record<string, unknown>> => {
  const [row] = await owner.db
    .select({ accrual: schema.leavePolicy.accrual })
    .from(schema.leavePolicy)
    .where(eq(schema.leavePolicy.leaveTypeId, leaveTypeId));
  return (row?.accrual as Record<string, unknown>) ?? {};
};

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

describe('ADR-0038 carry-forward expiry — expireCarriedLeave', () => {
  it('(a) carry 5, expiry 31 Mar, none taken → sweep forfeits the full 5', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const emp = await hire('2025-01-01'); // policy active at hire → 12 granted
    expect(await balance(emp.employmentId)).toBe(12);
    await openLeaveYear(adminCtx(b), { year: 2026 }); // carry min(12,5)=5, forfeit 7, +12 new → 17
    expect(await balance(emp.employmentId)).toBe(17);

    const r = await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' });
    expect(r.swept).toBe(1);
    expect(r.forfeited).toBe(5);
    expect(await balance(emp.employmentId)).toBe(12); // the 5 carried days forfeited; fresh 12 intact
  });

  it('(b) carry 5, take 3 by 31 Mar → forfeits only the unconsumed 2, never the fresh entitlement', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 }); // → 17
    // Take 3 days inside the carry window (Feb 2026).
    await post(emp.employmentId, b.annualLeaveTypeId, 'debit', -3, '2026-02-10');
    expect(await balance(emp.employmentId)).toBe(14);

    const r = await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' });
    expect(r.forfeited).toBe(2); // unconsumed carry = 5 − 3 = 2 (NOT 5)
    expect(await balance(emp.employmentId)).toBe(12); // 14 − 2 forfeited = 12 fresh, intact
  });

  it('(c) a sweep before the expiry date is a no-op; on/after the date it forfeits', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 });

    const before = await expireCarriedLeave(adminCtx(b), { today: '2026-03-30' });
    expect(before.swept).toBe(0);
    expect(await balance(emp.employmentId)).toBe(17); // untouched

    const on = await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' });
    expect(on.swept).toBe(1);
    expect(await balance(emp.employmentId)).toBe(12);
  });

  it('(c2) idempotent — re-running on/after the expiry date does not double-forfeit', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 });

    await expireCarriedLeave(adminCtx(b), { today: '2026-04-15' });
    expect(await balance(emp.employmentId)).toBe(12);
    const again = await expireCarriedLeave(adminCtx(b), { today: '2026-04-15' });
    expect(again.swept).toBe(0);
    expect(again.forfeited).toBe(0);
    expect(await balance(emp.employmentId)).toBe(12);
    expect(await adjustmentsAt(emp.employmentId, b.annualLeaveTypeId, '2026-03-31')).toBe(1);
  });

  it('(c3) two consecutive years each ending 03-31 forfeit independently', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const emp = await hire('2025-01-01');

    // Year 2026: open, sweep at its 2026-03-31.
    await openLeaveYear(adminCtx(b), { year: 2026 }); // → 17
    await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' }); // forfeit 5 → 12
    expect(await balance(emp.employmentId)).toBe(12);

    // Year 2027: open (carry min(12,5)=5, +12 → 17 again), then sweep its OWN 2027-03-31.
    await openLeaveYear(adminCtx(b), { year: 2027 });
    expect(await balance(emp.employmentId)).toBe(17);
    // A run on 2027-03-31 must forfeit 2027's carry without re-touching 2026's already-swept lot.
    const r = await expireCarriedLeave(adminCtx(b), { today: '2027-03-31' });
    expect(r.swept).toBe(1);
    expect(r.forfeited).toBe(5);
    expect(await balance(emp.employmentId)).toBe(12);
    expect(await adjustmentsAt(emp.employmentId, b.annualLeaveTypeId, '2026-03-31')).toBe(1);
    expect(await adjustmentsAt(emp.employmentId, b.annualLeaveTypeId, '2027-03-31')).toBe(1);
  });

  it('(d) a manual unrelated adjustment on 03-31 does not suppress the real sweep', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 }); // → 17
    // A manual correction of a DIFFERENT magnitude on the same date (e.g. HR claws back 1 day).
    await post(emp.employmentId, b.annualLeaveTypeId, 'adjustment', -1, '2026-03-31');
    expect(await balance(emp.employmentId)).toBe(16);

    const r = await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' });
    expect(r.swept).toBe(1);
    // unconsumed carry 5 (no debits); balance 16 → forfeit min(5,16)=5.
    expect(r.forfeited).toBe(5);
    expect(await balance(emp.employmentId)).toBe(11); // 16 − 5
    // Two distinct adjustment rows now sit on 03-31: the manual −1 and the sweep −5.
    expect(await adjustmentsAt(emp.employmentId, b.annualLeaveTypeId, '2026-03-31')).toBe(2);
  });

  it('(e) null expiry = the carry never expires (back-compat default)', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: null });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 }); // → 17, no expiry configured
    const r = await expireCarriedLeave(adminCtx(b), { today: '2030-12-31' });
    expect(r.swept).toBe(0);
    expect(await balance(emp.employmentId)).toBe(17); // nothing ever forfeited
  });

  it('(f) legacy carry from a year before the expiry policy existed is not retroactively swept', async () => {
    const emp = await hire('2023-01-01'); // hire grant in 2023
    // Years 2024 + 2025 carried under a cap-only policy (no expiry). Reconstruct that history directly:
    // a balance carried into 2024 and 2025 with NO expiry adjustments.
    await post(emp.employmentId, b.annualLeaveTypeId, 'accrual', 5, '2024-01-01');
    await post(emp.employmentId, b.annualLeaveTypeId, 'accrual', 5, '2025-01-01');
    // Only NOW does a policy with a 31-Mar expiry begin (validFrom 2026-01-01).
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 }, from: '2026-01-01' });
    const beforeBal = await balance(emp.employmentId);

    // A sweep dated in 2026 must not reach back to forfeit 2024/2025 carry — the earliest swept year is the
    // policy's validFrom year (2026), whose own 2026-03-31 has no carried lot here (no 2026 year-open run).
    const r = await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' });
    expect(r.swept).toBe(0);
    expect(await balance(emp.employmentId)).toBe(beforeBal); // legacy carry untouched
  });

  it('(g) a mid-year joiner with pro-rated, < cap carry expires the carried remainder correctly', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    // Joined 1 Jul 2025 → ANNUAL pro-rated: 12 × 6/12 = 6 in 2025.
    const emp = await hire('2025-07-01');
    expect(await balance(emp.employmentId)).toBe(6);
    await openLeaveYear(adminCtx(b), { year: 2026 }); // prior balance 6 → carry min(6,5)=5, +12 → 17
    expect(await balance(emp.employmentId)).toBe(17);

    const r = await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' });
    expect(r.forfeited).toBe(5); // carried 5 (capped from 6), none taken
    expect(await balance(emp.employmentId)).toBe(12);
  });

  it('(h) a forfeit is never re-inflated: nothing re-grants the swept days afterwards', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 }); // → 17
    await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' }); // → 12
    // Re-opening the SAME year is idempotent (skipped) and a later sweep finds nothing new.
    const reopen = await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(reopen.granted).toBe(0);
    const r2 = await expireCarriedLeave(adminCtx(b), { today: '2026-12-31' });
    expect(r2.swept).toBe(0);
    expect(await balance(emp.employmentId)).toBe(12); // stays forfeited, not re-inflated
  });

  // (i) stays valid precisely because the carry-forward enhancement did NOT generalize the sweep beyond
  // ANNUAL (expireCarriedLeave keeps its eq(code,'ANNUAL') filter — see core/leave.ts). A future change
  // that widens the sweep to other leave types must keep SICK/HOSPITALIZATION excluded (EA s.60F resets).
  it('(i) sick/hospitalization (non-annual) carry is never swept by this annual-only function', async () => {
    const sickTypeId = await addType('SICK', 'Sick Leave');
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const emp = await hire('2025-01-01');
    // A standing SICK balance carried across the boundary (statutory types reset, but prove WE don't touch it).
    await post(emp.employmentId, sickTypeId, 'accrual', 14, '2025-01-01');
    await post(emp.employmentId, sickTypeId, 'accrual', 14, '2026-01-01');
    const sickBefore = await ledgerBalance(emp.employmentId, sickTypeId);

    await expireCarriedLeave(adminCtx(b), { today: '2026-12-31' });
    expect(await ledgerBalance(emp.employmentId, sickTypeId)).toBe(sickBefore); // SICK untouched
  });
});

describe('ADR-0038 carry-forward expiry — resolveGradePolicy carryExpiry', () => {
  it('(j) resolves carryExpiry from the SAME winning policy as days/carryMax (no cross-leak)', async () => {
    // Two competing all-grades policies. The winner is the higher `days`. Its expiry must win too — a
    // rejected lower-days policy must NOT leak its expiry onto the selected one.
    const rows = [
      { gradeId: null, accrual: { annualDays: 10, carryForwardMax: 3, carryForwardExpiryMonth: 6, carryForwardExpiryDay: 30 } },
      { gradeId: null, accrual: { annualDays: 14, carryForwardMax: 5, carryForwardExpiryMonth: 3, carryForwardExpiryDay: 31 } },
    ];
    const resolved = resolveGradePolicy(rows, null, undefined, 0);
    expect(resolved).not.toBeNull();
    expect(resolved!.days).toBe(14);
    expect(resolved!.carryMax).toBe(5);
    expect(resolved!.carryExpiry).toEqual({ month: 3, day: 31 }); // from the winner, not the 6/30 loser
  });

  it('(j2) a grade winner carries its own expiry and applies through the live sweep', async () => {
    const exec = await createJobGrade(adminCtx(b), { code: 'EXEC', name: 'Executive' });
    // All-grades default expires 30 Jun; the EXEC policy (more generous) expires 31 Mar.
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      carryForwardMax: 5,
      carryForwardExpiryMonth: 6,
      carryForwardExpiryDay: 30,
      validFrom: '2025-01-01',
    });
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 18,
      carryForwardMax: 5,
      carryForwardExpiryMonth: 3,
      carryForwardExpiryDay: 31,
      gradeId: exec.id,
      validFrom: '2025-01-01',
    });
    const emp = await hire('2025-01-01', exec.id); // 18 granted under the EXEC policy
    await openLeaveYear(adminCtx(b), { year: 2026 }); // carry min(18,5)=5 → balance 5 + 18 = 23

    // On 2026-03-31 the EXEC's own 31-Mar expiry must fire (the 30-Jun default must NOT win for them).
    const r = await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' });
    expect(r.swept).toBe(1);
    expect(r.forfeited).toBe(5);
    expect(await balance(emp.employmentId)).toBe(18);
  });
});

describe('Carry-forward enhancement — carryForwardEnabled toggle at year-open (openLeaveYear)', () => {
  // The three-way truth table for the explicit enable switch vs. the cap, observed at year-open.
  it('(k) explicit false + positive cap ⇒ everything forfeits (the toggle overrides the cap)', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, carryForwardEnabled: false });
    const emp = await hire('2025-01-01'); // 12 granted at hire
    expect(await balance(emp.employmentId)).toBe(12);
    // Carry disabled ⇒ carryMax collapses to 0 ⇒ the whole prior 12 forfeits, +12 fresh = 12.
    await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(await balance(emp.employmentId)).toBe(12);
  });

  it('(l) explicit true + cap 0 ⇒ full forfeit (same observable result as off — pins the ambiguity)', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 0, carryForwardEnabled: true });
    const emp = await hire('2025-01-01');
    expect(await balance(emp.employmentId)).toBe(12);
    // Enabled but the cap is 0, so min(prior, 0) = 0 carries ⇒ prior 12 forfeits, +12 fresh = 12.
    await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(await balance(emp.employmentId)).toBe(12);
  });

  it('(m) absent flag + positive cap ⇒ carries (back-compat default holds)', async () => {
    // No carryForwardEnabled in the JSONB at all — the back-compat `cap > 0` default must still carry.
    await annualPolicy({ annualDays: 12, carryForwardMax: 5 });
    const acc = await readAccrual(b.annualLeaveTypeId);
    expect('carryForwardEnabled' in acc).toBe(false); // key omitted, not written as undefined/false
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 }); // carry min(12,5)=5 + 12 fresh = 17
    expect(await balance(emp.employmentId)).toBe(17);
  });
});

describe('Carry-forward enhancement — disabled policy is inert in the expiry sweep', () => {
  it('(n) carryForwardEnabled:false + a populated expiry ⇒ expireCarriedLeave is a no-op', async () => {
    // A stale expiry offset is still present in the JSONB, but the rule is disabled. openLeaveYear already
    // forfeited the whole prior balance at open (carry 0), so the later sweep must find nothing AND must
    // not fire even though carryExpiry parses — proving the carryEnabled guard in expireCarriedLeave.
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 }, carryForwardEnabled: false });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 }); // disabled ⇒ prior 12 forfeits, +12 = 12
    expect(await balance(emp.employmentId)).toBe(12);

    const r = await expireCarriedLeave(adminCtx(b), { today: '2026-12-31' });
    expect(r.swept).toBe(0);
    expect(r.forfeited).toBe(0);
    expect(await balance(emp.employmentId)).toBe(12); // untouched
    expect(await adjustmentsAt(emp.employmentId, b.annualLeaveTypeId, '2026-03-31')).toBe(0);
  });
});

describe('Carry-forward enhancement — resolveGradePolicy carryForwardEnabled + carryEnabled default', () => {
  it('(o) carryForwardEnabled is resolved from the WINNING (higher-days) policy, not a losing one', async () => {
    // The loser disables carry; the winner (higher days) enables it. The winner's flag must win — mirror of (j).
    const rows = [
      { gradeId: null, accrual: { annualDays: 10, carryForwardMax: 3, carryForwardEnabled: false } },
      { gradeId: null, accrual: { annualDays: 14, carryForwardMax: 5, carryForwardEnabled: true } },
    ];
    const resolved = resolveGradePolicy(rows, null, undefined, 0);
    expect(resolved).not.toBeNull();
    expect(resolved!.days).toBe(14);
    expect(resolved!.carryForwardEnabled).toBe(true); // from the 14-day winner, not the disabled 10-day loser
    expect(carryEnabled(resolved)).toBe(true);
  });

  it('(p) carryEnabled back-compat default: absent flag ⇒ enabled iff carryMax > 0', () => {
    expect(carryEnabled({ days: 12, carryMax: 5 })).toBe(true); // cap > 0, no flag ⇒ on
    expect(carryEnabled({ days: 12, carryMax: 0 })).toBe(false); // cap 0, no flag ⇒ off
    expect(carryEnabled({ days: 12, carryMax: 5, carryForwardEnabled: false })).toBe(false); // explicit off overrides
    expect(carryEnabled({ days: 12, carryMax: 0, carryForwardEnabled: true })).toBe(true); // explicit on overrides
    expect(carryEnabled(null)).toBe(false);
  });
});

describe('Carry-forward enhancement — carryForwardIncludeEarned round-trips (config-only, no ledger effect)', () => {
  it('(q) the include-earned flag persists through createLeavePolicy and changes no ledger outcome', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, carryForwardIncludeEarned: true });
    const acc = await readAccrual(b.annualLeaveTypeId);
    expect(acc.carryForwardIncludeEarned).toBe(true); // persisted

    // It must not influence the year-end engine this round: a normal open carries exactly as without it.
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 }); // carry min(12,5)=5 + 12 = 17, identical to the no-flag case
    expect(await balance(emp.employmentId)).toBe(17);
  });
});

// ───────────────────────────────────────────────────────────────────────────────────────────────────
// R4 Build #1 — carry-forward expiry-date validity + "X months after year-end" mode.
// ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('R4 Build #1 — isValidMonthDay + lastRealDayOfMonth (pure)', () => {
  it('(r) rejects impossible day/month combinations', () => {
    for (const [m, d] of [
      [2, 31],
      [4, 31],
      [6, 31],
      [9, 31],
      [11, 31],
      [2, 30],
      [0, 15],
      [13, 1],
      [3, 0],
    ] as const) {
      expect(isValidMonthDay(m, d), `${m}/${d} should be invalid`).toBe(false);
    }
  });

  it('(s) accepts real calendar days including 29 Feb (leap-tolerant at config time)', () => {
    for (const [m, d] of [
      [2, 28],
      [2, 29],
      [4, 30],
      [3, 31],
      [1, 1],
      [12, 31],
    ] as const) {
      expect(isValidMonthDay(m, d), `${m}/${d} should be valid`).toBe(true);
    }
  });

  it('(t) lastRealDayOfMonth is leap-correct', () => {
    expect(lastRealDayOfMonth(2027, 2)).toBe(28); // common year
    expect(lastRealDayOfMonth(2028, 2)).toBe(29); // leap year
    expect(lastRealDayOfMonth(2027, 6)).toBe(30);
    expect(lastRealDayOfMonth(2027, 12)).toBe(31);
  });
});

describe('R4 Build #1 — write-path validation (createLeavePolicy / updateLeavePolicy)', () => {
  const create = (p: {
    month?: number | null;
    day?: number | null;
    mode?: 'date' | 'months';
    months?: number | null;
  }) =>
    createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      carryForwardMax: 5,
      carryForwardExpiryMonth: p.month ?? null,
      carryForwardExpiryDay: p.day ?? null,
      carryForwardExpiryMode: p.mode,
      carryForwardExpiryMonths: p.months ?? null,
      validFrom: '2025-01-01',
    });

  it('(u) impossible dates are rejected with a clear message', async () => {
    for (const [m, d] of [
      [2, 31],
      [4, 31],
      [6, 31],
    ] as const) {
      await expect(create({ month: m, day: d })).rejects.toThrow(/real calendar date/i);
    }
  });

  it('(v) valid dates save and round-trip through the accrual reader', async () => {
    for (const [m, d] of [
      [2, 29],
      [4, 30],
      [3, 31],
    ] as const) {
      await owner.db.delete(schema.leavePolicy).where(eq(schema.leavePolicy.leaveTypeId, b.annualLeaveTypeId));
      await create({ month: m, day: d });
      const acc = await readAccrual(b.annualLeaveTypeId);
      expect(acc.carryForwardExpiryMonth).toBe(m);
      expect(acc.carryForwardExpiryDay).toBe(d);
      expect('carryForwardExpiryMode' in acc).toBe(false); // date mode omits the mode key
    }
  });

  it('(w) months out of 1..12 is rejected', async () => {
    await expect(create({ mode: 'months', months: 0 })).rejects.toThrow(/between 1 and 12/i);
    await expect(create({ mode: 'months', months: 13 })).rejects.toThrow(/between 1 and 12/i);
  });

  it('(x) updateLeavePolicy also rejects an impossible date', async () => {
    const { id } = await create({ month: 3, day: 31 });
    await expect(
      updateLeavePolicy(adminCtx(b), {
        id,
        annualDays: 12,
        carryForwardMax: 5,
        carryForwardExpiryMonth: 4,
        carryForwardExpiryDay: 31,
        validFrom: '2025-01-01',
      }),
    ).rejects.toThrow(/real calendar date/i);
  });
});

describe('R4 Build #1 — crash prevention: 29 Feb in a common year never crashes the sweep', () => {
  it('(y) date-mode 29 Feb, carry into a common (non-leap) year → forfeits on the clamped 28 Feb', async () => {
    // 2027 is NOT a leap year. The expiry {2,29} must clamp to 2027-02-28 so the ledger insert (a `date`
    // column) never rejects the value and aborts the whole tenant sweep. This is the regression test for the
    // real bug: NOT a no-op, NOT a crash — a real forfeit on 28 Feb.
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 2, day: 29 } });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2027 }); // carry min(12,5)=5, +12 → 17
    expect(await balance(emp.employmentId)).toBe(17);

    const r = await expireCarriedLeave(adminCtx(b), { today: '2027-02-28' });
    expect(r.swept).toBe(1);
    expect(r.forfeited).toBe(5);
    expect(await balance(emp.employmentId)).toBe(12);
    // The forfeit landed on the CLAMPED 28 Feb (a real date). It could never be 2027-02-29 — Postgres
    // rejects that literal outright — which is exactly the crash the clamp prevents.
    expect(await adjustmentsAt(emp.employmentId, b.annualLeaveTypeId, '2027-02-28')).toBe(1);
  });
});

describe('R4 Build #1 — "X months after year-end" mode resolution', () => {
  const monthsPolicy = (months: number, from = '2025-01-01') =>
    createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 18,
      carryForwardMax: 5,
      carryForwardExpiryMode: 'months',
      carryForwardExpiryMonths: months,
      validFrom: from,
    });

  it('(z) months:3 resolves to 31 Mar of the carry year — reporter headline scenario end-to-end', async () => {
    await monthsPolicy(3);
    const acc = await readAccrual(b.annualLeaveTypeId);
    expect(acc.carryForwardExpiryMode).toBe('months');
    expect(acc.carryForwardExpiryMonths).toBe(3);
    expect('carryForwardExpiryMonth' in acc).toBe(false); // months mode omits date keys

    // hire 2025-01-01 (18 granted), reduce to 8 at 2026 year-end, cap 5 ⇒ open 2027 carries 5, forfeit 3.
    const emp = await hire('2025-01-01');
    await post(emp.employmentId, b.annualLeaveTypeId, 'adjustment', -10, '2026-06-01'); // 18 → 8 by year-end
    await openLeaveYear(adminCtx(b), { year: 2027 }); // carry min(8,5)=5, +18 → 23
    expect(await balance(emp.employmentId)).toBe(23);

    const early = await expireCarriedLeave(adminCtx(b), { today: '2027-03-30' });
    expect(early.swept).toBe(0); // not yet due
    const r = await expireCarriedLeave(adminCtx(b), { today: '2027-03-31' });
    expect(r.swept).toBe(1);
    expect(r.forfeited).toBe(5);
    expect(await balance(emp.employmentId)).toBe(18);
    expect(await adjustmentsAt(emp.employmentId, b.annualLeaveTypeId, '2027-03-31')).toBe(1);
  });

  it('(aa) months:2 into a common year resolves to 28 Feb (auto-derived crash guard)', async () => {
    await monthsPolicy(2);
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2027 }); // 2027 common; carry 5, +18 → 23
    const r = await expireCarriedLeave(adminCtx(b), { today: '2027-02-28' });
    expect(r.swept).toBe(1);
    expect(r.forfeited).toBe(5);
    // Clamped to the real 28 Feb (2027 is common) — never the phantom 2027-02-29 that would crash the insert.
    expect(await adjustmentsAt(emp.employmentId, b.annualLeaveTypeId, '2027-02-28')).toBe(1);
  });

  it('(bb) months:12 resolves to 31 Dec of the carry year (explicit edge)', async () => {
    await monthsPolicy(12);
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2027 });
    const r = await expireCarriedLeave(adminCtx(b), { today: '2027-12-31' });
    expect(r.swept).toBe(1);
    expect(r.forfeited).toBe(5);
    expect(await adjustmentsAt(emp.employmentId, b.annualLeaveTypeId, '2027-12-31')).toBe(1);
  });

  it('(cc) empty months ⇒ never expires (no forfeit row, no throw)', async () => {
    await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 18,
      carryForwardMax: 5,
      carryForwardExpiryMode: 'months',
      carryForwardExpiryMonths: null,
      validFrom: '2025-01-01',
    });
    const acc = await readAccrual(b.annualLeaveTypeId);
    expect('carryForwardExpiryMode' in acc).toBe(false); // omitted ⇒ mode-only never persisted
    expect('carryForwardExpiryMonths' in acc).toBe(false);
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2027 });
    const r = await expireCarriedLeave(adminCtx(b), { today: '2030-12-31' });
    expect(r.swept).toBe(0);
  });
});

describe('R4 Build #1 — mode switch clears stale cross-mode keys', () => {
  it('(dd) date {4,30} → update to months:3 ⇒ accrual has months keys and NO date keys', async () => {
    const { id } = await createLeavePolicy(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      carryForwardMax: 5,
      carryForwardExpiryMonth: 4,
      carryForwardExpiryDay: 30,
      validFrom: '2025-01-01',
    });
    let acc = await readAccrual(b.annualLeaveTypeId);
    expect(acc.carryForwardExpiryMonth).toBe(4);

    await updateLeavePolicy(adminCtx(b), {
      id,
      annualDays: 12,
      carryForwardMax: 5,
      carryForwardExpiryMode: 'months',
      carryForwardExpiryMonths: 3,
      validFrom: '2025-01-01',
    });
    acc = await readAccrual(b.annualLeaveTypeId);
    expect(acc.carryForwardExpiryMode).toBe('months');
    expect(acc.carryForwardExpiryMonths).toBe(3);
    expect('carryForwardExpiryMonth' in acc).toBe(false);
    expect('carryForwardExpiryDay' in acc).toBe(false);
  });
});
