-- Reversible native necessary-condition experiment. Positives retain the entire original owner.
-- Historical, revoked and foreign-company assignments remain positive candidates; no permission cache.

CREATE OR REPLACE FUNCTION app.contract_has_role(wanted_company uuid,wanted_unit uuid,wanted_role text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN (EXISTS(SELECT 1 FROM public.contract_role_assignment a WHERE a.tenant_id=app.current_tenant_id() AND a.user_id=app.current_user_id() AND a.role=wanted_role)) THEN (
 app.contract_company_entitled(wanted_company) AND app.contract_verified_human(app.current_user_id()) AND (wanted_role NOT IN('pbp','gbs') OR app.contract_canonical_role(wanted_company,wanted_unit,app.current_user_id(),wanted_role)) AND EXISTS(SELECT 1 FROM public.contract_role_assignment a WHERE a.tenant_id=app.current_tenant_id() AND a.company_id=wanted_company AND (a.business_unit_id IS NULL OR a.business_unit_id=wanted_unit) AND a.user_id=app.current_user_id() AND a.revoked_at IS NULL AND a.role=wanted_role AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))
 ) ELSE false END;
$$;

CREATE OR REPLACE FUNCTION app.contract_hr_admin(wanted_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN (EXISTS(SELECT 1 FROM public.role_assignment a WHERE a.tenant_id=app.current_tenant_id() AND a.app_user_id=app.current_user_id() AND a.role::text IN('hr_admin','super_admin'))) THEN (
 app.contract_company_entitled(wanted_company) AND app.contract_active_user(app.current_user_id()) AND EXISTS(SELECT 1 FROM public.role_assignment a WHERE a.tenant_id=app.current_tenant_id() AND a.app_user_id=app.current_user_id() AND a.role::text IN('hr_admin','super_admin') AND (a.company_id IS NULL OR a.company_id=wanted_company OR app.is_company_descendant(wanted_company,a.company_id)))
 ) ELSE false END;
$$;

CREATE OR REPLACE FUNCTION app.contract_configure(wanted_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN (EXISTS(SELECT 1 FROM public.role_assignment a WHERE a.tenant_id=app.current_tenant_id() AND a.app_user_id=app.current_user_id() AND a.role::text IN('hr_admin','super_admin')) OR EXISTS(SELECT 1 FROM public.contract_role_assignment a WHERE a.tenant_id=app.current_tenant_id() AND a.user_id=app.current_user_id() AND a.role='gbs')) THEN (
 app.contract_company_writable(wanted_company) AND app.contract_active_user(app.current_user_id()) AND (app.contract_hr_admin(wanted_company) OR app.contract_has_role(wanted_company,NULL,'gbs'))
 ) ELSE false END;
$$;

CREATE OR REPLACE FUNCTION app.contract_gbs_company_scope(wanted_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN (EXISTS(SELECT 1 FROM public.contract_role_assignment a WHERE a.tenant_id=app.current_tenant_id() AND a.user_id=app.current_user_id() AND a.role='gbs')) THEN (
 app.contract_company_writable(wanted_company) AND app.contract_verified_human(app.current_user_id()) AND EXISTS(SELECT 1 FROM public.contract_role_assignment a WHERE a.tenant_id=app.current_tenant_id() AND a.company_id=wanted_company AND a.user_id=app.current_user_id() AND a.role='gbs' AND a.revoked_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) AND app.contract_canonical_role(wanted_company,a.business_unit_id,a.user_id,'gbs'))
 ) ELSE false END;
$$;
