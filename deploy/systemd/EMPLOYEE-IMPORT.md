# Staged employee imports (background worker)

The web process only admits an import (`employee_import_job`) and returns. `scripts/employee-import-runner.ts` is a
separate process with its own small connection pool (`AIHR_DB_POOL_MAX`, default 4) that validates the file once,
applies rows in chunk transactions of about 250 ms under the initiating user's authority, then activates everything in
one short transaction. Nothing the import writes is visible to anyone until activation; a failure before activation
discards the staged rows (each discarded hire leaves `employment.hired` followed by `employment.voided`, ADR-0157).

Installation follows the same protected pattern as `aihr-bank-import.service` (see BANK-IMPORT.md): the worker runs as the
`aihr-import` account with `/etc/aihr/import-worker.env`, holding `DATABASE_URL` (app role) and `MIGRATION_DATABASE_URL`
(queue owner; discovery, coordination and discard only). The unit file is `deploy/systemd/aihr-employee-import.service`.
This source does not install or start it; deployment and its packaging remain separately authorized release work.

A failed or absent worker leaves jobs in `queued`/`importing` with their progress intact. Resume is automatic when the
worker returns: each chunk's hire and its step marker commit together, so a crash re-runs nothing that committed.
