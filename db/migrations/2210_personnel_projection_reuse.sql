-- Draft append-only repair. Existing callable signatures, owners and grants stay in place.
-- Reuse the exact quality flags for already-admitted rows without re-resolving their tags.
CREATE FUNCTION app.employment_organisation_quality_flags(
  p_employment uuid, p_as_of date, p_hired_on date, p_grade uuid, p_tags jsonb
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,app AS $$
  SELECT CASE WHEN p_tags IS NULL OR p_tags->>'companyId' IS NULL THEN NULL ELSE jsonb_build_object(
    'missing_business_unit', p_hired_on<=p_as_of AND p_tags->>'businessUnitId' IS NULL,
    'missing_job_grade', p_hired_on<=p_as_of AND p_grade IS NULL,
    'missing_direct_superior', p_hired_on<=p_as_of
      AND NOT EXISTS (
        SELECT 1 FROM public.reporting_line r
        WHERE r.tenant_id=app.current_tenant_id()
          AND r.subordinate_employment_id=p_employment AND r.line_type='administrative'
          AND r.superseded_at IS NULL AND r.valid_from<=p_as_of
          AND (r.valid_to IS NULL OR r.valid_to>p_as_of)
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.org_chart_root r
        WHERE r.tenant_id=app.current_tenant_id() AND r.employment_id=p_employment
          AND r.valid_from<=p_as_of AND (r.valid_to IS NULL OR r.valid_to>p_as_of)
      ),
    'company_not_in_structure', p_tags->>'status'='pending'
  ) END
$$;
REVOKE ALL ON FUNCTION app.employment_organisation_quality_flags(uuid,date,date,uuid,jsonb) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.employment_organisation_quality(p_employment uuid,p_as_of date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE tags jsonb; e record;
BEGIN
 tags:=app.employment_organisation_tags(p_employment,p_as_of);
 SELECT id,hired_on,grade_id INTO e FROM public.employment
 WHERE id=p_employment AND tenant_id=app.current_tenant_id() AND voided_at IS NULL;
 IF NOT FOUND OR tags IS NULL OR tags->>'companyId' IS NULL THEN RETURN NULL; END IF;
 RETURN jsonb_build_object(
  'companyId',tags->>'companyId','taggingStatus',tags->>'status','reason',tags->>'reason',
  'flags',app.employment_organisation_quality_flags(e.id,p_as_of,e.hired_on,e.grade_id,tags));
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.personnel_filter_rows(p_as_of date,p_scope uuid[] DEFAULT NULL) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH permitted_companies AS MATERIALIZED (
   SELECT c.id FROM public.company c
   WHERE c.tenant_id=app.current_tenant_id() AND app.access_workforce_projection_company(c.id)
 ),
 -- Caller-selected companies constrain the starting rows only. Permissions for the dated
 -- company, hierarchy and manager are checked against the entire tenant's allowed set.
 admitted AS MATERIALIZED (
   SELECT DISTINCT ON ((a.value->>'employmentId')::uuid) a.value
   FROM app.access_workforce_list_rows() AS a(value)
   JOIN permitted_companies pc ON pc.id=(a.value->>'companyId')::uuid
   WHERE p_scope IS NULL OR pc.id=ANY(p_scope)
   ORDER BY (a.value->>'employmentId')::uuid
 ),
 candidates AS MATERIALIZED (
   SELECT b.value,e.id,e.tenant_id,e.company_id,e.hired_on,e.grade_id,
          e.confirmation_date,e.final_confirmation_date
   FROM admitted b
   JOIN public.employment e ON e.id=(b.value->>'employmentId')::uuid AND e.tenant_id=app.current_tenant_id()
   JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
   JOIN permitted_companies permitted ON permitted.id=e.company_id
   WHERE e.voided_at IS NULL
 ),
 -- Fence the scoped candidates before the raising resolver, then retain its result once per row.
 tagged AS MATERIALIZED (
   SELECT b.*,app.employment_organisation_tags(b.id,p_as_of) AS tags
   FROM candidates b
 ),
 visible AS MATERIALIZED (
   SELECT b.value,b.id,b.tenant_id,b.hired_on,b.grade_id,b.confirmation_date,b.final_confirmation_date,
          a.department_id,a.position_id,a.cost_center_id,a.location_id,a.employment_type,b.tags,
          dated.id AS dated_company_id,
          CASE WHEN b.tags->>'status' IN ('ready','pending') THEN (b.tags->>'businessUnitId')::uuid
            ELSE a.business_unit_id END AS dated_bu_id
   FROM tagged b
   JOIN permitted_companies dated ON dated.id=COALESCE((b.tags->>'companyId')::uuid,b.company_id)
   LEFT JOIN LATERAL (
     SELECT x.department_id,x.position_id,x.business_unit_id,x.cost_center_id,x.location_id,x.employment_type
     FROM public.assignment x
     WHERE x.employment_id=b.id AND x.tenant_id=b.tenant_id AND x.superseded_at IS NULL
       AND x.valid_from<=p_as_of AND (x.valid_to IS NULL OR x.valid_to>p_as_of)
     ORDER BY x.valid_from DESC,x.id DESC LIMIT 1
   ) a ON true
 )
 SELECT v.value||jsonb_build_object(
   'companyId',v.dated_company_id,'company',co.legal_name,
   'departmentId',v.department_id,'department',COALESCE(NULLIF(btrim(d.label),''),d.name),
   'positionId',v.position_id,'position',COALESCE(NULLIF(btrim(pos.label),''),pos.title),
   'employmentType',v.employment_type,
   'businessUnitId',v.dated_bu_id,'businessUnit',bu.name,'jobGradeId',v.grade_id,
   'parentCompanyId',CASE WHEN allowed_parent.id IS NOT NULL THEN v.tags->>'parentCompanyId' END,
   'businessGroupId',CASE WHEN allowed_group.id IS NOT NULL THEN v.tags->>'businessGroupId' END,
   'parentCompany',pc.legal_name,'businessGroup',bg.legal_name,
   'confirmationState',CASE WHEN COALESCE(v.final_confirmation_date,v.confirmation_date)<=p_as_of THEN 'confirmed' ELSE 'unconfirmed' END,
   'jobGradeCode',g.code,'costCenter',cc.name,'workLocation',loc.name,
   'reportingTo',(
     SELECT mp.full_name FROM public.reporting_line r
     JOIN public.employment me ON me.id=r.manager_employment_id AND me.tenant_id=r.tenant_id AND me.voided_at IS NULL
     JOIN permitted_companies manager_scope ON manager_scope.id=me.company_id
     JOIN public.person mp ON mp.id=me.person_id AND mp.tenant_id=me.tenant_id
     WHERE r.tenant_id=v.tenant_id AND r.subordinate_employment_id=v.id AND r.line_type='administrative'
       AND r.superseded_at IS NULL AND r.valid_from<=p_as_of AND (r.valid_to IS NULL OR r.valid_to>p_as_of)
     ORDER BY r.valid_from DESC,r.id LIMIT 1
   ),
   'quality',app.employment_organisation_quality_flags(v.id,p_as_of,v.hired_on,v.grade_id,v.tags)
 )
 FROM visible v
 JOIN public.company co ON co.id=v.dated_company_id AND co.tenant_id=v.tenant_id
 LEFT JOIN public.cost_center cc ON cc.id=v.cost_center_id AND cc.tenant_id=v.tenant_id
 LEFT JOIN public.location loc ON loc.id=v.location_id AND loc.tenant_id=v.tenant_id
 LEFT JOIN public.job_grade g ON g.id=v.grade_id AND g.tenant_id=v.tenant_id
 LEFT JOIN public.business_unit bu ON bu.id=v.dated_bu_id AND bu.tenant_id=v.tenant_id
 LEFT JOIN public.department d ON d.id=v.department_id AND d.tenant_id=v.tenant_id
 LEFT JOIN public.position pos ON pos.id=v.position_id AND pos.tenant_id=v.tenant_id
 LEFT JOIN permitted_companies allowed_parent ON allowed_parent.id=(v.tags->>'parentCompanyId')::uuid
 LEFT JOIN permitted_companies allowed_group ON allowed_group.id=(v.tags->>'businessGroupId')::uuid
 LEFT JOIN public.company pc ON pc.id=allowed_parent.id AND pc.tenant_id=v.tenant_id
 LEFT JOIN public.company bg ON bg.id=allowed_group.id AND bg.tenant_id=v.tenant_id
$$;

--> statement-breakpoint
-- Preserve the existing signatures, SECURITY DEFINER owners, ACLs and trigger binding.
CREATE OR REPLACE FUNCTION app.personnel_private_search_bind() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_day date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.actor_id IS DISTINCT FROM app.current_user_id() OR NOT app.principal_snapshot_current() OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=NEW.actor_id AND u.tenant_id=NEW.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'Private search unavailable' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(NEW.matches)<>'array' OR jsonb_array_length(NEW.matches)>100000 OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.matches)m WHERE COALESCE(m->>'employmentId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR m->>'kind' IS NULL OR m->>'kind' NOT IN ('public','identity') OR COALESCE(m->>'personRevision','') !~ '^[0-9]{1,12}$' OR COALESCE(m->>'employmentRevision','') !~ '^[0-9]{1,12}$' OR (m->>'identityRevision' IS NOT NULL AND m->>'identityRevision' !~ '^[0-9]{1,12}$') OR jsonb_typeof(m)<>'object' OR m-ARRAY['employmentId','kind','personRevision','employmentRevision','identityRevision']<>'{}'::jsonb) THEN RAISE EXCEPTION 'Private search unavailable' USING ERRCODE='22023'; END IF;
 -- Bind exact row identity and revisions before the guarded resolver can run.
 -- PostgreSQL may reorder WHERE predicates, but cannot push them through these fences.
 IF EXISTS (
  WITH entries AS MATERIALIZED (
   SELECT item,ordinal FROM jsonb_array_elements(NEW.matches) WITH ORDINALITY AS m(item,ordinal)
  ),
  matched AS MATERIALIZED (
   SELECT m.ordinal,m.item->>'kind' AS kind,e.id,e.company_id
   FROM entries m
   JOIN public.employment e ON e.id=(m.item->>'employmentId')::uuid AND e.tenant_id=NEW.tenant_id
   JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
   LEFT JOIN public.employee_statutory_my i ON i.person_id=p.id AND i.tenant_id=p.tenant_id
   WHERE e.voided_at IS NULL
     AND e.xmin::text=m.item->>'employmentRevision'
     AND p.xmin::text=m.item->>'personRevision'
     AND (m.item->>'kind'='public' OR i.xmin::text=m.item->>'identityRevision')
  ),
  dated AS MATERIALIZED (
   SELECT m.ordinal,m.kind,
     COALESCE((app.employment_organisation_tags(m.id,v_day)->>'companyId')::uuid,m.company_id) AS company_id
   FROM matched m
  )
  SELECT 1 FROM entries m WHERE NOT EXISTS (
   SELECT 1 FROM dated d
   WHERE d.ordinal=m.ordinal AND app.access_workforce_projection_company(d.company_id)
     AND (d.kind='public' OR app.personnel_identity_search_permitted(d.company_id))
  )
 ) THEN RAISE EXCEPTION 'Private search changed. Try again.' USING ERRCODE='40001'; END IF;
 IF NEW.scope_ids IS NULL OR cardinality(NEW.scope_ids)>1000 OR EXISTS(SELECT 1 FROM unnest(NEW.scope_ids)x WHERE x IS NULL OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=x AND c.tenant_id=NEW.tenant_id AND app.access_workforce_projection_company(c.id))) THEN RAISE EXCEPTION 'Private search scope unavailable' USING ERRCODE='42501'; END IF;
 NEW.scope_ids:=ARRAY(SELECT DISTINCT x FROM unnest(NEW.scope_ids)x ORDER BY x);
 PERFORM pg_advisory_xact_lock(hashtextextended('personnel-private-search:'||NEW.tenant_id::text||':'||NEW.actor_id::text,0));
 NEW.created_at:=clock_timestamp();NEW.expires_at:=NEW.created_at+interval '5 minutes';
 DELETE FROM public.personnel_private_search WHERE tenant_id=NEW.tenant_id AND actor_id=NEW.actor_id AND (expires_at<=now() OR token_hash IN(SELECT token_hash FROM public.personnel_private_search WHERE tenant_id=NEW.tenant_id AND actor_id=NEW.actor_id ORDER BY created_at DESC OFFSET 7));
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.personnel_private_search_matches(p_hash text,p_employment uuid,p_company uuid,p_scope uuid[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH matched AS MATERIALIZED (
  SELECT e.id,e.company_id
  FROM public.personnel_private_search s
  CROSS JOIN LATERAL jsonb_array_elements(s.matches) AS m(item)
  JOIN public.employment e ON e.id=p_employment AND e.tenant_id=s.tenant_id
  JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
  LEFT JOIN public.employee_statutory_my i ON i.person_id=p.id AND i.tenant_id=p.tenant_id
  WHERE app.principal_snapshot_current() AND app.access_workforce_projection_company(p_company)
    AND s.token_hash=p_hash AND s.tenant_id=app.current_tenant_id()
    AND s.actor_id=app.current_user_id() AND s.expires_at>now()
    AND s.scope_ids @> p_scope AND s.scope_ids <@ p_scope
    AND m.item->>'employmentId'=p_employment::text AND e.voided_at IS NULL
    AND e.xmin::text=m.item->>'employmentRevision' AND p.xmin::text=m.item->>'personRevision'
    AND (m.item->>'kind'='public' OR (
      m.item->>'kind'='identity' AND i.xmin::text=m.item->>'identityRevision'
      AND app.personnel_identity_search_permitted(p_company)
    ))
 ),
 dated AS MATERIALIZED (
  SELECT COALESCE((app.employment_organisation_tags(m.id,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
    ->>'companyId')::uuid,m.company_id) AS company_id
  FROM matched m
 )
 SELECT EXISTS (
  SELECT 1 FROM dated d
  WHERE d.company_id=p_company AND app.access_workforce_projection_company(d.company_id)
 )
$$;
