-- Board release integration, 13 November 2026 (docs/adr/2026-11-12-rewards-direct-configuration.md): two loose ends of
-- 5580/5600. Owner-owned functions only; no existing migration and no purpose-owned object is changed
-- (docs/SCALE-AND-RELEASE-RULES.md rule 9).
--
-- 1. EXECUTE on the configuration predicates. 5580 granted app.reward_config_editor, app.reward_config_viewer,
--    app.reward_config_library_viewer and app.reward_config_editor_anywhere to PUBLIC, and app.reward_config_creating
--    kept its default PUBLIC EXECUTE. Each is now executable only by the roles that evaluate it (the function owner
--    keeps it as owner):
--    - app.reward_config_editor: the permissive policies on reward_library, reward_library_version and
--      reward_pat_version apply to every role, so every non-owner role that reads or writes those tables evaluates it:
--      ai_hr_app, ai_hr_reward_setup_reader (2204/2205 purpose reads) and ai_hr_reward_preparation_reader (3701 column
--      reads of reward_library and reward_library_version). Its other callers are owner definers or app-role
--      invokers (app.reward_config_change_visible, app.reward_config_page_allowed).
--    - app.reward_config_viewer, app.reward_config_library_viewer, app.reward_config_editor_anywhere: in no policy;
--      called by the application (setup-data.ts, config-change.ts, access-policy.ts) and owner definers: ai_hr_app.
--    - app.reward_config_creating: evaluated by the SECURITY INVOKER annual-admission guard
--      (app.reward_policy_binding_guard) under the role inserting an annual review: ai_hr_reward_setup_reader (the
--      purpose creators) and the migration owner (5580's creator); ai_hr_app reaches it too, so its refusal stays the
--      guard's own "Use approved Rewards annual admission" rather than a permission error. The flag cannot be forged:
--      it also requires the current role to hold the owner of app_user, which ai_hr_app does not, and the guard
--      evaluates it as the inserting role (test/rewards-config-grants-lock.test.ts).
--
-- 2. The review creator's company-year lock. app.reward_config_create_planned_unit (5580, re-created by 5600) hashed
--    the plan year from a subquery evaluated before any authority check; a caller whose plan this function cannot see
--    got a NULL key, and pg_advisory_xact_lock(NULL) takes no lock. The function now checks authority, reads the year
--    itself and refuses a plan it cannot see before taking that lock, then confirms the locked plan has that year. The
--    lock order (access configuration, plans, company-year, PAT) and every other line of the 5600 body are unchanged.
--
-- Rollback (manual, only if never relied upon): CREATE OR REPLACE the 5600 body of the creator, GRANT EXECUTE on the
-- four predicates TO PUBLIC and on app.reward_config_creating() TO PUBLIC.

REVOKE ALL ON FUNCTION app.reward_config_editor(uuid),app.reward_config_viewer(uuid),app.reward_config_library_viewer(),
 app.reward_config_editor_anywhere(),app.reward_config_creating() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_config_editor(uuid) TO ai_hr_app,ai_hr_reward_setup_reader,ai_hr_reward_preparation_reader;
GRANT EXECUTE ON FUNCTION app.reward_config_viewer(uuid),app.reward_config_library_viewer(),app.reward_config_editor_anywhere() TO ai_hr_app;
GRANT EXECUTE ON FUNCTION app.reward_config_creating() TO ai_hr_app,ai_hr_reward_setup_reader;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app.reward_config_create_planned_unit(wanted_version uuid,wanted_company uuid,wanted_business_unit uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();p reward_plan_setup%ROWTYPE;b jsonb;s jsonb;v jsonb;pat reward_pat_version%ROWTYPE;policy jsonb;cycle uuid;existing_cycle_name text;unit uuid:=gen_random_uuid();source jsonb;row record;overlap boolean;pending_names text;company_tags jsonb;plan_year integer;
BEGIN
 -- The same lock order as setupTenant and the installed 4100 entry point, ahead of the plan and company locks.
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':plans',2203));
 IF t IS NULL OR actor IS NULL OR NOT coalesce(app.reward_not_viewing_as(),false) OR NOT app.reward_setup_allowed(wanted_company,'manage') THEN RAISE EXCEPTION 'Group Rewards plan creation authority required' USING ERRCODE='42501';END IF;
 -- 5620: the company-year key's plan year is read here, by this function under its own row security, and a plan it
 -- cannot see is refused before that lock (5580/5600 hashed a NULL year, so no lock was taken at all).
 SELECT year INTO plan_year FROM reward_plan_setup WHERE tenant_id=t AND version_id=wanted_version AND state='approved';
 IF plan_year IS NULL THEN RAISE EXCEPTION 'Current approved plan and available legal employer required';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':company-year:'||wanted_company::text||':'||plan_year::text,2203));
 -- The annual-admission guard (app.reward_policy_binding_guard) admits this owner writer only inside this call.
 PERFORM set_config('app.reward_config_creating',txid_current()::text,true);
 SELECT * INTO p FROM reward_plan_setup WHERE tenant_id=t AND version_id=wanted_version AND state='approved';
 IF p.version_id IS NULL OR p.year IS DISTINCT FROM plan_year OR NOT app.reward_config_company_eligible(wanted_company,p.year) OR p.snapshot_date>timezone('Asia/Kuala_Lumpur',now())::date THEN RAISE EXCEPTION 'Current approved plan and available legal employer required';END IF;
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
