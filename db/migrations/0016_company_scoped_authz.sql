-- Slice B: company-scoped authorization with subtree semantics (ADR-0009).
-- Fixes the bug where a company-scoped role granted tenant-wide power. The session now carries
-- GRANTS (role + company) in app.grants; admin checks resolve against the company tree. Helpers
-- are redefined in place, so every policy that calls is_admin()/can_see_employment picks up the
-- new behaviour automatically — we only recreate the policies whose *expression* changes.

-- ── Grants from the session: app.grants = JSON [{role, companyId}] ──
CREATE OR REPLACE FUNCTION app.current_grants() RETURNS TABLE (role text, company_id uuid)
  LANGUAGE sql STABLE AS $$
  SELECT g->>'role', nullif(g->>'companyId', '')::uuid
  FROM jsonb_array_elements(
    coalesce(nullif(current_setting('app.grants', true), '')::jsonb, '[]'::jsonb)
  ) AS g;
$$;
--> statement-breakpoint
-- A grant of `role` covering `company`: group-wide (null), on the company, or on an ancestor.
CREATE OR REPLACE FUNCTION app.has_role_for(p_role text, p_company uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.current_grants() g
    WHERE g.role = p_role
      AND (g.company_id IS NULL OR g.company_id = p_company OR app.is_company_descendant(p_company, g.company_id))
  );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.is_admin_for(p_company uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT app.has_role_for('hr_admin', p_company) OR app.has_role_for('super_admin', p_company);
$$;
--> statement-breakpoint
-- Coarse "admin somewhere" (any admin grant) — for group-level config.
CREATE OR REPLACE FUNCTION app.is_admin() RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM app.current_grants() g WHERE g.role IN ('hr_admin', 'super_admin'));
$$;
--> statement-breakpoint
-- Group-wide admin only (null-scoped hr_admin, or super_admin) — for grant/identity management.
CREATE OR REPLACE FUNCTION app.is_group_admin() RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.current_grants() g
    WHERE g.role = 'super_admin' OR (g.role = 'hr_admin' AND g.company_id IS NULL)
  );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_admin_employment(emp_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM employment e WHERE e.id = emp_id AND app.is_admin_for(e.company_id));
$$;
--> statement-breakpoint
-- can_see_employment: admin branch now company-scoped; self + manager branches unchanged.
CREATE OR REPLACE FUNCTION app.can_see_employment(emp_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
      SELECT 1 FROM employment e
      WHERE e.id = emp_id AND e.tenant_id = app.current_tenant_id() AND app.is_admin_for(e.company_id)
    )
    OR EXISTS (
      SELECT 1 FROM employment e JOIN app_user u ON u.person_id = e.person_id
      WHERE e.id = emp_id AND e.tenant_id = app.current_tenant_id() AND u.id = app.current_user_id()
    )
    OR EXISTS (
      SELECT 1 FROM reporting_line rl
        JOIN employment me ON me.id = rl.manager_employment_id
        JOIN app_user u ON u.person_id = me.person_id
      WHERE rl.subordinate_employment_id = emp_id
        AND rl.line_type = 'administrative'
        AND rl.tenant_id = app.current_tenant_id()
        AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
        AND rl.superseded_at IS NULL
        AND u.id = app.current_user_id()
    );
$$;
--> statement-breakpoint

-- ── Bootstrap returns grants (role + company), not just role names ──
DROP FUNCTION IF EXISTS app.principal(uuid);
--> statement-breakpoint
CREATE FUNCTION app.principal(p_user_id uuid)
  RETURNS TABLE (tenant_id uuid, person_id uuid, grants jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT u.tenant_id, u.person_id,
         COALESCE(
           jsonb_agg(jsonb_build_object('role', ra.role, 'companyId', ra.company_id))
             FILTER (WHERE ra.role IS NOT NULL),
           '[]'::jsonb
         )
  FROM app_user u
  LEFT JOIN role_assignment ra ON ra.app_user_id = u.id
  WHERE u.id = p_user_id
  GROUP BY u.tenant_id, u.person_id;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.principal(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── Recreate the policies whose expression changes (company-scoped) ──
-- Company-stamped structural tables → is_admin_for(company_id).
DROP POLICY tenant_isolation ON department;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON department FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));
--> statement-breakpoint
DROP POLICY tenant_isolation ON position;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON position FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));
--> statement-breakpoint
DROP POLICY tenant_isolation ON cost_center;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON cost_center FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));
--> statement-breakpoint
-- company: scoped by parent (children) or self (root/update).
DROP POLICY tenant_isolation ON company;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON company FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(coalesce(parent_company_id, id)));
--> statement-breakpoint
DROP POLICY attendance_policy_rls ON attendance_policy;
--> statement-breakpoint
CREATE POLICY attendance_policy_rls ON attendance_policy FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));
--> statement-breakpoint
DROP POLICY company_statutory_my_rls ON company_statutory_my;
--> statement-breakpoint
CREATE POLICY company_statutory_my_rls ON company_statutory_my FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));
--> statement-breakpoint
-- employment: write scoped to its company.
DROP POLICY employment_rls ON employment;
--> statement-breakpoint
CREATE POLICY employment_rls ON employment FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));
--> statement-breakpoint
-- Employment-scoped rows → can_admin_employment(employment_id).
DROP POLICY assignment_rls ON assignment;
--> statement-breakpoint
CREATE POLICY assignment_rls ON assignment FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_employment(employment_id));
--> statement-breakpoint
DROP POLICY compensation_rls ON compensation;
--> statement-breakpoint
CREATE POLICY compensation_rls ON compensation FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_employment(employment_id));
--> statement-breakpoint
DROP POLICY payslip_rls ON payslip;
--> statement-breakpoint
CREATE POLICY payslip_rls ON payslip FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_employment(employment_id));
--> statement-breakpoint
-- payroll_batch: read = admin-for-company or has a visible payslip; write = admin-for-company.
DROP POLICY payroll_batch_rls ON payroll_batch;
--> statement-breakpoint
CREATE POLICY payroll_batch_rls ON payroll_batch FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND (
      app.is_admin_for(company_id)
      OR EXISTS (SELECT 1 FROM payslip ps WHERE ps.batch_id = payroll_batch.id AND app.can_see_employment(ps.employment_id))
    )
  )
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));
--> statement-breakpoint
-- employee_statutory_my: admin must also be able to see the person (i.e. admin for their company).
DROP POLICY employee_statutory_my_rls ON employee_statutory_my;
--> statement-breakpoint
CREATE POLICY employee_statutory_my_rls ON employee_statutory_my FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_person(person_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin() AND app.can_see_person(person_id));
--> statement-breakpoint
-- Grant/identity management → GROUP-WIDE admin only (prevents privilege escalation).
DROP POLICY tenant_isolation ON role_assignment;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON role_assignment FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_group_admin());
--> statement-breakpoint
DROP POLICY tenant_isolation ON app_user;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app_user FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_group_admin());
