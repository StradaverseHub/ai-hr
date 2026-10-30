-- UNAPPLIED PROVISIONAL DEVELOPMENT ONLY. Coordinator idx720 / when1793330000078.
-- Same encrypted ledger; truthful cycle/company fact owner and native unit entry witness.
-- Separate nullable column additions and equivalent validated constraints. The combined ADD
-- exceeded the hosted memory bound after composition; no predecessor guard is removed or changed.
-- Report only stored catalogue sizes, never deparse unrelated predecessor expressions here.
DO $$ DECLARE checks bigint;largest integer;total bigint; BEGIN
 SELECT count(*),max(pg_column_size(conbin)),sum(pg_column_size(conbin)) INTO checks,largest,total
 FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c';
 RAISE NOTICE '0741 DDL start: CHECK count %, largest stored bytes %, total stored bytes %',checks,largest,total;
END $$;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD COLUMN rewards_calendar_unit_id uuid;
--> statement-breakpoint
DO $$ BEGIN RAISE NOTICE '0741 DDL 1/7 complete: unit column';END $$;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD COLUMN rewards_calendar_cycle_id uuid;
--> statement-breakpoint
DO $$ BEGIN RAISE NOTICE '0741 DDL 2/7 complete: cycle column';END $$;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD COLUMN rewards_calendar_id uuid;
--> statement-breakpoint
DO $$ BEGIN RAISE NOTICE '0741 DDL 3/7 complete: calendar column';END $$;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD COLUMN rewards_calendar_event_id uuid;
--> statement-breakpoint
DO $$ BEGIN RAISE NOTICE '0741 DDL 4/7 complete: event column';END $$;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD COLUMN rewards_calendar_revision integer;
--> statement-breakpoint
DO $$ BEGIN RAISE NOTICE '0741 DDL 5/7 complete: revision column';END $$;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_own_leave_review_rewards_calendar_event_id_key UNIQUE (rewards_calendar_event_id);
--> statement-breakpoint
DO $$ BEGIN RAISE NOTICE '0741 DDL 6/7 complete: event uniqueness';END $$;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_own_leave_review_rewards_calendar_revision_check CHECK (rewards_calendar_revision>0);
--> statement-breakpoint
DO $$ BEGIN RAISE NOTICE '0741 DDL 7/7 complete: positive revision';END $$;
--> statement-breakpoint
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES('rewards.calendar.update','rewards','approve','pay','rewards.calendar.update');
--> statement-breakpoint
-- Preserve every predecessor CHECK byte-expression for all predecessor kinds. Only the new closed
-- kind uses the new cycle/company column family; no assigned employment/person is fabricated.
DO $$ DECLARE c record; old text; canonical text; null_columns text; scope_name text; matches integer; before_hashes jsonb; after_hashes jsonb; raw_bytes integer;
BEGIN
 -- Closed metadata/receipt whitelist. Every other physical column is strictly NULL for calendar editing,
 -- including all existing assigned subject and other action receipt columns. No predecessor tree copy.
 SELECT string_agg(format('%I IS NULL',attname),' AND ' ORDER BY attnum) INTO null_columns
 FROM pg_attribute WHERE attrelid='app.assistant_own_leave_review'::regclass AND attnum>0 AND NOT attisdropped
 AND attname NOT IN ('action_kind','id','tenant_id','user_id','person_id','employment_id','company_id','intent_digest','reviewed_digest','state','created_at','expires_at','rewards_calendar_unit_id','rewards_calendar_cycle_id','rewards_calendar_event_id','rewards_calendar_revision','rewards_calendar_id');
 IF null_columns IS NULL THEN RAISE EXCEPTION '0741 missing canonical custody columns';END IF;
 canonical:=null_columns||' AND employment_id IS NULL AND company_id IS NOT NULL AND rewards_calendar_unit_id IS NOT NULL AND rewards_calendar_cycle_id IS NOT NULL AND ((state=''completed'')=(rewards_calendar_event_id IS NOT NULL AND rewards_calendar_revision IS NOT NULL AND rewards_calendar_id IS NOT NULL)) AND ((rewards_calendar_event_id IS NULL)=(rewards_calendar_id IS NULL)) AND ((rewards_calendar_event_id IS NULL)=(rewards_calendar_revision IS NULL)) AND (state=''completed'' OR (rewards_calendar_event_id IS NULL AND rewards_calendar_revision IS NULL))';
 -- Only actor scope and legacy kind receipt columns reject the new closed kind. Other family checks already enforce their own columns NULL.
 -- Discover exact keys without deparsing every large predecessor tree into a held cursor.
 SELECT count(*),min(conname) INTO matches,scope_name FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c' AND conname='assistant_own_leave_review_check'
 AND conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='app.assistant_own_leave_review'::regclass AND attname='testing_execution_id'),(SELECT attnum FROM pg_attribute WHERE attrelid='app.assistant_own_leave_review'::regclass AND attname='employment_id')]::smallint[];
 IF matches<>1 THEN RAISE EXCEPTION '0741 actor scope shape drift';END IF;
 SELECT jsonb_object_agg(conname,encode(sha256(convert_to(conbin::text,'UTF8')),'hex') ORDER BY conname) INTO before_hashes FROM pg_constraint
 WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c' AND conname NOT IN (scope_name,'assistant_review_kind_columns');
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c' AND conname IN (scope_name,'assistant_review_kind_columns') LOOP
 SELECT octet_length(conbin::text) INTO raw_bytes FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=c.conname;
 RAISE NOTICE '0741 target % raw conbin bytes before deparse %',c.conname,raw_bytes;
 SELECT pg_get_expr(conbin,conrelid) INTO old FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=c.conname;
 RAISE NOTICE '0741 wrapping %, predecessor bytes %, finite new branch bytes %',c.conname,octet_length(old),octet_length(canonical);
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',c.conname);
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK (CASE WHEN action_kind=''rewards.calendar.update'' THEN (%s) ELSE (%s) END)',c.conname,canonical,old);
 END LOOP;
 SELECT jsonb_object_agg(conname,encode(sha256(convert_to(conbin::text,'UTF8')),'hex') ORDER BY conname) INTO after_hashes FROM pg_constraint
 WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c' AND conname NOT IN (scope_name,'assistant_review_kind_columns');
 IF before_hashes IS NULL OR before_hashes IS DISTINCT FROM after_hashes THEN RAISE EXCEPTION '0741 untouched predecessor CHECK changed';END IF;
 RAISE NOTICE '0741 untouched CHECK hashes identical, digest %',encode(sha256(convert_to(before_hashes::text,'UTF8')),'hex');
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_rewards_calendar_columns CHECK (CASE WHEN action_kind=''rewards.calendar.update'' THEN (%s) ELSE rewards_calendar_unit_id IS NULL AND rewards_calendar_cycle_id IS NULL AND rewards_calendar_id IS NULL AND rewards_calendar_event_id IS NULL AND rewards_calendar_revision IS NULL END)',canonical);
END $$;
--> statement-breakpoint
CREATE FUNCTION app._assistant_rewards_calendar_review_identity(p_person uuid,p_bind boolean DEFAULT true,p_write boolean DEFAULT true) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL OR current_setting('transaction_isolation')<>'read committed' OR (p_write AND current_setting('transaction_read_only')<>'off') THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('access-configuration:'||app.current_tenant_id()::text,0)) THEN RAISE EXCEPTION 'Rewards calendar busy' USING ERRCODE='55P03';END IF;
 IF app.principal_snapshot_current() IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id() AND a.archived_at IS NULL AND NOT app.login_blocked(a.id) AND (p_bind IS NOT TRUE OR a.person_id IS NOT DISTINCT FROM p_person) AND (a.person_id IS NULL OR EXISTS(SELECT 1 FROM public.person actual WHERE actual.id=a.person_id AND actual.tenant_id=a.tenant_id))) THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_rewards_calendar_review_identity(uuid,boolean,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_rewards_calendar_review_source(p_person uuid,p_unit uuid,p_cycle uuid,p_company uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_rewards_calendar_review_identity(p_person);
 IF NOT EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.id=p_unit AND u.tenant_id=app.current_tenant_id() AND u.company_id=p_company AND u.cycle_id=p_cycle AND u.deleted_at IS NULL AND (u.created_by=app.current_user_id() OR app.reward_admin(u.company_id) OR EXISTS(SELECT 1 FROM app.reward_roles(u.id))))
  OR app.reward_calendar_access(p_cycle,p_company,true) IS NOT TRUE THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_rewards_calendar_review_source(uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Calendar review contains no employee identities; only the real actor is a privacy target.
CREATE FUNCTION app._assistant_rewards_calendar_review_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',jsonb_build_object('actionId',r.id,'action',r.action_kind,'contractVersion',1,
 'binding',jsonb_build_object('tenantId',r.tenant_id,'userId',r.user_id,'personId',r.person_id,'employmentId',r.employment_id,'companyId',r.company_id,'unitId',r.rewards_calendar_unit_id,'cycleId',r.rewards_calendar_cycle_id),
 'intentDigest',r.intent_digest,'reviewedDigest',r.reviewed_digest,'state',r.state,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 'sealed',CASE WHEN r.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN jsonb_build_object('formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,
 'eventId',r.rewards_calendar_event_id,'postedRevision',r.rewards_calendar_revision,'postedBatchId',r.rewards_calendar_id)
 FROM app.assistant_own_leave_review r LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=r.id WHERE r.id=p_id AND r.action_kind='rewards.calendar.update';
$$;
REVOKE ALL ON FUNCTION app._assistant_rewards_calendar_review_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_calendar_review_prepare(p_id uuid,p_person uuid,p_unit uuid,p_cycle uuid,p_company uuid,p_intent_digest text,p_reviewed_digest text,p_kid text,p_wrapped_dek text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();at_time timestamptz;people uuid[];
BEGIN
 PERFORM app._assistant_rewards_calendar_review_source(p_person,p_unit,p_cycle,p_company);
 people:='{}'::uuid[];
 IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND (i.person_id=p_person OR i.person_id=ANY(people))) OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND (i.person_id=p_person OR i.person_id=ANY(people))) THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 IF p_id IS NULL OR p_intent_digest IS NULL OR p_intent_digest !~ '^[a-f0-9]{64}$' OR p_reviewed_digest IS NULL OR p_reviewed_digest !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$' OR p_wrapped_dek IS NULL OR length(p_wrapped_dek) NOT BETWEEN 1 AND 512 OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='22023';END IF;
 at_time:=clock_timestamp();
 IF (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation' AND expires_at>at_time)>=5 OR (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND created_at>at_time-interval '10 minutes')>=20 THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='54000';END IF;
 INSERT INTO app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,rewards_calendar_unit_id,rewards_calendar_cycle_id,rewards_review_person_ids,intent_digest,reviewed_digest,state,created_at,expires_at)
 VALUES('rewards.calendar.update',p_id,t,u,p_person,NULL,p_company,p_unit,p_cycle,NULL,p_intent_digest,p_reviewed_digest,'awaiting_confirmation',at_time,at_time+interval '10 minutes') ON CONFLICT(id) DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped_dek,p_ciphertext);
 RETURN app._assistant_rewards_calendar_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_calendar_review_prepare(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_calendar_review_prepare(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_calendar_review_subject(p_id uuid) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_rewards_calendar_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND action_kind='rewards.calendar.update';
 IF NOT FOUND THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_rewards_calendar_review_identity(r.person_id);RETURN r.rewards_calendar_unit_id;
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_calendar_review_subject(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_calendar_review_subject(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_calendar_review_peek(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_rewards_calendar_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND action_kind='rewards.calendar.update';
 IF NOT FOUND THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_rewards_calendar_review_source(r.person_id,r.rewards_calendar_unit_id,r.rewards_calendar_cycle_id,r.company_id);
 IF r.state='awaiting_confirmation' AND (NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c WHERE c.action_id=r.id)) THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('review',app._assistant_rewards_calendar_review_json(r.id),'pendingExpired',r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at);
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_calendar_review_peek(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_calendar_review_peek(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_calendar_review_read(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_rewards_calendar_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND action_kind='rewards.calendar.update' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_rewards_calendar_review_source(r.person_id,r.rewards_calendar_unit_id,r.rewards_calendar_cycle_id,r.company_id);
 IF r.state='awaiting_confirmation' AND (NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c WHERE c.action_id=r.id)) THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at THEN UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review a WHERE c.action_id=a.id AND a.id=r.id AND a.state<>'awaiting_confirmation';
 RETURN app._assistant_rewards_calendar_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_calendar_review_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_calendar_review_read(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_rewards_calendar_values(q public.reward_calendar) RETURNS jsonb
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('due',jsonb_build_object('bu',(q).bu_due,'returned',(q).returned_due,'bg',(q).bg_due,'gr',(q).gr_due,'ctro',(q).ctro_due,'ec',(q).ec_due,'payroll',(q).payroll_due),'caseDue',(q).case_due,'offcycleDays',jsonb_build_object('bg',(q).offcycle_bg_days,'gr',(q).offcycle_gr_days,'ctro',(q).offcycle_ctro_days,'ec',(q).offcycle_ec_days,'returned',(q).offcycle_returned_days));
$$;
REVOKE ALL ON FUNCTION app._assistant_rewards_calendar_values(public.reward_calendar) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_calendar_review_complete(p_id uuid,p_reviewed_digest text,p_event uuid,p_revision integer,p_batch uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 PERFORM app._assistant_rewards_calendar_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND action_kind='rewards.calendar.update' FOR UPDATE NOWAIT;
 IF NOT FOUND OR p_event IS NULL OR p_revision IS NULL OR p_revision<0 THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_rewards_calendar_review_source(r.person_id,r.rewards_calendar_unit_id,r.rewards_calendar_cycle_id,r.company_id);
 IF r.state='completed' THEN
  IF r.rewards_calendar_event_id IS DISTINCT FROM p_event OR r.rewards_calendar_revision IS DISTINCT FROM p_revision OR r.rewards_calendar_id IS DISTINCT FROM p_batch THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
  IF r.reviewed_digest IS DISTINCT FROM p_reviewed_digest OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c WHERE c.action_id=r.id) THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
  IF p_batch IS NULL OR NOT EXISTS(SELECT 1 FROM public.reward_calendar q JOIN public.domain_event d ON d.tenant_id=q.tenant_id AND d.aggregate_id=q.id
   WHERE q.id=p_batch AND q.tenant_id=t AND q.company_id=r.company_id AND q.cycle_id=r.rewards_calendar_cycle_id AND q.revision=p_revision AND q.updated_by=u
   AND q.xmin=pg_current_xact_id()::xid AND d.id=p_event AND d.xmin=pg_current_xact_id()::xid
   AND d.aggregate_type='reward-calendar' AND d.event_type='reward-calendar.updated' AND d.actor_type='user' AND d.actor_id=u AND d.subject_employment_id IS NULL
   AND (d.payload->>'cycleId')::uuid=q.cycle_id AND (d.payload->>'companyId')::uuid=q.company_id AND (d.payload->>'revision')::integer=p_revision
   AND d.payload->'values'=d.payload->'after' AND d.payload->'after'=app._assistant_rewards_calendar_values(q)
   AND d.payload->>'calendarRowHash'=encode(sha256(convert_to(to_jsonb(q)::text,'UTF8')),'hex'))
   THEN RAISE EXCEPTION 'Rewards calendar proof unavailable' USING ERRCODE='42501';END IF;
  UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,rewards_calendar_event_id=p_event,rewards_calendar_revision=p_revision,rewards_calendar_id=p_batch,rewards_review_person_ids=NULL WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 ELSE RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 RETURN app._assistant_rewards_calendar_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_calendar_review_complete(uuid,text,uuid,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_calendar_review_complete(uuid,text,uuid,integer,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_calendar_review_discard(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_rewards_calendar_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND action_kind='rewards.calendar.update' FOR UPDATE NOWAIT;
 IF NOT FOUND OR r.state='completed' THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' THEN UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL,rewards_review_person_ids=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 -- Also clears a malformed already-retired association without touching native canonical history.
 UPDATE app.assistant_own_leave_review SET rewards_review_person_ids=NULL WHERE id=r.id AND rewards_review_person_ids IS NOT NULL;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=r.id;
 RETURN jsonb_build_object('action','rewards.calendar.update','contractVersion',1,'actionId',r.id,'state',r.state);
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_calendar_review_discard(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_calendar_review_discard(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_calendar_reviews_index() RETURNS TABLE(action text,action_id uuid,state text,created_at timestamptz,expires_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_rewards_calendar_review_identity(NULL,false,false);
 RETURN QUERY SELECT r.action_kind,r.id,r.state,r.created_at,r.expires_at FROM app.assistant_own_leave_review r WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND r.action_kind='rewards.calendar.update' ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_calendar_reviews_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_calendar_reviews_index() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_calendar_scope(p_unit uuid,p_lock boolean DEFAULT false) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.reward_unit%ROWTYPE;c public.reward_calendar%ROWTYPE;fingerprint text;
BEGIN
 PERFORM app._assistant_rewards_calendar_review_identity(NULL,false);
 SELECT * INTO q FROM public.reward_unit WHERE id=p_unit AND tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN RAISE EXCEPTION 'Rewards calendar unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_rewards_calendar_review_source((SELECT person_id FROM public.app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id()),q.id,q.cycle_id,q.company_id);
 -- A missing row is also a source state. Serialize Assistant creates by true owner; the native unique
 -- key and own revision refuse any concurrent non-Assistant create, never silently overwrite it.
 IF p_lock THEN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('rewards-calendar:'||q.tenant_id::text||':'||q.cycle_id::text||':'||q.company_id::text,0)) THEN RAISE EXCEPTION 'Rewards calendar busy' USING ERRCODE='55P03';END IF;
  SELECT * INTO q FROM public.reward_unit WHERE id=p_unit AND tenant_id=app.current_tenant_id() FOR SHARE NOWAIT;
  SELECT * INTO c FROM public.reward_calendar WHERE tenant_id=q.tenant_id AND cycle_id=q.cycle_id AND company_id=q.company_id FOR UPDATE NOWAIT;
 ELSE SELECT * INTO c FROM public.reward_calendar WHERE tenant_id=q.tenant_id AND cycle_id=q.cycle_id AND company_id=q.company_id;END IF;
 SELECT coalesce(encode(sha256(convert_to(to_jsonb(cal)::text||':'||cal.xmin::text,'UTF8')),'hex'),'absent') INTO fingerprint FROM (SELECT 1) dummy LEFT JOIN public.reward_calendar cal ON cal.tenant_id=q.tenant_id AND cal.cycle_id=q.cycle_id AND cal.company_id=q.company_id;
 RETURN (SELECT jsonb_build_object('unitId',q.id,'cycleId',q.cycle_id,'companyId',q.company_id,'companyName',co.legal_name,'name',rc.name,'calendarId',c.id,'revision',coalesce(c.revision,0),'values',app._assistant_rewards_calendar_values(c),'fingerprint',fingerprint)
 FROM public.company co JOIN public.reward_cycle rc ON rc.id=q.cycle_id AND rc.tenant_id=q.tenant_id WHERE co.id=q.company_id AND co.tenant_id=q.tenant_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_calendar_scope(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_calendar_scope(uuid,boolean) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_calendar_receipt(p_unit uuid,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.reward_unit%ROWTYPE;c public.reward_calendar%ROWTYPE;d public.domain_event%ROWTYPE;
BEGIN
 PERFORM app.assistant_rewards_calendar_scope(p_unit,false);
 SELECT * INTO q FROM public.reward_unit WHERE id=p_unit AND tenant_id=app.current_tenant_id();
 SELECT * INTO c FROM public.reward_calendar WHERE tenant_id=q.tenant_id AND cycle_id=q.cycle_id AND company_id=q.company_id;
 SELECT * INTO d FROM public.domain_event WHERE id=p_event AND tenant_id=q.tenant_id AND aggregate_id=c.id AND aggregate_type='reward-calendar' AND event_type='reward-calendar.updated' AND actor_type='user' AND actor_id=app.current_user_id() AND subject_employment_id IS NULL;
 IF NOT FOUND OR (d.payload->>'companyId')::uuid IS DISTINCT FROM q.company_id OR (d.payload->>'cycleId')::uuid IS DISTINCT FROM q.cycle_id OR c.revision<(d.payload->>'revision')::integer THEN RAISE EXCEPTION 'Rewards calendar unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('kind','calendar_saved','unitId',q.id,'cycleId',q.cycle_id,'companyId',q.company_id,'calendarId',c.id,'eventId',d.id,'savedRevision',(d.payload->>'revision')::integer,'currentRevision',c.revision,'proof','historical_calendar_update_current_calendar');
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_calendar_receipt(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_calendar_receipt(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_calendar_choices() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE items jsonb;
BEGIN
 PERFORM app._assistant_rewards_calendar_review_identity(NULL,false);
 SELECT coalesce(jsonb_agg(jsonb_build_object('unitId',q.id,'cycleId',q.cycle_id,'companyId',q.company_id,'name',q.display_name,'companyName',q.company_name,'calendarId',q.calendar_id,'revision',q.revision,'values',q.values) ORDER BY q.company_name,q.display_name,q.id),'[]'::jsonb) INTO items
 FROM (SELECT DISTINCT ON (u.cycle_id,u.company_id) u.id,u.cycle_id,u.company_id,c.legal_name AS company_name,rc.name AS display_name,cal.id AS calendar_id,coalesce(cal.revision,0) AS revision,app._assistant_rewards_calendar_values(cal) AS values
 FROM public.reward_unit u JOIN public.company c ON c.id=u.company_id AND c.tenant_id=u.tenant_id JOIN public.reward_cycle rc ON rc.id=u.cycle_id AND rc.tenant_id=u.tenant_id LEFT JOIN public.reward_calendar cal ON cal.tenant_id=u.tenant_id AND cal.company_id=u.company_id AND cal.cycle_id=u.cycle_id
 WHERE u.tenant_id=app.current_tenant_id() AND u.deleted_at IS NULL AND (u.created_by=app.current_user_id() OR app.reward_admin(u.company_id) OR EXISTS(SELECT 1 FROM app.reward_roles(u.id))) AND app.reward_calendar_access(u.cycle_id,u.company_id,true) ORDER BY u.cycle_id,u.company_id,u.id LIMIT 21) q;
 RETURN jsonb_build_object('kind','choices','truncated',jsonb_array_length(items)>20,'units',CASE WHEN jsonb_array_length(items)>20 THEN items-20 ELSE items END);
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_calendar_choices() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_calendar_choices() TO ai_hr_app;
--> statement-breakpoint
-- Extend only closed native-outcome predicates; retain all predecessor bodies and grants.
DO $$ DECLARE target regprocedure;definition text;marker text;replacement text;
BEGIN
 FOR target IN SELECT signature::regprocedure FROM unnest(ARRAY['app.native_outcome_review_completed(text,uuid)','app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)','app.native_outcome_completed_review_choices(jsonb)']) signature LOOP
 definition:=pg_get_functiondef(target);
 IF target='app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure THEN marker:='WHEN ''rewards.cancel_review'' THEN r.rewards_posted_event_id';replacement:=marker||' WHEN ''rewards.calendar.update'' THEN r.rewards_calendar_event_id';
 ELSE marker:='''rewards.post''';replacement:=marker||',''rewards.calendar.update'''; END IF;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION '0741 unexpected outcome owner %',target;END IF;
 EXECUTE replace(definition,marker,replacement);
 END LOOP;
END $$;
