-- Picker consumers need seven normal Workforce fields, not every profile/reporting projection.
-- Keep the full authorized population and the existing company/subject/voided-row contract.
CREATE FUNCTION app.access_workforce_picker_facts(wanted_companies uuid[])
RETURNS TABLE(employment_id uuid,name text,employee_code text,company_id uuid,company text,department text,terminated_on date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH permitted AS MATERIALIZED (
  SELECT c.id FROM public.company c
  WHERE c.tenant_id=app.current_tenant_id()
   AND (wanted_companies IS NULL OR c.id=ANY(wanted_companies))
   AND app.access_workforce_projection_company(c.id)
 )
 SELECT e.id,p.full_name,e.employee_code,e.company_id,co.legal_name,
  COALESCE(NULLIF(btrim(d.label),''),d.name),e.terminated_on
 FROM public.employment e JOIN permitted allowed ON allowed.id=e.company_id
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
 LEFT JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.valid_to IS NULL AND a.superseded_at IS NULL
 LEFT JOIN public.department d ON d.id=a.department_id AND d.tenant_id=e.tenant_id
 WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_workforce_picker_facts(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_workforce_picker_facts(uuid[]) TO ai_hr_app;
