-- Tighten payroll_batch read access (security fix).
-- The original policy let any tenant member read every batch's aggregate totals. Restrict
-- reads to admins, OR to a principal who has a visible payslip in that batch (so the employee
-- self-service portal can still resolve its own payslips' period/status). Writes stay admin-only.

DROP POLICY IF EXISTS payroll_batch_rls ON payroll_batch;
--> statement-breakpoint
CREATE POLICY payroll_batch_rls ON payroll_batch FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      app.is_admin()
      OR EXISTS (
        SELECT 1 FROM payslip ps
        WHERE ps.batch_id = payroll_batch.id
          AND app.can_see_employment(ps.employment_id)
      )
    )
  )
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
