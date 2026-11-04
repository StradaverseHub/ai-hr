-- Reversible hosted prototype only. Canonical Workforce functions and grants are unchanged.
CREATE FUNCTION app.performance_workforce_list_rows(subject_ids uuid[]) RETURNS SETOF jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF cardinality(subject_ids)>2000 THEN RAISE EXCEPTION 'Too many Workforce subjects' USING ERRCODE='22023';END IF;
 RETURN QUERY

 WITH permitted AS MATERIALIZED (
  SELECT c.id FROM public.company c WHERE c.tenant_id=app.current_tenant_id() AND app.access_workforce_projection_company(c.id)
 )
 SELECT jsonb_build_object(
  'employmentId',e.id,'name',p.full_name,'email',p.primary_email,'employeeCode',e.employee_code,
  'department',COALESCE(NULLIF(btrim(d.label),''),d.name),'departmentId',a.department_id,
  'position',COALESCE(NULLIF(btrim(pos.label),''),pos.title),'company',co.legal_name,'companyId',e.company_id,
  'hiredOn',e.hired_on,'terminatedOn',e.terminated_on,'confirmationDate',e.confirmation_date,
  'finalConfirmationDate',e.final_confirmation_date,'probationEndDate',e.probation_end_date,
  'provisionalEndOn',e.provisional_end_on,'resignationDate',e.resignation_date,'lastWorkingDate',e.last_working_date,
  'blacklistedAt',e.blacklisted_at,'jobGrade',g.name,'employmentType',a.employment_type,
  'businessUnit',COALESCE(NULLIF(btrim(bu.label),''),bu.code),'costCenter',cc.name,'workLocation',loc.name,
  'joinDate',e.join_date,'reportingTo',(
   SELECT mp.full_name FROM public.reporting_line rl
   JOIN public.employment me ON me.id=rl.manager_employment_id AND me.tenant_id=rl.tenant_id AND me.voided_at IS NULL
   JOIN permitted manager_scope ON manager_scope.id=me.company_id
   JOIN public.person mp ON mp.id=me.person_id AND mp.tenant_id=me.tenant_id
   WHERE rl.tenant_id=e.tenant_id AND rl.subordinate_employment_id=e.id AND rl.line_type='administrative'
    AND rl.valid_to IS NULL AND rl.superseded_at IS NULL ORDER BY rl.valid_from DESC,rl.id LIMIT 1))
 FROM public.employment e JOIN permitted allowed ON allowed.id=e.company_id
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
 LEFT JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.valid_to IS NULL AND a.superseded_at IS NULL
 LEFT JOIN public.department d ON d.id=a.department_id AND d.tenant_id=e.tenant_id
 LEFT JOIN public.position pos ON pos.id=a.position_id AND pos.tenant_id=e.tenant_id
 LEFT JOIN public.job_grade g ON g.id=e.grade_id AND g.tenant_id=e.tenant_id
 LEFT JOIN public.business_unit bu ON bu.id=a.business_unit_id AND bu.tenant_id=e.tenant_id
 LEFT JOIN public.cost_center cc ON cc.id=a.cost_center_id AND cc.tenant_id=e.tenant_id
 LEFT JOIN public.location loc ON loc.id=a.location_id AND loc.tenant_id=e.tenant_id
 WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL AND e.id=ANY(subject_ids);
END;
$$;
REVOKE ALL ON FUNCTION app.performance_workforce_list_rows(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.performance_workforce_list_rows(uuid[]) TO ai_hr_app;
CREATE FUNCTION app.performance_workforce_list_facts()
RETURNS TABLE(employment_id uuid,name text,email text,employee_code text,company text,company_id uuid,
 department_id uuid,employment_type text,terminated_on date,final_confirmation_date date,confirmation_date date,
 probation_end_date date,provisional_end_on date,resignation_date date,last_working_date date,blacklisted_at date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH permitted AS MATERIALIZED (
  SELECT c.id FROM public.company c WHERE c.tenant_id=app.current_tenant_id() AND app.access_workforce_projection_company(c.id)
 )
 SELECT e.id,p.full_name,p.primary_email,e.employee_code,co.legal_name,e.company_id,a.department_id,a.employment_type::text,
  e.terminated_on,e.final_confirmation_date,e.confirmation_date,e.probation_end_date,e.provisional_end_on,
  e.resignation_date,e.last_working_date,e.blacklisted_at
 FROM public.employment e JOIN permitted allowed ON allowed.id=e.company_id
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 JOIN public.company co ON co.id=e.company_id AND co.tenant_id=e.tenant_id
 LEFT JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id AND a.valid_to IS NULL AND a.superseded_at IS NULL
 WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL;
$$;
REVOKE ALL ON FUNCTION app.performance_workforce_list_facts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.performance_workforce_list_facts() TO ai_hr_app;
