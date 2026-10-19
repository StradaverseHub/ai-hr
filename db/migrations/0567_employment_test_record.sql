-- Explicit employment classification for Movement import reference admission.
-- Existing records remain unmarked; no name, code, email or other heuristic backfill.
ALTER TABLE employment ADD COLUMN is_test_record boolean NOT NULL DEFAULT false;
