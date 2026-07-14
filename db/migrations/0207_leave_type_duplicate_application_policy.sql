-- Duplicate Leave Application Restriction Configuration (feedback d5e51c34).
--
-- Adds a per-leave-type policy controlling whether an employee may submit MORE THAN ONE leave application
-- covering the same date when a pending/approved application already exists. The existing narrow AM/PM
-- same-slot clash guard (core/leave.ts requestLeave/editLeaveRequest) stays in place; this rule sits on top
-- of it for organisations that want the stricter same-DATE policy.
--
--   'allow'         — current behaviour: multiple applications on the same date are fine (no extra check).
--   'restrict_same' — block a 2nd pending/approved application of the SAME leave type overlapping the date range.
--   'restrict_any'  — block ANY new pending/approved leave (any type) overlapping the date range.
--
-- Additive + NULLABLE DEFAULT 'allow': the DEFAULT backfills every existing row to 'allow', so nothing
-- changes for anyone until an admin deliberately switches on a restriction. A CHECK constrains the column to
-- the closed 3-value set (defence-in-depth behind the service validation). IF NOT EXISTS makes a re-run on a
-- partially-migrated DB safe. No RLS change: leave_type already has tenant-read + admin-write policies, which
-- this column inherits (same as the 0192 visibility / 0193 placement migrations).
ALTER TABLE leave_type ADD COLUMN IF NOT EXISTS duplicate_application_policy text DEFAULT 'allow';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leave_type_duplicate_application_policy_check'
  ) THEN
    ALTER TABLE leave_type
      ADD CONSTRAINT leave_type_duplicate_application_policy_check
      CHECK (duplicate_application_policy IN ('allow', 'restrict_same', 'restrict_any'));
  END IF;
END $$;
