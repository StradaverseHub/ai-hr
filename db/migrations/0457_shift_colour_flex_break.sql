-- 6340aecb — Shift Settings redesign: the two things the shift record genuinely did not hold.
--
-- Everything else in that request already exists on `shift` (measured 2026-09-09): half_day_first_out /
-- half_day_second_in are the "1st Half End Time" / "2nd Half Start Time" pair, early_in / late_out are the
-- two fields being RELABELLED (a label change, deliberately NOT a column rename — both are read across
-- attendance and payroll), and start_time / end_time / break_minutes / break_periods / the grace columns /
-- crosses_midnight / late_out_next_day are all long since here. This migration adds a COLOUR and a
-- FLEXIBLE BREAK, and nothing else.
--
-- ⚠️ ONE OF THESE TWO IS NOT COSMETIC, AND THE DEFAULTS ARE THE SAFETY PROPERTY OF THE WHOLE CHANGE.
--
-- 1. color — DISPLAY ONLY. One of a fixed 8-token palette (lib/shift-visual.ts SHIFT_COLOR_TOKENS), shown
--    on the Shift list and used to tint the shift's cells on the Duty Roster. NULL on every existing row
--    and NULL is a first-class value, not a missing one: components/roster-grid.tsx keeps its rotating
--    position-keyed palette for a shift with no colour, so the roster looks EXACTLY as it does today until
--    somebody chooses a colour. Nothing reads it for scheduling, attendance or pay — the same guardrail
--    leave_type.color carries (migration 0179), whose token-CHECK shape this copies rather than inventing
--    a second convention for the same idea.
--
-- 2. flexible_break_enabled / flexible_break_minutes — THIS ONE MOVES MINUTES. Break handling feeds worked
--    minutes, worked minutes feed overtime, and overtime is what payroll reads. So the switch is installed
--    OFF on every existing row, by DEFAULT false rather than by a backfill statement that could be wrong:
--    the cheapest way to keep "nothing already saved changes" is to make the no-op the default. There is
--    no UPDATE in this migration and none is needed. test/shift-colour-flex-break.test.ts pins the
--    property in ringgit — a shift without the flag derives byte-identically to before.
--
--    WHAT IT DOES WHEN IT IS ON (core/attendance.ts deriveAttendance, core/roster.ts normalizeShiftInput):
--    a flexible break is an ALLOWANCE, not a clock window. The employee may take up to N minutes whenever
--    they like, so there is no window for the engine to test the clocking against: N comes off the day's
--    worked minutes (clamped to the span, so a short day can never go negative), instead of the overlap
--    between the punch and the declared break windows. N also BECOMES the shift's canonical break_minutes
--    at save time — one number, so the scheduled-hours figure, the punch import and the hourly clamp
--    cannot disagree with what the engine deducts. Fixed Break Start / Break End stay editable and stay
--    stored (the reporter's point 12: the allowance applies even when a window is configured).
--
-- The CHECKs exist because `enabled = true` with no allowance is a state the reader cannot honour, and a
-- column pair that can hold nonsense eventually does — the same reasoning as 0429's daily-cut-off pair.
--
-- No RLS or GRANT changes: this migration only ADDs columns to an existing table, whose row-level policies
-- are row-scoped (tenant/admin) and inherited by new columns, and whose column privileges follow the table
-- grant `shift` already carries. (A CREATE TABLE here would have needed both.)

ALTER TABLE "shift" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "shift" ADD CONSTRAINT "shift_color_token_ck" CHECK (
  "color" IS NULL OR "color" IN ('indigo','green','orange','blue','red','purple','teal','grey')
);--> statement-breakpoint

ALTER TABLE "shift" ADD COLUMN "flexible_break_enabled" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "shift" ADD COLUMN "flexible_break_minutes" integer;--> statement-breakpoint
ALTER TABLE "shift" ADD CONSTRAINT "shift_flexible_break_minutes_required" CHECK (
  NOT "flexible_break_enabled" OR ("flexible_break_minutes" IS NOT NULL AND "flexible_break_minutes" > 0)
);--> statement-breakpoint
ALTER TABLE "shift" ADD CONSTRAINT "shift_flexible_break_minutes_range" CHECK (
  "flexible_break_minutes" IS NULL OR ("flexible_break_minutes" >= 0 AND "flexible_break_minutes" <= 1440)
);--> statement-breakpoint

COMMENT ON COLUMN "shift"."color" IS
  '6340aecb - DISPLAY ONLY. One of lib/shift-visual.ts SHIFT_COLOR_TOKENS; tints the shift on the Shift '
  'list and the Duty Roster. NULL (every row before this migration) keeps the roster grid rotating '
  'position-keyed palette, i.e. today''s exact appearance. Never read for scheduling, attendance or pay.';--> statement-breakpoint
COMMENT ON COLUMN "shift"."flexible_break_enabled" IS
  '6340aecb - a flexible break is an ALLOWANCE rather than a clock window: up to flexible_break_minutes '
  'taken whenever the employee likes. FALSE on every existing row and the deduction path is unchanged for '
  'them (core/attendance.ts still deducts the overlap with the declared windows, or the 6h-cliff scalar).';--> statement-breakpoint
COMMENT ON COLUMN "shift"."flexible_break_minutes" IS
  '6340aecb - the allowed flexible break, in minutes. Required (and > 0) when flexible_break_enabled. '
  'core/roster.ts also writes it into break_minutes on save, so the scheduled-hours figure, the punch '
  'import and the hourly clamp all read the same number the engine deducts.';--> statement-breakpoint

-- REPORT, so the release note can state what the switch found rather than assert it.
DO $$
DECLARE total int; coloured int; flexi int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE color IS NOT NULL), count(*) FILTER (WHERE flexible_break_enabled)
    INTO total, coloured, flexi FROM "shift";
  RAISE NOTICE '0457 shift colour + flexible break: % shifts, % with a colour (expected 0), % with a flexible break (expected 0 - the switch ships OFF so no attendance figure moves)',
    total, coloured, flexi;
END $$;
