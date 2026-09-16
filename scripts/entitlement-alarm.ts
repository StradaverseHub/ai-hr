/**
 * READINESS 2.1 — the cron driver for the entitlement-engine alarm. The predicate, its reasoning and
 * everything it deliberately does NOT alarm on live in `core/entitlement-alarm.ts`; read that first.
 *
 *   node --env-file=.env.production --import tsx scripts/entitlement-alarm.ts
 *   node --env-file=.env.production --import tsx scripts/entitlement-alarm.ts --as-of=2026-09-12
 *
 * ── WHY A SEVENTH JOB AND NOT A CHECK FOLDED INTO AN EXISTING SWEEP ─────────────────────────────
 * The repo's own standing advice is the opposite of this, twice over — "a second cron line is a second
 * thing to forget to install" (review-sweep.ts, anomaly-sweep.ts), and r230 is the proof: the anomaly
 * sweep sat built and documented for six weeks without being installed, and review-sweep was absent
 * from this crontab for six weeks while every log looked fine. That advice was weighed and it loses
 * here, for one mechanical reason.
 *
 * THE HEARTBEAT. `deploy/cron-alert.sh` touches `heartbeat/<job>` ONLY on exit 0, and staleness of
 * that file is the ONLY signal for the "job stopped running" class — which is the exact class r230 and
 * r295 exist for. This alarm's condition is STANDING: once a tenant's tables go out of force, it is
 * still true tomorrow night and every night until a human fixes it. Fold it into `review-sweep` and
 * the first zeroed tenant pins that job's exit code non-zero indefinitely, its heartbeat never gets
 * touched again, and the hourly staleness check starts reporting "review-sweep has not succeeded" —
 * an alert about the wrong thing, on the channel that exists to catch a job that stopped running.
 * A standing alarm must not ride on the exit code of a job whose exit code is also a liveness signal.
 *
 * The secondary reasons point the same way. A configuration alarm reported as "AI HR scheduled job
 * FAILED: review-sweep" is a lie the operator learns to discount, and discounting it costs them
 * review-sweep's genuine failures too. And `anomaly-sweep` — read-only and idempotent, which is the
 * right shape — `continue`s past every tenant with no processed payroll batch, so the tenant most
 * likely to be mid-configuration is the one it would skip.
 *
 * WHAT IS DONE ABOUT THE SEVENTH-LINE RISK, rather than accepted:
 *   • it is registered in `JOB_KEYS` / `JOBS` (core/job-run.ts), so `/admin/scheduled-actions` carries
 *     a card for it that reads "Never run" until the crontab line exists. `test/job-run.test.ts`
 *     asserts that registry ABSOLUTELY, so this job could not be added without its i18n and its
 *     job_run wiring landing in the same commit;
 *   • `recordJobRun` writes a row per run, so "when did this last run" is answerable from the database
 *     and not only from a file on the box;
 *   • deploy/DEPLOY.md §5c carries the crontab line AND its heartbeat staleness line, beside the six.
 *
 * ── EXIT CODES, AND WHY THERE ARE THREE ────────────────────────────────────────────────────────
 *   0  checked every tenant in scope, nothing is dark
 *   3  checked, and at least one alarm — the wrapper alerts, and the summary's tail carries the lines
 *   2  the check could not answer for at least one tenant — a HOLE, which outranks a finding
 * `deploy/cron-alert.sh` alerts on any non-zero and puts the code in its own summary, so the operator
 * can tell "your entitlement engine is down" from "this check did not work" without opening the log.
 *
 * ── IT WRITES NOTHING EXCEPT ITS OWN RUN LOG ───────────────────────────────────────────────────
 * Every per-tenant transaction is `SET TRANSACTION READ ONLY` (see core/entitlement-alarm.ts), so the
 * server refuses a write from this path. The single INSERT this process makes is the `job_run` row
 * below, on the OWNER connection, outside every tenant transaction — the same row the other five
 * sweeps write, and the thing that makes the job visible on the Scheduled Actions screen.
 */
import { createDb } from '../db/client';
import { alarmExitCode, entitlementAlarmSweep } from '../core/entitlement-alarm';
import { recordJobRun } from '../core/job-run';
import { todayInKualaLumpur } from '../lib/hr-date';

/**
 * ⚠️ NO `process.loadEnvFile` HERE, and its absence is deliberate. `db/client.ts` reads `DATABASE_URL`
 * AT IMPORT TIME and throws when it is missing, so an env file loaded in this function would be read
 * too late to matter — `scripts/anomaly-sweep.ts` carries exactly that dead helper. The environment
 * comes from `--env-file=.env.production` on the command line, which is how the crontab invokes every
 * one of these jobs.
 */
async function main() {
  const startedAt = Date.now();
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  if (!ownerUrl) {
    console.error('entitlement:alarm requires MIGRATION_DATABASE_URL (the owner role) to enumerate tenants.');
    process.exit(2);
  }
  // MYT, not UTC — the same clock `valid_from` / `valid_to` are compared against everywhere else in
  // this product (lib/hr-date.ts). A UTC date would answer for yesterday for the eight hours between
  // UTC and MYT midnight, which is precisely when this job runs.
  const asOfArg = process.argv.find((a) => a.startsWith('--as-of='));
  const asOf = asOfArg ? asOfArg.slice('--as-of='.length) : todayInKualaLumpur();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    console.error(`entitlement:alarm — --as-of must be YYYY-MM-DD, got '${asOf}'.`);
    process.exit(2);
  }

  const owner = createDb(ownerUrl);
  const run = await entitlementAlarmSweep(owner.db, { asOf, log: (line) => console.log(line) });

  // The run log, in its OWN try/catch — a logging failure must not change what this process reports
  // about the tenants it checked.
  //
  // `tenantsFailed` is tenants the check could not EVALUATE, never tenants that alarmed: `jobOutcome`
  // turns that counter into the screen's Success/Partial/Failed badge, and a standing configuration
  // alarm is not this job failing. The finding travels as the `alarms` counter and as `error`, which
  // the screen renders in its own red panel.
  //
  // ⚠️ NOTHING TENANT-IDENTIFYING GOES IN HERE. `job_run`'s read policy is `app.is_group_admin()` with
  // no tenant dimension (0280), so any customer's group admin reads every row — naming a tenant whose
  // entitlement engine is down would disclose one customer's operational state to another.
  try {
    await recordJobRun(owner.db, {
      jobKey: 'entitlement.alarm',
      startedAt,
      tenantsProcessed: run.tenantsChecked,
      tenantsFailed: run.tenantsFailed,
      tenantsSkipped: run.tenantsSkipped,
      result: { alarms: run.alarms, tenantsAlarming: run.tenantsAlarming },
      error:
        run.alarms > 0
          ? `${run.alarms} entitlement alarm(s) across ${run.tenantsAlarming} tenant(s). ` +
            `Read the detail in the journal: journalctl -t aihr-cron -p err`
          : null,
    });
  } catch (e) {
    console.error(`entitlement:alarm — could not write the run log: ${(e as Error).message}`);
  }

  await owner.client.end();
  process.exit(alarmExitCode(run));
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
