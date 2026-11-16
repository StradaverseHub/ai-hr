-- Shared Offboarding configuration uses the same tenant-level administrator and Offboarding access
-- facts as the existing V9 configuration owner. Other modules keep their current authority.
CREATE OR REPLACE FUNCTION app.automation_can_configure(p_module text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_tenant_id() IS NOT NULL AND CASE p_module
  WHEN 'probation' THEN app.probation_active_user() AND (app.access_capability_allowed('probation.module',NULL) OR app.probation_permitted_scope('settings.configure',NULL))
  WHEN 'off' THEN app.current_user_id() IS NOT NULL AND app.is_group_admin() AND app.lc_v9_off_access()
  ELSE false END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_can_configure(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.automation_can_configure(text) TO ai_hr_app;

--> statement-breakpoint
-- The Configuration adapter offers twenty authorized sample IDs, without reading case payloads.
CREATE INDEX IF NOT EXISTS lc_onboarding_configuration_preview ON public.lc_onboarding_case(tenant_id,created_at DESC,id DESC) WHERE data->>'state'<>'cancelled';
--> statement-breakpoint
-- Indexed template-usage checks keep the builder independent of case payload readers.
CREATE INDEX IF NOT EXISTS resignation_journey_configuration_refs ON public.resignation_journey USING gin(data jsonb_path_ops);
--> statement-breakpoint
CREATE FUNCTION app.resignation_configuration_usage(p_documents text[],p_emails text[])
RETURNS TABLE(kind text,definition_id text,version integer,documents bigint,messages bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH permitted AS (
  SELECT app.automation_can_configure('off') AND coalesce(cardinality(p_documents),0)<=500 AND coalesce(cardinality(p_emails),0)<=500 AS ok
 ), wanted AS (
  SELECT DISTINCT 'document'::text AS kind,id FROM unnest(p_documents) AS id,permitted WHERE permitted.ok
  UNION SELECT DISTINCT 'email',id FROM unnest(p_emails) AS id,permitted WHERE permitted.ok
 ), hits AS (
  SELECT w.kind,w.id,j.data FROM wanted w JOIN public.resignation_journey j ON j.tenant_id=app.current_tenant_id()
   AND j.data @> CASE w.kind WHEN 'document' THEN jsonb_build_object('letters',jsonb_build_array(jsonb_build_object('templateId',w.id))) ELSE jsonb_build_object('waits',jsonb_build_array(jsonb_build_object('kind','file','templateId',w.id))) END
 ), details AS (
  SELECT h.kind,h.id,(letter->>'templateVersion')::integer AS version,count(*) AS documents,0::bigint AS messages
   FROM hits h CROSS JOIN LATERAL jsonb_array_elements(coalesce(h.data->'letters','[]'::jsonb)) letter
   WHERE h.kind='document' AND letter->>'templateId'=h.id GROUP BY h.kind,h.id,(letter->>'templateVersion')::integer
  UNION ALL
  SELECT h.kind,h.id,NULL::integer,0::bigint,count(*) FROM hits h WHERE h.kind='email' GROUP BY h.kind,h.id
 ) SELECT d.kind,d.id,d.version,d.documents,d.messages FROM details d;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.resignation_configuration_usage(text[],text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.resignation_configuration_usage(text[],text[]) TO ai_hr_app;
--> statement-breakpoint
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
