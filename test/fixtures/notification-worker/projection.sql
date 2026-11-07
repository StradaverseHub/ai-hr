-- UNNUMBERED ISOLATED-CI CHILD of lifecycle.sql. Not an installation/migration.
-- Apply atomically only after the exact stage1 fixture; never edit numbered SQL.
DO $guard$ BEGIN
 IF current_database() !~ '^ai_hr_test_w[0-9]+(_[a-z0-9_]+)?$'
 OR current_user::regrole::oid IS DISTINCT FROM (SELECT relowner FROM pg_class WHERE oid='public.notification'::regclass)
 OR EXISTS(SELECT 1 FROM notification_worker_private.run) THEN
 RAISE EXCEPTION 'Empty isolated native lifecycle fixture required' USING ERRCODE='55000';END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='notification_worker_private.admit_login()'::regprocedure) IS DISTINCT FROM '5a17c36ec64bc8fc1e574b81015b9518' THEN RAISE EXCEPTION 'Unexpected stage1 notification_worker_private.admit_login' USING ERRCODE='55000';END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='notification_worker.finish_batch(uuid)'::regprocedure) IS DISTINCT FROM 'dd04fada32d838d09a54c6b2b4739c7f' THEN RAISE EXCEPTION 'Unexpected stage1 notification_worker.finish_batch' USING ERRCODE='55000';END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='notification_worker.finish_run(uuid)'::regprocedure) IS DISTINCT FROM '789c63b2371795feb3c59dd104914e3e' THEN RAISE EXCEPTION 'Unexpected stage1 notification_worker.finish_run' USING ERRCODE='55000';END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='notification_worker.fail_run(uuid,text)'::regprocedure) IS DISTINCT FROM 'fdc6c2d66e8d8296ce807b1503603422' THEN RAISE EXCEPTION 'Unexpected stage1 notification_worker.fail_run' USING ERRCODE='55000';END IF;
END $guard$;
ALTER TABLE notification_worker_private.authority DROP CONSTRAINT authority_api_version_check;
ALTER TABLE notification_worker_private.authority ADD CHECK(api_version IN(1,2));
ALTER TABLE notification_worker_private.authority ADD COLUMN max_batch_projections integer NOT NULL DEFAULT 50000 CHECK(max_batch_projections BETWEEN 1 AND 100000);
ALTER TABLE notification_worker_private.run ADD COLUMN processed_events bigint NOT NULL DEFAULT 0 CHECK(processed_events>=0);
ALTER TABLE notification_worker_private.run ADD COLUMN created_notifications bigint NOT NULL DEFAULT 0 CHECK(created_notifications>=0);
ALTER TABLE notification_worker_private.batch_event ADD COLUMN disposition text CHECK(disposition IN('processed','ignored'));
ALTER TABLE notification_worker_private.batch_event ADD COLUMN created_count integer NOT NULL DEFAULT 0 CHECK(created_count>=0);
ALTER TABLE notification_worker_private.batch_event ADD COLUMN account_projected boolean NOT NULL DEFAULT false;
CREATE TABLE notification_worker_private.registry_contract(
 event_type text NOT NULL,kind text NOT NULL,category text,recipient_port text,implemented boolean NOT NULL,
 PRIMARY KEY(event_type,kind));
CREATE TABLE notification_worker_private.helper_contract(
 signature regprocedure PRIMARY KEY,owner_oid oid NOT NULL,body_md5 text NOT NULL,configuration text[],security_definer boolean NOT NULL,volatility char NOT NULL,language_oid oid NOT NULL);
ALTER TABLE notification_worker_private.registry_contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_worker_private.helper_contract ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON notification_worker_private.registry_contract,notification_worker_private.helper_contract FROM PUBLIC,ai_hr_app;
-- Freeze the existing native helper implementation used transitively by the fixed APIs.
-- No worker may update this baseline or approve helper/source drift.
INSERT INTO notification_worker_private.helper_contract
 SELECT p.oid,p.proowner,md5(p.prosrc),p.proconfig,p.prosecdef,p.provolatile,p.prolang
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app';
CREATE OR REPLACE FUNCTION notification_worker_private.admit_login() RETURNS oid LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pg_temp AS $body$
DECLARE a notification_worker_private.authority; r pg_roles; login oid;
BEGIN
 SELECT * INTO a FROM notification_worker_private.authority WHERE singleton;
 SELECT * INTO r FROM pg_roles WHERE rolname=session_user;login:=r.oid;
 IF NOT FOUND OR a.enabled IS DISTINCT FROM true OR a.api_version IS DISTINCT FROM 2
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
  WHERE c.relkind='S' AND n.nspname !~ '^pg_' AND has_sequence_privilege(login,c.oid,'USAGE,SELECT,UPDATE'))
 OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE p.prosecdef AND n.nspname !~ '^pg_' AND has_schema_privilege(login,n.oid,'USAGE') AND has_function_privilege(login,p.oid,'EXECUTE')
   AND NOT EXISTS(SELECT 1 FROM notification_worker_private.allowed_api x WHERE x.signature=p.oid))
 OR (SELECT count(*) FROM notification_worker_private.allowed_api)<>12
 OR EXISTS(SELECT 1 FROM notification_worker_private.allowed_api x LEFT JOIN pg_proc p ON p.oid=x.signature
  WHERE p.oid IS NULL OR p.proowner<>a.owner_oid OR NOT p.prosecdef OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[])
 OR NOT EXISTS(SELECT 1 FROM notification_worker_private.registry_contract)
 OR EXISTS(SELECT 1 FROM notification_worker_private.helper_contract c LEFT JOIN pg_proc p ON p.oid=c.signature
  WHERE p.oid IS NULL OR p.proowner<>c.owner_oid OR md5(p.prosrc)<>c.body_md5
   OR p.proconfig IS DISTINCT FROM c.configuration OR p.prosecdef<>c.security_definer OR p.provolatile<>c.volatility OR p.prolang<>c.language_oid)
 THEN RAISE EXCEPTION 'Notification worker authority unavailable' USING ERRCODE='42501';END IF;
 RETURN login;
END $body$;

CREATE FUNCTION notification_worker_private.event(p_batch uuid,p_event uuid) RETURNS public.domain_event
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
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
END $body$;
CREATE FUNCTION notification_worker_private.obsolete(e public.domain_event) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
 SELECT CASE WHEN e.event_type LIKE 'employment-review.%' THEN app.probation_legacy_review_owned(e.aggregate_id) ELSE false END
$body$;
CREATE FUNCTION notification_worker.facts(p_batch uuid,p_event uuid,p_family text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE e public.domain_event;result jsonb;stage text;known boolean;implemented boolean;
BEGIN
 e:=notification_worker_private.event(p_batch,p_event);
 IF p_family='meta' THEN
  SELECT count(*)>0,coalesce(bool_and(c.implemented),false) INTO known,implemented FROM notification_worker_private.registry_contract c WHERE c.event_type=e.event_type;
  RETURN jsonb_build_object('known',known,'implemented',implemented,'obsolete',notification_worker_private.obsolete(e));
 END IF;
 IF notification_worker_private.obsolete(e) THEN RAISE EXCEPTION 'Obsolete notification event' USING ERRCODE='42501';END IF;
 IF p_family='payroll-audience' AND e.event_type='payroll-batch.closed' THEN
  SELECT coalesce(jsonb_agg(DISTINCT s.employment_id),'[]'::jsonb) INTO result
  FROM public.payslip s JOIN public.employment work ON work.id=s.employment_id AND work.tenant_id=s.tenant_id
  WHERE s.batch_id=e.aggregate_id AND s.tenant_id=e.tenant_id;
 ELSIF p_family='notice-audience' AND e.event_type='notice.published' THEN
  SELECT coalesce(jsonb_agg(n.employment_id ORDER BY n.employment_id,n.id),'[]'::jsonb) INTO result
  FROM public.notice_recipient n JOIN public.notice notice ON notice.id=n.notice_id AND notice.tenant_id=n.tenant_id
  JOIN public.employment work ON work.id=n.employment_id AND work.tenant_id=n.tenant_id
  WHERE n.notice_id=e.aggregate_id AND n.tenant_id=e.tenant_id AND notice.published_at IS NOT NULL;
 ELSIF p_family='org-approvers' AND e.event_type IN('delegation.started','delegation.ended') THEN
  SELECT coalesce(jsonb_agg(r.manager_employment_id),'[]'::jsonb) INTO result FROM public.reporting_line r
  JOIN public.employment work ON work.id=r.manager_employment_id AND work.tenant_id=r.tenant_id
  WHERE r.id=e.aggregate_id AND r.tenant_id=e.tenant_id;
 ELSIF p_family='contract-audience' AND e.event_type='contract.notification-due' THEN
  SELECT coalesce(jsonb_agg(r.employment_id),'[]'::jsonb) INTO result FROM app.contract_notification_recipients(e.aggregate_id) r;
 ELSIF p_family='onboarding-audience' AND e.event_type='onboarding.digest' THEN
  result:='[]'::jsonb;
  IF jsonb_typeof(e.payload->'caseId')='string' AND jsonb_typeof(e.payload->'recipientUserId')='string' THEN
   SELECT coalesce(jsonb_agg(r.id),'[]'::jsonb) INTO result FROM app.onboarding_mail_recipient((e.payload->>'caseId')::uuid,(e.payload->>'recipientUserId')::uuid) r(id);
  END IF;
 ELSIF p_family='rewards-audience' AND e.event_type IN('reward-access.suspended','reward-unit.upload-replaced','reward-unit.upload-confirmed','reward-unit.routed','reward-unit.final-pool-changed','reward-unit.approved') THEN
  IF e.event_type='reward-access.suspended' THEN SELECT coalesce(jsonb_agg(r.id),'[]'::jsonb) INTO result FROM app.reward_access_suspension_event_recipients(e.id) r(id);
  ELSIF e.event_type='reward-unit.upload-replaced' THEN SELECT coalesce(jsonb_agg(r.id),'[]'::jsonb) INTO result FROM app.reward_upload_checker_recipients(e.aggregate_id) r(id);
  ELSIF e.event_type='reward-unit.final-pool-changed' THEN SELECT coalesce(jsonb_agg(r.id),'[]'::jsonb) INTO result FROM app.reward_pool_notification_recipients(e.aggregate_id) r(id);
  ELSE
   stage:=CASE e.event_type WHEN 'reward-unit.upload-confirmed' THEN 'draft' WHEN 'reward-unit.approved' THEN 'approved' ELSE e.payload->>'to' END;
   SELECT coalesce(jsonb_agg(r.id),'[]'::jsonb) INTO result FROM app.reward_notification_recipients(e.aggregate_id,stage) r(id);
  END IF;
 ELSE RAISE EXCEPTION 'Notification fact family unavailable for event' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('employmentIds',result);
END $body$;

CREATE FUNCTION notification_worker.project(p_batch uuid,p_event uuid,p_kind text,p_recipient uuid,p_rendered jsonb,p_category text)
 RETURNS TABLE(notification_id uuid,created boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
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
END $body$;
CREATE FUNCTION notification_worker.project_reward_account(p_batch uuid,p_event uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
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
END $body$;
CREATE FUNCTION notification_worker.finish_event(p_batch uuid,p_event uuid,p_disposition text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE e public.domain_event;known boolean;implemented boolean;obsolete boolean;
BEGIN
 e:=notification_worker_private.event(p_batch,p_event);obsolete:=notification_worker_private.obsolete(e);
 SELECT count(*)>0,coalesce(bool_and(c.implemented),false) INTO known,implemented FROM notification_worker_private.registry_contract c WHERE c.event_type=e.event_type;
 IF p_disposition IS NULL OR p_disposition NOT IN('processed','ignored')
 OR p_disposition='ignored' AND known AND NOT obsolete OR p_disposition='processed' AND (NOT known OR obsolete OR NOT implemented)
 OR e.event_type='assessment.reminder-queued' AND NOT obsolete
 OR p_disposition='processed' AND e.event_type='reward-access.suspended' AND NOT EXISTS(SELECT 1 FROM notification_worker_private.batch_event WHERE batch_id=p_batch AND event_id=e.id AND account_projected)
 THEN RAISE EXCEPTION 'Notification event settlement unavailable' USING ERRCODE='42501';END IF;
 UPDATE notification_worker_private.batch_event SET disposition=p_disposition WHERE batch_id=p_batch AND event_id=e.id AND disposition IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Notification event already finished' USING ERRCODE='42501';END IF;
END $body$;
CREATE OR REPLACE FUNCTION notification_worker.finish_batch(p_batch uuid) RETURNS TABLE(processed integer,created integer)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
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
  VALUES(b.tenant_id,CASE WHEN b.consumer='notifications' THEN last_sequence ELSE 0 END,CASE WHEN b.consumer='assessment-reminders' THEN last_sequence ELSE 0 END)
  ON CONFLICT(tenant_id) DO UPDATE SET last_sequence=greatest(public.notification_cursor.last_sequence,excluded.last_sequence),
   assessment_last_sequence=greatest(public.notification_cursor.assessment_last_sequence,excluded.assessment_last_sequence),updated_at=now();
 END IF;
 UPDATE notification_worker_private.run SET committed_batches=committed_batches+1,processed_events=processed_events+n,created_notifications=created_notifications+effects WHERE run_id=b.run_id AND state='running';
 IF NOT FOUND THEN RAISE EXCEPTION 'Notification run settlement changed' USING ERRCODE='55000';END IF;
 DELETE FROM notification_worker_private.batch WHERE batch_id=p_batch;
 RETURN QUERY SELECT n,effects;
END $body$;

CREATE OR REPLACE FUNCTION notification_worker.finish_run(p_run uuid) RETURNS void
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
 tenants_processed=n,tenants_failed=0,result=jsonb_build_object('batches',r.committed_batches,'processed',r.processed_events,'created',r.created_notifications)
 WHERE id=p_run AND job_key='notifications.project' AND outcome='running';
 IF NOT FOUND THEN RAISE EXCEPTION 'Notification terminal CAS refused' USING ERRCODE='55000';END IF;
 UPDATE notification_worker_private.run SET state='completed' WHERE run_id=p_run;
 UPDATE notification_worker_private.authority SET active_run=NULL WHERE singleton AND active_run=p_run;
 PERFORM pg_advisory_unlock(hashtextextended('notification-worker:singleton',0));
END $body$;
CREATE OR REPLACE FUNCTION notification_worker.fail_run(p_run uuid,p_reason text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
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
END $body$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA notification_worker,notification_worker_private FROM PUBLIC,ai_hr_app;
INSERT INTO notification_worker_private.allowed_api(signature) VALUES
 ('notification_worker.facts(uuid,uuid,text)'::regprocedure),('notification_worker.project(uuid,uuid,text,uuid,jsonb,text)'::regprocedure),
 ('notification_worker.project_reward_account(uuid,uuid)'::regprocedure),('notification_worker.finish_event(uuid,uuid,text)'::regprocedure);
GRANT EXECUTE ON FUNCTION notification_worker.facts(uuid,uuid,text),notification_worker.project(uuid,uuid,text,uuid,jsonb,text),
 notification_worker.project_reward_account(uuid,uuid),notification_worker.finish_event(uuid,uuid,text) TO ai_hr_notification_worker;
DO $revoke_platform$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_platform') THEN
  REVOKE ALL ON ALL TABLES IN SCHEMA notification_worker_private FROM ai_hr_platform;
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA notification_worker,notification_worker_private FROM ai_hr_platform;
 END IF;
END $revoke_platform$;
