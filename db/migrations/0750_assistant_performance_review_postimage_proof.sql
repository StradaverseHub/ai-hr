-- UNAPPLIED PROVISIONAL DEVELOPMENT ONLY: 0750 / idx729 / version7 / when1793330000087.
-- Only three existing Performance kinds change. Historical migration bytes remain immutable.
ALTER TABLE app.assistant_own_leave_review
 ADD COLUMN performance_postimage_version integer,
 ADD COLUMN performance_postimage_unchanged text,
 ADD COLUMN performance_postimage_notes text,
 ADD COLUMN performance_postimage_mode text,
 ADD COLUMN performance_postimage_event_id uuid,
 ADD COLUMN performance_postimage_root_xid xid8;
--> statement-breakpoint
-- NULL version denotes unqualified historical rows, never a legacy proof fallback.
ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_performance_postimage_columns CHECK(
 CASE WHEN action_kind IN ('performance.goal.approve','performance.checkin.cancel','performance.checkin.complete') THEN
  (performance_postimage_version IS NULL AND performance_postimage_unchanged IS NULL AND performance_postimage_notes IS NULL AND performance_postimage_mode IS NULL AND performance_postimage_event_id IS NULL AND performance_postimage_root_xid IS NULL)
  OR (performance_postimage_version IS NOT NULL AND performance_postimage_version=1 AND (
   (state='awaiting_confirmation' AND performance_postimage_unchanged IS NOT NULL AND performance_postimage_unchanged ~ '^[a-f0-9]{64}$' AND performance_postimage_event_id IS NULL AND performance_postimage_root_xid IS NULL
    AND CASE WHEN action_kind='performance.checkin.complete' THEN performance_postimage_notes IS NOT NULL AND performance_postimage_notes ~ '^[a-f0-9]{64}$' AND performance_postimage_mode IS NOT NULL AND performance_postimage_mode IN ('preserve','replace')
     ELSE performance_postimage_notes IS NULL AND performance_postimage_mode IS NULL END)
   OR (state<>'awaiting_confirmation' AND performance_postimage_unchanged IS NULL AND performance_postimage_notes IS NULL AND performance_postimage_mode IS NULL
    AND CASE WHEN state='completed' THEN performance_postimage_event_id IS NOT NULL AND performance_postimage_event_id=receipt_event_id AND performance_postimage_root_xid IS NOT NULL ELSE performance_postimage_event_id IS NULL AND performance_postimage_root_xid IS NULL END)))
 ELSE performance_postimage_version IS NULL AND performance_postimage_unchanged IS NULL AND performance_postimage_notes IS NULL AND performance_postimage_mode IS NULL AND performance_postimage_event_id IS NULL AND performance_postimage_root_xid IS NULL END);
--> statement-breakpoint
-- Pure typed serialization alone uses UTC. Authority/current_date owners keep their caller timezone.
CREATE FUNCTION app._performance_goal_unchanged(p public.performance_goal) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
 SELECT encode(sha256(convert_to((to_jsonb(p)-ARRAY['approval_status','approved_by_user_id','approved_at','updated_at'])::text,'UTF8')),'hex');
$$;
CREATE FUNCTION app._performance_checkin_unchanged(p public.performance_checkin,p_completion boolean) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp SET TimeZone='UTC' AS $$
 SELECT encode(sha256(convert_to((to_jsonb(p)-CASE WHEN p_completion THEN ARRAY['status','completed_at','notes'] ELSE ARRAY['status'] END)::text,'UTF8')),'hex');
$$;
CREATE FUNCTION app._performance_notes_commitment(p_notes text) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(1,p_notes)::text,'UTF8')),'hex');
$$;
REVOKE ALL ON FUNCTION app._performance_goal_unchanged(public.performance_goal) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._performance_checkin_unchanged(public.performance_checkin,boolean) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._performance_notes_commitment(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._performance_review_scope(p_kind text,p_subject uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_leave_decision_login();
 PERFORM app.access_workforce_write_lock();
 IF CASE p_kind
 WHEN 'performance.goal.approve' THEN app.assistant_goal_approval_choice_scope(p_subject)
 WHEN 'performance.checkin.cancel' THEN app.assistant_checkin_cancel_choice_scope(p_subject)
 WHEN 'performance.checkin.complete' THEN app.assistant_checkin_complete_choice_scope(p_subject)
 ELSE false END IS NOT TRUE THEN RAISE EXCEPTION 'Performance review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._performance_review_scope(text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_performance_review_expected(p_kind text,p_subject uuid,p_mode text DEFAULT NULL,p_replacement text DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE g public.performance_goal%ROWTYPE;c public.performance_checkin%ROWTYPE;unchanged text;notes text;
BEGIN
 PERFORM app._performance_review_scope(p_kind,p_subject);
 IF p_kind='performance.goal.approve' THEN
  IF p_mode IS NOT NULL OR p_replacement IS NOT NULL THEN RAISE EXCEPTION 'Unexpected Performance input' USING ERRCODE='22023';END IF;
  SELECT * INTO g FROM public.performance_goal WHERE id=p_subject AND tenant_id=app.current_tenant_id() FOR UPDATE;
  IF NOT FOUND OR g.approval_status<>'proposed' THEN RAISE EXCEPTION 'Performance review unavailable' USING ERRCODE='42501';END IF;
  unchanged:=app._performance_goal_unchanged(g);
 ELSE
  SELECT * INTO c FROM public.performance_checkin WHERE id=p_subject AND tenant_id=app.current_tenant_id() FOR UPDATE;
  IF NOT FOUND OR c.status<>'scheduled' THEN RAISE EXCEPTION 'Performance review unavailable' USING ERRCODE='42501';END IF;
  unchanged:=app._performance_checkin_unchanged(c,p_kind='performance.checkin.complete');
  IF p_kind='performance.checkin.complete' THEN
   IF p_mode IS NULL OR p_mode NOT IN ('preserve','replace') OR (p_mode='replace' AND (p_replacement IS NULL OR p_replacement=''))
   THEN RAISE EXCEPTION 'Explicit notes choice required' USING ERRCODE='22023';END IF;
   -- No SQL trim clone: replace is admitted human input already normalized by the native JS owner.
   -- A supplied purported preserved value is deliberately ignored.
   notes:=app._performance_notes_commitment(CASE WHEN p_mode='preserve' THEN c.notes ELSE p_replacement END);
  ELSIF p_mode IS NOT NULL OR p_replacement IS NOT NULL THEN RAISE EXCEPTION 'Unexpected Performance input' USING ERRCODE='22023';END IF;
 END IF;
 RETURN jsonb_build_object('version',1,'unchanged',unchanged,'notes',notes,'notesMode',p_mode);
END $$;
REVOKE ALL ON FUNCTION app.assistant_performance_review_expected(text,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_performance_review_expected(text,uuid,text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._performance_postimage_matches(p_kind text,p_subject uuid,p_proof jsonb,p_completed_at timestamptz DEFAULT NULL) RETURNS boolean
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE g public.performance_goal%ROWTYPE;c public.performance_checkin%ROWTYPE;
BEGIN
 IF p_proof->>'version' IS DISTINCT FROM '1' OR p_proof->>'unchanged' IS NULL THEN RETURN false;END IF;
 IF p_kind='performance.goal.approve' THEN
  SELECT * INTO g FROM public.performance_goal WHERE id=p_subject AND tenant_id=app.current_tenant_id();
  RETURN FOUND AND g.approval_status='approved' AND g.approved_by_user_id=app.current_user_id()
   AND g.approved_at=transaction_timestamp() AND g.updated_at=transaction_timestamp() AND app._performance_goal_unchanged(g)=p_proof->>'unchanged';
 ELSIF p_kind IN ('performance.checkin.cancel','performance.checkin.complete') THEN
  SELECT * INTO c FROM public.performance_checkin WHERE id=p_subject AND tenant_id=app.current_tenant_id();
  IF NOT FOUND OR app._performance_checkin_unchanged(c,p_kind='performance.checkin.complete') IS DISTINCT FROM p_proof->>'unchanged' THEN RETURN false;END IF;
  IF p_kind='performance.checkin.cancel' THEN RETURN c.status='cancelled';END IF;
  RETURN c.status='completed' AND p_completed_at IS NOT NULL AND c.completed_at=p_completed_at AND app._performance_notes_commitment(c.notes)=p_proof->>'notes';
 END IF;RETURN false;
END $$;
REVOKE ALL ON FUNCTION app._performance_postimage_matches(text,uuid,jsonb,timestamptz) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_performance_review_assert(p_kind text,p_subject uuid,p_proof jsonb,p_completed_at timestamptz DEFAULT NULL) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._performance_review_scope(p_kind,p_subject);
 IF app._performance_postimage_matches(p_kind,p_subject,p_proof,p_completed_at) IS NOT TRUE THEN RAISE EXCEPTION 'The Performance postimage changed' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app.assistant_performance_review_assert(text,uuid,jsonb,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_performance_review_assert(text,uuid,jsonb,timestamptz) TO ai_hr_app;
--> statement-breakpoint
-- Retire every pre-proof pending packet; never retrofit a commitment from today's row.
WITH retired AS (UPDATE app.assistant_own_leave_review SET state='refused',intent_digest=NULL,reviewed_digest=NULL
 WHERE action_kind IN ('performance.goal.approve','performance.checkin.cancel','performance.checkin.complete') AND state='awaiting_confirmation' AND performance_postimage_version IS NULL RETURNING id)
DELETE FROM app.assistant_own_leave_review_content WHERE action_id IN (SELECT id FROM retired);
--> statement-breakpoint
-- Sensitive commitments are transient: clear on every retirement AND completion. Canonical erasure
-- also passes through this sanitizer even when the ciphertext was already deleted. Only minimal
-- proof version/original event references survive a successfully verified completion.
CREATE FUNCTION app._performance_postimage_retire() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF OLD.action_kind IN ('performance.goal.approve','performance.checkin.cancel','performance.checkin.complete') AND OLD.state='completed' THEN
  IF TG_OP='DELETE' OR OLD.performance_postimage_root_xid=pg_current_xact_id() THEN RAISE EXCEPTION 'Immutable completed Performance history' USING ERRCODE='23514';END IF;
  IF ROW(NEW.id,NEW.action_kind,NEW.tenant_id,NEW.user_id,NEW.person_id,NEW.employment_id,NEW.company_id,NEW.decision_subject_person_id,NEW.receipt_subject_kind,NEW.receipt_subject_id,NEW.receipt_event_id,NEW.performance_postimage_version,NEW.performance_postimage_event_id,NEW.performance_postimage_root_xid,NEW.state,NEW.created_at,NEW.expires_at)
   IS DISTINCT FROM ROW(OLD.id,OLD.action_kind,OLD.tenant_id,OLD.user_id,OLD.person_id,OLD.employment_id,OLD.company_id,OLD.decision_subject_person_id,OLD.receipt_subject_kind,OLD.receipt_subject_id,OLD.receipt_event_id,OLD.performance_postimage_version,OLD.performance_postimage_event_id,OLD.performance_postimage_root_xid,OLD.state,OLD.created_at,OLD.expires_at)
  THEN RAISE EXCEPTION 'Immutable completed Performance history' USING ERRCODE='23514';END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;END IF;
 IF NEW.action_kind IN ('performance.goal.approve','performance.checkin.cancel','performance.checkin.complete') THEN
  IF OLD.performance_postimage_version=1 AND NEW.performance_postimage_version IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Immutable Performance proof version' USING ERRCODE='23514';END IF;
  IF OLD.performance_postimage_event_id IS NOT NULL AND NEW.performance_postimage_event_id IS DISTINCT FROM OLD.performance_postimage_event_id THEN RAISE EXCEPTION 'Immutable Performance proof event' USING ERRCODE='23514';END IF;
  IF NEW.state='awaiting_confirmation' AND OLD.performance_postimage_version=1 AND
   ROW(NEW.performance_postimage_unchanged,NEW.performance_postimage_notes,NEW.performance_postimage_mode) IS DISTINCT FROM ROW(OLD.performance_postimage_unchanged,OLD.performance_postimage_notes,OLD.performance_postimage_mode)
  THEN RAISE EXCEPTION 'Immutable Performance expectations' USING ERRCODE='23514';END IF;
  IF NEW.state<>'awaiting_confirmation' THEN NEW.performance_postimage_unchanged:=NULL;NEW.performance_postimage_notes:=NULL;NEW.performance_postimage_mode:=NULL;END IF;
 END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app._performance_postimage_retire() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER performance_postimage_retire BEFORE UPDATE OR DELETE ON app.assistant_own_leave_review FOR EACH ROW EXECUTE FUNCTION app._performance_postimage_retire();
--> statement-breakpoint
ALTER FUNCTION app._assistant_assigned_review_json(uuid) RENAME TO _assistant_assigned_review_json_0750_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_assigned_review_json(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;base jsonb;proof jsonb;
BEGIN
 base:=app._assistant_assigned_review_json_0750_previous(p_id);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id;
 IF NOT FOUND OR r.action_kind NOT IN ('performance.goal.approve','performance.checkin.cancel','performance.checkin.complete') THEN RETURN base;END IF;
 IF r.performance_postimage_version=1 AND r.state='awaiting_confirmation' THEN proof:=jsonb_build_object('version',1,'unchanged',r.performance_postimage_unchanged,'notes',r.performance_postimage_notes,'notesMode',r.performance_postimage_mode);END IF;
 RETURN jsonb_set(base,'{metadata,binding}',(base#>'{metadata,binding}')||jsonb_build_object('postimageProof',proof))
  ||jsonb_build_object('proofVersion',r.performance_postimage_version,'proofEventId',r.performance_postimage_event_id);
END $$;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_json(uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_json_0750_previous(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.assistant_assigned_review_prepare(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) RENAME TO _assistant_assigned_review_prepare_0750_previous;
--> statement-breakpoint
CREATE FUNCTION app.assistant_assigned_review_prepare(p_kind text,p_id uuid,p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid,p_subject uuid,p_intent text,p_reviewed text,p_kid text,p_wrapped text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_kind IN ('performance.goal.approve','performance.checkin.cancel','performance.checkin.complete') THEN RAISE EXCEPTION 'Prepare a fresh Performance proof review' USING ERRCODE='42501';END IF;
 RETURN app._assistant_assigned_review_prepare_0750_previous(p_kind,p_id,p_person,p_employment,p_company,p_subject_person,p_subject,p_intent,p_reviewed,p_kid,p_wrapped,p_ciphertext);
END $$;
REVOKE ALL ON FUNCTION app.assistant_assigned_review_prepare(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_assigned_review_prepare(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) TO ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_prepare_0750_previous(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_performance_review_prepare(p_kind text,p_id uuid,p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid,p_subject uuid,p_intent text,p_reviewed text,p_kid text,p_wrapped text,p_ciphertext text,p_proof jsonb,p_replacement text DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE expected jsonb;
BEGIN
 IF p_kind NOT IN ('performance.goal.approve','performance.checkin.cancel','performance.checkin.complete') THEN RAISE EXCEPTION 'Unknown Performance review' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_assigned_review_binding(p_kind,p_person,p_employment,p_company,p_subject_person,p_subject);
 -- Native expectations were derived BEFORE sealing; rederive now under the SAME locks and compare.
 -- Caller hashes are stale assertions, never authority or an expected-row proof by themselves.
 expected:=app.assistant_performance_review_expected(p_kind,p_subject,p_proof->>'notesMode',p_replacement);
 IF expected IS DISTINCT FROM p_proof THEN RAISE EXCEPTION 'Performance source changed before custody' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_assigned_review_prepare_0750_previous(p_kind,p_id,p_person,p_employment,p_company,p_subject_person,p_subject,p_intent,p_reviewed,p_kid,p_wrapped,p_ciphertext);
 UPDATE app.assistant_own_leave_review SET performance_postimage_version=1,performance_postimage_unchanged=expected->>'unchanged',performance_postimage_notes=expected->>'notes',performance_postimage_mode=expected->>'notesMode' WHERE id=p_id;
 RETURN app._assistant_assigned_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_performance_review_prepare(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_performance_review_prepare(text,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,jsonb,text) TO ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app._assistant_generic_review_verify(uuid,uuid) RENAME TO _assistant_generic_review_verify_0750_previous;
--> statement-breakpoint
CREATE FUNCTION app._assistant_generic_review_verify(p_id uuid,p_event uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;proof jsonb;completed_at timestamptz;
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id();
 IF NOT FOUND THEN RETURN false;END IF;
 IF r.action_kind NOT IN ('performance.goal.approve','performance.checkin.cancel','performance.checkin.complete') THEN RETURN app._assistant_generic_review_verify_0750_previous(p_id,p_event);END IF;
 IF r.performance_postimage_version IS DISTINCT FROM 1 OR r.performance_postimage_unchanged IS NULL OR app._assistant_generic_review_verify_0750_previous(p_id,p_event) IS NOT TRUE THEN RETURN false;END IF;
 proof:=jsonb_build_object('version',1,'unchanged',r.performance_postimage_unchanged,'notes',r.performance_postimage_notes,'notesMode',r.performance_postimage_mode);
 IF r.action_kind='performance.checkin.complete' THEN SELECT (payload->>'completedAt')::timestamptz INTO completed_at FROM public.domain_event WHERE id=p_event AND tenant_id=r.tenant_id;END IF;
 RETURN app._performance_postimage_matches(r.action_kind,r.receipt_subject_id,proof,completed_at) IS TRUE;
END $$;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify(uuid,uuid) FROM PUBLIC,ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify_0750_previous(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
ALTER FUNCTION app.assistant_assigned_review_complete(uuid,text,text,uuid) RENAME TO _assistant_assigned_review_complete_0750_previous;
--> statement-breakpoint
CREATE FUNCTION app.assistant_assigned_review_complete(p_id uuid,p_kind text,p_digest text,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;proof jsonb;completed_at timestamptz;
BEGIN
 IF p_kind NOT IN ('performance.goal.approve','performance.checkin.cancel','performance.checkin.complete') THEN RETURN app._assistant_assigned_review_complete_0750_previous(p_id,p_kind,p_digest,p_event);END IF;
 PERFORM app._assistant_leave_decision_login();
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind=p_kind FOR UPDATE;
 IF NOT FOUND OR r.performance_postimage_version IS DISTINCT FROM 1 OR p_event IS NULL THEN RAISE EXCEPTION 'Performance proof unavailable; open native history' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_assigned_review_binding(r.action_kind,r.person_id,r.employment_id,r.company_id,r.decision_subject_person_id,r.receipt_subject_id);
 IF r.state='completed' THEN
  IF r.performance_postimage_event_id IS DISTINCT FROM p_event OR r.receipt_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Performance proof unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
  IF p_digest IS DISTINCT FROM r.reviewed_digest OR app._assistant_generic_review_verify(r.id,p_event) IS NOT TRUE THEN RAISE EXCEPTION 'Performance postimage unavailable' USING ERRCODE='42501';END IF;
  proof:=jsonb_build_object('version',1,'unchanged',r.performance_postimage_unchanged,'notes',r.performance_postimage_notes,'notesMode',r.performance_postimage_mode);
  IF p_kind='performance.checkin.complete' THEN SELECT (payload->>'completedAt')::timestamptz INTO completed_at FROM public.domain_event WHERE id=p_event AND tenant_id=r.tenant_id;END IF;
  UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='completed',receipt_event_id=p_event,performance_postimage_event_id=p_event,performance_postimage_root_xid=pg_current_xact_id() WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
  IF app._assistant_generic_review_verify_0750_previous(r.id,p_event) IS NOT TRUE OR app._performance_postimage_matches(p_kind,r.receipt_subject_id,proof,completed_at) IS NOT TRUE THEN RAISE EXCEPTION 'Performance postimage changed during completion' USING ERRCODE='42501';END IF;
 ELSE RAISE EXCEPTION 'Performance review unavailable' USING ERRCODE='42501';END IF;
 RETURN app._assistant_assigned_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_assigned_review_complete(uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_assigned_review_complete(uuid,text,text,uuid) TO ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_complete_0750_previous(uuid,text,text,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Minimal historical receipt: no current mutable title/notes/status can retroactively certify proof.
CREATE FUNCTION app.assistant_performance_review_receipt(p_id uuid,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;d public.domain_event%ROWTYPE;kind text;
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND state='completed' AND action_kind IN ('performance.goal.approve','performance.checkin.cancel','performance.checkin.complete');
 IF NOT FOUND OR r.performance_postimage_version IS DISTINCT FROM 1 OR r.performance_postimage_event_id IS DISTINCT FROM p_event OR r.receipt_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Performance proof unavailable; open native history' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_assigned_review_binding(r.action_kind,r.person_id,r.employment_id,r.company_id,r.decision_subject_person_id,r.receipt_subject_id);
 SELECT * INTO d FROM public.domain_event WHERE id=p_event AND tenant_id=r.tenant_id AND aggregate_id=r.receipt_subject_id AND actor_type='user' AND actor_id=r.user_id AND subject_employment_id=r.employment_id;
 IF NOT FOUND OR d.aggregate_type IS DISTINCT FROM CASE WHEN r.action_kind='performance.goal.approve' THEN 'performance-goal' ELSE 'performance-checkin' END
 OR d.event_type IS DISTINCT FROM CASE r.action_kind WHEN 'performance.goal.approve' THEN 'performance-goal.approved' WHEN 'performance.checkin.cancel' THEN 'performance-checkin.cancelled' ELSE 'performance-checkin.completed' END THEN RAISE EXCEPTION 'Performance history unavailable' USING ERRCODE='42501';END IF;
 kind:=CASE r.action_kind WHEN 'performance.goal.approve' THEN 'approved' WHEN 'performance.checkin.cancel' THEN 'cancelled' ELSE 'completed' END;
 RETURN jsonb_build_object('kind',kind,'subjectId',r.receipt_subject_id,'employmentId',r.employment_id,'eventId',d.id)
  ||CASE WHEN r.action_kind='performance.checkin.complete' THEN jsonb_build_object('completedAt',d.payload->>'completedAt') ELSE '{}'::jsonb END;
END $$;
REVOKE ALL ON FUNCTION app.assistant_performance_review_receipt(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_performance_review_receipt(uuid,uuid) TO ai_hr_app;

--> statement-breakpoint
ALTER FUNCTION app.assistant_assigned_review_read(uuid,text,boolean) RENAME TO _assistant_assigned_review_read_0750_previous;
--> statement-breakpoint
CREATE FUNCTION app.assistant_assigned_review_read(p_id uuid,p_kind text,p_discard boolean DEFAULT false) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF p_kind NOT IN ('performance.goal.approve','performance.checkin.cancel','performance.checkin.complete') THEN RETURN app._assistant_assigned_review_read_0750_previous(p_id,p_kind,p_discard);END IF;
 PERFORM app._assistant_assigned_review_read_0750_previous(p_id,p_kind,p_discard);
 IF p_kind IN ('performance.goal.approve','performance.checkin.cancel','performance.checkin.complete') THEN
  UPDATE app.assistant_own_leave_review SET state='refused',intent_digest=NULL,reviewed_digest=NULL
  WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind=p_kind AND state='awaiting_confirmation' AND performance_postimage_version IS NULL;
  IF FOUND THEN DELETE FROM app.assistant_own_leave_review_content WHERE action_id=p_id;END IF;
 END IF;
 RETURN app._assistant_assigned_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_assigned_review_read(uuid,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_assigned_review_read(uuid,text,boolean) TO ai_hr_app;
REVOKE ALL ON FUNCTION app._assistant_assigned_review_read_0750_previous(uuid,text,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Completion closes this exact command until COMMIT, not merely until the SQL function returns.
-- A protected root XID is assigned only after the existing native physical top-XID verifier. A later
-- transaction may edit a goal normally; no sensitive preimage or new transaction ledger is retained.
-- Nondeferrable BEFORE writer fences also survive SET CONSTRAINTS ALL IMMEDIATE. They inspect the
-- protected ledger as owner, so app RLS cannot turn a real mutation into an invisible proof check.
CREATE FUNCTION app._performance_completed_writer_fence() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE blocked boolean:=false;old_id uuid;new_id uuid;old_tenant uuid;new_tenant uuid;
BEGIN
 IF TG_RELID NOT IN ('public.performance_goal'::regclass,'public.performance_checkin'::regclass,'public.domain_event'::regclass,'public.app_user'::regclass,'public.employment'::regclass)
 THEN RAISE EXCEPTION 'Unexpected Performance proof writer' USING ERRCODE='42501';END IF;
 IF TG_OP<>'INSERT' THEN old_id:=OLD.id;old_tenant:=OLD.tenant_id;END IF;
 IF TG_OP<>'DELETE' THEN new_id:=NEW.id;new_tenant:=NEW.tenant_id;END IF;
 IF TG_RELID='public.app_user'::regclass THEN
  IF TG_OP='UPDATE' AND ROW(OLD.id,OLD.tenant_id,OLD.person_id) IS NOT DISTINCT FROM ROW(NEW.id,NEW.tenant_id,NEW.person_id) THEN RETURN NEW;END IF;
 END IF;
 IF TG_RELID='public.employment'::regclass THEN
  IF TG_OP='UPDATE' AND ROW(OLD.id,OLD.tenant_id,OLD.person_id,OLD.company_id) IS NOT DISTINCT FROM ROW(NEW.id,NEW.tenant_id,NEW.person_id,NEW.company_id) THEN RETURN NEW;END IF;
 END IF;
 IF TG_RELID='public.domain_event'::regclass THEN
  SELECT EXISTS(SELECT 1 FROM app.assistant_own_leave_review r
   WHERE r.state='completed' AND r.performance_postimage_version=1 AND r.action_kind IN ('performance.goal.approve','performance.checkin.cancel','performance.checkin.complete') AND r.performance_postimage_root_xid=pg_current_xact_id()
   AND (r.receipt_event_id IN (old_id,new_id) OR (TG_OP<>'INSERT' AND r.tenant_id=old_tenant AND r.receipt_subject_id=OLD.aggregate_id) OR (TG_OP<>'DELETE' AND r.tenant_id=new_tenant AND r.receipt_subject_id=NEW.aggregate_id))) INTO blocked;
 ELSE
  SELECT EXISTS(SELECT 1 FROM app.assistant_own_leave_review r
   WHERE r.state='completed' AND r.performance_postimage_version=1 AND r.action_kind IN ('performance.goal.approve','performance.checkin.cancel','performance.checkin.complete') AND r.performance_postimage_root_xid=pg_current_xact_id()
   AND r.tenant_id IN (old_tenant,new_tenant) AND CASE
    WHEN TG_RELID='public.app_user'::regclass THEN r.user_id IN (old_id,new_id)
    WHEN TG_RELID='public.employment'::regclass THEN r.employment_id IN (old_id,new_id)
    WHEN TG_RELID='public.performance_goal'::regclass THEN r.action_kind='performance.goal.approve' AND r.receipt_subject_id IN (old_id,new_id)
    ELSE r.action_kind IN ('performance.checkin.cancel','performance.checkin.complete') AND r.receipt_subject_id IN (old_id,new_id) END) INTO blocked;
 END IF;
 IF blocked THEN RAISE EXCEPTION 'Performance completed command is closed until commit' USING ERRCODE='42501';END IF;
 IF TG_OP='DELETE' THEN RETURN OLD;ELSE RETURN NEW;END IF;
END $$;
REVOKE ALL ON FUNCTION app._performance_completed_writer_fence() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER performance_completed_goal_fence BEFORE UPDATE OR DELETE ON public.performance_goal FOR EACH ROW EXECUTE FUNCTION app._performance_completed_writer_fence();
CREATE TRIGGER performance_completed_checkin_fence BEFORE UPDATE OR DELETE ON public.performance_checkin FOR EACH ROW EXECUTE FUNCTION app._performance_completed_writer_fence();
CREATE TRIGGER performance_completed_event_fence BEFORE INSERT OR UPDATE OR DELETE ON public.domain_event FOR EACH ROW EXECUTE FUNCTION app._performance_completed_writer_fence();
CREATE TRIGGER performance_completed_actor_fence BEFORE UPDATE OR DELETE ON public.app_user FOR EACH ROW EXECUTE FUNCTION app._performance_completed_writer_fence();
CREATE TRIGGER performance_completed_employment_fence BEFORE UPDATE OR DELETE ON public.employment FOR EACH ROW EXECUTE FUNCTION app._performance_completed_writer_fence();
