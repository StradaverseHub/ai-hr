-- Leave eligibility: probation-based restriction (feedback d6bdbd55).
--
-- Adds a per-leave-type probation eligibility rule, sitting alongside the existing gender / marital-status /
-- min-service / grade-group eligibility gates. Many organisations only allow certain leave AFTER an employee
-- is confirmed (past probation); others allow it ONLY during probation.
--
--   NULL             — no probation restriction (DEFAULT; every existing row keeps today's behaviour).
--   'confirmed_only' — only employees past probation (on/after their confirmation date) may apply.
--   'probation_only' — only employees still on probation (before their confirmation date) may apply.
--
-- "On probation" is derived from the employee's confirmation date (final_confirmation_date, falling back to
-- confirmation_date): before it => on probation, on/after => confirmed, absent => treated as not-on-probation.
-- Enforced at requestLeave / editPendingLeave (assertEligible), mirroring the other eligibility gates.
--
-- Additive + NULLABLE (no default): NULL backfills every existing row => no restriction, nothing changes until
-- an admin sets it. A CHECK constrains the column to the closed 2-value set (defence-in-depth behind the
-- service validation). IF NOT EXISTS makes a re-run on a partially-migrated DB safe. No RLS change: leave_type
-- already has tenant-read + admin-write policies, which this column inherits (same as the 0208 duplicate-policy
-- / 0209 negative-balance migrations).
ALTER TABLE leave_type ADD COLUMN IF NOT EXISTS probation_eligibility text;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leave_type_probation_eligibility_check'
  ) THEN
    ALTER TABLE leave_type
      ADD CONSTRAINT leave_type_probation_eligibility_check
      CHECK (probation_eligibility IN ('confirmed_only', 'probation_only'));
  END IF;
END $$;
