-- f9afd1ce rev 2 (r267) — clocking_location gains ONE nullable column: report_label.
--
-- ── WHAT AND WHY ──────────────────────────────────────────────────────────────────────────────────────
-- The reporter's contest after r264 restated the configuration screen and asked for a short "report
-- label" on a site: the Attendance report's Clocking Location column prints the full site name today
-- ("HQ Tower — North Gate"), and a report column wants something shorter ("HQ"). This column is that
-- label. BLANK MEANS THE NAME: core/reporting.ts reads coalesce(report_label, name) for that ONE column;
-- the locations list, the employee's profile and the clock-in screen keep printing the name.
--
-- ── NO DATA STEP, NO CHECK, RLS INHERITED ─────────────────────────────────────────────────────────────
-- Measured on production 2026-09-11 (SELECT-only): clocking_location held 0 rows (0 archived), so there
-- is nothing to backfill and the DO block below simply REPORTS what it finds. The blank-means-name rule
-- is enforced where it is decided — the service trims and stores NULL for an empty label — not as a
-- CHECK (a NOT VALID check still fires on every UPDATE; CLAUDE.md §6). The 0459 policies govern the
-- table by row, not by column, so a nullable column needs no policy change and no GRANT (nothing is
-- created; the 0144 table grant carries over).
--
-- Journal entry: idx 461 (see meta/_journal.json).

DO $$
DECLARE total int;
BEGIN
  SELECT count(*) INTO total FROM clocking_location;
  RAISE NOTICE '0461 clocking_location.report_label added (nullable): % existing rows keep a NULL label, i.e. the report prints their name. Expected 0 (production measured 2026-09-11).', total;
END $$;
--> statement-breakpoint
ALTER TABLE "clocking_location" ADD COLUMN "report_label" text;
