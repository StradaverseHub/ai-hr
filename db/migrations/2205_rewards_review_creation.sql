CREATE TABLE reward_setup_cycle(tenant_id uuid NOT NULL REFERENCES tenant(id),plan_version_id uuid NOT NULL,cycle_id uuid NOT NULL,PRIMARY KEY(tenant_id,plan_version_id),FOREIGN KEY(tenant_id,plan_version_id) REFERENCES reward_plan_setup(tenant_id,version_id),FOREIGN KEY(tenant_id,cycle_id) REFERENCES reward_cycle(tenant_id,id));
ALTER TABLE reward_setup_cycle ENABLE ROW LEVEL SECURITY;ALTER TABLE reward_setup_cycle FORCE ROW LEVEL SECURITY;
CREATE POLICY reward_setup_cycle_read ON reward_setup_cycle FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(NULL,'manage'));
CREATE POLICY reward_setup_cycle_insert ON reward_setup_cycle FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(NULL,'manage'));
GRANT SELECT ON reward_setup_cycle TO ai_hr_app;
GRANT SELECT,INSERT ON reward_setup_cycle TO ai_hr_reward_setup_reader;
GRANT INSERT ON reward_cycle,reward_unit,reward_member,reward_entry,reward_company_year_review,reward_unit_setup TO ai_hr_reward_setup_reader;
GRANT SELECT ON reward_access_bootstrap,employment,person,assignment,compensation,job_grade,performance_review,review_cycle TO ai_hr_reward_setup_reader;
GRANT EXECUTE ON FUNCTION app.reward_validate_links(),app.reward_access_register_bootstrap(),app.reward_member_eligible(uuid),app.reward_member_bootstrap_allowed(uuid,uuid,text,date,date,uuid,text,text) TO ai_hr_reward_setup_reader;
CREATE POLICY reward_setup_cycle_source_read ON reward_cycle FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id());
CREATE POLICY reward_setup_cycle_source_insert ON reward_cycle FOR INSERT TO ai_hr_reward_setup_reader WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.reward_setup_allowed(NULL,'manage'));
CREATE POLICY reward_setup_unit_source_read ON reward_unit FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id());
CREATE POLICY reward_setup_unit_source_insert ON reward_unit FOR INSERT TO ai_hr_reward_setup_reader WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND status='draft' AND kind='annual' AND app.reward_setup_allowed(company_id,'manage'));
CREATE POLICY reward_setup_member_source_insert ON reward_member FOR INSERT TO ai_hr_reward_setup_reader WITH CHECK(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND role='gr' AND EXISTS(SELECT 1 FROM reward_unit u WHERE u.id=unit_id AND u.tenant_id=reward_member.tenant_id AND u.created_by=app.current_user_id() AND u.status='draft' AND app.reward_setup_allowed(u.company_id,'manage')));
CREATE POLICY reward_setup_bootstrap_source ON reward_access_bootstrap FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND creator_id=app.current_user_id() AND transaction_id=txid_current());
-- These policies exist only for a non-inheritable purpose owner; the function below always binds a fresh approved unit.
CREATE POLICY reward_setup_employment_source ON employment FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(company_id,'manage'));
CREATE POLICY reward_setup_person_source ON person FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM employment e WHERE e.person_id=person.id AND e.tenant_id=person.tenant_id AND app.reward_setup_allowed(e.company_id,'manage')));
CREATE POLICY reward_setup_assignment_source ON assignment FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM employment e WHERE e.id=employment_id AND e.tenant_id=assignment.tenant_id AND app.reward_setup_allowed(e.company_id,'manage')));
CREATE POLICY reward_setup_compensation_source ON compensation FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM employment e WHERE e.id=employment_id AND e.tenant_id=compensation.tenant_id AND app.reward_setup_allowed(e.company_id,'manage')));
CREATE POLICY reward_setup_grade_source ON job_grade FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id());
CREATE POLICY reward_setup_performance_source ON performance_review FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM employment e WHERE e.id=employment_id AND e.tenant_id=performance_review.tenant_id AND app.reward_setup_allowed(e.company_id,'manage')));
CREATE POLICY reward_setup_performance_cycle_source ON review_cycle FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id());
--> statement-breakpoint
CREATE FUNCTION app.reward_create_planned_unit(wanted_version uuid,wanted_company uuid,wanted_business_unit uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();p reward_plan_setup%ROWTYPE;b jsonb;s jsonb;v jsonb;pat reward_pat_version%ROWTYPE;policy jsonb;cycle uuid;unit uuid:=gen_random_uuid();source jsonb;row record;overlap boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':plans',2203));
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':company-year:'||wanted_company::text||':'||(SELECT year FROM reward_plan_setup WHERE tenant_id=t AND version_id=wanted_version)::text,2203));
 IF NOT app.reward_setup_allowed(wanted_company,'manage') THEN RAISE EXCEPTION 'Group Rewards plan creation authority required' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM reward_plan_setup WHERE tenant_id=t AND version_id=wanted_version AND state='approved';
 IF p.version_id IS NULL OR NOT app.reward_setup_company_eligible(wanted_company,p.year) OR p.snapshot_date>timezone('Asia/Kuala_Lumpur',now())::date THEN RAISE EXCEPTION 'Current approved plan and available legal employer required';END IF;
 SELECT value INTO b FROM jsonb_array_elements(p.bindings) WHERE value->>'companyId'=wanted_company::text AND value->>'businessUnitId'=wanted_business_unit::text;
 IF b IS NULL OR NOT EXISTS(SELECT 1 FROM reward_plan_company c WHERE c.tenant_id=t AND c.company_id=wanted_company AND c.year=p.year AND c.plan_version_id=wanted_version) THEN RAISE EXCEPTION 'Company is not assigned to this approved plan';END IF;
 IF EXISTS(SELECT 1 FROM reward_unit u JOIN reward_cycle c ON c.id=u.cycle_id AND c.tenant_id=u.tenant_id WHERE u.tenant_id=t AND u.company_id=wanted_company AND c.year=p.year AND u.kind='annual' AND u.deleted_at IS NULL) OR EXISTS(SELECT 1 FROM reward_company_year_review WHERE tenant_id=t AND company_id=wanted_company AND year=p.year) THEN RAISE EXCEPTION 'Company already has a review for this reward year';END IF;
 SELECT rv.data INTO s FROM reward_library_version rv JOIN reward_library l ON l.id=rv.library_id AND l.tenant_id=rv.tenant_id WHERE rv.id=(b->>'salaryVersionId')::uuid AND rv.tenant_id=t AND rv.state='confirmed' AND l.kind='salary' AND l.year=p.year;
 SELECT rv.data INTO v FROM reward_library_version rv JOIN reward_library l ON l.id=rv.library_id AND l.tenant_id=rv.tenant_id WHERE rv.id=(b->>'bonusVersionId')::uuid AND rv.tenant_id=t AND rv.state='confirmed' AND l.kind='bonus' AND l.year=p.year;
 SELECT * INTO pat FROM reward_pat_version WHERE tenant_id=t AND company_id=wanted_company AND year=p.year AND state='confirmed' ORDER BY revision DESC LIMIT 1;
 IF s IS NULL OR v IS NULL OR pat.id IS NULL OR(pat.inputs->>'targetCents')::bigint<=0 OR coalesce(pat.inputs->>'actualCents',pat.inputs->>'forecastCents') IS NULL THEN RAISE EXCEPTION 'Confirmed libraries and PAT are required';END IF;
 source:=app.reward_setup_policy_source(wanted_version);policy:=source->'policy';
 policy:=policy||jsonb_build_object('ranges',(SELECT coalesce(jsonb_object_agg(r->>'grade',jsonb_build_array((r->>'minimumCents')::bigint,(r->>'midpointCents')::bigint,(r->>'maximumCents')::bigint)),'{}'::jsonb) FROM jsonb_array_elements(s->'rows')r WHERE r->>'grade'<>'23'),'bonusMatrix',(SELECT jsonb_object_agg(r->>'grade',r->'months') FROM jsonb_array_elements(v->'rows')r),'bonusStructure',v->>'type','branchFactors',(SELECT coalesce(jsonb_object_agg(r->>'name',r->'factors'),'{}'::jsonb) FROM jsonb_array_elements(v->'segments')r),'patTarget',(pat.inputs->>'targetCents')::bigint,'patActual',greatest(0,coalesce(pat.inputs->>'actualCents',pat.inputs->>'forecastCents')::bigint),'targetMonthsBp',(pat.inputs->>'targetMonthsBp')::integer,'multiplierBp',CASE WHEN v->>'type'='branch' THEN '10000'::jsonb ELSE 'null'::jsonb END);
 SELECT cycle_id INTO cycle FROM reward_setup_cycle WHERE tenant_id=t AND plan_version_id=wanted_version;
 IF cycle IS NULL THEN INSERT INTO reward_cycle(tenant_id,name,year,created_by) VALUES(t,p.cycle_name,p.year,actor) RETURNING id INTO cycle;INSERT INTO reward_setup_cycle VALUES(t,wanted_version,cycle);END IF;
 INSERT INTO reward_unit(id,tenant_id,created_by,cycle_id,company_id,business_unit_id,policy,policy_group_version_id,snapshot_date) VALUES(unit,t,actor,cycle,wanted_company,wanted_business_unit,policy,wanted_version,p.snapshot_date);
 INSERT INTO reward_member(tenant_id,unit_id,user_id,role) VALUES(t,unit,actor,'gr');
 INSERT INTO reward_company_year_review VALUES(t,wanted_company,p.year,unit,'planned');
 INSERT INTO reward_unit_setup(unit_id,tenant_id,plan_version_id,salary_version_id,bonus_version_id,pat_version_id) VALUES(unit,t,wanted_version,(b->>'salaryVersionId')::uuid,(b->>'bonusVersionId')::uuid,pat.id);
 SELECT EXISTS(SELECT 1 FROM employment e JOIN assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id WHERE e.tenant_id=t AND e.company_id=wanted_company AND e.hired_on<=p.snapshot_date AND(e.terminated_on IS NULL OR e.terminated_on>p.snapshot_date) AND a.business_unit_id=wanted_business_unit AND a.valid_from<=p.snapshot_date AND(a.valid_to IS NULL OR a.valid_to>p.snapshot_date) AND a.superseded_at IS NULL GROUP BY e.id HAVING count(*)>1) INTO overlap;
 IF overlap THEN RAISE EXCEPTION 'An employee has overlapping assignments; correct Personnel before creating reviews';END IF;
 FOR row IN SELECT e.*,a.id AS assignment_id,a.position_id AS assignment_position_id,j.code AS grade_code,pe.full_name,comp.id AS compensation_id,comp.basic_salary,comp.currency AS comp_currency,comp.pay_mode,comp.valid_from AS pay_from,pr.id AS review_id,pr.overall_rating
 FROM employment e JOIN person pe ON pe.id=e.person_id AND pe.tenant_id=e.tenant_id JOIN assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id
 LEFT JOIN job_grade j ON j.id=e.grade_id AND j.tenant_id=e.tenant_id
 LEFT JOIN LATERAL(SELECT * FROM compensation c WHERE c.employment_id=e.id AND c.tenant_id=e.tenant_id AND c.valid_from<=p.snapshot_date AND(c.valid_to IS NULL OR c.valid_to>p.snapshot_date) AND c.superseded_at IS NULL ORDER BY c.valid_from DESC,c.id DESC LIMIT 1)comp ON true
 LEFT JOIN LATERAL(SELECT r.id,r.overall_rating FROM performance_review r JOIN review_cycle c ON c.id=r.cycle_id AND c.tenant_id=r.tenant_id WHERE r.employment_id=e.id AND r.tenant_id=e.tenant_id AND r.closed_at IS NOT NULL AND c.period_start<=make_date(p.year,12,31) AND c.period_end>=make_date(p.year,1,1) ORDER BY r.closed_at DESC,r.id DESC LIMIT 1)pr ON true
 WHERE e.tenant_id=t AND e.company_id=wanted_company AND e.hired_on<=p.snapshot_date AND(e.terminated_on IS NULL OR e.terminated_on>p.snapshot_date) AND a.business_unit_id=wanted_business_unit AND a.valid_from<=p.snapshot_date AND(a.valid_to IS NULL OR a.valid_to>p.snapshot_date) AND a.superseded_at IS NULL
 LOOP
 INSERT INTO reward_entry(tenant_id,unit_id,employment_id,source,facts,recommendation) VALUES(t,unit,row.id,jsonb_build_object('employmentId',row.id,'assignmentId',row.assignment_id,'positionId',row.assignment_position_id,'personId',row.person_id,'compensationId',row.compensation_id,'employeeCode',coalesce(row.employee_code,row.id::text),'name',row.full_name,'grade',regexp_replace(coalesce(row.grade_code,''),'^JG\s*','','i'),'gradeId',row.grade_id,'basicCents',coalesce(round(row.basic_salary*100),0),'currency',coalesce(row.comp_currency,'MYR'),'payMode',coalesce(row.pay_mode,'monthly'),'hiredOn',row.hired_on,'confirmedOn',row.confirmation_date,'notice',(row.tender_resignation_date IS NOT NULL AND row.tender_resignation_date<=p.snapshot_date) OR(row.resignation_date IS NOT NULL AND row.resignation_date<=p.snapshot_date),'lastPayChange',CASE WHEN row.pay_from>row.hired_on THEN row.pay_from ELSE NULL END,'confirmationPayChange',coalesce(row.pay_from=row.confirmation_date AND row.pay_from>row.hired_on,false),'performanceReviewId',row.review_id,'performanceRating',row.overall_rating,'architecture',app.reward_architecture_for_source(unit,row.id,row.assignment_position_id,p.snapshot_date),'payChanges',coalesce((SELECT jsonb_agg(jsonb_build_object('on',x.valid_from,'basicCents',round(x.basic_salary*100),'kind',NULL) ORDER BY x.valid_from,x.id) FROM(SELECT c.*,lag(c.basic_salary)over(ORDER BY c.valid_from,c.id) AS prior_basic FROM compensation c WHERE c.employment_id=row.id AND c.tenant_id=t AND c.superseded_at IS NULL)x WHERE x.prior_basic IS NOT NULL AND x.basic_salary<>x.prior_basic AND x.valid_from>row.hired_on AND x.valid_from BETWEEN make_date(p.year,1,1) AND make_date(p.year+1,12,31)),'[]'::jsonb)),
 '{"talent":null,"performance":null,"confidentiality":"standard","seniorPlan":false,"erCase":false,"pipCase":false,"erDecision":"pending","pipDecision":"pending","caseReason":"","segment":"","branch":"","reviewed":false}'::jsonb,
 '{"meritBp":null,"promotionGrade":null,"promotionBp":null,"specialBp":null,"multiplierBp":null,"bonusCents":null,"lumpCents":null,"reason":"","currentRoleSummary":"","proposedRoleSummary":""}'::jsonb);
 END LOOP;
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(t,'reward-unit',unit,'reward-unit.approved-plan-admitted','user',actor,jsonb_build_object('planVersionId',wanted_version,'salaryVersionId',b->>'salaryVersionId','bonusVersionId',b->>'bonusVersionId','patVersionId',pat.id));
 RETURN unit;
END $$;
ALTER FUNCTION app.reward_create_planned_unit(uuid,uuid,uuid) OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_create_planned_unit(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_create_planned_unit(uuid,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Annual admission is exclusively through reviewed planned/uploaded purpose-owned creators.
-- Retain the existing native off-cycle insert route for ordinary runtime sessions.
CREATE POLICY reward_annual_admission_only ON reward_unit AS RESTRICTIVE FOR INSERT TO ai_hr_app WITH CHECK(kind<>'annual');
--> statement-breakpoint
-- Private PAT audit labels reveal only people who acted on an authorized company PAT version.
CREATE POLICY reward_setup_pat_actor_person ON person FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM app_user u JOIN reward_pat_version v ON v.tenant_id=u.tenant_id AND(u.id=v.created_by OR u.id=v.confirmed_by) WHERE u.tenant_id=person.tenant_id AND u.person_id=person.id AND app.reward_setup_allowed(v.company_id,'manage')));
CREATE FUNCTION app.reward_private_pat_history(wanted_company uuid,wanted_year integer) RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NOT app.reward_setup_allowed(wanted_company,'manage') THEN RAISE EXCEPTION 'Company PAT is private to Group Rewards' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT jsonb_build_object('id',v.id,'companyId',v.company_id,'year',v.year,'revision',v.revision,'inputs',v.inputs,'state',v.state,'createdBy',v.created_by,'confirmedBy',v.confirmed_by,'confirmedAt',v.confirmed_at,'reason',v.reason,'createdByName',maker.full_name,'confirmedByName',checker.full_name) FROM reward_pat_version v LEFT JOIN app_user mu ON mu.id=v.created_by AND mu.tenant_id=v.tenant_id LEFT JOIN person maker ON maker.id=mu.person_id AND maker.tenant_id=mu.tenant_id LEFT JOIN app_user cu ON cu.id=v.confirmed_by AND cu.tenant_id=v.tenant_id LEFT JOIN person checker ON checker.id=cu.person_id AND checker.tenant_id=cu.tenant_id WHERE v.tenant_id=app.current_tenant_id() AND v.company_id=wanted_company AND v.year=wanted_year ORDER BY v.revision DESC;
END $$;
ALTER FUNCTION app.reward_private_pat_history(uuid,integer) OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_private_pat_history(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_private_pat_history(uuid,integer) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_pat_input_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE k text;value jsonb;months bigint;
BEGIN
 IF NOT app.reward_setup_allowed(NEW.company_id,'manage') OR NEW.tenant_id<>app.current_tenant_id() THEN RAISE EXCEPTION 'Company PAT authority required' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||':pat:'||NEW.company_id::text||':'||NEW.year::text,2203));
 IF EXISTS(SELECT 1 FROM reward_unit u JOIN reward_cycle c ON c.id=u.cycle_id AND c.tenant_id=u.tenant_id WHERE u.tenant_id=NEW.tenant_id AND u.company_id=NEW.company_id AND c.year=NEW.year AND u.deleted_at IS NULL AND u.status IN('ec','approved','posted')) THEN RAISE EXCEPTION 'Company PAT is locked at EC approval';END IF;
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
ALTER FUNCTION app.reward_pat_input_guard() OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_pat_input_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_pat_input_guard() TO ai_hr_app;
CREATE TRIGGER reward_pat_input_guard BEFORE INSERT OR UPDATE ON reward_pat_version FOR EACH ROW EXECUTE FUNCTION app.reward_pat_input_guard();
--> statement-breakpoint
-- Approved job metadata only: no employee grade or pay is changed by this projection.
GRANT SELECT ON job_architecture_seat,job_architecture_position_revision,job_architecture_catalogue_revision TO ai_hr_reward_setup_reader;
GRANT EXECUTE ON FUNCTION app.job_architecture_can(uuid,text) TO ai_hr_reward_setup_reader;
CREATE POLICY reward_setup_architecture_position ON job_architecture_position_revision FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(company_id,'manage'));
CREATE POLICY reward_setup_architecture_catalogue ON job_architecture_catalogue_revision FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM job_architecture_position_revision r WHERE r.tenant_id=job_architecture_catalogue_revision.tenant_id AND r.catalogue_revision=job_architecture_catalogue_revision.revision AND app.reward_setup_allowed(r.company_id,'manage')));
CREATE FUNCTION app.reward_architecture_for_source(wanted_unit uuid,wanted_employment uuid,wanted_position uuid,wanted_date date DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE u reward_unit%ROWTYPE;r job_architecture_position_revision%ROWTYPE;catalogue jsonb;job_unit jsonb;job_class jsonb;at_day date;
BEGIN
 SELECT * INTO u FROM reward_unit WHERE tenant_id=app.current_tenant_id() AND id=wanted_unit AND deleted_at IS NULL;
 IF u.id IS NULL OR NOT app.reward_access(u.id) OR NOT app.reward_setup_allowed(u.company_id,'manage') THEN RAISE EXCEPTION 'Rewards source metadata is outside your scope' USING ERRCODE='42501';END IF;
 at_day:=coalesce(wanted_date,u.snapshot_date);IF at_day>timezone('Asia/Kuala_Lumpur',now())::date THEN RAISE EXCEPTION 'Source metadata date cannot be in the future';END IF;
 IF NOT EXISTS(SELECT 1 FROM employment e JOIN assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id WHERE e.id=wanted_employment AND e.tenant_id=u.tenant_id AND e.company_id=u.company_id AND a.position_id=wanted_position AND a.business_unit_id=u.business_unit_id AND a.superseded_at IS NULL AND a.valid_from<=at_day AND(a.valid_to IS NULL OR a.valid_to>at_day)) THEN RETURN NULL;END IF;
 SELECT * INTO r FROM job_architecture_position_revision x WHERE x.tenant_id=u.tenant_id AND x.company_id=u.company_id AND x.position_id=wanted_position AND x.created_at<((at_day+1)::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur') ORDER BY x.revision DESC LIMIT 1;
 IF r.id IS NULL THEN RETURN NULL;END IF;
 SELECT c.catalogue INTO catalogue FROM job_architecture_catalogue_revision c WHERE c.tenant_id=r.tenant_id AND c.revision=r.catalogue_revision;
 SELECT value INTO job_unit FROM jsonb_array_elements(catalogue->'nodes') WHERE value->>'id'=r.mapping->>'jobUnitId';
 SELECT value INTO job_class FROM jsonb_array_elements(catalogue->'nodes') WHERE value->>'id'=job_unit->>'parentId' AND value->>'kind'='class';
 RETURN jsonb_build_object('positionId',wanted_position,'mappingRevision',r.revision,'catalogueRevision',r.catalogue_revision,'gradeId',r.mapping->>'gradeId','gradeCode',r.mapping->>'grade','jobUnitId',job_unit->>'id','jobUnitTitle',job_unit->>'title','classification',(WITH RECURSIVE path AS(SELECT job_unit AS node,0 AS depth UNION ALL SELECT parent.value,path.depth+1 FROM path CROSS JOIN LATERAL jsonb_array_elements(catalogue->'nodes')parent(value) WHERE parent.value->>'id'=path.node->>'parentId' AND path.depth<5)SELECT coalesce(jsonb_agg(node->>'title' ORDER BY depth DESC)FILTER(WHERE depth>0),'[]'::jsonb)FROM path));
END $$;
ALTER FUNCTION app.reward_architecture_for_source(uuid,uuid,uuid,date) OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_architecture_for_source(uuid,uuid,uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_architecture_for_source(uuid,uuid,uuid,date) TO ai_hr_app;
