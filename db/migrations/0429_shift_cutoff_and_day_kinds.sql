-- b8aa3466 — Shift settings: the daily cut-off, and four-way working days.
--
-- Two additions to `shift`, both ADDITIVE and both defaulted so that EVERY EXISTING ROW KEEPS EXACTLY
-- TODAY'S MEANING with no backfill statement at all. That is the property this migration is built around:
-- the plan promises "nothing already saved changes meaning", and the cheapest way to keep a promise like
-- that is to make the no-op the default rather than to write a data migration and hope it is right.
--
-- 1. DAILY CUT-OFF (plan item 7). A boolean plus a time. Today the engine decides which attendance day a
--    punch belongs to with a hard-coded 12-hour rule inside anchorToShift (core/attendance.ts) that nobody
--    can see or change. With the cut-off ON, that boundary becomes the operator's own clock time: a punch
--    before it belongs to the shift-day that opened the previous calendar day, a punch after it belongs to
--    the new one. OFF (the default, and every existing row) keeps the 12-hour behaviour byte-identical.
--
--    The CHECK exists because `enabled = true` with no time is a broken state the reader cannot honour, and
--    a column pair that can hold nonsense will eventually hold it.
--
-- 2. FOUR-WAY WORKING DAYS (plan item 9). Today `weekly_pattern` is the list of WORKING ISO weekdays and
--    every other day is a rest day — two meanings, which is why this tenant carries two whole extra shifts
--    ("Half Day", "Half Day #2", both 09:00-12:00) standing in for a value the row cannot express.
--
--    Rather than invent an encoding, this copies the shape attendance_policy already uses for exactly this
--    problem (working_days + half_working_days with a disjointness CHECK — migration 0142): keep
--    `weekly_pattern` as the FULL days and add one array per new kind. A weekday is
--        Full = in weekly_pattern
--        Half = in half_pattern
--        Off  = in off_pattern
--        Rest = in none of them          ← the same complement rule as today
--    so a row written before this migration reads back as Full where it was ticked and Rest where it was
--    not, which is precisely what it means today. No UPDATE statement is needed, and none is run.
--
--    weekly_pattern is NULLABLE (a shift with no pattern at all), so the disjointness CHECK coalesces it —
--    without that, one NULL makes the whole predicate NULL and the constraint silently stops constraining.
--
-- No RLS or GRANT changes: this migration only ADDs columns to an existing table. `shift`'s row-level
-- policies are row-scoped (tenant/admin), not column-scoped, so the new columns inherit them, and column
-- privileges follow the table grant that `shift` already carries — the same reason migration 0142 needed
-- none when it added attendance_policy.half_working_days. (A CREATE TABLE here would have needed both.)

ALTER TABLE "shift" ADD COLUMN "daily_cutoff_enabled" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "shift" ADD COLUMN "daily_cutoff_time" time;--> statement-breakpoint
ALTER TABLE "shift" ADD CONSTRAINT "shift_daily_cutoff_time_required" CHECK (NOT "daily_cutoff_enabled" OR "daily_cutoff_time" IS NOT NULL);--> statement-breakpoint

ALTER TABLE "shift" ADD COLUMN "half_pattern" integer[] NOT NULL DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "shift" ADD COLUMN "off_pattern" integer[] NOT NULL DEFAULT '{}';--> statement-breakpoint
ALTER TABLE "shift" ADD CONSTRAINT "shift_day_kinds_disjoint" CHECK (
  NOT (COALESCE("weekly_pattern", '{}') && "half_pattern")
  AND NOT (COALESCE("weekly_pattern", '{}') && "off_pattern")
  AND NOT ("half_pattern" && "off_pattern")
);
