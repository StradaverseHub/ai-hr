/**
 * b25e421e (r352) — A BIRTHDAY MUST REACH THE PAYSLIP WITH NOBODY EDITING ANYTHING.
 *
 * ═══ THE DEFECT THIS PINS ═══
 *
 * `employee_statutory_my.num_children` and `.child_relief_table` are a CACHED PROJECTION of the Family
 * register, and the payroll kernel reads them, not the register (core/payroll.ts:3665 selects them,
 * :5961 turns them into `taxProfile.children` and `childReliefAmount`). Their correct value depends on
 * the CLOCK, because eligibility turns on a child's age — but `syncChildReliefFromFamily` is invalidated
 * only by WRITES: it fires on a dependent add / update / archive and on nothing else. Nothing fires on
 * the passage of time.
 *
 * So a child had a birthday, the SCREEN dropped them immediately (it re-derives on every render, r351),
 * and the PAYSLIP went on relieving them until a human next opened that family and pressed Save. That
 * gap is the whole of b25e421e, and r351's entry named it as the half it did not ship.
 *
 * ═══ WHY THE FIX IS A SCHEDULE AND NOT A CODE CHANGE ═══
 *
 * `scripts/resync-child-relief-grid.ts` already exists and already calls `syncChildReliefFromFamily` —
 * the SAME single author a family edit calls, with all four of its rails — so a resynced row is
 * byte-identical to what the next edit would have produced. It was simply never put on cron. The fix is
 * to schedule it; this file pins the PROPERTY that makes scheduling sufficient, because a cron entry
 * lives on the box and no test can see it.
 *
 * What is asserted here is therefore the load-bearing claim: given no writes at all, only a later clock,
 * the projection moves. If that ever stopped being true, a nightly run would be a nightly no-op and the
 * payslip would go back to being stale with nothing to show for it.
 *
 * ═══ THE 00:00-08:00 CASE IS NOT INCIDENTAL — IT IS WHEN THE JOB RUNS ═══
 *
 * The third case pins the Kuala Lumpur date rather than the host's UTC date. This is not a nicety: a
 * nightly job runs inside exactly the window where the two disagree, so a sync that read UTC would age
 * every child a day late precisely on the nights it matters. core/dependents.ts:557 records the same
 * reasoning for why r351 moved that derivation onto `todayInKualaLumpur()`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { setStatutoryProfileMY, setTaxProfileMY } from '../localization/my/statutory';
import {
  addDependent,
  childAgeYears,
  isChildReliefEligible,
  qualifyingChildReliefFor,
  syncChildReliefFromFamily,
} from '../core/dependents';
import { employeeDependent } from '../db/schema';
import { withTenant } from '../db/client';
import { hireEmployee } from '../core/org';
import { adminCtx, closeAll, migrateTestDb, resetDb, seedBase, type Base } from './harness';

let base: Base;

/**
 * ⚠️ ONLY `Date` IS FAKED. `vi.useFakeTimers()` with its defaults also replaces setTimeout and
 * setInterval, which the postgres driver and its connection pool run on — every query then waits on a
 * clock nothing advances, and all three cases below time out at 30s rather than failing. Faking Date
 * alone gives `todayInKualaLumpur()` the instant it needs while leaving the driver's timers real.
 */

/**
 * The child's birthday, and the two instants either side of it. Derived from one constant so the pair
 * cannot drift apart, and fixed so nothing here depends on the day the suite runs (CLAUDE.md section 8
 * forbids a hardcoded FUTURE date read off the clock; this is a fixture's own timeline, not "now").
 */
const DOB = '2008-06-15';
/** 12:00 Kuala Lumpur on the day BEFORE the 18th birthday. UTC date and KL date agree here. */
const DAY_BEFORE = new Date('2026-06-14T04:00:00Z');
/** 12:00 Kuala Lumpur ON the 18th birthday. */
const BIRTHDAY_NOON = new Date('2026-06-15T04:00:00Z');
/** 01:00 Kuala Lumpur on the birthday — which is still 17:00 UTC on the 14th. The cron window. */
const BIRTHDAY_0100_MYT = new Date('2026-06-14T17:00:00Z');

let icSeq = 0;
/** `setTaxProfileMY` refuses to write tax details before an IC exists, so every fixture seeds one. */
async function hireOnAuto(name: string) {
  const e = await hireEmployee(adminCtx(base), {
    person: { fullName: name, primaryEmail: `${name.toLowerCase()}_${randomUUID().slice(0, 8)}@t.local` },
    companyId: base.companyId,
    departmentId: base.deptA,
    employmentType: 'full_time',
    hiredOn: '2026-01-01',
  });
  icSeq += 1;
  await setStatutoryProfileMY(adminCtx(base), {
    personId: e.personId,
    icNumber: `9001010${String(100000 + icSeq).slice(-5)}`,
  });
  await setTaxProfileMY(adminCtx(base), { personId: e.personId, numChildren: 0, childReliefMode: 'auto' });
  return e;
}

/** The STORED head count — `physicalChildren` is `num_children` read straight off the column. */
async function storedCount(personId: string, asOf: string): Promise<number | null> {
  const q = await qualifyingChildReliefFor(adminCtx(base), { personId, asOf });
  return q?.physicalChildren ?? null;
}

/** Proof that nothing wrote to the family register between two syncs. */
async function dependentStamps(personId: string): Promise<string[]> {
  return withTenant(adminCtx(base), async (tx) => {
    const rows = await tx
      .select({ id: employeeDependent.id, updatedAt: employeeDependent.updatedAt })
      .from(employeeDependent)
      .where(eq(employeeDependent.personId, personId))
      .orderBy(employeeDependent.id);
    return rows.map((r) => `${r.id}:${String(r.updatedAt)}`);
  });
}

beforeAll(async () => {
  await migrateTestDb();
});
beforeEach(async () => {
  await resetDb();
  base = await seedBase();
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  await closeAll();
});

/**
 * ⚠️ THIS BLOCK IS A DEFECT THIS ROUND FIXED, NOT A RESTATEMENT OF EXISTING BEHAVIOUR.
 *
 * `childAgeYears` computed `floor(elapsed / 365.25 days)`. From 2008-06-15 to 2026-06-15 is 6,574 days;
 * 18 × 365.25 is 6,574.5; so on the morning of their eighteenth birthday the function answered SEVENTEEN,
 * and `isChildReliefEligible` (`age < 18`) therefore kept an ineligible child inside the PCB relief figure.
 * How far it erred depended on how many 29-Februaries fell inside the span, so two children could get two
 * different answers on their own birthdays. It now delegates to the calendar-accurate `completedYearsAt`.
 *
 * These four cases are the boundary, and they are what makes the three database cases below non-vacuous:
 * without them, a nightly re-derivation could ship while still dropping the child a day late.
 */
describe('b25e421e · the age rule turns over ON the birthday, not a day or two after it', () => {
  const at = (d: string) => new Date(`${d}T00:00:00Z`);

  it('is 17 the day before, and 18 on the day itself', () => {
    expect(childAgeYears(DOB, at('2026-06-14')), 'the day before the eighteenth birthday').toBe(17);
    expect(childAgeYears(DOB, at('2026-06-15')), 'the eighteenth birthday itself — this read 17').toBe(18);
  });

  it('a 29-February birthday increments on 1 March in a common year, never on 28 February', () => {
    expect(childAgeYears('2008-02-29', at('2026-02-28'))).toBe(17);
    expect(childAgeYears('2008-02-29', at('2026-03-01'))).toBe(18);
  });

  it('eligibility follows it: the child is a qualifying child up to the birthday and not on it', () => {
    const row = {
      relationship: 'child' as const,
      dateOfBirth: DOB,
      isStudent: null,
      isDeceased: false,
      archivedAt: null,
      childTaxRelief: null,
    };
    expect(isChildReliefEligible(row, at('2026-06-14')), 'still 17, still eligible').toBe(true);
    expect(isChildReliefEligible(row, at('2026-06-15')), 'eighteen — out of the relief').toBe(false);
  });

  it('an unparseable or missing date of birth is still null, and is not counted', () => {
    expect(childAgeYears(null, at('2026-06-15'))).toBeNull();
    expect(childAgeYears('not-a-date', at('2026-06-15'))).toBeNull();
  });
});

describe('b25e421e · the stored tax figure ages on the clock, with no family edit', () => {
  it('a child crossing 18 overnight drops out of the stored head count on the next run alone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DAY_BEFORE);

    const E = await hireOnAuto('AgesOut');
    await addDependent(adminCtx(base), {
      personId: E.personId,
      fullName: 'Turns Eighteen',
      relationship: 'child',
      dateOfBirth: DOB,
      childReliefCategory: 'under_18',
      childReliefPercentage: 100,
      // Neither an explicit relief decision nor a student flag: the DATE OF BIRTH must be what decides,
      // because either of those legitimately wins over the age test (core/dependents.ts:240-243) and
      // would make this case prove nothing.
    });

    // Baseline: the day before the birthday, the register supports one child and the column holds one.
    await syncChildReliefFromFamily(adminCtx(base), E.personId);
    expect(await storedCount(E.personId, '2026-06-14'), 'a 17-year-old is an eligible child').toBe(1);

    const before = await dependentStamps(E.personId);

    // ─── The only thing that happens between the two runs is TIME. No add, no update, no archive. ───
    vi.setSystemTime(BIRTHDAY_NOON);
    const res = await syncChildReliefFromFamily(adminCtx(base), E.personId);

    expect(res.changed, 'the passage of time alone must move the projection').toBe(true);
    expect(res.before).toBe(1);
    expect(res.after).toBe(0);
    expect(await storedCount(E.personId, '2026-06-15'), 'the payslip reads this column').toBe(0);

    // Non-vacuity in the other direction: the move must NOT have come from a hidden write.
    expect(await dependentStamps(E.personId), 'nothing may have touched the family register').toEqual(before);
  });

  it('a run that does not cross the birthday reports unchanged — the job is a no-op on an ordinary night', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DAY_BEFORE);

    const E = await hireOnAuto('StaysSeventeen');
    await addDependent(adminCtx(base), {
      personId: E.personId,
      fullName: 'Still Seventeen',
      relationship: 'child',
      dateOfBirth: DOB,
      childReliefCategory: 'under_18',
      childReliefPercentage: 100,
    });
    await syncChildReliefFromFamily(adminCtx(base), E.personId);
    expect(await storedCount(E.personId, '2026-06-14')).toBe(1);

    // Re-run on the same day. Rail (b) must short-circuit, or a nightly job writes a tax event for every
    // employee every night and the audit trail becomes noise.
    const res = await syncChildReliefFromFamily(adminCtx(base), E.personId);
    expect(res.changed, 'nothing moved, so nothing may be written').toBe(false);
    expect(res.skipped).toBe('unchanged');
    expect(await storedCount(E.personId, '2026-06-14')).toBe(1);
  });

  it('at 01:00 Kuala Lumpur the child is already 18, though UTC still says yesterday — the cron window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(DAY_BEFORE);

    const E = await hireOnAuto('MidnightWindow');
    await addDependent(adminCtx(base), {
      personId: E.personId,
      fullName: 'Birthday At Midnight',
      relationship: 'child',
      dateOfBirth: DOB,
      childReliefCategory: 'under_18',
      childReliefPercentage: 100,
    });
    await syncChildReliefFromFamily(adminCtx(base), E.personId);
    expect(await storedCount(E.personId, '2026-06-14')).toBe(1);

    // 17:00 UTC on the 14th IS 01:00 on the 15th in Kuala Lumpur. A sync that read the host's UTC date
    // would still call this child 17 and leave the relief in place for another 24 hours — on the night
    // the nightly job actually runs.
    vi.setSystemTime(BIRTHDAY_0100_MYT);
    expect(
      new Date(BIRTHDAY_0100_MYT).toISOString().slice(0, 10),
      'the fixture is only meaningful while UTC and KL disagree here',
    ).toBe('2026-06-14');

    const res = await syncChildReliefFromFamily(adminCtx(base), E.personId);
    expect(res.changed, 'the tenant calendar, not the host clock, decides').toBe(true);
    expect(res.after).toBe(0);
  });
});
