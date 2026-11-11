-- Combined release allocation (docs/MIGRATION-ALLOCATION.md): 5088_access_review_custody_held_mode, idx 4488, when 1793330004788.
-- Review custody joins the Access lock in the mode its transaction already holds (staging, 11 November 2026).
--
-- These review-custody owners (0622 own-leave, 0670 generic, the 0622 leave-decision login) took the tenant's Access
-- lock exclusively in SQL whatever their caller held. Home's prepared-leave cards reopen a review only to show its
-- details; under the reader/writer lock that read holds Access shared, and a shared holder asking for the exclusive
-- lock has to upgrade, waiting behind every other shared holder with no bound. Each owner now takes the shared lock
-- when its transaction already holds it shared, and the exclusive lock otherwise, exactly as before: a command that
-- holds the exclusive lock re-enters it, and a caller that holds nothing still gets it exclusively. Bodies, grants and
-- owners are otherwise unchanged; every function here belongs to the migration owner (no purpose role), so the
-- restricted ai_hr_owner may replace it.
-- app._assistant_own_leave_review_identity: 0622_own_leave_review_store, unchanged except the Access lock statement.
CREATE OR REPLACE FUNCTION app._assistant_own_leave_review_identity(p_person uuid,p_employment uuid,p_company uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off' THEN
  RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 IF app.access_lock_mode_held(t)='S' THEN PERFORM pg_advisory_xact_lock_shared(hashtextextended('access-configuration:'||t::text,0));
 ELSE PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0)); END IF;
 IF app.principal_snapshot_current() IS NOT TRUE OR NOT EXISTS(
  SELECT 1 FROM public.app_user a JOIN public.employment e ON e.person_id=a.person_id AND e.tenant_id=a.tenant_id
  WHERE a.id=u AND a.tenant_id=t AND a.person_id=p_person AND a.archived_at IS NULL
   AND NOT app.login_blocked(a.id) AND e.id=p_employment AND e.company_id=p_company AND app.can_see_employment(e.id)) THEN
  RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 -- Retain the current transaction's erasure barrier even if a caller forces deferred constraints
 -- early. Older completed markers are only transient receipts and can be pruned under this lock.
 DELETE FROM app.assistant_review_erasure_intent WHERE tenant_id=t AND xact_id<>pg_current_xact_id() AND event_id IS NOT NULL;
END $$;
--> statement-breakpoint
-- app.assistant_own_leave_review_subject: 0622_own_leave_review_store, unchanged except the Access lock statement.
CREATE OR REPLACE FUNCTION app.assistant_own_leave_review_subject(p_id uuid) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF t IS NULL OR u IS NULL THEN RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 IF app.access_lock_mode_held(t)='S' THEN PERFORM pg_advisory_xact_lock_shared(hashtextextended('access-configuration:'||t::text,0));
 ELSE PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0)); END IF;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='leave.apply';
 IF NOT FOUND THEN RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_own_leave_review_identity(r.person_id,r.employment_id,r.company_id);
 RETURN r.employment_id;
END $$;
--> statement-breakpoint
-- app.assistant_own_leave_review_read: 0622_own_leave_review_store, unchanged except the Access lock statement.
CREATE OR REPLACE FUNCTION app.assistant_own_leave_review_read(p_id uuid,p_discard boolean DEFAULT false,p_reviewed_digest text DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off' THEN
  RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 IF app.access_lock_mode_held(t)='S' THEN PERFORM pg_advisory_xact_lock_shared(hashtextextended('access-configuration:'||t::text,0));
 ELSE PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0)); END IF;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='leave.apply' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_own_leave_review_identity(r.person_id,r.employment_id,r.company_id);
 IF p_discard IS TRUE AND r.state='awaiting_confirmation' AND p_reviewed_digest IS DISTINCT FROM r.reviewed_digest THEN
  RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' THEN
  IF clock_timestamp()>=r.expires_at THEN
   UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='expired' WHERE id=r.id;
  ELSIF p_discard IS TRUE THEN
   UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='discarded' WHERE id=r.id;
  END IF;
 END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review a
  WHERE c.action_id=a.id AND a.id=r.id AND a.state<>'awaiting_confirmation';
 RETURN app._assistant_own_leave_review_json(r.id);
END $$;
--> statement-breakpoint
-- app.assistant_generic_review_subject: 0670_ai_orchestrator_wave1_receipts, unchanged except the Access lock statement.
CREATE OR REPLACE FUNCTION app.assistant_generic_review_subject(p_id uuid,p_kind text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF app._assistant_generic_review_subject_kind(p_kind) IS NULL OR t IS NULL OR u IS NULL THEN RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501';END IF;
 IF app.access_lock_mode_held(t)='S' THEN PERFORM pg_advisory_xact_lock_shared(hashtextextended('access-configuration:'||t::text,0));
 ELSE PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0)); END IF;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind=p_kind;
 IF NOT FOUND THEN RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_own_leave_review_identity(r.person_id,r.employment_id,r.company_id);
 RETURN jsonb_build_object('employmentId',r.employment_id,'subjectId',r.receipt_subject_id);
END $$;
--> statement-breakpoint
-- app.assistant_generic_review_read: 0670_ai_orchestrator_wave1_receipts, unchanged except the Access lock statement.
CREATE OR REPLACE FUNCTION app.assistant_generic_review_read(p_id uuid,p_kind text,p_discard boolean DEFAULT false) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF app._assistant_generic_review_subject_kind(p_kind) IS NULL OR t IS NULL OR u IS NULL
  OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN
  RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501';END IF;
 IF app.access_lock_mode_held(t)='S' THEN PERFORM pg_advisory_xact_lock_shared(hashtextextended('access-configuration:'||t::text,0));
 ELSE PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0)); END IF;
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
--> statement-breakpoint
-- app._assistant_leave_decision_login: 0622_own_leave_review_store, unchanged except the Access lock statement.
CREATE OR REPLACE FUNCTION app._assistant_leave_decision_login(p_person uuid DEFAULT NULL,p_bind boolean DEFAULT false) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'Leave decision review unavailable' USING ERRCODE='42501';END IF;
 IF app.access_lock_mode_held(app.current_tenant_id())='S' THEN PERFORM pg_advisory_xact_lock_shared(hashtextextended('access-configuration:'||app.current_tenant_id()::text,0));
 ELSE PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||app.current_tenant_id()::text,0)); END IF;
 IF app.principal_snapshot_current() IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND (p_bind IS NOT TRUE OR u.person_id IS NOT DISTINCT FROM p_person)) THEN RAISE EXCEPTION 'Leave decision review unavailable' USING ERRCODE='42501';END IF;
END $$;
