-- UNALLOCATED DRAFT on branch claude/bulkjob-movement-20261110 (movement import on the shared bulk-job kernel): not a
-- reservation, not an installation allocation. The journal position (idx 9910, when 1793330099910) exists only so
-- this branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when after the
-- freshly verified ledger, per docs/MIGRATION-ALLOCATION.md. Depends on 9003 (bulk_job_kind).
--
-- Confirming a checked movement import runs as a background job (core/movement-import-worker.ts): one step per
-- employee, each saved all or nothing as before. The creator reads the job while they keep Import History view
-- access to every company in the file (scope 'movement'); one active movement import per person.
INSERT INTO bulk_job_kind(kind,scope_kind,exclusive) VALUES('movement_import','movement','creator');
