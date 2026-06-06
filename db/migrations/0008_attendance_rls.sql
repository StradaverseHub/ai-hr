-- Slice 3: RLS for attendance. attendance is ABAC-gated like leave (self check-in,
-- manager/admin visibility); attendance_policy is admin-managed company config.

GRANT SELECT, INSERT, UPDATE, DELETE ON attendance, attendance_policy TO ai_hr_app;
--> statement-breakpoint

ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY attendance_rls ON attendance FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id));
--> statement-breakpoint

ALTER TABLE attendance_policy ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY attendance_policy_rls ON attendance_policy FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
