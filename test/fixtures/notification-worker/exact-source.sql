-- UNNUMBERED/UNINSTALLED exact source contract revision1; publicAPI version3 unchanged.
-- Apply this entire file atomically after frozen7a, BEFORE authority/run activation.
-- No admitted call is removed, cached, moved or authorized by caller context.
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
DECLARE native_owner oid:=(SELECT relowner FROM pg_class WHERE oid='public.job_run'::regclass);p pg_proc;h pg_class;
BEGIN
 IF current_user::regrole::oid IS DISTINCT FROM native_owner
 OR native_owner IS DISTINCT FROM(SELECT relowner FROM pg_class WHERE oid='public.domain_event'::regclass)
 OR EXISTS(SELECT 1 FROM notification_worker_private.authority)OR EXISTS(SELECT 1 FROM notification_worker_private.run)
 OR(SELECT count(*)FROM notification_worker_private.process_contract WHERE kind='function')<>33
 OR(SELECT count(*)FROM pg_proc WHERE pronamespace IN('notification_worker'::regnamespace,'notification_worker_private'::regnamespace))<>33
 OR EXISTS(SELECT 1 FROM notification_worker_private.process_contract c LEFT JOIN pg_proc actual ON actual.oid=c.object_oid
  WHERE c.kind='function'AND(actual.oid IS NULL OR to_jsonb(actual)IS DISTINCT FROM c.details))
 OR(SELECT count(*)FROM notification_worker_private.process_contract WHERE kind='relation')<>3
 THEN RAISE EXCEPTION 'Exact inactive source-contract predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker_private.admit_login()'::regprocedure;
 IF p.proowner IS DISTINCT FROM native_owner OR p.prosrc IS DISTINCT FROM $prior_login$
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
END $prior_login$
 OR md5(p.prosrc)IS DISTINCT FROM '49533d66467b0468d6cb4c1fb0697fe5'
 OR NOT EXISTS(SELECT 1 FROM notification_worker_private.process_contract c WHERE c.kind='function'AND c.object_oid=p.oid AND c.details=to_jsonb(p))
 THEN RAISE EXCEPTION 'Exact reviewed login predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker_private.assert_process_profile()'::regprocedure;
 IF p.proowner IS DISTINCT FROM native_owner OR p.prosrc IS DISTINCT FROM $prior_profile$
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
END $prior_profile$
 OR md5(p.prosrc)IS DISTINCT FROM '52f4cceff05b3a26e36f1334241d63d9'
 OR NOT EXISTS(SELECT 1 FROM notification_worker_private.process_contract c WHERE c.kind='function'AND c.object_oid=p.oid AND c.details=to_jsonb(p))
 THEN RAISE EXCEPTION 'Exact reviewed profile predecessor required' USING ERRCODE='55000';END IF;
 SELECT * INTO h FROM pg_class WHERE oid='notification_worker_private.helper_contract'::regclass;
 IF h.relowner<>native_owner OR h.relkind<>'r'OR NOT h.relrowsecurity OR h.relforcerowsecurity
 OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=h.oid)OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=h.oid)
 OR EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=h.oid)OR EXISTS(SELECT 1 FROM pg_attrdef WHERE adrelid=h.oid)
 OR EXISTS(SELECT 1 FROM aclexplode(coalesce(h.relacl,acldefault('r',h.relowner)))g WHERE g.grantee<>native_owner OR g.grantor<>native_owner OR g.is_grantable)
 OR(SELECT count(*)FROM pg_attribute WHERE attrelid=h.oid AND attnum>0)<>7
 OR EXISTS(SELECT 1 FROM(VALUES
  (1,'signature','regprocedure'::regtype,-1,true),(2,'owner_oid','oid'::regtype,-1,true),
  (3,'body_md5','text'::regtype,-1,true),(4,'configuration','text[]'::regtype,-1,false),
  (5,'security_definer','boolean'::regtype,-1,true),(6,'volatility','bpchar'::regtype,5,true),(7,'language_oid','oid'::regtype,-1,true)
 )e(n,name,type_oid,modifier,required)LEFT JOIN pg_attribute a ON a.attrelid=h.oid AND a.attnum=e.n
 WHERE a.attnum IS NULL OR a.attname<>e.name OR a.atttypid<>e.type_oid OR a.atttypmod<>e.modifier OR a.attnotnull<>e.required
  OR a.attisdropped OR a.attidentity<>''OR a.attgenerated<>'')
 OR(SELECT count(*)FROM pg_constraint WHERE conrelid=h.oid)<>1
 OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=h.oid AND conname='helper_contract_pkey'AND contype='p'
  AND conkey=ARRAY[1]::smallint[]AND convalidated AND NOT condeferrable AND NOT condeferred)
 OR(SELECT count(*)FROM pg_index WHERE indrelid=h.oid)<>1
 OR NOT EXISTS(SELECT 1 FROM pg_index WHERE indrelid=h.oid AND indisprimary AND indisunique AND indisvalid AND indisready AND indislive AND indnkeyatts=1)
 OR(SELECT count(*)FROM notification_worker_private.helper_contract)<>2300
 OR(SELECT count(*)FROM pg_proc WHERE pronamespace='app'::regnamespace)<>2300
 OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='app'::regnamespace AND NOT EXISTS(SELECT 1 FROM notification_worker_private.helper_contract c WHERE c.signature=p.oid))
 OR EXISTS(SELECT 1 FROM notification_worker_private.helper_contract c LEFT JOIN pg_proc p ON p.oid=c.signature
  WHERE p.oid IS NULL OR p.pronamespace<>'app'::regnamespace OR p.proowner<>c.owner_oid OR md5(p.prosrc)<>c.body_md5
   OR p.proconfig IS DISTINCT FROM c.configuration OR p.prosecdef<>c.security_definer OR p.provolatile<>c.volatility OR p.prolang<>c.language_oid)
 THEN RAISE EXCEPTION 'Exact complete native helper contract required before capture' USING ERRCODE='55000';END IF;
END $before$;

ALTER TABLE notification_worker_private.helper_contract ADD COLUMN body_source text;
DO $capture$
DECLARE n integer;
BEGIN
 -- Source and old provenance/metadata are checked in THIS SAME native statement.
 -- Missing or concurrently changed predecessors cannot be silently recaptured.
 UPDATE notification_worker_private.helper_contract c SET body_source=p.prosrc FROM pg_proc p
 WHERE p.oid=c.signature AND p.pronamespace='app'::regnamespace AND p.proowner=c.owner_oid
  AND md5(p.prosrc)=c.body_md5 AND p.proconfig IS NOT DISTINCT FROM c.configuration
  AND p.prosecdef=c.security_definer AND p.provolatile=c.volatility AND p.prolang=c.language_oid;
 GET DIAGNOSTICS n=ROW_COUNT;
 IF n<>2300 OR EXISTS(SELECT 1 FROM notification_worker_private.helper_contract WHERE body_source IS NULL)
 THEN RAISE EXCEPTION 'Complete canonical source capture refused' USING ERRCODE='55000';END IF;
END $capture$;
ALTER TABLE notification_worker_private.helper_contract ALTER COLUMN body_source SET NOT NULL;
ALTER TABLE notification_worker_private.helper_contract ADD CONSTRAINT helper_contract_canonical_body_check
 CHECK((md5(body_source)COLLATE "C")=(body_md5 COLLATE "C"));

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
  WHERE p.oid IS NULL OR p.proowner<>c.owner_oid OR ((p.prosrc COLLATE "C") IS DISTINCT FROM (c.body_source COLLATE "C"))
   OR p.proconfig IS DISTINCT FROM c.configuration OR p.prosecdef<>c.security_definer OR p.provolatile<>c.volatility OR p.prolang<>c.language_oid)
 THEN RAISE EXCEPTION 'Notification worker authority unavailable' USING ERRCODE='42501';END IF;
 RETURN login;
END $body$;
CREATE OR REPLACE FUNCTION notification_worker_private.assert_process_profile() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pg_temp AS $body$
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
 OR (SELECT count(*) FROM notification_worker_private.process_contract WHERE kind='relation')<>4
 OR EXISTS(SELECT 1 FROM notification_worker_private.process_contract c LEFT JOIN pg_proc p ON p.oid=c.object_oid
  WHERE c.kind='function' AND (p.oid IS NULL OR to_jsonb(p) IS DISTINCT FROM c.details))
 OR EXISTS(SELECT 1 FROM notification_worker_private.process_contract c LEFT JOIN pg_trigger t ON t.oid=c.object_oid
  WHERE c.kind='trigger' AND (t.oid IS NULL OR to_jsonb(t) IS DISTINCT FROM c.details))
 OR EXISTS(SELECT 1 FROM notification_worker_private.process_contract c LEFT JOIN pg_class r ON r.oid=c.object_oid
  WHERE c.kind='relation' AND (r.oid IS NULL OR jsonb_build_object('owner',r.relowner,'namespace',r.relnamespace,'kind',r.relkind,'rls',r.relrowsecurity,'force',r.relforcerowsecurity,'acl',r.relacl,'columns',(SELECT jsonb_agg(to_jsonb(att) ORDER BY att.attnum) FROM pg_attribute att WHERE att.attrelid=r.oid AND att.attnum>0),'constraints',(SELECT jsonb_agg(to_jsonb(con) ORDER BY con.oid) FROM pg_constraint con WHERE con.conrelid=r.oid)) IS DISTINCT FROM c.details))
 OR EXISTS(SELECT 1 FROM pg_class r WHERE r.relnamespace IN('notification_worker'::regnamespace,'notification_worker_private'::regnamespace) AND NOT EXISTS(SELECT 1 FROM notification_worker_private.process_contract c WHERE c.kind='owned-class' AND c.object_oid=r.oid))
 OR EXISTS(SELECT 1 FROM notification_worker_private.process_contract c LEFT JOIN pg_class r ON r.oid=c.object_oid WHERE c.kind='owned-class' AND (r.oid IS NULL OR jsonb_build_object('name',r.relname,'owner',r.relowner,'namespace',r.relnamespace,'kind',r.relkind,'rls',r.relrowsecurity,'force',r.relforcerowsecurity,'acl',r.relacl) IS DISTINCT FROM c.details))
 OR EXISTS(SELECT 1 FROM notification_worker_private.helper_contract c LEFT JOIN pg_proc p ON p.oid=c.signature
  WHERE p.oid IS NULL OR p.proowner<>c.owner_oid OR ((p.prosrc COLLATE "C") IS DISTINCT FROM (c.body_source COLLATE "C"))
   OR p.proconfig IS DISTINCT FROM c.configuration OR p.prosecdef<>c.security_definer OR p.provolatile<>c.volatility OR p.prolang<>c.language_oid)
 THEN RAISE EXCEPTION 'Exact native process profile unavailable' USING ERRCODE='55000';END IF;
END $body$;
DO $after$
DECLARE p pg_proc;n integer;
BEGIN
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker_private.admit_login()'::regprocedure;
 IF md5(p.prosrc)IS DISTINCT FROM 'c3a8691c5ff07123a8f63f009d8567ad'OR NOT EXISTS(SELECT 1 FROM notification_worker_private.process_contract c WHERE c.kind='function'AND c.object_oid=p.oid AND(c.details-'prosrc')=(to_jsonb(p)-'prosrc'))
 THEN RAISE EXCEPTION 'Exact metadata-preserving source guard replacement required' USING ERRCODE='55000';END IF;
 UPDATE notification_worker_private.process_contract SET details=to_jsonb(p)WHERE kind='function'AND object_oid=p.oid;
 GET DIAGNOSTICS n=ROW_COUNT;IF n<>1 THEN RAISE EXCEPTION 'Exact source guard binding required' USING ERRCODE='55000';END IF;
 SELECT * INTO p FROM pg_proc WHERE oid='notification_worker_private.assert_process_profile()'::regprocedure;
 IF md5(p.prosrc)IS DISTINCT FROM 'f77a9b37429e8e2d7d4f350ef91487e5'OR NOT EXISTS(SELECT 1 FROM notification_worker_private.process_contract c WHERE c.kind='function'AND c.object_oid=p.oid AND(c.details-'prosrc')=(to_jsonb(p)-'prosrc'))
 THEN RAISE EXCEPTION 'Exact metadata-preserving source guard replacement required' USING ERRCODE='55000';END IF;
 UPDATE notification_worker_private.process_contract SET details=to_jsonb(p)WHERE kind='function'AND object_oid=p.oid;
 GET DIAGNOSTICS n=ROW_COUNT;IF n<>1 THEN RAISE EXCEPTION 'Exact source guard binding required' USING ERRCODE='55000';END IF;
 -- Fourth structural relation: seal source-column/NOTNULL/CHECK/index/ACL facts.
 INSERT INTO notification_worker_private.process_contract(kind,object_oid,details)
 SELECT 'relation',r.oid,jsonb_build_object('owner',r.relowner,'namespace',r.relnamespace,'kind',r.relkind,'rls',r.relrowsecurity,'force',r.relforcerowsecurity,'acl',r.relacl,
  'columns',(SELECT jsonb_agg(to_jsonb(att)ORDER BY att.attnum)FROM pg_attribute att WHERE att.attrelid=r.oid AND att.attnum>0),
  'constraints',(SELECT jsonb_agg(to_jsonb(con)ORDER BY con.oid)FROM pg_constraint con WHERE con.conrelid=r.oid))
 FROM pg_class r WHERE r.oid='notification_worker_private.helper_contract'::regclass;
 GET DIAGNOSTICS n=ROW_COUNT;IF n<>1 THEN RAISE EXCEPTION 'Exact source relation binding required' USING ERRCODE='55000';END IF;
END $after$;
