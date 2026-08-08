-- 1fff489c PHASE 1 — the radius belongs on the SITE, and a clocking point belongs to a Location.
--
-- WHY THIS EXISTS. Geofencing is already enforced (ADR-0070) — the reporter's "radius currently missing
-- entirely" is wrong in detail. The radius exists, but on EMPLOYMENT (geofencing_enabled +
-- geofence_radius_m), i.e. ONE number per PERSON covering every site they clock at. A 150 m office and a
-- 500 m project yard therefore cannot both be right for the same employee. This migration moves the
-- allowed distance onto the thing it actually describes.
--
-- WHY BOTH COLUMNS ARE NULLABLE. The admin form makes both required (core/clocking-location.ts refuses a
-- create/update without them), but the DATABASE stays permissive so nothing can break on the way in.
-- Production measurement 2026-08-07: ZERO clocking_location rows exist across all nine companies, so
-- there is nothing to backfill and a NOT NULL would only be a deploy-ordering hazard for no gain.
--
-- location_id is a plain FK with NO ON DELETE clause: `location` is archive-only (core/location.ts has no
-- delete), so the default RESTRICT is the correct answer — it makes a hypothetical hard delete of a
-- location that still has clocking points fail loudly instead of orphaning the points.

ALTER TABLE "clocking_location" ADD COLUMN IF NOT EXISTS "radius_m" integer;--> statement-breakpoint
ALTER TABLE "clocking_location" ADD COLUMN IF NOT EXISTS "location_id" uuid;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "clocking_location" ADD CONSTRAINT "clocking_location_location_id_fk"
    FOREIGN KEY ("location_id") REFERENCES "location"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- NULL-tolerant (a CHECK passes on NULL), so it cannot fail against an existing row. A zero or negative
-- radius is a geofence nobody can ever satisfy — refuse it at the storage layer, not just in the form.
DO $$ BEGIN
  ALTER TABLE "clocking_location" ADD CONSTRAINT "clocking_location_radius_m_ck"
    CHECK ("radius_m" IS NULL OR "radius_m" > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- The two reads this column was added for: the admin page's grouping (points under one location) and the
-- personnel card's pre-tick (points whose location matches the employee's confirmed location).
CREATE INDEX IF NOT EXISTS "clocking_location_location_idx"
  ON "clocking_location" ("tenant_id", "location_id");--> statement-breakpoint

-- ── The employment radius becomes an OPTIONAL OVERRIDE ───────────────────────────────────────────────
-- resolveGeofence now reads employment.geofence_radius_m only as a per-EMPLOYEE override and falls back to
-- the site's own radius_m. That means geofencing may legitimately be ENABLED with a blank override, which
-- the 0144 CHECK forbids. Dropping it is safe: production has 0 employments with geofencing_enabled, so no
-- row is relying on the constraint and none can be left in a state it used to prevent.
ALTER TABLE "employment" DROP CONSTRAINT IF EXISTS "employment_geofence_radius_required";--> statement-breakpoint

-- ── GRANTS ───────────────────────────────────────────────────────────────────────────────────────────
-- Table-level grants already cover every column, present and future, so these are a RE-ASSERTION rather
-- than a fix — kept because production's ALTER DEFAULT PRIVILEGES masks an omission and a restored
-- developer cluster is where a missing grant would surface (same reasoning as 0399/0400/0418).
GRANT SELECT, INSERT, UPDATE, DELETE ON "clocking_location" TO ai_hr_app;
