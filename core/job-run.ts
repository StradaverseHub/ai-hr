/**
 * Scheduled-actions run log (migration 0280). One row per sweep run: what ran, when, for how long,
 * whether it worked, and the cross-tenant aggregate counters describing what it changed.
 *
 * WRITE PATH: owner role only. recordJobRun takes an already-open owner `db` handle (the one the sweep
 * scripts build from MIGRATION_DATABASE_URL) and INSERTs directly — exactly as scripts/statutory-sync.ts
 * writes statutory_pack_sync_log. There is no server action and no SECURITY DEFINER wrapper, because
 * job_run's read gate (app.is_group_admin()) has no tenant dimension: any write path gated on it would
 * let one customer's HR admin forge or erase every other customer's job history. See 0280's header.
 *
 * READ PATH: listRecentJobRuns runs through withTenant like every other UI read, so the job_run_read
 * policy (app.is_group_admin()) is what actually scopes it — a company-scoped hr_admin gets zero rows
 * even if the page's own gate were ever removed.
 */
import { desc, inArray } from 'drizzle-orm';
import { createDb, withTenant, type SessionContext } from '../db/client';
import { jobRun } from '../db/schema';

/** The four out-of-band sweeps, keyed exactly as they are stored in job_run.job_key. */
export const JOB_KEYS = ['leave.accrue', 'review.sweep', 'leave.expire-carry', 'leave.expire-aged'] as const;
export type JobKey = (typeof JOB_KEYS)[number];

/** Outcome vocabulary. Stored as plain text (not a pgEnum — the 0275 widening lesson), owned here. */
export type JobOutcome = 'success' | 'partial' | 'failed';

/**
 * Static, code-side description of each job for the admin screen. The schedule strings mirror the
 * systemd OnCalendar= units installed on the host; they are display-only. Display NAMES and
 * DESCRIPTIONS are NOT here — they live in i18n (scheduledActions.jobs.<i18nKey>.name/.description),
 * so they are never stored in the DB and never untranslated.
 *
 * `i18nKey` is the job key with the dot swapped for a dash, because a dot is a namespace separator in
 * next-intl message keys and 'leave.accrue' would resolve as a nested object rather than a leaf.
 */
export type JobDescriptor = { key: JobKey; i18nKey: string; schedule: string };

export const JOBS: readonly JobDescriptor[] = [
  { key: 'leave.accrue', i18nKey: 'leave-accrue', schedule: 'Monthly — 1st at 02:00' },
  { key: 'review.sweep', i18nKey: 'review-sweep', schedule: 'Daily — 03:00' },
  { key: 'leave.expire-aged', i18nKey: 'leave-expire-aged', schedule: 'Daily — 03:30' },
  { key: 'leave.expire-carry', i18nKey: 'leave-expire-carry', schedule: 'Yearly — 1 April at 03:00' },
];

/**
 * Map a sweep's per-tenant failure counter onto the stored outcome.
 *   no tenants at all      → 'success' (nothing to do is not a failure)
 *   0 failures             → 'success'
 *   some, but not all      → 'partial'
 *   every tenant failed    → 'failed'
 * The script's PROCESS EXIT CODE is unchanged and independent of this: all four still end
 * `process.exit(failures > 0 ? 1 : 0)`, so a partial failure remains a non-zero exit for systemd.
 */
export function jobOutcome(tenantsProcessed: number, tenantsFailed: number): JobOutcome {
  if (tenantsFailed === 0) return 'success';
  if (tenantsProcessed > 0 && tenantsFailed >= tenantsProcessed) return 'failed';
  return 'partial';
}

export type RecordJobRunInput = {
  jobKey: JobKey;
  /** Date.now() captured at the top of the script; duration is derived from it. */
  startedAt: number;
  tenantsProcessed: number;
  tenantsFailed: number;
  /**
   * Cross-tenant AGGREGATE counters, e.g. { granted: 12 } or { swept: 3, forfeited: 12.5 }.
   * Values may be fractional — forfeited is a day count, not an integer — and are stored in jsonb
   * verbatim. No per-tenant breakdown: any tenant's group admin can read this table.
   */
  result?: Record<string, number>;
  error?: string | null;
};

/**
 * The owner Drizzle handle, so the sweep scripts can pass `createDb(ownerUrl).db` straight in. Derived
 * from createDb's own return type rather than hand-rolled, so the insert below is checked against the
 * real jobRun column types (a hand-written structural stand-in silently loses that checking).
 */
type OwnerDb = ReturnType<typeof createDb>['db'];

/**
 * Insert one job_run row. Returns nothing; callers wrap this in their own try/catch so that a logging
 * failure can never change the sweep's exit code (a run that did its real work must not be reported as
 * failed just because the audit insert did not land).
 */
export async function recordJobRun(db: OwnerDb, input: RecordJobRunInput): Promise<void> {
  await db.insert(jobRun).values({
    jobKey: input.jobKey,
    durationMs: Math.max(0, Math.round(Date.now() - input.startedAt)),
    outcome: jobOutcome(input.tenantsProcessed, input.tenantsFailed),
    tenantsProcessed: input.tenantsProcessed,
    tenantsFailed: input.tenantsFailed,
    result: input.result ?? null,
    error: input.error ?? null,
  });
}

export type JobRunRow = {
  id: string;
  jobKey: string;
  ranAt: Date;
  durationMs: number | null;
  outcome: string;
  tenantsProcessed: number;
  tenantsFailed: number;
  result: Record<string, number> | null;
  error: string | null;
};

/**
 * Recent runs for the admin screen, newest first, across all four jobs in one query. `perJob` caps how
 * many runs the caller intends to show per job; the LIMIT here is that cap times the number of jobs,
 * which is a safe upper bound since the caller groups and slices afterwards. Returns [] for anyone the
 * job_run_read policy does not admit — RLS, not a thrown error.
 */
export async function listRecentJobRuns(ctx: SessionContext, perJob = 10): Promise<JobRunRow[]> {
  const rows = await withTenant(ctx, (tx) =>
    tx
      .select()
      .from(jobRun)
      .where(inArray(jobRun.jobKey, [...JOB_KEYS]))
      .orderBy(desc(jobRun.ranAt))
      .limit(perJob * JOB_KEYS.length),
  );
  return rows as JobRunRow[];
}
