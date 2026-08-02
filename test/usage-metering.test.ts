/**
 * ADR-0077 slice 10 — the usage meter, and the property the whole slice exists for.
 *
 * `usage_snapshot` has existed since slice 1 with NOTHING writing to it. Usage is not reconstructable:
 * headcount changes, draft payslips are deleted with their batches, modules come and go. So a decision
 * next year to bill on past usage would have nothing to re-derive from, and **no amount of later work
 * recovers a day that was never captured.**
 *
 * The plan's verification criterion is the last describe block here: *"a synthetic bill for a past month
 * re-derives from snapshot rows alone"* — asserted against rows and nothing else, no live tables
 * consulted, because that is precisely the guarantee.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import * as schema from '../db/schema';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, setTenantStatus, type Base } from './harness';
import { usageForTenant } from '../core/usage-metering';
import { captureUsage } from '../scripts/capture-usage';
import { JOBS, JOB_KEYS } from '../core/job-run';

const URL = process.env.TEST_MIGRATION_DATABASE_URL!;
const DAY = '2026-08-01';

describe('the meter is registered as a scheduled job', () => {
  it('usage.capture is a known job key with a descriptor', () => {
    expect([...JOB_KEYS]).toContain('usage.capture');
    const d = JOBS.find((j) => j.key === 'usage.capture');
    expect(d?.i18nKey).toBe('usage-capture');
    expect(d?.schedule).toMatch(/Daily/);
  });
});

describe('against the real database', () => {
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

  /** A person + an active employment at the base company, hired on `hiredOn`. */
  const hire = async (name: string, hiredOn: string, terminatedOn: string | null = null) => {
    const [p] = await owner.db
      .insert(schema.person)
      .values({ tenantId: b.tenantId, fullName: name, primaryEmail: `${name.toLowerCase()}@example.test` })
      .returning({ id: schema.person.id });
    const [e] = await owner.db
      .insert(schema.employment)
      .values({ tenantId: b.tenantId, companyId: b.companyId, personId: p.id, hiredOn, terminatedOn })
      .returning({ id: schema.employment.id });
    return { personId: p.id, employmentId: e.id };
  };

  const snapshotsFor = (day: string) =>
    owner.db
      .select()
      .from(schema.usageSnapshot)
      .where(and(eq(schema.usageSnapshot.tenantId, b.tenantId), eq(schema.usageSnapshot.capturedOn, day)));

  describe('headcount', () => {
    it('counts an employment active on the day', async () => {
      await hire('Aisyah', '2026-01-01');
      const [row] = await usageForTenant(owner.db, b.tenantId, DAY);
      expect(row.activeEmployments).toBe(1);
    });

    it('excludes one hired AFTER the day — the boundary, not just the happy case', async () => {
      await hire('Future', '2026-08-02');
      const [row] = await usageForTenant(owner.db, b.tenantId, DAY);
      expect(row.activeEmployments).toBe(0);
    });

    it('includes one hired ON the day, and one terminated ON the day', async () => {
      // Both endpoints are INCLUSIVE: someone hired today worked today, and someone whose last day is
      // today was employed today. Off-by-one here silently under- or over-bills every month.
      await hire('StartsToday', DAY);
      await hire('EndsToday', '2026-01-01', DAY);
      const [row] = await usageForTenant(owner.db, b.tenantId, DAY);
      expect(row.activeEmployments).toBe(2);
    });

    it('excludes one terminated BEFORE the day', async () => {
      await hire('Left', '2026-01-01', '2026-07-31');
      const [row] = await usageForTenant(owner.db, b.tenantId, DAY);
      expect(row.activeEmployments).toBe(0);
    });
  });

  describe('active users', () => {
    it('counts a user whose person holds an active employment', async () => {
      const { personId } = await hire('Aisyah', '2026-01-01');
      await owner.db
        .insert(schema.appUser)
        .values({ tenantId: b.tenantId, workosUserId: `u_${personId}`, personId });
      const [row] = await usageForTenant(owner.db, b.tenantId, DAY);
      expect(row.activeUsers).toBe(1);
    });

    it('does NOT count a user whose only employment has ended', async () => {
      const { personId } = await hire('Left', '2026-01-01', '2026-07-01');
      await owner.db
        .insert(schema.appUser)
        .values({ tenantId: b.tenantId, workosUserId: `u_${personId}`, personId });
      const [row] = await usageForTenant(owner.db, b.tenantId, DAY);
      // The employment is the attribution path; a login that can no longer reach any company is not
      // usage of that company.
      expect(row.activeUsers).toBe(0);
      expect(row.activeEmployments).toBe(0);
    });

    it('counts a person once even with two employment rows at the same company', async () => {
      const [p] = await owner.db
        .insert(schema.person)
        .values({ tenantId: b.tenantId, fullName: 'Rehired', primaryEmail: 'rehired@example.test' })
        .returning({ id: schema.person.id });
      // A rehire leaves the old row in place; DISTINCT is what stops it double-counting.
      await owner.db.insert(schema.employment).values([
        { tenantId: b.tenantId, companyId: b.companyId, personId: p.id, hiredOn: '2020-01-01', terminatedOn: '2026-09-01' },
        { tenantId: b.tenantId, companyId: b.companyId, personId: p.id, hiredOn: '2026-01-01' },
      ]);
      await owner.db.insert(schema.appUser).values({ tenantId: b.tenantId, workosUserId: 'u_rehired', personId: p.id });
      const [row] = await usageForTenant(owner.db, b.tenantId, DAY);
      expect(row.activeUsers).toBe(1);
      expect(row.activeEmployments).toBe(2); // two employment ROWS is the honest headcount answer here
    });
  });

  describe('modules', () => {
    /**
     * seedBase already grants this tenant a set of modules, so these assertions clear the grants first
     * and state the expected set ABSOLUTELY. Asserting `toContain` against the seeded set instead would
     * pass whether or not the filter under test works — the r95 lesson about expectations derived from
     * the thing being tested.
     */
    beforeEach(async () => {
      await owner.db.delete(schema.tenantModule).where(eq(schema.tenantModule.tenantId, b.tenantId));
    });

    it('includes tenant-wide grants and is sorted and deduplicated', async () => {
      await owner.db.insert(schema.tenantModule).values([
        { tenantId: b.tenantId, moduleCode: 'country-my', companyId: null, status: 'active' },
        { tenantId: b.tenantId, moduleCode: 'attendance', companyId: null, status: 'active' },
      ]);
      const [row] = await usageForTenant(owner.db, b.tenantId, DAY);
      expect(row.modulesActive).toEqual(['attendance', 'country-my']);
    });

    it('ignores a DISABLED grant', async () => {
      await owner.db.insert(schema.tenantModule).values([
        { tenantId: b.tenantId, moduleCode: 'attendance', companyId: null, status: 'disabled' },
      ]);
      const [row] = await usageForTenant(owner.db, b.tenantId, DAY);
      expect(row.modulesActive).toEqual([]);
    });

    it('COUNTS a trial grant — a trial module is a module in use', async () => {
      // The bug this caught in my own first draft: filtering on status='active' alone silently
      // under-reports every tenant on trial, which is exactly the population a conversion decision
      // is about. core/entitlements.ts:422 treats ('active','trial') as enabled; the meter must agree,
      // or the same module is 'enabled' to the gate and invisible to the bill.
      await owner.db.insert(schema.tenantModule).values([
        { tenantId: b.tenantId, moduleCode: 'attendance', companyId: null, status: 'trial' },
      ]);
      const [row] = await usageForTenant(owner.db, b.tenantId, DAY);
      expect(row.modulesActive).toEqual(['attendance']);
    });
  });

  describe('the sweep', () => {
    it('writes one row per company and records the counts', async () => {
      await hire('Aisyah', '2026-01-01');
      const r = await captureUsage(URL, { capturedOn: DAY });
      expect(r.rows).toBeGreaterThanOrEqual(1);

      const rows = await snapshotsFor(DAY);
      expect(rows).toHaveLength(1);
      expect(rows[0].companyId).toBe(b.companyId);
      expect(rows[0].activeEmployments).toBe(1);
      expect(rows[0].country).toBe('MY');
    });

    it('is IDEMPOTENT — a second run replaces the day rather than doubling it', async () => {
      await hire('Aisyah', '2026-01-01');
      await captureUsage(URL, { capturedOn: DAY });
      await captureUsage(URL, { capturedOn: DAY });
      // Without migration 0347's unique index this is 2 rows, and the month's bill is double.
      expect(await snapshotsFor(DAY)).toHaveLength(1);
    });

    it('a re-run after a change REPLACES the figure — the later answer wins', async () => {
      await hire('Aisyah', '2026-01-01');
      await captureUsage(URL, { capturedOn: DAY });
      expect((await snapshotsFor(DAY))[0].activeEmployments).toBe(1);

      await hire('Second', '2026-01-01');
      await captureUsage(URL, { capturedOn: DAY });
      const rows = await snapshotsFor(DAY);
      expect(rows).toHaveLength(1);
      // DO UPDATE, not DO NOTHING: an operator re-running after fixing data must see the fix land.
      expect(rows[0].activeEmployments).toBe(2);
    });

    it('SKIPS a tenant out of good standing, and says so rather than failing', async () => {
      await hire('Aisyah', '2026-01-01');
      await setTenantStatus(b.tenantId, 'suspended');
      const r = await captureUsage(URL, { capturedOn: DAY });
      expect(r.skipped).toBe(1);
      expect(r.failures).toBe(0); // a suspended customer is a business state, not an incident (r108)
      expect(await snapshotsFor(DAY)).toHaveLength(0);
    });

    it('keeps separate rows per day, which is what makes a month summable', async () => {
      await hire('Aisyah', '2026-01-01');
      await captureUsage(URL, { capturedOn: '2026-08-01' });
      await captureUsage(URL, { capturedOn: '2026-08-02' });
      expect(await snapshotsFor('2026-08-01')).toHaveLength(1);
      expect(await snapshotsFor('2026-08-02')).toHaveLength(1);
    });
  });

  /**
   * THE SLICE'S OWN VERIFICATION CRITERION, quoted from the plan: "a synthetic bill for a past month
   * re-derives from snapshot rows alone". Everything below reads ONLY usage_snapshot — no employment,
   * no payslip, no tenant_module — because that is the guarantee being claimed.
   */
  describe('a synthetic bill re-derives from snapshot rows alone', () => {
    it('bills a month from the rows, with no live table consulted', async () => {
      await hire('One', '2026-01-01');
      await captureUsage(URL, { capturedOn: '2026-08-01' });
      await hire('Two', '2026-01-01');
      await captureUsage(URL, { capturedOn: '2026-08-02' });
      await captureUsage(URL, { capturedOn: '2026-08-03' });

      // The bill: peak headcount in the month, and the summed payslip count. Both plausible pricing
      // units, both derivable — which is the point of over-capturing before the unit is chosen.
      const [bill] = await owner.db
        .select({
          peakEmployments: sql<number>`max(${schema.usageSnapshot.activeEmployments})::int`,
          billedPayslips: sql<number>`coalesce(sum(${schema.usageSnapshot.payslipsGenerated}), 0)::int`,
          daysObserved: sql<number>`count(*)::int`,
        })
        .from(schema.usageSnapshot)
        .where(
          and(
            eq(schema.usageSnapshot.tenantId, b.tenantId),
            sql`${schema.usageSnapshot.capturedOn} >= '2026-08-01'`,
            sql`${schema.usageSnapshot.capturedOn} <= '2026-08-31'`,
          ),
        );

      expect(bill.daysObserved).toBe(3);
      expect(bill.peakEmployments).toBe(2);
      expect(bill.billedPayslips).toBe(0);
    });

    it('a summed unit degrades gracefully across a MISSED day', async () => {
      // The reason payslipsGenerated is a daily DELTA and not a running total. Days 1 and 3 captured,
      // day 2 missed (a cron that did not fire, or a tenant suspended that day). A sum over present
      // rows is simply the usage that was observed; a difference between endpoints would silently
      // attribute day 2's activity to day 3 — or lose it.
      await hire('One', '2026-01-01');
      await captureUsage(URL, { capturedOn: '2026-08-01' });
      await captureUsage(URL, { capturedOn: '2026-08-03' });

      const [agg] = await owner.db
        .select({ days: sql<number>`count(*)::int`, slips: sql<number>`coalesce(sum(${schema.usageSnapshot.payslipsGenerated}),0)::int` })
        .from(schema.usageSnapshot)
        .where(eq(schema.usageSnapshot.tenantId, b.tenantId));
      expect(agg.days).toBe(2);
      expect(agg.slips).toBe(0);
    });
  });
});
