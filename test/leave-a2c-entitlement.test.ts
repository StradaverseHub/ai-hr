/**
 * Anniversary to Calendar leave year type — enablement + first-year entitlement (feedback f3a64d90,
 * migration 0310).
 *
 * e1a51aea shipped the "Leave Year Type" per-type override but PARKED its third value, 'a2c'
 * (Anniversary to Calendar): the option rendered disabled, updateLeaveType rejected it, and the DB CHECK
 * admitted only ('a2a','c2c'). This item switches it on AND teaches the engine the calculation, together.
 *
 * The model under test (adcdf215 — UP-FRONT first year):
 *  • a2c's leave YEAR is the CALENDAR year (resolveLeaveYearCycle maps it to 'calendar'), so carry
 *    anchoring and the year-two full grant are the ordinary calendar ones — no third cycle token.
 *  • The ONLY novelty is the employee's FIRST (hire) year on ANNUAL: the full prorated part-year
 *    entitlement (resolved entitlement ÷ 365) × days from join to 31 Dec, clamped to the annual amount, is
 *    available UP FRONT at hire — independent of asOf, not built day by day. A first-year LEAVER is capped
 *    at their last day of service (serviceEnd) so encashment / final pay is never over-granted.
 *  • The correction posts ACCRUAL-CLASS rows (not adjustments), because "YTD Entitled" counts only
 *    entryType in ('accrual','in_lieu_accrual') — an adjustment alone could never move YTD Entitled to the
 *    up-front target — plus a compensating reversal of the superseded system rows so Balance/Available agree.
 *
 * Under test:
 *  (1) HAPPY PATH — the reporter's own case, now UP FRONT: hired 2026-01-06, ANNUAL 20 days, checked
 *      2026-07-23 ⇒ YTD Entitled 19.73 (20/365 × 360, full year-end proration available at hire); with 3.50
 *      taken, Available 16.23 and Balance 16.23, surfaced by leaveBalances AND leaveEntitlementBreakdown.
 *  (2) LEAP YEAR — a 366-day first year clamps to the annual entitlement (20.00, never 20.05).
 *  (3) NON-ANNUAL — a2c on SICK grants in FULL (EA s.60F), never day-sliced.
 *  (4) CLAW-DOWN through the real HR action — updateLeaveType saving a2c corrects an already-wrong
 *      employee DOWN and reconciles the stale system rows, so Balance nets to the expected figure; and
 *      re-running is idempotent.
 *  (5) YEAR TWO — from the next 1 Jan a2c is an ordinary calendar type: openLeaveYear grants the full 20
 *      and the a2c correction does nothing.
 *  (6) EA-FLOOR / SCHEME — the day slice is taken off the FULLY resolved entitlement (statutory floor ∨
 *      benefit-scheme band ∨ policy days), never the raw policy number.
 *  (7) PERSISTENCE — a2c survives the REAL database CHECK (migration 0310), not only the app-layer store.
 */
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { hireEmployee } from '../core/org';
import { createLeavePolicy, updateLeaveType } from '../core/admin';
import {
  a2cFirstYearEntitledToDate,
  isA2cFirstYear,
  openLeaveYear,
  projectExpectedEntitlement,
  reprojectEntitlementForEmployment,
  A2C_RECALC_REASON_PREFIX,
  POLICY_RECALC_REASON_PREFIX,
  type GradePolicyRow,
} from '../core/leave';
import { leaveBalances, leaveEntitlementBreakdown } from '../core/read';
import { adminCtx, closeAll, ledgerBalance, migrateTestDb, owner, resetDb, seedBase, type Base } from './harness';

let b: Base;
const uniqEmail = () => `a2c_${randomUUID().slice(0, 8)}@t.local`;

/** The reporter's scenario: joined 6 Jan 2026, checked 23 Jul 2026 ⇒ 199 days worked (inclusive). */
const HIRED = '2026-01-06';
const ASOF = '2026-07-23';

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

const setOverride = (v: string | null, asOf?: string) =>
  updateLeaveType(adminCtx(b), { id: b.annualLeaveTypeId, name: 'Annual Leave', yearCycleOverride: v, asOf });

const annualPolicy = (annualDays: number) =>
  createLeavePolicy(adminCtx(b), {
    leaveTypeId: b.annualLeaveTypeId,
    annualDays,
    validFrom: '2026-01-01',
  });

const hire = (opts?: { hiredOn?: string; grants?: { id: string; code: string; yearCycleOverride?: string | null }[] }) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'A2C Emp', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn: opts?.hiredOn ?? HIRED,
    grantLeaveTypes: opts?.grants ?? [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

/** A taken-leave debit, posted straight to the ledger (owner read/write bypasses RLS for fixtures). */
const debit = (employmentId: string, days: number, effectiveOn: string, leaveTypeId?: string) =>
  owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId: leaveTypeId ?? b.annualLeaveTypeId,
    entryType: 'debit',
    days: (-days).toFixed(2),
    effectiveOn,
  });

/** A stale system row of the kind the a2c model supersedes (a recalc adjustment from the old model). */
const staleRecalcAdjustment = (employmentId: string, days: number, effectiveOn: string) =>
  owner.db.insert(schema.leaveLedger).values({
    tenantId: b.tenantId,
    employmentId,
    leaveTypeId: b.annualLeaveTypeId,
    entryType: 'adjustment',
    days: days.toFixed(2),
    effectiveOn,
    reason: `${POLICY_RECALC_REASON_PREFIX}:${randomUUID()}`,
  });

const annualSummary = async (employmentId: string) => {
  const rows = await leaveBalances(adminCtx(b), employmentId);
  return rows.find((r) => r.leaveTypeId === b.annualLeaveTypeId)!;
};

/** Accrual-class total inside a calendar window (what "YTD Entitled" sums). */
const accruedInYear = async (employmentId: string, year: number, leaveTypeId?: string) => {
  const [row] = await owner.db
    .select({ v: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.employmentId, employmentId),
        eq(schema.leaveLedger.leaveTypeId, leaveTypeId ?? b.annualLeaveTypeId),
        sql`${schema.leaveLedger.entryType} in ('accrual','in_lieu_accrual')`,
        sql`${schema.leaveLedger.effectiveOn} >= ${`${year}-01-01`}`,
        sql`${schema.leaveLedger.effectiveOn} <= ${`${year}-12-31`}`,
      ),
    );
  return Number(row?.v ?? 0);
};

const a2cRows = (employmentId: string) =>
  owner.db
    .select({ entryType: schema.leaveLedger.entryType, days: schema.leaveLedger.days, effectiveOn: schema.leaveLedger.effectiveOn })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.employmentId, employmentId),
        sql`${schema.leaveLedger.reason} like ${`${A2C_RECALC_REASON_PREFIX}:%`}`,
      ),
    );

// ── (1) HAPPY PATH — the reporter's numbers ────────────────────────────────────────────────────────
describe('f3a64d90 — first-year up-front entitlement (the reporter’s case)', () => {
  it('hired 6 Jan 2026 on 20 ANNUAL days ⇒ YTD 19.73, Available 16.23, Balance 16.23 at 23 Jul 2026', async () => {
    await annualPolicy(20);
    await setOverride('a2c', ASOF);
    const { employmentId } = await hire({
      grants: [{ id: b.annualLeaveTypeId, code: 'ANNUAL', yearCycleOverride: 'a2c' }],
    });
    // adcdf215: the hire grant opens at the FULL up-front part-year figure (20/365 × 360 = 19.73), NOT a
    // day-one sliver and NOT the hire-month lump of 20.
    expect(await ledgerBalance(employmentId, b.annualLeaveTypeId)).toBe(19.73);

    await debit(employmentId, 3.5, '2026-06-10');
    await reprojectEntitlementForEmployment(adminCtx(b), { employmentId, asOf: ASOF, trigger: 'test' });

    const s = await annualSummary(employmentId);
    expect(s.accrued).toBe(19.73); // YTD Entitled — accrual-class only, up front and asOf-independent
    expect(s.taken).toBe(3.5);
    expect(s.pending).toBe(0);
    expect(s.balance).toBe(16.23);
    expect(s.available).toBe(16.23);

    // The Entitlement breakdown panel reads the same ledger and must agree line for line.
    const bd = await leaveEntitlementBreakdown(adminCtx(b), employmentId, b.annualLeaveTypeId, ASOF);
    expect(bd!.cycleStart).toBe('2026-01-01'); // a2c's leave YEAR is the calendar year
    expect(bd!.currentYearEntitlement).toBe(19.73);
    expect(bd!.totalAvailable).toBe(16.23);
  });

  it('is idempotent — a second recalc at the same date writes nothing', async () => {
    await annualPolicy(20);
    await setOverride('a2c', ASOF);
    const { employmentId } = await hire({
      grants: [{ id: b.annualLeaveTypeId, code: 'ANNUAL', yearCycleOverride: 'a2c' }],
    });
    await reprojectEntitlementForEmployment(adminCtx(b), { employmentId, asOf: ASOF, trigger: 'test' });
    const first = await a2cRows(employmentId);
    const r2 = await reprojectEntitlementForEmployment(adminCtx(b), { employmentId, asOf: ASOF, trigger: 'test' });
    expect(r2.affected).toBe(0);
    expect(await a2cRows(employmentId)).toHaveLength(first.length);
    expect((await annualSummary(employmentId)).accrued).toBe(19.73);
  });
});

// ── (2) LEAP YEAR — the mandatory clamp ────────────────────────────────────────────────────────────
describe('f3a64d90 — a2cFirstYearEntitledToDate', () => {
  it('reproduces the reporter’s up-front arithmetic (20 ÷ 365 × 360 = 19.73)', () => {
    expect(a2cFirstYearEntitledToDate(HIRED, ASOF, 20)).toBe(19.73);
  });

  it('clamps a 366-day leap first year to the annual entitlement (20.00, not 20.05)', () => {
    // 2028 is a leap year: a 1-Jan hire works 366 days, and 20/365 × 366 = 20.05 without the clamp.
    expect(a2cFirstYearEntitledToDate('2028-01-01', '2028-12-31', 20)).toBe(20);
  });

  it('is asOf-independent within the hire year (window ends 31 Dec), and floors a pre-hire asOf at 0', () => {
    // adcdf215: the up-front window end is 31 Dec of the HIRE year, so a later-year asOf and a 31-Dec asOf
    // both give the same figure — the value never tracks asOf for an active employee.
    expect(a2cFirstYearEntitledToDate(HIRED, '2027-06-30', 20)).toBe(a2cFirstYearEntitledToDate(HIRED, '2026-12-31', 20));
    expect(a2cFirstYearEntitledToDate(HIRED, '2026-01-05', 20)).toBe(0); // pre-hire guard
  });

  it('is asOf-independent for an ACTIVE hire (hire date, mid-year, 31 Dec all give 19.73; pre-hire is 0)', () => {
    // adcdf215: the full up-front figure is available from day one and does not build over the year.
    expect(a2cFirstYearEntitledToDate(HIRED, HIRED, 20)).toBe(19.73); // available immediately at hire
    expect(a2cFirstYearEntitledToDate(HIRED, ASOF, 20)).toBe(19.73); // mid-year — same figure
    expect(a2cFirstYearEntitledToDate(HIRED, '2026-12-31', 20)).toBe(19.73); // year-end — same figure
    expect(a2cFirstYearEntitledToDate(HIRED, '2026-01-05', 20)).toBe(0); // one day before hire ⇒ floored
  });

  it('caps a first-year LEAVER at their last day of service (serviceEnd), not the full year', () => {
    // adcdf215: a leaver terminated 2026-03-15 (69 days worked, inclusive) prorates to 20/365 × 69 = 3.78,
    // well below the 19.73 an active employee would carry — so encashment / final pay is never over-granted.
    expect(a2cFirstYearEntitledToDate(HIRED, ASOF, 20, '2026-03-15')).toBe(3.78);
    expect(a2cFirstYearEntitledToDate(HIRED, ASOF, 20, '2026-03-15')).toBeLessThan(a2cFirstYearEntitledToDate(HIRED, ASOF, 20));
    // A serviceEnd in a LATER year does not cap (still the full up-front figure).
    expect(a2cFirstYearEntitledToDate(HIRED, ASOF, 20, '2027-02-01')).toBe(19.73);
  });

  it('clamps the up-front figure to the winning band’s Maximum Balance from hire (cap 10 < 19.73)', () => {
    // adcdf215: projectExpectedEntitlement applies the max-balance cap on the up-front figure, so the cap
    // bites IMMEDIATELY at hire rather than partway through the year as the old build-up did.
    const capped: GradePolicyRow[] = [
      { gradeId: null, companyId: null, accrual: { annualDays: 20, serviceBands: [{ fromYears: 0, toYears: null, days: 20, maxBalanceDays: 10 }] } },
    ];
    const emp = { hiredOn: HIRED, leaveCycle: 'calendar' as string | null, gradeId: null, companyId: 'c1' };
    const res = projectExpectedEntitlement(emp, 'ANNUAL', capped, () => 0, ASOF, undefined, 'a2c');
    expect(res!.expected).toBe(10); // min(19.73, cap 10)
  });

  it('bounds the special first-year window to ANNUAL in the hire year', () => {
    expect(isA2cFirstYear('a2c', 'ANNUAL', HIRED, ASOF)).toBe(true);
    expect(isA2cFirstYear('a2c', 'SICK', HIRED, ASOF)).toBe(false); // EA s.60F — never day-sliced
    expect(isA2cFirstYear('a2c', 'ANNUAL', HIRED, '2027-07-23')).toBe(false); // year two = plain calendar
    expect(isA2cFirstYear('c2c', 'ANNUAL', HIRED, ASOF)).toBe(false);
    expect(isA2cFirstYear(null, 'ANNUAL', HIRED, ASOF)).toBe(false);
  });
});

// ── (3) NON-ANNUAL — statutory full grant ──────────────────────────────────────────────────────────
describe('f3a64d90 — non-ANNUAL types are never day-sliced', () => {
  // fa3f4ccb: the statutory pack no longer BACKFILLS an unconfigured type, so this test now configures
  // SICK explicitly (14 days — the s.60F <2y figure) and asserts the invariant it actually exists to
  // protect: a non-ANNUAL a2c type is granted in FULL, never day-sliced to 14/365 × 1.
  it('a2c on SICK grants the configured entitlement in FULL to a mid-year joiner', async () => {
    const [sick] = await owner.db
      .insert(schema.leaveType)
      .values({ tenantId: b.tenantId, code: 'SICK', name: 'Sick Leave', paid: true, yearCycleOverride: 'a2c' })
      .returning({ id: schema.leaveType.id });
    await owner.db.insert(schema.leavePolicy).values({
      tenantId: b.tenantId,
      leaveTypeId: sick.id,
      gradeId: null,
      companyId: null,
      accrual: { annualDays: 14 },
      validFrom: '2020-01-01',
    });
    const { employmentId } = await hire({
      grants: [{ id: sick.id, code: 'SICK', yearCycleOverride: 'a2c' }],
    });
    const granted = await ledgerBalance(employmentId, sick.id);
    expect(granted).toBe(14); // FULL, not 14/365 × 1

    // And the a2c correction leaves it alone (delta 0 — the ordinary full-grant projection matches).
    await reprojectEntitlementForEmployment(adminCtx(b), { employmentId, asOf: ASOF, trigger: 'test' });
    expect(await accruedInYear(employmentId, 2026, sick.id)).toBe(granted);
  });
});

// ── (4) CLAW-DOWN via the real HR action ───────────────────────────────────────────────────────────
describe('f3a64d90 — saving the Leave Year Type corrects everyone already affected', () => {
  it('claws an over-granted employee DOWN and reconciles the stale system rows so Balance nets right', async () => {
    await annualPolicy(20);
    // The pre-existing wrong state: a full hire-month lump of 20, a stale −9.50 recalc row from the old
    // model, and 3.50 days taken ⇒ the reporter's shape (YTD too low / Balance nonsensical).
    const { employmentId } = await hire();
    expect(await accruedInYear(employmentId, 2026)).toBe(20);
    await staleRecalcAdjustment(employmentId, -9.5, '2026-05-01');
    await debit(employmentId, 3.5, '2026-06-10');
    const before = await annualSummary(employmentId);
    expect(before.accrued).toBe(20);
    expect(before.balance).toBe(7);

    // HR picks "Anniversary to Calendar" and saves — nothing else.
    await setOverride('a2c', ASOF);

    const after = await annualSummary(employmentId);
    expect(after.accrued).toBe(19.73); // clawed DOWN from 20 to the a2c up-front target (accrual-class)
    expect(after.taken).toBe(3.5);
    expect(after.balance).toBe(16.23); // the stale −9.50 was reversed, so Balance = 19.73 − 3.50
    expect(after.available).toBe(16.23);

    // Both row classes were written under the one a2c reason (the top-up and the reversal).
    const rows = await a2cRows(employmentId);
    expect(rows.map((r) => r.entryType).sort()).toEqual(['accrual', 'adjustment']);

    // Re-running the correction is inert (both classes are read back into the next run's sums).
    await reprojectEntitlementForEmployment(adminCtx(b), { employmentId, asOf: ASOF, trigger: 'test' });
    const again = await annualSummary(employmentId);
    expect(again.accrued).toBe(19.73);
    expect(again.balance).toBe(16.23);
  });

  it('leaves employees on other Leave Year Types completely untouched', async () => {
    await annualPolicy(20);
    const { employmentId } = await hire();
    const before = await annualSummary(employmentId);
    await setOverride('c2c', ASOF);
    const after = await annualSummary(employmentId);
    expect(after.accrued).toBe(before.accrued);
    expect(after.balance).toBe(before.balance);
    expect(await a2cRows(employmentId)).toHaveLength(0);
  });
});

// ── (5) YEAR TWO — the ordinary calendar engine owns it ────────────────────────────────────────────
describe('f3a64d90 — year two onward is a plain calendar year', () => {
  it('openLeaveYear grants the full 20 in 2027 and the a2c correction adds nothing', async () => {
    await annualPolicy(20);
    await setOverride('a2c', ASOF);
    const { employmentId } = await hire({
      grants: [{ id: b.annualLeaveTypeId, code: 'ANNUAL', yearCycleOverride: 'a2c' }],
    });
    await reprojectEntitlementForEmployment(adminCtx(b), { employmentId, asOf: ASOF, trigger: 'test' });
    expect(await accruedInYear(employmentId, 2026)).toBe(19.73); // hire year — up-front figure

    await openLeaveYear(adminCtx(b), { year: 2027 });
    expect(await accruedInYear(employmentId, 2027)).toBe(20);

    // No first-year slicing in the second year — the correction is a no-op there.
    const r = await reprojectEntitlementForEmployment(adminCtx(b), { employmentId, asOf: '2027-07-23', trigger: 'test' });
    expect(r.affected).toBe(0);
    expect(await accruedInYear(employmentId, 2027)).toBe(20);
  });
});

// ── (6) EA-FLOOR / SCHEME feed the slice ───────────────────────────────────────────────────────────
describe('f3a64d90 — the slice is taken off the fully resolved entitlement', () => {
  const emp = { hiredOn: HIRED, leaveCycle: 'calendar' as string | null, gradeId: null, companyId: 'c1' };
  const policyRows = (days: number): GradePolicyRow[] => [
    { gradeId: null, companyId: null, accrual: { annualDays: days } },
  ];

  // fa3f4ccb: was "a below-floor policy still slices the STATUTORY floor". The floor no longer clamps, so
  // the slice is taken off the CONFIGURED days. The invariant this test protects is unchanged — the slice
  // is taken off the FULLY RESOLVED entitlement, whatever resolution now returns.
  it('fa3f4ccb: a below-minimum policy slices its own days, not the statutory floor', () => {
    const res = projectExpectedEntitlement(emp, 'ANNUAL', policyRows(5), () => 8, ASOF, undefined, 'a2c');
    expect(res!.expected).toBe(a2cFirstYearEntitledToDate(HIRED, ASOF, 5));
    expect(res!.expected).toBe(4.93); // 5/365 × 360
    expect(res!.windowStart).toBe('2026-01-01');
  });

  it('an auto-linked benefit-scheme band supersedes the policy days in the slice', () => {
    // Scheme band 24 beats the policy's 20 and the floor's 8 ⇒ up-front 24/365 × 360 = 23.67.
    const res = projectExpectedEntitlement(emp, 'ANNUAL', policyRows(20), () => 8, ASOF, () => 24, 'a2c');
    expect(res!.expected).toBe(a2cFirstYearEntitledToDate(HIRED, ASOF, 24));
    expect(res!.expected).toBe(23.67);
  });

  it('without the a2c override the same inputs keep the existing hire-month proration', () => {
    const res = projectExpectedEntitlement(emp, 'ANNUAL', policyRows(20), () => 8, ASOF, undefined, null);
    expect(res!.expected).toBe(20); // January joiner ⇒ 20 × 12/12 (unchanged behaviour)
  });
});

// ── (7) PERSISTENCE — the real DB CHECK ────────────────────────────────────────────────────────────
describe('f3a64d90 — migration 0310 widened the database CHECK', () => {
  it('accepts a2c and still rejects an unknown value at the column level', async () => {
    await owner.db
      .update(schema.leaveType)
      .set({ yearCycleOverride: 'a2c' })
      .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    const [row] = await owner.db
      .select({ v: schema.leaveType.yearCycleOverride })
      .from(schema.leaveType)
      .where(eq(schema.leaveType.id, b.annualLeaveTypeId));
    expect(row.v).toBe('a2c');

    await expect(
      owner.db
        .update(schema.leaveType)
        .set({ yearCycleOverride: 'a2x' })
        .where(eq(schema.leaveType.id, b.annualLeaveTypeId)),
    ).rejects.toThrow();
  });
});
