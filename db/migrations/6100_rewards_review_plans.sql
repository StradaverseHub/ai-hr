-- Board 0c0d8710: year/company ownership includes drafts; installed legacy versions remain immutable.
CREATE OR REPLACE FUNCTION app.reward_config_page_allowed(wanted_company uuid,wanted_page text,wanted_operation text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT wanted_page IN('salary.view','bonus.view','pat.manage','plans.manage') AND wanted_operation IN('manage','library_view')
 AND CASE WHEN wanted_page='plans.manage' AND wanted_operation='library_view' THEN
  (CASE WHEN wanted_company IS NULL THEN app.reward_config_editor_anywhere() ELSE app.reward_config_viewer(wanted_company) END OR app.reward_actor_holds_role('ec'))
 ELSE CASE WHEN wanted_operation='manage' THEN app.reward_config_editor(wanted_company) ELSE app.reward_config_viewer(wanted_company) END END
 AND app.reward_level_rank(app.reward_actor_page_level(wanted_page))>=CASE WHEN wanted_operation='manage' THEN 3 ELSE 1 END
$$;
CREATE TABLE reward_plan_year(
 tenant_id uuid NOT NULL REFERENCES tenant(id),year integer NOT NULL CHECK(year BETWEEN 2000 AND 2200),settings jsonb NOT NULL CHECK(jsonb_typeof(settings)='object'),
 revision integer NOT NULL DEFAULT 1,created_by uuid REFERENCES app_user(id),created_by_person_id uuid REFERENCES person(id),created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,year)
);
CREATE TABLE reward_plan_year_company(
 tenant_id uuid NOT NULL,year integer NOT NULL,company_id uuid NOT NULL,
 plan_version_id uuid,salary_version_id uuid,bonus_version_id uuid,plan_type text NOT NULL DEFAULT 'standard' CHECK(plan_type IN('standard','uploaded','no_awards')),
 reason text NOT NULL DEFAULT '',salary_source text NOT NULL DEFAULT 'none',bonus_source text NOT NULL DEFAULT 'none',salary_reviewed boolean NOT NULL DEFAULT false,bonus_reviewed boolean NOT NULL DEFAULT false,
 branch_acknowledged boolean NOT NULL DEFAULT false,revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,year,company_id),FOREIGN KEY(tenant_id,year) REFERENCES reward_plan_year(tenant_id,year),FOREIGN KEY(tenant_id,company_id) REFERENCES company(tenant_id,id),
 FOREIGN KEY(tenant_id,plan_version_id) REFERENCES reward_policy_group_version(tenant_id,id),FOREIGN KEY(tenant_id,salary_version_id) REFERENCES reward_library_version(tenant_id,id),FOREIGN KEY(tenant_id,bonus_version_id) REFERENCES reward_library_version(tenant_id,id),
 CHECK(plan_type<>'no_awards' OR length(btrim(reason))>=10),CHECK(salary_source IN('previous-year','business-unit','group-default','multiple-matches','none')),CHECK(bonus_source IN('previous-year','business-unit','group-default','multiple-matches','none'))
);
ALTER TABLE reward_plan_year ENABLE ROW LEVEL SECURITY;ALTER TABLE reward_plan_year FORCE ROW LEVEL SECURITY;
ALTER TABLE reward_plan_year_company ENABLE ROW LEVEL SECURITY;ALTER TABLE reward_plan_year_company FORCE ROW LEVEL SECURITY;
CREATE POLICY reward_plan_year_read ON reward_plan_year FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(NULL,'plans.manage','library_view'));
CREATE POLICY reward_plan_year_insert ON reward_plan_year FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(NULL,'plans.manage','manage') AND created_by=app.current_user_id());
CREATE POLICY reward_plan_year_company_read ON reward_plan_year_company FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(company_id,'plans.manage','library_view'));
CREATE POLICY reward_plan_year_company_write ON reward_plan_year_company FOR ALL USING(tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(company_id,'plans.manage','manage')) WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(company_id,'plans.manage','manage'));
GRANT SELECT,INSERT ON reward_plan_year TO ai_hr_app;
GRANT SELECT,INSERT,UPDATE ON reward_plan_year_company TO ai_hr_app;
--> statement-breakpoint
CREATE POLICY reward_year_backfill_exclusion ON reward_company_exclusion FOR SELECT TO ai_hr_owner USING(true);
CREATE POLICY reward_year_backfill_setup ON reward_plan_setup FOR SELECT TO ai_hr_owner USING(true);
CREATE POLICY reward_year_backfill_year ON reward_plan_year FOR INSERT TO ai_hr_owner WITH CHECK(true);
CREATE POLICY reward_year_backfill_company ON reward_plan_year_company FOR INSERT TO ai_hr_owner WITH CHECK(true);
-- Existing annual bindings are selected deterministically. No old source/version/review is modified.
INSERT INTO reward_plan_year(tenant_id,year,settings,created_by,created_by_person_id)
 SELECT DISTINCT ON(p.tenant_id,p.year) p.tenant_id,p.year,(v.policy-ARRAY['year'])||jsonb_build_object('snapshotDate',p.snapshot_date),p.created_by,p.created_by_person_id
 FROM reward_plan_setup p JOIN reward_policy_group_version v ON v.id=p.version_id AND v.tenant_id=p.tenant_id
 ORDER BY p.tenant_id,p.year,p.updated_at DESC,p.version_id DESC;
INSERT INTO reward_plan_year_company(tenant_id,year,company_id,plan_version_id,salary_version_id,bonus_version_id,salary_reviewed,bonus_reviewed,branch_acknowledged,plan_type,reason)
 SELECT DISTINCT ON(p.tenant_id,p.year,c.company_id) p.tenant_id,p.year,c.company_id,p.version_id,(b->>'salaryVersionId')::uuid,(b->>'bonusVersionId')::uuid,true,true,coalesce((b->>'branchAcknowledged')::boolean,false),coalesce(exclusion.award_type,'standard'),coalesce(exclusion.reason,'')
 FROM reward_plan_setup p CROSS JOIN LATERAL unnest(p.company_ids)c(company_id) CROSS JOIN LATERAL jsonb_array_elements(p.bindings)b LEFT JOIN reward_company_exclusion exclusion ON exclusion.tenant_id=p.tenant_id AND exclusion.company_id=c.company_id AND exclusion.year=p.year AND exclusion.ended_at IS NULL
 WHERE b->>'companyId'=c.company_id::text ORDER BY p.tenant_id,p.year,c.company_id,(p.state='approved') DESC,p.updated_at DESC,p.version_id DESC;
--> statement-breakpoint
DROP POLICY reward_year_backfill_exclusion ON reward_company_exclusion;
DROP POLICY reward_year_backfill_setup ON reward_plan_setup;
DROP POLICY reward_year_backfill_year ON reward_plan_year;
DROP POLICY reward_year_backfill_company ON reward_plan_year_company;
--> statement-breakpoint
-- Principal-protected set reader. Organisation mapping and headcount are each read once for all companies.
CREATE FUNCTION app.reward_review_plan_population(wanted_year integer,wanted_day date) RETURNS TABLE(company_id uuid,company_name text,business_unit_id uuid,business_unit_name text,headcount integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET jit=off AS $$
 WITH population AS MATERIALIZED(
 SELECT c.id,c.legal_name FROM company c
 LEFT JOIN company_registration_classification r ON r.tenant_id=c.tenant_id AND r.company_id=c.id
 LEFT JOIN reward_company_classification x ON x.tenant_id=c.tenant_id AND x.company_id=c.id
 WHERE c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL AND c.currency='MYR'
 AND coalesce(r.entity_kind,'legal_entity')='legal_entity' AND NOT coalesce(r.is_test_entity,false)
 AND coalesce(x.disposition,'visible')='visible' AND app.reward_config_page_allowed(c.id,'plans.manage','library_view')
 ),org AS MATERIALIZED(
 SELECT app.company_org_mapping_at(wanted_day) AS mapping,
 EXISTS(SELECT 1 FROM company_organisation_run r WHERE r.tenant_id=app.current_tenant_id() AND r.state='published' AND r.kind<>'retag' AND r.effective_on<=wanted_day) AS activated
 ),tags AS MATERIALIZED(
 SELECT p.id,p.legal_name,app.company_org_resolve(p.id,o.mapping,o.activated) AS tags FROM population p CROSS JOIN org o
 ),active_employments AS MATERIALIZED(
 SELECT e.id,e.company_id FROM employment e WHERE e.tenant_id=app.current_tenant_id() AND e.import_pending_attempt_id IS NULL AND e.hired_on<=timezone('Asia/Kuala_Lumpur',now())::date AND(e.terminated_on IS NULL OR e.terminated_on>timezone('Asia/Kuala_Lumpur',now())::date)
 ),assignments AS MATERIALIZED(
 SELECT DISTINCT ON(a.employment_id) a.employment_id,a.company_id FROM assignment a JOIN active_employments e ON e.id=a.employment_id WHERE a.tenant_id=app.current_tenant_id() AND a.superseded_at IS NULL AND a.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND(a.valid_to IS NULL OR a.valid_to>timezone('Asia/Kuala_Lumpur',now())::date) ORDER BY a.employment_id,a.valid_from DESC,a.id
 ),corrections AS MATERIALIZED(
 SELECT DISTINCT ON(ev.subject_employment_id)ev.subject_employment_id,nullif(ev.payload->'before'->>'companyId','')::uuid AS previous_company FROM domain_event ev JOIN active_employments e ON e.id=ev.subject_employment_id
 WHERE ev.tenant_id=app.current_tenant_id() AND ev.event_type='employment.information.corrected' AND ev.payload->>'effectiveOn'>timezone('Asia/Kuala_Lumpur',now())::date::text ORDER BY ev.subject_employment_id,ev.sequence
 ),counts AS MATERIALIZED(
 SELECT coalesce(c.previous_company,a.company_id,e.company_id) AS company_id,count(*)::integer AS n FROM active_employments e LEFT JOIN assignments a ON a.employment_id=e.id LEFT JOIN corrections c ON c.subject_employment_id=e.id GROUP BY coalesce(c.previous_company,a.company_id,e.company_id)
 ) SELECT t.id,t.legal_name,nullif(t.tags->>'businessUnitId','')::uuid,b.name,coalesce(c.n,0)
 FROM tags t LEFT JOIN business_unit b ON b.tenant_id=app.current_tenant_id() AND b.id=nullif(t.tags->>'businessUnitId','')::uuid
 LEFT JOIN counts c ON c.company_id=t.id WHERE t.tags->>'status'='ready'
$$;
REVOKE ALL ON FUNCTION app.reward_review_plan_population(integer,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_review_plan_population(integer,date) TO ai_hr_app;
CREATE FUNCTION app.reward_review_plan_rows(wanted_year integer) RETURNS TABLE("companyId" uuid,company text,"businessUnitId" uuid,"businessUnit" text,revision integer,"planVersionId" uuid,"planType" text,reason text,"salaryVersionId" uuid,"bonusVersionId" uuid,"salarySuggestion" jsonb,"bonusSuggestion" jsonb,headcount integer,"patEntered" boolean,status text,"canEdit" boolean,"reviewUnitId" uuid,"branchAcknowledged" boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET jit=off AS $$
 WITH year_settings AS MATERIALIZED(SELECT settings FROM reward_plan_year WHERE tenant_id=app.current_tenant_id() AND year=wanted_year),
 pat AS MATERIALIZED(SELECT DISTINCT ON(company_id) company_id,inputs FROM reward_pat_version WHERE tenant_id=app.current_tenant_id() AND year=wanted_year AND state='confirmed' ORDER BY company_id,revision DESC),
 rows AS MATERIALIZED(
 SELECT p.company_id AS "companyId",p.company_name AS company,p.business_unit_id AS "businessUnitId",p.business_unit_name AS "businessUnit",coalesce(c.revision,0) AS revision,
 c.plan_version_id AS "planVersionId",coalesce(c.plan_type,exclusion.award_type,'standard') AS "planType",coalesce(c.reason,exclusion.reason,'') AS reason,c.salary_version_id AS "salaryVersionId",c.bonus_version_id AS "bonusVersionId",
 jsonb_build_object('versionId',c.salary_version_id,'source',coalesce(c.salary_source,'none'),'reviewed',coalesce(c.salary_reviewed,false)) AS "salarySuggestion",
 jsonb_build_object('versionId',c.bonus_version_id,'source',coalesce(c.bonus_source,'none'),'reviewed',coalesce(c.bonus_reviewed,false)) AS "bonusSuggestion",
 p.headcount,coalesce(((pat.inputs->>'targetCents')::numeric>0 AND coalesce(pat.inputs->>'actualCents',pat.inputs->>'forecastCents') IS NOT NULL),false) AS "patEntered",
 CASE WHEN review.unit_id IS NOT NULL THEN 'reviews-created' WHEN c.plan_type<>'no_awards' AND c.salary_version_id IS NOT NULL AND c.bonus_version_id IS NOT NULL AND c.salary_reviewed AND c.bonus_reviewed AND (pat.inputs->>'targetCents')::numeric>0 AND coalesce(pat.inputs->>'actualCents',pat.inputs->>'forecastCents') IS NOT NULL AND EXISTS(SELECT 1 FROM reward_library_version v JOIN reward_library l ON l.id=v.library_id AND l.tenant_id=v.tenant_id WHERE v.tenant_id=c.tenant_id AND v.id=c.salary_version_id AND v.state='confirmed' AND l.kind='salary' AND l.year=wanted_year) AND EXISTS(SELECT 1 FROM reward_library_version v JOIN reward_library l ON l.id=v.library_id AND l.tenant_id=v.tenant_id WHERE v.tenant_id=c.tenant_id AND v.id=c.bonus_version_id AND v.state='confirmed' AND l.kind='bonus' AND l.year=wanted_year AND(v.data->>'type'<>'branch' OR c.branch_acknowledged)) THEN 'ready' ELSE 'draft' END AS status,
 app.reward_config_page_allowed(p.company_id,'plans.manage','manage') AS "canEdit",review.unit_id AS "reviewUnitId",coalesce(c.branch_acknowledged,false) AS "branchAcknowledged"
 FROM app.reward_review_plan_population(wanted_year,coalesce((SELECT (settings->>'snapshotDate')::date FROM year_settings),timezone('Asia/Kuala_Lumpur',now())::date))p
 LEFT JOIN reward_plan_year_company c ON c.tenant_id=app.current_tenant_id() AND c.year=wanted_year AND c.company_id=p.company_id
 LEFT JOIN reward_company_exclusion exclusion ON exclusion.tenant_id=app.current_tenant_id() AND exclusion.company_id=p.company_id AND exclusion.year=wanted_year AND exclusion.ended_at IS NULL
 LEFT JOIN pat ON pat.company_id=p.company_id LEFT JOIN reward_company_year_review review ON review.tenant_id=app.current_tenant_id() AND review.year=wanted_year AND review.company_id=p.company_id
 ) SELECT * FROM rows
$$;
REVOKE ALL ON FUNCTION app.reward_review_plan_rows(integer) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_review_plan_rows(integer) TO ai_hr_app;
CREATE FUNCTION app.reward_review_plan_grid(wanted_year integer,wanted_filter jsonb,wanted_page integer) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET jit=off AS $$
 WITH rows AS MATERIALIZED(SELECT * FROM app.reward_review_plan_rows(wanted_year)),filtered AS MATERIALIZED(
 SELECT * FROM rows WHERE (wanted_filter->>'businessUnitId' IS NULL OR "businessUnitId"::text=wanted_filter->>'businessUnitId')
 AND(wanted_filter->>'planType' IS NULL OR "planType"=wanted_filter->>'planType')
 AND(NOT coalesce((wanted_filter->>'missingSalary')::boolean,false) OR "salaryVersionId" IS NULL)
 AND(NOT coalesce((wanted_filter->>'missingBonus')::boolean,false) OR "bonusVersionId" IS NULL)
 AND(NOT coalesce((wanted_filter->>'unreviewed')::boolean,false) OR NOT("salarySuggestion"->>'reviewed')::boolean OR NOT("bonusSuggestion"->>'reviewed')::boolean)
 ),paged AS(SELECT * FROM filtered ORDER BY coalesce("businessUnit",''),company,"companyId" LIMIT 100 OFFSET (greatest(1,least(wanted_page,10000))-1)*100)
 SELECT jsonb_build_object('rows',coalesce((SELECT jsonb_agg(to_jsonb(paged) ORDER BY coalesce("businessUnit",''),company,"companyId") FROM paged),'[]'::jsonb),
 'coverage',(SELECT jsonb_build_object('total',count(*),'ready',count(*) FILTER(WHERE status='ready'),'missingSalary',count(*) FILTER(WHERE "salaryVersionId" IS NULL),'missingBonus',count(*) FILTER(WHERE "bonusVersionId" IS NULL),'missingPat',count(*) FILTER(WHERE NOT coalesce("patEntered",false)),'unreviewed',count(*) FILTER(WHERE NOT("salarySuggestion"->>'reviewed')::boolean OR NOT("bonusSuggestion"->>'reviewed')::boolean),'reviewsCreated',count(*) FILTER(WHERE status='reviews-created')) FROM filtered),
 'hasMore',(SELECT count(*)>wanted_page*100 FROM filtered)) WHERE app.reward_config_page_allowed(NULL,'plans.manage','library_view')
$$;
REVOKE ALL ON FUNCTION app.reward_review_plan_grid(integer,jsonb,integer) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_review_plan_grid(integer,jsonb,integer) TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE app.reward_review_plan_write_lease(tenant_id uuid NOT NULL REFERENCES public.tenant(id),xact_id bigint NOT NULL,PRIMARY KEY(tenant_id,xact_id));
REVOKE ALL ON app.reward_review_plan_write_lease FROM PUBLIC,ai_hr_app;
ALTER TABLE app.reward_review_plan_write_lease ENABLE ROW LEVEL SECURITY;ALTER TABLE app.reward_review_plan_write_lease FORCE ROW LEVEL SECURITY;
CREATE POLICY reward_review_plan_lease_owner ON app.reward_review_plan_write_lease TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE FUNCTION app.reward_review_plan_writing() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.reward_review_plan_write_lease WHERE tenant_id=app.current_tenant_id() AND xact_id=txid_current())
$$;
REVOKE ALL ON FUNCTION app.reward_review_plan_writing() FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_review_plan_writing() TO ai_hr_app;
-- Owner policies still check the real principal. EC receives metadata, never editing authority.
CREATE POLICY reward_year_plan_setup_owner ON reward_plan_setup FOR ALL TO ai_hr_owner
 USING(tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM unnest(company_ids)c WHERE NOT app.reward_config_page_allowed(c,'plans.manage','library_view')))
 WITH CHECK(tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM unnest(company_ids)c WHERE NOT app.reward_config_page_allowed(c,'plans.manage','manage')));
CREATE POLICY reward_year_plan_company_owner ON reward_plan_company FOR ALL TO ai_hr_owner
 USING(tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(company_id,'plans.manage','library_view')) WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(company_id,'plans.manage','manage'));
CREATE POLICY reward_year_company_review_owner ON reward_company_year_review FOR SELECT TO ai_hr_owner USING(tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(company_id,'plans.manage','library_view'));
CREATE POLICY reward_year_company_owner ON company FOR SELECT TO ai_hr_owner USING(tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(id,'plans.manage','library_view'));
CREATE POLICY reward_year_employment_owner ON employment FOR SELECT TO ai_hr_owner USING(tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(company_id,'plans.manage','library_view'));
CREATE POLICY reward_year_business_unit_owner ON business_unit FOR SELECT TO ai_hr_owner USING(tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(NULL,'plans.manage','library_view'));
CREATE POLICY reward_year_pat_owner ON reward_pat_version FOR SELECT TO ai_hr_owner USING(tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(company_id,'plans.manage','library_view'));
CREATE POLICY reward_year_library_owner ON reward_library FOR SELECT TO ai_hr_owner USING(tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(NULL,'plans.manage','library_view'));
CREATE POLICY reward_year_library_version_owner ON reward_library_version FOR SELECT TO ai_hr_owner USING(tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(NULL,'plans.manage','library_view'));
CREATE FUNCTION app.reward_review_plan_save(p_year integer,p_settings jsonb,p_policy jsonb,p_edits jsonb,p_new_year boolean,p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();actor_person uuid;prepared jsonb;result jsonb;
BEGIN
 IF t IS NULL OR actor IS NULL OR NOT app.reward_not_viewing_as() OR p_year NOT BETWEEN 2000 AND 2200 OR length(btrim(p_reason)) NOT BETWEEN 10 AND 4000
 OR jsonb_typeof(p_edits)<>'array' OR jsonb_array_length(p_edits)>500 OR p_policy->>'year' IS DISTINCT FROM p_year::text THEN RAISE EXCEPTION 'Invalid Review Plans command' USING ERRCODE='22023';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':review-plan-year:'||p_year,2203));
 IF NOT p_new_year THEN
  SELECT settings,(settings-'snapshotDate')||jsonb_build_object('year',year) INTO p_settings,p_policy FROM reward_plan_year WHERE tenant_id=t AND year=p_year;
  IF p_settings IS NULL THEN RAISE EXCEPTION 'Create the reward year first';END IF;
 END IF;
 SELECT person_id INTO actor_person FROM app_user WHERE tenant_id=t AND id=actor AND archived_at IS NULL AND NOT app.login_blocked(id);
 IF actor_person IS NULL THEN RAISE EXCEPTION 'A person-backed configuration account is required' USING ERRCODE='42501';END IF;
 IF p_new_year THEN
  IF NOT app.reward_config_page_allowed(NULL,'plans.manage','manage') THEN RAISE EXCEPTION 'Whole-group authority required for a reward year' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM reward_plan_year WHERE tenant_id=t AND year=p_year) THEN RAISE EXCEPTION 'Reward year already exists' USING ERRCODE='23505';END IF;
  IF EXISTS(SELECT company_id FROM app.reward_review_plan_population(p_year,(p_settings->>'snapshotDate')::date) EXCEPT SELECT (e->>'companyId')::uuid FROM jsonb_array_elements(p_edits)e) THEN RAISE EXCEPTION 'Reward year must cover every eligible company' USING ERRCODE='40001';END IF;
  INSERT INTO reward_plan_year(tenant_id,year,settings,created_by,created_by_person_id)VALUES(t,p_year,(p_policy-'year')||p_settings,actor,actor_person);
 ELSE
  IF NOT EXISTS(SELECT 1 FROM reward_plan_year WHERE tenant_id=t AND year=p_year) THEN RAISE EXCEPTION 'Create the reward year first';END IF;
 END IF;
 IF(SELECT count(DISTINCT e->>'companyId') FROM jsonb_array_elements(p_edits)e)<>jsonb_array_length(p_edits)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_edits)e LEFT JOIN reward_plan_year_company c ON c.tenant_id=t AND c.year=p_year AND c.company_id=(e->>'companyId')::uuid
 WHERE NOT app.reward_config_page_allowed((e->>'companyId')::uuid,'plans.manage','manage') OR coalesce(c.revision,0)<>(e->>'expectedRevision')::integer
 OR e->>'planType' NOT IN('standard','uploaded','no_awards') OR e->>'planType'='no_awards' AND length(btrim(e->>'reason'))<10
 OR NOT EXISTS(SELECT 1 FROM app.reward_review_plan_population(p_year,(p_settings->>'snapshotDate')::date)p WHERE p.company_id=(e->>'companyId')::uuid)) THEN RAISE EXCEPTION 'Review Plans changed or are outside your scope' USING ERRCODE='40001';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_edits)e CROSS JOIN LATERAL(VALUES('salary',e->>'salaryVersionId'),('bonus',e->>'bonusVersionId'))choice(kind,id)
 WHERE choice.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM reward_library_version v JOIN reward_library l ON l.tenant_id=v.tenant_id AND l.id=v.library_id
 WHERE v.tenant_id=t AND v.id=choice.id::uuid AND v.state='confirmed' AND l.kind=choice.kind AND l.year=p_year AND(choice.kind<>'bonus' OR v.data->>'type'<>'branch' OR(e->>'branchAcknowledged')::boolean))) THEN RAISE EXCEPTION 'Choose active libraries for this year and confirm branch factors' USING ERRCODE='22023';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_edits)e JOIN reward_company_year_review r ON r.tenant_id=t AND r.year=p_year AND r.company_id=(e->>'companyId')::uuid
 JOIN reward_unit u ON u.tenant_id=t AND u.id=r.unit_id JOIN reward_plan_year_company c ON c.tenant_id=t AND c.year=p_year AND c.company_id=r.company_id
 WHERE u.status IN('approved','posted','withdrawn','rejected') AND (c.salary_version_id IS DISTINCT FROM (e->>'salaryVersionId')::uuid OR c.bonus_version_id IS DISTINCT FROM(e->>'bonusVersionId')::uuid OR c.plan_type IS DISTINCT FROM e->>'planType')) THEN RAISE EXCEPTION 'Final approved reviews are locked' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_edits)e JOIN reward_company_year_review r ON r.tenant_id=t AND r.year=p_year AND r.company_id=(e->>'companyId')::uuid JOIN reward_plan_year_company c ON c.tenant_id=r.tenant_id AND c.year=r.year AND c.company_id=r.company_id
 WHERE c.plan_type IS DISTINCT FROM e->>'planType' OR e->>'salaryVersionId' IS NULL OR e->>'bonusVersionId' IS NULL) THEN RAISE EXCEPTION 'An existing review needs its current plan type and both library choices';END IF;
 -- One set generates identities. Subsequent statements insert complete immutable versions, never edit old ones.
 SELECT coalesce(jsonb_agg(e||jsonb_build_object('groupId',CASE WHEN cardinality(old.company_ids)=1 THEN old.group_id ELSE gen_random_uuid() END,'versionId',gen_random_uuid(),'previousVersionId',c.plan_version_id,'businessUnitId',p.business_unit_id,'name',left('Review plan '||p_year||' · '||p.company_id::text,100),
 'nextRevision',CASE WHEN cardinality(old.company_ids)=1 THEN g.revision+1 ELSE 1 END,'newGroup',coalesce(cardinality(old.company_ids)<>1,true),
 'ready',e->>'planType'<>'no_awards' AND e->>'salaryVersionId' IS NOT NULL AND e->>'bonusVersionId' IS NOT NULL AND(e->>'salaryReviewed')::boolean AND(e->>'bonusReviewed')::boolean AND EXISTS(SELECT 1 FROM reward_pat_version pat WHERE pat.tenant_id=t AND pat.year=p_year AND pat.company_id=p.company_id AND pat.state='confirmed' AND (pat.inputs->>'targetCents')::numeric>0 AND coalesce(pat.inputs->>'actualCents',pat.inputs->>'forecastCents') IS NOT NULL)
 )),'[]'::jsonb) INTO prepared FROM jsonb_array_elements(p_edits)e
 JOIN app.reward_review_plan_population(p_year,(p_settings->>'snapshotDate')::date)p ON p.company_id=(e->>'companyId')::uuid
 LEFT JOIN reward_plan_year_company c ON c.tenant_id=t AND c.year=p_year AND c.company_id=p.company_id
 LEFT JOIN reward_plan_setup old ON old.tenant_id=t AND old.version_id=c.plan_version_id LEFT JOIN reward_policy_group g ON g.tenant_id=t AND g.id=old.group_id;
 INSERT INTO app.reward_review_plan_write_lease VALUES(t,txid_current()) ON CONFLICT DO NOTHING;
 INSERT INTO reward_policy_group(id,tenant_id,name,revision,current_version_id,created_by)
 SELECT(e->>'groupId')::uuid,t,e->>'name',(e->>'nextRevision')::integer,(e->>'versionId')::uuid,actor FROM jsonb_array_elements(prepared)e WHERE(e->>'newGroup')::boolean;
 INSERT INTO reward_policy_group_version(id,tenant_id,group_id,revision,name,policy,policy_digest,created_by)
 SELECT(e->>'versionId')::uuid,t,(e->>'groupId')::uuid,(e->>'nextRevision')::integer,e->>'name',p_policy,encode(sha256(convert_to(p_policy::text,'UTF8')),'hex'),actor FROM jsonb_array_elements(prepared)e;
 INSERT INTO reward_policy_group_target(tenant_id,version_id,company_id,business_unit_id)
 SELECT t,(e->>'versionId')::uuid,(e->>'companyId')::uuid,(e->>'businessUnitId')::uuid FROM jsonb_array_elements(prepared)e;
 UPDATE reward_policy_group g SET current_version_id=(e->>'versionId')::uuid,revision=(e->>'nextRevision')::integer FROM jsonb_array_elements(prepared)e WHERE g.tenant_id=t AND g.id=(e->>'groupId')::uuid AND NOT(e->>'newGroup')::boolean;
 INSERT INTO reward_plan_setup(tenant_id,version_id,group_id,year,company_ids,cycle_name,snapshot_date,bindings,state,created_by,created_by_person_id,contributor_ids,contributor_person_ids,previous_plan_version_id,approved_by,approved_by_person_id,approved_at,reason)
 SELECT t,(e->>'versionId')::uuid,(e->>'groupId')::uuid,p_year,ARRAY[(e->>'companyId')::uuid],'Rewards '||p_year,(p_settings->>'snapshotDate')::date,
 jsonb_build_array(jsonb_build_object('companyId',e->>'companyId','businessUnitId',e->>'businessUnitId','salaryVersionId',e->>'salaryVersionId','bonusVersionId',e->>'bonusVersionId','branchAcknowledged',(e->>'branchAcknowledged')::boolean)),
 CASE WHEN(e->>'ready')::boolean THEN 'approved' ELSE 'draft' END,actor,actor_person,ARRAY[actor],ARRAY[actor_person],(e->>'previousVersionId')::uuid,
 CASE WHEN(e->>'ready')::boolean THEN actor END,CASE WHEN(e->>'ready')::boolean THEN actor_person END,CASE WHEN(e->>'ready')::boolean THEN now() END,p_reason FROM jsonb_array_elements(prepared)e;
 INSERT INTO reward_plan_year_company(tenant_id,year,company_id,plan_version_id,salary_version_id,bonus_version_id,plan_type,reason,salary_reviewed,bonus_reviewed,branch_acknowledged,salary_source,bonus_source)
 SELECT t,p_year,(e->>'companyId')::uuid,(e->>'versionId')::uuid,(e->>'salaryVersionId')::uuid,(e->>'bonusVersionId')::uuid,e->>'planType',coalesce(e->>'reason',''),(e->>'salaryReviewed')::boolean,(e->>'bonusReviewed')::boolean,(e->>'branchAcknowledged')::boolean,coalesce(e->>'salarySource','none'),coalesce(e->>'bonusSource','none') FROM jsonb_array_elements(prepared)e
 ON CONFLICT(tenant_id,year,company_id) DO UPDATE SET plan_version_id=excluded.plan_version_id,salary_version_id=excluded.salary_version_id,bonus_version_id=excluded.bonus_version_id,plan_type=excluded.plan_type,reason=excluded.reason,salary_reviewed=excluded.salary_reviewed,bonus_reviewed=excluded.bonus_reviewed,branch_acknowledged=excluded.branch_acknowledged,revision=reward_plan_year_company.revision+1,updated_at=now();
 INSERT INTO reward_plan_company(tenant_id,company_id,year,plan_version_id,salary_version_id,bonus_version_id)
 SELECT t,(e->>'companyId')::uuid,p_year,(e->>'versionId')::uuid,(e->>'salaryVersionId')::uuid,(e->>'bonusVersionId')::uuid FROM jsonb_array_elements(prepared)e WHERE(e->>'ready')::boolean
 ON CONFLICT(tenant_id,company_id,year) DO UPDATE SET plan_version_id=excluded.plan_version_id,salary_version_id=excluded.salary_version_id,bonus_version_id=excluded.bonus_version_id;
 UPDATE reward_company_exclusion old SET ended_at=now(),ended_by=actor,end_reason=left(p_reason,2000)
 FROM jsonb_array_elements(prepared)e WHERE old.tenant_id=t AND old.year=p_year AND old.company_id=(e->>'companyId')::uuid AND old.ended_at IS NULL
 AND(e->>'planType'='standard' OR old.award_type IS DISTINCT FROM e->>'planType');
 INSERT INTO reward_company_exclusion(tenant_id,company_id,year,reason,created_by,award_type)
 SELECT t,(e->>'companyId')::uuid,p_year,left(CASE WHEN length(btrim(coalesce(e->>'reason','')))>=10 THEN e->>'reason' ELSE p_reason END,2000),actor,e->>'planType'
 FROM jsonb_array_elements(prepared)e WHERE e->>'planType'<>'standard' AND NOT EXISTS(SELECT 1 FROM reward_company_exclusion old WHERE old.tenant_id=t AND old.year=p_year AND old.company_id=(e->>'companyId')::uuid AND old.ended_at IS NULL AND old.award_type=e->>'planType');
 DELETE FROM app.reward_review_plan_write_lease WHERE tenant_id=t AND xact_id=txid_current();
 RETURN prepared;
END $$;
REVOKE ALL ON FUNCTION app.reward_review_plan_save(integer,jsonb,jsonb,jsonb,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_review_plan_save(integer,jsonb,jsonb,jsonb,boolean,text) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.reward_review_plan_links() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF TG_TABLE_NAME='reward_plan_setup' THEN
  IF NOT EXISTS(SELECT 1 FROM reward_policy_group g WHERE g.tenant_id=NEW.tenant_id AND g.id=NEW.group_id AND g.current_version_id=NEW.version_id) THEN RAISE EXCEPTION 'The current shared configuration changed' USING ERRCODE='40001';END IF;
  IF NOT EXISTS(SELECT 1 FROM reward_policy_group_version v WHERE v.id=NEW.version_id AND v.tenant_id=NEW.tenant_id AND v.group_id=NEW.group_id AND (v.policy->>'year')::integer=NEW.year AND v.created_by=ANY(NEW.contributor_ids)) THEN RAISE EXCEPTION 'Plan must retain its exact source and all source contributors';END IF;
  IF (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(NEW.company_ids)x) IS DISTINCT FROM (SELECT array_agg(DISTINCT x.company_id ORDER BY x.company_id) FROM reward_policy_group_target x WHERE x.version_id=NEW.version_id AND x.tenant_id=NEW.tenant_id) OR jsonb_array_length(NEW.bindings)<>cardinality(NEW.company_ids) THEN RAISE EXCEPTION 'Plan company set must match its shared source';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.bindings)b WHERE NOT EXISTS(SELECT 1 FROM reward_policy_group_target x WHERE x.tenant_id=NEW.tenant_id AND x.version_id=NEW.version_id AND x.company_id=(b->>'companyId')::uuid AND x.business_unit_id=(b->>'businessUnitId')::uuid) OR NEW.state='approved' AND NOT EXISTS(SELECT 1 FROM reward_library_version v JOIN reward_library l ON l.id=v.library_id AND l.tenant_id=v.tenant_id WHERE v.id=(b->>'salaryVersionId')::uuid AND v.tenant_id=NEW.tenant_id AND v.state='confirmed' AND l.kind='salary' AND l.year=NEW.year) OR NEW.state='approved' AND NOT EXISTS(SELECT 1 FROM reward_library_version v JOIN reward_library l ON l.id=v.library_id AND l.tenant_id=v.tenant_id WHERE v.id=(b->>'bonusVersionId')::uuid AND v.tenant_id=NEW.tenant_id AND v.state='confirmed' AND l.kind='bonus' AND l.year=NEW.year AND(v.data->>'type'<>'branch' OR b->>'branchAcknowledged'='true'))) THEN RAISE EXCEPTION 'Plan requires exact shared targets and confirmed matching libraries';END IF;
  IF (SELECT count(DISTINCT b->>'companyId') FROM jsonb_array_elements(NEW.bindings)b)<>cardinality(NEW.company_ids) THEN RAISE EXCEPTION 'Each plan company has one binding';END IF;
 ELSIF TG_TABLE_NAME='reward_plan_company' THEN
  IF TG_OP='UPDATE' AND EXISTS(SELECT 1 FROM reward_plan_setup previous_plan JOIN reward_plan_setup next_plan ON next_plan.tenant_id=previous_plan.tenant_id LEFT JOIN reward_plan_setup lineage ON lineage.version_id=next_plan.previous_plan_version_id AND lineage.tenant_id=next_plan.tenant_id WHERE previous_plan.tenant_id=NEW.tenant_id AND previous_plan.version_id=OLD.plan_version_id AND next_plan.version_id=NEW.plan_version_id AND previous_plan.group_id<>next_plan.group_id AND(lineage.group_id IS DISTINCT FROM previous_plan.group_id OR NOT NEW.company_id=ANY(lineage.company_ids))) THEN RAISE EXCEPTION 'A company-year assignment can move only through an independently checked draft split';END IF;
  IF NOT EXISTS(SELECT 1 FROM reward_plan_setup p WHERE p.tenant_id=NEW.tenant_id AND p.version_id=NEW.plan_version_id AND p.state='approved' AND p.year=NEW.year AND NEW.company_id=ANY(p.company_ids) AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.bindings)b WHERE b->>'companyId'=NEW.company_id::text AND b->>'salaryVersionId'=NEW.salary_version_id::text AND b->>'bonusVersionId'=NEW.bonus_version_id::text)) THEN RAISE EXCEPTION 'Company assignment must match an independently approved plan';END IF;
 ELSIF TG_TABLE_NAME='reward_company_year_review' THEN
  IF NOT EXISTS(SELECT 1 FROM reward_unit u JOIN reward_cycle c ON c.id=u.cycle_id AND c.tenant_id=u.tenant_id WHERE u.id=NEW.unit_id AND u.tenant_id=NEW.tenant_id AND u.company_id=NEW.company_id AND c.year=NEW.year AND u.kind='annual') THEN RAISE EXCEPTION 'Review admission must match actual company and reward year';END IF;
 ELSIF TG_TABLE_NAME='reward_unit_setup' THEN
  IF NOT EXISTS(SELECT 1 FROM reward_unit u JOIN reward_plan_setup p ON p.version_id=NEW.plan_version_id AND p.tenant_id=u.tenant_id JOIN reward_pat_version v ON v.id=NEW.pat_version_id AND v.tenant_id=u.tenant_id WHERE u.id=NEW.unit_id AND u.tenant_id=NEW.tenant_id AND p.state='approved' AND v.state='confirmed' AND v.company_id=u.company_id AND v.year=p.year AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.bindings)b WHERE b->>'companyId'=u.company_id::text AND b->>'businessUnitId'=u.business_unit_id::text AND b->>'salaryVersionId'=NEW.salary_version_id::text AND b->>'bonusVersionId'=NEW.bonus_version_id::text)) THEN RAISE EXCEPTION 'Review setup must bind approved plan, libraries and confirmed company PAT';END IF;
  IF TG_OP='UPDATE' AND NOT app.reward_review_plan_writing() AND(NEW.unit_id<>OLD.unit_id OR NEW.tenant_id<>OLD.tenant_id OR NEW.plan_version_id<>OLD.plan_version_id OR NEW.salary_version_id<>OLD.salary_version_id OR NEW.bonus_version_id<>OLD.bonus_version_id) THEN RAISE EXCEPTION 'Consumed plan and library versions are immutable';END IF;
 END IF;RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION app.reward_review_plan_links() FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_review_plan_links() TO ai_hr_app;
DROP TRIGGER reward_plan_setup_links ON reward_plan_setup;CREATE TRIGGER reward_plan_setup_links BEFORE INSERT OR UPDATE ON reward_plan_setup FOR EACH ROW EXECUTE FUNCTION app.reward_review_plan_links();
DROP TRIGGER reward_plan_company_links ON reward_plan_company;CREATE TRIGGER reward_plan_company_links BEFORE INSERT OR UPDATE ON reward_plan_company FOR EACH ROW EXECUTE FUNCTION app.reward_review_plan_links();
DROP TRIGGER reward_unit_setup_links ON reward_unit_setup;CREATE TRIGGER reward_unit_setup_links BEFORE INSERT OR UPDATE ON reward_unit_setup FOR EACH ROW EXECUTE FUNCTION app.reward_review_plan_links();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.reward_role_default_level(wanted_role text,wanted_capability text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN r NOT IN('bu','bg','gr','ctro','ec','pbp','hr_admin','payroll') THEN 'none' ELSE CASE
  WHEN wanted_capability IN('access.manage','data.check','snapshot.refresh') THEN CASE WHEN r='gr' THEN 'full' ELSE 'none' END
  WHEN wanted_capability='plans.manage' THEN CASE WHEN r IN('gr','ctro','hr_admin') THEN 'full' WHEN r='ec' THEN 'view' ELSE 'none' END
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
--> statement-breakpoint
CREATE FUNCTION app.reward_review_plan_metadata(wanted_year integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT jsonb_build_object('years',coalesce((SELECT jsonb_agg(year ORDER BY year DESC) FROM reward_plan_year WHERE tenant_id=app.current_tenant_id()),'[]'::jsonb),
 'settings',(SELECT settings FROM reward_plan_year WHERE tenant_id=app.current_tenant_id() AND year=wanted_year),
 'previous',(SELECT jsonb_build_object('year',year,'settings',settings) FROM reward_plan_year WHERE tenant_id=app.current_tenant_id() AND year<wanted_year ORDER BY year DESC LIMIT 1),
 'libraries',coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'libraryId',l.id,'kind',l.kind,'name',l.name,'version',v.revision,'type',CASE WHEN l.kind='bonus' THEN v.data->>'type' END,'bonusType',CASE WHEN l.kind='bonus' THEN v.data->>'type' END,'tags',l.tags,'groupDefault',l.group_default,'previousLibraryId',l.previous_library_id,'year',l.year) ORDER BY l.kind,l.name,v.revision DESC)
 FROM reward_library l JOIN reward_library_version v ON v.tenant_id=l.tenant_id AND v.library_id=l.id WHERE l.tenant_id=app.current_tenant_id() AND l.year=wanted_year AND v.state='confirmed'),'[]'::jsonb),
 'businessUnits',coalesce((SELECT jsonb_agg(jsonb_build_object('id',business_unit_id,'name',business_unit_name) ORDER BY business_unit_name,business_unit_id) FROM(SELECT DISTINCT business_unit_id,business_unit_name FROM app.reward_review_plan_population(wanted_year,timezone('Asia/Kuala_Lumpur',now())::date))b),'[]'::jsonb),
 'excludedCompanies',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.legal_name,'reason',CASE WHEN c.archived_at IS NOT NULL THEN 'archived' WHEN c.currency<>'MYR' THEN 'currency' WHEN r.entity_kind<>'legal_entity' THEN 'grouping' WHEN r.is_test_entity THEN 'test' WHEN x.disposition<>'visible' THEN x.disposition ELSE 'structure' END) ORDER BY c.legal_name,c.id)
 FROM company c LEFT JOIN company_registration_classification r ON r.tenant_id=c.tenant_id AND r.company_id=c.id LEFT JOIN reward_company_classification x ON x.tenant_id=c.tenant_id AND x.company_id=c.id
 WHERE c.tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(c.id,'plans.manage','library_view')
 AND(c.archived_at IS NOT NULL OR c.currency<>'MYR' OR coalesce(r.entity_kind,'legal_entity')<>'legal_entity' OR coalesce(r.is_test_entity,false) OR coalesce(x.disposition,'visible')<>'visible')),'[]'::jsonb),
 'activePlanTypes',coalesce((SELECT jsonb_agg(jsonb_build_object('companyId',company_id,'planType',award_type,'reason',reason)) FROM reward_company_exclusion WHERE tenant_id=app.current_tenant_id() AND year=wanted_year AND ended_at IS NULL AND app.reward_config_page_allowed(company_id,'plans.manage','library_view')),'[]'::jsonb),
 'classificationCompanies',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'name',c.legal_name) ORDER BY c.legal_name,c.id) FROM company c WHERE c.tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(c.id,'plans.manage','library_view') AND app.reward_admin(c.id)),'[]'::jsonb),
 'classifications',coalesce((SELECT jsonb_agg(jsonb_build_object('companyId',c.company_id,'disposition',c.disposition,'canonicalCompanyId',CASE WHEN app.reward_admin(c.canonical_company_id) THEN c.canonical_company_id END,'reason',c.reason,'updatedAt',c.updated_at) ORDER BY c.company_id) FROM reward_company_classification c WHERE c.tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(c.company_id,'plans.manage','library_view') AND app.reward_admin(c.company_id)),'[]'::jsonb),
 'canClassify',EXISTS(SELECT 1 FROM company c WHERE c.tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(c.id,'plans.manage','library_view') AND app.reward_admin(c.id)),
 'canCreateYear',app.reward_config_page_allowed(NULL,'plans.manage','manage'),'canEdit',app.reward_config_editor_anywhere() AND app.reward_level_rank(app.reward_actor_page_level('plans.manage'))>=3,
 'canCreateReviews',app.reward_setup_allowed(NULL,'manage')) WHERE app.reward_config_page_allowed(NULL,'plans.manage','library_view')
$$;
REVOKE ALL ON FUNCTION app.reward_review_plan_metadata(integer) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_review_plan_metadata(integer) TO ai_hr_app;
-- Used-by includes draft assignments. Existing source ids remain unchanged.
CREATE OR REPLACE FUNCTION app.reward_config_library_used_by(wanted_version uuid) RETURNS TABLE(plan text,company text,year integer) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH bindings AS(SELECT p.company_id,p.year,p.plan_version_id FROM reward_plan_company p WHERE p.tenant_id=app.current_tenant_id() AND(p.salary_version_id=wanted_version OR p.bonus_version_id=wanted_version)
 UNION SELECT p.company_id,p.year,p.plan_version_id FROM reward_plan_year_company p WHERE p.tenant_id=app.current_tenant_id() AND(p.salary_version_id=wanted_version OR p.bonus_version_id=wanted_version))
 SELECT coalesce(v.name,'Review plan '||p.year),c.legal_name,p.year FROM bindings p LEFT JOIN reward_policy_group_version v ON v.id=p.plan_version_id AND v.tenant_id=app.current_tenant_id() JOIN company c ON c.id=p.company_id AND c.tenant_id=app.current_tenant_id()
 WHERE app.reward_config_viewer(c.id) ORDER BY coalesce(v.name,'Review plan '||p.year),c.legal_name,c.id
$$;
CREATE POLICY reward_year_registration_owner ON company_registration_classification FOR SELECT TO ai_hr_owner USING(tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(company_id,'plans.manage','library_view'));
INSERT INTO bulk_job_kind(kind,scope_kind,exclusive,input_shape,input_max_bytes,finalize_owner)VALUES('reward_plan_reviews',NULL,'creator','{"year":"number","companyIds":"array"}'::jsonb,32768,false);

--> statement-breakpoint
CREATE FUNCTION app.reward_review_plan_selected(wanted_year integer,wanted_ids jsonb) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r."companyId"),'[]'::jsonb) FROM(SELECT * FROM app.reward_review_plan_rows(wanted_year)
 WHERE wanted_ids IS NULL OR "companyId" IN(SELECT value::uuid FROM jsonb_array_elements_text(wanted_ids)) ORDER BY "companyId" LIMIT 501)r
$$;
REVOKE ALL ON FUNCTION app.reward_review_plan_selected(integer,jsonb) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_review_plan_selected(integer,jsonb) TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE reward_unit_setup ADD COLUMN library_rebind_revision integer;
CREATE FUNCTION app.reward_review_plan_consume_rebind(wanted_unit uuid,wanted_revision integer) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NOT app.reward_not_viewing_as() OR NOT app.reward_access(wanted_unit) OR NOT(app.reward_capability(wanted_unit,'figures.edit') OR app.reward_capability(wanted_unit,'review.decide')) THEN RETURN false;END IF;
 UPDATE reward_unit_setup s SET library_rebind_revision=NULL WHERE s.tenant_id=app.current_tenant_id() AND s.unit_id=wanted_unit AND s.library_rebind_revision=wanted_revision
 AND EXISTS(SELECT 1 FROM reward_unit u WHERE u.tenant_id=s.tenant_id AND u.id=s.unit_id AND u.revision=wanted_revision AND u.status NOT IN('draft','approved','posted','withdrawn','rejected'));
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION app.reward_review_plan_consume_rebind(uuid,integer) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_review_plan_consume_rebind(uuid,integer) TO ai_hr_app;
CREATE FUNCTION app.reward_review_plan_rebind(wanted_year integer,wanted_companies jsonb,p_reason text) RETURNS SETOF uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE t uuid:=app.current_tenant_id();changed uuid[];
BEGIN
 IF length(btrim(p_reason)) NOT BETWEEN 10 AND 4000 OR jsonb_typeof(wanted_companies)<>'array' OR jsonb_array_length(wanted_companies)>500 THEN RAISE EXCEPTION 'A reason is required';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(wanted_companies)c WHERE NOT app.reward_config_page_allowed(c.value::uuid,'plans.manage','manage')) THEN RAISE EXCEPTION 'Company configuration authority required' USING ERRCODE='42501';END IF;
 PERFORM 1 FROM reward_unit u JOIN reward_company_year_review r ON r.tenant_id=u.tenant_id AND r.unit_id=u.id JOIN reward_plan_year_company c ON c.tenant_id=r.tenant_id AND c.year=r.year AND c.company_id=r.company_id
 WHERE u.tenant_id=t AND r.year=wanted_year AND r.company_id IN(SELECT value::uuid FROM jsonb_array_elements_text(wanted_companies)) ORDER BY u.id FOR UPDATE OF u;
 IF EXISTS(SELECT 1 FROM reward_unit u JOIN reward_company_year_review r ON r.unit_id=u.id AND r.tenant_id=u.tenant_id JOIN reward_plan_year_company c ON c.tenant_id=r.tenant_id AND c.year=r.year AND c.company_id=r.company_id
 WHERE u.tenant_id=t AND r.year=wanted_year AND r.company_id IN(SELECT value::uuid FROM jsonb_array_elements_text(wanted_companies)) AND EXISTS(SELECT 1 FROM reward_unit_setup b WHERE b.tenant_id=u.tenant_id AND b.unit_id=u.id AND(b.salary_version_id IS DISTINCT FROM c.salary_version_id OR b.bonus_version_id IS DISTINCT FROM c.bonus_version_id)) AND u.status IN('approved','posted','withdrawn','rejected')) THEN RAISE EXCEPTION 'Final approved reviews are locked';END IF;
 INSERT INTO app.reward_review_plan_write_lease VALUES(t,txid_current()) ON CONFLICT DO NOTHING;
 WITH updates AS(
 UPDATE reward_unit u SET policy=app.reward_config_planned_policy_snapshot(u.policy,salary.data,bonus.data,pat.inputs),policy_group_version_id=c.plan_version_id,approved_digest=NULL,revision=u.revision+1,updated_at=now()
 FROM reward_company_year_review r JOIN reward_plan_year_company c ON c.tenant_id=r.tenant_id AND c.year=r.year AND c.company_id=r.company_id
 JOIN reward_plan_setup p ON p.tenant_id=c.tenant_id AND p.version_id=c.plan_version_id AND p.state='approved'
 JOIN reward_library_version salary ON salary.tenant_id=c.tenant_id AND salary.id=c.salary_version_id
 JOIN reward_library_version bonus ON bonus.tenant_id=c.tenant_id AND bonus.id=c.bonus_version_id
 JOIN reward_unit_setup binding ON binding.tenant_id=r.tenant_id AND binding.unit_id=r.unit_id
 JOIN reward_pat_version pat ON pat.tenant_id=binding.tenant_id AND pat.id=binding.pat_version_id
 WHERE u.tenant_id=t AND u.id=r.unit_id AND r.tenant_id=t AND r.year=wanted_year AND r.company_id IN(SELECT value::uuid FROM jsonb_array_elements_text(wanted_companies)) AND(binding.salary_version_id IS DISTINCT FROM c.salary_version_id OR binding.bonus_version_id IS DISTINCT FROM c.bonus_version_id) AND u.status NOT IN('approved','posted','withdrawn','rejected') RETURNING u.id
 )SELECT array_agg(id) INTO changed FROM updates;
 UPDATE reward_unit_setup binding SET plan_version_id=c.plan_version_id,salary_version_id=c.salary_version_id,bonus_version_id=c.bonus_version_id,library_rebind_revision=CASE WHEN u.status<>'draft' THEN u.revision END,updated_at=now()
 FROM reward_unit u JOIN reward_company_year_review r ON r.unit_id=u.id AND r.tenant_id=u.tenant_id JOIN reward_plan_year_company c ON c.tenant_id=r.tenant_id AND c.year=r.year AND c.company_id=r.company_id
 WHERE binding.tenant_id=t AND binding.unit_id=u.id AND u.id=ANY(coalesce(changed,'{}'::uuid[]));
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
 SELECT t,'reward-unit',u.id,'reward-unit.plan-rebound','user',app.current_user_id(),jsonb_build_object('year',wanted_year,'revision',u.revision,'reason',p_reason,'planVersionId',u.policy_group_version_id,'libraryRebind',true)
 FROM reward_unit u WHERE u.tenant_id=t AND u.id=ANY(coalesce(changed,'{}'::uuid[])) AND u.status<>'draft';
 DELETE FROM app.reward_review_plan_write_lease WHERE tenant_id=t AND xact_id=txid_current();
 RETURN QUERY SELECT unnest(coalesce(changed,'{}'::uuid[]));
END $$;
REVOKE ALL ON FUNCTION app.reward_review_plan_rebind(integer,jsonb,text) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_review_plan_rebind(integer,jsonb,text) TO ai_hr_app;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.reward_policy_binding_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE binding jsonb; expected_policy jsonb; year_value integer; uploaded boolean:=false;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.policy_group_version_id IS DISTINCT FROM OLD.policy_group_version_id OR
   (OLD.policy_group_version_id IS NOT NULL AND (NEW.company_id IS DISTINCT FROM OLD.company_id
    OR NEW.business_unit_id IS DISTINCT FROM OLD.business_unit_id OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.cycle_id IS DISTINCT FROM OLD.cycle_id OR NEW.policy->'year' IS DISTINCT FROM OLD.policy->'year')) THEN
   -- Native digest/status publishers have purpose roles with no plan-table access.
   -- Separate PL/pgSQL branches are required: SQL AND does not fence ACL checks.
   -- Bind the real function owner (ai_hr_owner installed; the fixture's migration owner in CI).
   IF current_user=pg_catalog.pg_get_userbyid((SELECT proowner FROM pg_catalog.pg_proc WHERE oid='app.reward_review_plan_rebind(integer,jsonb,text)'::regprocedure)) THEN
    IF app.reward_review_plan_writing() THEN
     IF NEW.tenant_id=OLD.tenant_id AND NEW.id=OLD.id AND NEW.company_id=OLD.company_id AND NEW.business_unit_id IS NOT DISTINCT FROM OLD.business_unit_id AND NEW.cycle_id=OLD.cycle_id AND NEW.kind=OLD.kind AND NEW.policy->'year'=OLD.policy->'year' AND NEW.status=OLD.status AND OLD.status NOT IN('approved','posted','withdrawn','rejected') AND EXISTS(SELECT 1 FROM reward_plan_company c WHERE c.tenant_id=NEW.tenant_id AND c.company_id=NEW.company_id AND c.year=(NEW.policy->>'year')::integer AND c.plan_version_id=NEW.policy_group_version_id) THEN RETURN NEW;END IF;
    END IF;
   END IF;
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
CREATE OR REPLACE FUNCTION app.reward_consumed_library_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NOT app.reward_review_plan_writing() AND EXISTS(SELECT 1 FROM reward_unit_setup s WHERE s.unit_id=OLD.id AND s.tenant_id=OLD.tenant_id) AND (NEW.policy->'ranges' IS DISTINCT FROM OLD.policy->'ranges' OR NEW.policy->'bonusMatrix' IS DISTINCT FROM OLD.policy->'bonusMatrix' OR NEW.policy->'bonusStructure' IS DISTINCT FROM OLD.policy->'bonusStructure' OR NEW.policy->'branchFactors' IS DISTINCT FROM OLD.policy->'branchFactors') THEN RAISE EXCEPTION 'Consumed salary and bonus libraries are immutable';END IF;RETURN NEW;
END $$;

--> statement-breakpoint
CREATE POLICY reward_review_plan_exclusion_owner ON reward_company_exclusion TO ai_hr_owner USING(tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(company_id,'plans.manage','manage')) WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_config_page_allowed(company_id,'plans.manage','manage'));
CREATE FUNCTION app.reward_review_plan_previous_choices(wanted_year integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object('companyId',c.company_id,'salaryLibraryId',sl.id,'bonusLibraryId',bl.id,'branch',coalesce(b.data->>'type'='branch',false),'planType',c.plan_type,'reason',c.reason) ORDER BY c.company_id),'[]'::jsonb)
 FROM reward_plan_year_company c LEFT JOIN reward_library_version s ON s.id=c.salary_version_id AND s.tenant_id=c.tenant_id LEFT JOIN reward_library sl ON sl.id=s.library_id AND sl.tenant_id=s.tenant_id LEFT JOIN reward_library_version b ON b.id=c.bonus_version_id AND b.tenant_id=c.tenant_id LEFT JOIN reward_library bl ON bl.id=b.library_id AND bl.tenant_id=b.tenant_id
 WHERE c.tenant_id=app.current_tenant_id() AND c.year=wanted_year-1 AND app.reward_config_page_allowed(c.company_id,'plans.manage','library_view')
$$;
REVOKE ALL ON FUNCTION app.reward_review_plan_previous_choices(integer) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_review_plan_previous_choices(integer) TO ai_hr_app;

CREATE FUNCTION app.reward_review_plan_target_available() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE wanted_year integer; wanted_company uuid;
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF TG_TABLE_NAME='reward_unit' THEN
  wanted_company:=NEW.company_id;wanted_year:=(NEW.policy->>'year')::integer;
 ELSE
  wanted_company:=NEW.company_id;
  SELECT (v.policy->>'year')::integer INTO wanted_year FROM public.reward_policy_group_version v WHERE v.id=NEW.version_id AND v.tenant_id=NEW.tenant_id;
 END IF;
 PERFORM 1 FROM public.company c WHERE c.id=wanted_company AND c.tenant_id=NEW.tenant_id FOR SHARE;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT ((TG_TABLE_NAME='reward_policy_group_target' AND app.reward_review_plan_writing() AND app.reward_config_page_allowed(wanted_company,'plans.manage','manage')) OR app.reward_company_available(wanted_company,wanted_year) OR (TG_TABLE_NAME='reward_unit' AND app.reward_setup_allowed(wanted_company,'manage') AND app.reward_not_viewing_as() AND EXISTS(SELECT 1 FROM reward_company_exclusion e WHERE e.tenant_id=NEW.tenant_id AND e.company_id=wanted_company AND e.year=wanted_year AND e.ended_at IS NULL AND e.award_type='uploaded')))
 THEN RAISE EXCEPTION 'Company is archived or excluded from this reward year' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_review_plan_target_available() FROM PUBLIC;DROP TRIGGER reward_policy_target_company_available ON reward_policy_group_target;CREATE TRIGGER reward_policy_target_company_available BEFORE INSERT ON reward_policy_group_target FOR EACH ROW EXECUTE FUNCTION app.reward_review_plan_target_available();
--> statement-breakpoint
-- Durable company-change outbox. Enqueue is in the source transaction; the continuous import worker
-- processes at most one event and 100 company/year drafts per tick without holding a web request.
ALTER TABLE reward_plan_year ADD COLUMN is_open boolean NOT NULL DEFAULT true;
CREATE TABLE app.reward_review_plan_company_outbox(event_id uuid PRIMARY KEY REFERENCES public.domain_event(id),tenant_id uuid NOT NULL REFERENCES public.tenant(id),not_before timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE app.reward_review_plan_company_outbox ENABLE ROW LEVEL SECURITY;ALTER TABLE app.reward_review_plan_company_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY reward_review_plan_outbox_owner ON app.reward_review_plan_company_outbox TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
REVOKE ALL ON app.reward_review_plan_company_outbox FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.reward_review_plan_company_enqueue() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF NEW.event_type IN('company.created','company.registration-classification.changed','reward.company-classified','organisation-tag-run.published') THEN
  INSERT INTO app.reward_review_plan_company_outbox(event_id,tenant_id,not_before)VALUES(NEW.id,NEW.tenant_id,CASE WHEN NEW.event_type='organisation-tag-run.published' THEN greatest(now(),(NEW.payload->>'effectiveOn')::date::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur') ELSE now() END) ON CONFLICT DO NOTHING;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_review_plan_company_enqueue() FROM PUBLIC;
CREATE TRIGGER reward_review_plan_company_enqueue AFTER INSERT ON domain_event FOR EACH ROW EXECUTE FUNCTION app.reward_review_plan_company_enqueue();
-- System-only maintenance accesses the owner rows, never as a captured human principal.
CREATE POLICY reward_plan_year_system ON reward_plan_year TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY reward_plan_year_company_system ON reward_plan_year_company TO ai_hr_owner USING(app.acting_as_owner()) WITH CHECK(app.acting_as_owner());
CREATE POLICY reward_plan_registration_system ON company_registration_classification FOR SELECT TO ai_hr_owner USING(app.acting_as_owner());
CREATE FUNCTION app.reward_review_plan_company_tick() RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE item app.reward_review_plan_company_outbox%ROWTYPE;n integer;source_mapping jsonb;activated boolean;
BEGIN
 IF NOT app.acting_as_owner() THEN RAISE EXCEPTION 'Physical maintenance owner required' USING ERRCODE='42501';END IF;
 SELECT * INTO item FROM app.reward_review_plan_company_outbox WHERE not_before<=now() ORDER BY not_before,created_at,event_id LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF item.event_id IS NULL THEN RETURN 0;END IF;
 PERFORM set_config('app.tenant_id',item.tenant_id::text,true);PERFORM set_config('app.user_id','',true);PERFORM set_config('jit','off',true);
 IF NOT pg_try_advisory_xact_lock(hashtextextended('access-configuration:'||item.tenant_id::text,0)) THEN RETURN 0;END IF;
 SELECT app.company_org_mapping_at(timezone('Asia/Kuala_Lumpur',now())::date),EXISTS(SELECT 1 FROM company_organisation_run WHERE tenant_id=item.tenant_id AND state='published' AND kind<>'retag' AND effective_on<=timezone('Asia/Kuala_Lumpur',now())::date) INTO source_mapping,activated;
 WITH eligible AS MATERIALIZED(
 SELECT c.id,c.legal_name FROM company c LEFT JOIN company_registration_classification r ON r.tenant_id=c.tenant_id AND r.company_id=c.id LEFT JOIN reward_company_classification x ON x.tenant_id=c.tenant_id AND x.company_id=c.id
 WHERE c.tenant_id=item.tenant_id AND c.archived_at IS NULL AND c.currency='MYR' AND coalesce(r.entity_kind,'legal_entity')='legal_entity' AND NOT coalesce(r.is_test_entity,false) AND coalesce(x.disposition,'visible')='visible'
 AND app.company_org_resolve(c.id,source_mapping,activated)->>'status'='ready'
 ),inserted AS(
 INSERT INTO reward_plan_year_company(tenant_id,year,company_id,plan_type,reason)
 SELECT y.tenant_id,y.year,c.id,coalesce(exclusion.award_type,'standard'),coalesce(exclusion.reason,'') FROM reward_plan_year y CROSS JOIN eligible c LEFT JOIN reward_company_exclusion exclusion ON exclusion.tenant_id=y.tenant_id AND exclusion.year=y.year AND exclusion.company_id=c.id AND exclusion.ended_at IS NULL
 WHERE y.tenant_id=item.tenant_id AND y.is_open AND NOT EXISTS(SELECT 1 FROM reward_plan_year_company p WHERE p.tenant_id=y.tenant_id AND p.year=y.year AND p.company_id=c.id)
 ORDER BY y.year,c.id LIMIT 100 ON CONFLICT DO NOTHING RETURNING tenant_id,year,company_id
 ),events AS(
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,payload)
 SELECT i.tenant_id,'reward-plan',i.company_id,'reward-plan.company-added','system',jsonb_build_object('companyId',i.company_id,'company',c.legal_name,'year',i.year,'sourceEventId',item.event_id)
 FROM inserted i JOIN eligible c ON c.id=i.company_id RETURNING id
 )SELECT count(*)::integer INTO n FROM events;
 IF n<100 THEN DELETE FROM app.reward_review_plan_company_outbox WHERE event_id=item.event_id;END IF;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.reward_review_plan_company_tick() FROM PUBLIC,ai_hr_app;
CREATE FUNCTION app.reward_review_plan_company_recipients(wanted_event uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH event AS(SELECT tenant_id,(payload->>'companyId')::uuid AS company_id FROM domain_event WHERE tenant_id=app.current_tenant_id() AND id=wanted_event AND event_type='reward-plan.company-added'),
 holders AS(
 SELECT g.user_id FROM reward_group_role_grant g JOIN event e ON e.tenant_id=g.tenant_id WHERE g.role='gr' AND g.active
 UNION SELECT s.user_id FROM reward_setup_grant s JOIN event e ON e.tenant_id=s.tenant_id WHERE s.role='gr' AND s.active AND(s.company_id IS NULL OR s.company_id=e.company_id) AND s.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND(s.valid_to IS NULL OR s.valid_to>=timezone('Asia/Kuala_Lumpur',now())::date)
 )SELECT DISTINCT employment.id FROM holders h JOIN event ev ON true JOIN app_user u ON u.tenant_id=ev.tenant_id AND u.id=h.user_id JOIN employment ON employment.tenant_id=u.tenant_id AND employment.person_id=u.person_id
 WHERE u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND employment.hired_on<=timezone('Asia/Kuala_Lumpur',now())::date AND(employment.terminated_on IS NULL OR employment.terminated_on>timezone('Asia/Kuala_Lumpur',now())::date)
 AND app.is_admin() AND(app.current_user_id() IS NULL OR app.is_group_admin())
$$;
REVOKE ALL ON FUNCTION app.reward_review_plan_company_recipients(uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_review_plan_company_recipients(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_review_plan_activate(wanted_year integer,wanted_company uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE p reward_plan_year_company%ROWTYPE;actor uuid:=app.current_user_id();
BEGIN
 IF NOT app.reward_setup_allowed(wanted_company,'manage') OR NOT app.reward_config_page_allowed(wanted_company,'plans.manage','manage') THEN RAISE EXCEPTION 'Current plan creation authority required' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM reward_plan_year_company WHERE tenant_id=app.current_tenant_id() AND year=wanted_year AND company_id=wanted_company FOR UPDATE;
 IF p.plan_version_id IS NULL OR NOT EXISTS(SELECT 1 FROM app.reward_review_plan_rows(wanted_year)r WHERE r."companyId"=wanted_company AND r.status='ready') THEN RAISE EXCEPTION 'Current ready plan required';END IF;
 UPDATE reward_plan_setup SET state='approved',approved_by=actor,approved_by_person_id=(SELECT person_id FROM app_user WHERE tenant_id=app.current_tenant_id() AND id=actor),approved_at=now(),revision=revision+1,updated_at=now()
 WHERE tenant_id=p.tenant_id AND version_id=p.plan_version_id AND state='draft';
 INSERT INTO reward_plan_company(tenant_id,company_id,year,plan_version_id,salary_version_id,bonus_version_id)VALUES(p.tenant_id,p.company_id,p.year,p.plan_version_id,p.salary_version_id,p.bonus_version_id)
 ON CONFLICT(tenant_id,company_id,year)DO UPDATE SET plan_version_id=excluded.plan_version_id,salary_version_id=excluded.salary_version_id,bonus_version_id=excluded.bonus_version_id;
END $$;
REVOKE ALL ON FUNCTION app.reward_review_plan_activate(integer,uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_review_plan_activate(integer,uuid) TO ai_hr_app;
CREATE FUNCTION app.reward_review_plan_company_rows(wanted_year integer,wanted_day date,config_editor boolean) RETURNS TABLE(id uuid,name text,"parentId" uuid,"parentName" text,"businessGroupId" uuid,"businessGroupName" text,"businessUnitId" uuid,"businessUnitName" text,"structureStatus" text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET jit=off AS $$
 WITH eligible AS MATERIALIZED(
 SELECT c.id,c.legal_name,c.parent_company_id FROM company c LEFT JOIN company_registration_classification r ON r.tenant_id=c.tenant_id AND r.company_id=c.id LEFT JOIN reward_company_classification x ON x.tenant_id=c.tenant_id AND x.company_id=c.id
 WHERE c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL AND c.currency='MYR' AND coalesce(r.entity_kind,'legal_entity')='legal_entity' AND NOT coalesce(r.is_test_entity,false) AND coalesce(x.disposition,'visible')='visible'
 AND CASE WHEN config_editor THEN app.reward_config_editor(c.id) ELSE app.reward_setup_allowed(c.id,'manage') END
 AND NOT EXISTS(SELECT 1 FROM reward_company_exclusion e WHERE e.tenant_id=c.tenant_id AND e.company_id=c.id AND e.year=wanted_year AND e.ended_at IS NULL)
 ),source AS MATERIALIZED(SELECT app.company_org_mapping_at(wanted_day) AS mapping,EXISTS(SELECT 1 FROM company_organisation_run WHERE tenant_id=app.current_tenant_id() AND state='published' AND kind<>'retag' AND effective_on<=wanted_day) AS activated),
 tags AS MATERIALIZED(SELECT e.*,app.company_org_resolve(e.id,s.mapping,s.activated) AS tags FROM eligible e CROSS JOIN source s)
 SELECT t.id,t.legal_name,p.id,p.legal_name,nullif(t.tags->>'businessGroupId','')::uuid,g.legal_name,nullif(t.tags->>'businessUnitId','')::uuid,b.name,coalesce(t.tags->>'status','legacy')
 FROM tags t LEFT JOIN company p ON p.tenant_id=app.current_tenant_id() AND p.id=t.parent_company_id LEFT JOIN company g ON g.tenant_id=app.current_tenant_id() AND g.id=nullif(t.tags->>'businessGroupId','')::uuid LEFT JOIN business_unit b ON b.tenant_id=app.current_tenant_id() AND b.id=nullif(t.tags->>'businessUnitId','')::uuid
 ORDER BY coalesce(g.legal_name,p.legal_name,''),coalesce(b.label,b.code,''),t.legal_name,t.id
$$;
REVOKE ALL ON FUNCTION app.reward_review_plan_company_rows(integer,date,boolean) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_review_plan_company_rows(integer,date,boolean) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_review_plan_legacy_suggestion_data(wanted_year integer,wanted_day date) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT jsonb_build_object('companies',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM app.reward_review_plan_company_rows(wanted_year,wanted_day,false)c),'[]'::jsonb),
 'candidates',coalesce((SELECT jsonb_agg(jsonb_build_object('id',v.id,'libraryId',l.id,'name',l.name,'year',l.year,'version',v.revision,'kind',l.kind,'tags',l.tags,'groupDefault',l.group_default,'type',v.data->>'type','previousLibraryId',l.previous_library_id) ORDER BY l.name,v.revision DESC) FROM reward_library l JOIN reward_library_version v ON v.tenant_id=l.tenant_id AND v.library_id=l.id WHERE l.tenant_id=app.current_tenant_id() AND l.year=wanted_year AND v.state='confirmed'),'[]'::jsonb),
 'previous',coalesce((SELECT jsonb_agg(jsonb_build_object('companyId',p.company_id,'salaryLibraryId',sv.library_id,'bonusLibraryId',bv.library_id,'branch',bv.data->>'type'='branch')) FROM reward_plan_company p JOIN reward_library_version sv ON sv.tenant_id=p.tenant_id AND sv.id=p.salary_version_id JOIN reward_library_version bv ON bv.tenant_id=p.tenant_id AND bv.id=p.bonus_version_id WHERE p.tenant_id=app.current_tenant_id() AND p.year=wanted_year-1),'[]'::jsonb),
 'covered',coalesce((SELECT jsonb_agg(DISTINCT company_id) FROM(SELECT company_id FROM reward_plan_company WHERE tenant_id=app.current_tenant_id() AND year=wanted_year UNION SELECT company_id FROM reward_plan_year_company WHERE tenant_id=app.current_tenant_id() AND year=wanted_year UNION SELECT t.company_id FROM reward_policy_group_target t JOIN reward_policy_group g ON g.tenant_id=t.tenant_id AND g.current_version_id=t.version_id JOIN reward_policy_group_version v ON v.tenant_id=t.tenant_id AND v.id=t.version_id WHERE t.tenant_id=app.current_tenant_id() AND v.policy->>'year'=wanted_year::text)c),'[]'::jsonb))
 WHERE app.reward_setup_allowed(NULL,'manage')
$$;
REVOKE ALL ON FUNCTION app.reward_review_plan_legacy_suggestion_data(integer,date) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_review_plan_legacy_suggestion_data(integer,date) TO ai_hr_app;

--> statement-breakpoint
-- 5620 creator is retained exactly except shared Access mode: creating one review changes no pre-existing access configuration.
CREATE OR REPLACE FUNCTION app.reward_config_create_planned_unit(wanted_version uuid,wanted_company uuid,wanted_business_unit uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();p reward_plan_setup%ROWTYPE;b jsonb;s jsonb;v jsonb;pat reward_pat_version%ROWTYPE;policy jsonb;cycle uuid;existing_cycle_name text;unit uuid:=gen_random_uuid();source jsonb;row record;overlap boolean;pending_names text;company_tags jsonb;plan_year integer;
BEGIN
 -- The same lock order as setupTenant and the installed 4100 entry point, ahead of the plan and company locks.
 PERFORM pg_advisory_xact_lock_shared(hashtextextended('access-configuration:'||t::text,0));
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

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.reward_role_level_options(wanted_role text,wanted_capability text) RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,app AS $$
 SELECT CASE WHEN d='none' THEN ARRAY['none']
  WHEN wanted_capability='restricted.view' THEN ARRAY['step','view']
  WHEN d='full' AND wanted_capability IN('salary.view','bonus.view','senior.manage','limits.view','plans.manage') THEN ARRAY['full','view','none']
  ELSE ARRAY[d,'none'] END
 FROM (SELECT app.reward_role_default_level(wanted_role,wanted_capability) AS d) x
$$;
--> statement-breakpoint
-- Retained legacy commands join the same draft owner. They cannot create a second, invisible company/year plan.
CREATE FUNCTION app.reward_review_plan_track_legacy_setup() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE policy_data jsonb;
BEGIN
 IF app.reward_review_plan_writing() THEN RETURN NEW;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':review-plan-year:'||NEW.year,2203));
 SELECT policy INTO policy_data FROM reward_policy_group_version WHERE tenant_id=NEW.tenant_id AND id=NEW.version_id;
 IF EXISTS(SELECT 1 FROM reward_plan_year_company c JOIN reward_plan_setup prior ON prior.tenant_id=c.tenant_id AND prior.version_id=c.plan_version_id
 WHERE c.tenant_id=NEW.tenant_id AND c.year=NEW.year AND c.company_id=ANY(NEW.company_ids) AND c.plan_version_id<>NEW.version_id AND prior.group_id<>NEW.group_id AND c.plan_version_id IS DISTINCT FROM NEW.previous_plan_version_id) THEN RAISE EXCEPTION 'This company already has a draft or active Review Plan for the year' USING ERRCODE='23505';END IF;
 INSERT INTO reward_plan_year(tenant_id,year,settings,created_by,created_by_person_id)VALUES(NEW.tenant_id,NEW.year,(policy_data-'year')||jsonb_build_object('snapshotDate',NEW.snapshot_date),NEW.created_by,NEW.created_by_person_id)ON CONFLICT DO NOTHING;
 INSERT INTO reward_plan_year_company(tenant_id,year,company_id,plan_version_id,salary_version_id,bonus_version_id,salary_reviewed,bonus_reviewed,branch_acknowledged)
 SELECT NEW.tenant_id,NEW.year,(b->>'companyId')::uuid,NEW.version_id,(b->>'salaryVersionId')::uuid,(b->>'bonusVersionId')::uuid,true,true,coalesce((b->>'branchAcknowledged')::boolean,false) FROM jsonb_array_elements(NEW.bindings)b
 ON CONFLICT(tenant_id,year,company_id)DO UPDATE SET plan_version_id=excluded.plan_version_id,salary_version_id=excluded.salary_version_id,bonus_version_id=excluded.bonus_version_id,salary_reviewed=true,bonus_reviewed=true,branch_acknowledged=excluded.branch_acknowledged,revision=reward_plan_year_company.revision+1,updated_at=now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_review_plan_track_legacy_setup() FROM PUBLIC;
CREATE TRIGGER reward_review_plan_track_legacy_setup AFTER INSERT OR UPDATE ON reward_plan_setup FOR EACH ROW EXECUTE FUNCTION app.reward_review_plan_track_legacy_setup();

--> statement-breakpoint
CREATE FUNCTION app.reward_review_plan_track_legacy_participation() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE participation text;why text;
BEGIN
 IF app.reward_review_plan_writing() THEN RETURN NEW;END IF;
 SELECT award_type,reason INTO participation,why FROM reward_company_exclusion WHERE tenant_id=NEW.tenant_id AND company_id=NEW.company_id AND year=NEW.year AND ended_at IS NULL;
 UPDATE reward_plan_year_company SET plan_type=coalesce(participation,'standard'),reason=coalesce(why,''),revision=revision+1,updated_at=now()
 WHERE tenant_id=NEW.tenant_id AND company_id=NEW.company_id AND year=NEW.year AND(plan_type IS DISTINCT FROM coalesce(participation,'standard') OR reason IS DISTINCT FROM coalesce(why,''));
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_review_plan_track_legacy_participation() FROM PUBLIC;
CREATE TRIGGER reward_review_plan_track_legacy_participation AFTER INSERT OR UPDATE ON reward_company_exclusion FOR EACH ROW EXECUTE FUNCTION app.reward_review_plan_track_legacy_participation();
--> statement-breakpoint
-- The current approver is not a configuration editor. Only the protected acknowledgement may clear
-- an exact outstanding marker; immutable library/plan columns remain guarded by reward_review_plan_links.
CREATE POLICY reward_review_plan_consume_owner ON reward_unit_setup FOR UPDATE TO ai_hr_owner
 USING(tenant_id=app.current_tenant_id() AND library_rebind_revision IS NOT NULL AND app.reward_not_viewing_as() AND app.reward_access(unit_id) AND(app.reward_capability(unit_id,'figures.edit') OR app.reward_capability(unit_id,'review.decide')))
 WITH CHECK(tenant_id=app.current_tenant_id() AND library_rebind_revision IS NULL AND app.reward_not_viewing_as() AND app.reward_access(unit_id) AND(app.reward_capability(unit_id,'figures.edit') OR app.reward_capability(unit_id,'review.decide')));
--> statement-breakpoint
CREATE FUNCTION app.reward_review_plan_rebind_recipients(wanted_event uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 WITH target AS MATERIALIZED(
 SELECT u.id,u.tenant_id,u.status FROM domain_event ev JOIN reward_unit u ON u.tenant_id=ev.tenant_id AND u.id=ev.aggregate_id
 WHERE ev.tenant_id=app.current_tenant_id() AND ev.id=wanted_event AND ev.event_type='reward-unit.plan-rebound' AND u.deleted_at IS NULL AND u.status IN('bg','gr','ctro','ec')
 AND app.is_admin() AND(app.current_user_id() IS NULL OR app.reward_admin(u.company_id))
 ),holders AS(
 SELECT m.user_id FROM reward_member m JOIN target u ON u.id=m.unit_id AND u.tenant_id=m.tenant_id WHERE(m.role=u.status OR u.status='bg' AND m.role='proxy_bg')AND app.reward_member_eligible_internal(m.id)
 UNION SELECT g.user_id FROM reward_group_role_grant g JOIN target u ON u.tenant_id=g.tenant_id AND g.role=u.status WHERE g.active AND app.reward_group_person_eligible(g.user_id)
 )SELECT DISTINCT e.id FROM holders h JOIN app_user a ON a.id=h.user_id AND a.tenant_id=app.current_tenant_id() JOIN employment e ON e.tenant_id=a.tenant_id AND e.person_id=a.person_id
 WHERE a.archived_at IS NULL AND NOT app.login_blocked(a.id) AND e.hired_on<=timezone('Asia/Kuala_Lumpur',now())::date AND(e.terminated_on IS NULL OR e.terminated_on>timezone('Asia/Kuala_Lumpur',now())::date)
$$;
REVOKE ALL ON FUNCTION app.reward_review_plan_rebind_recipients(uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_review_plan_rebind_recipients(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Company deletion asks only whether retained year choices exist, through the same
-- canonical administrator/parent guard as the existing retention owners. No plan or pay data leaves it.
CREATE INDEX reward_plan_year_company_retention ON public.reward_plan_year_company(tenant_id,company_id);
CREATE FUNCTION app.reward_plan_company_in_use(wanted_company uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app.principal_snapshot_current() AND app.is_admin() AND EXISTS(
  SELECT 1 FROM public.company c WHERE c.tenant_id=app.current_tenant_id() AND c.id=wanted_company
   AND app.is_admin_for(coalesce(app.company_org_current_parent(c.id),c.id))
 ) THEN EXISTS(
  SELECT 1 FROM public.reward_plan_year_company p WHERE p.tenant_id=app.current_tenant_id() AND p.company_id=wanted_company
 ) ELSE false END
$$;
REVOKE ALL ON FUNCTION app.reward_plan_company_in_use(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_plan_company_in_use(uuid) TO ai_hr_app;
