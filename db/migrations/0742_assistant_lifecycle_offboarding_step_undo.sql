-- Coordinator allocated0742 /idx721 /when1793330000079. UNAPPLIED PROVISIONAL DEVELOPMENT ONLY.
-- One closed offboarding kind in the EXISTING physical encrypted ledger. No V9/outcome engine.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES
 ('lifecycle.offboarding.step.undo','lifecycle','confirm','own_work','lifecycle.offboarding.step.undo');
--> statement-breakpoint
-- Extend only the three predicates that reject the new nullable-case family. Freeze their names
-- before DDL; preserve every other dedicated guard and every predecessor expression once.
DO $$ DECLARE item record;previous text;scope_name text;case_name text;matches integer; BEGIN
 SELECT count(*),min(conname) INTO matches,scope_name FROM pg_constraint
 WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c'
 AND pg_get_expr(conbin,conrelid) LIKE '%testing_execution_id IS NOT NULL%'
 AND pg_get_expr(conbin,conrelid) LIKE '%employment_id IS NULL%';
 IF matches<>1 THEN RAISE EXCEPTION '0742: unexpected scope predicate';END IF;
 SELECT count(*),min(conname) INTO matches,case_name FROM pg_constraint
 WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c'
 AND conname<>'assistant_offboarding_step_columns' AND pg_get_expr(conbin,conrelid) LIKE '%lifecycle_case_id IS NOT NULL%';
 IF matches<>1 THEN RAISE EXCEPTION '0742: unexpected lifecycle predicate';END IF;
 FOR item IN SELECT * FROM (VALUES
  (scope_name,'company_id IS NOT NULL AND testing_execution_id IS NULL AND testing_run_id IS NULL AND testing_event_id IS NULL'),
  (case_name,'lifecycle_case_id IS NOT NULL AND ((state=''completed'')=(lifecycle_submitted_event_id IS NOT NULL))'),
  ('assistant_review_kind_columns','leave_request_id IS NULL AND submission_event_id IS NULL AND notification_event_id IS NULL AND profile_request_id IS NULL AND profile_requested_event_id IS NULL AND claim_draft_id IS NULL AND claim_saved_event_id IS NULL AND performance_ack_event_id IS NULL')
 ) requirements(name,expression) LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=item.name;
  IF previous IS NULL THEN RAISE EXCEPTION '0742: missing predicate %',item.name;END IF;
  RAISE NOTICE '0742 bounded predicate % predecessor bytes %',item.name,octet_length(previous);
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',item.name);
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK (CASE WHEN action_kind=''lifecycle.offboarding.step.undo'' THEN (%s) ELSE (%s) END)',item.name,item.expression,previous);
 END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD COLUMN offboarding_undo_step_key text,
 ADD COLUMN offboarding_undo_expect_reopening boolean,ADD COLUMN offboarding_undo_case_event_id uuid UNIQUE;
--> statement-breakpoint
-- Explicit closed set of this kind's columns. Every actual foreign dedicated/receipt/scope column
-- must be NULL, including later predecessor extensions, without copying their predicate trees.
DO $$ DECLARE unrelated text; BEGIN
 SELECT string_agg(format('%I IS NULL',attname),' AND ' ORDER BY attnum) INTO unrelated FROM pg_attribute
 WHERE attrelid='app.assistant_own_leave_review'::regclass AND attnum>0 AND NOT attisdropped
 AND attname<>ALL(ARRAY['action_kind','id','tenant_id','user_id','person_id','employment_id','company_id','intent_digest','reviewed_digest','state','created_at','expires_at','lifecycle_case_id','lifecycle_case_person_id','lifecycle_submitted_event_id','offboarding_undo_step_key','offboarding_undo_expect_reopening','offboarding_undo_case_event_id']);
 IF unrelated IS NULL THEN RAISE EXCEPTION '0742: predecessor custody columns missing';END IF;
 EXECUTE 'ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_offboarding_step_undo_columns CHECK (CASE WHEN action_kind=''lifecycle.offboarding.step.undo'' THEN
  lifecycle_case_id IS NOT NULL AND company_id IS NOT NULL AND offboarding_undo_step_key IS NOT NULL AND length(offboarding_undo_step_key) BETWEEN 1 AND 100 AND offboarding_undo_step_key<>''resign_outcome'' AND offboarding_undo_expect_reopening IS NOT NULL
  AND ((state=''completed'')=(lifecycle_submitted_event_id IS NOT NULL))
  AND ((offboarding_undo_case_event_id IS NOT NULL)=(state=''completed'' AND offboarding_undo_expect_reopening)) AND ('||unrelated||')
 ELSE offboarding_undo_step_key IS NULL AND offboarding_undo_expect_reopening IS NULL AND offboarding_undo_case_event_id IS NULL END)';
END $$;
--> statement-breakpoint
CREATE FUNCTION app.assistant_offboarding_step_undo_source(p_case uuid,p_step text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE company_scope uuid;result jsonb; BEGIN
 PERFORM app._assistant_lifecycle_review_identity(NULL,false);
 LOCK TABLE public.lc_staff IN SHARE MODE NOWAIT;
 SELECT company_id INTO company_scope FROM public.lc_case WHERE id=p_case AND tenant_id=app.current_tenant_id() AND kind='offboarding' FOR SHARE NOWAIT;
 IF NOT FOUND OR coalesce(app.lc_level(company_scope),0)<2 THEN RAISE EXCEPTION 'Lifecycle undo review unavailable' USING ERRCODE='42501';END IF;
 result:=app.assistant_offboarding_step_source(p_case,p_step);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_step_undo_source(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_step_undo_source(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_offboarding_step_undo_review_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',jsonb_build_object('actionId',r.id,'action',r.action_kind,'contractVersion',1,
 'binding',jsonb_build_object('tenantId',r.tenant_id,'userId',r.user_id,'personId',r.person_id,'employmentId',r.employment_id,'companyId',r.company_id,'caseId',r.lifecycle_case_id,'casePersonId',r.lifecycle_case_person_id,'stepKey',r.offboarding_undo_step_key),
 'intentDigest',r.intent_digest,'reviewedDigest',r.reviewed_digest,'state',r.state,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 'sealed',CASE WHEN r.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN jsonb_build_object('formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,
 'eventId',r.lifecycle_submitted_event_id,'reopeningEventId',r.offboarding_undo_case_event_id,'expectedReopening',r.offboarding_undo_expect_reopening)
 FROM app.assistant_own_leave_review r LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=r.id WHERE r.id=p_id AND r.person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND r.action_kind='lifecycle.offboarding.step.undo';
$$;
REVOKE ALL ON FUNCTION app._assistant_offboarding_step_undo_review_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_offboarding_step_undo_review_prepare(p_id uuid,p_person uuid,p_case uuid,p_case_person uuid,p_employment uuid,p_company uuid,p_step text,p_expect_reopening boolean,
 p_intent_digest text,p_reviewed_digest text,p_kid text,p_wrapped_dek text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb;at_time timestamptz;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 PERFORM app._assistant_lifecycle_review_identity(p_person);
 source:=app.assistant_offboarding_step_undo_source(p_case,p_step);
 IF source->>'status' NOT IN ('in_progress','completed') OR p_expect_reopening IS NULL OR p_expect_reopening IS DISTINCT FROM (source->>'status'='completed') OR NOT EXISTS(SELECT 1 FROM public.lc_case_step WHERE tenant_id=t AND case_id=p_case AND step_key=p_step AND done) THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 IF (source->>'casePersonId')::uuid IS DISTINCT FROM p_case_person OR (source->>'employmentId')::uuid IS DISTINCT FROM p_employment OR (source->>'companyId')::uuid IS DISTINCT FROM p_company THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 -- A preparation in the same privacy-erasure transaction must not create new uncaptured private text.
 IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id()
  AND i.tenant_id=t AND (i.person_id=p_person OR i.person_id=p_case_person OR app._assistant_lifecycle_review_person(p_case,i.person_id,t)))
  OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id()
   AND i.tenant_id=t AND (i.person_id=p_person OR i.person_id=p_case_person OR app._assistant_lifecycle_review_person(p_case,i.person_id,t))) THEN
  RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 IF p_id IS NULL OR p_intent_digest IS NULL OR p_intent_digest !~ '^[a-f0-9]{64}$'
  OR p_reviewed_digest IS NULL OR p_reviewed_digest !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$'
  OR p_wrapped_dek IS NULL OR length(p_wrapped_dek) NOT BETWEEN 1 AND 512
  OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN
  RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='22023';END IF;
 at_time:=clock_timestamp();
 -- Private review admission is separate from model quota. The identity owner already holds the
 -- tenant Access lock, serializing competing preparations and privacy/custody transitions. Bounds
 -- apply to this login only: at most five unexpired pending reviews and twenty preparations per
 -- rolling ten minutes. Discard/expiry cannot reset the creation-rate budget. SQL owns every time.
 IF (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u
   AND state='awaiting_confirmation' AND expires_at>at_time)>=5
  OR (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u
   AND created_at>at_time-interval '10 minutes')>=20 THEN
  RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='54000';END IF;
 INSERT INTO app.assistant_own_leave_review
  (action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,lifecycle_case_id,lifecycle_case_person_id,offboarding_undo_step_key,offboarding_undo_expect_reopening,intent_digest,reviewed_digest,state,created_at,expires_at)
 VALUES('lifecycle.offboarding.step.undo',p_id,t,u,p_person,p_employment,p_company,p_case,p_case_person,p_step,p_expect_reopening,
  p_intent_digest,p_reviewed_digest,'awaiting_confirmation',at_time,at_time+interval '10 minutes') ON CONFLICT(id) DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped_dek,p_ciphertext);
 RETURN app._assistant_offboarding_step_undo_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_step_undo_review_prepare(uuid,uuid,uuid,uuid,uuid,uuid,text,boolean,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_step_undo_review_prepare(uuid,uuid,uuid,uuid,uuid,uuid,text,boolean,text,text,text,text,text) TO ai_hr_app;

--> statement-breakpoint
-- Nomination-only current login metadata; no body/case facts before the source-owned interval.
CREATE FUNCTION app.assistant_offboarding_step_undo_review_subject(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_lifecycle_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT person_id FROM public.app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id()) AND action_kind='lifecycle.offboarding.step.undo';
 IF NOT FOUND THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_lifecycle_review_identity(r.person_id);RETURN jsonb_build_object('caseId',r.lifecycle_case_id,'stepKey',r.offboarding_undo_step_key);
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_step_undo_review_subject(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_step_undo_review_subject(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_offboarding_step_undo_review_read(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;source jsonb;
BEGIN
 PERFORM app._assistant_lifecycle_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT person_id FROM public.app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id()) AND action_kind='lifecycle.offboarding.step.undo';
 IF NOT FOUND THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_lifecycle_review_identity(r.person_id);source:=app.assistant_offboarding_step_undo_source(r.lifecycle_case_id,r.offboarding_undo_step_key);
 IF (source->>'casePersonId')::uuid IS DISTINCT FROM r.lifecycle_case_person_id OR (source->>'employmentId')::uuid IS DISTINCT FROM r.employment_id OR (source->>'companyId')::uuid IS DISTINCT FROM r.company_id THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=r.id FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at THEN UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review a WHERE c.action_id=a.id AND a.id=r.id AND a.state<>'awaiting_confirmation';
 RETURN app._assistant_offboarding_step_undo_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_step_undo_review_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_step_undo_review_read(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_offboarding_step_undo_review_complete(p_id uuid,p_reviewed_digest text,p_case uuid,p_event uuid,p_reopening uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;source jsonb;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 PERFORM app._assistant_lifecycle_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND person_id IS NOT DISTINCT FROM (SELECT person_id FROM public.app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id()) AND action_kind='lifecycle.offboarding.step.undo';
 IF NOT FOUND OR p_case IS NULL OR p_case IS DISTINCT FROM r.lifecycle_case_id OR p_event IS NULL THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_lifecycle_review_identity(r.person_id);source:=app.assistant_offboarding_step_undo_source(p_case,r.offboarding_undo_step_key);
 IF (source->>'casePersonId')::uuid IS DISTINCT FROM r.lifecycle_case_person_id OR (source->>'employmentId')::uuid IS DISTINCT FROM r.employment_id OR (source->>'companyId')::uuid IS DISTINCT FROM r.company_id THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=r.id FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='completed' THEN
  IF r.lifecycle_submitted_event_id IS DISTINCT FROM p_event OR r.offboarding_undo_case_event_id IS DISTINCT FROM p_reopening THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
  IF p_reviewed_digest IS DISTINCT FROM r.reviewed_digest THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
  IF (p_reopening IS NOT NULL) IS DISTINCT FROM r.offboarding_undo_expect_reopening OR p_event=p_reopening THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.lc_case c JOIN public.lc_case_step a ON a.case_id=c.id AND a.tenant_id=c.tenant_id AND a.step_key=r.offboarding_undo_step_key AND NOT a.done AND a.done_by IS NULL AND a.done_at IS NULL
   JOIN public.domain_event d ON d.id=p_event AND d.tenant_id=c.tenant_id AND d.aggregate_type='lifecycle-case' AND d.aggregate_id=c.id AND d.event_type='lifecycle-case.step-undone' AND d.actor_type='user' AND d.actor_id=u
    AND d.subject_employment_id IS NOT DISTINCT FROM c.employment_id AND d.payload->>'action'='step.undone' AND d.payload->>'number'=c.number AND d.payload->>'step'=a.step_key AND d.payload->>'stepRowHash'=encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex') AND d.payload->>'stepRowVersion'=a.xmin::text
   JOIN public.lc_history h ON h.ref_type='case' AND h.ref_id=c.id AND h.tenant_id=c.tenant_id AND h.action='step.undone' AND h.actor_user_id=u AND h.detail->>'key'=a.step_key
   WHERE c.id=p_case AND c.tenant_id=t AND c.kind='offboarding' AND c.status='in_progress'
    AND c.person_id IS NOT DISTINCT FROM r.lifecycle_case_person_id AND c.employment_id IS NOT DISTINCT FROM r.employment_id AND c.company_id=r.company_id
    AND a.xmin=pg_current_xact_id()::xid AND h.xmin=pg_current_xact_id()::xid AND d.xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
  IF r.offboarding_undo_expect_reopening THEN
   IF NOT EXISTS(SELECT 1 FROM public.domain_event d JOIN public.lc_case c ON c.id=d.aggregate_id AND c.tenant_id=d.tenant_id
    JOIN public.lc_history h ON h.ref_id=c.id AND h.tenant_id=c.tenant_id AND h.ref_type='case' AND h.action='case.reverted' AND h.actor_user_id=u AND h.xmin=pg_current_xact_id()::xid
    WHERE d.id=p_reopening AND c.id=p_case AND c.tenant_id=t AND c.status='in_progress' AND c.completed_at IS NULL AND c.xmin=pg_current_xact_id()::xid
     AND d.aggregate_type='lifecycle-case' AND d.event_type='lifecycle-case.reopened' AND d.actor_type='user' AND d.actor_id=u AND d.subject_employment_id IS NOT DISTINCT FROM c.employment_id
     AND d.payload=jsonb_build_object('action','case.reverted','number',c.number,'kind','offboarding') AND d.xmin=pg_current_xact_id()::xid)
    THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
  ELSIF EXISTS(SELECT 1 FROM public.domain_event d WHERE d.tenant_id=t AND d.aggregate_id=p_case AND d.event_type='lifecycle-case.reopened' AND d.xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
  UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,lifecycle_submitted_event_id=p_event,offboarding_undo_case_event_id=p_reopening WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 ELSE RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 RETURN app._assistant_offboarding_step_undo_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_step_undo_review_complete(uuid,text,uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_step_undo_review_complete(uuid,text,uuid,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_offboarding_step_undo_review_discard(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_lifecycle_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT person_id FROM public.app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id()) AND action_kind='lifecycle.offboarding.step.undo' FOR UPDATE NOWAIT;
 IF NOT FOUND OR r.state='completed' THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' THEN
  UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;
 END IF;
 DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=r.id;
 RETURN jsonb_build_object('action','lifecycle.offboarding.step.undo','contractVersion',1,'actionId',r.id,'state',r.state);
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_step_undo_review_discard(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_step_undo_review_discard(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_offboarding_step_undo_reviews_index() RETURNS TABLE(action text,action_id uuid,state text,created_at timestamptz,expires_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_lifecycle_review_identity(NULL,false);
 RETURN QUERY SELECT r.action_kind,r.id,r.state,r.created_at,r.expires_at FROM app.assistant_own_leave_review r WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND r.action_kind='lifecycle.offboarding.step.undo' ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_step_undo_reviews_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_step_undo_reviews_index() TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.assistant_offboarding_step_undo_reference(p_case uuid,p_step text,p_event uuid,p_reopening uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb;c public.lc_case%ROWTYPE; BEGIN
 source:=app.assistant_offboarding_step_undo_source(p_case,p_step);
 SELECT * INTO c FROM public.lc_case WHERE id=p_case AND tenant_id=app.current_tenant_id();
 IF c.status<>'in_progress' OR NOT EXISTS(SELECT 1 FROM public.lc_case_step a JOIN public.domain_event d ON d.aggregate_id=a.case_id AND d.tenant_id=a.tenant_id
  WHERE a.case_id=c.id AND a.tenant_id=c.tenant_id AND a.step_key=p_step AND NOT a.done AND a.done_by IS NULL AND a.done_at IS NULL
   AND d.id=p_event AND d.aggregate_type='lifecycle-case' AND d.event_type='lifecycle-case.step-undone' AND d.actor_type='user' AND d.actor_id=app.current_user_id()
   AND d.subject_employment_id IS NOT DISTINCT FROM c.employment_id AND d.payload->>'action'='step.undone' AND d.payload->>'number'=c.number AND d.payload->>'step'=p_step AND d.payload->>'stepRowHash'=encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex') AND d.payload->>'stepRowVersion'=a.xmin::text)
  OR (p_reopening IS NOT NULL AND (c.status<>'in_progress' OR NOT EXISTS(SELECT 1 FROM public.domain_event d WHERE d.id=p_reopening AND d.tenant_id=c.tenant_id AND d.aggregate_id=c.id AND d.aggregate_type='lifecycle-case' AND d.event_type='lifecycle-case.reopened' AND d.actor_type='user' AND d.actor_id=app.current_user_id() AND d.subject_employment_id IS NOT DISTINCT FROM c.employment_id)))
 THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('caseId',c.id,'stepKey',p_step,'status','in_progress','stepEventId',p_event,'reopeningEventId',p_reopening);
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_step_undo_reference(uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_step_undo_reference(uuid,text,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Extend only the three closed learning/discovery owner mappings; preserve all predecessor bodies.
DO $$ DECLARE target regprocedure;definition text;marker text;replacement text; BEGIN
 FOR target IN SELECT signature::regprocedure FROM unnest(ARRAY[
  'app.native_outcome_review_completed(text,uuid)',
  'app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)',
  'app.native_outcome_completed_review_choices(jsonb)']) signature LOOP
  definition:=pg_get_functiondef(target);
  IF target='app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid)'::regprocedure THEN
   marker:='WHEN ''lifecycle.acknowledgement.submit'' THEN r.lifecycle_submitted_event_id';
   replacement:=marker||' WHEN ''lifecycle.offboarding.step.undo'' THEN r.lifecycle_submitted_event_id';
  ELSE marker:='''lifecycle.acknowledgement.submit''';replacement:=marker||',''lifecycle.offboarding.step.undo'''; END IF;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION '0742: unexpected outcome mapping %',target;END IF;
  EXECUTE replace(definition,marker,replacement);
 END LOOP;
END $$;
