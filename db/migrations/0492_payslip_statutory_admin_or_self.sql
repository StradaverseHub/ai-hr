-- Security remediation (assessment 2026-09, finding H4). The 0060 privacy decision — compensation
-- READ tightened to ADMIN-OR-SELF so managers cannot see a subordinate's pay — was never applied to
-- `payslip` or `employee_statutory_my`. Both still resolved through app.can_see_employment /
-- app.can_see_person, whose manager down-walk + HOD branch let a line manager read a subordinate's
-- net pay, full bank account, IC/passport and EPF/SOCSO/tax numbers (verified: the EA statement route
-- returned a subordinate's IC + tax number to a non-admin manager). Mirror 0060 on both tables.
--
-- READ = (company-scoped) payroll admin OR the employee themselves; managers/HODs lose it.
-- WRITE is unchanged (already payroll-admin / admin only). Payroll generation reads under an admin or
-- payroll-admin context, so it is unaffected; /me self-reads keep working via is_self_person.

DROP POLICY payslip_rls ON payslip;--> statement-breakpoint
CREATE POLICY payslip_rls ON payslip FOR ALL
  USING (
    tenant_id = app.current_tenant_id() AND (
      app.can_admin_payroll_employment(employment_id)
      OR EXISTS (
        SELECT 1 FROM employment e
        WHERE e.id = payslip.employment_id AND app.is_self_person(e.person_id)
      )
    )
  )
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_payroll_employment(employment_id));
--> statement-breakpoint
-- employee_statutory_my is person-keyed (no employment_id), so the payroll-admin check joins through
-- the person's employments. Full admins and the person themselves keep read; managers lose it.
DROP POLICY employee_statutory_my_rls ON employee_statutory_my;--> statement-breakpoint
CREATE POLICY employee_statutory_my_rls ON employee_statutory_my FOR ALL
  USING (
    tenant_id = app.current_tenant_id() AND (
      app.is_admin()
      OR app.is_self_person(person_id)
      OR EXISTS (
        SELECT 1 FROM employment e
        WHERE e.person_id = employee_statutory_my.person_id AND app.can_admin_payroll_for(e.company_id)
      )
    )
  )
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin() AND app.can_see_person(person_id));
