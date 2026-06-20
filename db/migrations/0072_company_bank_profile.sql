-- ADR-0031: per-entity, per-bank salary-disbursement profile. Holds the bank-issued corporate/org ID +
-- employer debit account every bulk-payment file header needs. Sensitive employer credentials — RLS
-- restricts BOTH read and write to company-scoped admins (app.is_admin_for), unlike most tables whose
-- reads are tenant-wide. Explicit ai_hr_app grant (per the 0071 lesson: don't rely on cluster defaults).
CREATE TYPE "disbursement_bank" AS ENUM('maybank', 'cimb', 'public_bank', 'rhb');--> statement-breakpoint
CREATE TABLE "company_bank_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"bank" "disbursement_bank" NOT NULL,
	"corporate_id" text NOT NULL,
	"debit_account_no" text NOT NULL,
	"org_name" text,
	"txn_type" text DEFAULT 'IBG' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_bank_profile" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_bank_profile" ADD CONSTRAINT "company_bank_profile_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_bank_profile" ADD CONSTRAINT "company_bank_profile_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_bank_profile_company_bank_uq" ON "company_bank_profile" USING btree ("company_id","bank");--> statement-breakpoint
CREATE POLICY "company_bank_profile_rls" ON "company_bank_profile" FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "company_bank_profile" TO ai_hr_app;
