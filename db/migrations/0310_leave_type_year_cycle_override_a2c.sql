-- Feedback f3a64d90: Anniversary to Calendar (a2c) leave year type — ENABLEMENT.
--
-- Migration 0303 introduced leave_type.year_cycle_override with a CHECK admitting only ('a2a','c2c'):
-- the third dropdown option the reporter specified — 'a2c' (Anniversary to Calendar) — was rendered
-- DISABLED and rejected by updateLeaveType because the engine had no first-year calculation for it.
--
-- That calculation now exists (core/leave.ts a2cFirstYearEntitledToDate): in the HIRE year the ANNUAL
-- entitlement builds day-by-day from the join date to 31-Dec at (entitlement / 365) × days worked to
-- date, clamped to the annual entitlement (leap-safe); from the next 1-Jan the type simply runs on the
-- calendar year (resolveLeaveYearCycle maps 'a2c' → 'calendar', so year two onward is byte-identical to
-- an ordinary calendar type — no new cycle token, no new granting engine).
--
-- Widen the CHECK so the now-live value can be stored. The app-layer membership test against
-- LEAVE_YEAR_CYCLE_OVERRIDES stays the primary guard; this CHECK is defence-in-depth (a hand-crafted
-- write can still never store a value the engine cannot compute).
--
-- Journal entry: idx 310 (see meta/_journal.json).

ALTER TABLE "leave_type" DROP CONSTRAINT "leave_type_year_cycle_override_check";--> statement-breakpoint
ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_year_cycle_override_check" CHECK ("year_cycle_override" IN ('a2a', 'c2c', 'a2c'));
