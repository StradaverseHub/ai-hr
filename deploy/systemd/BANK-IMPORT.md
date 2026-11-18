# Bank & Statutory background imports

The web process admits files in 1 MiB requests and returns immediately after upload/confirmation.
`scripts/bank-import-runner.ts` processes durable jobs independently of the browser and Cloudflare's
response deadline. The current source contract is 250,000 data rows, 128 MiB original/decoded CSV,
32 worksheets and 20 million worksheet cells. Other importers keep their existing limits.

Install only with the verified candidate's migration and release procedure. Production still needs
its separately authorized installation; this document and the service template do not deploy it.

1. Freeze and reconcile the new migration allocation with the latest main/alpha journal and the target
   watermark. Preserve all applied SQL bytes. Rehearse the populated upgrade, permissions and job recovery.
2. Let any legacy synchronous Bank & Statutory requests finish before cutover. They have no job reservation
   and must not overlap submissions to the new worker. Check the original append-only import history;
   do not cancel a live database transaction or assume a browser timeout rolled it back.
3. Provision a dedicated `aihr-import` OS account and a root-owned, protected `/etc/aihr/import-worker.env`.
   It contains the approved app-role `DATABASE_URL` and the queue physical owner's
   `MIGRATION_DATABASE_URL`, including this installation's TLS options, plus the web process's exact
   `MOVEMENT_IMPORT_WORKBOOK_KEY` and `MOVEMENT_IMPORT_WORKBOOK_KEY_ID` (the worker checks uploaded
   Movement workbooks; without them every Movement Excel check fails with "Workbook signing is not
   configured", and different values reject every downloaded template). Keep owner credentials out of
   the web service. The worker uses the owner connection only for queue discovery, coordination and
   terminal operational failure; canonical HR changes always use the app-role connection and the
   submitting actor's database-captured grants, checked against current access on every transaction.
4. Verify the immutable release path, Node binary and dependency availability (including `tsx`). Adjust
   the trusted installer's fixed `WorkingDirectory`/`ExecStart` to that exact installation. Produce
   `worker-package-v1` through the separate `bank-import-worker-package` GitHub workflow at the same
   exact source as the passing full application gate. Authenticate its first-attempt successful run,
   job, repository, workflow and artifact API SHA256 before inspecting its three closed members:
   `worker-package.zip`, `worker-manifest.json` and `worker-provenance.json`. Verify the package/lock
   identities, committed source hashes and closed Linux dependency tree. This package supplies bytes;
   it never replaces the application gate or authorizes a deployment.
   The administrator installer must receive independently pinned archive, private-environment and
   reviewed-helper hashes. It must validate protected root-owned inputs and Node ancestors, extract
   verified bytes into an empty protected release directory, and generate its service definition from
   trusted instructions. Never run a service template or executable copied from web-writable state
   as root. The web identity must not be able to edit the worker's code or credentials. Install and
   start `aihr-bank-import.service` after the migration and web candidate are installed. Include this
   worker in future release restarts; an installer limited to first installation must refuse updates.
5. Check queue arrival, the worker's service health and a real authorized upload → preview → explicit
   confirmation → paginated progress → immutable history journey. Verify another admin cannot read
   the job and cannot submit the same exact file while its job is active. Rehearse a worker restart and
   prove saved rows and progress stay aligned. Check configured memory/disk capacity with real workbooks.

Progress is durable in `bank_import_job`/`bank_import_row`. A PostgreSQL session advisory lock admits one
worker at a time; process death releases it. Upload parts are idempotent. A partial upload resumes by
selecting the same file again. The active-file unique index is tenant-wide and includes previews awaiting
confirmation. The creator may cancel an upload or a ready preview. It does not expire a running job and
therefore cannot silently admit duplicate work when processing is slow.

Each row's HR mutation, immutable before/after item and mutable completion marker commit in one app-role
transaction. A crash before commit rolls all three back; after commit the restart skips the marker.
A completed exact file can be submitted intentionally again; unchanged rows are skipped. SHA256 compares
original file bytes, so a workbook re-saved with different ZIP bytes is a distinct file.

Permission removal stops the job without undoing earlier committed rows. Row failures are shown on its
progress page; the shared attempt retains the original source and successful field-level changes.
The worker's owner-only failure path records an operational failure, never fabricates an authorized HR
change. A stale heartbeat means waiting/stopped work, not permission to resubmit. Diagnose the worker,
credential or access failure before starting another job. Current UI error text explicitly states that
previously saved rows remain saved.

The large capacity regression validates 100,001 distinct employee rows, skips unchanged records, and
saves changed records at the first, middle and last positions. It verifies admission, pagination, batch
checkpoints and canonical writes; it is not a production throughput benchmark of 100,001 changed rows.

Job inputs/previews are personal data retained for audit/recovery. Source upload chunks are deleted on
cancel or successful completion; the confirmed attempt retains the original source under the existing
Import History policy. No automated job/preview erasure policy is introduced by this release.

For the combined staging release, migration `0685_bank_import_jobs.sql` is an unapplied draft until the
release owner appends its agreed index/timestamp after the exact predecessor source prefix. This
component branch deliberately carries no replacement journal entry. Its earlier focused CI results
remain evidence for their original commits; the integrated candidate requires a fresh complete gate.

A failed or absent worker is a release blocker even if the web build is healthy. Keep queued jobs and
uploaded chunks intact while repairing its service or credentials. Do not fall back to the legacy
synchronous import while new jobs can still write: legacy requests do not honor the active-file
reservation. Before any web rollback, prevent new Bank submissions and account for every active job;
retain its matching worker release, source, private configuration and database backup. There is no
automatic schema rollback. A worker-only restart uses the same durable checkpoints and may safely
resume after an interrupted row transaction rolls back.

## Payroll Individual Transaction queue

The same protected worker also handles Individual Transaction workbooks after migration
2460. It validates the original workbook independently of the browser and waits for the
uploader to confirm the stored preview. The original file stays in the tenant database
under the same company scope as the batch. Payroll writes and the immutable import
results commit together. A restart replays the interrupted phase, and an attempt whose
writes already committed supplies its recorded outcomes without repeating them.
Include both import paths in staging worker acceptance.

## Shared bulk-job kernel

The same protected worker also runs every kind on the shared bulk-job kernel (migration 5011,
`core/bulk-job-handlers.ts`), starting with the staged employee import (EMPLOYEE-IMPORT.md). Each loop
iteration runs one Bank tick, one Individual Transaction tick and one bounded bulk-job unit. The worker records a
heartbeat with the kinds it serves; `scripts/check-import-worker.ts` (run by `deploy/deploy.sh`) reports a kind
without a live worker. Include the employee import journey in staging worker acceptance.
Section and register imports (kinds `section_import` and `register_import`, draft migration 5060) run on the same
worker; include a Profile file and a Qualification file in staging worker acceptance.

The leave family runs on the same worker (draft 5030, docs/adr/2026-11-10-leave-family-bulk-jobs.md): leave ledger
import (`leave_ledger`), Generate Entitlement (`leave_generation`) and Run Earned Accrual (`leave_accrual`). The
monthly accrual and yearly carry-expiry timers keep their own units and now write in short per-batch transactions.

## Stall watchdog

On 13 Nov 2026 the staging worker stayed `active` under systemd with the same PID while its heartbeat stopped and
no job moved for about 50 minutes; it logged nothing. One call in the loop never returned, most likely a database
call on a connection that no longer answered. The worker now watches its own loop
(`lib/import-worker-watchdog.ts`). It records which phase it is in (`bank`, `individual`, `bulk`, `pause`, and
`stop` while shutting down) and when that phase started. Every 30 s it checks the phase. When one phase has
lasted longer than the limit, it writes one line to stderr and exits with status 70:

    Import worker stalled in bulk for 1830 s; exiting so systemd restarts it.

`Restart=on-failure` (with `RestartSec=5`) then starts a new process, so the unit file is unchanged. The phase
names the tick that stalled: `bank` (Bank & Statutory queue), `individual` (Individual Transaction queue), `bulk`
(one bulk-job unit, including the claim and heartbeat) or `pause` (the idle wait, which cannot stall on the
database). One stall line is an incident to investigate, not a routine event. Check the database and network at
that time, and look for repeated lines. Repeated lines for the same phase and job mean a unit that keeps hanging.
If a legitimate unit is longer than the limit, raise the limit. Do not resubmit work.

At start the worker logs its limit, so the journal shows the setting in force:

    Import worker started (pid 12345); stall watchdog 1800 s (AIHR_IMPORT_WORKER_STALL_SECONDS).

`AIHR_IMPORT_WORKER_STALL_SECONDS` in `/etc/aihr/import-worker.env` sets the limit: a whole number of seconds from
1200 to 21600 (default 1800). Any other value refuses to start before the worker connects, and the journal names the
setting and its range. Raise the limit only after measuring a legitimate phase on the target that runs longer.

The default and the minimum come from a measurement on 14 Nov 2026 (branch `claude/worker-stall-measure-20261114`,
`alpha-focused-checks` runs 43569779572, 43571207900, 43569777102, 43571538877, 43569782311, 43570418529,
43573247694 and 43573249829, on 4-vCPU GitHub runners with PostgreSQL on the same machine). Each figure is one call of
the worker's tick, the unit one phase covers:

| Phase | Input | Runner | Staging estimate (x3) |
| --- | --- | --- | --- |
| `bank`, first tick of an Excel workbook (decode and store every row in one transaction) | 250,000 rows, every template column, 29.7 MiB file | 228 s and 339 s (decode 217 s and 332 s) before the bounded-memory decoder; 24.1 s (decode 14.9 s) after | about 1,020 s before; about 75 s after |
| `bank`, first tick of a CSV file | 250,000 rows, every template column, 118.6 MiB | 218 s and 302 s (decode 291 s of the 302 s) before; 16.9 s (decode 3.1 s, insert 13.2 s) after | about 905 s before; about 50 s after |
| `bank`, one validation tick | 1,000 rows, every template column, tenant of 2,001 employees | about 18 s (from 20-row probes of 0.36 s) | about 55 s |
| `bank`, one validation tick | 100 rows, every template column, tenant of 250,001 employees | 78.5 s and 79.4 s before the residency fix; 0.98 s and 0.92 s after (1,000 rows: 6.05 s and 5.86 s, see below) | about 240 s before; about 3 s after (1,000 rows: about 18 s) |
| `bank`, one import tick | 100 changed rows, tenant of 250,001 employees | 19.4 s and 19.6 s | about 60 s |
| `individual`, validation | 2,000 rows | 0.35 s and 0.30 s | under 5 s |
| `individual`, confirmation (one transaction) | 2,000 rows for 200 employees | 58.0 s and 42.3 s | about 175 s |
| `bulk`, one prepare | not measured; bounded by its 900 s lease | | 900 s |

Staging has 2 vCPUs and runs PostgreSQL, PgBouncer and the web service on the same host, so the runner figures are
multiplied by 3. The slowest runner figure (339 s on an AMD EPYC 7763) gives about 1,020 s. A 1200 s limit left
less than 20% margin above that, and the old 960 s minimum was below it, so the default is 1800 s and the minimum
1200 s. The minimum also stays above the 900 s bulk-job prepare lease, the longest unit the kernel allows (every
other bulk unit holds a 60 s lease). The limits were set from the slower decoder and are kept: the first tick is now
far below them (see the decode memory section below).

### Decode memory of the first Bank tick

The first ('queued') tick decodes the whole upload and stores its rows in one transaction, 1,000 rows per insert.
Until 14 Nov 2026 it held every stage of a maximum file at once: the stored parts and a concatenated copy, a `File`
copy, the whole CSV text, fields grown one character at a time, an array of every row and an array of every record;
for Excel also the full SheetJS workbook (with formatted and HTML text for every cell), a whole-sheet array, its CSV
text and a second parse of that text. A maximum file could need about 4 GB, more than the 3.9 GB staging host, and an
out-of-memory kill would restart the worker into the same tick.

`lib/bank-import-stream-source.server.ts` now decodes for the worker. It produces the same records, ordinals,
duplicate errors and refusals as `decodeBankImportSource` (unchanged; `test/bank-import-stream-source.test.ts`
compares the two, and at the maximum size both produced the identical 395,703,371-byte insert payload): a CSV is
decoded and parsed part by part, each stored part released once read; a workbook still goes through SheetJS, with
dense cells and without the presentation-only text, read in 5,000-row windows; rows wait for the insert as compact
1,000-row JSON batches. The transaction, its inserts and the job states are unchanged.

Measured on 14 Nov 2026 in a fresh process per decode (branch `claude/bank-import-memory-measure-20261114`, never
merged; `alpha-focused-checks` runs 43594676216 before and 43594671099 after, 4-vCPU runners), decode plus the insert
payloads, 250,000 rows with every template column:

| File | Before: peak RSS, time | After: peak RSS, time |
| --- | --- | --- |
| CSV, 118.6 MiB | 3,645 MiB, 184 s | 858 MiB, 4.6 s |
| Excel, 29.7 MiB (7.5 million cells) | 4,210 MiB, 208 s | 1,958 MiB, 24 s |

A maximum CSV now fits comfortably. A maximum workbook still needs about 2 GB, almost all of it inside SheetJS's
whole-workbook read (the inflated 254 MiB sheet XML and 108 MiB shared-string XML as strings, plus one object per
cell). That is still about half of the staging host: keep the worker's memory in mind when PostgreSQL and the web
service are busy, and prefer CSV for files near the limit. Removing it needs a streaming sheet reader (a follow-up).

Fixed on 14 Nov 2026: a residency file no longer outgrows the limit. Before the fix, every row that named a residency
column (`tax_residency`, `is_resident`, `tax_circumstance`, `tax_category` or `epf_citizenship`) read the employee's
tax selection one at a time during validation, about 0.8 s per row in a tenant of 250,001 employees (15 ms at 2,001),
so one 1,000-row validation tick took about 790 s on a runner and about 2,400 s on staging. The cost came from the
employment row policy: without the transaction-local point-read marker each statement that reads `employment`
(directly or through the statutory and tax-selection policies) rebuilds the tenant's whole visible-employment set,
about 0.34 s at 250,001 employees, and the per-row read ran two or more such statements per row. Validation now reads
residency for each slice of up to 1,000 subjects in one set-wise read through the pack's borrowed
`getTaxSelections` (the read the Personnel export uses), so that cost is paid a fixed number of times per tick, not
per row (`readTaxResidenciesTx` in `core/bank-statutory-import.ts`; `test/bank-residency-batch.test.ts` proves the
same answers as the per-row read and a fixed statement count). Re-measured on branch
`claude/bank-residency-measure-20261114`, `alpha-focused-checks` runs 43593293114 and 43593396202 (4-vCPU runners),
in a tenant of 250,001 employees with every template column:

| Validation tick | Before | After (two runs) | Staging estimate (x3) |
| --- | --- | --- | --- |
| 100 rows | 78.5 s and 79.4 s | 0.98 s and 0.92 s | about 3 s |
| 1,000 rows | about 790 s (estimated from 20-row probes) | 6.05 s and 5.86 s | about 18 s |

The residency read itself fell from 16.8 s and 15.5 s for 20 rows one at a time to 0.47 s and 0.44 s for 1,000
rows at once. The import tick (100 changed rows, one transaction each) is unchanged at about 19 s.

The exit itself is the whole recovery. The watchdog writes nothing and does no clean-up, because the stalled call
may hold the only queue-owner connection. When the process exits, PostgreSQL rolls back each open transaction. A
chunk's writes and its applied markers commit together, so an interrupted chunk leaves nothing behind. Bank and
Individual rows keep their own committed checkpoints, and their session advisory locks end with the session. A
bulk job keeps the dead worker's lease until the lease expires (at most 60 s, or 15 min during prepare). The new
process cannot claim the job before then, and afterwards it claims the job with a new lease and capability and
resumes it from its committed steps.
`test/import-worker-watchdog-db.test.ts` proves this against a real database. Because the worker exits rather
than waiting, its heartbeat row stays behind until it goes stale, and the new process records its own.

If the database server never sees the old connection close (for example when the network path itself failed),
the old backend, together with any Bank or Individual advisory lock it holds, lasts until the server's TCP
keepalive ends it. The server's own default is far too slow for this: staging's PostgreSQL 16 measured
`tcp_keepalives_idle` 7200 s and `client_connection_check_interval` 0, which would have blocked those two queues
for more than two hours. Every connection of a worker-role process (`AIHR_DB_PROCESS_ROLE=worker`: the queue-owner
connection and the HR-transaction pool) therefore sets its own session values at startup
(`db/worker-connection.ts`), with no change to the database server:

| Setting | Value | Effect |
| --- | --- | --- |
| `tcp_keepalives_idle`, `_interval`, `_count` | 60 s, 15 s, 8 | an idle backend whose client vanished closes about 3 min later |
| `tcp_user_timeout` | 180000 ms | the same bound while the backend is sending to a client that no longer acknowledges |
| `client_connection_check_interval` | 10000 ms | a running statement is cancelled within 10 s once its client is known to be gone |

Keepalive probes run only on an idle connection, and the connection check ends a statement only when its client
has gone, so neither shortens a legitimate long statement. All five settings may be set by a role that is not a
superuser, so the restricted `ai_hr_owner` and `ai_hr_app` apply them. A server that refused one would fail the
worker's connection at start with the error in the journal, instead of running without it.
`test/worker-connection-db.test.ts` checks every worker connection against a real database.
On the client side the worker keeps TCP keepalive on with a 60 s idle time (the operating system's probe interval and count
apply, about 12 min on Linux), and the stall watchdog stays the backstop for a call that never returns.
So a half-open owner session now ends, and its locks with it, about 3 min after the network failed, usually
before the watchdog has restarted the worker. The web keeps the server defaults; it may connect through PgBouncer,
which refuses startup parameters it does not know.

If the two queues still wait after a restart, use `ps` and `pg_locks` on the database host (rule 12 of
docs/SCALE-AND-RELEASE-RULES.md) to find the old backend. Over a Unix-domain socket PostgreSQL ignores the TCP
settings (`SHOW tcp_keepalives_idle` reads 0); such a connection is local, so the server sees a dead process at
once.

## Protected staging update after first installation

`bank_import_worker_upgrade_v1.py` is a staging-only two-step update, separate from
first-install v2. It reuses the reviewed closed worker format and fixed service
configuration. The exact source's successful application witness and authenticated
`worker-package-v1` artifact are prerequisites; worker bytes alone grant no release
authority. Production is not supported or authorized by this helper.

1. Retain the shared staging lease across worker drain, web installation, activation,
   health and rendered acceptance. Independently pin the installed worker source,
   its first-install receipt, unit hash and selected environment hash. Pin the new
   archive SHA256 and package/lock hashes from authenticated GitHub artifact metadata
   and provenance, plus old/new web sources and build IDs.
2. Assemble a self-contained helper with
   `python3 scripts/bank-import-worker-upgrade-bundle.py /PRIVATE/NEW-helper.py`.
   Review and hash-pin those bytes independently, copy to a new root-protected path,
   verify that hash there, and invoke with `python3 -I -B`. Never import root-executed
   code from the web-writable checkout or use the first-install helper for updates.
3. `drain` requires the exact healthy previous web source/build. It verifies the
   live `aihr` service and bounded loopback `/health` database probe, bracketed by
   unchanged deployment records, both before preparation and immediately before
   signalling. It snapshots and
   authenticates the new package before signalling the managed worker's main process
   with SIGTERM. The existing runner finishes its current Bank and Individual import
   tick and exits normally. A 330-second observation deadline **never escalates to
   SIGKILL**, invokes systemd's timed stop, disables the unit, kills a DB session or
   replays a job. A crash/restart/PID change refuses the update. Queued uploads and
   saved row/audit checkpoints remain durable. If drain is uncertain, diagnose the
   retained process/unit before any source installation; do not assume it stopped.
4. Install the exact verified web source/build through the normal guarded operator
   route. `activate` requires that exact successful arrival, the matching protected
   drain record and unchanged old unit/environment. It re-extracts authenticated
   bytes into a new immutable release, replaces only the fixed unit atomically,
   reloads systemd and starts the new worker. Three stable live PID/source/command/
   identity/environment observations are required before its installation receipt.
5. Verify both actual import journeys and permissions, exact worker/web identity,
   durable progress/history and restart behavior before declaring the combined release arrived.
   The receipt intentionally keeps `journeyVerified:false`: it is process evidence,
   not human staging acceptance or rendered journey proof.

The helper takes `drain|activate` (or `adopt-stopped`, below) plus `--previous-web-source`, `--previous-web-build`,
`--previous-worker-source`,
`--source`, `--build-id`, `--archive`, `--archive-sha256`, `--lock-sha256`,
`--package-sha256`, `--unit-sha256` and `--worker-env-sha256`. All values must come
from independently verified release evidence, never a web request. It preserves
prior code, unit identity evidence, packages, private configuration, DB contents and
operation records; it does no automatic schema or worker rollback. Existing attempts,
partial activation or failed web installation require explicit diagnosis/recovery.
Do not remove an attempt to bypass a refusal. An absent/unhealthy matching worker
continues to block release even if web health passes.

The previously installed web and worker may come from different releases. Verify
each independently: the previous web source/build must match deployment state;
the previous worker source must match its protected release receipt, unit and live
process. The protected drain record binds both identities and the new source/build.
Activation refuses any change to that record or the installed worker environment;
it never assumes the worker was upgraded merely because the web source advanced.

A failure after unit replacement enters a protected recovery state. The helper
quarantines only its exact candidate unit with `Restart=no` and `SendSIGKILL=no`,
reloads and verifies those protections, disables automatic boot activation, then
requests a bounded graceful stop. It retains source packages, data and credentials;
it does not restore the old worker. Failure records and observations remain under
`/opt/aihr-import/upgrades/<source>/`. If the unit changed, reload/protection fails,
or process exit is unconfirmed, it reports uncertainty and requires administrator
recovery; it never claims a completed stop or accepted release. An incomplete
activation cannot be retried by deleting records or overwriting an immutable path.

### A reviewed key added after the last activation (`--previous-worker-env-sha256`)

`--worker-env-sha256` is always the root-read sha256 of the current `/etc/aihr/import-worker.env`. Normally the
previous release's `worker-install-v2.json` records the same value as `selectedEnvironmentSha256`, and the helper
refuses with "prior managed installation receipt differs" when it does not. If an operator added a reviewed key
(one in `installer_v2` `ENV_KEYS`, for example `MOVEMENT_IMPORT_WORKBOOK_KEY` and `MOVEMENT_IMPORT_WORKBOOK_KEY_ID`)
after that activation, pass the receipt's value as `--previous-worker-env-sha256 <64 hex>` to `drain` and `activate`
(staging) or `production-drain`, `production-activate` and `production-rollback`. Read it from the receipt on the
host. Never pass a digest you have not read there. Omitted, nothing changes. Given, the receipt must record exactly that
value, the current file must still equal `--worker-env-sha256`, and the two must differ. The current file must also
pass the closed environment checks: the installer's one `KEY=<JSON string>` line per key, reviewed keys, approved
database roles and root-protected TLS files on staging, and the `production-first-install` checks on production.
The drain record binds the argument. Activation and rollback refuse a different value or a missing one. The new
receipt records the current environment, so the next update needs no `--previous-worker-env-sha256`. The helper still compares a
running worker's live environment with the current file, so a worker started before the edit refuses ("live worker
environment differs") and needs separate operator review; the helper never restarts it. `adopt-stopped` does not
accept the argument.

### Adopting a cleanly stopped worker without a managed receipt (`adopt-stopped`)

Use `adopt-stopped` only on staging, and only when the installed worker came from a procedure before
`installer_v2`/`upgrade_v1`, so its release has no `worker-install-v2.json`, and it is already cleanly stopped.
In that state `drain` cannot run, because nothing is running to drain. It also cannot validate the unit, because
that unit predates the current template. `adopt-stopped` replaces `drain` plus `activate` for this one case.
The web must already run the new exact source/build. Hold the shared staging lease throughout.

As root, read the prior unit and the protected environment and independently record both sha256 values
(`sha256sum /etc/systemd/system/aihr-bank-import.service /etc/aihr/import-worker.env`). Also record the
unit's `WorkingDirectory` source. Pin the package exactly as for `activate`, then build, hash-pin and copy the
bundle as in step 2 above.

```bash
python3 -I -B /ROOT-PROTECTED/helper.py adopt-stopped \
  --previous-worker-source <WorkingDirectory source> --source <new source> --build-id <new web build> \
  --archive /ROOT-PROTECTED/worker-package.zip --archive-sha256 <zip> --lock-sha256 <lock> --package-sha256 <package> \
  --observed-unit-sha256 <root-read unit sha256> --worker-env-sha256 <root-read env sha256>
```

The mode does not accept `--previous-web-source`, `--previous-web-build` or `--unit-sha256`, and `drain`/`activate`
do not accept `--observed-unit-sha256`. It refuses, before writing anything, when:
- the current web is not the exact healthy source/build (the same `aihr` service, loopback `/health` and
  unchanged-deployment-record check as `activate`);
- the unit or environment bytes differ from the two pins;
- the prior release already has a managed receipt (use `drain`/`activate` instead);
- the loaded unit differs from the installation: user/group `aihr-import`, the prior `WorkingDirectory`, the
  fixed unit and environment paths, no drop-in or override, `Restart=on-failure`, enabled, no pending reload;
- the worker identity is missing;
- the unit is not `inactive`/`dead` with `MainPID=0`, `Result=success` and `ExecMainStatus=0` (so an active,
  activating, failed or non-zero exit refuses);
- systemd still tracks a control group, or any live process runs as `aihr-import` or inside the unit's cgroup;
- an attempt for this source already exists under `/opt/aihr-import/upgrades/`.

After those checks it creates `/opt/aihr-import/upgrades/<source>/`. There it keeps the exact prior unit bytes
(`prior-unit.service`) and the recorded stopped observation (`stopped-prior.json`). It then authenticates the
archive, extracts it into the new immutable release, and re-checks the web. Immediately before replacing the
unit, it re-verifies both pins and the full stopped observation. From that point it is identical to `activate`:
the current template, atomic replacement, `daemon-reload`, start, three stable live observations and a fresh
`worker-install-v2.json`. That receipt carries `mode: adopt-stopped`, `previousUnitSha256` and the observation
digest, and a later managed `drain` can validate it. A failure after replacement enters the same protected
quarantine. The mode never signals, kills, restores or deletes the prior worker, its release or any record.

### Hung worker during a web release

With `AIHR_IMPORT_WORKER_REQUIRED=1` (staging), `deploy/deploy.sh` ends with `scripts/check-import-worker.ts` and fails
the deploy if any bulk-job kind has no live heartbeat (one within 90 s, waiting up to `AIHR_IMPORT_WORKER_WAIT_SECONDS`,
default 45 s). The CI web build has already been activated and the service restarted by then. The drain → web →
activate order above does not help, because `drain` and the upgrade helper need a successful web deploy record.

A hung worker usually recovers by itself: the [stall watchdog](#stall-watchdog) exits it once one phase has lasted
longer than `AIHR_IMPORT_WORKER_STALL_SECONDS` (default 1800 s) and systemd starts a new process, which records a
fresh heartbeat. Until that happens, the heartbeat is stale and the deploy's worker check fails. The steps below
cover that window, and a worker that keeps hanging after each restart.

- **Before the web deploy:** run the check with the pinned runtime:
  `cd /opt/ai-hr && /opt/node22/bin/node --env-file=.env.production --import tsx scripts/check-import-worker.ts`.
  If the managed worker is running but its heartbeat is stale, look in the journal for a stall line or for the
  watchdog's start line. Wait for the watchdog to restart it, or restart that existing unit yourself
  (`sudo systemctl restart aihr-bank-import`) under the held lease. On staging the deploy user's passwordless sudo
  covers only `systemctl restart aihr`, so a person with the sudo password runs this in their own terminal
  (`ssh -t -F /PRIVATE/ssh_config aihr-staging 'sudo systemctl restart aihr-bank-import'`; done this way on
  13 November 2026). Repeat the check before deploying.
  A restart keeps the unit, release and receipts unchanged. It is not a worker upgrade.
- **If the deploy already failed at that check** (deploy record `failed` at phase `ci-build-health`, log ending in
  `Import worker check failed`): wait until the check passes again (the watchdog restart, or the restart above),
  then complete the web arrival with `operator-release.mjs verify-resume-arrival` and `resume-arrival`
  ([policy](../../docs/CI-STAGING-VERIFICATION-POLICY.md#resume-after-activation--aihr-resume-arrivalv1)). Do not
  hand-write `deploy-state.sh finish`. Run the worker upgrade helper only after that arrival.
- If the new release adds a bulk-job kind the old worker cannot serve, neither the watchdog nor a restart can pass
  the check. That is a worker upgrade, not a hung worker. Plan the drain/activate sequence before the web deploy
  instead.

## Production first activation (`production-first-install`)

`bank_import_worker_production_v1.py` is the reviewed route for the first worker activation on the customer
production layout (production runbook section 6). It exists because the first-install v2 helper refuses that layout
(the worker identity and environment already exist, there are no staging deployment receipts and the database is
remote) and the staging update helper needs an existing unit. **Production installation still needs the owner's
separate, explicit go-ahead.** The helper, its tests and its bundle grant no release or production authority.

It expects the customer layout: the web is `aihr.service` running as `aihr` from `/opt/ai-hr`, with its environment
in `/etc/aihr/runtime.env`; the worker reads the existing `/etc/aihr/import-worker.env` and runs on
`/opt/node22/bin/node` (v22.23.3, as the worker package requires). The unit is the same fixed template as v2:
`User=aihr-import`, `WorkingDirectory=/opt/aihr-import/releases/<source>`, `AIHR_DB_PROCESS_ROLE=worker`,
`AIHR_DB_POOL_MAX=2` and `EnvironmentFile=/etc/aihr/import-worker.env`. Its receipt has the same fields that a later
managed `drain` checks.

Build the helper from the reviewed commit, hash-pin it, copy it to a new root-protected path, check the hash there
and run it with `python3 -I -B`:

```bash
python3 -I -B scripts/bank-import-worker-production-bundle.py /PRIVATE/production-helper.py   # prints helperSha256
sudo python3 -I -B /ROOT-PROTECTED/production-helper.py production-first-install \
  --source <RELEASE_SHA> --build-id <STAGING_BUILD_ID> --web-port <PORT from runtime.env> \
  --release-manifest /var/tmp/aihr-release-<PROD_TAG>/release-manifest.json --release-manifest-sha256 <from SHA256SUMS> \
  --archive /var/tmp/aihr-release-<PROD_TAG>/worker-package.zip --archive-sha256 <authenticated artifact zip sha256> \
  --lock-sha256 <lock sha256> --package-sha256 <package sha256> \
  --worker-env-sha256 <root-read sha256sum of /etc/aihr/import-worker.env> --existing-uid <id -u aihr-import>
```

Every value comes from independently verified release evidence or a root-read observation. The helper prints
no environment value or database URL. Before it writes anything, it refuses when:
- the release manifest is not the pinned bytes, or does not name exactly `--source` and `--build-id`;
- `/opt/ai-hr/.next/BUILD_ID` is not `--build-id`;
- `aihr` is not active and running as `aihr` from `/opt/ai-hr`;
- loopback `/health` on `--web-port` is not `{"status":"ok"}`;
- the web service's main PID changes while these checks run;
- any `aihr-bank-import*` unit, template, drop-in or enablement link exists in a systemd unit directory, or systemd
  knows the unit (loaded, masked or tracking a control group);
- any process runs as `aihr-import` or inside an `aihr-bank-import` cgroup;
- `aihr-import` is not the pinned uid, is not a system uid (below 1000), shares its uid or primary group, has a
  supplementary group (including `aihr`) or a login shell, or has a home that exists and is not root-owned and
  read-only;
- the environment file is not root-owned 0600/0400 (or 0640/0440 with group root or `aihr-import`) with the pinned
  sha256, or does not parse under a closed subset of systemd's syntax: `KEY=value` lines, `#` comments, and plain or
  quoted values without `$`, backslash, quote characters, spaces or control characters;
- the file contains a key outside the reviewed set (`DATABASE_URL`, `MIGRATION_DATABASE_URL`,
  `AUDIT_HASH_CHAIN_ENABLED`, `NODE_EXTRA_CA_CERTS`, `PGSSLMODE`, `PGSSLROOTCERT`, `PGSSLCERT`, `PGSSLKEY`), so it
  cannot override `AIHR_DB_POOL_MAX` or `AIHR_DB_PROCESS_ROLE`;
- `DATABASE_URL` does not use `ai_hr_app` and `MIGRATION_DATABASE_URL` does not use `ai_hr_owner`, both on database
  `ai_hr` at the same host and port, with no options except `sslmode`, `sslrootcert`, `sslcert` and `sslkey`;
- a non-loopback database lacks exactly one `sslmode=verify-full` per URL, or lacks a root-protected
  `NODE_EXTRA_CA_CERTS` (for Node) and `PGSSLROOTCERT` (for libpq). `PGSSLMODE`, if set, must also be `verify-full`;
- `aihr-import` cannot read those certificate files or traverse `/opt/aihr-import`;
- a read-only `/usr/bin/psql` check shows that the app role is a superuser or BYPASSRLS, or that the owner role does
  not own `bank_import_job` (so the app VM needs the PostgreSQL client);
- `/opt/aihr-import/releases/<source>` or an earlier attempt in `/opt/aihr-import/installs/<source>/` exists.

It then records `preflight.json` (key names and identities only) in `/opt/aihr-import/installs/<source>/`,
snapshots and authenticates the archive, and extracts it into the new immutable release. The prior receipt-less
releases stay untouched. Immediately before the unit exists, it repeats every check above. It creates the unit
atomically, without replacing anything, then runs `daemon-reload` and checks the loaded configuration. It starts
the worker and takes three stable observations of the live process: worker uid, release directory, fixed command,
and the exact environment file values plus `AIHR_DB_PROCESS_ROLE=worker` and `AIHR_DB_POOL_MAX=2`. After that it
re-checks the web identity and the environment pin, enables the unit, and writes `worker-install-v2.json`
(`mode: production-first-install`, `journeyVerified: false`) and `activated.json`.

Any failure after the unit exists enters the same quarantine as `activate`: `Restart=no`, `SendSIGKILL=no`, reload,
disable and a bounded graceful stop. It never sends SIGKILL and never deletes prior releases, the environment file
or the identity. If the quarantine cannot be confirmed, it reports uncertainty for administrator recovery. A failed
or partial attempt cannot be retried by deleting its records. After success, verify the worker as in the runbook
(`scripts/check-import-worker.ts`), then set `AIHR_IMPORT_WORKER_REQUIRED=1` in the deploy environment. Later
production updates use `production-drain`/`production-activate` below; the staging `drain`/`activate` helper depends on
staging deployment receipts and the v2 environment format, and refuses production.

## Production update (`production-drain`, `production-activate`) and rollback (`production-rollback`)

The same production bundle updates an installed managed worker release to a new source, and can re-activate the
pinned previous release. **Each production run still needs the owner's separate, explicit go-ahead**; the helper,
its tests and its bundle grant no release authority. The staging `drain`/`activate`/`adopt-stopped` phases are not
reachable from this bundle.

The update is two phases because the web install sits between them. The window order is: `production-drain`, stop
the web, install the web, migrate, start the web, `production-activate`. `production-drain` accepts either the exact
previous web or the exact new web, so both phases may also run back to back after the web install (the staging
order). Both phases take the same pins. The drain record binds them, and activation refuses any difference.

Read these pins on production as root before the window and pass them unchanged to every phase:

| Argument | Source of the value |
| --- | --- |
| `--previous-worker-source` | `systemctl show -p WorkingDirectory --value aihr-bank-import`: the managed release directory name |
| `--unit-sha256` | `sha256sum /etc/systemd/system/aihr-bank-import.service`; equals that release receipt's `unitSha256` |
| `--worker-env-sha256` | `sha256sum /etc/aihr/import-worker.env`; equals that receipt's `selectedEnvironmentSha256` |
| `--previous-worker-env-sha256` (optional) | that receipt's `selectedEnvironmentSha256`, only when a reviewed key was added to the file after it (see above) |
| `--existing-uid` | `id -u aihr-import` |
| `--previous-web-source`, `--previous-web-build` | the installed web release and `/opt/ai-hr/.next/BUILD_ID` before the window |
| `--source`, `--build-id` | the new release; `--release-manifest` must name both |
| `--release-manifest`, `--release-manifest-sha256` | the private package's `release-manifest.json` and its `SHA256SUMS` line |
| `--archive`, `--archive-sha256`, `--lock-sha256`, `--package-sha256` | the authenticated `worker-package-v1` artifact and its provenance |
| `--web-port` | `PORT` in `/etc/aihr/runtime.env` (3000 when absent) |

Build the bundle from the reviewed commit, hash-pin it, copy it to a new root-protected path, check the hash there,
and run every phase from `/` with `python3 -I -B`:

```bash
python3 -I -B scripts/bank-import-worker-production-bundle.py /PRIVATE/production-helper.py   # prints helperSha256
# On production, as root: install -m 0400 -o root -g root, then sha256sum -c against helperSha256.
ARGS=(--previous-worker-source <old> --unit-sha256 <unit> --previous-web-source <old web> --previous-web-build <old build>
      --source <new> --build-id <new build> --web-port <port>
      --release-manifest <manifest> --release-manifest-sha256 <manifest sha256>
      --archive <worker-package.zip> --archive-sha256 <zip> --lock-sha256 <lock> --package-sha256 <package>
      --worker-env-sha256 <env> --existing-uid <uid>)
cd / && sudo python3 -I -B /ROOT-PROTECTED/production-helper.py production-drain "${ARGS[@]}"
# ... stop the web, install the web, migrate, start the web ...
cd / && sudo python3 -I -B /ROOT-PROTECTED/production-helper.py production-activate "${ARGS[@]}"
```

Both phases refuse, before they write anything, when:
- the sources or digests are malformed, or `--source` equals `--previous-worker-source`;
- the release manifest is not the pinned bytes, or does not name exactly `--source` and `--build-id`;
- the web is not the running `aihr` service as `aihr` from `/opt/ai-hr` with loopback `/health` returning
  `{"status":"ok"}`, or `/opt/ai-hr/.next/BUILD_ID` is not a pinned build. `production-drain` accepts the previous or
  the new pin. `production-activate` accepts only the new pin;
- the previous release has no root-protected `worker-install-v2.json` from `production-first-install` or
  `production-activate` (staging or `adopt-stopped` receipts refuse), or the receipt names another source, unit,
  environment or an unstable service;
- the previous web source equals the previous worker source and its build differs from that receipt's `webBuildId`;
- the unit bytes differ from `--unit-sha256` or from the template for the previous source, or the loaded unit is not
  that template: other `WorkingDirectory`, a drop-in, a pending reload, not `Restart=on-failure` or not enabled;
- the environment file, identity, database URLs or TLS files fail a `production-first-install` check above (the
  read-only `psql` role proof runs in `production-activate` and `production-rollback`);
- the previous worker is neither running from the previous release (uid, release directory, command and exact
  environment) nor cleanly stopped (`inactive`/`dead`, `MainPID=0`, `Result=success`, exit status 0, no control group,
  no process as `aihr-import` or in the unit cgroup). An earlier automatic restart of a running worker is accepted.

`production-drain` snapshots and authenticates the archive and extracts it once as a check, in a private
`/opt/aihr-import/upgrades/.production-drain-<source>-*` directory. It repeats every check, then sends SIGTERM to the
worker's main process only. The runner finishes its current Bank, Individual and bulk-job tick and exits 0. The helper
watches for up to 330 seconds. It **never sends SIGKILL**, never arms systemd's timed stop, never disables the unit
and never replays a job. A restart, a PID change or a non-zero exit refuses. Queued uploads, jobs and saved row
checkpoints stay durable in the database while the worker is stopped. Only a complete drain publishes the attempt as
`/opt/aihr-import/upgrades/<source>/` with `drained.json`. After the deadline the helper records
`drain-unfinished.json` and keeps the previous unit and release unchanged. Let the runner finish, confirm a clean exit
with `systemctl show aihr-bank-import -p ActiveState,SubState,MainPID,Result,ExecMainStatus`, then run
`production-drain` again: it records an already cleanly stopped worker without signalling it. A worker that crashed,
or is still stopping, refuses.

`production-activate` requires that exact drain record, the drained previous worker and the exact new web. It runs
the read-only database role proof and re-authenticates the drain's archive snapshot. It extracts it again into the new
immutable `/opt/aihr-import/releases/<source>` and repeats every check. If a check fails at that point, nothing uses the
new release yet: it is moved, not deleted, into `refused-release-*` inside the attempt, and `production-activate` can
run again once the cause is repaired. When the checks pass, it replaces the unit atomically with the template for the
new source, runs `daemon-reload` and starts the worker. Three stable live observations follow:
uid, release, command and exact environment, with no restart. It then re-checks the web and the environment pin and
confirms boot enablement. It writes `worker-install-v2.json` (`mode: production-update`, `journeyVerified: false`) and
`activated.json`. The receipt keeps the previous worker, unit and web pins, and a later `production-drain` accepts it.
The previous release directory and its receipt are never changed. Any failure after the unit replacement starts
enters the same quarantine as the staging `activate`: `Restart=no` and `SendSIGKILL=no` loaded and verified, boot
activation disabled, a bounded graceful stop, with records under `/opt/aihr-import/upgrades/<source>/`. If it cannot
be confirmed, the helper reports uncertainty. A failed activation is not retried by deleting records. Use
`production-rollback` to return to the previous release, or reviewed administrator recovery to retry the same source.

After activation, run `scripts/check-import-worker.ts` against the new web tree and the real import journeys in the
runbook. The receipt is process evidence only.

### Rollback (`production-rollback`)

`production-rollback` re-activates the pinned previous release of a production update attempt. It needs no new code
during the window. Run it with the web you intend to keep: after a web rollback, that is the previous web; for a
worker-only rollback, it is the new web.

```bash
cd / && sudo python3 -I -B /ROOT-PROTECTED/production-helper.py production-rollback \
  --from-source <new> --to-source <old> \
  --unit-sha256 <root-read sha256sum of /etc/systemd/system/aihr-bank-import.service now> --to-unit-sha256 <old receipt unitSha256> \
  --web-source <old or new> --web-build <its BUILD_ID> --web-port <port> \
  --worker-env-sha256 <env> --existing-uid <uid>
```

It refuses, before it writes anything, unless all of these hold:
- `/opt/aihr-import/upgrades/<from>/drained.json` is a production drain record naming `--to-source`, `--to-unit-sha256`,
  `--worker-env-sha256` and `--previous-worker-env-sha256` when the drain had it (absent otherwise);
- the previous release keeps its production receipt for that source, unit template and environment (the
  `--previous-worker-env-sha256` value when given, otherwise `--worker-env-sha256`);
- every entry of the previous release is owned like its root-protected directory and is neither group- nor
  other-writable nor set-id;
- `--web-build` is the build recorded for `--web-source`: the previous receipt's `webBuildId`, or the drain record's
  `--build-id`. The web passes the customer web check above;
- the environment, identity, TLS files and read-only database role proof pass;
- the current unit is exactly `--unit-sha256` and one of four reviewed units:
  - the previous template, with that worker cleanly stopped (drained, never activated);
  - the new template (activated: running, restarting or stopped);
  - the quarantine of the new source (failed activation, stopped);
  - the quarantine of the previous source (an earlier rollback failed, stopped).

A running new worker is stopped exactly like a failed activation: quarantine unit, reload, disable and a bounded
graceful stop, without SIGKILL. Its records go in `stop-updated/`. If that stop is not confirmed, the rollback stops for
administrator recovery. The helper then repeats every check and installs the previous template atomically, unless it
is already there. It reloads, starts and takes the same three stable observations, then re-checks the web and
environment. It re-enables boot activation and writes `rolled-back.json` in a new
`/opt/aihr-import/upgrades/<from>/rollback-<to>-*` directory. The previous receipt is not rewritten. It still matches the
re-activated unit, so a later `production-drain` from that release works. A failure after the unit change enters the
quarantine for the previous source. After repair, run `production-rollback` again with the new unit sha256. A
previous worker that is already running refuses with "nothing to roll back". Without a published attempt (an
unfinished drain) there is nothing to roll back: the previous unit is unchanged, so once its runner has exited cleanly,
`systemctl start aihr-bank-import.service` resumes it. Records, packages and both releases are
never deleted. Retrying the same new source after a rollback needs reviewed administrator recovery of its attempt
directory and release.

Disk: each update keeps the archive (about 275 MB for 0cbe5fec), one checked extraction in the attempt and the new
release (about 0.9 GB each). Check `df -B1 /opt/aihr-import` before the window.

### Authenticated CI runtime cutover (`aihr-worker-ci-runtime/v2`, staging only)

This conditional administrator operation preserves the ordinary `drain`, `activate`, `adopt-stopped`
contracts. It has no CI controller hook, environment mutation, synthetic heartbeat, deployment finish,
pending removal, queue promotion, acceptance or handback authority. The complete gate, independent
administrator review, installed journeys and actual capacity evidence remain release prerequisites.

There are two separate administrator approvals. Before the unchanged operator starts, the root-private
`ADMIN_REVIEWED_CI_WORKER_DRAIN_PINS` record pins the complete approved gate/build/artifact/witness tuple,
original managed drain arguments, helper/Node bytes, prior worker unit/archive/environment, healthy old
web, native environment fingerprint and raw dotenv SHA, readiness policy, complete canonical source
manifest SHA, held lease credential and native coordinator, and existing kernel operation lock identity.
The normal drain record is unchanged. Its mtime must fall within that first approval's validity interval.
A later approval cannot retrospectively justify a different drain.

After the unchanged native installer initializes its single grant/installation and publishes its genuine
active-service CI marker, the administrator independently prepares
`ADMIN_AUTHORIZED_SINGLE_CI_WORKER_CUTOVER`. It names the original approval and SHA and compares every
shared pin, including the exact full gate/build provenance and unchanged web and worker environments.
It adds the actual installation UUID/owner/device/inode, original grant/activated/runtime record SHAs,
original drain SHA, full ordered ledger identity, web PID/start/boot, original CI launch and old last-ok,
and independently prepared full source manifest. It expires within900 seconds and before the original
unexpired native grant. No helper generates approval, chooses the latest grant, or widens that authority.
The exact closed schemas are `FIRST_APPROVAL_FIELDS` and `ACTIVATION_FIELDS` in the reviewed helper.
Approval and lease files are root-private regular single-link files, opened without following links;
their named/opened inode and immutable bytes remain pinned throughout. The first approval is historical;
its expiry need not remain current after the drain. The second approval and grant must remain fresh.

Prepare content evidence as the ordinary owner of an actually clean frozen Git checkout:

```
node --import tsx scripts/bank-import-worker-source-inventory.mjs FROZEN_CHECKOUT FULL_CANDIDATE_SHA PRIVATE_OUTPUT
```

The generator imports the actual `deploymentRsyncArgs` and `canonicalSourceExclusions` owners. It includes
all canonical nodes, including ignored but canonically included extras, and records exact membership,
file bytes, modes and links. Its output parent is canonical/private/owned and the output must not exist.
Transfer and root-protect/hash-pin it independently. The helper checks both filter owners, detects extra
and missing nodes, and hashes installed content through held no-follow descriptors. This additional proof
never relabels native `fullSourceChecksumVerified:false`; the normal operator's checksum owner remains
unchanged. Metadata is never described as byte verification.

Invoke only the independently hash-pinned, root-owned self-contained bundle **after** the privilege
boundary, using the fixed launcher for each stage:

```
sudo /usr/bin/python3 -I /ROOT_PROTECTED_HELPER guarded-drain --approval /ROOT_PRIVATE_FIRST_APPROVAL --approval-sha256 EXACT_SHA256
sudo /usr/bin/python3 -I /ROOT_PROTECTED_HELPER guarded-activate-ci-runtime --approval /ROOT_PRIVATE_ACTIVATION_APPROVAL --approval-sha256 EXACT_SHA256
```

There are no arbitrary command/target arguments: original managed arguments come from the closed approval.
The launcher opens the existing canonical native `operations.lock` without CREATE, verifies owner/mode/
regular single-link inode and private queue ancestors, acquires shared flock, then acquires the worker
install exclusive lock. Both descriptions survive into every direct helper/proof/mutation child, including
systemctl. Native lease assertions run as the actual queue owner; root never calls the native coordinator
as root or executes web-writable application JavaScript. Closing one holder never intentionally unlocks
an inherited description. The lock supplies exclusion, not approval. Fixed launcher and native lease checks
cover the whole operation, including failure-only quarantine. No queue ownership or sudoers changes apply.

This is a precise process boundary, not a claim that every descendant inherits unrelated FDs. Native Node
may spawn truly read-only Python byte-audit or psql leaves which do not inherit those descriptions. Their
fixed argv provides only verification/read-only ledger queries, with no callback, grant write, activation,
receipt or release continuation. If all authority parents die, such a leaf cannot publish success or mutate
the release. The uncertain nonexpiring lease remains retained; there is no automatic handback.

All application JavaScript runs only as the actual private-install owner with supplementary groups cleared,
fixed PATH/HOME and exact held lease environment. Before any Node invocation with a dotenv, the pinned
Node runs as that owner **without** a dotenv or application import and uses builtin `util.parseEnv` on the
same bounded inode-bracketed private bytes. Only active key names, safe/CA booleans and the raw hash leave
that parser. Quoted/multiline/exported values, duplicates and comments follow actual Node semantics;
comments and ordinary NODE_ENV are allowed. Shared first/late
`nodeOptions:{policy:"aihr-worker-node-options-memory/v1",sha256}` pins the exact unchanged active value.
Only the anchored single `--max[-_]old[-_]space[-_]size=(\d+)` flag with numeric128..65536 is admitted;
no leading/trailing whitespace, additional flag, quoted-value extension, import/require/inspect or other
option is accepted. Absence may be pinned with the empty-value digest; an actively empty value refuses.
The owner parser emits only the memory-policy boolean and digest; subsequent native Node reads the
UNCHANGED dotenv, with no NODE_OPTIONS override/deletion. Hosted controls execute every accepted
hyphen/underscore spelling through actual Node/V8. Active LD_*, DYLD_*, PYTHON*, NODE_PATH,
NODE_V8_COVERAGE, NODE_COMPILE_CACHE, NODE_REDIRECT_WARNINGS, NODE_ICU_DATA,
NODE_REPL_EXTERNAL_MODULE, OPENSSL_CONF/OPENSSL_MODULES refuse. NODE_EXTRA_CA_CERTS
currently has no independently bounded external certificate pin, so its active presence also refuses
rather than removing configuration or pretending coverage.

Both administrator approvals also pin `python:{path,sha256,version}` for the root-protected resolved
`/usr/bin/python3.N` binary, which must match fixed PATH resolution and actual version >=3.11. A fixed
owner probe verifies version and actual safe_path/no_user_site flags. Subprocess environments alone add
PYTHONNOUSERSITE=1/PYTHONSAFEPATH=1 after loader admission; native Node-to-Python verification inherits them.
Host/private environment files, native argv, grant and native proof fields remain unchanged. This excludes
user-site/current-directory Python customization; system Python/global packages remain under OS trust.

Proof subprocesses also receive fixed TSX_DISABLE_CACHE=1 after active-dotenv admission. The installed
TSX owner selects an in-memory Map under this flag rather than reading/writing generated transforms in
os.tmpdir()/tsx-UID outside the observed roots. Active TSX_DISABLE_CACHE must be absent or exactly1;
TSX_TSCONFIG_PATH must be absent, preserving normal resolution through the frozen source config. The
builtin no-dotenv parser emits only those policy booleans and key presence. Hosted controls execute
actual Node --import tsx against a poisoned, unreadable/unwritable fictional cache, preserve frozen
config/path-alias resolution, and verify actual --env-file precedence for the fixed subprocess flag.
No environment file is edited. Coverage
is deliberately bounded to canonical source, active compiled tree, entire node_modules link-target graph
and complete `/opt/node22`; it does not claim a systemwide dependency graph or replace OS loader trust.

The success graph has exactly two native `status` audits, before the first unit/service mutation and after
three four-second stability observations. They use the exact native command as the actual installation
owner, retaining raw original/fresh records. Any native byte error is fatal, including a concurrent cleanup
read race. There is no generic retry or metadata fallback. Runtime comparison normalizes exactly its two
known changing timestamps: top-level verifiedAt and nested migrationLedger.verifiedAt. Both are validated;
the original seven-field native ledger is retained, while approval pins its six stable named fields.

Ten complete metadata/identity fences bracket the two source content passes, both native audits, reload,
start and stability checks. Each fence uses descriptor-relative O_NOFOLLOW/named-FD identity and two exact
complete enumerations of canonical source, compiled tree, dependencies including resolved link targets,
and the bounded Node runtime tree. It also rechecks immutable private original/audit record bytes, exact
legal monotonic native cleanup publications/removals, current lease, full native environment fingerprint,
web PID/start/boot/build/health and fresh full ordered ledger. Cache membership is pinned absent or safe
existing; membership changes refuse. The existing cache boundary pins device/inode/type/UID/GID/mode,
while child changes within that sole native-excluded directory are permitted. Compiled parent-root and
all non-cache metadata remain exact. Metadata-only regular entries use two complete anchored parent-FD
no-follow stat observations; every directory retains opened/no-follow descriptor identity and membership
brackets, links retain O_PATH, and actual byte consumers retain full opened-FD/named identity bridges. Original private records cannot change. Cleanup's wx sentinel is never precreated
or treated as flock; native packet/retained removal is admitted only under the exact native successful O,
commit/checksum/authority/consumption chain and retained original audit bytes. The immutable cleanup-intent has the exact authority hash, directory
identity and ordered children next/packet before either deletion. Native wx/write/fsync can expose a new
known file before publication completes: only that typed metadata-publication outcome may re-observe,
at most16 short attempts inside the SAME20/24-second slot, with fresh original pins/lease/strict O.
Existing accepted record changes, wrong closed records, retained audit integrity errors and every genuine
native byte-proof error are fatal; there is no generic exception retry or fallback.

Bounded native failures report a fixed reason (deadline, child exit, stdout/stderr
bound, wait timeout, interruption or other) and numeric exit/timing/byte counts.
They never include command arguments, environment, input, captured output or arbitrary
exception text. The original owned-process cleanup and all proof budgets still apply.

Only the same original `ci-build-health` launch may progress R0 (running with pinned old last-ok) → R1
(native exit0/finished-at/last-ok publication) → O (strict normal success). Direct R0→O is allowed. The same
lease may advance installing→arrived only under strict O. Failed/foreign/pending/backsliding states refuse.
The helper never publishes native finish or arrival. Final helper PASS is required before acceptance and
handback, and need not precede the normal operator's genuine arrival while both branches run concurrently.

Each helper slot has one absolute deadline shared across all subprocesses, without reset per child:
preparation30s, each complete fence20s, each source content pass60s, each native audit180s, reload45s,
start45s, receipt15s. Each stability sleep plus following fence shares one24s absolute slot, so scheduler
and proof work consume that same budget. Before first mutation F2, remaining approval/grant must be at
least527s, and the original native runtime marker +600s readiness deadline must leave155s. Global planning
also reserves max(remaining helper497s, latest genuine heartbeat/poll plus estimated normal branch830s)
plus30s safety-initiation margin against the original grant. The830s is explicitly an **estimate**, not an
enforced bound on the unchanged normal operator: its three source checks, arrival status and cleanup have
larger genuine existing timeouts. Neither estimates nor deterministic tests prove aggregate capacity.
Actual candidate/load/admin timing must fit before release; failed or insufficient evidence refuses.

A selected CI install waits fixed600 seconds for the unchanged all-kind heartbeat predicate. Explicit
AIHR_IMPORT_WORKER_WAIT_SECONDS is allowed only if exactly600; empty/45/0600 refuse early without rewriting
configuration. Unset selects600. Non-CI retains configured/default45. REQUIRED1 remains mandatory. Startup
bank/individual work may delay bulk heartbeat and cause genuine failure; there is no schema or env waiver.
The native grant's original maximum1800s, root approval900s and readiness600s are separate clocks.

Failure cannot publish success, activate further, arrive or hand back after authority expiry. Only a
protected exact own start (unit/source, UID/cgroup/PID/start/boot, immutable intent/evidence) plus continuous
validated shared/exclusive locks allows the existing graceful no-SIGKILL quarantine. Foreign/restarted/
reused/uncertain processes are never stopped. Failure initiation gets30s; the existing separately bounded
330s graceful quarantine may continue beyond success-authority expiry under those own-process fences.
No automatic rollback, DB kill or queue reset applies. Lost lock ownership permits no unit/service mutation.
Partial receipts remain honest (`journeyVerified:false`); failure diagnostics may themselves be unavailable
once ownership or process identity can no longer be demonstrated.

### Prepared handoff and exact pre-unit recovery

`bank_import_worker_prepared_v1.py` owns bounded, separately reviewed preparation.
The original unprepared conditional route retains its 30-second limit and refuses
large extractions; do not increase that live deadline. For a new normal handoff,
after managed drain and **before starting the web installer/readiness window**, use
`guarded-prepare-ci-worker` with `ADMIN_REVIEWED_CI_WORKER_PREPARATION`. Its closed
`preparation` object selects `normal`, the original drain approval/receipt, an
exclusive UUID, and fixed derived prepared-tree/proof paths. The separate IO-only
operation expires within300 seconds, re-extracts and authenticates the complete
archive, normalizes manifest modes, verifies every file byte/link/member/root
identity, and seals a root-private immutable proof. It changes no unit or service.
The independently reviewed later `ADMIN_AUTHORIZED_PREPARED_CI_WORKER_CUTOVER`
adds only the exact `preparedWorker:{path,sha256}` selection to the original
activation fields. `guarded-activate-prepared-ci-runtime` then runs the same
10 metadata fences, two source-content passes, two native byte audits and stable
owned-process checks. The live preparation remains30 seconds. Metadata rechecking,
immutable prepared-tree publication, unit replacement and reload share M0/45.
One absolute827-second live cap starts at guarded entry and never resets per child
or phase. Original grant/approval/readiness clocks are never reset or extended.

Normal `activate-prepared-ci-runtime` gives only F4, the full fence immediately
after its owned worker starts, a60-second slot. Cold worker bootstrap competed
with the20-second scan on the small staging server. Every other full fence stays20,
shared sleep/stability slots stay24, each native child stays20 and native freshness
stays60. Published recovery retains its existing60-second F4; legacy unprepared
activation and failed-preunit recovery retain20. All ten complete two-walk fences,
source inventories, audits and ownership checks still run.

For normal prepared activation, the post-mutation graph grows497→537 seconds.
Before any unit mutation, remaining global opportunity must therefore be at
least537 of the unchanged827-second cap (the pre-graph may consume at most290).
The lesser of fresh root authority and the original installation grant must have
at least567 seconds remaining, including the original30-second reserve. The
original immutable native marker's `verifiedAt + 600` readiness deadline must have
at least195 seconds remaining, versus155 in the legacy normal route. These are
stricter admission floors, not new clocks; fresh root authority still has a900-second
maximum and cannot outlive the original unexpired installation grant (at most1800).

The original-grant fork reservation is
`max(537, max(0, readinessDeadline + 15 - now) + 830) + 30` for prepared normal.
The830-second native branch allowance remains an estimate, not a new asserted hard
cap. Admission returns its actual567/195 required metrics. Legacy normal admission
retains497/527/155 and its original fork formula. A refused or expired original
grant/readiness window cannot be renewed by worker preparation or root approval.

For the exact failure before immutable worker publication/unit mutation, preparation
may instead select `failed-preunit`, the original fully extracted directory/inode,
and closed original terminal worker-check failure/activation/start-marker pins.
It authenticates all existing bytes; it does not retry extraction or delete history.
A fresh `ADMIN_AUTHORIZED_SINGLE_CI_WORKER_RECOVERY` explicitly binds that proof,
the original selected installation/grant/runtime and failed log/records, original
root authorities, old managed unit/environment/receipt and the held installing
lease. `guarded-recover-ci-runtime` admits only that exact terminal failed state;
a fresh attempt directory is published only after historical and actual native
failure admission. It uses the same full proof graph and live30/827 limits. The
fresh root approval authorizes one matching **worker** recovery for at most900
seconds. Original expired CI grants are used only by native read-only
`resume-status`; they are never renewed or used for web writes. The original600
readiness window stays failed. No normal fork/cleanup/finish runs during recovery.
After real matching-worker readiness, the unchanged `resume-arrival` owner verifies
and finishes the original installation. Recovery receipts are worker-only and never
claim full arrival, application journeys, handback or production authority.

Hosted qualification includes both complete prepared normal/recovery graphs,
original authority/global-expiry and unit/PID/environment/tree drift refusals, real
full source-bound ZIP extraction with more than30 seconds elapsed, the old30-second
negative control, and real-root full-package content/metadata/tamper checks. Native
CI/database/systemd proof ports in graph fixtures are explicitly identified; they
are not reported as an actual installed application acceptance.

Activation failure diagnostics snapshot the closed stage name, remaining stage
milliseconds and a fixed category before changing to failure-only clocks. Native
child failures retain only the existing fixed reason and numeric exit/time/byte
counts. Arbitrary exception messages, paths, argv, environment and child output
are never serialized. This safe summary is flushed to stderr before quarantine
and included in protected failure records when those records can be published.
The outer recovery error remains generic; the summary identifies the original
failure separately from any quarantine or evidence-publication failure.

The active owned-process fence still protects every quarantine command and unit
write. After graceful stop, a separate method can publish only the fixed immutable
`activation-failure-observation.json` leaf. It rechecks held locks, protected start
and quarantine records, boot, exact quarantine unit, current environment and one
complete native systemd observation: stopped, disabled, no restart and no remaining
or reused owned PID. It grants no command, activation receipt or arrival authority.
If these checks fail, the original safe summary remains in stderr and the caller
reports the final observation unavailable. This diagnostic repair neither retries
an activation nor admits an already published, quarantined release through the
pre-unit recovery route. That state requires its own reviewed recovery contract.

### Published but unaccepted staging worker

`bank_import_worker_published_v1.py` adds two explicit guarded modes for the
narrow state where the prior prepared recovery published the worker directory,
started its own process and quarantined it before producing an install receipt.
The pre-unit modes continue to reject an existing release. Neither new mode
extracts, renames, restores or deletes an existing release or failure record.

First, `guarded-seal-published-ci-worker` takes a separately reviewed root approval
with the original first-stage fields, `sealId` and `publishedFailure`. The latter
selects the prior recovery approval/hash, exact operation directory/stat identity,
all ten retained record identities/hashes, current published root identity and
quarantine unit hash. The exact namespace includes start intent, started process,
quarantine authority, failure record, F0–F3 and A0; unknown/partial attempts refuse.
This read-only authentication stage holds the existing queue SH and install EX,
requires PID0/dead/disabled/no restart and no worker UID or cgroup processes, and
authenticates every installed file plus the original archive within300 seconds.
Original prepared member identities and link closure must match; only the old
root location and ctime may differ because of the recorded publication rename.
It writes one root-private immutable `published-worker-<sealId>.json` proof, with
no service mutation or installation acceptance.

Only after that proof exists may the operator mint a fresh, at-most900-second
`ADMIN_AUTHORIZED_PUBLISHED_WORKER_RECOVERY` for
`guarded-recover-published-ci-runtime`. Its original recovery fields remain
unchanged, with one additional `publishedSeal` selecting path, SHA and the complete
seal stat identity. Mint inside the seal approval's original300-second freshness
window. The proof's original time is never rewritten. The new graph has its own
unchanged absolute827-second limit and original20/24-second fence slots.

The live mode independently rechecks historical records, exact installed tree,
stopped state, original failed native installation, original grant/runtime/ledger,
web source/build and held installing lease. It runs the same F0/S0/F1/A0/F2
admission and full subsequent proof graph. M0/45 rechecks the existing published
tree and replaces the exact quarantine unit with the candidate unit; it publishes
no directory. A fresh exclusive `published-recovery-<sealId>` attempt preserves
all older attempts. A previous published recovery refuses rather than retrying.
Any activation failure retains its safe original diagnosis and uses only the
exact owned-process quarantine. Successful receipts explicitly identify this as
published worker recovery; they grant no application arrival, acceptance,
production or expired-grant write authority. The unchanged original
`resume-arrival` remains responsible for closing the installation after actual
all-kind worker readiness.

Because quarantine disabled boot start, this published-only route restores and
independently reads back boot enablement after the full proof graph while its
exact owned worker is still running, before either success receipt, within the
unchanged15-second receipt slot. It never enables before starting: a pre-start
failure must leave the unaccepted unit disabled. Enable or readback failure uses
the same owned-process quarantine and disables the rejected worker again.

The published-only F4 post-start fence has a60-second absolute slot. The measured
staging attempt passed F0–F3 in9.8–14.1 seconds, then failed at F4 with its20-second
allowance exhausted while the worker's measured20.4-second bootstrap overlapped
the scan. This does not establish the lost inner exception text. The adjustment
retains both full enumerations, link closure, all native proofs and their20-second
child limits, native freshness60 and every other20/24-second slot. The global827
and fresh900-second authorities do not change. Required post-mutation opportunity
increases497→537 and authority reserve527→567; admission therefore refuses before
unit mutation if the pre-graph consumed more than290 seconds of the global cap.

A fresh root selection may additionally bind exactly one failed published attempt
in `publishedFailure.previousPublished`, keyed by its fixed derived directory name.
It pins that directory, all eleven file identities/hashes and its original live
approval/hash. The original seal, start/quarantine identity, F4 rejected boundary,
stopped/disabled observation and absence of any success member are revalidated.
The directory stays in place. Unknown attempts, changed records, uncertain state,
success receipts and any unselected prior attempt still refuse. This explicit
review is required before minting a new seal/UUID; no old clock or proof is renewed.
