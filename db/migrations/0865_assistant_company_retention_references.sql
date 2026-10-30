-- Coordinator DEV allocation0865 / idx750 / when1793330000265; installation remains held.
-- Universal topology proof: same physical owners, unchanged closed boolean and isolated app.
-- Restricted physical-owner qualification remains a separate hosted/operator acceptance proof.
-- No CI detection, role/owner/FORCE/raw-grant changes, or applied migration rewrites.
DO $retention$ DECLARE helper record;promotion record;review record;app_role record;owner_name name;
BEGIN
 SELECT p.proowner,p.prosecdef,p.provolatile,p.prorettype,p.pronargs,p.proconfig,p.proacl INTO helper
 FROM pg_catalog.pg_proc p WHERE p.oid='app.ai_assistance_company_in_use(uuid)'::regprocedure;
 SELECT relowner,relrowsecurity,relforcerowsecurity INTO promotion FROM pg_catalog.pg_class WHERE oid='public.ai_agent_promotion'::regclass;
 SELECT relowner,relrowsecurity INTO review FROM pg_catalog.pg_class WHERE oid='app.assistant_own_leave_review'::regclass;
 SELECT oid,rolsuper,rolbypassrls,rolcreaterole INTO app_role FROM pg_catalog.pg_roles WHERE rolname='ai_hr_app';
 IF helper.proowner IS NULL OR app_role.oid IS NULL OR helper.proowner IS DISTINCT FROM promotion.relowner OR helper.proowner IS DISTINCT FROM review.relowner
  OR helper.proowner=app_role.oid OR helper.prosecdef IS DISTINCT FROM true OR helper.provolatile IS DISTINCT FROM 's'
  OR helper.prorettype IS DISTINCT FROM 'boolean'::regtype OR helper.pronargs IS DISTINCT FROM 1
  OR helper.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
  OR app_role.rolsuper IS DISTINCT FROM false OR app_role.rolbypassrls IS DISTINCT FROM false OR app_role.rolcreaterole IS DISTINCT FROM false
  OR review.relrowsecurity IS DISTINCT FROM true OR promotion.relrowsecurity IS DISTINCT FROM true OR promotion.relforcerowsecurity IS DISTINCT FROM true
  OR pg_catalog.pg_has_role(app_role.oid,helper.proowner,'MEMBER') OR pg_catalog.pg_has_role(app_role.oid,helper.proowner,'USAGE') OR pg_catalog.pg_has_role(app_role.oid,helper.proowner,'SET')
  OR NOT pg_catalog.has_function_privilege(app_role.oid,'app.ai_assistance_company_in_use(uuid)','EXECUTE')
  OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(coalesce(helper.proacl,pg_catalog.acldefault('f',helper.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') THEN
  RAISE EXCEPTION 'Company retention exact owner or app boundary unavailable';
 END IF;
 owner_name:=pg_catalog.pg_get_userbyid(promotion.relowner);
 -- TO the checked owner AND exact current_user equality. Common ownership alone is not purpose isolation.
 EXECUTE format('CREATE POLICY ai_agent_promotion_company_retention ON public.ai_agent_promotion FOR SELECT TO %I USING(current_user=pg_catalog.pg_get_userbyid((SELECT relowner FROM pg_catalog.pg_class WHERE oid=''public.ai_agent_promotion''::regclass)) AND company_id IS NOT NULL AND tenant_id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() IS TRUE AND app.is_admin_for(company_id) IS TRUE)',owner_name);
END $retention$;
--> statement-breakpoint
-- Same signature, owner, ACL and scoped boolean. All retained states count until their own
-- retention owner actually removes them. Never lend native row/ciphertext/candidate visibility.
CREATE OR REPLACE FUNCTION app.ai_assistance_company_in_use(wanted_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT wanted_company IS NOT NULL AND app.current_tenant_id() IS NOT NULL
 AND app.current_user_id() IS NOT NULL
 AND app.principal_snapshot_current() IS TRUE AND app.is_admin_for(wanted_company) IS TRUE
 AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id())
 AND (EXISTS(SELECT 1 FROM app.assistant_own_leave_review r WHERE r.tenant_id=app.current_tenant_id()
           AND (r.company_id=wanted_company OR r.allocation_effective_company_id=wanted_company))
 OR EXISTS(SELECT 1 FROM public.ai_agent_promotion p WHERE p.tenant_id=app.current_tenant_id() AND p.company_id=wanted_company)
 OR EXISTS(SELECT 1 FROM public.personnel_import_assistance_attempt a WHERE a.tenant_id=app.current_tenant_id() AND a.company_id=wanted_company)
 OR EXISTS(SELECT 1 FROM public.employee_import_evaluation_attempt e WHERE e.tenant_id=app.current_tenant_id() AND e.company_id=wanted_company)
 OR EXISTS(SELECT 1 FROM public.employee_import_evaluation_run_membership m WHERE m.tenant_id=app.current_tenant_id() AND m.company_id=wanted_company));
$$;
