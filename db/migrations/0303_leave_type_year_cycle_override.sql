-- Feedback e1a51aea: Leave Type configuration — per-type Leave Year Type override.
--
-- leave_type.year_cycle_override: an OPTIONAL per-type override of the company's leave cycle
-- (company.leave_cycle, ADR-0040 2D-2). NULL (every existing row) = follow the company cycle exactly as
-- today — no behaviour change without an explicit choice. Closed value set:
--   'a2a' — Anniversary to Anniversary: this type runs on the employee's hire-month anniversary cycle
--           (the existing 'anniversary' semantics), even when the company cycle is calendar.
--   'c2c' — Calendar to Calendar: this type runs on the calendar year (the existing 'calendar'
--           semantics), even when the company cycle is anniversary.
-- The third dropdown option the reporter specified — 'a2c' (Anniversary to Calendar hybrid) — is shown
-- DISABLED in the UI and REJECTED by the service (updateLeaveType): the engine has no hybrid-year
-- calculation semantics yet, and building new payout mathematics inside a screen restructure is out of
-- scope (see the item's GOOD TO KNOW). The CHECK below therefore admits only the two live values.
--
-- Journal entry: idx 303 (see meta/_journal.json).

ALTER TABLE "leave_type" ADD COLUMN "year_cycle_override" text;--> statement-breakpoint
ALTER TABLE "leave_type" ADD CONSTRAINT "leave_type_year_cycle_override_check" CHECK ("year_cycle_override" IN ('a2a', 'c2c'));
