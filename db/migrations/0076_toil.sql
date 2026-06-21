-- ADR-0033 slice 33-2: Leave-in-lieu (TOIL). Gated (TOIL_ENABLED) — additive, no behaviour when off.
-- toil_policy (one per company, the allowFirstScheduleEligible toggle lives here) + toil_accrual (the
-- register that drives no-double-pay + expiry). Explicit ai_hr_app grants (not cluster defaults).

CREATE TYPE "toil_accrual_basis" AS ENUM('hours_worked', 'premium_equivalent');--> statement-breakpoint
CREATE TYPE "toil_expiry_action" AS ENUM('convert_to_pay', 'lapse');--> statement-breakpoint
CREATE TYPE "toil_accrual_status" AS ENUM('active', 'taken', 'converted_to_pay', 'lapsed');--> statement-breakpoint
-- TOIL ledger credits are distinguishable from entitlement accruals. Added value is not used in this
-- migration, so it is safe inside the migration transaction (PG 12+).
ALTER TYPE "leave_entry_type" ADD VALUE IF NOT EXISTS 'in_lieu_accrual';--> statement-breakpoint

CREATE TABLE "toil_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"accrual_basis" "toil_accrual_basis" DEFAULT 'hours_worked' NOT NULL,
	"expiry_days" integer DEFAULT 90 NOT NULL,
	"on_expiry" "toil_expiry_action" DEFAULT 'convert_to_pay' NOT NULL,
	"allow_first_schedule_eligible" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "toil_accrual" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"worked_date" date NOT NULL,
	"day_type" "attendance_day_type" NOT NULL,
	"ot_minutes" integer NOT NULL,
	"days_credited" numeric(6, 2) NOT NULL,
	"accrual_basis" "toil_accrual_basis" NOT NULL,
	"expires_on" date NOT NULL,
	"status" "toil_accrual_status" DEFAULT 'active' NOT NULL,
	"policy_id" uuid,
	"ledger_entry_id" uuid,
	"taken_by_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "toil_policy" ADD CONSTRAINT "toil_policy_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "toil_policy" ADD CONSTRAINT "toil_policy_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "toil_accrual" ADD CONSTRAINT "toil_accrual_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "toil_accrual" ADD CONSTRAINT "toil_accrual_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "toil_accrual" ADD CONSTRAINT "toil_accrual_policy_id_toil_policy_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."toil_policy"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "toil_accrual" ADD CONSTRAINT "toil_accrual_ledger_entry_id_leave_ledger_id_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."leave_ledger"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "toil_accrual" ADD CONSTRAINT "toil_accrual_taken_by_request_id_leave_request_id_fk" FOREIGN KEY ("taken_by_request_id") REFERENCES "public"."leave_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "toil_policy_company_uq" ON "toil_policy" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "toil_accrual_emp_date_uq" ON "toil_accrual" USING btree ("tenant_id","employment_id","worked_date");--> statement-breakpoint
CREATE INDEX "toil_accrual_expiry_idx" ON "toil_accrual" USING btree ("tenant_id","status","expires_on");--> statement-breakpoint

ALTER TABLE "toil_policy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "toil_policy_rls" ON "toil_policy" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));--> statement-breakpoint
ALTER TABLE "toil_accrual" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "toil_accrual_rls" ON "toil_accrual" FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_employment(employment_id));--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "toil_policy" TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "toil_accrual" TO ai_hr_app;
