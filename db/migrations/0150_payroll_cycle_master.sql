-- ADR-0069: Configurable Payroll Cycle master. A FLAT, COMPANY-scoped catalog of the friendly cycle
-- names the Payroll Process wizard's "Payroll Cycle" dropdown offers, mirroring leave_type / claim_type
-- (single archived_at soft-delete, partial-unique on the live name). Each row maps to ONE of the four
-- fixed behavioural run_types (payroll_run_type) — configurable LABEL/LIST, NOT configurable payroll
-- math. `remarks` carries an off_cycle preset's free-text label (e.g. 'Advance Salary' / 'Mid-Month').
--
-- RLS is COMPANY-scoped via app.can_admin_payroll_for(company_id), matching payroll_batch_rls (0099) —
-- the table this catalog FEEDS. Read is tenant-wide (the wizard dropdown must resolve cycle rows under a
-- payroll admin's session regardless of which company they administer; the write guard is the real
-- backstop against a Company-A admin editing Company-B's list). Explicit ai_hr_app grants (the MEMORY
-- fail-closed guard — RLS enabled + missing grant = silent fail-closed).
--
-- Migration numbered 0146 (not 0145) because a concurrent worktree claimed 0145 first (plan item 8:
-- re-verify the highest number at execution time to avoid a collision).

CREATE TABLE "payroll_cycle" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"run_type" "payroll_run_type" NOT NULL,
	"remarks" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payroll_cycle" ADD CONSTRAINT "payroll_cycle_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_cycle" ADD CONSTRAINT "payroll_cycle_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payroll_cycle_company_idx" ON "payroll_cycle" USING btree ("company_id");--> statement-breakpoint
-- One live name per company (case-insensitive). Archived rows may share a name that was re-created.
CREATE UNIQUE INDEX "payroll_cycle_company_name_uq" ON "payroll_cycle" ("company_id", lower("name")) WHERE "archived_at" IS NULL;--> statement-breakpoint

-- RLS: tenant-wide read, admin-for-payroll write (payroll_batch precedent, 0099).
ALTER TABLE "payroll_cycle" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_cycle" TO ai_hr_app;--> statement-breakpoint
CREATE POLICY "payroll_cycle_rls" ON "payroll_cycle" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_payroll_for(company_id));
