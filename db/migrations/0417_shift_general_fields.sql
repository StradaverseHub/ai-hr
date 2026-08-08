-- cf21e554 STAGE 1 — Shift Setting: the eight missing General-tab boxes, plus the Description the
-- reporter's own shift name is currently carrying.
--
-- WHY EVERY COLUMN IS NULLABLE WITH NO DEFAULT. The reporter was promised, in writing, that "nothing
-- already saved changes: your nine live shifts keep their times, breaks, working days and premiums exactly
-- as they are, and every new box starts empty." A DEFAULT on any of these would be a silent data change on
-- 11 production rows (9 live + 2 archived) and would make two of them (normal_hours_rounding_minutes,
-- half_day_first_out) start moving real attendance figures the moment the migration ran. NULL is the only
-- value that means "this shift does not use this box", which is what every existing row must keep saying.
-- There is deliberately NO backfill.
--
-- WHICH OF THESE MOVE A FIGURE (the honest split, mirrored in the UI's own per-box notes):
--   • normal_hours_rounding_minutes — APPLIED, inside core/attendance.ts netScheduledMinutes.
--   • half_day_first_out           — APPLIED, wins over attendance_policy.half_day_before for this shift.
--   • early_in / late_out / late_out_next_day / half_day_second_in — recorded, validated, displayed.
--   • day_type / category / full_day_leave_minutes / full_day_ot_minutes — RECORDED ONLY (stage 1). The
--     plan says so on the box itself so nobody fills one in and expects a different pay result.
--
-- day_type's CHECK deliberately reuses THIS PRODUCT'S OWN vocabulary (core/attendance.ts DayType:
-- workday / rest_day / holiday) rather than guessing the legacy HRMS's enum from a screenshot. The
-- reference screen showed the box, not its dropdown.

ALTER TABLE "shift" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint
ALTER TABLE "shift" ADD COLUMN IF NOT EXISTS "day_type" text;--> statement-breakpoint
ALTER TABLE "shift" ADD COLUMN IF NOT EXISTS "category" text;--> statement-breakpoint
ALTER TABLE "shift" ADD COLUMN IF NOT EXISTS "early_in" time;--> statement-breakpoint
ALTER TABLE "shift" ADD COLUMN IF NOT EXISTS "late_out" time;--> statement-breakpoint
-- The reference screen's "0430+" marker: a latest-clock-out that falls on the day AFTER the shift's own
-- date. Nullable boolean, not NOT NULL DEFAULT false, so an untouched row keeps saying "not configured"
-- rather than "configured as same-day" — see the header.
ALTER TABLE "shift" ADD COLUMN IF NOT EXISTS "late_out_next_day" boolean;--> statement-breakpoint
ALTER TABLE "shift" ADD COLUMN IF NOT EXISTS "full_day_leave_minutes" integer;--> statement-breakpoint
ALTER TABLE "shift" ADD COLUMN IF NOT EXISTS "normal_hours_rounding_minutes" integer;--> statement-breakpoint
ALTER TABLE "shift" ADD COLUMN IF NOT EXISTS "full_day_ot_minutes" integer;--> statement-breakpoint
ALTER TABLE "shift" ADD COLUMN IF NOT EXISTS "half_day_first_out" time;--> statement-breakpoint
ALTER TABLE "shift" ADD COLUMN IF NOT EXISTS "half_day_second_in" time;--> statement-breakpoint

-- ── CHECKs ───────────────────────────────────────────────────────────────────────────────────────────
-- All NULL-tolerant (a CHECK passes on NULL), so they cannot fail against existing rows. Added with the
-- DO-block idempotence guard the repo uses elsewhere: ALTER TABLE ... ADD CONSTRAINT has no IF NOT EXISTS.
DO $$ BEGIN
  ALTER TABLE "shift" ADD CONSTRAINT "shift_day_type_ck"
    CHECK ("day_type" IS NULL OR "day_type" IN ('workday', 'rest_day', 'holiday'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "shift" ADD CONSTRAINT "shift_full_day_leave_minutes_ck"
    CHECK ("full_day_leave_minutes" IS NULL OR ("full_day_leave_minutes" >= 0 AND "full_day_leave_minutes" <= 1440));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "shift" ADD CONSTRAINT "shift_full_day_ot_minutes_ck"
    CHECK ("full_day_ot_minutes" IS NULL OR ("full_day_ot_minutes" >= 0 AND "full_day_ot_minutes" <= 1440));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Rounding is a MULTIPLE, in minutes, applied to the shift's net scheduled minutes. 0 is allowed and means
-- "no rounding" (identical to NULL); the upper bound is a day, because a rounding unit larger than the
-- shift itself can only ever floor the schedule to zero.
DO $$ BEGIN
  ALTER TABLE "shift" ADD CONSTRAINT "shift_normal_hours_rounding_minutes_ck"
    CHECK ("normal_hours_rounding_minutes" IS NULL OR ("normal_hours_rounding_minutes" >= 0 AND "normal_hours_rounding_minutes" <= 1440));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- The half-day PAIR: morning clock-out strictly before afternoon clock-in. Only constrains rows that set
-- BOTH (a shift may carry just the morning cut-off, which is the one that replaces the company-wide
-- attendance_policy.half_day_before).
DO $$ BEGIN
  ALTER TABLE "shift" ADD CONSTRAINT "shift_half_day_pair_ck"
    CHECK ("half_day_first_out" IS NULL OR "half_day_second_in" IS NULL OR "half_day_first_out" < "half_day_second_in");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
