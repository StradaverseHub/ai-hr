-- 9aa894a4 — Leave Year Configuration. A managed lifecycle record per (tenant, leave year): Draft → Open →
-- Closed, with two independent control dates — open_leave_year_date (when the year's balances go live) and
-- employee_application_start_date (when staff may start APPLYING for that year). Purely ADDITIVE: with NO
-- rows the system behaves exactly as before (openLeaveYear stays manual, and the new application gate only
-- ever fires for a FUTURE leave year — see leaveYearOpenForApplication in core/leave.ts). status→open calls
-- the existing openLeaveYear grant sweep (no duplication) and stamps opened_at / opened_by.
--
-- RLS mirrors profile_option (0180): tenant-read for every member, admin-only write (WITH CHECK
-- app.is_admin()). New tables never inherit grants (ADR-0002) — grant ai_hr_app explicitly.

CREATE TABLE IF NOT EXISTS "leave_year_config" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"open_leave_year_date" date,
	"employee_application_start_date" date,
	"opened_at" timestamp with time zone,
	"opened_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leave_year_config_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action,
	CONSTRAINT "leave_year_config_status_check" CHECK ("status" IN ('draft', 'open', 'closed'))
);
--> statement-breakpoint
-- One managed record per (tenant, year) — the idempotency key the upsert path relies on.
CREATE UNIQUE INDEX IF NOT EXISTS "leave_year_config_tenant_year_uq" ON "leave_year_config" USING btree ("tenant_id","year");--> statement-breakpoint

-- New tables never inherit grants (ADR-0002) — grant the app role explicitly. Plain GRANT/POLICY (matching
-- 0180): drizzle never re-runs a recorded migration, so these run exactly once on a fresh table.
GRANT SELECT, INSERT, UPDATE, DELETE ON "leave_year_config" TO ai_hr_app;--> statement-breakpoint
ALTER TABLE "leave_year_config" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "leave_year_config_rls" ON "leave_year_config" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
