-- User explicitly approved restoring these three existing Offboarding branches on 17 November 2026.
-- Preserve existing Probation/Contract guards and function ACLs; introduce no roles or grants.
CREATE OR REPLACE FUNCTION app.automation_can_configure(p_module text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_tenant_id() IS NOT NULL AND CASE p_module
 WHEN 'probation' THEN app.probation_active_user() AND (app.access_capability_allowed('probation.module',NULL) OR app.probation_permitted_scope('settings.configure',NULL))
 WHEN 'contract_staff' THEN app.contract_verified_human(app.current_user_id()) AND EXISTS(SELECT 1 FROM public.company c
 WHERE c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL AND (app.contract_shared_permitted('workflows',c.id) OR app.contract_shared_permitted('templates',c.id) OR app.contract_shared_permitted('groups',c.id)))
 WHEN 'off' THEN app.current_user_id() IS NOT NULL AND app.is_group_admin() AND app.lc_v9_off_access()
 ELSE false END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automation_run_subject_access(p_module text,p_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.current_tenant_id() IS NOT NULL AND CASE p_module
 WHEN 'probation' THEN app.probation_active_user() AND app.probation_case_access(p_subject)
 WHEN 'contract_staff' THEN app.contract_shared_case_permitted(p_subject,'view')
 WHEN 'off' THEN app.resignation_journey_access(p_subject)
 ELSE false END,false)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automation_can_run(p_module text,p_subject uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.current_tenant_id() IS NOT NULL AND p_subject IS NOT NULL AND CASE p_module
 WHEN 'probation' THEN app.probation_storage_runner() OR app.automation_run_subject_access(p_module,p_subject)
 WHEN 'contract_staff' THEN EXISTS(SELECT 1 FROM public.contract_shared_event e WHERE e.tenant_id=app.current_tenant_id() AND e.case_id=p_subject AND e.id::text=current_setting('app.contract_event',true)
 AND app.contract_shared_worker_event_held(e.case_id,e.decision_revision))
 WHEN 'off' THEN app.resignation_runtime_intent(p_subject)
 ELSE false END,false)
$$;
