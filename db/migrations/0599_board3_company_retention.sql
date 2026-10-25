-- Retain Board 3 documents and allocation history when company setup is deleted.
-- The app receives scoped booleans; these owner-only read policies never expose raw rows to ai_hr_app.
--> statement-breakpoint
CREATE POLICY job_document_company_retention ON public.job_document FOR SELECT USING(current_user<>'ai_hr_app' AND tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current()) AND app.is_admin_for(company_id));
--> statement-breakpoint
CREATE POLICY job_document_form_company_retention ON public.job_document_form FOR SELECT USING(current_user<>'ai_hr_app' AND tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current()) AND app.is_admin_for(company_id));
--> statement-breakpoint
CREATE POLICY job_document_revision_source_retention ON public.job_document_revision FOR SELECT USING(current_user<>'ai_hr_app' AND tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current()) AND (EXISTS(SELECT 1 FROM public.business_unit o WHERE o.id=job_document_revision.business_unit_id AND o.tenant_id=job_document_revision.tenant_id AND app.is_admin_for(o.company_id))
 OR EXISTS(SELECT 1 FROM public.department o WHERE o.id=job_document_revision.department_id AND o.tenant_id=job_document_revision.tenant_id AND app.is_admin_for(o.company_id))
 OR EXISTS(SELECT 1 FROM public.location o WHERE o.id=job_document_revision.location_id AND o.tenant_id=job_document_revision.tenant_id AND app.is_admin_for(o.company_id))
 OR EXISTS(SELECT 1 FROM public.position o WHERE o.id=job_document_revision.position_id AND o.tenant_id=job_document_revision.tenant_id AND app.is_admin_for(o.company_id))
 OR EXISTS(SELECT 1 FROM public.position o WHERE o.id=job_document_revision.reports_to_position_id AND o.tenant_id=job_document_revision.tenant_id AND app.is_admin_for(o.company_id))));
--> statement-breakpoint
CREATE FUNCTION app.board3_allocation_company_in_use(wanted_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT wanted_company IS NOT NULL AND app.current_tenant_id() IS NOT NULL
 AND (SELECT app.principal_snapshot_current()) AND app.is_admin_for(wanted_company)
 AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id())
 AND (EXISTS(SELECT 1 FROM public.employment_cost_allocation_set s WHERE s.tenant_id=app.current_tenant_id() AND s.company_id=wanted_company));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.board3_allocation_company_in_use(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.board3_allocation_company_in_use(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.board3_job_company_in_use(wanted_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT wanted_company IS NOT NULL AND app.current_tenant_id() IS NOT NULL
 AND (SELECT app.principal_snapshot_current()) AND app.is_admin_for(wanted_company)
 AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id())
 AND (EXISTS(SELECT 1 FROM public.job_document j WHERE j.tenant_id=app.current_tenant_id() AND j.company_id=wanted_company) OR EXISTS(SELECT 1 FROM public.job_document_form f WHERE f.tenant_id=app.current_tenant_id() AND f.company_id=wanted_company));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.board3_job_company_in_use(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.board3_job_company_in_use(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.board3_source_company_in_use(wanted_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT wanted_company IS NOT NULL AND app.current_tenant_id() IS NOT NULL
 AND (SELECT app.principal_snapshot_current()) AND app.is_admin_for(wanted_company)
 AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id())
 AND (EXISTS(SELECT 1 FROM public.employment_cost_allocation_row r JOIN public.cost_center c ON c.id=r.cost_center_id AND c.tenant_id=r.tenant_id WHERE r.tenant_id=app.current_tenant_id() AND c.company_id=wanted_company) OR EXISTS(SELECT 1 FROM public.job_document_revision r JOIN public.business_unit o ON o.id=r.business_unit_id AND o.tenant_id=r.tenant_id WHERE r.tenant_id=app.current_tenant_id() AND o.company_id=wanted_company)
 OR EXISTS(SELECT 1 FROM public.job_document_revision r JOIN public.department o ON o.id=r.department_id AND o.tenant_id=r.tenant_id WHERE r.tenant_id=app.current_tenant_id() AND o.company_id=wanted_company)
 OR EXISTS(SELECT 1 FROM public.job_document_revision r JOIN public.location o ON o.id=r.location_id AND o.tenant_id=r.tenant_id WHERE r.tenant_id=app.current_tenant_id() AND o.company_id=wanted_company)
 OR EXISTS(SELECT 1 FROM public.job_document_revision r JOIN public.position o ON o.id=r.position_id AND o.tenant_id=r.tenant_id WHERE r.tenant_id=app.current_tenant_id() AND o.company_id=wanted_company)
 OR EXISTS(SELECT 1 FROM public.job_document_revision r JOIN public.position o ON o.id=r.reports_to_position_id AND o.tenant_id=r.tenant_id WHERE r.tenant_id=app.current_tenant_id() AND o.company_id=wanted_company));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.board3_source_company_in_use(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.board3_source_company_in_use(uuid) TO ai_hr_app;
