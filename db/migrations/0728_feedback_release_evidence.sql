-- Release milestones belong to the same RLS-protected feedback row, including user-only reporters.
-- NULL preserves uncertainty for historical deployed items; no environment is guessed or backfilled.
ALTER TABLE feedback_request ADD COLUMN release jsonb;
