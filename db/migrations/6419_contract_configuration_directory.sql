-- Retain the literal Contract-only reviewer reader from the inactive mixed5784 source.
-- Guard, returned columns and application EXECUTE remain exactly the reviewed original.
-- Contract configuration uses its current company's owner authority and current eligibility rules.
-- Selected IDs plus explicit search replace preloading one entire directory for every company.
CREATE FUNCTION app.contract_configuration_directory(p_companies uuid[],p_query text,p_users uuid[])
RETURNS TABLE("companyId" uuid,id uuid,name text,"employeeId" text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH wanted AS (
  SELECT DISTINCT c.id FROM public.company c WHERE c.tenant_id=app.current_tenant_id()
   AND coalesce(cardinality(p_companies),0)<=50 AND coalesce(cardinality(p_users),0)<=200
   AND c.id=ANY(p_companies) AND app.contract_configure(c.id)
 ), eligible AS (
  SELECT w.id AS company_id,u.id,coalesce(p.full_name,'Available reviewer') AS name,active.employee_code,
   row_number() over(partition by w.id order by p.full_name,u.id) AS rank
  FROM wanted w JOIN public.app_user u ON u.tenant_id=app.current_tenant_id()
  LEFT JOIN public.person p ON p.id=u.person_id AND p.tenant_id=u.tenant_id
  LEFT JOIN LATERAL(SELECT e.id,e.employee_code FROM public.employment e WHERE e.person_id=u.person_id AND e.tenant_id=u.tenant_id AND e.company_id=w.id AND e.voided_at IS NULL AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (least(e.terminated_on,e.last_working_date,e.resignation_date) IS NULL OR least(e.terminated_on,e.last_working_date,e.resignation_date)>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY e.hired_on DESC,e.id LIMIT 1) active ON true
  WHERE app.contract_active_user(u.id)
   AND (u.id=ANY(p_users) OR length(btrim(p_query))>=2 AND position(lower(left(btrim(p_query),100)) in lower(p.full_name))>0)
   AND (active.id IS NOT NULL OR app.contract_canonical_role(w.id,NULL,u.id,'pbp') OR app.contract_canonical_role(w.id,NULL,u.id,'gbs') OR app.contract_hr_admin(w.id) AND p.id IS NOT NULL AND app.access_workforce_person(p.id,'workforce.view') OR EXISTS(SELECT 1 FROM public.contract_role_assignment a WHERE a.tenant_id=u.tenant_id AND a.company_id=w.id AND a.user_id=u.id AND a.revoked_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)))
 ) SELECT e.company_id,e.id,e.name,e.employee_code FROM eligible e WHERE e.rank<=250 ORDER BY e.company_id,e.name,e.id LIMIT 2000;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_configuration_directory(uuid[],text,uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.contract_configuration_directory(uuid[],text,uuid[]) TO ai_hr_app;
