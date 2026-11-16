-- Shared Offboarding configuration uses the same tenant-level administrator and Offboarding access
-- facts as the existing V9 configuration owner. Other modules keep their current authority.
CREATE OR REPLACE FUNCTION app.automation_can_configure(p_module text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_tenant_id() IS NOT NULL AND CASE p_module
  WHEN 'probation' THEN app.probation_active_user() AND (app.access_capability_allowed('probation.module',NULL) OR app.probation_permitted_scope('settings.configure',NULL))
  WHEN 'off' THEN app.current_user_id() IS NOT NULL AND app.is_group_admin() AND app.lc_v9_off_access()
  ELSE false END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_can_configure(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.automation_can_configure(text) TO ai_hr_app;
