-- Combined release allocation, 11 November 2026 (docs/MIGRATION-ALLOCATION.md): 5060_register_section_import_jobs, idx 4460, when 1793330004760.
-- Draft name on its branch: 9930_register_section_import_jobs. Any draft note below describes that unallocated branch position.
-- UNALLOCATED DRAFT on branch claude/bulkjob-register-20261110 (register and section imports as background jobs on the
-- shared bulk-job kernel, 9003): not a reservation, not an installation allocation. The journal position (idx 9930,
-- when 1793330099300) exists only so this branch's schema is executable and reviewable; the integration owner assigns
-- the final tag/idx/when after the freshly verified ledger, per docs/MIGRATION-ALLOCATION.md.
--
-- Two kinds, no new tables (docs/adr/2026-11-10-register-section-import-jobs.md). Neither records an Import History attempt,
-- exactly as the synchronous imports did not, so the job is readable by its creator only (scope_kind NULL). One active
-- import of each kind per person, as one person could only run one synchronous import at a time from the screen.
--  section_import:  Profile and Family files, one row per step (rows succeed or fail on their own, as before).
--  register_import: Qualification and Emergency Contact files, all-or-nothing (captured writes, one release).
-- Hardened kernel (5013): both admissions pass {section, records, fileName} and nothing else (there is no admission
-- plan). A section file is at most 900,000 bytes of CSV, but every parsed row repeats every column name, so a wide,
-- sparse file is many times larger as JSON: 64 MiB, the employee import's ceiling. A register file is at most 500 rows
-- and 900,000 bytes of JSON (assertRegisterImportBounds) plus the file name: 2 MiB. Only the register import finalizes
-- on the queue-owner connection (app.register_import_release, 5061 and 5063; finalizeOwner in
-- core/register-import-worker.ts); the section import finalizes as the app role.
INSERT INTO bulk_job_kind(kind,scope_kind,exclusive,input_shape,input_max_bytes,finalize_owner) VALUES
 ('section_import',NULL,'creator','{"section":"string","records":"array","fileName":"string"}'::jsonb,67108864,false),
 ('register_import',NULL,'creator','{"section":"string","records":"array","fileName":"string"}'::jsonb,2097152,true);
