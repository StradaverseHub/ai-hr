-- UNNUMBERED, UNINSTALLED disposable proof extension. Only the owned installer may
-- compose this after the exact315 receipt prototype. No page/worker adoption.
SET LOCAL search_path=pg_catalog,pg_temp;
DO $gate$
BEGIN
 IF current_user::regrole::oid IS DISTINCT FROM(SELECT relowner FROM pg_class WHERE oid='public.domain_event'::regclass)
 OR current_database()IS DISTINCT FROM current_setting('aihr.reward_policy_fixture.database',true)
 OR to_regnamespace('reward_audit_policy_private')IS NOT NULL
 THEN RAISE EXCEPTION 'Exact disposable Rewards policy owner required' USING ERRCODE='55000';END IF;
 PERFORM reward_audit_private.assert_profile();
END $gate$;
-- Exact native latest0864 trigger and BOTH PRE owner families; actual SQL
-- guard runs atomically before any new purpose object/profile is created.
DO $predecessor$
DECLARE expected record;p pg_proc;native_owner oid:=(SELECT relowner FROM pg_class WHERE oid='public.domain_event'::regclass);
BEGIN
 FOR expected IN SELECT * FROM(VALUES
  ('app._domain_event_next(uuid,boolean)','e045132f89b378e39a8ecebce70da078',2,ARRAY['p_tenant','p_try']::text[],1,'false','jsonb',false,false),
  ('app._domain_event_preimage_for(public.domain_event)','a8e839e23a62af89888a9d2b23c833b3',1,ARRAY['p_event']::text[],0,NULL::text,'jsonb',false,false),
  ('app._bank_event_scope_valid(text,jsonb,public.domain_event)','3a99df1ac592f93170f873c47f9d3365',3,ARRAY['p_scope','p_preimage','p_event']::text[],0,NULL::text,'boolean',false,false),
  ('app._bank_review_parent_fence()','b09e13ccb23c615dc50c43f906198749',0,NULL::text[],0,NULL::text,'trigger',false,false),
  ('app.assistant_bank_review_arm(uuid)','6d1ee57aefd755ac107f3282398e22eb',1,ARRAY['p_id']::text[],0,NULL::text,'void',true,false),
  ('app._bank_audit_owner_frame_guard()','f70f12b5a66a6a99a5f01a266b591a30',0,NULL::text[],0,NULL::text,'void',false,false),
  ('app.domain_event_chain_tg()','67c5ccec77df9b5690b086c206d0166a',0,NULL::text[],0,NULL::text,'trigger',false,true),
  ('app._assistant_catalogue_audit_preimage_guard()','5147c6c5635b44823e5283a57d86a0d1',0,NULL::text[],0,NULL::text,'trigger',false,false),
  ('app._assistant_catalogue_audit_owner_frame_guard()','c567cb10896020af14486b31d72b539c',0,NULL::text[],0,NULL::text,'void',false,false),
  ('app._assistant_catalogue_native_phase(uuid,text,tid,uuid)','7bebed36dc9c305bde20e9f8a42be22f',4,ARRAY['p_id','p_phase','p_tid','p_event']::text[],2,'NULL::tid, NULL::uuid','void',false,false),
  ('app._assistant_catalogue_interval_verified(uuid)','fa2b013ff8a82ab76fadefeaf327a83e',1,ARRAY['p_id']::text[],0,NULL::text,'boolean',false,false)
 )v(signature,body_md5,nargs,names,default_count,defaults,result,app_allowed,retained_trigger_acl)LOOP
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(expected.signature);
  IF NOT FOUND OR md5(p.prosrc)IS DISTINCT FROM expected.body_md5 OR p.proowner<>native_owner
  OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')OR NOT p.prosecdef OR p.provolatile<>'v'
  OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
  OR p.pronargs<>expected.nargs OR p.proargnames IS DISTINCT FROM expected.names OR p.pronargdefaults<>expected.default_count
  OR pg_get_expr(p.proargdefaults,0)IS DISTINCT FROM expected.defaults OR pg_get_function_result(p.oid)IS DISTINCT FROM expected.result
  OR p.proisstrict OR p.proleakproof OR p.proparallel<>'u'OR p.prokind<>'f'OR p.procost<>100 OR p.prorows<>0
  OR p.provariadic<>0 OR p.prosupport<>0::oid OR p.proallargtypes IS NOT NULL OR p.proargmodes IS NOT NULL
  OR p.probin IS NOT NULL OR p.protrftypes IS NOT NULL OR p.prosqlbody IS NOT NULL
  OR NOT expected.retained_trigger_acl AND EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))a
   WHERE a.privilege_type<>'EXECUTE'OR a.is_grantable OR a.grantor<>p.proowner OR a.grantee<>p.proowner AND(NOT expected.app_allowed OR a.grantee<>'ai_hr_app'::regrole::oid))
  THEN RAISE EXCEPTION 'Exact native audit PRE predecessor required: %',expected.signature USING ERRCODE='55000';END IF;
 END LOOP;
END $predecessor$;
CREATE SCHEMA reward_audit_policy_private;
REVOKE ALL ON SCHEMA reward_audit_policy_private FROM PUBLIC,ai_hr_app,ai_hr_reward_audit_read,ai_hr_reward_audit_projector;
CREATE TABLE reward_audit_policy_private.config(
 singleton boolean PRIMARY KEY CHECK(singleton),database_name name NOT NULL,owner_oid oid NOT NULL,
 version integer NOT NULL CHECK(version=1),canonical_source text NOT NULL CHECK(canonical_source~'^[a-f0-9]{64}$'),
 fallback_armed boolean NOT NULL,truth_contract jsonb NOT NULL,enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE reward_audit_policy_private.truth(
 setting_code smallint NOT NULL CHECK(setting_code IN(-1,0,1)),has_history boolean NOT NULL,env_armed boolean NOT NULL,
 armed boolean NOT NULL,refused_disarm boolean NOT NULL,reason text NOT NULL,
 PRIMARY KEY(setting_code,has_history,env_armed)
);
-- No content/actor/tenant FK or shared tenant row updated during receipt COMMIT.
CREATE TABLE reward_audit_policy_private.observation(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,actor_id uuid NOT NULL,observed_at timestamptz NOT NULL,
 root_xid xid8 NOT NULL,login_oid oid NOT NULL,backend_pid integer NOT NULL,backend_started_at timestamptz NOT NULL,
 policy_version integer NOT NULL CHECK(policy_version=1),setting_code smallint NOT NULL CHECK(setting_code IN(-1,0,1)),
 has_history boolean NOT NULL,env_armed boolean NOT NULL,durable_floor boolean NOT NULL,
 armed boolean NOT NULL,refused_disarm boolean NOT NULL,reason text NOT NULL
);
-- Immutable first armed receipt marker. No false/preexisting tenant row and no
-- UPDATE of a tenant hot row. A native RR freshness probe may insert a NULL
-- receipt only inside a subtransaction that must roll back before it returns.
CREATE TABLE reward_audit_policy_private.floor_marker(
 tenant_id uuid PRIMARY KEY,receipt_id uuid,actor_id uuid,observed_at timestamptz,
 policy_version integer NOT NULL CHECK(policy_version=1),
 CHECK((receipt_id IS NULL AND actor_id IS NULL AND observed_at IS NULL)
 OR(receipt_id IS NOT NULL AND actor_id IS NOT NULL AND observed_at IS NOT NULL))
);
CREATE TABLE reward_audit_policy_private.floor_frame(
 tenant_id uuid NOT NULL,root_xid xid8 NOT NULL,backend_pid integer NOT NULL,backend_started_at timestamptz NOT NULL,
 policy_version integer NOT NULL CHECK(policy_version=1),observed_floor boolean NOT NULL,
 PRIMARY KEY(tenant_id,root_xid)
);
CREATE TABLE reward_audit_policy_private.function_contract(signature regprocedure PRIMARY KEY,details jsonb NOT NULL);
CREATE TABLE reward_audit_policy_private.relation_contract(object_oid oid PRIMARY KEY,details jsonb NOT NULL);
CREATE TABLE reward_audit_policy_private.trigger_contract(object_oid oid PRIMARY KEY,details jsonb NOT NULL);
DO $tables$DECLARE r record;BEGIN
 FOR r IN SELECT c.oid::regclass AS relation FROM pg_class c WHERE c.relnamespace='reward_audit_policy_private'::regnamespace AND c.relkind='r' LOOP
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',r.relation);
  EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC,ai_hr_app,ai_hr_reward_audit_read,ai_hr_reward_audit_projector',r.relation);
 END LOOP;
END $tables$;
CREATE FUNCTION reward_audit_policy_private.assert_floor_profile()RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE c reward_audit_policy_private.config;
BEGIN
 -- Compare exact raw function metadata BEFORE invoking the relation decoder.
 IF EXISTS(SELECT 1 FROM reward_audit_policy_private.function_contract x LEFT JOIN pg_proc p ON p.oid=x.signature WHERE p.oid IS NULL OR to_jsonb(p)IS DISTINCT FROM x.details)
 OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='reward_audit_policy_private'::regnamespace AND NOT EXISTS(SELECT 1 FROM reward_audit_policy_private.function_contract x WHERE x.signature=p.oid))
 THEN RAISE EXCEPTION 'Exact native floor function closure required' USING ERRCODE='55000';END IF;
 SELECT * INTO c FROM reward_audit_policy_private.config WHERE singleton;
 IF NOT FOUND OR NOT c.enabled OR c.version<>1 OR c.database_name<>current_database()OR c.owner_oid<>current_user::regrole::oid
 OR c.owner_oid<>(SELECT relowner FROM pg_class WHERE oid='public.domain_event'::regclass)
 OR NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.oid='reward_audit_policy_private'::regnamespace AND n.nspowner=c.owner_oid)
 OR EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(nullif(coalesce(n.nspacl,acldefault('n',n.nspowner)),ARRAY[]::aclitem[]))g
  WHERE n.oid='reward_audit_policy_private'::regnamespace AND(g.grantee<>c.owner_oid OR g.grantor<>c.owner_oid))
 OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(nullif(coalesce(p.proacl,acldefault('f',p.proowner)),ARRAY[]::aclitem[]))g
  WHERE p.pronamespace='reward_audit_policy_private'::regnamespace AND(p.proowner<>c.owner_oid OR g.grantee<>c.owner_oid OR g.grantor<>c.owner_oid))
 OR EXISTS(SELECT 1 FROM pg_class r CROSS JOIN LATERAL aclexplode(nullif(coalesce(r.relacl,acldefault('r',r.relowner)),ARRAY[]::aclitem[]))g
  WHERE r.relnamespace='reward_audit_policy_private'::regnamespace AND(r.relowner<>c.owner_oid OR g.grantee<>c.owner_oid OR g.grantor<>c.owner_oid))
 OR EXISTS(SELECT 1 FROM pg_attribute a JOIN pg_class r ON r.oid=a.attrelid CROSS JOIN LATERAL unnest(a.attacl)g
  WHERE r.relnamespace='reward_audit_policy_private'::regnamespace)
 OR(SELECT count(*)FROM reward_audit_policy_private.truth)<>12
 OR(SELECT jsonb_agg(to_jsonb(t)ORDER BY t.setting_code,t.has_history,t.env_armed)FROM reward_audit_policy_private.truth t)IS DISTINCT FROM c.truth_contract
 OR EXISTS(SELECT 1 FROM reward_audit_policy_private.relation_contract x LEFT JOIN pg_class r ON r.oid=x.object_oid WHERE r.oid IS NULL OR reward_audit_private.relation_metadata(r.oid)IS DISTINCT FROM x.details)
 OR EXISTS(SELECT 1 FROM pg_class r WHERE r.relnamespace='reward_audit_policy_private'::regnamespace AND NOT EXISTS(SELECT 1 FROM reward_audit_policy_private.relation_contract x WHERE x.object_oid=r.oid))
 OR EXISTS(SELECT 1 FROM reward_audit_policy_private.trigger_contract x LEFT JOIN pg_trigger t ON t.oid=x.object_oid WHERE t.oid IS NULL OR to_jsonb(t)IS DISTINCT FROM x.details)
 OR EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid IN(SELECT object_oid FROM reward_audit_policy_private.relation_contract)AND NOT EXISTS(SELECT 1 FROM reward_audit_policy_private.trigger_contract x WHERE x.object_oid=t.oid))
 OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid IN(SELECT object_oid FROM reward_audit_policy_private.relation_contract))
 THEN RAISE EXCEPTION 'Exact native Rewards policy profile required' USING ERRCODE='55000';END IF;
END $body$;
CREATE FUNCTION reward_audit_policy_private.assert_profile()RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
BEGIN
 PERFORM reward_audit_policy_private.assert_floor_profile();PERFORM reward_audit_private.assert_profile();
END $body$;
CREATE FUNCTION reward_audit_policy_private.durable_floor(p_tenant uuid)RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
 SELECT EXISTS(SELECT 1 FROM reward_audit_policy_private.floor_marker WHERE tenant_id=p_tenant)
$body$;
CREATE FUNCTION reward_audit_policy_private.policy(p_tenant uuid)RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE setting_value jsonb;v_setting_code smallint;v_history boolean;v_floor boolean;c reward_audit_policy_private.config;t reward_audit_policy_private.truth;
BEGIN
 PERFORM reward_audit_policy_private.assert_profile();SELECT * INTO STRICT c FROM reward_audit_policy_private.config WHERE singleton;
 -- Same raw explicit-setting resolution as entitlements + readChainSetting;
 -- missing/malformed remains NULL, never the setting catalogue's defaultfalse.
 SELECT ts.value INTO setting_value FROM public.tenant_setting ts JOIN public.setting_definition sd ON sd.key=ts.key
 WHERE ts.tenant_id=p_tenant AND ts.key='audit.hash_chain_enabled'AND(sd.scope='tenant'OR ts.source<>'customer');
 v_setting_code:=CASE setting_value WHEN 'true'::jsonb THEN 1 WHEN 'false'::jsonb THEN 0 ELSE -1 END;
 SELECT EXISTS(SELECT 1 FROM public.domain_event WHERE tenant_id=p_tenant AND chain_seq IS NOT NULL)INTO v_history;
 v_floor:=reward_audit_policy_private.durable_floor(p_tenant);
 SELECT * INTO STRICT t FROM reward_audit_policy_private.truth x WHERE x.setting_code=v_setting_code AND x.has_history=v_history AND x.env_armed=c.fallback_armed;
 RETURN jsonb_build_object('version',c.version,'settingCode',v_setting_code,'hasHistory',v_history,'envArmed',c.fallback_armed,'durableFloor',v_floor,
 'armed',t.armed OR v_floor,'refusedDisarm',t.refused_disarm OR v_floor AND NOT t.armed,'reason',t.reason);
END $body$;
CREATE FUNCTION reward_audit_policy_private.observe(p_id uuid)RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE r reward_audit_private.admission;p jsonb;
BEGIN
 r:=reward_audit_private.current_admission();IF r.id IS DISTINCT FROM p_id THEN RAISE EXCEPTION 'Exact native policy admission required' USING ERRCODE='42501';END IF;
 p:=reward_audit_policy_private.policy(r.tenant_id);
 INSERT INTO reward_audit_policy_private.observation(id,tenant_id,actor_id,observed_at,root_xid,login_oid,backend_pid,backend_started_at,policy_version,setting_code,has_history,env_armed,durable_floor,armed,refused_disarm,reason)
 VALUES(r.id,r.tenant_id,r.actor_id,r.observed_at,r.xid,r.login_oid,r.backend_pid,r.backend_start,(p->>'version')::integer,(p->>'settingCode')::smallint,
 (p->>'hasHistory')::boolean,(p->>'envArmed')::boolean,(p->>'durableFloor')::boolean,(p->>'armed')::boolean,(p->>'refusedDisarm')::boolean,p->>'reason');
END $body$;
CREATE FUNCTION reward_audit_policy_private.require_observation(p_id uuid)RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE r reward_audit_private.admission;
BEGIN
 PERFORM reward_audit_policy_private.assert_profile();r:=reward_audit_private.current_admission();
 IF r.id IS DISTINCT FROM p_id OR NOT EXISTS(SELECT 1 FROM reward_audit_policy_private.observation o WHERE o.id=r.id AND o.tenant_id=r.tenant_id AND o.actor_id=r.actor_id
 AND o.observed_at=r.observed_at AND o.root_xid=r.xid AND o.login_oid=r.login_oid AND o.backend_pid=r.backend_pid AND o.backend_started_at=r.backend_start AND o.policy_version=1)
 THEN RAISE EXCEPTION 'Exact native observed audit policy required' USING ERRCODE='42501';END IF;
END $body$;
-- No FK locks on content, actor or tenant tuples. This deferred native
-- obligation is the only persistent floor creation route. The exact profile
-- seals this trigger, all tables and both immutable source relations.
CREATE FUNCTION reward_audit_policy_private.require_marker_receipt()RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
BEGIN
 PERFORM reward_audit_policy_private.assert_floor_profile();
 IF NEW.receipt_id IS NULL OR NEW.actor_id IS NULL OR NEW.observed_at IS NULL OR NEW.policy_version<>1
 OR NOT EXISTS(SELECT 1 FROM reward_audit_policy_private.observation o JOIN reward_audit_private.receipt r
  ON r.id=o.id AND r.tenant_id=o.tenant_id AND r.actor_id=o.actor_id AND r.observed_at=o.observed_at
  WHERE o.id=NEW.receipt_id AND o.tenant_id=NEW.tenant_id AND o.actor_id=NEW.actor_id AND o.observed_at=NEW.observed_at
  AND o.policy_version=NEW.policy_version AND o.armed AND r.version=1)
 THEN RAISE EXCEPTION 'Exact committed armed receipt floor required' USING ERRCODE='55000';END IF;
 RETURN NEW;
END $body$;
CREATE CONSTRAINT TRIGGER reward_audit_policy_marker_complete AFTER INSERT ON reward_audit_policy_private.floor_marker
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reward_audit_policy_private.require_marker_receipt();
CREATE TRIGGER reward_audit_policy_marker_immutable BEFORE UPDATE OR DELETE ON reward_audit_policy_private.floor_marker
 FOR EACH ROW EXECUTE FUNCTION reward_audit_private.immutable();
CREATE FUNCTION reward_audit_policy_private.mark_receipt_floor(p_id uuid)RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE a reward_audit_private.admission;o reward_audit_policy_private.observation;
BEGIN
 PERFORM reward_audit_policy_private.require_observation(p_id);a:=reward_audit_private.current_admission();
 SELECT * INTO STRICT o FROM reward_audit_policy_private.observation WHERE id=a.id;
 IF o.armed THEN
  INSERT INTO reward_audit_policy_private.floor_marker(tenant_id,receipt_id,actor_id,observed_at,policy_version)
  VALUES(o.tenant_id,o.id,o.actor_id,o.observed_at,o.policy_version)ON CONFLICT(tenant_id)DO NOTHING;
 END IF;
END $body$;
-- Test-only synchronization seam; exact owner-only SECINVOKER body is sealed.
-- The owned fixture may temporarily replace ONLY this no-op with a fixed native
-- lock wait, then restore exact source/metadata before another case. Uninstalled.
CREATE FUNCTION reward_audit_policy_private.probe_checkpoint(p_tenant uuid)RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $body$
BEGIN RETURN;END
$body$;
CREATE FUNCTION reward_audit_policy_private.snapshot_floor(p_tenant uuid)RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE affected bigint;result boolean;token text:=gen_random_uuid()::text;detail text;message text;
BEGIN
 -- RC's per-command snapshot sees earlier committed markers. A visible true
 -- marker is immutable in every mode. Only a false fixed snapshot needs a
 -- native uniqueness probe; never convert 40001 into a benign false result.
 IF reward_audit_policy_private.durable_floor(p_tenant)THEN RETURN true;END IF;
 IF current_setting('transaction_isolation')='read committed'THEN RETURN false;END IF;
 IF current_setting('transaction_isolation')NOT IN('repeatable read','serializable')OR current_setting('transaction_read_only')<>'off'
 THEN RAISE EXCEPTION 'Native write floor snapshot required' USING ERRCODE='42501';END IF;
 BEGIN
  -- This setting and ALL probe writes roll back together, preserving callers
  -- that previously used SET CONSTRAINTS ALL IMMEDIATE. No probe can escape.
  SET CONSTRAINTS reward_audit_policy_private.reward_audit_policy_marker_complete DEFERRED;
  INSERT INTO reward_audit_policy_private.floor_marker(tenant_id,policy_version)VALUES(p_tenant,1)ON CONFLICT(tenant_id)DO NOTHING;
  GET DIAGNOSTICS affected=ROW_COUNT;result:=affected=0;
  PERFORM reward_audit_policy_private.probe_checkpoint(p_tenant);
  -- PG16 DO NOTHING checks a conflicting tuple against a fixed MVCC snapshot:
  -- an invisible committed marker raises 40001 BEFORE reaching this sentinel.
  RAISE EXCEPTION 'Native rolled-back floor probe' USING ERRCODE='ZXF01',DETAIL=token;
 EXCEPTION WHEN SQLSTATE 'ZXF01' THEN
  GET STACKED DIAGNOSTICS detail=PG_EXCEPTION_DETAIL,message=MESSAGE_TEXT;
  IF detail IS DISTINCT FROM token OR message IS DISTINCT FROM 'Native rolled-back floor probe' THEN RAISE;END IF;
 END;
 RETURN result;
END $body$;
CREATE FUNCTION reward_audit_policy_private.cleanup_frames(p_limit integer)RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE n integer;
BEGIN
 PERFORM reward_audit_policy_private.assert_floor_profile();
 IF current_setting('transaction_isolation')<>'read committed'OR current_setting('transaction_read_only')<>'off'OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 64
 THEN RAISE EXCEPTION 'Exact bounded native frame cleanup required' USING ERRCODE='42501';END IF;
 -- Only inserts from OTHER transactions visible here can have committed. An
 -- active uncommitted insert is invisible; no backend kill/age guess is used.
 WITH old AS(SELECT tenant_id,root_xid FROM reward_audit_policy_private.floor_frame WHERE root_xid<>pg_current_xact_id()
 ORDER BY root_xid,tenant_id FOR UPDATE SKIP LOCKED LIMIT p_limit)
 DELETE FROM reward_audit_policy_private.floor_frame f USING old o WHERE f.tenant_id=o.tenant_id AND f.root_xid=o.root_xid;
 GET DIAGNOSTICS n=ROW_COUNT;RETURN n;
END $body$;
CREATE FUNCTION reward_audit_policy_private.floor_for_xact(p_tenant uuid)RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE r reward_audit_policy_private.floor_frame;x xid8:=pg_current_xact_id();started timestamptz;key bigint:=hashtext('audit-chain:'||p_tenant::text);floor boolean;
BEGIN
 PERFORM reward_audit_policy_private.assert_floor_profile();SELECT backend_start INTO STRICT started FROM pg_stat_activity WHERE pid=pg_backend_pid();
 -- This is additional physical evidence. The exact source/EXEC closure also
 -- retains _domain_event_next's real pg_advisory_xact_lock before this helper.
 IF p_tenant IS NULL OR NOT EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=pg_backend_pid()AND l.locktype='advisory'AND l.granted AND l.mode='ExclusiveLock'
 AND l.objsubid=1 AND l.classid=((key>>32)&4294967295)::oid AND l.objid=(key&4294967295)::oid)
 THEN RAISE EXCEPTION 'Actual native History frame required' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM reward_audit_policy_private.floor_frame WHERE tenant_id=p_tenant AND root_xid=x;
 IF FOUND THEN
  IF r.backend_pid<>pg_backend_pid()OR r.backend_started_at<>started OR r.policy_version<>1 THEN RAISE EXCEPTION 'Native audit floor frame identity changed' USING ERRCODE='42501';END IF;
  RETURN r.observed_floor;
 END IF;
 -- RC housekeeping is separate from fixed-snapshot freshness. Native conflict
 -- detection protects RR writers without changing transaction isolation.
 IF current_setting('transaction_isolation')='read committed'THEN PERFORM reward_audit_policy_private.cleanup_frames(8);END IF;
 floor:=reward_audit_policy_private.snapshot_floor(p_tenant);
 INSERT INTO reward_audit_policy_private.floor_frame VALUES(p_tenant,x,pg_backend_pid(),started,1,floor);
 RETURN floor;
END $body$;
CREATE TRIGGER reward_audit_policy_observation_immutable BEFORE UPDATE OR DELETE ON reward_audit_policy_private.observation FOR EACH ROW EXECUTE FUNCTION reward_audit_private.immutable();
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA reward_audit_policy_private FROM PUBLIC,ai_hr_app,ai_hr_reward_audit_read,ai_hr_reward_audit_projector;
-- The owner installs the canonical generated truth contract/protected fixture
-- config and exact native function/relation/trigger contracts before enabling.

-- A lost service acknowledgment must reconcile the exact own receipt before
-- deciding whether another actual read is needed. This returns no old HR data.
CREATE FUNCTION reward_audit_read.reconcile_receipt(p_id uuid)RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE r reward_audit_private.receipt;a reward_audit_private.authority;
BEGIN
 PERFORM reward_audit_policy_private.assert_profile();SELECT * INTO STRICT a FROM reward_audit_private.authority WHERE singleton;
 IF session_user::regrole::oid<>a.reader_oid OR current_setting('transaction_isolation')<>'repeatable read'OR current_setting('transaction_read_only')<>'on'
 OR NOT reward_audit_private.current_actor()THEN RAISE EXCEPTION 'Current own audit receipt reader required' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM reward_audit_private.receipt WHERE id=p_id AND tenant_id=app.current_tenant_id()AND actor_id=app.current_user_id();
 IF NOT FOUND THEN RETURN NULL;END IF;
 IF NOT app.reward_setup_allowed(NULL,CASE WHEN r.operation='libraries'THEN 'library_view'ELSE 'manage'END)
 OR NOT EXISTS(SELECT 1 FROM reward_audit_policy_private.observation o WHERE o.id=r.id AND o.tenant_id=r.tenant_id AND o.actor_id=r.actor_id AND o.observed_at=r.observed_at)
 THEN RAISE EXCEPTION 'Current own audit receipt authority required' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('id',r.id,'observedAt',r.observed_at,'armed',(SELECT o.armed FROM reward_audit_policy_private.observation o WHERE o.id=r.id),
 'projected',EXISTS(SELECT 1 FROM reward_audit_private.projection p WHERE p.receipt_id=r.id));
END $body$;
REVOKE ALL ON FUNCTION reward_audit_read.reconcile_receipt(uuid)FROM PUBLIC,ai_hr_app,ai_hr_reward_audit_projector;
GRANT EXECUTE ON FUNCTION reward_audit_read.reconcile_receipt(uuid)TO ai_hr_reward_audit_read;
