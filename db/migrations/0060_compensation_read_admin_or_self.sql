-- Consultant feedback #5 (access control / privacy). A manager could read a direct report's BASE
-- compensation because the compensation READ policy used app.can_see_employment() — which is downward
-- (self + reports + admin). Tighten the read to ADMIN-OR-SELF: only a (company-scoped) admin or the
-- employee themselves may read a compensation row; managers lose visibility of subordinate pay.
--
-- WRITE is unchanged (admin only, app.can_admin_employment). Self-read keeps `myEmployments` (/me) and
-- an employee's own pay visible. Payroll reads comp under an admin context, so generation is unaffected.
-- The performance-review merit/bonus RECOMMENDATION the manager authors lives on performance_review
-- (a separate table) and is deliberately untouched.

DROP POLICY compensation_rls ON compensation;--> statement-breakpoint

CREATE POLICY compensation_rls ON compensation FOR ALL
  USING (
    tenant_id = app.current_tenant_id() AND (
      app.can_admin_employment(employment_id)
      OR EXISTS (
        SELECT 1 FROM employment e
        WHERE e.id = compensation.employment_id AND app.is_self_person(e.person_id)
      )
    )
  )
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_employment(employment_id));
