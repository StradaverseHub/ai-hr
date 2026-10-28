-- 0657 AI integration repairs (28 October 2026), assembled from the full-run repair fragments.
-- Part 1 (payroll-statutory): anomaly gate requires a real verdict row. Part 2 (guards-fixtures):
-- scoped company-in-use check and owner-only retention policies for four AI tables.
-- Depends on 0599, 0622, 0628, 0631 and 0576. Parts are independent of each other.

-- Repair fragment: payroll-statutory (28 October 2026 full-run repair round).
-- Depends on: 0631_payroll_close_source (creates app.payroll_close_anomaly_gate(uuid) with this exact
-- signature and RETURNS TABLE shape), 0576_principal_snapshot_current, and the existing
-- app.can_admin_payroll_for / app.login_blocked / app.current_* helpers. No table, grant or role change.
--
-- Defect: `evaluated` was coalesce(bool_or(v.superseded_at IS NULL),false) over a LEFT JOIN. A batch with
-- NO verdict row yields one null-extended row whose superseded_at IS NULL is true, so every never-evaluated
-- run read as evaluated and the ADR-0076 circuit breaker refused to close runs the anomaly layer never saw.
-- The flag now requires an actual verdict row, matching core/payroll-anomaly.ts anomalyEvaluated(). The
-- blocking flag, the private source version text and the authority predicates are unchanged.
CREATE OR REPLACE FUNCTION app.payroll_close_anomaly_gate(p_batch uuid)
 RETURNS TABLE(blocking boolean,evaluated boolean,source_version text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(bool_or(v.disposition='block' AND v.superseded_at IS NULL AND v.resolved_at IS NULL),false),
  coalesce(bool_or(v.id IS NOT NULL AND v.superseded_at IS NULL),false),
  md5(coalesce(string_agg(v.id::text||':'||v.xmin::text,',' ORDER BY v.id),''))
 FROM public.payroll_batch b LEFT JOIN public.payroll_anomaly_verdict v ON v.batch_id=b.id AND v.tenant_id=b.tenant_id
 WHERE b.id=p_batch AND b.tenant_id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL
  AND app.principal_snapshot_current() AND app.can_admin_payroll_for(b.company_id)
  AND EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id()
   AND u.tenant_id=b.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 GROUP BY b.id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_close_anomaly_gate(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_close_anomaly_gate(uuid) TO ai_hr_app;
--> statement-breakpoint
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
