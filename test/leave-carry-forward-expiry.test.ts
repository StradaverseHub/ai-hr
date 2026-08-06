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
 *
 * ── 6e9a126e RELEASE THREE — REPOINTED, AND THE CARRY RULES GO ON THE LEAVE TYPE ────────────────────
 *
 * Every forfeit figure, every idempotency count and every clamped date below is unchanged. What moved is
 * where the configuration lives: the DAYS to an entitlement template's band, and every CARRY rule (cap,
 * enable switch, expiry offset, expiry mode, include-earned) to the leave TYPE's own columns.
 *
 * THE TYPE IS NOT A PREFERENCE, IT IS THE ONLY PLACE THAT WORKS. `expireCarriedLeave` gates its entire
 * sweep on `typeCarriesExpiry` — `applyLeaveTypeRules({days:0,carryMax:0}, type)?.carryExpiry != null` —
 * which asks the leave type and nothing else. A per-band expiry never reaches the loop below that would
 * honour it, so a fixture that put the expiry on the band would report a clean zero forfeit while every
 * assertion here claimed a real one.
 *
 * WHAT WAS RETIRED, AND WHY, IS STATED AT EACH SITE: the two pure `resolveGradePolicy` unit tests (the
 * resolver is deleted), the per-grade EXPIRY half of (j2) (carry expiry is now one rule per leave type),
 * the second-writer duplicate (x), and the JSONB-hygiene half of (cc) (there is no blob left to keep
 * clean). The BEHAVIOUR each of those protected is asserted below wherever it still exists.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createJobGrade, setLeaveTypeRules } from '../core/admin';
import {
  accrueEarnedLeave,
  carryEnabled,
  CARRY_FORFEIT_REASON_CAP,
  CARRY_FORFEIT_REASON_EXPIRY,
  expireCarriedLeave,
  isValidMonthDay,
  lastRealDayOfMonth,
  openLeaveYear,
} from '../core/leave';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';

let b: Base;

const balance = (employmentId: string) => ledgerBalance(employmentId, b.annualLeaveTypeId);

/** Insert a leave_type by code (e.g. SICK) so we can prove non-annual types are untouched. */
const addType = async (code: string, name: string) => {
  const [t] = await owner.db
    .insert(schema.leaveType)
    .values({ allowNegativeBalance: true, tenantId: b.tenantId, code, name, paid: true })
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

/** The `reason` column(s) of adjustment rows for an (emp, type) at a given effective date — proves the
 *  Carry-Forward-Report feature's machine-code tagging (CARRY_FORFEIT_REASON_CAP / _EXPIRY). */
const reasonsAt = async (employmentId: string, leaveTypeId: string, effectiveOn: string): Promise<(string | null)[]> => {
  const rows = await owner.db
    .select({ reason: schema.leaveLedger.reason })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.employmentId, employmentId),
        eq(schema.leaveLedger.leaveTypeId, leaveTypeId),
        eq(schema.leaveLedger.entryType, 'adjustment'),
        eq(schema.leaveLedger.effectiveOn, effectiveOn),
      ),
    );
  return rows.map((r) => r.reason);
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

/** The leave TYPE's rule columns, written straight (owner role) — the fixture equivalent of the JSONB the
 *  dropped `createLeavePolicy` used to build. Every engine reads carry from here. */
const setCarryRules = (patch: Partial<typeof schema.leaveType.$inferInsert>, id = b.annualLeaveTypeId) =>
  owner.db.update(schema.leaveType).set(patch).where(eq(schema.leaveType.id, id));

/** Read back the leave TYPE's rule columns — the replacement for reading `leave_policy.accrual`. */
const typeRow = async (id = b.annualLeaveTypeId) => {
  const [row] = await owner.db.select().from(schema.leaveType).where(eq(schema.leaveType.id, id));
  return row;
};

/** Annual entitlement active from `from`, with carry cap + optional expiry offset. Days to the template
 *  band; every carry rule to the leave type (see the header for why the type is the only place that
 *  works). `undefined` for a rule leaves its column NULL, which is what "not configured" means now and
 *  what the old writer expressed by OMITTING the JSONB key. */
const annualPolicy = async (
  p: {
    annualDays?: number;
    carryForwardMax?: number;
    expiry?: { month: number; day: number } | null;
    from?: string;
    /** Carry-forward enhancement: explicit on/off switch. undefined ⇒ back-compat (cap > 0) default. */
    carryForwardEnabled?: boolean;
    carryForwardIncludeEarned?: boolean;
  },
) => {
  const tpl = await seedEntitlement(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays: p.annualDays ?? 12,
    validFrom: p.from ?? '2025-01-01',
  });
  await setCarryRules({
    carryForwardMax: String(p.carryForwardMax ?? 5),
    carryForwardExpiryMonth: p.expiry?.month ?? null,
    carryForwardExpiryDay: p.expiry?.day ?? null,
    carryForwardEnabled: p.carryForwardEnabled ?? null,
    carryForwardIncludeEarned: p.carryForwardIncludeEarned ?? null,
  });
  return tpl;
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

describe('ADR-0038 carry-forward expiry — the grade-scoped winner, end to end', () => {
  /**
   * ⚠️ (j) IS RETIRED. It was a pure unit test of `resolveGradePolicy` — "carryExpiry comes from the SAME
   * winning policy as days and carryMax, a rejected lower-days policy must not leak its expiry onto the
   * selected one". `resolveGradePolicy` was deleted with `leave_policy`, and the cross-leak it guarded is
   * now impossible by construction rather than by a rule: `policyFromTemplateBand` takes days, carry cap
   * and expiry off ONE band object, so there is no second candidate to leak from.
   */
  it('(j2) a grade-scoped entitlement wins end-to-end, and its days survive the live sweep', async () => {
    // ⚠️ THE PER-GRADE EXPIRY HALF OF THIS TEST IS RETIRED. It configured a 30-Jun default and a 31-Mar
    // EXEC policy and proved the EXEC's OWN expiry fired. Carry expiry is now ONE rule per leave type
    // (`expireCarriedLeave` only asks the type), so two expiries for two grades is not a configuration the
    // product has. Asserting it would need a per-band expiry, which the sweep's gate never reaches — a
    // green zero dressed up as a real forfeit.
    //
    // WHAT SURVIVES IS THE PRECEDENCE ITSELF, which is the part worth pinning: the grade-scoped rule beats
    // the grade-less one and the employee gets 18 days, not 12. Under `leave_policy` a grade row beat a
    // grade-less row by HAVING a grade; now both eligibility rules match and the resolver picks the more
    // SPECIFIC one (orgCriteriaSpecificity). Same outcome, decided elsewhere — and the 18 below is what
    // proves it, because 12 is what a mis-resolution would produce.
    const exec = await createJobGrade(adminCtx(b), { code: 'EXEC', name: 'Executive' });
    await seedEntitlement(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      validFrom: '2025-01-01',
      name: 'All grades',
    });
    await seedEntitlement(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 18,
      gradeId: exec.id,
      validFrom: '2025-01-01',
      name: 'Executive',
    });
    await setCarryRules({ carryForwardMax: '5', carryForwardExpiryMonth: 3, carryForwardExpiryDay: 31 });

    const emp = await hire('2025-01-01', exec.id); // 18, from the grade-scoped table — not the 12 default
    expect(await balance(emp.employmentId)).toBe(18);
    await openLeaveYear(adminCtx(b), { year: 2026 }); // carry min(18,5)=5 → balance 5 + 18 = 23
    expect(await balance(emp.employmentId)).toBe(23);

    const r = await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' });
    expect(r.swept).toBe(1);
    expect(r.forfeited).toBe(5);
    expect(await balance(emp.employmentId)).toBe(18); // the grade winner's fresh 18, untaxed
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
    // No carryForwardEnabled configured AT ALL — the back-compat `cap > 0` default must still carry. The
    // assertion used to be that the JSONB key was OMITTED rather than written as false; on the type the
    // same fact is a NULL column, and it matters for the same reason: `applyLeaveTypeRules` only produces
    // a real boolean from a real boolean, so a stored `false` would disable carry outright.
    await annualPolicy({ annualDays: 12, carryForwardMax: 5 });
    expect((await typeRow()).carryForwardEnabled).toBeNull();
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

describe('Carry-forward enhancement — the carryEnabled default', () => {
  /**
   * ⚠️ (o) IS RETIRED, for the same reason as (j) and by the same argument. It unit-tested
   * `resolveGradePolicy` — "carryForwardEnabled is resolved from the WINNING (higher-days) policy, not a
   * losing one". That resolver is deleted, and the enable switch is no longer a per-entitlement value at
   * all: it is one column on the leave type, so there is no losing candidate for it to be taken from.
   * `carryEnabled` itself, which was the point of the assertion, is unit-tested in full by (p) below.
   */
  it('(p) carryEnabled back-compat default: absent flag ⇒ enabled iff carryMax > 0', () => {
    expect(carryEnabled({ days: 12, carryMax: 5 })).toBe(true); // cap > 0, no flag ⇒ on
    expect(carryEnabled({ days: 12, carryMax: 0 })).toBe(false); // cap 0, no flag ⇒ off
    expect(carryEnabled({ days: 12, carryMax: 5, carryForwardEnabled: false })).toBe(false); // explicit off overrides
    expect(carryEnabled({ days: 12, carryMax: 0, carryForwardEnabled: true })).toBe(true); // explicit on overrides
    expect(carryEnabled(null)).toBe(false);
  });
});

describe('Carry-forward enhancement — carryForwardIncludeEarned round-trips (config-only, no ledger effect)', () => {
  it('(q) the include-earned flag persists on the leave type and changes no ledger outcome', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, carryForwardIncludeEarned: true });
    expect((await typeRow()).carryForwardIncludeEarned).toBe(true); // persisted

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

describe('R4 Build #1 — write-path validation (setLeaveTypeRules)', () => {
  /** The SURVIVING writer for these rules. Same validation, same rejections; `createLeavePolicy` and
   *  `updateLeavePolicy` went with the table they wrote to. */
  const save = (p: {
    month?: number | null;
    day?: number | null;
    mode?: 'date' | 'months' | null;
    months?: number | null;
  }) =>
    setLeaveTypeRules(adminCtx(b), {
      id: b.annualLeaveTypeId,
      carryForwardMax: 5,
      carryForwardExpiryMonth: p.month ?? null,
      carryForwardExpiryDay: p.day ?? null,
      carryForwardExpiryMode: p.mode,
      carryForwardExpiryMonths: p.months ?? null,
    });

  it('(u) impossible dates are rejected with a clear message', async () => {
    for (const [m, d] of [
      [2, 31],
      [4, 31],
      [6, 31],
    ] as const) {
      await expect(save({ month: m, day: d })).rejects.toThrow(/not a real date/i);
    }
  });

  it('(v) valid dates save and round-trip through the rule columns', async () => {
    for (const [m, d] of [
      [2, 29],
      [4, 30],
      [3, 31],
    ] as const) {
      await save({ month: m, day: d });
      const row = await typeRow();
      expect(row.carryForwardExpiryMonth).toBe(m);
      expect(row.carryForwardExpiryDay).toBe(d);
      // Date mode leaves the mode column NULL — `parseCarryExpiry` reads an absent mode as 'date', which
      // is the same back-compat branch the omitted JSONB key used to select.
      expect(row.carryForwardExpiryMode).toBeNull();
    }
  });

  it('(w) months out of 1..12 is rejected', async () => {
    await expect(save({ mode: 'months', months: 0 })).rejects.toThrow(/between 1 and 12/i);
    await expect(save({ mode: 'months', months: 13 })).rejects.toThrow(/between 1 and 12/i);
  });

  // ⚠️ (x) IS RETIRED. It asserted that `updateLeavePolicy` ALSO rejected an impossible date — the point
  // being that two separate writers both had to validate, and one of them silently not doing so was a real
  // and repeated defect. There is now exactly ONE writer for these rules: `setLeaveTypeRules` is both the
  // create and the update path, and (u) already exercises it. The asymmetry the test guarded no longer
  // exists to be guarded, so keeping it would only assert (u) twice.
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
  const monthsPolicy = async (months: number | null, from = '2025-01-01') => {
    await seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays: 18, validFrom: from });
    await setCarryRules({
      carryForwardMax: '5',
      carryForwardExpiryMode: 'months',
      carryForwardExpiryMonths: months,
    });
  };

  it('(z) months:3 resolves to 31 Mar of the carry year — reporter headline scenario end-to-end', async () => {
    await monthsPolicy(3);
    const row = await typeRow();
    expect(row.carryForwardExpiryMode).toBe('months');
    expect(row.carryForwardExpiryMonths).toBe(3);
    expect(row.carryForwardExpiryMonth).toBeNull(); // months mode leaves the date columns unset

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
    // ⚠️ THE JSONB-HYGIENE HALF OF THIS TEST IS RETIRED. It also asserted `'carryForwardExpiryMode' in acc
    // === false` — that `createLeavePolicy` refused to persist a mode with no months beside it, because
    // both lived in ONE blob and a mode-only key there was a half-written rule. On the leave type they are
    // two independent columns and `setLeaveTypeRules` stores exactly what it is given, so that claim is
    // about a writer that no longer exists. What it was PROTECTING — that an incomplete months rule never
    // expires anything — is the behavioural assertion below, and that is unchanged.
    await monthsPolicy(null);
    const row = await typeRow();
    expect(row.carryForwardExpiryMonths).toBeNull();
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2027 });
    const r = await expireCarriedLeave(adminCtx(b), { today: '2030-12-31' });
    expect(r.swept).toBe(0);
    expect(await balance(emp.employmentId)).toBe(23); // carry 5 + fresh 18, nothing forfeited
  });
});

describe('R4 Build #1 — a mode switch leaves no stale cross-mode rule behind', () => {
  it('(dd) date {4,30} → switch to months:3 ⇒ the sweep fires on 31 Mar and NEVER on 30 Apr', async () => {
    // REPOINTED FROM KEY-ABSENCE TO BEHAVIOUR, because the hazard moved rather than disappearing. It used
    // to be that both modes' settings lived in ONE JSONB blob, so `updateLeavePolicy` had to DELETE the
    // date keys or `parseCarryExpiry` could read a stale 30 Apr. On the leave type they are separate
    // columns and a switch cannot clear the ones it does not write — the date pair genuinely LINGERS. What
    // has to be true is that the mode column wins and the stale pair is ignored, and the honest way to
    // assert that is the forfeit date itself rather than the presence of a column.
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 4, day: 30 } });
    expect((await typeRow()).carryForwardExpiryMonth).toBe(4);

    await setLeaveTypeRules(adminCtx(b), {
      id: b.annualLeaveTypeId,
      carryForwardExpiryMode: 'months',
      carryForwardExpiryMonths: 3,
    });
    const row = await typeRow();
    expect(row.carryForwardExpiryMode).toBe('months');
    expect(row.carryForwardExpiryMonths).toBe(3);
    expect(row.carryForwardExpiryMonth).toBe(4); // the stale date pair is still stored…

    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 }); // carry min(12,5)=5, +12 → 17
    // …and it is ignored. months:3 resolves to 31 Mar, so the sweep is due then and not in April.
    const early = await expireCarriedLeave(adminCtx(b), { today: '2026-03-30' });
    expect(early.swept).toBe(0);
    const due = await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' });
    expect(due.swept).toBe(1);
    expect(due.forfeited).toBe(5);
    expect(await adjustmentsAt(emp.employmentId, b.annualLeaveTypeId, '2026-03-31')).toBe(1);
    expect(await adjustmentsAt(emp.employmentId, b.annualLeaveTypeId, '2026-04-30')).toBe(0);
  });
});

// ── Carry-Forward-Report feature — reason tagging on the three automatic forfeit paths ─────────────
describe('Carry-forward-report — reason tagging on automatic forfeits (no behaviour change)', () => {
  it('(ee) openLeaveYear cap-excess forfeit is stamped CARRY_FORFEIT_REASON_CAP', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5 }); // no expiry
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 }); // before 12, carry 5, forfeit 7
    expect(await balance(emp.employmentId)).toBe(17);
    expect(await reasonsAt(emp.employmentId, b.annualLeaveTypeId, '2026-01-01')).toEqual([CARRY_FORFEIT_REASON_CAP]);
  });

  it('(ff) expireCarriedLeave expiry forfeit is stamped CARRY_FORFEIT_REASON_EXPIRY', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 }); // before 12, carry 5, forfeit 7 (tagged CAP) → 17
    expect(await reasonsAt(emp.employmentId, b.annualLeaveTypeId, '2026-01-01')).toEqual([CARRY_FORFEIT_REASON_CAP]);
    const r = await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' });
    expect(r.forfeited).toBe(5);
    expect(await reasonsAt(emp.employmentId, b.annualLeaveTypeId, '2026-03-31')).toEqual([CARRY_FORFEIT_REASON_EXPIRY]);
  });

  it('(gg) accrueEarnedLeave 2D-3 cycle-boundary forfeit is stamped CARRY_FORFEIT_REASON_CAP', async () => {
    await seedEntitlement(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      annualDays: 12,
      validFrom: '2026-01-01',
    });
    await setCarryRules({ carryForwardMax: '5', accrualMethod: 'earned_monthly' });
    const emp = await hireEmployee(adminCtx(b), {
      person: { fullName: 'CF2', primaryEmail: `cf2_${randomUUID().slice(0, 8)}@t.local` },
      companyId: b.companyId,
      departmentId: b.deptA,
      employmentType: 'full_time',
      hiredOn: '2026-01-01',
      grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
    });
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-12-31' }); // full 2026 cycle → 12
    expect(await balance(emp.employmentId)).toBe(12);
    const r = await accrueEarnedLeave(adminCtx(b), { asOf: '2027-06-15' }); // new cycle: forfeit (12−5)=7 at 2027-01-01
    expect(r.forfeits).toBe(1);
    expect(await reasonsAt(emp.employmentId, b.annualLeaveTypeId, '2027-01-01')).toEqual([CARRY_FORFEIT_REASON_CAP]);
  });

  it('(hh) idempotent re-runs of all three paths still post nothing extra (reason-blind idempotency unchanged)', async () => {
    await annualPolicy({ annualDays: 12, carryForwardMax: 5, expiry: { month: 3, day: 31 } });
    const emp = await hire('2025-01-01');
    await openLeaveYear(adminCtx(b), { year: 2026 });
    await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' });
    expect(await adjustmentsAt(emp.employmentId, b.annualLeaveTypeId, '2026-03-31')).toBe(1);

    // Re-run everything — the reason-blind idempotency checks (entryType+effectiveOn+days magnitude)
    // must still suppress duplicate inserts even though the rows now carry a reason.
    const openAgain = await openLeaveYear(adminCtx(b), { year: 2026 });
    expect(openAgain.granted).toBe(0);
    expect(openAgain.forfeits).toBe(0);
    const sweepAgain = await expireCarriedLeave(adminCtx(b), { today: '2026-03-31' });
    expect(sweepAgain.swept).toBe(0);
    expect(sweepAgain.forfeited).toBe(0);
    expect(await adjustmentsAt(emp.employmentId, b.annualLeaveTypeId, '2026-03-31')).toBe(1);
  });
});
