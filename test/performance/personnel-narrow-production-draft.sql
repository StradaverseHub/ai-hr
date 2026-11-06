-- Disposable hosted qualification only. Allocation and application route enablement are separate.
-- The canonical Personnel projection remains the owner of full DTOs. The only change in the
-- bounded reader is narrowing its authorized base rows before assembling the dated DTO.
CREATE FUNCTION app.personnel_overview_page_rows(p_as_of date,p_scope uuid[],p_subjects uuid[]) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH permitted_companies AS MATERIALIZED (
   SELECT c.id FROM public.company c
   WHERE c.tenant_id=app.current_tenant_id() AND app.access_workforce_projection_company(c.id)
 ),
 -- Caller-selected companies constrain the starting rows only. Permissions for the dated
 -- company, hierarchy and manager are checked against the entire tenant's allowed set.
 admitted AS MATERIALIZED (
   SELECT DISTINCT ON ((a.value->>'employmentId')::uuid) a.value
   FROM app._access_workforce_list_rows(CASE WHEN cardinality(p_subjects) BETWEEN 1 AND 2000 THEN p_subjects ELSE ARRAY[]::uuid[] END) AS a(value)
   JOIN permitted_companies pc ON pc.id=(a.value->>'companyId')::uuid
   WHERE pc.id=ANY(p_scope) AND cardinality(p_subjects) BETWEEN 1 AND 2000
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
REVOKE ALL ON FUNCTION app.personnel_overview_page_rows(date,uuid[],uuid[]) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.personnel_overview_page_rows(date,uuid[],uuid[]) TO ai_hr_app;

-- A single non-superseded assignment can cover an employment on any date. The validated,
-- immediate assignment_no_overlap constraint is an explicit installation prerequisite.
-- Keep the first future information-correction event, including a null previous company.
CREATE FUNCTION app.personnel_overview_narrow_rows(p_as_of date,p_scope uuid[]) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH permitted_companies AS MATERIALIZED (
   SELECT c.id FROM public.company c
   WHERE c.tenant_id=app.current_tenant_id() AND app.access_workforce_projection_company(c.id)
 ),
 -- Caller-selected companies constrain the starting rows only. Permissions for the dated
 -- company, hierarchy and manager are checked against the entire tenant's allowed set.
 candidates AS MATERIALIZED (
   SELECT jsonb_build_object('employmentId',e.id,'name',p.full_name,'email',p.primary_email,
      'employeeCode',e.employee_code,'finalConfirmationDate',e.final_confirmation_date,
      'confirmationDate',e.confirmation_date,'probationEndDate',e.probation_end_date,
      'provisionalEndOn',e.provisional_end_on,'resignationDate',e.resignation_date,
      'lastWorkingDate',e.last_working_date,'terminatedOn',e.terminated_on,
      'blacklistedAt',e.blacklisted_at) AS value,
      e.id,e.tenant_id,e.company_id,e.hired_on,e.grade_id,e.confirmation_date,e.final_confirmation_date
   FROM public.employment e
   JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
   JOIN permitted_companies pc ON pc.id=e.company_id
   WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL
     AND pc.id=ANY(p_scope)
 ),
 -- Fence the scoped candidates before the raising resolver, then retain its result once per row.
 future_correction_presence AS MATERIALIZED (
   SELECT EXISTS (
     SELECT 1 FROM public.domain_event ev
     WHERE ev.tenant_id=app.current_tenant_id() AND ev.event_type='employment.information.corrected'
       AND ev.payload->>'effectiveOn'>p_as_of::text
   ) AS present
 ),
 dated AS MATERIALIZED (
   SELECT b.*,a.business_unit_id AS legacy_business_unit_id,a.department_id,a.position_id,a.employment_type,
          coalesce(c.previous_company,a.company_id,b.company_id) AS dated_company
   FROM candidates b
   CROSS JOIN future_correction_presence presence
   LEFT JOIN LATERAL (
     SELECT nullif(ev.payload->'before'->>'companyId','')::uuid AS previous_company
     FROM public.domain_event ev
     WHERE presence.present AND ev.tenant_id=b.tenant_id AND ev.subject_employment_id=b.id
       AND ev.event_type='employment.information.corrected' AND ev.payload->>'effectiveOn'>p_as_of::text
     ORDER BY ev.sequence LIMIT 1
   ) c ON true
   LEFT JOIN public.assignment a ON a.tenant_id=b.tenant_id AND a.employment_id=b.id
     AND a.superseded_at IS NULL AND a.valid_from<=p_as_of AND (a.valid_to IS NULL OR a.valid_to>p_as_of)
 ),
 current_principal AS MATERIALIZED (
   SELECT app.principal_snapshot_current() AS allowed
 ),
 company_tags AS MATERIALIZED (
   SELECT pc.id,app.company_org_tags_unchecked(pc.id,p_as_of) AS tags
   FROM permitted_companies pc
   WHERE p_as_of IS NOT NULL AND isfinite(p_as_of)
     AND (SELECT allowed FROM current_principal)
     AND EXISTS (SELECT 1 FROM dated d WHERE d.dated_company=pc.id)
 ),
 tagged AS MATERIALIZED (
   SELECT d.value,d.id,d.tenant_id,d.company_id,d.hired_on,d.grade_id,
          d.confirmation_date,d.final_confirmation_date,
          d.legacy_business_unit_id,d.department_id,d.position_id,d.employment_type,
          CASE
            WHEN t.tags->>'companyId' IS DISTINCT FROM d.dated_company::text OR t.tags IS NULL
              THEN app.employment_organisation_tags(d.id,p_as_of)
            WHEN t.tags->>'status'='legacy' THEN t.tags||jsonb_build_object('businessUnitId',d.legacy_business_unit_id)
            ELSE coalesce(recorded.tags,t.tags)
          END AS tags
   FROM dated d
   LEFT JOIN company_tags t ON t.id=d.dated_company
   LEFT JOIN LATERAL (
     SELECT c.tags
     FROM public.employment_organisation_classification c
     JOIN public.company_organisation_run r ON r.id=c.mapping_version_id AND r.tenant_id=c.tenant_id
     WHERE t.tags IS NOT NULL AND t.tags->>'status' IS DISTINCT FROM 'legacy'
       AND c.tenant_id=d.tenant_id AND c.employment_id=d.id AND c.company_id=d.dated_company
       AND c.effective_on<=p_as_of AND r.state='published' AND NOT EXISTS (
         SELECT 1 FROM public.company_organisation_mapping m
         JOIN public.company_organisation_run newer ON newer.id=m.run_id AND newer.tenant_id=m.tenant_id
         WHERE m.tenant_id=d.tenant_id AND m.company_id=d.dated_company AND newer.state='published'
           AND newer.effective_on>c.effective_on AND newer.effective_on<=p_as_of
       )
     ORDER BY c.effective_on DESC,c.created_at DESC,c.id DESC LIMIT 1
   ) recorded ON true
 ),
 visible AS MATERIALIZED (
   SELECT b.value,b.id,b.tenant_id,b.hired_on,b.grade_id,b.confirmation_date,b.final_confirmation_date,
          b.department_id,b.position_id,b.employment_type,b.tags,
          dated.id AS dated_company_id,
          CASE WHEN b.tags->>'status' IN ('ready','pending') THEN (b.tags->>'businessUnitId')::uuid
            ELSE b.legacy_business_unit_id END AS dated_bu_id
   FROM tagged b
   JOIN permitted_companies dated ON dated.id=COALESCE((b.tags->>'companyId')::uuid,b.company_id)

 )
 SELECT v.value||jsonb_build_object(
   'companyId',v.dated_company_id,'company',co.legal_name,
   'departmentId',v.department_id,'employmentType',v.employment_type,
   'businessUnitId',v.dated_bu_id,'businessUnit',bu.name,
   'positionId',v.position_id,'position',COALESCE(NULLIF(btrim(pos.label),''),pos.title)
 )
 FROM visible v
 JOIN public.company co ON co.id=v.dated_company_id AND co.tenant_id=v.tenant_id
 LEFT JOIN public.business_unit bu ON bu.id=v.dated_bu_id AND bu.tenant_id=v.tenant_id
 LEFT JOIN public.position pos ON pos.id=v.position_id AND pos.tenant_id=v.tenant_id
$$;
REVOKE ALL ON FUNCTION app.personnel_overview_narrow_rows(date,uuid[]) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.personnel_overview_narrow_rows(date,uuid[]) TO ai_hr_app;
