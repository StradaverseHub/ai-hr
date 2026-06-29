-- 2.1 Payroll Policy — a named, reusable, company-scoped template for HOW an employee gets paid.
-- All four policy_type values exist now (no later migration to add one); only `monthly` is wired to
-- calculation in this slice (it is the existing behaviour). pay_rule reuses core/pay-rule.ts's PayRule
-- (null for monthly; daily/hourly deferred). Assigned to an employment via employment.payroll_policy_id.
CREATE TYPE "payroll_policy_type" AS ENUM('monthly', 'daily', 'hourly', 'custom_period');--> statement-breakpoint
CREATE TABLE "payroll_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"policy_type" "payroll_policy_type" NOT NULL,
	"pay_rule" jsonb,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "payroll_policy" ADD CONSTRAINT "payroll_policy_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_policy" ADD CONSTRAINT "payroll_policy_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_policy_company_name_uq" ON "payroll_policy" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "payroll_policy_company_status_idx" ON "payroll_policy" USING btree ("company_id","status");--> statement-breakpoint
ALTER TABLE "employment" ADD COLUMN "payroll_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "employment" ADD CONSTRAINT "employment_payroll_policy_id_payroll_policy_id_fk" FOREIGN KEY ("payroll_policy_id") REFERENCES "public"."payroll_policy"("id") ON DELETE set null ON UPDATE no action;
