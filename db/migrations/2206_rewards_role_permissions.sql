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
CREATE POLICY reward_access_view_session_insert ON reward_access_view_session FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND viewer_id=app.current_user_id() AND EXISTS(SELECT 1 FROM reward_unit u WHERE u.tenant_id=reward_access_view_session.tenant_id AND u.deleted_at IS NULL AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(u.id)))));
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
  IF TG_OP='INSERT' THEN
   IF NEW.ended_at IS NOT NULL THEN RAISE EXCEPTION 'New View as sessions must start open'; END IF;
   PERFORM app.reward_view_as_principal(NEW.target_id);
  ELSIF NEW.viewer_id<>OLD.viewer_id OR NEW.target_id<>OLD.target_id OR NEW.tenant_id<>OLD.tenant_id OR NEW.started_at<>OLD.started_at OR NEW.expires_at<>OLD.expires_at OR OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL THEN RAISE EXCEPTION 'View as identity and closed sessions are immutable'; END IF;
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
 IF wanted_user IS NULL OR wanted_user=app.current_user_id() THEN RAISE EXCEPTION 'Group Rewards View as requires a different current principal' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM reward_member m JOIN reward_unit u ON u.id=m.unit_id AND u.tenant_id=m.tenant_id WHERE m.user_id=wanted_user AND m.tenant_id=app.current_tenant_id() AND app.reward_member_eligible(m.id) AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(u.id)))) THEN RAISE EXCEPTION 'Target is outside managed Rewards scope' USING ERRCODE='42501'; END IF;
 WITH shared_companies AS (
  SELECT DISTINCT u.company_id FROM reward_member m JOIN reward_unit u ON u.id=m.unit_id AND u.tenant_id=m.tenant_id
  WHERE m.user_id=wanted_user AND m.tenant_id=app.current_tenant_id() AND u.deleted_at IS NULL AND app.reward_member_eligible(m.id) AND 'gr'=ANY(ARRAY(SELECT app.reward_roles(u.id)))
 ), scoped_grants AS (
  SELECT DISTINCT grant_row.value AS g FROM app.principal(wanted_user) p CROSS JOIN LATERAL jsonb_array_elements(p.grants) grant_row(value)
  WHERE p.tenant_id=app.current_tenant_id() AND (grant_row.value->>'companyId' IS NULL OR EXISTS(SELECT 1 FROM shared_companies c WHERE c.company_id=(grant_row.value->>'companyId')::uuid OR app.is_company_descendant(c.company_id,(grant_row.value->>'companyId')::uuid)))
 )
 SELECT jsonb_build_object('tenantId',u.tenant_id,'userId',u.id,'personId',u.person_id,'roles',(SELECT coalesce(jsonb_agg(DISTINCT g->>'role'),'[]'::jsonb) FROM scoped_grants),'grants',(SELECT coalesce(jsonb_agg(g),'[]'::jsonb) FROM scoped_grants)) INTO result
 FROM app_user u WHERE u.id=wanted_user AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF result IS NULL THEN RAISE EXCEPTION 'View as principal unavailable' USING ERRCODE='42501'; END IF;RETURN result;
END $$;
-- Existing constrained Rewards reader is nonlogin/nobypass and already reads these identities under its purpose policies.
GRANT SELECT ON app_user,reward_member,reward_unit TO ai_hr_rewards_post_reader;
GRANT EXECUTE ON FUNCTION app.principal(uuid),app.is_company_descendant(uuid,uuid),app.reward_member_eligible(uuid) TO ai_hr_rewards_post_reader;
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

-- The legacy access ledger remains sealed. Only the exact new policy events can be appended by their bounded owner.
CREATE OR REPLACE FUNCTION app.reward_access_audit_owner() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF (NEW.aggregate_type='reward-access-request' OR NEW.event_type LIKE 'reward-access.%' OR NEW.event_type='reward-unit.access-changed') AND NOT
   (current_user='ai_hr_reward_setup_reader' AND NEW.aggregate_type='reward-access' AND NEW.tenant_id=app.current_tenant_id() AND NEW.actor_type='user' AND NEW.actor_id=app.current_user_id()
    AND NEW.event_type IN('reward-access.permission.changed','reward-access.permissions.reset','reward-access.personal-page.changed','reward-access.setup-authority.changed','reward-access.view-as.started','reward-access.view-as.used','reward-access.view-as.ended'))
   AND NOT app.acting_as_owner() THEN RAISE EXCEPTION 'native Rewards access audit owner required' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
GRANT EXECUTE ON FUNCTION app.acting_as_owner(),app.is_group_admin(),app.reward_view_as_principal(uuid) TO ai_hr_reward_setup_reader;
GRANT EXECUTE ON FUNCTION app.reward_access(uuid) TO ai_hr_rewards_post_reader,ai_hr_reward_setup_reader;
GRANT SELECT ON reward_access_view_session,reward_role_permission,reward_page_grant TO ai_hr_reward_setup_reader;
CREATE FUNCTION app.reward_access_policy_event(event_name text,record_id uuid,details jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
DECLARE actor uuid:=app.current_user_id();t uuid:=app.current_tenant_id();expected_target uuid;expected_company uuid;
BEGIN
 IF actor IS NULL OR t IS NULL OR record_id IS NULL OR jsonb_typeof(details) IS DISTINCT FROM 'object' OR octet_length(details::text)>40000 THEN RAISE EXCEPTION 'Rewards access event identity is invalid' USING ERRCODE='42501';END IF;
 CASE event_name
 WHEN 'permission.changed','permissions.reset' THEN
   IF record_id<>actor OR NOT app.reward_setup_allowed(NULL,'manage') OR NOT app.reward_not_viewing_as() THEN RAISE EXCEPTION 'Group Rewards access policy owner required' USING ERRCODE='42501';END IF;
 WHEN 'setup-authority.changed' THEN
   IF NOT app.is_group_admin() OR NOT app.reward_not_viewing_as() OR NOT EXISTS(SELECT 1 FROM reward_setup_grant r WHERE r.id=record_id AND r.tenant_id=t AND r.xmin=pg_current_xact_id()::text::xid) THEN RAISE EXCEPTION 'Current setup grant change required' USING ERRCODE='42501';END IF;
 WHEN 'personal-page.changed' THEN
   expected_company:=(details->'after'->>'companyId')::uuid;
   IF expected_company IS NULL OR NOT app.reward_setup_allowed(expected_company,'manage') OR NOT app.reward_not_viewing_as() OR NOT EXISTS(SELECT 1 FROM reward_page_grant r WHERE r.tenant_id=t AND r.user_id=record_id AND r.company_id=expected_company AND r.capability=details->'after'->>'capability' AND r.xmin=pg_current_xact_id()::text::xid) THEN RAISE EXCEPTION 'Current personal-page change required' USING ERRCODE='42501';END IF;
 WHEN 'view-as.started','view-as.used','view-as.ended' THEN
   SELECT r.target_id INTO expected_target FROM reward_access_view_session r WHERE r.tenant_id=t AND r.id=record_id AND r.viewer_id=actor
    AND (event_name='view-as.ended' AND r.ended_at IS NOT NULL AND r.xmin=pg_current_xact_id()::text::xid OR event_name='view-as.started' AND r.ended_at IS NULL AND r.xmin=pg_current_xact_id()::text::xid OR event_name='view-as.used' AND r.ended_at IS NULL AND r.expires_at>now());
   IF expected_target IS NULL THEN RAISE EXCEPTION 'Current Rewards view session required' USING ERRCODE='42501';END IF;
   IF event_name='view-as.used' THEN PERFORM app.reward_view_as_principal(expected_target);END IF;
   details:=jsonb_build_object('targetUserId',expected_target);
 ELSE RAISE EXCEPTION 'Unknown Rewards policy event' USING ERRCODE='42501';
 END CASE;
 INSERT INTO domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) VALUES(t,'reward-access',record_id,'reward-access.'||event_name,'user',actor,details);
END $$;
ALTER FUNCTION app.reward_access_policy_event(text,uuid,jsonb) OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_access_policy_event(text,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_access_policy_event(text,uuid,jsonb) TO ai_hr_app;

CREATE FUNCTION app.reward_rule_policy_reference(wanted uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app AS $$
 SELECT jsonb_build_object('name',p.name,'version',p.revision,'current',g.current_version_id=p.id)
 FROM reward_unit u JOIN reward_policy_group_version p ON p.id=u.policy_group_version_id AND p.tenant_id=u.tenant_id
 JOIN reward_policy_group g ON g.id=p.group_id AND g.tenant_id=p.tenant_id
 WHERE u.id=wanted AND u.tenant_id=app.current_tenant_id() AND u.deleted_at IS NULL AND EXISTS(SELECT 1 FROM app.reward_roles(wanted))
$$;
ALTER FUNCTION app.reward_rule_policy_reference(uuid) OWNER TO ai_hr_reward_setup_reader;
REVOKE ALL ON FUNCTION app.reward_rule_policy_reference(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.reward_rule_policy_reference(uuid) TO ai_hr_app;

-- BU seats follow the same effective company and approved BU as Personnel. The source owner
-- provides a deliberate legacy fallback; missing or pending managed grouping cannot admit a new seat.
CREATE FUNCTION app.reward_access_current_bu(wanted_person uuid,wanted_company uuid,wanted_bu uuid,wanted_tenant uuid,wanted_day date) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public,app AS $$
 SELECT EXISTS(SELECT 1 FROM employment e
 CROSS JOIN LATERAL app.company_org_employment_unchecked(e.id,wanted_day) tags(tag)
 WHERE e.tenant_id=app.current_tenant_id() AND e.tenant_id=wanted_tenant AND e.person_id=wanted_person
 AND e.hired_on<=wanted_day AND e.blacklisted_at IS NULL
 AND(least(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR wanted_day<=least(e.resignation_date,e.last_working_date,e.terminated_on))
 AND EXISTS(SELECT 1 FROM assignment a WHERE a.tenant_id=e.tenant_id AND a.employment_id=e.id AND a.superseded_at IS NULL AND a.valid_from<=wanted_day AND(a.valid_to IS NULL OR a.valid_to>wanted_day))
 AND tag->>'status' IN('ready','legacy') AND tag->>'companyId'=wanted_company::text AND tag->>'businessUnitId'=wanted_bu::text)
$$;
REVOKE ALL ON FUNCTION app.reward_access_current_bu(uuid,uuid,uuid,uuid,date) FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION app.reward_access_candidate_eligible(wanted_unit uuid,wanted_user uuid,wanted_role text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.reward_unit r JOIN public.app_user u ON u.tenant_id=r.tenant_id
 WHERE r.id=wanted_unit AND r.tenant_id=app.current_tenant_id() AND u.id=wanted_user AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked_on(u.id,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
 AND app.reward_access_scope(r.id) AND app.reward_access_candidate_visible(r.id,u.id)
 AND NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.person_id=u.person_id AND e.tenant_id=u.tenant_id AND e.tender_resignation_date<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date AND (least(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date<=least(e.resignation_date,e.last_working_date,e.terminated_on)))
 AND (wanted_role<>'bu' OR app.reward_access_current_bu(u.person_id,r.company_id,r.business_unit_id,r.tenant_id,timezone('Asia/Kuala_Lumpur',now())::date)));
$$;
CREATE OR REPLACE FUNCTION app.reward_member_state(wanted_member uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE m public.reward_member;u public.app_user;r public.reward_unit;day date:=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;changed date;
BEGIN
 SELECT * INTO m FROM public.reward_member WHERE id=wanted_member AND tenant_id=app.current_tenant_id();
 IF m.id IS NULL THEN RETURN jsonb_build_object('reason','unavailable','on',day); END IF;
 SELECT * INTO u FROM public.app_user WHERE id=m.user_id AND tenant_id=m.tenant_id;
 SELECT * INTO r FROM public.reward_unit WHERE id=m.unit_id AND tenant_id=m.tenant_id;
 IF u.id IS NULL OR u.archived_at IS NOT NULL OR app.login_blocked_on(u.id,(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date) THEN
 SELECT least(min((e.blacklisted_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date),min(least(e.resignation_date,e.last_working_date,e.terminated_on))) INTO changed FROM public.employment e WHERE e.tenant_id=m.tenant_id AND e.person_id=u.person_id;
 RETURN jsonb_build_object('reason','login','on',COALESCE((u.archived_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date,changed,m.valid_from)); END IF;
 IF m.valid_from>day THEN RETURN jsonb_build_object('reason','future','on',m.valid_from); END IF;
 IF m.valid_to<day THEN RETURN jsonb_build_object('reason','expired','on',m.valid_to); END IF;
 -- A restore never overrides a disabled login or an access window. It expires on any People change.
 IF m.restored_fingerprint=app.reward_member_people_fingerprint(m.user_id,m.unit_id) THEN RETURN NULL; END IF;
 SELECT min(e.tender_resignation_date) INTO changed FROM public.employment e WHERE e.tenant_id=m.tenant_id AND e.person_id=u.person_id AND e.tender_resignation_date<=day
 AND (least(e.resignation_date,e.last_working_date,e.terminated_on) IS NULL OR day<=least(e.resignation_date,e.last_working_date,e.terminated_on));
 IF changed IS NOT NULL THEN RETURN jsonb_build_object('reason','notice','on',changed); END IF;
 -- BU authority follows the current employment and effective assignment. Group seats are not BU-bound.
 IF m.role='bu' AND NOT app.reward_access_current_bu(u.person_id,r.company_id,r.business_unit_id,m.tenant_id,day) THEN
 SELECT max(a.valid_from) INTO changed FROM public.employment e JOIN public.assignment a ON a.employment_id=e.id AND a.tenant_id=e.tenant_id
 WHERE e.tenant_id=m.tenant_id AND e.person_id=u.person_id AND a.superseded_at IS NULL AND a.valid_from<=day;
 RETURN jsonb_build_object('reason','assignment','on',COALESCE(changed,m.valid_from)); END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION app.reward_member_people_fingerprint(wanted_user uuid,wanted_unit uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to((jsonb_build_object('user',jsonb_build_array(u.id,u.person_id,u.archived_at),'scope',jsonb_build_array(r.company_id,r.business_unit_id),
 'generation',jsonb_build_array(COALESCE((SELECT generation FROM public.reward_access_source_epoch g WHERE g.tenant_id=u.tenant_id AND g.source_kind='user' AND g.source_id=u.id),0),COALESCE((SELECT generation FROM public.reward_access_source_epoch g WHERE g.tenant_id=u.tenant_id AND g.source_kind='person' AND g.source_id=u.person_id),0)),
 'employment',COALESCE((SELECT jsonb_agg(jsonb_build_array(e.id,e.hired_on,e.company_id,e.tender_resignation_date,e.resignation_date,e.last_working_date,e.terminated_on,e.blacklisted_at,
 COALESCE((SELECT jsonb_agg(jsonb_build_array(a.id,a.business_unit_id,a.valid_from,a.valid_to,a.superseded_at) ORDER BY a.id) FROM public.assignment a WHERE a.employment_id=e.id AND a.tenant_id=e.tenant_id),'[]'::jsonb)) ORDER BY e.id)
 FROM public.employment e WHERE e.person_id=u.person_id AND e.tenant_id=u.tenant_id),'[]'::jsonb)) || coalesce((
 SELECT jsonb_build_object('managedOrganisation',jsonb_agg(jsonb_build_array(e.id,tag->>'companyId',tag->>'businessUnitId',tag->>'status') ORDER BY e.id))
 FROM public.employment e CROSS JOIN LATERAL app.company_org_employment_unchecked(e.id,timezone('Asia/Kuala_Lumpur',now())::date) tags(tag)
 LEFT JOIN LATERAL (SELECT a.business_unit_id,a.company_id FROM public.assignment a WHERE a.tenant_id=e.tenant_id AND a.employment_id=e.id AND a.superseded_at IS NULL AND a.valid_from<=timezone('Asia/Kuala_Lumpur',now())::date AND(a.valid_to IS NULL OR a.valid_to>timezone('Asia/Kuala_Lumpur',now())::date) ORDER BY a.valid_from DESC,a.id LIMIT 1) current_assignment ON true
 WHERE e.tenant_id=u.tenant_id AND e.person_id=u.person_id AND tag->>'status'<>'legacy'
 AND (tag->>'status'<>'ready' OR tag->>'companyId' IS DISTINCT FROM coalesce(current_assignment.company_id,e.company_id)::text OR tag->>'businessUnitId' IS DISTINCT FROM current_assignment.business_unit_id::text)
 HAVING count(*)>0),'{}'::jsonb))::text,'UTF8')),'hex')
 FROM public.app_user u JOIN public.reward_unit r ON r.tenant_id=u.tenant_id
 WHERE u.id=wanted_user AND r.id=wanted_unit AND u.tenant_id=app.current_tenant_id();
$$;
