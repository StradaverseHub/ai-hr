-- Hosted reversible experiment only; no journal identity or installation authority.
CREATE FUNCTION app.performance_approval_subject_batch(subject_ids uuid[],wanted_module text,wanted_task text)
RETURNS TABLE(employment_id uuid,person_id uuid,employee text,employee_code text,company_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF cardinality(subject_ids)>1000 THEN RAISE EXCEPTION 'Too many approval subjects' USING ERRCODE='22023'; END IF;
 RETURN QUERY
 WITH candidates AS MATERIALIZED (
  SELECT e.id,e.person_id,p.full_name,e.employee_code,e.company_id
  FROM public.employment e JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
  WHERE e.tenant_id=app.current_tenant_id() AND e.id=ANY(subject_ids)
 ), companies AS MATERIALIZED (
  SELECT DISTINCT c.company_id FROM candidates c
 ), admin_companies AS MATERIALIZED (
  SELECT c.company_id,app.is_admin_for(c.company_id) AS allowed FROM companies c
 ), non_admin AS MATERIALIZED (
  SELECT c.id FROM candidates c JOIN admin_companies a ON a.company_id=c.company_id WHERE a.allowed IS NOT TRUE
 )
 SELECT c.id,c.person_id,c.full_name,c.employee_code,c.company_id
 FROM candidates c JOIN admin_companies a ON a.company_id=c.company_id WHERE a.allowed
 UNION ALL
 SELECT c.id,s.person_id,s.employee,s.employee_code,s.company_id
 FROM non_admin c JOIN LATERAL app.delegated_approval_subject(c.id,wanted_module,wanted_task) s ON true;
END;
$$;
REVOKE ALL ON FUNCTION app.performance_approval_subject_batch(uuid[],text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.performance_approval_subject_batch(uuid[],text,text) TO ai_hr_app;
