-- Contract list at group scale (measured 23 November 2026, focused diagnostic runs 45192349790 and 45192363574).
-- app.contract_shared_page evaluated app.contract_shared_case_permitted for every Contract case before taking a
-- page: with 1,000 cases in 70 companies one call took about 1.6 s, 1.6 s of it in the per-case permission check
-- (the same joins alone took 3 ms), and the shared hosted gate timed it out under load.
-- Every row the list joins is company-current (its employment is in the case company), so that check reduces to
-- app.contract_shared_permitted('view',company,group,employment). With no employment the same function is exactly the
-- company-level grant, and an employment only adds superior and People Business Partner grants. The list therefore
-- evaluates the company grant once per company and the full employment check only for cases the company grant does
-- not already permit. Same signature, owner, ACL (CREATE OR REPLACE keeps the 6314 EXECUTE grant), rows and order.
-- Guarded by the exact 6314 list body and the exact 6308 permission body this equivalence depends on.
DO $source_guard$
BEGIN
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='app.contract_shared_page(text,integer,integer)'::regprocedure) IS DISTINCT FROM 'aaae8cc301acf6dde1d9f864d620118aee1cbd7f3fe30a14c89384f6652bcf36' THEN RAISE EXCEPTION 'Expected the original 6314 Contract list source';END IF;
 IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid='app.contract_shared_permitted(text,uuid,uuid,uuid)'::regprocedure) IS DISTINCT FROM '7f85faa8fa3d9873cf637ffb363ed1817b169c034e69fc1eceb30cb40b17836b' THEN RAISE EXCEPTION 'Expected the original 6308 Contract permission source';END IF;
END;
$source_guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.contract_shared_page(p_search text DEFAULT '',p_limit integer DEFAULT 50,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH latest AS MATERIALIZED (
  SELECT DISTINCT ON(c.employment_id) c.* FROM public.contract_case c WHERE c.tenant_id=app.current_tenant_id()
  ORDER BY c.employment_id,(c.data->'term'->>'startOn') DESC,c.created_at DESC,c.id
 ),
 -- Company-level rights once per company: with no employment the shared check is exactly the company grant.
 company_rights AS MATERIALIZED (
  SELECT d.company_id,app.contract_shared_permitted('view',d.company_id,(SELECT coalesce(co.parent_company_id,co.id) FROM public.company co WHERE co.tenant_id=app.current_tenant_id() AND co.id=d.company_id),NULL) AS ok
  FROM (SELECT DISTINCT l.company_id FROM latest l) d
 ), visible AS MATERIALIZED (
  SELECT c.id,c.number AS "caseNumber",c.company_id AS "companyId",c.employment_id AS "employmentId",
   p.full_name AS "employeeName",e.employee_code AS "employeeCode",co.legal_name AS company,
   e.contract_start_date::text AS "startOn",e.contract_end_date::text AS "endOn",e.contract_number AS "contractNumber",
   bg.legal_name AS "businessGroup",coalesce(dep.name,'') AS department,
   s.data->>'stage' AS stage,c.data->>'state' AS "legacyState",s.revision AS "sharedRevision",
   coalesce(s.data->'flags','[]'::jsonb) AS flags,s.updated_at::text AS "lastActivityAt",
   s.data->'payConfirmation' IS DISTINCT FROM 'null'::jsonb AND s.data->'payConfirmation' IS NOT NULL AS "payConfirmed",
   coalesce((s.data->'decision'->>'payChanges')::boolean,false) AS "payChanges"
  FROM latest c JOIN public.employment e ON e.tenant_id=c.tenant_id AND e.id=c.employment_id AND e.company_id=c.company_id
  JOIN public.person p ON p.tenant_id=e.tenant_id AND p.id=e.person_id
  JOIN public.company co ON co.tenant_id=c.tenant_id AND co.id=c.company_id
  JOIN public.company bg ON bg.tenant_id=co.tenant_id AND bg.id=coalesce(co.parent_company_id,co.id)
  JOIN company_rights cr ON cr.company_id=c.company_id
  LEFT JOIN public.contract_shared_case s ON s.tenant_id=c.tenant_id AND s.case_id=c.id
  LEFT JOIN LATERAL(SELECT a.business_unit_id,a.department_id FROM public.assignment a WHERE a.tenant_id=e.tenant_id AND a.employment_id=e.id AND a.superseded_at IS NULL
   AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1) a ON true
  LEFT JOIN public.business_unit bu ON bu.tenant_id=e.tenant_id AND bu.id=a.business_unit_id
  LEFT JOIN public.department dep ON dep.tenant_id=e.tenant_id AND dep.id=a.department_id
  -- Same answer as app.contract_shared_case_permitted(c.id,'view') for these joined (company-current) rows; the
  -- per-employment check runs only where the company grant alone does not already permit the case.
  WHERE CASE WHEN cr.ok THEN true ELSE app.contract_shared_permitted('view',c.company_id,bg.id,c.employment_id) END AND e.voided_at IS NULL AND e.blacklisted_at IS NULL
  AND (coalesce(p_search,'')='' OR concat_ws(' ',p.full_name,e.employee_code,c.number,co.legal_name,bg.legal_name,dep.name) ILIKE '%'||left(p_search,100)||'%')
 ), page AS (
  SELECT * FROM visible ORDER BY "endOn" NULLS LAST,"employeeName",id LIMIT least(greatest(coalesce(p_limit,50),1),100)+1 OFFSET least(greatest(coalesce(p_offset,0),0),100000)
 )
 SELECT jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(page) ORDER BY "endOn" NULLS LAST,"employeeName",id),'[]'::jsonb)) FROM page
$$;
