-- Parent allocation 0603 coordinated with actual Operator/efficiency owners on 26 October 2026.
-- STILL UNJOURNALED/UNAPPLIED: resolve existing Operator 0601 rollout order before journaling.
-- SOURCE DRAFT ONLY. No migration allocation/journal entry; never apply manually.
-- Review custody and canonical-reference completion only. No leave executor or endpoint is mounted.
-- Tables have no app-role grants/policies: narrow SECURITY DEFINER functions own all access.
CREATE TABLE app.assistant_own_leave_review (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.app_user(id) ON DELETE CASCADE,
 person_id uuid NOT NULL REFERENCES public.person(id) ON DELETE CASCADE,
 employment_id uuid NOT NULL REFERENCES public.employment(id) ON DELETE CASCADE,
 company_id uuid NOT NULL REFERENCES public.company(id),
 intent_digest text CHECK(intent_digest ~ '^[a-f0-9]{64}$'),
 reviewed_digest text CHECK(reviewed_digest ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('awaiting_confirmation','discarded','expired','refused','completed')),
 CHECK(CASE WHEN state='awaiting_confirmation' THEN intent_digest IS NOT NULL AND reviewed_digest IS NOT NULL
  ELSE intent_digest IS NULL AND reviewed_digest IS NULL END),
 leave_request_id uuid UNIQUE,submission_event_id uuid UNIQUE,
 CHECK((state='completed')=(leave_request_id IS NOT NULL AND submission_event_id IS NOT NULL)),
 CHECK((leave_request_id IS NULL)=(submission_event_id IS NULL)),
 created_at timestamptz NOT NULL,expires_at timestamptz NOT NULL CHECK(expires_at>created_at)
);
--> statement-breakpoint
CREATE INDEX assistant_own_leave_review_owner ON app.assistant_own_leave_review(tenant_id,user_id,expires_at,id);
--> statement-breakpoint
CREATE INDEX assistant_own_leave_review_admission ON app.assistant_own_leave_review(tenant_id,user_id,created_at,id);
--> statement-breakpoint
CREATE TABLE app.assistant_own_leave_review_content (
 action_id uuid PRIMARY KEY REFERENCES app.assistant_own_leave_review(id) ON DELETE CASCADE,
 kid text NOT NULL CHECK(kid ~ '^[a-f0-9]{16}$'),
 wrapped_dek text NOT NULL CHECK(length(wrapped_dek) BETWEEN 1 AND 512),
 ciphertext text NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 65536)
);
--> statement-breakpoint
ALTER TABLE app.assistant_own_leave_review ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.assistant_own_leave_review_content ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app.assistant_own_leave_review,app.assistant_own_leave_review_content FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TABLE app.assistant_review_erasure_intent (
 xact_id xid8 NOT NULL,tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.app_user(id) ON DELETE CASCADE,
 person_id uuid NOT NULL REFERENCES public.person(id) ON DELETE CASCADE,
 employment_id uuid NOT NULL REFERENCES public.employment(id) ON DELETE CASCADE,
 cleared integer NOT NULL CHECK(cleared>=0),event_id uuid REFERENCES public.domain_event(id),
 PRIMARY KEY(xact_id,tenant_id,user_id,person_id)
);
ALTER TABLE app.assistant_review_erasure_intent ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE app.assistant_review_erasure_intent FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
-- The access/privacy writer barrier precedes action row locks. Read Committed takes the post-lock
-- identity snapshot. This verifies custody ownership, not leave eligibility, Assistant grants or pauses.
CREATE FUNCTION app._assistant_own_leave_review_identity(p_person uuid,p_employment uuid,p_company uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off' THEN
  RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF app.principal_snapshot_current() IS NOT TRUE OR NOT EXISTS(
  SELECT 1 FROM public.app_user a JOIN public.employment e ON e.person_id=a.person_id AND e.tenant_id=a.tenant_id
  WHERE a.id=u AND a.tenant_id=t AND a.person_id=p_person AND a.archived_at IS NULL
   AND NOT app.login_blocked(a.id) AND e.id=p_employment AND e.company_id=p_company AND app.can_see_employment(e.id)) THEN
  RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 -- Retain the current transaction's erasure barrier even if a caller forces deferred constraints
 -- early. Older completed markers are only transient receipts and can be pruned under this lock.
 DELETE FROM app.assistant_review_erasure_intent WHERE tenant_id=t AND xact_id<>pg_current_xact_id() AND event_id IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION app._assistant_own_leave_review_identity(uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_own_leave_review_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',jsonb_build_object(
  'actionId',r.id,'action','leave.apply','contractVersion',1,
  'binding',jsonb_build_object('tenantId',r.tenant_id,'userId',r.user_id,'personId',r.person_id,'employmentId',r.employment_id,'companyId',r.company_id),
  'intentDigest',r.intent_digest,'reviewedDigest',r.reviewed_digest,'state',r.state,
  'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  'sealed',CASE WHEN r.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN jsonb_build_object(
   'formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,
  'receipt',CASE WHEN r.state='completed' THEN jsonb_build_object('actionId',r.id,'contractVersion',1,
   'state','completed','leaveRequestId',r.leave_request_id,'submissionEventId',r.submission_event_id) ELSE NULL END)
 FROM app.assistant_own_leave_review r LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=r.id
 WHERE r.id=p_id;
$$;
REVOKE ALL ON FUNCTION app._assistant_own_leave_review_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_own_leave_review_prepare(p_id uuid,p_person uuid,p_employment uuid,p_company uuid,
 p_intent_digest text,p_reviewed_digest text,p_kid text,p_wrapped_dek text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE at_time timestamptz;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 PERFORM app._assistant_own_leave_review_identity(p_person,p_employment,p_company);
 -- A preparation in the same privacy-erasure transaction must not create new uncaptured private text.
 IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id()
  AND i.tenant_id=t AND i.person_id=p_person)
  OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id()
   AND i.tenant_id=t AND i.person_id=p_person) THEN
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
  (id,tenant_id,user_id,person_id,employment_id,company_id,intent_digest,reviewed_digest,state,created_at,expires_at)
 VALUES(p_id,t,u,p_person,p_employment,p_company,
  p_intent_digest,p_reviewed_digest,'awaiting_confirmation',at_time,at_time+interval '10 minutes') ON CONFLICT(id) DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped_dek,p_ciphertext);
 RETURN app._assistant_own_leave_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_own_leave_review_prepare(uuid,uuid,uuid,uuid,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_own_leave_review_prepare(uuid,uuid,uuid,uuid,text,text,text,text,text) TO ai_hr_app;
--> statement-breakpoint
-- Nomination-only source reference. Access owns custody while the server command acquires its
-- ordered leave dependency locks BEFORE locking the action row or returning encrypted content.
CREATE FUNCTION app.assistant_own_leave_review_subject(p_id uuid) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF t IS NULL OR u IS NULL THEN RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u;
 IF NOT FOUND THEN RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_own_leave_review_identity(r.person_id,r.employment_id,r.company_id);
 RETURN r.employment_id;
END $$;
REVOKE ALL ON FUNCTION app.assistant_own_leave_review_subject(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_own_leave_review_subject(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Returning encrypted content is a SERVER-ONLY custody API. Do not serialize its raw JSON result.
CREATE FUNCTION app.assistant_own_leave_review_read(p_id uuid,p_discard boolean DEFAULT false,p_reviewed_digest text DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off' THEN
  RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u FOR UPDATE;
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
REVOKE ALL ON FUNCTION app.assistant_own_leave_review_read(uuid,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_own_leave_review_read(uuid,boolean,text) TO ai_hr_app;
--> statement-breakpoint
-- Private lifecycle persistence only: the server command still owns fresh Assistant authority,
-- pauses, reviewed-effect revalidation and the canonical requestLeave call. Never expose this SQL
-- function as a model tool or accept its source references from a confirmation POST.
-- Both source rows must have been written in THIS top-level transaction. PostgreSQL16 documents
-- xid8->xid casting and that pg_current_xact_id returns the top-level ID, including inside savepoints.
-- Consequently savepoint-created source rows fail closed here. The command must use its supplied
-- top-level transaction directly, with whole-transaction rollback on any refusal (no nested commit).
CREATE FUNCTION app.assistant_own_leave_review_complete(p_id uuid,p_reviewed_digest text,
 p_request uuid,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off' THEN
  RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_own_leave_review_identity(r.person_id,r.employment_id,r.company_id);
 IF p_request IS NULL OR p_event IS NULL THEN
  RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 -- A repeat delivery may reconcile the same completed reference, never attach another submission.
 IF r.state='completed' THEN
  IF r.leave_request_id IS DISTINCT FROM p_request OR r.submission_event_id IS DISTINCT FROM p_event THEN
   RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
  IF p_reviewed_digest IS DISTINCT FROM r.reviewed_digest THEN
   RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.leave_request q JOIN public.employment e ON e.id=q.employment_id
   JOIN public.domain_event d ON d.id=p_event AND d.tenant_id=q.tenant_id
    AND d.aggregate_type='leave-request' AND d.aggregate_id=q.id AND d.event_type='leave-request.submitted'
    AND d.actor_type='user' AND d.actor_id=u AND d.subject_employment_id=q.employment_id
   WHERE q.id=p_request AND q.tenant_id=t AND q.employment_id=r.employment_id
    AND e.tenant_id=t AND e.person_id=r.person_id AND e.company_id=r.company_id
    AND q.xmin=pg_current_xact_id()::xid AND d.xmin=pg_current_xact_id()::xid) THEN
   RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
  UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='completed',leave_request_id=p_request,submission_event_id=p_event WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 ELSE RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';
 END IF;
 RETURN app._assistant_own_leave_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_own_leave_review_complete(uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_own_leave_review_complete(uuid,text,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Validity expiry is not a claim of scheduled physical deletion. This bounded primitive must be
-- wired and observed before any production endpoint promises automatic retention cleanup.
CREATE FUNCTION app.assistant_own_leave_reviews_expire(p_limit integer DEFAULT 100) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();ids uuid[];
BEGIN
 IF t IS NULL OR app.current_user_id() IS NULL OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
  RAISE EXCEPTION 'Review cleanup unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF app.principal_snapshot_current() IS NOT TRUE OR app.is_group_admin() IS NOT TRUE OR NOT EXISTS(
  SELECT 1 FROM public.app_user a WHERE a.id=app.current_user_id() AND a.tenant_id=t
   AND a.archived_at IS NULL AND NOT app.login_blocked(a.id)) THEN
  RAISE EXCEPTION 'Review cleanup unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(array_agg(d.id),'{}') INTO ids FROM (
  SELECT id FROM app.assistant_own_leave_review WHERE tenant_id=t AND state='awaiting_confirmation'
   AND expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT p_limit FOR UPDATE) d;
 UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='expired' WHERE id=ANY(ids) AND tenant_id=t;
 DELETE FROM app.assistant_own_leave_review_content WHERE action_id=ANY(ids);
 RETURN cardinality(ids);
END $$;
REVOKE ALL ON FUNCTION app.assistant_own_leave_reviews_expire(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_own_leave_reviews_expire(integer) TO ai_hr_app;
--> statement-breakpoint
-- Actual-login cleanup is distinct from administrative cleanup: it can retire only this login's
-- expired review bodies, even after Assistant grant/pause changes or person relinking. It returns
-- a bounded count, never an action identity or private content. No user/tenant selector is accepted.
CREATE FUNCTION app.assistant_own_leave_reviews_expire_own(p_limit integer DEFAULT 100) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();ids uuid[];
BEGIN
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
  RAISE EXCEPTION 'Review cleanup unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF app.principal_snapshot_current() IS NOT TRUE OR NOT EXISTS(
  SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id)) THEN
  RAISE EXCEPTION 'Review cleanup unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(array_agg(d.id),'{}') INTO ids FROM (
  SELECT id FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation'
   AND expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT p_limit FOR UPDATE) d;
 UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='expired' WHERE id=ANY(ids) AND tenant_id=t AND user_id=u;
 DELETE FROM app.assistant_own_leave_review_content WHERE action_id=ANY(ids);
 RETURN cardinality(ids);
END $$;
REVOKE ALL ON FUNCTION app.assistant_own_leave_reviews_expire_own(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_own_leave_reviews_expire_own(integer) TO ai_hr_app;
--> statement-breakpoint
-- Untyped private review content follows the canonical person's erasure, across every employment.
-- The existing erasure owner admits/locks the person and requires its real audit at commit.
CREATE FUNCTION app.assistant_own_leave_reviews_redact(p_employment uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i app.home_greeting_erasure_intent%ROWTYPE;total integer;
BEGIN
 SELECT * INTO i FROM app.home_greeting_erasure_intent WHERE xact_id=pg_current_xact_id()
  AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND employment_id=p_employment;
 IF NOT FOUND OR app.principal_snapshot_current() IS NOT TRUE OR app.can_admin_employment(p_employment) IS NOT TRUE THEN
  RAISE EXCEPTION 'Review erasure admission unavailable' USING ERRCODE='42501';END IF;
 DELETE FROM app.assistant_review_erasure_intent WHERE tenant_id=i.tenant_id
  AND xact_id<>pg_current_xact_id() AND event_id IS NOT NULL;
 IF EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent e WHERE e.xact_id=i.xact_id
  AND e.tenant_id=i.tenant_id AND e.user_id=i.user_id AND e.person_id=i.person_id) THEN
  RAISE EXCEPTION 'Review erasure already prepared' USING ERRCODE='40001';END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review r
  WHERE c.action_id=r.id AND r.tenant_id=i.tenant_id AND r.person_id=i.person_id;
 GET DIAGNOSTICS total=ROW_COUNT;
 UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,
  state=CASE WHEN state='awaiting_confirmation' THEN 'refused' ELSE state END
  WHERE tenant_id=i.tenant_id AND person_id=i.person_id;
 INSERT INTO app.assistant_review_erasure_intent VALUES(i.xact_id,i.tenant_id,i.user_id,i.person_id,i.employment_id,total,NULL);
 RETURN total;
END $$;
REVOKE ALL ON FUNCTION app.assistant_own_leave_reviews_redact(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_own_leave_reviews_redact(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.audit_assistant_review_erasure() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i app.assistant_review_erasure_intent%ROWTYPE;h app.home_greeting_erasure_intent%ROWTYPE;
BEGIN
 IF NEW.event_type<>'pii.erased' OR NEW.aggregate_type<>'person' THEN RETURN NULL;END IF;
 SELECT * INTO i FROM app.assistant_review_erasure_intent WHERE xact_id=pg_current_xact_id()
  AND tenant_id=NEW.tenant_id AND user_id=NEW.actor_id AND person_id=NEW.aggregate_id;
 IF NOT FOUND THEN
  IF EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c JOIN app.assistant_own_leave_review r ON r.id=c.action_id
   WHERE r.tenant_id=NEW.tenant_id AND r.person_id=NEW.aggregate_id)
   OR coalesce(NEW.payload->'erasedFields' ? 'assistantPreparedReviews',false) THEN
   RAISE EXCEPTION 'Review erasure admission unavailable' USING ERRCODE='42501';END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO h FROM app.home_greeting_erasure_intent WHERE xact_id=i.xact_id AND tenant_id=i.tenant_id
  AND user_id=i.user_id AND person_id=i.person_id;
 IF NOT FOUND OR i.event_id IS NOT NULL OR NEW.actor_type<>'user' OR NEW.actor_id IS DISTINCT FROM app.current_user_id()
  OR i.tenant_id IS DISTINCT FROM app.current_tenant_id() OR app.principal_snapshot_current() IS NOT TRUE
  OR app.can_admin_employment(i.employment_id) IS NOT TRUE OR NEW.subject_employment_id IS DISTINCT FROM i.employment_id
  OR jsonb_typeof(NEW.payload->'erasedFields') IS DISTINCT FROM 'array'
  OR NEW.payload->>'scope' IS DISTINCT FROM h.scope
  OR encode(sha256(convert_to(NEW.payload->>'requestRef','UTF8')),'hex') IS DISTINCT FROM h.request_ref_hash
  OR encode(sha256(convert_to(NEW.payload->>'reason','UTF8')),'hex') IS DISTINCT FROM h.reason_hash
  OR coalesce(NEW.payload->'erasedFields' ? 'assistantPreparedReviews',false) IS DISTINCT FROM (i.cleared>0) THEN
  RAISE EXCEPTION 'Review erasure audit unavailable' USING ERRCODE='42501';END IF;
 UPDATE app.assistant_review_erasure_intent SET event_id=NEW.id WHERE xact_id=i.xact_id
  AND tenant_id=i.tenant_id AND user_id=i.user_id AND person_id=i.person_id;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.audit_assistant_review_erasure() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_review_erasure_audit AFTER INSERT ON public.domain_event
 FOR EACH ROW EXECUTE FUNCTION app.audit_assistant_review_erasure();
--> statement-breakpoint
CREATE FUNCTION app.assistant_review_erasure_complete() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i app.assistant_review_erasure_intent%ROWTYPE;
BEGIN
 SELECT * INTO i FROM app.assistant_review_erasure_intent WHERE xact_id=NEW.xact_id AND tenant_id=NEW.tenant_id
  AND user_id=NEW.user_id AND person_id=NEW.person_id;
 IF NOT FOUND OR i.event_id IS NULL OR i.xact_id IS DISTINCT FROM pg_current_xact_id()
  OR i.tenant_id IS DISTINCT FROM app.current_tenant_id() OR i.user_id IS DISTINCT FROM app.current_user_id()
  OR app.principal_snapshot_current() IS NOT TRUE OR app.can_admin_employment(i.employment_id) IS NOT TRUE
  OR EXISTS(SELECT 1 FROM app.assistant_own_leave_review WHERE tenant_id=i.tenant_id AND person_id=i.person_id
   AND (intent_digest IS NOT NULL OR reviewed_digest IS NOT NULL))
  OR EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c JOIN app.assistant_own_leave_review r ON r.id=c.action_id
   WHERE r.tenant_id=i.tenant_id AND r.person_id=i.person_id) THEN
  RAISE EXCEPTION 'Review erasure incomplete' USING ERRCODE='42501';END IF;
 -- Do not remove the current-xact barrier here: SET CONSTRAINTS IMMEDIATE must not permit a later
 -- preparation in the same transaction. A later authorized custody call prunes the completed marker.
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.assistant_review_erasure_complete() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER assistant_review_erasure_complete AFTER INSERT ON app.assistant_review_erasure_intent
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.assistant_review_erasure_complete();
