-- Repair fragment: guards-fixtures (AI integration full-run repair, 28 October 2026).
-- Depends on: 0599_board3_company_retention (pattern), 0622_own_leave_review_store
-- (app.assistant_own_leave_review), 0628_employee_import_ai_evaluation (the three import tables).
-- Consumed by core/company-refs.ts COMPANY_REFERRERS existsFunction 'app.ai_assistance_company_in_use'.
--
-- The four AI tables reference company.id. The company-delete check runs as ai_hr_app, whose RLS
-- view of them is own-user only, so a plain EXISTS would miss another administrator's rows and the
-- delete would fail on a raw foreign-key error. As with 0599, the app receives a scoped boolean only;
-- these owner-only read policies never expose a row to ai_hr_app (FORCE RLS on the 0628 tables means
-- the definer is otherwise filtered too).
CREATE POLICY personnel_import_assistance_company_retention ON public.personnel_import_assistance_attempt FOR SELECT USING(current_user<>'ai_hr_app' AND tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current()) AND app.is_admin_for(company_id));
--> statement-breakpoint
CREATE POLICY employee_import_evaluation_company_retention ON public.employee_import_evaluation_attempt FOR SELECT USING(current_user<>'ai_hr_app' AND tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current()) AND app.is_admin_for(company_id));
--> statement-breakpoint
CREATE POLICY employee_import_evaluation_membership_company_retention ON public.employee_import_evaluation_run_membership FOR SELECT USING(current_user<>'ai_hr_app' AND tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current()) AND app.is_admin_for(company_id));
--> statement-breakpoint
CREATE POLICY assistant_own_leave_review_company_retention ON app.assistant_own_leave_review FOR SELECT USING(current_user<>'ai_hr_app' AND company_id IS NOT NULL AND tenant_id=app.current_tenant_id() AND (SELECT app.principal_snapshot_current()) AND app.is_admin_for(company_id));
--> statement-breakpoint
CREATE FUNCTION app.ai_assistance_company_in_use(wanted_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT wanted_company IS NOT NULL AND app.current_tenant_id() IS NOT NULL
 AND (SELECT app.principal_snapshot_current()) AND app.is_admin_for(wanted_company)
 AND EXISTS(SELECT 1 FROM public.company c WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id())
 AND (EXISTS(SELECT 1 FROM app.assistant_own_leave_review r WHERE r.tenant_id=app.current_tenant_id() AND r.company_id=wanted_company)
 OR EXISTS(SELECT 1 FROM public.personnel_import_assistance_attempt a WHERE a.tenant_id=app.current_tenant_id() AND a.company_id=wanted_company)
 OR EXISTS(SELECT 1 FROM public.employee_import_evaluation_attempt e WHERE e.tenant_id=app.current_tenant_id() AND e.company_id=wanted_company)
 OR EXISTS(SELECT 1 FROM public.employee_import_evaluation_run_membership m WHERE m.tenant_id=app.current_tenant_id() AND m.company_id=wanted_company));
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.ai_assistance_company_in_use(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.ai_assistance_company_in_use(uuid) TO ai_hr_app;
