-- UNALLOCATED / UNJOURNALED / UNAPPLIED. Minimal original-actor Payroll CLOSE receipt.
-- No audit SELECT/table grant, role grant, generic event lookup or execution permission.
-- PostgreSQL 16: SECDEF does not itself bypass FORCE RLS. Refuse installation unless the
-- actual function owner can read these tables as their owner or with existing BYPASSRLS.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN ('domain_event','payroll_batch','payroll_anomaly_verdict','payslip','company_payroll_config','employment','person','assignment')
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

--> statement-breakpoint
-- INTERNAL affected-person projection for the ACTUAL selected current/prior/coverage source union.
-- No fresh prior selection: ties validate as candidates of the original latest-earlier-month selector.
-- Relationship checks bound supplied coverage to this run's source graph; trusted canonical source
-- still owns exact selection/provenance (arbitrary SQL cannot prove it used that engine).
CREATE FUNCTION app.payroll_close_source_people(p_batch uuid,p_prior uuid,p_coverage uuid[]) RETURNS uuid[]
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b public.payroll_batch%ROWTYPE;ids uuid[];sources uuid[];
BEGIN
 SELECT * INTO b FROM public.payroll_batch WHERE id=p_batch AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR app.current_user_id() IS NULL OR app.principal_snapshot_current() IS NOT TRUE
  OR app.can_admin_payroll_for(b.company_id) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=b.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'Payroll source unavailable' USING ERRCODE='42501';END IF;
 IF p_coverage IS NULL OR array_position(p_coverage,NULL) IS NOT NULL OR
  coalesce((SELECT array_agg(DISTINCT q ORDER BY q) FROM unnest(p_coverage) q),'{}'::uuid[]) IS DISTINCT FROM p_coverage
 THEN RAISE EXCEPTION 'Payroll source unavailable' USING ERRCODE='42501';END IF;
 IF p_prior IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.payroll_batch prior
  WHERE prior.id=p_prior AND prior.tenant_id=b.tenant_id AND prior.company_id=b.company_id AND prior.pay_period<b.pay_period
   AND NOT EXISTS(SELECT 1 FROM public.payroll_batch newer WHERE newer.company_id=b.company_id AND newer.pay_period<b.pay_period AND newer.pay_period>prior.pay_period))
 THEN RAISE EXCEPTION 'Payroll source unavailable' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM unnest(p_coverage) selected(id) LEFT JOIN public.employment e ON e.id=selected.id AND e.tenant_id=b.tenant_id
  WHERE e.id IS NULL OR NOT(EXISTS(SELECT 1 FROM public.payslip slip WHERE slip.batch_id=b.id AND slip.employment_id=e.id AND slip.tenant_id=b.tenant_id)
   OR (b.run_type='regular' AND e.hired_on<=((b.pay_period||'-01')::date+interval '1 month' - interval '1 day')::date AND (e.terminated_on IS NULL OR e.terminated_on>=(b.pay_period||'-01')::date)
    -- Membership assertion only, matching entityChangedDuring/employedByCompanyDuring in
    -- core/employment-company.ts and the unchanged closeOwed tenure predicate. No new nomination.
    AND EXISTS(SELECT 1 FROM public.assignment changed WHERE changed.employment_id=e.id AND changed.tenant_id=b.tenant_id AND changed.superseded_at IS NULL AND changed.company_id IS NOT NULL AND changed.company_id<>e.company_id AND changed.valid_from<=((b.pay_period||'-01')::date+interval '1 month' - interval '1 day')::date AND (changed.valid_to IS NULL OR changed.valid_to>(b.pay_period||'-01')::date))
    AND (e.company_id=b.company_id OR EXISTS(SELECT 1 FROM public.assignment a WHERE a.employment_id=e.id AND a.tenant_id=b.tenant_id AND a.company_id=b.company_id AND a.superseded_at IS NULL AND a.valid_from<=((b.pay_period||'-01')::date+interval '1 month' - interval '1 day')::date AND (a.valid_to IS NULL OR a.valid_to>(b.pay_period||'-01')::date))))))
 THEN RAISE EXCEPTION 'Payroll source unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}'::uuid[]) INTO sources FROM (
  SELECT slip.employment_id AS id FROM public.payslip slip WHERE slip.batch_id IN (p_batch,p_prior) AND slip.tenant_id=b.tenant_id
  UNION ALL SELECT unnest(p_coverage)
 ) q;
 IF EXISTS(SELECT 1 FROM unnest(sources) q(id) LEFT JOIN public.employment e ON e.id=q.id AND e.tenant_id=b.tenant_id LEFT JOIN public.person p ON p.id=e.person_id AND p.tenant_id=b.tenant_id WHERE e.id IS NULL OR p.id IS NULL)
 THEN RAISE EXCEPTION 'Payroll source unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(array_agg(DISTINCT e.person_id ORDER BY e.person_id),'{}'::uuid[]) INTO ids FROM public.employment e WHERE e.id=ANY(sources) AND e.tenant_id=b.tenant_id;
 RETURN ids;
END $$;
REVOKE ALL ON FUNCTION app.payroll_close_source_people(uuid,uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.payroll_close_source_people(uuid,uuid,uuid[]) TO ai_hr_app;
