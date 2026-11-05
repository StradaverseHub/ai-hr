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
GRANT SELECT,UPDATE ON reward_uploaded_review TO ai_hr_app;GRANT SELECT,INSERT ON reward_uploaded_version TO ai_hr_app;
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
CREATE FUNCTION app.reward_uploaded_participation(wanted_company uuid,reward_year integer,why text) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE result uuid;previous reward_company_exclusion%ROWTYPE;t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();
BEGIN
 PERFORM app.access_workforce_write_lock();
 IF NOT app.reward_setup_allowed(wanted_company,'manage') OR NOT app.reward_not_viewing_as() THEN RAISE EXCEPTION 'Group Rewards authority required';END IF;
 IF reward_year NOT BETWEEN 2000 AND 2200 OR length(trim(why)) NOT BETWEEN 10 AND 2000 OR NOT EXISTS(SELECT 1 FROM company WHERE id=wanted_company AND tenant_id=t AND archived_at IS NULL) THEN RAISE EXCEPTION 'Current company, year and a reason are required';END IF;
 SELECT * INTO previous FROM reward_company_exclusion WHERE tenant_id=t AND company_id=wanted_company AND year=reward_year AND ended_at IS NULL FOR UPDATE;
 IF previous.id IS NOT NULL AND previous.award_type='uploaded' THEN RETURN previous.id;END IF;
 IF previous.id IS NOT NULL THEN UPDATE reward_company_exclusion SET ended_at=now(),ended_by=actor,end_reason=trim(why) WHERE id=previous.id;END IF;
 INSERT INTO reward_company_exclusion(tenant_id,company_id,year,reason,created_by,award_type) VALUES(t,wanted_company,reward_year,trim(why),actor,'uploaded') RETURNING id INTO result;
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(t,'reward-company-exclusion',result,'reward.company-uploaded-participation','user',actor,jsonb_build_object('companyId',wanted_company,'year',reward_year,'before',previous.award_type,'after','uploaded','reason',why));RETURN result;
END $$;
ALTER FUNCTION app.reward_uploaded_participation(uuid,integer,text) OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_uploaded_participation(uuid,integer,text) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_uploaded_participation(uuid,integer,text) TO ai_hr_app;
CREATE FUNCTION app.reward_uploaded_binding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM reward_unit WHERE id=NEW.unit_id AND tenant_id=NEW.tenant_id AND kind='annual') THEN RAISE EXCEPTION 'Uploaded review binding invalid';END IF;
 IF TG_TABLE_NAME='reward_uploaded_review' AND TG_OP='UPDATE' THEN
  IF NOT EXISTS(SELECT 1 FROM reward_unit u WHERE u.id=NEW.unit_id AND u.tenant_id=NEW.tenant_id AND u.status='draft') THEN RAISE EXCEPTION 'Whole uploads and checker confirmation are limited to BU stage';END IF;
  IF NEW.unit_id<>OLD.unit_id OR NEW.tenant_id<>OLD.tenant_id THEN RAISE EXCEPTION 'Upload identity is immutable';END IF;
  IF NEW.current_version<>OLD.current_version THEN
   IF NEW.current_version<>OLD.current_version+1 OR NEW.checked_by IS NOT NULL OR NEW.checked_version IS NOT NULL OR NEW.checked_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM reward_uploaded_version v WHERE v.tenant_id=NEW.tenant_id AND v.unit_id=NEW.unit_id AND v.version=NEW.current_version AND v.uploaded_by=app.current_user_id()) THEN RAISE EXCEPTION 'Replacement must append the doer current version and reset confirmation';END IF;
  ELSIF NEW.checked_by IS NOT NULL AND (OLD.checked_by IS NOT NULL OR NEW.checked_at IS NULL OR NOT EXISTS(SELECT 1 FROM reward_uploaded_version v WHERE v.unit_id=NEW.unit_id AND v.tenant_id=NEW.tenant_id AND v.version=NEW.current_version AND (SELECT coalesce(jsonb_agg(x.value-ARRAY['incrementCents','warnings'] ORDER BY x.value->>'employmentId'),'[]'::jsonb) FROM jsonb_array_elements(v.rows)x)=(SELECT coalesce(jsonb_agg(e.uploaded_award ORDER BY e.employment_id::text),'[]'::jsonb) FROM reward_entry e WHERE e.unit_id=NEW.unit_id AND e.tenant_id=NEW.tenant_id AND e.uploaded_award IS NOT NULL))) THEN RAISE EXCEPTION 'Checker must confirm the unchanged current upload';END IF;
 END IF;
 IF TG_TABLE_NAME='reward_uploaded_version' THEN
  IF NEW.uploaded_by<>app.current_user_id() OR NOT EXISTS(SELECT 1 FROM reward_unit u JOIN reward_uploaded_review r ON r.unit_id=u.id AND r.tenant_id=u.tenant_id WHERE u.id=NEW.unit_id AND u.tenant_id=NEW.tenant_id AND u.status='draft' AND NEW.version=r.current_version+1) THEN RAISE EXCEPTION 'Upload versions are append-only at BU stage';END IF;
 END IF;
 IF TG_TABLE_NAME='reward_uploaded_review' AND NEW.checked_by IS NOT NULL AND (NEW.checked_by<>app.current_user_id() OR NEW.checked_version<>NEW.current_version OR NOT EXISTS(SELECT 1 FROM reward_uploaded_version v WHERE v.unit_id=NEW.unit_id AND v.tenant_id=NEW.tenant_id AND v.version=NEW.current_version AND v.uploaded_by<>NEW.checked_by)) THEN RAISE EXCEPTION 'A different Group Rewards checker must confirm the current version';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reward_uploaded_binding BEFORE INSERT OR UPDATE ON reward_uploaded_review FOR EACH ROW EXECUTE FUNCTION app.reward_uploaded_binding();
CREATE TRIGGER reward_uploaded_version_binding BEFORE INSERT ON reward_uploaded_version FOR EACH ROW EXECUTE FUNCTION app.reward_uploaded_binding();
REVOKE ALL ON FUNCTION app.reward_uploaded_binding() FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_uploaded_binding() TO ai_hr_app,ai_hr_reward_setup_reader;
CREATE TRIGGER reward_uploaded_review_readonly BEFORE INSERT OR UPDATE OR DELETE ON reward_uploaded_review FOR EACH ROW EXECUTE FUNCTION app.reward_view_as_write_guard();
CREATE TRIGGER reward_uploaded_version_readonly BEFORE INSERT OR UPDATE OR DELETE ON reward_uploaded_version FOR EACH ROW EXECUTE FUNCTION app.reward_view_as_write_guard();

CREATE FUNCTION app.reward_uploaded_entry_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE stage text;actor_roles text[];min_salary bigint;new_salary bigint;
BEGIN
 IF NEW.uploaded_award IS NOT DISTINCT FROM OLD.uploaded_award THEN RETURN NEW;END IF;
 IF NOT EXISTS(SELECT 1 FROM reward_uploaded_review WHERE unit_id=NEW.unit_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Uploaded money requires an uploaded review';END IF;
 SELECT status INTO stage FROM reward_unit WHERE id=NEW.unit_id AND tenant_id=NEW.tenant_id;SELECT ARRAY(SELECT app.reward_roles(NEW.unit_id)) INTO actor_roles;
 IF stage IN('approved','posted','withdrawn','rejected') OR NOT(stage='draft' AND actor_roles && ARRAY['bu','gr'] OR stage=ANY(actor_roles)) THEN RAISE EXCEPTION 'Only the current approver may adjust uploaded awards';END IF;
 IF NEW.uploaded_award IS NOT NULL THEN
  IF NOT app.reward_private_entry_visible(NEW.unit_id,NEW.id) THEN RAISE EXCEPTION 'Restricted uploaded line';END IF;
  IF NEW.uploaded_award->>'employmentId'<>NEW.employment_id::text OR NEW.uploaded_award->>'incrementType' NOT IN('merit','promotion','special') THEN RAISE EXCEPTION 'Invalid uploaded identity or increment type';END IF;
  min_salary:=(NEW.source->>'basicCents')::bigint;new_salary:=(NEW.uploaded_award->>'newBasicCents')::bigint;
  IF new_salary IS NULL OR new_salary<min_salary OR (NEW.uploaded_award->>'bonusCents')::bigint<0 OR (NEW.uploaded_award->>'lumpCents')::bigint<0 THEN RAISE EXCEPTION 'Invalid uploaded amounts or salary reduction';END IF;
  IF NEW.uploaded_award->>'incrementType'='promotion' AND NOT EXISTS(SELECT 1 FROM job_grade g WHERE g.tenant_id=NEW.tenant_id AND g.archived_at IS NULL AND regexp_replace(g.code,'^JG\s*','','i')=NEW.uploaded_award->>'newGrade') THEN RAISE EXCEPTION 'Promotion grade must be active';END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.reward_uploaded_entry_guard() FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_uploaded_entry_guard() TO ai_hr_app;
CREATE TRIGGER reward_uploaded_entry_guard BEFORE UPDATE OF uploaded_award ON reward_entry FOR EACH ROW EXECUTE FUNCTION app.reward_uploaded_entry_guard();
-- Whole-file payloads are never a directly readable application column. Native rows retain own-line filtering.
REVOKE SELECT ON reward_uploaded_version FROM ai_hr_app;
GRANT SELECT(id,tenant_id,unit_id,version,digest,uploaded_by,reason,evidence_name,evidence_mime,created_at) ON reward_uploaded_version TO ai_hr_app;
GRANT SELECT ON reward_uploaded_version TO ai_hr_reward_setup_reader;
CREATE POLICY reward_uploaded_version_owner_read ON reward_uploaded_version FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))));
ALTER FUNCTION app.reward_uploaded_binding() SECURITY DEFINER;
ALTER FUNCTION app.reward_uploaded_binding() OWNER TO ai_hr_reward_setup_reader;
CREATE FUNCTION app.reward_uploaded_evidence(wanted_unit uuid,wanted_version integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT jsonb_build_object('name',v.evidence_name,'mime',v.evidence_mime,'content',v.evidence_content) FROM reward_uploaded_version v
 WHERE v.tenant_id=app.current_tenant_id() AND v.unit_id=wanted_unit AND v.version=wanted_version AND v.evidence_content IS NOT NULL AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(v.unit_id)))
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v.rows) r JOIN reward_entry e ON e.employment_id=(r->>'employmentId')::uuid AND e.unit_id=v.unit_id AND e.tenant_id=v.tenant_id WHERE NOT app.reward_private_entry_visible(e.unit_id,e.id))
$$;
ALTER FUNCTION app.reward_uploaded_evidence(uuid,integer) OWNER TO ai_hr_reward_setup_reader;
GRANT EXECUTE ON FUNCTION app.reward_private_entry_visible(uuid,uuid) TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_uploaded_evidence(uuid,integer) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_uploaded_evidence(uuid,integer) TO ai_hr_app;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_reward_upload_reader') THEN CREATE ROLE ai_hr_reward_upload_reader NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_reward_upload_reader' AND(rolcanlogin OR rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe uploaded-cycle reader';END IF;
END $$;
GRANT USAGE ON SCHEMA public,app TO ai_hr_reward_upload_reader;
GRANT SELECT ON reward_unit,reward_uploaded_review TO ai_hr_reward_upload_reader;
GRANT EXECUTE ON FUNCTION app.current_tenant_id(),app.current_user_id(),app.reward_roles(uuid) TO ai_hr_reward_upload_reader;
CREATE POLICY reward_uploaded_cycle_units ON reward_unit FOR SELECT TO ai_hr_reward_upload_reader USING(tenant_id=app.current_tenant_id());
CREATE POLICY reward_uploaded_cycle_reviews ON reward_uploaded_review FOR SELECT TO ai_hr_reward_upload_reader USING(tenant_id=app.current_tenant_id());
CREATE FUNCTION app.reward_uploaded_cycle_ready(wanted_unit uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE cycle uuid;
BEGIN
 IF NOT 'payroll'=ANY(ARRAY(SELECT app.reward_roles(wanted_unit))) THEN RAISE EXCEPTION 'Payroll seat required';END IF;
 SELECT cycle_id INTO cycle FROM reward_unit WHERE id=wanted_unit AND tenant_id=app.current_tenant_id() AND deleted_at IS NULL;
 RETURN cycle IS NOT NULL AND NOT EXISTS(SELECT 1 FROM reward_unit u JOIN reward_uploaded_review r ON r.unit_id=u.id AND r.tenant_id=u.tenant_id WHERE u.tenant_id=app.current_tenant_id() AND u.cycle_id=cycle AND u.deleted_at IS NULL AND u.status NOT IN('approved','posted'));
END $$;
ALTER FUNCTION app.reward_uploaded_cycle_ready(uuid) OWNER TO ai_hr_reward_upload_reader;
REVOKE ALL ON FUNCTION app.reward_uploaded_cycle_ready(uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_uploaded_cycle_ready(uuid) TO ai_hr_app;

GRANT INSERT ON reward_company_exclusion,domain_event TO ai_hr_reward_setup_reader;
GRANT EXECUTE ON FUNCTION app.reward_exclusion_reason_trim(text) TO ai_hr_reward_setup_reader;
CREATE POLICY reward_upload_exclusion_insert ON reward_company_exclusion FOR INSERT TO ai_hr_reward_setup_reader WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(company_id,'manage') AND created_by=app.current_user_id());
