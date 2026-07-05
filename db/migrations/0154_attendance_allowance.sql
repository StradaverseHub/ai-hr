-- ADR-0072: Attendance Allowance Management (Monthly, v1). All additive.
--
--   • attendance_allowance_policy — a company-scoped catalog policy that rewards good attendance with a
--     fixed amount, transferred into a draft payroll run via the existing pay-component prefill path.
--     Evaluation is a PURE READ (no award table); the only persisted output is the payroll_batch_component
--     row created at transfer time (claims/OT precedent). `method` is a text tag — v1 accepts only
--     'monthly' (Daily deferred; no enum, so adding it later needs no migration). RLS: tenant-catalog read
--     (every tenant member, mirrors 0065 pay_component / 0144 clocking_location), admin-of-company write.
--
-- Journal entry: idx 151 (see meta/_journal.json).

CREATE TABLE "attendance_allowance_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"method" text DEFAULT 'monthly' NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"pay_component_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"criteria" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attendance_allowance_policy_amount_nonneg" CHECK ("amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "attendance_allowance_policy" ADD CONSTRAINT "attendance_allowance_policy_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_allowance_policy" ADD CONSTRAINT "attendance_allowance_policy_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance_allowance_policy" ADD CONSTRAINT "attendance_allowance_policy_pay_component_id_pay_component_id_fk" FOREIGN KEY ("pay_component_id") REFERENCES "public"."pay_component"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_allowance_policy_company_idx" ON "attendance_allowance_policy" USING btree ("tenant_id","company_id");--> statement-breakpoint
-- Per-company code uniqueness among LIVE (non-archived) rows — mirrors business_unit / clocking_location.
CREATE UNIQUE INDEX "attendance_allowance_policy_code_uq" ON "attendance_allowance_policy" USING btree ("tenant_id","company_id",lower("code")) WHERE "archived_at" is null;--> statement-breakpoint

-- RLS: mirrors the 0065 pay_component / 0144 clocking_location tenant-catalog pattern verbatim — every
-- tenant member SELECTs the catalog, only an admin of the policy's own company writes.
ALTER TABLE "attendance_allowance_policy" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "attendance_allowance_policy_rls" ON "attendance_allowance_policy" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));--> statement-breakpoint

-- Explicit grants (a migrate-forward-only DB / clean CI provisioning has no cluster default privileges —
-- see 0071's rationale). The new table needs its own grant.
GRANT SELECT, INSERT, UPDATE, DELETE ON "attendance_allowance_policy" TO ai_hr_app;
