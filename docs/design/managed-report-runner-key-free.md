# Dedicated key-free internal report tick

The normal `scripts/provision-runner.ts` remains the owner provisioning/holiday/report runner. Its
no-argument environment loading and external/default jobs are preserved, including report dispatch.
It loads the full app env file and can hold Auth keys. **No claim that normal provisioning or every
cron process is key-free is made.** The new smaller installed command is the only key-free path:

```
/opt/node20/bin/node --import tsx scripts/provision-runner.ts --installed-internal-reports-only
```

It must execute from the installed app directory with a trusted, separately curated environment.
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

The installed root launcher must start with `env -i`, source only this separately curated file with
export enabled, set the installed cwd and exec the absolute pinned Node20 runtime. It must never source
.env.production/.env.local or export the full web environment. The Node branch itself reads no env
file at all. Root file ownership/DAC/cron and actual running UID/config proof remain installation work;
validating names is not proof of who supplied environment values.

The operator must select **one report dispatch scheduling course** and avoid scheduling this dedicated
tick alongside the existing all-jobs tick's report dispatch. This change deliberately leaves default
behavior intact; preparing the file/command does not install a second cron, disable provisioning or
claim duplicate scheduling is reconciled automatically. If normal provisioning must continue on its
old schedule, its report-dispatch scheduling must be explicitly reconciled before enabling a dedicated
report cron. No automatic cron mutation or keyless claim for that normal runner is part of this patch.

## Prepared checks and limits

`test/provision-runner-internal-reports.test.ts` covers exact CLI grammar, secret/override rejection,
canonical origin/same DB/distinct app-owner roles, no env loading, report-only dispatch, pool cleanup,
pre-import validation and preserved default three-job wiring. Existing `test/operator-provision.test.ts`
remains the real owner provisioning regression consumer after dynamic import isolation.

All tests and semantic types are unrun in this source-only checkpoint. No owner credential was read,
installed config written, cron activated, DB connected or runtime invoked. Real restricted/owner DB
permissions, root-owned env/UID proof, Node20 Linux/runtime, IPC/SMTP, schedule reconciliation and actual
key absence in the installed process remain unverified.
