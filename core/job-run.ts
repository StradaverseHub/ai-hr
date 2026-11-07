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
import { and, desc, eq } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';
import { createDb, withTenant, type SessionContext } from '../db/client';
import { jobRun } from '../db/schema';

/** The out-of-band sweeps, keyed exactly as they are stored in job_run.job_key.
 *
 *  c459bff9 removed 'leave.expire-aged': the sweep, its script and the leave-type expiry columns it read
 *  are gone. Note what dropping the key does — listRecentJobRuns filters history with
 *  the active JOB_KEYS, so past runs of the deleted sweep stop appearing on the Scheduled
 *  Actions screen. The job_run ROWS are kept in the table; only the screen stops listing a job that can
 *  never run again. */
export const JOB_KEYS = [
  'leave.accrue',
  'replacement-holidays.reconcile',
  'review.sweep',
  'notifications.project',
  'leave.expire-carry',
  // ADR-0077 slice 10 (r113) — the usage meter. Unlike the sweeps above, a MISSED RUN IS A PERMANENT HOLE:
  // the others recompute from stored dates, this one records a fact that stops being observable.
  'usage.capture',
  // ADR-0076 slice 7 — the nightly provisional dry-run. A MISSED RUN IS HARMLESS, unlike usage.capture:
  // the evaluator is idempotent and recomputes from stored payslips, so the next run catches up fully.
  'anomaly.sweep',
  // Readiness 2.1 (r296) — the entitlement-engine alarm. THE ODD ONE OUT: it is the only entry here
  // that changes nothing at all, so a "missed run" costs no data. What a missed run costs is the
  // DETECTION — the state it watches for went unnoticed for a day on a live tenant — which is exactly
  // why it is registered here rather than left to a crontab line nobody can see from inside the app.
  // A card reading "Never run" on /admin/scheduled-actions is the visible form of "not installed".
  'entitlement.alarm',
  'reports.employee-master.deliver',
  // WP12 (review R20) — the AI alert check (scripts/ai-alerts.ts). A DETECTOR like entitlement.alarm: it changes
  // nothing, and its standing alert pins its own exit code non-zero, so its row here is its liveness record.
  'ai.alerts',
] as const;
export type JobKey = (typeof JOB_KEYS)[number];

/** Outcome vocabulary. Stored as plain text (not a pgEnum — the 0275 widening lesson), owned here. */
export type JobOutcome = 'success' | 'partial' | 'failed';

/**
 * Static legacy descriptions; these schedule strings do not prove a schedule is installed. Current
 * scheduler state comes from runner control, and the page does not advertise these static schedules.
 * Display NAMES and DESCRIPTIONS are NOT here — they
 * live in i18n (scheduledActions.jobs.<i18nKey>.name/.description), so they are never stored in the DB
 * and never untranslated.
 *
 * `i18nKey` is the job key with the dot swapped for a dash, because a dot is a namespace separator in
 * next-intl message keys and 'leave.accrue' would resolve as a nested object rather than a leaf.
 */
export type JobDescriptor = { key: JobKey; i18nKey: string; schedule: string };

export const JOBS: readonly JobDescriptor[] = [
  {key:'replacement-holidays.reconcile',i18nKey:'replacement-holidays-reconcile',schedule:'Every minute — queued changes; daily reconciliation'},
  { key: 'leave.accrue', i18nKey: 'leave-accrue', schedule: 'Monthly — 1st at 02:00' },
  { key: 'review.sweep', i18nKey: 'review-sweep', schedule: 'Daily — 03:00' },
  { key: 'notifications.project', i18nKey: 'notifications-project', schedule: 'Installed notification runner — check runner inventory' },
  { key: 'leave.expire-carry', i18nKey: 'leave-expire-carry', schedule: 'Yearly — 1 April at 03:00' },
  { key: 'usage.capture', i18nKey: 'usage-capture', schedule: 'Daily — 01:00' },
  { key: 'anomaly.sweep', i18nKey: 'anomaly-sweep', schedule: 'Daily — 02:30' },
  { key: 'entitlement.alarm', i18nKey: 'entitlement-alarm', schedule: 'Daily — 03:30' },
  { key: 'reports.employee-master.deliver', i18nKey: 'reports-employee-master-deliver', schedule: 'Every minute — due report schedules' },
  { key: 'ai.alerts', i18nKey: 'ai-alerts', schedule: 'Hourly — at 15 minutes past' },
];

/**
 * Map a sweep's per-tenant failure counter onto the stored outcome.
 *   no tenants at all      → 'success' (nothing to do is not a failure)
 *   0 failures             → 'success'
 *   some, but not all      → 'partial'
 *   every tenant failed    → 'failed'
 * The script's PROCESS EXIT CODE is unchanged and independent of this: every sweep still ends
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
  /** Tenants the sweep actually RAN. Excludes those skipped for standing — see tenantsSkipped. */
  tenantsProcessed: number;
  tenantsFailed: number;
  /**
   * ADR-0077 slice 9 — tenants stepped over because they were not in good standing (core/sweep-scope.ts).
   *
   * NOT a failure, and deliberately not folded into tenantsProcessed: `jobOutcome` compares failures
   * against processed, so counting skips as processed would make a night where every tenant was suspended
   * look like a night where everything ran. It is stored in `result` as `skipped` rather than a column
   * because `result` is jsonb and a new column would be a migration for a counter.
   *
   * It is also the only durable record that a sweep did not run for a tenant. Reactivation is specified to
   * "replay skipped sweeps with the suspended window excluded from expiry clocks" — without this it would
   * have to infer what was missed from the gaps between run timestamps.
   */
  tenantsSkipped?: number;
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
    // Merged into the aggregate counters, and only when there were any: a `skipped: 0` on every row
    // would bury the runs that actually skipped something.
    result:
      input.tenantsSkipped != null && input.tenantsSkipped > 0
        ? { ...(input.result ?? {}), skipped: input.tenantsSkipped }
        : (input.result ?? null),
    error: input.error ?? null,
  });
}

/** A durable start is deliberately separate from legacy completion-only sweep logging. A crash leaves
 * outcome=running and duration=NULL; neither a start nor an old success proves current worker health. */
export type StartedJobRun = { id: string; jobKey: JobKey; startedAt: Date };
export async function startJobRun(db: OwnerDb, jobKey: JobKey, result: Record<string, number>): Promise<StartedJobRun> {
  const [row] = await db.insert(jobRun).values({ jobKey, outcome: 'running', result })
    .returning({ id: jobRun.id, startedAt: jobRun.ranAt });
  if (!row) throw new Error('Scheduled run start was not recorded.');
  return { ...row, jobKey };
}

/** Only the matching unfinished run may become terminal. Failure to persist evidence rejects; callers
 * using this tracked contract must exit nonzero rather than silently manufacture a healthy heartbeat. */
export async function completeJobRun(db: OwnerDb, run: StartedJobRun, input: {
  outcome: JobOutcome; tenantsProcessed: number; tenantsFailed: number;
  result: Record<string, number>; error?: string | null;
}): Promise<void> {
  const completed = await db.update(jobRun).set({
    outcome: input.outcome,
    durationMs: Math.max(0, Math.round(Date.now() - run.startedAt.getTime())),
    tenantsProcessed: input.tenantsProcessed, tenantsFailed: input.tenantsFailed,
    result: input.result, error: input.error ?? null,
  }).where(and(eq(jobRun.id, run.id), eq(jobRun.jobKey, run.jobKey), eq(jobRun.outcome, 'running')))
    .returning({ id: jobRun.id });
  if (completed.length !== 1) throw new Error('Scheduled run completion was not recorded.');
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

/** Bound each key through its existing (job_key, ran_at) index before combining history. A minute
 * worker must not displace slower jobs. All branches retain the original application-role RLS. */
export async function listRecentJobRuns(ctx: SessionContext, perJob = 10): Promise<JobRunRow[]> {
  if (!Number.isInteger(perJob) || perJob < 1 || perJob > 100) throw new Error('Invalid job history limit.');
  return withTenant(ctx, async tx => {
    const history = (key: JobKey) => tx.select().from(jobRun).where(eq(jobRun.jobKey, key))
      .orderBy(desc(jobRun.ranAt), desc(jobRun.id)).limit(perJob);
    const bounded = unionAll(history(JOB_KEYS[0]), history(JOB_KEYS[1]), ...JOB_KEYS.slice(2).map(history)).as('recent_job_runs');
    return tx.select().from(bounded).orderBy(desc(bounded.ranAt), desc(bounded.id));
  });
}
