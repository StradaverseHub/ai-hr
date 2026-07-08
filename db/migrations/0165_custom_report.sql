-- Custom Report Builder (ADR-0074, feedback c440b365). A user-defined report is a NAME + a chosen
-- dataset from a CLOSED registry (core/report-registry.ts) + a declarative `spec` (chosen columns,
-- filters, sort, grouping, layout properties) stored as JSONB. There is NO free-form SQL: the spec only
-- ever names dataset/field ids the registry already exposes, and each dataset's underlying read enforces
-- tenant RLS + company scope, so a saved report can only ever project columns of rows the runner could
-- already see. This is the same "closed enum, shared validator" posture as pay_component's pay-rule.
--
-- RLS: a normal tenant table (no secret columns → no FORCE needed). Reads are tenant-scoped and further
-- narrowed to the OWNER, a SHARED report, or an admin (every report route is admin-gated anyway; the
-- owner/shared split governs who among admins sees whose drafts). Writes are admin-only, mirroring
-- ai_provider_config's write policy (0059).
--
-- Idempotent + forward-only (the test DB is rebuilt forward-only). Journal idx 163 — PLACEHOLDER NUMBER;
-- the integration step may renumber this self-contained migration.

CREATE TABLE IF NOT EXISTS "custom_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"dataset_id" text NOT NULL,
	"spec" jsonb NOT NULL,
	"is_favourite" boolean NOT NULL DEFAULT false,
	"shared" boolean NOT NULL DEFAULT false,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "custom_report" ADD CONSTRAINT "custom_report_tenant_id_tenant_id_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "custom_report_tenant_category_idx" ON "custom_report" ("tenant_id", "category");--> statement-breakpoint

ALTER TABLE "custom_report" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

-- Read: tenant member, further narrowed to the owner OR a shared report OR an admin. (Routes are
-- admin-gated, so in practice admins read all; this keeps the model honest if a non-admin path is added.)
DROP POLICY IF EXISTS "custom_report_read" ON "custom_report";--> statement-breakpoint
CREATE POLICY "custom_report_read" ON "custom_report" FOR SELECT
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      shared = true
      OR app.is_admin()
      OR created_by_user_id = app.current_user_id()
    )
  );--> statement-breakpoint

-- Write: admin only (FOR ALL also covers SELECT, OR-combined with the read policy above).
DROP POLICY IF EXISTS "custom_report_write" ON "custom_report";--> statement-breakpoint
CREATE POLICY "custom_report_write" ON "custom_report" FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.is_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint
