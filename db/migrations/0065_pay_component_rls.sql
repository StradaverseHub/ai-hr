-- Wave 3 #9 (ADR-0025) — row-level security for the typed pay-component tables. The cluster's default
-- privileges already grant ai_hr_app table-wide arwd on new tables, so this only adds RLS + policies.

-- pay_component: tenant catalog — every tenant member reads; only admins write (mirrors leave_type).
ALTER TABLE pay_component ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY pay_component_rls ON pay_component FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

-- employment_pay_component: recurring per-employee amounts are PAY → admin-or-self read, admin write
-- (mirrors compensation_rls, Wave 1 #5 — a manager must not see a subordinate's component amounts).
ALTER TABLE employment_pay_component ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY employment_pay_component_rls ON employment_pay_component FOR ALL
  USING (
    tenant_id = app.current_tenant_id() AND (
      app.can_admin_employment(employment_id)
      OR EXISTS (
        SELECT 1 FROM employment e
        WHERE e.id = employment_pay_component.employment_id AND app.is_self_person(e.person_id)
      )
    )
  )
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_employment(employment_id));--> statement-breakpoint

-- payroll_batch_component: per-batch values are admin-only (mirrors payroll_input_rls).
ALTER TABLE payroll_batch_component ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY payroll_batch_component_rls ON payroll_batch_component FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND EXISTS (SELECT 1 FROM payroll_batch b WHERE b.id = batch_id AND app.is_admin_for(b.company_id))
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND EXISTS (SELECT 1 FROM payroll_batch b WHERE b.id = batch_id AND app.is_admin_for(b.company_id))
  );
