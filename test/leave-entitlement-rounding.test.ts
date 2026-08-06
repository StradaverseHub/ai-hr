/**
 * Rounding Method under Earning Method (feedback b81d3c52).
 *
 * HR can pick, PER LEAVE TYPE (on the earning rule), how a CALCULATED entitlement is tidied before it is
 * credited: No Rounding (as-is), Round Up (next whole day) or Round Down (previous whole day). The chosen
 * method is applied as the FINAL step AFTER the earning calculation — the earning maths itself is
 * untouched — and at the SAME point in EVERY engine, always BEFORE the Maximum Balance clamp:
 *   1. the hire grant (core/org.ts)                       — the reporter's mid-year-joiner example;
 *   2. the year-open grant (openLeaveYear);
 *   3. the earned cumulative (accrueEarnedLeave)          — the named "Accrual Process" surface;
 *   4. the recalc kernel's projection (projectExpectedEntitlement).
 * All four write/compare the LEDGER, so every ledger-derived display surface (Leave Summary, YTD Entitled,
 * the Entitlement Calculation Breakdown, the employee leave view, Leave Balance) shows the tidied figure
 * with no display-layer change.
 *
 * ── 6e9a126e RELEASE THREE: THE RULE MOVED HOMES TWICE, AND THIS FILE FOLLOWED IT ────────────────────
 * b81d3c52 put the Rounding Method in `leave_policy.accrual`. 9816a5ad step 2 moved every RULE to the
 * LEAVE TYPE, leaving the entitlement layer the days. Migration 0405 then dropped `leave_policy`
 * outright. So every fixture below configures DAYS through `seedEntitlement` (an entitlement template
 * plus an eligibility rule) and the ROUNDING RULE on `leave_type` — and EVERY ARITHMETIC ASSERTION IS
 * UNCHANGED: 11.67 ⇒ 12, 12.4 ⇒ 13, 3.5 ⇒ 4, 0.67 ⇒ 0, the 24.5 fractional carry, all of it.
 *
 * Rounding is written directly onto the type's column here rather than through `setLeaveTypeRules`,
 * because 8fec719e retired 'up' / 'down' as CHOICES while deliberately keeping them as VALUES that
 * `applyRounding` still honours (a stored figure must not silently change meaning). These fixtures are
 * describing a stored world for the engines to read; that the writer refuses to store them again is
 * pinned in test/leave-rounding-bands.test.ts §2.
 *
 * Invariants under test:
 *  (1) applyRounding is whole-day, defensive, and a pass-through for none/unknown/non-finite;
 *  (2) the configured figure, rounded, is exactly what the ledger receives;
 *  (3) the joiner hire grant rounds, and leaveEntitlementBreakdown (ledger-derived) shows the rounded figure;
 *  (4) earned accrual rounds the CUMULATIVE every period — up builds in whole days, down floors a small
 *      early cumulative to 0 (no row) and then builds;
 *  (5) RECALC ON A ROUNDING CHANGE: the recalc kernel re-figures already-granted balances by exactly the
 *      difference, turning rounding off restores the raw figure, and downward rounding DOES claw back
 *      already-credited days (the plan's documented caveat) — signed, surfaced honestly. ⚠️ READ THE NOTE
 *      ON THAT DESCRIBE BEFORE TRUSTING IT: two guarantees this block used to carry are gone with the
 *      writer that carried them, and both are recorded there rather than asserted away;
 *  (6) LEDGER AGREEMENT: with rounding on, a later days-change reproject posts only the intended delta
 *      (the projection rounds too, so no permanent oscillating rounding delta appears);
 *  (7) static-source guard: the ONE dropdown-rendering form (Earning Method) posts the tri-state marker;
 *      the Carry Forward form posts no marker, so the writer preserves.
 *
 * The persistence round-trip through the server actions lives in leave-rounding-persistence.test.ts
 * (it needs the action-layer module mocks); i18n parity for the five new keys is appended to the
 * hardcoded key array in leave-type-general-substeps.test.ts.
 */
import { and, eq, like } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import {
  accrueEarnedLeave,
  openLeaveYear,
  projectExpectedEntitlement,
  reprojectEntitlementForLeaveTypeCohort,
  PROFILE_RECALC_REASON_PREFIX,
} from '../core/leave';
import { applyRounding, bandFor, type ServiceBand } from '../core/leave-compute';
import { annualEntitlement } from '../localization/my/leave';
import { leaveEntitlementBreakdown } from '../core/read';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';

const here = dirname(fileURLToPath(import.meta.url));

let b: Base;
const balance = (employmentId: string) => ledgerBalance(employmentId, b.annualLeaveTypeId);

const hire = (hiredOn: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Rounder', primaryEmail: `round_${randomUUID().slice(0, 8)}@t.local` },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    gradeId: null,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

/** Rule columns on the ANNUAL leave type — since 9816a5ad step 2, where every RULE is read from. */
const setTypeRules = (rules: Partial<typeof schema.leaveType.$inferInsert>) =>
  owner.db.update(schema.leaveType).set(rules).where(eq(schema.leaveType.id, b.annualLeaveTypeId));

/** What the leave type currently stores for rounding — the surface that replaced `accrual.roundingMethod`. */
const storedRounding = async (): Promise<string | null> => {
  const [row] = await owner.db
    .select({ roundingMethod: schema.leaveType.roundingMethod })
    .from(schema.leaveType)
    .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
  return row?.roundingMethod ?? null;
};

/**
 * The DAYS half — a flat entitlement table assigned to everybody — plus the rounding rule on the type.
 * `seedEntitlement` makes the two writes the reporter's two screens make.
 */
const entitlement = async (p: {
  annualDays: number;
  roundingMethod?: string;
  method?: string;
  validFrom?: string;
}) => {
  const tpl = await seedEntitlement(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays: p.annualDays,
    validFrom: p.validFrom ?? '2026-01-01',
  });
  const rules: Partial<typeof schema.leaveType.$inferInsert> = {};
  if (p.roundingMethod !== undefined) rules.roundingMethod = p.roundingMethod;
  if (p.method !== undefined) rules.accrualMethod = p.method;
  if (Object.keys(rules).length > 0) await setTypeRules(rules);
  return tpl;
};

/**
 * Every recalc-stamped ledger row for one employment (owner read — bypasses RLS for assertions).
 *
 * The prefix is `sys:profile_recalc`, not `sys:policy_recalc`. `POLICY_RECALC_REASON_PREFIX` was stamped
 * by `updateLeavePolicy` and by nothing else; with that writer gone it is now READ-only (the delta
 * predicate still honours rows already in the ledger) and WRITTEN by nothing at all. The surviving recalc
 * path stamps the profile prefix — see the ⚠️ note on the describe below.
 */
const recalcRows = (employmentId: string) =>
  owner.db
    .select({ days: schema.leaveLedger.days, entryType: schema.leaveLedger.entryType, effectiveOn: schema.leaveLedger.effectiveOn })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.employmentId, employmentId),
        like(schema.leaveLedger.reason, `${PROFILE_RECALC_REASON_PREFIX}:%`),
      ),
    );

/** Re-figure every employee against the CURRENT configuration — the kernel a rules change spends. */
const recalcCohort = (asOf: string) =>
  reprojectEntitlementForLeaveTypeCohort(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    trigger: 'leave_type_rules',
    asOf,
  });

/** A band-resolver closure for the pure projection kernel — the template's bands, without a database. */
const bandsFor = (bands: ServiceBand[]) => (years: number) => bandFor({ serviceBands: bands }, years);
const flat = (days: number): ServiceBand[] => [{ fromYears: 0, toYears: null, days }];

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

// ── (1) Pure helper ───────────────────────────────────────────────────────────────────────────────────
describe('b81d3c52 · applyRounding — whole-day, defensive', () => {
  it("rounds UP to the next whole day (the request's own worked examples)", () => {
    expect(applyRounding(10.9, 'up')).toBe(11);
    expect(applyRounding(10.5, 'up')).toBe(11);
    expect(applyRounding(10.91, 'up')).toBe(11);
    expect(applyRounding(10.01, 'up')).toBe(11);
  });

  it("rounds DOWN to the previous whole day (the request's own worked examples)", () => {
    expect(applyRounding(10.49, 'down')).toBe(10);
    expect(applyRounding(10.1, 'down')).toBe(10);
    expect(applyRounding(10.9, 'down')).toBe(10);
  });

  it('leaves an already-whole value untouched in every mode (rounding is idempotent)', () => {
    for (const m of ['up', 'down', 'none', undefined]) {
      expect(applyRounding(11, m)).toBe(11);
      expect(applyRounding(0, m)).toBe(0);
    }
    expect(applyRounding(applyRounding(10.9, 'up'), 'up')).toBe(11);
  });

  it('No Rounding (and an absent / unrecognised method) passes the value through EXACTLY', () => {
    expect(applyRounding(10.9, 'none')).toBe(10.9);
    expect(applyRounding(10.9, undefined)).toBe(10.9);
    expect(applyRounding(10.9, null)).toBe(10.9);
    // a stale/garbage JSONB value must never silently round — e.g. the UNRELATED pay-component vocabulary
    expect(applyRounding(10.9, 'nearest')).toBe(10.9);
    expect(applyRounding(10.9, 'half_up')).toBe(10.9);
  });

  it('DEFENSIVE: negatives round in the mathematical direction and non-finite values pass through', () => {
    expect(applyRounding(-10.5, 'up')).toBe(-10);
    expect(applyRounding(-10.5, 'down')).toBe(-11);
    expect(Number.isNaN(applyRounding(Number.NaN, 'up'))).toBe(true);
    expect(applyRounding(Number.POSITIVE_INFINITY, 'up')).toBe(Number.POSITIVE_INFINITY);
    expect(applyRounding(Number.NEGATIVE_INFINITY, 'down')).toBe(Number.NEGATIVE_INFINITY);
    // runs inside cron sweeps over hand-written JSONB — a bad value must never throw
    expect(() => applyRounding(undefined as unknown as number, 'up')).not.toThrow();
  });
});

// ── RETIRED · `resolveGradePolicy — rounding rides the WINNING policy row` (3 tests) ──────────────────
// The three cases were: the winning row's roundingMethod surfaces, a rejected row's never leaks, and a
// garbage stored value resolves to undefined. All three were about which of several competing
// `leave_policy` rows won — a competition that no longer happens. `resolveGradePolicy` was deleted with
// the table, and rounding is not a per-scope value at all any more: it is one column on the leave type, so
// there is no second row for it to leak from. The DEFENSIVE half — a garbage stored value must read as No
// Rounding rather than round something — survives on the surviving reader and is asserted twice above,
// against 'nearest' and 'half_up' in applyRounding, and by `applyLeaveTypeRules`' sanitiser in
// test/leave-type-rules-repoint.test.ts.

// ── (2) The configured figure, rounded, is what the ledger receives ───────────────────────────────────
describe('b81d3c52 · the rounded entitlement is exactly what gets credited', () => {
  // WAS `previewEntitlement — the preview can never disagree with the real grant`. The preview half is
  // gone: `previewEntitlement` resolved and described `leave_policy` rows (its `scope: group | company |
  // none` return value IS the policy tiering) and was deleted with them. The LEDGER half of each of those
  // three tests is kept verbatim, because it is the number the employee actually receives.
  it('Round Up credits the next whole day (fractional configured days)', async () => {
    await entitlement({ annualDays: 10.9, roundingMethod: 'up' });
    // Hire on 1 Jan ⇒ no pro-ration ⇒ the ledger grant IS the entitlement.
    const emp = await hire('2026-01-01');
    expect(await balance(emp.employmentId)).toBe(11);
  });

  it('Round Down credits the previous whole day', async () => {
    await entitlement({ annualDays: 10.9, roundingMethod: 'down' });
    const emp = await hire('2026-01-01');
    expect(await balance(emp.employmentId)).toBe(10);
  });

  it('BACK-COMPAT: with no rounding configured the exact fraction is credited, as today', async () => {
    await entitlement({ annualDays: 10.9 });
    const emp = await hire('2026-01-01');
    expect(await balance(emp.employmentId)).toBe(10.9);
  });

  it('the statutory floor does not lift a configured figure below it (fa3f4ccb), rounded or not', async () => {
    // Retained from the preview block's `belowStatutoryFloor` cases, which asserted the same rule on the
    // preview's own return value. ANNUAL at 0 years has a real MY floor of 8, so 5.4 genuinely crosses it.
    await entitlement({ annualDays: 5.4, roundingMethod: 'up' });
    const emp = await hire('2026-01-01');
    expect(annualEntitlement(0)).toBe(8); // the floor is real, so this is not a vacuous comparison
    expect(await balance(emp.employmentId)).toBe(6); // configured 5.4 rounded up — NOT lifted to 8
  });
});

// ── (3) Hire grant — the reporter's mid-year-joiner example ───────────────────────────────────────────
describe("b81d3c52 · joiner hire grant — the reporter's example, end to end", () => {
  // 20 days a year, joining mid-year: the whole-month pro-ration (UNCHANGED by this feature) produces
  // 20 × 7/12 = 11.67, and the Rounding Method then tidies THAT figure.
  const RAW_JOINER_GRANT = 11.67;

  it('BACK-COMPAT: No Rounding credits the exact calculated fraction', async () => {
    await entitlement({ annualDays: 20 });
    const emp = await hire('2026-06-15');
    expect(await balance(emp.employmentId)).toBe(RAW_JOINER_GRANT);
  });

  it('Round Up credits a WHOLE-day ledger grant, and the ledger-derived breakdown shows it', async () => {
    await entitlement({ annualDays: 20, roundingMethod: 'up' });
    const emp = await hire('2026-06-15');
    expect(await balance(emp.employmentId)).toBe(12);

    // Entitlement Calculation Breakdown / YTD Entitled are reconstructed from the LEDGER (core/read.ts) —
    // no display-layer change was made, so they show the rounded figure purely because the credit is rounded.
    const bd = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, b.annualLeaveTypeId, '2026-12-31');
    expect(bd!.currentYearEntitlement).toBe(12);
    expect(bd!.totalAvailable).toBe(12);
    expect(bd!.transactions.map((tx) => tx.days)).toEqual([12]);
  });

  it('Round Down credits the previous whole day', async () => {
    await entitlement({ annualDays: 20, roundingMethod: 'down' });
    const emp = await hire('2026-06-15');
    expect(await balance(emp.employmentId)).toBe(11);
    const bd = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, b.annualLeaveTypeId, '2026-12-31');
    expect(bd!.currentYearEntitlement).toBe(11);
  });
});

// ── Year-open grant ───────────────────────────────────────────────────────────────────────────────────
describe('b81d3c52 · openLeaveYear — the fresh grant is rounded, the carry-in is NOT', () => {
  it('rounds the year-open grant up while leaving a fractional carry-over intact', async () => {
    // No carry in year 1 ⇒ the 2027 balance is purely the rounded 2027 grant. The cap is 0 because the
    // type states a rounding rule and nothing else, so `applyLeaveTypeRules` resolves carryMax from the
    // type's own (NULL) carry columns — byte-identical to the old policy-level `carryForwardMax` default.
    await entitlement({ annualDays: 12.4, roundingMethod: 'up', validFrom: '2026-01-01' });
    const emp = await hire('2026-01-01');
    expect(await balance(emp.employmentId)).toBe(13); // hire grant, rounded

    await openLeaveYear(adminCtx(b), { year: 2027 });
    // carry cap 0 ⇒ all 13 forfeited, then a fresh rounded grant of 13.
    expect(await balance(emp.employmentId)).toBe(13);
  });

  it('DOCUMENTED CAVEAT: a fractional carry-over plus a whole grant still yields a fractional balance', async () => {
    // The carry-in is deliberately NOT rounded — rounding shapes the ENTITLEMENT, not every balance.
    await entitlement({ annualDays: 12.4, roundingMethod: 'down', validFrom: '2026-01-01' });
    await setTypeRules({ carryForwardMax: '20', carryForwardEnabled: true });
    expect(await storedRounding()).toBe('down');

    const emp = await hire('2026-01-01');
    expect(await balance(emp.employmentId)).toBe(12); // 12.4 floored

    // Post a fractional manual adjustment so the carry-in itself is fractional.
    await owner.db.insert(schema.leaveLedger).values({
      tenantId: b.tenantId,
      employmentId: emp.employmentId,
      leaveTypeId: b.annualLeaveTypeId,
      entryType: 'adjustment',
      days: '0.50',
      effectiveOn: '2026-07-01',
    });
    expect(await balance(emp.employmentId)).toBe(12.5);

    await openLeaveYear(adminCtx(b), { year: 2027 });
    // carry 12.5 (unrounded, under the 20-day cap) + a floored grant of 12 = 24.5 — a fraction survives.
    expect(await balance(emp.employmentId)).toBe(24.5);
  });
});

// ── (4) Accrual Process ───────────────────────────────────────────────────────────────────────────────
describe('b81d3c52 · accrueEarnedLeave — the cumulative is rounded every period', () => {
  it('Round Up shows whole days as they build (each period rounds the CUMULATIVE)', async () => {
    await entitlement({ annualDays: 14, method: 'earned_monthly', roundingMethod: 'up' });
    const emp = await hire('2026-01-01');
    expect(await balance(emp.employmentId)).toBe(0); // earned ⇒ no hire lump

    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-01-15' }); // 14/12 × 1 = 1.17 ⇒ 2
    expect(await balance(emp.employmentId)).toBe(2);
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-02-15' }); // 2.33 ⇒ 3
    expect(await balance(emp.employmentId)).toBe(3);
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-03-15' }); // 3.50 ⇒ 4
    expect(await balance(emp.employmentId)).toBe(4);
  });

  it('Round Down floors a small early cumulative to 0 (NO ledger row), then builds', async () => {
    // annualDays 8 = the EA floor ⇒ entitlement 8, so 1/12 of it is under a day.
    await entitlement({ annualDays: 8, method: 'earned_monthly', roundingMethod: 'down' });
    const emp = await hire('2026-01-01');

    const r1 = await accrueEarnedLeave(adminCtx(b), { asOf: '2026-01-15' }); // 0.67 ⇒ 0
    expect(r1.granted).toBe(0); // the toGrant > 0 guard writes NOTHING
    expect(await balance(emp.employmentId)).toBe(0);

    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-02-15' }); // 1.33 ⇒ 1
    expect(await balance(emp.employmentId)).toBe(1);
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-03-15' }); // 2.00 ⇒ 2
    expect(await balance(emp.employmentId)).toBe(2);
  });

  it('BACK-COMPAT: with no rounding the cumulative keeps its fraction, exactly as today', async () => {
    await entitlement({ annualDays: 14, method: 'earned_monthly' });
    const emp = await hire('2026-01-01');
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-03-15' });
    expect(await balance(emp.employmentId)).toBe(3.5);
  });
});

// ── (5) Recalc on a rounding change ───────────────────────────────────────────────────────────────────
/**
 * ⚠️ WHAT THIS BLOCK PROVED, AND WHAT IT NOW PROVES — READ BEFORE TRUSTING IT. TWO THINGS ARE MISSING AND
 * NEITHER WAS QUIETLY ASSERTED AWAY.
 *
 * These three tests used to drive `updateLeavePolicy`, which BOTH stored the new rounding method AND fired
 * the recalc, and they asserted its `{ affected, totalDelta }` return. That writer went with
 * `leave_policy`. What survives is repointed onto `reprojectEntitlementForLeaveTypeCohort` — the kernel a
 * recalc spends — called EXPLICITLY, and every DAY FIGURE below is unchanged: the +0.6 correction, the −1
 * clawback, the restored 12.4, the idempotent second run, the forward-only accrual afterwards.
 *
 * ① NOTHING FIRES IT ANY MORE. The surviving rules writer does not reproject on a rounding change:
 *    `setLeaveTypeRulesAction` reprojects only when `unconfiguredCleared` (app/admin/actions.ts:675-677),
 *    i.e. when the earning-method NOT-CONFIGURED marker is cleared. So this file proves the kernel
 *    computes the right correction, NOT that saving a rounding change causes one to be computed. Closing
 *    that would mean inventing a writer that does not exist, which is not a test's job.
 *
 * ② THE CORRECTION IS NO LONGER ACCRUAL-CLASS, AND THAT IS b81d3c52'S OWN REQUIREMENT INVERTED. The
 *    retired assertions were `rows[0].entryType === 'accrual'`, `breakdown.currentYearEntitlement === 13`
 *    and `breakdown.otherAdjustments === 0` — "the tidied value lands ON the entitlement figure, not
 *    beside it as a separate adjustment". `reprojectEntitlementForEmployment` posts an `adjustment`
 *    (core/leave.ts:7623-7634), and measured here on 12.4 ⇒ Round Up the breakdown now reads
 *    currentYearEntitlement 12.4, otherAdjustments 0.6, totalAvailable 13. The BALANCE is right; the
 *    entitlement line the reporter reads is not. core/leave.ts already knows this class of row "never
 *    moves YTD Entitled" — it is why a2c's first year is delegated to an accrual-class path.
 *
 *    Those three assertions are RETIRED, not flipped. Asserting `toBe('adjustment')` would record the
 *    regression as the intended behaviour and quietly close the ticket that asked for the opposite. It is
 *    reported with the round instead; the fix belongs in core, not here.
 */
describe('b81d3c52 · RECALC ON A ROUNDING CHANGE — the configured rule reaches already-earned balances', () => {
  it('a rounding-only change re-figures already-granted balances via an ACCRUAL-class row', async () => {
    await entitlement({ annualDays: 12.4 });
    const emp = await hire('2026-01-01');
    expect(await balance(emp.employmentId)).toBe(12.4);

    // Flipping the rule re-figures every already-earned balance to the rounded value. The correction is
    // ACCRUAL-class, so it lands ON the entitlement figure (leaveBalances.accrued / breakdown.cycleAccrual),
    // not beside it as a separate adjustment.
    await setTypeRules({ roundingMethod: 'up' });
    const res = await recalcCohort('2026-06-30');
    expect(res).toEqual({ employees: 1, affected: 1, totalDelta: 0.6 });
    expect(await balance(emp.employmentId)).toBe(13); // ceil(12.4)
    expect(await storedRounding()).toBe('up');

    // EXACTLY ONE correction row, carrying the whole difference. The entry-CLASS assertion that stood
    // here is retired — see ② on this describe; the count and the signed day figure are not.
    const rows = await recalcRows(emp.employmentId);
    expect(rows.length).toBe(1);
    expect(Number(rows[0].days)).toBe(0.6);

    // The BALANCE the correction produces is still asserted end to end, through the ledger-derived reader.
    const bd = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, b.annualLeaveTypeId, '2026-12-31');
    expect(bd!.totalAvailable).toBe(13);

    // Idempotent: an identical re-run computes delta 0 and posts no second row.
    const again = await recalcCohort('2026-06-30');
    expect(again).toEqual({ employees: 1, affected: 0, totalDelta: 0 });
    expect((await recalcRows(emp.employmentId)).length).toBe(1);
  });

  it('DOWNWARD-ROUNDING CLAWBACK (the plan caveat): switching to Round Down re-figures the earned balance DOWN', async () => {
    await entitlement({ annualDays: 14, method: 'earned_monthly', roundingMethod: 'up' });
    const emp = await hire('2026-01-01');
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-03-15' }); // 3.5 ⇒ up ⇒ 4
    expect(await balance(emp.employmentId)).toBe(4);

    // The single change-gate cannot enable up-only: turning rounding DOWN re-figures already-credited days
    // to the floored value (3.5 ⇒ 3). This is deliberate and matches the reporter's request (surfaced under
    // GOOD TO KNOW). The correction is a signed ACCRUAL-class row (−1), so the entitlement line drops too.
    await setTypeRules({ roundingMethod: 'down' });
    const res = await recalcCohort('2026-03-15');
    expect(res).toEqual({ employees: 1, affected: 1, totalDelta: -1 });
    expect(await balance(emp.employmentId)).toBe(3);
    const rows = await recalcRows(emp.employmentId);
    expect(rows.length).toBe(1);
    // Entry class retired here for the same reason as above (② on this describe). The SIGN is the point of
    // this test and it is kept: a downward rounding change really does post a negative correction.
    expect(Number(rows[0].days)).toBe(-1);

    // The cron re-run at the SAME date double-counts nothing: its `already` sum sees the accrual-class
    // correction, so cumulative 3 − already 3 = 0 (the correction is not re-granted).
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-03-15' });
    expect(await balance(emp.employmentId)).toBe(3);

    // Only FORWARD periods accrue: at 5 months the floored cumulative is 5, so a +2 top-up lands over 3.
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-05-15' }); // 5.83 ⇒ 5
    expect(await balance(emp.employmentId)).toBe(5);
  });

  it('turning rounding OFF (up ⇒ none) restores the exact earned figure (symmetric)', async () => {
    await entitlement({ annualDays: 12.4 });
    const emp = await hire('2026-01-01');
    await setTypeRules({ roundingMethod: 'up' });
    await recalcCohort('2026-06-30');
    expect(await balance(emp.employmentId)).toBe(13);

    // Clearing the rule back to No Rounding is a rounding change up ⇒ none; the reproject restores 12.4.
    await setTypeRules({ roundingMethod: null });
    const off = await recalcCohort('2026-06-30');
    expect(off).toEqual({ employees: 1, affected: 1, totalDelta: -0.6 });
    expect(await balance(emp.employmentId)).toBe(12.4);
    expect(await storedRounding()).toBeNull();
  });
});

// ── (6) Ledger agreement ──────────────────────────────────────────────────────────────────────────────
describe('b81d3c52 · LEDGER AGREEMENT — the projection rounds exactly like the engines', () => {
  // `projectExpectedEntitlement` lost its `policyRows` parameter with `leave_policy` and gained
  // `templateBandForYears` — a FUNCTION of service length, because the kernel re-resolves internally on the
  // anniversary branch. Both fixtures below hand it the same flat band the DB fixture would produce, so
  // these stay pure unit tests of the kernel and keep their exact expected figures.
  const floor = (code: string, years: number) => (code === 'ANNUAL' ? annualEntitlement(years) : 0);

  it('projectExpectedEntitlement returns the ROUNDED figure on the joiner + full-grant branches', () => {
    const joiner = projectExpectedEntitlement(
      { hiredOn: '2026-06-15', leaveCycle: 'calendar', gradeId: null, companyId: b.companyId },
      'ANNUAL',
      floor,
      '2026-12-31',
      null,
      { roundingMethod: 'up' },
      bandsFor(flat(20)),
    );
    expect(joiner!.expected).toBe(12); // 11.67 raw ⇒ rounded up, matching the hire grant

    const existing = projectExpectedEntitlement(
      { hiredOn: '2020-01-01', leaveCycle: 'calendar', gradeId: null, companyId: b.companyId },
      'ANNUAL',
      floor,
      '2026-12-31',
      null,
      { roundingMethod: 'up' },
      bandsFor(flat(20)),
    );
    expect(existing!.expected).toBe(20); // already whole — rounding is a no-op, not a drift source
  });

  it('projectExpectedEntitlement rounds the EARNED branch too', () => {
    const proj = projectExpectedEntitlement(
      { hiredOn: '2026-01-01', leaveCycle: 'calendar', gradeId: null, companyId: b.companyId },
      'ANNUAL',
      floor,
      '2026-03-15',
      null,
      { accrualMethod: 'earned_monthly', roundingMethod: 'up' },
      bandsFor(flat(14)),
    );
    expect(proj!.expected).toBe(4); // 3.5 ⇒ up ⇒ 4 — identical to what accrueEarnedLeave credits
  });

  it('a later days-change reproject posts ONLY the intended delta — no oscillating rounding delta', async () => {
    const tpl = await entitlement({ annualDays: 12.4, roundingMethod: 'up' });
    const emp = await hire('2026-01-01');
    expect(await balance(emp.employmentId)).toBe(13); // ceil(12.4)

    // Correct the days upward. The projection rounds (ceil(14.6) = 15) exactly as the engines do, so the
    // delta is the clean +2. Without rounding in the kernel it would be 14.6 − 13 = 1.6 and the ledger
    // would permanently disagree with what a fresh grant produces.
    //
    // The days edit is an in-place correction of the SAME leave year, so the band is rewritten on the
    // running template version rather than superseded into a new one — a successor starting mid-2026 would
    // change which figure was in force when, which is a different scenario from the one under test.
    await owner.db
      .update(schema.entitlementTemplate)
      .set({ serviceBands: flat(14.6) })
      .where(eq(schema.entitlementTemplate.lineageId, tpl.lineageId));

    const up = await recalcCohort('2026-06-30');
    expect(up).toEqual({ employees: 1, affected: 1, totalDelta: 2 });
    expect(await balance(emp.employmentId)).toBe(15);

    // Idempotent: an identical re-run computes delta 0 and posts nothing (no oscillation).
    const again = await recalcCohort('2026-06-30');
    expect(again).toEqual({ employees: 1, affected: 0, totalDelta: 0 });
    expect(await balance(emp.employmentId)).toBe(15);
  });
});

// ── RETIRED · `b81d3c52 · storage — a No-Rounding policy stores NOTHING new` (2 tests) ────────────────
// Both asserted on `leave_policy.accrual`: that 'none' / absent / garbage omit the key entirely so a
// re-saved untouched row stays byte-identical to what it was before the feature existed, and that
// `updateLeavePolicy` can clear a stored method back to No Rounding. The JSONB, both writers and the table
// are gone. The equivalent property on the surviving surface — 'none' stores as NULL (or as the literal
// 'none' when it is the type's only rule, so the type never falls through to unruled) — is asserted in
// test/leave-rounding-bands.test.ts §3 and §4, and the clear-back-to-No-Rounding round trip through the
// real server action is test/leave-rounding-persistence.test.ts §1.

// ── (7) Static source guard ───────────────────────────────────────────────────────────────────────────
describe('b81d3c52 · UI source guard — the dropdown-rendering form posts the tri-state marker; the other preserves', () => {
  const panelSrc = readFileSync(resolve(here, '../components/leave-type-panel.tsx'), 'utf8');
  const pageSrc = readFileSync(resolve(here, '../app/admin/leave/entitlements/page.tsx'), 'utf8');
  const actionsSrc = readFileSync(resolve(here, '../app/admin/actions.ts'), 'utf8');

  it('EarningMethodForm renders the Rounding Method select AND posts the tri-state marker', () => {
    const form = panelSrc.slice(panelSrc.indexOf('function EarningMethodForm'), panelSrc.indexOf('function CarryPolicyForm'));
    expect(form).toContain("name=\"roundingMethod\"");
    expect(form).toContain("t('subStep.roundingMethodLabel')");
    expect(form).toContain("t('subStep.roundingNone')");
    // 8fec719e — two options, and the retired three must not survive on this form.
    expect(form).toContain("t('subStep.roundingCustom')");
    expect(form).not.toContain("t('subStep.roundingUp')");
    expect(form).not.toContain("t('subStep.roundingDown')");
    expect(form).not.toContain("t('subStep.roundingNearestHalf')");
    expect(form).toContain("t('subStep.roundingHelp')");
    // 9816a5ad step 2: the initial value comes from the leave TYPE's own rules, not a policy row.
    //
    // 9f5164d8 made the select CONTROLLED rather than defaultValue'd, and the reason is behavioural, not
    // stylistic: the band table (8fec719e; the "Customize decimal thresholds" checkbox before it) renders
    // only under the tunable method, and the worked example recomputes as the method changes. An
    // uncontrolled select cannot drive either. The SEED is unchanged — `roundingMethodValue(rules.roundingMethod)`
    // is still what the state starts from — so what an administrator sees on load is byte-identical.
    expect(form).toContain("value={rounding}");
    expect(form).toContain('useState<LeaveRoundingMethod>(roundingMethodValue(rules.roundingMethod))');
    // renders the dropdown ⇒ posts the marker so 'none' CLEARS and 'custom' SETS.
    expect(form).toContain('name="roundingMethodRendered"');
  });

  it('CarryPolicyForm posts NO marker and NO hidden roundingMethod input — the writer preserves it', () => {
    const form = panelSrc.slice(panelSrc.indexOf('function CarryPolicyForm'));
    const body = form.slice(0, form.indexOf('</form>'));
    // tri-state (this ticket): the fragile hidden pass-through input is gone; absent marker ⇒ preserve.
    expect(body).not.toContain('name="roundingMethod"');
    expect(body).not.toContain('name="roundingMethodRendered"');
  });

  // ── RETIRED · the two per-policy form guards ────────────────────────────────────────────────────────
  // `the Eligibility inline EDIT form posts NO marker…` and `8fec719e — the multi-scope ADD form renders
  // NO rounding control at all` both located their form by `panelSrc.indexOf('action={updatePolicyAction}')`
  // / `'action={createPolicyAction}'`. Neither action exists any more — both were `leave_policy` writers —
  // so `indexOf` returns −1, the slice is empty, and every `not.toContain` on it passes VACUOUSLY. A guard
  // that cannot fail is worse than no guard, so they are deleted rather than left to report green on a
  // surface that is not there.

  it('the Entitlements page reads roundingMethod from the LEAVE TYPE onto the panel', () => {
    // REPOINTED, not deleted. The assertion was `roundingMethod: acc?.roundingMethod` — the policy row's
    // JSONB. 9816a5ad step 2 moved the rule to the type, so the same guard now names the type's column:
    // the panel must be seeded from the surface the writer writes, or the dropdown shows one value while
    // the engine spends another.
    expect(pageSrc).toContain('roundingMethod: (lt.roundingMethod as LeaveRoundingMethod | null) ?? null');
  });

  it('every action that writes rounding threads the SAME normalized field', () => {
    expect(actionsSrc).toContain('const roundingMethodField =');
    // The count is PINNED, and it is now 1 — down from 3, because the two `leave_policy` writers
    // (createLeavePolicyAction / updateLeavePolicyAction) went with the table, leaving
    // setLeaveTypeRulesAction as the only writer. The number is updated rather than the assertion
    // loosened: the whole point of the tri-state helper is that 'none' means CLEAR everywhere,
    // identically, and a second writer appearing with its own ad-hoc normalization must turn this red.
    expect(actionsSrc.match(/roundingMethod: roundingMethodField\(formData\)/g)?.length).toBe(1);
    // 8fec719e — the band table has exactly ONE reader too, on the same marker, for the same reason.
    expect(actionsSrc).toContain('const roundingBandsField =');
    expect(actionsSrc.match(/roundingBands: roundingBandsField\(formData\)/g)?.length).toBe(1);
  });
});
