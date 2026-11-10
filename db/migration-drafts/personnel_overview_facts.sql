-- UNALLOCATED DRAFT MIGRATION — not in db/migrations/meta/_journal.json and not applied by db:migrate.
-- Allocate it through docs/MIGRATION-ALLOCATION.md (and move it into db/migrations) before release.
-- core/read.ts detects these functions inside its existing bounds statement and keeps the current
-- Personnel readers when they are absent, so the application is correct with or without this draft.
-- The same installation prerequisites as 2403 and 2701.
DO $personnel_assignment_prerequisite$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.oid='app.personnel_filter_rows(date,uuid[])'::regprocedure
      AND p.prosecdef AND pg_catalog.pg_get_userbyid(p.proowner)=current_user
  ) THEN
    RAISE EXCEPTION 'Personnel overview must use the existing projection owner' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_index i ON i.indexrelid=c.conindid AND i.indrelid=c.conrelid
    WHERE c.conrelid='public.assignment'::regclass AND c.conname='assignment_no_overlap'
      AND c.contype='x' AND c.convalidated AND NOT c.condeferrable
      AND i.indisvalid AND i.indisready AND i.indimmediate
      AND pg_catalog.pg_get_constraintdef(c.oid,true)=
        'EXCLUDE USING gist (employment_id WITH =, daterange(valid_from, valid_to, ''[)''::text) WITH &&) WHERE (superseded_at IS NULL)'
  ) THEN
    RAISE EXCEPTION 'Personnel overview requires the reviewed immediate assignment exclusion constraint' USING ERRCODE='55000';
  END IF;
END;
$personnel_assignment_prerequisite$;
--> statement-breakpoint
-- Complete typed Personnel facts: every list filter, sort key and data-quality flag, evaluated set-wise.
-- Authority, dated company/assignment and organisation tags follow app.personnel_overview_filter_fields
-- (2701) exactly; the additional columns repeat the canonical JSON owners (2129/2139 list rows and 2210
-- personnel_filter_rows) per key, so a typed predicate or sort reads the same value the JSON row carries.
CREATE FUNCTION app.personnel_overview_facts(p_as_of date,p_scope uuid[]) RETURNS TABLE (
 "employmentId" uuid,name text,email text,"employeeCode" text,
 "finalConfirmationDate" date,"confirmationDate" date,"probationEndDate" date,"provisionalEndOn" date,
 "resignationDate" date,"lastWorkingDate" date,"terminatedOn" date,"blacklistedAt" date,
 "companyId" uuid,company text,"departmentId" uuid,department text,"employmentType" text,
 "businessUnitId" uuid,"businessUnit" text,"positionId" uuid,"position" text,
 "parentCompanyId" uuid,"businessGroupId" uuid,"jobGrade" text,"jobGradeCode" text,
 "hiredOn" date,"joinDate" date,"costCenter" text,"workLocation" text,"reportingTo" text,
 "confirmationState" text,"qualityMissingBusinessUnit" boolean,"qualityMissingJobGrade" boolean,
 "qualityMissingDirectSuperior" boolean,"qualityCompanyNotInStructure" boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH permitted_companies AS MATERIALIZED (
   SELECT c.id FROM public.company c
   WHERE c.tenant_id=app.current_tenant_id() AND app.access_workforce_projection_company(c.id)
 ),
 candidates AS MATERIALIZED (
   SELECT p.full_name AS name,p.primary_email AS email,e.employee_code,
      e.probation_end_date,e.provisional_end_on,e.resignation_date,e.last_working_date,e.terminated_on,e.blacklisted_at,
      e.id,e.tenant_id,e.company_id,e.hired_on,e.join_date,e.grade_id,e.confirmation_date,e.final_confirmation_date
   FROM public.employment e
   JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
   JOIN permitted_companies pc ON pc.id=e.company_id
   WHERE e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL
     AND pc.id=ANY(p_scope)
 ),
 future_correction_presence AS MATERIALIZED (
   SELECT EXISTS (
     SELECT 1 FROM public.domain_event ev
     WHERE ev.tenant_id=app.current_tenant_id() AND ev.event_type='employment.information.corrected'
       AND ev.payload->>'effectiveOn'>p_as_of::text
   ) AS present
 ),
 dated AS MATERIALIZED (
   SELECT b.*,a.business_unit_id AS legacy_business_unit_id,a.department_id,a.position_id,a.employment_type,
          a.cost_center_id,a.location_id,
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
            WHEN t.tags->>'status'='legacy' THEN t.tags
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
 ),
 -- The dated administrative manager, once per subordinate (the same first edge the JSON subquery takes).
 managers AS MATERIALIZED (
   SELECT DISTINCT ON (r.subordinate_employment_id) r.subordinate_employment_id AS id,mp.full_name
   FROM public.reporting_line r
   JOIN visible v ON v.id=r.subordinate_employment_id AND v.tenant_id=r.tenant_id
   JOIN public.employment me ON me.id=r.manager_employment_id AND me.tenant_id=r.tenant_id AND me.voided_at IS NULL
   JOIN permitted_companies manager_scope ON manager_scope.id=me.company_id
   JOIN public.person mp ON mp.id=me.person_id AND mp.tenant_id=me.tenant_id
   WHERE r.line_type='administrative' AND r.superseded_at IS NULL AND r.valid_from<=p_as_of
     AND (r.valid_to IS NULL OR r.valid_to>p_as_of)
   ORDER BY r.subordinate_employment_id,r.valid_from DESC,r.id
 ),
 -- app.employment_organisation_quality_flags' direct-superior test, as two anti-join sets.
 superior_present AS MATERIALIZED (
   SELECT DISTINCT r.subordinate_employment_id AS id FROM public.reporting_line r
   WHERE r.tenant_id=app.current_tenant_id() AND r.line_type='administrative'
     AND r.superseded_at IS NULL AND r.valid_from<=p_as_of AND (r.valid_to IS NULL OR r.valid_to>p_as_of)
   UNION
   SELECT r.employment_id FROM public.org_chart_root r
   WHERE r.tenant_id=app.current_tenant_id() AND r.valid_from<=p_as_of AND (r.valid_to IS NULL OR r.valid_to>p_as_of)
 )
 SELECT v.id,v.name,v.email,v.employee_code,
   v.final_confirmation_date,v.confirmation_date,v.probation_end_date,v.provisional_end_on,
   v.resignation_date,v.last_working_date,v.terminated_on,v.blacklisted_at,
   v.dated_company_id,co.legal_name,v.department_id,COALESCE(NULLIF(btrim(d.label),''),d.name),v.employment_type::text,
   v.dated_bu_id,bu.name,v.position_id,COALESCE(NULLIF(btrim(pos.label),''),pos.title),
   CASE WHEN allowed_parent.id IS NOT NULL THEN (v.tags->>'parentCompanyId')::uuid END,
   CASE WHEN allowed_group.id IS NOT NULL THEN (v.tags->>'businessGroupId')::uuid END,
   g.name,g.code,v.hired_on,v.join_date,cc.name,loc.name,m.full_name,
   CASE WHEN COALESCE(v.final_confirmation_date,v.confirmation_date)<=p_as_of THEN 'confirmed' ELSE 'unconfirmed' END,
   CASE WHEN v.tags IS NOT NULL AND v.tags->>'companyId' IS NOT NULL THEN v.hired_on<=p_as_of AND v.dated_bu_id IS NULL END,
   CASE WHEN v.tags IS NOT NULL AND v.tags->>'companyId' IS NOT NULL THEN v.hired_on<=p_as_of AND v.grade_id IS NULL END,
   CASE WHEN v.tags IS NOT NULL AND v.tags->>'companyId' IS NOT NULL THEN v.hired_on<=p_as_of AND s.id IS NULL END,
   CASE WHEN v.tags IS NOT NULL AND v.tags->>'companyId' IS NOT NULL THEN v.tags->>'status'='pending' END
 FROM visible v
 JOIN public.company co ON co.id=v.dated_company_id AND co.tenant_id=v.tenant_id
 LEFT JOIN public.department d ON d.id=v.department_id AND d.tenant_id=v.tenant_id
 LEFT JOIN public.business_unit bu ON bu.id=v.dated_bu_id AND bu.tenant_id=v.tenant_id
 LEFT JOIN public.position pos ON pos.id=v.position_id AND pos.tenant_id=v.tenant_id
 LEFT JOIN public.job_grade g ON g.id=v.grade_id AND g.tenant_id=v.tenant_id
 LEFT JOIN public.cost_center cc ON cc.id=v.cost_center_id AND cc.tenant_id=v.tenant_id
 LEFT JOIN public.location loc ON loc.id=v.location_id AND loc.tenant_id=v.tenant_id
 LEFT JOIN permitted_companies allowed_parent ON allowed_parent.id=(v.tags->>'parentCompanyId')::uuid
 LEFT JOIN permitted_companies allowed_group ON allowed_group.id=(v.tags->>'businessGroupId')::uuid
 LEFT JOIN managers m ON m.id=v.id
 LEFT JOIN superior_present s ON s.id=v.id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.personnel_overview_facts(date,uuid[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.personnel_overview_facts(date,uuid[]) TO ai_hr_app;
--> statement-breakpoint
-- The token's entries once, for a set-wise join instead of a per-row scan of every entry. Principal,
-- actor, expiry and exact top-scope binding repeat app.personnel_private_search_matches. `verified`
-- is that function's employment/person/identity revision binding; company-dependent checks (dated
-- company, Workforce view and identity-search permission) stay with the caller's typed row.
CREATE FUNCTION app.personnel_private_search_entries(p_hash text,p_scope uuid[]) RETURNS TABLE (
 "employmentId" uuid,kind text,"filterRevision" text,"hasFilterRevision" boolean,verified boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH token AS MATERIALIZED (
   SELECT s.tenant_id,s.matches FROM public.personnel_private_search s
   WHERE app.principal_snapshot_current() AND s.token_hash=p_hash AND s.tenant_id=app.current_tenant_id()
     AND s.actor_id=app.current_user_id() AND s.expires_at>now()
     AND s.scope_ids @> p_scope AND s.scope_ids <@ p_scope
 ),
 entries AS MATERIALIZED (
   SELECT t.tenant_id,m.item FROM token t CROSS JOIN LATERAL jsonb_array_elements(t.matches) m(item)
 )
 SELECT e.id,x.item->>'kind',x.item->>'filterRevision',x.item ? 'filterRevision',
   e.voided_at IS NULL AND e.xmin::text=x.item->>'employmentRevision' AND p.xmin::text=x.item->>'personRevision'
     AND (x.item->>'kind'='public' OR (x.item->>'kind'='identity' AND i.xmin::text=x.item->>'identityRevision'))
 FROM entries x
 JOIN public.employment e ON e.id::text=x.item->>'employmentId' AND e.tenant_id=x.tenant_id
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 LEFT JOIN public.employee_statutory_my i ON i.person_id=p.id AND i.tenant_id=p.tenant_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.personnel_private_search_entries(text,uuid[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.personnel_private_search_entries(text,uuid[]) TO ai_hr_app;
--> statement-breakpoint
-- app.personnel_list_rows (4001) for a bounded subject set: the same extension over the bounded page
-- projection (2403), so each row's JSON, and therefore its filterRevision, is byte-identical.
CREATE FUNCTION app.personnel_list_rows_for_ids(p_as_of date,p_scope uuid[],p_subjects uuid[]) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH admitted AS MATERIALIZED (SELECT value FROM app.personnel_overview_page_rows(p_as_of,p_scope,p_subjects) a(value)),
 extended AS MATERIALIZED (
 SELECT a.value||jsonb_build_object(
 'directSuperiorFullName',a.value->'reportingTo',
 'directSuperiorEmployeeCode',(SELECT me.employee_code FROM public.reporting_line r
 JOIN public.employment me ON me.id=r.manager_employment_id AND me.tenant_id=r.tenant_id AND me.voided_at IS NULL
 WHERE r.tenant_id=e.tenant_id AND r.subordinate_employment_id=e.id AND r.line_type='administrative'
 AND r.superseded_at IS NULL AND r.valid_from<=p_as_of AND (r.valid_to IS NULL OR r.valid_to>p_as_of)
 AND app.access_workforce_projection_company(me.company_id) ORDER BY r.valid_from DESC,r.id LIMIT 1),
 'employmentFieldsPermitted',app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain'),'orgDivision',CASE WHEN a.value ? 'orgDivision' THEN a.value->'orgDivision' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.org_division) ELSE NULL::jsonb END,'orgBranch',CASE WHEN a.value ? 'orgBranch' THEN a.value->'orgBranch' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.org_branch) ELSE NULL::jsonb END,'orgRegion',CASE WHEN a.value ? 'orgRegion' THEN a.value->'orgRegion' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.org_region) ELSE NULL::jsonb END,'orgLine',CASE WHEN a.value ? 'orgLine' THEN a.value->'orgLine' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.org_line) ELSE NULL::jsonb END,'orgSection',CASE WHEN a.value ? 'orgSection' THEN a.value->'orgSection' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.org_section) ELSE NULL::jsonb END,'orgTeam',CASE WHEN a.value ? 'orgTeam' THEN a.value->'orgTeam' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.org_team) ELSE NULL::jsonb END,'orgBase',CASE WHEN a.value ? 'orgBase' THEN a.value->'orgBase' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.org_base) ELSE NULL::jsonb END,'employmentCategory',CASE WHEN a.value ? 'employmentCategory' THEN a.value->'employmentCategory' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.employment_category) ELSE NULL::jsonb END,'hiredOn',CASE WHEN a.value ? 'hiredOn' THEN a.value->'hiredOn' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.hired_on) ELSE NULL::jsonb END,'joinDate',CASE WHEN a.value ? 'joinDate' THEN a.value->'joinDate' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.join_date) ELSE NULL::jsonb END,'probationValue',CASE WHEN a.value ? 'probationValue' THEN a.value->'probationValue' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.probation_value) ELSE NULL::jsonb END,'probationUnit',CASE WHEN a.value ? 'probationUnit' THEN a.value->'probationUnit' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.probation_unit) ELSE NULL::jsonb END,'extendedProbationValue',CASE WHEN a.value ? 'extendedProbationValue' THEN a.value->'extendedProbationValue' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.extended_probation_value) ELSE NULL::jsonb END,'extendedProbationUnit',CASE WHEN a.value ? 'extendedProbationUnit' THEN a.value->'extendedProbationUnit' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.extended_probation_unit) ELSE NULL::jsonb END,'finalConfirmationDate',CASE WHEN a.value ? 'finalConfirmationDate' THEN a.value->'finalConfirmationDate' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.final_confirmation_date) ELSE NULL::jsonb END,'contractStartDate',CASE WHEN a.value ? 'contractStartDate' THEN a.value->'contractStartDate' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.contract_start_date) ELSE NULL::jsonb END,'contractEndDate',CASE WHEN a.value ? 'contractEndDate' THEN a.value->'contractEndDate' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.contract_end_date) ELSE NULL::jsonb END,'contractRemark',CASE WHEN a.value ? 'contractRemark' THEN a.value->'contractRemark' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.contract_remark) ELSE NULL::jsonb END,'noticeBeforeConfirmationValue',CASE WHEN a.value ? 'noticeBeforeConfirmationValue' THEN a.value->'noticeBeforeConfirmationValue' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.notice_before_confirmation_value) ELSE NULL::jsonb END,'noticeBeforeConfirmationUnit',CASE WHEN a.value ? 'noticeBeforeConfirmationUnit' THEN a.value->'noticeBeforeConfirmationUnit' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.notice_before_confirmation_unit) ELSE NULL::jsonb END,'noticeAfterConfirmationValue',CASE WHEN a.value ? 'noticeAfterConfirmationValue' THEN a.value->'noticeAfterConfirmationValue' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.notice_after_confirmation_value) ELSE NULL::jsonb END,'noticeAfterConfirmationUnit',CASE WHEN a.value ? 'noticeAfterConfirmationUnit' THEN a.value->'noticeAfterConfirmationUnit' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.notice_after_confirmation_unit) ELSE NULL::jsonb END,'tenderResignationDate',CASE WHEN a.value ? 'tenderResignationDate' THEN a.value->'tenderResignationDate' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.tender_resignation_date) ELSE NULL::jsonb END,'resignationDate',CASE WHEN a.value ? 'resignationDate' THEN a.value->'resignationDate' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.resignation_date) ELSE NULL::jsonb END,'lastWorkingDate',CASE WHEN a.value ? 'lastWorkingDate' THEN a.value->'lastWorkingDate' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.last_working_date) ELSE NULL::jsonb END,'confirmationDate',CASE WHEN a.value ? 'confirmationDate' THEN a.value->'confirmationDate' WHEN app.access_workforce_company((a.value->>'companyId')::uuid,'workforce.maintain') THEN to_jsonb(e.confirmation_date) ELSE NULL::jsonb END) value
 FROM admitted a JOIN public.employment e ON e.id=(a.value->>'employmentId')::uuid AND e.tenant_id=app.current_tenant_id() AND e.voided_at IS NULL
 ) SELECT value||jsonb_build_object('filterRevision',md5(value::text)) FROM extended
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.personnel_list_rows_for_ids(date,uuid[],uuid[]) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.personnel_list_rows_for_ids(date,uuid[],uuid[]) TO ai_hr_app;
