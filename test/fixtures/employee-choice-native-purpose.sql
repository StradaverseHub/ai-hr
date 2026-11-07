-- Unnumbered owned-worker prototype only. No production install or allocation.
DO $prototype_guard$
BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres' OR inet_server_addr() IS DISTINCT FROM '127.0.0.1'::inet
 OR current_database() IS DISTINCT FROM current_setting('aihr.employee_choice_probe.database',true)
 OR current_database() !~ '^ai_hr_test_w(_[a-z0-9_]{1,20})?[1-9][0-9]*$'
 OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='app'::regnamespace AND p.proname='employee_choice_native_prototype')
 OR NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid='public.assignment'::regclass
  AND c.conname='assignment_no_overlap' AND c.contype='x' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred
  AND regexp_replace(pg_get_constraintdef(c.oid),'[[:space:]]','','g')=
   regexp_replace($native_constraint$EXCLUDE USING gist (employment_id WITH =, daterange(valid_from, valid_to, '[)'::text) WITH &&) WHERE ((superseded_at IS NULL))$native_constraint$,'[[:space:]]','','g'))
 THEN RAISE EXCEPTION 'Owned native employee-choice prototype database required' USING ERRCODE='55000';END IF;
END $prototype_guard$;

CREATE FUNCTION app.employee_choice_native_prototype(
 p_tenant uuid,p_actor uuid,p_person uuid,p_roles text[],p_grants jsonb,
 p_company_scope uuid[],p_terminated_after date,p_employee_scope uuid[],
 p_company uuid,p_department uuid,p_unit uuid,p_status text,p_search_mode text,p_pattern text,
 p_selected uuid,p_offset bigint,p_limit integer,p_label_mode text,p_port text,p_matched_ids uuid[])
RETURNS TABLE(phase integer,kind text,"employmentId" uuid,name text,"employeeCode" text,"companyId" uuid,
 "departmentId" uuid,"businessUnitId" uuid,status text,label text,code text,total integer)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,pg_temp SET jit=off AS $employee_choice$
DECLARE observed_grants text;
BEGIN
 IF p_company_scope IS NULL OR (cardinality(p_company_scope)>0 AND array_ndims(p_company_scope) IS DISTINCT FROM 1)
 OR (p_employee_scope IS NOT NULL AND cardinality(p_employee_scope)>0 AND array_ndims(p_employee_scope) IS DISTINCT FROM 1)
 OR (p_matched_ids IS NOT NULL AND cardinality(p_matched_ids)>0 AND array_ndims(p_matched_ids) IS DISTINCT FROM 1)
 OR p_roles IS NULL
 OR (cardinality(p_roles)>0 AND array_ndims(p_roles) IS DISTINCT FROM 1)
 THEN RAISE EXCEPTION 'Invalid native employee-choice arrays' USING ERRCODE='22023';END IF;
 IF array_position(p_company_scope,NULL) IS NOT NULL OR array_position(p_employee_scope,NULL) IS NOT NULL
 OR array_position(p_roles,NULL) IS NOT NULL OR array_position(p_matched_ids,NULL) IS NOT NULL
 OR jsonb_typeof(p_grants) IS DISTINCT FROM 'array'
 OR p_status IS NULL OR p_status NOT IN('','active','ended')
 OR p_search_mode IS NULL OR p_search_mode NOT IN('none','ascii','unicode','impossible')
 OR (p_search_mode='ascii' AND (p_pattern IS NULL OR octet_length(convert_to(p_pattern,'UTF8'))<>char_length(p_pattern)))
 OR (p_search_mode<>'ascii' AND p_pattern IS NOT NULL)
 OR p_offset IS NULL OR p_offset<0 OR p_offset>9007199254740991
 OR p_limit IS NULL OR p_limit<1 OR p_limit>2000
 OR p_label_mode IS NULL OR p_label_mode NOT IN('names','labels')
 OR p_port IS NULL OR p_port NOT IN('page','ids','project')
 OR (p_port='ids' AND (p_offset<>0 OR p_selected IS NOT NULL OR p_label_mode<>'names'))
 OR (p_port='project' AND (p_matched_ids IS NULL OR p_search_mode<>'none' OR p_selected IS NOT NULL OR p_label_mode<>'names'))
 OR (p_port<>'project' AND p_matched_ids IS NOT NULL)
 OR (p_terminated_after IS NOT NULL AND (NOT isfinite(p_terminated_after)
  OR p_terminated_after<'0001-01-01'::date OR p_terminated_after>'9999-12-31'::date))
 THEN RAISE EXCEPTION 'Invalid native employee-choice parameters' USING ERRCODE='22023';END IF;
 IF p_matched_ids IS NOT NULL AND cardinality(p_matched_ids)<>(SELECT count(DISTINCT id) FROM unnest(p_matched_ids) id)
 THEN RAISE EXCEPTION 'Invalid native employee-choice projection set' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_grants) g WHERE jsonb_typeof(g) IS DISTINCT FROM 'object'
  OR jsonb_typeof(g->'role') IS DISTINCT FROM 'string' OR NOT (g?'companyId')
  OR jsonb_typeof(g->'companyId') NOT IN('string','null')
  OR (jsonb_typeof(g->'companyId')='string' AND pg_input_is_valid(g->>'companyId','uuid') IS NOT TRUE)
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(g)='object' THEN g ELSE '{}'::jsonb END) k WHERE k NOT IN('role','companyId')))
 THEN RAISE EXCEPTION 'Invalid native employee-choice grants' USING ERRCODE='22023';END IF;
 IF current_user<>'ai_hr_app' OR session_user<>'ai_hr_app'
 OR current_setting('transaction_isolation')<>'repeatable read' OR current_setting('transaction_read_only')<>'on'
 OR nullif(current_setting('app.agent_principal_id',true),'') IS NOT NULL
 OR row_security_active('public.employment'::regclass) IS NOT TRUE OR row_security_active('public.person'::regclass) IS NOT TRUE
 OR row_security_active('public.assignment'::regclass) IS NOT TRUE OR row_security_active('public.company'::regclass) IS NOT TRUE
 OR row_security_active('public.department'::regclass) IS NOT TRUE OR row_security_active('public.business_unit'::regclass) IS NOT TRUE
 OR p_tenant IS NULL OR p_actor IS NULL OR p_tenant IS DISTINCT FROM app.current_tenant_id()
 OR p_actor IS DISTINCT FROM app.current_user_id()
 THEN RAISE EXCEPTION 'Current native employee-choice presentation authority required' USING ERRCODE='42501';END IF;
 observed_grants:=current_setting('app.grants',true);
 IF observed_grants IS NULL OR pg_input_is_valid(observed_grants,'jsonb') IS NOT TRUE
 THEN RAISE EXCEPTION 'Current native employee-choice presentation authority required' USING ERRCODE='42501';END IF;
 IF current_setting('app.roles',true) IS DISTINCT FROM array_to_string(p_roles,',') OR observed_grants::jsonb IS DISTINCT FROM p_grants
 THEN RAISE EXCEPTION 'Current native employee-choice presentation authority required' USING ERRCODE='42501';END IF;
 IF app.principal_snapshot_current() IS NOT TRUE
 OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=p_actor AND u.tenant_id=p_tenant
   AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND u.person_id IS NOT DISTINCT FROM p_person)
 OR (p_label_mode='labels' AND app.is_admin() IS NOT TRUE)
 THEN RAISE EXCEPTION 'Current native employee-choice presentation authority required' USING ERRCODE='42501';END IF;

 RETURN QUERY WITH
 employee_choice_project_ids AS MATERIALIZED(
  SELECT matched.id FROM unnest(p_matched_ids) AS matched(id) WHERE p_port='project'
 ),
 employee_choice_scope_ids AS MATERIALIZED(
  SELECT scoped.id FROM unnest(p_employee_scope) AS scoped(id)
 ),
 employee_choice_employments AS MATERIALIZED(
  SELECT e.id AS "employmentId",e.person_id AS "personId",e.company_id AS "companyId",e.employee_code AS "employeeCode",
   CASE WHEN e.terminated_on IS NULL THEN 'active' ELSE 'ended' END AS status
  FROM public.employment e WHERE e.tenant_id=p_tenant
   AND (cardinality(p_company_scope)=0 OR e.company_id=ANY(p_company_scope))
   AND (p_terminated_after IS NULL OR e.terminated_on IS NULL OR e.terminated_on>p_terminated_after)
   AND (p_employee_scope IS NULL OR (e.id IN(SELECT scoped.id FROM employee_choice_scope_ids scoped)) IS TRUE)
   AND (p_port<>'project' OR (e.id IN(SELECT matched.id FROM employee_choice_project_ids matched)) IS TRUE)
 ),
 employee_choice_people AS MATERIALIZED(
  SELECT p.id AS "personId",p.full_name AS name FROM public.person p
  WHERE p.tenant_id=p_tenant AND (p.id IN(SELECT e."personId" FROM employee_choice_employments e)) IS TRUE
 ),
 employee_choice_assignments AS MATERIALIZED(
  SELECT a.employment_id AS "employmentId",a.department_id AS "departmentId",a.business_unit_id AS "businessUnitId"
  FROM public.assignment a WHERE a.tenant_id=p_tenant AND a.valid_to IS NULL AND a.superseded_at IS NULL
   AND (a.employment_id IN(SELECT e."employmentId" FROM employee_choice_employments e)) IS TRUE
 ),
 employee_choice_companies AS MATERIALIZED(
  SELECT c.id AS "companyId",c.legal_name AS company FROM public.company c
  WHERE c.tenant_id=p_tenant AND (c.id IN(SELECT e."companyId" FROM employee_choice_employments e)) IS TRUE
 ),
 employee_choice_population AS MATERIALIZED(
  SELECT e."employmentId",p.name,e."employeeCode",e."companyId",a."departmentId",a."businessUnitId",e.status
  FROM employee_choice_employments e JOIN employee_choice_people p ON p."personId"=e."personId"
   JOIN employee_choice_companies c ON c."companyId"=e."companyId"
   LEFT JOIN employee_choice_assignments a ON a."employmentId"=e."employmentId"
 ),
 employee_choice_organisation AS MATERIALIZED(
  SELECT DISTINCT p."companyId",p."departmentId",p."businessUnitId" FROM employee_choice_population p
 ),
 employee_choice_matching AS MATERIALIZED(
  SELECT p.* FROM employee_choice_population p WHERE (p_company IS NULL OR p."companyId"=p_company)
   AND (p_department IS NULL OR p."departmentId"=p_department) AND (p_unit IS NULL OR p."businessUnitId"=p_unit)
   AND (p_status='' OR p.status=p_status)
 ),
 employee_choice_count AS MATERIALIZED(
  SELECT count(*)::bigint AS n FROM employee_choice_matching
 ),
 employee_choice_page_window AS MATERIALIZED(
  SELECT least(p_limit::bigint,greatest(0::bigint,c.n-p_offset)) AS k,
   greatest(0::bigint,c.n-p_offset-least(p_limit::bigint,greatest(0::bigint,c.n-p_offset))) AS r
  FROM employee_choice_count c WHERE p_port IN('page','project') AND p_search_mode='none'
 ),
 employee_choice_page_ascending AS MATERIALIZED(
  SELECT page.* FROM employee_choice_page_window w CROSS JOIN LATERAL(
   SELECT m."employmentId",m.name FROM employee_choice_matching m
    ORDER BY m.name,m."employmentId" LIMIT w.k OFFSET p_offset
  ) page WHERE w.k>0 AND p_offset<=w.r
 ),
 employee_choice_page_descending AS MATERIALIZED(
  SELECT page.* FROM employee_choice_page_window w CROSS JOIN LATERAL(
   SELECT m."employmentId",m.name FROM employee_choice_matching m
    ORDER BY m.name DESC,m."employmentId" DESC LIMIT w.k OFFSET w.r
  ) page WHERE w.k>0 AND p_offset>w.r
 ),
 employee_choice_page_keys AS MATERIALIZED(
  SELECT a."employmentId",a.name FROM employee_choice_page_ascending a
  UNION ALL
  SELECT d."employmentId",d.name FROM employee_choice_page_descending d
 ),employee_choice_result AS (
  SELECT m.* FROM employee_choice_matching m
   WHERE p_port IN('page','project') AND p_search_mode='none'
    AND (m."employmentId" IN(SELECT k."employmentId" FROM employee_choice_page_keys k)) IS TRUE
  UNION ALL
  SELECT m.* FROM employee_choice_matching m WHERE (p_port='ids' OR (p_port='page' AND p_search_mode<>'none')) AND
   CASE p_search_mode WHEN 'none' THEN true WHEN 'impossible' THEN false
    WHEN 'unicode' THEN ((m.name COLLATE "C") ~ '[^ -~]' OR (coalesce(m."employeeCode",'') COLLATE "C") ~ '[^ -~]')
    ELSE ((m.name COLLATE "C") ~ '[^ -~]' OR (coalesce(m."employeeCode",'') COLLATE "C") ~ '[^ -~]'
     OR lower(m.name COLLATE "C") LIKE p_pattern ESCAPE E'\\' OR lower(coalesce(m."employeeCode",'') COLLATE "C") LIKE p_pattern ESCAPE E'\\') END
 )
 SELECT stream.* FROM (
  SELECT 0::integer AS phase,'count'::text AS kind,NULL::uuid AS "employmentId",NULL::text AS name,NULL::text AS "employeeCode",
   NULL::uuid AS "companyId",NULL::uuid AS "departmentId",NULL::uuid AS "businessUnitId",NULL::text AS status,NULL::text AS label,NULL::text AS code,
   CASE WHEN p_search_mode='none' THEN (SELECT c.n::integer FROM employee_choice_count c) ELSE NULL::integer END AS total
   WHERE p_port IN('page','project')
  UNION ALL
  SELECT 1,'company',NULL::uuid,NULL::text,NULL::text,c."companyId",NULL::uuid,NULL::uuid,NULL::text,c.company,NULL::text,NULL::integer
   FROM employee_choice_companies c WHERE p_port='page' AND EXISTS(SELECT 1 FROM employee_choice_population p WHERE p."companyId"=c."companyId")
  UNION ALL
  SELECT DISTINCT 2,'department',NULL::uuid,NULL::text,NULL::text,o."companyId",d.id,NULL::uuid,NULL::text,
   CASE WHEN p_label_mode='labels' THEN coalesce(nullif(trim(d.label),''),nullif(trim(d.description),''),d.name) ELSE d.name END,
   CASE WHEN p_label_mode='labels' THEN d.name ELSE NULL::text END,NULL::integer
   FROM employee_choice_organisation o JOIN public.department d ON d.id=o."departmentId" AND d.tenant_id=p_tenant WHERE p_port='page'
  UNION ALL
  SELECT DISTINCT 3,'unit',NULL::uuid,NULL::text,NULL::text,o."companyId",NULL::uuid,u.id,NULL::text,
   CASE WHEN p_label_mode='labels' THEN coalesce(nullif(trim(u.label),''),nullif(trim(u.name),''),u.code) ELSE u.name END,
   CASE WHEN p_label_mode='labels' THEN u.code ELSE NULL::text END,NULL::integer
   FROM employee_choice_organisation o JOIN public.business_unit u ON u.id=o."businessUnitId" AND u.tenant_id=p_tenant WHERE p_port='page'
  UNION ALL
  SELECT 4,'selected',p."employmentId",p.name,p."employeeCode",p."companyId",p."departmentId",p."businessUnitId",p.status,NULL::text,NULL::text,NULL::integer
   FROM employee_choice_population p WHERE p_port='page' AND p."employmentId"=p_selected
  UNION ALL
  SELECT 5,'candidate',r."employmentId",r.name,r."employeeCode",CASE WHEN p_port='project' OR (p_port='page' AND p_search_mode='none') THEN r."companyId" ELSE NULL::uuid END,
   CASE WHEN p_port='project' OR (p_port='page' AND p_search_mode='none') THEN r."departmentId" ELSE NULL::uuid END,
   CASE WHEN p_port='project' OR (p_port='page' AND p_search_mode='none') THEN r."businessUnitId" ELSE NULL::uuid END,
   CASE WHEN p_port='project' OR (p_port='page' AND p_search_mode='none') THEN r.status ELSE NULL::text END,NULL::text,NULL::text,NULL::integer FROM employee_choice_result r
 ) stream;
END;
$employee_choice$;
REVOKE ALL ON FUNCTION app.employee_choice_native_prototype(uuid,uuid,uuid,text[],jsonb,uuid[],date,uuid[],uuid,uuid,uuid,text,text,text,uuid,bigint,integer,text,text,uuid[]) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.employee_choice_native_prototype(uuid,uuid,uuid,text[],jsonb,uuid[],date,uuid[],uuid,uuid,uuid,text,text,text,uuid,bigint,integer,text,text,uuid[]) TO ai_hr_app;
