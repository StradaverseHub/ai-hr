CREATE TABLE reward_setup_cycle(tenant_id uuid NOT NULL REFERENCES tenant(id),group_id uuid NOT NULL,year integer NOT NULL,origin_plan_version_id uuid NOT NULL,cycle_id uuid NOT NULL,PRIMARY KEY(tenant_id,group_id,year),FOREIGN KEY(tenant_id,origin_plan_version_id) REFERENCES reward_plan_setup(tenant_id,version_id),FOREIGN KEY(tenant_id,cycle_id) REFERENCES reward_cycle(tenant_id,id));
ALTER TABLE reward_setup_cycle ENABLE ROW LEVEL SECURITY;ALTER TABLE reward_setup_cycle FORCE ROW LEVEL SECURITY;
CREATE POLICY reward_setup_cycle_read ON reward_setup_cycle FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(NULL,'manage'));
CREATE POLICY reward_setup_cycle_insert ON reward_setup_cycle FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(NULL,'manage'));
GRANT SELECT ON reward_setup_cycle TO ai_hr_app;
GRANT SELECT,INSERT ON reward_setup_cycle TO ai_hr_reward_setup_reader;
GRANT INSERT ON reward_cycle,reward_unit,reward_member,reward_entry,reward_company_year_review,reward_unit_setup TO ai_hr_reward_setup_reader;
GRANT SELECT ON reward_access_bootstrap,reward_company_year_review,employment,person,assignment,compensation,job_grade,performance_review,review_cycle TO ai_hr_reward_setup_reader;
GRANT EXECUTE ON FUNCTION app.reward_validate_links(),app.reward_access_register_bootstrap(),app.reward_member_eligible(uuid),app.reward_member_bootstrap_allowed(uuid,uuid,text,date,date,uuid,text,text) TO ai_hr_reward_setup_reader;
CREATE POLICY reward_setup_cycle_source_read ON reward_cycle FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id());
CREATE POLICY reward_setup_cycle_source_insert ON reward_cycle FOR INSERT TO ai_hr_reward_setup_reader WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.reward_setup_allowed(NULL,'manage'));
CREATE POLICY reward_setup_unit_source_read ON reward_unit FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id());
CREATE POLICY reward_setup_unit_source_insert ON reward_unit FOR INSERT TO ai_hr_reward_setup_reader WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND status='draft' AND kind='annual' AND app.reward_setup_allowed(company_id,'manage'));
CREATE POLICY reward_setup_member_source_insert ON reward_member FOR INSERT TO ai_hr_reward_setup_reader WITH CHECK(tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND role='gr' AND valid_from=timezone('Asia/Kuala_Lumpur',now())::date AND valid_to IS NULL AND covers_user_id IS NULL AND restored_reason IS NULL AND restored_fingerprint IS NULL AND EXISTS(SELECT 1 FROM reward_unit u JOIN reward_access_bootstrap b ON b.unit_id=u.id AND b.tenant_id=u.tenant_id JOIN reward_company_year_review r ON r.unit_id=u.id AND r.tenant_id=u.tenant_id AND r.company_id=u.company_id WHERE u.id=reward_member.unit_id AND u.tenant_id=reward_member.tenant_id AND u.created_by=app.current_user_id() AND u.status='draft' AND u.kind='annual' AND u.revision=1 AND b.creator_id=app.current_user_id() AND b.transaction_id=txid_current() AND app.reward_setup_allowed(u.company_id,'manage')));
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
DECLARE t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();p reward_plan_setup%ROWTYPE;b jsonb;s jsonb;v jsonb;pat reward_pat_version%ROWTYPE;policy jsonb;cycle uuid;existing_cycle_name text;unit uuid:=gen_random_uuid();source jsonb;row record;overlap boolean;pending_names text;company_tags jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':plans',2203));
 PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':company-year:'||wanted_company::text||':'||(SELECT year FROM reward_plan_setup WHERE tenant_id=t AND version_id=wanted_version)::text,2203));
 IF NOT app.reward_setup_allowed(wanted_company,'manage') THEN RAISE EXCEPTION 'Group Rewards plan creation authority required' USING ERRCODE='42501';END IF;
 SELECT * INTO p FROM reward_plan_setup WHERE tenant_id=t AND version_id=wanted_version AND state='approved';
 IF p.version_id IS NULL OR NOT app.reward_setup_company_eligible(wanted_company,p.year) OR p.snapshot_date>timezone('Asia/Kuala_Lumpur',now())::date THEN RAISE EXCEPTION 'Current approved plan and available legal employer required';END IF;
 company_tags:=app.reward_company_structure(wanted_company,p.snapshot_date);IF company_tags->>'status' IS DISTINCT FROM 'ready' OR nullif(company_tags->>'businessUnitId','')::uuid IS DISTINCT FROM wanted_business_unit THEN RAISE EXCEPTION 'Confirmed dated company Business unit required at the approved plan snapshot' USING ERRCODE='22023';END IF;
 SELECT value INTO b FROM jsonb_array_elements(p.bindings) WHERE value->>'companyId'=wanted_company::text AND value->>'businessUnitId'=wanted_business_unit::text;
 IF b IS NULL OR NOT EXISTS(SELECT 1 FROM reward_plan_company c WHERE c.tenant_id=t AND c.company_id=wanted_company AND c.year=p.year AND c.plan_version_id=wanted_version) THEN RAISE EXCEPTION 'Company is not assigned to this approved plan';END IF;
 IF EXISTS(SELECT 1 FROM reward_unit u JOIN reward_cycle c ON c.id=u.cycle_id AND c.tenant_id=u.tenant_id WHERE u.tenant_id=t AND u.company_id=wanted_company AND c.year=p.year AND u.kind='annual' AND u.deleted_at IS NULL) OR EXISTS(SELECT 1 FROM reward_company_year_review WHERE tenant_id=t AND company_id=wanted_company AND year=p.year) THEN RAISE EXCEPTION 'Company already has a review for this reward year';END IF;
 SELECT rv.data INTO s FROM reward_library_version rv JOIN reward_library l ON l.id=rv.library_id AND l.tenant_id=rv.tenant_id WHERE rv.id=(b->>'salaryVersionId')::uuid AND rv.tenant_id=t AND rv.state='confirmed' AND l.kind='salary' AND l.year=p.year;
 SELECT rv.data INTO v FROM reward_library_version rv JOIN reward_library l ON l.id=rv.library_id AND l.tenant_id=rv.tenant_id WHERE rv.id=(b->>'bonusVersionId')::uuid AND rv.tenant_id=t AND rv.state='confirmed' AND l.kind='bonus' AND l.year=p.year;
 SELECT * INTO pat FROM reward_pat_version WHERE tenant_id=t AND company_id=wanted_company AND year=p.year AND state='confirmed' ORDER BY revision DESC LIMIT 1;
 IF s IS NULL OR v IS NULL OR pat.id IS NULL OR(pat.inputs->>'targetCents')::bigint<=0 OR coalesce(pat.inputs->>'actualCents',pat.inputs->>'forecastCents') IS NULL THEN RAISE EXCEPTION 'Confirmed libraries and PAT are required';END IF;
 source:=app.reward_setup_policy_source(wanted_version);policy:=source->'policy';
 policy:=policy||jsonb_build_object('ranges',(SELECT coalesce(jsonb_object_agg(r->>'grade',jsonb_build_array((r->>'minimumCents')::bigint,(r->>'midpointCents')::bigint,(r->>'maximumCents')::bigint)),'{}'::jsonb) FROM jsonb_array_elements(s->'rows')r WHERE r->>'grade'<>'23'),'bonusMatrix',(SELECT jsonb_object_agg(r->>'grade',r->'months') FROM jsonb_array_elements(v->'rows')r),'bonusStructure',v->>'type','branchFactors',(SELECT coalesce(jsonb_object_agg(r->>'name',r->'factors'),'{}'::jsonb) FROM jsonb_array_elements(v->'segments')r),'patTarget',(pat.inputs->>'targetCents')::bigint,'patActual',greatest(0,coalesce(pat.inputs->>'actualCents',pat.inputs->>'forecastCents')::bigint),'targetMonthsBp',(pat.inputs->>'targetMonthsBp')::integer,'multiplierBp',CASE WHEN v->>'type'='branch' THEN '10000'::jsonb ELSE 'null'::jsonb END);
 SELECT c.id,c.name INTO cycle,existing_cycle_name FROM reward_setup_cycle link JOIN reward_cycle c ON c.id=link.cycle_id AND c.tenant_id=link.tenant_id WHERE link.tenant_id=t AND link.group_id=p.group_id AND link.year=p.year;
 IF cycle IS NULL THEN INSERT INTO reward_cycle(tenant_id,name,year,created_by) VALUES(t,p.cycle_name,p.year,actor) RETURNING id INTO cycle;INSERT INTO reward_setup_cycle VALUES(t,p.group_id,p.year,wanted_version,cycle);ELSIF existing_cycle_name IS DISTINCT FROM p.cycle_name THEN RAISE EXCEPTION 'The cycle name is fixed after the first review is created';END IF;
 INSERT INTO reward_unit(id,tenant_id,created_by,cycle_id,company_id,business_unit_id,policy,policy_group_version_id,snapshot_date) VALUES(unit,t,actor,cycle,wanted_company,wanted_business_unit,policy,wanted_version,p.snapshot_date);
 INSERT INTO reward_company_year_review VALUES(t,wanted_company,p.year,unit,'planned');
 INSERT INTO reward_unit_setup(unit_id,tenant_id,plan_version_id,salary_version_id,bonus_version_id,pat_version_id) VALUES(unit,t,wanted_version,(b->>'salaryVersionId')::uuid,(b->>'bonusVersionId')::uuid,pat.id);
 INSERT INTO reward_member(tenant_id,unit_id,user_id,role,valid_from) VALUES(t,unit,actor,'gr',timezone('Asia/Kuala_Lumpur',now())::date);
 SELECT string_agg(coalesce(e.employee_code,e.id::text)||' · '||pe.full_name,'; ' ORDER BY e.employee_code,e.id) INTO pending_names FROM employment e JOIN person pe ON pe.id=e.person_id AND pe.tenant_id=e.tenant_id WHERE e.tenant_id=t AND e.hired_on<=p.snapshot_date AND(e.terminated_on IS NULL OR e.terminated_on>p.snapshot_date) AND app.reward_source_org_tags(e.id,p.snapshot_date)->>'companyId'=wanted_company::text AND coalesce(app.reward_source_org_tags(e.id,p.snapshot_date)->>'status','pending') NOT IN('legacy','ready');
 IF pending_names IS NOT NULL THEN RAISE EXCEPTION 'Group structure tagging is pending: %',pending_names;END IF;
 SELECT EXISTS(SELECT 1 FROM employment e JOIN assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id WHERE e.tenant_id=t AND app.reward_source_org_tags(e.id,p.snapshot_date)->>'companyId'=wanted_company::text AND e.hired_on<=p.snapshot_date AND(e.terminated_on IS NULL OR e.terminated_on>p.snapshot_date) AND (CASE WHEN app.reward_source_org_tags(e.id,p.snapshot_date)->>'status'='legacy' THEN a.business_unit_id ELSE nullif(app.reward_source_org_tags(e.id,p.snapshot_date)->>'businessUnitId','')::uuid END)=wanted_business_unit AND a.valid_from<=p.snapshot_date AND(a.valid_to IS NULL OR a.valid_to>p.snapshot_date) AND a.superseded_at IS NULL GROUP BY e.id HAVING count(*)>1) INTO overlap;
 IF overlap THEN RAISE EXCEPTION 'An employee has overlapping assignments; correct Personnel before creating reviews';END IF;
 FOR row IN SELECT e.*,a.id AS assignment_id,a.position_id AS assignment_position_id,j.code AS grade_code,pe.full_name,comp.id AS compensation_id,comp.basic_salary,comp.currency AS comp_currency,comp.pay_mode,comp.valid_from AS pay_from,pr.id AS review_id,pr.overall_rating
 FROM employment e JOIN person pe ON pe.id=e.person_id AND pe.tenant_id=e.tenant_id JOIN assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id
 LEFT JOIN job_grade j ON j.id=e.grade_id AND j.tenant_id=e.tenant_id
 LEFT JOIN LATERAL(SELECT * FROM compensation c WHERE c.employment_id=e.id AND c.tenant_id=e.tenant_id AND c.valid_from<=p.snapshot_date AND(c.valid_to IS NULL OR c.valid_to>p.snapshot_date) AND c.superseded_at IS NULL ORDER BY c.valid_from DESC,c.id DESC LIMIT 1)comp ON true
 LEFT JOIN LATERAL(SELECT r.id,r.overall_rating FROM performance_review r JOIN review_cycle c ON c.id=r.cycle_id AND c.tenant_id=r.tenant_id WHERE r.employment_id=e.id AND r.tenant_id=e.tenant_id AND r.closed_at IS NOT NULL AND c.period_start<=make_date(p.year,12,31) AND c.period_end>=make_date(p.year,1,1) ORDER BY r.closed_at DESC,r.id DESC LIMIT 1)pr ON true
 WHERE e.tenant_id=t AND app.reward_source_org_tags(e.id,p.snapshot_date)->>'companyId'=wanted_company::text AND e.hired_on<=p.snapshot_date AND(e.terminated_on IS NULL OR e.terminated_on>p.snapshot_date) AND (CASE WHEN app.reward_source_org_tags(e.id,p.snapshot_date)->>'status'='legacy' THEN a.business_unit_id ELSE nullif(app.reward_source_org_tags(e.id,p.snapshot_date)->>'businessUnitId','')::uuid END)=wanted_business_unit AND a.valid_from<=p.snapshot_date AND(a.valid_to IS NULL OR a.valid_to>p.snapshot_date) AND a.superseded_at IS NULL
 LOOP
 INSERT INTO reward_entry(tenant_id,unit_id,employment_id,source,facts,recommendation) VALUES(t,unit,row.id,jsonb_build_object('employmentId',row.id,'assignmentId',row.assignment_id,'positionId',row.assignment_position_id,'personId',row.person_id,'compensationId',row.compensation_id,'employeeCode',coalesce(row.employee_code,row.id::text),'name',row.full_name,'grade',regexp_replace(coalesce(row.grade_code,''),'^JG[[:space:]]*','','i'),'gradeId',row.grade_id,'basicCents',coalesce(round(row.basic_salary*100),0),'currency',coalesce(row.comp_currency,'MYR'),'payMode',coalesce(row.pay_mode,'monthly'),'hiredOn',row.hired_on,'confirmedOn',row.confirmation_date,'notice',(row.tender_resignation_date IS NOT NULL AND row.tender_resignation_date<=p.snapshot_date) OR(row.resignation_date IS NOT NULL AND row.resignation_date<=p.snapshot_date),'lastPayChange',CASE WHEN row.pay_from>row.hired_on THEN row.pay_from ELSE NULL END,'confirmationPayChange',coalesce(row.pay_from=row.confirmation_date AND row.pay_from>row.hired_on,false),'performanceReviewId',row.review_id,'performanceRating',row.overall_rating,'architecture',app.reward_architecture_for_source(unit,row.id,row.assignment_position_id,p.snapshot_date),'payChanges',coalesce((SELECT jsonb_agg(jsonb_build_object('on',x.valid_from,'basicCents',round(x.basic_salary*100),'kind',NULL) ORDER BY x.valid_from,x.id) FROM(SELECT c.*,lag(c.basic_salary)over(ORDER BY c.valid_from,c.id) AS prior_basic FROM compensation c WHERE c.employment_id=row.id AND c.tenant_id=t AND c.superseded_at IS NULL)x WHERE x.prior_basic IS NOT NULL AND x.basic_salary<>x.prior_basic AND x.valid_from>row.hired_on AND x.valid_from BETWEEN make_date(p.year,1,1) AND make_date(p.year+1,12,31)),'[]'::jsonb)),
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
 RETURN QUERY SELECT jsonb_build_object('id',v.id,'companyId',v.company_id,'year',v.year,'revision',v.revision,'inputs',v.inputs,'state',v.state,'createdBy',v.created_by,'createdByPersonId',v.created_by_person_id,'confirmedBy',v.confirmed_by,'confirmedAt',v.confirmed_at,'reason',v.reason,'createdByName',maker.full_name,'confirmedByName',checker.full_name) FROM reward_pat_version v LEFT JOIN app_user mu ON mu.id=v.created_by AND mu.tenant_id=v.tenant_id LEFT JOIN person maker ON maker.id=mu.person_id AND maker.tenant_id=mu.tenant_id LEFT JOIN app_user cu ON cu.id=v.confirmed_by AND cu.tenant_id=v.tenant_id LEFT JOIN person checker ON checker.id=cu.person_id AND checker.tenant_id=cu.tenant_id WHERE v.tenant_id=app.current_tenant_id() AND v.company_id=wanted_company AND v.year=wanted_year ORDER BY v.revision DESC;
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
 IF u.id IS NULL OR NOT app.reward_access(u.id) OR NOT EXISTS(SELECT 1 FROM app.reward_roles(u.id) seat WHERE seat='gr') OR NOT app.reward_setup_allowed(u.company_id,'manage') THEN RAISE EXCEPTION 'Rewards source metadata is outside your scope' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM employment e JOIN app_user actor ON actor.person_id=e.person_id AND actor.tenant_id=e.tenant_id WHERE e.id=wanted_employment AND e.tenant_id=u.tenant_id AND actor.id=app.current_user_id()) THEN RETURN NULL;END IF;
 at_day:=coalesce(wanted_date,u.snapshot_date);IF at_day>timezone('Asia/Kuala_Lumpur',now())::date THEN RAISE EXCEPTION 'Source metadata date cannot be in the future';END IF;
 IF NOT EXISTS(SELECT 1 FROM employment e JOIN assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id WHERE e.id=wanted_employment AND e.tenant_id=u.tenant_id AND app.reward_source_org_tags(e.id,at_day)->>'companyId'=u.company_id::text AND a.position_id=wanted_position AND(CASE WHEN app.reward_source_org_tags(e.id,at_day)->>'status'='legacy' THEN a.business_unit_id ELSE nullif(app.reward_source_org_tags(e.id,at_day)->>'businessUnitId','')::uuid END)=u.business_unit_id AND a.superseded_at IS NULL AND a.valid_from<=at_day AND(a.valid_to IS NULL OR a.valid_to>at_day)) THEN RETURN NULL;END IF;
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
--> statement-breakpoint
-- Private canonical-engine payroll aggregates: no runtime SELECT or employee-source export.
CREATE TABLE reward_pat_basis(unit_id uuid PRIMARY KEY REFERENCES reward_unit(id),tenant_id uuid NOT NULL REFERENCES tenant(id),fingerprint text NOT NULL,engine_basis text NOT NULL,standard_payroll bigint NOT NULL CHECK(standard_payroll>=0),h_payroll bigint NOT NULL CHECK(h_payroll>=0),updated_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE reward_pat_basis ENABLE ROW LEVEL SECURITY;ALTER TABLE reward_pat_basis FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON reward_pat_basis TO ai_hr_reward_setup_reader;
GRANT SELECT ON reward_entry,reward_governance,reward_governance_public TO ai_hr_reward_setup_reader;
GRANT UPDATE ON reward_governance,reward_governance_public,reward_unit TO ai_hr_reward_setup_reader;
GRANT INSERT ON reward_governance_history TO ai_hr_reward_setup_reader;
CREATE POLICY reward_pat_basis_owner ON reward_pat_basis FOR ALL TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM reward_unit u WHERE u.id=unit_id AND u.tenant_id=reward_pat_basis.tenant_id AND app.reward_setup_allowed(u.company_id,'manage'))) WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM reward_unit u WHERE u.id=unit_id AND u.tenant_id=reward_pat_basis.tenant_id AND app.reward_setup_allowed(u.company_id,'manage')));
CREATE POLICY reward_pat_basis_entries ON reward_entry FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM reward_unit u WHERE u.id=unit_id AND u.tenant_id=reward_entry.tenant_id AND app.reward_setup_allowed(u.company_id,'manage')));
CREATE POLICY reward_pat_draft_governance ON reward_governance FOR ALL TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM reward_unit u WHERE u.id=unit_id AND u.tenant_id=reward_governance.tenant_id AND u.status='draft' AND app.reward_setup_allowed(u.company_id,'manage'))) WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM reward_unit u WHERE u.id=unit_id AND u.tenant_id=reward_governance.tenant_id AND u.status='draft' AND app.reward_setup_allowed(u.company_id,'manage')));
CREATE POLICY reward_pat_draft_public ON reward_governance_public FOR ALL TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM reward_unit u WHERE u.id=unit_id AND u.tenant_id=reward_governance_public.tenant_id AND u.status='draft' AND app.reward_setup_allowed(u.company_id,'manage'))) WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM reward_unit u WHERE u.id=unit_id AND u.tenant_id=reward_governance_public.tenant_id AND u.status='draft' AND app.reward_setup_allowed(u.company_id,'manage')));
CREATE POLICY reward_pat_draft_history ON reward_governance_history FOR INSERT TO ai_hr_reward_setup_reader WITH CHECK(tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND kind='company-pat-confirmed' AND EXISTS(SELECT 1 FROM reward_unit u WHERE u.id=unit_id AND u.tenant_id=reward_governance_history.tenant_id AND u.status='draft' AND app.reward_setup_allowed(u.company_id,'manage')));
CREATE POLICY reward_pat_draft_unit ON reward_unit FOR UPDATE TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND status='draft' AND app.reward_setup_allowed(company_id,'manage')) WITH CHECK(tenant_id=app.current_tenant_id() AND status='draft' AND app.reward_setup_allowed(company_id,'manage'));
CREATE FUNCTION app.reward_pat_basis_fingerprint(wanted_unit uuid) RETURNS text LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object('policy',(SELECT jsonb_object_agg(key,value) FROM jsonb_each(u.policy) WHERE key=ANY(ARRAY['year','activeAsOf','minimumBonusRating','excludeNotice','excludeErCase','confirmedBy','blockedFrom','blockedTo','payWindowKeep','seniorMembershipMode','seniorGrades'])),'entries',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',e.id,'source',e.source,'facts',jsonb_build_object('performance',e.facts->'performance','seniorPlan',e.facts->'seniorPlan','erCase',e.facts->'erCase','confidentiality',e.facts->'confidentiality'))ORDER BY e.id),'[]'::jsonb)FROM reward_entry e WHERE e.unit_id=u.id AND e.tenant_id=u.tenant_id),'selection',g.state->'selection')::text,'UTF8')),'hex') FROM reward_unit u JOIN reward_governance g ON g.unit_id=u.id AND g.tenant_id=u.tenant_id WHERE u.id=wanted_unit AND u.tenant_id=app.current_tenant_id()
$$;
REVOKE ALL ON FUNCTION app.reward_pat_basis_fingerprint(uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.reward_pat_basis_fingerprint(uuid) TO ai_hr_reward_setup_reader;
CREATE FUNCTION app.reward_record_pat_basis(wanted_unit uuid,wanted_basis text,p_standard_payroll bigint,p_h_payroll bigint) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE u reward_unit%ROWTYPE;actual text;
BEGIN
 SELECT * INTO u FROM reward_unit WHERE id=wanted_unit AND tenant_id=app.current_tenant_id() FOR UPDATE;
 IF u.id IS NULL OR NOT EXISTS(SELECT 1 FROM app.reward_roles(u.id)seat WHERE seat='gr') OR NOT app.reward_setup_allowed(u.company_id,'manage') OR p_standard_payroll NOT BETWEEN 0 AND 9007199254740991 OR p_h_payroll NOT BETWEEN 0 AND 9007199254740991 OR wanted_basis !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Canonical Rewards basis is unavailable' USING ERRCODE='42501';END IF;
 actual:=app.reward_pat_basis_fingerprint(u.id);IF actual IS NULL OR NOT EXISTS(SELECT 1 FROM reward_governance_public p WHERE p.unit_id=u.id AND p.tenant_id=u.tenant_id AND p.snapshot->>'basis'=wanted_basis) THEN RAISE EXCEPTION 'Refresh the current unit budget basis';END IF;
 INSERT INTO reward_pat_basis(unit_id,tenant_id,fingerprint,engine_basis,standard_payroll,h_payroll) VALUES(u.id,u.tenant_id,actual,wanted_basis,p_standard_payroll,p_h_payroll) ON CONFLICT(unit_id)DO UPDATE SET fingerprint=excluded.fingerprint,engine_basis=excluded.engine_basis,standard_payroll=excluded.standard_payroll,h_payroll=excluded.h_payroll,updated_at=now();
END $$;
ALTER FUNCTION app.reward_record_pat_basis(uuid,text,bigint,bigint) OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_record_pat_basis(uuid,text,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_record_pat_basis(uuid,text,bigint,bigint) TO ai_hr_app;
CREATE FUNCTION app.reward_pat_affected_units(wanted_company uuid,wanted_year integer) RETURNS TABLE(id uuid,status text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NOT app.reward_setup_allowed(wanted_company,'manage') THEN RAISE EXCEPTION 'Company PAT authority required' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT u.id,u.status FROM reward_unit u JOIN reward_cycle c ON c.id=u.cycle_id AND c.tenant_id=u.tenant_id JOIN reward_unit_setup s ON s.unit_id=u.id AND s.tenant_id=u.tenant_id WHERE u.tenant_id=app.current_tenant_id() AND u.company_id=wanted_company AND c.year=wanted_year AND u.deleted_at IS NULL ORDER BY u.id FOR UPDATE OF u;
END $$;
ALTER FUNCTION app.reward_pat_affected_units(uuid,integer) OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_pat_affected_units(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_pat_affected_units(uuid,integer) TO ai_hr_app;
CREATE FUNCTION app.reward_reprice_draft_pat(wanted_unit uuid,wanted_pat uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE u reward_unit%ROWTYPE;p reward_pat_version%ROWTYPE;b reward_pat_basis%ROWTYPE;before_state jsonb;after_state jsonb;public_state jsonb;old_pools jsonb;new_pools jsonb;pool_status text;numerator numeric;target numeric;months numeric;standard_pool numeric;h_pool numeric;
BEGIN
 SELECT * INTO u FROM reward_unit WHERE id=wanted_unit AND tenant_id=app.current_tenant_id() AND deleted_at IS NULL FOR UPDATE;
 IF u.id IS NULL OR u.status<>'draft' OR NOT app.reward_setup_allowed(u.company_id,'manage') THEN RAISE EXCEPTION 'Only an authorized draft can adopt confirmed PAT';END IF;
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
ALTER FUNCTION app.reward_reprice_draft_pat(uuid,uuid) OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_reprice_draft_pat(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_reprice_draft_pat(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_apply_confirmed_pat(wanted_unit uuid,wanted_pat uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE u reward_unit%ROWTYPE;p reward_pat_version%ROWTYPE;
BEGIN
 SELECT * INTO u FROM reward_unit WHERE id=wanted_unit AND tenant_id=app.current_tenant_id() AND deleted_at IS NULL FOR UPDATE;
 SELECT * INTO p FROM reward_pat_version WHERE id=wanted_pat AND tenant_id=u.tenant_id AND company_id=u.company_id AND year=(u.policy->>'year')::integer AND state='confirmed' AND confirmed_by=app.current_user_id() AND confirmed_at=transaction_timestamp();
 IF p.id IS NULL OR NOT app.reward_setup_allowed(u.company_id,'manage') OR u.status IN('ec','approved','posted') THEN RAISE EXCEPTION 'Apply the independently confirmed PAT in its confirmation transaction';END IF;
 IF u.status='draft' THEN PERFORM app.reward_reprice_draft_pat(u.id,p.id);ELSE UPDATE reward_unit_setup SET pool_recalculation_required=true,updated_at=now() WHERE unit_id=u.id AND tenant_id=u.tenant_id AND pat_version_id<>p.id;END IF;
END $$;
ALTER FUNCTION app.reward_apply_confirmed_pat(uuid,uuid) OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_apply_confirmed_pat(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_apply_confirmed_pat(uuid,uuid) TO ai_hr_app;
REVOKE EXECUTE ON FUNCTION app.reward_reprice_draft_pat(uuid,uuid) FROM ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_consumed_library_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM reward_unit_setup s WHERE s.unit_id=OLD.id AND s.tenant_id=OLD.tenant_id) AND (NEW.policy->'ranges' IS DISTINCT FROM OLD.policy->'ranges' OR NEW.policy->'bonusMatrix' IS DISTINCT FROM OLD.policy->'bonusMatrix' OR NEW.policy->'bonusStructure' IS DISTINCT FROM OLD.policy->'bonusStructure' OR NEW.policy->'branchFactors' IS DISTINCT FROM OLD.policy->'branchFactors') THEN RAISE EXCEPTION 'Consumed salary and bonus libraries are immutable';END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_consumed_library_immutable() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_consumed_library_immutable() TO ai_hr_app,ai_hr_reward_setup_reader;
CREATE TRIGGER reward_consumed_library_immutable BEFORE UPDATE OF policy ON reward_unit FOR EACH ROW EXECUTE FUNCTION app.reward_consumed_library_immutable();
--> statement-breakpoint
-- Closed fixed-point formula shared by the confirmation owner; two floors match Rewards engine.ratio.
CREATE FUNCTION app.reward_pat_pool_from_payroll(payroll bigint,inputs jsonb) RETURNS bigint LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
DECLARE numerator numeric;target numeric;months numeric;result numeric;
BEGIN
 IF payroll IS NULL OR payroll NOT BETWEEN 0 AND 9007199254740991 THEN RAISE EXCEPTION 'Invalid eligible payroll';END IF;
 target:=(inputs->>'targetCents')::numeric;numerator:=coalesce(inputs->>'actualCents',inputs->>'forecastCents')::numeric;months:=(inputs->>'targetMonthsBp')::numeric;
 IF target IS NULL OR numerator IS NULL THEN RETURN 0;END IF;
 IF target<=0 OR months IS NULL OR months NOT BETWEEN 0 AND 100000 OR months%100<>0 THEN RAISE EXCEPTION 'Invalid confirmed PAT formula inputs';END IF;
 result:=trunc(trunc(payroll::numeric*greatest(0,numerator)/target)*months/10000);
 IF result>9007199254740991 THEN RAISE EXCEPTION 'Calculated pool exceeds the supported amount';END IF;RETURN result::bigint;
END $$;
REVOKE ALL ON FUNCTION app.reward_pat_pool_from_payroll(bigint,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_pat_pool_from_payroll(bigint,jsonb) TO ai_hr_app,ai_hr_reward_setup_reader;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.architecture_grade(text) TO ai_hr_reward_setup_reader;
CREATE FUNCTION app.reward_library_input_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE kind text;k text;r jsonb;m jsonb;prior bigint;n bigint;s jsonb;assignable boolean;
BEGIN
 IF NEW.tenant_id<>app.current_tenant_id() OR NOT app.reward_setup_allowed(NULL,'manage') THEN RAISE EXCEPTION 'Global Group Rewards library authority required' USING ERRCODE='42501';END IF;
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
ALTER FUNCTION app.reward_library_input_guard() OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_library_input_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_library_input_guard() TO ai_hr_app;
CREATE TRIGGER reward_library_input_guard BEFORE INSERT OR UPDATE ON reward_library_version FOR EACH ROW EXECUTE FUNCTION app.reward_library_input_guard();
--> statement-breakpoint
-- Reuse the published, dated Group structure owner through bounded setup projections.
DO $$ BEGIN
 IF to_regprocedure('app.company_org_tags_unchecked(uuid,date)') IS NOT NULL THEN GRANT EXECUTE ON FUNCTION app.company_org_tags_unchecked(uuid,date),app.company_org_employment_company(uuid,date),app.company_org_employment_unchecked(uuid,date) TO ai_hr_reward_setup_reader;END IF;
END $$;
GRANT SELECT ON business_unit TO ai_hr_reward_setup_reader;
CREATE POLICY reward_setup_bu_metadata ON business_unit FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id());
CREATE FUNCTION app.reward_company_structure(wanted_company uuid,wanted_date date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE tags jsonb;result jsonb;
BEGIN
 IF NOT app.reward_setup_allowed(wanted_company,'manage') OR wanted_date IS NULL THEN RAISE EXCEPTION 'Company structure is outside your Rewards scope' USING ERRCODE='42501';END IF;
 IF to_regprocedure('app.company_org_tags_unchecked(uuid,date)') IS NULL THEN RETURN jsonb_build_object('companyId',wanted_company,'status','legacy','businessUnitId',NULL,'businessUnitName',NULL,'businessGroupId',NULL,'businessGroupName',NULL);END IF;
 EXECUTE 'select app.company_org_tags_unchecked($1,$2)' INTO tags USING wanted_company,wanted_date;
 SELECT tags||jsonb_build_object('businessUnitName',(SELECT b.name FROM business_unit b WHERE b.id=nullif(tags->>'businessUnitId','')::uuid AND b.tenant_id=app.current_tenant_id()),'businessGroupName',(SELECT c.legal_name FROM company c WHERE c.id=nullif(tags->>'businessGroupId','')::uuid AND c.tenant_id=app.current_tenant_id()),'parentCompanyName',(SELECT c.legal_name FROM company c WHERE c.id=nullif(tags->>'parentCompanyId','')::uuid AND c.tenant_id=app.current_tenant_id())) INTO result;RETURN result;
END $$;
ALTER FUNCTION app.reward_company_structure(uuid,date) OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_company_structure(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_company_structure(uuid,date) TO ai_hr_app;
CREATE FUNCTION app.reward_source_org_tags(wanted_employment uuid,wanted_date date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE tags jsonb;co uuid;
BEGIN
 IF to_regprocedure('app.company_org_employment_company(uuid,date)') IS NULL THEN SELECT e.company_id INTO co FROM employment e WHERE e.id=wanted_employment AND e.tenant_id=app.current_tenant_id();tags:=jsonb_build_object('companyId',co,'status','legacy','businessUnitId',NULL);
 ELSE EXECUTE 'select app.company_org_employment_company($1,$2)' INTO co USING wanted_employment,wanted_date;END IF;
 IF co IS NULL OR NOT app.reward_setup_allowed(co,'manage') THEN RETURN NULL;END IF;
 IF tags IS NULL THEN EXECUTE 'select app.company_org_employment_unchecked($1,$2)' INTO tags USING wanted_employment,wanted_date;END IF;
 RETURN coalesce(tags,jsonb_build_object('companyId',co,'status','pending','reason','Organisation grouping authority unavailable'));
END $$;
ALTER FUNCTION app.reward_source_org_tags(uuid,date) OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_source_org_tags(uuid,date) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Bound private PAT cannot be replaced by a per-review JSON write.
CREATE FUNCTION app.reward_bound_pat_inputs() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE inputs jsonb;k text;
BEGIN
 SELECT p.inputs INTO inputs FROM reward_unit_setup s JOIN reward_pat_version p ON p.id=s.pat_version_id AND p.tenant_id=s.tenant_id WHERE s.unit_id=NEW.unit_id AND s.tenant_id=NEW.tenant_id;
 IF inputs IS NOT NULL THEN FOREACH k IN ARRAY ARRAY['targetCents','forecastCents','actualCents','targetMonthsBp'] LOOP IF NEW.state->'inputs'->k IS DISTINCT FROM inputs->k THEN RAISE EXCEPTION 'Bound company PAT inputs are immutable in a review';END IF;END LOOP;END IF;RETURN NEW;
END $$;
ALTER FUNCTION app.reward_bound_pat_inputs() OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_bound_pat_inputs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_bound_pat_inputs() TO ai_hr_app;
CREATE TRIGGER reward_bound_pat_inputs BEFORE INSERT OR UPDATE ON reward_governance FOR EACH ROW EXECUTE FUNCTION app.reward_bound_pat_inputs();
CREATE FUNCTION app.reward_planned_progression_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE bound boolean;public_state jsonb;basis reward_pat_basis%ROWTYPE;pat_inputs jsonb;expected_status text;
BEGIN
 SELECT true INTO bound FROM reward_unit_setup s WHERE s.unit_id=OLD.id AND s.tenant_id=OLD.tenant_id;
 IF bound AND NEW.status<>OLD.status AND NEW.status NOT IN('draft','withdrawn','rejected') THEN
  IF NEW.policy-ARRAY['patActual','patTarget','targetMonthsBp','unitGovernanceDigest'] IS DISTINCT FROM OLD.policy-ARRAY['patActual','patTarget','targetMonthsBp','unitGovernanceDigest'] THEN RAISE EXCEPTION 'Save policy changes and refresh the budget before progressing';END IF;
  SELECT p.snapshot INTO public_state FROM reward_governance_public p WHERE p.unit_id=OLD.id AND p.tenant_id=OLD.tenant_id;
  SELECT * INTO basis FROM reward_pat_basis b WHERE b.unit_id=OLD.id AND b.tenant_id=OLD.tenant_id;
  IF public_state IS NULL OR basis.unit_id IS NULL OR basis.fingerprint IS DISTINCT FROM app.reward_pat_basis_fingerprint(OLD.id) OR EXISTS(SELECT 1 FROM reward_unit_setup s WHERE s.unit_id=OLD.id AND s.tenant_id=OLD.tenant_id AND s.pool_recalculation_required) THEN RAISE EXCEPTION 'Refresh and acknowledge the confirmed company PAT pool before progressing';END IF;
  SELECT p.inputs INTO pat_inputs FROM reward_unit_setup s JOIN reward_pat_version p ON p.id=s.pat_version_id AND p.tenant_id=s.tenant_id WHERE s.unit_id=OLD.id AND s.tenant_id=OLD.tenant_id AND p.state='confirmed';
  expected_status:=CASE WHEN pat_inputs->>'targetCents' IS NULL OR coalesce(pat_inputs->>'actualCents',pat_inputs->>'forecastCents') IS NULL THEN 'not-set' WHEN pat_inputs->>'actualCents' IS NOT NULL THEN 'final' ELSE 'provisional' END;
  IF pat_inputs IS NULL OR public_state->>'status' IS DISTINCT FROM expected_status OR public_state->'pools' IS DISTINCT FROM jsonb_build_object('standard',app.reward_pat_pool_from_payroll(basis.standard_payroll,pat_inputs),'h',app.reward_pat_pool_from_payroll(basis.h_payroll,pat_inputs)) THEN RAISE EXCEPTION 'Review pool must match the confirmed company PAT and payroll basis';END IF;
  IF NEW.status IN('ctro','ec','approved','posted') AND expected_status<>'final' THEN RAISE EXCEPTION 'Final confirmed Actual PAT is required for CTRO and EC approval';END IF;
 END IF;RETURN NEW;
END $$;
ALTER FUNCTION app.reward_planned_progression_guard() OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_planned_progression_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_planned_progression_guard() TO ai_hr_app;
CREATE TRIGGER reward_planned_progression_guard BEFORE UPDATE OF status ON reward_unit FOR EACH ROW EXECUTE FUNCTION app.reward_planned_progression_guard();
--> statement-breakpoint
-- Trigger-only provenance comparison may read the private basis for a current approver; no runtime SELECT is granted.
CREATE POLICY reward_pat_basis_guard_read ON reward_pat_basis FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND app.reward_access(unit_id));
CREATE POLICY reward_pat_governance_guard_read ON reward_governance FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND app.reward_access(unit_id));
--> statement-breakpoint
-- Independence follows the stored PERSON as well as the login. Snapshots survive later account relinking.
CREATE FUNCTION app.reward_setup_identity_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE actor_person uuid;source_person uuid;prior_people uuid[]:='{}';prior_version uuid;
BEGIN
 SELECT person_id INTO actor_person FROM app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id() AND archived_at IS NULL;
 IF actor_person IS NULL THEN RAISE EXCEPTION 'A person-backed Group Rewards account is required' USING ERRCODE='42501';END IF;
 IF TG_TABLE_NAME='reward_pat_version' THEN
  IF TG_OP='INSERT' THEN NEW.created_by_person_id:=actor_person;
  ELSE
   IF NEW.created_by_person_id IS DISTINCT FROM OLD.created_by_person_id THEN RAISE EXCEPTION 'PAT maker identity is immutable';END IF;
   IF NEW.state='confirmed' THEN IF actor_person=OLD.created_by_person_id THEN RAISE EXCEPTION 'A different person must confirm company PAT';END IF;NEW.confirmed_by_person_id:=actor_person;END IF;
  END IF;
 ELSIF TG_TABLE_NAME='reward_library_version' THEN
  IF TG_OP='INSERT' THEN NEW.created_by_person_id:=actor_person;NEW.contributor_person_ids:=ARRAY[actor_person];
  ELSE
   IF NEW.created_by_person_id IS DISTINCT FROM OLD.created_by_person_id THEN RAISE EXCEPTION 'Library maker identity is immutable';END IF;
   IF NEW.state='confirmed' THEN IF actor_person=ANY(OLD.contributor_person_ids) THEN RAISE EXCEPTION 'A different person must confirm the library';END IF;NEW.confirmed_by_person_id:=actor_person;NEW.contributor_person_ids:=OLD.contributor_person_ids;
   ELSE NEW.contributor_person_ids:=(SELECT array_agg(DISTINCT x) FROM unnest(OLD.contributor_person_ids||ARRAY[actor_person])x);END IF;
  END IF;
 ELSE
  IF TG_OP='INSERT' THEN
   SELECT a.person_id INTO source_person FROM reward_policy_group_version v JOIN app_user a ON a.id=v.created_by AND a.tenant_id=v.tenant_id WHERE v.id=NEW.version_id AND v.tenant_id=NEW.tenant_id;
   IF source_person IS NULL THEN RAISE EXCEPTION 'A linked shared-plan maker identity is required';END IF;
   prior_version:=NEW.previous_plan_version_id;
   IF prior_version IS NULL THEN SELECT p.version_id INTO prior_version FROM reward_plan_setup p JOIN reward_policy_group_version v ON v.id=p.version_id AND v.tenant_id=p.tenant_id WHERE p.tenant_id=NEW.tenant_id AND p.group_id=NEW.group_id ORDER BY v.revision DESC LIMIT 1;END IF;
   IF prior_version IS NOT NULL THEN SELECT contributor_person_ids INTO prior_people FROM reward_plan_setup WHERE tenant_id=NEW.tenant_id AND version_id=prior_version;IF prior_people IS NULL THEN RAISE EXCEPTION 'Prior plan identity snapshot is unavailable';END IF;NEW.previous_plan_version_id:=prior_version;END IF;
   NEW.created_by_person_id:=actor_person;NEW.contributor_person_ids:=(SELECT array_agg(DISTINCT x)FROM unnest(prior_people||ARRAY[actor_person,source_person]||ARRAY(SELECT person_id FROM app_user WHERE tenant_id=NEW.tenant_id AND id=ANY(NEW.contributor_ids) AND person_id IS NOT NULL))x);
  ELSE
   IF NEW.created_by_person_id IS DISTINCT FROM OLD.created_by_person_id OR NEW.previous_plan_version_id IS DISTINCT FROM OLD.previous_plan_version_id THEN RAISE EXCEPTION 'Plan maker identity and lineage are immutable';END IF;
   IF NEW.state='approved' THEN IF actor_person=ANY(OLD.contributor_person_ids) THEN RAISE EXCEPTION 'A different person must approve the plan';END IF;NEW.approved_by_person_id:=actor_person;NEW.contributor_person_ids:=OLD.contributor_person_ids;
   ELSE NEW.contributor_person_ids:=(SELECT array_agg(DISTINCT x) FROM unnest(OLD.contributor_person_ids||ARRAY[actor_person])x);END IF;
  END IF;
 END IF;RETURN NEW;
END $$;
ALTER FUNCTION app.reward_setup_identity_guard() OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_setup_identity_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_setup_identity_guard() TO ai_hr_app;
CREATE TRIGGER reward_library_identity_guard BEFORE INSERT OR UPDATE ON reward_library_version FOR EACH ROW EXECUTE FUNCTION app.reward_setup_identity_guard();
CREATE TRIGGER reward_pat_identity_guard BEFORE INSERT OR UPDATE ON reward_pat_version FOR EACH ROW EXECUTE FUNCTION app.reward_setup_identity_guard();
CREATE TRIGGER reward_plan_identity_guard BEFORE INSERT OR UPDATE ON reward_plan_setup FOR EACH ROW EXECUTE FUNCTION app.reward_setup_identity_guard();

--> statement-breakpoint
DO $$ BEGIN
 IF to_regprocedure('app.architecture_grade_code(text)') IS NOT NULL THEN GRANT EXECUTE ON FUNCTION app.architecture_grade_code(text) TO ai_hr_reward_setup_reader;END IF;
 IF to_regprocedure('app.architecture_grade_assignable(uuid)') IS NOT NULL THEN GRANT EXECUTE ON FUNCTION app.architecture_grade_assignable(uuid) TO ai_hr_reward_setup_reader;END IF;
END $$;
--> statement-breakpoint
-- Historical company source access is scoped to a fresh, reserved creation in this transaction.
CREATE FUNCTION app.reward_source_employment_scope(wanted_employment uuid,current_company uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE admitted record;dated_company uuid;
BEGIN
 IF app.reward_setup_allowed(current_company,'manage') THEN RETURN true;END IF;
 IF to_regprocedure('app.company_org_employment_company(uuid,date)') IS NULL THEN RETURN false;END IF;
 FOR admitted IN SELECT u.company_id,u.snapshot_date FROM reward_unit u JOIN reward_access_bootstrap b ON b.unit_id=u.id AND b.tenant_id=u.tenant_id JOIN reward_company_year_review r ON r.unit_id=u.id AND r.tenant_id=u.tenant_id AND r.company_id=u.company_id WHERE u.tenant_id=app.current_tenant_id() AND u.status='draft' AND u.kind='annual' AND b.creator_id=app.current_user_id() AND b.transaction_id=txid_current() AND app.reward_setup_allowed(u.company_id,'manage') LOOP
  EXECUTE 'select app.company_org_employment_company($1,$2)' INTO dated_company USING wanted_employment,admitted.snapshot_date;
  IF dated_company=admitted.company_id THEN RETURN true;END IF;
 END LOOP;RETURN false;
END $$;
ALTER FUNCTION app.reward_source_employment_scope(uuid,uuid) OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_source_employment_scope(uuid,uuid) FROM PUBLIC,ai_hr_app;
ALTER POLICY reward_setup_employment_source ON employment USING(tenant_id=app.current_tenant_id() AND app.reward_source_employment_scope(id,company_id));
ALTER POLICY reward_setup_person_source ON person USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM employment e WHERE e.person_id=person.id AND e.tenant_id=person.tenant_id AND app.reward_source_employment_scope(e.id,e.company_id)));
ALTER POLICY reward_setup_assignment_source ON assignment USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM employment e WHERE e.id=employment_id AND e.tenant_id=assignment.tenant_id AND app.reward_source_employment_scope(e.id,e.company_id)));
ALTER POLICY reward_setup_compensation_source ON compensation USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM employment e WHERE e.id=employment_id AND e.tenant_id=compensation.tenant_id AND app.reward_source_employment_scope(e.id,e.company_id)));
ALTER POLICY reward_setup_performance_source ON performance_review USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM employment e WHERE e.id=employment_id AND e.tenant_id=performance_review.tenant_id AND app.reward_source_employment_scope(e.id,e.company_id)));

--> statement-breakpoint
-- Extend the retained link validator to the existing dated Personnel company owner.
CREATE OR REPLACE FUNCTION app.reward_validate_links() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE current_company uuid;dated_company uuid;unit_company uuid;unit_day date;validate_pair boolean;
BEGIN
 IF TG_TABLE_NAME='reward_unit' THEN
  validate_pair:=TG_OP='INSERT';IF TG_OP='UPDATE' THEN validate_pair:=NEW.tenant_id<>OLD.tenant_id OR NEW.company_id<>OLD.company_id OR NEW.business_unit_id<>OLD.business_unit_id;END IF;
  IF validate_pair AND (NOT EXISTS(SELECT 1 FROM company c WHERE c.id=NEW.company_id AND c.tenant_id=NEW.tenant_id)
   OR NOT app.reward_dated_company_pair(NEW.tenant_id,NEW.company_id,NEW.business_unit_id))
   THEN RAISE EXCEPTION 'Invalid reward company or business unit'; END IF;
  IF NEW.parent_unit_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM reward_unit p WHERE p.id=NEW.parent_unit_id AND p.tenant_id=NEW.tenant_id AND p.company_id=NEW.company_id AND p.business_unit_id=NEW.business_unit_id AND p.kind='annual' AND p.status='posted') THEN RAISE EXCEPTION 'Invalid annual reward funding source'; END IF;
 ELSIF TG_TABLE_NAME='reward_member' THEN
  IF NOT EXISTS(SELECT 1 FROM app_user u WHERE u.id=NEW.user_id AND u.tenant_id=NEW.tenant_id AND u.archived_at IS NULL)
   THEN RAISE EXCEPTION 'Invalid reward member'; END IF;
 ELSIF TG_TABLE_NAME='reward_entry' THEN
  IF NEW.source->>'employmentId' IS DISTINCT FROM NEW.employment_id::text THEN RAISE EXCEPTION 'Invalid reward employee identity';END IF;
  IF TG_OP='UPDATE' AND NEW.tenant_id=OLD.tenant_id AND NEW.unit_id=OLD.unit_id AND NEW.employment_id=OLD.employment_id THEN RETURN NEW;END IF;
  SELECT e.company_id,u.company_id,u.snapshot_date INTO current_company,unit_company,unit_day FROM public.employment e JOIN public.reward_unit u ON u.id=NEW.unit_id AND u.tenant_id=e.tenant_id WHERE e.id=NEW.employment_id AND e.tenant_id=NEW.tenant_id;
  IF unit_company IS NULL THEN RAISE EXCEPTION 'Invalid reward employee';END IF;
  dated_company:=current_company;
  IF app.current_tenant_id()=NEW.tenant_id AND to_regprocedure('app.company_org_employment_company(uuid,date)') IS NOT NULL THEN EXECUTE 'select app.company_org_employment_company($1,$2)' INTO dated_company USING NEW.employment_id,unit_day;END IF;
  IF dated_company IS DISTINCT FROM unit_company THEN RAISE EXCEPTION 'Employee is outside the review company at its snapshot date';END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.reward_setup_cycle_name(wanted_group uuid,wanted_year integer) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT c.name FROM reward_setup_cycle s JOIN reward_cycle c ON c.id=s.cycle_id AND c.tenant_id=s.tenant_id WHERE s.tenant_id=app.current_tenant_id() AND s.group_id=wanted_group AND s.year=wanted_year AND app.reward_setup_allowed(NULL,'manage')
$$;
ALTER FUNCTION app.reward_setup_cycle_name(uuid,integer) OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_setup_cycle_name(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_setup_cycle_name(uuid,integer) TO ai_hr_app;
--> statement-breakpoint
DO $$ BEGIN
 IF to_regprocedure('app.company_org_bu_usable(uuid,uuid)') IS NOT NULL THEN GRANT EXECUTE ON FUNCTION app.company_org_bu_usable(uuid,uuid) TO ai_hr_reward_setup_reader;END IF;
END $$;
CREATE FUNCTION app.reward_dated_company_pair(wanted_tenant uuid,wanted_company uuid,wanted_bu uuid) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,app AS $$
DECLARE result boolean;
BEGIN
 IF wanted_tenant=app.current_tenant_id() AND to_regprocedure('app.company_org_bu_usable(uuid,uuid)') IS NOT NULL THEN EXECUTE 'select app.company_org_bu_usable($1,$2)' INTO result USING wanted_bu,wanted_company;RETURN coalesce(result,false);END IF;
 RETURN app.reward_policy_pair_valid(wanted_tenant,wanted_company,wanted_bu,false);
END $$;
REVOKE ALL ON FUNCTION app.reward_dated_company_pair(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
GRANT EXECUTE ON FUNCTION app.reward_dated_company_pair(uuid,uuid,uuid) TO ai_hr_reward_setup_reader;
CREATE FUNCTION app.reward_setup_grade_choices() RETURNS TABLE(id uuid,code text,name text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NOT app.reward_setup_allowed(NULL,'library_view') THEN RAISE EXCEPTION 'Grade Ladder library authority required' USING ERRCODE='42501';END IF;
 IF to_regprocedure('app.architecture_grade_assignable(uuid)') IS NOT NULL THEN
  RETURN QUERY EXECUTE 'select g.id,g.code,g.name from public.job_grade g where g.tenant_id=app.current_tenant_id() and g.archived_at is null and app.architecture_grade(g.code) is not null and app.architecture_grade_assignable(g.id) order by g.rank,g.code,g.id';
 ELSE RETURN QUERY SELECT g.id,g.code,g.name FROM job_grade g WHERE g.tenant_id=app.current_tenant_id() AND g.archived_at IS NULL AND app.architecture_grade(g.code) IS NOT NULL ORDER BY g.rank,g.code,g.id;
 END IF;
END $$;
ALTER FUNCTION app.reward_setup_grade_choices() OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_setup_grade_choices() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_setup_grade_choices() TO ai_hr_app;
