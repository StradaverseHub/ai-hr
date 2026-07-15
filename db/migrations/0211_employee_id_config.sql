-- Employee ID Auto Running Number Setup (feedback 3d0031e6) — a configurable auto-numbering rule for the
-- employee_code assigned at hire. Modeled on payroll_policy (table + tenant-scoped RLS). company_id is
-- NULLABLE: NULL = GLOBAL scope (one sequence shared across all companies in the tenant); a set company_id =
-- a COMPANY-SPECIFIC sequence. Two PARTIAL unique indexes enforce ONE ACTIVE config per scope. Additive +
-- backward compatible: with no active config, the legacy EMP-#### counter still runs (seeds/tests unchanged).
--
-- RLS: readable tenant-wide (so generateEmployeeCode resolves the applicable config under the hiring session),
-- writable only by an admin — group admin for a GLOBAL (company NULL) config, company admin for a company one.
CREATE TABLE IF NOT EXISTS "employee_id_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid,
	"prefix" text NOT NULL,
	"start_number" integer DEFAULT 1 NOT NULL,
	"number_length" integer DEFAULT 4 NOT NULL,
	"increment" integer DEFAULT 1 NOT NULL,
	"current_running_number" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_id_config_tenant_id_tenant_id_fk') THEN
		ALTER TABLE "employee_id_config" ADD CONSTRAINT "employee_id_config_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'employee_id_config_company_id_company_id_fk') THEN
		ALTER TABLE "employee_id_config" ADD CONSTRAINT "employee_id_config_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
-- ONE ACTIVE per scope: at most one active GLOBAL config per tenant; at most one active config per company.
CREATE UNIQUE INDEX IF NOT EXISTS "employee_id_config_global_active_uq" ON "employee_id_config" USING btree ("tenant_id") WHERE company_id is null and status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "employee_id_config_company_active_uq" ON "employee_id_config" USING btree ("tenant_id","company_id") WHERE company_id is not null and status = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "employee_id_config_tenant_status_idx" ON "employee_id_config" USING btree ("tenant_id","status");--> statement-breakpoint
ALTER TABLE "employee_id_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "employee_id_config" TO ai_hr_app;--> statement-breakpoint
DROP POLICY IF EXISTS employee_id_config_rls ON "employee_id_config";--> statement-breakpoint
CREATE POLICY employee_id_config_rls ON "employee_id_config" FOR ALL
	USING (tenant_id = app.current_tenant_id())
	WITH CHECK (
		tenant_id = app.current_tenant_id()
		AND (
			(company_id IS NULL AND app.is_admin())
			OR (company_id IS NOT NULL AND app.is_admin_for(company_id))
		)
	);
