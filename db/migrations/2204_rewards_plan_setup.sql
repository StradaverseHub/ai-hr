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
CREATE FUNCTION app.reward_setup_links() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF TG_TABLE_NAME='reward_plan_company' THEN
  IF NOT EXISTS(SELECT 1 FROM reward_plan_setup p WHERE p.tenant_id=NEW.tenant_id AND p.version_id=NEW.plan_version_id AND p.state='approved' AND p.year=NEW.year AND NEW.company_id=ANY(p.company_ids) AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.bindings)b WHERE b->>'companyId'=NEW.company_id::text AND b->>'salaryVersionId'=NEW.salary_version_id::text AND b->>'bonusVersionId'=NEW.bonus_version_id::text)) THEN RAISE EXCEPTION 'Company assignment must match an independently approved plan';END IF;
 ELSIF TG_TABLE_NAME='reward_company_year_review' THEN
  IF NOT EXISTS(SELECT 1 FROM reward_unit u JOIN reward_cycle c ON c.id=u.cycle_id AND c.tenant_id=u.tenant_id WHERE u.id=NEW.unit_id AND u.tenant_id=NEW.tenant_id AND u.company_id=NEW.company_id AND c.year=NEW.year AND u.kind='annual') THEN RAISE EXCEPTION 'Review admission must match actual company and reward year';END IF;
 ELSIF TG_TABLE_NAME='reward_unit_setup' THEN
  IF NOT EXISTS(SELECT 1 FROM reward_unit u JOIN reward_plan_setup p ON p.version_id=NEW.plan_version_id AND p.tenant_id=u.tenant_id JOIN reward_pat_version v ON v.id=NEW.pat_version_id AND v.tenant_id=u.tenant_id WHERE u.id=NEW.unit_id AND u.tenant_id=NEW.tenant_id AND p.state='approved' AND v.state='confirmed' AND v.company_id=u.company_id AND v.year=p.year AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.bindings)b WHERE b->>'companyId'=u.company_id::text AND b->>'businessUnitId'=u.business_unit_id::text AND b->>'salaryVersionId'=NEW.salary_version_id::text AND b->>'bonusVersionId'=NEW.bonus_version_id::text)) THEN RAISE EXCEPTION 'Review setup must bind approved plan, libraries and confirmed company PAT';END IF;
  IF TG_OP='UPDATE' AND(NEW.unit_id<>OLD.unit_id OR NEW.tenant_id<>OLD.tenant_id OR NEW.plan_version_id<>OLD.plan_version_id OR NEW.salary_version_id<>OLD.salary_version_id OR NEW.bonus_version_id<>OLD.bonus_version_id) THEN RAISE EXCEPTION 'Consumed plan and library versions are immutable';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER reward_plan_company_links BEFORE INSERT OR UPDATE ON reward_plan_company FOR EACH ROW EXECUTE FUNCTION app.reward_setup_links();
CREATE TRIGGER reward_company_year_links BEFORE INSERT ON reward_company_year_review FOR EACH ROW EXECUTE FUNCTION app.reward_setup_links();
CREATE TRIGGER reward_unit_setup_links BEFORE INSERT OR UPDATE ON reward_unit_setup FOR EACH ROW EXECUTE FUNCTION app.reward_setup_links();
REVOKE ALL ON FUNCTION app.reward_setup_links() FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_setup_links() TO ai_hr_app;
