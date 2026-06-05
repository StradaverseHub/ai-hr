-- Slice 0 security layer (applied as the OWNER role; the app connects as ai_hr_app).
--   * Row-Level Security — tenant isolation + ABAC (ADR-0002 / ADR-0004)
--   * Append-only audit log (ADR-0006)
--   * Temporal integrity — no two *current* assignments overlap for one employment
-- Helper functions live in schema `app`. The owner bypasses RLS, so migrations/seeds
-- are unaffected; ai_hr_app (non-owner, non-BYPASSRLS) is fully governed.

-- ── Session context helpers ────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.current_roles() RETURNS text[]
  LANGUAGE sql STABLE AS $$ SELECT coalesce(string_to_array(nullif(current_setting('app.roles', true), ''), ','), ARRAY[]::text[]) $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.has_role(r text) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT r = ANY(app.current_roles()) $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.is_admin() RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT app.has_role('hr_admin') OR app.has_role('super_admin') $$;
--> statement-breakpoint
-- SECURITY DEFINER: runs as owner so internal lookups bypass RLS (avoids policy recursion).
-- Each lookup is still constrained to the current tenant, so nothing leaks cross-tenant.
CREATE OR REPLACE FUNCTION app.can_see_employment(emp_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app.is_admin()
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
CREATE OR REPLACE FUNCTION app.can_see_person(p_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT app.is_admin()
    OR EXISTS (
      SELECT 1 FROM app_user u
      WHERE u.id = app.current_user_id() AND u.person_id = p_id AND u.tenant_id = app.current_tenant_id()
    )
    OR EXISTS (
      SELECT 1 FROM employment e
      WHERE e.person_id = p_id AND e.tenant_id = app.current_tenant_id() AND app.can_see_employment(e.id)
    );
$$;
--> statement-breakpoint

-- ── Grants to the non-privileged app role ──────────────────────────
GRANT USAGE ON SCHEMA app TO ai_hr_app;
--> statement-breakpoint
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ai_hr_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ai_hr_app;
--> statement-breakpoint

-- ── RLS: tenant isolation (structural tables) ──────────────────────
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON tenant FOR ALL
  USING (id = app.current_tenant_id()) WITH CHECK (id = app.current_tenant_id());
--> statement-breakpoint
ALTER TABLE company ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON company FOR ALL
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
ALTER TABLE position ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON position FOR ALL
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
ALTER TABLE department ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON department FOR ALL
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
ALTER TABLE cost_center ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON cost_center FOR ALL
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
ALTER TABLE leave_type ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON leave_type FOR ALL
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
ALTER TABLE leave_policy ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON leave_policy FOR ALL
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON app_user FOR ALL
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
ALTER TABLE role_assignment ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON role_assignment FOR ALL
  USING (tenant_id = app.current_tenant_id()) WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
ALTER TABLE reporting_line ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY reporting_line_rls ON reporting_line FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint

-- ── RLS: ABAC on person-data tables ────────────────────────────────
ALTER TABLE person ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY person_rls ON person FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_person(id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint
ALTER TABLE employment ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY employment_rls ON employment FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint
ALTER TABLE assignment ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY assignment_rls ON assignment FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
--> statement-breakpoint
ALTER TABLE leave_request ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY leave_request_rls ON leave_request FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id));
--> statement-breakpoint
ALTER TABLE leave_ledger ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY leave_ledger_rls ON leave_ledger FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id));
--> statement-breakpoint

-- ── Audit log: append-only (ADR-0006) ──────────────────────────────
ALTER TABLE domain_event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY domain_event_read ON domain_event FOR SELECT
  USING (tenant_id = app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY domain_event_append ON domain_event FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON domain_event FROM ai_hr_app;
--> statement-breakpoint

-- ── Temporal integrity: no overlapping *current* assignments ───────
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE assignment ADD CONSTRAINT assignment_no_overlap
  EXCLUDE USING gist (
    employment_id WITH =,
    daterange(valid_from, valid_to, '[)') WITH &&
  ) WHERE (superseded_at IS NULL);
