-- Idle sign-out policy (ADR-0171): one row per organization, written only by its group administrator.
-- No row means the default of 15 minutes. The bounds are the product's: at least 5 minutes, at most the
-- 8-hour absolute session lifetime, and no "off".
CREATE TABLE session_policy (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id),
  idle_timeout_minutes integer NOT NULL CHECK (idle_timeout_minutes BETWEEN 5 AND 480),
  revision integer NOT NULL CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE session_policy ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY session_policy_read ON session_policy FOR SELECT
  USING (tenant_id = app.current_tenant_id() AND app.is_group_admin());
--> statement-breakpoint
CREATE POLICY session_policy_insert ON session_policy FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_group_admin() AND app.principal_snapshot_current());
--> statement-breakpoint
CREATE POLICY session_policy_update ON session_policy FOR UPDATE
  USING (tenant_id = app.current_tenant_id() AND app.is_group_admin() AND app.principal_snapshot_current())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_group_admin() AND app.principal_snapshot_current());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON session_policy TO ai_hr_app;
--> statement-breakpoint
-- The sign-in service checks idle sessions before any tenant context exists. It may learn only the limit.
CREATE FUNCTION app.session_idle_timeout_minutes(p_tenant uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT coalesce((SELECT idle_timeout_minutes FROM public.session_policy WHERE tenant_id = p_tenant), 15) $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.session_idle_timeout_minutes(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.session_idle_timeout_minutes(uuid) TO ai_hr_app;
