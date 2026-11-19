-- Approved board 989bdb77: scoped Personnel manager delivery identity, independent of login accounts.
-- Reads one authorised lifecycle case, never an arbitrary directory or a caller-supplied manager.
CREATE FUNCTION app.lifecycle_personnel_manager(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject_id uuid; draft_id uuid; case_company_id uuid; manager_id uuid; candidate_ids uuid[];
 manager_name text; manager_email text; active boolean; day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
 system_read boolean:=app.current_user_id() IS NULL AND nullif(current_setting('app.agent_principal_id',true),'') IS NULL AND (session_user='ai_hr_owner' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper));
BEGIN
 IF NOT system_read AND NOT app.lifecycle_recipient_case_allowed(p_case,false) THEN
  RAISE EXCEPTION 'Full lifecycle case access is required' USING ERRCODE='insufficient_privilege';
 END IF;
 SELECT c.employment_id,c.source_draft_id,c.company_id INTO subject_id,draft_id,case_company_id
 FROM public.lc_onboarding_case c WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN
  SELECT nullif(c.data->'facts'->>'employmentId','')::uuid,c.company_id INTO subject_id,case_company_id
  FROM public.lc_v9_case c WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id() AND c.module='off';
 END IF;
 IF case_company_id IS NULL THEN RAISE EXCEPTION 'Lifecycle case unavailable' USING ERRCODE='insufficient_privilege'; END IF;
 IF subject_id IS NOT NULL THEN
  -- One effective administrative relation; duplicate candidates are a hold, never an arbitrary first row.
  SELECT array_agg(DISTINCT r.manager_employment_id ORDER BY r.manager_employment_id) INTO candidate_ids
  FROM public.reporting_line r JOIN public.employment subject ON subject.id=r.subordinate_employment_id AND subject.tenant_id=r.tenant_id
  WHERE r.tenant_id=app.current_tenant_id() AND r.subordinate_employment_id=subject_id AND subject.voided_at IS NULL
   AND r.line_type='administrative' AND r.superseded_at IS NULL AND r.valid_from<=day AND (r.valid_to IS NULL OR r.valid_to>day);
 ELSE
  SELECT CASE WHEN d.data->'employment'->>'reportingManagerEmploymentId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   THEN ARRAY[(d.data->'employment'->>'reportingManagerEmploymentId')::uuid] END INTO candidate_ids
  FROM public.employee_draft d WHERE d.id=draft_id AND d.tenant_id=app.current_tenant_id() AND d.company_id=case_company_id;
 END IF;
 IF coalesce(cardinality(candidate_ids),0)=0 THEN RETURN jsonb_build_object('employmentId',NULL,'name',NULL,'email',NULL,'reason','none'); END IF;
 IF cardinality(candidate_ids)<>1 THEN RETURN jsonb_build_object('employmentId',NULL,'name',NULL,'email',NULL,'reason','ambiguous'); END IF;
 manager_id:=candidate_ids[1];
 SELECT p.full_name,nullif(btrim(p.primary_email),''),
  e.voided_at IS NULL AND e.blacklisted_at IS NULL AND e.hired_on<=day AND (LEAST(e.terminated_on,e.resignation_date,e.last_working_date) IS NULL OR LEAST(e.terminated_on,e.resignation_date,e.last_working_date)>day)
 INTO manager_name,manager_email,active
 FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE e.id=manager_id AND e.tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN RETURN jsonb_build_object('employmentId',manager_id,'name',NULL,'email',NULL,'reason','unavailable'); END IF;
 RETURN jsonb_build_object('employmentId',manager_id,'name',manager_name,'email',CASE WHEN active THEN manager_email END,
  'reason',CASE WHEN NOT active THEN 'inactive' WHEN manager_email IS NULL THEN 'missingEmail' ELSE NULL END);
END;
$$;
REVOKE ALL ON FUNCTION app.lifecycle_personnel_manager(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.lifecycle_personnel_manager(uuid) TO ai_hr_app;
