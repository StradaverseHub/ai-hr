-- Criteria share the existing actor-bound five-minute token, with no direct app read grant.
ALTER TABLE public.personnel_private_search ADD COLUMN criteria jsonb;
REVOKE SELECT(criteria) ON public.personnel_private_search FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Approved ed921f69. Extend, never replace, the dated Workforce purpose owner.
CREATE FUNCTION app.personnel_list_rows(p_as_of date,p_scope uuid[] DEFAULT NULL) RETURNS SETOF jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH admitted AS MATERIALIZED (SELECT value FROM app.personnel_filter_rows(p_as_of,p_scope) a(value)),
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
REVOKE ALL ON FUNCTION app.personnel_list_rows(date,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.personnel_list_rows(date,uuid[]) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.personnel_private_search_bind() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE v_day date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.actor_id IS DISTINCT FROM app.current_user_id() OR NOT app.principal_snapshot_current() OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=NEW.actor_id AND u.tenant_id=NEW.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'Private search unavailable' USING ERRCODE='42501'; END IF;
 IF NEW.criteria IS NOT NULL THEN
  IF jsonb_typeof(NEW.criteria)<>'object' OR NEW.criteria-ARRAY['term','filters']<>'{}'::jsonb OR jsonb_typeof(NEW.criteria->'term') IS DISTINCT FROM 'string' OR length(NEW.criteria->>'term')>200 OR jsonb_typeof(NEW.criteria->'filters') IS DISTINCT FROM 'array' OR octet_length(NEW.criteria::text)>65536 THEN RAISE EXCEPTION 'Private filters unavailable' USING ERRCODE='22023'; END IF;
  IF jsonb_array_length(NEW.criteria->'filters')>80 OR EXISTS(
   SELECT 1 FROM jsonb_array_elements(NEW.criteria->'filters') f
   WHERE jsonb_typeof(f)<>'object' OR f-ARRAY['field','operator','value']<>'{}'::jsonb
    OR jsonb_typeof(f->'field') IS DISTINCT FROM 'string' OR f->>'field' NOT IN ('code','name','company','department','position','status','jobGrade','employmentType','reportingTo','businessUnit','costCenter','workLocation','groupJoinDate','joinDate','confirmationDate','email','identity','employment.directSuperiorEmployeeCode','employment.directSuperiorFullName','employment.orgDivision','employment.orgBranch','employment.orgRegion','employment.orgLine','employment.orgSection','employment.orgTeam','employment.orgBase','employment.employmentCategory','employment.hiredOn','employment.joinDate','employment.groupService','employment.companyService','employment.yearOfService','employment.probationValue','employment.probationUnit','employment.extendedProbationValue','employment.extendedProbationUnit','employment.finalConfirmationDate','employment.contractStartDate','employment.contractEndDate','employment.contractRemark','employment.noticeBeforeConfirmationValue','employment.noticeBeforeConfirmationUnit','employment.noticeAfterConfirmationValue','employment.noticeAfterConfirmationUnit','employment.tenderResignationDate','employment.resignationDate','employment.lastWorkingDate','employment.confirmationDate')
    OR jsonb_typeof(f->'operator') IS DISTINCT FROM 'string' OR f->>'operator' NOT IN ('contains','equals','blank','notBlank','from','to')
    OR jsonb_typeof(f->'value') IS DISTINCT FROM 'string' OR length(f->>'value')>200
    OR (f->>'operator'='contains' AND f->>'field' IN ('employment.probationValue','employment.extendedProbationValue','employment.noticeBeforeConfirmationValue','employment.noticeAfterConfirmationValue','groupJoinDate','joinDate','confirmationDate','employment.hiredOn','employment.joinDate','employment.finalConfirmationDate','employment.contractStartDate','employment.contractEndDate','employment.tenderResignationDate','employment.resignationDate','employment.lastWorkingDate','employment.confirmationDate'))
    OR (f->>'operator' IN ('from','to') AND f->>'field' NOT IN ('employment.probationValue','employment.extendedProbationValue','employment.noticeBeforeConfirmationValue','employment.noticeAfterConfirmationValue','groupJoinDate','joinDate','confirmationDate','employment.hiredOn','employment.joinDate','employment.finalConfirmationDate','employment.contractStartDate','employment.contractEndDate','employment.tenderResignationDate','employment.resignationDate','employment.lastWorkingDate','employment.confirmationDate'))
    OR (f->>'operator' NOT IN ('blank','notBlank') AND f->>'field' IN ('employment.probationValue','employment.extendedProbationValue','employment.noticeBeforeConfirmationValue','employment.noticeAfterConfirmationValue') AND f->>'value' !~ '^[-+]?(?:[0-9]+[.]?[0-9]*|[.][0-9]+)$')
    OR (f->>'operator' NOT IN ('blank','notBlank') AND f->>'field' IN ('groupJoinDate','joinDate','confirmationDate','employment.hiredOn','employment.joinDate','employment.finalConfirmationDate','employment.contractStartDate','employment.contractEndDate','employment.tenderResignationDate','employment.resignationDate','employment.lastWorkingDate','employment.confirmationDate') AND f->>'value' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
  ) OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.criteria->'filters') f GROUP BY f->>'field' HAVING count(*)>1)
  THEN RAISE EXCEPTION 'Private filters unavailable' USING ERRCODE='22023'; END IF;
 END IF;
 IF jsonb_typeof(NEW.matches)<>'array' OR jsonb_array_length(NEW.matches)>100000 OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.matches)m WHERE COALESCE(m->>'employmentId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' OR m->>'kind' IS NULL OR m->>'kind' NOT IN ('public','identity') OR COALESCE(m->>'personRevision','') !~ '^[0-9]{1,12}$' OR COALESCE(m->>'employmentRevision','') !~ '^[0-9]{1,12}$' OR (m->>'identityRevision' IS NOT NULL AND m->>'identityRevision' !~ '^[0-9]{1,12}$') OR (m ? 'filterRevision' AND COALESCE(m->>'filterRevision','') !~ '^[a-f0-9]{32}$') OR jsonb_typeof(m)<>'object' OR m-ARRAY['employmentId','kind','personRevision','employmentRevision','identityRevision','filterRevision']<>'{}'::jsonb) THEN RAISE EXCEPTION 'Private search unavailable' USING ERRCODE='22023'; END IF;
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

 -- Fingerprint filters against the complete permission-bound current row. No raw criterion is stored.
 IF EXISTS (
  WITH expected AS MATERIALIZED (SELECT item FROM jsonb_array_elements(NEW.matches)item WHERE item ? 'filterRevision'),
  current_rows AS MATERIALIZED (SELECT value FROM app.personnel_list_rows(v_day,NEW.scope_ids) filter_source(value))
  SELECT 1 FROM expected m WHERE NOT EXISTS(SELECT 1 FROM current_rows c WHERE c.value->>'employmentId'=m.item->>'employmentId' AND c.value->>'filterRevision'=m.item->>'filterRevision')
 ) THEN RAISE EXCEPTION 'Private filters changed. Try again.' USING ERRCODE='40001'; END IF;
 NEW.scope_ids:=ARRAY(SELECT DISTINCT x FROM unnest(NEW.scope_ids)x ORDER BY x);
 PERFORM pg_advisory_xact_lock(hashtextextended('personnel-private-search:'||NEW.tenant_id::text||':'||NEW.actor_id::text,0));
 NEW.created_at:=clock_timestamp();NEW.expires_at:=NEW.created_at+interval '5 minutes';
 DELETE FROM public.personnel_private_search WHERE tenant_id=NEW.tenant_id AND actor_id=NEW.actor_id AND (expires_at<=now() OR token_hash IN(SELECT token_hash FROM public.personnel_private_search WHERE tenant_id=NEW.tenant_id AND actor_id=NEW.actor_id ORDER BY created_at DESC OFFSET 7));
 RETURN NEW;
END $$;

--> statement-breakpoint
CREATE FUNCTION app.personnel_column_search_matches(p_hash text,p_employment uuid,p_company uuid,p_scope uuid[],p_revision text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.personnel_private_search_matches(p_hash,p_employment,p_company,p_scope) AND EXISTS(
 SELECT 1 FROM public.personnel_private_search s CROSS JOIN LATERAL jsonb_array_elements(s.matches) m
 WHERE s.token_hash=p_hash AND s.tenant_id=app.current_tenant_id() AND s.actor_id=app.current_user_id() AND s.expires_at>now()
 AND m->>'employmentId'=p_employment::text AND (NOT(m ? 'filterRevision') OR m->>'filterRevision'=p_revision))
$$;
REVOKE ALL ON FUNCTION app.personnel_column_search_matches(text,uuid,uuid,uuid[],text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.personnel_column_search_matches(text,uuid,uuid,uuid[],text) TO ai_hr_app;

--> statement-breakpoint
-- The sole criteria read seam repeats principal, actor, expiry and exact top-scope binding.
CREATE FUNCTION app.personnel_column_search_criteria(p_hash text,p_scope uuid[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT s.criteria FROM public.personnel_private_search s
 WHERE s.token_hash=p_hash AND s.tenant_id=app.current_tenant_id() AND s.actor_id=app.current_user_id()
 AND s.expires_at>now() AND app.principal_snapshot_current()
 AND EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=s.actor_id AND u.tenant_id=s.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 AND s.scope_ids @> p_scope AND s.scope_ids <@ p_scope
 AND NOT EXISTS(SELECT 1 FROM unnest(p_scope) company_id WHERE NOT app.access_workforce_projection_company(company_id))
$$;
REVOKE ALL ON FUNCTION app.personnel_column_search_criteria(text,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.personnel_column_search_criteria(text,uuid[]) TO ai_hr_app;
