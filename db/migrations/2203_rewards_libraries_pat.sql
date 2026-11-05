-- Shared setup authority is deliberately narrower than generic HR administration.
CREATE TABLE reward_setup_grant(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),user_id uuid NOT NULL REFERENCES app_user(id),
 company_id uuid REFERENCES company(id),role text NOT NULL CHECK(role IN('gr','ctro')),valid_from date NOT NULL,valid_to date,active boolean NOT NULL DEFAULT true,
 created_by uuid NOT NULL REFERENCES app_user(id),reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 4000),revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),CHECK(valid_to IS NULL OR valid_to>=valid_from),UNIQUE(tenant_id,id)
);
ALTER TABLE reward_setup_grant ENABLE ROW LEVEL SECURITY;ALTER TABLE reward_setup_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY reward_setup_grant_read ON reward_setup_grant FOR SELECT USING(tenant_id=app.current_tenant_id() AND (user_id=app.current_user_id() OR app.is_group_admin()));
CREATE POLICY reward_setup_grant_insert ON reward_setup_grant FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_group_admin() AND created_by=app.current_user_id());
CREATE POLICY reward_setup_grant_update ON reward_setup_grant FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.is_group_admin()) WITH CHECK(tenant_id=app.current_tenant_id() AND app.is_group_admin());
GRANT SELECT,INSERT,UPDATE ON reward_setup_grant TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_setup_allowed(wanted_company uuid,wanted_operation text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT wanted_operation IN('library_view','manage')
 AND EXISTS(SELECT 1 FROM app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 AND (wanted_company IS NULL OR EXISTS(SELECT 1 FROM company c WHERE c.id=wanted_company AND c.tenant_id=app.current_tenant_id()))
 AND (EXISTS(SELECT 1 FROM reward_setup_grant g WHERE g.tenant_id=app.current_tenant_id() AND g.user_id=app.current_user_id() AND g.active
  AND g.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND(g.valid_to IS NULL OR g.valid_to>=timezone('Asia/Kuala_Lumpur',now())::date)
  AND((wanted_company IS NULL AND g.company_id IS NULL) OR (wanted_company IS NOT NULL AND(g.company_id IS NULL OR g.company_id=wanted_company))) AND(g.role='gr' OR wanted_operation='library_view' AND g.role='ctro'))
 OR EXISTS(SELECT 1 FROM reward_unit u WHERE u.tenant_id=app.current_tenant_id() AND u.deleted_at IS NULL AND wanted_company IS NOT NULL AND u.company_id=wanted_company
  AND EXISTS(SELECT 1 FROM app.reward_roles(u.id) r WHERE r='gr' OR wanted_operation='library_view' AND r='ctro')))
$$;
REVOKE ALL ON FUNCTION app.reward_setup_allowed(uuid,text) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_setup_allowed(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE reward_library(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),kind text NOT NULL CHECK(kind IN('salary','bonus')),
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),year integer NOT NULL CHECK(year BETWEEN 2000 AND 2200),tags text[] NOT NULL DEFAULT '{}',group_default boolean NOT NULL DEFAULT false,
 previous_library_id uuid,created_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,previous_library_id) REFERENCES reward_library(tenant_id,id)
);
CREATE UNIQUE INDEX reward_library_name_year ON reward_library(tenant_id,kind,year,lower(name));
CREATE TABLE reward_library_version(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),library_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),
 data jsonb NOT NULL CHECK(jsonb_typeof(data)='object'),state text NOT NULL CHECK(state IN('draft','pending','confirmed')),lock_version integer NOT NULL DEFAULT 1,
 created_by uuid NOT NULL REFERENCES app_user(id),contributor_ids uuid[] NOT NULL,confirmed_by uuid REFERENCES app_user(id),confirmed_at timestamptz,
 reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 4000),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),UNIQUE(tenant_id,library_id,revision),FOREIGN KEY(tenant_id,library_id) REFERENCES reward_library(tenant_id,id),
 CHECK((state='confirmed')=(confirmed_by IS NOT NULL)),CHECK(confirmed_by IS NULL OR NOT confirmed_by=ANY(contributor_ids))
);
CREATE UNIQUE INDEX reward_library_one_working ON reward_library_version(tenant_id,library_id) WHERE state<>'confirmed';
CREATE TABLE reward_pat_version(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),company_id uuid NOT NULL REFERENCES company(id),year integer NOT NULL CHECK(year BETWEEN 2000 AND 2200),
 revision integer NOT NULL CHECK(revision>0),inputs jsonb NOT NULL CHECK(jsonb_typeof(inputs)='object'),state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','confirmed')),
 created_by uuid NOT NULL REFERENCES app_user(id),confirmed_by uuid REFERENCES app_user(id),confirmed_at timestamptz,reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 4000),
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(tenant_id,id),UNIQUE(tenant_id,company_id,year,revision),
 CHECK((state='confirmed')=(confirmed_by IS NOT NULL)),CHECK(confirmed_by IS NULL OR confirmed_by<>created_by)
);
CREATE UNIQUE INDEX reward_pat_one_pending ON reward_pat_version(tenant_id,company_id,year) WHERE state='pending';
--> statement-breakpoint
ALTER TABLE reward_library ENABLE ROW LEVEL SECURITY;ALTER TABLE reward_library FORCE ROW LEVEL SECURITY;
ALTER TABLE reward_library_version ENABLE ROW LEVEL SECURITY;ALTER TABLE reward_library_version FORCE ROW LEVEL SECURITY;
ALTER TABLE reward_pat_version ENABLE ROW LEVEL SECURITY;ALTER TABLE reward_pat_version FORCE ROW LEVEL SECURITY;
CREATE POLICY reward_library_read ON reward_library FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(NULL,'library_view'));
CREATE POLICY reward_library_insert ON reward_library FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(NULL,'manage') AND created_by=app.current_user_id());
CREATE POLICY reward_library_version_read ON reward_library_version FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(NULL,'library_view'));
CREATE POLICY reward_library_version_insert ON reward_library_version FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(NULL,'manage') AND created_by=app.current_user_id() AND state='draft' AND contributor_ids=ARRAY[app.current_user_id()]);
CREATE POLICY reward_library_version_update ON reward_library_version FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(NULL,'manage') AND state<>'confirmed') WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(NULL,'manage') AND(state<>'confirmed' OR confirmed_by=app.current_user_id()));
CREATE POLICY reward_pat_read ON reward_pat_version FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(company_id,'manage'));
CREATE POLICY reward_pat_insert ON reward_pat_version FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(company_id,'manage') AND created_by=app.current_user_id() AND state='pending');
CREATE POLICY reward_pat_check ON reward_pat_version FOR UPDATE USING(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(company_id,'manage') AND state='pending' AND created_by<>app.current_user_id()) WITH CHECK(tenant_id=app.current_tenant_id() AND state='confirmed' AND confirmed_by=app.current_user_id() AND app.reward_setup_allowed(company_id,'manage'));
GRANT SELECT,INSERT ON reward_library TO ai_hr_app;
GRANT SELECT,INSERT,UPDATE ON reward_library_version,reward_pat_version TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_setup_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF TG_TABLE_NAME='reward_library_version' THEN
  IF OLD.state='confirmed' OR NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.library_id<>OLD.library_id OR NEW.revision<>OLD.revision OR NEW.created_by<>OLD.created_by THEN RAISE EXCEPTION 'Confirmed library versions and identities are immutable'; END IF;
  IF NEW.state='confirmed' AND(OLD.state<>'pending' OR NEW.data IS DISTINCT FROM OLD.data OR NEW.reason<>OLD.reason OR NEW.contributor_ids IS DISTINCT FROM OLD.contributor_ids OR NEW.confirmed_by<>app.current_user_id() OR app.current_user_id()=ANY(OLD.contributor_ids)) THEN RAISE EXCEPTION 'An independent checker must confirm the exact pending library version'; END IF;
  IF NEW.state<>'confirmed' THEN NEW.contributor_ids=(SELECT array_agg(DISTINCT x) FROM unnest(OLD.contributor_ids||ARRAY[app.current_user_id()]) x);END IF;
 ELSIF TG_TABLE_NAME='reward_pat_version' THEN
  IF OLD.state='confirmed' OR NEW.inputs IS DISTINCT FROM OLD.inputs OR NEW.company_id<>OLD.company_id OR NEW.year<>OLD.year OR NEW.revision<>OLD.revision OR NEW.created_by<>OLD.created_by OR NEW.reason<>OLD.reason OR NEW.tenant_id<>OLD.tenant_id OR NEW.id<>OLD.id THEN RAISE EXCEPTION 'PAT versions are immutable; create a successor proposal'; END IF;
 ELSIF TG_TABLE_NAME='reward_setup_grant' THEN
  IF NOT EXISTS(SELECT 1 FROM app_user WHERE id=NEW.user_id AND tenant_id=NEW.tenant_id) OR NEW.company_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM company WHERE id=NEW.company_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Setup grants must remain in their tenant';END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER reward_library_immutable BEFORE UPDATE ON reward_library_version FOR EACH ROW EXECUTE FUNCTION app.reward_setup_immutable();
CREATE TRIGGER reward_pat_immutable BEFORE UPDATE ON reward_pat_version FOR EACH ROW EXECUTE FUNCTION app.reward_setup_immutable();
CREATE TRIGGER reward_setup_grant_links BEFORE INSERT OR UPDATE ON reward_setup_grant FOR EACH ROW EXECUTE FUNCTION app.reward_setup_immutable();
REVOKE ALL ON FUNCTION app.reward_setup_immutable() FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_setup_immutable() TO ai_hr_app;
