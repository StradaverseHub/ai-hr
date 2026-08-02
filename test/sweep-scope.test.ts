/**
 * ADR-0077 slice 9 — the four scheduled sweeps consult tenant standing.
 *
 * WHAT THIS IS GUARDING. r104 made a non-good-standing tenant read-only inside `withTenant`; r105 built
 * the only thing that puts a tenant there. That left the sweeps, which run outside a request and used to
 * enumerate every tenant with `select id, name from tenant` — no standing anywhere in the query.
 *
 * The resulting behaviour disagreed across the four, and the disagreement is the reason this file exists:
 * three of them pass `entitlementsExempt: 'sweeps'` (no snapshot → r104's guard keys on
 * `ctx.entitlements?.tenantStatus` and never engages → they wrote to suspended tenants), while
 * review-sweep resolves a real snapshot (guard engages → read-only error → the tenant is counted as a
 * FAILURE and the process exits non-zero, nightly, for a customer who is suspended on purpose).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  describeSkips,
  loadSweepScope,
  partitionSweepTenants,
  sweepSkipReason,
  SYSTEM_TENANT_ID,
} from '../core/sweep-scope';
import { TENANT_STATUS_GOOD_STANDING } from '../core/entitlement-types';
import { jobOutcome, recordJobRun } from '../core/job-run';
import { closeAll, migrateTestDb, owner, resetDb, seedBase, setTenantStatus } from './harness';
import { desc, eq } from 'drizzle-orm';
import * as schema from '../db/schema';

const t = (id: string, name: string, status: string) => ({ id, name, status });

describe('sweepSkipReason — scope agrees with the write boundary', () => {
  it('admits exactly the statuses withTenant treats as good standing', () => {
    // Stated ABSOLUTELY rather than by iterating the set against itself — the r95 lesson: an assertion
    // that derives its expectation from the thing under test passes when the set is empty.
    expect([...TENANT_STATUS_GOOD_STANDING].sort()).toEqual(['active', 'trial']);
    expect(sweepSkipReason('active')).toBeNull();
    expect(sweepSkipReason('trial')).toBeNull();
  });

  it('skips suspended and closed, naming which one', () => {
    expect(sweepSkipReason('suspended')).toMatch(/suspended/);
    expect(sweepSkipReason('closed')).toMatch(/retention/);
  });

  it('skips an unrecognised status and reports it BY NAME', () => {
    // tenant.status is plain text, so a value nobody taught this code about is reachable. Skipping it is
    // the same answer withTenant gives (it is not in the good-standing set, so writes are refused) —
    // agreeing with the write boundary is the point, and the operator needs to see the value itself.
    const reason = sweepSkipReason('grace-period');
    expect(reason).toContain("'grace-period'");
    expect(reason).toMatch(/not recognised/);
  });

  it('is total over every status the good-standing set does not admit', () => {
    for (const s of ['suspended', 'closed', 'unresolved', 'pending', '']) {
      expect(TENANT_STATUS_GOOD_STANDING.has(s)).toBe(false);
      expect(sweepSkipReason(s)).not.toBeNull();
    }
  });
});

describe('partitionSweepTenants', () => {
  it('splits a mixed list and keeps the reason with the tenant', () => {
    const scope = partitionSweepTenants([
      t('a', 'Acme', 'active'),
      t('b', 'Beta', 'suspended'),
      t('c', 'Gamma', 'trial'),
      t('d', 'Delta', 'closed'),
    ]);
    expect(scope.run.map((x) => x.id)).toEqual(['a', 'c']);
    expect(scope.skipped.map((x) => x.tenant.id)).toEqual(['b', 'd']);
    expect(scope.skipped[0].reason).toMatch(/suspended/);
    expect(scope.skipped[1].reason).toMatch(/retention/);
  });

  it('every tenant lands in exactly one side', () => {
    const all = [t('a', 'A', 'active'), t('b', 'B', 'suspended'), t('c', 'C', 'whatever')];
    const scope = partitionSweepTenants(all);
    expect(scope.run.length + scope.skipped.length).toBe(all.length);
    const ids = [...scope.run.map((x) => x.id), ...scope.skipped.map((x) => x.tenant.id)].sort();
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('describeSkips prints nothing when nothing was skipped', () => {
    expect(describeSkips(partitionSweepTenants([t('a', 'A', 'active')]))).toEqual([]);
  });
});

describe('a skipped tenant is not a failed tenant', () => {
  it('a night where every tenant is suspended is a SUCCESS, not a failure', () => {
    // The behaviour that was actually costing something: review-sweep hit the read-only guard, counted it
    // as a per-tenant failure, and exited non-zero. Skips are excluded from tenantsProcessed, so an
    // all-suspended night is 0 processed / 0 failed.
    const scope = partitionSweepTenants([t('a', 'A', 'suspended'), t('b', 'B', 'closed')]);
    expect(scope.run).toHaveLength(0);
    expect(jobOutcome(scope.run.length, 0)).toBe('success');
  });

  it('does not dilute a real failure — one of two in scope failing is still partial', () => {
    const scope = partitionSweepTenants([t('a', 'A', 'active'), t('b', 'B', 'active'), t('c', 'C', 'suspended')]);
    expect(jobOutcome(scope.run.length, 1)).toBe('partial');
    // And if skips WERE folded into processed, the same night would read 1-of-3 — the reason
    // tenantsSkipped is a separate counter rather than part of tenantsProcessed.
    expect(jobOutcome(3, 3)).toBe('failed');
    expect(jobOutcome(scope.run.length, 2)).toBe('failed');
  });
});

describe('the four sweeps are wired to it', () => {
  const SCRIPTS = [
    'scripts/accrue-earned.ts',
    'scripts/review-sweep.ts',
    'scripts/expire-carry.ts',
    'scripts/expire-aged-leave.ts',
  ];

  it.each(SCRIPTS)('%s enumerates through loadSweepScope, not a bare tenant select', (path) => {
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/loadSweepScope\(owner\.db\)/);
    // The exact shape of the old bug: enumerating tenants without asking for status. A sweep that
    // re-introduces this gets its writes refused by withTenant one tenant at a time instead.
    expect(src).not.toMatch(/select\(\{\s*id:\s*tenant\.id,\s*name:\s*tenant\.name\s*\}\)/);
  });

  it.each(SCRIPTS)('%s records what it skipped', (path) => {
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/tenantsSkipped:\s*scope\.skipped\.length/);
  });

  it.each(SCRIPTS)('%s reports skips on the console', (path) => {
    expect(readFileSync(path, 'utf8')).toMatch(/describeSkips\(scope\)/);
  });
});

describe('against the real database', () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeAll();
  });

  it('loadSweepScope reads standing from the tenant row, not from a caller’s assumption', async () => {
    const a = await seedBase();
    const b = await seedBase();
    // Baseline first: a freshly seeded tenant must be IN scope, otherwise the assertion below could pass
    // because nothing is ever in scope.
    const before = await loadSweepScope(owner.db);
    expect(before.run.map((t) => t.id).sort()).toEqual([a.tenantId, b.tenantId].sort());
    expect(before.skipped).toHaveLength(0);

    await setTenantStatus(b.tenantId, 'suspended');

    const after = await loadSweepScope(owner.db);
    expect(after.run.map((t) => t.id)).toEqual([a.tenantId]);
    expect(after.skipped.map((s) => s.tenant.id)).toEqual([b.tenantId]);
    expect(after.skipped[0].reason).toMatch(/suspended/);
  });

  it('excludes the reserved audit anchor, which is not a customer and never was', async () => {
    // 0151 inserts tenant 0…0 so pre-auth events (login-failed, reset-request) have an FK target. The
    // old `select id, name from tenant` picked it up, so every sweep has counted one tenant more than
    // exists — visible to an operator on the Scheduled Actions screen. Assert both that it is gone AND
    // that it is in the table, so this cannot pass because the row is simply missing.
    const [anchor] = await owner.db
      .select({ id: schema.tenant.id })
      .from(schema.tenant)
      .where(eq(schema.tenant.id, SYSTEM_TENANT_ID));
    expect(anchor?.id).toBe(SYSTEM_TENANT_ID);

    const real = await seedBase();
    const scope = await loadSweepScope(owner.db);
    expect(scope.run.map((t) => t.id)).toEqual([real.tenantId]);
    // Not reported as a skip either — it is not a tenant whose standing was weighed.
    expect(scope.skipped.map((s) => s.tenant.id)).not.toContain(SYSTEM_TENANT_ID);
  });

  it('a closed tenant is out of scope too — dunning never closes, so this state came from an operator', async () => {
    const a = await seedBase();
    await setTenantStatus(a.tenantId, 'closed');
    const scope = await loadSweepScope(owner.db);
    expect(scope.run).toHaveLength(0);
    expect(scope.skipped[0].reason).toMatch(/retention/);
  });

  it('records the skip count in the run log, and only when something was skipped', async () => {
    const startedAt = Date.now() - 10;
    await recordJobRun(owner.db, {
      jobKey: 'leave.accrue',
      startedAt,
      tenantsProcessed: 2,
      tenantsFailed: 0,
      tenantsSkipped: 3,
      result: { granted: 7 },
    });
    await recordJobRun(owner.db, {
      jobKey: 'leave.expire-carry',
      startedAt,
      tenantsProcessed: 2,
      tenantsFailed: 0,
      tenantsSkipped: 0,
      result: { swept: 1, forfeited: 2.5 },
    });

    const [accrue] = await owner.db
      .select()
      .from(schema.jobRun)
      .where(eq(schema.jobRun.jobKey, 'leave.accrue'))
      .orderBy(desc(schema.jobRun.ranAt));
    expect(accrue.result).toEqual({ granted: 7, skipped: 3 });
    // Skips do not make the night a failure, and do not inflate what was processed.
    expect(accrue.outcome).toBe('success');
    expect(accrue.tenantsProcessed).toBe(2);

    const [carry] = await owner.db
      .select()
      .from(schema.jobRun)
      .where(eq(schema.jobRun.jobKey, 'leave.expire-carry'))
      .orderBy(desc(schema.jobRun.ranAt));
    // A `skipped: 0` on every row would bury the runs that actually skipped something. Fractional day
    // counts still survive the merge unrounded.
    expect(carry.result).toEqual({ swept: 1, forfeited: 2.5 });
  });
});

describe('skipping is NOT catching up — the asymmetry between accrual and expiry', () => {
  /**
   * This is the assertion that stops a well-meaning "just replay it on the next run" change.
   *
   * ACCRUAL self-heals: accrueEarned computes entitlement from service dates up to `asOf`, so the first
   * run after reinstatement grants the months missed during suspension. Nothing is lost by skipping it.
   *
   * EXPIRY DOES NOT: both expiry sweeps compare `today` against a stored expiry date, so a plain re-run
   * after reinstatement forfeits everything whose date fell INSIDE the suspended window — days the
   * employee never had a chance to use, because their employer's account was frozen. The reactivation
   * plan says the window must be excluded from expiry clocks; that exclusion lives in reactivation, and
   * this file's job is to make sure the sweeps do not quietly grow their own version of it.
   */
  it('no sweep contains a catch-up path keyed on skipped tenants', () => {
    for (const path of ['scripts/expire-carry.ts', 'scripts/expire-aged-leave.ts', 'scripts/accrue-earned.ts']) {
      const src = readFileSync(path, 'utf8');
      // scope.skipped may only be COUNTED and PRINTED. Iterating it is how a catch-up loop starts.
      expect(src).not.toMatch(/for\s*\(.*of\s+scope\.skipped/);
      expect(src).not.toMatch(/scope\.skipped\.map\(/);
    }
  });

  it('the expiry sweeps still measure from a stored date, which is why replay is reactivation’s job', () => {
    // Substantiates the claim above rather than asserting it in prose: both expiry sweeps take `today`
    // and pass it through, so they have no notion of a window to exclude.
    for (const path of ['scripts/expire-carry.ts', 'scripts/expire-aged-leave.ts']) {
      const src = readFileSync(path, 'utf8');
      expect(src).toMatch(/\{\s*today\s*\}/);
      expect(src).not.toMatch(/suspendedWindow|excludeWindow|catchUp/i);
    }
  });
});
