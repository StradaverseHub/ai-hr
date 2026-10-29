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
   the template's `WorkingDirectory`/`ExecStart` to that exact installation. The web identity must not
   be able to edit the worker's code or credentials. Install and start `aihr-bank-import.service` after
   the migration and web candidate are installed. Include this worker in future release restarts.
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
