-- 18504ca6 — EFFECTIVE DATE ON THE SHIFT ARRANGEMENT CARD.
--
-- THE ASYMMETRY THIS CLOSES. On the personnel Attendance tab the Location card asks for an effective date
-- and the Shift arrangement card directly below it does not. Saving a shift UPDATEs employment.shift_type +
-- employment.default_shift_id IN PLACE (core/roster.ts assignEmployeeShift), so the previous shift is gone:
-- the system cannot answer "which shift was this person on last month", and any day later corrected or
-- re-imported is re-measured against TODAY's shift because today's shift is the only one on file.
--
-- WHY A DATED LADDER AND NOT A MOVEMENT KIND. Mirrors the compensation ladder (valid_from / valid_to /
-- superseded_at, core/comp.ts) rather than the Movement module: core/movement-kinds.ts pins behaviour to a
-- fixed MOVEMENT_KINDS list with no shift kind, and shift is not an assignment field — inventing one would
-- create a SECOND writer for a truth the Shift arrangement card already owns (the 8ebabbf2 rule).
--
-- employment.default_shift_id SURVIVES AS A CACHE, not as the source of truth. It keeps being written with
-- the value in force at save time so every existing reader keeps working; the resolvers read this ladder
-- first and fall back to the cache only for an employment that has NO ladder row at all (a legacy write, or
-- the b8aa3466 backup-shift backfill, which only touches employments that have no shift and therefore no
-- row here). That fallback is what makes this migration behaviour-neutral for code paths not yet converted.
--
-- PERIODS CANNOT OVERLAP because each row simply runs until the next one begins: valid_to is closed to the
-- day before the successor's valid_from when a change is saved, and resolution picks the greatest
-- valid_from <= the date being asked about. There is no scheduled job — resolution is by date at read time.

CREATE TABLE IF NOT EXISTS "employment_shift_arrangement" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  "employment_id" uuid NOT NULL REFERENCES "employment"("id"),
  -- The reporter's "Shift type" (Fixed / Roster). Carried per PERIOD, not per employee, so the history row
  -- says which arrangement was in force as well as which shift. Mirrors employment.shift_type's values;
  -- a CHECK rather than a pg enum for the same reason compensation.payment_term is text — a new arrangement
  -- would otherwise need a migration to widen an enum this table does not own.
  "shift_type" text NOT NULL,
  -- NOT NULL: b8aa3466 made the backup shift mandatory on BOTH arrangements, so there is no such thing as a
  -- dated period with no shift. ON DELETE is deliberately absent (no action): core/roster.ts deleteShift
  -- refuses to hard-delete a referenced shift and steers HR to Archive, and this table is one more reference.
  "shift_id" uuid NOT NULL REFERENCES "shift"("id"),
  "valid_from" date NOT NULL,
  -- Closed to the day BEFORE the successor's valid_from. NULL = the open, current period.
  "valid_to" date,
  -- Set when a save for the SAME valid_from replaces this entry (the "saving twice for one date replaces it
  -- rather than creating a second" rule). A superseded row is invisible to every resolver.
  "superseded_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  -- Who moved them. NULL on the rows this migration backfills — nobody made that change, it is the shift the
  -- employee already had, recorded as applying since their start date (the card renders it as such).
  "created_by" uuid REFERENCES "app_user"("id"),
  CONSTRAINT "employment_shift_arrangement_type_ck" CHECK ("shift_type" IN ('fixed', 'roster')),
  -- A period cannot end before it begins.
  CONSTRAINT "employment_shift_arrangement_range_ck" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from")
);
--> statement-breakpoint

-- One LIVE entry per (employee, effective date): the DB backstop for the same-date replace rule, so a
-- double submit cannot leave two rows claiming the same start and make resolution depend on row order.
-- Partial on superseded_at IS NULL because a replaced row keeps its valid_from for the audit trail.
CREATE UNIQUE INDEX IF NOT EXISTS "employment_shift_arrangement_live_uq"
  ON "employment_shift_arrangement" ("tenant_id", "employment_id", "valid_from")
  WHERE "superseded_at" IS NULL;
--> statement-breakpoint

-- The resolver's read: every live period of one employee, ordered by start date.
CREATE INDEX IF NOT EXISTS "employment_shift_arrangement_emp_idx"
  ON "employment_shift_arrangement" ("tenant_id", "employment_id", "valid_from");
--> statement-breakpoint

-- ── GRANTS ───────────────────────────────────────────────────────────────────────────────────────────
-- Explicit, and NOT optional: production's ALTER DEFAULT PRIVILEGES masks an omission here, so a restored
-- developer cluster is where "permission denied for table employment_shift_arrangement" would surface — on
-- the first render of the Attendance tab, after the deploy. Same reasoning as 0418 / 0419 / 0420.
GRANT SELECT, INSERT, UPDATE, DELETE ON "employment_shift_arrangement" TO ai_hr_app;
--> statement-breakpoint

-- ── RLS ──────────────────────────────────────────────────────────────────────────────────────────────
-- Mirrors roster_assignment (migration 0075) EXACTLY, because it answers the same question about the same
-- subject: who may see / administer THIS employee's schedule. Read is can_see_employment (so an employee
-- and their manager can read their own shift history); write is can_admin_employment (HR only).
ALTER TABLE "employment_shift_arrangement" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "employment_shift_arrangement_rls" ON "employment_shift_arrangement";
--> statement-breakpoint
CREATE POLICY "employment_shift_arrangement_rls" ON "employment_shift_arrangement" FOR ALL
  USING ("tenant_id" = app.current_tenant_id() AND app.can_see_employment("employment_id"))
  WITH CHECK ("tenant_id" = app.current_tenant_id() AND app.can_admin_employment("employment_id"));
--> statement-breakpoint

-- ── BACKFILL — THIS IS WHAT MAKES THE RELEASE BEHAVIOUR-NEUTRAL ──────────────────────────────────────
-- One OPEN row per employment that has a backup shift today, starting at the employee's own start date, and
-- carrying the shift_type and default_shift_id they already have. Every historical date therefore still
-- resolves to exactly the shift it resolves to now: no figure moves, no screen moves, until somebody makes
-- a change on the card.
--
-- coalesce(hired_on, join_date, created_at::date) — hired_on is NOT NULL today, but the SAME expression is
-- what core/shift-arrangement.ts validates a new effective date against, and the two must not be able to
-- drift apart (an employment whose hired_on ever became nullable would otherwise get a NULL valid_from here
-- and a rejected save there).
INSERT INTO "employment_shift_arrangement"
  ("tenant_id", "employment_id", "shift_type", "shift_id", "valid_from", "valid_to", "created_by")
SELECT
  e."tenant_id",
  e."id",
  COALESCE(e."shift_type", 'fixed'),
  e."default_shift_id",
  COALESCE(e."hired_on", e."join_date", e."created_at"::date),
  NULL,
  NULL
FROM "employment" e
WHERE e."default_shift_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "employment_shift_arrangement" a
    WHERE a."employment_id" = e."id" AND a."superseded_at" IS NULL
  );
