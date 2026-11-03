CREATE OR REPLACE FUNCTION app.employee_master_access_stamp(p_report uuid,p_companies uuid[]) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE actual jsonb;supplied jsonb;actual_roles text[];
BEGIN
 SELECT p.grants INTO actual FROM app.principal(app.current_user_id()) p JOIN app_user u ON u.id=app.current_user_id()
 WHERE p.tenant_id=app.current_tenant_id() AND u.tenant_id=p.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF actual IS NULL OR p_companies IS NULL OR cardinality(p_companies) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Report context unavailable';END IF;
 SELECT coalesce(jsonb_agg(g ORDER BY g->>'role',g->>'companyId'),'[]'::jsonb) INTO actual FROM jsonb_array_elements(actual) g;
 SELECT coalesce(jsonb_agg(g ORDER BY g->>'role',g->>'companyId'),'[]'::jsonb) INTO supplied FROM jsonb_array_elements(coalesce(nullif(current_setting('app.grants',true),'')::jsonb,'[]'::jsonb)) g;
 SELECT array_agg(DISTINCT g->>'role' ORDER BY g->>'role') INTO actual_roles FROM jsonb_array_elements(actual) g;
 IF actual IS DISTINCT FROM supplied OR actual_roles IS DISTINCT FROM ARRAY(SELECT DISTINCT role FROM unnest(app.current_roles()) role ORDER BY role)
 OR EXISTS(SELECT 1 FROM unnest(p_companies) id WHERE NOT EXISTS(SELECT 1 FROM company c WHERE c.id=id AND c.tenant_id=app.current_tenant_id())) THEN RAISE EXCEPTION 'Report context unavailable';END IF;
 IF EXISTS(SELECT 1 FROM unnest(p_companies) id WHERE
  app.function_action_allowed('employeeMasterReports','view',id) IS NOT TRUE
  OR app.pay_formula_category(id,'personnel') IS NOT TRUE) THEN RAISE EXCEPTION 'Report context unavailable' USING ERRCODE='42501';END IF;
 IF p_report IS NOT NULL AND NOT EXISTS(SELECT 1 FROM custom_report r WHERE r.id=p_report AND r.tenant_id=app.current_tenant_id() AND r.dataset_id='master'
 AND app.custom_report_visible(r.created_by_user_id,r.shared,r.shared_role_ids)) THEN RAISE EXCEPTION 'Report unavailable';END IF;
 RETURN encode(sha256(convert_to(jsonb_build_object('actor',app.current_user_id(),'report',p_report,'companies',ARRAY(SELECT DISTINCT id FROM unnest(p_companies) id ORDER BY id),'source',identity_email.report_access_stamp(app.current_tenant_id()))::text,'UTF8')),'hex');
END $$;
--> statement-breakpoint
-- Verify the raw report definition reader still has its restrictive View policy.
CREATE FUNCTION app.employee_master_view_bindings_complete() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
 SELECT EXISTS(
  SELECT FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
  WHERE p.polrelid='public.custom_report'::regclass AND p.polname='employee_master_definition_read'
   AND p.polcmd='r' AND NOT p.polpermissive AND c.relrowsecurity
   AND EXISTS(SELECT FROM pg_depend d WHERE d.classid='pg_policy'::regclass AND d.objid=p.oid
    AND d.refclassid='pg_proc'::regclass AND d.refobjid='app.employee_master_definition_allowed(jsonb,text)'::regprocedure)
 );
$$;
REVOKE ALL ON FUNCTION app.employee_master_view_bindings_complete() FROM PUBLIC,ai_hr_app;
