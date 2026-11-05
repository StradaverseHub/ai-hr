CREATE OR REPLACE FUNCTION app.reward_company_new_assignment_guard() RETURNS trigger
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
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT (app.reward_company_available(wanted_company,wanted_year) OR (TG_TABLE_NAME='reward_unit' AND app.reward_setup_allowed(wanted_company,'manage') AND app.reward_not_viewing_as() AND EXISTS(SELECT 1 FROM reward_company_exclusion e WHERE e.tenant_id=NEW.tenant_id AND e.company_id=wanted_company AND e.year=wanted_year AND e.ended_at IS NULL AND e.award_type='uploaded')))
 THEN RAISE EXCEPTION 'Company is archived or excluded from this reward year' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

ALTER TABLE reward_entry ADD COLUMN uploaded_award jsonb CHECK(uploaded_award IS NULL OR jsonb_typeof(uploaded_award)='object');
ALTER TABLE reward_company_exclusion ADD COLUMN award_type text NOT NULL DEFAULT 'no_awards' CHECK(award_type IN('no_awards','uploaded'));
CREATE TABLE reward_uploaded_review(unit_id uuid PRIMARY KEY REFERENCES reward_unit(id),tenant_id uuid NOT NULL REFERENCES tenant(id),current_version integer NOT NULL DEFAULT 0,checked_version integer,checked_by uuid REFERENCES app_user(id),checked_at timestamptz);
CREATE TABLE reward_uploaded_version(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),unit_id uuid NOT NULL REFERENCES reward_unit(id),version integer NOT NULL,rows jsonb NOT NULL CHECK(jsonb_typeof(rows)='array'),digest text NOT NULL,uploaded_by uuid NOT NULL REFERENCES app_user(id),reason text NOT NULL CHECK(length(trim(reason))>=10),evidence_name text,evidence_mime text,evidence_content text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,unit_id,version));
ALTER TABLE reward_uploaded_review ENABLE ROW LEVEL SECURITY;ALTER TABLE reward_uploaded_review FORCE ROW LEVEL SECURITY;
ALTER TABLE reward_uploaded_version ENABLE ROW LEVEL SECURITY;ALTER TABLE reward_uploaded_version FORCE ROW LEVEL SECURITY;
CREATE POLICY reward_uploaded_review_read ON reward_uploaded_review FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.reward_access(unit_id));
CREATE POLICY reward_uploaded_review_write ON reward_uploaded_review FOR ALL USING(tenant_id=app.current_tenant_id() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))) AND app.reward_not_viewing_as()) WITH CHECK(tenant_id=app.current_tenant_id() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))) AND app.reward_not_viewing_as());
-- Raw whole-company uploads and attachments remain GR-only; ordinary approvers receive native, filtered row projections.
CREATE POLICY reward_uploaded_version_read ON reward_uploaded_version FOR SELECT USING(tenant_id=app.current_tenant_id() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))));
CREATE POLICY reward_uploaded_version_insert ON reward_uploaded_version FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND uploaded_by=app.current_user_id() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))) AND app.reward_not_viewing_as());
GRANT SELECT,INSERT,UPDATE ON reward_uploaded_review TO ai_hr_app;GRANT SELECT,INSERT ON reward_uploaded_version TO ai_hr_app;
GRANT SELECT,INSERT,UPDATE ON reward_uploaded_review TO ai_hr_reward_setup_reader;
CREATE POLICY reward_uploaded_review_create ON reward_uploaded_review FOR INSERT TO ai_hr_reward_setup_reader WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed((SELECT company_id FROM reward_unit WHERE id=unit_id),'manage'));
CREATE FUNCTION app.reward_create_uploaded_unit(wanted_company uuid,wanted_business_unit uuid,wanted_cycle uuid,wanted_year integer,wanted_snapshot date,wanted_policy jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();unit uuid:=gen_random_uuid();row record;overlap boolean;
BEGIN
 PERFORM app.access_workforce_write_lock();PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':company-year:'||wanted_company::text||':'||wanted_year::text,2203));
 IF NOT app.reward_setup_allowed(wanted_company,'manage') OR NOT app.reward_not_viewing_as() THEN RAISE EXCEPTION 'Group Rewards creation authority required';END IF;
 IF wanted_snapshot>timezone('Asia/Kuala_Lumpur',now())::date OR wanted_policy->>'year'<>wanted_year::text OR NOT EXISTS(SELECT 1 FROM reward_cycle WHERE id=wanted_cycle AND tenant_id=t AND year=wanted_year) OR NOT EXISTS(SELECT 1 FROM reward_company_exclusion WHERE tenant_id=t AND company_id=wanted_company AND year=wanted_year AND ended_at IS NULL AND award_type='uploaded') THEN RAISE EXCEPTION 'Select an uploaded-awards company and current cycle';END IF;
 IF EXISTS(SELECT 1 FROM reward_company_year_review WHERE tenant_id=t AND company_id=wanted_company AND year=wanted_year) OR EXISTS(SELECT 1 FROM reward_unit u JOIN reward_cycle c ON c.id=u.cycle_id AND c.tenant_id=u.tenant_id WHERE u.tenant_id=t AND u.company_id=wanted_company AND c.year=wanted_year AND u.deleted_at IS NULL AND u.kind='annual') THEN RAISE EXCEPTION 'Company already has a review for this year';END IF;
 INSERT INTO reward_unit(id,tenant_id,created_by,cycle_id,company_id,business_unit_id,policy,snapshot_date) VALUES(unit,t,actor,wanted_cycle,wanted_company,wanted_business_unit,wanted_policy,wanted_snapshot);
 INSERT INTO reward_member(tenant_id,unit_id,user_id,role) VALUES(t,unit,actor,'gr');INSERT INTO reward_uploaded_review(unit_id,tenant_id) VALUES(unit,t);INSERT INTO reward_company_year_review VALUES(t,wanted_company,wanted_year,unit,'uploaded');
 SELECT EXISTS(SELECT 1 FROM employment e JOIN assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id WHERE e.tenant_id=t AND e.company_id=wanted_company AND e.hired_on<=wanted_snapshot AND(e.terminated_on IS NULL OR e.terminated_on>wanted_snapshot) AND a.valid_from<=wanted_snapshot AND(a.valid_to IS NULL OR a.valid_to>wanted_snapshot) AND a.superseded_at IS NULL GROUP BY e.id HAVING count(*)>1) INTO overlap;
 IF overlap THEN RAISE EXCEPTION 'An employee has overlapping assignments; correct Personnel before creating reviews';END IF;
 FOR row IN SELECT e.*,a.id AS assignment_id,j.code AS grade_code,pe.full_name,comp.id AS compensation_id,comp.basic_salary,comp.currency AS comp_currency,comp.pay_mode,comp.valid_from AS pay_from,pr.id AS review_id,pr.overall_rating
 FROM employment e JOIN person pe ON pe.id=e.person_id AND pe.tenant_id=e.tenant_id JOIN assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id
 LEFT JOIN job_grade j ON j.id=e.grade_id AND j.tenant_id=e.tenant_id
 LEFT JOIN LATERAL(SELECT * FROM compensation c WHERE c.employment_id=e.id AND c.tenant_id=e.tenant_id AND c.valid_from<=wanted_snapshot AND(c.valid_to IS NULL OR c.valid_to>wanted_snapshot) AND c.superseded_at IS NULL ORDER BY c.valid_from DESC,c.id DESC LIMIT 1)comp ON true
 LEFT JOIN LATERAL(SELECT r.id,r.overall_rating FROM performance_review r JOIN review_cycle c ON c.id=r.cycle_id AND c.tenant_id=r.tenant_id WHERE r.employment_id=e.id AND r.tenant_id=e.tenant_id AND r.closed_at IS NOT NULL AND c.period_start<=make_date(wanted_year,12,31) AND c.period_end>=make_date(wanted_year,1,1) ORDER BY r.closed_at DESC,r.id DESC LIMIT 1)pr ON true
 WHERE e.tenant_id=t AND e.company_id=wanted_company AND e.hired_on<=wanted_snapshot AND(e.terminated_on IS NULL OR e.terminated_on>wanted_snapshot) AND a.valid_from<=wanted_snapshot AND(a.valid_to IS NULL OR a.valid_to>wanted_snapshot) AND a.superseded_at IS NULL
 LOOP
 INSERT INTO reward_entry(tenant_id,unit_id,employment_id,source,facts,recommendation) VALUES(t,unit,row.id,jsonb_build_object('employmentId',row.id,'personId',row.person_id,'compensationId',row.compensation_id,'employeeCode',coalesce(row.employee_code,row.id::text),'name',row.full_name,'grade',regexp_replace(coalesce(row.grade_code,''),'^JG\s*','','i'),'gradeId',row.grade_id,'basicCents',coalesce(round(row.basic_salary*100),0),'currency',coalesce(row.comp_currency,'MYR'),'payMode',coalesce(row.pay_mode,'monthly'),'hiredOn',row.hired_on,'confirmedOn',row.confirmation_date,'notice',(row.tender_resignation_date IS NOT NULL AND row.tender_resignation_date<=wanted_snapshot) OR(row.resignation_date IS NOT NULL AND row.resignation_date<=wanted_snapshot),'lastPayChange',CASE WHEN row.pay_from>row.hired_on THEN row.pay_from ELSE NULL END,'confirmationPayChange',row.pay_from=row.confirmation_date AND row.pay_from>row.hired_on,'performanceReviewId',row.review_id,'performanceRating',row.overall_rating,'payChanges',coalesce((SELECT jsonb_agg(jsonb_build_object('on',x.valid_from,'basicCents',round(x.basic_salary*100),'kind',NULL) ORDER BY x.valid_from,x.id) FROM(SELECT c.*,lag(c.basic_salary)over(ORDER BY c.valid_from,c.id) AS prior_basic FROM compensation c WHERE c.employment_id=row.id AND c.tenant_id=t AND c.superseded_at IS NULL)x WHERE x.prior_basic IS NOT NULL AND x.basic_salary<>x.prior_basic AND x.valid_from>row.hired_on AND x.valid_from BETWEEN make_date(wanted_year,1,1) AND make_date(wanted_year+1,12,31)),'[]'::jsonb)),
 '{"talent":null,"performance":null,"confidentiality":"standard","seniorPlan":false,"erCase":false,"pipCase":false,"erDecision":"pending","pipDecision":"pending","caseReason":"","segment":"","branch":"","reviewed":false}'::jsonb,
 '{"meritBp":null,"promotionGrade":null,"promotionBp":null,"specialBp":null,"multiplierBp":null,"bonusCents":null,"lumpCents":null,"reason":"","currentRoleSummary":"","proposedRoleSummary":""}'::jsonb);
 END LOOP;
 RETURN unit;
END $$;
ALTER FUNCTION app.reward_create_uploaded_unit(uuid,uuid,uuid,integer,date,jsonb) OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_create_uploaded_unit(uuid,uuid,uuid,integer,date,jsonb) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_create_uploaded_unit(uuid,uuid,uuid,integer,date,jsonb) TO ai_hr_app;

GRANT SELECT,UPDATE ON reward_company_exclusion TO ai_hr_reward_setup_reader;
GRANT EXECUTE ON FUNCTION app.reward_company_exclusion_change(uuid,integer,text,uuid) TO ai_hr_reward_setup_reader;
CREATE POLICY reward_upload_exclusion_update ON reward_company_exclusion FOR UPDATE TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(company_id,'manage')) WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(company_id,'manage'));
CREATE FUNCTION app.reward_uploaded_participation(company_id uuid,reward_year integer,why text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE result uuid;
BEGIN
 IF NOT app.reward_setup_allowed(company_id,'manage') OR NOT app.reward_not_viewing_as() THEN RAISE EXCEPTION 'Group Rewards authority required';END IF;
 result:=app.reward_company_exclusion_change(company_id,reward_year,why,NULL);
 UPDATE reward_company_exclusion SET award_type='uploaded' WHERE id=result AND tenant_id=app.current_tenant_id();RETURN result;
END $$;
ALTER FUNCTION app.reward_uploaded_participation(uuid,integer,text) OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_uploaded_participation(uuid,integer,text) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_uploaded_participation(uuid,integer,text) TO ai_hr_app;
CREATE FUNCTION app.reward_uploaded_binding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM reward_unit WHERE id=NEW.unit_id AND tenant_id=NEW.tenant_id AND kind='annual') THEN RAISE EXCEPTION 'Uploaded review binding invalid';END IF;
 IF TG_TABLE_NAME='reward_uploaded_review' AND NEW.checked_by IS NOT NULL AND (NEW.checked_by<>app.current_user_id() OR NEW.checked_version<>NEW.current_version OR NOT EXISTS(SELECT 1 FROM reward_uploaded_version v WHERE v.unit_id=NEW.unit_id AND v.tenant_id=NEW.tenant_id AND v.version=NEW.current_version AND v.uploaded_by<>NEW.checked_by)) THEN RAISE EXCEPTION 'A different Group Rewards checker must confirm the current version';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reward_uploaded_binding BEFORE INSERT OR UPDATE ON reward_uploaded_review FOR EACH ROW EXECUTE FUNCTION app.reward_uploaded_binding();
CREATE TRIGGER reward_uploaded_version_binding BEFORE INSERT ON reward_uploaded_version FOR EACH ROW EXECUTE FUNCTION app.reward_uploaded_binding();
REVOKE ALL ON FUNCTION app.reward_uploaded_binding() FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_uploaded_binding() TO ai_hr_app,ai_hr_reward_setup_reader;
