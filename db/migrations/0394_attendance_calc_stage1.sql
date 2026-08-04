-- 7c834696 STAGE 1 — "Attendance Calculation Engine Enhancement": make the stored-but-inert attendance
-- settings actually calculate. Schema half only; 0395 backfills the new per-day figures.
--
-- ── WHAT WAS ALREADY THERE, AND WHY THIS MIGRATION IS SMALL ───────────────────────────────────────────
-- The rule library (0204), its OT band table, the shift→rule binding (shift.rule_id) and the four per-rate
-- OT columns on the Records screens ALL already exist. What did not exist is anywhere to PUT a calculated
-- figure: `attendance` stored `worked_minutes` and `ot_minutes` and nothing else, so lateness, early-out,
-- short-hours and the per-rate overtime split had no home and were either ignored (the deduction pair) or
-- guessed at read time from the frozen day_type (the rate split). Every column below is a new HOME for a
-- figure the engine can now derive; none of them replaces an existing one.
--
-- ── THE INVARIANT THIS MIGRATION MUST NOT BREAK ───────────────────────────────────────────────────────
-- `attendance.ot_minutes` STAYS THE CANONICAL TOTAL. core/payroll.ts (the OT prefill + the weekly
-- cross-cycle read), core/reporting.ts (the overtime report) and toil_accrual all read it, and none of
-- them is changed by this work. The five new per-rate columns are ADDITIVE and SUM BACK to `ot_minutes`
-- exactly — categorisation MOVES minutes between the rate columns, it never changes the total.
-- test/attendance-stage1-calc.test.ts pins that sum as an assertion, not as a comment.
--
-- ── DIRECTION OF EVERY COLUMN ────────────────────────────────────────────────────────────────────────
--   late_minutes / early_out_minutes / under_minutes  — NEUTRAL. New measured facts. Nothing reads them
--     for money; they exist so a day can say what happened. NULL on every historical row (0395 does not
--     invent them: they need the resolved shift, which SQL cannot resolve).
--   late_deduct_minutes / early_out_deduct_minutes    — the only DOWNWARD-capable figures in the change,
--     and they are shipped switched OFF on every rule (attendance_rule.apply_deductions DEFAULT false)
--     and can only ever be non-zero for attendance dates on/after deductions_effective_from, which the
--     service stamps to TODAY at the moment an admin turns the switch on. A closed payroll period can
--     therefore never acquire a deduction retroactively. The CHECK below makes that structural rather
--     than a promise: deductions ON without a start date is not a representable row.
--   ot_flat/ot00/ot10/ot15/ot20/ot30_minutes          — NEUTRAL in total (they sum to ot_minutes).
--
-- ── GRANTS / RLS: NOTHING IS OWED, STATED RATHER THAN ASSUMED ────────────────────────────────────────
-- No table is created here. `attendance` (0011), `attendance_rule` and `attendance_rule_ot_row` (0204,
-- re-scoped 0319) already carry their grants to ai_hr_app and their RLS policies, and a new COLUMN on an
-- existing table inherits both. A new enum LABEL carries no privileges of its own. ("No GRANT line" and
-- "GRANT line forgotten" look identical in a diff, so this is written down.)

-- ── 1 · attendance: the per-day figures the engine can now derive ────────────────────────────────────
-- All nullable, no defaults: NULL means "this day predates the engine that computes it", which is a
-- different statement from 0, and the read layer renders it as "—" rather than as a confident zero.
ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "late_minutes" integer;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "early_out_minutes" integer;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "under_minutes" integer;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "late_deduct_minutes" integer;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "early_out_deduct_minutes" integer;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "ot_flat_minutes" integer;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "ot00_minutes" integer;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "ot10_minutes" integer;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "ot15_minutes" integer;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "ot20_minutes" integer;--> statement-breakpoint
ALTER TABLE "attendance" ADD COLUMN IF NOT EXISTS "ot30_minutes" integer;--> statement-breakpoint

COMMENT ON COLUMN "attendance"."ot_flat_minutes" IS
  '7c834696 stage 1 — OT minutes categorised to a FLAT-rate band. ot_flat+ot00+ot10+ot15+ot20+ot30 = ot_minutes exactly; ot_minutes stays the canonical total every downstream reader (payroll, reporting, toil) uses.';--> statement-breakpoint
COMMENT ON COLUMN "attendance"."ot00_minutes" IS
  '7c834696 stage 1 — OT minutes at a configured rate of 0: recorded but not payable. Exists so the five rate buckets still sum to ot_minutes when a rule uses a 0 band.';--> statement-breakpoint
COMMENT ON COLUMN "attendance"."late_deduct_minutes" IS
  '7c834696 stage 1 — minutes deducted for lateness by the paired rule. 0/NULL unless that rule has apply_deductions AND the attendance date is on/after its deductions_effective_from. NEVER backfilled.';--> statement-breakpoint

-- ── 2 · attendance_rule: the deduction opt-in, shipped OFF ───────────────────────────────────────────
-- late_after_minutes / late_deduct_minutes (and the early-out pair) have been stored and editable since
-- 0204 and read by NOTHING. Switching them on for everybody at release would take minutes off people who
-- have never been told the setting was live, so the switch is per-rule and defaults FALSE — release day
-- changes no figure on any rule. `deductions_effective_from` is stamped by the service (never typed by a
-- human) to today-in-Kuala-Lumpur when the switch flips on, so "forward-dated only" is a property of the
-- data, not of anyone remembering to do it.
ALTER TABLE "attendance_rule" ADD COLUMN IF NOT EXISTS "apply_deductions" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_rule" ADD COLUMN IF NOT EXISTS "deductions_effective_from" date;--> statement-breakpoint

ALTER TABLE "attendance_rule" DROP CONSTRAINT IF EXISTS "attendance_rule_deductions_dated_check";--> statement-breakpoint
ALTER TABLE "attendance_rule" ADD CONSTRAINT "attendance_rule_deductions_dated_check"
  CHECK (apply_deductions = false OR deductions_effective_from IS NOT NULL);--> statement-breakpoint

-- Deliberately NOT added as a DB CHECK: the request's "X cannot exceed Y" rule on the (after X minutes →
-- deduct Y minutes) pair. Rules saved since 0204 were never validated, so an existing row may violate it
-- and a CHECK would abort this migration on production. It is enforced in normalizeInput (core/
-- attendance-rule.ts) on SAVE only — an offending stored rule keeps working and is refused the next time
-- someone edits it, with a message naming the two fields.

-- ── 3 · attendance_rule_ot_row: the per-band public-holiday rate ─────────────────────────────────────
-- Nullable on purpose: NULL = "this band has no separate holiday rate", and the split falls back to the
-- band's ordinary `rate`, which is exactly today's behaviour. A band only behaves differently on a
-- holiday once someone fills this in.
ALTER TABLE "attendance_rule_ot_row" ADD COLUMN IF NOT EXISTS "ph_rate" numeric(6, 2);--> statement-breakpoint
COMMENT ON COLUMN "attendance_rule_ot_row"."ph_rate" IS
  '7c834696 stage 1 — the multiplier this band uses when the attendance day is a public holiday. NULL ⇒ use `rate` (today''s behaviour).';--> statement-breakpoint

-- ── 4 · the fourth overtime-approval option ──────────────────────────────────────────────────────────
-- ADR-0069 shipped three of the request's four options (requested / system_calculated / smaller_of);
-- `greater_of` was simply never added. drizzle wraps each migration file in ONE transaction and Postgres
-- 16 permits ADD VALUE inside one, but the new label cannot be CAST TO or COMPARED AS the enum type in
-- that same transaction (see 0294 / 0392 headers). Nothing below uses the label — this is the last
-- statement in the file — so one file is legal here.
ALTER TYPE "ot_approval_calculation" ADD VALUE IF NOT EXISTS 'greater_of';
