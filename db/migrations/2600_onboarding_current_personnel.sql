-- Read current Personnel facts only through an already-authorised onboarding case.
-- This is a projection: historical case/revision/private rows are never rewritten on read.
CREATE FUNCTION app.onboarding_current_personnel(p_case uuid,p_day date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.lc_onboarding_case%ROWTYPE; source jsonb; labels jsonb; cfg jsonb; private_access boolean; draft_day date; d public.employee_draft%ROWTYPE;
BEGIN
 IF app.current_user_id() IS NULL OR app.login_blocked(app.current_user_id()) OR p_day IS NULL OR NOT isfinite(p_day) THEN RETURN NULL; END IF;
 SELECT * INTO c FROM public.lc_onboarding_case WHERE id=p_case AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR c.data->>'state' NOT IN ('pending','submitted') OR NOT
   (app.onboarding_participant(c.id) OR app.is_admin_for(c.company_id) OR app.onboarding_v9_page_reader() OR app.onboarding_v9_record_reader()) THEN RETURN NULL; END IF;
 SELECT data INTO cfg FROM public.lc_onboarding_config WHERE tenant_id=c.tenant_id;
 private_access:=app.is_admin_for(c.company_id) AND (coalesce(cfg->'access'->'onboarding','[]'::jsonb) ? app.current_user_id()::text OR app.onboarding_v9_sections() IS NULL OR app.onboarding_v9_sections()->>'hr'='view');
 IF c.employment_id IS NOT NULL THEN
   SELECT jsonb_build_object('fullName',coalesce(p.full_name,''),'employeeId',coalesce(e.employee_code,''),'email',coalesce(p.primary_email,''),
    'joinDate',coalesce(e.join_date,e.hired_on)::text,'company',e.company_id::text,
    'department',coalesce(a.department_id::text,''),'title',coalesce(a.position_id::text,''),
    'businessGroup',coalesce(app.company_org_employment_unchecked(e.id,greatest(p_day,e.hired_on))->>'businessUnitId',''),
    'supervisor',coalesce(rl.manager_employment_id::text,'')) || CASE WHEN private_access THEN jsonb_build_object(
    'costCentre',coalesce(a.cost_center_id::text,''),'ic',coalesce(st.ic_number,''),'passport',coalesce(st.passport_number,'')) ELSE '{}'::jsonb END
   INTO source FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
   LEFT JOIN LATERAL (SELECT x.* FROM public.assignment x WHERE x.employment_id=e.id AND x.tenant_id=e.tenant_id AND x.superseded_at IS NULL
    AND (x.valid_to IS NULL OR x.valid_to>p_day) ORDER BY (x.valid_from<=p_day) DESC,CASE WHEN x.valid_from<=p_day THEN x.valid_from END DESC,x.valid_from,x.id LIMIT 1) a ON true
   LEFT JOIN LATERAL (SELECT x.manager_employment_id FROM public.reporting_line x WHERE x.subordinate_employment_id=e.id AND x.tenant_id=e.tenant_id AND x.line_type='administrative' AND x.superseded_at IS NULL
    AND (x.valid_to IS NULL OR x.valid_to>p_day) ORDER BY (x.valid_from<=p_day) DESC,CASE WHEN x.valid_from<=p_day THEN x.valid_from END DESC,x.valid_from,x.id LIMIT 1) rl ON true
   LEFT JOIN public.employee_statutory_my st ON st.person_id=e.person_id AND st.tenant_id=e.tenant_id AND private_access
   WHERE e.id=c.employment_id AND e.tenant_id=c.tenant_id AND (e.company_id=c.company_id OR app.is_admin_for(c.company_id) AND app.is_admin_for(e.company_id));
 ELSE
   SELECT * INTO d FROM public.employee_draft WHERE id=c.source_draft_id AND tenant_id=c.tenant_id AND company_id=c.company_id;
   IF NOT FOUND THEN RETURN NULL; END IF;
   BEGIN draft_day:=coalesce(nullif(d.data->'employment'->>'hiredOn','')::date,p_day); EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN draft_day:=p_day; END;
   IF NOT isfinite(draft_day) THEN draft_day:=p_day; END IF;
   source:=jsonb_build_object('fullName',coalesce(d.data->'profile'->>'fullName',''),'employeeId',coalesce(d.reserved_employee_code,d.data->'profile'->>'employeeCode',''),
    'email',coalesce(d.data->'profile'->>'primaryEmail',''),'joinDate',coalesce(d.data->'employment'->>'hiredOn',''),'company',d.company_id::text,
    'department',coalesce(d.data->'employment'->>'departmentId',''),'title',coalesce(d.data->'employment'->>'positionId',''),
    'businessGroup',CASE WHEN app.company_organisation_managed() THEN coalesce(app.company_org_tags_unchecked(d.company_id,draft_day)->>'businessUnitId','') ELSE coalesce((SELECT business_unit_id::text FROM public.department WHERE tenant_id=c.tenant_id AND id::text=d.data->'employment'->>'departmentId'),'') END,
    'supervisor',coalesce(d.data->'employment'->>'reportingManagerEmploymentId','')) || CASE WHEN private_access THEN jsonb_build_object(
    'costCentre',coalesce(d.data->'employment'->>'costCenterId',''),'ic',coalesce(d.data->'profile'->>'icNumber',''),'passport',coalesce(d.data->'profile'->>'passportNumber','')) ELSE '{}'::jsonb END;
 END IF;
 IF source IS NULL THEN RETURN NULL; END IF;
 labels:=jsonb_strip_nulls(jsonb_build_object(
  'company',(SELECT legal_name FROM public.company WHERE tenant_id=c.tenant_id AND id::text=source->>'company'),
  'businessGroup',(SELECT name FROM public.business_unit WHERE tenant_id=c.tenant_id AND id::text=source->>'businessGroup'),
  'department',(SELECT name FROM public.department WHERE tenant_id=c.tenant_id AND id::text=source->>'department'),
  'title',(SELECT title FROM public.position WHERE tenant_id=c.tenant_id AND id::text=source->>'title'),
  'supervisor',(SELECT p.full_name FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id WHERE e.tenant_id=c.tenant_id AND e.id::text=source->>'supervisor'),
  'costCentre',(SELECT name FROM public.cost_center WHERE private_access AND tenant_id=c.tenant_id AND id::text=source->>'costCentre')));
 RETURN jsonb_build_object('source',source,'labels',labels);
END $$;
REVOKE ALL ON FUNCTION app.onboarding_current_personnel(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.onboarding_current_personnel(uuid,date) TO ai_hr_app;
