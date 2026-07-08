-- Basic Salary redesign (feedback 87c82b18 "Personnel Module Enhancement — Basic Salary Management
-- Redesign"). The effective-dated salary-history engine already exists (core/comp.ts CLOSE+INSERT; payroll
-- picks the row in effect per period). This adds the one piece of history data the screen was missing:
-- a per-record Remarks note capturing the reason for each salary change (e.g. "annual increment", "merit").
--
-- Additive, nullable text column — every existing row keeps remarks = NULL (rendered as "—"). No backfill.
--
-- No RLS change: compensation already has admin-or-self read (migration 0060) + admin write policies that
-- are table-level and cover the new column (same pattern as 0133 / 0147 / 0159).
ALTER TABLE compensation ADD COLUMN IF NOT EXISTS remarks text;
