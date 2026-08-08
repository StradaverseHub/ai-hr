-- cf21e554 STAGE 2 — the shift's own Overtime Schedule tab: overtime windows BY CLOCK TIME.
--
-- WHY A NEW TABLE RATHER THAN attendance_rule_ot_row. The existing overtime library measures bands in
-- MINUTES PAST NORMAL (from_minutes / to_minutes) and belongs to a RULE, which several shifts share. The
-- reference screen's rows are wall-clock windows on ONE shift — "05:00–08:00" and "17:00–23:59" — with
-- their own minimum and maximum length and their own adjustment. Neither the unit nor the owner matches, so
-- folding them into the rule rows would have meant overloading two columns with a second meaning and
-- silently re-scoping every shift that shares a rule.
--
-- WHAT THIS TABLE DOES NOT DO. It does not round and it does not price. The engine reads these windows to
-- decide WHICH MINUTES COUNT, then hands the total to applyOtRuleRows exactly as before, so the rule's band
-- rounding and the statutory 1.5×/2×/3× rate cap keep owning rounding and pay. That ordering is asserted in
-- test/shift-ot-window.test.ts.
--
-- NOT IN THIS ROUND (present on the reference grid, deliberately absent here — a screenshot does not say
-- what they do): OT Shift, Next OT (if exceed max hours), OT Allowance.

CREATE TABLE IF NOT EXISTS "shift_ot_window" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  -- ON DELETE CASCADE: a window is part of its shift and unreadable without it. core/roster.ts deleteShift
  -- hard-deletes only an UNREFERENCED shift, so this cascade fires for a template created in error — which
  -- is exactly when its draft OT windows should go with it.
  "shift_id" uuid NOT NULL REFERENCES "shift"("id") ON DELETE CASCADE,
  "sort_order" integer NOT NULL DEFAULT 0,
  -- The reference grid's "OT" column: a name for the window ("Before shift", "Evening"). Optional.
  "label" text,
  "start_time" time NOT NULL,
  "end_time" time NOT NULL,
  -- The window ends on the day AFTER it starts (the reference's 17:00–23:59 row sits beside a next-day
  -- marker). NOT NULL DEFAULT false is safe here in a way it is not on `shift`: this table starts empty.
  "end_next_day" boolean NOT NULL DEFAULT false,
  -- Min.Hrs / Max.Hrs, in MINUTES. Below the minimum the window contributes nothing; above the maximum it
  -- is clamped. NULL = unbounded on that side.
  "min_minutes" integer,
  "max_minutes" integer,
  -- The reference row reading "0030-" against "0130" on a shift named "WITH 0.5 OT HOUR ADJ": once this
  -- window's overtime reaches adjust_after_minutes, add adjust_delta_minutes to it. The delta is SIGNED —
  -- −30 is the reporter's deduction; a positive value is an uplift. Both columns or neither.
  "adjust_after_minutes" integer,
  "adjust_delta_minutes" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "shift_ot_window_sort_order_ck" CHECK ("sort_order" >= 0),
  CONSTRAINT "shift_ot_window_min_ck" CHECK ("min_minutes" IS NULL OR "min_minutes" >= 0),
  CONSTRAINT "shift_ot_window_max_ck" CHECK ("max_minutes" IS NULL OR "max_minutes" >= 0),
  CONSTRAINT "shift_ot_window_min_max_ck"
    CHECK ("min_minutes" IS NULL OR "max_minutes" IS NULL OR "min_minutes" <= "max_minutes"),
  CONSTRAINT "shift_ot_window_adjust_after_ck" CHECK ("adjust_after_minutes" IS NULL OR "adjust_after_minutes" >= 0),
  -- An adjustment is a PAIR. "After 90 minutes" with no delta, or a delta with no threshold, is a half-set
  -- rule the engine would have to guess at — refuse it at the storage layer instead.
  CONSTRAINT "shift_ot_window_adjust_pair_ck"
    CHECK (("adjust_after_minutes" IS NULL) = ("adjust_delta_minutes" IS NULL))
);
--> statement-breakpoint

-- The engine's read: every window of one shift, in display order.
CREATE INDEX IF NOT EXISTS "shift_ot_window_shift_idx" ON "shift_ot_window" ("tenant_id", "shift_id", "sort_order");
--> statement-breakpoint

-- One row per position on a shift's grid, so a re-save cannot leave two rows claiming Sequence 2 and make
-- the order (and therefore which adjustment applies to which window) depend on physical row order.
CREATE UNIQUE INDEX IF NOT EXISTS "shift_ot_window_shift_sort_uq" ON "shift_ot_window" ("shift_id", "sort_order");
--> statement-breakpoint

-- ── GRANTS ───────────────────────────────────────────────────────────────────────────────────────────
-- Explicit, and NOT optional: production's ALTER DEFAULT PRIVILEGES masks an omission here, so a restored
-- developer cluster is where "permission denied for table shift_ot_window" would surface — on the first
-- render of the Shift Settings page, after the deploy. Same reasoning as 0399 / 0400 / 0396.
GRANT SELECT, INSERT, UPDATE, DELETE ON "shift_ot_window" TO ai_hr_app;
--> statement-breakpoint

-- ── RLS ──────────────────────────────────────────────────────────────────────────────────────────────
-- Mirrors `shift` itself (migration 0197): tenant-wide READ so the roster/attendance engine resolves a
-- window for any employee, tenant-ADMIN write via app.is_admin(). is_admin_for(company_id) is not usable —
-- shifts are tenant-global and carry a NULL company_id, which is precisely why 0197 moved off it.
ALTER TABLE "shift_ot_window" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS "shift_ot_window_rls" ON "shift_ot_window";
--> statement-breakpoint
CREATE POLICY "shift_ot_window_rls" ON "shift_ot_window" FOR ALL
  USING ("tenant_id" = app.current_tenant_id())
  WITH CHECK ("tenant_id" = app.current_tenant_id() AND app.is_admin());
