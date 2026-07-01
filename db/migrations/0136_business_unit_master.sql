-- ADR-0068: Business Unit master. A FLAT, company-scoped catalog (no parent/child hierarchy) mirroring
-- cost_center. Departments optionally link to a BU via a NULLABLE department.business_unit_id (existing
-- rows stay unassigned and remain usable under every BU on the hire form). Also makes the default probation
-- length configurable per company via a nullable company_payroll_config.probation_months (null = default 3).
--
-- RLS follows the job_grade / payroll_policy precedent (0090 / 0128), NOT location's admin-only FOR ALL:
-- read is TENANT-WIDE (department.business_unit_id is JOINed by non-admin read paths — an admin-only SELECT
-- would silently filter BU to NULL for non-admins, the exact bug 0128's header warns about); WRITE is
-- restricted to an admin for the BU's company. Explicit ai_hr_app grants (the MEMORY fail-closed guard).

CREATE TABLE "business_unit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_unit" ADD CONSTRAINT "business_unit_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_unit" ADD CONSTRAINT "business_unit_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "business_unit_company_idx" ON "business_unit" USING btree ("company_id");--> statement-breakpoint
-- Code unique per company among non-archived rows (mirrors cost_center's 0030 shape).
CREATE UNIQUE INDEX "business_unit_company_code_uq" ON "business_unit" ("company_id", lower("code")) WHERE "archived_at" IS NULL;--> statement-breakpoint

-- Department → Business Unit link: a nullable column on the existing department row (additive; existing
-- rows stay NULL = unassigned). Deletion of a referenced BU is blocked by the service delete-guard (no BU
-- delete path ships yet); no-action FK is the DB backstop.
ALTER TABLE "department" ADD COLUMN "business_unit_id" uuid;--> statement-breakpoint
ALTER TABLE "department" ADD CONSTRAINT "department_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Configurable default probation length (months). Null = legacy/default 3. Additive.
ALTER TABLE "company_payroll_config" ADD COLUMN "probation_months" integer;--> statement-breakpoint

-- RLS: tenant-wide read, admin-for-company write (job_grade / payroll_policy precedent).
ALTER TABLE "business_unit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "business_unit" TO ai_hr_app;--> statement-breakpoint
CREATE POLICY "business_unit_rls" ON "business_unit" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));
