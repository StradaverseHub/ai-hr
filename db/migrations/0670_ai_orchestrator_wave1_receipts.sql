-- ADR-0151 wave 1: generic receipts on the one prepared-action store, and the first generic kind,
-- claims.cancel (own pending claim cancellation). Reserved as 0670 (when 1793190000000) by the migration
-- coordinator on 28 Oct 2026; the journal index is assigned at journaling.
--
-- The store keeps one owner (ADR-0131: no second ledger). New kinds use three generic receipt columns
-- instead of per-kind columns, and one generic function family whose completion step dispatches to a
-- strict per-kind verifier. Later kinds extend the two named constraints and the verifier by name.
-- No data changes: existing rows keep their kinds and columns, and every existing constraint keeps its
-- exact meaning for existing kinds.
ALTER TABLE app.assistant_own_leave_review
 ADD COLUMN receipt_subject_kind text,ADD COLUMN receipt_subject_id uuid,ADD COLUMN receipt_event_id uuid UNIQUE;
--> statement-breakpoint
-- Replace the unnamed action-kind list and the per-kind column rule with named equivalents. Each is found
-- by its definition; exactly one must match, so an unexpected schema refuses instead of guessing.
DO $$
DECLARE kind_check text;columns_check text;columns_expr text;found integer;
BEGIN
 SELECT count(*),min(conname) INTO found,kind_check FROM pg_constraint
  WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c'
   AND pg_get_constraintdef(oid) LIKE 'CHECK ((action_kind = ANY (ARRAY[%' AND pg_get_constraintdef(oid) NOT LIKE '%CASE%';
 IF found<>1 THEN RAISE EXCEPTION '0670: expected one action-kind constraint, found %',found;END IF;
 SELECT count(*),min(conname) INTO found,columns_check FROM pg_constraint
  WHERE conrelid='app.assistant_own_leave_review'::regclass AND contype='c'
   AND pg_get_constraintdef(oid) LIKE '%performance_ack_event_id IS NOT NULL%' AND pg_get_constraintdef(oid) LIKE '%leave.apply%';
 IF found<>1 THEN RAISE EXCEPTION '0670: expected one per-kind column constraint, found %',found;END IF;
 SELECT substring(pg_get_constraintdef(oid) FROM '^CHECK (.*)$') INTO columns_expr FROM pg_constraint
  WHERE conrelid='app.assistant_own_leave_review'::regclass AND conname=columns_check;
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',kind_check);
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review DROP CONSTRAINT %I',columns_check);
 -- Generic kinds hold none of the legacy per-kind receipt columns; every legacy kind keeps its old rule.
 EXECUTE format('ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_kind_columns CHECK (CASE WHEN action_kind IN (''claims.cancel'') THEN leave_request_id IS NULL AND submission_event_id IS NULL AND notification_event_id IS NULL AND profile_request_id IS NULL AND profile_requested_event_id IS NULL AND claim_draft_id IS NULL AND claim_saved_event_id IS NULL AND performance_ack_event_id IS NULL ELSE %s END)',columns_expr);
END $$;
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_action_kind CHECK(action_kind IN ('leave.apply','notifications.email_preferences.save','ess.profile.request','claims.draft.save','performance.review.acknowledge','performance.onehr.plan.acknowledge','system_testing.execution.save','claims.submit','org.reporting.change','knowledge_base.article.create','lifecycle.acknowledgement.submit','toil.replacement.request','approvals.leave.decide','attendance.correction.request','typed_pay_components.create','rewards.post','payroll.close','country-my.statutory.update','multi_cycle_payroll.create_run',
 'claims.cancel'));
--> statement-breakpoint
-- A generic kind names its native subject at preparation and its own committed event at completion.
ALTER TABLE app.assistant_own_leave_review ADD CONSTRAINT assistant_review_generic_receipt CHECK(CASE
 WHEN action_kind='claims.cancel' THEN receipt_subject_kind='claim_request' AND receipt_subject_id IS NOT NULL AND ((state='completed')=(receipt_event_id IS NOT NULL))
 ELSE receipt_subject_kind IS NULL AND receipt_subject_id IS NULL AND receipt_event_id IS NULL END);
--> statement-breakpoint
-- One subject at a time: a second pending review for the same claim would let two confirmations race.
CREATE UNIQUE INDEX assistant_review_generic_pending_subject ON app.assistant_own_leave_review(tenant_id,action_kind,receipt_subject_id)
 WHERE receipt_subject_id IS NOT NULL AND state='awaiting_confirmation';
--> statement-breakpoint
-- The closed generic kinds and the native subject each names. Anything else is refused.
CREATE FUNCTION app._assistant_generic_review_subject_kind(p_kind text) RETURNS text
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE p_kind WHEN 'claims.cancel' THEN 'claim_request' END;
$$;
REVOKE ALL ON FUNCTION app._assistant_generic_review_subject_kind(text) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_generic_review_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',jsonb_build_object(
  'actionId',r.id,'action',r.action_kind,'contractVersion',1,
  'binding',jsonb_build_object('tenantId',r.tenant_id,'userId',r.user_id,'personId',r.person_id,'employmentId',r.employment_id,'companyId',r.company_id),
  'intentDigest',r.intent_digest,'reviewedDigest',r.reviewed_digest,'state',r.state,
  'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  'sealed',CASE WHEN r.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN jsonb_build_object(
   'formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,
  'subjectKind',r.receipt_subject_kind,'subjectId',r.receipt_subject_id,'eventId',r.receipt_event_id)
 FROM app.assistant_own_leave_review r LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=r.id
 WHERE r.id=p_id AND app._assistant_generic_review_subject_kind(r.action_kind) IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION app._assistant_generic_review_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- Same admission as the existing own-review family: current own employment, privacy-erasure barrier,
-- digest/content bounds, and per-login pending and rate bounds shared with every other kind.
CREATE FUNCTION app.assistant_generic_review_prepare(p_kind text,p_id uuid,p_person uuid,p_employment uuid,p_company uuid,
 p_subject uuid,p_intent_digest text,p_reviewed_digest text,p_kid text,p_wrapped_dek text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE at_time timestamptz;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();subject_kind text:=app._assistant_generic_review_subject_kind(p_kind);
BEGIN
 IF subject_kind IS NULL OR p_subject IS NULL THEN RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_own_leave_review_identity(p_person,p_employment,p_company);
 IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id()
  AND i.tenant_id=t AND i.person_id=p_person)
  OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id()
   AND i.tenant_id=t AND i.person_id=p_person) THEN
  RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501';END IF;
 IF p_id IS NULL OR p_intent_digest IS NULL OR p_intent_digest !~ '^[a-f0-9]{64}$'
  OR p_reviewed_digest IS NULL OR p_reviewed_digest !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$'
  OR p_wrapped_dek IS NULL OR length(p_wrapped_dek) NOT BETWEEN 1 AND 512
  OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN
  RAISE EXCEPTION 'Review unavailable' USING ERRCODE='22023';END IF;
 -- The subject must be this employment's own row. Ownership of the effect is still the native service's.
 IF subject_kind='claim_request' AND NOT EXISTS(SELECT 1 FROM public.claim_request q
   WHERE q.id=p_subject AND q.tenant_id=t AND q.employment_id=p_employment) THEN
  RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501';END IF;
 at_time:=clock_timestamp();
 IF (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u
   AND state='awaiting_confirmation' AND expires_at>at_time)>=5
  OR (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u
   AND created_at>at_time-interval '10 minutes')>=20 THEN
  RAISE EXCEPTION 'Review unavailable' USING ERRCODE='54000';END IF;
 -- An expired pending review for the same subject yields to the new one.
 UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL
  WHERE tenant_id=t AND action_kind=p_kind AND receipt_subject_id=p_subject AND state='awaiting_confirmation' AND expires_at<=at_time;
 INSERT INTO app.assistant_own_leave_review
  (action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,receipt_subject_kind,receipt_subject_id,intent_digest,reviewed_digest,state,created_at,expires_at)
 VALUES(p_kind,p_id,t,u,p_person,p_employment,p_company,subject_kind,p_subject,
  p_intent_digest,p_reviewed_digest,'awaiting_confirmation',at_time,at_time+interval '10 minutes') ON CONFLICT DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped_dek,p_ciphertext);
 RETURN app._assistant_generic_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_generic_review_prepare(text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_generic_review_prepare(text,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) TO ai_hr_app;
--> statement-breakpoint
-- Nomination only: returns the stored employment and subject so the trusted command can take the
-- native locks before it reads the review row for update.
CREATE FUNCTION app.assistant_generic_review_subject(p_id uuid,p_kind text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF app._assistant_generic_review_subject_kind(p_kind) IS NULL OR t IS NULL OR u IS NULL THEN RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind=p_kind;
 IF NOT FOUND THEN RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_own_leave_review_identity(r.person_id,r.employment_id,r.company_id);
 RETURN jsonb_build_object('employmentId',r.employment_id,'subjectId',r.receipt_subject_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_generic_review_subject(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_generic_review_subject(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_generic_review_read(p_id uuid,p_kind text,p_discard boolean DEFAULT false) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF app._assistant_generic_review_subject_kind(p_kind) IS NULL OR t IS NULL OR u IS NULL
  OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN
  RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind=p_kind FOR UPDATE NOWAIT;
 IF NOT FOUND OR (p_discard IS TRUE AND r.state='completed') THEN RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_own_leave_review_identity(r.person_id,r.employment_id,r.company_id);
 IF r.state='awaiting_confirmation' THEN
  IF clock_timestamp()>=r.expires_at THEN
   UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='expired' WHERE id=r.id;
  ELSIF p_discard IS TRUE THEN
   UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='discarded' WHERE id=r.id;
  END IF;
 END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review a
  WHERE c.action_id=a.id AND a.id=r.id AND a.state<>'awaiting_confirmation';
 RETURN app._assistant_generic_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_generic_review_read(uuid,text,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_generic_review_read(uuid,text,boolean) TO ai_hr_app;
--> statement-breakpoint
-- Per-kind proof that the native command committed THIS effect in THIS transaction for THIS login and
-- subject. Consistency evidence only; the native service remains the owner of the effect's rules.
CREATE FUNCTION app._assistant_generic_review_verify(p_id uuid,p_event uuid) RETURNS boolean
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u;
 IF NOT FOUND OR p_event IS NULL THEN RETURN false;END IF;
 IF r.action_kind='claims.cancel' THEN
  RETURN EXISTS(SELECT 1 FROM public.claim_request q JOIN public.domain_event d ON d.aggregate_id=q.id AND d.tenant_id=q.tenant_id
   WHERE q.id=r.receipt_subject_id AND q.tenant_id=t AND q.employment_id=r.employment_id AND q.status='cancelled'
    AND q.xmin=pg_current_xact_id()::xid
    AND d.id=p_event AND d.aggregate_type='claim-request' AND d.event_type='claim-request.cancelled'
    AND d.actor_type='user' AND d.actor_id=u AND d.subject_employment_id=q.employment_id
    AND d.xmin=pg_current_xact_id()::xid);
 END IF;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION app._assistant_generic_review_verify(uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_generic_review_complete(p_id uuid,p_kind text,p_reviewed_digest text,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF app._assistant_generic_review_subject_kind(p_kind) IS NULL OR t IS NULL OR u IS NULL OR p_event IS NULL
  OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN
  RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind=p_kind FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_own_leave_review_identity(r.person_id,r.employment_id,r.company_id);
 IF r.state='completed' THEN
  IF r.receipt_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
  IF p_reviewed_digest IS DISTINCT FROM r.reviewed_digest OR NOT app._assistant_generic_review_verify(r.id,p_event) THEN
   RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501';END IF;
  UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='completed',receipt_event_id=p_event WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 ELSE RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501';END IF;
 RETURN app._assistant_generic_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_generic_review_complete(uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_generic_review_complete(uuid,text,text,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Metadata only, same 30-day window and person binding as the existing own-review indexes.
CREATE FUNCTION app.assistant_generic_reviews_index(p_kind text)
 RETURNS TABLE(action text,action_id uuid,state text,created_at timestamptz,expires_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();p uuid;at_time timestamptz;
BEGIN
 IF app._assistant_generic_review_subject_kind(p_kind) IS NULL OR t IS NULL OR u IS NULL
  OR current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'Review index unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF app.principal_snapshot_current() IS NOT TRUE THEN RAISE EXCEPTION 'Review index unavailable' USING ERRCODE='42501';END IF;
 SELECT a.person_id INTO p FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id);
 IF p IS NULL THEN RAISE EXCEPTION 'Review index unavailable' USING ERRCODE='42501';END IF;
 at_time:=clock_timestamp();
 RETURN QUERY SELECT r.action_kind,r.id,r.state,r.created_at,r.expires_at FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=t AND r.user_id=u AND r.person_id=p AND r.action_kind=p_kind
   AND r.created_at>=at_time-interval '30 days' AND r.created_at<=at_time
  ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END $$;
REVOKE ALL ON FUNCTION app.assistant_generic_reviews_index(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_generic_reviews_index(text) TO ai_hr_app;
--> statement-breakpoint
-- Outcome linking (ADR-0151 §4.6c): the association table's action list gains the new kind under a
-- stable name, and the three 0650 readers below are copied with only that kind added.
DO $$
DECLARE action_check text;found integer;
BEGIN
 SELECT count(*),min(conname) INTO found,action_check FROM pg_constraint
  WHERE conrelid='public.ai_native_outcome_association'::regclass AND contype='c'
   AND pg_get_constraintdef(oid) LIKE 'CHECK ((action = ANY (ARRAY[%' AND pg_get_constraintdef(oid) LIKE '%employees.import%';
 IF found<>1 THEN RAISE EXCEPTION '0670: expected one association action constraint, found %',found;END IF;
 EXECUTE format('ALTER TABLE public.ai_native_outcome_association DROP CONSTRAINT %I',action_check);
END $$;
--> statement-breakpoint
ALTER TABLE public.ai_native_outcome_association ADD CONSTRAINT ai_native_outcome_association_action CHECK(action IN('employees.import',
'org.reporting.change','leave.apply','ess.profile.request','approvals.leave.decide','knowledge_base.article.create','payroll.close','attendance.correction.request','claims.draft.save','claims.submit','performance.review.acknowledge','performance.onehr.plan.acknowledge','rewards.post','lifecycle.acknowledgement.submit','toil.replacement.request','multi_cycle_payroll.create_run','typed_pay_components.create','country-my.statutory.update','notifications.email_preferences.save','system_testing.execution.save','claims.cancel'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.native_outcome_review_completed(p_kind text,p_id uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
 SELECT app.current_user_id() IS NOT NULL AND app.current_tenant_id() IS NOT NULL
 AND app.principal_snapshot_current() AND p_kind IN('org.reporting.change','leave.apply','ess.profile.request','approvals.leave.decide','knowledge_base.article.create','payroll.close','attendance.correction.request','claims.draft.save','claims.submit','performance.review.acknowledge','performance.onehr.plan.acknowledge','rewards.post','lifecycle.acknowledgement.submit','toil.replacement.request','multi_cycle_payroll.create_run','typed_pay_components.create','country-my.statutory.update','notifications.email_preferences.save','system_testing.execution.save','claims.cancel')
 AND EXISTS(SELECT 1 FROM app.assistant_own_leave_review r WHERE r.id=p_id AND r.tenant_id=app.current_tenant_id()
  AND r.user_id=app.current_user_id() AND r.action_kind=p_kind AND r.state='completed'
  AND r.created_at<=now() AND r.created_at>now()-interval '30 days')
$$;
REVOKE ALL ON FUNCTION app.native_outcome_review_completed(text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.native_outcome_review_completed(text,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.native_outcome_targets_require(p_tenant uuid,p_user uuid,p_person uuid,p_action text,p_source uuid,p_event uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT p_tenant=app.current_tenant_id() AND p_user=app.current_user_id() AND app.principal_snapshot_current()
 AND EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=p_user AND u.tenant_id=p_tenant AND u.person_id IS NOT DISTINCT FROM p_person AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 AND EXISTS(SELECT 1 FROM app.native_outcome_source_capture c WHERE c.tenant_id=p_tenant AND c.user_id=p_user
  AND c.person_id IS NOT DISTINCT FROM p_person AND c.action=p_action AND c.source_id=p_source AND c.event_id=p_event AND c.expires_at>now()
  AND c.target_count=(SELECT count(*) FROM app.native_outcome_source_target t WHERE t.capture_id=c.id))
 AND((p_action='employees.import' AND EXISTS(SELECT 1 FROM public.employee_import_evaluation_attempt e WHERE e.id=p_source AND e.tenant_id=p_tenant AND e.user_id=p_user AND e.state='committed' AND e.event_id=p_event AND e.expires_at>now()))
 OR(p_action<>'employees.import' AND EXISTS(SELECT 1 FROM app.assistant_own_leave_review r WHERE r.id=p_source AND r.tenant_id=p_tenant AND r.user_id=p_user
  AND r.action_kind=p_action AND r.state='completed' AND r.person_id IS NOT DISTINCT FROM p_person AND CASE p_action
   WHEN 'leave.apply' THEN r.submission_event_id WHEN 'org.reporting.change' THEN r.reporting_set_event_id
   WHEN 'ess.profile.request' THEN r.profile_requested_event_id WHEN 'approvals.leave.decide' THEN r.decision_event_id
   WHEN 'knowledge_base.article.create' THEN r.knowledge_created_event_id WHEN 'payroll.close' THEN r.payroll_closed_event_id
   WHEN 'attendance.correction.request' THEN r.attendance_requested_event_id WHEN 'claims.draft.save' THEN r.claim_saved_event_id
   WHEN 'claims.submit' THEN r.claim_submitted_event_id WHEN 'performance.review.acknowledge' THEN r.performance_ack_event_id
   WHEN 'performance.onehr.plan.acknowledge' THEN r.performance_ack_event_id WHEN 'rewards.post' THEN r.rewards_posted_event_id
   WHEN 'lifecycle.acknowledgement.submit' THEN r.lifecycle_submitted_event_id WHEN 'toil.replacement.request' THEN r.toil_submitted_event_id
   WHEN 'multi_cycle_payroll.create_run' THEN r.multi_cycle_created_event_id WHEN 'typed_pay_components.create' THEN r.pay_component_created_event_id
   WHEN 'country-my.statutory.update' THEN r.country_statutory_event_id WHEN 'notifications.email_preferences.save' THEN r.notification_event_id
   WHEN 'system_testing.execution.save' THEN r.testing_event_id WHEN 'claims.cancel' THEN r.receipt_event_id END=p_event)))
$$;
REVOKE ALL ON FUNCTION app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.native_outcome_targets_require(uuid,uuid,uuid,text,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.native_outcome_completed_review_choices(p_kinds jsonb)
 RETURNS TABLE(action text,action_id uuid,created_at timestamptz)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp SET row_security=on AS $$
BEGIN
 IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL OR NOT app.principal_snapshot_current()
 OR jsonb_typeof(p_kinds) IS DISTINCT FROM 'array' OR jsonb_array_length(p_kinds) NOT BETWEEN 1 AND 20
 THEN RAISE EXCEPTION 'Outcome choices unavailable'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_kinds) v WHERE jsonb_typeof(v)<>'string')
 OR (SELECT count(DISTINCT v) FROM jsonb_array_elements_text(p_kinds) v)<>jsonb_array_length(p_kinds)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(p_kinds) v WHERE v NOT IN
 ('org.reporting.change','leave.apply','ess.profile.request','approvals.leave.decide','knowledge_base.article.create','payroll.close','attendance.correction.request','claims.draft.save','claims.submit','performance.review.acknowledge','performance.onehr.plan.acknowledge','rewards.post','lifecycle.acknowledgement.submit','toil.replacement.request','multi_cycle_payroll.create_run','typed_pay_components.create','country-my.statutory.update','notifications.email_preferences.save','system_testing.execution.save','claims.cancel'))
 THEN RAISE EXCEPTION 'Outcome choices unavailable'; END IF;
 RETURN QUERY SELECT r.action_kind,r.id,r.created_at FROM app.assistant_own_leave_review r
 WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id()
 AND r.state='completed' AND r.action_kind IN(SELECT jsonb_array_elements_text(p_kinds))
 AND r.created_at<=now() AND r.created_at>now()-interval '30 days'
 AND app.native_outcome_capture_available(r.action_kind,r.id)
 ORDER BY r.created_at DESC,r.id DESC LIMIT 26;
END $$;
REVOKE ALL ON FUNCTION app.native_outcome_completed_review_choices(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.native_outcome_completed_review_choices(jsonb) TO ai_hr_app;
