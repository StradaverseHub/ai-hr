-- 2.1 Payroll Policy — catalog RLS (modeled on 0086_leave_approval_policy.sql, NOT 0110/is_admin_for-FOR-ALL).
-- Readable TENANT-WIDE so the payroll kernel can resolve an employee's assigned policy under the caller's
-- (possibly non-admin) session at compute time — a `FOR ALL USING (is_admin_for(...))` policy would return
-- zero rows in a non-admin context and silently fall the employee back to the monthly default with no error.
-- Writable ONLY by an admin for the policy's company.
ALTER TABLE payroll_policy ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON payroll_policy TO ai_hr_app;--> statement-breakpoint
CREATE POLICY payroll_policy_rls ON payroll_policy FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));
