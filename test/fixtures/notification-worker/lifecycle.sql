-- UNNUMBERED ISOLATED-CI PROTOTYPE ONLY. No worker projection or installer.
-- Execute atomically as the existing public relation owner in a disposable worker DB.
-- Independent exact harness binding, deliberately before owner/schema checks.
-- The sole source is test/db-names.ts: optional normalized namespace precedes poolId.
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
DO $gate$ BEGIN
 IF current_database() IS DISTINCT FROM current_setting('aihr.notification_fixture.database',true)
 OR current_user::regrole::oid IS DISTINCT FROM (SELECT relowner FROM pg_class WHERE oid='public.job_run'::regclass)
 OR current_user::regrole::oid IS DISTINCT FROM (SELECT relowner FROM pg_class WHERE oid='public.domain_event'::regclass)
 OR EXISTS(SELECT 1 FROM pg_class WHERE oid IN('public.tenant'::regclass,'public.tenant_module'::regclass,'public.company'::regclass,'public.notification_event_processing'::regclass)
  AND (relowner<>current_user::regrole::oid OR relforcerowsecurity))
 OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname IN('notification_worker','notification_worker_private')) THEN
  RAISE EXCEPTION 'Isolated clean owner fixture required' USING ERRCODE='55000';
 END IF;
END $gate$;
CREATE SCHEMA notification_worker;
CREATE SCHEMA notification_worker_private;
REVOKE ALL ON SCHEMA notification_worker,notification_worker_private FROM PUBLIC,ai_hr_app;
CREATE TABLE notification_worker_private.authority(
 singleton boolean PRIMARY KEY CHECK(singleton),enabled boolean NOT NULL DEFAULT false,
 login_oid oid NOT NULL,owner_oid oid NOT NULL,api_version integer NOT NULL CHECK(api_version=1),
 max_batch_events integer NOT NULL CHECK(max_batch_events BETWEEN 1 AND 5000),
 max_run_batches integer NOT NULL CHECK(max_run_batches BETWEEN 1 AND 10000),
 max_run_seconds integer NOT NULL CHECK(max_run_seconds BETWEEN 1 AND 3600),
 max_tenants integer NOT NULL CHECK(max_tenants BETWEEN 1 AND 10000),active_run uuid
);
CREATE TABLE notification_worker_private.run(
 run_id uuid PRIMARY KEY REFERENCES public.job_run(id),login_oid oid NOT NULL,backend_pid integer NOT NULL,
 backend_started_at timestamptz NOT NULL,started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 state text NOT NULL DEFAULT 'running' CHECK(state IN('running','completed','failed')),
 committed_batches integer NOT NULL DEFAULT 0 CHECK(committed_batches>=0)
);
CREATE TABLE notification_worker_private.run_scope(
 run_id uuid REFERENCES notification_worker_private.run(run_id),tenant_id uuid REFERENCES public.tenant(id),
 standing text NOT NULL,consumer text CHECK(consumer IN('notifications','assessment-reminders')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','completed','skipped','capped','blocked','failed')),
 backlog_pending bigint,backlog_oldest_seconds double precision,observed_at timestamptz,
 PRIMARY KEY(run_id,tenant_id)
);
CREATE TABLE notification_worker_private.batch(
 batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),run_id uuid NOT NULL,tenant_id uuid NOT NULL,
 consumer text NOT NULL,login_oid oid NOT NULL,backend_pid integer NOT NULL,backend_started_at timestamptz NOT NULL,
 admitted_xid xid8 NOT NULL,event_count integer NOT NULL CHECK(event_count BETWEEN 0 AND 5000),
 FOREIGN KEY(run_id,tenant_id) REFERENCES notification_worker_private.run_scope(run_id,tenant_id),
 UNIQUE(login_oid,backend_pid,backend_started_at,admitted_xid)
);
CREATE TABLE notification_worker_private.batch_event(
 batch_id uuid REFERENCES notification_worker_private.batch(batch_id) ON DELETE CASCADE,
 event_id uuid REFERENCES public.domain_event(id),event_sequence bigint NOT NULL,PRIMARY KEY(batch_id,event_id)
);
CREATE TABLE notification_worker_private.allowed_api(signature regprocedure PRIMARY KEY);
ALTER TABLE notification_worker_private.authority ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_worker_private.run ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_worker_private.run_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_worker_private.batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_worker_private.batch_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_worker_private.allowed_api ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA notification_worker_private FROM PUBLIC,ai_hr_app;

-- A caller-controlled COMMIT cannot preserve a half-admitted source reference.
-- Successful settlement deletes the batch; rollback removes admission/effects.
CREATE FUNCTION notification_worker_private.require_batch_settlement() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
BEGIN
 IF EXISTS(SELECT 1 FROM notification_worker_private.batch WHERE batch_id=NEW.batch_id) THEN
  RAISE EXCEPTION 'Notification batch must settle before commit' USING ERRCODE='55000';END IF;
 RETURN NULL;
END $body$;
CREATE CONSTRAINT TRIGGER notification_batch_must_settle AFTER INSERT OR UPDATE ON notification_worker_private.batch
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION notification_worker_private.require_batch_settlement();

CREATE FUNCTION notification_worker_private.admit_login() RETURNS oid LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pg_temp AS $body$
DECLARE a notification_worker_private.authority; r pg_roles; login oid;
BEGIN
 SELECT * INTO a FROM notification_worker_private.authority WHERE singleton;
 SELECT * INTO r FROM pg_roles WHERE rolname=session_user;login:=r.oid;
 IF NOT FOUND OR a.enabled IS DISTINCT FROM true OR a.api_version IS DISTINCT FROM 1
 OR login IS DISTINCT FROM a.login_oid OR current_user::regrole::oid IS DISTINCT FROM a.owner_oid
 OR a.owner_oid IS DISTINCT FROM (SELECT relowner FROM pg_class WHERE oid='public.job_run'::regclass)
 OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE (n.nspname='notification_worker_private' OR c.oid IN('public.tenant'::regclass,'public.tenant_module'::regclass,'public.company'::regclass,'public.domain_event'::regclass,'public.notification_event_processing'::regclass,'public.job_run'::regclass))
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
 OR (SELECT count(*) FROM notification_worker_private.allowed_api)<>8
 OR EXISTS(SELECT 1 FROM notification_worker_private.allowed_api x LEFT JOIN pg_proc p ON p.oid=x.signature
  WHERE p.oid IS NULL OR p.proowner<>a.owner_oid OR NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[])
 THEN RAISE EXCEPTION 'Notification worker authority unavailable' USING ERRCODE='42501';END IF;
 RETURN login;
END $body$;
CREATE FUNCTION notification_worker_private.consumer(p_tenant uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path=pg_catalog,pg_temp AS $body$
 SELECT CASE WHEN t.status IN('active','trial') THEN CASE
  WHEN EXISTS(SELECT 1 FROM public.tenant_module m WHERE m.tenant_id=t.id AND m.module_code='notifications'
   AND m.company_id IS NULL AND m.status IN('active','trial') AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())) THEN 'notifications'
  WHEN EXISTS(SELECT 1 FROM public.tenant_module m JOIN public.company c ON c.id=m.company_id AND c.tenant_id=t.id
   WHERE m.tenant_id=t.id AND m.module_code='notifications' AND m.status IN('active','trial')
    AND (m.expires_at IS NULL OR m.expires_at>statement_timestamp())) THEN 'assessment-reminders' END END
 FROM public.tenant t WHERE t.id=p_tenant AND t.id<>'00000000-0000-0000-0000-000000000000'::uuid
$body$;
CREATE FUNCTION notification_worker_private.admit_run(p_run uuid,p_time boolean DEFAULT true) RETURNS notification_worker_private.run
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
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
END $body$;
CREATE FUNCTION notification_worker_private.admit_batch(p_batch uuid) RETURNS notification_worker_private.batch
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
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
END $body$;
CREATE FUNCTION notification_worker.open_run() RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
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
END $body$;
CREATE FUNCTION notification_worker.scope_page(p_run uuid,p_after uuid,p_count integer)
 RETURNS TABLE(tenant_id uuid,standing text,consumer text,entitlement_facts jsonb)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
BEGIN
 PERFORM notification_worker_private.admit_run(p_run);
 IF p_count IS NULL OR p_count NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid scope page' USING ERRCODE='22023';END IF;
 RETURN QUERY SELECT s.tenant_id,s.standing,s.consumer,jsonb_build_object('tenantStatus',s.standing,'modules',
  coalesce((SELECT jsonb_agg(jsonb_build_object('moduleCode',m.module_code,'companyId',m.company_id,'status',m.status,'expiresAt',m.expires_at) ORDER BY m.id)
   FROM public.tenant_module m WHERE m.tenant_id=s.tenant_id AND m.module_code='notifications'),'[]'::jsonb))
 FROM notification_worker_private.run_scope s WHERE s.run_id=p_run AND (p_after IS NULL OR s.tenant_id>p_after) ORDER BY s.tenant_id LIMIT p_count;
END $body$;
CREATE FUNCTION notification_worker.open_batch(p_run uuid,p_tenant uuid,p_count integer) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
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
END $body$;
CREATE FUNCTION notification_worker.events(p_batch uuid)
 RETURNS TABLE(event_id uuid,aggregate_type text,aggregate_id uuid,event_type text,subject_employment_id uuid,payload jsonb,event_sequence bigint)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE b notification_worker_private.batch;
BEGIN
 b:=notification_worker_private.admit_batch(p_batch);
 RETURN QUERY SELECT e.id,e.aggregate_type,e.aggregate_id,e.event_type,e.subject_employment_id,e.payload,e.sequence
 FROM notification_worker_private.batch_event x JOIN public.domain_event e ON e.id=x.event_id AND e.tenant_id=b.tenant_id AND e.sequence=x.event_sequence
 JOIN public.notification_event_processing p ON p.event_id=e.id AND p.tenant_id=e.tenant_id AND p.consumer=b.consumer AND p.disposition IS NULL
 WHERE x.batch_id=p_batch ORDER BY x.event_sequence;
END $body$;
-- This stage can finish EMPTY batches only. Pending events are never fabricated
-- as processed/ignored while canonical projection/preparation is still missing.
CREATE FUNCTION notification_worker.finish_batch(p_batch uuid) RETURNS TABLE(processed integer,created integer)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE b notification_worker_private.batch;
BEGIN
 b:=notification_worker_private.admit_batch(p_batch);
 IF b.event_count<>0 OR EXISTS(SELECT 1 FROM notification_worker_private.batch_event WHERE batch_id=p_batch) THEN
  RAISE EXCEPTION 'Canonical notification projection is not implemented' USING ERRCODE='55000';END IF;
 DELETE FROM notification_worker_private.batch WHERE batch_id=p_batch;
 UPDATE notification_worker_private.run SET committed_batches=committed_batches+1 WHERE run_id=b.run_id AND state='running';
 RETURN QUERY SELECT 0,0;
END $body$;
CREATE FUNCTION notification_worker.settle_scope(p_run uuid,p_tenant uuid,p_reason text)
 RETURNS TABLE(pending bigint,oldest_seconds double precision,observed_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
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
END $body$;
CREATE FUNCTION notification_worker.finish_run(p_run uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
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
 tenants_processed=n,tenants_failed=0,result=jsonb_build_object('batches',r.committed_batches,'processed',0,'created',0)
 WHERE id=p_run AND job_key='notifications.project' AND outcome='running';
 IF NOT FOUND THEN RAISE EXCEPTION 'Notification terminal CAS refused' USING ERRCODE='55000';END IF;
 UPDATE notification_worker_private.run SET state='completed' WHERE run_id=p_run;
 UPDATE notification_worker_private.authority SET active_run=NULL WHERE singleton AND active_run=p_run;
 PERFORM pg_advisory_unlock(hashtextextended('notification-worker:singleton',0));
END $body$;
CREATE FUNCTION notification_worker.fail_run(p_run uuid,p_reason text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE r notification_worker_private.run;n integer;
BEGIN
 r:=notification_worker_private.admit_run(p_run,false);
 IF p_reason IS NULL OR p_reason NOT IN('projection-unimplemented','scope-changed','budget-exhausted','database-refusal')
 OR EXISTS(SELECT 1 FROM notification_worker_private.batch WHERE run_id=p_run) THEN RAISE EXCEPTION 'Invalid notification failure' USING ERRCODE='22023';END IF;
 SELECT count(*)::int INTO n FROM notification_worker_private.run_scope WHERE run_id=p_run AND state NOT IN('completed','skipped');
 UPDATE public.job_run SET outcome='failed',duration_ms=least(2147483647,greatest(0,extract(epoch FROM(clock_timestamp()-r.started_at))*1000))::integer,
 tenants_processed=(SELECT count(*) FROM notification_worker_private.run_scope WHERE run_id=p_run AND state='completed'),
 tenants_failed=n,result=jsonb_build_object('batches',r.committed_batches,'processed',0,'created',0),error=p_reason
 WHERE id=p_run AND job_key='notifications.project' AND outcome='running';
 IF NOT FOUND THEN RAISE EXCEPTION 'Notification terminal CAS refused' USING ERRCODE='55000';END IF;
 UPDATE notification_worker_private.run SET state='failed' WHERE run_id=p_run;
 UPDATE notification_worker_private.authority SET active_run=NULL WHERE singleton AND active_run=p_run;
 PERFORM pg_advisory_unlock(hashtextextended('notification-worker:singleton',0));
END $body$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA notification_worker,notification_worker_private FROM PUBLIC,ai_hr_app;
INSERT INTO notification_worker_private.allowed_api(signature) VALUES
 ('notification_worker.open_run()'::regprocedure),('notification_worker.scope_page(uuid,uuid,integer)'::regprocedure),
 ('notification_worker.open_batch(uuid,uuid,integer)'::regprocedure),('notification_worker.events(uuid)'::regprocedure),
 ('notification_worker.finish_batch(uuid)'::regprocedure),('notification_worker.settle_scope(uuid,uuid,text)'::regprocedure),
 ('notification_worker.finish_run(uuid)'::regprocedure),('notification_worker.fail_run(uuid,text)'::regprocedure);
GRANT USAGE ON SCHEMA notification_worker TO ai_hr_notification_worker;
GRANT EXECUTE ON FUNCTION notification_worker.open_run(),notification_worker.scope_page(uuid,uuid,integer),
 notification_worker.open_batch(uuid,uuid,integer),notification_worker.events(uuid),notification_worker.finish_batch(uuid),
 notification_worker.settle_scope(uuid,uuid,text),notification_worker.finish_run(uuid),notification_worker.fail_run(uuid,text)
 TO ai_hr_notification_worker;

DO $revoke_platform$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_platform') THEN
  REVOKE ALL ON SCHEMA notification_worker,notification_worker_private FROM ai_hr_platform;
  REVOKE ALL ON ALL TABLES IN SCHEMA notification_worker_private FROM ai_hr_platform;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA notification_worker,notification_worker_private FROM ai_hr_platform;
 END IF;
END $revoke_platform$;
