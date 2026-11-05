CREATE FUNCTION app.reward_private_entry_visible(wanted_unit uuid,wanted_entry uuid) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS(SELECT 1 FROM reward_entry e WHERE e.id=wanted_entry AND e.unit_id=wanted_unit AND e.tenant_id=app.current_tenant_id()
  AND EXISTS(SELECT 1 FROM app.reward_roles(e.unit_id))
  AND NOT EXISTS(SELECT 1 FROM app_user me WHERE me.id=app.current_user_id() AND me.tenant_id=e.tenant_id AND me.person_id::text=e.source->>'personId')
  AND (e.facts->>'reviewed'='true' OR 'gr'=ANY(ARRAY(SELECT app.reward_roles(e.unit_id))))
  AND (e.facts->>'confidentiality'<>'ec' OR ARRAY(SELECT app.reward_roles(e.unit_id)) && ARRAY['gr','ctro','ec'])
  AND (e.facts->>'confidentiality'<>'bg' OR ARRAY(SELECT app.reward_roles(e.unit_id)) && ARRAY['bg','gr','ctro','ec','payroll']))
$$;
REVOKE ALL ON FUNCTION app.reward_private_entry_visible(uuid,uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_private_entry_visible(uuid,uuid) TO ai_hr_app;
CREATE TABLE reward_advisor_setting(
 unit_id uuid PRIMARY KEY REFERENCES reward_unit(id),tenant_id uuid NOT NULL REFERENCES tenant(id),revision integer NOT NULL DEFAULT 1,
 settings jsonb NOT NULL CHECK(jsonb_typeof(settings)='object'),changed_by uuid NOT NULL REFERENCES app_user(id),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reward_advisor_suggestion(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),unit_id uuid NOT NULL REFERENCES reward_unit(id),entry_id uuid NOT NULL REFERENCES reward_entry(id),
 unit_revision integer NOT NULL,source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'),settings_revision integer NOT NULL,
 recommendation jsonb NOT NULL CHECK(jsonb_typeof(recommendation)='object'),reason_refs jsonb NOT NULL CHECK(jsonb_typeof(reason_refs)='array'),input_snapshot jsonb NOT NULL,
 provider text NOT NULL,model text NOT NULL,contract_id text NOT NULL,prompt_digest text NOT NULL,
 created_by uuid NOT NULL REFERENCES app_user(id),created_at timestamptz NOT NULL DEFAULT now(),status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','accepted','adjusted','ignored')),
 decided_by uuid REFERENCES app_user(id),decided_at timestamptz,decision_reason text,final_recommendation jsonb,
 UNIQUE(tenant_id,id),CHECK((status='pending')=(decided_by IS NULL))
);
CREATE INDEX reward_advisor_suggestion_entry ON reward_advisor_suggestion(tenant_id,unit_id,entry_id,created_at DESC,id DESC);
ALTER TABLE reward_advisor_setting ENABLE ROW LEVEL SECURITY;ALTER TABLE reward_advisor_setting FORCE ROW LEVEL SECURITY;
ALTER TABLE reward_advisor_suggestion ENABLE ROW LEVEL SECURITY;ALTER TABLE reward_advisor_suggestion FORCE ROW LEVEL SECURITY;
CREATE POLICY reward_advisor_setting_read ON reward_advisor_setting FOR SELECT USING(tenant_id=app.current_tenant_id() AND EXISTS(SELECT 1 FROM app.reward_roles(unit_id)));
CREATE POLICY reward_advisor_setting_write ON reward_advisor_setting FOR ALL USING(tenant_id=app.current_tenant_id() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))) AND app.reward_not_viewing_as()) WITH CHECK(tenant_id=app.current_tenant_id() AND changed_by=app.current_user_id() AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(unit_id))) AND app.reward_not_viewing_as());
CREATE POLICY reward_advisor_suggestion_read ON reward_advisor_suggestion FOR SELECT USING(tenant_id=app.current_tenant_id() AND app.reward_private_entry_visible(unit_id,entry_id));
CREATE POLICY reward_advisor_suggestion_insert ON reward_advisor_suggestion FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND status='pending' AND app.reward_private_entry_visible(unit_id,entry_id) AND app.reward_not_viewing_as());
CREATE POLICY reward_advisor_suggestion_update ON reward_advisor_suggestion FOR UPDATE USING(tenant_id=app.current_tenant_id() AND status='pending' AND app.reward_private_entry_visible(unit_id,entry_id) AND app.reward_not_viewing_as()) WITH CHECK(tenant_id=app.current_tenant_id() AND decided_by=app.current_user_id() AND status<>'pending' AND app.reward_private_entry_visible(unit_id,entry_id) AND app.reward_not_viewing_as());
GRANT SELECT,INSERT,UPDATE ON reward_advisor_setting,reward_advisor_suggestion TO ai_hr_app;
CREATE FUNCTION app.reward_advisor_binding() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM reward_unit u WHERE u.id=NEW.unit_id AND u.tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Advisor review binding is invalid'; END IF;
 IF TG_TABLE_NAME='reward_advisor_suggestion' THEN
  IF NOT EXISTS(SELECT 1 FROM reward_entry e WHERE e.id=NEW.entry_id AND e.unit_id=NEW.unit_id AND e.tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Advisor employee binding is invalid'; END IF;
  IF TG_OP='UPDATE' AND (NEW.recommendation IS DISTINCT FROM OLD.recommendation OR NEW.reason_refs IS DISTINCT FROM OLD.reason_refs OR NEW.input_snapshot IS DISTINCT FROM OLD.input_snapshot OR NEW.source_digest<>OLD.source_digest OR NEW.unit_revision<>OLD.unit_revision OR NEW.entry_id<>OLD.entry_id OR NEW.unit_id<>OLD.unit_id OR NEW.tenant_id<>OLD.tenant_id OR NEW.created_by<>OLD.created_by OR NEW.settings_revision<>OLD.settings_revision OR NEW.provider<>OLD.provider OR NEW.model<>OLD.model OR NEW.contract_id<>OLD.contract_id OR NEW.prompt_digest<>OLD.prompt_digest) THEN RAISE EXCEPTION 'Advisor suggestion inputs are immutable'; END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER reward_advisor_setting_binding BEFORE INSERT OR UPDATE ON reward_advisor_setting FOR EACH ROW EXECUTE FUNCTION app.reward_advisor_binding();
CREATE TRIGGER reward_advisor_suggestion_binding BEFORE INSERT OR UPDATE ON reward_advisor_suggestion FOR EACH ROW EXECUTE FUNCTION app.reward_advisor_binding();
REVOKE ALL ON FUNCTION app.reward_advisor_binding() FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_advisor_binding() TO ai_hr_app;
