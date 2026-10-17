-- Company deletion needs a scoped retention fact even after an employee transfers out of scope.
-- Direct app reads retain their current employment visibility. Only the definer-side metadata query
-- can use these policies; no row, employee identity or holiday content is returned by its helper.
CREATE POLICY replacement_holiday_retention_metadata ON public.replacement_holiday FOR SELECT
 USING(current_user<>'ai_hr_app' AND tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
--> statement-breakpoint
CREATE POLICY replacement_holiday_revision_retention_metadata ON public.replacement_holiday_revision FOR SELECT
 USING(current_user<>'ai_hr_app' AND tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id));
--> statement-breakpoint
CREATE FUNCTION app.replacement_holiday_company_in_use(wanted_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT wanted_company IS NOT NULL AND app.current_tenant_id() IS NOT NULL
  AND app.is_admin_for(wanted_company)
  AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id())
  AND (EXISTS(SELECT 1 FROM public.replacement_holiday h WHERE h.company_id=wanted_company AND h.tenant_id=app.current_tenant_id())
   OR EXISTS(SELECT 1 FROM public.replacement_holiday_revision r WHERE r.company_id=wanted_company AND r.tenant_id=app.current_tenant_id()));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.replacement_holiday_company_in_use(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.replacement_holiday_company_in_use(uuid) TO ai_hr_app;
