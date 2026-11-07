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
3. `drain` requires the exact healthy previous web source/build. It snapshots and
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
   durable progress/history and restart behavior before declaring Phase 1 arrived.
   The receipt intentionally keeps `journeyVerified:false`: it is process evidence,
   not human staging acceptance or rendered journey proof.

The helper takes `drain|activate` plus `--previous-source`, `--previous-build`,
`--source`, `--build-id`, `--archive`, `--archive-sha256`, `--lock-sha256`,
`--package-sha256`, `--unit-sha256` and `--worker-env-sha256`. All values must come
from independently verified release evidence, never a web request. It preserves
prior code, unit identity evidence, packages, private configuration, DB contents and
operation records; it does no automatic schema or worker rollback. Existing attempts,
partial activation or failed web installation require explicit diagnosis/recovery.
Do not remove an attempt to bypass a refusal. An absent/unhealthy matching worker
continues to block release even if web health passes.
