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

ALTER TABLE reward_unit ADD COLUMN uploaded_award_digest text CHECK(uploaded_award_digest IS NULL OR uploaded_award_digest~'^[a-f0-9]{64}$');
ALTER TABLE reward_company_exclusion ADD COLUMN award_type text NOT NULL DEFAULT 'no_awards' CHECK(award_type IN('no_awards','uploaded'));
CREATE TABLE reward_uploaded_review(unit_id uuid PRIMARY KEY REFERENCES reward_unit(id),tenant_id uuid NOT NULL REFERENCES tenant(id),current_version integer NOT NULL DEFAULT 0,checked_version integer,refresh_required boolean NOT NULL DEFAULT false,checked_by uuid REFERENCES app_user(id),checked_at timestamptz);
CREATE TABLE reward_uploaded_version(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),unit_id uuid NOT NULL REFERENCES reward_unit(id),version integer NOT NULL,rows jsonb NOT NULL CHECK(jsonb_typeof(rows)='array'),digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),input_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,import_content text,original_file_name text,uploaded_by uuid NOT NULL REFERENCES app_user(id),uploaded_by_person uuid REFERENCES person(id),reason text NOT NULL CHECK(length(trim(reason))>=10),evidence_name text,evidence_mime text,evidence_content text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,unit_id,version));
CREATE TABLE reward_uploaded_award(entry_id uuid PRIMARY KEY REFERENCES reward_entry(id),tenant_id uuid NOT NULL REFERENCES tenant(id),unit_id uuid NOT NULL REFERENCES reward_unit(id),award jsonb NOT NULL CHECK(jsonb_typeof(award)='object'),source_version integer NOT NULL,updated_by uuid NOT NULL REFERENCES app_user(id),updated_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(tenant_id,unit_id,source_version) REFERENCES reward_uploaded_version(tenant_id,unit_id,version));
ALTER TABLE reward_uploaded_award ENABLE ROW LEVEL SECURITY;ALTER TABLE reward_uploaded_award FORCE ROW LEVEL SECURITY;
CREATE POLICY reward_uploaded_award_read ON reward_uploaded_award FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.reward_private_entry_visible(unit_id,entry_id) AND ('gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))) OR EXISTS(SELECT 1 FROM reward_uploaded_review r WHERE r.unit_id=reward_uploaded_award.unit_id AND r.tenant_id=reward_uploaded_award.tenant_id AND r.current_version>0 AND r.checked_version=r.current_version)));
CREATE POLICY reward_uploaded_award_insert ON reward_uploaded_award FOR INSERT TO ai_hr_app WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_private_entry_visible(unit_id,entry_id) AND ('gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))) OR EXISTS(SELECT 1 FROM reward_uploaded_review r WHERE r.unit_id=reward_uploaded_award.unit_id AND r.tenant_id=reward_uploaded_award.tenant_id AND r.current_version>0 AND r.checked_version=r.current_version)) AND app.reward_capability(unit_id,'figures.edit') AND app.reward_not_viewing_as() AND updated_by=app.current_user_id());
CREATE POLICY reward_uploaded_award_update ON reward_uploaded_award FOR UPDATE TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.reward_private_entry_visible(unit_id,entry_id) AND ('gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))) OR EXISTS(SELECT 1 FROM reward_uploaded_review r WHERE r.unit_id=reward_uploaded_award.unit_id AND r.tenant_id=reward_uploaded_award.tenant_id AND r.current_version>0 AND r.checked_version=r.current_version)) AND app.reward_capability(unit_id,'figures.edit') AND app.reward_not_viewing_as()) WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_private_entry_visible(unit_id,entry_id) AND ('gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))) OR EXISTS(SELECT 1 FROM reward_uploaded_review r WHERE r.unit_id=reward_uploaded_award.unit_id AND r.tenant_id=reward_uploaded_award.tenant_id AND r.current_version>0 AND r.checked_version=r.current_version)) AND app.reward_capability(unit_id,'figures.edit') AND app.reward_not_viewing_as() AND updated_by=app.current_user_id());
CREATE POLICY reward_uploaded_award_delete ON reward_uploaded_award FOR DELETE TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.reward_private_entry_visible(unit_id,entry_id) AND ('gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))) OR EXISTS(SELECT 1 FROM reward_uploaded_review r WHERE r.unit_id=reward_uploaded_award.unit_id AND r.tenant_id=reward_uploaded_award.tenant_id AND r.current_version>0 AND r.checked_version=r.current_version)) AND app.reward_capability(unit_id,'figures.edit') AND app.reward_not_viewing_as());
GRANT SELECT,INSERT,UPDATE,DELETE ON reward_uploaded_award TO ai_hr_app;
GRANT SELECT ON reward_uploaded_award TO ai_hr_reward_setup_reader;
CREATE POLICY reward_uploaded_award_check_owner ON reward_uploaded_award FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))));

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
GRANT EXECUTE ON FUNCTION app.reward_confidentiality_floors(uuid,uuid[],date) TO ai_hr_reward_setup_reader;
CREATE FUNCTION app.reward_uploaded_snapshot_roster(wanted_unit uuid,wanted_snapshot date) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE u reward_unit%ROWTYPE;t uuid:=app.current_tenant_id();unit uuid:=wanted_unit;wanted_company uuid;wanted_year integer;row record;overlap boolean;pending_names text;company_tags jsonb;seen uuid[]:='{}';
BEGIN
 SELECT * INTO u FROM reward_unit WHERE id=wanted_unit AND tenant_id=t AND deleted_at IS NULL AND status='draft';
 IF u.id IS NULL OR NOT 'gr'=ANY(ARRAY(SELECT app.reward_roles(u.id))) OR NOT app.reward_setup_allowed(u.company_id,'manage') OR NOT app.reward_not_viewing_as() OR NOT EXISTS(SELECT 1 FROM reward_uploaded_review WHERE unit_id=u.id AND tenant_id=t) THEN RAISE EXCEPTION 'Group Rewards draft upload authority required';END IF;
 wanted_company:=u.company_id;wanted_year:=(u.policy->>'year')::integer;
 company_tags:=app.reward_company_structure(wanted_company,wanted_snapshot);IF company_tags->>'status' IS DISTINCT FROM 'ready' OR nullif(company_tags->>'businessUnitId','')::uuid IS DISTINCT FROM u.business_unit_id THEN RAISE EXCEPTION 'Confirm the company Business unit before refreshing the upload';END IF;
 SELECT string_agg(coalesce(e.employee_code,e.id::text)||' · '||pe.full_name,'; ' ORDER BY e.employee_code,e.id) INTO pending_names FROM employment e JOIN person pe ON pe.id=e.person_id AND pe.tenant_id=e.tenant_id WHERE e.tenant_id=t AND e.hired_on<=wanted_snapshot AND(e.terminated_on IS NULL OR e.terminated_on>wanted_snapshot) AND app.reward_source_org_tags(e.id,wanted_snapshot)->>'companyId'=wanted_company::text AND coalesce(app.reward_source_org_tags(e.id,wanted_snapshot)->>'status','pending') NOT IN('legacy','ready');
 IF pending_names IS NOT NULL THEN RAISE EXCEPTION 'Group structure tagging is pending: %',pending_names;END IF;
 SELECT EXISTS(SELECT 1 FROM employment e JOIN assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id WHERE e.tenant_id=t AND app.reward_source_org_tags(e.id,wanted_snapshot)->>'companyId'=wanted_company::text AND e.hired_on<=wanted_snapshot AND(e.terminated_on IS NULL OR e.terminated_on>wanted_snapshot) AND a.valid_from<=wanted_snapshot AND(a.valid_to IS NULL OR a.valid_to>wanted_snapshot) AND a.superseded_at IS NULL GROUP BY e.id HAVING count(*)>1) INTO overlap;
 IF overlap THEN RAISE EXCEPTION 'An employee has overlapping assignments; correct Personnel before creating reviews';END IF;
 FOR row IN SELECT e.*,a.id AS assignment_id,a.position_id AS assignment_position_id,j.code AS grade_code,pe.full_name,comp.id AS compensation_id,comp.basic_salary,comp.currency AS comp_currency,comp.pay_mode,comp.valid_from AS pay_from,pr.id AS review_id,pr.overall_rating
 FROM employment e JOIN person pe ON pe.id=e.person_id AND pe.tenant_id=e.tenant_id JOIN assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id
 LEFT JOIN job_grade j ON j.id=e.grade_id AND j.tenant_id=e.tenant_id
 LEFT JOIN LATERAL(SELECT * FROM compensation c WHERE c.employment_id=e.id AND c.tenant_id=e.tenant_id AND c.valid_from<=wanted_snapshot AND(c.valid_to IS NULL OR c.valid_to>wanted_snapshot) AND c.superseded_at IS NULL ORDER BY c.valid_from DESC,c.id DESC LIMIT 1)comp ON true
 LEFT JOIN LATERAL(SELECT r.id,r.overall_rating FROM performance_review r JOIN review_cycle c ON c.id=r.cycle_id AND c.tenant_id=r.tenant_id WHERE r.employment_id=e.id AND r.tenant_id=e.tenant_id AND r.closed_at IS NOT NULL AND c.period_start<=make_date(wanted_year,12,31) AND c.period_end>=make_date(wanted_year,1,1) ORDER BY r.closed_at DESC,r.id DESC LIMIT 1)pr ON true
 WHERE e.tenant_id=t AND app.reward_source_org_tags(e.id,wanted_snapshot)->>'companyId'=wanted_company::text AND e.hired_on<=wanted_snapshot AND(e.terminated_on IS NULL OR e.terminated_on>wanted_snapshot) AND a.valid_from<=wanted_snapshot AND(a.valid_to IS NULL OR a.valid_to>wanted_snapshot) AND a.superseded_at IS NULL
 LOOP
 INSERT INTO reward_entry(tenant_id,unit_id,employment_id,source,facts,recommendation) VALUES(t,unit,row.id,jsonb_build_object('employmentId',row.id,'assignmentId',row.assignment_id,'positionId',row.assignment_position_id,'personId',row.person_id,'compensationId',row.compensation_id,'employeeCode',coalesce(row.employee_code,row.id::text),'name',row.full_name,'grade',regexp_replace(coalesce(row.grade_code,''),'^JG[[:space:]]*','','i'),'gradeId',row.grade_id,'basicCents',coalesce(round(row.basic_salary*100),0),'currency',coalesce(row.comp_currency,'MYR'),'payMode',coalesce(row.pay_mode,'monthly'),'hiredOn',row.hired_on,'confirmedOn',row.confirmation_date,'notice',(row.tender_resignation_date IS NOT NULL AND row.tender_resignation_date<=wanted_snapshot) OR(row.resignation_date IS NOT NULL AND row.resignation_date<=wanted_snapshot),'lastPayChange',CASE WHEN row.pay_from>row.hired_on THEN row.pay_from ELSE NULL END,'confirmationPayChange',coalesce(row.pay_from=row.confirmation_date AND row.pay_from>row.hired_on,false),'performanceReviewId',row.review_id,'performanceRating',row.overall_rating,'architecture',app.reward_architecture_for_source(unit,row.id,row.assignment_position_id,wanted_snapshot),'payChanges',coalesce((SELECT jsonb_agg(jsonb_build_object('on',x.valid_from,'basicCents',round(x.basic_salary*100),'kind',NULL) ORDER BY x.valid_from,x.id) FROM(SELECT c.*,lag(c.basic_salary)over(ORDER BY c.valid_from,c.id) AS prior_basic FROM compensation c WHERE c.employment_id=row.id AND c.tenant_id=t AND c.superseded_at IS NULL)x WHERE x.prior_basic IS NOT NULL AND x.basic_salary<>x.prior_basic AND x.valid_from>row.hired_on AND x.valid_from BETWEEN make_date(wanted_year,1,1) AND make_date(wanted_year+1,12,31)),'[]'::jsonb)),
 '{"talent":null,"performance":null,"confidentiality":"standard","seniorPlan":false,"erCase":false,"pipCase":false,"erDecision":"pending","pipDecision":"pending","caseReason":"","segment":"","branch":"","reviewed":false}'::jsonb,
 '{"meritBp":null,"promotionGrade":null,"promotionBp":null,"specialBp":null,"multiplierBp":null,"bonusCents":null,"lumpCents":null,"reason":"","currentRoleSummary":"","proposedRoleSummary":""}'::jsonb) ON CONFLICT(unit_id,employment_id) DO UPDATE SET source=excluded.source||jsonb_strip_nulls(jsonb_build_object('confidentialityFloor',reward_entry.source->'confidentialityFloor','confidentialityReason',reward_entry.source->'confidentialityReason')),updated_at=now();
 seen:=array_append(seen,row.id);
 END LOOP;
 WITH floors AS (SELECT * FROM app.reward_confidentiality_floors(unit,seen,wanted_snapshot)), source_rows AS (
   SELECT e.id,f.level,f.manager_employment_id,
     CASE e.facts->>'confidentiality' WHEN 'ec' THEN 2 WHEN 'bg' THEN 1 ELSE 0 END current_rank,
     CASE e.source->>'confidentialityFloor' WHEN 'ec' THEN 2 WHEN 'bg' THEN 1 ELSE 0 END old_rank,
     CASE f.level WHEN 'ec' THEN 2 WHEN 'bg' THEN 1 ELSE 0 END new_rank
   FROM reward_entry e LEFT JOIN floors f ON f.employment_id=e.employment_id
   WHERE e.tenant_id=t AND e.unit_id=unit AND e.employment_id=ANY(seen)
 )
 UPDATE reward_entry e SET source=(e.source-ARRAY['confidentialityFloor','confidentialityReason'])||
     CASE WHEN f.level IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('confidentialityFloor',f.level,'confidentialityReason',jsonb_build_object('seat',f.level,'managerEmploymentId',f.manager_employment_id)) END,
   facts=e.facts||jsonb_build_object('reviewed',true,'confidentiality',CASE greatest(CASE WHEN f.current_rank>f.old_rank THEN f.current_rank ELSE 0 END,f.new_rank) WHEN 2 THEN 'ec' WHEN 1 THEN 'bg' ELSE 'standard' END),updated_at=now()
 FROM source_rows f WHERE e.id=f.id AND e.tenant_id=t AND e.unit_id=unit;
 UPDATE reward_entry e SET source=e.source||jsonb_build_object('leftOn',wanted_snapshot,'leftReason',CASE WHEN EXISTS(SELECT 1 FROM employment x WHERE x.id=e.employment_id AND x.tenant_id=t AND x.terminated_on<=wanted_snapshot) THEN 'terminated' ELSE 'moved' END),updated_at=now() WHERE e.unit_id=unit AND e.tenant_id=t AND NOT e.employment_id=ANY(seen);
END $$;
ALTER FUNCTION app.reward_uploaded_snapshot_roster(uuid,date) OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_uploaded_snapshot_roster(uuid,date) FROM PUBLIC,ai_hr_app;
GRANT SELECT ON reward_entry TO ai_hr_reward_setup_reader;
GRANT UPDATE(source,facts,updated_at) ON reward_entry TO ai_hr_reward_setup_reader;
GRANT UPDATE(snapshot_date,revision,approved_digest,updated_at) ON reward_unit TO ai_hr_reward_setup_reader;
CREATE FUNCTION app.reward_create_uploaded_unit(wanted_company uuid,wanted_business_unit uuid,wanted_cycle uuid,wanted_year integer,wanted_snapshot date,wanted_policy jsonb,wanted_cycle_name text DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();unit uuid:=gen_random_uuid();row record;overlap boolean;pending_names text;company_tags jsonb;
BEGIN
 PERFORM app.access_workforce_write_lock();PERFORM pg_advisory_xact_lock(hashtextextended(t::text||':company-year:'||wanted_company::text||':'||wanted_year::text,2203));
 IF NOT app.reward_setup_allowed(wanted_company,'manage') OR NOT app.reward_not_viewing_as() THEN RAISE EXCEPTION 'Group Rewards creation authority required';END IF;
 company_tags:=app.reward_company_structure(wanted_company,wanted_snapshot);IF company_tags->>'status' IS DISTINCT FROM 'ready' OR nullif(company_tags->>'businessUnitId','')::uuid IS DISTINCT FROM wanted_business_unit THEN RAISE EXCEPTION 'Confirmed dated company Business unit required for an uploaded review';END IF;
 IF wanted_snapshot>timezone('Asia/Kuala_Lumpur',now())::date OR wanted_policy->>'year'<>wanted_year::text OR(wanted_cycle IS NOT NULL AND NOT EXISTS(SELECT 1 FROM reward_cycle WHERE id=wanted_cycle AND tenant_id=t AND year=wanted_year)) OR NOT EXISTS(SELECT 1 FROM reward_company_exclusion WHERE tenant_id=t AND company_id=wanted_company AND year=wanted_year AND ended_at IS NULL AND award_type='uploaded') THEN RAISE EXCEPTION 'Select an uploaded-awards company and current cycle';END IF;
 IF EXISTS(SELECT 1 FROM reward_company_year_review WHERE tenant_id=t AND company_id=wanted_company AND year=wanted_year) OR EXISTS(SELECT 1 FROM reward_unit u JOIN reward_cycle c ON c.id=u.cycle_id AND c.tenant_id=u.tenant_id WHERE u.tenant_id=t AND u.company_id=wanted_company AND c.year=wanted_year AND u.deleted_at IS NULL AND u.kind='annual') THEN RAISE EXCEPTION 'Company already has a review for this year';END IF;
 IF wanted_cycle IS NULL THEN IF NOT app.reward_setup_allowed(NULL,'manage') OR length(trim(coalesce(wanted_cycle_name,''))) NOT BETWEEN 1 AND 160 THEN RAISE EXCEPTION 'Group-wide Rewards authority and a cycle name are required';END IF;INSERT INTO reward_cycle(tenant_id,name,year,created_by) VALUES(t,trim(wanted_cycle_name),wanted_year,actor) RETURNING id INTO wanted_cycle;END IF;
 INSERT INTO reward_unit(id,tenant_id,created_by,cycle_id,company_id,business_unit_id,policy,snapshot_date) VALUES(unit,t,actor,wanted_cycle,wanted_company,wanted_business_unit,wanted_policy,wanted_snapshot);
 INSERT INTO reward_company_year_review VALUES(t,wanted_company,wanted_year,unit,'uploaded');
 INSERT INTO reward_member(tenant_id,unit_id,user_id,role,valid_from) VALUES(t,unit,actor,'gr',timezone('Asia/Kuala_Lumpur',now())::date);INSERT INTO reward_uploaded_review(unit_id,tenant_id) VALUES(unit,t);
 PERFORM app.reward_uploaded_snapshot_roster(unit,wanted_snapshot);
 RETURN unit;
END $$;
ALTER FUNCTION app.reward_create_uploaded_unit(uuid,uuid,uuid,integer,date,jsonb,text) OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_create_uploaded_unit(uuid,uuid,uuid,integer,date,jsonb,text) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_create_uploaded_unit(uuid,uuid,uuid,integer,date,jsonb,text) TO ai_hr_app;

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
  IF OLD.refresh_required AND NOT NEW.refresh_required AND NEW.current_version=OLD.current_version THEN RAISE EXCEPTION 'Refreshed sources require a new upload version';END IF;
  IF NEW.current_version<>OLD.current_version THEN
   IF NEW.current_version<>OLD.current_version+1 OR NEW.checked_by IS NOT NULL OR NEW.checked_version IS NOT NULL OR NEW.checked_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM reward_uploaded_version v WHERE v.tenant_id=NEW.tenant_id AND v.unit_id=NEW.unit_id AND v.version=NEW.current_version AND v.uploaded_by=app.current_user_id()) THEN RAISE EXCEPTION 'Replacement must append the doer current version and reset confirmation';END IF;
  ELSIF NEW.checked_by IS NOT NULL AND (OLD.checked_by IS NOT NULL OR NEW.checked_at IS NULL OR NOT EXISTS(SELECT 1 FROM reward_uploaded_version v WHERE v.unit_id=NEW.unit_id AND v.tenant_id=NEW.tenant_id AND v.version=NEW.current_version AND (SELECT coalesce(jsonb_agg(x.value-ARRAY['incrementCents','warnings'] ORDER BY x.value->>'employmentId'),'[]'::jsonb) FROM jsonb_array_elements(v.rows)x)=(SELECT coalesce(jsonb_agg(a.award ORDER BY e.employment_id::text),'[]'::jsonb) FROM reward_uploaded_award a JOIN reward_entry e ON e.id=a.entry_id AND e.unit_id=a.unit_id AND e.tenant_id=a.tenant_id WHERE a.unit_id=NEW.unit_id AND a.tenant_id=NEW.tenant_id))) THEN RAISE EXCEPTION 'Checker must confirm the unchanged current upload';END IF;
 END IF;
 IF TG_TABLE_NAME='reward_uploaded_version' THEN
  SELECT person_id INTO NEW.uploaded_by_person FROM app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id();
  NEW.input_snapshot:=(SELECT coalesce(jsonb_agg(jsonb_build_object('employmentId',e.employment_id,'source',e.source,'facts',e.facts) ORDER BY e.employment_id),'[]'::jsonb) FROM reward_entry e WHERE e.unit_id=NEW.unit_id AND e.tenant_id=NEW.tenant_id AND EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.rows) r WHERE r->>'employmentId'=e.employment_id::text));
  NEW.digest:=encode(sha256(convert_to(NEW.rows::text||NEW.input_snapshot::text||coalesce(NEW.import_content,'')||coalesce(NEW.evidence_content,''),'UTF8')),'hex');
  IF NEW.uploaded_by<>app.current_user_id() OR NOT EXISTS(SELECT 1 FROM reward_unit u JOIN reward_uploaded_review r ON r.unit_id=u.id AND r.tenant_id=u.tenant_id WHERE u.id=NEW.unit_id AND u.tenant_id=NEW.tenant_id AND u.status='draft' AND NEW.version=r.current_version+1) THEN RAISE EXCEPTION 'Upload versions are append-only at BU stage';END IF;
 END IF;
 IF TG_TABLE_NAME='reward_uploaded_review' THEN
 IF NEW.checked_by IS NOT NULL AND (NEW.refresh_required OR NOT app.reward_uploaded_awards_editable(NEW.unit_id) OR coalesce((app.reward_uploaded_validation(NEW.unit_id)->>'valid')::boolean,false)=false) THEN RAISE EXCEPTION 'Another authorized checker must verify current valid uploaded awards';END IF;
 IF NEW.checked_by IS NOT NULL AND (NEW.checked_by<>app.current_user_id() OR NEW.checked_version<>NEW.current_version OR NOT EXISTS(SELECT 1 FROM reward_uploaded_version v WHERE v.unit_id=NEW.unit_id AND v.tenant_id=NEW.tenant_id AND v.version=NEW.current_version AND v.uploaded_by<>NEW.checked_by AND(v.uploaded_by_person IS NULL OR v.uploaded_by_person IS DISTINCT FROM(SELECT person_id FROM app_user WHERE id=NEW.checked_by AND tenant_id=NEW.tenant_id)))) THEN RAISE EXCEPTION 'A different Group Rewards checker must confirm the current version';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER reward_uploaded_binding BEFORE INSERT OR UPDATE ON reward_uploaded_review FOR EACH ROW EXECUTE FUNCTION app.reward_uploaded_binding();
CREATE TRIGGER reward_uploaded_version_binding BEFORE INSERT ON reward_uploaded_version FOR EACH ROW EXECUTE FUNCTION app.reward_uploaded_binding();
REVOKE ALL ON FUNCTION app.reward_uploaded_binding() FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_uploaded_binding() TO ai_hr_app,ai_hr_reward_setup_reader;
CREATE TRIGGER reward_uploaded_review_readonly BEFORE INSERT OR UPDATE OR DELETE ON reward_uploaded_review FOR EACH ROW EXECUTE FUNCTION app.reward_view_as_write_guard();
CREATE TRIGGER reward_uploaded_version_readonly BEFORE INSERT OR UPDATE OR DELETE ON reward_uploaded_version FOR EACH ROW EXECUTE FUNCTION app.reward_view_as_write_guard();

-- Whole-file payloads are never a directly readable application column. Native rows retain own-line filtering.
REVOKE SELECT ON reward_uploaded_version FROM ai_hr_app;
GRANT SELECT(id,tenant_id,unit_id,version,digest,uploaded_by,reason,evidence_name,evidence_mime,created_at) ON reward_uploaded_version TO ai_hr_app;
GRANT SELECT ON reward_uploaded_version TO ai_hr_reward_setup_reader;
CREATE POLICY reward_uploaded_version_owner_read ON reward_uploaded_version FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))));
ALTER FUNCTION app.reward_uploaded_binding() SECURITY DEFINER;
ALTER FUNCTION app.reward_uploaded_binding() OWNER TO ai_hr_reward_setup_reader;
CREATE FUNCTION app.reward_uploaded_evidence(wanted_unit uuid,wanted_version integer) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT jsonb_build_object('name',v.evidence_name,'mime',v.evidence_mime,'content',v.evidence_content) FROM reward_uploaded_version v
 WHERE v.tenant_id=app.current_tenant_id() AND v.unit_id=wanted_unit AND v.version=wanted_version AND v.evidence_content IS NOT NULL AND app.reward_not_viewing_as() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(v.unit_id)))
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
GRANT SELECT ON reward_member,app_user,employment TO ai_hr_reward_upload_reader;
GRANT SELECT(uploaded_by,tenant_id,unit_id,version) ON reward_uploaded_version TO ai_hr_reward_upload_reader;
GRANT EXECUTE ON FUNCTION app.reward_member_eligible_internal(uuid),app.is_admin(),app.reward_admin(uuid) TO ai_hr_reward_upload_reader;
CREATE POLICY reward_upload_notice_member ON reward_member FOR SELECT TO ai_hr_reward_upload_reader USING(tenant_id=app.current_tenant_id());
CREATE POLICY reward_upload_notice_user ON app_user FOR SELECT TO ai_hr_reward_upload_reader USING(tenant_id=app.current_tenant_id());
CREATE POLICY reward_upload_notice_employment ON employment FOR SELECT TO ai_hr_reward_upload_reader USING(tenant_id=app.current_tenant_id());
CREATE POLICY reward_upload_notice_version ON reward_uploaded_version FOR SELECT TO ai_hr_reward_upload_reader USING(tenant_id=app.current_tenant_id());
CREATE FUNCTION app.reward_upload_checker_recipients(wanted_unit uuid) RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT DISTINCT e.id FROM reward_unit r JOIN reward_uploaded_review s ON s.unit_id=r.id AND s.tenant_id=r.tenant_id JOIN reward_uploaded_version v ON v.unit_id=r.id AND v.tenant_id=r.tenant_id AND v.version=s.current_version JOIN reward_member m ON m.unit_id=r.id AND m.tenant_id=r.tenant_id JOIN app_user u ON u.id=m.user_id AND u.tenant_id=r.tenant_id JOIN employment e ON e.person_id=u.person_id AND e.tenant_id=r.tenant_id
 WHERE r.id=wanted_unit AND r.tenant_id=app.current_tenant_id() AND r.deleted_at IS NULL AND r.status='draft' AND s.current_version>0 AND s.checked_version IS DISTINCT FROM s.current_version AND m.role='gr' AND m.user_id<>v.uploaded_by AND (v.uploaded_by_person IS NULL OR v.uploaded_by_person IS DISTINCT FROM u.person_id) AND app.reward_member_eligible_internal(m.id) AND e.hired_on<=timezone('Asia/Kuala_Lumpur',now())::date AND e.terminated_on IS NULL AND app.is_admin() AND(app.current_user_id() IS NULL OR app.reward_admin(r.company_id))
$$;
ALTER FUNCTION app.reward_upload_checker_recipients(uuid) OWNER TO ai_hr_reward_upload_reader;
REVOKE ALL ON FUNCTION app.reward_upload_checker_recipients(uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_upload_checker_recipients(uuid) TO ai_hr_app;
GRANT SELECT ON reward_entry,compensation TO ai_hr_reward_upload_reader;
CREATE POLICY reward_upload_source_entry ON reward_entry FOR SELECT TO ai_hr_reward_upload_reader USING(tenant_id=app.current_tenant_id());
CREATE POLICY reward_upload_source_comp ON compensation FOR SELECT TO ai_hr_reward_upload_reader USING(tenant_id=app.current_tenant_id());
CREATE FUNCTION app.reward_uploaded_source_current_internal(wanted_unit uuid,wanted_employment uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS(SELECT 1 FROM reward_unit u JOIN reward_entry r ON r.unit_id=u.id AND r.tenant_id=u.tenant_id JOIN employment e ON e.id=r.employment_id AND e.tenant_id=u.tenant_id
 JOIN LATERAL(SELECT c.id,c.basic_salary,c.currency,c.pay_mode FROM compensation c WHERE c.tenant_id=e.tenant_id AND c.employment_id=e.id AND c.superseded_at IS NULL AND c.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND(c.valid_to IS NULL OR c.valid_to>timezone('Asia/Kuala_Lumpur',now())::date) ORDER BY c.valid_from DESC,c.id DESC LIMIT 1)c ON true
 WHERE u.id=wanted_unit AND u.tenant_id=app.current_tenant_id() AND u.deleted_at IS NULL AND r.employment_id=wanted_employment AND app.company_org_employment_company(e.id,timezone('Asia/Kuala_Lumpur',now())::date)=u.company_id AND(e.terminated_on IS NULL OR e.terminated_on>timezone('Asia/Kuala_Lumpur',now())::date) AND e.grade_id::text IS NOT DISTINCT FROM r.source->>'gradeId' AND c.id::text=r.source->>'compensationId' AND round(c.basic_salary*100)=(r.source->>'basicCents')::bigint AND c.currency=r.source->>'currency' AND c.pay_mode::text=r.source->>'payMode' AND EXISTS(SELECT 1 FROM app.reward_roles(u.id)))
$$;
ALTER FUNCTION app.reward_uploaded_source_current_internal(uuid,uuid) OWNER TO ai_hr_reward_upload_reader;
REVOKE ALL ON FUNCTION app.reward_uploaded_source_current_internal(uuid,uuid) FROM PUBLIC,ai_hr_app;

GRANT SELECT ON reward_uploaded_award TO ai_hr_reward_upload_reader;
GRANT UPDATE(uploaded_award_digest) ON reward_unit TO ai_hr_reward_upload_reader;
CREATE POLICY reward_upload_digest_write ON reward_unit FOR UPDATE TO ai_hr_reward_upload_reader USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM app.reward_roles(id))) WITH CHECK(tenant_id=app.current_tenant_id());
CREATE POLICY reward_upload_private_owner ON reward_uploaded_award FOR SELECT TO ai_hr_reward_upload_reader USING(tenant_id=app.current_tenant_id());
CREATE FUNCTION app.reward_uploaded_award_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
DECLARE r reward_entry%ROWTYPE;u reward_unit%ROWTYPE;a jsonb;wanted uuid;target uuid;version integer;roles text[];
BEGIN
 wanted:=CASE WHEN TG_OP='DELETE' THEN OLD.unit_id ELSE NEW.unit_id END;target:=CASE WHEN TG_OP='DELETE' THEN OLD.entry_id ELSE NEW.entry_id END;
 SELECT * INTO u FROM reward_unit WHERE id=wanted AND tenant_id=app.current_tenant_id();SELECT * INTO r FROM reward_entry WHERE id=target AND unit_id=wanted AND tenant_id=app.current_tenant_id();
 SELECT ARRAY(SELECT app.reward_roles(wanted)) INTO roles;
 IF NOT 'gr'=ANY(roles) AND NOT EXISTS(SELECT 1 FROM reward_uploaded_review WHERE unit_id=wanted AND tenant_id=app.current_tenant_id() AND current_version>0 AND checked_version=current_version) THEN RAISE EXCEPTION 'Independent upload confirmation required before approver edits';END IF;
 IF r.id IS NULL OR u.deleted_at IS NOT NULL OR u.status IN('approved','posted','withdrawn','rejected') OR NOT(u.status='draft' AND roles && ARRAY['bu','gr'] OR u.status=ANY(roles)) OR NOT app.reward_not_viewing_as() THEN RAISE EXCEPTION 'Only the current approver may change uploaded awards';END IF;
 IF TG_OP='DELETE' AND NOT(u.status='draft' AND 'gr'=ANY(roles) AND EXISTS(SELECT 1 FROM reward_uploaded_review r JOIN reward_uploaded_version v ON v.unit_id=r.unit_id AND v.tenant_id=r.tenant_id AND v.version=r.current_version+1 WHERE r.unit_id=wanted AND r.tenant_id=app.current_tenant_id() AND v.uploaded_by=app.current_user_id())) THEN RAISE EXCEPTION 'Whole-file removal requires a new Group Rewards upload version';END IF;
 IF TG_OP<>'DELETE' THEN
  IF NEW.tenant_id<>r.tenant_id OR TG_OP='UPDATE' AND(NEW.unit_id<>OLD.unit_id OR NEW.entry_id<>OLD.entry_id OR NEW.tenant_id<>OLD.tenant_id) THEN RAISE EXCEPTION 'Private uploaded award identity is immutable';END IF;
  SELECT current_version INTO version FROM reward_uploaded_review WHERE unit_id=wanted AND tenant_id=r.tenant_id;
  IF NEW.source_version=version THEN
   IF (u.status='draft' AND NOT 'bu'=ANY(roles)) OR NOT EXISTS(SELECT 1 FROM reward_uploaded_review WHERE unit_id=wanted AND tenant_id=r.tenant_id AND checked_version=current_version AND current_version>0) OR length(trim(coalesce(NEW.award->>'remarks','')))<10 THEN RAISE EXCEPTION 'Only the current approver may adjust a checked award with a reason';END IF;
  END IF;
  IF version IS NULL OR NOT(NEW.source_version=version OR u.status='draft' AND 'gr'=ANY(roles) AND NEW.source_version=version+1 AND EXISTS(SELECT 1 FROM reward_uploaded_version v WHERE v.unit_id=wanted AND v.tenant_id=r.tenant_id AND v.version=NEW.source_version AND v.uploaded_by=app.current_user_id())) THEN RAISE EXCEPTION 'Uploaded award version is stale';END IF;
  a:=NEW.award;IF jsonb_typeof(a->'newBasicCents') IS DISTINCT FROM 'number' OR jsonb_typeof(a->'bonusCents') IS DISTINCT FROM 'number' OR jsonb_typeof(a->'lumpCents') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Uploaded amounts must be nonnegative integer minor units';END IF;
  IF a->>'employmentId' IS DISTINCT FROM r.employment_id::text OR a->>'incrementType' IS NULL OR a->>'incrementType' NOT IN('merit','promotion','special') OR(a->>'newBasicCents')::numeric IS NULL OR(a->>'newBasicCents')::numeric<(r.source->>'basicCents')::numeric OR(a->>'newBasicCents')::numeric<>trunc((a->>'newBasicCents')::numeric) OR(a->>'bonusCents')::numeric<0 OR(a->>'lumpCents')::numeric<0 OR(a->>'bonusCents')::numeric<>trunc((a->>'bonusCents')::numeric) OR(a->>'lumpCents')::numeric<>trunc((a->>'lumpCents')::numeric) THEN RAISE EXCEPTION 'Invalid uploaded amounts or identity';END IF;
  IF a->>'incrementType'='promotion' AND (SELECT count(*) FROM job_grade g WHERE g.tenant_id=r.tenant_id AND app.architecture_grade_assignable(g.id) AND app.architecture_grade(g.code)=a->>'newGrade')<>1 THEN RAISE EXCEPTION 'Promotion grade must be active';END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION app.reward_uploaded_award_guard() FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_uploaded_award_guard() TO ai_hr_app;
CREATE TRIGGER reward_uploaded_award_guard BEFORE INSERT OR UPDATE OR DELETE ON reward_uploaded_award FOR EACH ROW EXECUTE FUNCTION app.reward_uploaded_award_guard();
CREATE TRIGGER reward_uploaded_award_readonly BEFORE INSERT OR UPDATE OR DELETE ON reward_uploaded_award FOR EACH ROW EXECUTE FUNCTION app.reward_view_as_write_guard();
CREATE FUNCTION app.reward_uploaded_digest_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE wanted uuid:=CASE WHEN TG_OP='DELETE' THEN OLD.unit_id ELSE NEW.unit_id END;
BEGIN
 UPDATE reward_unit SET uploaded_award_digest=(SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(entry_id,award,source_version) ORDER BY entry_id)::text,'[]'),'UTF8')),'hex') FROM reward_uploaded_award WHERE unit_id=wanted AND tenant_id=app.current_tenant_id()) WHERE id=wanted AND tenant_id=app.current_tenant_id();RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
ALTER FUNCTION app.reward_uploaded_digest_changed() OWNER TO ai_hr_reward_upload_reader;
CREATE TRIGGER reward_uploaded_digest_changed AFTER INSERT OR UPDATE OR DELETE ON reward_uploaded_award FOR EACH ROW EXECUTE FUNCTION app.reward_uploaded_digest_changed();
CREATE FUNCTION app.reward_uploaded_awards_for_post(wanted uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NOT app.reward_not_viewing_as() OR NOT EXISTS(SELECT 1 FROM reward_unit WHERE id=wanted AND tenant_id=app.current_tenant_id() AND deleted_at IS NULL AND status='approved' AND app.reward_admin(company_id) AND 'payroll'=ANY(ARRAY(SELECT app.reward_roles(id)))) THEN RAISE EXCEPTION 'Approved Payroll handoff authority required';END IF;
 RETURN(SELECT coalesce(jsonb_agg((award-'remarks')||jsonb_build_object('remarks','') ORDER BY entry_id),'[]'::jsonb) FROM reward_uploaded_award WHERE unit_id=wanted AND tenant_id=app.current_tenant_id());
END $$;
ALTER FUNCTION app.reward_uploaded_awards_for_post(uuid) OWNER TO ai_hr_reward_upload_reader;
REVOKE ALL ON FUNCTION app.reward_uploaded_awards_for_post(uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_uploaded_awards_for_post(uuid) TO ai_hr_app;
CREATE FUNCTION app.reward_uploaded_awards_editable(wanted uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT 'gr'=ANY(ARRAY(SELECT app.reward_roles(wanted))) AND NOT EXISTS(SELECT 1 FROM reward_uploaded_award a WHERE a.unit_id=wanted AND a.tenant_id=app.current_tenant_id() AND NOT app.reward_private_entry_visible(a.unit_id,a.entry_id))
$$;
ALTER FUNCTION app.reward_uploaded_awards_editable(uuid) OWNER TO ai_hr_reward_upload_reader;
GRANT EXECUTE ON FUNCTION app.reward_private_entry_visible(uuid,uuid) TO ai_hr_reward_upload_reader;
REVOKE ALL ON FUNCTION app.reward_uploaded_awards_editable(uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_uploaded_awards_editable(uuid) TO ai_hr_app;
CREATE FUNCTION app.reward_uploaded_validation(wanted uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE row record;a jsonb;basic numeric;next_basic numeric;bonus numeric;lump numeric;bp numeric;warning boolean:=false;seen integer:=0;yr integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM app.reward_roles(wanted)) THEN RAISE EXCEPTION 'Review seat required';END IF;
 SELECT(policy->>'year')::integer INTO yr FROM reward_unit WHERE id=wanted AND tenant_id=app.current_tenant_id() AND deleted_at IS NULL;
 FOR row IN SELECT x.award,e.source,e.facts,e.employment_id FROM reward_uploaded_award x JOIN reward_entry e ON e.id=x.entry_id AND e.unit_id=x.unit_id AND e.tenant_id=x.tenant_id WHERE x.unit_id=wanted AND x.tenant_id=app.current_tenant_id() LOOP
  seen:=seen+1;a:=row.award;basic:=(row.source->>'basicCents')::numeric;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(a) k WHERE k NOT IN('employmentId','incrementType','incrementBp','newBasicCents','newGrade','bonusCents','lumpCents','remarks')) OR a->>'employmentId' IS DISTINCT FROM row.employment_id::text OR a->>'incrementType' IS NULL OR a->>'incrementType' NOT IN('merit','promotion','special') OR basic<=0 OR row.source->>'currency'<>'MYR' OR row.source->>'leftOn' IS NOT NULL OR NOT app.reward_uploaded_source_current_internal(wanted,row.employment_id) THEN RETURN jsonb_build_object('valid',false,'warnings',warning);END IF;
  IF jsonb_typeof(a->'newBasicCents')<>'number' OR jsonb_typeof(a->'bonusCents')<>'number' OR jsonb_typeof(a->'lumpCents')<>'number' THEN RETURN jsonb_build_object('valid',false,'warnings',warning);END IF;
  next_basic:=(a->>'newBasicCents')::numeric;bonus:=(a->>'bonusCents')::numeric;lump:=(a->>'lumpCents')::numeric;
  IF next_basic IS NULL OR bonus IS NULL OR lump IS NULL OR next_basic<basic OR bonus<0 OR lump<0 OR greatest(next_basic,bonus,lump)>9007199254740991 OR next_basic<>trunc(next_basic) OR bonus<>trunc(bonus) OR lump<>trunc(lump) THEN RETURN jsonb_build_object('valid',false,'warnings',warning);END IF;
  IF a->>'incrementBp' IS NOT NULL THEN bp:=(a->>'incrementBp')::numeric;IF bp<0 OR bp>1000000 OR bp<>trunc(bp) OR next_basic<>basic+floor(basic*bp/10000+0.5) THEN RETURN jsonb_build_object('valid',false,'warnings',warning);END IF;END IF;
  IF a->>'incrementType'='promotion' THEN IF (SELECT count(*) FROM job_grade g WHERE g.tenant_id=app.current_tenant_id() AND app.architecture_grade_assignable(g.id) AND app.architecture_grade(g.code)=a->>'newGrade')<>1 THEN RETURN jsonb_build_object('valid',false,'warnings',warning);END IF;
  ELSIF a->>'newGrade' IS NOT NULL THEN RETURN jsonb_build_object('valid',false,'warnings',warning);END IF;
  bp:=floor((next_basic-basic)*10000/basic);
  warning:=warning OR coalesce((row.source->>'notice')::boolean,false) OR coalesce((row.facts->>'erCase')::boolean,false) OR row.source->>'hiredOn'>=make_date(yr,10,1)::text OR(row.source->>'lastPayChange' BETWEEN make_date(yr,10,1)::text AND make_date(yr,12,31)::text) OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(row.source->'payChanges','[]'::jsonb)) p WHERE p->>'on' BETWEEN make_date(yr,10,1)::text AND make_date(yr,12,31)::text) OR(a->>'incrementType'='promotion' AND bp>=3000) OR(a->>'incrementType'<>'promotion' AND bp>1000) OR bonus>basic*9;
 END LOOP;
 RETURN jsonb_build_object('valid',seen>0,'warnings',coalesce(warning,false));
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range OR division_by_zero THEN RETURN jsonb_build_object('valid',false,'warnings',false);
END $$;
GRANT SELECT ON job_grade TO ai_hr_reward_upload_reader;
CREATE POLICY reward_upload_grade_read ON job_grade FOR SELECT TO ai_hr_reward_upload_reader USING(tenant_id=app.current_tenant_id());
ALTER FUNCTION app.reward_uploaded_validation(uuid) OWNER TO ai_hr_reward_upload_reader;
REVOKE ALL ON FUNCTION app.reward_uploaded_validation(uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_uploaded_validation(uuid) TO ai_hr_app;
GRANT EXECUTE ON FUNCTION app.reward_uploaded_awards_editable(uuid),app.reward_uploaded_validation(uuid) TO ai_hr_reward_setup_reader;
CREATE POLICY reward_upload_participation_read ON reward_company_exclusion FOR SELECT TO ai_hr_app USING(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(company_id,'manage'));

CREATE FUNCTION app.reward_uploaded_atomic_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE wanted uuid:=CASE WHEN TG_OP='DELETE' THEN OLD.unit_id ELSE NEW.unit_id END;
BEGIN
 IF EXISTS(SELECT 1 FROM reward_uploaded_review r WHERE r.unit_id=wanted AND r.tenant_id=app.current_tenant_id() AND(r.current_version<>(SELECT coalesce(max(v.version),0) FROM reward_uploaded_version v WHERE v.unit_id=r.unit_id AND v.tenant_id=r.tenant_id) OR EXISTS(SELECT 1 FROM reward_uploaded_award a WHERE a.unit_id=r.unit_id AND a.tenant_id=r.tenant_id AND a.source_version<>r.current_version))) THEN RAISE EXCEPTION 'Upload version and all private awards must commit together';END IF;
 RETURN NULL;
END $$;
ALTER FUNCTION app.reward_uploaded_atomic_version() OWNER TO ai_hr_reward_upload_reader;
CREATE CONSTRAINT TRIGGER reward_uploaded_version_atomic AFTER INSERT ON reward_uploaded_version DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.reward_uploaded_atomic_version();
CREATE CONSTRAINT TRIGGER reward_uploaded_review_atomic AFTER INSERT OR UPDATE ON reward_uploaded_review DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.reward_uploaded_atomic_version();
CREATE CONSTRAINT TRIGGER reward_uploaded_award_atomic AFTER INSERT OR UPDATE OR DELETE ON reward_uploaded_award DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.reward_uploaded_atomic_version();

CREATE FUNCTION app.reward_uploaded_source_current(wanted_unit uuid,wanted_employment uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS(SELECT 1 FROM reward_entry e WHERE e.unit_id=wanted_unit AND e.employment_id=wanted_employment AND e.tenant_id=app.current_tenant_id() AND app.reward_private_entry_visible(e.unit_id,e.id) AND app.reward_uploaded_source_current_internal(wanted_unit,wanted_employment))
$$;
ALTER FUNCTION app.reward_uploaded_source_current(uuid,uuid) OWNER TO ai_hr_reward_upload_reader;
REVOKE ALL ON FUNCTION app.reward_uploaded_source_current(uuid,uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_uploaded_source_current(uuid,uuid) TO ai_hr_app;
GRANT SELECT(uploaded_by_person) ON reward_uploaded_version TO ai_hr_reward_upload_reader;
CREATE FUNCTION app.reward_uploaded_maker_same_person(wanted uuid,wanted_version integer) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT 'gr'=ANY(ARRAY(SELECT app.reward_roles(wanted))) AND EXISTS(SELECT 1 FROM reward_uploaded_version v JOIN app_user u ON u.id=app.current_user_id() AND u.tenant_id=v.tenant_id WHERE v.unit_id=wanted AND v.version=wanted_version AND v.tenant_id=app.current_tenant_id() AND v.uploaded_by_person IS NOT NULL AND v.uploaded_by_person=u.person_id)
$$;
ALTER FUNCTION app.reward_uploaded_maker_same_person(uuid,integer) OWNER TO ai_hr_reward_upload_reader;
REVOKE ALL ON FUNCTION app.reward_uploaded_maker_same_person(uuid,integer) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_uploaded_maker_same_person(uuid,integer) TO ai_hr_app;

GRANT EXECUTE ON FUNCTION app.architecture_grade_assignable(uuid),app.architecture_grade(text),app.architecture_grade_code(text) TO ai_hr_reward_upload_reader;

GRANT EXECUTE ON FUNCTION app.company_org_employment_company(uuid,date) TO ai_hr_reward_upload_reader;

CREATE FUNCTION app.reward_refresh_uploaded_sources(wanted_unit uuid,wanted_revision integer,why text) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE u reward_unit%ROWTYPE;t uuid:=app.current_tenant_id();day date:=timezone('Asia/Kuala_Lumpur',now())::date;
BEGIN
 PERFORM app.access_workforce_write_lock();SELECT * INTO u FROM reward_unit WHERE id=wanted_unit AND tenant_id=t AND deleted_at IS NULL FOR UPDATE;
 IF u.id IS NULL OR u.status<>'draft' OR u.revision<>wanted_revision OR length(trim(coalesce(why,''))) NOT BETWEEN 10 AND 2000 OR NOT 'gr'=ANY(ARRAY(SELECT app.reward_roles(u.id))) OR NOT app.reward_not_viewing_as() THEN RAISE EXCEPTION 'Reload the current BU-stage review and give a refresh reason';END IF;
 PERFORM app.reward_uploaded_snapshot_roster(wanted_unit,day);
 UPDATE reward_uploaded_review SET checked_version=NULL,checked_by=NULL,checked_at=NULL,refresh_required=true WHERE unit_id=u.id AND tenant_id=t;
 UPDATE reward_unit SET snapshot_date=day,revision=revision+1,approved_digest=NULL,updated_at=now() WHERE id=u.id AND tenant_id=t;
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(t,'reward-unit',u.id,'reward-unit.upload-source-refreshed','user',app.current_user_id(),jsonb_build_object('before',u.snapshot_date,'after',day,'revision',u.revision+1,'reason',trim(why)));
 RETURN u.revision+1;
END $$;
ALTER FUNCTION app.reward_refresh_uploaded_sources(uuid,integer,text) OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_refresh_uploaded_sources(uuid,integer,text) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_refresh_uploaded_sources(uuid,integer,text) TO ai_hr_app;

-- Uploaded money cannot enter or skip the approval route through a generic unit update.
CREATE FUNCTION app.reward_uploaded_route_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE upload reward_uploaded_review%ROWTYPE; roles text[]; needed text; action_name text; facts jsonb; last_actor uuid;
BEGIN
 IF NEW.status=OLD.status THEN RETURN NEW; END IF;
 SELECT * INTO upload FROM reward_uploaded_review WHERE unit_id=OLD.id AND tenant_id=OLD.tenant_id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF OLD.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT app.reward_not_viewing_as() THEN RAISE EXCEPTION 'Uploaded review route is not writable'; END IF;
 roles:=ARRAY(SELECT app.reward_roles(OLD.id));
 IF NEW.status='withdrawn' AND OLD.status NOT IN('posted','rejected','withdrawn') AND ('gr'=ANY(roles) OR app.reward_admin(OLD.company_id)) AND NEW.revision=OLD.revision+1 AND NEW.approved_digest IS NULL THEN RETURN NEW; END IF;
 IF NEW.status='posted' THEN
  IF OLD.status<>'approved' OR NOT 'payroll'=ANY(roles) OR NOT app.reward_admin(OLD.company_id) OR NEW.posted_at IS NULL OR upload.refresh_required OR upload.current_version=0 OR upload.checked_version IS DISTINCT FROM upload.current_version OR NOT app.reward_uploaded_cycle_ready(OLD.id) THEN RAISE EXCEPTION 'Only confirmed, approved uploaded awards may be posted by Payroll'; END IF;
  RETURN NEW;
 END IF;
 IF NOT app.reward_capability(OLD.id,'review.decide') THEN RAISE EXCEPTION 'Review decision authority is required'; END IF;
 IF NEW.status='draft' AND OLD.status IN('bg','gr','ctro','ec','approved') THEN
  IF NOT (OLD.status=ANY(roles) OR OLD.status='approved' AND roles&&ARRAY['gr','ctro','ec']) OR NEW.revision<>OLD.revision+1 OR NEW.approved_digest IS NOT NULL THEN RAISE EXCEPTION 'Only a current reviewer may return the uploaded review'; END IF;
  action_name:='return';
 ELSE
  needed:=CASE OLD.status WHEN 'draft' THEN 'bu' WHEN 'bg' THEN 'bg' WHEN 'gr' THEN 'gr' WHEN 'ctro' THEN 'ctro' WHEN 'ec' THEN 'ec' END;
  IF needed IS NULL OR NOT needed=ANY(roles) OR NEW.status IS DISTINCT FROM (CASE OLD.status WHEN 'draft' THEN 'bg' WHEN 'bg' THEN 'gr' WHEN 'gr' THEN 'ctro' WHEN 'ctro' THEN 'ec' WHEN 'ec' THEN 'approved' END) THEN RAISE EXCEPTION 'Uploaded reviews must follow the normal approval sequence'; END IF;
  action_name:=CASE OLD.status WHEN 'draft' THEN 'submit' ELSE 'approve' END;
  IF upload.refresh_required OR upload.current_version=0 OR upload.checked_version IS DISTINCT FROM upload.current_version OR NEW.revision<>OLD.revision OR NEW.approved_digest IS NULL OR(OLD.status<>'draft' AND NEW.approved_digest IS DISTINCT FROM OLD.approved_digest) THEN RAISE EXCEPTION 'Confirm the unchanged upload independently before approving'; END IF;
  facts:=app.reward_uploaded_validation(OLD.id);
  IF NOT coalesce((facts->>'valid')::boolean,false) THEN RAISE EXCEPTION 'An uploaded award fails current validation'; END IF;
  SELECT d.actor_id INTO last_actor FROM reward_decision d WHERE d.tenant_id=OLD.tenant_id AND d.unit_id=OLD.id AND d.revision=OLD.revision AND d.to_stage=OLD.status ORDER BY d.created_at DESC,d.id DESC LIMIT 1;
  IF action_name='approve' AND last_actor=app.current_user_id() THEN RAISE EXCEPTION 'A different reviewer must sign the next stage'; END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM reward_decision d WHERE d.tenant_id=OLD.tenant_id AND d.unit_id=OLD.id AND d.revision=OLD.revision AND d.actor_id=app.current_user_id() AND d.action=action_name AND d.from_stage=OLD.status AND d.to_stage=NEW.status AND (action_name='return' OR d.digest=NEW.approved_digest) AND (NOT coalesce((facts->>'warnings')::boolean,false) AND action_name<>'return' OR length(trim(d.reason))>=10) AND d.xmin=pg_current_xact_id()::text::xid) THEN RAISE EXCEPTION 'The uploaded review requires its authorized decision in the same transaction'; END IF;
 RETURN NEW;
END $$;
GRANT SELECT ON reward_decision,reward_role_permission,reward_page_grant,reward_setup_grant TO ai_hr_reward_upload_reader;
GRANT EXECUTE ON FUNCTION app.reward_not_viewing_as(),app.reward_capability(uuid,text),app.reward_role_native_capability(text,text),app.reward_member_eligible(uuid),app.reward_setup_allowed(uuid,text) TO ai_hr_reward_upload_reader;
ALTER FUNCTION app.reward_uploaded_route_guard() OWNER TO ai_hr_reward_upload_reader;
REVOKE ALL ON FUNCTION app.reward_uploaded_route_guard() FROM PUBLIC;
CREATE TRIGGER reward_uploaded_route_guard BEFORE UPDATE OF status ON reward_unit FOR EACH ROW EXECUTE FUNCTION app.reward_uploaded_route_guard();
