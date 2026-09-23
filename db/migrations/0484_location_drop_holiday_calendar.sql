-- ADR-0086 (item 0fe1ca2e, r331) — RETIRE `location.holiday_group_id`.
--
-- ── WHAT THIS REVERSES, AND ON WHOSE SAY-SO ─────────────────────────────────────────────────────────
--
-- ADR-0067 ("Configurable Public-Holiday Calendars by Location/Subsidiary", Accepted 2026-06-29) is a
-- real capability: a work site could carry its own named public-holiday calendar, so a Sabah site kept
-- Sabah's holidays without anyone editing an employee. This column IS §(b) of that decision.
--
-- Item 0fe1ca2e asked for the work-site register to be removed. That request revokes ADR-0067 §(b) and
-- §(c), so it went back to the reporter as a CAPABILITY question rather than a code deletion — unused is
-- not unwanted — and they approved the retirement. ADR-0086 records the reversal, the measurement behind
-- it, and what deliberately survives. Read it before reversing this.
--
-- ── MEASURED CROSS-TENANT ON PRODUCTION BEFORE ANY OF IT WAS BUILT ──────────────────────────────────
--
-- scripts/report-location-holiday-deltas.ts (r328, read-only, whole run inside SET TRANSACTION READ ONLY,
-- every tenant regardless of standing), run 2026-09-22/23:
--   · 8 `location` rows. All 8 carry a state override. ZERO map a holiday calendar — so this column is
--     exercised by no row anywhere, which is why the DROP below needs no data step.
--   · 1 open assignment points at a site. That employee's `employment.work_state` already carries the
--     site's state, so their 2026 calendar is 12 days before and 12 days after, Federal Territory Day
--     included. `holidays MOVE 0`.
--   · `EMPTY calendar both sides = 0` — a real all-clear, not the missing-data illusion that check exists
--     to catch. Every other failure shape the report can name (blocked-by-holiday-group, named-calendar,
--     no-state, ambiguous, archived-site) is also 0.
-- The DO block below re-proves the only part of that which this file depends on, on the box, at deploy
-- time, rather than trusting a report that was run three days earlier.
--
-- ── THE ORDER THIS FILE COMES LAST IN, AND WHY IT MATTERS ───────────────────────────────────────────
--
-- Nothing has read this column since the code change that ships with it: core/holidays.ts
-- `holidayDatesFor` and `effectiveHolidayState` both lost their `assignment` → `location` join in ONE
-- commit (ADR-0086 §6 step 3), the delete guard in core/admin.ts lost its location arm, and the Calendar
-- picker left app/admin/locations. A migration that dropped the column first would have left a running
-- deployment resolving holidays through a column that no longer exists.
--
-- ⚠️ THIS IS NOT REVERSIBLE BY RE-ADDING THE COLUMN. The mapping data itself is gone. On production there
-- is none to lose (0 of 8 rows), but a tenant that later wants per-site calendars is asking for ADR-0067
-- §(b) back, and would be re-mapping by hand.
--
-- ── WHAT THIS FILE DELIBERATELY DOES NOT DO ─────────────────────────────────────────────────────────
--
-- · `location` ITSELF STAYS. `clocking_location.location_id` (ADR-0070) is a live FK onto it, r322 settled
--   the Clocking Location form and its guard, and this item has no mandate to reopen either.
-- · `location.state` STAYS. Nothing reads it now, but it is the record of what a site's state WAS — the
--   value the r328 carry moved onto `employment.work_state` — and retiring it is a separate, smaller
--   decision than the one ADR-0086 makes.
-- · `location.branch` STAYS: branch mapping (1fff489c PHASE 2) is a second, live feature on this table.
-- · `assignment.location_id` STAYS, and NO CHECK CONSTRAINT is added to it. A `NOT VALID` check still
--   fires on every UPDATE (CLAUDE.md §6), and `core/org.ts` alone writes that row from six places
--   (hireEmployee, transferEmployee, terminateEmploymentTx, setEmploymentAssignment,
--   changeEmploymentCompany, transferEmploymentCompanyTx), plus core/movement.ts reverseLegTx,
--   scripts/backfill-assignment-company.ts and db/seed.ts. It is also HISTORY: core/movement.ts records
--   `locationId` in its from/to deltas and historical events already hold it.
-- · `holiday_group.archetype` and `employment.holiday_group_id` STAY — ADR-0067 §(a) is untouched and a
--   custom/extended calendar still reaches a person, directly, through their own profile.

DO $$
DECLARE total int; mapped int; assigned int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE holiday_group_id IS NOT NULL) INTO total, mapped FROM location;
  SELECT count(*) INTO assigned
    FROM assignment a
    JOIN location l ON l.id = a.location_id
   WHERE a.valid_to IS NULL AND a.superseded_at IS NULL AND l.holiday_group_id IS NOT NULL;

  -- STOP rather than silently move somebody's public holidays. A mapped calendar cannot be carried onto
  -- `employment.work_state` — a work state is a state, not a hand-picked day list — so if any employee's
  -- OPEN assignment points at a mapped site, dropping this column changes which days they are paid a
  -- holiday rate for and which days count as working days for leave. Production has none (measured above);
  -- a tenant that does gets a sentence naming the fix rather than a silent reclassification.
  IF assigned > 0 THEN
    RAISE EXCEPTION '0484 STOPPED before changing anything: % employee(s) have an open assignment at a work site that maps a named holiday calendar, and a work site is about to stop deciding holidays. A site calendar cannot be carried onto an employee''s work state. Assign those employees the calendar directly (Personnel › Holiday calendar) first, then deploy again.',
      assigned;
  END IF;

  RAISE NOTICE '0484 location holiday calendar retired (ADR-0086, supersedes ADR-0067 §(b)): % site(s), % mapping a calendar, % employee(s) affected. Expected 8 / 0 / 0 (production measured 2026-09-22); no data step, and holidays MOVE 0.',
    total, mapped, assigned;
END $$;--> statement-breakpoint

ALTER TABLE "location" DROP COLUMN "holiday_group_id";
