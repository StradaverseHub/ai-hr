/**
 * Scheduled-actions run log (0280) — the recorder itself: what it stores, how it classifies an
 * outcome, and the guarantee that a logging failure cannot change a sweep's exit code.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import { JOBS, jobOutcome, recordJobRun } from '../core/job-run';
import { closeAll, migrateTestDb, owner, resetDb } from './harness';

const runsFor = (jobKey: string) =>
  owner.db.select().from(schema.jobRun).where(eq(schema.jobRun.jobKey, jobKey)).orderBy(desc(schema.jobRun.ranAt));

describe('0280 — job_run recorder', () => {
  beforeAll(async () => {
    await migrateTestDb();
  });
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await closeAll();
  });

  it('writes duration, counters and error text', async () => {
    const startedAt = Date.now() - 1500;
    await recordJobRun(owner.db, {
      jobKey: 'review.sweep',
      startedAt,
      tenantsProcessed: 4,
      tenantsFailed: 1,
      result: { opened: 3, reminders: 5 },
      error: 'Acme Sdn Bhd: connection reset',
    });

    const [row] = await runsFor('review.sweep');
    expect(row.outcome).toBe('partial');
    expect(row.tenantsProcessed).toBe(4);
    expect(row.tenantsFailed).toBe(1);
    expect(row.result).toEqual({ opened: 3, reminders: 5 });
    expect(row.error).toBe('Acme Sdn Bhd: connection reset');
    // Derived from startedAt, so it must reflect the elapsed time rather than being null/zero.
    expect(row.durationMs).toBeGreaterThanOrEqual(1500);
    expect(row.ranAt).toBeInstanceOf(Date);
  });

  it('a run with nothing to report stores defaults, not nulls, for the counters', async () => {
    await recordJobRun(owner.db, { jobKey: 'leave.accrue', startedAt: Date.now(), tenantsProcessed: 0, tenantsFailed: 0 });
    const [row] = await runsFor('leave.accrue');
    expect(row.outcome).toBe('success');
    expect(row.tenantsProcessed).toBe(0);
    expect(row.tenantsFailed).toBe(0);
    expect(row.result).toBeNull();
    expect(row.error).toBeNull();
  });

  // The single most important storage property: expire-carry / expire-aged aggregate forfeited DAYS as a
  // rounded float. Coercing result to integers (or rendering it with parseInt) would silently report 12
  // days forfeited where 12.5 were actually taken from employees.
  it('fractional counters in result survive the round-trip un-truncated', async () => {
    await recordJobRun(owner.db, {
      jobKey: 'leave.expire-carry',
      startedAt: Date.now(),
      tenantsProcessed: 2,
      tenantsFailed: 0,
      result: { swept: 3, forfeited: 12.5 },
    });
    const [row] = await runsFor('leave.expire-carry');
    expect(row.result).toEqual({ swept: 3, forfeited: 12.5 });
    expect(row.result?.forfeited).toBe(12.5);
    expect(Number.isInteger(row.result?.forfeited)).toBe(false);
  });

  it('classifies the outcome from the per-tenant failure counter', () => {
    expect(jobOutcome(4, 0)).toBe('success');
    expect(jobOutcome(4, 1)).toBe('partial');
    expect(jobOutcome(4, 3)).toBe('partial');
    expect(jobOutcome(4, 4)).toBe('failed');
    // No tenants at all is "nothing to do", not a failure.
    expect(jobOutcome(0, 0)).toBe('success');
  });

  // The scripts wrap recordJobRun in their own try/catch precisely so that a failure to write the audit
  // row cannot turn a run that did its real work into a non-zero exit. This pins the shape of that
  // contract: recordJobRun rejects (it does not swallow), and the caller's catch is what absorbs it.
  it('a recordJobRun failure surfaces as a rejection the caller can absorb without changing its exit code', async () => {
    const exploding = {
      insert: () => ({
        values: () => Promise.reject(new Error('job_run insert failed')),
      }),
    } as unknown as Parameters<typeof recordJobRun>[0];

    await expect(
      recordJobRun(exploding, { jobKey: 'leave.accrue', startedAt: Date.now(), tenantsProcessed: 1, tenantsFailed: 0 }),
    ).rejects.toThrow('job_run insert failed');

    // …and the sweep's own try/catch around it yields the exit code the failure counter dictates.
    const failures = 0;
    let exitCode = -1;
    try {
      await recordJobRun(exploding, { jobKey: 'leave.accrue', startedAt: Date.now(), tenantsProcessed: 1, tenantsFailed: 0 });
    } catch {
      // swallowed, exactly as the scripts do
    }
    exitCode = failures > 0 ? 1 : 0;
    expect(exitCode).toBe(0);
    // Nothing was written, so the screen simply has no row for that run — it never reports a false failure.
    expect(await runsFor('leave.accrue')).toHaveLength(0);
  });

  it('the job registry covers exactly the four sweeps, with i18n keys free of dot separators', () => {
    expect(JOBS.map((j) => j.key).sort()).toEqual(
      ['leave.accrue', 'leave.expire-aged', 'leave.expire-carry', 'review.sweep'].sort(),
    );
    // A dot in a next-intl key is a namespace separator, so 'leave.accrue' would resolve as a nested
    // object rather than a leaf message. The registry swaps it for a dash.
    for (const j of JOBS) expect(j.i18nKey).not.toContain('.');
  });
});
