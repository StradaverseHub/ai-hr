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
   `MIGRATION_DATABASE_URL`, including this installation's TLS options. Keep owner credentials out of
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
production updates need their own reviewed route: the staging `drain`/`activate` helper depends on staging
deployment receipts and the v2 environment format.
