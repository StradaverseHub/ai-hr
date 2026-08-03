-- 0375 — the two columns Simplify Earning Method Configuration needs (bc36c768). SCHEMA ONLY.
--
-- Split from the clear-out (0376) on purpose. This file is reversible and moves nothing; 0376 is the
-- one-off reset that erases live configuration. Landing them as one file would make a rollback of the
-- reset a rollback of the storage it needs.
--
-- ADR/PLAN: .plans/bc36c768.txt
--
-- NO GRANT STATEMENT IS NEEDED OR CORRECT HERE: both statements ADD A COLUMN to an existing table, and
-- column privileges are inherited from the table grant. (A migration that CREATES a table does need its
-- own `GRANT SELECT, INSERT, UPDATE, DELETE ON <t> TO ai_hr_app;` — 0353 forgot one and only production's
-- ALTER DEFAULT PRIVILEGES hid it.)

-- ── 1. accrual_day — which day of the month Monthly Accrual credits on ───────────────────────────────
--
-- NULL means day 1, which is what every existing row means: `accrualPeriods` has always counted whole
-- months inclusive of the current one, i.e. today's behaviour is hard-wired to "day 1". The default is
-- therefore ABSENCE, not a stored 1 — a backfilled 1 would be indistinguishable from a deliberate choice
-- and would make "never configured" unreadable a year from now.
--
-- The CHECK is 1..31 and NOT "1..the length of this month", because the column has no month. A day past
-- the end of a short month is legal and MEANS something: `effectiveAccrualDay` clamps it to that month's
-- last day, so 31 credits on 28 February (29 in a leap year) and no month is ever skipped.
ALTER TABLE "leave_type" ADD COLUMN IF NOT EXISTS "accrual_day" integer;--> statement-breakpoint
ALTER TABLE "leave_type" DROP CONSTRAINT IF EXISTS "leave_type_accrual_day_check";--> statement-breakpoint
ALTER TABLE "leave_type"
	ADD CONSTRAINT "leave_type_accrual_day_check"
	CHECK ("accrual_day" IS NULL OR ("accrual_day" >= 1 AND "accrual_day" <= 31));--> statement-breakpoint

-- ── 2. accrual_unconfigured — THE NOT-CONFIGURED MARKER ──────────────────────────────────────────────
--
-- This is what makes the 0376 reset safe, and it is the heart of the item. A leave type carrying this
-- timestamp grants nothing and earns nothing: not at hire, not on the monthly accrual run, not when
-- routine HR work (a grade correction, an employment-type change, a movement, a scheme assignment)
-- triggers a reprojection. It is cleared the moment setLeaveTypeRules writes a non-null accrual_method.
--
-- WHY A MARKER AND NOT SIMPLY A BLANK METHOD, which is the obvious reading of "clear the setting". A NULL
-- accrual_method is read by every engine as the LUMP path — so a blanked leave type would credit a new
-- joiner a full year's entitlement on the spot, and nothing in this system can claw a credited day back.
-- Worse, projectExpectedEntitlement would take its `hiredOn >= windowStart ? prorate : days` branch and
-- return the FULL annual figure for an existing employee, and the delta over the accrued-to-date ledger
-- would post as an UPWARD `sys:profile_recalc:` correction the next time anyone edited that employee's
-- profile. The marker removes both outright.
--
-- timestamptz rather than boolean: WHEN a type was reset is the only fact that distinguishes "cleared by
-- the 0376 reset" from "created afterwards and never configured", and the two want different follow-up.
ALTER TABLE "leave_type" ADD COLUMN IF NOT EXISTS "accrual_unconfigured" timestamptz;
