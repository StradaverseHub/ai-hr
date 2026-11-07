-- UNNUMBERED/UNINSTALLED exact-freshness query-shape experiment. No page/runtime adoption.
-- Apply atomically after exact dd6 stage3 process source, before authority activation.
DO $database$
DECLARE namespace text:=current_setting('aihr.notification_fixture.namespace',true);
 pool_id text:=current_setting('aihr.notification_fixture.pool_id',true);
 expected text;normalised text;
BEGIN
 IF namespace IS NULL OR pool_id IS NULL OR pool_id !~ '^[1-9][0-9]*$'
 OR length(namespace)>20 OR (namespace<>'' AND namespace !~ '^_?[a-z0-9][a-z0-9_]*$') THEN
  RAISE EXCEPTION 'Canonical isolated notification worker binding required' USING ERRCODE='55000';END IF;
 normalised:=CASE WHEN namespace='' THEN '' WHEN left(namespace,1)='_' THEN namespace ELSE '_'||namespace END;
 expected:='ai_hr_test_w'||normalised||pool_id;
 IF current_database() IS DISTINCT FROM expected OR expected IS DISTINCT FROM current_setting('aihr.notification_fixture.database',true) THEN
  RAISE EXCEPTION 'Exact canonical notification worker database required' USING ERRCODE='55000';END IF;
END $database$;
DO $before$
DECLARE p pg_proc;native_owner oid:=(SELECT relowner FROM pg_class WHERE oid='public.job_run'::regclass);
BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker_private.admit_login()'::regprocedure;
 IF current_user::regrole::oid IS DISTINCT FROM native_owner
 OR native_owner IS DISTINCT FROM(SELECT relowner FROM pg_class WHERE oid='public.domain_event'::regclass)
 OR EXISTS(SELECT 1 FROM notification_worker_private.authority)OR EXISTS(SELECT 1 FROM notification_worker_private.run)
 OR p.proowner IS DISTINCT FROM native_owner OR p.prosrc IS DISTINCT FROM $prior$
DECLARE a notification_worker_private.authority; r pg_roles; login oid;
BEGIN
 SELECT * INTO a FROM notification_worker_private.authority WHERE singleton;
 SELECT * INTO r FROM pg_roles WHERE rolname=session_user;login:=r.oid;
 IF NOT FOUND OR a.enabled IS DISTINCT FROM true OR a.api_version IS DISTINCT FROM 3
 OR login IS DISTINCT FROM a.login_oid OR current_user::regrole::oid IS DISTINCT FROM a.owner_oid
 OR a.owner_oid IS DISTINCT FROM (SELECT relowner FROM pg_class WHERE oid='public.job_run'::regclass)
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE (n.nspname='notification_worker_private' OR c.oid IN('public.tenant'::regclass,'public.tenant_module'::regclass,'public.company'::regclass,'public.domain_event'::regclass,'public.notification_event_processing'::regclass,'public.job_run'::regclass,'public.notification'::regclass,'public.notification_delivery'::regclass,'public.notification_cursor'::regclass))
  AND (c.relowner<>a.owner_oid OR c.relforcerowsecurity))
 OR r.rolname<>'ai_hr_notification_worker' OR NOT r.rolcanlogin OR r.rolinherit OR r.rolsuper
 OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
 OR r.rolvaliduntil<=clock_timestamp()
 OR has_parameter_privilege(login,'session_replication_role','SET')
 OR has_database_privilege(login,current_database(),'CREATE')
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off'
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=login OR roleid=login)
 OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
  AND (has_schema_privilege(login,n.oid,'CREATE') OR n.nspname NOT IN('public','notification_worker') AND has_schema_privilege(login,n.oid,'USAGE')))
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN('r','p','v','m','f')
  AND (has_table_privilege(login,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR has_any_column_privilege(login,c.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE CASE WHEN c.relkind='S' AND n.nspname !~ '^pg_'
   THEN has_sequence_privilege(login,c.oid,'USAGE,SELECT,UPDATE') ELSE false END)
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE p.prosecdef AND n.nspname !~ '^pg_' AND has_schema_privilege(login,n.oid,'USAGE') AND has_function_privilege(login,p.oid,'EXECUTE')
   AND NOT EXISTS(SELECT 1 FROM notification_worker_private.allowed_api x WHERE x.signature=p.oid))
 OR (SELECT count(*) FROM notification_worker_private.allowed_api)<>13
 OR EXISTS(SELECT 1 FROM notification_worker_private.allowed_api x LEFT JOIN pg_proc p ON p.oid=x.signature
  WHERE p.oid IS NULL OR p.proowner<>a.owner_oid OR NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[])
 OR NOT EXISTS(SELECT 1 FROM notification_worker_private.registry_contract)
 OR (SELECT count(*) FROM notification_worker_private.assessment_task_key)<>16
 OR EXISTS(SELECT 1 FROM notification_worker_private.helper_contract c LEFT JOIN pg_proc p ON p.oid=c.signature
  WHERE p.oid IS NULL OR p.proowner<>c.owner_oid OR md5(p.prosrc)<>c.body_md5
   OR p.proconfig IS DISTINCT FROM c.configuration OR p.prosecdef<>c.security_definer OR p.provolatile<>c.volatility OR p.prolang<>c.language_oid)
 THEN RAISE EXCEPTION 'Notification worker authority unavailable' USING ERRCODE='42501';END IF;
 RETURN login;
END $prior$
 OR md5(p.prosrc)IS DISTINCT FROM '8517a1befa95a7daa5ff621e92f8ceef'
 OR p.proname<>'admit_login'OR p.pronamespace<>'notification_worker_private'::regnamespace OR p.pronargs<>0 OR p.proargnames IS NOT NULL
 OR p.prorettype<>'oid'::regtype OR p.proretset OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR NOT p.prosecdef OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v'OR p.proparallel<>'u'OR p.prokind<>'f'
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]OR p.procost<>100 OR p.prorows<>0
 OR p.pronargdefaults<>0 OR p.proargdefaults IS NOT NULL OR p.provariadic<>0 OR p.prosupport<>0::oid OR p.prosqlbody IS NOT NULL OR p.probin IS NOT NULL OR p.protrftypes IS NOT NULL OR p.proallargtypes IS NOT NULL OR p.proargmodes IS NOT NULL
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner)))g WHERE g.grantor<>native_owner OR g.grantee<>native_owner OR g.privilege_type<>'EXECUTE'OR g.is_grantable)
 OR(SELECT count(*)FROM notification_worker_private.process_contract WHERE kind='function')<>33
 OR(SELECT count(*)FROM pg_proc WHERE pronamespace IN('notification_worker'::regnamespace,'notification_worker_private'::regnamespace))<>33
 OR EXISTS(SELECT 1 FROM notification_worker_private.process_contract c LEFT JOIN pg_proc actual ON actual.oid=c.object_oid WHERE c.kind='function'AND(actual.oid IS NULL OR to_jsonb(actual)IS DISTINCT FROM c.details))
 OR NOT EXISTS(SELECT 1 FROM notification_worker_private.process_contract c WHERE c.kind='function'AND c.object_oid=p.oid AND c.details=to_jsonb(p))
 THEN RAISE EXCEPTION 'Exact inactive native query-shape predecessor required' USING ERRCODE='55000';END IF;
END $before$;
CREATE OR REPLACE FUNCTION notification_worker_private.admit_login() RETURNS oid LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pg_temp AS $body$
DECLARE a notification_worker_private.authority; r pg_roles; login oid;
BEGIN
 SELECT * INTO a FROM notification_worker_private.authority WHERE singleton;
 SELECT * INTO r FROM pg_roles WHERE rolname=session_user;login:=r.oid;
 IF NOT FOUND OR a.enabled IS DISTINCT FROM true OR a.api_version IS DISTINCT FROM 3
 OR login IS DISTINCT FROM a.login_oid OR current_user::regrole::oid IS DISTINCT FROM a.owner_oid
 OR a.owner_oid IS DISTINCT FROM (SELECT relowner FROM pg_class WHERE oid='public.job_run'::regclass)
 OR EXISTS(WITH owned_targets AS MATERIALIZED(SELECT c.relowner,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='notification_worker_private' OR c.oid IN('public.tenant'::regclass,'public.tenant_module'::regclass,'public.company'::regclass,'public.domain_event'::regclass,'public.notification_event_processing'::regclass,'public.job_run'::regclass,'public.notification'::regclass,'public.notification_delivery'::regclass,'public.notification_cursor'::regclass))
  SELECT 1 FROM owned_targets c WHERE c.relowner<>a.owner_oid OR c.relforcerowsecurity)
 OR r.rolname<>'ai_hr_notification_worker' OR NOT r.rolcanlogin OR r.rolinherit OR r.rolsuper
 OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
 OR r.rolvaliduntil<=clock_timestamp()
 OR has_parameter_privilege(login,'session_replication_role','SET')
 OR has_database_privilege(login,current_database(),'CREATE')
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off'
 OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=login OR roleid=login)
 OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
  AND (has_schema_privilege(login,n.oid,'CREATE') OR n.nspname NOT IN('public','notification_worker') AND has_schema_privilege(login,n.oid,'USAGE')))
 OR EXISTS(WITH relation_candidates AS MATERIALIZED(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema' AND c.relkind IN('r','p','v','m','f'))
  SELECT 1 FROM relation_candidates c WHERE has_table_privilege(login,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR has_any_column_privilege(login,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))
 OR EXISTS(WITH sequence_candidates AS MATERIALIZED(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind='S' AND n.nspname !~ '^pg_')
  SELECT 1 FROM sequence_candidates c WHERE has_sequence_privilege(login,c.oid,'USAGE,SELECT,UPDATE'))
 OR EXISTS(WITH definer_candidates AS MATERIALIZED(SELECT p.oid,n.oid AS namespace_oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE p.prosecdef AND n.nspname !~ '^pg_')
  SELECT 1 FROM definer_candidates p WHERE has_schema_privilege(login,p.namespace_oid,'USAGE') AND has_function_privilege(login,p.oid,'EXECUTE')
   AND NOT EXISTS(SELECT 1 FROM notification_worker_private.allowed_api x WHERE x.signature=p.oid))
 OR (SELECT count(*) FROM notification_worker_private.allowed_api)<>13
 OR EXISTS(SELECT 1 FROM notification_worker_private.allowed_api x LEFT JOIN LATERAL(SELECT native.oid,native.proowner,native.prosecdef,native.proconfig
  FROM pg_proc native WHERE native.oid=x.signature OFFSET 0)p ON true
  WHERE p.oid IS NULL OR p.proowner<>a.owner_oid OR NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[])
 OR NOT EXISTS(SELECT 1 FROM notification_worker_private.registry_contract)
 OR (SELECT count(*) FROM notification_worker_private.assessment_task_key)<>16
 OR EXISTS(SELECT 1 FROM notification_worker_private.helper_contract c LEFT JOIN pg_proc p ON p.oid=c.signature
  WHERE p.oid IS NULL OR p.proowner<>c.owner_oid OR md5(p.prosrc)<>c.body_md5
   OR p.proconfig IS DISTINCT FROM c.configuration OR p.prosecdef<>c.security_definer OR p.provolatile<>c.volatility OR p.prolang<>c.language_oid)
 THEN RAISE EXCEPTION 'Notification worker authority unavailable' USING ERRCODE='42501';END IF;
 RETURN login;
END $body$;
DO $after$
DECLARE p pg_proc;n integer;
BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker_private.admit_login()'::regprocedure;
 IF md5(p.prosrc)IS DISTINCT FROM '49533d66467b0468d6cb4c1fb0697fe5'OR NOT EXISTS(SELECT 1 FROM notification_worker_private.process_contract c WHERE c.kind='function'AND c.object_oid=p.oid AND(c.details-'prosrc')=(to_jsonb(p)-'prosrc'))
 THEN RAISE EXCEPTION 'Exact metadata-preserving query-shape replacement required' USING ERRCODE='55000';END IF;
 -- This one reviewed function body changes; every other sealed object stays exact.
 UPDATE notification_worker_private.process_contract SET details=to_jsonb(p)WHERE kind='function'AND object_oid=p.oid;
 GET DIAGNOSTICS n=ROW_COUNT;IF n<>1 THEN RAISE EXCEPTION 'Exact query-shape function binding required' USING ERRCODE='55000';END IF;
END $after$;
