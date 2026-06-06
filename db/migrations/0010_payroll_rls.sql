-- Slice 4: RLS for payroll. Batches are admin-managed; payslips are ABAC-readable
-- (an employee sees their own; managers/admins see their scope) but admin-written.

GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_batch, payslip TO ai_hr_app;
--> statement-breakpoint

ALTER TABLE payroll_batch ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payroll_batch_rls ON payroll_batch FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint

ALTER TABLE payslip ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payslip_rls ON payslip FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
