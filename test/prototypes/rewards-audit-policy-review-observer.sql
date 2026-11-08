-- UNINSTALLED, exact disposable fixture only. Not a migration or service API.
DO $admit$ BEGIN
 IF current_setting('aihr.reward_policy_observer.database',true) IS DISTINCT FROM current_database()
 OR current_user IS DISTINCT FROM session_user
 OR current_user::regrole::oid<>(SELECT relowner FROM pg_class WHERE oid='public.domain_event'::regclass)
 OR to_regnamespace('reward_policy_test') IS NOT NULL OR to_regnamespace('reward_policy_test_private') IS NOT NULL
 THEN RAISE EXCEPTION 'Owned test review observer installation refused' USING ERRCODE='55000';END IF;
END $admit$;
CREATE SCHEMA reward_policy_test;
CREATE SCHEMA reward_policy_test_private;
REVOKE ALL ON SCHEMA reward_policy_test,reward_policy_test_private FROM PUBLIC,ai_hr_app,ai_hr_reward_audit_read,ai_hr_reward_audit_projector;
CREATE TABLE reward_policy_test_private.config(
 singleton boolean PRIMARY KEY CHECK(singleton),database_name name NOT NULL,owner_oid oid NOT NULL,
 login_oid oid NOT NULL,enabled boolean NOT NULL DEFAULT false,function_details jsonb NOT NULL,
 decoder_details jsonb NOT NULL,schema_contract jsonb NOT NULL,relation_contract jsonb NOT NULL
);
CREATE TABLE reward_policy_test_private.binding(
 review_id uuid PRIMARY KEY,tenant_id uuid NOT NULL,actor_id uuid NOT NULL,
 action_kind text NOT NULL CHECK(action_kind IN('employees.bank.maintain','org.position.archive')),
 login_oid oid NOT NULL,backend_pid integer NOT NULL CHECK(backend_pid>1),
 backend_started_at timestamptz NOT NULL,root_xid xid8 NOT NULL
);
ALTER TABLE reward_policy_test_private.config ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_policy_test_private.binding ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA reward_policy_test_private FROM PUBLIC,ai_hr_app,ai_hr_reward_audit_read,ai_hr_reward_audit_projector;
CREATE FUNCTION reward_policy_test.read_review(p_review uuid,p_action text)RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE c reward_policy_test_private.config;b reward_policy_test_private.binding;review_row record;actual jsonb;
BEGIN
 SELECT * INTO c FROM reward_policy_test_private.config WHERE singleton;
 IF NOT FOUND OR c.enabled IS DISTINCT FROM true OR c.database_name IS DISTINCT FROM current_database()
 OR c.owner_oid IS DISTINCT FROM current_user::regrole::oid
 OR c.owner_oid IS DISTINCT FROM (SELECT relowner FROM pg_class WHERE oid='public.domain_event'::regclass)
 OR c.login_oid IS DISTINCT FROM 'ai_hr_app'::regrole::oid
 OR (SELECT to_jsonb(p)FROM pg_proc p WHERE p.oid='reward_policy_test.read_review(uuid,text)'::regprocedure)IS DISTINCT FROM c.function_details
 OR (SELECT to_jsonb(p)FROM pg_proc p WHERE p.oid='reward_audit_private.relation_metadata(oid)'::regprocedure)IS DISTINCT FROM c.decoder_details
 THEN RAISE EXCEPTION 'Owned test review observer profile changed' USING ERRCODE='55000';END IF;
 SELECT jsonb_agg(to_jsonb(n)ORDER BY n.nspname)INTO actual FROM pg_namespace n WHERE n.nspname IN('reward_policy_test','reward_policy_test_private');
 IF actual IS DISTINCT FROM c.schema_contract THEN RAISE EXCEPTION 'Owned test review observer profile changed' USING ERRCODE='55000';END IF;
 SELECT jsonb_agg(jsonb_build_object('name',r.oid::regclass::text,'details',reward_audit_private.relation_metadata(r.oid))ORDER BY r.oid)INTO actual
 FROM pg_class r WHERE r.relnamespace IN('reward_policy_test'::regnamespace,'reward_policy_test_private'::regnamespace)AND r.relkind NOT IN('i','I');
 IF actual IS DISTINCT FROM c.relation_contract
 OR EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid WHERE r.relnamespace IN('reward_policy_test'::regnamespace,'reward_policy_test_private'::regnamespace))
 OR EXISTS(SELECT 1 FROM pg_policy p JOIN pg_class r ON r.oid=p.polrelid WHERE r.relnamespace IN('reward_policy_test'::regnamespace,'reward_policy_test_private'::regnamespace))
 OR (SELECT count(*)FROM pg_proc p WHERE p.pronamespace IN('reward_policy_test'::regnamespace,'reward_policy_test_private'::regnamespace))<>1
 THEN RAISE EXCEPTION 'Owned test review observer profile changed' USING ERRCODE='55000';END IF;
 IF p_review IS NULL OR p_action IS NULL OR p_action NOT IN('employees.bank.maintain','org.position.archive')
 OR session_user::regrole::oid IS DISTINCT FROM c.login_oid OR current_setting('role')<>'none'
 OR app.principal_snapshot_current()IS NOT TRUE
 THEN RAISE EXCEPTION 'Owned test review observation refused' USING ERRCODE='42501';END IF;
 SELECT * INTO b FROM reward_policy_test_private.binding x WHERE x.review_id=p_review AND x.action_kind=p_action
 AND x.tenant_id=app.current_tenant_id()AND x.actor_id=app.current_user_id()
 AND x.login_oid=session_user::regrole::oid AND x.backend_pid=pg_backend_pid()
 AND x.backend_started_at=(SELECT backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid())AND x.root_xid=pg_current_xact_id();
 IF NOT FOUND THEN RAISE EXCEPTION 'Owned test review observation refused' USING ERRCODE='42501';END IF;
 SELECT tenant_id,user_id,action_kind,state,bank_retained_root_xid,bank_audit_preimage,
 catalogue_native_root,catalogue_native_phase,catalogue_audit_preimage INTO review_row
 FROM app.assistant_own_leave_review WHERE id=p_review;
 IF NOT FOUND OR review_row.tenant_id IS DISTINCT FROM b.tenant_id OR review_row.user_id IS DISTINCT FROM b.actor_id
 OR review_row.action_kind IS DISTINCT FROM b.action_kind OR review_row.state<>'awaiting_confirmation'
 OR p_action='employees.bank.maintain'AND review_row.bank_retained_root_xid IS DISTINCT FROM b.root_xid
 OR p_action='org.position.archive'AND review_row.catalogue_native_root IS NOT NULL AND review_row.catalogue_native_root IS DISTINCT FROM b.root_xid
 THEN RAISE EXCEPTION 'Owned test review observation refused' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('phase',CASE WHEN p_action='org.position.archive'THEN review_row.catalogue_native_phase ELSE NULL END,
  'pre',CASE WHEN p_action='employees.bank.maintain'THEN review_row.bank_audit_preimage ELSE review_row.catalogue_audit_preimage END);
END $body$;
REVOKE ALL ON FUNCTION reward_policy_test.read_review(uuid,text)FROM PUBLIC,ai_hr_app,ai_hr_reward_audit_read,ai_hr_reward_audit_projector;
GRANT USAGE ON SCHEMA reward_policy_test TO ai_hr_app;
GRANT EXECUTE ON FUNCTION reward_policy_test.read_review(uuid,text)TO ai_hr_app;
