-- Board item 60f1fdcd, the three parts the first build left unbuilt (docs/adr/2026-11-12-rewards-direct-configuration.md).
-- DRAFT block 5580-5599; the integrator renumbers at admission. Owner decision (12 November 2026, option 2): the
-- purpose-owned definers stay byte-identical (docs/SCALE-AND-RELEASE-RULES.md rule 9); new functions owned by the
-- migration owner, with their own row-security policies and grants, replace the application paths that called them.
--
--  (a) CTRO and HR Admin edit Salary Structures, Bonus Matrices and company PAT: app.reward_config_editor(company) is
--      Group Rewards (app.reward_setup_allowed, unchanged), CTRO (whole-group grant, setup grant or review seat) or
--      HR Admin over the company. Group-wide items (company NULL) need group-wide authority: a company-scoped HR Admin
--      is refused. The library and PAT write triggers that called purpose-owned guards are re-pointed at owner copies.
--  (b) The person who made a plan active creates reviews from it: app.reward_config_create_planned_unit is the 2205
--      creator without the 4100 activator exclusion. Its authority stays Group Rewards (the creator takes the review's
--      Group Rewards seat, which also sees EC-confidential people).
--  (c) The uploader makes their own uploaded awards active: the 2208 binding triggers are re-pointed at an owner
--      trigger without the uploader-versus-checker rule.
--
-- Every replica is the installed body with only the named function, callee, authority and message substitutions
-- (scratchpad generator recorded in the ADR). Owner copies read forced tables through row security: where the
-- purpose role had its own policy, an owner policy with the same predicate (and the configuration editor in place of
-- Group Rewards) is added; no owner policy is wider than the caller's own configuration authority.
--
-- Composes with the Role permissions migration (board db14e49c, 5520) when both are installed: that migration's
-- app.reward_config_change_record branch for role_permission rows is kept below behind to_regprocedure, and its
-- restrictive page-level policies must admit hr_admin and CTRO at Full for these pages (see the ADR).
--
-- Rollback (manual, only if never relied upon): re-point the six triggers at the installed purpose functions, restore
-- the 5400 bodies of the three change-log functions and 2205's app.reward_policy_binding_guard, then DROP the
-- policies and functions created below.

-- 1. The configuration editor predicate and the library viewer.
CREATE FUNCTION app.reward_config_editor(wanted_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_user_id() IS NOT NULL AND coalesce(app.reward_not_viewing_as(),false)
 AND EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 AND (wanted_company IS NULL OR EXISTS(SELECT 1 FROM public.company c WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id()))
 AND (coalesce(app.reward_setup_allowed(wanted_company,'manage'),false)
  OR 'ctro' IN (SELECT app.reward_current_group_roles())
  OR EXISTS(SELECT 1 FROM public.reward_setup_grant g WHERE g.tenant_id=app.current_tenant_id() AND g.user_id=app.current_user_id() AND g.active AND g.role='ctro'
   AND g.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND (g.valid_to IS NULL OR g.valid_to>=timezone('Asia/Kuala_Lumpur',now())::date)
   AND (g.company_id IS NULL OR wanted_company IS NOT NULL AND g.company_id=wanted_company))
  OR wanted_company IS NOT NULL AND EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.tenant_id=app.current_tenant_id() AND u.deleted_at IS NULL AND u.company_id=wanted_company
   AND 'ctro'=ANY(ARRAY(SELECT app.reward_roles(u.id))))
  OR EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=app.current_tenant_id() AND r.app_user_id=app.current_user_id() AND r.role::text='hr_admin'
   AND app.has_role_for('hr_admin',wanted_company)
   AND (r.company_id IS NULL OR wanted_company IS NOT NULL AND (r.company_id=wanted_company OR app.is_company_descendant(wanted_company,r.company_id)))))
$$;
CREATE FUNCTION app.reward_config_library_viewer() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.reward_setup_allowed(NULL,'library_view'),false) OR app.reward_config_editor(NULL)
$$;
CREATE FUNCTION app.reward_config_viewer(wanted_company uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(app.reward_setup_allowed(wanted_company,'library_view'),false) OR app.reward_config_editor(wanted_company)
$$;
-- Whether the principal edits the configuration of the group or of at least one company (menus and list views; the
-- lists themselves show only the companies app.reward_config_editor admits).
CREATE FUNCTION app.reward_config_editor_anywhere() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.reward_config_editor(NULL) OR app.current_user_id() IS NOT NULL AND coalesce(app.reward_not_viewing_as(),false)
 AND EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 AND (EXISTS(SELECT 1 FROM public.reward_setup_grant g WHERE g.tenant_id=app.current_tenant_id() AND g.user_id=app.current_user_id() AND g.active AND g.role IN('gr','ctro')
   AND g.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND (g.valid_to IS NULL OR g.valid_to>=timezone('Asia/Kuala_Lumpur',now())::date))
  OR EXISTS(SELECT 1 FROM public.reward_member m JOIN public.reward_unit u ON u.id=m.unit_id AND u.tenant_id=m.tenant_id AND u.deleted_at IS NULL
   WHERE m.tenant_id=app.current_tenant_id() AND m.user_id=app.current_user_id() AND m.role IN('gr','ctro')
    AND m.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND (m.valid_to IS NULL OR m.valid_to>=timezone('Asia/Kuala_Lumpur',now())::date))
  OR EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=app.current_tenant_id() AND r.app_user_id=app.current_user_id() AND r.role::text='hr_admin'
   AND app.has_role_for('hr_admin',r.company_id)))
$$;
-- Row-security predicates: the policies below apply to every role that reads these tables (purpose readers included),
-- so every role may evaluate them. They answer only about the current principal.
REVOKE ALL ON FUNCTION app.reward_config_editor(uuid),app.reward_config_library_viewer(),app.reward_config_viewer(uuid),app.reward_config_editor_anywhere() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_config_editor(uuid),app.reward_config_library_viewer(),app.reward_config_viewer(uuid),app.reward_config_editor_anywhere() TO PUBLIC;
--> statement-breakpoint

-- 2. The change log, its readers and the notice recipients use the editor predicate. Notices also reach HR Admins
-- with scope over the change's companies (group-wide HR Admins for group-level items), never the editor's person.
CREATE OR REPLACE FUNCTION app.reward_config_change_visible(wanted_area text,wanted_companies uuid[]) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT app.current_user_id() IS NOT NULL AND (
  CASE WHEN cardinality(wanted_companies)=0 THEN app.reward_config_editor(NULL)
   ELSE NOT EXISTS(SELECT 1 FROM unnest(wanted_companies) c WHERE NOT app.reward_config_editor(c)) END
  OR wanted_area IN('salary','bonus') AND app.reward_config_library_viewer());
$$;
CREATE OR REPLACE FUNCTION app.reward_config_change_record(p_area text,p_action text,p_item uuid,p_label text,p_companies uuid[],p_version text,p_reason text,p_high_impact boolean,p_changed integer,p_summary jsonb,p_subject_unit uuid,p_subject_entries uuid[],p_restored_from text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();actor_person uuid;result uuid;companies uuid[]:=coalesce(p_companies,'{}');allowed boolean;
BEGIN
 IF t IS NULL OR actor IS NULL OR NOT coalesce(app.reward_not_viewing_as(),false) THEN RAISE EXCEPTION 'Rewards configuration change log writer required' USING ERRCODE='42501'; END IF;
 -- The actor's PERSON is recorded when the login has one; an account without a person is still the actor.
 SELECT person_id INTO actor_person FROM public.app_user WHERE id=actor AND tenant_id=t AND archived_at IS NULL;
 IF EXISTS(SELECT 1 FROM unnest(companies) c WHERE NOT EXISTS(SELECT 1 FROM public.company x WHERE x.id=c AND x.tenant_id=t)) THEN RAISE EXCEPTION 'Rewards configuration companies must be in this tenant' USING ERRCODE='42501'; END IF;
 IF p_area='access' THEN
  -- An access row records the actor's own access request that was applied without a second approval.
  allowed:=EXISTS(SELECT 1 FROM public.reward_access_request q WHERE q.id=p_item AND q.tenant_id=t AND q.requested_by=actor AND q.status='applied_no_second_approval');
 ELSIF p_area='group_role' THEN allowed:=coalesce(app.is_group_admin(),false);
 ELSIF p_area='role_permission' AND cardinality(companies)=0 AND to_regprocedure('app.reward_role_permission_immediate()') IS NOT NULL THEN
  -- The Role permissions grid (board db14e49c), when installed, names its own immediate authority.
  EXECUTE 'select app.reward_role_permission_immediate()' INTO allowed;
 ELSIF cardinality(companies)=0 THEN allowed:=app.reward_config_editor(NULL);
 ELSE allowed:=NOT EXISTS(SELECT 1 FROM unnest(companies) c WHERE NOT app.reward_config_editor(c));
 END IF;
 IF NOT coalesce(allowed,false) THEN RAISE EXCEPTION 'Rewards configuration authority required' USING ERRCODE='42501'; END IF;
 IF p_subject_unit IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.id=p_subject_unit AND u.tenant_id=t) THEN RAISE EXCEPTION 'Rewards review not found' USING ERRCODE='42501'; END IF;
 INSERT INTO public.reward_config_change(tenant_id,area,action,item_id,item_label,company_ids,version_ref,actor_kind,actor_id,actor_person_id,reason,high_impact,changed_count,summary,subject_unit_id,subject_entry_ids,restored_from)
 VALUES(t,p_area,p_action,p_item,btrim(p_label),companies,p_version,'user',actor,actor_person,btrim(p_reason),coalesce(p_high_impact,false),coalesce(p_changed,0),coalesce(p_summary,'{}'::jsonb),p_subject_unit,coalesce(p_subject_entries,'{}'),p_restored_from)
 RETURNING id INTO result;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION app.reward_config_change_recipients(wanted_change uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH change AS (
  SELECT c.* FROM public.reward_config_change c WHERE c.id=wanted_change AND c.tenant_id=app.current_tenant_id() AND c.actor_kind='user'
 ), holder AS (
  SELECT g.user_id FROM public.reward_group_role_grant g JOIN change c ON c.tenant_id=g.tenant_id
   WHERE g.active AND g.role IN('gr','ctro') AND app.reward_group_person_eligible(g.user_id)
  UNION
  SELECT s.user_id FROM public.reward_setup_grant s JOIN change c ON c.tenant_id=s.tenant_id
   WHERE s.active AND s.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND (s.valid_to IS NULL OR s.valid_to>=timezone('Asia/Kuala_Lumpur',now())::date)
    AND (s.company_id IS NULL OR s.company_id=ANY(c.company_ids))
  UNION
  SELECT m.user_id FROM public.reward_member m JOIN public.reward_unit u ON u.id=m.unit_id AND u.tenant_id=m.tenant_id AND u.deleted_at IS NULL
   JOIN change c ON c.tenant_id=m.tenant_id AND u.company_id=ANY(c.company_ids)
   WHERE m.role IN('gr','ctro') AND m.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND (m.valid_to IS NULL OR m.valid_to>=timezone('Asia/Kuala_Lumpur',now())::date)
  UNION
  SELECT r.app_user_id FROM public.role_assignment r JOIN change c ON c.tenant_id=r.tenant_id
   WHERE r.role::text='hr_admin' AND (r.company_id IS NULL OR r.company_id=ANY(c.company_ids)
    OR EXISTS(SELECT 1 FROM unnest(c.company_ids) x WHERE app.is_company_descendant(x,r.company_id)))
 )
 SELECT DISTINCT e.id FROM holder h
  JOIN change c ON true
  JOIN public.app_user a ON a.id=h.user_id AND a.tenant_id=c.tenant_id
  JOIN public.employment e ON e.person_id=a.person_id AND e.tenant_id=a.tenant_id
 WHERE a.archived_at IS NULL AND a.person_id IS NOT NULL AND a.person_id IS DISTINCT FROM c.actor_person_id AND a.id IS DISTINCT FROM c.actor_id
  AND e.hired_on<=timezone('Asia/Kuala_Lumpur',now())::date AND e.terminated_on IS NULL
  AND app.is_admin() AND (app.current_user_id() IS NULL OR app.is_group_admin());
$$;
--> statement-breakpoint

-- 3. Read and listing helpers for the configuration pages, as owner copies with the editor or viewer predicate.
CREATE FUNCTION app.reward_config_company_eligible(wanted_company uuid,wanted_year integer) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE classified boolean:=true;reward_visible boolean:=true;
BEGIN
 IF NOT app.reward_config_editor(wanted_company) OR NOT EXISTS(SELECT 1 FROM company c WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL AND c.currency='MYR') OR EXISTS(SELECT 1 FROM reward_company_exclusion e WHERE e.tenant_id=app.current_tenant_id() AND e.company_id=wanted_company AND e.year=wanted_year AND e.ended_at IS NULL) THEN RETURN false;END IF;
 IF to_regclass('public.reward_company_classification') IS NOT NULL THEN EXECUTE 'select not exists(select 1 from public.reward_company_classification where tenant_id=$1 and company_id=$2 and disposition<>''visible'')' INTO reward_visible USING app.current_tenant_id(),wanted_company;IF NOT reward_visible THEN RETURN false;END IF;END IF;
 IF to_regclass('public.company_registration_classification') IS NOT NULL THEN EXECUTE 'select not exists(select 1 from public.company_registration_classification where tenant_id=$1 and company_id=$2 and(entity_kind<>''legal_entity'' or is_test_entity))' INTO classified USING app.current_tenant_id(),wanted_company;END IF;
 RETURN classified;
END $$;
CREATE FUNCTION app.reward_config_policy_source(wanted_version uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM reward_policy_group_version v WHERE v.id=wanted_version AND v.tenant_id=app.current_tenant_id()) OR NOT EXISTS(SELECT 1 FROM reward_policy_group_target t WHERE t.version_id=wanted_version AND t.tenant_id=app.current_tenant_id()) OR EXISTS(SELECT 1 FROM reward_policy_group_target t WHERE t.version_id=wanted_version AND t.tenant_id=app.current_tenant_id() AND NOT app.reward_config_editor(t.company_id)) THEN RAISE EXCEPTION 'Shared configuration is not in your Rewards scope' USING ERRCODE='42501';END IF;
 SELECT app.reward_policy_group_version_json(v.id)||jsonb_build_object('createdBy',v.created_by,'current',g.current_version_id=v.id) INTO result FROM reward_policy_group_version v JOIN reward_policy_group g ON g.id=v.group_id AND g.tenant_id=v.tenant_id WHERE v.id=wanted_version AND v.tenant_id=app.current_tenant_id();RETURN result;
END $$;
CREATE FUNCTION app.reward_config_library_used_by(wanted_version uuid) RETURNS TABLE(plan text,company text,year integer) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT v.name,c.legal_name,p.year FROM reward_plan_company p JOIN reward_policy_group_version v ON v.id=p.plan_version_id AND v.tenant_id=p.tenant_id JOIN company c ON c.id=p.company_id AND c.tenant_id=p.tenant_id
 WHERE p.tenant_id=app.current_tenant_id() AND(p.salary_version_id=wanted_version OR p.bonus_version_id=wanted_version) AND app.reward_config_viewer(c.id) ORDER BY v.name,c.legal_name,c.id
$$;
CREATE FUNCTION app.reward_config_library_locked(wanted_version uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.reward_config_library_viewer() AND EXISTS(SELECT 1 FROM reward_unit_setup s JOIN reward_unit u ON u.id=s.unit_id AND u.tenant_id=s.tenant_id WHERE s.tenant_id=app.current_tenant_id() AND(s.salary_version_id=wanted_version OR s.bonus_version_id=wanted_version) AND u.status<>'draft')
$$;
CREATE FUNCTION app.reward_config_companies(wanted_year integer) RETURNS TABLE(id uuid,name text,"parentId" uuid,"parentName" text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT c.id,c.legal_name,p.id,p.legal_name FROM company c LEFT JOIN company p ON p.id=c.parent_company_id AND p.tenant_id=c.tenant_id WHERE c.tenant_id=app.current_tenant_id() AND wanted_year BETWEEN 2000 AND 2200 AND app.reward_config_company_eligible(c.id,wanted_year) ORDER BY coalesce(p.legal_name,''),c.legal_name,c.id
$$;
CREATE FUNCTION app.reward_config_company_structure(wanted_company uuid,wanted_date date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE tags jsonb;result jsonb;
BEGIN
 IF NOT app.reward_config_editor(wanted_company) OR wanted_date IS NULL THEN RAISE EXCEPTION 'Company structure is outside your Rewards scope' USING ERRCODE='42501';END IF;
 IF to_regprocedure('app.company_org_tags_unchecked(uuid,date)') IS NULL THEN RETURN jsonb_build_object('companyId',wanted_company,'status','legacy','businessUnitId',NULL,'businessUnitName',NULL,'businessGroupId',NULL,'businessGroupName',NULL);END IF;
 EXECUTE 'select app.company_org_tags_unchecked($1,$2)' INTO tags USING wanted_company,wanted_date;
 SELECT tags||jsonb_build_object('businessUnitName',(SELECT b.name FROM business_unit b WHERE b.id=nullif(tags->>'businessUnitId','')::uuid AND b.tenant_id=app.current_tenant_id()),'businessGroupName',(SELECT c.legal_name FROM company c WHERE c.id=nullif(tags->>'businessGroupId','')::uuid AND c.tenant_id=app.current_tenant_id()),'parentCompanyName',(SELECT c.legal_name FROM company c WHERE c.id=nullif(tags->>'parentCompanyId','')::uuid AND c.tenant_id=app.current_tenant_id())) INTO result;RETURN result;
END $$;
CREATE FUNCTION app.reward_config_source_org_tags(wanted_employment uuid,wanted_date date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE tags jsonb;co uuid;
BEGIN
 IF to_regprocedure('app.company_org_employment_company(uuid,date)') IS NULL THEN SELECT e.company_id INTO co FROM employment e WHERE e.id=wanted_employment AND e.tenant_id=app.current_tenant_id();tags:=jsonb_build_object('companyId',co,'status','legacy','businessUnitId',NULL);
 ELSE EXECUTE 'select app.company_org_employment_company($1,$2)' INTO co USING wanted_employment,wanted_date;END IF;
 IF co IS NULL OR NOT app.reward_config_editor(co) THEN RETURN NULL;END IF;
 IF tags IS NULL THEN EXECUTE 'select app.company_org_employment_unchecked($1,$2)' INTO tags USING wanted_employment,wanted_date;END IF;
 RETURN coalesce(tags,jsonb_build_object('companyId',co,'status','pending','reason','Organisation grouping authority unavailable'));
END $$;
CREATE FUNCTION app.reward_config_grade_choices() RETURNS TABLE(id uuid,code text,name text) LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NOT app.reward_config_library_viewer() THEN RAISE EXCEPTION 'Grade Ladder library authority required' USING ERRCODE='42501';END IF;
 IF to_regprocedure('app.architecture_grade_assignable(uuid)') IS NOT NULL THEN
  RETURN QUERY EXECUTE 'select g.id,g.code,g.name from public.job_grade g where g.tenant_id=app.current_tenant_id() and g.archived_at is null and app.architecture_grade(g.code) is not null and app.architecture_grade_assignable(g.id) order by g.rank,g.code,g.id';
 ELSE RETURN QUERY SELECT g.id,g.code,g.name FROM job_grade g WHERE g.tenant_id=app.current_tenant_id() AND g.archived_at IS NULL AND app.architecture_grade(g.code) IS NOT NULL ORDER BY g.rank,g.code,g.id;
 END IF;
END $$;
CREATE FUNCTION app.reward_config_planned_policy_snapshot(policy jsonb,s jsonb,v jsonb,pat jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT policy||jsonb_build_object('ranges',(SELECT coalesce(jsonb_object_agg(r->>'grade',jsonb_build_array((r->>'minimumCents')::bigint,(r->>'midpointCents')::bigint,(r->>'maximumCents')::bigint)),'{}'::jsonb) FROM jsonb_array_elements(s->'rows')r WHERE r->>'grade'<>'23'),'bonusMatrix',(SELECT jsonb_object_agg(r->>'grade',r->'months') FROM jsonb_array_elements(v->'rows')r),'bonusStructure',v->>'type','branchFactors',(SELECT coalesce(jsonb_object_agg(r->>'name',r->'factors'),'{}'::jsonb) FROM jsonb_array_elements(v->'segments')r),'patTarget',(pat->>'targetCents')::bigint,'patActual',greatest(0,coalesce(pat->>'actualCents',pat->>'forecastCents')::bigint),'targetMonthsBp',(pat->>'targetMonthsBp')::integer,'multiplierBp',CASE WHEN v->>'type'='branch' THEN '10000'::jsonb ELSE 'null'::jsonb END)
$$;
CREATE FUNCTION app.reward_config_pat_history(wanted_company uuid,wanted_year integer) RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NOT app.reward_config_editor(wanted_company) THEN RAISE EXCEPTION 'Company PAT is outside your Rewards configuration scope' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT jsonb_build_object('id',v.id,'companyId',v.company_id,'year',v.year,'revision',v.revision,'inputs',v.inputs,'state',v.state,'createdBy',v.created_by,'createdByPersonId',v.created_by_person_id,'confirmedBy',v.confirmed_by,'confirmedAt',v.confirmed_at,'reason',v.reason,'createdByName',maker.full_name,'confirmedByName',checker.full_name) FROM reward_pat_version v LEFT JOIN person maker ON maker.id=v.created_by_person_id AND maker.tenant_id=v.tenant_id LEFT JOIN person checker ON checker.id=v.confirmed_by_person_id AND checker.tenant_id=v.tenant_id WHERE v.tenant_id=app.current_tenant_id() AND v.company_id=wanted_company AND v.year=wanted_year ORDER BY v.revision DESC;
END $$;
REVOKE ALL ON FUNCTION app.reward_config_company_eligible(uuid,integer),app.reward_config_policy_source(uuid),app.reward_config_library_used_by(uuid),app.reward_config_library_locked(uuid),
 app.reward_config_companies(integer),app.reward_config_company_structure(uuid,date),app.reward_config_source_org_tags(uuid,date),app.reward_config_grade_choices(),
 app.reward_config_planned_policy_snapshot(jsonb,jsonb,jsonb,jsonb),app.reward_config_pat_history(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_config_company_eligible(uuid,integer),app.reward_config_library_used_by(uuid),app.reward_config_library_locked(uuid),
 app.reward_config_companies(integer),app.reward_config_company_structure(uuid,date),app.reward_config_grade_choices(),app.reward_config_pat_history(uuid,integer) TO ai_hr_app;
-- The annual-admission guard calls the snapshot copy whether the purpose creator or the owner creator inserts.
GRANT EXECUTE ON FUNCTION app.reward_config_planned_policy_snapshot(jsonb,jsonb,jsonb,jsonb) TO ai_hr_reward_setup_reader;
-- The registration classification the eligibility copy reads, as the purpose reader's policy did (2209).
CREATE POLICY company_registration_config_owner ON public.company_registration_classification FOR SELECT TO ai_hr_owner
 USING(tenant_id=app.current_tenant_id() AND app.reward_config_editor(company_id));
--> statement-breakpoint

-- 4. Salary Structures and Bonus Matrices (group-wide): the editor reads, saves and makes versions active.
CREATE POLICY reward_library_config_read ON public.reward_library FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.reward_config_editor(NULL));
CREATE POLICY reward_library_config_insert ON public.reward_library FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_config_editor(NULL) AND created_by=app.current_user_id());
CREATE POLICY reward_library_version_config_read ON public.reward_library_version FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.reward_config_editor(NULL));
CREATE POLICY reward_library_version_config_insert ON public.reward_library_version FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_config_editor(NULL) AND created_by=app.current_user_id() AND state='draft' AND contributor_ids=ARRAY[app.current_user_id()]);
CREATE POLICY reward_library_version_config_update ON public.reward_library_version FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.reward_config_editor(NULL) AND state<>'confirmed')
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_config_editor(NULL) AND(state<>'confirmed' OR confirmed_by=app.current_user_id()));
CREATE POLICY reward_library_revision_audit_config_read ON public.reward_library_revision_audit FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.reward_config_editor(NULL));
CREATE POLICY reward_library_revision_audit_config_owner ON public.reward_library_revision_audit FOR INSERT TO ai_hr_owner
 WITH CHECK(tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND app.reward_config_editor(NULL));
CREATE FUNCTION app.reward_config_library_input_guard() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,app AS $$
DECLARE kind text;k text;r jsonb;m jsonb;prior bigint;n bigint;s jsonb;assignable boolean;
BEGIN
 IF NEW.tenant_id<>app.current_tenant_id() OR NOT app.reward_config_editor(NULL) THEN RAISE EXCEPTION 'Group-wide Rewards configuration authority required' USING ERRCODE='42501';END IF;
 SELECT l.kind INTO kind FROM reward_library l WHERE l.id=NEW.library_id AND l.tenant_id=NEW.tenant_id;
 IF kind IS NULL OR NEW.data->>'kind' IS DISTINCT FROM kind OR jsonb_typeof(NEW.data->'rows')<>'array' OR jsonb_array_length(NEW.data->'rows')<>13 THEN RAISE EXCEPTION 'A library must contain the complete active Grade Ladder';END IF;
 IF (SELECT count(DISTINCT x->>'grade') FROM jsonb_array_elements(NEW.data->'rows')x)<>13 OR (SELECT count(DISTINCT x->>'gradeId') FROM jsonb_array_elements(NEW.data->'rows')x)<>13 THEN RAISE EXCEPTION 'Include each Grade Ladder identity once';END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(NEW.data->'rows') LOOP
  IF app.architecture_grade(r->>'grade') IS DISTINCT FROM r->>'grade' OR NOT EXISTS(SELECT 1 FROM job_grade g WHERE g.id=(r->>'gradeId')::uuid AND g.tenant_id=NEW.tenant_id AND g.archived_at IS NULL AND app.architecture_grade(g.code)=r->>'grade') THEN RAISE EXCEPTION 'Library grade must match its active Grade Ladder identity';END IF;
  IF to_regprocedure('app.architecture_grade_assignable(uuid)') IS NOT NULL THEN EXECUTE 'select app.architecture_grade_assignable($1)' INTO assignable USING (r->>'gradeId')::uuid;IF assignable IS DISTINCT FROM true THEN RAISE EXCEPTION 'Choose an active assignable Grade Ladder identity';END IF;END IF;
  IF kind='salary' THEN
   IF NOT(r ?& ARRAY['gradeId','grade','minimumCents','midpointCents','maximumCents']) OR r-ARRAY['gradeId','grade','minimumCents','midpointCents','maximumCents']<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid salary row shape';END IF;
   IF r->>'grade'='23' THEN IF r->'minimumCents'<>'null'::jsonb OR r->'midpointCents'<>'null'::jsonb OR r->'maximumCents'<>'null'::jsonb THEN RAISE EXCEPTION 'JG23 has no salary range';END IF;
   ELSE
    FOREACH k IN ARRAY ARRAY['minimumCents','midpointCents','maximumCents'] LOOP IF jsonb_typeof(r->k) IS DISTINCT FROM 'number' OR coalesce(r->>k,'')!~'^[0-9]+$' OR (r->>k)::numeric NOT BETWEEN 1 AND 100000000000 THEN RAISE EXCEPTION 'Enter supported positive salary cents';END IF;END LOOP;
    IF (r->>'minimumCents')::bigint>=(r->>'midpointCents')::bigint OR (r->>'midpointCents')::bigint>=(r->>'maximumCents')::bigint THEN RAISE EXCEPTION 'Salary Minimum must be below Midpoint below Maximum';END IF;
   END IF;
  ELSE
   IF NOT(r ?& ARRAY['gradeId','grade','months']) OR r-ARRAY['gradeId','grade','months']<>'{}'::jsonb OR jsonb_typeof(r->'months')<>'array' OR jsonb_array_length(r->'months')<>5 THEN RAISE EXCEPTION 'Invalid bonus row shape';END IF;
   prior:=0;FOR m IN SELECT value FROM jsonb_array_elements(r->'months') LOOP IF m::text!~'^[0-9]+$' OR m::numeric NOT BETWEEN 0 AND 100000 OR m::numeric%100<>0 OR m::numeric<prior THEN RAISE EXCEPTION 'Bonus months must be ordered with two decimal places';END IF;prior:=m::bigint;END LOOP;
   IF r->'months'->>0<>'0' THEN RAISE EXCEPTION 'UA bonus months must be zero';END IF;
  END IF;
 END LOOP;
 IF kind='salary' THEN IF NEW.data-ARRAY['kind','rows']<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid salary library shape';END IF;
 ELSE
  IF NOT(NEW.data ?& ARRAY['kind','type','rows','segments']) OR NEW.data-ARRAY['kind','type','rows','segments']<>'{}'::jsonb OR NEW.data->>'type' NOT IN('standard','branch') OR jsonb_typeof(NEW.data->'segments')<>'array' OR jsonb_array_length(NEW.data->'segments')>100 OR (NEW.data->>'type'='branch')<>(jsonb_array_length(NEW.data->'segments')>0) THEN RAISE EXCEPTION 'Branch matrices require segment factors; standard matrices do not';END IF;
  IF (SELECT count(DISTINCT x->>'name')FROM jsonb_array_elements(NEW.data->'segments')x)<>jsonb_array_length(NEW.data->'segments') THEN RAISE EXCEPTION 'Segment names must be unique';END IF;
  FOR s IN SELECT value FROM jsonb_array_elements(NEW.data->'segments') LOOP
   IF NOT(s ?& ARRAY['name','factors']) OR length(trim(coalesce(s->>'name',''))) NOT BETWEEN 1 AND 80 OR s-ARRAY['name','factors']<>'{}'::jsonb OR jsonb_typeof(s->'factors')<>'array' OR jsonb_array_length(s->'factors')<>5 OR s->'factors'->>0<>'0' THEN RAISE EXCEPTION 'Each branch segment requires five factors and UA zero';END IF;
   FOR m IN SELECT value FROM jsonb_array_elements(s->'factors') LOOP IF m::text!~'^[0-9]+$' OR m::numeric NOT BETWEEN 0 AND 100000 OR m::numeric%100<>0 THEN RAISE EXCEPTION 'Use nonnegative factors with two decimal places';END IF;END LOOP;
  END LOOP;
 END IF;RETURN NEW;
END $$;
CREATE FUNCTION app.reward_config_library_capture_revision() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO reward_library_revision_audit(tenant_id,version_id,lock_version,actor_id,reason,after_state,after_values)
  VALUES(NEW.tenant_id,NEW.id,NEW.lock_version,app.current_user_id(),NEW.reason,NEW.state,NEW.data);
 ELSE
  INSERT INTO reward_library_revision_audit(tenant_id,version_id,lock_version,actor_id,reason,before_state,after_state,before_values,after_values)
  VALUES(NEW.tenant_id,NEW.id,NEW.lock_version,app.current_user_id(),NEW.reason,OLD.state,NEW.state,OLD.data,NEW.data);
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.reward_config_library_input_guard(),app.reward_config_library_capture_revision() FROM PUBLIC;
DROP TRIGGER reward_library_input_guard ON public.reward_library_version;
CREATE TRIGGER reward_library_input_guard BEFORE INSERT OR UPDATE ON public.reward_library_version FOR EACH ROW EXECUTE FUNCTION app.reward_config_library_input_guard();
DROP TRIGGER reward_library_capture_revision ON public.reward_library_version;
CREATE TRIGGER reward_library_capture_revision AFTER INSERT OR UPDATE ON public.reward_library_version FOR EACH ROW EXECUTE FUNCTION app.reward_config_library_capture_revision();
--> statement-breakpoint

-- 5. Company PAT: the editor of the company reads, saves and makes it active. Making it active reprices draft reviews
-- and marks reviews beyond draft for pool recalculation exactly as the installed chain does.
CREATE POLICY reward_pat_config_read ON public.reward_pat_version FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.reward_config_editor(company_id));
CREATE POLICY reward_pat_config_insert ON public.reward_pat_version FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_config_editor(company_id) AND created_by=app.current_user_id() AND state='pending');
CREATE POLICY reward_pat_config_edit ON public.reward_pat_version FOR UPDATE
 USING(tenant_id=app.current_tenant_id() AND app.reward_config_editor(company_id) AND state='pending')
 WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_config_editor(company_id) AND(state='pending' OR state='confirmed' AND confirmed_by=app.current_user_id()));
-- The rows the installed chain reached as the purpose reader (2205 reward_pat_basis_owner, reward_pat_draft_*).
CREATE POLICY reward_pat_basis_config_owner ON public.reward_pat_basis TO ai_hr_owner
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.id=unit_id AND u.tenant_id=reward_pat_basis.tenant_id AND app.reward_config_editor(u.company_id)))
 WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.id=unit_id AND u.tenant_id=reward_pat_basis.tenant_id AND app.reward_config_editor(u.company_id)));
CREATE POLICY reward_pat_draft_governance_config_owner ON public.reward_governance TO ai_hr_owner
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.id=unit_id AND u.tenant_id=reward_governance.tenant_id AND u.status='draft' AND app.reward_config_editor(u.company_id)))
 WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.id=unit_id AND u.tenant_id=reward_governance.tenant_id AND u.status='draft' AND app.reward_config_editor(u.company_id)));
CREATE POLICY reward_pat_draft_public_config_owner ON public.reward_governance_public TO ai_hr_owner
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.id=unit_id AND u.tenant_id=reward_governance_public.tenant_id AND u.status='draft' AND app.reward_config_editor(u.company_id)))
 WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.id=unit_id AND u.tenant_id=reward_governance_public.tenant_id AND u.status='draft' AND app.reward_config_editor(u.company_id)));
CREATE POLICY reward_pat_draft_history_config_owner ON public.reward_governance_history FOR INSERT TO ai_hr_owner
 WITH CHECK(tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND kind='company-pat-confirmed'
  AND EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.id=unit_id AND u.tenant_id=reward_governance_history.tenant_id AND u.status='draft' AND app.reward_config_editor(u.company_id)));
CREATE POLICY reward_unit_setup_pat_config_owner ON public.reward_unit_setup TO ai_hr_owner
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.id=unit_id AND u.tenant_id=reward_unit_setup.tenant_id AND app.reward_config_editor(u.company_id)))
 WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.id=unit_id AND u.tenant_id=reward_unit_setup.tenant_id AND app.reward_config_editor(u.company_id)));
CREATE FUNCTION app.reward_config_pat_input_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE k text;value jsonb;months bigint;
BEGIN
 IF NOT app.reward_config_editor(NEW.company_id) OR NEW.tenant_id<>app.current_tenant_id() THEN RAISE EXCEPTION 'Company PAT authority required' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':pat:'||NEW.company_id::text||':'||NEW.year::text,2203));
 IF EXISTS(SELECT 1 FROM reward_unit u JOIN reward_cycle c ON c.id=u.cycle_id AND c.tenant_id=u.tenant_id JOIN reward_unit_setup binding ON binding.unit_id=u.id AND binding.tenant_id=u.tenant_id WHERE u.tenant_id=NEW.tenant_id AND u.company_id=NEW.company_id AND c.year=NEW.year AND u.deleted_at IS NULL AND u.status IN('ec','approved','posted')) THEN RAISE EXCEPTION 'Company PAT is locked at EC approval';END IF;
 IF jsonb_typeof(NEW.inputs)<>'object' OR NOT(NEW.inputs ?& ARRAY['targetCents','forecastCents','actualCents','targetMonthsBp']) OR NEW.inputs-ARRAY['targetCents','forecastCents','actualCents','targetMonthsBp']<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid PAT input shape';END IF;
 FOREACH k IN ARRAY ARRAY['targetCents','forecastCents','actualCents'] LOOP
  value:=NEW.inputs->k;
  IF value<>'null'::jsonb AND(jsonb_typeof(value)<>'number' OR value::text !~ '^-?[0-9]+$' OR (value::text)::numeric NOT BETWEEN -100000000000 AND 100000000000) THEN RAISE EXCEPTION 'PAT amounts must use supported integer cents';END IF;
 END LOOP;
 IF NEW.inputs->>'targetCents' IS NOT NULL AND (NEW.inputs->>'targetCents')::bigint<=0 OR NEW.inputs->>'targetCents' IS NULL AND coalesce(NEW.inputs->>'actualCents',NEW.inputs->>'forecastCents') IS NOT NULL THEN RAISE EXCEPTION 'A positive target is required for entered PAT';END IF;
 IF coalesce(NEW.inputs->>'targetMonthsBp','') !~ '^[0-9]+$' THEN RAISE EXCEPTION 'Invalid target months';END IF;
 months:=(NEW.inputs->>'targetMonthsBp')::bigint;IF months NOT BETWEEN 0 AND 100000 OR months%100<>0 THEN RAISE EXCEPTION 'Use supported target months precision';END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION app.reward_config_pat_affected_units(wanted_company uuid,wanted_year integer) RETURNS TABLE(id uuid,status text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NOT app.reward_config_editor(wanted_company) THEN RAISE EXCEPTION 'Company PAT authority required' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT u.id,u.status FROM reward_unit u JOIN reward_cycle c ON c.id=u.cycle_id AND c.tenant_id=u.tenant_id JOIN reward_unit_setup s ON s.unit_id=u.id AND s.tenant_id=u.tenant_id WHERE u.tenant_id=app.current_tenant_id() AND u.company_id=wanted_company AND c.year=wanted_year AND u.deleted_at IS NULL ORDER BY u.id FOR UPDATE OF u;
END $$;
CREATE FUNCTION app.reward_config_reprice_draft_pat(wanted_unit uuid,wanted_pat uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE u reward_unit%ROWTYPE;p reward_pat_version%ROWTYPE;b reward_pat_basis%ROWTYPE;before_state jsonb;after_state jsonb;public_state jsonb;old_pools jsonb;new_pools jsonb;pool_status text;numerator numeric;target numeric;months numeric;standard_pool numeric;h_pool numeric;
BEGIN
 SELECT * INTO u FROM reward_unit WHERE id=wanted_unit AND tenant_id=app.current_tenant_id() AND deleted_at IS NULL FOR UPDATE;
 IF u.id IS NULL OR u.status<>'draft' OR NOT app.reward_config_editor(u.company_id) THEN RAISE EXCEPTION 'Only an authorized draft can adopt confirmed PAT';END IF;
 SELECT * INTO p FROM reward_pat_version WHERE id=wanted_pat AND tenant_id=u.tenant_id AND company_id=u.company_id AND year=(u.policy->>'year')::integer AND state='confirmed';
 IF p.id IS NULL OR EXISTS(SELECT 1 FROM reward_pat_version newer WHERE newer.tenant_id=p.tenant_id AND newer.company_id=p.company_id AND newer.year=p.year AND newer.state='confirmed' AND newer.revision>p.revision) OR NOT EXISTS(SELECT 1 FROM reward_unit_setup s WHERE s.unit_id=u.id AND s.tenant_id=u.tenant_id) THEN RAISE EXCEPTION 'Use the current confirmed company PAT';END IF;
 SELECT * INTO b FROM reward_pat_basis WHERE unit_id=u.id AND tenant_id=u.tenant_id FOR UPDATE;
 SELECT state INTO before_state FROM reward_governance WHERE unit_id=u.id AND tenant_id=u.tenant_id FOR UPDATE;
 SELECT snapshot INTO public_state FROM reward_governance_public WHERE unit_id=u.id AND tenant_id=u.tenant_id FOR UPDATE;
 IF b.unit_id IS NULL OR before_state IS NULL OR public_state IS NULL OR b.fingerprint IS DISTINCT FROM app.reward_pat_basis_fingerprint(u.id) OR b.engine_basis IS DISTINCT FROM public_state->>'basis' THEN RAISE EXCEPTION 'An affected draft budget basis is stale or missing. Refresh its unit budget inputs before confirming company PAT.' USING ERRCODE='40001';END IF;
 numerator:=greatest(0,coalesce(p.inputs->>'actualCents',p.inputs->>'forecastCents')::numeric);target:=(p.inputs->>'targetCents')::numeric;months:=(p.inputs->>'targetMonthsBp')::numeric;
 pool_status:=CASE WHEN target IS NULL OR coalesce(p.inputs->>'actualCents',p.inputs->>'forecastCents') IS NULL THEN 'not-set' WHEN p.inputs->>'actualCents' IS NOT NULL THEN 'final' ELSE 'provisional' END;
 -- Exactly engine.ratio(engine.ratio(payroll, PAT, target), months, 10000): two separate floors.
 standard_pool:=app.reward_pat_pool_from_payroll(b.standard_payroll,p.inputs);
 h_pool:=app.reward_pat_pool_from_payroll(b.h_payroll,p.inputs);
 IF standard_pool>9007199254740991 OR h_pool>9007199254740991 THEN RAISE EXCEPTION 'Calculated pool exceeds the supported amount';END IF;
 old_pools:=public_state->'pools';new_pools:=jsonb_build_object('standard',standard_pool::bigint,'h',h_pool::bigint);
 after_state:=jsonb_set(jsonb_set(before_state,'{inputs}',p.inputs||jsonb_build_object('multiplierBp',before_state->'inputs'->'multiplierBp','branchRatings',coalesce(before_state->'inputs'->'branchRatings','{}'::jsonb))),'{previousPools}',old_pools);
 UPDATE reward_unit_setup SET previous_pat_version_id=pat_version_id,pat_version_id=p.id,pool_recalculation_required=false,updated_at=now() WHERE unit_id=u.id AND tenant_id=u.tenant_id;
 UPDATE reward_governance SET state=after_state,updated_at=now() WHERE unit_id=u.id AND tenant_id=u.tenant_id;
 UPDATE reward_governance_public SET snapshot=public_state||jsonb_build_object('status',pool_status,'pools',new_pools,'targetMonthsBp',p.inputs->'targetMonthsBp','previousPools',old_pools) WHERE unit_id=u.id AND tenant_id=u.tenant_id;
 INSERT INTO reward_governance_history(tenant_id,unit_id,actor_id,kind,reason,before_state,after_state)VALUES(u.tenant_id,u.id,app.current_user_id(),'company-pat-confirmed',p.reason,before_state,after_state);
 UPDATE reward_unit SET policy=jsonb_set(policy,'{unitGovernanceDigest}',to_jsonb(encode(sha256(convert_to(after_state::text,'UTF8')),'hex'))),revision=revision+1,updated_at=now() WHERE id=u.id AND tenant_id=u.tenant_id;
END $$;
CREATE FUNCTION app.reward_config_apply_confirmed_pat(wanted_unit uuid,wanted_pat uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE u reward_unit%ROWTYPE;p reward_pat_version%ROWTYPE;
BEGIN
 SELECT * INTO u FROM reward_unit WHERE id=wanted_unit AND tenant_id=app.current_tenant_id() AND deleted_at IS NULL FOR UPDATE;
 SELECT * INTO p FROM reward_pat_version WHERE id=wanted_pat AND tenant_id=u.tenant_id AND company_id=u.company_id AND year=(u.policy->>'year')::integer AND state='confirmed' AND confirmed_by=app.current_user_id() AND confirmed_at=transaction_timestamp();
 IF p.id IS NULL OR NOT app.reward_config_editor(u.company_id) OR u.status IN('ec','approved','posted') THEN RAISE EXCEPTION 'Apply the active PAT in the transaction that made it active';END IF;
 IF u.status='draft' THEN PERFORM app.reward_config_reprice_draft_pat(u.id,p.id);ELSE UPDATE reward_unit_setup SET pool_recalculation_required=true,updated_at=now() WHERE unit_id=u.id AND tenant_id=u.tenant_id AND pat_version_id<>p.id;END IF;
END $$;
CREATE FUNCTION app.reward_config_pat_confirm_apply() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE affected record;
BEGIN
 IF OLD.state='pending' AND NEW.state='confirmed' THEN
  FOR affected IN SELECT * FROM app.reward_config_pat_affected_units(NEW.company_id,NEW.year) LOOP
   PERFORM app.reward_config_apply_confirmed_pat(affected.id,NEW.id);
  END LOOP;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.reward_config_pat_input_guard(),app.reward_config_pat_affected_units(uuid,integer),app.reward_config_reprice_draft_pat(uuid,uuid),
 app.reward_config_apply_confirmed_pat(uuid,uuid),app.reward_config_pat_confirm_apply() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_config_pat_affected_units(uuid,integer) TO ai_hr_app;
DROP TRIGGER reward_pat_input_guard ON public.reward_pat_version;
CREATE TRIGGER reward_pat_input_guard BEFORE INSERT OR UPDATE ON public.reward_pat_version FOR EACH ROW EXECUTE FUNCTION app.reward_config_pat_input_guard();
DROP TRIGGER reward_pat_confirm_apply ON public.reward_pat_version;
CREATE TRIGGER reward_pat_confirm_apply AFTER UPDATE ON public.reward_pat_version FOR EACH ROW EXECUTE FUNCTION app.reward_config_pat_confirm_apply();
--> statement-breakpoint

-- 6. Reviews from an active plan, created by whoever made it active. The annual-admission guard admits this owner
-- creator only while it runs (its transaction id in a local setting, and the owner role, which ai_hr_app cannot
-- assume); every snapshot and binding check is unchanged.
CREATE FUNCTION app.reward_config_creating() RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce(current_setting('app.reward_config_creating',true),'')=txid_current()::text
  AND pg_catalog.pg_has_role(current_user,(SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.app_user'::regclass),'USAGE')
$$;
CREATE OR REPLACE FUNCTION app.reward_policy_binding_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE binding jsonb; expected_policy jsonb; year_value integer; uploaded boolean:=false;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.policy_group_version_id IS DISTINCT FROM OLD.policy_group_version_id OR
   (OLD.policy_group_version_id IS NOT NULL AND (NEW.company_id IS DISTINCT FROM OLD.company_id
    OR NEW.business_unit_id IS DISTINCT FROM OLD.business_unit_id OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.cycle_id IS DISTINCT FROM OLD.cycle_id OR NEW.policy->'year' IS DISTINCT FROM OLD.policy->'year')) THEN
   RAISE EXCEPTION 'reward policy lineage is immutable' USING ERRCODE='23514'; END IF;
 ELSIF NEW.kind='annual' THEN
  IF COALESCE(NEW.policy->>'year','') !~ '^(20[0-9]{2}|21[0-9]{2}|2200)$' THEN RAISE EXCEPTION 'reward policy year is invalid' USING ERRCODE='23514'; END IF;
  year_value:=(NEW.policy->>'year')::integer;
  IF (current_user='ai_hr_reward_setup_reader' OR app.reward_config_creating()) AND NEW.tenant_id=app.current_tenant_id() AND NEW.created_by=app.current_user_id() AND app.reward_setup_allowed(NEW.company_id,'manage') THEN
   IF NEW.policy_group_version_id IS NULL THEN
    IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='public.reward_company_exclusion'::regclass AND attname='award_type' AND NOT attisdropped) THEN
     EXECUTE 'select exists(select 1 from public.reward_company_exclusion where tenant_id=$1 and company_id=$2 and year=$3 and ended_at is null and award_type=''uploaded'')' INTO uploaded USING NEW.tenant_id,NEW.company_id,year_value;
    END IF;
    IF NOT uploaded THEN RAISE EXCEPTION 'Uploaded annual participation is not active' USING ERRCODE='42501';END IF;
   ELSE
    SELECT app.reward_config_planned_policy_snapshot(src.policy,salary.data,bonus.data,pat.inputs) INTO expected_policy
    FROM public.reward_plan_setup p
    JOIN public.reward_plan_company c ON c.tenant_id=p.tenant_id AND c.plan_version_id=p.version_id AND c.company_id=NEW.company_id AND c.year=p.year
    JOIN public.reward_policy_group_version src ON src.tenant_id=p.tenant_id AND src.id=p.version_id
    CROSS JOIN LATERAL jsonb_array_elements(p.bindings) b
    JOIN public.reward_library_version salary ON salary.tenant_id=p.tenant_id AND salary.id=(b->>'salaryVersionId')::uuid AND salary.state='confirmed'
    JOIN public.reward_library_version bonus ON bonus.tenant_id=p.tenant_id AND bonus.id=(b->>'bonusVersionId')::uuid AND bonus.state='confirmed'
    JOIN LATERAL(SELECT inputs FROM public.reward_pat_version pv WHERE pv.tenant_id=p.tenant_id AND pv.company_id=c.company_id AND pv.year=p.year AND pv.state='confirmed' ORDER BY pv.revision DESC LIMIT 1)pat ON true
    WHERE p.tenant_id=NEW.tenant_id AND p.version_id=NEW.policy_group_version_id AND p.state='approved' AND p.year=year_value AND p.snapshot_date=NEW.snapshot_date AND b->>'companyId'=NEW.company_id::text AND b->>'businessUnitId'=NEW.business_unit_id::text;
    IF expected_policy IS NULL OR NEW.policy IS DISTINCT FROM expected_policy THEN
     RAISE EXCEPTION 'Reward policy snapshot does not match approved plan and applied inputs' USING ERRCODE='23514';
    END IF;
   END IF;
  ELSIF current_user='ai_hr_app' THEN
   RAISE EXCEPTION 'Use approved Rewards annual admission' USING ERRCODE='42501';
  ELSE
   binding:=app.reward_policy_for_review(NEW.policy_group_version_id,NEW.company_id,NEW.business_unit_id,year_value);
   IF binding IS NOT NULL AND NEW.policy IS DISTINCT FROM binding->'policy' THEN RAISE EXCEPTION 'reward policy snapshot does not match selected version' USING ERRCODE='23514'; END IF;
  END IF;
 ELSIF NEW.policy_group_version_id IS NOT NULL THEN
  RAISE EXCEPTION 'shared policy binds only a future annual review' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE FUNCTION app.reward_config_create_planned_unit(wanted_version uuid,wanted_company uuid,wanted_business_unit uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();p reward_plan_setup%ROWTYPE;b jsonb;s jsonb;v jsonb;pat reward_pat_version%ROWTYPE;policy jsonb;cycle uuid;existing_cycle_name text;unit uuid:=gen_random_uuid();source jsonb;row record;overlap boolean;pending_names text;company_tags jsonb;
BEGIN
 -- The same lock order as setupTenant and the installed 4100 entry point, ahead of the plan and company locks.
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':plans',2203));
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':company-year:'||wanted_company::text||':'||(SELECT year FROM reward_plan_setup WHERE tenant_id=t AND version_id=wanted_version)::text,2203));
 IF t IS NULL OR actor IS NULL OR NOT coalesce(app.reward_not_viewing_as(),false) OR NOT app.reward_setup_allowed(wanted_company,'manage') THEN RAISE EXCEPTION 'Group Rewards plan creation authority required' USING ERRCODE='42501';END IF;
 -- The annual-admission guard (app.reward_policy_binding_guard) admits this owner writer only inside this call.
 PERFORM set_config('app.reward_config_creating',txid_current()::text,true);
 SELECT * INTO p FROM reward_plan_setup WHERE tenant_id=t AND version_id=wanted_version AND state='approved';
 IF p.version_id IS NULL OR NOT app.reward_config_company_eligible(wanted_company,p.year) OR p.snapshot_date>timezone('Asia/Kuala_Lumpur',now())::date THEN RAISE EXCEPTION 'Current approved plan and available legal employer required';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':pat:'||wanted_company::text||':'||p.year::text,2203));
 company_tags:=app.reward_config_company_structure(wanted_company,p.snapshot_date);IF company_tags->>'status' IS DISTINCT FROM 'ready' OR nullif(company_tags->>'businessUnitId','')::uuid IS DISTINCT FROM wanted_business_unit THEN RAISE EXCEPTION 'Confirmed dated company Business unit required at the approved plan snapshot' USING ERRCODE='22023';END IF;
 SELECT value INTO b FROM jsonb_array_elements(p.bindings) WHERE value->>'companyId'=wanted_company::text AND value->>'businessUnitId'=wanted_business_unit::text;
 IF b IS NULL OR NOT EXISTS(SELECT 1 FROM reward_plan_company c WHERE c.tenant_id=t AND c.company_id=wanted_company AND c.year=p.year AND c.plan_version_id=wanted_version) THEN RAISE EXCEPTION 'Company is not assigned to this approved plan';END IF;
 IF EXISTS(SELECT 1 FROM reward_unit u JOIN reward_cycle c ON c.id=u.cycle_id AND c.tenant_id=u.tenant_id WHERE u.tenant_id=t AND u.company_id=wanted_company AND c.year=p.year AND u.kind='annual' AND u.deleted_at IS NULL) OR EXISTS(SELECT 1 FROM reward_company_year_review WHERE tenant_id=t AND company_id=wanted_company AND year=p.year) THEN RAISE EXCEPTION 'Company already has a review for this reward year';END IF;
 SELECT rv.data INTO s FROM reward_library_version rv JOIN reward_library l ON l.id=rv.library_id AND l.tenant_id=rv.tenant_id WHERE rv.id=(b->>'salaryVersionId')::uuid AND rv.tenant_id=t AND rv.state='confirmed' AND l.kind='salary' AND l.year=p.year;
 SELECT rv.data INTO v FROM reward_library_version rv JOIN reward_library l ON l.id=rv.library_id AND l.tenant_id=rv.tenant_id WHERE rv.id=(b->>'bonusVersionId')::uuid AND rv.tenant_id=t AND rv.state='confirmed' AND l.kind='bonus' AND l.year=p.year;
 SELECT * INTO pat FROM reward_pat_version WHERE tenant_id=t AND company_id=wanted_company AND year=p.year AND state='confirmed' ORDER BY revision DESC LIMIT 1;
 IF s IS NULL OR v IS NULL OR pat.id IS NULL OR(pat.inputs->>'targetCents')::bigint<=0 OR coalesce(pat.inputs->>'actualCents',pat.inputs->>'forecastCents') IS NULL THEN RAISE EXCEPTION 'Confirmed libraries and PAT are required';END IF;
 source:=app.reward_config_policy_source(wanted_version);policy:=source->'policy';
 policy:=app.reward_config_planned_policy_snapshot(policy,s,v,pat.inputs);
 SELECT c.id,c.name INTO cycle,existing_cycle_name FROM reward_setup_cycle link JOIN reward_cycle c ON c.id=link.cycle_id AND c.tenant_id=link.tenant_id WHERE link.tenant_id=t AND link.group_id=p.group_id AND link.year=p.year;
 IF cycle IS NULL THEN INSERT INTO reward_cycle(tenant_id,name,year,created_by) VALUES(t,p.cycle_name,p.year,actor) RETURNING id INTO cycle;INSERT INTO reward_setup_cycle VALUES(t,p.group_id,p.year,wanted_version,cycle);ELSIF existing_cycle_name IS DISTINCT FROM p.cycle_name THEN RAISE EXCEPTION 'The cycle name is fixed after the first review is created';END IF;
 INSERT INTO reward_unit(id,tenant_id,created_by,cycle_id,company_id,business_unit_id,policy,policy_group_version_id,snapshot_date) VALUES(unit,t,actor,cycle,wanted_company,wanted_business_unit,policy,wanted_version,p.snapshot_date);
 INSERT INTO reward_company_year_review VALUES(t,wanted_company,p.year,unit,'planned');
 INSERT INTO reward_unit_setup(unit_id,tenant_id,plan_version_id,salary_version_id,bonus_version_id,pat_version_id) VALUES(unit,t,wanted_version,(b->>'salaryVersionId')::uuid,(b->>'bonusVersionId')::uuid,pat.id);
 INSERT INTO reward_member(tenant_id,unit_id,user_id,role,valid_from) VALUES(t,unit,actor,'gr',timezone('Asia/Kuala_Lumpur',now())::date);
 SELECT string_agg(coalesce(e.employee_code,e.id::text)||' · '||pe.full_name,'; ' ORDER BY e.employee_code,e.id) INTO pending_names FROM employment e JOIN person pe ON pe.id=e.person_id AND pe.tenant_id=e.tenant_id AND pe.import_pending_attempt_id IS NULL WHERE e.tenant_id=t AND e.import_pending_attempt_id IS NULL AND e.hired_on<=p.snapshot_date AND(e.terminated_on IS NULL OR e.terminated_on>p.snapshot_date) AND app.reward_config_source_org_tags(e.id,p.snapshot_date)->>'companyId'=wanted_company::text AND coalesce(app.reward_config_source_org_tags(e.id,p.snapshot_date)->>'status','pending') NOT IN('legacy','ready');
 IF pending_names IS NOT NULL THEN RAISE EXCEPTION 'Group structure tagging is pending: %',pending_names;END IF;
 SELECT EXISTS(SELECT 1 FROM employment e JOIN assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id WHERE e.tenant_id=t AND e.import_pending_attempt_id IS NULL AND app.reward_config_source_org_tags(e.id,p.snapshot_date)->>'companyId'=wanted_company::text AND e.hired_on<=p.snapshot_date AND(e.terminated_on IS NULL OR e.terminated_on>p.snapshot_date) AND (CASE WHEN app.reward_config_source_org_tags(e.id,p.snapshot_date)->>'status'='legacy' THEN a.business_unit_id ELSE nullif(app.reward_config_source_org_tags(e.id,p.snapshot_date)->>'businessUnitId','')::uuid END)=wanted_business_unit AND a.valid_from<=p.snapshot_date AND(a.valid_to IS NULL OR a.valid_to>p.snapshot_date) AND a.superseded_at IS NULL GROUP BY e.id HAVING count(*)>1) INTO overlap;
 IF overlap THEN RAISE EXCEPTION 'An employee has overlapping assignments; correct Personnel before creating reviews';END IF;
 FOR row IN SELECT e.*,a.id AS assignment_id,a.position_id AS assignment_position_id,j.code AS grade_code,pe.full_name,comp.id AS compensation_id,comp.basic_salary,comp.currency AS comp_currency,comp.pay_mode,comp.valid_from AS pay_from,pr.id AS review_id,pr.overall_rating
 FROM employment e JOIN person pe ON pe.id=e.person_id AND pe.tenant_id=e.tenant_id AND pe.import_pending_attempt_id IS NULL JOIN assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id
 LEFT JOIN job_grade j ON j.id=e.grade_id AND j.tenant_id=e.tenant_id
 LEFT JOIN LATERAL(SELECT * FROM compensation c WHERE c.employment_id=e.id AND c.tenant_id=e.tenant_id AND c.valid_from<=p.snapshot_date AND(c.valid_to IS NULL OR c.valid_to>p.snapshot_date) AND c.superseded_at IS NULL ORDER BY c.valid_from DESC,c.id DESC LIMIT 1)comp ON true
 LEFT JOIN LATERAL(SELECT r.id,r.overall_rating FROM performance_review r JOIN review_cycle c ON c.id=r.cycle_id AND c.tenant_id=r.tenant_id WHERE r.employment_id=e.id AND r.tenant_id=e.tenant_id AND r.closed_at IS NOT NULL AND c.period_start<=make_date(p.year,12,31) AND c.period_end>=make_date(p.year,1,1) ORDER BY r.closed_at DESC,r.id DESC LIMIT 1)pr ON true
 WHERE e.tenant_id=t AND e.import_pending_attempt_id IS NULL AND app.reward_config_source_org_tags(e.id,p.snapshot_date)->>'companyId'=wanted_company::text AND e.hired_on<=p.snapshot_date AND(e.terminated_on IS NULL OR e.terminated_on>p.snapshot_date) AND (CASE WHEN app.reward_config_source_org_tags(e.id,p.snapshot_date)->>'status'='legacy' THEN a.business_unit_id ELSE nullif(app.reward_config_source_org_tags(e.id,p.snapshot_date)->>'businessUnitId','')::uuid END)=wanted_business_unit AND a.valid_from<=p.snapshot_date AND(a.valid_to IS NULL OR a.valid_to>p.snapshot_date) AND a.superseded_at IS NULL
 LOOP
 INSERT INTO reward_entry(tenant_id,unit_id,employment_id,source,facts,recommendation) VALUES(t,unit,row.id,jsonb_build_object('employmentId',row.id,'assignmentId',row.assignment_id,'positionId',row.assignment_position_id,'personId',row.person_id,'compensationId',row.compensation_id,'employeeCode',coalesce(row.employee_code,row.id::text),'name',row.full_name,'grade',regexp_replace(coalesce(row.grade_code,''),'^JG[[:space:]]*','','i'),'gradeId',row.grade_id,'basicCents',coalesce(round(row.basic_salary*100),0),'currency',coalesce(row.comp_currency,'MYR'),'payMode',coalesce(row.pay_mode,'monthly'),'hiredOn',row.hired_on,'confirmedOn',row.confirmation_date,'notice',(row.tender_resignation_date IS NOT NULL AND row.tender_resignation_date<=p.snapshot_date) OR(row.resignation_date IS NOT NULL AND row.resignation_date<=p.snapshot_date),'lastPayChange',CASE WHEN row.pay_from>row.hired_on THEN row.pay_from ELSE NULL END,'confirmationPayChange',coalesce(row.pay_from=row.confirmation_date AND row.pay_from>row.hired_on,false),'performanceReviewId',row.review_id,'performanceRating',row.overall_rating,'architecture',app.reward_architecture_for_source(unit,row.id,row.assignment_position_id,p.snapshot_date),'payChanges',coalesce((SELECT jsonb_agg(jsonb_build_object('on',x.valid_from,'basicCents',round(x.basic_salary*100),'kind',app.reward_snapshot_pay_change_kind(x.id)) ORDER BY x.valid_from,x.id) FROM(SELECT c.*,lag(c.basic_salary)over(ORDER BY c.valid_from,c.id) AS prior_basic FROM compensation c WHERE c.employment_id=row.id AND c.tenant_id=t AND c.superseded_at IS NULL)x WHERE x.prior_basic IS NOT NULL AND x.basic_salary<>x.prior_basic AND x.valid_from>row.hired_on AND x.valid_from BETWEEN make_date(p.year,1,1) AND make_date(p.year+1,12,31)),'[]'::jsonb)),
 '{"talent":null,"performance":null,"confidentiality":"standard","seniorPlan":false,"erCase":false,"pipCase":false,"erDecision":"pending","pipDecision":"pending","caseReason":"","segment":"","branch":"","reviewed":false}'::jsonb,
 '{"meritBp":null,"promotionGrade":null,"promotionBp":null,"specialBp":null,"multiplierBp":null,"bonusCents":null,"lumpCents":null,"reason":"","currentRoleSummary":"","proposedRoleSummary":""}'::jsonb);
 END LOOP;
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(t,'reward-unit',unit,'reward-unit.approved-plan-admitted','user',actor,jsonb_build_object('planVersionId',wanted_version,'salaryVersionId',b->>'salaryVersionId','bonusVersionId',b->>'bonusVersionId','patVersionId',pat.id));
 PERFORM set_config('app.reward_config_creating','',true);
 RETURN unit;
END $$;
REVOKE ALL ON FUNCTION app.reward_config_create_planned_unit(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_config_create_planned_unit(uuid,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint

-- 7. Uploaded awards: the uploader makes the unchanged, valid current version active. The checks that read whole-file
-- rows run in the owner function below; the validation and editable-lines checks keep their purpose owners and run as
-- the writer, as the installed trigger's own callees did.
CREATE POLICY reward_uploaded_award_config_owner ON public.reward_uploaded_award FOR SELECT TO ai_hr_owner
 USING(tenant_id=app.current_tenant_id() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))));
CREATE FUNCTION app.reward_config_uploaded_binding_check(p_table text,p_op text,p_new jsonb,p_old jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE unit uuid:=(p_new->>'unit_id')::uuid;t uuid:=(p_new->>'tenant_id')::uuid;actor uuid:=app.current_user_id();actor_person uuid;snapshot jsonb;
BEGIN
 IF p_table NOT IN('reward_uploaded_review','reward_uploaded_version') OR p_op NOT IN('INSERT','UPDATE') OR p_op='UPDATE' AND p_old IS NULL THEN RAISE EXCEPTION 'Uploaded review binding invalid';END IF;
 IF NOT EXISTS(SELECT 1 FROM reward_unit WHERE id=unit AND tenant_id=t AND kind='annual') THEN RAISE EXCEPTION 'Uploaded review binding invalid';END IF;
 IF p_table='reward_uploaded_review' AND p_op='UPDATE' THEN
  IF NOT EXISTS(SELECT 1 FROM reward_unit u WHERE u.id=unit AND u.tenant_id=t AND u.status='draft') THEN RAISE EXCEPTION 'Whole uploads and activation are limited to BU stage';END IF;
  IF p_new->>'unit_id' IS DISTINCT FROM p_old->>'unit_id' OR p_new->>'tenant_id' IS DISTINCT FROM p_old->>'tenant_id' THEN RAISE EXCEPTION 'Upload identity is immutable';END IF;
  IF (p_old->>'refresh_required')::boolean AND NOT (p_new->>'refresh_required')::boolean AND (p_new->>'current_version')::integer=(p_old->>'current_version')::integer THEN RAISE EXCEPTION 'Refreshed sources require a new upload version';END IF;
  IF (p_new->>'current_version')::integer<>(p_old->>'current_version')::integer THEN
   IF (p_new->>'current_version')::integer<>(p_old->>'current_version')::integer+1 OR p_new->>'checked_by' IS NOT NULL OR p_new->>'checked_version' IS NOT NULL OR p_new->>'checked_at' IS NOT NULL
    OR NOT EXISTS(SELECT 1 FROM reward_uploaded_version v WHERE v.tenant_id=t AND v.unit_id=unit AND v.version=(p_new->>'current_version')::integer AND v.uploaded_by=actor) THEN RAISE EXCEPTION 'Replacement must append the doer current version and reset confirmation';END IF;
  ELSIF p_new->>'checked_by' IS NOT NULL AND (p_old->>'checked_by' IS NOT NULL OR p_new->>'checked_at' IS NULL OR NOT EXISTS(SELECT 1 FROM reward_uploaded_version v WHERE v.unit_id=unit AND v.tenant_id=t AND v.version=(p_new->>'current_version')::integer
   AND (SELECT coalesce(jsonb_agg(x.value-ARRAY['incrementCents','warnings'] ORDER BY x.value->>'employmentId'),'[]'::jsonb) FROM jsonb_array_elements(v.rows)x)=(SELECT coalesce(jsonb_agg(a.award ORDER BY e.employment_id::text),'[]'::jsonb) FROM reward_uploaded_award a JOIN reward_entry e ON e.id=a.entry_id AND e.unit_id=a.unit_id AND e.tenant_id=a.tenant_id WHERE a.unit_id=unit AND a.tenant_id=t))) THEN
   RAISE EXCEPTION 'Only the unchanged current upload can be made active';END IF;
 END IF;
 IF p_table='reward_uploaded_version' THEN
  SELECT person_id INTO actor_person FROM app_user WHERE id=actor AND tenant_id=app.current_tenant_id();
  snapshot:=(SELECT coalesce(jsonb_agg(jsonb_build_object('employmentId',e.employment_id,'source',e.source,'facts',e.facts) ORDER BY e.employment_id),'[]'::jsonb) FROM reward_entry e WHERE e.unit_id=unit AND e.tenant_id=t AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_new->'rows') r WHERE r->>'employmentId'=e.employment_id::text));
  IF (p_new->>'uploaded_by')::uuid<>actor OR NOT EXISTS(SELECT 1 FROM reward_unit u JOIN reward_uploaded_review r ON r.unit_id=u.id AND r.tenant_id=u.tenant_id WHERE u.id=unit AND u.tenant_id=t AND u.status='draft' AND (p_new->>'version')::integer=r.current_version+1) THEN RAISE EXCEPTION 'Upload versions are append-only at BU stage';END IF;
  -- The same digest as the installed trigger: rows, input snapshot, file name, import text and evidence.
  RETURN jsonb_build_object('uploadedByPerson',actor_person,'inputSnapshot',snapshot,'digest',encode(sha256(convert_to(jsonb_build_object('rows',p_new->'rows','snapshot',snapshot,'originalFileName',p_new->'original_file_name','import',p_new->'import_content','evidenceName',p_new->'evidence_name','evidenceType',p_new->'evidence_mime','evidence',p_new->'evidence_content')::text,'UTF8')),'hex'));
 END IF;
 -- Making an upload active: the current editor, the current version. Who uploaded it no longer matters (board 60f1fdcd).
 IF p_new->>'checked_by' IS NOT NULL AND ((p_new->>'checked_by')::uuid<>actor OR (p_new->>'checked_version')::integer<>(p_new->>'current_version')::integer
  OR NOT EXISTS(SELECT 1 FROM reward_uploaded_version v WHERE v.unit_id=unit AND v.tenant_id=t AND v.version=(p_new->>'current_version')::integer)) THEN
  RAISE EXCEPTION 'Make the current upload version active as yourself';END IF;
 RETURN '{}'::jsonb;
END $$;
CREATE FUNCTION app.reward_config_uploaded_binding() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,app AS $$
DECLARE computed jsonb;
BEGIN
 computed:=app.reward_config_uploaded_binding_check(TG_TABLE_NAME,TG_OP,to_jsonb(NEW),CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) END);
 IF TG_TABLE_NAME='reward_uploaded_version' THEN
  NEW.uploaded_by_person:=(computed->>'uploadedByPerson')::uuid;NEW.input_snapshot:=computed->'inputSnapshot';NEW.digest:=computed->>'digest';
 ELSIF NEW.checked_by IS NOT NULL AND (NEW.refresh_required OR NOT app.reward_uploaded_awards_editable(NEW.unit_id) OR coalesce((app.reward_uploaded_validation(NEW.unit_id)->>'valid')::boolean,false)=false) THEN
  RAISE EXCEPTION 'Only current valid uploaded awards can be made active';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_config_uploaded_binding_check(text,text,jsonb,jsonb),app.reward_config_uploaded_binding() FROM PUBLIC;
-- The writers of these rows: the application, the purpose creator and source refresh (2208) and the upload reader.
GRANT EXECUTE ON FUNCTION app.reward_config_uploaded_binding_check(text,text,jsonb,jsonb) TO ai_hr_app,ai_hr_reward_setup_reader,ai_hr_reward_upload_reader;
DROP TRIGGER reward_uploaded_binding ON public.reward_uploaded_review;
CREATE TRIGGER reward_uploaded_binding BEFORE INSERT OR UPDATE ON public.reward_uploaded_review FOR EACH ROW EXECUTE FUNCTION app.reward_config_uploaded_binding();
DROP TRIGGER reward_uploaded_version_binding ON public.reward_uploaded_version;
CREATE TRIGGER reward_uploaded_version_binding BEFORE INSERT ON public.reward_uploaded_version FOR EACH ROW EXECUTE FUNCTION app.reward_config_uploaded_binding();
