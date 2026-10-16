# Dedicated key-free internal report tick

The normal `scripts/provision-runner.ts` remains the owner provisioning/holiday/report runner. Its
no-argument environment loading and external/default jobs are preserved, including report dispatch.
It loads the full app env file and can hold Auth keys. **No claim that normal provisioning or every
cron process is key-free is made.** The new smaller installed command is the only key-free path:

```
/usr/local/lib/aihr-identity-email/internal-node --import tsx scripts/provision-runner.ts --installed-internal-reports-only
```

The installed `internal-node` must point to the operator-reviewed compatible Node22.13+ or Node24
runtime required by the transport installation. Production Node20 has a known compatibility gap and
does not satisfy this prerequisite. The path alone is not runtime acceptance evidence. The command
must execute from the installed app directory with a trusted, separately curated environment.
There is no `SKIP_ENV` environment toggle, caller file path, generic bypass or additional owner grant.
Only the exact CLI flag is accepted; unknown/combined arguments refuse. Before importing any app
runtime, this branch validates a closed environment and never calls any env-file loader. It runs only
canonical `sweepEmployeeMasterReports` using the existing injected owner DB; no provisioning, invitation
reissue, holiday sweep, web session, SMTP transport or Auth decrypt owner is invoked by this branch.
Both its owner pool and app singleton close, including when work/owner shutdown fails. Installed
command failures log only a fixed sentence, preserving default-path diagnostics without reflecting
owner URL, SQL or private environment values.

## Installer/operator interface

Transport installer may prepare, but **must not activate cron**. The operator/root-owned scheduling
configuration is separate `/etc/aihr-internal-report/runner.env`, mode0600, containing only:

- `AUTH_PROVIDER=internal` and exact canonical HTTPS `AUTH_PUBLIC_ORIGIN` from actual installed web
  configuration. Canonical here means origin only, with no trailing slash/path/query/credentials.
- `DATABASE_URL`: actual unprivileged ai_hr_app connection.
- `MIGRATION_DATABASE_URL`: separately supplied, explicitly authorized existing canonical deployment
  owner connection. The installer cannot manufacture/derive an owner credential from the web app env.
  App and owner URLs must select the same host/port/database with distinct roles. Remote connections
  require verify-full TLS; role/connection override options refuse.
- Selected runtime-only `NODE_ENV`, `TZ`, `HOME`, `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TMPDIR` and
  harmless shell bookkeeping `PWD`, `SHLVL`, `_` where needed.

Every other variable refuses before application imports. In particular AUTH_SESSION_KEY, provider
secrets, NODE_OPTIONS and caller-selected socket overrides are forbidden, even when empty. This does
not remove the privileged owner DB trust: this job is key-free, **not** an unprivileged report reader.
The same canonical owner authority as the existing report queue/sweep remains required.

The root-owned launcher parses only this generated, closed environment format as data: it never
sources shell text. It verifies the active marker and the existing provisioning cron owner's exact
name/UID/base GID, clears supplementary groups, drops GID then UID, and execs the separate reviewed
Node runtime from `/opt/ai-hr`. No web-owned application TypeScript executes as root. A root-owned
nonblocking lock descriptor survives exec to bound overlapping report ticks; real Linux inheritance
still needs measurement. Owner URLs travel only in the selected environment, never argv or logs.

The new [scheduling handoff](managed-report-scheduling-handoff.md) supplies source for the missing
suppression/activation course. An absent marker preserves the old report stage. A trusted paused or
active marker suppresses only that stage, after provisioning and holiday work; a bad marker refuses
report dispatch without restoring a fallback. Dedicated admission requires the active marker before
any application import. The base transport installer still activates no cron. A separate explicit
root scheduling command must prove the deployed guard, review all scheduler inventory, pause and drain
old processes before installing its exact owned cron file. User crontab bytes and Node20 remain unchanged.
The full provisioning process still loads Auth keys for its other jobs: only the dedicated report
process is key-free. Scheduling implementation is source-only, not installed acceptance evidence.

## Prepared checks and limits

`test/provision-runner-internal-reports.test.ts` covers exact CLI grammar, secret/override rejection,
canonical origin/same DB/distinct app-owner roles, no env loading, report-only dispatch, pool cleanup,
pre-import validation and preserved default three-job wiring. Existing `test/operator-provision.test.ts`
remains the real owner provisioning regression consumer after dynamic import isolation.

All tests and semantic types are unrun in this source-only checkpoint. No owner credential was read,
installed config written, cron activated, DB connected or runtime invoked. Real restricted/owner DB
permissions, root-owned env/UID proof, reviewed compatible Node Linux/runtime, IPC/SMTP, actual
scheduling handoff/rollback and key absence in the installed process remain unverified.
