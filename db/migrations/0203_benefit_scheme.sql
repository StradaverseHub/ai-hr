-- Benefit Scheme & Leave Entitlement Configuration (feedback b83c6a3b).
-- A configuration LAYER over the existing grade-scoped leave_policy engine. Additive + backward compatible:
-- a tenant with no schemes resolves entitlements exactly as before. Idempotent (IF NOT EXISTS / DO blocks)
-- so a re-run on a partially-migrated DB is safe.
CREATE TABLE IF NOT EXISTS "grade_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "grade_group_name_uq" ON "grade_group" ("tenant_id", lower("name")) WHERE archived_at IS NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "grade_group_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"grade_group_id" uuid NOT NULL,
	"grade_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "grade_group_member" ADD CONSTRAINT "grade_group_member_group_fk" FOREIGN KEY ("grade_group_id") REFERENCES "public"."grade_group"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "grade_group_member" ADD CONSTRAINT "grade_group_member_grade_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."job_grade"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "grade_group_member_grade_uq" ON "grade_group_member" ("tenant_id", "grade_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grade_group_member_group_idx" ON "grade_group_member" ("grade_group_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "benefit_scheme" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"employment_type" "employment_type" NOT NULL,
	"grade_group_id" uuid,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "benefit_scheme" ADD CONSTRAINT "benefit_scheme_company_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "benefit_scheme" ADD CONSTRAINT "benefit_scheme_grade_group_fk" FOREIGN KEY ("grade_group_id") REFERENCES "public"."grade_group"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "benefit_scheme_name_uq" ON "benefit_scheme" ("tenant_id", lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "benefit_scheme_match_uq" ON "benefit_scheme" ("tenant_id", "company_id", "employment_type", "grade_group_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "benefit_scheme_company_idx" ON "benefit_scheme" ("company_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheme_leave_entitlement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"benefit_scheme_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"service_bands" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "scheme_leave_entitlement" ADD CONSTRAINT "scheme_leave_entitlement_scheme_fk" FOREIGN KEY ("benefit_scheme_id") REFERENCES "public"."benefit_scheme"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "scheme_leave_entitlement" ADD CONSTRAINT "scheme_leave_entitlement_type_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_type"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scheme_leave_entitlement_uq" ON "scheme_leave_entitlement" ("tenant_id", "benefit_scheme_id", "leave_type_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheme_leave_entitlement_scheme_idx" ON "scheme_leave_entitlement" ("benefit_scheme_id");--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN IF NOT EXISTS "benefit_scheme_id" uuid;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "employment" ADD CONSTRAINT "employment_benefit_scheme_fk" FOREIGN KEY ("benefit_scheme_id") REFERENCES "public"."benefit_scheme"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
-- RLS: tenant-read + admin-write, mirroring job_grade / leave_policy config tables.
ALTER TABLE "grade_group" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grade_group_member" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "benefit_scheme" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "scheme_leave_entitlement" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "grade_group" TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "grade_group_member" TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "benefit_scheme" TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "scheme_leave_entitlement" TO ai_hr_app;--> statement-breakpoint
DROP POLICY IF EXISTS grade_group_rls ON "grade_group";--> statement-breakpoint
CREATE POLICY grade_group_rls ON "grade_group" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint
DROP POLICY IF EXISTS grade_group_member_rls ON "grade_group_member";--> statement-breakpoint
CREATE POLICY grade_group_member_rls ON "grade_group_member" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint
DROP POLICY IF EXISTS benefit_scheme_rls ON "benefit_scheme";--> statement-breakpoint
CREATE POLICY benefit_scheme_rls ON "benefit_scheme" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint
DROP POLICY IF EXISTS scheme_leave_entitlement_rls ON "scheme_leave_entitlement";--> statement-breakpoint
CREATE POLICY scheme_leave_entitlement_rls ON "scheme_leave_entitlement" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
