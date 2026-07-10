-- Leave Unit Configuration (feedback e4980382).
--
-- Adds a single additive column to leave_type recording whether that leave type is MANAGED and applied in
-- whole Days or in Hours. Surfaced beside the existing "Paid Leave" setting on the Leave Type Setup screen
-- (the create-type form + the per-type edit panel) — no new page or configuration section.
--
--   leave_unit — 'day' | 'hour'. NOT NULL DEFAULT 'day', so every existing row reads Day with no backfill.
--
-- SCOPE (per the item spec, reporter-stated): this is a labelling / configuration setting for reporting.
-- It DOES NOT change leave entitlement, accrual, workflow, or payroll behaviour — none of those paths read
-- leave_unit. The finer-grained per-request fraction model already lives on leave_type.durations (full_day /
-- half_day / hourly) and continues to drive the actual deduction math; leave_unit is the coarse Day-vs-Hour
-- label the reporter asked for. Driving/replacing the duration model from leave_unit is a future item.
--
-- Backward compatible: DEFAULT 'day' ⇒ today's exact behaviour for every existing type. A DB CHECK backs the
-- service-level validation (mirrors the leave_type_color_token_ck / expiry_unit checks on this table).
-- No RLS change: leave_type already has tenant-read + admin-write policies; a new column inherits them
-- (same as the 0179 visual-config and 0181 day-type-inclusion migrations).
ALTER TABLE leave_type ADD COLUMN IF NOT EXISTS leave_unit text NOT NULL DEFAULT 'day';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leave_type_leave_unit_ck'
  ) THEN
    ALTER TABLE leave_type ADD CONSTRAINT leave_type_leave_unit_ck
      CHECK (leave_unit IN ('day', 'hour'));
  END IF;
END $$;
