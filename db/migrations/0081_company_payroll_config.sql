-- ADR-0035 1B (#17): per-company payroll scheduling config — cut-off day, pay day, payment basis.
-- Scheduling METADATA only (no payroll-math change). RLS restricts read+write to company-scoped admins
-- (app.is_admin_for), mirroring company_bank_profile (0072). Explicit ai_hr_app grant.
CREATE TABLE "company_payroll_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"cut_off_day" integer,
	"pay_day" integer,
	"payment_basis" text DEFAULT 'monthly' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_payroll_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_payroll_config" ADD CONSTRAINT "company_payroll_config_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_payroll_config" ADD CONSTRAINT "company_payroll_config_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_payroll_config_company_uq" ON "company_payroll_config" USING btree ("company_id");--> statement-breakpoint
CREATE POLICY "company_payroll_config_rls" ON "company_payroll_config" FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "company_payroll_config" TO ai_hr_app;
