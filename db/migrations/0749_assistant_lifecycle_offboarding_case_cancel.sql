-- Coordinator allocated0749 /idx728 /when1793330000086. UNAPPLIED PROVISIONAL DEVELOPMENT ONLY.
-- One closed offboarding kind in the EXISTING physical encrypted ledger. No V9/outcome engine.
INSERT INTO app.assistant_action_kind(id,module,tier_ceiling,category,review_kind) VALUES
 ('lifecycle.offboarding.case.cancel','lifecycle','confirm','own_work','lifecycle.offboarding.case.cancel');
--> statement-breakpoint
-- Extend only the three predicates that reject the new nullable-case family. Freeze their names
-- before DDL; preserve every other dedicated guard and every predecessor expression once.
DO $$ DECLARE item record;previous text;scope_name text;case_name text;matches integer; BEGIN
 -- Inspect the raw catalog representation BEFORE rebuilding any predicate. Never deparse every
 -- ledger CHECK: inherited duplicated trees can be megabytes and dominate migration peak memory.
 FOR item IN SELECT conname,pg_column_size(conbin) AS bytes FROM pg_constraint
  WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c'
   AND conname IN ('assistant_own_leave_review_check','assistant_own_leave_review_check16','assistant_review_kind_columns') LOOP
  RAISE NOTICE '0749 raw conbin % bytes %',item.conname,item.bytes;
 END LOOP;
 -- Frozen held-ledger identities verified by the original aa600 migration notices. Installation
 -- reconciliation must revalidate these identities; refuse any unexpected predicate rather than guess.
 SELECT count(*),min(conname) INTO matches,scope_name FROM pg_constraint
 WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c' AND conname='assistant_own_leave_review_check';
 IF matches<>1 THEN RAISE EXCEPTION '0749: unexpected scope predicate';END IF;
 SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=scope_name;
 IF previous NOT LIKE '%testing_execution_id IS NOT NULL%' OR previous NOT LIKE '%employment_id IS NULL%' THEN RAISE EXCEPTION '0749: unexpected scope shape';END IF;
 SELECT count(*),min(conname) INTO matches,case_name FROM pg_constraint
 WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c' AND conname='assistant_own_leave_review_check16';
 IF matches<>1 THEN RAISE EXCEPTION '0749: unexpected lifecycle predicate';END IF;
 SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=case_name;
 IF previous NOT LIKE '%lifecycle_case_id IS NOT NULL%' THEN RAISE EXCEPTION '0749: unexpected lifecycle shape';END IF;
 FOR item IN SELECT * FROM (VALUES
  (scope_name,'company_id IS NOT NULL AND testing_execution_id IS NULL AND testing_run_id IS NULL AND testing_event_id IS NULL'),
  (case_name,'lifecycle_case_id IS NOT NULL AND ((state=''completed'')=(lifecycle_submitted_event_id IS NOT NULL))'),
  ('assistant_review_kind_columns','leave_request_id IS NULL AND submission_event_id IS NULL AND notification_event_id IS NULL AND profile_request_id IS NULL AND profile_requested_event_id IS NULL AND claim_draft_id IS NULL AND claim_saved_event_id IS NULL AND performance_ack_event_id IS NULL')
 ) requirements(name,expression) LOOP
  SELECT pg_get_expr(conbin,conrelid) INTO previous FROM pg_constraint WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=item.name;
  IF previous IS NULL THEN RAISE EXCEPTION '0749: missing predicate %',item.name;END IF;
  RAISE NOTICE '0749 bounded predicate % predecessor bytes %',item.name,octet_length(previous);
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',item.name);
  EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT %I CHECK (CASE WHEN action_kind=''lifecycle.offboarding.case.cancel'' THEN (%s) ELSE (%s) END)',item.name,item.expression,previous);
 END LOOP;
END $$;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD COLUMN offboarding_cancel_effect_commitment text,
 ADD COLUMN offboarding_cancel_case_version text;
--> statement-breakpoint
-- One private pending whole-effect commitment. The SAME shared custody/erasure state transition
-- scrubs it atomically; no private case/body fingerprint is added to native domain-event payloads.
CREATE FUNCTION app._assistant_case_cancel_scrub() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
 IF NEW.action_kind='lifecycle.offboarding.case.cancel' AND (NEW.state<>'awaiting_confirmation' OR NEW.intent_digest IS NULL OR NEW.reviewed_digest IS NULL) THEN NEW.offboarding_cancel_effect_commitment:=NULL;END IF;
 RETURN NEW;END $$;
REVOKE ALL ON FUNCTION app._assistant_case_cancel_scrub() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_case_cancel_private_scrub BEFORE UPDATE ON app.assistant_own_leave_review
 FOR EACH ROW EXECUTE FUNCTION app._assistant_case_cancel_scrub();
--> statement-breakpoint
DO $$ DECLARE unrelated text;BEGIN
 SELECT string_agg(format('%I IS NULL',attname),' AND ' ORDER BY attnum) INTO unrelated FROM pg_attribute
 WHERE attrelid='app.assistant_own_leave_review'::regclass AND attnum>0 AND NOT attisdropped
 AND attname<>ALL(ARRAY['action_kind','id','tenant_id','user_id','person_id','employment_id','company_id','intent_digest','reviewed_digest','state','created_at','expires_at','lifecycle_case_id','lifecycle_case_person_id','lifecycle_submitted_event_id','offboarding_cancel_effect_commitment','offboarding_cancel_case_version']);
 IF unrelated IS NULL THEN RAISE EXCEPTION '0749: predecessor custody columns missing';END IF;
 EXECUTE 'ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_offboarding_case_cancel_columns CHECK (CASE WHEN action_kind=''lifecycle.offboarding.case.cancel'' THEN
  lifecycle_case_id IS NOT NULL AND company_id IS NOT NULL
  AND ((state=''completed'')=(lifecycle_submitted_event_id IS NOT NULL))
  AND ((state=''completed'')=(offboarding_cancel_case_version IS NOT NULL))
  AND (offboarding_cancel_case_version IS NULL OR offboarding_cancel_case_version ~ ''^[0-9]+$'')
  AND ((state=''awaiting_confirmation'')=(offboarding_cancel_effect_commitment IS NOT NULL))
  AND (offboarding_cancel_effect_commitment IS NULL OR offboarding_cancel_effect_commitment ~ ''^[a-f0-9]{64}$'') AND ('||unrelated||')
 ELSE offboarding_cancel_effect_commitment IS NULL AND offboarding_cancel_case_version IS NULL END)';
END $$;
--> statement-breakpoint
-- FOR UPDATE on these actual parents conflicts with immediate FK KEY SHARE membership checks.
-- Refuse schema drift that could defer a new step/comment/return/item/asset past the source interval.
DO $$ DECLARE item record;child_att smallint;parent_att smallint;BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('lc_case_step','case_id','lc_case','id'),('lc_comment','case_id','lc_case','id'),('it_requisition','case_id','lc_case','id'),
  ('it_requisition_item','requisition_id','it_requisition','id'),('it_asset','requisition_id','it_requisition','id')) v(child,col,parent,parent_col) LOOP
  SELECT attnum INTO child_att FROM pg_attribute WHERE attrelid=('public.'||item.child)::regclass AND attname=item.col AND NOT attisdropped;
  SELECT attnum INTO parent_att FROM pg_attribute WHERE attrelid=('public.'||item.parent)::regclass AND attname=item.parent_col AND NOT attisdropped;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=('public.'||item.child)::regclass AND confrelid=('public.'||item.parent)::regclass
   AND contype='f' AND convalidated AND NOT condeferrable AND conkey=ARRAY[child_att] AND confkey=ARRAY[parent_att]) THEN
   RAISE EXCEPTION '0749: immediate membership FK unavailable %',item.child;END IF;
 END LOOP;
END $$;
--> statement-breakpoint
-- Native JS clean/UTF-16 length, applied only to already reviewed canonical reason text. The guarded
-- public preparation receives the native projection's normalized reason, never a model reason.
CREATE FUNCTION app._assistant_case_cancel_reason_valid(p_reason text) RETURNS boolean
 LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$ DECLARE units integer;BEGIN
 IF p_reason IS NULL OR char_length(p_reason) NOT BETWEEN 1 AND 500 OR p_reason IS DISTINCT FROM btrim(p_reason,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') THEN RETURN false;END IF;
 SELECT coalesce(sum(CASE WHEN ascii(ch)>65535 THEN 2 ELSE 1 END),0)::int INTO units FROM regexp_split_to_table(p_reason,'') ch;
 RETURN units<=500;
END $$;
REVOKE ALL ON FUNCTION app._assistant_case_cancel_reason_valid(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- PRIVATE: complete ordered related sets and physical versions. All rows are fenced/authorized by
-- source() before this function is called. Case has NO updated_at: only status/cancel_reason differ.
CREATE FUNCTION app._assistant_case_cancel_effect(p_case uuid,p_reason text,p_predicted boolean) RETURNS text
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(
  CASE WHEN p_predicted THEN to_jsonb(c)||jsonb_build_object('status','cancelled','cancel_reason',p_reason) ELSE to_jsonb(c) END,
  (SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(a),a.xmin::text) ORDER BY a.step_key),'[]'::jsonb) FROM public.lc_case_step a WHERE a.case_id=c.id),
  (SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(a),a.xmin::text) ORDER BY a.id),'[]'::jsonb) FROM public.lc_comment a WHERE a.case_id=c.id),
  (SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(a),a.xmin::text) ORDER BY a.id),'[]'::jsonb) FROM public.it_requisition a WHERE a.case_id=c.id),
  (SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(a),a.xmin::text) ORDER BY a.requisition_id,a.item_key),'[]'::jsonb) FROM public.it_requisition_item a JOIN public.it_requisition q ON q.id=a.requisition_id WHERE q.case_id=c.id),
  (SELECT coalesce(jsonb_agg(jsonb_build_array(to_jsonb(a),a.xmin::text) ORDER BY a.id),'[]'::jsonb) FROM public.it_asset a JOIN public.it_requisition q ON q.id=a.requisition_id WHERE q.case_id=c.id)
 )::text,'UTF8')),'hex') FROM public.lc_case c WHERE c.id=p_case AND c.tenant_id=app.current_tenant_id() AND c.kind='offboarding';
$$;
REVOKE ALL ON FUNCTION app._assistant_case_cancel_effect(uuid,text,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_offboarding_case_cancel_source(p_case uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE scope record;item record;c public.lc_case%ROWTYPE;stamp text;BEGIN
 PERFORM app._assistant_lifecycle_review_identity(NULL,false);
 LOCK TABLE public.lc_staff IN SHARE MODE NOWAIT;
 -- Direct strong parent locks: no SHARE→UPDATE upgrade. Immediate FK checks fence raw app phantoms.
 SELECT id,company_id INTO scope FROM public.lc_case WHERE id=p_case AND tenant_id=app.current_tenant_id() AND kind='offboarding' FOR UPDATE NOWAIT;
 IF NOT FOUND OR coalesce(app.lc_level(scope.company_id),0)<2 THEN RAISE EXCEPTION 'Case cancellation unavailable' USING ERRCODE='42501';END IF;
 FOR item IN SELECT id,tenant_id,company_id FROM public.it_requisition WHERE case_id=p_case ORDER BY id FOR UPDATE NOWAIT LOOP
  IF item.tenant_id<>app.current_tenant_id() OR coalesce(app.lc_level(item.company_id),0)<1 THEN RAISE EXCEPTION 'Case cancellation unavailable' USING ERRCODE='42501';END IF;
 END LOOP;
 PERFORM 1 FROM public.lc_case_step WHERE case_id=p_case ORDER BY step_key FOR SHARE NOWAIT;
 PERFORM 1 FROM public.lc_comment WHERE case_id=p_case ORDER BY id FOR SHARE NOWAIT;
 PERFORM 1 FROM public.it_requisition_item a JOIN public.it_requisition q ON q.id=a.requisition_id WHERE q.case_id=p_case ORDER BY a.requisition_id,a.item_key FOR SHARE OF a NOWAIT;
 FOR item IN SELECT a.id,a.tenant_id,a.company_id FROM public.it_asset a JOIN public.it_requisition q ON q.id=a.requisition_id WHERE q.case_id=p_case ORDER BY a.id FOR SHARE OF a NOWAIT LOOP
  IF item.tenant_id<>app.current_tenant_id() OR coalesce(app.lc_level(item.company_id),0)<1 THEN RAISE EXCEPTION 'Case cancellation unavailable' USING ERRCODE='42501';END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM public.lc_case_step WHERE case_id=p_case AND tenant_id<>app.current_tenant_id())
  OR EXISTS(SELECT 1 FROM public.lc_comment WHERE case_id=p_case AND tenant_id<>app.current_tenant_id())
  OR EXISTS(SELECT 1 FROM public.it_requisition_item a JOIN public.it_requisition q ON q.id=a.requisition_id WHERE q.case_id=p_case AND a.tenant_id<>app.current_tenant_id()) THEN
  RAISE EXCEPTION 'Case cancellation unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM public.lc_case WHERE id=p_case AND tenant_id=app.current_tenant_id();
 SELECT encode(sha256(convert_to(jsonb_build_array(app._assistant_case_cancel_effect(c.id,NULL,false),(SELECT xmin::text FROM public.lc_case WHERE id=c.id))::text,'UTF8')),'hex') INTO stamp;
 RETURN jsonb_build_object('caseId',c.id,'caseNumber',c.number,'casePersonId',c.person_id,'employmentId',c.employment_id,'companyId',c.company_id,'status',c.status,'sourceDigest',stamp);
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_case_cancel_source(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_case_cancel_source(uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app._assistant_case_cancel_review_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',jsonb_build_object('actionId',r.id,'action',r.action_kind,'contractVersion',1,
 'binding',jsonb_build_object('tenantId',r.tenant_id,'userId',r.user_id,'personId',r.person_id,'employmentId',r.employment_id,'companyId',r.company_id,'caseId',r.lifecycle_case_id,'casePersonId',r.lifecycle_case_person_id),
 'intentDigest',r.intent_digest,'reviewedDigest',r.reviewed_digest,'state',r.state,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 'sealed',CASE WHEN r.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN jsonb_build_object('formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,'eventId',r.lifecycle_submitted_event_id)
 FROM app.assistant_own_leave_review r LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=r.id
 WHERE r.id=p_id AND r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id()
 AND r.person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND r.action_kind='lifecycle.offboarding.case.cancel';
$$;
REVOKE ALL ON FUNCTION app._assistant_case_cancel_review_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_offboarding_case_cancel_review_prepare(p_id uuid,p_person uuid,p_case uuid,p_case_person uuid,p_employment uuid,p_company uuid,p_reason text,
 p_intent_digest text,p_reviewed_digest text,p_kid text,p_wrapped_dek text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source jsonb;at_time timestamptz;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();BEGIN
 PERFORM app._assistant_lifecycle_review_identity(p_person);
 source:=app.assistant_offboarding_case_cancel_source(p_case);
 IF source->>'status'<>'in_progress' OR app._assistant_case_cancel_reason_valid(p_reason) IS NOT TRUE THEN RAISE EXCEPTION 'Case cancellation unavailable' USING ERRCODE='42501';END IF;
 IF (source->>'casePersonId')::uuid IS DISTINCT FROM p_case_person OR (source->>'employmentId')::uuid IS DISTINCT FROM p_employment OR (source->>'companyId')::uuid IS DISTINCT FROM p_company THEN RAISE EXCEPTION 'Case cancellation unavailable' USING ERRCODE='42501';END IF;
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
 (action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,lifecycle_case_id,lifecycle_case_person_id,offboarding_cancel_effect_commitment,intent_digest,reviewed_digest,state,created_at,expires_at)
 VALUES('lifecycle.offboarding.case.cancel',p_id,t,u,p_person,p_employment,p_company,p_case,p_case_person,app._assistant_case_cancel_effect(p_case,p_reason,true),p_intent_digest,p_reviewed_digest,'awaiting_confirmation',at_time,at_time+interval '10 minutes') ON CONFLICT(id) DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'Case cancellation unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped_dek,p_ciphertext);
 RETURN app._assistant_case_cancel_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_case_cancel_review_prepare(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_case_cancel_review_prepare(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,text) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.assistant_offboarding_case_cancel_review_subject(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_lifecycle_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT person_id FROM public.app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id()) AND action_kind='lifecycle.offboarding.case.cancel';
 IF NOT FOUND THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_lifecycle_review_identity(r.person_id);RETURN jsonb_build_object('caseId',r.lifecycle_case_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_case_cancel_review_subject(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_case_cancel_review_subject(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_offboarding_case_cancel_review_read(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;source jsonb;
BEGIN
 PERFORM app._assistant_lifecycle_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT person_id FROM public.app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id()) AND action_kind='lifecycle.offboarding.case.cancel';
 IF NOT FOUND THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_lifecycle_review_identity(r.person_id);source:=app.assistant_offboarding_case_cancel_source(r.lifecycle_case_id);
 IF (source->>'casePersonId')::uuid IS DISTINCT FROM r.lifecycle_case_person_id OR (source->>'employmentId')::uuid IS DISTINCT FROM r.employment_id OR (source->>'companyId')::uuid IS DISTINCT FROM r.company_id THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=r.id FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at AND source->>'status'<>'in_progress' THEN RAISE EXCEPTION 'Case cancellation unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at THEN UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review a WHERE c.action_id=a.id AND a.id=r.id AND a.state<>'awaiting_confirmation';
 RETURN app._assistant_case_cancel_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_case_cancel_review_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_case_cancel_review_read(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_offboarding_case_cancel_review_discard(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_lifecycle_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND person_id IS NOT DISTINCT FROM (SELECT person_id FROM public.app_user WHERE id=app.current_user_id() AND tenant_id=app.current_tenant_id()) AND action_kind='lifecycle.offboarding.case.cancel' FOR UPDATE NOWAIT;
 IF NOT FOUND OR r.state='completed' THEN RAISE EXCEPTION 'Lifecycle review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' THEN
  UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;
 END IF;
 DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=r.id;
 RETURN jsonb_build_object('action','lifecycle.offboarding.case.cancel','contractVersion',1,'actionId',r.id,'state',r.state);
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_case_cancel_review_discard(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_case_cancel_review_discard(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_offboarding_case_cancel_reviews_index() RETURNS TABLE(action text,action_id uuid,state text,created_at timestamptz,expires_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_lifecycle_review_identity(NULL,false);
 RETURN QUERY SELECT r.action_kind,r.id,r.state,r.created_at,r.expires_at FROM app.assistant_own_leave_review r WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id()) AND r.action_kind='lifecycle.offboarding.case.cancel' ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_case_cancel_reviews_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_case_cancel_reviews_index() TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.assistant_offboarding_case_cancel_review_complete(p_id uuid,p_reviewed_digest text,p_case uuid,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;source jsonb;c public.lc_case%ROWTYPE;v text;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();BEGIN
 PERFORM app._assistant_lifecycle_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='lifecycle.offboarding.case.cancel'
  AND person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=u AND a.tenant_id=t);
 IF NOT FOUND OR p_case IS NULL OR p_case IS DISTINCT FROM r.lifecycle_case_id OR p_event IS NULL THEN RAISE EXCEPTION 'Case cancellation unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_lifecycle_review_identity(r.person_id);source:=app.assistant_offboarding_case_cancel_source(p_case);
 IF (source->>'casePersonId')::uuid IS DISTINCT FROM r.lifecycle_case_person_id OR (source->>'employmentId')::uuid IS DISTINCT FROM r.employment_id OR (source->>'companyId')::uuid IS DISTINCT FROM r.company_id THEN RAISE EXCEPTION 'Case cancellation unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=r.id FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Case cancellation unavailable' USING ERRCODE='42501';END IF;
 IF r.state='completed' THEN
  IF r.lifecycle_submitted_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Case cancellation unavailable' USING ERRCODE='42501';END IF;
  PERFORM app.assistant_offboarding_case_cancel_reference(r.id);
 ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
  IF p_reviewed_digest IS DISTINCT FROM r.reviewed_digest THEN RAISE EXCEPTION 'Case cancellation unavailable' USING ERRCODE='42501';END IF;
  SELECT * INTO c FROM public.lc_case WHERE id=p_case AND tenant_id=t;
  SELECT xmin::text INTO v FROM public.lc_case WHERE id=p_case AND tenant_id=t;
  IF c.status<>'cancelled' OR v IS DISTINCT FROM pg_current_xact_id()::xid::text
   OR app._assistant_case_cancel_reason_valid(c.cancel_reason) IS NOT TRUE
   OR app._assistant_case_cancel_effect(c.id,NULL,false) IS DISTINCT FROM r.offboarding_cancel_effect_commitment THEN
   RAISE EXCEPTION 'Case cancellation unavailable' USING ERRCODE='42501';END IF;
  IF (SELECT count(*) FROM public.domain_event d WHERE d.tenant_id=t AND d.aggregate_type='lifecycle-case' AND d.aggregate_id=p_case AND d.xmin=pg_current_xact_id()::xid)<>1
   OR NOT EXISTS(SELECT 1 FROM public.domain_event d WHERE d.id=p_event AND d.tenant_id=t AND d.aggregate_type='lifecycle-case' AND d.aggregate_id=p_case AND d.event_type='lifecycle-case.cancelled'
    AND d.actor_type='user' AND d.actor_id=u AND d.subject_employment_id IS NOT DISTINCT FROM c.employment_id
    AND d.payload=jsonb_build_object('action','case.cancelled','number',c.number) AND d.xmin=pg_current_xact_id()::xid)
   OR (SELECT count(*) FROM public.lc_history h WHERE h.tenant_id=t AND h.ref_type='case' AND h.ref_id=p_case AND h.xmin=pg_current_xact_id()::xid)<>1
   OR NOT EXISTS(SELECT 1 FROM public.lc_history h WHERE h.tenant_id=t AND h.ref_type='case' AND h.ref_id=p_case AND h.action='case.cancelled' AND h.actor_user_id=u
    AND h.detail=jsonb_build_object('reason',c.cancel_reason) AND h.xmin=pg_current_xact_id()::xid) THEN
   RAISE EXCEPTION 'Case cancellation unavailable' USING ERRCODE='42501';END IF;
  UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,lifecycle_submitted_event_id=p_event,offboarding_cancel_case_version=v WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 ELSE RAISE EXCEPTION 'Case cancellation unavailable' USING ERRCODE='42501';END IF;
 RETURN app._assistant_case_cancel_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_case_cancel_review_complete(uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_case_cancel_review_complete(uuid,text,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_offboarding_case_cancel_reference(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;source jsonb;c public.lc_case%ROWTYPE;v text;BEGIN
 PERFORM app._assistant_lifecycle_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='lifecycle.offboarding.case.cancel'
  AND person_id IS NOT DISTINCT FROM (SELECT a.person_id FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=app.current_tenant_id());
 IF NOT FOUND OR r.state<>'completed' THEN RAISE EXCEPTION 'Case cancellation unavailable' USING ERRCODE='42501';END IF;
 source:=app.assistant_offboarding_case_cancel_source(r.lifecycle_case_id);
 SELECT * INTO c FROM public.lc_case WHERE id=r.lifecycle_case_id AND tenant_id=r.tenant_id;
 SELECT xmin::text INTO v FROM public.lc_case WHERE id=c.id AND tenant_id=c.tenant_id;
 IF c.status<>'cancelled' OR v IS DISTINCT FROM r.offboarding_cancel_case_version OR c.person_id IS DISTINCT FROM r.lifecycle_case_person_id
  OR c.employment_id IS DISTINCT FROM r.employment_id OR c.company_id IS DISTINCT FROM r.company_id THEN RAISE EXCEPTION 'Case cancellation unavailable' USING ERRCODE='42501';END IF;
 IF (SELECT count(*) FROM public.domain_event d WHERE d.tenant_id=r.tenant_id AND d.aggregate_type='lifecycle-case' AND d.aggregate_id=c.id AND d.xmin::text=v)<>1
  OR NOT EXISTS(SELECT 1 FROM public.domain_event d WHERE d.id=r.lifecycle_submitted_event_id AND d.tenant_id=r.tenant_id AND d.aggregate_type='lifecycle-case' AND d.aggregate_id=c.id
   AND d.event_type='lifecycle-case.cancelled' AND d.actor_type='user' AND d.actor_id=r.user_id AND d.subject_employment_id IS NOT DISTINCT FROM c.employment_id
   AND d.payload=jsonb_build_object('action','case.cancelled','number',c.number) AND d.xmin::text=v)
  OR (SELECT count(*) FROM public.lc_history h WHERE h.tenant_id=r.tenant_id AND h.ref_type='case' AND h.ref_id=c.id AND h.xmin::text=v)<>1
  OR NOT EXISTS(SELECT 1 FROM public.lc_history h WHERE h.tenant_id=r.tenant_id AND h.ref_type='case' AND h.ref_id=c.id AND h.action='case.cancelled' AND h.actor_user_id=r.user_id
   AND h.detail=jsonb_build_object('reason',c.cancel_reason) AND h.xmin::text=v) THEN RAISE EXCEPTION 'Case cancellation unavailable' USING ERRCODE='42501';END IF;
 RETURN jsonb_build_object('caseId',c.id,'status','cancelled','eventId',r.lifecycle_submitted_event_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_offboarding_case_cancel_reference(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_offboarding_case_cancel_reference(uuid) TO ai_hr_app;

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
   replacement:=marker||' WHEN ''lifecycle.offboarding.case.cancel'' THEN r.lifecycle_submitted_event_id';
  ELSE marker:='''lifecycle.acknowledgement.submit''';replacement:=marker||',''lifecycle.offboarding.case.cancel'''; END IF;
  IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN RAISE EXCEPTION '0749: unexpected outcome mapping %',target;END IF;
  EXECUTE replace(definition,marker,replacement);
 END LOOP;
END $$;
