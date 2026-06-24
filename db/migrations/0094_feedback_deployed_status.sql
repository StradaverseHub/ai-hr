-- Add a `deployed` status to feedback (ADR-0044, improvement loop). After a built change is released to
-- the server, the loop marks the originating feedback item `deployed` to close it. Postgres requires the
-- new enum value to be added before it can be used; it slots in after `done`.
ALTER TYPE "feedback_status" ADD VALUE IF NOT EXISTS 'deployed' AFTER 'done';
