-- INACTIVE forward proposal: coordinator owns fresh allocation and registration.
-- Restore ONLY the existing user-approved Offboarding configuration conjunction.
-- No new grant, role, function, execution path, table, policy or column.
DO $$ BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='app.automation_can_configure(text)'::regprocedure)
  IS DISTINCT FROM '90a7fc6228997080ffad60011c50bc1be22f538ecfef4f3616f9d414a2a5a362' THEN RAISE EXCEPTION 'Expected selected native shared builder configure owner before approved Offboarding compatibility';END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automation_can_configure(p_module text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_tenant_id() IS NOT NULL AND CASE p_module
 WHEN 'probation' THEN app.probation_active_user() AND (app.access_capability_allowed('probation.module',NULL) OR app.probation_permitted_scope('settings.configure',NULL))
 WHEN 'contract_staff' THEN app.contract_verified_human(app.current_user_id()) AND EXISTS(SELECT 1 FROM public.company c
 WHERE c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL AND (app.contract_shared_permitted('workflows',c.id) OR app.contract_shared_permitted('templates',c.id) OR app.contract_shared_permitted('groups',c.id)))
 WHEN 'off' THEN app.current_user_id() IS NOT NULL AND app.is_group_admin() AND app.lc_v9_off_access()
 ELSE false END
$$;
