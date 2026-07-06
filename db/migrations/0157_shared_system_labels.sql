-- Shared System Labels — multi-company assignment (ADR-0073, feedback d356dec8).
--
-- PHASE 1 of the phased rollout in the approved plan: SCHEMA + BACKFILL only, ADDITIVE, behind an
-- OFF-by-default per-company flag (company.shared_system_labels). Phase 4 (the Excel-style grid UI) ships in
-- a SEPARATE change once this model has baked — do NOT bundle them.
--
-- The model (why it is the safe one): we do NOT strip company_id off the four org tables — that single move
-- would break their write-RLS (is_admin_for(company_id)), every consumer read that filters
-- inArray(<table>.company_id, companyIds), and the mental model that assignment.department_id resolves to a
-- company. Instead:
--   1. Each label KEEPS its single owning company_id (its "origin"); its row + its write-RLS are unchanged.
--   2. A new junction `label_company_assignment` gives a label ADDITIONAL companies that may use it.
--   3. A new is_global flag on each org table = "All Companies" (resolves to every company in the tenant
--      without writing N junction rows), so adding a company later needs no backfill of global labels.
--   4. A resolver (core/system-labels.ts) unions origin ∪ junction ∪ global; every consumer reads through it.
--      With the flag OFF the resolver returns ORIGIN-ONLY, so behaviour is byte-identical to today.
--
-- Backward-compat: we backfill one self-assignment (origin company) per existing label row, so
-- "companies that may use label X" = origin ∪ junction = exactly the origin for all legacy data. Existing
-- `assignment` and `leave_approval_policy` FKs stay valid because label ids and rows are preserved.
--
-- Idempotent + forward-only (test DB is rebuilt forward-only — a botched migration otherwise causes phantom
-- RLS-test failures): IF NOT EXISTS on every DDL, ON CONFLICT DO NOTHING on the backfill.
--
-- Journal entry: idx 157 (see meta/_journal.json). PLACEHOLDER NUMBER — the integration step may renumber
-- this migration; it is self-contained and idempotent, so the exact index is not load-bearing.

-- ── 1. Feature flag (off by default) ────────────────────────────────────────────────────────────────
ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "shared_system_labels" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- ── 2. is_global "All Companies" flag on each of the four org tables (additive, default false) ───────
ALTER TABLE "position" ADD COLUMN IF NOT EXISTS "is_global" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "business_unit" ADD COLUMN IF NOT EXISTS "is_global" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "department" ADD COLUMN IF NOT EXISTS "is_global" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "cost_center" ADD COLUMN IF NOT EXISTS "is_global" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- ── 3. Junction table: a label → an additional company that may use it ──────────────────────────────
-- label_kind is one of the four kinds; label_id is a polymorphic key (no DB FK, spans four tables — the
-- service validates it). Origin company_id is NOT stored here; it lives on the label row and is unioned in
-- by the resolver, so an origin never needs a junction row (though the backfill writes one for symmetry).
CREATE TABLE IF NOT EXISTS "label_company_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"label_kind" text NOT NULL,
	"label_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "label_company_assignment" ADD CONSTRAINT "label_company_assignment_tenant_id_tenant_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "label_company_assignment" ADD CONSTRAINT "label_company_assignment_company_id_company_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "label_company_assignment" ADD CONSTRAINT "label_company_assignment_kind_ck"
    CHECK ("label_kind" IN ('department', 'position', 'cost_center', 'business_unit'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "label_company_assignment_uq"
  ON "label_company_assignment" ("tenant_id", "label_kind", "label_id", "company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "label_company_assignment_company_idx"
  ON "label_company_assignment" ("company_id", "label_kind");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "label_company_assignment_label_idx"
  ON "label_company_assignment" ("label_kind", "label_id");--> statement-breakpoint

-- ── 4. RLS on the junction ──────────────────────────────────────────────────────────────────────────
-- Read is TENANT-WIDE (the resolver is read by non-admin dropdown paths — an admin-only SELECT would silently
-- filter shared labels to nothing for non-admins, the exact bug the 0128/0136 headers warn about). WRITE is
-- restricted to an admin of the company being assigned/unassigned (is_admin_for(company_id)) — you may only
-- add or remove a company you administer. Explicit ai_hr_app grants (the fail-closed convention from 0136).
ALTER TABLE "label_company_assignment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "label_company_assignment" TO ai_hr_app;--> statement-breakpoint
DROP POLICY IF EXISTS "label_company_assignment_rls" ON "label_company_assignment";--> statement-breakpoint
CREATE POLICY "label_company_assignment_rls" ON "label_company_assignment" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));--> statement-breakpoint

-- ── 5. is_global write-gate: only a GROUP admin may declare a label global ──────────────────────────
-- The is_global flag makes a label span EVERY company in the tenant, so it is a group-level decision, not a
-- per-company one. Guard it with per-row trigger functions that reject setting is_global=true unless the
-- session is a group admin (app.is_group_admin()). Per-company admins keep full control of their own labels'
-- other columns; they simply cannot flip the group-wide global flag. (The base table write-RLS is unchanged:
-- is_admin_for(company_id) still gates who may write the row at all.)
CREATE OR REPLACE FUNCTION app.guard_is_global() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_global = true
     AND (TG_OP = 'INSERT' OR OLD.is_global IS DISTINCT FROM NEW.is_global)
     AND NOT app.is_group_admin() THEN
    RAISE EXCEPTION 'Only a group admin may make a system label global (is_global)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "position_is_global_guard" ON "position";--> statement-breakpoint
CREATE TRIGGER "position_is_global_guard" BEFORE INSERT OR UPDATE ON "position"
  FOR EACH ROW EXECUTE FUNCTION app.guard_is_global();--> statement-breakpoint
DROP TRIGGER IF EXISTS "business_unit_is_global_guard" ON "business_unit";--> statement-breakpoint
CREATE TRIGGER "business_unit_is_global_guard" BEFORE INSERT OR UPDATE ON "business_unit"
  FOR EACH ROW EXECUTE FUNCTION app.guard_is_global();--> statement-breakpoint
DROP TRIGGER IF EXISTS "department_is_global_guard" ON "department";--> statement-breakpoint
CREATE TRIGGER "department_is_global_guard" BEFORE INSERT OR UPDATE ON "department"
  FOR EACH ROW EXECUTE FUNCTION app.guard_is_global();--> statement-breakpoint
DROP TRIGGER IF EXISTS "cost_center_is_global_guard" ON "cost_center";--> statement-breakpoint
CREATE TRIGGER "cost_center_is_global_guard" BEFORE INSERT OR UPDATE ON "cost_center"
  FOR EACH ROW EXECUTE FUNCTION app.guard_is_global();--> statement-breakpoint

-- ── 6. Backfill: one self-assignment (origin company) per existing label row ────────────────────────
-- After this, "companies that may use label X" = origin ∪ junction, which for legacy data = origin exactly.
-- ON CONFLICT DO NOTHING makes re-running the migration safe.
INSERT INTO "label_company_assignment" ("tenant_id", "label_kind", "label_id", "company_id")
  SELECT "tenant_id", 'department', "id", "company_id" FROM "department"
  ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "label_company_assignment" ("tenant_id", "label_kind", "label_id", "company_id")
  SELECT "tenant_id", 'position', "id", "company_id" FROM "position"
  ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "label_company_assignment" ("tenant_id", "label_kind", "label_id", "company_id")
  SELECT "tenant_id", 'cost_center', "id", "company_id" FROM "cost_center"
  ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "label_company_assignment" ("tenant_id", "label_kind", "label_id", "company_id")
  SELECT "tenant_id", 'business_unit', "id", "company_id" FROM "business_unit"
  ON CONFLICT DO NOTHING;
