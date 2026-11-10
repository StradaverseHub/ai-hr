# Background employee imports (shared bulk-job kernel)

The web process only admits an import (a `bulk_job` row of kind `employee_import`, migration 9003) and returns.
The protected import worker, `aihr-bank-import.service` (`scripts/bank-import-runner.ts`), runs it on the shared
bulk-job kernel next to the Bank & Statutory and Individual Transaction queues. There is no separate employee import
unit: the same closed `worker-package-v1`, first-install helper (`bank_import_worker_installer_v2.py`) and staging
upgrade helper (`bank_import_worker_upgrade_v1.py`) build, install, enable and update it. Follow BANK-IMPORT.md for
every installation and release step; nothing here installs or starts a service.

What the worker does: validates the file once with no tenant lock, applies rows in chunk transactions of about 200 ms
under the initiating user's freshly checked authority, then releases the whole import in one short transaction.
Nothing is visible to anyone until that release; afterwards the markers are settled in bounded batches. A failure
before release discards the staged rows in bounded batches (each discarded hire leaves `employment.hired` followed by
`employment.voided`, ADR-0157). The creator gets one in-app notice with the outcome and a link to Import History.

Credentials and pool: the same root-owned `/etc/aihr/import-worker.env` (`DATABASE_URL` app role,
`MIGRATION_DATABASE_URL` queue owner). The owner connection only claims, leases and runs the owner-only discard and
settle routines. `AIHR_DB_POOL_MAX` in that file bounds the worker's app-role pool (db/client default otherwise).

Readiness. Each worker records a heartbeat in `bulk_job_worker` with the kinds it serves. After restarting the web
service, `deploy/deploy.sh` runs `scripts/check-import-worker.ts --wait 45`, which requires a live heartbeat for every
kind in `bulk_job_kind`. During the documented drain → web install → worker activate sequence the worker is stopped
at that point, so the deploy only warns; set `AIHR_IMPORT_WORKER_REQUIRED=1` once the matching worker is activated to
make a missing worker fail the deploy, or re-run the check by hand after activation:
`node --env-file=.env.production --import tsx scripts/check-import-worker.ts` (exit 0 ready, 2 missing, 1 unreadable).
While no live worker serves the kind, the import screen shows the job as queued and waiting for the import service.

A failed or absent worker leaves jobs queued or in progress with their progress intact. Resume is automatic when the
worker returns: each chunk's rows and its step markers commit together, and an expired lease is reclaimed, so a crash
re-runs nothing that committed. The upgrade helper's drain finishes the current unit (at most about a second for a
bulk-job unit) before the runner exits.
