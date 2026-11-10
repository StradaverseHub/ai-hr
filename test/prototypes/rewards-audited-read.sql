-- UNNUMBERED, UNINSTALLED owned-CI prototype. Execute this whole file atomically.
-- No production installation, page adoption, chain arming or legacy reader replacement.
SET LOCAL search_path=pg_catalog,pg_temp;
DO $gate$
DECLARE expected text:=current_setting('aihr.reward_audit_fixture.database',true);
 namespace text:=current_setting('aihr.reward_audit_fixture.namespace',true);pool_id text:=current_setting('aihr.reward_audit_fixture.pool_id',true);canonical text;
BEGIN
 IF namespace IS NULL OR length(namespace)>20 OR(namespace<>''AND namespace!~'^_?[a-z0-9][a-z0-9_]*$')OR pool_id IS NULL OR pool_id!~'^[1-9][0-9]*$'THEN RAISE EXCEPTION 'Canonical disposable Rewards database binding required' USING ERRCODE='55000';END IF;
 canonical:='ai_hr_test_w'||CASE WHEN namespace=''THEN ''WHEN left(namespace,1)='_'THEN namespace ELSE '_'||namespace END||pool_id;
 IF expected IS NULL OR expected IS DISTINCT FROM canonical OR current_database() IS DISTINCT FROM expected
 OR current_user::regrole::oid IS DISTINCT FROM (SELECT relowner FROM pg_class WHERE oid='public.domain_event'::regclass)
 OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname IN('reward_audit_read','reward_audit_projection','reward_audit_private'))
 OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_reward_audit_read' AND rolcanlogin AND NOT rolsuper AND NOT rolinherit AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication)
 OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_reward_audit_projector' AND rolcanlogin AND NOT rolsuper AND NOT rolinherit AND NOT rolbypassrls AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication)
 OR NOT has_schema_privilege('ai_hr_reward_audit_read','public','USAGE')
 THEN RAISE EXCEPTION 'Exact clean disposable Rewards audit owner required' USING ERRCODE='55000';END IF;
END $gate$;

-- Fixed canonical predecessor identities, BEFORE any purpose object/privilege change.
DO $predecessors$
DECLARE expected record;p pg_proc;native_owner oid:=(SELECT relowner FROM pg_class WHERE oid='public.domain_event'::regclass);expected_owner oid;
BEGIN
 FOR expected IN SELECT * FROM(VALUES
  ('app.reward_setup_allowed(uuid,text)','b49b2eb7457182ca5770d4ebaf75e526','ai_hr_reward_setup_reader','sql','s','search_path=pg_catalog, public, app','boolean',ARRAY['wanted_company','wanted_operation']::text[],false,2,0),
  ('app.reward_library_used_by(uuid)','6e58d32ca23d982690ee131309c29aa2','ai_hr_reward_setup_reader','sql','s','search_path=pg_catalog, public, app','TABLE(plan text, company text, year integer)',ARRAY['wanted_version','plan','company','year']::text[],true,1,0),
  ('app.reward_library_locked(uuid)','c4a444e6431828797272c1e0f3253371','ai_hr_reward_setup_reader','sql','s','search_path=pg_catalog, public, app','boolean',ARRAY['wanted_version']::text[],false,1,0),
  ('app.reward_setup_companies(integer)','b1af144133d96175d962cd6d7ec14443','ai_hr_reward_setup_reader','sql','s','search_path=pg_catalog, public, app','TABLE(id uuid, name text, "parentId" uuid, "parentName" text)',ARRAY['wanted_year','id','name','parentId','parentName']::text[],true,1,0),
  ('app.reward_private_pat_history(uuid,integer)','d1913b119fe830fd51dc6c10c30e29bc','ai_hr_reward_setup_reader','plpgsql','s','search_path=pg_catalog, public, app','SETOF jsonb',ARRAY['wanted_company','wanted_year']::text[],true,2,0),
  ('app.reward_company_structure(uuid,date)','cbd10859b7b4dec0c034dedb8a54ac96','ai_hr_reward_setup_reader','plpgsql','s','search_path=pg_catalog, public, app','jsonb',ARRAY['wanted_company','wanted_date']::text[],false,2,0),
  ('app.principal_snapshot_current()','4eac75e69dbb1793bb23c2b1f28a38f4','native','plpgsql','s','search_path=pg_catalog, public, pg_temp','boolean',NULL::text[],false,0,0),
  ('app.domain_event_chain_tg()','aeecd386c91435bd6d5f553e96da5edd','native','plpgsql','v','search_path=pg_catalog, public, pg_temp','trigger',NULL::text[],false,0,0),
  ('app._domain_event_next(uuid,boolean)','e045132f89b378e39a8ecebce70da078','native','plpgsql','v','search_path=pg_catalog, public, pg_temp','jsonb',ARRAY['p_tenant','p_try']::text[],false,2,1)
 )v(signature,body_md5,owner_name,language,volatility,configuration,result,names,returns_set,input_count,default_count)LOOP
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(expected.signature);
  expected_owner:=CASE WHEN expected.owner_name='native'THEN native_owner ELSE expected.owner_name::regrole::oid END;
  IF NOT FOUND OR p.proowner IS DISTINCT FROM expected_owner OR md5(p.prosrc)IS DISTINCT FROM expected.body_md5
  OR p.prolang IS DISTINCT FROM(SELECT oid FROM pg_language WHERE lanname=expected.language)
  OR p.proargnames IS DISTINCT FROM expected.names OR p.pronargs<>expected.input_count OR p.pronargdefaults<>expected.default_count
  OR p.prorettype IS NULL OR pg_get_function_result(p.oid)IS DISTINCT FROM expected.result OR p.proretset IS DISTINCT FROM expected.returns_set
  OR pg_get_expr(p.proargdefaults,0)IS DISTINCT FROM (CASE WHEN expected.default_count=1 THEN 'false'ELSE NULL END)
  OR p.prokind<>'f'OR p.provariadic<>0 OR p.prosqlbody IS NOT NULL OR p.probin IS NOT NULL OR p.protrftypes IS NOT NULL
  OR NOT p.prosecdef OR p.proisstrict OR p.proleakproof OR p.provolatile<>expected.volatility OR p.proparallel<>'u'
  OR p.procost<>100 OR p.prorows<>(CASE WHEN expected.returns_set THEN 1000 ELSE 0 END) OR p.prosupport<>0::oid
  OR p.proconfig IS DISTINCT FROM ARRAY[expected.configuration]
  THEN RAISE EXCEPTION 'Exact canonical Rewards audit predecessor required: %',expected.signature USING ERRCODE='55000';END IF;
  IF expected.owner_name<>'native'AND((SELECT count(*)FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>2
   OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))g WHERE g.grantor<>expected_owner OR g.grantee NOT IN(expected_owner,'ai_hr_app'::regrole::oid)OR g.privilege_type<>'EXECUTE'OR g.is_grantable))
  THEN RAISE EXCEPTION 'Exact canonical Rewards helper ACL required' USING ERRCODE='55000';END IF;
 END LOOP;
 FOR expected IN SELECT * FROM(VALUES
  ('app.current_tenant_id()','b69de56599d1d372c0a775eccd111aef'),
  ('app.current_user_id()','3bc28e512c0d45b405e5e34682c31d25')
 )v(signature,body_md5)LOOP
  SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(expected.signature);
  IF NOT FOUND OR p.proowner<>native_owner OR md5(p.prosrc)IS DISTINCT FROM expected.body_md5 OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='sql')
   OR p.pronargs<>0 OR p.pronargdefaults<>0 OR p.proargdefaults IS NOT NULL OR p.proargnames IS NOT NULL OR p.prorettype<>'uuid'::regtype::oid OR p.proretset OR p.proconfig IS NOT NULL
   OR p.prosecdef OR p.proisstrict OR p.proleakproof OR p.provolatile<>'s'OR p.proparallel<>'u'OR p.prokind<>'f'OR p.provariadic<>0 OR p.prosqlbody IS NOT NULL OR p.probin IS NOT NULL OR p.protrftypes IS NOT NULL OR p.proallargtypes IS NOT NULL OR p.proargmodes IS NOT NULL
   OR p.procost<>100 OR p.prorows<>0 OR p.prosupport<>0::oid
  THEN RAISE EXCEPTION 'Exact native Rewards context predecessor required' USING ERRCODE='55000';END IF;
 END LOOP;
 SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure('app.domain_event_hash(text,uuid,bigint,text,uuid,text,text,uuid,uuid,jsonb)');
 IF NOT FOUND OR p.proowner<>native_owner OR md5(p.prosrc)<>'fccd99adab0af7f3d8e5a24964e489f4'OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='sql')
 OR p.pronargs<>10 OR p.pronargdefaults<>0 OR p.proargdefaults IS NOT NULL OR p.prorettype<>'text'::regtype::oid OR p.proretset OR p.proconfig IS NOT NULL
 OR p.proargnames IS DISTINCT FROM ARRAY['p_prev_hash','p_tenant','p_chain_seq','p_agg_type','p_agg_id','p_event_type','p_actor_type','p_actor_id','p_subject','p_payload']::text[]OR p.proallargtypes IS NOT NULL OR p.proargmodes IS NOT NULL
 OR p.prosecdef OR p.proisstrict OR p.proleakproof OR p.provolatile<>'i'OR p.proparallel<>'u'OR p.prokind<>'f'OR p.provariadic<>0 OR p.prosqlbody IS NOT NULL OR p.probin IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.procost<>100 OR p.prorows<>0 OR p.prosupport<>0::oid
 THEN RAISE EXCEPTION 'Exact canonical audit hash owner required' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class IN('public.reward_library'::regclass,'public.reward_library_version'::regclass,'public.domain_event'::regclass))THEN RAISE EXCEPTION 'Unexpected Rewards source rewrite rules' USING ERRCODE='55000';END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.domain_event'::regclass AND tgname='domain_event_chain_tg'AND tgfoid='app.domain_event_chain_tg()'::regprocedure AND tgtype=7 AND tgenabled='O'AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred AND tgnargs=0 AND octet_length(tgargs)=0 AND tgqual IS NULL)
 THEN RAISE EXCEPTION 'Exact canonical audit trigger required' USING ERRCODE='55000';END IF;
END $predecessors$;

CREATE SCHEMA reward_audit_read;
CREATE SCHEMA reward_audit_projection;
CREATE SCHEMA reward_audit_private;
REVOKE ALL ON SCHEMA reward_audit_read,reward_audit_projection,reward_audit_private FROM PUBLIC,ai_hr_app;
GRANT USAGE ON SCHEMA reward_audit_read TO ai_hr_reward_audit_read;
GRANT USAGE ON SCHEMA reward_audit_projection TO ai_hr_reward_audit_projector;

-- No business, actor, tenant or content FK: receipt commitment must not wait for
-- an Access/History/content writer. Native admission derives every field.
CREATE TABLE reward_audit_private.authority(
 singleton boolean PRIMARY KEY CHECK(singleton),database_name name NOT NULL,
 owner_oid oid NOT NULL,reader_oid oid NOT NULL,projector_oid oid NOT NULL,
 version integer NOT NULL CHECK(version=1),enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE reward_audit_private.admission(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 aggregate_id uuid NOT NULL DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,actor_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN('libraries','pat')),kind text CHECK(kind IN('salary','bonus')),
 year integer CHECK(year BETWEEN 2000 AND 2200),observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 login_oid oid NOT NULL,backend_pid integer NOT NULL,backend_start timestamptz NOT NULL,xid xid8 NOT NULL,
 CHECK(operation='libraries' OR kind IS NULL AND year IS NOT NULL),
 UNIQUE(login_oid,backend_pid,backend_start,xid)
);
CREATE TABLE reward_audit_private.receipt(
 id uuid PRIMARY KEY,event_id uuid NOT NULL UNIQUE,aggregate_id uuid NOT NULL,
 tenant_id uuid NOT NULL,actor_id uuid NOT NULL,version integer NOT NULL CHECK(version=1),
 operation text NOT NULL CHECK(operation IN('libraries','pat')),kind text CHECK(kind IN('salary','bonus')),
 year integer CHECK(year BETWEEN 2000 AND 2200),observed_at timestamptz NOT NULL,
 CHECK(operation='libraries' OR kind IS NULL AND year IS NOT NULL)
);
CREATE TABLE reward_audit_private.projection(
 receipt_id uuid PRIMARY KEY,event_id uuid NOT NULL UNIQUE,appended_at timestamptz NOT NULL
);
CREATE TABLE reward_audit_private.function_contract(signature regprocedure PRIMARY KEY,details jsonb NOT NULL);
CREATE TABLE reward_audit_private.relation_contract(object_oid oid PRIMARY KEY,details jsonb NOT NULL);
CREATE TABLE reward_audit_private.policy_contract(object_oid oid PRIMARY KEY,details jsonb NOT NULL);
CREATE TABLE reward_audit_private.trigger_contract(object_oid oid PRIMARY KEY,details jsonb NOT NULL);
ALTER TABLE reward_audit_private.authority ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_audit_private.admission ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_audit_private.receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_audit_private.projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_audit_private.function_contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_audit_private.relation_contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_audit_private.policy_contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE reward_audit_private.trigger_contract ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA reward_audit_private FROM PUBLIC,ai_hr_app,ai_hr_reward_audit_read,ai_hr_reward_audit_projector;

CREATE FUNCTION reward_audit_private.immutable() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
BEGIN RAISE EXCEPTION 'Rewards audit provenance is immutable' USING ERRCODE='42501';END $body$;
CREATE TRIGGER reward_audit_receipt_immutable BEFORE UPDATE OR DELETE ON reward_audit_private.receipt FOR EACH ROW EXECUTE FUNCTION reward_audit_private.immutable();
CREATE TRIGGER reward_audit_projection_immutable BEFORE UPDATE OR DELETE ON reward_audit_private.projection FOR EACH ROW EXECUTE FUNCTION reward_audit_private.immutable();

-- The deferred obligation proves COMMITTED transaction completeness. It cannot
-- prevent a trusted SQL credential holder from reading and then rolling back.
-- The service additionally awaits successful COMMIT before returning any data.
CREATE FUNCTION reward_audit_private.require_receipt() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
BEGIN
 IF EXISTS(SELECT 1 FROM reward_audit_private.admission WHERE id=NEW.id)
 OR NOT EXISTS(SELECT 1 FROM reward_audit_private.receipt r WHERE r.id=NEW.id AND r.event_id=NEW.event_id
  AND r.aggregate_id=NEW.aggregate_id AND r.tenant_id=NEW.tenant_id AND r.actor_id=NEW.actor_id
  AND r.operation=NEW.operation AND r.kind IS NOT DISTINCT FROM NEW.kind AND r.year IS NOT DISTINCT FROM NEW.year
  AND r.observed_at=NEW.observed_at AND r.version=1)
 THEN RAISE EXCEPTION 'Rewards read must finalize its exact durable receipt before commit' USING ERRCODE='55000';END IF;
 RETURN NULL;
END $body$;
CREATE CONSTRAINT TRIGGER reward_audit_must_finalize AFTER INSERT ON reward_audit_private.admission DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reward_audit_private.require_receipt();

CREATE FUNCTION reward_audit_private.relation_metadata(p_relation oid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
 SELECT jsonb_build_object('relation',jsonb_build_object('oid',c.oid,'namespace',c.relnamespace,'name',c.relname,'owner',c.relowner,'kind',c.relkind,'persistence',c.relpersistence,'accessMethod',c.relam,'tablespace',c.reltablespace,
  'acl',c.relacl,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'options',c.reloptions,'partition',c.relispartition,'replicaIdentity',c.relreplident),
  'columns',coalesce((SELECT jsonb_agg(to_jsonb(a)ORDER BY a.attnum)FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0),'[]'::jsonb),
  'constraints',coalesce((SELECT jsonb_agg(to_jsonb(k)ORDER BY k.oid)FROM pg_constraint k WHERE k.conrelid=c.oid),'[]'::jsonb),
  'indexes',coalesce((SELECT jsonb_agg(to_jsonb(i)ORDER BY i.indexrelid)FROM pg_index i WHERE i.indrelid=c.oid),'[]'::jsonb),
  'rules',coalesce((SELECT jsonb_agg(to_jsonb(r)ORDER BY r.oid)FROM pg_rewrite r WHERE r.ev_class=c.oid),'[]'::jsonb))FROM pg_class c WHERE c.oid=p_relation
$body$;

CREATE FUNCTION reward_audit_private.assert_profile() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE a reward_audit_private.authority;login record;
BEGIN
 SELECT * INTO a FROM reward_audit_private.authority WHERE singleton;
 IF NOT FOUND OR a.enabled IS DISTINCT FROM true OR a.version<>1 OR a.database_name<>current_database()
 OR a.owner_oid<>current_user::regrole::oid
 OR a.owner_oid<>(SELECT relowner FROM pg_class WHERE oid='public.domain_event'::regclass)
 THEN RAISE EXCEPTION 'Owned Rewards audit profile unavailable' USING ERRCODE='55000';END IF;
 FOR login IN SELECT * FROM pg_roles WHERE oid IN(a.reader_oid,a.projector_oid) LOOP
  IF login.rolname IS DISTINCT FROM (CASE WHEN login.oid=a.reader_oid THEN 'ai_hr_reward_audit_read' ELSE 'ai_hr_reward_audit_projector' END)
  OR NOT login.rolcanlogin OR login.rolinherit OR login.rolsuper OR login.rolbypassrls OR login.rolcreatedb OR login.rolcreaterole OR login.rolreplication
  OR login.rolvaliduntil<=clock_timestamp()
  OR EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid=login.oid OR member=login.oid)
  OR EXISTS(SELECT 1 FROM pg_db_role_setting WHERE setrole=login.oid)
  OR has_parameter_privilege(login.oid,'session_replication_role','SET')
  OR has_database_privilege(login.oid,current_database(),'CREATE')
  OR has_schema_privilege(login.oid,'app','USAGE')
  OR login.oid=a.reader_oid AND NOT has_schema_privilege(login.oid,'public','USAGE')
  OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_temp_%' AND n.nspname NOT LIKE 'pg_toast_temp_%'
   AND (has_schema_privilege(login.oid,n.oid,'CREATE') OR n.nspname NOT IN('pg_catalog','information_schema','public',CASE WHEN login.oid=a.reader_oid THEN 'reward_audit_read' ELSE 'reward_audit_projection' END) AND has_schema_privilege(login.oid,n.oid,'USAGE')))
  OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN('r','p','v','m','f') AND
   (c.relowner=login.oid OR has_table_privilege(login.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')OR has_any_column_privilege(login.oid,c.oid,'INSERT,UPDATE,REFERENCES')
    OR(has_table_privilege(login.oid,c.oid,'SELECT')OR has_any_column_privilege(login.oid,c.oid,'SELECT'))AND NOT(login.oid=a.reader_oid AND c.oid IN('public.reward_library'::regclass,'public.reward_library_version'::regclass))))
  OR EXISTS(SELECT 1 FROM pg_class c WHERE CASE WHEN c.relkind='S' THEN has_sequence_privilege(login.oid,c.oid,'USAGE,SELECT,UPDATE') OR c.relowner=login.oid ELSE false END)
  OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.prosecdef
   AND has_schema_privilege(login.oid,n.oid,'USAGE') AND has_function_privilege(login.oid,p.oid,'EXECUTE')
   AND (n.nspname<>CASE WHEN login.oid=a.reader_oid THEN 'reward_audit_read' ELSE 'reward_audit_projection' END
    OR NOT EXISTS(SELECT 1 FROM reward_audit_private.function_contract c WHERE c.signature=p.oid)))
  OR EXISTS(SELECT 1 FROM pg_proc p,aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))g
   WHERE g.grantee=login.oid AND(g.privilege_type<>'EXECUTE'OR g.is_grantable OR
    NOT(login.oid=a.reader_oid AND(p.pronamespace='reward_audit_read'::regnamespace OR p.oid IN('app.reward_setup_allowed(uuid,text)'::regprocedure,'app.current_tenant_id()'::regprocedure))
     OR login.oid=a.projector_oid AND p.oid='reward_audit_projection.materialize(integer)'::regprocedure)))
  THEN RAISE EXCEPTION 'Dedicated Rewards audit LOGIN closure changed' USING ERRCODE='55000';END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_roles WHERE oid IN(a.reader_oid,a.projector_oid))<>2
 OR EXISTS(SELECT 1 FROM reward_audit_private.function_contract c LEFT JOIN pg_proc p ON p.oid=c.signature WHERE p.oid IS NULL OR to_jsonb(p)IS DISTINCT FROM c.details)
 OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace IN('reward_audit_read'::regnamespace,'reward_audit_projection'::regnamespace,'reward_audit_private'::regnamespace) AND NOT EXISTS(SELECT 1 FROM reward_audit_private.function_contract c WHERE c.signature=p.oid))
 OR EXISTS(SELECT 1 FROM reward_audit_private.relation_contract c LEFT JOIN pg_class r ON r.oid=c.object_oid WHERE r.oid IS NULL OR reward_audit_private.relation_metadata(r.oid)IS DISTINCT FROM c.details)
 OR EXISTS(SELECT 1 FROM pg_class r WHERE r.relnamespace='reward_audit_private'::regnamespace AND NOT EXISTS(SELECT 1 FROM reward_audit_private.relation_contract c WHERE c.object_oid=r.oid))
 OR EXISTS(SELECT 1 FROM reward_audit_private.policy_contract c LEFT JOIN pg_policy p ON p.oid=c.object_oid WHERE p.oid IS NULL OR to_jsonb(p)IS DISTINCT FROM c.details)
 OR EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid IN(SELECT object_oid FROM reward_audit_private.relation_contract)AND NOT EXISTS(SELECT 1 FROM reward_audit_private.policy_contract c WHERE c.object_oid=p.oid))
 OR EXISTS(SELECT 1 FROM reward_audit_private.trigger_contract c LEFT JOIN pg_trigger t ON t.oid=c.object_oid WHERE t.oid IS NULL OR to_jsonb(t)IS DISTINCT FROM c.details)
 OR EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid IN(SELECT object_oid FROM reward_audit_private.relation_contract)AND NOT EXISTS(SELECT 1 FROM reward_audit_private.trigger_contract c WHERE c.object_oid=t.oid))
 THEN RAISE EXCEPTION 'Exact Rewards audit owned object profile changed' USING ERRCODE='55000';END IF;
END $body$;

CREATE FUNCTION reward_audit_private.current_actor() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $body$
 SELECT nullif(current_setting('app.agent_principal_id',true),'')IS NULL
 AND app.current_user_id()IS NOT NULL AND app.current_tenant_id()IS NOT NULL
 AND app.principal_snapshot_current()
 AND EXISTS(SELECT 1 FROM public.tenant t WHERE t.id=app.current_tenant_id()AND t.status IN('active','trial'))
 AND EXISTS(SELECT 1 FROM public.tenant_module m WHERE m.tenant_id=app.current_tenant_id()AND m.module_code='rewards'AND m.company_id IS NULL AND m.status IN('active','trial')AND(m.expires_at IS NULL OR m.expires_at>now()))
$body$;

CREATE FUNCTION reward_audit_private.current_admission() RETURNS reward_audit_private.admission LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE r reward_audit_private.admission;
BEGIN
 SELECT * INTO r FROM reward_audit_private.admission x WHERE x.login_oid=session_user::regrole::oid
 AND x.backend_pid=pg_backend_pid()AND x.backend_start=(SELECT backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid())AND x.xid=pg_current_xact_id()
 AND x.tenant_id=app.current_tenant_id()AND x.actor_id=app.current_user_id();
 IF NOT FOUND OR NOT reward_audit_private.current_actor() THEN RAISE EXCEPTION 'Exact active Rewards read admission required' USING ERRCODE='42501';END IF;
 RETURN r;
END $body$;

CREATE FUNCTION reward_audit_read.begin_read(p_operation text,p_kind text,p_year integer) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE a reward_audit_private.authority;r uuid;
BEGIN
 PERFORM reward_audit_private.assert_profile();SELECT * INTO a FROM reward_audit_private.authority WHERE singleton;
 IF session_user::regrole::oid<>a.reader_oid OR current_setting('transaction_isolation')<>'repeatable read'OR current_setting('transaction_read_only')<>'off'
 OR p_operation IS NULL OR p_operation NOT IN('libraries','pat')OR p_kind IS NOT NULL AND p_kind NOT IN('salary','bonus')
 OR p_year IS NOT NULL AND p_year NOT BETWEEN 2000 AND 2200 OR p_operation='pat'AND(p_kind IS NOT NULL OR p_year IS NULL)
 OR NOT reward_audit_private.current_actor()
 OR NOT app.reward_setup_allowed(NULL,CASE WHEN p_operation='libraries'THEN 'library_view'ELSE 'manage'END)
 OR NOT EXISTS(SELECT 1 FROM public.domain_event WHERE tenant_id=app.current_tenant_id()AND chain_seq IS NOT NULL)
 THEN RAISE EXCEPTION 'Current armed-chain Rewards read purpose required' USING ERRCODE='42501';END IF;
 INSERT INTO reward_audit_private.admission(tenant_id,actor_id,operation,kind,year,login_oid,backend_pid,backend_start,xid)
 VALUES(app.current_tenant_id(),app.current_user_id(),p_operation,p_kind,p_year,session_user::regrole::oid,pg_backend_pid(),(SELECT backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid()),pg_current_xact_id())RETURNING id INTO r;
 RETURN r;
END $body$;

CREATE FUNCTION reward_audit_read.finalize_read(p_admission uuid) RETURNS TABLE(id uuid,observed_at text) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE r reward_audit_private.admission;
BEGIN
 PERFORM reward_audit_private.assert_profile();r:=reward_audit_private.current_admission();
 IF r.id IS DISTINCT FROM p_admission THEN RAISE EXCEPTION 'Exact Rewards read receipt required' USING ERRCODE='42501';END IF;
 INSERT INTO reward_audit_private.receipt(id,event_id,aggregate_id,tenant_id,actor_id,version,operation,kind,year,observed_at)
 VALUES(r.id,r.event_id,r.aggregate_id,r.tenant_id,r.actor_id,1,r.operation,r.kind,r.year,r.observed_at);
 DELETE FROM reward_audit_private.admission WHERE reward_audit_private.admission.id=r.id;
 RETURN QUERY SELECT r.id,r.observed_at::text;
END $body$;

-- All helper routes retain the canonical native owner/permission predicate.
-- They expose only the exact canonical query vocabulary; no SQL/data broker.
CREATE FUNCTION reward_audit_read.allowed(p_company uuid,p_operation text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE r reward_audit_private.admission;
BEGIN
 r:=reward_audit_private.current_admission();
 IF p_operation IS NULL OR p_operation NOT IN('library_view','manage')OR r.operation='libraries'AND(p_company IS NOT NULL OR p_operation<>'library_view') THEN RETURN false;END IF;
 RETURN app.reward_setup_allowed(p_company,p_operation);
END $body$;
CREATE FUNCTION reward_audit_read.library_visible(p_library uuid,p_year integer,p_kind text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE r reward_audit_private.admission;
BEGIN r:=reward_audit_private.current_admission();RETURN r.operation='libraries'AND(r.year IS NULL OR r.year=p_year)AND(r.kind IS NULL OR r.kind=p_kind)
 AND EXISTS(SELECT 1 FROM public.reward_library l WHERE l.id=p_library AND l.tenant_id=r.tenant_id AND l.year=p_year AND l.kind=p_kind);END $body$;
CREATE FUNCTION reward_audit_read.library_used_by(p_version uuid) RETURNS TABLE(plan text,company text,year integer) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE r reward_audit_private.admission;
BEGIN r:=reward_audit_private.current_admission();IF r.operation<>'libraries'OR NOT EXISTS(SELECT 1 FROM public.reward_library_version v JOIN public.reward_library l ON l.id=v.library_id AND l.tenant_id=v.tenant_id WHERE v.id=p_version AND v.tenant_id=r.tenant_id AND reward_audit_read.library_visible(l.id,l.year,l.kind))THEN RAISE EXCEPTION 'Exact admitted library version required' USING ERRCODE='42501';END IF;RETURN QUERY SELECT * FROM app.reward_library_used_by(p_version);END $body$;
CREATE FUNCTION reward_audit_read.library_locked(p_version uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
BEGIN PERFORM 1 FROM reward_audit_read.library_used_by(p_version);RETURN app.reward_library_locked(p_version);END $body$;
CREATE FUNCTION reward_audit_read.companies(p_year integer) RETURNS TABLE(id uuid,name text,"parentId"uuid,"parentName"text) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE r reward_audit_private.admission;
BEGIN r:=reward_audit_private.current_admission();IF r.operation<>'pat'OR r.year IS DISTINCT FROM p_year THEN RAISE EXCEPTION 'Exact admitted PAT year required' USING ERRCODE='42501';END IF;RETURN QUERY SELECT * FROM app.reward_setup_companies(p_year);END $body$;
CREATE FUNCTION reward_audit_read.company_structure(p_company uuid,p_date date) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE r reward_audit_private.admission;
BEGIN r:=reward_audit_private.current_admission();IF r.operation<>'pat'OR p_date IS NULL OR NOT EXISTS(SELECT 1 FROM reward_audit_read.companies(r.year)c WHERE c.id=p_company)THEN RAISE EXCEPTION 'Exact admitted PAT company required' USING ERRCODE='42501';END IF;RETURN app.reward_company_structure(p_company,p_date);END $body$;
CREATE FUNCTION reward_audit_read.pat_history(p_company uuid,p_year integer) RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE r reward_audit_private.admission;
BEGIN r:=reward_audit_private.current_admission();IF r.operation<>'pat'OR r.year IS DISTINCT FROM p_year OR NOT EXISTS(SELECT 1 FROM reward_audit_read.companies(r.year)c WHERE c.id=p_company)THEN RAISE EXCEPTION 'Exact admitted PAT history required' USING ERRCODE='42501';END IF;RETURN QUERY SELECT * FROM app.reward_private_pat_history(p_company,p_year);END $body$;

GRANT SELECT ON public.reward_library,public.reward_library_version TO ai_hr_reward_audit_read;
-- Required only for existing RLS's pre-resolved function OIDs. The LOGIN still has
-- NO app-schema USAGE and cannot address the general native API namespace.
DO $rls_grants$BEGIN
 IF NOT has_function_privilege('ai_hr_reward_audit_read','app.reward_setup_allowed(uuid,text)','EXECUTE')THEN GRANT EXECUTE ON FUNCTION app.reward_setup_allowed(uuid,text)TO ai_hr_reward_audit_read;END IF;
 IF NOT has_function_privilege('ai_hr_reward_audit_read','app.current_tenant_id()','EXECUTE')THEN GRANT EXECUTE ON FUNCTION app.current_tenant_id()TO ai_hr_reward_audit_read;END IF;
END $rls_grants$;
CREATE POLICY reward_audit_library_purpose ON public.reward_library AS RESTRICTIVE FOR SELECT TO ai_hr_reward_audit_read
 USING(tenant_id=app.current_tenant_id()AND reward_audit_read.library_visible(id,year,kind));
CREATE POLICY reward_audit_library_version_purpose ON public.reward_library_version AS RESTRICTIVE FOR SELECT TO ai_hr_reward_audit_read
 USING(tenant_id=app.current_tenant_id()AND EXISTS(SELECT 1 FROM public.reward_library l WHERE l.id=reward_library_version.library_id AND l.tenant_id=reward_library_version.tenant_id));

CREATE FUNCTION reward_audit_read.coverage() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
BEGIN
 PERFORM reward_audit_private.assert_profile();
 IF session_user<>'ai_hr_reward_audit_read'OR current_setting('transaction_isolation')<>'repeatable read'OR current_setting('transaction_read_only')<>'on'
 OR NOT reward_audit_private.current_actor()OR NOT app.reward_setup_allowed(NULL,'manage')THEN RAISE EXCEPTION 'Current Rewards audit coverage authority required' USING ERRCODE='42501';END IF;
 RETURN(SELECT jsonb_build_object('version',1,'scope','armed-chain-prototype','processor','uninstalled','failures',NULL,
 'committedReceipts',count(*)::text,'projectedReceipts',count(p.receipt_id)::text,'pendingReceipts',(count(*)-count(p.receipt_id))::text,
 'oldestPendingAt',min(r.observed_at)FILTER(WHERE p.receipt_id IS NULL),'caughtUp',count(*)=count(p.receipt_id))
 FROM reward_audit_private.receipt r LEFT JOIN reward_audit_private.projection p ON p.receipt_id=r.id WHERE r.tenant_id=app.current_tenant_id());
END $body$;

CREATE FUNCTION reward_audit_projection.materialize(p_limit integer) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE a reward_audit_private.authority;r reward_audit_private.receipt;appended timestamptz;n integer:=0;
BEGIN
 PERFORM reward_audit_private.assert_profile();SELECT * INTO a FROM reward_audit_private.authority WHERE singleton;
 IF session_user::regrole::oid<>a.projector_oid OR current_setting('transaction_isolation')<>'read committed'OR current_setting('transaction_read_only')<>'off'
 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 25 THEN RAISE EXCEPTION 'Exact bounded Rewards audit projector required' USING ERRCODE='42501';END IF;
 -- No high-water cursor: a receipt committed later stays discoverable, regardless
 -- of observation/order IDs. Row locks serialize claims, links/events commit together.
 FOR r IN SELECT x.* FROM reward_audit_private.receipt x WHERE NOT EXISTS(SELECT 1 FROM reward_audit_private.projection p WHERE p.receipt_id=x.id)ORDER BY x.observed_at,x.id FOR UPDATE OF x SKIP LOCKED LIMIT p_limit LOOP
  -- The cursor snapshot can predate another projector's COMMIT while receipt
  -- tuples stay immutable. Once this row is locked, a NEW RC statement must
  -- recheck the committed link before appending its unique event.
  IF EXISTS(SELECT 1 FROM reward_audit_private.projection p WHERE p.receipt_id=r.id)THEN CONTINUE;END IF;
  IF r.version<>1 OR NOT EXISTS(SELECT 1 FROM public.domain_event WHERE tenant_id=r.tenant_id AND chain_seq IS NOT NULL)THEN RAISE EXCEPTION 'Supported armed-chain audit receipt required' USING ERRCODE='55000';END IF;
  appended:=clock_timestamp();
  INSERT INTO public.domain_event(id,tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload,occurred_at)
  VALUES(r.event_id,r.tenant_id,'rewards-setup',r.aggregate_id,'rewards-setup.'||CASE WHEN r.operation='libraries'THEN 'libraries.viewed'ELSE 'pat.viewed'END,'user',r.actor_id,NULL,
   CASE WHEN r.operation='libraries'THEN jsonb_build_object('kind',r.kind,'year',r.year)ELSE jsonb_build_object('year',r.year)END
   ||jsonb_build_object('auditReceipt',jsonb_build_object('version',1,'id',r.id,'observedAt',r.observed_at,'appendedAt',appended)),r.observed_at);
  IF NOT EXISTS(SELECT 1 FROM public.domain_event e WHERE e.id=r.event_id AND e.tenant_id=r.tenant_id AND e.aggregate_type='rewards-setup'AND e.aggregate_id=r.aggregate_id
   AND e.event_type='rewards-setup.'||CASE WHEN r.operation='libraries'THEN 'libraries.viewed'ELSE 'pat.viewed'END AND e.actor_type='user'AND e.actor_id=r.actor_id AND e.subject_employment_id IS NULL AND e.occurred_at=r.observed_at
   AND e.payload=CASE WHEN r.operation='libraries'THEN jsonb_build_object('kind',r.kind,'year',r.year)ELSE jsonb_build_object('year',r.year)END||jsonb_build_object('auditReceipt',jsonb_build_object('version',1,'id',r.id,'observedAt',r.observed_at,'appendedAt',appended))
   AND e.chain_seq IS NOT NULL AND e.hash=app.domain_event_hash(e.prev_hash,e.tenant_id,e.chain_seq,e.aggregate_type,e.aggregate_id,e.event_type,e.actor_type::text,e.actor_id,e.subject_employment_id,e.payload))
  THEN RAISE EXCEPTION 'Exact canonical Rewards audit append required' USING ERRCODE='55000';END IF;
  INSERT INTO reward_audit_private.projection(receipt_id,event_id,appended_at)VALUES(r.id,r.event_id,appended);n:=n+1;
 END LOOP;
 RETURN n;
END $body$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA reward_audit_read,reward_audit_projection,reward_audit_private FROM PUBLIC,ai_hr_app,ai_hr_reward_audit_read,ai_hr_reward_audit_projector;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA reward_audit_read TO ai_hr_reward_audit_read;
GRANT EXECUTE ON FUNCTION reward_audit_projection.materialize(integer)TO ai_hr_reward_audit_projector;

-- The fixture fills predecessor_contract only after independently checking the
-- pinned source body/language/config/native owner and existing ACL. APIs remain
-- disabled until all metadata is captured and the full profile is proven.
INSERT INTO reward_audit_private.function_contract SELECT p.oid,to_jsonb(p)FROM pg_proc p WHERE p.pronamespace IN('reward_audit_read'::regnamespace,'reward_audit_projection'::regnamespace,'reward_audit_private'::regnamespace);
INSERT INTO reward_audit_private.relation_contract SELECT c.oid,reward_audit_private.relation_metadata(c.oid)FROM pg_class c WHERE c.relnamespace='reward_audit_private'::regnamespace OR c.oid IN('public.reward_library'::regclass,'public.reward_library_version'::regclass,'public.domain_event'::regclass);
INSERT INTO reward_audit_private.policy_contract SELECT p.oid,to_jsonb(p)FROM pg_policy p WHERE p.polrelid IN(SELECT object_oid FROM reward_audit_private.relation_contract);
INSERT INTO reward_audit_private.trigger_contract SELECT t.oid,to_jsonb(t)FROM pg_trigger t WHERE t.tgrelid IN(SELECT object_oid FROM reward_audit_private.relation_contract);
INSERT INTO reward_audit_private.authority VALUES(true,current_database(),current_user::regrole::oid,'ai_hr_reward_audit_read'::regrole::oid,'ai_hr_reward_audit_projector'::regrole::oid,1,false);
