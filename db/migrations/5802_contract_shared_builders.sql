-- Register Contract configuration with the existing shared definition stores. Existing Probation permissions remain.
CREATE OR REPLACE FUNCTION app.automation_can_configure(p_module text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_tenant_id() IS NOT NULL AND CASE p_module
 WHEN 'probation' THEN app.probation_active_user() AND (app.access_capability_allowed('probation.module',NULL) OR app.probation_permitted_scope('settings.configure',NULL))
 WHEN 'contract_staff' THEN app.contract_verified_human(app.current_user_id()) AND EXISTS(SELECT 1 FROM public.company c
 WHERE c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL AND app.contract_shared_permitted('builders',c.id))
 ELSE false END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automation_run_subject_access(p_module text,p_subject uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.current_tenant_id() IS NOT NULL AND CASE p_module
 WHEN 'probation' THEN app.probation_active_user() AND app.probation_case_access(p_subject)
 WHEN 'contract_staff' THEN app.contract_shared_case_permitted(p_subject,'view') OR app.contract_shared_letter_assigned(p_subject)
 ELSE false END,false)
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.automation_can_run(p_module text,p_subject uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.current_tenant_id() IS NOT NULL AND p_subject IS NOT NULL AND CASE p_module
 WHEN 'probation' THEN app.probation_storage_runner() OR app.automation_run_subject_access(p_module,p_subject)
 WHEN 'contract_staff' THEN EXISTS(SELECT 1 FROM public.contract_shared_case c WHERE c.tenant_id=app.current_tenant_id() AND c.case_id=p_subject)
 AND (app.acting_as_owner() AND app.current_user_id() IS NULL OR app.automation_run_subject_access(p_module,p_subject))
 ELSE false END,false)
$$;
