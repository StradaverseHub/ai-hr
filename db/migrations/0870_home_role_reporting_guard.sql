-- A reporting edge is necessary, never sufficient, for the existing reports-derived Home role.
-- For an unassigned employee, avoid evaluating visibility across unrelated employment/person rows.
-- If any eligible edge exists, retain the complete original visibility query and every native guard.
-- Function language, volatility, definer, search path, owner and execute ACLs are unchanged.
CREATE OR REPLACE FUNCTION app.own_home_dashboard_role(p_employment uuid) RETURNS text
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app.is_admin_for(proof.company_id) THEN 'hr_admin'
  WHEN app.has_role_for('manager',proof.company_id) OR CASE WHEN EXISTS(
   SELECT 1 FROM public.reporting_line pending_edge
   WHERE pending_edge.manager_employment_id=e.id AND pending_edge.tenant_id=e.tenant_id
    AND pending_edge.valid_to IS NULL AND pending_edge.superseded_at IS NULL
    AND pending_edge.line_type::text<>'delegate'
  ) THEN EXISTS(
   SELECT 1 FROM public.reporting_line r JOIN public.employment report ON report.id=r.subordinate_employment_id
    JOIN public.person subject ON subject.id=report.person_id
   WHERE r.manager_employment_id=e.id AND r.tenant_id=e.tenant_id AND report.tenant_id=e.tenant_id
    AND subject.tenant_id=e.tenant_id AND r.valid_to IS NULL AND r.superseded_at IS NULL
    AND r.line_type::text<>'delegate' AND app.can_see_employment(report.id) AND app.can_see_person(subject.id)
  ) ELSE false END THEN 'manager' ELSE 'employee' END
 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
 CROSS JOIN LATERAL app.proven_company_date_points(jsonb_build_array(jsonb_build_object(
  'employmentId',e.id,'date',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))) proof
 WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()
  AND app.principal_snapshot_current() AND app.is_self_person(e.person_id);
$$;
