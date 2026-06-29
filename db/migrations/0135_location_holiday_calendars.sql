-- PH-calendars-by-location (ADR-0067). A THIN naming-and-mapping layer over the EXISTING holiday machinery
-- (ADR-0055 org-subtree cascade + wave-2C state holidays + ADR-0063 editable/tentative + ADR-0054 location
-- master data). No new holiday table, no new scope axis on `holiday` — so holiday_uq and the
-- holiday_scope_excl CHECK are untouched (zero seed-collision risk).
--
-- Two additive, backfill-safe changes:
--   1. holiday_group.archetype — labels a group as one of three calendar KINDS. Default 'standard' makes
--      every existing group identical to today (standard = the existing gazette/state path, no resolver
--      branch). 'extended' = gazette ∪ company ad-hoc; 'custom' = company ad-hoc only (no gazette).
--   2. location.holiday_group_id — the LOCATION → CALENDAR mapping. Null = unmapped → today's resolution.
--      ON DELETE SET NULL (mirrors employment.holiday_group_id): deleting a group un-maps locations rather
--      than erroring; the deleteHolidayGroup service guard is the friendly primary path, this FK the backstop.
--
-- holiday_group and location already have RLS (0100, 0111) and ai_hr_app grants; new columns inherit both.
-- No new table, no new policy, no index change.
CREATE TYPE "holiday_group_archetype" AS ENUM ('standard', 'extended', 'custom');--> statement-breakpoint
ALTER TABLE "holiday_group" ADD COLUMN "archetype" "holiday_group_archetype" DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "location" ADD COLUMN "holiday_group_id" uuid REFERENCES "holiday_group"("id") ON DELETE SET NULL;
