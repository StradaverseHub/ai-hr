-- Disposable fictional-runner prototype only. Preserve the native projection authority and dated predicates.
CREATE FUNCTION app.performance_personnel_filter_fields(p_as_of date,p_scope uuid[]) RETURNS TABLE (
 "employmentId" uuid,name text,email text,"employeeCode" text,
 "finalConfirmationDate" date,"confirmationDate" date,"probationEndDate" date,"provisionalEndOn" date,
 "resignationDate" date,"lastWorkingDate" date,"terminatedOn" date,"blacklistedAt" timestamptz,
 "companyId" uuid,company text,"departmentId" uuid,"employmentType" text,
 "businessUnitId" uuid,"businessUnit" text,"positionId" uuid,position text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH permitted_companies AS MATERIALIZED (
   SELECT c.id FROM public.company c
   WHERE c.tenant_id=app.current_tenant_id() AND app.access_workforce_projection_company(c.id)
 ),
 -- Caller-selected companies constrain the starting rows only. Permissions for the dated
 -- company, hierarchy and manager are checked against the entire tenant's allowed set.
 candidates AS MATERIALIZED (
   SELECT p.full_name AS name,p.primary_email AS email,e.employee_code,
      e.probation_end_date,e.provisional_end_on,e.resignation_date,e.last_working_date,e.terminated_on,e.blacklisted_at,
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
   SELECT d.*,
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
   SELECT b.*,
          dated.id AS dated_company_id,
          CASE WHEN b.tags->>'status' IN ('ready','pending') THEN (b.tags->>'businessUnitId')::uuid
            ELSE b.legacy_business_unit_id END AS dated_bu_id
   FROM tagged b
   JOIN permitted_companies dated ON dated.id=COALESCE((b.tags->>'companyId')::uuid,b.company_id)

 )
 SELECT v.id,v.name,v.email,v.employee_code,
   v.final_confirmation_date,v.confirmation_date,v.probation_end_date,v.provisional_end_on,
   v.resignation_date,v.last_working_date,v.terminated_on,v.blacklisted_at,
   v.dated_company_id,co.legal_name,v.department_id,v.employment_type::text,
   v.dated_bu_id,bu.name,v.position_id,COALESCE(NULLIF(btrim(pos.label),''),pos.title)
 FROM visible v
 JOIN public.company co ON co.id=v.dated_company_id AND co.tenant_id=v.tenant_id
 LEFT JOIN public.business_unit bu ON bu.id=v.dated_bu_id AND bu.tenant_id=v.tenant_id
 LEFT JOIN public.position pos ON pos.id=v.position_id AND pos.tenant_id=v.tenant_id
$$;
REVOKE ALL ON FUNCTION app.performance_personnel_filter_fields(date,uuid[]) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.performance_personnel_filter_fields(date,uuid[]) TO ai_hr_app;
