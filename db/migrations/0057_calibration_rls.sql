-- Performance Phase B — calibration RLS (ADR-0022, slice 4).
--
-- calibration_session / calibration_entry hold proposed/committed overall ratings across a cohort — an
-- HR/admin activity. So both are ADMIN-ONLY for read AND write (tenant isolation + app.is_admin()),
-- unlike review_cycle (tenant-readable). The committed ratings land on performance_review via the service.

ALTER TABLE calibration_session ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE calibration_entry ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON calibration_session TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON calibration_entry TO ai_hr_app;--> statement-breakpoint

CREATE POLICY calibration_session_rls ON calibration_session FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.is_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

CREATE POLICY calibration_entry_rls ON calibration_entry FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.is_admin())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
