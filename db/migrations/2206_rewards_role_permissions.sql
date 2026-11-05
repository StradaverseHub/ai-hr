-- Configurable role reach narrows native route authority; confidentiality remains enforced by existing owners.
CREATE TABLE reward_role_permission(
 tenant_id uuid NOT NULL REFERENCES tenant(id),role text NOT NULL CHECK(role IN('bu','bg','proxy_bg','gr','ctro','ec','pbp','hr_admin','payroll')),
 capability text NOT NULL,allowed boolean NOT NULL,changed_by uuid NOT NULL REFERENCES app_user(id),reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 2000),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,role,capability)
);
ALTER TABLE reward_role_permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_role_permission FORCE ROW LEVEL SECURITY;
CREATE POLICY reward_role_permission_read ON reward_role_permission FOR SELECT USING(tenant_id=app.current_tenant_id());
CREATE POLICY reward_role_permission_write ON reward_role_permission FOR ALL USING(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(null,'manage')) WITH CHECK(tenant_id=app.current_tenant_id() AND changed_by=app.current_user_id() AND app.reward_setup_allowed(null,'manage'));
GRANT SELECT,INSERT,UPDATE,DELETE ON reward_role_permission TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE reward_page_grant(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),user_id uuid NOT NULL REFERENCES app_user(id),
 company_id uuid NOT NULL REFERENCES company(id),capability text NOT NULL CHECK(capability IN('review.view','analytics.view','approvals.view','rules.view')),
 valid_from date NOT NULL,valid_to date,active boolean NOT NULL DEFAULT true,created_by uuid NOT NULL REFERENCES app_user(id),reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 2000),
 CHECK(valid_to IS NULL OR valid_to>=valid_from),UNIQUE(tenant_id,user_id,company_id,capability)
);
ALTER TABLE reward_page_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_page_grant FORCE ROW LEVEL SECURITY;
CREATE POLICY reward_page_grant_read ON reward_page_grant FOR SELECT USING(tenant_id=app.current_tenant_id() AND (user_id=app.current_user_id() OR app.reward_setup_allowed(company_id,'manage')));
CREATE POLICY reward_page_grant_write ON reward_page_grant FOR ALL USING(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(company_id,'manage')) WITH CHECK(tenant_id=app.current_tenant_id() AND app.reward_setup_allowed(company_id,'manage'));
GRANT SELECT,INSERT,UPDATE ON reward_page_grant TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.reward_role_native_capability(wanted_role text,wanted_capability text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE
 WHEN wanted_capability IN('cycles.view','plans.manage','pat.manage','access.manage','senior.manage','data.check','snapshot.refresh') THEN wanted_role='gr'
 WHEN wanted_capability IN('salary.view','bonus.view') THEN wanted_role IN('gr','ctro')
 WHEN wanted_capability='restricted.view' THEN wanted_role IN('gr','ctro','ec')
 WHEN wanted_capability IN('review.view','analytics.view','approvals.view','rules.view') THEN wanted_role IN('bu','bg','gr','ctro','ec','pbp','payroll')
 WHEN wanted_capability='cases.decide' THEN wanted_role IN('bu','gr')
 WHEN wanted_capability IN('figures.edit','notes.add','review.decide','review.batch') THEN wanted_role IN('bu','bg','gr','ctro','ec')
 WHEN wanted_capability='offcycle.decide' THEN wanted_role IN('bg','gr','ctro','ec')
 WHEN wanted_capability='offcycle.raise' THEN wanted_role IN('bu','bg','gr')
 ELSE false END
$$;
CREATE FUNCTION app.reward_capability(wanted_unit uuid,wanted_capability text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS(SELECT 1 FROM reward_unit u WHERE u.id=wanted_unit AND u.tenant_id=app.current_tenant_id() AND u.deleted_at IS NULL
  AND EXISTS(SELECT 1 FROM app.reward_roles(u.id) AS assigned(role) WHERE app.reward_role_native_capability(assigned.role,wanted_capability)
   AND coalesce((SELECT allowed FROM reward_role_permission p WHERE p.tenant_id=u.tenant_id AND p.role=assigned.role AND p.capability=wanted_capability),true)))
$$;
REVOKE ALL ON FUNCTION app.reward_role_native_capability(text,text),app.reward_capability(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_role_native_capability(text,text),app.reward_capability(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE TABLE reward_access_view_session(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),viewer_id uuid NOT NULL REFERENCES app_user(id),target_id uuid NOT NULL REFERENCES app_user(id),
 started_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',ended_at timestamptz,
 CHECK(viewer_id<>target_id),CHECK(expires_at>started_at AND expires_at<=started_at+interval '30 minutes')
);
CREATE UNIQUE INDEX reward_access_one_view_session ON reward_access_view_session(tenant_id,viewer_id) WHERE ended_at IS NULL;
ALTER TABLE reward_access_view_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_access_view_session FORCE ROW LEVEL SECURITY;
CREATE POLICY reward_access_view_session_read ON reward_access_view_session FOR SELECT USING(tenant_id=app.current_tenant_id() AND viewer_id=app.current_user_id());
CREATE POLICY reward_access_view_session_insert ON reward_access_view_session FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND viewer_id=app.current_user_id() AND app.reward_setup_allowed(null,'manage'));
CREATE POLICY reward_access_view_session_end ON reward_access_view_session FOR UPDATE USING(tenant_id=app.current_tenant_id() AND viewer_id=app.current_user_id()) WITH CHECK(tenant_id=app.current_tenant_id() AND viewer_id=app.current_user_id());
GRANT SELECT,INSERT,UPDATE ON reward_access_view_session TO ai_hr_app;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_reward_view_reader') THEN CREATE ROLE ai_hr_reward_view_reader NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_reward_view_reader' AND (rolcanlogin OR rolsuper OR rolbypassrls)) THEN RAISE EXCEPTION 'Unsafe Rewards view reader'; END IF;
END $$;
GRANT USAGE ON SCHEMA public,app TO ai_hr_reward_view_reader;
GRANT SELECT ON reward_access_view_session TO ai_hr_reward_view_reader;
GRANT EXECUTE ON FUNCTION app.current_tenant_id(),app.current_user_id() TO ai_hr_reward_view_reader;
CREATE POLICY reward_view_reader ON reward_access_view_session FOR SELECT TO ai_hr_reward_view_reader USING(tenant_id=app.current_tenant_id() AND viewer_id=app.current_user_id());
CREATE FUNCTION app.reward_not_viewing_as() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT NOT EXISTS(SELECT 1 FROM reward_access_view_session WHERE tenant_id=app.current_tenant_id() AND viewer_id=app.current_user_id() AND ended_at IS NULL AND expires_at>now())
$$;
ALTER FUNCTION app.reward_not_viewing_as() OWNER TO ai_hr_reward_view_reader;
GRANT EXECUTE ON FUNCTION app.reward_not_viewing_as() TO PUBLIC;
-- Restrictive write policies defend every current service, assistant, import and export mutation path.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['reward_unit','reward_entry','reward_member','reward_decision','reward_policy_group','reward_policy_group_version','reward_policy_group_target','reward_governance','reward_governance_history','reward_senior_evidence','reward_governance_public','reward_senior_award','reward_company_exclusion','reward_calendar','reward_access_request','reward_role_permission','reward_page_grant','reward_setup_grant','reward_library','reward_library_version','reward_pat_version','reward_plan_setup','reward_plan_company','reward_company_year_review','reward_unit_setup','reward_setup_cycle','reward_pat_basis'] LOOP
  IF to_regclass('public.'||t) IS NOT NULL THEN
   EXECUTE format('CREATE POLICY reward_view_as_insert ON %I AS RESTRICTIVE FOR INSERT TO PUBLIC WITH CHECK(app.reward_not_viewing_as())',t);
   EXECUTE format('CREATE POLICY reward_view_as_update ON %I AS RESTRICTIVE FOR UPDATE TO PUBLIC USING(app.reward_not_viewing_as()) WITH CHECK(app.reward_not_viewing_as())',t);
   EXECUTE format('CREATE POLICY reward_view_as_delete ON %I AS RESTRICTIVE FOR DELETE TO PUBLIC USING(app.reward_not_viewing_as())',t);
  END IF;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.reward_access_policy_shape() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN
 IF TG_TABLE_NAME='reward_role_permission' THEN
  IF NOT app.reward_role_native_capability(CASE WHEN NEW.role='proxy_bg' THEN 'bg' ELSE NEW.role END,NEW.capability)
    OR NEW.capability NOT IN('review.view','analytics.view','approvals.view','rules.view','figures.edit','cases.decide','notes.add','review.decide','review.batch','offcycle.raise','offcycle.decide','data.check','snapshot.refresh')
    THEN RAISE EXCEPTION 'Fixed Rewards role permission'; END IF;
 ELSIF TG_TABLE_NAME='reward_page_grant' THEN
  IF NOT EXISTS(SELECT 1 FROM app_user WHERE id=NEW.user_id AND tenant_id=NEW.tenant_id AND archived_at IS NULL)
   OR NOT EXISTS(SELECT 1 FROM company WHERE id=NEW.company_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'Page access must remain in its tenant'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM app_user WHERE id=NEW.target_id AND tenant_id=NEW.tenant_id AND archived_at IS NULL AND NOT app.login_blocked(id)) THEN RAISE EXCEPTION 'View as target is unavailable'; END IF;
  IF TG_OP='UPDATE' AND (NEW.viewer_id<>OLD.viewer_id OR NEW.target_id<>OLD.target_id OR NEW.tenant_id<>OLD.tenant_id OR NEW.started_at<>OLD.started_at OR NEW.expires_at<>OLD.expires_at) THEN RAISE EXCEPTION 'View as identity is immutable'; END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER reward_role_permission_shape BEFORE INSERT OR UPDATE ON reward_role_permission FOR EACH ROW EXECUTE FUNCTION app.reward_access_policy_shape();
CREATE TRIGGER reward_page_grant_shape BEFORE INSERT OR UPDATE ON reward_page_grant FOR EACH ROW EXECUTE FUNCTION app.reward_access_policy_shape();
CREATE TRIGGER reward_view_session_shape BEFORE INSERT OR UPDATE ON reward_access_view_session FOR EACH ROW EXECUTE FUNCTION app.reward_access_policy_shape();
REVOKE ALL ON FUNCTION app.reward_access_policy_shape() FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_access_policy_shape() TO ai_hr_app;
--> statement-breakpoint
-- The administrator may inspect a real principal only for reviews they administer. No target secrets leave SQL.
CREATE FUNCTION app.reward_view_as_principal(wanted_user uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE result jsonb;
BEGIN
 IF NOT app.reward_setup_allowed(NULL,'manage') OR wanted_user=app.current_user_id() THEN RAISE EXCEPTION 'Group Rewards View as authority required' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM reward_member m JOIN reward_unit u ON u.id=m.unit_id AND u.tenant_id=m.tenant_id WHERE m.user_id=wanted_user AND m.tenant_id=app.current_tenant_id() AND app.reward_member_eligible(m.id) AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(u.id)))) THEN RAISE EXCEPTION 'Target is outside managed Rewards scope' USING ERRCODE='42501'; END IF;
 SELECT jsonb_build_object('tenantId',u.tenant_id,'userId',u.id,'personId',u.person_id,'roles',(SELECT coalesce(jsonb_agg(DISTINCT r.role::text),'[]'::jsonb) FROM role_assignment r WHERE r.tenant_id=u.tenant_id AND r.app_user_id=u.id),'grants',(SELECT coalesce(jsonb_agg(jsonb_build_object('role',r.role::text,'companyId',r.company_id)),'[]'::jsonb) FROM role_assignment r WHERE r.tenant_id=u.tenant_id AND r.app_user_id=u.id)) INTO result
 FROM app_user u WHERE u.id=wanted_user AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF result IS NULL THEN RAISE EXCEPTION 'View as principal unavailable' USING ERRCODE='42501'; END IF;RETURN result;
END $$;
-- Existing constrained Rewards reader is nonlogin/nobypass and already reads these identities under its purpose policies.
GRANT SELECT ON role_assignment,app_user,reward_member,reward_unit,reward_setup_grant TO ai_hr_rewards_post_reader;
GRANT EXECUTE ON FUNCTION app.reward_setup_allowed(uuid,text),app.reward_member_eligible(uuid) TO ai_hr_rewards_post_reader;
CREATE POLICY reward_view_principal_assignments ON role_assignment FOR SELECT TO ai_hr_rewards_post_reader USING(tenant_id=app.current_tenant_id());
ALTER FUNCTION app.reward_view_as_principal(uuid) OWNER TO ai_hr_rewards_post_reader;
REVOKE ALL ON FUNCTION app.reward_view_as_principal(uuid) FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_view_as_principal(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Triggers also cover legacy SECURITY DEFINER writers whose retained owner bypasses RLS.
CREATE FUNCTION app.reward_view_as_write_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,app AS $$
BEGIN IF NOT app.reward_not_viewing_as() THEN RAISE EXCEPTION 'End read-only View as before changing Rewards' USING ERRCODE='42501';END IF;RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;END $$;
REVOKE ALL ON FUNCTION app.reward_view_as_write_guard() FROM PUBLIC;GRANT EXECUTE ON FUNCTION app.reward_view_as_write_guard() TO PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['reward_unit','reward_entry','reward_member','reward_decision','reward_policy_group','reward_policy_group_version','reward_policy_group_target','reward_governance','reward_governance_history','reward_senior_evidence','reward_governance_public','reward_senior_award','reward_company_exclusion','reward_calendar','reward_access_request','reward_role_permission','reward_page_grant','reward_setup_grant','reward_library','reward_library_version','reward_pat_version','reward_plan_setup','reward_plan_company','reward_company_year_review','reward_unit_setup','reward_setup_cycle','reward_pat_basis'] LOOP
  IF to_regclass('public.'||t) IS NOT NULL THEN EXECUTE format('CREATE TRIGGER reward_view_as_write_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app.reward_view_as_write_guard()',t);END IF;
 END LOOP;
END $$;
--> statement-breakpoint
-- Personal page exceptions restore a narrowed page only inside a still-eligible native review seat.
-- They never mint an approval role, company scope, confidential category or mutation capability.
CREATE OR REPLACE FUNCTION app.reward_capability(wanted_unit uuid,wanted_capability text) RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS(SELECT 1 FROM reward_unit u WHERE u.id=wanted_unit AND u.tenant_id=app.current_tenant_id() AND u.deleted_at IS NULL
 AND EXISTS(SELECT 1 FROM app.reward_roles(u.id) AS assigned(role) WHERE app.reward_role_native_capability(assigned.role,wanted_capability)
 AND (coalesce((SELECT allowed FROM reward_role_permission p WHERE p.tenant_id=u.tenant_id AND p.role=CASE WHEN assigned.role='bg' AND EXISTS(SELECT 1 FROM reward_member m WHERE m.unit_id=u.id AND m.tenant_id=u.tenant_id AND m.user_id=app.current_user_id() AND m.role='bg' AND m.covers_user_id IS NOT NULL AND app.reward_member_eligible(m.id)) THEN 'proxy_bg' ELSE assigned.role END AND p.capability=wanted_capability),true)
 OR (wanted_capability IN('review.view','analytics.view','approvals.view','rules.view') AND EXISTS(SELECT 1 FROM reward_page_grant g WHERE g.tenant_id=u.tenant_id AND g.company_id=u.company_id AND g.user_id=app.current_user_id() AND g.capability=wanted_capability AND g.active AND g.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND(g.valid_to IS NULL OR g.valid_to>=timezone('Asia/Kuala_Lumpur',now())::date))))))
$$;
