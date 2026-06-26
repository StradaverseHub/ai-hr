-- Holiday grouping — per-employee assignment over the EXISTING state holiday engine (ADR-0040 2C).
-- A "holiday group" is a NAMED bundle of states (MY_STATES labels). Holidays are NOT re-tagged: they stay
-- keyed on holiday.state only. At resolution an employee's group is expanded to its member states and fed
-- into the same `national ∪ holiday.state = ANY(states)` predicate the engine already uses. Assignment is
-- employment.holiday_group_id, mutually exclusive with employment.work_state (a group is "≥1 states", a
-- work_state is "exactly one"). All additive + backfill-safe: existing rows have holiday_group_id NULL, so
-- the XOR CHECK holds for every current row regardless of work_state.
CREATE TABLE "holiday_group" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenant"("id"),
  "name" text NOT NULL,
  "states" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- Case-insensitive per-tenant name uniqueness (org_catalog_integrity pattern, 0030).
CREATE UNIQUE INDEX "holiday_group_name_uq" ON "holiday_group" USING btree ("tenant_id", lower("name"));--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN "holiday_group_id" uuid REFERENCES "holiday_group"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "employment" ADD CONSTRAINT "employment_holiday_assignment_xor" CHECK ("work_state" IS NULL OR "holiday_group_id" IS NULL);--> statement-breakpoint
-- RLS mirroring 0006_holiday_rls.sql: tenant-scoped read for any member (the leave resolver SELECTs
-- groups); admin-only writes. GRANT targets ai_hr_app, not the owner (migrations/seed run as owner and
-- bypass RLS by design).
GRANT SELECT, INSERT, UPDATE, DELETE ON "holiday_group" TO ai_hr_app;--> statement-breakpoint
ALTER TABLE "holiday_group" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "holiday_group" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
