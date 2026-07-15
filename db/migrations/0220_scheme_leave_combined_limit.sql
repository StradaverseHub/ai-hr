-- Combined Leave Type Limit (R44 feedback 4c48fd1f) — a shared per-cycle cap pooling several leave types
-- under one total (e.g. "Compassionate + Marriage + Paternity combined = 5 days a year"). Config layer only
-- here (Stage 1); enforcement (Stage 2) is application code at apply/approval time. Additive + backward
-- compatible: a scheme with no pools behaves exactly as before. Idempotent (IF NOT EXISTS / DO blocks).
CREATE TABLE IF NOT EXISTS "scheme_leave_combined_limit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"benefit_scheme_id" uuid NOT NULL,
	"name" text NOT NULL,
	"total_limit_days" numeric(6, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "scheme_leave_combined_limit" ADD CONSTRAINT "scheme_leave_combined_limit_scheme_fk" FOREIGN KEY ("benefit_scheme_id") REFERENCES "public"."benefit_scheme"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheme_leave_combined_limit_scheme_idx" ON "scheme_leave_combined_limit" ("benefit_scheme_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheme_leave_combined_limit_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"combined_limit_id" uuid NOT NULL,
	"benefit_scheme_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "scheme_leave_combined_limit_member" ADD CONSTRAINT "scheme_leave_combined_limit_member_pool_fk" FOREIGN KEY ("combined_limit_id") REFERENCES "public"."scheme_leave_combined_limit"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "scheme_leave_combined_limit_member" ADD CONSTRAINT "scheme_leave_combined_limit_member_scheme_fk" FOREIGN KEY ("benefit_scheme_id") REFERENCES "public"."benefit_scheme"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "scheme_leave_combined_limit_member" ADD CONSTRAINT "scheme_leave_combined_limit_member_type_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_type"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scheme_leave_combined_limit_member_uq" ON "scheme_leave_combined_limit_member" ("tenant_id", "benefit_scheme_id", "leave_type_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheme_leave_combined_limit_member_pool_idx" ON "scheme_leave_combined_limit_member" ("combined_limit_id");--> statement-breakpoint
-- RLS: tenant-read + admin-write, mirroring the sibling scheme-child tables (0205_benefit_scheme.sql).
ALTER TABLE "scheme_leave_combined_limit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scheme_leave_combined_limit_member" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "scheme_leave_combined_limit" TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "scheme_leave_combined_limit_member" TO ai_hr_app;--> statement-breakpoint
DROP POLICY IF EXISTS scheme_leave_combined_limit_rls ON "scheme_leave_combined_limit";--> statement-breakpoint
CREATE POLICY scheme_leave_combined_limit_rls ON "scheme_leave_combined_limit" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint
DROP POLICY IF EXISTS scheme_leave_combined_limit_member_rls ON "scheme_leave_combined_limit_member";--> statement-breakpoint
CREATE POLICY scheme_leave_combined_limit_member_rls ON "scheme_leave_combined_limit_member" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
