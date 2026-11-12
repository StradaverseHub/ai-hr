-- Board 60f1fdcd + db14e49c, composed at the board release integration (docs/adr/2026-11-12-rewards-direct-configuration.md).
-- 5580 lets CTRO and HR Admin edit Salary Structures, Bonus Matrices and company PAT through
-- app.reward_config_editor; 5520's restrictive app-role policies on reward_library, reward_library_version and
-- reward_pat_version gate the same tables by app.reward_actor_page_level, which counted only Group Rewards, CTRO and
-- the Executive Chairman, and its catalogue gave CTRO View only and HR Admin nothing on those rows. Without this
-- migration the row security refuses what 5580 allows.
--
--  1. The catalogue default (also the ceiling) for salary.view, bonus.view and pat.manage is Full for Group Rewards,
--     CTRO and HR Admin, mirroring packs/rewards/access-policy-model.ts. Options follow unchanged
--     (app.reward_role_level_options): salary and bonus offer Full / View only / —, PAT offers Full / —.
--  2. app.reward_actor_page_level also counts HR Admin, so the grid narrows HR Admin as it narrows CTRO.
--  3. app.reward_config_page_allowed: the configuration editor (manage) or viewer (library_view) of the company AND
--     the page's row (Full = manage, View only = library_view), for the pages and menus of these three areas.
--
-- The configuration editor predicate stays the outer limit (a company-scoped HR Admin is still refused on group-wide
-- items); the grid only narrows. Owner-owned function replacements and owner policies only; no purpose-owned object is
-- replaced (docs/SCALE-AND-RELEASE-RULES.md rule 9).
--
-- Part 4 closes the owner row-security and EXECUTE gaps the restricted-owner audit found in 5400-5580.
--
-- Rollback (manual, only if never relied upon): CREATE OR REPLACE the 5520 bodies of app.reward_role_default_level
-- and app.reward_actor_page_level and the 5580 body of app.reward_config_create_planned_unit, then DROP the functions
-- and policies created below.

CREATE OR REPLACE FUNCTION app.reward_role_default_level(wanted_role text,wanted_capability text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN r NOT IN('bu','bg','gr','ctro','ec','pbp','hr_admin','payroll') THEN 'none' ELSE CASE
  WHEN wanted_capability IN('access.manage','plans.manage','data.check','snapshot.refresh') THEN CASE WHEN r='gr' THEN 'full' ELSE 'none' END
  WHEN wanted_capability IN('salary.view','bonus.view','pat.manage') THEN CASE WHEN r IN('gr','ctro','hr_admin') THEN 'full' ELSE 'none' END
  WHEN wanted_capability IN('senior.manage','limits.view') THEN CASE r WHEN 'gr' THEN 'full' WHEN 'ctro' THEN 'view' WHEN 'ec' THEN 'view' ELSE 'none' END
  WHEN wanted_capability='restricted.view' THEN CASE WHEN r IN('gr','ctro','ec') THEN 'step' ELSE 'none' END
  WHEN wanted_capability='promotions.view' THEN CASE WHEN r='gr' THEN 'view' ELSE 'none' END
  WHEN wanted_capability IN('review.view','analytics.view','approvals.view','rules.view') THEN CASE WHEN r='hr_admin' THEN 'none' ELSE 'view' END
  WHEN wanted_capability='cases.decide' THEN CASE r WHEN 'bu' THEN 'step' WHEN 'gr' THEN 'full' ELSE 'none' END
  WHEN wanted_capability IN('figures.edit','notes.add','review.decide','review.batch') THEN CASE WHEN r='gr' THEN 'full' WHEN r IN('bu','bg','ctro','ec') THEN 'step' ELSE 'none' END
  WHEN wanted_capability='offcycle.raise' THEN CASE WHEN r='gr' THEN 'full' WHEN r IN('bu','bg') THEN 'step' ELSE 'none' END
  WHEN wanted_capability='offcycle.decide' THEN CASE WHEN r='gr' THEN 'full' WHEN r IN('bg','ctro','ec') THEN 'step' ELSE 'none' END
  ELSE 'none' END END
 FROM (SELECT CASE WHEN wanted_role='proxy_bg' THEN 'bg' ELSE wanted_role END AS r) x
$$;
-- The current principal's level for a configuration page: the widest level among the Rewards configuration roles they
-- hold (Group Rewards, CTRO, Executive Chairman and, for the areas 5580 opened to them, HR Admin). The configuration
-- predicates stay the outer limit.
CREATE OR REPLACE FUNCTION app.reward_actor_page_level(wanted_capability text) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT coalesce((SELECT l FROM (SELECT app.reward_role_level(r,wanted_capability) AS l FROM unnest(ARRAY['gr','ctro','ec','hr_admin']) r WHERE app.reward_actor_holds_role(r)) x
  ORDER BY app.reward_level_rank(l) DESC LIMIT 1),'none')
$$;
CREATE FUNCTION app.reward_config_page_allowed(wanted_company uuid,wanted_page text,wanted_operation text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT wanted_page IN('salary.view','bonus.view','pat.manage') AND wanted_operation IN('manage','library_view')
  AND CASE WHEN wanted_operation='manage' THEN app.reward_config_editor(wanted_company) ELSE app.reward_config_viewer(wanted_company) END
  AND app.reward_level_rank(app.reward_actor_page_level(wanted_page))>=CASE WHEN wanted_operation='manage' THEN 3 ELSE 1 END
$$;
REVOKE ALL ON FUNCTION app.reward_config_page_allowed(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_config_page_allowed(uuid,text,text) TO ai_hr_app;
--> statement-breakpoint

-- 4. Owner row security and EXECUTE for the owner-owned definers (13 November 2026 audit of 5400-5600, recorded in the
-- ADR). On an installation the migration owner owns these functions and the forced tables they read and is not a
-- superuser, so every forced table needs a policy that admits it and every callee needs its EXECUTE. CI databases are
-- built by a superuser, which bypasses both.
--
-- (a) Creating a review from a plan: app.reward_config_create_planned_unit (5580) called two functions owned by
--     ai_hr_reward_setup_reader that the owner may not execute (app.reward_architecture_for_source is granted only to
--     ai_hr_app, app.reward_snapshot_pay_change_kind to nobody), so it failed with "permission denied for function"
--     on every installation. Owner copies with the installed bodies replace those two calls; the only substitution in
--     the architecture copy is the owner org-tags copy (app.reward_config_source_org_tags, 5580) for the purpose-owned
--     app.reward_source_org_tags, which the owner may not execute either. The purpose functions stay byte-identical.
CREATE FUNCTION app.reward_config_architecture_for_source(wanted_unit uuid,wanted_employment uuid,wanted_position uuid,wanted_date date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE u reward_unit%ROWTYPE;r job_architecture_position_revision%ROWTYPE;catalogue jsonb;job_unit jsonb;job_class jsonb;at_day date;
BEGIN
 SELECT * INTO u FROM reward_unit WHERE tenant_id=app.current_tenant_id() AND id=wanted_unit AND deleted_at IS NULL;
 IF u.id IS NULL OR NOT app.reward_access(u.id) OR NOT EXISTS(SELECT 1 FROM app.reward_roles(u.id) seat WHERE seat='gr') OR NOT app.reward_setup_allowed(u.company_id,'manage') THEN RAISE EXCEPTION 'Rewards source metadata is outside your scope' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM employment e JOIN app_user actor ON actor.person_id=e.person_id AND actor.tenant_id=e.tenant_id WHERE e.id=wanted_employment AND e.tenant_id=u.tenant_id AND actor.id=app.current_user_id()) THEN RETURN NULL;END IF;
 at_day:=coalesce(wanted_date,u.snapshot_date);IF at_day>timezone('Asia/Kuala_Lumpur',now())::date THEN RAISE EXCEPTION 'Source metadata date cannot be in the future';END IF;
 IF NOT EXISTS(SELECT 1 FROM employment e JOIN assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id WHERE e.id=wanted_employment AND e.tenant_id=u.tenant_id AND app.reward_config_source_org_tags(e.id,at_day)->>'companyId'=u.company_id::text AND a.position_id=wanted_position AND(CASE WHEN app.reward_config_source_org_tags(e.id,at_day)->>'status'='legacy' THEN a.business_unit_id ELSE nullif(app.reward_config_source_org_tags(e.id,at_day)->>'businessUnitId','')::uuid END)=u.business_unit_id AND a.superseded_at IS NULL AND a.valid_from<=at_day AND(a.valid_to IS NULL OR a.valid_to>at_day)) THEN RETURN NULL;END IF;
 SELECT * INTO r FROM job_architecture_position_revision x WHERE x.tenant_id=u.tenant_id AND x.company_id=u.company_id AND x.position_id=wanted_position AND x.created_at<((at_day+1)::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur') ORDER BY x.revision DESC LIMIT 1;
 IF r.id IS NULL THEN RETURN NULL;END IF;
 SELECT c.catalogue INTO catalogue FROM job_architecture_catalogue_revision c WHERE c.tenant_id=r.tenant_id AND c.revision=r.catalogue_revision;
 SELECT value INTO job_unit FROM jsonb_array_elements(catalogue->'nodes') WHERE value->>'id'=r.mapping->>'jobUnitId';
 SELECT value INTO job_class FROM jsonb_array_elements(catalogue->'nodes') WHERE value->>'id'=job_unit->>'parentId' AND value->>'kind'='class';
 RETURN jsonb_build_object('positionId',wanted_position,'mappingRevision',r.revision,'catalogueRevision',r.catalogue_revision,'gradeId',r.mapping->>'gradeId','gradeCode',r.mapping->>'grade','jobUnitId',job_unit->>'id','jobUnitTitle',job_unit->>'title','classification',(WITH RECURSIVE path AS(SELECT job_unit AS node,0 AS depth UNION ALL SELECT parent.value,path.depth+1 FROM path CROSS JOIN LATERAL jsonb_array_elements(catalogue->'nodes')parent(value) WHERE parent.value->>'id'=path.node->>'parentId' AND path.depth<5)SELECT coalesce(jsonb_agg(node->>'title' ORDER BY depth DESC)FILTER(WHERE depth>0),'[]'::jsonb)FROM path));
END $$;
REVOKE ALL ON FUNCTION app.reward_config_architecture_for_source(uuid,uuid,uuid,date) FROM PUBLIC;
CREATE FUNCTION app.reward_config_snapshot_pay_change_kind(wanted_compensation uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT coalesce(kind.behaviour_kind,tag.movement_code)
 FROM reward_snapshot_comp_movement tag LEFT JOIN movement_event_type kind ON kind.tenant_id=tag.tenant_id AND kind.code=tag.movement_code
 WHERE tag.tenant_id=app.current_tenant_id() AND tag.compensation_id=wanted_compensation
$$;
REVOKE ALL ON FUNCTION app.reward_config_snapshot_pay_change_kind(uuid) FROM PUBLIC;
-- The forced tables those copies read, with the purpose reader's own predicates (2205).
CREATE POLICY reward_config_architecture_position ON public.job_architecture_position_revision FOR SELECT TO ai_hr_owner
 USING(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(company_id,'manage'));
CREATE POLICY reward_config_architecture_catalogue ON public.job_architecture_catalogue_revision FOR SELECT TO ai_hr_owner
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.job_architecture_position_revision r WHERE r.tenant_id=job_architecture_catalogue_revision.tenant_id
  AND r.catalogue_revision=job_architecture_catalogue_revision.revision AND app.reward_setup_allowed(r.company_id,'manage')));
CREATE POLICY reward_config_snapshot_pay_change ON public.reward_snapshot_comp_movement FOR SELECT TO ai_hr_owner
 USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM public.compensation c WHERE c.tenant_id=reward_snapshot_comp_movement.tenant_id AND c.id=compensation_id));
-- The creator with the two owner copies; every other line is the 5580 body.
CREATE OR REPLACE FUNCTION app.reward_config_create_planned_unit(wanted_version uuid,wanted_company uuid,wanted_business_unit uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
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
 INSERT INTO reward_entry(tenant_id,unit_id,employment_id,source,facts,recommendation) VALUES(t,unit,row.id,jsonb_build_object('employmentId',row.id,'assignmentId',row.assignment_id,'positionId',row.assignment_position_id,'personId',row.person_id,'compensationId',row.compensation_id,'employeeCode',coalesce(row.employee_code,row.id::text),'name',row.full_name,'grade',regexp_replace(coalesce(row.grade_code,''),'^JG[[:space:]]*','','i'),'gradeId',row.grade_id,'basicCents',coalesce(round(row.basic_salary*100),0),'currency',coalesce(row.comp_currency,'MYR'),'payMode',coalesce(row.pay_mode,'monthly'),'hiredOn',row.hired_on,'confirmedOn',row.confirmation_date,'notice',(row.tender_resignation_date IS NOT NULL AND row.tender_resignation_date<=p.snapshot_date) OR(row.resignation_date IS NOT NULL AND row.resignation_date<=p.snapshot_date),'lastPayChange',CASE WHEN row.pay_from>row.hired_on THEN row.pay_from ELSE NULL END,'confirmationPayChange',coalesce(row.pay_from=row.confirmation_date AND row.pay_from>row.hired_on,false),'performanceReviewId',row.review_id,'performanceRating',row.overall_rating,'architecture',app.reward_config_architecture_for_source(unit,row.id,row.assignment_position_id,p.snapshot_date),'payChanges',coalesce((SELECT jsonb_agg(jsonb_build_object('on',x.valid_from,'basicCents',round(x.basic_salary*100),'kind',app.reward_config_snapshot_pay_change_kind(x.id)) ORDER BY x.valid_from,x.id) FROM(SELECT c.*,lag(c.basic_salary)over(ORDER BY c.valid_from,c.id) AS prior_basic FROM compensation c WHERE c.employment_id=row.id AND c.tenant_id=t AND c.superseded_at IS NULL)x WHERE x.prior_basic IS NOT NULL AND x.basic_salary<>x.prior_basic AND x.valid_from>row.hired_on AND x.valid_from BETWEEN make_date(p.year,1,1) AND make_date(p.year+1,12,31)),'[]'::jsonb)),
 '{"talent":null,"performance":null,"confidentiality":"standard","seniorPlan":false,"erCase":false,"pipCase":false,"erDecision":"pending","pipDecision":"pending","caseReason":"","segment":"","branch":"","reviewed":false}'::jsonb,
 '{"meritBp":null,"promotionGrade":null,"promotionBp":null,"specialBp":null,"multiplierBp":null,"bonusCents":null,"lumpCents":null,"reason":"","currentRoleSummary":"","proposedRoleSummary":""}'::jsonb);
 END LOOP;
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(t,'reward-unit',unit,'reward-unit.approved-plan-admitted','user',actor,jsonb_build_object('planVersionId',wanted_version,'salaryVersionId',b->>'salaryVersionId','bonusVersionId',b->>'bonusVersionId','patVersionId',pat.id));
 PERFORM set_config('app.reward_config_creating','',true);
 RETURN unit;
END $$;
--> statement-breakpoint

-- (b) Change notices: app.reward_config_change_recipients (5580) lists Rewards setup-grant holders, but the owner saw
--     only its caller's own grants (2203 reward_setup_grant_read), so other holders silently dropped out of the
--     notices. Active grants of the current tenant; the function already gates its caller.
CREATE POLICY reward_setup_grant_config_owner ON public.reward_setup_grant FOR SELECT TO ai_hr_owner
 USING(tenant_id=app.current_tenant_id() AND active);
-- (c) "Used by" on a library: app.reward_config_library_used_by (5580) lists plan assignments for the companies the
--     caller views, but reward_plan_company admitted the owner only through the native library-view predicate, so a
--     CTRO or HR Admin editor saw an empty list.
CREATE POLICY reward_plan_company_config_owner ON public.reward_plan_company FOR SELECT TO ai_hr_owner
 USING(tenant_id=app.current_tenant_id() AND app.reward_config_viewer(company_id));
