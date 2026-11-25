# Resident scheduled jobs

`aihr-scheduled-jobs.service` runs the minute maintenance jobs in one long-running process instead of starting
`node --import tsx` every minute (ADR 0181; owner decision 25 Nov 2026, "B: app-side process").

| Job | Was | Now |
| --- | --- | --- |
| `provision`: `scripts/provision-runner.ts` (provisioning, module changes, replacement holidays, employee master reports) | crontab `* * * * *` under `flock` and `cron-alert.sh provision` | `--job provision=every-minute` |
| `notification-email`: `scripts/notification-email-sweep.ts` | `aihr-notification-email.timer` (staging: two minutes after each run, under `flock -n -E 0` and `cron-alert.sh notification-email`, `AIHR_ALERT_TAIL=0`) or a `* * * * *` crontab line | `--job notification-email=after-120s,alert-tail=0` |

Why: each cold start allocated about 0.6 GB a minute on staging and opened new direct database connections. Those
connections planned every statement cold under row security (166 ms against 8–9 ms warm) and were the main
remaining source of new database sessions (about 4 a minute).

## What stays the same

- **User, checkout, environment and login.** It is a systemd *user* unit of the deploy user that owns `/opt/ai-hr`
  and ran the crontab, started with `--env-file=.env.production` from `/opt/ai-hr`. Both jobs still use
  `MIGRATION_DATABASE_URL`, so the notification projection's SET ROLE edge (`scripts/check-notification-role.ts`)
  is unchanged. Nothing is added to any other account, environment file or privilege.
- **Once-only.** `flock` is replaced by one PostgreSQL session advisory lock per job
  (`scripts/lib/scheduled-job-lock.ts`). The cron / timer commands take the same lock, so the old and new schedules
  never run one job at the same time, in either order. A busy lock skips the run silently, as `flock -n` did.
- **Cadence.** `every-minute` starts at each wall-clock minute. A run still going at the next minute makes the
  scheduler skip to the first minute after the run ends. `after-<n>s` starts n seconds after the previous run ended,
  like the timer's `OnUnitInactiveSec`.
- **Alerting** (the `deploy/cron-alert.sh` contract, per job):
  - each run appends a dated `==== … start ====` / `exit=N` block to `~/aihr-cron-logs/<job>.log`;
  - only a successful run touches `~/aihr-cron-logs/heartbeat/<job>`;
  - a failed run sends one summary to `logger -t aihr-cron -p user.err`, to stdout and to `AIHR_ALERT_COMMAND`.
  - The crontab's heartbeat staleness lines keep working unchanged.
- **Independence.** A job that fails, hangs or throws never delays or masks another job's run, heartbeat or alert.

## What changes

- **Code is loaded once.** After a release, `deploy.sh` runs `systemctl --user try-restart aihr-scheduled-jobs`. A
  stop lets runs in flight finish for up to 60 s.
- **Connections stay open.** Expect up to 4 app-role connections, 2 owner connections per job and 1 lock
  connection, all direct and counted in `AIHR_DB_BACKGROUND_CONNECTIONS`. Their `application_name` values are
  `aihr-scheduled-provision`, `aihr-scheduled-notification-email` and `aihr-scheduled-jobs-lock`.
- **One process carries the combined limits:** `MemoryHigh=640M`, `MemoryMax=896M`, `CPUQuota=50%`, `Nice=10`.
  Before, the provision runner ran uncapped and the notification sweep was capped at 768M and 35% CPU.
- **Logs.** Scheduler lines (started, skipped, lock lost, stopping) go to `journalctl --user -u aihr-scheduled-jobs`.
  Job output goes to the same log files as before.

## Install (administrator, release window, staging lease)

Run as the deploy user, from `/opt/ai-hr`, after deploying a release that contains this directory:

```bash
sudo loginctl enable-linger ubuntu       # once, if `loginctl show-user ubuntu -p Linger` is not yes
sudo -iu ubuntu
cd /opt/ai-hr
deploy/scheduled-jobs/install.sh check   # read-only: unit state, timer state, crontab lines it would comment out
deploy/scheduled-jobs/install.sh install
```

`install` performs these steps in order:

1. Backs up the crontab.
2. Installs and starts the unit, and refuses before touching any schedule if it does not start.
3. Comments out (never deletes) the active `provision-runner.ts` and `notification-email-sweep.ts` crontab lines,
   prefixed `# MOVED to aihr-scheduled-jobs.service:`. The separate `--installed-internal-reports-only` capability
   stays.
4. Disables `aihr-notification-email.timer` if it is enabled.
5. Reads the crontab back.

Then verify the outcome, not the command:

```bash
crontab -l | grep -E 'provision-runner|notification-email-sweep'   # only lines carrying the MOVED marker
systemctl --user is-active aihr-scheduled-jobs
tail -n 20 ~/aihr-cron-logs/provision.log ~/aihr-cron-logs/notification-email.log
ls -l --time-style=+%T ~/aihr-cron-logs/heartbeat/                  # provision and notification-email fresh
```

Rollback restores the exact previous schedules:

```bash
deploy/scheduled-jobs/install.sh rollback
```

It stops and disables the service, uncomments the marked lines and re-enables the timer if `install` disabled it.

## Not covered

- The optional installed report-dispatch handoff (`deploy/identity-email/report-scheduling.ts`) inventories the
  legacy provisioning crontab line. Update it before using it on an installation that runs this service.
- The marker pins `scripts/provision-runner.ts` by hash. Any change to that file, this one included, needs a new
  marker before the default report stage runs again; until then it refuses (fail-closed).
- `payroll-loop-tick` (every 15 minutes) and the nightly sweeps stay on cron.
