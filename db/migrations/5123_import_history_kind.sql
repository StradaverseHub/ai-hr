-- ccd3a65c: Import History lists section imports by type. Nullable, append-only: no backfill, no
-- constraint, no RLS or grant change (table-level grants from 0341 already cover new columns). Runs
-- recorded before this column stay NULL and are shown as "Not recorded".
ALTER TABLE public.employee_import_run ADD COLUMN import_section text;
