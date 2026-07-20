-- R46 orgbank (84719377) — per-authority statutory payment configuration (NET-NEW).
--
-- company_statutory_my is ONE flat row per company holding the employer reference numbers (EPF/SOCSO/LHDN/
-- MyInvois/SSM/HRDF). There is today no place at all to record, PER statutory body, which bank account pays
-- it, the body's address/contact, or the authorised signatory — and a one-row-per-company shape cannot hold
-- nine authorities. This child table adds exactly that; company_statutory_my is untouched.
--
-- `authority` is TEXT with the controlled set enforced in code (core/statutory-authority.ts
-- STATUTORY_AUTHORITIES), not a pgEnum — 0275 exists precisely because a 4-value pgEnum had to be widened.
--
-- FK delete behaviour is chosen so neither dependency can silently destroy configuration:
--   bank_profile_id      ON DELETE SET NULL — removing a bank account unroutes the authority, it does not
--                        delete the authority's address / contact / signatory setup.
--   signatory_person_id  ON DELETE SET NULL — same, and it is the PDPA-erasure-safe behaviour. A merely
--                        TERMINATED employee is not deleted, so the stored signatory survives; the picker is
--                        scoped to the company's active employments and is legacy-tolerant about a stored
--                        value that is no longer in that list.
--
-- RLS mirrors company_bank_profile's LATEST policy (0099: can_admin_payroll_for for BOTH read and write) —
-- this row references a bank account and names a signatory, so it is at least as sensitive as the account
-- itself. A new table does NOT inherit prior GRANTs and the app role is NOSUPERUSER/NOBYPASSRLS (ADR-0002,
-- and the 0071 lesson), so the explicit GRANT belongs in this same migration.
--
-- Journal entry: idx 276 (see meta/_journal.json).

CREATE TABLE "company_statutory_authority" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"authority" text NOT NULL,
	"account_no" text,
	"bank_profile_id" uuid,
	"address_line1" text,
	"address_line2" text,
	"address_line3" text,
	"city" text,
	"state" text,
	"postcode" text,
	"country" text,
	"phone" text,
	"email" text,
	"signatory_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_statutory_authority" ADD CONSTRAINT "company_statutory_authority_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_statutory_authority" ADD CONSTRAINT "company_statutory_authority_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_statutory_authority" ADD CONSTRAINT "company_statutory_authority_bank_profile_id_company_bank_profile_id_fk" FOREIGN KEY ("bank_profile_id") REFERENCES "public"."company_bank_profile"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_statutory_authority" ADD CONSTRAINT "company_statutory_authority_signatory_person_id_person_id_fk" FOREIGN KEY ("signatory_person_id") REFERENCES "public"."person"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "company_statutory_authority_company_authority_uq" ON "company_statutory_authority" USING btree ("company_id","authority");--> statement-breakpoint

ALTER TABLE "company_statutory_authority" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "company_statutory_authority" TO ai_hr_app;--> statement-breakpoint
CREATE POLICY "company_statutory_authority_rls" ON "company_statutory_authority" FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_admin_payroll_for(company_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_payroll_for(company_id));
