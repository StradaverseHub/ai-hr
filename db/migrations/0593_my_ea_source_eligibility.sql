-- Own-service metadata only. Does not grant access to an unreleased payslip or change admin EA rules.
-- Reserved Board2 0593@1791900000073. Register after the reviewed lower union through 0592.
-- Former draft reservation 0589 was retired without registration or application.
CREATE FUNCTION app.my_ea_source_options()
RETURNS TABLE(employment_id uuid, employee_code text, company_id uuid, company text,
 country text, year text, available boolean, is_current boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT e.id,e.employee_code,c.id,c.legal_name,c.country,left(b.pay_period,4),
   bool_and(b.status::text='closed' AND (b.released_at IS NULL OR b.released_at<=now())
     AND b.pay_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
   AND NOT EXISTS(SELECT 1 FROM public.payslip malformed JOIN public.payroll_batch bad ON bad.id=malformed.batch_id AND bad.tenant_id=malformed.tenant_id
     WHERE malformed.employment_id=e.id AND malformed.tenant_id=e.tenant_id AND bad.company_id=c.id AND bad.pay_period !~ '^[0-9]{4}'),e.company_id=c.id
 FROM public.app_user u
 JOIN public.employment e ON e.person_id=u.person_id AND e.tenant_id=u.tenant_id
 JOIN public.payslip p ON p.employment_id=e.id AND p.tenant_id=e.tenant_id
 JOIN public.payroll_batch b ON b.id=p.batch_id AND b.tenant_id=e.tenant_id
 JOIN public.company c ON c.id=b.company_id AND c.tenant_id=e.tenant_id
 WHERE app.principal_snapshot_current() AND u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id()
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND b.pay_period ~ '^[0-9]{4}'
 GROUP BY e.id,e.tenant_id,e.employee_code,c.id,c.legal_name,c.country,left(b.pay_period,4),e.company_id
$$;
REVOKE ALL ON FUNCTION app.my_ea_source_options() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_ea_source_options() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.my_ea_source_available(wanted_employment uuid,wanted_company uuid,wanted_year text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT wanted_year ~ '^[0-9]{4}$' AND EXISTS(
  SELECT 1 FROM app.my_ea_source_options() s
  WHERE s.employment_id=wanted_employment AND s.company_id=wanted_company
    AND s.year=wanted_year AND s.available
 );
$$;
REVOKE ALL ON FUNCTION app.my_ea_source_available(uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.my_ea_source_available(uuid,uuid,text) TO ai_hr_app;
