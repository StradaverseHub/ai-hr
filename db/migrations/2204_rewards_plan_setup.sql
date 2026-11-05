CREATE TABLE reward_plan_setup(
 tenant_id uuid NOT NULL REFERENCES tenant(id),version_id uuid NOT NULL,group_id uuid NOT NULL,year integer NOT NULL,
 company_ids uuid[] NOT NULL,cycle_name text NOT NULL CHECK(length(trim(cycle_name)) BETWEEN 1 AND 160),snapshot_date date NOT NULL,
 bindings jsonb NOT NULL CHECK(jsonb_typeof(bindings)='array'),state text NOT NULL CHECK(state IN('draft','pending','approved')),
 created_by uuid NOT NULL REFERENCES app_user(id),contributor_ids uuid[] NOT NULL,approved_by uuid REFERENCES app_user(id),approved_at timestamptz,
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 4000),revision integer NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,version_id),FOREIGN KEY(tenant_id,version_id) REFERENCES reward_policy_group_version(tenant_id,id),
 CHECK(cardinality(company_ids)>0),CHECK((state='approved')=(approved_by IS NOT NULL)),CHECK(approved_by IS NULL OR NOT approved_by=ANY(contributor_ids))
);
CREATE TABLE reward_plan_company(
 tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),year integer NOT NULL,
 plan_version_id uuid NOT NULL,salary_version_id uuid NOT NULL,bonus_version_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,company_id,year),FOREIGN KEY(tenant_id,plan_version_id) REFERENCES reward_plan_setup(tenant_id,version_id),
 FOREIGN KEY(tenant_id,salary_version_id) REFERENCES reward_library_version(tenant_id,id),FOREIGN KEY(tenant_id,bonus_version_id) REFERENCES reward_library_version(tenant_id,id)
);
CREATE TABLE reward_company_year_review(
 tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),year integer NOT NULL,
 unit_id uuid NOT NULL REFERENCES reward_unit(id),kind text NOT NULL CHECK(kind IN('planned','uploaded')),
 PRIMARY KEY(tenant_id,company_id,year),UNIQUE(tenant_id,unit_id)
);
CREATE TABLE reward_unit_setup(
 unit_id uuid PRIMARY KEY REFERENCES reward_unit(id),tenant_id uuid NOT NULL REFERENCES tenant(id),plan_version_id uuid NOT NULL,salary_version_id uuid NOT NULL,bonus_version_id uuid NOT NULL,pat_version_id uuid NOT NULL,
 pool_recalculation_required boolean NOT NULL DEFAULT false,previous_pat_version_id uuid,updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,plan_version_id) REFERENCES reward_plan_setup(tenant_id,version_id),FOREIGN KEY(tenant_id,salary_version_id) REFERENCES reward_library_version(tenant_id,id),FOREIGN KEY(tenant_id,bonus_version_id) REFERENCES reward_library_version(tenant_id,id),FOREIGN KEY(tenant_id,pat_version_id) REFERENCES reward_pat_version(tenant_id,id)
);
--> statement-breakpoint
ALTER TABLE reward_plan_setup ENABLE ROW LEVEL SECURITY;ALTER TABLE reward_plan_setup FORCE ROW LEVEL SECURITY;
ALTER TABLE reward_plan_company ENABLE ROW LEVEL SECURITY;ALTER TABLE reward_plan_company FORCE ROW LEVEL SECURITY;
ALTER TABLE reward_company_year_review ENABLE ROW LEVEL SECURITY;ALTER TABLE reward_company_year_review FORCE ROW LEVEL SECURITY;
ALTER TABLE reward_unit_setup ENABLE ROW LEVEL SECURITY;ALTER TABLE reward_unit_setup FORCE ROW LEVEL SECURITY;
CREATE POLICY reward_plan_setup_read ON reward_plan_setup FOR SELECT USING(tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM unnest(company_ids)c WHERE NOT app.reward_setup_allowed(c,'manage')));
CREATE POLICY reward_plan_setup_write ON reward_plan_setup FOR ALL USING(tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM unnest(company_ids)c WHERE NOT app.reward_setup_allowed(c,'manage'))) WITH CHECK(tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM unnest(company_ids)c WHERE NOT app.reward_setup_allowed(c,'manage')));
CREATE POLICY reward_plan_company_read ON reward_plan_company FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(company_id,'library_view'));
CREATE POLICY reward_plan_company_write ON reward_plan_company FOR ALL USING(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(company_id,'manage')) WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(company_id,'manage'));
CREATE POLICY reward_company_year_read ON reward_company_year_review FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(company_id,'library_view'));
CREATE POLICY reward_company_year_insert ON reward_company_year_review FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(company_id,'manage'));
CREATE POLICY reward_unit_setup_read ON reward_unit_setup FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.reward_access(unit_id));
CREATE POLICY reward_unit_setup_write ON reward_unit_setup FOR ALL USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM reward_unit u WHERE u.id=unit_id AND u.tenant_id=reward_unit_setup.tenant_id AND app.reward_setup_allowed(u.company_id,'manage'))) WITH CHECK(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM reward_unit u WHERE u.id=unit_id AND u.tenant_id=reward_unit_setup.tenant_id AND app.reward_setup_allowed(u.company_id,'manage')));
GRANT SELECT,INSERT,UPDATE ON reward_plan_setup,reward_plan_company,reward_unit_setup TO ai_hr_app;
GRANT SELECT,INSERT ON reward_company_year_review TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_setup_company_eligible(wanted_company uuid,wanted_year integer) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE classified boolean:=true;
BEGIN
 IF NOT app.reward_setup_allowed(wanted_company,'manage') OR NOT EXISTS(SELECT 1 FROM company c WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id() AND c.archived_at IS NULL AND c.currency='MYR') OR EXISTS(SELECT 1 FROM reward_company_exclusion e WHERE e.tenant_id=app.current_tenant_id() AND e.company_id=wanted_company AND e.year=wanted_year AND e.ended_at IS NULL) THEN RETURN false;END IF;
 IF to_regclass('public.company_registration_classification') IS NOT NULL THEN EXECUTE 'select not exists(select 1 from public.company_registration_classification where tenant_id=$1 and company_id=$2 and(entity_kind<>''legal_entity'' or is_test_entity))' INTO classified USING app.current_tenant_id(),wanted_company;END IF;
 RETURN classified;
END $$;
CREATE FUNCTION app.reward_setup_policy_source(wanted_version uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM reward_policy_group_version v WHERE v.id=wanted_version AND v.tenant_id=app.current_tenant_id()) OR NOT EXISTS(SELECT 1 FROM reward_policy_group_target t WHERE t.version_id=wanted_version AND t.tenant_id=app.current_tenant_id()) OR EXISTS(SELECT 1 FROM reward_policy_group_target t WHERE t.version_id=wanted_version AND t.tenant_id=app.current_tenant_id() AND NOT app.reward_setup_allowed(t.company_id,'manage')) THEN RAISE EXCEPTION 'Shared configuration is not in your Rewards scope' USING ERRCODE='42501';END IF;
 SELECT app.reward_policy_group_version_json(v.id)||jsonb_build_object('createdBy',v.created_by,'current',g.current_version_id=v.id) INTO result FROM reward_policy_group_version v JOIN reward_policy_group g ON g.id=v.group_id AND g.tenant_id=v.tenant_id WHERE v.id=wanted_version AND v.tenant_id=app.current_tenant_id();RETURN result;
END $$;
CREATE FUNCTION app.reward_library_used_by(wanted_version uuid) RETURNS TABLE(plan text,company text,year integer) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT v.name,c.legal_name,p.year FROM reward_plan_company p JOIN reward_policy_group_version v ON v.id=p.plan_version_id AND v.tenant_id=p.tenant_id JOIN company c ON c.id=p.company_id AND c.tenant_id=p.tenant_id
 WHERE p.tenant_id=app.current_tenant_id() AND(p.salary_version_id=wanted_version OR p.bonus_version_id=wanted_version) AND app.reward_setup_allowed(c.id,'library_view') ORDER BY v.name,c.legal_name,c.id
$$;
CREATE FUNCTION app.reward_library_locked(wanted_version uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT app.reward_setup_allowed(NULL,'library_view') AND EXISTS(SELECT 1 FROM reward_unit_setup s JOIN reward_unit u ON u.id=s.unit_id AND u.tenant_id=s.tenant_id WHERE s.tenant_id=app.current_tenant_id() AND(s.salary_version_id=wanted_version OR s.bonus_version_id=wanted_version) AND u.status<>'draft')
$$;
CREATE FUNCTION app.reward_applied_public_references(wanted_unit uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT jsonb_build_object('plan',jsonb_build_object('name',p.name,'version',p.revision),'salary',jsonb_build_object('name',sl.name,'version',sv.revision),'bonus',jsonb_build_object('name',bl.name,'version',bv.revision,'type',bv.data->>'type'),'pat',jsonb_build_object('status',CASE WHEN pv.inputs->>'actualCents' IS NOT NULL THEN 'final' ELSE 'provisional' END,'version',pv.revision))
 FROM reward_unit_setup s JOIN reward_unit u ON u.id=s.unit_id AND u.tenant_id=s.tenant_id JOIN reward_policy_group_version p ON p.id=s.plan_version_id AND p.tenant_id=s.tenant_id
 JOIN reward_library_version sv ON sv.id=s.salary_version_id AND sv.tenant_id=s.tenant_id JOIN reward_library sl ON sl.id=sv.library_id AND sl.tenant_id=sv.tenant_id
 JOIN reward_library_version bv ON bv.id=s.bonus_version_id AND bv.tenant_id=s.tenant_id JOIN reward_library bl ON bl.id=bv.library_id AND bl.tenant_id=bv.tenant_id JOIN reward_pat_version pv ON pv.id=s.pat_version_id AND pv.tenant_id=s.tenant_id
 WHERE s.unit_id=wanted_unit AND s.tenant_id=app.current_tenant_id() AND app.reward_access(wanted_unit)
$$;
REVOKE ALL ON FUNCTION app.reward_setup_company_eligible(uuid,integer),app.reward_setup_policy_source(uuid),app.reward_library_used_by(uuid),app.reward_library_locked(uuid),app.reward_applied_public_references(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_setup_company_eligible(uuid,integer),app.reward_setup_policy_source(uuid),app.reward_library_used_by(uuid),app.reward_library_locked(uuid),app.reward_applied_public_references(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_plan_setup_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF OLD.state='approved' OR NEW.tenant_id<>OLD.tenant_id OR NEW.version_id<>OLD.version_id OR NEW.group_id<>OLD.group_id OR NEW.year<>OLD.year OR NEW.created_by<>OLD.created_by THEN RAISE EXCEPTION 'Approved setup is immutable; create a shared configuration successor';END IF;
 IF NEW.state='approved' AND(OLD.state<>'pending' OR NEW.bindings IS DISTINCT FROM OLD.bindings OR NEW.company_ids IS DISTINCT FROM OLD.company_ids OR NEW.cycle_name<>OLD.cycle_name OR NEW.snapshot_date<>OLD.snapshot_date OR NEW.contributor_ids IS DISTINCT FROM OLD.contributor_ids OR NEW.approved_by<>app.current_user_id() OR app.current_user_id()=ANY(OLD.contributor_ids)) THEN RAISE EXCEPTION 'An independent Group Rewards checker must approve the exact pending setup';END IF;
 IF NEW.state<>'approved' THEN NEW.contributor_ids=(SELECT array_agg(DISTINCT x) FROM unnest(OLD.contributor_ids||ARRAY[app.current_user_id()])x);END IF;RETURN NEW;
END $$;
CREATE TRIGGER reward_plan_setup_immutable BEFORE UPDATE ON reward_plan_setup FOR EACH ROW EXECUTE FUNCTION app.reward_plan_setup_immutable();
REVOKE ALL ON FUNCTION app.reward_plan_setup_immutable() FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_plan_setup_immutable() TO ai_hr_app;
--> statement-breakpoint
-- Purpose owner cannot sign in, bypass RLS, own tables, create schema objects or be assumed by the runtime.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_reward_setup_reader') THEN CREATE ROLE ai_hr_reward_setup_reader NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_reward_setup_reader' AND(rolcanlogin OR rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe reward setup reader role';END IF;
END $$;
GRANT USAGE ON SCHEMA public,app TO ai_hr_reward_setup_reader;
GRANT EXECUTE ON FUNCTION app.current_tenant_id(),app.current_user_id(),app.login_blocked(uuid),app.reward_roles(uuid),app.reward_access(uuid),app.reward_setup_allowed(uuid,text),app.reward_policy_group_version_json(uuid) TO ai_hr_reward_setup_reader;
GRANT SELECT ON company,app_user,reward_unit,reward_cycle,reward_setup_grant,reward_library,reward_library_version,reward_pat_version,reward_plan_setup,reward_plan_company,reward_unit_setup,reward_policy_group,reward_policy_group_version,reward_policy_group_target,reward_company_exclusion TO ai_hr_reward_setup_reader;
CREATE POLICY reward_setup_source_company ON company FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id());
CREATE POLICY reward_setup_source_actor ON app_user FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND id=app.current_user_id());
CREATE POLICY reward_setup_source_policy_group ON reward_policy_group FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id());
CREATE POLICY reward_setup_source_policy_version ON reward_policy_group_version FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id());
CREATE POLICY reward_setup_source_policy_target ON reward_policy_group_target FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id());
CREATE POLICY reward_setup_source_exclusions ON reward_company_exclusion FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(company_id,'manage'));
ALTER FUNCTION app.reward_setup_company_eligible(uuid,integer) OWNER TO ai_hr_reward_setup_reader;
ALTER FUNCTION app.reward_setup_policy_source(uuid) OWNER TO ai_hr_reward_setup_reader;
ALTER FUNCTION app.reward_library_used_by(uuid) OWNER TO ai_hr_reward_setup_reader;
ALTER FUNCTION app.reward_library_locked(uuid) OWNER TO ai_hr_reward_setup_reader;
ALTER FUNCTION app.reward_applied_public_references(uuid) OWNER TO ai_hr_reward_setup_reader;
--> statement-breakpoint
DROP POLICY reward_plan_setup_write ON reward_plan_setup;
CREATE POLICY reward_plan_setup_insert ON reward_plan_setup FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND state='draft' AND created_by=app.current_user_id() AND app.current_user_id()=ANY(contributor_ids) AND NOT EXISTS(SELECT 1 FROM unnest(company_ids)c WHERE NOT app.reward_setup_allowed(c,'manage')));
CREATE POLICY reward_plan_setup_update ON reward_plan_setup FOR UPDATE USING(tenant_id=app.current_tenant_id() AND state<>'approved' AND NOT EXISTS(SELECT 1 FROM unnest(company_ids)c WHERE NOT app.reward_setup_allowed(c,'manage'))) WITH CHECK(tenant_id=app.current_tenant_id() AND NOT EXISTS(SELECT 1 FROM unnest(company_ids)c WHERE NOT app.reward_setup_allowed(c,'manage')));
CREATE FUNCTION app.reward_setup_links() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF TG_TABLE_NAME='reward_plan_setup' THEN
  IF NOT EXISTS(SELECT 1 FROM reward_policy_group_version v WHERE v.id=NEW.version_id AND v.tenant_id=NEW.tenant_id AND v.group_id=NEW.group_id AND (v.policy->>'year')::integer=NEW.year AND v.created_by=ANY(NEW.contributor_ids)) THEN RAISE EXCEPTION 'Plan must retain its exact source and all source contributors';END IF;
  IF (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(NEW.company_ids)x) IS DISTINCT FROM (SELECT array_agg(DISTINCT x.company_id ORDER BY x.company_id) FROM reward_policy_group_target x WHERE x.version_id=NEW.version_id AND x.tenant_id=NEW.tenant_id) OR jsonb_array_length(NEW.bindings)<>cardinality(NEW.company_ids) THEN RAISE EXCEPTION 'Plan company set must match its shared source';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.bindings)b WHERE NOT EXISTS(SELECT 1 FROM reward_policy_group_target x WHERE x.tenant_id=NEW.tenant_id AND x.version_id=NEW.version_id AND x.company_id=(b->>'companyId')::uuid AND x.business_unit_id=(b->>'businessUnitId')::uuid) OR NOT EXISTS(SELECT 1 FROM reward_library_version v JOIN reward_library l ON l.id=v.library_id AND l.tenant_id=v.tenant_id WHERE v.id=(b->>'salaryVersionId')::uuid AND v.tenant_id=NEW.tenant_id AND v.state='confirmed' AND l.kind='salary' AND l.year=NEW.year) OR NOT EXISTS(SELECT 1 FROM reward_library_version v JOIN reward_library l ON l.id=v.library_id AND l.tenant_id=v.tenant_id WHERE v.id=(b->>'bonusVersionId')::uuid AND v.tenant_id=NEW.tenant_id AND v.state='confirmed' AND l.kind='bonus' AND l.year=NEW.year AND(v.data->>'type'<>'branch' OR b->>'branchAcknowledged'='true'))) THEN RAISE EXCEPTION 'Plan requires exact shared targets and confirmed matching libraries';END IF;
  IF (SELECT count(DISTINCT b->>'companyId') FROM jsonb_array_elements(NEW.bindings)b)<>cardinality(NEW.company_ids) THEN RAISE EXCEPTION 'Each plan company has one binding';END IF;
 ELSIF TG_TABLE_NAME='reward_plan_company' THEN
  IF NOT EXISTS(SELECT 1 FROM reward_plan_setup p WHERE p.tenant_id=NEW.tenant_id AND p.version_id=NEW.plan_version_id AND p.state='approved' AND p.year=NEW.year AND NEW.company_id=ANY(p.company_ids) AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.bindings)b WHERE b->>'companyId'=NEW.company_id::text AND b->>'salaryVersionId'=NEW.salary_version_id::text AND b->>'bonusVersionId'=NEW.bonus_version_id::text)) THEN RAISE EXCEPTION 'Company assignment must match an independently approved plan';END IF;
 ELSIF TG_TABLE_NAME='reward_company_year_review' THEN
  IF NOT EXISTS(SELECT 1 FROM reward_unit u JOIN reward_cycle c ON c.id=u.cycle_id AND c.tenant_id=u.tenant_id WHERE u.id=NEW.unit_id AND u.tenant_id=NEW.tenant_id AND u.company_id=NEW.company_id AND c.year=NEW.year AND u.kind='annual') THEN RAISE EXCEPTION 'Review admission must match actual company and reward year';END IF;
 ELSIF TG_TABLE_NAME='reward_unit_setup' THEN
  IF NOT EXISTS(SELECT 1 FROM reward_unit u JOIN reward_plan_setup p ON p.version_id=NEW.plan_version_id AND p.tenant_id=u.tenant_id JOIN reward_pat_version v ON v.id=NEW.pat_version_id AND v.tenant_id=u.tenant_id WHERE u.id=NEW.unit_id AND u.tenant_id=NEW.tenant_id AND p.state='approved' AND v.state='confirmed' AND v.company_id=u.company_id AND v.year=p.year AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.bindings)b WHERE b->>'companyId'=u.company_id::text AND b->>'businessUnitId'=u.business_unit_id::text AND b->>'salaryVersionId'=NEW.salary_version_id::text AND b->>'bonusVersionId'=NEW.bonus_version_id::text)) THEN RAISE EXCEPTION 'Review setup must bind approved plan, libraries and confirmed company PAT';END IF;
  IF TG_OP='UPDATE' AND(NEW.unit_id<>OLD.unit_id OR NEW.tenant_id<>OLD.tenant_id OR NEW.plan_version_id<>OLD.plan_version_id OR NEW.salary_version_id<>OLD.salary_version_id OR NEW.bonus_version_id<>OLD.bonus_version_id) THEN RAISE EXCEPTION 'Consumed plan and library versions are immutable';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER reward_plan_setup_links BEFORE INSERT OR UPDATE ON reward_plan_setup FOR EACH ROW EXECUTE FUNCTION app.reward_setup_links();
CREATE TRIGGER reward_plan_company_links BEFORE INSERT OR UPDATE ON reward_plan_company FOR EACH ROW EXECUTE FUNCTION app.reward_setup_links();
CREATE TRIGGER reward_company_year_links BEFORE INSERT ON reward_company_year_review FOR EACH ROW EXECUTE FUNCTION app.reward_setup_links();
CREATE TRIGGER reward_unit_setup_links BEFORE INSERT OR UPDATE ON reward_unit_setup FOR EACH ROW EXECUTE FUNCTION app.reward_setup_links();
ALTER FUNCTION app.reward_setup_links() OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_setup_links() FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_setup_links() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_setup_plan_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT v.id FROM reward_policy_group_version v JOIN reward_policy_group g ON g.id=v.group_id AND g.tenant_id=v.tenant_id WHERE v.tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(NULL,'manage') AND v.revision=g.revision AND EXISTS(SELECT 1 FROM reward_policy_group_target x WHERE x.tenant_id=v.tenant_id AND x.version_id=v.id) ORDER BY g.name,g.id
$$;
ALTER FUNCTION app.reward_setup_plan_ids() OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_setup_plan_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_setup_plan_ids() TO ai_hr_app;
--> statement-breakpoint
-- Narrow public provenance projection can read only versions consumed by a review the caller may see.
CREATE POLICY reward_setup_reference_salary_bonus ON reward_library_version FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM reward_unit_setup s WHERE s.tenant_id=reward_library_version.tenant_id AND(s.salary_version_id=reward_library_version.id OR s.bonus_version_id=reward_library_version.id) AND app.reward_access(s.unit_id)));
CREATE POLICY reward_setup_reference_library ON reward_library FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM reward_library_version v JOIN reward_unit_setup s ON s.tenant_id=v.tenant_id AND(s.salary_version_id=v.id OR s.bonus_version_id=v.id) WHERE v.library_id=reward_library.id AND v.tenant_id=reward_library.tenant_id AND app.reward_access(s.unit_id)));
CREATE POLICY reward_setup_reference_pat ON reward_pat_version FOR SELECT TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM reward_unit_setup s WHERE s.tenant_id=reward_pat_version.tenant_id AND s.pat_version_id=reward_pat_version.id AND app.reward_access(s.unit_id)));

--> statement-breakpoint
CREATE FUNCTION app.reward_setup_policy_commit(p_group uuid,p_expected integer,p_name text,p_policy jsonb,p_targets jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE t uuid:=app.current_tenant_id();actor uuid:=app.current_user_id();g public.reward_policy_group%ROWTYPE;
 version_id uuid:=gen_random_uuid();next_revision integer;target jsonb;c uuid;b uuid;group_id uuid;
BEGIN
 IF NOT app.reward_setup_allowed(NULL,'manage') THEN RAISE EXCEPTION 'Global Group Rewards authority required' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF actor IS NULL OR p_expected IS NULL OR p_expected<0 OR p_name IS NULL OR p_name<>btrim(p_name) OR length(p_name) NOT BETWEEN 1 AND 100
  OR p_policy IS NULL OR jsonb_typeof(p_policy)<>'object' OR octet_length(p_policy::text)>100000
  OR COALESCE(p_policy->>'year','') !~ '^(20[0-9]{2}|21[0-9]{2}|2200)$'
  OR p_policy->>'seniorMembershipMode' IS DISTINCT FROM 'named-members' OR p_policy->'seniorGrades' IS DISTINCT FROM '[]'::jsonb
  OR p_policy->'lumpUnitCents' IS DISTINCT FROM 'null'::jsonb
  OR p_targets IS NULL OR jsonb_typeof(p_targets)<>'array' OR jsonb_array_length(p_targets)>500 OR (p_group IS NULL AND jsonb_array_length(p_targets)=0) THEN
  RAISE EXCEPTION 'reward policy group invalid' USING ERRCODE='23514'; END IF;
 IF p_group IS NULL THEN
  IF p_expected<>0 THEN RAISE EXCEPTION 'reward policy group changed' USING ERRCODE='40001'; END IF;
  group_id:=gen_random_uuid();next_revision:=1;
 ELSE
  SELECT * INTO g FROM public.reward_policy_group x WHERE x.id=p_group AND x.tenant_id=t FOR UPDATE;
  IF NOT FOUND OR g.revision<>p_expected THEN RAISE EXCEPTION 'reward policy group changed' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM reward_policy_group_target x WHERE x.tenant_id=t AND x.version_id=g.current_version_id AND NOT app.reward_setup_allowed(x.company_id,'manage')) THEN
   RAISE EXCEPTION 'reward policy group scope' USING ERRCODE='42501'; END IF;
  group_id:=g.id;next_revision:=g.revision+1;
 END IF;
 FOR target IN SELECT value FROM jsonb_array_elements(p_targets) LOOP
  IF jsonb_typeof(target)<>'object' OR NOT (target ?& ARRAY['companyId','businessUnitId']) OR (target-ARRAY['companyId','businessUnitId'])<>'{}'::jsonb THEN
   RAISE EXCEPTION 'reward policy group invalid' USING ERRCODE='23514'; END IF;
  c:=(target->>'companyId')::uuid;b:=(target->>'businessUnitId')::uuid;
  IF c IS NULL OR b IS NULL OR NOT app.reward_policy_pair_valid(t,c,b) OR NOT app.reward_setup_allowed(c,'manage') OR NOT app.reward_setup_company_eligible(c,(p_policy->>'year')::integer) THEN
   RAISE EXCEPTION 'reward policy group scope' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM public.reward_policy_group other_group
   JOIN public.reward_policy_group_version other_version ON other_version.id=other_group.current_version_id AND other_version.tenant_id=other_group.tenant_id
   JOIN public.reward_policy_group_target other_target ON other_target.version_id=other_version.id AND other_target.tenant_id=other_version.tenant_id
   WHERE other_group.tenant_id=t AND other_group.id IS DISTINCT FROM p_group AND other_target.company_id=c 
    AND other_version.policy->>'year'=p_policy->>'year') THEN
   RAISE EXCEPTION 'reward policy group overlaps another current configuration' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_array_elements(p_targets))<>(SELECT count(DISTINCT jsonb_build_array(value->>'companyId',value->>'businessUnitId')) FROM jsonb_array_elements(p_targets)) THEN
  RAISE EXCEPTION 'reward policy group invalid' USING ERRCODE='23514'; END IF;
 IF p_group IS NULL THEN
  INSERT INTO public.reward_policy_group(id,tenant_id,name,revision,current_version_id,created_by) VALUES(group_id,t,p_name,next_revision,version_id,actor);
 END IF;
 INSERT INTO public.reward_policy_group_version(id,tenant_id,group_id,revision,name,policy,policy_digest,created_by)
  VALUES(version_id,t,group_id,next_revision,p_name,p_policy,encode(sha256(convert_to(p_policy::text,'UTF8')),'hex'),actor);
 INSERT INTO public.reward_policy_group_target(tenant_id,version_id,company_id,business_unit_id)
  SELECT t,version_id,(value->>'companyId')::uuid,(value->>'businessUnitId')::uuid FROM jsonb_array_elements(p_targets);
 IF p_group IS NOT NULL THEN UPDATE public.reward_policy_group SET name=p_name,revision=next_revision,current_version_id=version_id WHERE id=group_id AND tenant_id=t; END IF;
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload)
  VALUES(t,'reward-policy-group',group_id,'reward-policy-group.setup-version-saved','user',actor,
   jsonb_build_object('beforeRevision',p_expected,'revision',next_revision,'versionId',version_id,'targets',p_targets,
    'policyDigest',encode(sha256(convert_to(p_policy::text,'UTF8')),'hex')));
 RETURN app.reward_policy_group_version_json(version_id);
END;
$$;

ALTER FUNCTION app.reward_setup_policy_commit(uuid,integer,text,jsonb,jsonb) OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_setup_policy_commit(uuid,integer,text,jsonb,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_setup_policy_commit(uuid,integer,text,jsonb,jsonb) TO ai_hr_app;
GRANT INSERT ON reward_policy_group,reward_policy_group_version,reward_policy_group_target,domain_event TO ai_hr_reward_setup_reader;
GRANT UPDATE ON reward_policy_group TO ai_hr_reward_setup_reader;
GRANT EXECUTE ON FUNCTION app.reward_policy_pair_valid(uuid,uuid,uuid,boolean) TO ai_hr_reward_setup_reader;
CREATE POLICY reward_setup_policy_group_insert ON reward_policy_group FOR INSERT TO ai_hr_reward_setup_reader WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.reward_setup_allowed(NULL,'manage'));
CREATE POLICY reward_setup_policy_group_update ON reward_policy_group FOR UPDATE TO ai_hr_reward_setup_reader USING(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(NULL,'manage')) WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(NULL,'manage'));
CREATE POLICY reward_setup_policy_version_insert ON reward_policy_group_version FOR INSERT TO ai_hr_reward_setup_reader WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.reward_setup_allowed(NULL,'manage'));
CREATE POLICY reward_setup_policy_target_insert ON reward_policy_group_target FOR INSERT TO ai_hr_reward_setup_reader WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(company_id,'manage'));
CREATE POLICY reward_setup_policy_event_insert ON domain_event FOR INSERT TO ai_hr_reward_setup_reader WITH CHECK(tenant_id=app.current_tenant_id() AND actor_id=app.current_user_id() AND event_type='reward-policy-group.setup-version-saved' AND app.reward_setup_allowed(NULL,'manage'));
--> statement-breakpoint
-- Existing permissive policies still parse their bounded authorization helpers for this purpose role.
GRANT EXECUTE ON FUNCTION app.reward_admin(uuid),app.is_admin(),app.is_group_admin(),app.acting_as_owner() TO ai_hr_reward_setup_reader;
