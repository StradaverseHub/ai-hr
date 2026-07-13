-- 88e94371 · "Lateness, Early Out & Overtime Settings" — named-rule library.
-- Adds a per-company library of attendance calculation rules (attendance_rule) + an OT time-band child table
-- (attendance_rule_ot_row) + a nullable shift.rule_id FK. Idempotent (IF NOT EXISTS / ON CONFLICT).
--
-- DATA CONVERSION (reporter-approved: convert, do NOT delete): every existing attendance_policy row becomes a
-- per-company un-deletable "Standard" (is_default) rule whose late-grace = (late_after − work_start), so the
-- time engine's late threshold carries over byte-identically. No existing config is removed.

CREATE TABLE IF NOT EXISTS "attendance_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"late_grace_period_minutes" integer DEFAULT 0 NOT NULL,
	"late_after_minutes" integer DEFAULT 0 NOT NULL,
	"late_deduct_minutes" integer DEFAULT 0 NOT NULL,
	"include_grace_in_lateness" boolean DEFAULT false NOT NULL,
	"early_grace_period_minutes" integer DEFAULT 0 NOT NULL,
	"early_after_minutes" integer DEFAULT 0 NOT NULL,
	"early_deduct_minutes" integer DEFAULT 0 NOT NULL,
	"include_grace_in_early_out" boolean DEFAULT false NOT NULL,
	"apply_to_early_ot" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_rule_status_check" CHECK ("status" IN ('active','inactive'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "attendance_rule_ot_row" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"from_minutes" integer DEFAULT 0 NOT NULL,
	"to_minutes" integer DEFAULT 0 NOT NULL,
	"rate_pattern" text DEFAULT 'flat' NOT NULL,
	"rate" numeric(6, 2) DEFAULT '1.50' NOT NULL,
	"rounding" boolean DEFAULT false NOT NULL,
	"round_to_minutes" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_rule_ot_row_pattern_check" CHECK ("rate_pattern" IN ('flat','variable'))
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "attendance_rule" ADD CONSTRAINT "attendance_rule_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "attendance_rule" ADD CONSTRAINT "attendance_rule_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "attendance_rule_ot_row" ADD CONSTRAINT "attendance_rule_ot_row_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "attendance_rule_ot_row" ADD CONSTRAINT "attendance_rule_ot_row_rule_id_attendance_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."attendance_rule"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "attendance_rule_default_uq" ON "attendance_rule" USING btree ("company_id") WHERE "is_default";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "attendance_rule_company_name_uq" ON "attendance_rule" USING btree ("company_id", lower("name"));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attendance_rule_company_idx" ON "attendance_rule" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attendance_rule_ot_row_rule_idx" ON "attendance_rule_ot_row" USING btree ("rule_id", "sort_order");
--> statement-breakpoint
ALTER TABLE "shift" ADD COLUMN IF NOT EXISTS "rule_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "shift" ADD CONSTRAINT "shift_rule_id_attendance_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."attendance_rule"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
-- RLS: read tenant-wide (the time engine resolves rules under an employee's session), write admin-only for
-- the owning company — mirrors attendance_policy (migration 0016).
GRANT SELECT, INSERT, UPDATE, DELETE ON attendance_rule, attendance_rule_ot_row TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE attendance_rule ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS attendance_rule_rls ON attendance_rule;
--> statement-breakpoint
CREATE POLICY attendance_rule_rls ON attendance_rule FOR ALL
	USING (tenant_id = app.current_tenant_id())
	WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));
--> statement-breakpoint
ALTER TABLE attendance_rule_ot_row ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS attendance_rule_ot_row_rls ON attendance_rule_ot_row;
--> statement-breakpoint
-- OT rows inherit their rule's company for the admin write-gate.
CREATE POLICY attendance_rule_ot_row_rls ON attendance_rule_ot_row FOR ALL
	USING (tenant_id = app.current_tenant_id())
	WITH CHECK (
		tenant_id = app.current_tenant_id()
		AND EXISTS (SELECT 1 FROM attendance_rule r WHERE r.id = rule_id AND app.is_admin_for(r.company_id))
	);
--> statement-breakpoint
-- Convert every existing attendance_policy into a per-company un-deletable "Standard" rule (idempotent: the
-- partial unique index attendance_rule_default_uq makes a re-run a no-op via ON CONFLICT DO NOTHING).
INSERT INTO "attendance_rule" (
	"tenant_id", "company_id", "name", "description", "is_default", "status",
	"late_grace_period_minutes", "early_grace_period_minutes"
)
SELECT
	ap."tenant_id",
	ap."company_id",
	'Standard',
	'Default attendance calculation rule (converted from the company attendance policy).',
	true,
	'active',
	GREATEST(0, (EXTRACT(EPOCH FROM ap."late_after") - EXTRACT(EPOCH FROM ap."work_start"))::int / 60),
	0
FROM "attendance_policy" ap
ON CONFLICT DO NOTHING;
