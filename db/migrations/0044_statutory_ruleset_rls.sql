-- Statutory ruleset RLS (ADR-0019).
--
-- An effective-dated override of a country's statutory figures (EPF/SOCSO/EIS/PCB/OT). These are
-- tenant-wide configuration, not per-employment data, so the read audience is every tenant member
-- (the /payroll/configuration view is a transparency/compliance surface). WRITES are admin-only:
-- editing legal figures produces real payslips, so only an admin (super_admin or hr_admin) may create
-- a new effective-dated version. Rows are never updated in place by the service (a new version is
-- appended), but UPDATE is granted so an admin can archive a row (set archived_at); the WITH CHECK
-- keeps the row inside the tenant on any mutation.

ALTER TABLE statutory_ruleset ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON statutory_ruleset TO ai_hr_app;--> statement-breakpoint

CREATE POLICY statutory_ruleset_read ON statutory_ruleset FOR SELECT
  USING (tenant_id = app.current_tenant_id());--> statement-breakpoint

CREATE POLICY statutory_ruleset_insert ON statutory_ruleset FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

CREATE POLICY statutory_ruleset_update ON statutory_ruleset FOR UPDATE
  USING (tenant_id = app.current_tenant_id() AND app.is_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

CREATE POLICY statutory_ruleset_delete ON statutory_ruleset FOR DELETE
  USING (tenant_id = app.current_tenant_id() AND app.is_admin());
