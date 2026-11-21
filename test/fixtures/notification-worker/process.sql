-- UNINSTALLED process-stage owned CI prototype. Apply after exact stage3 only.
-- Never a numbered migration, installation or worker recovery capability.
SET LOCAL search_path=pg_catalog,public,pg_temp;
DO $guard$
DECLARE p pg_proc; expected_owner oid;
BEGIN
 expected_owner:=(SELECT relowner FROM pg_class WHERE oid='public.job_run'::regclass);
 IF current_database() IS DISTINCT FROM current_setting('aihr.notification_fixture.database',true)
 OR current_user::regrole::oid IS DISTINCT FROM expected_owner
 OR session_user::regrole::oid IS DISTINCT FROM expected_owner
 OR EXISTS(SELECT 1 FROM notification_worker_private.run)
 OR EXISTS(SELECT 1 FROM notification_worker_private.authority WHERE api_version<>3)
 OR to_regclass('notification_worker_private.committed_batch') IS NOT NULL
 OR to_regprocedure('notification_worker_private.recover_abandoned_run(uuid)') IS NOT NULL THEN
 RAISE EXCEPTION 'Exact empty owned stage3 fixture required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker_private.require_batch_settlement()'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_0$
BEGIN
 IF EXISTS(SELECT 1 FROM notification_worker_private.batch WHERE batch_id=NEW.batch_id) THEN
  RAISE EXCEPTION 'Notification batch must settle before commit' USING ERRCODE='55000';END IF;
 RETURN NULL;
END $expected_0$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM ''
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'trigger'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker_private'::regnamespace::oid OR p.proname<>'require_batch_settlement'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner)) THEN RAISE EXCEPTION 'Exact reviewed notification_worker_private.require_batch_settlement predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker_private.admit_login()'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_1$
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
END $expected_1$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM ''
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'oid'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker_private'::regnamespace::oid OR p.proname<>'admit_login'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner)) THEN RAISE EXCEPTION 'Exact reviewed notification_worker_private.admit_login predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker_private.consumer(uuid)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_2$
 SELECT CASE WHEN t.status IN('active','trial') THEN CASE
  WHEN EXISTS(SELECT 1 FROM public.tenant_module m WHERE m.tenant_id=t.id AND m.module_code='notifications'
   AND m.company_id IS NULL AND m.status IN('active','trial') AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())) THEN 'notifications'
  WHEN EXISTS(SELECT 1 FROM public.tenant_module m JOIN public.company c ON c.id=m.company_id AND c.tenant_id=t.id
   WHERE m.tenant_id=t.id AND m.module_code='notifications' AND m.status IN('active','trial')
    AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())) THEN 'assessment-reminders' END END
 FROM public.tenant t WHERE t.id=p_tenant AND t.id<>'00000000-0000-0000-0000-000000000000'::uuid
$expected_2$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'p_tenant uuid'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'text'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker_private'::regnamespace::oid OR p.proname<>'consumer'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='sql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'s' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner)) THEN RAISE EXCEPTION 'Exact reviewed notification_worker_private.consumer predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker_private.admit_run(uuid,boolean)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_3$
DECLARE r notification_worker_private.run; a notification_worker_private.authority; login oid; started timestamptz;
 k bigint:=hashtextextended('notification-worker:singleton',0);
BEGIN
 login:=notification_worker_private.admit_login();
 SELECT * INTO a FROM notification_worker_private.authority WHERE singleton FOR UPDATE;
 SELECT backend_start INTO started FROM pg_stat_activity WHERE pid=pg_backend_pid();
 SELECT * INTO r FROM notification_worker_private.run WHERE run_id=p_run FOR UPDATE;
 IF NOT FOUND OR r.state<>'running' OR r.login_oid<>login OR r.backend_pid<>pg_backend_pid()
 OR r.backend_started_at IS DISTINCT FROM started OR a.active_run IS DISTINCT FROM p_run
 OR NOT EXISTS(SELECT 1 FROM public.job_run j WHERE j.id=p_run AND j.job_key='notifications.project' AND j.outcome='running')
 OR p_time AND clock_timestamp()>r.started_at+make_interval(secs=>a.max_run_seconds)
 OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted
  AND classid=((k>>32)&4294967295)::oid AND objid=(k&4294967295)::oid AND objsubid=1 AND mode='ExclusiveLock')
 THEN RAISE EXCEPTION 'Notification run unavailable' USING ERRCODE='42501';END IF;
 RETURN r;
END $expected_3$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'p_run uuid, p_time boolean DEFAULT true'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'notification_worker_private.run'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker_private'::regnamespace::oid OR p.proname<>'admit_run'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner)) THEN RAISE EXCEPTION 'Exact reviewed notification_worker_private.admit_run predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker_private.admit_batch(uuid)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_4$
DECLARE b notification_worker_private.batch;r notification_worker_private.run;s notification_worker_private.run_scope;
BEGIN
 PERFORM notification_worker_private.admit_login();
 SELECT * INTO b FROM notification_worker_private.batch WHERE batch_id=p_batch;
 IF NOT FOUND THEN RAISE EXCEPTION 'Notification batch unavailable' USING ERRCODE='42501';END IF;
 r:=notification_worker_private.admit_run(b.run_id);
 SELECT * INTO s FROM notification_worker_private.run_scope WHERE run_id=b.run_id AND tenant_id=b.tenant_id;
 IF b.login_oid<>r.login_oid OR b.backend_pid<>r.backend_pid OR b.backend_started_at IS DISTINCT FROM r.backend_started_at
 OR b.admitted_xid<>pg_current_xact_id() OR b.consumer IS DISTINCT FROM s.consumer
 OR b.consumer IS DISTINCT FROM notification_worker_private.consumer(b.tenant_id)
 OR s.standing IS DISTINCT FROM (SELECT status FROM public.tenant WHERE id=b.tenant_id)
 THEN RAISE EXCEPTION 'Notification batch unavailable' USING ERRCODE='42501';END IF;
 RETURN b;
END $expected_4$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'p_batch uuid'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'notification_worker_private.batch'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker_private'::regnamespace::oid OR p.proname<>'admit_batch'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner)) THEN RAISE EXCEPTION 'Exact reviewed notification_worker_private.admit_batch predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker.open_run()'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_5$
DECLARE login oid;r uuid;started timestamptz;a notification_worker_private.authority;k bigint:=hashtextextended('notification-worker:singleton',0);
BEGIN
 login:=notification_worker_private.admit_login();
 SELECT * INTO a FROM notification_worker_private.authority WHERE singleton FOR UPDATE;
 IF a.active_run IS NOT NULL OR EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted
  AND classid=((k>>32)&4294967295)::oid AND objid=(k&4294967295)::oid AND objsubid=1) THEN
  RAISE EXCEPTION 'Notification worker already running' USING ERRCODE='55000';END IF;
 IF NOT pg_try_advisory_lock(k) THEN
  RAISE EXCEPTION 'Notification worker already running' USING ERRCODE='55000';END IF;
 BEGIN
  IF (SELECT count(*) FROM public.tenant WHERE id<>'00000000-0000-0000-0000-000000000000'::uuid)>a.max_tenants THEN
   RAISE EXCEPTION 'Notification scope cap' USING ERRCODE='54000';END IF;
  SELECT backend_start INTO started FROM pg_stat_activity WHERE pid=pg_backend_pid();
  INSERT INTO public.job_run(job_key,outcome) VALUES('notifications.project','running') RETURNING id INTO r;
  INSERT INTO notification_worker_private.run(run_id,login_oid,backend_pid,backend_started_at) VALUES(r,login,pg_backend_pid(),started);
  INSERT INTO notification_worker_private.run_scope(run_id,tenant_id,standing,consumer)
   SELECT r,t.id,t.status,notification_worker_private.consumer(t.id) FROM public.tenant t
    WHERE t.id<>'00000000-0000-0000-0000-000000000000'::uuid;
  UPDATE notification_worker_private.authority SET active_run=r WHERE singleton;
  RETURN r;
 EXCEPTION WHEN OTHERS THEN
  PERFORM pg_advisory_unlock(hashtextextended('notification-worker:singleton',0));RAISE;
 END;
END $expected_5$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM ''
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'uuid'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker'::regnamespace::oid OR p.proname<>'open_run'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>2
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner,(SELECT oid FROM pg_roles WHERE rolname='ai_hr_notification_worker'))) THEN RAISE EXCEPTION 'Exact reviewed notification_worker.open_run predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker.scope_page(uuid,uuid,integer)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_6$
BEGIN
 PERFORM notification_worker_private.admit_run(p_run);
 IF p_count IS NULL OR p_count NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid scope page' USING ERRCODE='22023';END IF;
 RETURN QUERY SELECT s.tenant_id,s.standing,s.consumer,jsonb_build_object('tenantStatus',s.standing,'modules',
  coalesce((SELECT jsonb_agg(jsonb_build_object('moduleCode',m.module_code,'companyId',m.company_id,'status',m.status,'expiresAt',m.expires_at) ORDER BY m.id)
   FROM public.tenant_module m WHERE m.tenant_id=s.tenant_id AND m.module_code='notifications'),'[]'::jsonb))
 FROM notification_worker_private.run_scope s WHERE s.run_id=p_run AND (p_after IS NULL OR s.tenant_id>p_after) ORDER BY s.tenant_id LIMIT p_count;
END $expected_6$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'p_run uuid, p_after uuid, p_count integer'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'TABLE(tenant_id uuid, standing text, consumer text, entitlement_facts jsonb)'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker'::regnamespace::oid OR p.proname<>'scope_page'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>1000 OR p.proretset IS DISTINCT FROM true
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>2
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner,(SELECT oid FROM pg_roles WHERE rolname='ai_hr_notification_worker'))) THEN RAISE EXCEPTION 'Exact reviewed notification_worker.scope_page predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker.open_batch(uuid,uuid,integer)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_7$
DECLARE r notification_worker_private.run;a notification_worker_private.authority;s notification_worker_private.run_scope;b uuid;n integer;
BEGIN
 r:=notification_worker_private.admit_run(p_run);
 SELECT * INTO a FROM notification_worker_private.authority WHERE singleton;
 IF p_count IS NULL OR p_count NOT BETWEEN 1 AND a.max_batch_events OR r.committed_batches>=a.max_run_batches
 OR EXISTS(SELECT 1 FROM notification_worker_private.batch WHERE run_id=p_run) THEN
  RAISE EXCEPTION 'Notification batch cap or unfinished batch' USING ERRCODE='54000';END IF;
 SELECT * INTO s FROM notification_worker_private.run_scope WHERE run_id=p_run AND tenant_id=p_tenant FOR UPDATE;
 IF NOT FOUND OR s.state<>'pending' OR s.consumer IS NULL OR s.consumer IS DISTINCT FROM notification_worker_private.consumer(p_tenant)
 OR s.standing IS DISTINCT FROM (SELECT status FROM public.tenant WHERE id=p_tenant) THEN
  RAISE EXCEPTION 'Notification tenant unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('notification-cursor:'||p_tenant::text,0));
 INSERT INTO notification_worker_private.batch(run_id,tenant_id,consumer,login_oid,backend_pid,backend_started_at,admitted_xid,event_count)
 VALUES(p_run,p_tenant,s.consumer,r.login_oid,r.backend_pid,r.backend_started_at,pg_current_xact_id(),0) RETURNING batch_id INTO b;
 INSERT INTO notification_worker_private.batch_event(batch_id,event_id,event_sequence)
 SELECT b,p.event_id,p.event_sequence FROM public.notification_event_processing p JOIN public.domain_event e ON e.id=p.event_id AND e.tenant_id=p.tenant_id AND e.sequence=p.event_sequence
 WHERE p.tenant_id=p_tenant AND p.consumer=s.consumer AND p.disposition IS NULL ORDER BY p.event_sequence LIMIT p_count FOR SHARE OF p,e;
 GET DIAGNOSTICS n=ROW_COUNT;UPDATE notification_worker_private.batch SET event_count=n WHERE batch_id=b;
 RETURN b;
END $expected_7$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'p_run uuid, p_tenant uuid, p_count integer'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'uuid'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker'::regnamespace::oid OR p.proname<>'open_batch'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>2
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner,(SELECT oid FROM pg_roles WHERE rolname='ai_hr_notification_worker'))) THEN RAISE EXCEPTION 'Exact reviewed notification_worker.open_batch predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker.events(uuid)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_8$
DECLARE b notification_worker_private.batch;
BEGIN
 b:=notification_worker_private.admit_batch(p_batch);
 RETURN QUERY SELECT e.id,e.aggregate_type,e.aggregate_id,e.event_type,e.subject_employment_id,e.payload,e.sequence
 FROM notification_worker_private.batch_event x JOIN public.domain_event e ON e.id=x.event_id AND e.tenant_id=b.tenant_id AND e.sequence=x.event_sequence
 JOIN public.notification_event_processing p ON p.event_id=e.id AND p.tenant_id=e.tenant_id AND p.consumer=b.consumer AND p.disposition IS NULL
 WHERE x.batch_id=p_batch ORDER BY x.event_sequence;
END $expected_8$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'p_batch uuid'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'TABLE(event_id uuid, aggregate_type text, aggregate_id uuid, event_type text, subject_employment_id uuid, payload jsonb, event_sequence bigint)'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker'::regnamespace::oid OR p.proname<>'events'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>1000 OR p.proretset IS DISTINCT FROM true
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>2
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner,(SELECT oid FROM pg_roles WHERE rolname='ai_hr_notification_worker'))) THEN RAISE EXCEPTION 'Exact reviewed notification_worker.events predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker.finish_batch(uuid)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_9$
DECLARE b notification_worker_private.batch;n integer;effects integer;last_sequence bigint;completed integer;
BEGIN
 b:=notification_worker_private.admit_batch(p_batch);
 SELECT count(*)::integer,coalesce(sum(x.created_count),0)::integer,max(x.event_sequence) INTO n,effects,last_sequence
 FROM notification_worker_private.batch_event x WHERE x.batch_id=p_batch;
 IF n<>b.event_count OR EXISTS(SELECT 1 FROM notification_worker_private.batch_event WHERE batch_id=p_batch AND disposition IS NULL) THEN
  RAISE EXCEPTION 'Notification batch is unfinished' USING ERRCODE='55000';END IF;
 UPDATE public.notification_event_processing p SET disposition=x.disposition,processed_at=now()
 FROM notification_worker_private.batch_event x WHERE x.batch_id=p_batch AND p.event_id=x.event_id AND p.event_sequence=x.event_sequence
 AND p.tenant_id=b.tenant_id AND p.consumer=b.consumer AND p.disposition IS NULL;
 GET DIAGNOSTICS completed=ROW_COUNT;
 IF completed<>n THEN RAISE EXCEPTION 'Notification processing authority changed' USING ERRCODE='55000';END IF;
 IF n>0 THEN
  INSERT INTO public.notification_cursor(tenant_id,last_sequence,assessment_last_sequence)
  VALUES(b.tenant_id,CASE WHEN b.consumer='notifications' THEN last_sequence ELSE NULL END,CASE WHEN b.consumer='assessment-reminders' THEN last_sequence ELSE NULL END)
  ON CONFLICT(tenant_id) DO UPDATE SET
   last_sequence=CASE WHEN b.consumer='notifications' THEN greatest(public.notification_cursor.last_sequence,excluded.last_sequence) ELSE public.notification_cursor.last_sequence END,
   assessment_last_sequence=CASE WHEN b.consumer='assessment-reminders' THEN greatest(public.notification_cursor.assessment_last_sequence,excluded.assessment_last_sequence) ELSE public.notification_cursor.assessment_last_sequence END,updated_at=now();
 END IF;
 UPDATE notification_worker_private.run SET committed_batches=committed_batches+1,processed_events=processed_events+n,created_notifications=created_notifications+effects WHERE run_id=b.run_id AND state='running';
 IF NOT FOUND THEN RAISE EXCEPTION 'Notification run settlement changed' USING ERRCODE='55000';END IF;
 DELETE FROM notification_worker_private.batch WHERE batch_id=p_batch;
 RETURN QUERY SELECT n,effects;
END $expected_9$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'p_batch uuid'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'TABLE(processed integer, created integer)'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker'::regnamespace::oid OR p.proname<>'finish_batch'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>1000 OR p.proretset IS DISTINCT FROM true
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>2
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner,(SELECT oid FROM pg_roles WHERE rolname='ai_hr_notification_worker'))) THEN RAISE EXCEPTION 'Exact reviewed notification_worker.finish_batch predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker.settle_scope(uuid,uuid,text)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_10$
DECLARE r notification_worker_private.run;s notification_worker_private.run_scope;n bigint;age double precision;observed timestamptz;next_state text;
BEGIN
 r:=notification_worker_private.admit_run(p_run);
 IF p_reason IS NULL OR p_reason NOT IN('drained','capped','failed','disabled') OR EXISTS(SELECT 1 FROM notification_worker_private.batch WHERE run_id=p_run) THEN
  RAISE EXCEPTION 'Invalid notification settlement' USING ERRCODE='22023';END IF;
 SELECT * INTO s FROM notification_worker_private.run_scope WHERE run_id=p_run AND tenant_id=p_tenant FOR UPDATE;
 IF NOT FOUND OR s.state<>'pending' THEN RAISE EXCEPTION 'Notification scope unavailable' USING ERRCODE='42501';END IF;
 SELECT count(*),coalesce(greatest(0,extract(epoch FROM(clock_timestamp()-min(e.occurred_at)))),0)::double precision INTO n,age
 FROM public.notification_event_processing p JOIN public.domain_event e ON e.id=p.event_id AND e.tenant_id=p.tenant_id AND e.sequence=p.event_sequence
 WHERE p.tenant_id=p_tenant AND p.consumer=s.consumer AND p.disposition IS NULL;
 observed:=clock_timestamp();
 next_state:=CASE WHEN p_reason='failed' THEN 'failed' WHEN p_reason='capped' THEN 'capped'
  WHEN s.consumer IS DISTINCT FROM notification_worker_private.consumer(p_tenant) OR s.standing IS DISTINCT FROM (SELECT status FROM public.tenant WHERE id=p_tenant) THEN 'blocked'
  WHEN s.consumer IS NULL THEN 'skipped' WHEN n>0 THEN 'blocked' WHEN p_reason='disabled' THEN 'blocked' ELSE 'completed' END;
 UPDATE notification_worker_private.run_scope SET state=next_state,backlog_pending=n,backlog_oldest_seconds=age,observed_at=observed WHERE run_id=p_run AND tenant_id=p_tenant;
 RETURN QUERY SELECT n,age,observed;
END $expected_10$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'p_run uuid, p_tenant uuid, p_reason text'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'TABLE(pending bigint, oldest_seconds double precision, observed_at timestamp with time zone)'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker'::regnamespace::oid OR p.proname<>'settle_scope'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>1000 OR p.proretset IS DISTINCT FROM true
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>2
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner,(SELECT oid FROM pg_roles WHERE rolname='ai_hr_notification_worker'))) THEN RAISE EXCEPTION 'Exact reviewed notification_worker.settle_scope predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker.finish_run(uuid)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_11$
DECLARE r notification_worker_private.run;n integer;
BEGIN
 r:=notification_worker_private.admit_run(p_run);
 IF EXISTS(SELECT 1 FROM notification_worker_private.batch WHERE run_id=p_run)
 OR EXISTS(SELECT 1 FROM notification_worker_private.run_scope s WHERE s.run_id=p_run AND
  (s.state NOT IN('completed','skipped') OR s.backlog_pending<>0 OR s.observed_at IS NULL
   OR s.consumer IS DISTINCT FROM notification_worker_private.consumer(s.tenant_id)
   OR s.standing IS DISTINCT FROM (SELECT status FROM public.tenant WHERE id=s.tenant_id)))
 OR EXISTS(SELECT 1 FROM notification_worker_private.run_scope s JOIN public.notification_event_processing p ON p.tenant_id=s.tenant_id AND p.consumer=s.consumer
  WHERE s.run_id=p_run AND p.disposition IS NULL) THEN RAISE EXCEPTION 'Notification run is incomplete' USING ERRCODE='55000';END IF;
 SELECT count(*)::int INTO n FROM notification_worker_private.run_scope WHERE run_id=p_run AND state='completed';
 UPDATE public.job_run SET outcome='success',duration_ms=least(2147483647,greatest(0,extract(epoch FROM(clock_timestamp()-r.started_at))*1000))::integer,
 tenants_processed=n,tenants_failed=0,result=jsonb_build_object('batches',r.committed_batches,'processed',r.processed_events,'created',r.created_notifications)
 WHERE id=p_run AND job_key='notifications.project' AND outcome='running';
 IF NOT FOUND THEN RAISE EXCEPTION 'Notification terminal CAS refused' USING ERRCODE='55000';END IF;
 UPDATE notification_worker_private.run SET state='completed' WHERE run_id=p_run;
 UPDATE notification_worker_private.authority SET active_run=NULL WHERE singleton AND active_run=p_run;
 PERFORM pg_advisory_unlock(hashtextextended('notification-worker:singleton',0));
END $expected_11$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'p_run uuid'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'void'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker'::regnamespace::oid OR p.proname<>'finish_run'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>2
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner,(SELECT oid FROM pg_roles WHERE rolname='ai_hr_notification_worker'))) THEN RAISE EXCEPTION 'Exact reviewed notification_worker.finish_run predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker.fail_run(uuid,text)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_12$
DECLARE r notification_worker_private.run;n integer;
BEGIN
 r:=notification_worker_private.admit_run(p_run,false);
 IF p_reason IS NULL OR p_reason NOT IN('projection-unimplemented','scope-changed','budget-exhausted','database-refusal')
 OR EXISTS(SELECT 1 FROM notification_worker_private.batch WHERE run_id=p_run) THEN RAISE EXCEPTION 'Invalid notification failure' USING ERRCODE='22023';END IF;
 SELECT count(*)::int INTO n FROM notification_worker_private.run_scope WHERE run_id=p_run AND state NOT IN('completed','skipped');
 UPDATE public.job_run SET outcome='failed',duration_ms=least(2147483647,greatest(0,extract(epoch FROM(clock_timestamp()-r.started_at))*1000))::integer,
 tenants_processed=(SELECT count(*) FROM notification_worker_private.run_scope WHERE run_id=p_run AND state='completed'),
 tenants_failed=n,result=jsonb_build_object('batches',r.committed_batches,'processed',r.processed_events,'created',r.created_notifications),error=p_reason
 WHERE id=p_run AND job_key='notifications.project' AND outcome='running';
 IF NOT FOUND THEN RAISE EXCEPTION 'Notification terminal CAS refused' USING ERRCODE='55000';END IF;
 UPDATE notification_worker_private.run SET state='failed' WHERE run_id=p_run;
 UPDATE notification_worker_private.authority SET active_run=NULL WHERE singleton AND active_run=p_run;
 PERFORM pg_advisory_unlock(hashtextextended('notification-worker:singleton',0));
END $expected_12$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'p_run uuid, p_reason text'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'void'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker'::regnamespace::oid OR p.proname<>'fail_run'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>2
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner,(SELECT oid FROM pg_roles WHERE rolname='ai_hr_notification_worker'))) THEN RAISE EXCEPTION 'Exact reviewed notification_worker.fail_run predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker_private.event(uuid,uuid)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_13$
DECLARE b notification_worker_private.batch;e public.domain_event;
BEGIN
 b:=notification_worker_private.admit_batch(p_batch);
 SELECT ev.* INTO e FROM notification_worker_private.batch_event x
 JOIN public.domain_event ev ON ev.id=x.event_id AND ev.tenant_id=b.tenant_id AND ev.sequence=x.event_sequence
 JOIN public.notification_event_processing p ON p.event_id=ev.id AND p.tenant_id=ev.tenant_id AND p.event_sequence=ev.sequence AND p.consumer=b.consumer AND p.disposition IS NULL
 WHERE x.batch_id=p_batch AND x.event_id=p_event AND x.disposition IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Admitted notification event unavailable' USING ERRCODE='42501';END IF;
 -- Native authority comes from admission above; no supplied principal/GUC survives.
 PERFORM set_config('app.tenant_id',b.tenant_id::text,true),set_config('app.user_id','',true),
 set_config('app.roles','hr_admin',true),set_config('app.grants','[{"role":"hr_admin","companyId":null}]',true),set_config('app.agent_principal_id','',true);
 RETURN e;
END $expected_13$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'p_batch uuid, p_event uuid'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'domain_event'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker_private'::regnamespace::oid OR p.proname<>'event'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner)) THEN RAISE EXCEPTION 'Exact reviewed notification_worker_private.event predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker_private.obsolete(public.domain_event)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_14$
 SELECT CASE WHEN e.event_type LIKE 'employment-review.%' THEN coalesce(app.probation_legacy_review_owned(e.aggregate_id),false) ELSE false END
$expected_14$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'e domain_event'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'boolean'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker_private'::regnamespace::oid OR p.proname<>'obsolete'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='sql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'s' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner)) THEN RAISE EXCEPTION 'Exact reviewed notification_worker_private.obsolete predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker_private.audience(public.domain_event,text)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_15$
DECLARE c notification_worker_private.registry_contract;result jsonb;stage text;matches boolean;
BEGIN
 SELECT * INTO c FROM notification_worker_private.registry_contract WHERE event_type=e.event_type AND kind=p_kind AND implemented;
 IF NOT FOUND THEN RAISE EXCEPTION 'Canonical notification audience unavailable' USING ERRCODE='42501';END IF;
 IF c.guard IS NOT NULL THEN
  matches:=coalesce(e.payload->(c.guard->>'field')=c.guard->'equals',false);
  IF c.guard->'not'='true'::jsonb THEN matches:=NOT matches;END IF;
  IF NOT matches THEN RETURN ARRAY[]::uuid[];END IF;
 END IF;
 IF c.audience='none' THEN RETURN ARRAY[]::uuid[];
 ELSIF c.audience='subject' THEN RETURN CASE WHEN e.subject_employment_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[e.subject_employment_id] END;
 END IF;
 IF c.recipient_port='payrollClosed' AND e.event_type='payroll-batch.closed' THEN
  SELECT coalesce(jsonb_agg(DISTINCT s.employment_id),'[]'::jsonb) INTO result
  FROM public.payslip s JOIN public.employment work ON work.id=s.employment_id AND work.tenant_id=s.tenant_id
  WHERE s.batch_id=e.aggregate_id AND s.tenant_id=e.tenant_id;
 ELSIF c.recipient_port='noticePublished' AND e.event_type='notice.published' THEN
  SELECT coalesce(jsonb_agg(n.employment_id ORDER BY n.employment_id,n.id),'[]'::jsonb) INTO result
  FROM public.notice_recipient n JOIN public.notice notice ON notice.id=n.notice_id AND notice.tenant_id=n.tenant_id
  JOIN public.employment work ON work.id=n.employment_id AND work.tenant_id=n.tenant_id
  WHERE n.notice_id=e.aggregate_id AND n.tenant_id=e.tenant_id AND notice.published_at IS NOT NULL;
 ELSIF c.recipient_port IN('delegationStarted','delegationEnded') AND e.event_type IN('delegation.started','delegation.ended') THEN
  SELECT coalesce(jsonb_agg(r.manager_employment_id),'[]'::jsonb) INTO result FROM public.reporting_line r
  JOIN public.employment work ON work.id=r.manager_employment_id AND work.tenant_id=r.tenant_id
  WHERE r.id=e.aggregate_id AND r.tenant_id=e.tenant_id;
 ELSIF c.recipient_port='contract' AND e.event_type='contract.notification-due' THEN
  SELECT coalesce(jsonb_agg(r.employment_id),'[]'::jsonb) INTO result FROM app.contract_notification_recipients(e.aggregate_id) r;
 ELSIF c.recipient_port='onboardingDigest' AND e.event_type='onboarding.digest' THEN
  result:='[]'::jsonb;
  IF jsonb_typeof(e.payload->'caseId')='string' AND jsonb_typeof(e.payload->'recipientUserId')='string' THEN
   SELECT coalesce(jsonb_agg(r.id),'[]'::jsonb) INTO result FROM app.onboarding_mail_recipient((e.payload->>'caseId')::uuid,(e.payload->>'recipientUserId')::uuid) r(id);
  END IF;
 ELSIF c.recipient_port IN('rewardSuspension','rewardUploadChecker','rewardUploadReady','rewardRouted','rewardPoolChanged','rewardApproved') AND e.event_type IN('reward-access.suspended','reward-unit.upload-replaced','reward-unit.upload-confirmed','reward-unit.routed','reward-unit.final-pool-changed','reward-unit.approved') THEN
  IF e.event_type='reward-access.suspended' THEN SELECT coalesce(jsonb_agg(r.id),'[]'::jsonb) INTO result FROM app.reward_access_suspension_event_recipients(e.id) r(id);
  ELSIF e.event_type='reward-unit.upload-replaced' THEN SELECT coalesce(jsonb_agg(r.id),'[]'::jsonb) INTO result FROM app.reward_upload_checker_recipients(e.aggregate_id) r(id);
  ELSIF e.event_type='reward-unit.final-pool-changed' THEN SELECT coalesce(jsonb_agg(r.id),'[]'::jsonb) INTO result FROM app.reward_pool_notification_recipients(e.aggregate_id) r(id);
  ELSE
   stage:=CASE e.event_type WHEN 'reward-unit.upload-confirmed' THEN 'draft' WHEN 'reward-unit.approved' THEN 'approved' ELSE e.payload->>'to' END;
   SELECT coalesce(jsonb_agg(r.id),'[]'::jsonb) INTO result FROM app.reward_notification_recipients(e.aggregate_id,stage) r(id);
  END IF;
 ELSE RAISE EXCEPTION 'Canonical notification reader unavailable' USING ERRCODE='42501';END IF;
 RETURN ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(result));
END $expected_15$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'e domain_event, p_kind text'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'uuid[]'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker_private'::regnamespace::oid OR p.proname<>'audience'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'s' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner)) THEN RAISE EXCEPTION 'Exact reviewed notification_worker_private.audience predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker_private.capture_recipe(uuid,public.domain_event,text)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_16$
DECLARE ids uuid[];
BEGIN
 IF EXISTS(SELECT 1 FROM notification_worker_private.batch_recipe WHERE batch_id=p_batch AND event_id=e.id AND kind=p_kind) THEN RETURN;END IF;
 ids:=notification_worker_private.audience_for_batch(p_batch,e,p_kind);
 IF EXISTS(SELECT 1 FROM unnest(ids) wanted(id) WHERE NOT EXISTS(SELECT 1 FROM public.employment work WHERE work.id=wanted.id AND work.tenant_id=e.tenant_id)) THEN
  RAISE EXCEPTION 'Native notification audience escaped its event tenant' USING ERRCODE='42501';END IF;
 INSERT INTO notification_worker_private.batch_recipe(batch_id,event_id,kind) VALUES(p_batch,e.id,p_kind);
 INSERT INTO notification_worker_private.batch_recipient(batch_id,event_id,kind,employment_id,ordinal)
 SELECT p_batch,e.id,p_kind,r.id,min(r.ordinal) FROM unnest(ids) WITH ORDINALITY r(id,ordinal) GROUP BY r.id;
END $expected_16$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'p_batch uuid, e domain_event, p_kind text'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'void'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker_private'::regnamespace::oid OR p.proname<>'capture_recipe'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner)) THEN RAISE EXCEPTION 'Exact reviewed notification_worker_private.capture_recipe predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker.facts(uuid,uuid,text)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_17$
DECLARE e public.domain_event;c notification_worker_private.registry_contract;result jsonb;known boolean;implemented boolean;
BEGIN
 e:=notification_worker_private.event(p_batch,p_event);
 IF p_family IN('assessment-reminder','assessment-reminder-current','assessment-reminder-words','assessment-reminder-cooldown') THEN RETURN notification_worker_private.assessment_facts(p_batch,e,p_family);END IF;
 IF p_family='meta' THEN
  SELECT count(*)>0,coalesce(bool_and(r.implemented),false) INTO known,implemented FROM notification_worker_private.registry_contract r WHERE r.event_type=e.event_type;
  RETURN jsonb_build_object('known',known,'implemented',implemented,'obsolete',notification_worker_private.obsolete(e));
 END IF;
 IF notification_worker_private.obsolete(e) THEN RAISE EXCEPTION 'Obsolete notification event' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM notification_worker_private.registry_contract r WHERE r.event_type=e.event_type AND r.implemented AND CASE p_family
  WHEN 'subject-audience' THEN r.audience='subject'
  WHEN 'payroll-audience' THEN r.recipient_port='payrollClosed'
  WHEN 'notice-audience' THEN r.recipient_port='noticePublished'
  WHEN 'org-approvers' THEN r.recipient_port IN('delegationStarted','delegationEnded')
  WHEN 'contract-audience' THEN r.recipient_port='contract'
  WHEN 'onboarding-audience' THEN r.recipient_port='onboardingDigest'
  WHEN 'rewards-audience' THEN r.recipient_port IN('rewardSuspension','rewardUploadChecker','rewardUploadReady','rewardRouted','rewardPoolChanged','rewardApproved')
  ELSE false END;
 IF NOT FOUND THEN RAISE EXCEPTION 'Notification fact family unavailable for event' USING ERRCODE='42501';END IF;
 PERFORM notification_worker_private.capture_recipe(p_batch,e,c.kind);
 SELECT coalesce(jsonb_agg(r.employment_id ORDER BY r.ordinal),'[]'::jsonb) INTO result FROM notification_worker_private.batch_recipient r WHERE r.batch_id=p_batch AND r.event_id=e.id AND r.kind=c.kind;
 RETURN jsonb_build_object('employmentIds',result);
END $expected_17$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'p_batch uuid, p_event uuid, p_family text'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'jsonb'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker'::regnamespace::oid OR p.proname<>'facts'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>2
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner,(SELECT oid FROM pg_roles WHERE rolname='ai_hr_notification_worker'))) THEN RAISE EXCEPTION 'Exact reviewed notification_worker.facts predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker.project(uuid,uuid,text,uuid,jsonb,text)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_18$
DECLARE b notification_worker_private.batch;e public.domain_event;generated_id uuid;cap integer;
BEGIN
 e:=notification_worker_private.event(p_batch,p_event);SELECT * INTO b FROM notification_worker_private.batch WHERE batch_id=p_batch;
 IF notification_worker_private.obsolete(e) OR NOT EXISTS(SELECT 1 FROM notification_worker_private.registry_contract c
   WHERE c.event_type=e.event_type AND c.kind=p_kind AND c.category IS NOT DISTINCT FROM p_category AND c.implemented)
 OR NOT EXISTS(SELECT 1 FROM public.employment work WHERE work.id=p_recipient AND work.tenant_id=e.tenant_id)
 OR p_rendered IS NULL OR jsonb_typeof(p_rendered)<>'object'
 THEN RAISE EXCEPTION 'Notification projection unavailable' USING ERRCODE='42501';END IF;
 IF (SELECT count(*) FROM jsonb_object_keys(p_rendered))<>4
 OR NOT (p_rendered ?& ARRAY['title','body','linkPath','severity'])
 OR jsonb_typeof(p_rendered->'title')<>'string' OR length(p_rendered->>'title') NOT BETWEEN 1 AND 512
 OR jsonb_typeof(p_rendered->'body')<>'string' OR length(p_rendered->>'body')>4000
 OR jsonb_typeof(p_rendered->'linkPath')<>'string' OR length(p_rendered->>'linkPath') NOT BETWEEN 1 AND 1024
 OR p_rendered->>'linkPath' !~ '^/[^/\\[:cntrl:]]*' OR p_rendered->>'linkPath' ~ '^//' OR p_rendered->>'linkPath' ~ '[\\[:cntrl:]]'
 OR jsonb_typeof(p_rendered->'severity')<>'string' OR p_rendered->>'severity' NOT IN('info','action','warning')
 THEN RAISE EXCEPTION 'Invalid rendered notification' USING ERRCODE='22023';END IF;
 PERFORM notification_worker_private.capture_recipe(p_batch,e,p_kind);
 IF NOT EXISTS(SELECT 1 FROM notification_worker_private.batch_recipient r WHERE r.batch_id=p_batch AND r.event_id=e.id AND r.kind=p_kind AND r.employment_id=p_recipient) THEN
  RAISE EXCEPTION 'Recipient is outside the exact admitted event audience' USING ERRCODE='42501';END IF;
 SELECT n.id INTO generated_id FROM public.notification n WHERE n.tenant_id=e.tenant_id AND n.source_event_id=e.id AND n.recipient_employment_id=p_recipient AND n.kind=p_kind;
 IF generated_id IS NOT NULL THEN RETURN QUERY SELECT generated_id,false;RETURN;END IF;
 SELECT max_batch_projections INTO cap FROM notification_worker_private.authority WHERE singleton;
 IF (SELECT coalesce(sum(created_count),0) FROM notification_worker_private.batch_event WHERE batch_id=p_batch)>=cap THEN
  RAISE EXCEPTION 'Notification projection cap exhausted' USING ERRCODE='54000';END IF;
 INSERT INTO public.notification(tenant_id,recipient_employment_id,kind,title,body,link_path,severity,source_event_id)
 VALUES(e.tenant_id,p_recipient,p_kind,p_rendered->>'title',p_rendered->>'body',p_rendered->>'linkPath',(p_rendered->>'severity')::public.notification_severity,e.id) RETURNING notification.id INTO generated_id;
 IF p_category IS NOT NULL THEN PERFORM app.notification_email_enqueue(generated_id,p_category,e.sequence);END IF;
 UPDATE notification_worker_private.batch_event SET created_count=created_count+1 WHERE batch_id=p_batch AND event_id=e.id;
 RETURN QUERY SELECT generated_id,true;
END $expected_18$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'p_batch uuid, p_event uuid, p_kind text, p_recipient uuid, p_rendered jsonb, p_category text'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'TABLE(notification_id uuid, created boolean)'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker'::regnamespace::oid OR p.proname<>'project'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>1000 OR p.proretset IS DISTINCT FROM true
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>2
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner,(SELECT oid FROM pg_roles WHERE rolname='ai_hr_notification_worker'))) THEN RAISE EXCEPTION 'Exact reviewed notification_worker.project predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker.project_reward_account(uuid,uuid)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_19$
DECLARE e public.domain_event;added integer;cap integer;
BEGIN
 e:=notification_worker_private.event(p_batch,p_event);
 IF e.event_type<>'reward-access.suspended' OR e.aggregate_type<>'reward-unit'
 OR NOT EXISTS(SELECT 1 FROM notification_worker_private.registry_contract WHERE event_type=e.event_type AND implemented)
 OR EXISTS(SELECT 1 FROM notification_worker_private.batch_event WHERE batch_id=p_batch AND event_id=e.id AND account_projected)
 THEN RAISE EXCEPTION 'Rewards account projection unavailable' USING ERRCODE='42501';END IF;
 added:=app.reward_access_project_account_suspension(e.id);
 UPDATE notification_worker_private.batch_event SET account_projected=true,created_count=created_count+added WHERE batch_id=p_batch AND event_id=e.id;
 SELECT max_batch_projections INTO cap FROM notification_worker_private.authority WHERE singleton;
 IF (SELECT sum(created_count) FROM notification_worker_private.batch_event WHERE batch_id=p_batch)>cap THEN RAISE EXCEPTION 'Notification projection cap exhausted' USING ERRCODE='54000';END IF;
 RETURN added;
END $expected_19$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'p_batch uuid, p_event uuid'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'integer'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker'::regnamespace::oid OR p.proname<>'project_reward_account'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>2
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner,(SELECT oid FROM pg_roles WHERE rolname='ai_hr_notification_worker'))) THEN RAISE EXCEPTION 'Exact reviewed notification_worker.project_reward_account predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker.finish_event(uuid,uuid,text)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_20$
DECLARE e public.domain_event;known boolean;implemented boolean;obsolete boolean;c notification_worker_private.registry_contract;
BEGIN
 e:=notification_worker_private.event(p_batch,p_event);obsolete:=notification_worker_private.obsolete(e);
 SELECT count(*)>0,coalesce(bool_and(registry.implemented),false) INTO known,implemented FROM notification_worker_private.registry_contract registry WHERE registry.event_type=e.event_type;
 IF p_disposition IS NULL OR p_disposition NOT IN('processed','ignored')
 OR p_disposition='ignored' AND known AND NOT obsolete OR p_disposition='processed' AND (NOT known OR obsolete OR NOT implemented)
 OR e.event_type='assessment.reminder-queued' AND NOT EXISTS(SELECT 1 FROM notification_worker_private.assessment_admission a WHERE a.batch_id=p_batch AND a.event_id=e.id AND a.prepared)
 OR p_disposition='processed' AND e.event_type='reward-access.suspended' AND NOT EXISTS(SELECT 1 FROM notification_worker_private.batch_event WHERE batch_id=p_batch AND event_id=e.id AND account_projected)
 THEN RAISE EXCEPTION 'Notification event settlement unavailable' USING ERRCODE='42501';END IF;
 IF p_disposition='processed' THEN
  FOR c IN SELECT * FROM notification_worker_private.registry_contract WHERE event_type=e.event_type LOOP
   PERFORM notification_worker_private.capture_recipe(p_batch,e,c.kind);
   IF EXISTS(SELECT 1 FROM notification_worker_private.batch_recipient r WHERE r.batch_id=p_batch AND r.event_id=e.id AND r.kind=c.kind
    AND NOT EXISTS(SELECT 1 FROM public.notification n WHERE n.tenant_id=e.tenant_id AND n.source_event_id=e.id AND n.kind=c.kind AND n.recipient_employment_id=r.employment_id)) THEN
    RAISE EXCEPTION 'Canonical event audience is not fully projected' USING ERRCODE='55000';END IF;
  END LOOP;
 END IF;
 UPDATE notification_worker_private.batch_event SET disposition=p_disposition WHERE batch_id=p_batch AND event_id=e.id AND disposition IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Notification event already finished' USING ERRCODE='42501';END IF;
END $expected_20$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'p_batch uuid, p_event uuid, p_disposition text'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'void'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker'::regnamespace::oid OR p.proname<>'finish_event'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>2
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner,(SELECT oid FROM pg_roles WHERE rolname='ai_hr_notification_worker'))) THEN RAISE EXCEPTION 'Exact reviewed notification_worker.finish_event predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker_private.assessment_epochs(uuid,uuid)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_21$
 SELECT coalesce(jsonb_agg(jsonb_build_object('scopeId',scope_id,'revision',revision) ORDER BY scope_id),'[]'::jsonb)
 FROM public.performance_assessment_reminder_epoch WHERE tenant_id=p_tenant AND scope_id IN('00000000-0000-0000-0000-000000000000'::uuid,p_cycle)
$expected_21$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'p_tenant uuid, p_cycle uuid'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'jsonb'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker_private'::regnamespace::oid OR p.proname<>'assessment_epochs'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='sql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'s' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner)) THEN RAISE EXCEPTION 'Exact reviewed notification_worker_private.assessment_epochs predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker_private.capture_assessment(uuid,public.domain_event)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_22$
DECLARE a notification_worker_private.assessment_admission;p notification_worker_private.assessment_projection;r record;
 versions jsonb;started timestamptz;g jsonb;routes jsonb;state jsonb;expiry timestamptz;boundary timestamptz;until_at timestamptz;
BEGIN
 IF e.event_type<>'assessment.reminder-queued' OR e.aggregate_type<>'assessment-reminder' THEN RAISE EXCEPTION 'Assessment reminder event required' USING ERRCODE='42501';END IF;
 SELECT * INTO a FROM notification_worker_private.assessment_admission WHERE batch_id=p_batch AND event_id=e.id;
 IF FOUND THEN RETURN a;END IF;
 SELECT recipient.id,recipient.run_id,recipient.user_id,recipient.employment_id,recipient.outcome,run.cycle_id,run.mode INTO r
 FROM public.performance_assessment_reminder_recipient recipient JOIN public.performance_assessment_reminder_run run ON run.id=recipient.run_id AND run.tenant_id=recipient.tenant_id
 WHERE recipient.id=e.aggregate_id AND recipient.tenant_id=e.tenant_id AND recipient.source_event_id=e.id;
 IF NOT FOUND OR r.outcome<>'queued' OR r.employment_id IS NULL THEN
  INSERT INTO notification_worker_private.assessment_admission(batch_id,event_id,recipient_id,available,epochs) VALUES(p_batch,e.id,e.aggregate_id,false,'[]'::jsonb) RETURNING * INTO a;RETURN a;
 END IF;
 versions:=notification_worker_private.assessment_epochs(e.tenant_id,r.cycle_id);
 SELECT * INTO p FROM notification_worker_private.assessment_projection WHERE batch_id=p_batch AND cycle_id=r.cycle_id AND epochs=versions AND expires_at>clock_timestamp() ORDER BY started_at DESC LIMIT 1;
 IF NOT FOUND THEN
  started:=date_trunc('milliseconds',clock_timestamp());g:=app.assessment_pending_work(r.cycle_id);
  IF g IS NULL THEN routes:='[]'::jsonb;ELSE SELECT coalesce(jsonb_agg(to_jsonb(route) ORDER BY route.user_id,route.employment_id),'[]'::jsonb) INTO routes FROM app.assessment_reminder_mail_routes(r.cycle_id) route;END IF;
  SELECT jsonb_build_object('modules',(SELECT coalesce(jsonb_agg(jsonb_build_object('code',tm.module_code,'company',tm.company_id)),'[]'::jsonb) FROM public.tenant_module tm WHERE tm.tenant_id=e.tenant_id AND tm.status IN('active','trial') AND (tm.expires_at IS NULL OR tm.expires_at>now())),
   'settings',(SELECT coalesce(jsonb_object_agg(ts.key,ts.value),'{}'::jsonb) FROM public.tenant_setting ts JOIN public.setting_definition sd ON sd.key=ts.key WHERE ts.tenant_id=e.tenant_id AND ts.key='performance.reminder_rules' AND (sd.scope='tenant' OR ts.source<>'customer')),
   'tenant_status',(SELECT status FROM public.tenant WHERE id=e.tenant_id)) INTO state;
  SELECT min(expires_at) INTO expiry FROM public.tenant_module WHERE tenant_id=e.tenant_id AND expires_at>now();
  SELECT min(times.boundary::timestamptz) INTO boundary FROM jsonb_each(coalesce(g#>'{cycle,policy,windows}','{}'::jsonb)) cell
   CROSS JOIN LATERAL(VALUES(cell.value->>'opensAt'),(cell.value->>'closesAt')) times(boundary) WHERE times.boundary IS NOT NULL AND times.boundary::timestamptz>started;
  until_at:=least(started+interval '60 seconds',((date_trunc('day',started AT TIME ZONE 'Asia/Kuala_Lumpur')+interval '1 day'-interval '1 millisecond') AT TIME ZONE 'Asia/Kuala_Lumpur'),coalesce(expiry,'infinity'::timestamptz),coalesce(boundary,'infinity'::timestamptz));
  INSERT INTO notification_worker_private.assessment_projection(batch_id,cycle_id,epochs,started_at,expires_at,module_expiry,graph,routes,snapshot)
   VALUES(p_batch,r.cycle_id,versions,started,until_at,expiry,g,routes,state) RETURNING * INTO p;
 END IF;
 INSERT INTO notification_worker_private.assessment_admission(batch_id,event_id,recipient_id,available,run_id,cycle_id,user_id,employment_id,mode,epochs,projection_id)
  VALUES(p_batch,e.id,e.aggregate_id,true,r.run_id,r.cycle_id,r.user_id,r.employment_id,r.mode,versions,p.id) RETURNING * INTO a;
 RETURN a;
END $expected_22$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'p_batch uuid, e domain_event'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'notification_worker_private.assessment_admission'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker_private'::regnamespace::oid OR p.proname<>'capture_assessment'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner)) THEN RAISE EXCEPTION 'Exact reviewed notification_worker_private.capture_assessment predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker_private.assessment_facts(uuid,public.domain_event,text)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_23$
DECLARE a notification_worker_private.assessment_admission;p notification_worker_private.assessment_projection;cooling boolean;
BEGIN
 a:=notification_worker_private.capture_assessment(p_batch,e);
 IF p_family='assessment-reminder' THEN
  IF NOT a.available THEN RETURN jsonb_build_object('kind','unavailable');END IF;
  SELECT * INTO p FROM notification_worker_private.assessment_projection WHERE id=a.projection_id;
  RETURN jsonb_build_object('kind','ready','tenantId',e.tenant_id,'cycleId',a.cycle_id,'userId',a.user_id,'employmentId',a.employment_id,'mode',a.mode,'epochs',a.epochs,
   'graph',p.graph,'routes',p.routes,'startedAt',p.started_at,'moduleExpiry',p.module_expiry,'snapshot',p.snapshot);
 ELSIF p_family='assessment-reminder-current' AND a.available THEN
  RETURN jsonb_build_object('epochs',notification_worker_private.assessment_epochs(e.tenant_id,a.cycle_id),'checkedAt',date_trunc('milliseconds',clock_timestamp()));
 ELSIF p_family='assessment-reminder-words' AND a.available THEN RETURN app.email_design_assessment_words();
 ELSIF p_family='assessment-reminder-cooldown' AND a.available THEN
  SELECT EXISTS(SELECT 1 FROM public.performance_assessment_reminder_recipient r JOIN public.performance_assessment_reminder_run run ON run.id=r.run_id AND run.tenant_id=r.tenant_id
   LEFT JOIN public.notification_delivery d ON d.source_event_id=r.source_event_id AND d.recipient_user_id=r.user_id AND d.channel='email'
   WHERE r.tenant_id=e.tenant_id AND run.cycle_id=a.cycle_id AND r.user_id=a.user_id AND r.id<>a.recipient_id
    AND ((d.status='sent' AND d.sent_at>now()-interval '20 hours') OR d.status='pending' OR d.last_error='uncertain' OR r.outcome='queued' AND d.id IS NULL AND r.created_at>now()-interval '20 hours')) INTO cooling;
  RETURN to_jsonb(cooling);
 ELSE RAISE EXCEPTION 'Assessment reminder fact phase unavailable' USING ERRCODE='42501';END IF;
END $expected_23$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'p_batch uuid, e domain_event, p_family text'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'jsonb'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker_private'::regnamespace::oid OR p.proname<>'assessment_facts'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner)) THEN RAISE EXCEPTION 'Exact reviewed notification_worker_private.assessment_facts predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker_private.assessment_iso_datetime(text)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_24$
 SELECT value ~ '^(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:[.][0-9]+)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$'
 OR value ~ '^[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:[.][0-9]+)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$'
$expected_24$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'value text'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'boolean'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker_private'::regnamespace::oid OR p.proname<>'assessment_iso_datetime'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='sql')
 OR p.prosecdef IS DISTINCT FROM false OR p.proisstrict OR p.proleakproof OR p.provolatile<>'i' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner)) THEN RAISE EXCEPTION 'Exact reviewed notification_worker_private.assessment_iso_datetime predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker_private.assessment_codepoint_length(text)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_25$
 SELECT length(value)
$expected_25$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'value text'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'integer'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker_private'::regnamespace::oid OR p.proname<>'assessment_codepoint_length'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='sql')
 OR p.prosecdef IS DISTINCT FROM false OR p.proisstrict OR p.proleakproof OR p.provolatile<>'i' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner)) THEN RAISE EXCEPTION 'Exact reviewed notification_worker_private.assessment_codepoint_length predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker_private.assessment_js_trim(text)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_26$
 SELECT btrim(value,chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||
  chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||
  chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279))
$expected_26$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'value text'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'text'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker_private'::regnamespace::oid OR p.proname<>'assessment_js_trim'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='sql')
 OR p.prosecdef IS DISTINCT FROM false OR p.proisstrict OR p.proleakproof OR p.provolatile<>'i' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner)) THEN RAISE EXCEPTION 'Exact reviewed notification_worker_private.assessment_js_trim predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker.prepare_assessment(uuid,uuid,jsonb)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_27$
DECLARE e public.domain_event;a notification_worker_private.assessment_admission;p notification_worker_private.assessment_projection;r record;
 kind text;next_outcome text;at_time timestamptz;until_time timestamptz;expected_tenant_epoch bigint;expected_cycle_epoch bigint;item jsonb;words jsonb;canonical_tasks jsonb:='[]'::jsonb;people jsonb;
BEGIN
 e:=notification_worker_private.event(p_batch,p_event);a:=notification_worker_private.capture_assessment(p_batch,e);
 IF a.prepared OR p_decision IS NULL OR jsonb_typeof(p_decision)<>'object' OR jsonb_typeof(p_decision->'kind') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Assessment preparation proposal unavailable' USING ERRCODE='42501';END IF;
 kind:=p_decision->>'kind';
 -- Logical parser limits and the canonical recipient table's storage limits
 -- both bind. Refuse oversized proposals before a table CHECK failure; never
 -- loosen the existing 20k task / 220k word storage contract for wire parity.
 IF kind NOT IN('noop','skip','prepare') OR octet_length(p_decision::text)>260000 THEN RAISE EXCEPTION 'Closed bounded preparation decision required' USING ERRCODE='22023';END IF;
 IF kind='noop' THEN
  IF a.available OR (SELECT count(*) FROM jsonb_object_keys(p_decision))<>1 THEN RAISE EXCEPTION 'Assessment no-op is not current' USING ERRCODE='42501';END IF;
  UPDATE notification_worker_private.assessment_admission SET prepared=true WHERE batch_id=p_batch AND event_id=e.id;RETURN ARRAY[]::uuid[];
 END IF;
 IF NOT a.available THEN RAISE EXCEPTION 'Assessment recipient is not queued' USING ERRCODE='42501';END IF;
 SELECT recipient.id,recipient.outcome,recipient.user_id,recipient.employment_id,recipient.run_id,run.cycle_id INTO r FROM public.performance_assessment_reminder_recipient recipient
 JOIN public.performance_assessment_reminder_run run ON run.id=recipient.run_id AND run.tenant_id=recipient.tenant_id
 WHERE recipient.id=a.recipient_id AND recipient.tenant_id=e.tenant_id AND recipient.source_event_id=e.id;
 IF NOT FOUND OR r.user_id IS DISTINCT FROM a.user_id OR r.employment_id IS DISTINCT FROM a.employment_id OR r.run_id IS DISTINCT FROM a.run_id OR r.cycle_id IS DISTINCT FROM a.cycle_id THEN RAISE EXCEPTION 'Assessment source identity changed' USING ERRCODE='42501';END IF;
 IF r.outcome<>'queued' THEN
  UPDATE notification_worker_private.assessment_admission SET prepared=true WHERE batch_id=p_batch AND event_id=e.id;RETURN ARRAY[]::uuid[];
 END IF;
 IF kind='skip' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(p_decision))<>2 OR NOT(p_decision?&ARRAY['kind','outcome']) OR jsonb_typeof(p_decision->'outcome') IS DISTINCT FROM 'string' OR p_decision->>'outcome' NOT IN('changed','noPendingWork','noConsent','cooldown') THEN RAISE EXCEPTION 'Invalid assessment refusal' USING ERRCODE='22023';END IF;
  next_outcome:=p_decision->>'outcome';
 ELSIF kind='prepare' THEN
  IF (SELECT count(*) FROM jsonb_object_keys(p_decision))<>7 OR NOT(p_decision?&ARRAY['kind','tasks','mailWords','preparedAt','preparedUntil','tenantEpoch','cycleEpoch'])
   OR jsonb_typeof(p_decision->'tasks')<>'array' OR jsonb_array_length(p_decision->'tasks') NOT BETWEEN 1 AND 16 OR octet_length((p_decision->'tasks')::text)>20000
   OR jsonb_typeof(p_decision->'preparedAt') IS DISTINCT FROM 'string' OR jsonb_typeof(p_decision->'preparedUntil') IS DISTINCT FROM 'string'
   OR notification_worker_private.assessment_iso_datetime(p_decision->>'preparedAt') IS NOT TRUE
   OR notification_worker_private.assessment_iso_datetime(p_decision->>'preparedUntil') IS NOT TRUE
   OR jsonb_typeof(p_decision->'tenantEpoch') IS DISTINCT FROM 'number' OR jsonb_typeof(p_decision->'cycleEpoch') IS DISTINCT FROM 'number'
   THEN RAISE EXCEPTION 'Invalid assessment preparation' USING ERRCODE='22023';END IF;
  IF (p_decision->>'tenantEpoch')::numeric NOT BETWEEN 0 AND 9007199254740991 OR (p_decision->>'cycleEpoch')::numeric NOT BETWEEN 0 AND 9007199254740991
   OR trunc((p_decision->>'tenantEpoch')::numeric)<>(p_decision->>'tenantEpoch')::numeric
   OR trunc((p_decision->>'cycleEpoch')::numeric)<>(p_decision->>'cycleEpoch')::numeric THEN RAISE EXCEPTION 'Invalid assessment preparation epochs' USING ERRCODE='22023';END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_decision->'tasks') LOOP
   IF jsonb_typeof(item)<>'object' OR NOT(item?&ARRAY['key','count','closesAt']) OR EXISTS(SELECT 1 FROM jsonb_object_keys(item) key WHERE key NOT IN('key','count','closesAt','people'))
    OR jsonb_typeof(item->'key') IS DISTINCT FROM 'string' OR NOT EXISTS(SELECT 1 FROM notification_worker_private.assessment_task_key k WHERE k.key=item->>'key')
    OR jsonb_typeof(item->'count') IS DISTINCT FROM 'number'
    OR jsonb_typeof(item->'closesAt') NOT IN('string','null') THEN RAISE EXCEPTION 'Invalid assessment task' USING ERRCODE='22023';END IF;
   IF (item->>'count')::numeric NOT BETWEEN 1 AND 1000000 OR trunc((item->>'count')::numeric)<>(item->>'count')::numeric
    OR item->'closesAt'<>'null'::jsonb AND notification_worker_private.assessment_iso_datetime(item->>'closesAt') IS NOT TRUE THEN RAISE EXCEPTION 'Invalid assessment task value' USING ERRCODE='22023';END IF;
   IF item?'people' THEN
    IF jsonb_typeof(item->'people')<>'array' OR jsonb_array_length(item->'people')>3 THEN RAISE EXCEPTION 'Invalid assessment task people' USING ERRCODE='22023';END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(item->'people') name WHERE jsonb_typeof(name) IS DISTINCT FROM 'string'
     OR notification_worker_private.assessment_codepoint_length(notification_worker_private.assessment_js_trim(name#>>'{}')) NOT BETWEEN 1 AND 200) THEN RAISE EXCEPTION 'Invalid assessment task names' USING ERRCODE='22023';END IF;
    SELECT coalesce(jsonb_agg(to_jsonb(notification_worker_private.assessment_js_trim(name#>>'{}')) ORDER BY ordinal),'[]'::jsonb) INTO people
     FROM jsonb_array_elements(item->'people') WITH ORDINALITY names(name,ordinal);
    item:=jsonb_set(item,'{people}',people);
   END IF;
   canonical_tasks:=canonical_tasks||jsonb_build_array(item);
  END LOOP;
  words:=p_decision->'mailWords';
  IF words<>'null'::jsonb AND (jsonb_typeof(words)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(words))<>2 OR NOT(words?&ARRAY['subject','opening']) OR jsonb_typeof(words->'subject') IS DISTINCT FROM 'string' OR jsonb_typeof(words->'opening') IS DISTINCT FROM 'string' OR notification_worker_private.assessment_codepoint_length(words->>'subject') NOT BETWEEN 1 AND 20000 OR (position(chr(13) in (words->>'subject'))>0 OR position(chr(10) in (words->>'subject'))>0) OR notification_worker_private.assessment_codepoint_length(words->>'opening') NOT BETWEEN 1 AND 30000 OR octet_length(words::text)>220000) THEN RAISE EXCEPTION 'Invalid prepared reminder words' USING ERRCODE='22023';END IF;
  SELECT * INTO p FROM notification_worker_private.assessment_projection WHERE id=a.projection_id;
  expected_tenant_epoch:=coalesce((SELECT (x->>'revision')::bigint FROM jsonb_array_elements(a.epochs) x WHERE x->>'scopeId'='00000000-0000-0000-0000-000000000000'),0);
  expected_cycle_epoch:=coalesce((SELECT (x->>'revision')::bigint FROM jsonb_array_elements(a.epochs) x WHERE x->>'scopeId'=a.cycle_id::text),0);
  IF (p_decision->>'tenantEpoch')::numeric<>expected_tenant_epoch OR (p_decision->>'cycleEpoch')::numeric<>expected_cycle_epoch THEN RAISE EXCEPTION 'Assessment epoch proposal changed' USING ERRCODE='42501';END IF;
  BEGIN
   at_time:=(p_decision->>'preparedAt')::timestamptz;until_time:=(p_decision->>'preparedUntil')::timestamptz;
  EXCEPTION WHEN SQLSTATE '22007' OR SQLSTATE '22008' OR SQLSTATE '22009' THEN RAISE EXCEPTION 'Invalid native preparation instant' USING ERRCODE='22023';END;
  IF NOT isfinite(at_time) OR NOT isfinite(until_time) THEN RAISE EXCEPTION 'Finite preparation instants required' USING ERRCODE='22023';END IF;
  IF at_time<p.started_at OR at_time>clock_timestamp() OR until_time<=at_time OR until_time>least(at_time+interval '60 seconds',p.expires_at) THEN RAISE EXCEPTION 'Assessment preparation deadline is invalid' USING ERRCODE='22023';END IF;
  IF notification_worker_private.assessment_epochs(e.tenant_id,a.cycle_id) IS DISTINCT FROM a.epochs OR p.expires_at<=clock_timestamp() THEN next_outcome:='changed';
  ELSE
   IF NOT EXISTS(SELECT 1 FROM public.app_user u JOIN public.employment work ON work.person_id=u.person_id AND work.tenant_id=u.tenant_id WHERE u.id=a.user_id AND u.tenant_id=e.tenant_id AND work.id=a.employment_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'Assessment recipient identity is not current' USING ERRCODE='42501';END IF;
   UPDATE public.performance_assessment_reminder_recipient SET tasks=canonical_tasks,mail_words=nullif(words,'null'::jsonb),prepared_at=at_time,prepared_until=until_time,tenant_epoch=expected_tenant_epoch,cycle_epoch=expected_cycle_epoch WHERE id=a.recipient_id AND tenant_id=e.tenant_id AND outcome='queued';
   IF NOT FOUND THEN RAISE EXCEPTION 'Assessment preparation changed' USING ERRCODE='55000';END IF;
   UPDATE notification_worker_private.assessment_admission SET prepared=true,recipient_employment_id=a.employment_id WHERE batch_id=p_batch AND event_id=e.id;RETURN ARRAY[a.employment_id];
  END IF;
 ELSE RAISE EXCEPTION 'Unknown assessment preparation decision' USING ERRCODE='22023';END IF;
 UPDATE public.performance_assessment_reminder_recipient SET outcome=next_outcome,tasks='[]'::jsonb,mail_words=NULL,prepared_at=NULL,prepared_until=NULL WHERE id=a.recipient_id AND tenant_id=e.tenant_id;
 UPDATE notification_worker_private.assessment_admission SET prepared=true WHERE batch_id=p_batch AND event_id=e.id;RETURN ARRAY[]::uuid[];
END $expected_27$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'p_batch uuid, p_event uuid, p_decision jsonb'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'uuid[]'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker'::regnamespace::oid OR p.proname<>'prepare_assessment'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'v' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>2
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner,(SELECT oid FROM pg_roles WHERE rolname='ai_hr_notification_worker'))) THEN RAISE EXCEPTION 'Exact reviewed notification_worker.prepare_assessment predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker_private.audience_for_batch(uuid,public.domain_event,text)'::regprocedure;
 IF p.prosrc IS DISTINCT FROM $expected_28$
DECLARE a notification_worker_private.assessment_admission;
BEGIN
 IF e.event_type<>'assessment.reminder-queued' THEN RETURN notification_worker_private.audience(e,p_kind);END IF;
 IF p_kind<>'performance.reminder' OR NOT EXISTS(SELECT 1 FROM notification_worker_private.registry_contract c WHERE c.event_type=e.event_type AND c.kind=p_kind AND c.recipient_port='assessmentReminder' AND c.implemented) THEN RAISE EXCEPTION 'Canonical reminder recipe unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO a FROM notification_worker_private.assessment_admission WHERE batch_id=p_batch AND event_id=e.id;
 IF NOT FOUND OR NOT a.prepared THEN RAISE EXCEPTION 'Native assessment preparation required' USING ERRCODE='42501';END IF;
 RETURN CASE WHEN a.recipient_employment_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[a.recipient_employment_id] END;
END $expected_28$
 OR pg_get_function_arguments(p.oid) IS DISTINCT FROM 'p_batch uuid, e domain_event, p_kind text'
 OR pg_get_function_result(p.oid) IS DISTINCT FROM 'uuid[]'
 OR p.pronamespace IS DISTINCT FROM 'notification_worker_private'::regnamespace::oid OR p.proname<>'audience_for_batch'
 OR p.proowner IS DISTINCT FROM expected_owner OR p.prolang IS DISTINCT FROM (SELECT oid FROM pg_language WHERE lanname='plpgsql')
 OR p.prosecdef IS DISTINCT FROM true OR p.proisstrict OR p.proleakproof OR p.provolatile<>'s' OR p.proparallel<>'u'
 OR p.prokind<>'f' OR p.provariadic<>0 OR p.procost<>100 OR p.prosupport<>0 OR p.probin IS NOT NULL
 OR p.prosqlbody IS NOT NULL OR p.protrftypes IS NOT NULL
 OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
 OR p.prorows<>0 OR p.proretset IS DISTINCT FROM false
 OR (SELECT count(*) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))))<>1
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x WHERE x.grantor<>expected_owner OR x.privilege_type<>'EXECUTE' OR x.is_grantable OR x.grantee NOT IN(expected_owner)) THEN RAISE EXCEPTION 'Exact reviewed notification_worker_private.audience_for_batch predecessor required' USING ERRCODE='55000';END IF;
END $guard$;

-- Sole additive failure-code change; every original native CAS/effect stays.
CREATE OR REPLACE FUNCTION notification_worker.fail_run(p_run uuid,p_reason text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE r notification_worker_private.run;n integer;
BEGIN
 r:=notification_worker_private.admit_run(p_run,false);
 IF p_reason IS NULL OR p_reason NOT IN('projection-unimplemented','scope-changed','budget-exhausted','database-refusal','interrupted')
 OR EXISTS(SELECT 1 FROM notification_worker_private.batch WHERE run_id=p_run) THEN RAISE EXCEPTION 'Invalid notification failure' USING ERRCODE='22023';END IF;
 SELECT count(*)::int INTO n FROM notification_worker_private.run_scope WHERE run_id=p_run AND state NOT IN('completed','skipped');
 UPDATE public.job_run SET outcome='failed',duration_ms=least(2147483647,greatest(0,extract(epoch FROM(clock_timestamp()-r.started_at))*1000))::integer,
 tenants_processed=(SELECT count(*) FROM notification_worker_private.run_scope WHERE run_id=p_run AND state='completed'),
 tenants_failed=n,result=jsonb_build_object('batches',r.committed_batches,'processed',r.processed_events,'created',r.created_notifications),error=p_reason
 WHERE id=p_run AND job_key='notifications.project' AND outcome='running';
 IF NOT FOUND THEN RAISE EXCEPTION 'Notification terminal CAS refused' USING ERRCODE='55000';END IF;
 UPDATE notification_worker_private.run SET state='failed' WHERE run_id=p_run;
 UPDATE notification_worker_private.authority SET active_run=NULL WHERE singleton AND active_run=p_run;
 PERFORM pg_advisory_unlock(hashtextextended('notification-worker:singleton',0));
END $body$;

-- Actual settled batch provenance persists after the admission rows cascade away.
CREATE TABLE notification_worker_private.committed_batch(
 batch_id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES notification_worker_private.run(run_id) ON DELETE CASCADE,
 tenant_id uuid NOT NULL,consumer text NOT NULL,processed integer NOT NULL CHECK(processed>=0),
 created integer NOT NULL CHECK(created>=0),committed_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE notification_worker_private.committed_event(
 batch_id uuid NOT NULL REFERENCES notification_worker_private.committed_batch(batch_id) ON DELETE CASCADE,
 event_id uuid NOT NULL,event_sequence bigint NOT NULL,disposition text NOT NULL CHECK(disposition IN('processed','ignored')),
 created integer NOT NULL CHECK(created>=0),PRIMARY KEY(batch_id,event_id));
CREATE TABLE notification_worker_private.process_contract(kind text NOT NULL,object_oid oid NOT NULL,details jsonb NOT NULL,PRIMARY KEY(kind,object_oid));
ALTER TABLE notification_worker_private.committed_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_worker_private.committed_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_worker_private.process_contract ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON notification_worker_private.committed_batch,notification_worker_private.committed_event,notification_worker_private.process_contract FROM PUBLIC,ai_hr_app,ai_hr_notification_worker;

CREATE FUNCTION notification_worker_private.assert_process_profile() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE a notification_worker_private.authority;
BEGIN
 SELECT * INTO a FROM notification_worker_private.authority WHERE singleton;
 IF a.api_version IS DISTINCT FROM 3 OR a.owner_oid IS DISTINCT FROM current_user::regrole::oid
 OR a.owner_oid IS DISTINCT FROM(SELECT relowner FROM pg_class WHERE oid='public.job_run'::regclass)
 OR (SELECT count(*) FROM notification_worker_private.process_contract WHERE kind='function')<>33
 OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN('notification_worker','notification_worker_private'))<>33
 -- Seal the complete owned inventory, including PostgreSQL RI/FK triggers.
 OR (SELECT count(*) FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid WHERE (r.relnamespace='notification_worker_private'::regnamespace OR t.tgconstraint IN(SELECT c.oid FROM pg_constraint c JOIN pg_class source ON source.oid=c.conrelid WHERE c.contype='f' AND source.relnamespace='notification_worker_private'::regnamespace)))
  IS DISTINCT FROM (SELECT count(*) FROM notification_worker_private.process_contract WHERE kind='trigger')
 OR (SELECT count(*) FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid WHERE r.relnamespace='notification_worker_private'::regnamespace AND NOT t.tgisinternal)<>3
 OR NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_constraint c ON c.oid=t.tgconstraint WHERE t.tgisinternal AND c.contype='f' AND t.tgrelid IN(SELECT oid FROM pg_class WHERE relnamespace='notification_worker_private'::regnamespace))
 OR EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_constraint c ON c.oid=t.tgconstraint JOIN pg_class source ON source.oid=c.conrelid WHERE source.relnamespace='notification_worker_private'::regnamespace AND c.contype='f' AND (NOT t.tgisinternal OR t.tgenabled<>'O'))
 OR EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid WHERE (r.relnamespace='notification_worker_private'::regnamespace OR t.tgconstraint IN(SELECT c.oid FROM pg_constraint c JOIN pg_class source ON source.oid=c.conrelid WHERE c.contype='f' AND source.relnamespace='notification_worker_private'::regnamespace))
  AND NOT EXISTS(SELECT 1 FROM notification_worker_private.process_contract c WHERE c.kind='trigger' AND c.object_oid=t.oid))
 OR EXISTS(SELECT 1 FROM (VALUES
  ('notification_batch_must_settle','notification_worker_private.batch'::regclass,'notification_worker_private.require_batch_settlement()'::regprocedure,21,true,true),
  ('notification_process_start_guard','notification_worker_private.run'::regclass,'notification_worker_private.process_start_guard()'::regprocedure,7,false,false),
  ('notification_process_commit_guard','notification_worker_private.batch'::regclass,'notification_worker_private.capture_committed_batch()'::regprocedure,11,false,false)
 ) expected(trigger_name,relation_oid,fn_oid,trigger_type,is_deferrable,initially_deferred) WHERE NOT EXISTS(SELECT 1 FROM pg_trigger t
  WHERE t.tgname=expected.trigger_name AND t.tgrelid=expected.relation_oid AND t.tgfoid=expected.fn_oid
   AND t.tgtype=expected.trigger_type AND t.tgdeferrable=expected.is_deferrable AND t.tginitdeferred=expected.initially_deferred
   AND NOT t.tgisinternal AND t.tgenabled='O' AND t.tgnargs=0 AND octet_length(t.tgargs)=0 AND t.tgqual IS NULL))
 OR (SELECT count(*) FROM notification_worker_private.process_contract WHERE kind='relation')<>3
 OR EXISTS(SELECT 1 FROM notification_worker_private.process_contract c LEFT JOIN pg_proc p ON p.oid=c.object_oid
  WHERE c.kind='function' AND (p.oid IS NULL OR to_jsonb(p) IS DISTINCT FROM c.details))
 OR EXISTS(SELECT 1 FROM notification_worker_private.process_contract c LEFT JOIN pg_trigger t ON t.oid=c.object_oid
  WHERE c.kind='trigger' AND (t.oid IS NULL OR to_jsonb(t) IS DISTINCT FROM c.details))
 OR EXISTS(SELECT 1 FROM notification_worker_private.process_contract c LEFT JOIN pg_class r ON r.oid=c.object_oid
  WHERE c.kind='relation' AND (r.oid IS NULL OR jsonb_build_object('owner',r.relowner,'namespace',r.relnamespace,'kind',r.relkind,'rls',r.relrowsecurity,'force',r.relforcerowsecurity,'acl',r.relacl,'columns',(SELECT jsonb_agg(to_jsonb(att) ORDER BY att.attnum) FROM pg_attribute att WHERE att.attrelid=r.oid AND att.attnum>0),'constraints',(SELECT jsonb_agg(to_jsonb(con) ORDER BY con.oid) FROM pg_constraint con WHERE con.conrelid=r.oid)) IS DISTINCT FROM c.details))
 OR EXISTS(SELECT 1 FROM pg_class r WHERE r.relnamespace IN('notification_worker'::regnamespace,'notification_worker_private'::regnamespace) AND NOT EXISTS(SELECT 1 FROM notification_worker_private.process_contract c WHERE c.kind='owned-class' AND c.object_oid=r.oid))
 OR EXISTS(SELECT 1 FROM notification_worker_private.process_contract c LEFT JOIN pg_class r ON r.oid=c.object_oid WHERE c.kind='owned-class' AND (r.oid IS NULL OR jsonb_build_object('name',r.relname,'owner',r.relowner,'namespace',r.relnamespace,'kind',r.relkind,'rls',r.relrowsecurity,'force',r.relforcerowsecurity,'acl',r.relacl) IS DISTINCT FROM c.details))
 OR EXISTS(SELECT 1 FROM notification_worker_private.helper_contract c LEFT JOIN pg_proc p ON p.oid=c.signature
  WHERE p.oid IS NULL OR p.proowner<>c.owner_oid OR md5(p.prosrc)<>c.body_md5
   OR p.proconfig IS DISTINCT FROM c.configuration OR p.prosecdef<>c.security_definer OR p.provolatile<>c.volatility OR p.prolang<>c.language_oid)
 THEN RAISE EXCEPTION 'Exact native process profile unavailable' USING ERRCODE='55000';END IF;
END $body$;
CREATE FUNCTION notification_worker_private.process_start_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
BEGIN
 PERFORM notification_worker_private.assert_process_profile();RETURN NEW;
END $body$;
CREATE TRIGGER notification_process_start_guard BEFORE INSERT ON notification_worker_private.run
 FOR EACH ROW EXECUTE FUNCTION notification_worker_private.process_start_guard();
CREATE FUNCTION notification_worker_private.capture_committed_batch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE b notification_worker_private.batch;r notification_worker_private.run;n integer;effects integer;
BEGIN
 PERFORM notification_worker_private.assert_process_profile();
 b:=notification_worker_private.admit_batch(OLD.batch_id);
 SELECT * INTO r FROM notification_worker_private.run WHERE run_id=b.run_id;
 SELECT count(*)::integer,coalesce(sum(created_count),0)::integer INTO n,effects FROM notification_worker_private.batch_event WHERE batch_id=b.batch_id;
 IF n<>b.event_count OR EXISTS(SELECT 1 FROM notification_worker_private.batch_event e WHERE e.batch_id=b.batch_id AND
  (e.disposition IS NULL OR NOT EXISTS(SELECT 1 FROM public.notification_event_processing p WHERE p.event_id=e.event_id
   AND p.event_sequence=e.event_sequence AND p.tenant_id=b.tenant_id AND p.consumer=b.consumer
   AND p.disposition=e.disposition AND p.processed_at IS NOT NULL)))
 OR r.committed_batches<>(SELECT count(*)+1 FROM notification_worker_private.committed_batch WHERE run_id=b.run_id)
 OR r.processed_events<>(SELECT coalesce(sum(processed),0)+n FROM notification_worker_private.committed_batch WHERE run_id=b.run_id)
 OR r.created_notifications<>(SELECT coalesce(sum(created),0)+effects FROM notification_worker_private.committed_batch WHERE run_id=b.run_id)
 THEN RAISE EXCEPTION 'Exact committed notification receipts required' USING ERRCODE='55000';END IF;
 INSERT INTO notification_worker_private.committed_batch(batch_id,run_id,tenant_id,consumer,processed,created)
 VALUES(b.batch_id,b.run_id,b.tenant_id,b.consumer,n,effects);
 INSERT INTO notification_worker_private.committed_event(batch_id,event_id,event_sequence,disposition,created)
 SELECT batch_id,event_id,event_sequence,disposition,created_count FROM notification_worker_private.batch_event WHERE batch_id=b.batch_id;
 RETURN OLD;
END $body$;
CREATE TRIGGER notification_process_commit_guard BEFORE DELETE ON notification_worker_private.batch
 FOR EACH ROW EXECUTE FUNCTION notification_worker_private.capture_committed_batch();

-- Only the actual installation/fixture owner can reconcile an abandoned run.
-- No worker-facing repair capability, arbitrary job key or supplied counters.
CREATE FUNCTION notification_worker_private.recover_abandoned_run(p_run uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE a notification_worker_private.authority;r notification_worker_private.run;
 k bigint:=hashtextextended('notification-worker:singleton',0);n integer;
BEGIN
 PERFORM notification_worker_private.assert_process_profile();
 SELECT * INTO a FROM notification_worker_private.authority WHERE singleton FOR UPDATE;
 IF session_user::regrole::oid IS DISTINCT FROM a.owner_oid OR current_user::regrole::oid IS DISTINCT FROM a.owner_oid
 OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off'
 OR a.active_run IS DISTINCT FROM p_run OR a.login_oid IS DISTINCT FROM(SELECT oid FROM pg_roles WHERE rolname='ai_hr_notification_worker')
 THEN RAISE EXCEPTION 'Exact owner abandonment authority required' USING ERRCODE='42501';END IF;
 IF NOT pg_try_advisory_xact_lock(k) THEN RAISE EXCEPTION 'Notification worker still owns its session' USING ERRCODE='55000';END IF;
 SELECT * INTO r FROM notification_worker_private.run WHERE run_id=p_run FOR UPDATE;
 IF NOT FOUND OR r.state<>'running' OR r.login_oid IS DISTINCT FROM a.login_oid
 OR EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=r.backend_pid)
 OR EXISTS(SELECT 1 FROM notification_worker_private.batch WHERE run_id=p_run)
 OR NOT EXISTS(SELECT 1 FROM public.job_run WHERE id=p_run AND job_key='notifications.project' AND outcome='running')
 OR r.committed_batches<>(SELECT count(*) FROM notification_worker_private.committed_batch WHERE run_id=p_run)
 OR r.processed_events<>(SELECT coalesce(sum(processed),0) FROM notification_worker_private.committed_batch WHERE run_id=p_run)
 OR r.created_notifications<>(SELECT coalesce(sum(created),0) FROM notification_worker_private.committed_batch WHERE run_id=p_run)
 OR EXISTS(SELECT 1 FROM notification_worker_private.committed_batch c WHERE c.run_id=p_run AND
  (c.processed<>(SELECT count(*) FROM notification_worker_private.committed_event e WHERE e.batch_id=c.batch_id)
   OR c.created<>(SELECT coalesce(sum(e.created),0) FROM notification_worker_private.committed_event e WHERE e.batch_id=c.batch_id)))
 OR EXISTS(SELECT 1 FROM notification_worker_private.committed_batch c JOIN notification_worker_private.committed_event e ON e.batch_id=c.batch_id
  WHERE c.run_id=p_run AND NOT EXISTS(SELECT 1 FROM public.notification_event_processing p JOIN public.domain_event d
   ON d.id=p.event_id AND d.tenant_id=p.tenant_id AND d.sequence=p.event_sequence
   WHERE p.event_id=e.event_id AND p.event_sequence=e.event_sequence AND p.tenant_id=c.tenant_id AND p.consumer=c.consumer
    AND p.disposition=e.disposition AND p.processed_at IS NOT NULL))
 THEN RAISE EXCEPTION 'Abandoned notification run cannot be reconciled' USING ERRCODE='55000';END IF;
 SELECT count(*)::integer INTO n FROM notification_worker_private.run_scope WHERE run_id=p_run AND state NOT IN('completed','skipped');
 UPDATE public.job_run SET outcome='failed',duration_ms=least(2147483647,greatest(0,extract(epoch FROM(clock_timestamp()-r.started_at))*1000))::integer,
 tenants_processed=(SELECT count(*) FROM notification_worker_private.run_scope WHERE run_id=p_run AND state='completed'),
 tenants_failed=n,result=jsonb_build_object('batches',r.committed_batches,'processed',r.processed_events,'created',r.created_notifications),error='abandoned'
 WHERE id=p_run AND job_key='notifications.project' AND outcome='running';
 IF NOT FOUND THEN RAISE EXCEPTION 'Exact abandoned job CAS refused' USING ERRCODE='55000';END IF;
 UPDATE notification_worker_private.run SET state='failed' WHERE run_id=p_run AND state='running' AND login_oid=r.login_oid
 AND backend_pid=r.backend_pid AND backend_started_at=r.backend_started_at;
 IF NOT FOUND THEN RAISE EXCEPTION 'Exact abandoned run CAS refused' USING ERRCODE='55000';END IF;
 UPDATE notification_worker_private.authority SET active_run=NULL WHERE singleton AND active_run=p_run AND login_oid=r.login_oid AND owner_oid=a.owner_oid;
 IF NOT FOUND THEN RAISE EXCEPTION 'Exact abandoned authority CAS refused' USING ERRCODE='55000';END IF;
END $body$;
REVOKE ALL ON FUNCTION notification_worker_private.assert_process_profile(),notification_worker_private.process_start_guard(),
 notification_worker_private.capture_committed_batch(),notification_worker_private.recover_abandoned_run(uuid) FROM PUBLIC,ai_hr_app,ai_hr_notification_worker;
-- Capture full native metadata after the reviewed additive profile is complete.
INSERT INTO notification_worker_private.process_contract
 SELECT 'function',p.oid,to_jsonb(p) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN('notification_worker','notification_worker_private');
INSERT INTO notification_worker_private.process_contract
 SELECT 'trigger',t.oid,to_jsonb(t) FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid WHERE (r.relnamespace='notification_worker_private'::regnamespace OR t.tgconstraint IN(SELECT c.oid FROM pg_constraint c JOIN pg_class source ON source.oid=c.conrelid WHERE c.contype='f' AND source.relnamespace='notification_worker_private'::regnamespace));
INSERT INTO notification_worker_private.process_contract
 SELECT 'relation',r.oid,jsonb_build_object('owner',r.relowner,'namespace',r.relnamespace,'kind',r.relkind,'rls',r.relrowsecurity,'force',r.relforcerowsecurity,'acl',r.relacl,'columns',(SELECT jsonb_agg(to_jsonb(att) ORDER BY att.attnum) FROM pg_attribute att WHERE att.attrelid=r.oid AND att.attnum>0),'constraints',(SELECT jsonb_agg(to_jsonb(con) ORDER BY con.oid) FROM pg_constraint con WHERE con.conrelid=r.oid))
 FROM pg_class r WHERE r.oid IN('notification_worker_private.committed_batch'::regclass,'notification_worker_private.committed_event'::regclass,'notification_worker_private.process_contract'::regclass);

INSERT INTO notification_worker_private.process_contract
 SELECT 'owned-class',r.oid,jsonb_build_object('name',r.relname,'owner',r.relowner,'namespace',r.relnamespace,'kind',r.relkind,'rls',r.relrowsecurity,'force',r.relforcerowsecurity,'acl',r.relacl)
 FROM pg_class r WHERE r.relnamespace IN('notification_worker'::regnamespace,'notification_worker_private'::regnamespace);
