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
