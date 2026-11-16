-- Bounded set-based Contract tracker. Source pay is absent from list rows and is separately authorized on detail.
CREATE FUNCTION app.contract_shared_page(p_search text DEFAULT '',p_limit integer DEFAULT 50,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH latest AS MATERIALIZED (
  SELECT DISTINCT ON(c.employment_id) c.* FROM public.contract_case c WHERE c.tenant_id=app.current_tenant_id()
  ORDER BY c.employment_id,(c.data->'term'->>'startOn') DESC,c.created_at DESC,c.id
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
  LEFT JOIN public.contract_shared_case s ON s.tenant_id=c.tenant_id AND s.case_id=c.id
  LEFT JOIN LATERAL(SELECT a.business_unit_id,a.department_id FROM public.assignment a WHERE a.tenant_id=e.tenant_id AND a.employment_id=e.id AND a.superseded_at IS NULL
   AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1) a ON true
  LEFT JOIN public.business_unit bu ON bu.tenant_id=e.tenant_id AND bu.id=a.business_unit_id
  LEFT JOIN public.department dep ON dep.tenant_id=e.tenant_id AND dep.id=a.department_id
  WHERE app.contract_shared_case_permitted(c.id,'view') AND e.voided_at IS NULL AND e.blacklisted_at IS NULL
  AND (coalesce(p_search,'')='' OR concat_ws(' ',p.full_name,e.employee_code,c.number,co.legal_name,bg.legal_name,dep.name) ILIKE '%'||left(p_search,100)||'%')
 ), page AS (
  SELECT * FROM visible ORDER BY "endOn" NULLS LAST,"employeeName",id LIMIT least(greatest(coalesce(p_limit,50),1),100)+1 OFFSET least(greatest(coalesce(p_offset,0),0),100000)
 )
 SELECT jsonb_build_object('rows',coalesce(jsonb_agg(to_jsonb(page) ORDER BY "endOn" NULLS LAST,"employeeName",id),'[]'::jsonb)) FROM page
$$;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_context(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE c public.contract_case;s public.contract_shared_case;source jsonb;rights text[];f jsonb;is_current boolean;
BEGIN
 SELECT * INTO c FROM public.contract_case WHERE tenant_id=app.current_tenant_id() AND id=p_case;
 IF c.id IS NULL OR app.contract_shared_case_permitted(c.id,'view') IS NOT TRUE THEN RETURN NULL;END IF;
 SELECT coalesce(array_agg(permission),'{}'::text[]) INTO rights FROM unnest(ARRAY['view','seePay','decide','decline','manual','workflows','templates','groups','access']::text[]) permission
 WHERE app.contract_shared_case_permitted(c.id,permission);
 SELECT * INTO s FROM public.contract_shared_case WHERE tenant_id=c.tenant_id AND case_id=c.id;
 f:=s.data;is_current:=app.contract_case_company_current(c.id);
 source:=CASE WHEN is_current THEN app.contract_source(c.employment_id) ELSE c.data->'sourceSnapshot' END;
 IF source IS NULL THEN RETURN NULL;END IF;
 source:=source||jsonb_build_object('contractNumber',CASE WHEN is_current THEN (SELECT e.contract_number FROM public.employment e WHERE e.tenant_id=c.tenant_id AND e.id=c.employment_id) ELSE nullif(f->'period'->>'number','')::integer END,'periodRevision',CASE WHEN is_current THEN app.contract_shared_period_revision(c.employment_id) ELSE f->'period'->>'sourceRevision' END);
 source:=source||coalesce((SELECT jsonb_build_object('businessUnitId',source->>'businessGroupId','businessGroupId',bg.id,'businessGroup',bg.legal_name) FROM public.company co JOIN public.company bg ON bg.tenant_id=co.tenant_id AND bg.id=coalesce(co.parent_company_id,co.id) WHERE co.tenant_id=c.tenant_id AND co.id=c.company_id),'{}'::jsonb);
 IF is_current THEN source:=source||coalesce((SELECT jsonb_build_object('departmentId',a.department_id,'jobTitle',source->>'designation') FROM public.assignment a WHERE a.tenant_id=c.tenant_id AND a.employment_id=c.employment_id AND a.superseded_at IS NULL AND a.valid_from<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (a.valid_to IS NULL OR a.valid_to>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) ORDER BY a.valid_from DESC,a.id LIMIT 1),'{}'::jsonb);END IF;
 -- No current Payroll amount, component reference escapes a View-only projection. Agreed decision terms remain part of the case.
 IF NOT is_current OR NOT 'seePay'=ANY(rights) THEN source:=source-ARRAY['salaryCents','allowanceCents','allowanceComponentId','fixedAllowanceId','compensationId'];END IF;

 RETURN jsonb_build_object('id',c.id,'caseNumber',c.number,'companyId',c.company_id,'employmentId',c.employment_id,'permissions',to_jsonb(rights),
  'source',source,'sourceCurrent',is_current,'flow',f,'legacyState',c.data->>'state','sourceConflict',c.source_conflict,
  'cutoverAvailable',is_current AND s.case_id IS NULL AND c.data->>'state' IN('upcoming','decision_pending') AND c.data->'decision'='null'::jsonb AND coalesce(c.data->'decisionDraft','null'::jsonb)='null'::jsonb);
END $$;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_participants(p_case uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',u.id,'name',p.full_name,'role',r.role) ORDER BY r.role,u.id),'[]'::jsonb)
 FROM public.contract_case c CROSS JOIN LATERAL(
  SELECT app.contract_users_for_employment(c.employment_id) AS id,'employee' AS role
  UNION ALL SELECT app.contract_manager_users(c.employment_id),'directSuperior'
 ) r JOIN public.app_user u ON u.tenant_id=c.tenant_id AND u.id=r.id
 JOIN public.person p ON p.tenant_id=u.tenant_id AND p.id=u.person_id
 WHERE c.tenant_id=app.current_tenant_id() AND c.id=p_case AND app.contract_case_company_current(c.id) AND app.contract_shared_case_permitted(c.id,'view')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_shared_page(text,integer,integer),app.contract_shared_context(uuid),app.contract_shared_participants(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_page(text,integer,integer),app.contract_shared_context(uuid),app.contract_shared_participants(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The app reads shaped projections. Raw JSON can contain agreed salaries and is not a View-only read surface.
REVOKE SELECT ON public.contract_shared_case,public.contract_shared_letter FROM ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.contract_shared_preview_references(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF app.automation_can_manage('contract_staff','workflows') IS NOT TRUE OR app.contract_shared_case_permitted(p_case,'view') IS NOT TRUE THEN RAISE EXCEPTION 'Contract preview is unavailable' USING ERRCODE='42501';END IF;
 SELECT jsonb_build_object(
  'participants',app.contract_shared_participants(p_case),
  'templates',app.automation_template_choices('contract_staff'),
  'groups',coalesce((SELECT jsonb_agg(jsonb_build_object('id',g->>'id','name',g->>'name','members',coalesce(g->'members','[]'::jsonb))) FROM
   (SELECT g FROM public.lc_v9_config c CROSS JOIN LATERAL jsonb_array_elements(coalesce(c.data->'groups','[]'::jsonb)) g WHERE c.tenant_id=app.current_tenant_id() LIMIT 200) groups),'[]'::jsonb),
  'people',coalesce((SELECT jsonb_agg(jsonb_build_object('id',u.id,'name',p.full_name)) FROM
   (SELECT id,person_id FROM public.app_user WHERE tenant_id=app.current_tenant_id() AND app.contract_verified_human(id) ORDER BY id LIMIT 2000) u
   JOIN public.person p ON p.id=u.person_id AND p.tenant_id=app.current_tenant_id()),'[]'::jsonb),
  'routings',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.routing_id,'name',r.name,'rows',r.routing_rows)) FROM
   (SELECT DISTINCT ON(v.routing_id) v.routing_id,v.name,v.routing_rows,v.retired FROM public.automation_routing_version v WHERE v.tenant_id=app.current_tenant_id() ORDER BY v.routing_id,v.revision DESC LIMIT 500) r WHERE NOT r.retired),'[]'::jsonb),
  'fallbackGroupId',coalesce((SELECT fallback_group_id FROM public.contract_shared_settings s JOIN public.contract_case c ON c.tenant_id=s.tenant_id AND c.company_id=s.company_id WHERE c.tenant_id=app.current_tenant_id() AND c.id=p_case),(SELECT data->>'peopleOpsGroup' FROM public.lc_v9_config WHERE tenant_id=app.current_tenant_id())),
  'postingApproverGroupId',coalesce((SELECT posting_group_id FROM public.contract_shared_settings s JOIN public.contract_case c ON c.tenant_id=s.tenant_id AND c.company_id=s.company_id WHERE c.tenant_id=app.current_tenant_id() AND c.id=p_case),(SELECT data->>'peopleOpsGroup' FROM public.lc_v9_config WHERE tenant_id=app.current_tenant_id())),
  'documents',coalesce((SELECT jsonb_agg(jsonb_set(d.document,'{actions}',coalesce((SELECT jsonb_agg(a||jsonb_build_object('signature',NULL)) FROM jsonb_array_elements(d.document->'actions') a),'[]'::jsonb))) FROM
   (SELECT data->'document' AS document FROM public.contract_shared_letter WHERE tenant_id=app.current_tenant_id() AND case_id=p_case AND data->>'state'='routing' ORDER BY updated_at DESC,id LIMIT 50) d),'[]'::jsonb)
 ) INTO result;
 RETURN result;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.contract_shared_preview_references(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contract_shared_preview_references(uuid) TO ai_hr_app;
