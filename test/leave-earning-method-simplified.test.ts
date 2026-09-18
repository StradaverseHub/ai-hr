/**
 * bc36c768 — Simplify Earning Method Configuration.
 *
 * THE ITEM IN ONE PARAGRAPH. The Earning Method list offered four choices that added up to two behaviours
 * (None and By Year stored the same value; Earn Upon Resignation never calculated anything), monthly
 * earning always credited on the 1st with no way to change that, and there was no day-by-day earning at
 * all. It is now exactly three — None, Monthly Accrual (with a required day of the month), Daily Accrual —
 * and every leave type is reset to NOT CONFIGURED until HR sets it.
 *
 * WHAT THESE TESTS ARE REALLY DEFENDING, in rough order of how expensive the failure would be:
 *
 *  1. ONE ARITHMETIC, TWO CALL SITES. accrueEarnedLeave (which credits) and projectExpectedEntitlement
 *     (which reprojects) used to carry two independent copies of the earned-to-date formula. If a new
 *     branch reaches only one of them, the recalc kernel projects one figure while the accrual engine
 *     credits another and the difference is posted, in alternating directions, on every profile edit
 *     forever. The cross-check here is the standing guard against that.
 *
 *  2. THE NOT-CONFIGURED GATE RETURNS null, NEVER 0, from projectExpectedEntitlement. A 0 would make all
 *     three reproject callers post a NEGATIVE compensating adjustment clawing back every already-credited
 *     day — the exact inversion of the risk the gate exists to remove, on a reset the reporter was
 *     promised moves no balance.
 *
 *  3. THE MARKER MUST NOT FLIP hasAnyLeaveTypeRule. The clear-out stamps every non-archived type at once,
 *     including types whose real carry / rounding / max-balance configuration still lives in
 *     leave_policy.accrual. If the marker counted as a type-level rule, the overlay would bury all of it
 *     under NULLs and an earning-method reset would silently wipe carry-forward and rounding.
 *
 *  4. THE JOINER GUARD on Daily Accrual. A "cycle start → today" daily window would let a calendar-cycle
 *     employee hired in June accrue from 1 January, and the accrual engine only ever tops UP, so nothing
 *     could ever claw it back.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { withTenant } from '../db/client';
import { hireEmployee } from '../core/org';
import { setLeaveTypeRules } from '../core/admin';
import {
  accrueEarnedLeave,
  earnedToDateFor,
  effectiveAccrualDay,
  expireCarriedLeave,
  isA2cFirstYear,
  isAccrualUnconfigured,
  isEarnedMethod,
  openLeaveYear,
  projectExpectedEntitlement,
  reprojectA2cEntitlement,
  reprojectEntitlementForEmployment,
  reprojectEntitlementForLeaveTypeCohort,
} from '../core/leave';
import { bandFor, hasAnyLeaveTypeRule, type ServiceBand } from '../core/leave-compute';
import { leaveEntitlementBreakdown } from '../core/read';
import { adminCtx, closeAll, migrateTestDb, owner, resetDb, seedBase, seedEntitlement, type Base } from './harness';

const here = dirname(fileURLToPath(import.meta.url));
/**
 * a6fe37fc ROUND 5 (cutover) — RE-POINTED, NOT DELETED. `components/leave-type-panel.tsx` (3,367 lines)
 * was DELETED with the page that mounted it: the four steps and six sub-steps it carried are the FIVE
 * TABS of `/admin/leave-config/types` (IA §2), which is what this whole item was raised about. The panel
 * became three files, so what this guard scans is their concatenation — the property it pins is about the
 * leave TYPE screen, not about one filename, and pinning it to a file that no longer exists would have
 * taken the guard out rather than moved it.
 */
const LEAVE_TYPE_SCREEN = [
  'app/admin/leave-config/types/page.tsx',
  'app/admin/leave-config/types/leave-type-tabs.tsx',
  'app/admin/leave-config/types/leave-type-sub-forms.tsx',
];
const panelSrc = LEAVE_TYPE_SCREEN.map((f) => readFileSync(resolve(here, '..', f), 'utf8')).join('\n');
const actionsSrc = readFileSync(resolve(here, '../app/admin/actions.ts'), 'utf8');
const leaveSrc = readFileSync(resolve(here, '../core/leave.ts'), 'utf8');

let b: Base;

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

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────────

const uniqEmail = () => `earn_${randomUUID().slice(0, 8)}@t.local`;

const hire = (hiredOn: string) =>
  hireEmployee(adminCtx(b), {
    person: { fullName: 'Earn Emp', primaryEmail: uniqEmail() },
    companyId: b.companyId,
    departmentId: b.deptA,
    employmentType: 'full_time',
    hiredOn,
    grantLeaveTypes: [{ id: b.annualLeaveTypeId, code: 'ANNUAL' }],
  });

/** A days-only entitlement. bc36c768 already had the METHOD living on the leave TYPE rather than beside
 *  the days; 6e9a126e release three moved the days themselves out of `leave_policy` and into an
 *  entitlement template's band, so this fixture changes storage and nothing else — every figure below is
 *  the figure it was. */
const policy = (annualDays: number, validFrom = '2026-01-01') =>
  seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, annualDays, validFrom });

/** A banded entitlement, for the one test that needs per-band carry rather than a flat figure. */
const bandedPolicy = (serviceBands: ServiceBand[], validFrom = '2026-01-01') =>
  seedEntitlement(adminCtx(b), { leaveTypeId: b.annualLeaveTypeId, serviceBands, validFrom });

const balanceOf = async (employmentId: string) => {
  const [r] = await owner.db
    .select({ bal: sql<string>`coalesce(sum(${schema.leaveLedger.days}), 0)` })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.employmentId, employmentId),
        eq(schema.leaveLedger.leaveTypeId, b.annualLeaveTypeId),
      ),
    );
  return Number(r.bal);
};

const ledgerRows = (employmentId: string) =>
  owner.db
    .select({
      entryType: schema.leaveLedger.entryType,
      days: schema.leaveLedger.days,
      effectiveOn: schema.leaveLedger.effectiveOn,
      reason: schema.leaveLedger.reason,
    })
    .from(schema.leaveLedger)
    .where(
      and(
        eq(schema.leaveLedger.employmentId, employmentId),
        eq(schema.leaveLedger.leaveTypeId, b.annualLeaveTypeId),
      ),
    );

const typeRow = async (id = b.annualLeaveTypeId) => {
  const [row] = await owner.db.select().from(schema.leaveType).where(eq(schema.leaveType.id, id));
  return row;
};

/** Stamp the NOT-CONFIGURED marker the way migration 0376 does. Direct column write on purpose: the
 *  clear-out is a one-off migration, not an ordinary save, and the ordinary writer CLEARS this marker. */
const markUnconfigured = (id = b.annualLeaveTypeId) =>
  owner.db
    .update(schema.leaveType)
    .set({ accrualUnconfigured: new Date('2026-01-01T00:00:00Z') })
    .where(eq(schema.leaveType.id, id));

const setTypeColumns = (patch: Partial<typeof schema.leaveType.$inferInsert>, id = b.annualLeaveTypeId) =>
  owner.db.update(schema.leaveType).set(patch).where(eq(schema.leaveType.id, id));

/**
 * Just `setLeaveTypeRulesAction`'s own body, sliced between two export markers.
 *
 * ⚠️ THE END MARKER IS ASSERTED, and it is asserted because the silent failure already happened. Both
 * source assertions below used to slice to `export async function updateLeavePolicyAction`, which release
 * three deleted — `indexOf` then returns -1, `slice(start, -1)` runs to the END OF THE FILE, and both
 * tests quietly start asserting things about every action in the module instead of about this one. A
 * source-scan delimiter that can vanish must be checked, not trusted.
 */
const setLeaveTypeRulesActionSrc = (): string => {
  const start = actionsSrc.indexOf('export async function setLeaveTypeRulesAction');
  const end = actionsSrc.indexOf('export async function previewEarnedAccrualAction');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return actionsSrc.slice(start, end);
};

/**
 * The projection kernel, wired exactly as its production callers wire it.
 *
 * 6e9a126e RELEASE THREE — the kernel takes a `templateBandForYears` CLOSURE where it used to take a list
 * of `leave_policy` rows, because it re-resolves internally at a second service length and a band handed
 * in already-resolved would pin the first resolution. This reads the band table out of the entitlement
 * template the test actually seeded, which is the same posture the old wiring had: it never invented a
 * configuration, it read whatever the fixture had written. Nothing seeded ⇒ no band ⇒ `noOpinion`, which
 * is a SKIP and is exactly what several tests below are asserting.
 */
const templateBandForYears = async (): Promise<(years: number) => ServiceBand | null> => {
  const rows = await owner.db
    .select({ serviceBands: schema.entitlementTemplate.serviceBands })
    .from(schema.entitlementTemplate)
    .where(
      and(
        eq(schema.entitlementTemplate.leaveTypeId, b.annualLeaveTypeId),
        sql`${schema.entitlementTemplate.validTo} is null`,
      ),
    );
  const bands = (rows[0]?.serviceBands ?? null) as ServiceBand[] | null;
  return (years: number) => (bands ? bandFor({ serviceBands: bands }, years) : null);
};

const project = async (p: { hiredOn: string; asOf: string; leaveCycle?: string | null }) => {
  const t = await typeRow();
  return projectExpectedEntitlement(
    { hiredOn: p.hiredOn, leaveCycle: p.leaveCycle ?? null, gradeId: null, companyId: b.companyId },
    'ANNUAL',
    () => 0, // statutory floor neutralised: this suite is about the CONFIGURED figure
    p.asOf,
    t.yearCycleOverride,
    t,
    await templateBandForYears(),
  );
};

// ── (a)(b)(c) the accrual day ───────────────────────────────────────────────────────────────────────

describe('bc36c768 (a)(b)(c) · Monthly Accrual credits on the day HR chooses', () => {
  it('(a) accrualDay 15 credits nothing on the 14th and the month\'s slice on the 15th', async () => {
    await policy(12);
    await setLeaveTypeRules(adminCtx(b), {
      id: b.annualLeaveTypeId,
      accrualMethod: 'earned_monthly',
      accrualDay: 15,
    });
    const emp = await hire('2026-01-01');
    // 14 March: January and February have credited, March has not reached its day yet.
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-03-14' });
    expect(await balanceOf(emp.employmentId)).toBe(2);
    // 15 March: March's slice lands.
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-03-15' });
    expect(await balanceOf(emp.employmentId)).toBe(3);
  });

  it('(b) accrualDay 31 credits on 28 February — and on 29 February in a leap year, not never', async () => {
    // A month shorter than the configured day must NOT be skipped: the cumulative model only ever tops
    // up, so a skipped month is a permanent hole nothing later fills in.
    expect(effectiveAccrualDay('2026-02-28', 31)).toBe(28);
    expect(effectiveAccrualDay('2028-02-29', 31)).toBe(29);
    expect(effectiveAccrualDay('2026-04-30', 31)).toBe(30);
    expect(effectiveAccrualDay('2026-01-31', 31)).toBe(31);

    await policy(12);
    await setLeaveTypeRules(adminCtx(b), {
      id: b.annualLeaveTypeId,
      accrualMethod: 'earned_monthly',
      accrualDay: 31,
    });
    const emp = await hire('2026-01-01');
    // 27 Feb: January only (January's 31st has passed, February's clamped 28th has not).
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-02-27' });
    expect(await balanceOf(emp.employmentId)).toBe(1);
    // 28 Feb in an ordinary year: February credits.
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-02-28' });
    expect(await balanceOf(emp.employmentId)).toBe(2);

    // And the leap-year half, at the unit level so the assertion is about the rule, not about a fixture.
    const leap = (asOf: string) =>
      earnedToDateFor({
        method: 'earned_monthly',
        accrualDay: 31,
        annualDays: 12,
        cycleStart: '2028-01-01',
        hiredOn: '2028-01-01',
        leaveCycle: 'calendar',
        asOf,
      });
    expect(leap('2028-02-28')).toBe(1); // 29 Feb exists this year, so the 28th is still too early
    expect(leap('2028-02-29')).toBe(2); // and the 29th credits February
  });

  it('(c) an absent accrualDay is byte-identical to the pre-bc36c768 behaviour', async () => {
    // The whole back-compat guarantee in one assertion: for every day of a cycle, "no accrual day
    // configured" must produce exactly what "day 1" produces, which is what accrualPeriods always did.
    for (const month of [1, 2, 3, 6, 9, 12]) {
      for (const day of [1, 2, 14, 15, 28]) {
        const asOf = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const base = { method: 'earned_monthly', annualDays: 12, cycleStart: '2026-01-01', hiredOn: '2026-01-01', leaveCycle: 'calendar', asOf };
        expect(earnedToDateFor({ ...base, accrualDay: null }), asOf).toBe(earnedToDateFor({ ...base, accrualDay: 1 }));
        // …and it is the plain month count, inclusive of the current month.
        expect(earnedToDateFor({ ...base, accrualDay: null }), asOf).toBe(month);
      }
    }
  });
});

// ── (d)(e)(f) Daily Accrual ─────────────────────────────────────────────────────────────────────────

describe('bc36c768 (d)(e)(f) · Daily Accrual', () => {
  it('(d) 20 days over a 365-day year reaches 9.97 at day 182, never exceeds 20.00, and divides by 366 in a leap year', async () => {
    const daily = (cycleStart: string, asOf: string) =>
      earnedToDateFor({
        method: 'earned_daily',
        annualDays: 20,
        cycleStart,
        hiredOn: cycleStart,
        leaveCycle: 'calendar',
        asOf,
      });
    // The reporter's own worked example: 20 / 365 × 182 = 9.97. Day 182 of 2026 is 1 July.
    expect(daily('2026-01-01', '2026-07-01')).toBe(9.97);
    expect(daily('2026-01-01', '2026-12-31')).toBe(20);
    // Never above the annual entitlement, whatever asOf is asked for.
    expect(daily('2026-01-01', '2027-06-30')).toBe(20);

    // 2028 runs 366 days, so THE SAME ELAPSED DAY yields LESS. Day 182 falls on 1 July in 2026 and on
    // 30 June in 2028 (February's extra day shifts it), and the two figures differ precisely because the
    // divisor is the ACTUAL cycle length rather than a hardcoded 365 — which is what
    // a2cFirstYearEntitledToDate deliberately does, and the reason this does not reuse it.
    expect(daily('2028-01-01', '2028-06-30')).toBe(9.95); // 20/366 × 182
    expect(daily('2026-01-01', '2026-06-30')).toBe(9.92); // 20/365 × 181
    expect(daily('2028-01-01', '2028-12-31')).toBe(20);
  });

  it('(e) THE JOINER GUARD — a 2026-06-15 calendar-cycle joiner holds +0.05, not +10.00', async () => {
    // A "cycle start → today" window would accrue this employee from 1 January: five and a half months of
    // leave they never worked, which the accrual engine (`toGrant > 0`, top-up only) could never claw back.
    await policy(20);
    await setLeaveTypeRules(adminCtx(b), { id: b.annualLeaveTypeId, accrualMethod: 'earned_daily' });
    const emp = await hire('2026-06-15');
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-06-15' });
    expect(await balanceOf(emp.employmentId)).toBe(0.05); // 20/365 × 1 day
    expect(await balanceOf(emp.employmentId)).not.toBe(10);
    // And the projection kernel agrees to the penny, which is what stops the reproject oscillating.
    expect((await project({ hiredOn: '2026-06-15', asOf: '2026-06-15' }))!.expected).toBe(0.05);
  });

  it('(f) Daily Accrual plus a round-up rule credits a whole day from day one — pinned, not pretended away', async () => {
    // The reporter was told this outright and told we would WARN rather than block: rounding is applied to
    // the RUNNING TOTAL, not to each day's slice, so 0.05 becomes 1.00 immediately. The recommendation is
    // no rounding on a daily type; the combination stays configurable.
    await policy(20);
    await setLeaveTypeRules(adminCtx(b), { id: b.annualLeaveTypeId, accrualMethod: 'earned_daily' });
    // 'up' is no longer WRITABLE (8fec719e narrowed the choices) but applyRounding still evaluates it, so
    // the column is set directly — this pins the engine's behaviour for any row still carrying one.
    await setTypeColumns({ roundingMethod: 'up' });
    const emp = await hire('2026-01-01');
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-01-01' });
    expect(await balanceOf(emp.employmentId)).toBe(1);
    // The screen says so before the administrator saves, rather than after the first accrual run.
    expect(panelSrc).toContain('dailyRoundingWarning');
  });

  it('the entitlement breakdown recognises earned_daily as earned — verified, not assumed', async () => {
    // core/read.ts asks `isEarnedMethod(policy?.method)` and hands the answer to `monthlyAccruedToDate`,
    // which is null for a lump type and the cycle's accrual for an earned one. It picks the new method up
    // for free, but "for free" is exactly the class of claim that is worth one assertion.
    await policy(20);
    await setLeaveTypeRules(adminCtx(b), { id: b.annualLeaveTypeId, accrualMethod: 'earned_daily' });
    const emp = await hire('2026-01-01');
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-07-01' });
    const daily = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, b.annualLeaveTypeId, '2026-07-01');
    expect(daily!.monthlyAccruedToDate).toBe(9.97);

    // …and a lump type still reports null there, so the assertion above is not vacuous.
    await setLeaveTypeRules(adminCtx(b), { id: b.annualLeaveTypeId, accrualMethod: 'grant_on_hire_prorated' });
    const lump = await leaveEntitlementBreakdown(adminCtx(b), emp.employmentId, b.annualLeaveTypeId, '2026-07-01');
    expect(lump!.monthlyAccruedToDate).toBeNull();
  });

  it('earned_daily is recognised everywhere isEarnedMethod is asked, and the quarterly value survives', () => {
    expect(isEarnedMethod('earned_daily')).toBe(true);
    expect(isEarnedMethod('earned_monthly')).toBe(true);
    // KEPT on purpose: the dropdown no longer offers quarterly, but the value set is open by contract and
    // deleting engine support would collapse a stored 'earned_quarterly' onto the LUMP path — i.e. hand
    // its holders a full year up front. Retiring a choice and re-interpreting stored values are different
    // changes and only the first was asked for.
    expect(isEarnedMethod('earned_quarterly')).toBe(true);
    expect(isEarnedMethod('grant_on_hire_prorated')).toBe(false);
    expect(isEarnedMethod(undefined)).toBe(false);
  });
});

// ── (g) the two engines agree ───────────────────────────────────────────────────────────────────────

describe('bc36c768 (g) · the accrual engine and the recalc kernel compute the SAME cumulative', () => {
  it('agrees for every method and every accrualDay across a full cycle', async () => {
    // THE FAILURE THIS EXISTS TO CATCH: two independent copies of the earned-to-date formula, one in
    // accrueEarnedLeave and one in projectExpectedEntitlement. A branch added to only one of them makes
    // the kernel project a figure the engine never credits, and the difference is posted as a
    // compensating adjustment on every profile edit, in alternating directions, forever.
    const cases: { method: string; accrualDay: number | null }[] = [
      { method: 'earned_monthly', accrualDay: null },
      { method: 'earned_monthly', accrualDay: 15 },
      { method: 'earned_monthly', accrualDay: 31 },
      { method: 'earned_quarterly', accrualDay: null },
      { method: 'earned_daily', accrualDay: null },
    ];
    const asOfs = ['2026-01-01', '2026-01-14', '2026-02-15', '2026-03-31', '2026-06-30', '2026-09-15', '2026-12-14', '2026-12-31'];

    for (const c of cases) {
      await resetDb();
      b = await seedBase();
      await policy(20);
      // earned_quarterly is not writable through setLeaveTypeRules' vocabulary check? It is — the method
      // is an open string. The column is written the same way for every case so the fixture is uniform.
      await setTypeColumns({ accrualMethod: c.method, accrualDay: c.accrualDay });
      const emp = await hire('2026-01-01');
      // The excluded combination is NOT reachable in this loop, and that is asserted rather than assumed
      // (see the dedicated a2c test below).
      const t = await typeRow();
      expect(isA2cFirstYear(t.yearCycleOverride, 'ANNUAL', '2026-01-01', '2026-12-31'), `${c.method} a2c`).toBe(false);

      for (const asOf of asOfs) {
        await accrueEarnedLeave(adminCtx(b), { asOf });
        const credited = await balanceOf(emp.employmentId);
        const projected = await project({ hiredOn: '2026-01-01', asOf });
        expect(projected, `${c.method}/${c.accrualDay}@${asOf}`).not.toBeNull();
        expect(projected!.expected, `${c.method}/${c.accrualDay}@${asOf}`).toBe(credited);
      }
    }
  });

  it('EXPLICITLY EXCLUDES a2c-first-year ANNUAL: the two FUNCTIONS still differ, and that is now by design', async () => {
    // ⚠️ d58bfa3f CLOSED THE ENGINE HALF OF THIS. Read the update before trusting the sentence below it.
    //
    // WAS: projectExpectedEntitlement tests a2cFirstYear BEFORE the earned branch while accrueEarnedLeave
    // contained zero a2c handling, so for an ANNUAL a2c type in the hire year the ENGINE credited period
    // slices and the KERNEL projected the up-front part-year — a real divergence on a real tenant's
    // configuration, and the defect behind d58bfa3f (the reporter saw 2.50 where the kernel said 7.10).
    //
    // NOW: `accrueEarnedLeave` calls `isA2cFirstYear` / `a2cFirstYearEntitledToDate` — the SAME predicate
    // and helper the kernel uses — so the two ENGINES agree. What this test asserts is narrower and still
    // true: the two pure FUNCTIONS below return different things, because they answer different questions.
    // `earnedToDateFor` is period arithmetic and knows nothing about a2c by design; an a2c first year is
    // not a partial year being earned, it is a part-year entitlement granted up front. Teaching the period
    // arithmetic about a2c would have been a third definition of the same rule.
    //
    // So this stays as documentation of WHY the two functions differ, not of an open gap.
    await policy(20);
    await setTypeColumns({ accrualMethod: 'earned_daily', yearCycleOverride: 'a2c' });
    const t = await typeRow();
    expect(isA2cFirstYear(t.yearCycleOverride, 'ANNUAL', '2026-06-15', '2026-06-30')).toBe(true);

    const kernel = (await project({ hiredOn: '2026-06-15', asOf: '2026-06-30' }))!.expected;
    const engine = earnedToDateFor({
      method: 'earned_daily',
      annualDays: 20,
      cycleStart: '2026-01-01',
      hiredOn: '2026-06-15',
      leaveCycle: 'calendar',
      asOf: '2026-06-30',
    });
    // The kernel returns the a2c UP-FRONT part-year figure; the engine returns the daily slice. They are
    // not equal, and this assertion is the documentation of that gap.
    expect(kernel).not.toBe(engine);
    expect(engine).toBe(0.88); // 20/365 × 16 days, hire-date anchored
  });

  it('neither engine keeps a second copy of the period arithmetic', () => {
    // The structural half of the guarantee: exactly one definition, and two call sites.
    expect(leaveSrc).toContain('export function earnedToDateFor(');
    expect(leaveSrc.match(/earnedToDateFor\(\{/g)?.length).toBe(2);
    expect(leaveSrc).not.toContain("const totalPeriods = pol!.method === 'earned_quarterly' ? 4 : 12;");
  });
});

// ── (h) the NOT-CONFIGURED gate ─────────────────────────────────────────────────────────────────────

describe('bc36c768 (h) · a NOT-CONFIGURED type grants nothing and moves nothing', () => {
  it('the hire grant, the accrual run, the cohort recalc, the profile recalc AND the a2c correction all write ZERO rows', async () => {
    await policy(12);
    // Configure it, hire someone, let them accrue a real balance — so the reset has something it could
    // wrongly claw back. A test against an empty ledger would pass vacuously.
    await setLeaveTypeRules(adminCtx(b), { id: b.annualLeaveTypeId, accrualMethod: 'earned_monthly' });
    const existing = await hire('2026-01-01');
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-06-30' });
    const balanceBefore = await balanceOf(existing.employmentId);
    expect(balanceBefore).toBe(6);
    const rowsBefore = (await ledgerRows(existing.employmentId)).length;

    // …now the clear-out lands.
    await setTypeColumns({ accrualMethod: null, accrualDay: null });
    await markUnconfigured();
    expect(isAccrualUnconfigured(await typeRow())).toBe(true);

    // 1. THE HIRE GRANT. A joiner is credited +0.00 and loses nothing — the catch-up credits it later.
    const joiner = await hire('2026-07-01');
    expect(await balanceOf(joiner.employmentId)).toBe(0);
    expect((await ledgerRows(joiner.employmentId)).length).toBe(0);

    // 2. THE ACCRUAL RUN.
    const run = await accrueEarnedLeave(adminCtx(b), { asOf: '2026-07-31' });
    expect(run.granted).toBe(0);
    expect(run.forfeits).toBe(0);

    // 3. THE COHORT RECALC (reprojectEntitlementForLeaveTypeCohort).
    //    6e9a126e RELEASE THREE — this bullet used to be THE POLICY RECALC: `updateLeavePolicy` with a
    //    days change, running `reprojectEntitlementForPolicy`. Both went with `leave_policy`, so that
    //    kernel caller no longer exists to be pinned. The cohort recalc is the caller that took over as
    //    the configuration-change trigger (setLeaveTypeRulesAction fires it), so the claim this test
    //    makes — every caller of projectExpectedEntitlement writes nothing while the type is unconfigured
    //    — is still made against every caller there is.
    const cohortRecalc = await reprojectEntitlementForLeaveTypeCohort(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      trigger: 'test_cohort',
      asOf: '2026-07-31',
    });
    expect(cohortRecalc.affected).toBe(0);
    expect(cohortRecalc.totalDelta).toBe(0);

    // 4. THE PROFILE RECALC (reprojectEntitlementForEmployment) — the one routine HR work fires.
    const profRecalc = await reprojectEntitlementForEmployment(adminCtx(b), {
      employmentId: existing.employmentId,
      asOf: '2026-07-31',
      trigger: 'test_profile_edit',
    });
    expect(profRecalc.affected).toBe(0);
    expect(profRecalc.totalDelta).toBe(0);

    // 5. THE a2c CORRECTION (reprojectA2cEntitlement), the third projectExpectedEntitlement caller.
    await setTypeColumns({ yearCycleOverride: 'a2c' });
    const a2c = await withTenant(adminCtx(b), (tx) =>
      reprojectA2cEntitlement(tx, adminCtx(b), {
        leaveTypeId: b.annualLeaveTypeId,
        asOf: '2026-07-31',
        trigger: 'test_a2c',
      }),
    );
    expect(a2c.affected).toBe(0);
    expect(a2c.totalDelta).toBe(0);

    // NOTHING MOVED. Not the balance, not the row count — and in particular no NEGATIVE clawback row,
    // which is what a gate returning 0 instead of null would have posted at every one of steps 3–5.
    expect(await balanceOf(existing.employmentId)).toBe(balanceBefore);
    expect((await ledgerRows(existing.employmentId)).length).toBe(rowsBefore);
  });

  it('the gate returns null (skip), never 0 — the distinction the whole reset rests on', async () => {
    await policy(12);
    await markUnconfigured();
    expect(await project({ hiredOn: '2026-01-01', asOf: '2026-06-30' })).toBeNull();
    // Un-mark it and the same call produces a real figure, so the null above is the marker talking and
    // not a fixture that happens to project nothing.
    await setTypeColumns({ accrualUnconfigured: null });
    expect((await project({ hiredOn: '2026-01-01', asOf: '2026-06-30' }))!.expected).toBe(12);
  });
});

// ── (i) openLeaveYear ───────────────────────────────────────────────────────────────────────────────

describe('bc36c768 (i) · at a year open, an unconfigured type gets a ZEROED GRANT, not a skip', () => {
  it('still writes the carry-forward forfeit, still writes the 0-day open marker, and expiry still sweeps', async () => {
    // WHY NOT A `continue`. Skipping the type would skip two more things below the earned gate: the
    // carry-forward cap forfeit (so excess balance would sit untouched forever) and the grant row, which
    // is ALWAYS written even at 0 days because it is openLeaveYear's own idempotency marker AND
    // expireCarriedLeave's "this year was opened" marker — without it, carried leave never expires either.
    await policy(12);
    await setTypeColumns({
      carryForwardEnabled: true,
      carryForwardMax: '5',
      carryForwardExpiryMonth: 3,
      carryForwardExpiryDay: 31,
    });
    const emp = await hire('2026-01-01'); // lump type: 12 days credited at hire
    expect(await balanceOf(emp.employmentId)).toBe(12);

    await markUnconfigured();
    const opened = await openLeaveYear(adminCtx(b), { year: 2027 });
    expect(opened.forfeits).toBe(1);
    expect(opened.granted).toBe(1); // the marker row IS a grant, at 0 days

    const rows = await ledgerRows(emp.employmentId);
    const forfeit = rows.find((r) => r.effectiveOn === '2027-01-01' && r.entryType === 'adjustment');
    const marker = rows.find((r) => r.effectiveOn === '2027-01-01' && r.entryType === 'accrual');
    expect(forfeit, 'the cap forfeit row').toBeTruthy();
    expect(Number(forfeit!.days)).toBe(-7); // 12 held − 5 carry allowance
    expect(marker, 'the always-written open marker').toBeTruthy();
    expect(Number(marker!.days)).toBe(0); // …at zero days, because the type is not configured
    expect(await balanceOf(emp.employmentId)).toBe(5);

    // And the expiry sweep finds its marker, so carried leave still expires on its normal date.
    const swept = await expireCarriedLeave(adminCtx(b), { today: '2027-04-01' });
    expect(swept.forfeited).toBeGreaterThan(0);
    expect(await balanceOf(emp.employmentId)).toBe(0);
  });

  it('MEASURED: the retained carry is IDENTICAL to a configured year — the disclosed side effect does not occur', async () => {
    // The plan (and the note the reporter was given) predicted that zeroing the grant would leave the
    // max-balance clamp more headroom, so `carry` would come out HIGHER and the forfeit correspondingly
    // SMALLER than a configured year. MEASURED HERE, THAT DIFFERENCE IS ZERO, and the reason is in
    // applyMaxBalance: it clamps `carry` to the cap FIRST (`Math.min(carry, cap)`) and only then gives the
    // GRANT whatever room is left. The carry has never depended on the grant, so forcing the grant to 0
    // cannot move it. The disclosure was conservative rather than wrong — but the number is 0.00, and
    // pinning it is worth more than repeating an unquantified warning.
    const measure = async (unconfigured: boolean) => {
      await resetDb();
      b = await seedBase();
      await policy(12);
      await setTypeColumns({ carryForwardEnabled: true, carryForwardMax: '5', maxBalanceDays: '10' });
      const emp = await hire('2026-01-01');
      if (unconfigured) await markUnconfigured();
      const res = await openLeaveYear(adminCtx(b), { year: 2027 });
      const rows = await ledgerRows(emp.employmentId);
      const forfeit = rows.find((r) => r.effectiveOn === '2027-01-01' && r.entryType === 'adjustment');
      const grant = rows.find((r) => r.effectiveOn === '2027-01-01' && r.entryType === 'accrual');
      return { forfeits: res.forfeits, forfeit: Number(forfeit?.days ?? 0), grant: Number(grant?.days ?? 0) };
    };
    const configured = await measure(false);
    const unconfigured = await measure(true);

    expect(unconfigured.forfeit).toBe(configured.forfeit); // the measured difference: 0.00 days
    expect(unconfigured.forfeits).toBe(configured.forfeits);
    // The ONLY thing that differs is the grant, which is the entire intent.
    expect(configured.grant).toBeGreaterThan(0);
    expect(unconfigured.grant).toBe(0);
  });
});

// ── (j) the marker is not a rule ────────────────────────────────────────────────────────────────────

describe('bc36c768 (j) · the NOT-CONFIGURED marker does not flip hasAnyLeaveTypeRule', () => {
  it('a previously unruled type keeps the carry configured BESIDE its days, not the type\'s NULLs', async () => {
    // THIS EXCLUSION IS LOAD-BEARING. The clear-out stamps every non-archived type at once, including the
    // ones migration 0325 never consolidated — whose real carry / rounding / max-balance configuration
    // lives beside their DAYS rather than on the type. If the marker counted as a type-level rule,
    // applyLeaveTypeRules would engage and bury all of it under NULLs, and an EARNING-METHOD reset would
    // silently wipe carry-forward and rounding. Same reasoning as carryForwardIncludeEarned's exclusion,
    // which came first.
    expect(hasAnyLeaveTypeRule({ accrualUnconfigured: new Date() })).toBe(false);
    expect(hasAnyLeaveTypeRule({ accrualUnconfigured: '2026-01-01T00:00:00Z', accrualMethod: null })).toBe(false);
    // …while a real rule, including the new accrual DAY, still engages it.
    expect(hasAnyLeaveTypeRule({ accrualDay: 15 })).toBe(true);
    expect(hasAnyLeaveTypeRule({ accrualMethod: 'earned_daily' })).toBe(true);
    expect(hasAnyLeaveTypeRule({ carryForwardMax: '5' })).toBe(true);

    // End to end, REPOINTED AT WHERE PER-ENTITLEMENT CARRY LIVES NOW. It used to be
    // `leave_policy.accrual.carryForwardMax`; release three dropped that table, and the surviving
    // equivalent is the service band's own `carryForwardDays`, which `policyFromTemplateBand` reads and
    // which an unruled type therefore keeps. Same claim, same figures, same failure mode: had the marker
    // engaged the overlay, the type's NULL carry cap would resolve to 0 and the whole 12 would forfeit.
    await bandedPolicy([{ fromYears: 0, toYears: null, days: 12, carryForwardDays: 5 }]);
    const emp = await hire('2026-01-01');
    expect(await balanceOf(emp.employmentId)).toBe(12);
    await markUnconfigured();
    expect(hasAnyLeaveTypeRule(await typeRow())).toBe(false); // still unruled — the marker changed nothing
    await openLeaveYear(adminCtx(b), { year: 2027 });
    expect(await balanceOf(emp.employmentId)).toBe(5);
  });
});

// ── (k) the clear-out migration ─────────────────────────────────────────────────────────────────────

describe('bc36c768 (k) · the 0376 clear-out', () => {
  /**
   * ⚠️ THE REPLAY IS RETIRED — 6e9a126e RELEASE THREE, and it cannot be repointed at anything.
   *
   * 'clears BOTH surfaces, stamps the marker, leaves every ledger row untouched, and posts exactly one
   * event per type' re-executed 0376's own SQL against a live fixture. That SQL's SECOND SURFACE is
   * `leave_policy.accrual` — it reads and UPDATEs the table at lines 83 and 133 — and migration 0405
   * drops it. 0376 still runs correctly in the migration CHAIN (it is applied long before 0405), but a
   * replay against today's schema raises `relation "leave_policy" does not exist`, and rebuilding
   * leave_policy in the test to feed it would be testing the layer this release exists to delete.
   *
   * Retired with it: the archived-type asymmetry (an archived type keeps its method and its NULL marker),
   * the JSONB assertions that only the `method` key was stripped while carry and rounding survived, the
   * untouched-ledger check, and the one-recovery-event-per-non-archived-type audit including its
   * `before.policyMethods` capture. Every one of those describes a table that no longer exists.
   *
   * The two things it proved that are STILL TRUE are still proved elsewhere in this file: that the marker
   * makes a type grant nothing and move nothing is (h), and that the marker does not flip
   * `hasAnyLeaveTypeRule` is (j). What is lost is the proof that 0376's SQL itself parses and runs — a
   * one-off migration that has already run in production.
   */

  it('is registered in the journal with the mandated watermark — a file drizzle never runs is not a migration', () => {
    const journal = JSON.parse(readFileSync(resolve(here, '../db/migrations/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number; when: number; tag: string }[];
    };
    const schemaMig = journal.entries.find((e) => e.tag.startsWith('0375_'));
    const clearOut = journal.entries.find((e) => e.tag.startsWith('0376_'));
    expect(schemaMig?.when).toBe(1781862475000);
    expect(clearOut?.when).toBe(1781862476000);
    // Ordering matters: the clear-out writes columns the schema migration creates.
    expect(schemaMig!.when).toBeLessThan(clearOut!.when);
  });
});

// ── (l) the catch-up ────────────────────────────────────────────────────────────────────────────────

describe('bc36c768 (l) · saving an earning method clears the marker and credits everything owed', () => {
  it('clears the marker, and the cohort reproject tops the EXISTING workforce up in one upward correction', async () => {
    await policy(12);
    // An employee who was already earning before the reset, with a materialized cycle.
    await setLeaveTypeRules(adminCtx(b), { id: b.annualLeaveTypeId, accrualMethod: 'earned_monthly' });
    const emp = await hire('2026-01-01');
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-06-30' });
    expect(await balanceOf(emp.employmentId)).toBe(6);

    // The clear-out lands, and the type sits unconfigured for a while.
    await setTypeColumns({ accrualMethod: null });
    await markUnconfigured();

    // HR now configures it — as None, i.e. the entitlement handed over up front.
    const res = await setLeaveTypeRules(adminCtx(b), {
      id: b.annualLeaveTypeId,
      accrualMethod: 'grant_on_hire_prorated',
    });
    expect(res.unconfiguredCleared).toBe(true);
    expect((await typeRow()).accrualUnconfigured).toBeNull();

    // THE WRITE ITSELF POSTS NOTHING. This is the runtime half of the ordering assertion: had the
    // reproject been called inside setLeaveTypeRules, the balance would already have moved by now.
    expect(await balanceOf(emp.employmentId)).toBe(6);

    // …and the catch-up, fired after the commit, credits the difference as ONE upward correction.
    const cohort = await reprojectEntitlementForLeaveTypeCohort(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      trigger: 'leave_type_rules',
      asOf: '2026-06-30',
    });
    expect(cohort.employees).toBeGreaterThan(0);
    expect(cohort.affected).toBe(1);
    expect(cohort.totalDelta).toBe(6); // 12 owed − 6 already credited
    expect(await balanceOf(emp.employmentId)).toBe(12);
  });

  it('KNOWN LIMIT — a joiner hired DURING the unconfigured window is not reached by the catch-up', async () => {
    // THIS IS A REAL GAP AND IT IS PINNED RATHER THAN HIDDEN. The plan promises that an employee hired
    // while a type is unconfigured is credited +0.00 and "loses nothing, because saving the earning method
    // runs a one-off correction crediting the full amount owed". The correction it mandates is
    // reprojectEntitlementForEmployment, and that kernel carries a MATERIALIZED-ONLY guard: "no accrual row
    // this cycle ⇒ nothing granted yet ⇒ nothing to correct". A +0.00 joiner has no accrual row by
    // construction, so the reproject skips them.
    //
    // WHO IS ACTUALLY AFFECTED, precisely: a joiner during the unconfigured window on a type later
    // configured as NONE (the lump path). An EARNED type catches them up on the very next accrual run,
    // which has no such guard — it grants from zero. A lump joiner waits for the next year-open.
    //
    // Removing the materialized-only guard is NOT the fix to reach for here: it is shared by both recalc
    // kernels, it is what stops a reproject fabricating grants for cycles no engine ever materialised, and
    // 49809272's tests pin it. This belongs in its own item.
    await policy(12);
    await markUnconfigured();
    const joiner = await hire('2026-03-01');
    expect(await balanceOf(joiner.employmentId)).toBe(0);

    await setLeaveTypeRules(adminCtx(b), { id: b.annualLeaveTypeId, accrualMethod: 'grant_on_hire_prorated' });
    await reprojectEntitlementForLeaveTypeCohort(adminCtx(b), {
      leaveTypeId: b.annualLeaveTypeId,
      trigger: 'leave_type_rules',
      asOf: '2026-06-30',
    });
    expect(await balanceOf(joiner.employmentId)).toBe(0); // still zero — the documented gap

    // The EARNED half of the same story, which DOES self-correct: configure the type as Monthly Accrual
    // instead and the next accrual run credits everything owed from zero.
    await setLeaveTypeRules(adminCtx(b), { id: b.annualLeaveTypeId, accrualMethod: 'earned_monthly' });
    await accrueEarnedLeave(adminCtx(b), { asOf: '2026-06-30' });
    expect(await balanceOf(joiner.employmentId)).toBe(4); // Mar–Jun, 1 day a month
  });

  it('saving anything OTHER than a non-null method leaves the type unconfigured', async () => {
    await policy(12);
    await markUnconfigured();
    // The "Not configured" placeholder posts an empty method, which the action maps to null. An accidental
    // save must not be how a leave type gets configured.
    const placeholderSave = await setLeaveTypeRules(adminCtx(b), { id: b.annualLeaveTypeId, accrualMethod: null });
    expect(placeholderSave.unconfiguredCleared).toBe(false);
    expect((await typeRow()).accrualUnconfigured).not.toBeNull();
    // …and a carry-forward-only save says nothing about how this type earns, so it does not clear it.
    const carrySave = await setLeaveTypeRules(adminCtx(b), { id: b.annualLeaveTypeId, carryForwardMax: 7 });
    expect(carrySave.unconfiguredCleared).toBe(false);
    expect((await typeRow()).accrualUnconfigured).not.toBeNull();
  });

  it('the action fires the cohort reproject AFTER the write transaction, never inside it', () => {
    // Ordering is load-bearing, not stylistic: each per-employee recalc opens its OWN transaction and reads
    // the COMMITTED rules, so a call inside setLeaveTypeRules would have every employee reproject against
    // the configuration the save just replaced. Asserted structurally because no runtime observation can
    // distinguish "inside a transaction that then committed" from "after it".
    const fn = setLeaveTypeRulesActionSrc();
    expect(fn).toContain('reprojectEntitlementForLeaveTypeCohort');
    expect(fn.indexOf('await setLeaveTypeRules(')).toBeLessThan(fn.indexOf('reprojectEntitlementForLeaveTypeCohort('));
    // …and it is gated on the marker having actually been cleared, so an ordinary re-save of a configured
    // type does not reproject the whole workforce every time somebody touches the rounding table.
    expect(fn).toContain('if (saved.unconfiguredCleared)');
    // The service itself must NOT call it — that is the mistake this ordering exists to prevent.
    const adminSrc = readFileSync(resolve(here, '../core/admin.ts'), 'utf8');
    expect(adminSrc).not.toContain('reprojectEntitlementForLeaveTypeCohort');
  });
});

// ── the writers ─────────────────────────────────────────────────────────────────────────────────────

describe('bc36c768 · setLeaveTypeRules is the ONLY path that can write an earning method', () => {
  it('exactly ONE action reads a `method` form field, and it is setLeaveTypeRulesAction', () => {
    // Three reads are stripped: createLeavePolicyAction, createLeavePoliciesMultiAction and — crucially —
    // the MOUNTED updateLeavePolicyAction. While that last one stood, "setLeaveTypeRulesAction is the only
    // writer" was simply FALSE, and that claim is the entire justification for removing the by_quarter
    // round-trip option from the editor. A dead read is one hand-crafted POST away from being a live one.
    const reads = [...actionsSrc.matchAll(/formData\.get\('method'\)/g)];
    expect(reads.length).toBe(1);
    const only = setLeaveTypeRulesActionSrc();
    expect(only).toContain("formData.get('method')");
    // …and it is gated on the earningRendered marker, so a carry-only save cannot clear the method.
    expect(only).toContain('...(earningRendered');

    // The only `name="method"` inputs in the whole app are that form's two hidden fields.
    expect([...panelSrc.matchAll(/name="method"/g)].length).toBe(2);
  });

  it('an unrecognised stored method is re-posted VERBATIM and keeps the rounding half saveable', () => {
    const form = panelSrc.slice(
      panelSrc.indexOf('function EarningMethodForm'),
      panelSrc.indexOf('function CarryPolicyForm'),
    );
    // Re-posted verbatim: collapsing it onto 'none' would turn an unrelated ROUNDING save into a silent
    // downgrade of the earning method to the lump path (the eee43966 class).
    expect(form).toContain('<input type="hidden" name="method" value={storedMethod} />');
    // Displayed as a SPAN rather than a read-only input: a disabled control still reads as a control, and
    // it would be a second element carrying the earning-method label — the "exactly one visible method
    // picker" invariant eee43966 pinned and this item must not quietly break.
    expect(form).toContain('<span className={cn(inputCls, \'w-72 bg-muted text-muted-foreground\')}>{storedMethod}</span>');
    expect((panelSrc.match(/aria-label=\{t\('subStep\.earningMethodLabel'\)\}/g) ?? []).length).toBe(1);
    // earningRendered stays posted UNCONDITIONALLY. app/admin/actions.ts gates accrualMethod, accrualDay,
    // roundingMethod, roundingThreshold AND roundingBands inside ONE `...(earningRendered ? {} : {})`, so
    // dropping the marker to avoid writing the method would make Rounding Method unsaveable for that type.
    expect(form).toContain('<input type="hidden" name="earningRendered" value="1" />');
    const marker = form.indexOf('name="earningRendered"');
    // r299 (3de1453a): the read-only branch is `legacyReadOnly` — an unknown stored method EXCEPT a legacy earned
    // method on a type that is not Annual Leave, which is replaceable on the select (test/r288-earned-sweep-
    // warning.dom.test.tsx §D). Found, then ordered: a missing branch must not pass as "after the marker".
    const branch = form.indexOf('legacyReadOnly ? (');
    expect(branch).toBeGreaterThan(-1);
    expect(marker).toBeLessThan(branch); // rendered before the branch ⇒ posted on both sides of it
  });

  it('the seed no longer writes an earning method into leave_policy.accrual', () => {
    // A freshly seeded tenant would otherwise re-introduce, on every provision, the exact key migration
    // 0376 strips — and the reset would be untrue for anyone provisioned after it.
    // Comment lines are stripped first: the replacement comment quotes the removed call verbatim, which is
    // exactly the sort of thing that makes a naive source scan lie in both directions.
    const seedSrc = readFileSync(resolve(here, '../db/seed.ts'), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      .join('\n');
    expect(seedSrc).not.toContain("method: 'earned_monthly'");
    // The method is set once, on the leave TYPE, through the single writer.
    expect(seedSrc).toContain("setLeaveTypeRules(admin, { id: annual.id, accrualMethod: 'earned_monthly'");
  });
});
