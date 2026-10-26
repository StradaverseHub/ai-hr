-- UNALLOCATED / UNJOURNALED / UNAPPLIED. Minimal original-actor Payroll CLOSE receipt.
-- No audit SELECT/table grant, role grant, generic event lookup or execution permission.
-- PostgreSQL 16: SECDEF does not itself bypass FORCE RLS. Refuse installation unless the
-- actual function owner can read these tables as their owner or with existing BYPASSRLS.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN ('domain_event','payroll_batch','payroll_anomaly_verdict','payslip','company_payroll_config')
   AND NOT EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=current_user
    AND (r.rolsuper OR r.rolbypassrls OR (c.relowner=r.oid AND NOT c.relforcerowsecurity))))
 THEN RAISE EXCEPTION 'Payroll close receipt owner unavailable'; END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.read_own_payroll_close_event(p_batch uuid,p_event uuid)
 RETURNS TABLE(event_id uuid,batch_id uuid,released_at text)
 LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT e.id,b.id,e.payload->>'releasedAt'
 FROM public.payroll_batch b JOIN public.domain_event e ON e.aggregate_id=b.id
 WHERE app.current_user_id() IS NOT NULL AND app.principal_snapshot_current()
  AND EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id()
   AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
  AND b.id=p_batch AND b.tenant_id=app.current_tenant_id() AND app.can_admin_payroll_for(b.company_id)
  AND e.id=p_event AND e.tenant_id=b.tenant_id AND e.aggregate_type='payroll-batch'
  AND e.event_type='payroll-batch.closed' AND e.actor_type='user' AND e.actor_id=app.current_user_id()
  AND jsonb_typeof(e.payload->'releasedAt')='string'
$$;
REVOKE ALL ON FUNCTION app.read_own_payroll_close_event(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_own_payroll_close_event(uuid,uuid) TO ai_hr_app;

--> statement-breakpoint
-- Canonical CLOSE gate: a transferred-out subject's RLS-hidden verdict must never mean clear.
-- Fixed flags only; private version commitment is internal reviewed-source custody, not public review.
-- Predicates match openBlockingVerdicts/anomalyEvaluated, including their supersession/resolution rules.
CREATE FUNCTION app.payroll_close_anomaly_gate(p_batch uuid)
 RETURNS TABLE(blocking boolean,evaluated boolean,source_version text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(bool_or(v.disposition='block' AND v.superseded_at IS NULL AND v.resolved_at IS NULL),false),
  coalesce(bool_or(v.superseded_at IS NULL),false),
  md5(coalesce(string_agg(v.id::text||':'||v.xmin::text,',' ORDER BY v.id),''))
 FROM public.payroll_batch b LEFT JOIN public.payroll_anomaly_verdict v ON v.batch_id=b.id AND v.tenant_id=b.tenant_id
 WHERE b.id=p_batch AND b.tenant_id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL
  AND app.principal_snapshot_current() AND app.can_admin_payroll_for(b.company_id)
  AND EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id()
   AND u.tenant_id=b.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 GROUP BY b.id
$$;
REVOKE ALL ON FUNCTION app.payroll_close_anomaly_gate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_close_anomaly_gate(uuid) TO ai_hr_app;

--> statement-breakpoint
-- INTERNAL canonical CLOSE inputs only. Exact native SUM(...net_pay)::float8 and prior-month DESC
-- LIMIT 1 selection (ties intentionally unspecified). No threshold/verdict/financial rule duplicated.
-- Actual current company decides scope; caller cannot supply a prior run or another company.
-- Private visibility flag mirrors CURRENT0492 payslip admin-or-self policy, never manager can_see.
CREATE FUNCTION app.payroll_close_circuit_inputs(p_batch uuid)
 RETURNS TABLE(batch_id uuid,company_id uuid,prior_batch_id uuid,current_net float8,prior_net float8,source_version text,inputs_visible boolean)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH target AS (
  SELECT b.id,b.company_id,b.pay_period,b.xmin::text AS version FROM public.payroll_batch b
  WHERE b.id=p_batch AND b.tenant_id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL
   AND app.principal_snapshot_current() AND app.can_admin_payroll_for(b.company_id)
   AND EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id()
    AND u.tenant_id=b.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 ), selected AS (
  SELECT t.*,p.id AS prior_id,p.xmin::text AS prior_version FROM target t
  LEFT JOIN LATERAL (SELECT b.id,b.xmin FROM public.payroll_batch b
   WHERE b.company_id=t.company_id AND b.pay_period<t.pay_period ORDER BY b.pay_period DESC LIMIT 1) p ON true
 )
 SELECT s.id,s.company_id,s.prior_id,
  (SELECT coalesce(sum(p.net_pay),0)::float8 FROM public.payslip p WHERE p.batch_id=s.id),
  (SELECT coalesce(sum(p.net_pay),0)::float8 FROM public.payslip p WHERE p.batch_id=s.prior_id),
  md5(s.version||':'||coalesce(s.prior_version,'')||':'||coalesce(s.prior_id::text,'')||':'||
   coalesce((SELECT string_agg(p.id::text||':'||p.xmin::text,',' ORDER BY p.id) FROM public.payslip p WHERE p.batch_id=s.id OR p.batch_id=s.prior_id),'')),
  NOT EXISTS(SELECT 1 FROM public.payslip p WHERE (p.batch_id=s.id OR p.batch_id=s.prior_id)
   AND (app.can_admin_payroll_employment(p.employment_id) OR EXISTS(SELECT 1 FROM public.employment e
     WHERE e.id=p.employment_id AND app.is_self_person(e.person_id))) IS NOT TRUE)
 FROM selected s
$$;
REVOKE ALL ON FUNCTION app.payroll_close_circuit_inputs(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_close_circuit_inputs(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Fixed CLOSE-only company input. No other company profile or financial fields are selected. The
-- trusted canonical resolver still owns default-policy precedence/cutoff windows/release semantics.
CREATE FUNCTION app.payroll_close_configuration(p_batch uuid)
 RETURNS TABLE(batch_id uuid,company_id uuid,config jsonb,source_version text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT b.id,b.company_id,CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object(
  'cutOffDay',c.cut_off_day,'overtimeCutOffDay',c.overtime_cut_off_day,'claimCutOffDay',c.claim_cut_off_day,
  'unpaidLeaveCutOffDay',c.unpaid_leave_cut_off_day,'attendanceCutOffDay',c.attendance_cut_off_day,
  'defaultPayrollPolicyId',c.default_payroll_policy_id,'payDay',c.pay_day,'payslipRelease',c.payslip_release) END,
  md5(coalesce(c.id::text||':'||c.xmin::text,''))
 FROM public.payroll_batch b LEFT JOIN public.company_payroll_config c ON c.company_id=b.company_id AND c.tenant_id=b.tenant_id
 WHERE b.id=p_batch AND b.tenant_id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL
  AND app.principal_snapshot_current() AND app.can_admin_payroll_for(b.company_id)
  AND EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id()
   AND u.tenant_id=b.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
$$;
REVOKE ALL ON FUNCTION app.payroll_close_configuration(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_close_configuration(uuid) TO ai_hr_app;
