-- UNNUMBERED ISOLATED-CI child of lifecycle.sql + projection.sql. No installer.
DO $guard$ BEGIN
 IF current_database() IS DISTINCT FROM current_setting('aihr.notification_fixture.database',true)
 OR EXISTS(SELECT 1 FROM notification_worker_private.run) THEN RAISE EXCEPTION 'Empty canonical owned fixture required' USING ERRCODE='55000';END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='notification_worker_private.admit_login()'::regprocedure) IS DISTINCT FROM 'ff603749a439de1340d6bffa1b0ccec0' THEN RAISE EXCEPTION 'Unexpected stage2 notification_worker_private.admit_login()' USING ERRCODE='55000';END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='notification_worker.facts(uuid,uuid,text)'::regprocedure) IS DISTINCT FROM 'c7ed5396f274a2690ada3219037daba2' THEN RAISE EXCEPTION 'Unexpected stage2 notification_worker.facts(uuid,uuid,text)' USING ERRCODE='55000';END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='notification_worker_private.audience(domain_event,text)'::regprocedure) IS DISTINCT FROM '53b02f61ecaea1a1727ba255fff5adf9' THEN RAISE EXCEPTION 'Unexpected stage2 notification_worker_private.audience(domain_event,text)' USING ERRCODE='55000';END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='notification_worker.finish_event(uuid,uuid,text)'::regprocedure) IS DISTINCT FROM 'b317afa0442bac4e210c29c8856864bf' THEN RAISE EXCEPTION 'Unexpected stage2 notification_worker.finish_event(uuid,uuid,text)' USING ERRCODE='55000';END IF;
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='notification_worker_private.capture_recipe(uuid,domain_event,text)'::regprocedure) IS DISTINCT FROM 'c1bde7e57685cf9cd202ca54dcdf9a55' THEN RAISE EXCEPTION 'Unexpected stage2 capture recipe' USING ERRCODE='55000';END IF;
END $guard$;
ALTER TABLE notification_worker_private.authority DROP CONSTRAINT authority_api_version_check;
ALTER TABLE notification_worker_private.authority ADD CHECK(api_version IN(1,2,3));
CREATE TABLE notification_worker_private.assessment_task_key(key text PRIMARY KEY);
CREATE TABLE notification_worker_private.assessment_projection(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),batch_id uuid NOT NULL REFERENCES notification_worker_private.batch(batch_id) ON DELETE CASCADE,
 cycle_id uuid NOT NULL,epochs jsonb NOT NULL,started_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,module_expiry timestamptz,
 graph jsonb,routes jsonb NOT NULL,snapshot jsonb NOT NULL);
CREATE INDEX assessment_projection_batch_cycle ON notification_worker_private.assessment_projection(batch_id,cycle_id);
CREATE TABLE notification_worker_private.assessment_admission(
 batch_id uuid NOT NULL,event_id uuid NOT NULL,recipient_id uuid NOT NULL,available boolean NOT NULL,
 run_id uuid,cycle_id uuid,user_id uuid,employment_id uuid,mode text,epochs jsonb NOT NULL,
 projection_id uuid REFERENCES notification_worker_private.assessment_projection(id),prepared boolean NOT NULL DEFAULT false,
 recipient_employment_id uuid,PRIMARY KEY(batch_id,event_id),
 FOREIGN KEY(batch_id,event_id) REFERENCES notification_worker_private.batch_event(batch_id,event_id) ON DELETE CASCADE);
ALTER TABLE notification_worker_private.assessment_task_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_worker_private.assessment_projection ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_worker_private.assessment_admission ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON notification_worker_private.assessment_task_key,notification_worker_private.assessment_projection,notification_worker_private.assessment_admission FROM PUBLIC,ai_hr_app;
CREATE OR REPLACE FUNCTION notification_worker_private.admit_login() RETURNS oid LANGUAGE plpgsql SECURITY DEFINER
 SET search_path=pg_catalog,pg_temp AS $body$
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
END $body$;
CREATE FUNCTION notification_worker_private.assessment_epochs(p_tenant uuid,p_cycle uuid) RETURNS jsonb
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
 SELECT coalesce(jsonb_agg(jsonb_build_object('scopeId',scope_id,'revision',revision) ORDER BY scope_id),'[]'::jsonb)
 FROM public.performance_assessment_reminder_epoch WHERE tenant_id=p_tenant AND scope_id IN('00000000-0000-0000-0000-000000000000'::uuid,p_cycle)
$body$;
CREATE FUNCTION notification_worker_private.capture_assessment(p_batch uuid,e public.domain_event) RETURNS notification_worker_private.assessment_admission
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
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
END $body$;
CREATE FUNCTION notification_worker_private.assessment_facts(p_batch uuid,e public.domain_event,p_family text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
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
END $body$;
-- Exact Zod4.6.7 default z.iso.datetime({offset:true}) language: leap-aware
-- four-digit year, required seconds, optional fraction, uppercaseT/Z, colon offset.
-- This is task wire syntax, not PostgreSQL's broader/narrower timestamptz language.
CREATE FUNCTION notification_worker_private.assessment_iso_datetime(value text) RETURNS boolean
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $body$
 SELECT value ~ '^(?:[0-9][0-9][2468][048]|[0-9][0-9][13579][26]|[0-9][0-9]0[48]|[02468][048]00|[13579][26]00)-02-29T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:[.][0-9]+)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$'
 OR value ~ '^[0-9]{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:[.][0-9]+)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$'
$body$;
-- Locked Zod4.6.7 string limits count Unicode code points. PostgreSQL UTF8
-- length has the same count on the representable JSONB string domain, including
-- supplementary characters and combining marks (not grapheme clusters).
CREATE FUNCTION notification_worker_private.assessment_codepoint_length(value text) RETURNS integer
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $body$
 SELECT length(value)
$body$;
-- ECMAScript TrimString whitespace/line terminators, including NBSP and BOM.
CREATE FUNCTION notification_worker_private.assessment_js_trim(value text) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,pg_temp AS $body$
 SELECT btrim(value,chr(9)||chr(10)||chr(11)||chr(12)||chr(13)||chr(32)||chr(160)||chr(5760)||
  chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||
  chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279))
$body$;
CREATE FUNCTION notification_worker.prepare_assessment(p_batch uuid,p_event uuid,p_decision jsonb) RETURNS uuid[]
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE e public.domain_event;a notification_worker_private.assessment_admission;p notification_worker_private.assessment_projection;r record;
 kind text;next_outcome text;at_time timestamptz;until_time timestamptz;expected_tenant_epoch bigint;expected_cycle_epoch bigint;item jsonb;words jsonb;canonical_tasks jsonb:='[]'::jsonb;people jsonb;
BEGIN
 e:=notification_worker_private.event(p_batch,p_event);a:=notification_worker_private.capture_assessment(p_batch,e);
 IF a.prepared OR p_decision IS NULL OR jsonb_typeof(p_decision)<>'object' OR jsonb_typeof(p_decision->'kind') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Assessment preparation proposal unavailable' USING ERRCODE='42501';END IF;
 kind:=p_decision->>'kind';
 -- These are wire byte ceilings in addition to the unchanged canonical shape.
 -- 16*3*200 code points at worst six JSON-escaped bytes fit 64KiB tasks;
 -- 20k+30k code points fit 320KiB words; 400KiB also includes the envelope.
 -- Unbounded date fractions or pre-trim padding remain explicitly bounded.
 IF kind NOT IN('noop','skip','prepare') OR octet_length(p_decision::text)>409600 THEN RAISE EXCEPTION 'Closed bounded preparation decision required' USING ERRCODE='22023';END IF;
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
   OR jsonb_typeof(p_decision->'tasks')<>'array' OR jsonb_array_length(p_decision->'tasks') NOT BETWEEN 1 AND 16 OR octet_length((p_decision->'tasks')::text)>65536
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
  IF words<>'null'::jsonb AND (jsonb_typeof(words)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(words))<>2 OR NOT(words?&ARRAY['subject','opening']) OR jsonb_typeof(words->'subject') IS DISTINCT FROM 'string' OR jsonb_typeof(words->'opening') IS DISTINCT FROM 'string' OR notification_worker_private.assessment_codepoint_length(words->>'subject') NOT BETWEEN 1 AND 20000 OR (position(chr(13) in (words->>'subject'))>0 OR position(chr(10) in (words->>'subject'))>0) OR notification_worker_private.assessment_codepoint_length(words->>'opening') NOT BETWEEN 1 AND 30000 OR octet_length(words::text)>327680) THEN RAISE EXCEPTION 'Invalid prepared reminder words' USING ERRCODE='22023';END IF;
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
END $body$;

CREATE OR REPLACE FUNCTION notification_worker.facts(p_batch uuid,p_event uuid,p_family text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
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
END $body$;
CREATE FUNCTION notification_worker_private.audience_for_batch(p_batch uuid,e public.domain_event,p_kind text) RETURNS uuid[]
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE a notification_worker_private.assessment_admission;
BEGIN
 IF e.event_type<>'assessment.reminder-queued' THEN RETURN notification_worker_private.audience(e,p_kind);END IF;
 IF p_kind<>'performance.reminder' OR NOT EXISTS(SELECT 1 FROM notification_worker_private.registry_contract c WHERE c.event_type=e.event_type AND c.kind=p_kind AND c.recipient_port='assessmentReminder' AND c.implemented) THEN RAISE EXCEPTION 'Canonical reminder recipe unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO a FROM notification_worker_private.assessment_admission WHERE batch_id=p_batch AND event_id=e.id;
 IF NOT FOUND OR NOT a.prepared THEN RAISE EXCEPTION 'Native assessment preparation required' USING ERRCODE='42501';END IF;
 RETURN CASE WHEN a.recipient_employment_id IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[a.recipient_employment_id] END;
END $body$;
CREATE OR REPLACE FUNCTION notification_worker_private.capture_recipe(p_batch uuid,e public.domain_event,p_kind text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
DECLARE ids uuid[];
BEGIN
 IF EXISTS(SELECT 1 FROM notification_worker_private.batch_recipe WHERE batch_id=p_batch AND event_id=e.id AND kind=p_kind) THEN RETURN;END IF;
 ids:=notification_worker_private.audience_for_batch(p_batch,e,p_kind);
 IF EXISTS(SELECT 1 FROM unnest(ids) wanted(id) WHERE NOT EXISTS(SELECT 1 FROM public.employment work WHERE work.id=wanted.id AND work.tenant_id=e.tenant_id)) THEN
  RAISE EXCEPTION 'Native notification audience escaped its event tenant' USING ERRCODE='42501';END IF;
 INSERT INTO notification_worker_private.batch_recipe(batch_id,event_id,kind) VALUES(p_batch,e.id,p_kind);
 INSERT INTO notification_worker_private.batch_recipient(batch_id,event_id,kind,employment_id,ordinal)
 SELECT p_batch,e.id,p_kind,r.id,min(r.ordinal) FROM unnest(ids) WITH ORDINALITY r(id,ordinal) GROUP BY r.id;
END $body$;
CREATE OR REPLACE FUNCTION notification_worker.finish_event(p_batch uuid,p_event uuid,p_disposition text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $body$
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
END $body$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA notification_worker,notification_worker_private FROM PUBLIC,ai_hr_app;
INSERT INTO notification_worker_private.allowed_api(signature) VALUES('notification_worker.prepare_assessment(uuid,uuid,jsonb)'::regprocedure);
GRANT EXECUTE ON FUNCTION notification_worker.prepare_assessment(uuid,uuid,jsonb) TO ai_hr_notification_worker;
DO $revoke_platform$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_hr_platform') THEN
 REVOKE ALL ON ALL TABLES IN SCHEMA notification_worker_private FROM ai_hr_platform;
 REVOKE ALL ON ALL FUNCTIONS IN SCHEMA notification_worker,notification_worker_private FROM ai_hr_platform;
END IF;END $revoke_platform$;
