-- UNAPPLIED PROVISIONAL DEVELOPMENT ONLY. Coordinator idx711 / when1793330000068.
-- Same physical encrypted ledger and unit/company compatibility protocol as Rewards post.
-- Legacy rewards_posted_* columns hold this kind's cancellation event/revision; no payroll effect.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES('rewards.cancel_review','rewards','approve','pay','rewards.cancel_review');
--> statement-breakpoint
-- Preserve every predecessor CHECK byte-expression for all predecessor kinds. Only the new closed
-- kind uses the existing unit/company column family; no assigned employment/person is fabricated.
DO $$ DECLARE c record; old text; canonical text; null_columns text; scope_name text; rewards_name text; matches integer;
BEGIN
 -- Closed metadata/receipt whitelist. Every other physical column is strictly NULL for cancellation,
 -- including all existing assigned subject and other action receipt columns. No predecessor tree copy.
 SELECT string_agg(format('%I IS NULL',attname),' AND ' ORDER BY attnum) INTO null_columns
 FROM pg_attribute WHERE attrelid='app.assistant_own_leave_review'::regclass AND attnum>0 AND NOT attisdropped
 AND attname NOT IN ('action_kind','id','tenant_id','user_id','person_id','employment_id','company_id','intent_digest','reviewed_digest','state','created_at','expires_at','rewards_unit_id','rewards_posted_event_id','rewards_posted_revision','rewards_posted_batch_id','rewards_review_person_ids');
 IF null_columns IS NULL THEN RAISE EXCEPTION '0731 missing canonical custody columns';END IF;
 canonical:=null_columns||' AND employment_id IS NULL AND company_id IS NOT NULL AND rewards_unit_id IS NOT NULL AND rewards_posted_batch_id IS NULL AND ((state=''completed'')=(rewards_posted_event_id IS NOT NULL AND rewards_posted_revision IS NOT NULL)) AND ((rewards_posted_event_id IS NULL)=(rewards_posted_revision IS NULL)) AND (state=''completed'' OR (rewards_posted_event_id IS NULL AND rewards_posted_revision IS NULL)) AND (rewards_review_person_ids IS NULL OR rewards_review_person_ids=ARRAY[]::uuid[])';
 -- Only three existing checks reject this kind: actor scope, dedicated Rewards columns and
 -- legacy kind receipt columns. Other family checks already enforce their own columns NULL.
 -- Discover exact keys without deparsing every large predecessor tree into a held cursor.
 SELECT count(*),min(conname) INTO matches,scope_name FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c'
 AND conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='app.assistant_own_leave_review'::regclass AND attname='testing_execution_id'),(SELECT attnum FROM pg_attribute WHERE attrelid='app.assistant_own_leave_review'::regclass AND attname='employment_id')]::smallint[];
 IF matches<>1 THEN RAISE EXCEPTION '0731 actor scope shape drift';END IF;
 SELECT count(*),min(conname) INTO matches,rewards_name FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c'
 AND conkey @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='app.assistant_own_leave_review'::regclass AND attname='action_kind'),(SELECT attnum FROM pg_attribute WHERE attrelid='app.assistant_own_leave_review'::regclass AND attname='rewards_unit_id')]::smallint[];
 IF matches<>1 THEN RAISE EXCEPTION '0731 Rewards column shape drift';END IF;
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c' AND conname IN (scope_name,rewards_name,'assistant_review_kind_columns') LOOP
 SELECT pg_get_expr(conbin,conrelid) INTO old FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=c.conname;
 RAISE NOTICE '0731 wrapping %, predecessor bytes %, finite new branch bytes %',c.conname,octet_length(old),octet_length(canonical);
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',c.conname);
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK (CASE WHEN action_kind=''rewards.cancel_review'' THEN (%s) ELSE (%s) END)',c.conname,canonical,old);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION app._assistant_rewards_cancel_review_identity(p_person uuid,p_bind boolean DEFAULT true,p_write boolean DEFAULT true) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL OR current_setting('transaction_isolation')<>'read committed' OR (p_write AND current_setting('transaction_read_only')<>'off') THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 IF NOT pg_try_advisory_xact_lock(hashtextextended('access-configuration:'||app.current_tenant_id()::text,0)) THEN RAISE EXCEPTION 'Rewards cancellation busy' USING ERRCODE='55P03';END IF;
 IF app.principal_snapshot_current() IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id() AND a.archived_at IS NULL AND NOT app.login_blocked(a.id) AND (p_bind IS NOT TRUE OR a.person_id IS NOT DISTINCT FROM p_person) AND (a.person_id IS NULL OR EXISTS(SELECT 1 FROM public.person actual WHERE actual.id=a.person_id AND actual.tenant_id=a.tenant_id))) THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_rewards_cancel_review_identity(uuid,boolean,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_rewards_cancel_review_source(p_person uuid,p_unit uuid,p_company uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_rewards_cancel_review_identity(p_person);
 IF NOT EXISTS(SELECT 1 FROM public.reward_unit u WHERE u.id=p_unit AND u.tenant_id=app.current_tenant_id() AND u.company_id=p_company AND u.deleted_at IS NULL)
  OR (app.reward_admin(p_company) IS NOT TRUE AND NOT EXISTS(SELECT 1 FROM app.reward_roles(p_unit) AS r(role) WHERE r.role='gr')) THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_rewards_cancel_review_source(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Cancellation review contains no employee identities; only the real actor is a privacy target.
CREATE FUNCTION app._assistant_rewards_cancel_review_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',jsonb_build_object('actionId',r.id,'action',r.action_kind,'contractVersion',1,
 'binding',jsonb_build_object('tenantId',r.tenant_id,'userId',r.user_id,'personId',r.person_id,'employmentId',r.employment_id,'companyId',r.company_id,'unitId',r.rewards_unit_id),
 'intentDigest',r.intent_digest,'reviewedDigest',r.reviewed_digest,'state',r.state,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 'sealed',CASE WHEN r.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN jsonb_build_object('formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,
 'eventId',r.rewards_posted_event_id,'postedRevision',r.rewards_posted_revision,'postedBatchId',r.rewards_posted_batch_id)
 FROM app.assistant_own_leave_review r LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=r.id WHERE r.id=p_id AND r.action_kind='rewards.cancel_review';
$$;
REVOKE ALL ON FUNCTION app._assistant_rewards_cancel_review_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_cancel_review_prepare(p_id uuid,p_person uuid,p_unit uuid,p_company uuid,p_intent_digest text,p_reviewed_digest text,p_kid text,p_wrapped_dek text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();at_time timestamptz;people uuid[];
BEGIN
 PERFORM app._assistant_rewards_cancel_review_source(p_person,p_unit,p_company);
 IF NOT EXISTS(SELECT 1 FROM public.reward_unit q WHERE q.id=p_unit AND q.tenant_id=t AND q.status IN ('draft','bg','gr','ctro','ec','approved')) THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 people:='{}'::uuid[];
 IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND (i.person_id=p_person OR i.person_id=ANY(people))) OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND (i.person_id=p_person OR i.person_id=ANY(people))) THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 IF p_id IS NULL OR p_intent_digest IS NULL OR p_intent_digest !~ '^[a-f0-9]{64}$' OR p_reviewed_digest IS NULL OR p_reviewed_digest !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$' OR p_wrapped_dek IS NULL OR length(p_wrapped_dek) NOT BETWEEN 1 AND 512 OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='22023';END IF;
 at_time:=clock_timestamp();
 IF (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation' AND expires_at>at_time)>=5 OR (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND created_at>at_time-interval '10 minutes')>=20 THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='54000';END IF;
 INSERT INTO app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,rewards_unit_id,rewards_review_person_ids,intent_digest,reviewed_digest,state,created_at,expires_at)
 VALUES('rewards.cancel_review',p_id,t,u,p_person,NULL,p_company,p_unit,people,p_intent_digest,p_reviewed_digest,'awaiting_confirmation',at_time,at_time+interval '10 minutes') ON CONFLICT(id) DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped_dek,p_ciphertext);
 RETURN app._assistant_rewards_cancel_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_cancel_review_prepare(uuid,uuid,uuid,uuid,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_cancel_review_prepare(uuid,uuid,uuid,uuid,text,text,text,text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_cancel_review_subject(p_id uuid) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_rewards_cancel_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND action_kind='rewards.cancel_review';
 IF NOT FOUND THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_rewards_cancel_review_identity(r.person_id);RETURN r.rewards_unit_id;
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_cancel_review_subject(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_cancel_review_subject(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_cancel_review_peek(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_rewards_cancel_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND action_kind='rewards.cancel_review';
 IF NOT FOUND THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_rewards_cancel_review_source(r.person_id,r.rewards_unit_id,r.company_id);
 IF r.state='awaiting_confirmation' AND (r.rewards_review_person_ids IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c WHERE c.action_id=r.id)) THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('review',app._assistant_rewards_cancel_review_json(r.id),'pendingExpired',r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at);
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_cancel_review_peek(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_cancel_review_peek(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_cancel_review_read(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_rewards_cancel_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND action_kind='rewards.cancel_review' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_rewards_cancel_review_source(r.person_id,r.rewards_unit_id,r.company_id);
 IF r.state='awaiting_confirmation' AND (r.rewards_review_person_ids IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c WHERE c.action_id=r.id)) THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at THEN UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review a WHERE c.action_id=a.id AND a.id=r.id AND a.state<>'awaiting_confirmation';
 RETURN app._assistant_rewards_cancel_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_cancel_review_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_cancel_review_read(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_cancel_review_complete(p_id uuid,p_reviewed_digest text,p_event uuid,p_revision integer,p_batch uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 PERFORM app._assistant_rewards_cancel_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND action_kind='rewards.cancel_review' FOR UPDATE NOWAIT;
 IF NOT FOUND OR p_event IS NULL OR p_revision IS NULL OR p_revision<0 THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_rewards_cancel_review_source(r.person_id,r.rewards_unit_id,r.company_id);
 IF r.state='completed' THEN
  IF r.rewards_posted_event_id IS DISTINCT FROM p_event OR r.rewards_posted_revision IS DISTINCT FROM p_revision OR r.rewards_posted_batch_id IS DISTINCT FROM p_batch THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
  IF r.reviewed_digest IS DISTINCT FROM p_reviewed_digest OR r.rewards_review_person_ids IS NULL OR NOT EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c WHERE c.action_id=r.id) THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
  IF p_batch IS NOT NULL OR NOT EXISTS(SELECT 1 FROM public.reward_unit q JOIN public.domain_event d ON d.tenant_id=q.tenant_id AND d.aggregate_id=q.id
   WHERE q.id=r.rewards_unit_id AND q.tenant_id=t AND q.company_id=r.company_id AND q.deleted_at IS NULL AND q.status='withdrawn' AND q.revision=p_revision+1 AND q.approved_digest IS NULL
   AND q.xmin=pg_current_xact_id()::xid AND d.id=p_event AND d.xmin=pg_current_xact_id()::xid
   AND d.aggregate_type='reward-unit' AND d.event_type='reward-unit.cancelled' AND d.actor_type='user' AND d.actor_id=u AND d.subject_employment_id IS NULL
   AND (d.payload->>'revision')::integer=p_revision AND d.payload->'after'=jsonb_build_object('status','withdrawn','revision',p_revision+1)
   AND d.payload->'before'=jsonb_build_object('status',d.payload->>'fromStage','revision',p_revision)
   AND d.payload->>'fromStage' IN ('draft','bg','gr','ctro','ec','approved')
   AND length(d.payload->>'reason') BETWEEN 10 AND 4000
   AND d.payload->>'cancelRowHash'=encode(sha256(convert_to(to_jsonb(q)::text,'UTF8')),'hex'))
   THEN RAISE EXCEPTION 'Rewards cancellation proof unavailable' USING ERRCODE='42501';END IF;
  UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,rewards_posted_event_id=p_event,rewards_posted_revision=p_revision,rewards_posted_batch_id=p_batch,rewards_review_person_ids=NULL WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 ELSE RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 RETURN app._assistant_rewards_cancel_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_cancel_review_complete(uuid,text,uuid,integer,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_cancel_review_complete(uuid,text,uuid,integer,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_cancel_review_discard(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_rewards_cancel_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND action_kind='rewards.cancel_review' FOR UPDATE NOWAIT;
 IF NOT FOUND OR r.state='completed' THEN RAISE EXCEPTION 'Rewards review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' THEN UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL,rewards_review_person_ids=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 -- Also clears a malformed already-retired association without touching native canonical history.
 UPDATE app.assistant_own_leave_review SET rewards_review_person_ids=NULL WHERE id=r.id AND rewards_review_person_ids IS NOT NULL;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=r.id;
 RETURN jsonb_build_object('action','rewards.cancel_review','contractVersion',1,'actionId',r.id,'state',r.state);
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_cancel_review_discard(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_cancel_review_discard(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_cancel_reviews_index() RETURNS TABLE(action text,action_id uuid,state text,created_at timestamptz,expires_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_rewards_cancel_review_identity(NULL,false,false);
 RETURN QUERY SELECT r.action_kind,r.id,r.state,r.created_at,r.expires_at FROM app.assistant_own_leave_review r WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND r.action_kind='rewards.cancel_review' ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_cancel_reviews_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_cancel_reviews_index() TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_cancel_scope(p_unit uuid,p_lock boolean DEFAULT false) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.reward_unit%ROWTYPE; fingerprint text;
BEGIN
 PERFORM app._assistant_rewards_cancel_review_identity(NULL,false);
 SELECT * INTO q FROM public.reward_unit WHERE id=p_unit AND tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN RAISE EXCEPTION 'Rewards cancellation unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_rewards_cancel_review_source((SELECT person_id FROM public.app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id()),q.id,q.company_id);
 IF p_lock THEN
  SELECT * INTO q FROM public.reward_unit WHERE id=p_unit AND tenant_id=app.current_tenant_id() FOR UPDATE NOWAIT;
  IF q.parent_unit_id IS NOT NULL THEN PERFORM 1 FROM public.reward_unit WHERE id=q.parent_unit_id AND tenant_id=q.tenant_id FOR UPDATE NOWAIT; END IF;
 END IF;
 SELECT encode(sha256(convert_to(to_jsonb(u)::text||':'||u.xmin::text,'UTF8')),'hex') INTO fingerprint FROM public.reward_unit u WHERE u.id=q.id AND u.tenant_id=q.tenant_id;
 RETURN jsonb_build_object('unitId',q.id,'companyId',q.company_id,'name',q.name,'revision',q.revision,'status',q.status,'fingerprint',fingerprint);
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_cancel_scope(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_cancel_scope(uuid,boolean) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_cancel_receipt(p_unit uuid,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE q public.reward_unit%ROWTYPE; d public.domain_event%ROWTYPE;
BEGIN
 PERFORM app.assistant_rewards_cancel_scope(p_unit,false);
 SELECT * INTO q FROM public.reward_unit WHERE id=p_unit AND tenant_id=app.current_tenant_id();
 SELECT * INTO d FROM public.domain_event WHERE id=p_event AND tenant_id=q.tenant_id AND aggregate_id=q.id AND aggregate_type='reward-unit' AND event_type='reward-unit.cancelled' AND actor_type='user' AND actor_id=app.current_user_id() AND subject_employment_id IS NULL;
 IF NOT FOUND OR q.status<>'withdrawn' OR q.revision<(d.payload->>'revision')::integer+1 THEN RAISE EXCEPTION 'Rewards cancellation unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('kind','cancelled','unitId',q.id,'eventId',d.id,'cancelledRevision',(d.payload->>'revision')::integer,'currentRevision',q.revision,'currentStatus',q.status,'proof','historical_cancellation_current_unit');
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_cancel_receipt(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_cancel_receipt(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_rewards_cancel_choices() RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE items jsonb;
BEGIN
 PERFORM app._assistant_rewards_cancel_review_identity(NULL,false);
 SELECT coalesce(jsonb_agg(jsonb_build_object('unitId',q.id,'name',q.name,'revision',q.revision,'status',q.status) ORDER BY q.name,q.id),'[]'::jsonb) INTO items
 FROM (SELECT u.* FROM public.reward_unit u WHERE u.tenant_id=app.current_tenant_id() AND u.deleted_at IS NULL AND u.status IN ('draft','bg','gr','ctro','ec','approved') AND (app.reward_admin(u.company_id) OR EXISTS(SELECT 1 FROM app.reward_roles(u.id) r(role) WHERE r.role='gr')) ORDER BY u.name,u.id LIMIT 21) q;
 RETURN jsonb_build_object('kind','choices','truncated',jsonb_array_length(items)>20,'units',CASE WHEN jsonb_array_length(items)>20 THEN items-20 ELSE items END);
END $$;
REVOKE ALL ON FUNCTION app.assistant_rewards_cancel_choices() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_rewards_cancel_choices() TO ai_hr_app;
--> statement-breakpoint
-- Extend only closed native-outcome predicates; retain all predecessor bodies and grants.
DO $$ DECLARE target regprocedure;definition text;marker text;replacement text;
BEGIN
 FOR target IN SELECT signature::regprocedure FROM unnest(ARRAY['app.native_outcome_review_completed(text,uuid)','app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)','app.native_outcome_completed_review_choices(jsonb)']) signature LOOP
 definition:=pg_get_functiondef(target);
 IF target='app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure THEN marker:='WHEN ''rewards.post'' THEN r.rewards_posted_event_id';replacement:=marker||' WHEN ''rewards.cancel_review'' THEN r.rewards_posted_event_id';
 ELSE marker:='''rewards.post''';replacement:=marker||',''rewards.cancel_review'''; END IF;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION '0731 unexpected outcome owner %',target;END IF;
 EXECUTE replace(definition,marker,replacement);
 END LOOP;
END $$;
