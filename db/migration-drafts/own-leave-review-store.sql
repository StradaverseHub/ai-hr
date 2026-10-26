-- Centrally reserved source-only filename tag: 0622_own_leave_review_store; journal index/timestamp DEFERRED.
-- UNJOURNALED / UNAPPLIED. Supersedes surrendered AI0613-0620 reservations.
-- Preserve actual human journal prerequisites; final index/when allocated centrally at source freeze.
-- Refresh canonical prefix and actual staging watermark before release-owner journal/application.
CREATE TABLE app.assistant_own_leave_review (
 action_kind text NOT NULL DEFAULT 'leave.apply' CHECK(action_kind IN ('leave.apply','notifications.email_preferences.save','ess.profile.request','claims.draft.save','performance.review.acknowledge','performance.onehr.plan.acknowledge','system_testing.execution.save','claims.submit','org.reporting.change','knowledge_base.article.create')),
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES public.app_user(id) ON DELETE CASCADE,
 person_id uuid REFERENCES public.person(id) ON DELETE CASCADE,
 employment_id uuid REFERENCES public.employment(id) ON DELETE CASCADE,
 company_id uuid REFERENCES public.company(id),
 -- Nullable actor is closed to USER-scoped Testing/Knowledge and governed non-own Org; old own kinds retain their IDs.
 testing_execution_id uuid REFERENCES public.test_execution(id) ON DELETE CASCADE,
 testing_run_id uuid UNIQUE,testing_event_id uuid UNIQUE,
 CHECK(CASE WHEN action_kind='system_testing.execution.save' THEN employment_id IS NULL AND company_id IS NULL AND testing_execution_id IS NOT NULL
  WHEN action_kind='knowledge_base.article.create' THEN employment_id IS NULL AND company_id IS NULL AND testing_execution_id IS NULL AND testing_run_id IS NULL AND testing_event_id IS NULL
  WHEN action_kind='org.reporting.change' THEN employment_id IS NOT NULL AND company_id IS NOT NULL AND testing_execution_id IS NULL AND testing_run_id IS NULL AND testing_event_id IS NULL
  ELSE person_id IS NOT NULL AND employment_id IS NOT NULL AND company_id IS NOT NULL AND testing_execution_id IS NULL AND testing_run_id IS NULL AND testing_event_id IS NULL END),
 CHECK((testing_run_id IS NULL)=(testing_event_id IS NULL)),
 intent_digest text CHECK(intent_digest ~ '^[a-f0-9]{64}$'),
 reviewed_digest text CHECK(reviewed_digest ~ '^[a-f0-9]{64}$'),
 state text NOT NULL CHECK(state IN ('awaiting_confirmation','discarded','expired','refused','completed')),
 CHECK(CASE WHEN state='awaiting_confirmation' THEN intent_digest IS NOT NULL AND reviewed_digest IS NOT NULL
  ELSE intent_digest IS NULL AND reviewed_digest IS NULL END),
 leave_request_id uuid UNIQUE,submission_event_id uuid UNIQUE,
 notification_event_id uuid UNIQUE,profile_request_id uuid UNIQUE,profile_requested_event_id uuid UNIQUE,
 -- A draft can be edited by multiple separately reviewed actions; only each native save event is unique.
 claim_draft_id uuid,claim_saved_event_id uuid UNIQUE,performance_ack_event_id uuid UNIQUE,
 -- Multiple pending reviews may name one human draft; only one may claim its exact submit event.
 claim_submission_id uuid REFERENCES public.claim_request(id),claim_submitted_event_id uuid UNIQUE,
 knowledge_article_id uuid UNIQUE,knowledge_created_event_id uuid UNIQUE,
 CHECK(CASE WHEN action_kind='knowledge_base.article.create' THEN ((state='completed')=(knowledge_article_id IS NOT NULL AND knowledge_created_event_id IS NOT NULL)) ELSE knowledge_article_id IS NULL AND knowledge_created_event_id IS NULL END),
 CHECK((knowledge_article_id IS NULL)=(knowledge_created_event_id IS NULL)),
 -- Actual HR actor and target remain separate. Pending privacy links retire with encrypted body.
 org_subject_person_id uuid REFERENCES public.person(id) ON DELETE CASCADE,
 org_manager_person_id uuid REFERENCES public.person(id) ON DELETE CASCADE,
 org_previous_manager_person_id uuid REFERENCES public.person(id) ON DELETE CASCADE,
 reporting_line_id uuid REFERENCES public.reporting_line(id),reporting_set_event_id uuid UNIQUE REFERENCES public.domain_event(id),
 CHECK(CASE WHEN action_kind='org.reporting.change' THEN org_subject_person_id IS NOT NULL
  AND ((state='awaiting_confirmation')=(org_manager_person_id IS NOT NULL))
  AND (state='awaiting_confirmation' OR org_previous_manager_person_id IS NULL)
  AND ((state='completed')=(reporting_line_id IS NOT NULL AND reporting_set_event_id IS NOT NULL))
  ELSE org_subject_person_id IS NULL AND org_manager_person_id IS NULL AND org_previous_manager_person_id IS NULL AND reporting_line_id IS NULL AND reporting_set_event_id IS NULL END),
 CHECK((reporting_line_id IS NULL)=(reporting_set_event_id IS NULL)),
 CHECK(CASE WHEN action_kind='claims.submit' THEN claim_submission_id IS NOT NULL AND ((state='completed')=(claim_submitted_event_id IS NOT NULL)) ELSE claim_submission_id IS NULL AND claim_submitted_event_id IS NULL END),
 CHECK(CASE WHEN action_kind='leave.apply' THEN performance_ack_event_id IS NULL AND claim_draft_id IS NULL AND claim_saved_event_id IS NULL AND notification_event_id IS NULL AND profile_request_id IS NULL AND profile_requested_event_id IS NULL
  AND ((state='completed')=(leave_request_id IS NOT NULL AND submission_event_id IS NOT NULL))
  WHEN action_kind='notifications.email_preferences.save' THEN performance_ack_event_id IS NULL AND claim_draft_id IS NULL AND claim_saved_event_id IS NULL AND leave_request_id IS NULL AND submission_event_id IS NULL AND profile_request_id IS NULL AND profile_requested_event_id IS NULL
   AND ((state='completed')=(notification_event_id IS NOT NULL))
  WHEN action_kind='ess.profile.request' THEN performance_ack_event_id IS NULL AND claim_draft_id IS NULL AND claim_saved_event_id IS NULL AND leave_request_id IS NULL AND submission_event_id IS NULL AND notification_event_id IS NULL
   AND ((state='completed')=(profile_request_id IS NOT NULL AND profile_requested_event_id IS NOT NULL))
  WHEN action_kind='claims.draft.save' THEN performance_ack_event_id IS NULL AND leave_request_id IS NULL AND submission_event_id IS NULL AND notification_event_id IS NULL AND profile_request_id IS NULL AND profile_requested_event_id IS NULL
   AND ((state='completed')=(claim_draft_id IS NOT NULL AND claim_saved_event_id IS NOT NULL))
  WHEN action_kind='knowledge_base.article.create' THEN performance_ack_event_id IS NULL AND leave_request_id IS NULL AND submission_event_id IS NULL AND notification_event_id IS NULL AND profile_request_id IS NULL AND profile_requested_event_id IS NULL AND claim_draft_id IS NULL AND claim_saved_event_id IS NULL
  WHEN action_kind='org.reporting.change' THEN performance_ack_event_id IS NULL AND leave_request_id IS NULL AND submission_event_id IS NULL AND notification_event_id IS NULL AND profile_request_id IS NULL AND profile_requested_event_id IS NULL AND claim_draft_id IS NULL AND claim_saved_event_id IS NULL
  WHEN action_kind='claims.submit' THEN performance_ack_event_id IS NULL AND leave_request_id IS NULL AND submission_event_id IS NULL AND notification_event_id IS NULL AND profile_request_id IS NULL AND profile_requested_event_id IS NULL AND claim_draft_id IS NULL AND claim_saved_event_id IS NULL
  WHEN action_kind='system_testing.execution.save' THEN performance_ack_event_id IS NULL AND leave_request_id IS NULL AND submission_event_id IS NULL AND notification_event_id IS NULL AND profile_request_id IS NULL AND profile_requested_event_id IS NULL AND claim_draft_id IS NULL AND claim_saved_event_id IS NULL
   AND ((state='completed')=(testing_run_id IS NOT NULL AND testing_event_id IS NOT NULL))
  ELSE leave_request_id IS NULL AND submission_event_id IS NULL AND notification_event_id IS NULL AND profile_request_id IS NULL AND profile_requested_event_id IS NULL AND claim_draft_id IS NULL AND claim_saved_event_id IS NULL
   AND ((state='completed')=(performance_ack_event_id IS NOT NULL)) END),
 CHECK((claim_draft_id IS NULL)=(claim_saved_event_id IS NULL)),
 CHECK((profile_request_id IS NULL)=(profile_requested_event_id IS NULL)),
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
 ciphertext text NOT NULL CHECK(octet_length(ciphertext) BETWEEN 1 AND 819200)
);
--> statement-breakpoint
-- The existing table carries one bounded Testing body. Every legacy kind keeps its original cap.
-- No application table grants permit changing action_kind to evade this closed size discriminator.
CREATE FUNCTION app.assistant_review_content_size() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE kind text;bound integer;
BEGIN
 SELECT action_kind INTO kind FROM app.assistant_own_leave_review WHERE id=NEW.action_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Review content unavailable' USING ERRCODE='23514';END IF;
 bound:=CASE WHEN kind='system_testing.execution.save' THEN 819200 ELSE 65536 END;
 IF octet_length(NEW.ciphertext) NOT BETWEEN 1 AND bound THEN RAISE EXCEPTION 'Review content unavailable' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.assistant_review_content_size() FROM PUBLIC,ai_hr_app;
CREATE TRIGGER assistant_review_content_size BEFORE INSERT OR UPDATE ON app.assistant_own_leave_review_content FOR EACH ROW EXECUTE FUNCTION app.assistant_review_content_size();
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
 -- Captured before pending manager pointers retire; deferred proof must still cover these rows.
 review_ids uuid[] NOT NULL,
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
 WHERE r.id=p_id AND r.action_kind='leave.apply';
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
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='leave.apply';
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
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='leave.apply' FOR UPDATE;
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
 UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='expired',org_manager_person_id=NULL,org_previous_manager_person_id=NULL WHERE id=ANY(ids) AND tenant_id=t;
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
 UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='expired',org_manager_person_id=NULL,org_previous_manager_person_id=NULL WHERE id=ANY(ids) AND tenant_id=t AND user_id=u;
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
DECLARE i app.home_greeting_erasure_intent%ROWTYPE;total integer;ids uuid[];
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
 -- Capture every current actor/subject/pending manager association before clearing pointers.
 SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]) INTO ids FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=i.tenant_id AND (r.person_id=i.person_id OR r.org_subject_person_id=i.person_id
   OR r.org_manager_person_id=i.person_id OR r.org_previous_manager_person_id=i.person_id);
 DELETE FROM app.assistant_own_leave_review_content WHERE action_id=ANY(ids);
 GET DIAGNOSTICS total=ROW_COUNT;
 UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,
  state=CASE WHEN state='awaiting_confirmation' THEN 'refused' ELSE state END,org_manager_person_id=NULL,org_previous_manager_person_id=NULL
  WHERE tenant_id=i.tenant_id AND id=ANY(ids);
 INSERT INTO app.assistant_review_erasure_intent VALUES(i.xact_id,i.tenant_id,i.user_id,i.person_id,i.employment_id,total,NULL,ids);
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
   WHERE r.tenant_id=NEW.tenant_id AND (r.person_id=NEW.aggregate_id OR r.org_subject_person_id=NEW.aggregate_id OR r.org_manager_person_id=NEW.aggregate_id OR r.org_previous_manager_person_id=NEW.aggregate_id))
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
  OR EXISTS(SELECT 1 FROM app.assistant_own_leave_review WHERE tenant_id=i.tenant_id AND (id=ANY(i.review_ids) OR person_id=i.person_id OR org_subject_person_id=i.person_id OR org_manager_person_id=i.person_id OR org_previous_manager_person_id=i.person_id)
   AND (intent_digest IS NOT NULL OR reviewed_digest IS NOT NULL))
  OR EXISTS(SELECT 1 FROM app.assistant_own_leave_review_content c JOIN app.assistant_own_leave_review r ON r.id=c.action_id
   WHERE r.tenant_id=i.tenant_id AND (r.id=ANY(i.review_ids) OR r.person_id=i.person_id OR r.org_subject_person_id=i.person_id OR r.org_manager_person_id=i.person_id OR r.org_previous_manager_person_id=i.person_id)) THEN
  RAISE EXCEPTION 'Review erasure incomplete' USING ERRCODE='42501';END IF;
 -- Do not remove the current-xact barrier here: SET CONSTRAINTS IMMEDIATE must not permit a later
 -- preparation in the same transaction. A later authorized custody call prunes the completed marker.
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.assistant_review_erasure_complete() FROM PUBLIC,ai_hr_app;
CREATE CONSTRAINT TRIGGER assistant_review_erasure_complete AFTER INSERT ON app.assistant_review_erasure_intent
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.assistant_review_erasure_complete();

--> statement-breakpoint
-- UNALLOCATED ADDITION / UNJOURNALED / UNAPPLIED: metadata discovery is not a content/effect grant.
-- Fixed 30-day discovery visibility and 25-row bound; this is NOT a metadata purge promise.
CREATE FUNCTION app.assistant_own_leave_reviews_index()
 RETURNS TABLE(action_id uuid,state text,created_at timestamptz,expires_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();p uuid;at_time timestamptz;
BEGIN
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off' THEN
  RAISE EXCEPTION 'Own review index unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF app.principal_snapshot_current() IS NOT TRUE THEN
  RAISE EXCEPTION 'Own review index unavailable' USING ERRCODE='42501';END IF;
 SELECT a.person_id INTO p FROM public.app_user a JOIN public.person actual ON actual.id=a.person_id AND actual.tenant_id=a.tenant_id
 WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id);
 IF p IS NULL THEN RAISE EXCEPTION 'Own review index unavailable' USING ERRCODE='42501';END IF;
 at_time:=clock_timestamp();
 RETURN QUERY SELECT r.id,r.state,r.created_at,r.expires_at FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=t AND r.user_id=u AND r.person_id=p AND r.action_kind='leave.apply'
   AND r.created_at>=at_time-interval '30 days' AND r.created_at<=at_time
  ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END $$;
REVOKE ALL ON FUNCTION app.assistant_own_leave_reviews_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_own_leave_reviews_index() TO ai_hr_app;

--> statement-breakpoint
-- Shared module action custody extension: UNJOURNALED / UNAPPLIED, part of the reservation above.

-- Same physical owner/content lifecycle. A native event is a reference, never stored private proof.
CREATE FUNCTION app._assistant_module_action_review_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',jsonb_build_object(
  'actionId',r.id,'action',r.action_kind,'contractVersion',1,
  'binding',jsonb_build_object('tenantId',r.tenant_id,'userId',r.user_id,'personId',r.person_id,'employmentId',r.employment_id,'companyId',r.company_id),
  'intentDigest',r.intent_digest,'reviewedDigest',r.reviewed_digest,'state',r.state,
  'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  'sealed',CASE WHEN r.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN jsonb_build_object(
   'formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,
  'eventId',CASE WHEN r.action_kind='ess.profile.request' THEN r.profile_requested_event_id WHEN r.action_kind='claims.draft.save' THEN r.claim_saved_event_id WHEN r.action_kind IN ('performance.review.acknowledge','performance.onehr.plan.acknowledge') THEN r.performance_ack_event_id ELSE r.notification_event_id END)
  ||CASE WHEN r.action_kind='ess.profile.request' THEN jsonb_build_object('requestId',r.profile_request_id) WHEN r.action_kind='claims.draft.save' THEN jsonb_build_object('draftId',r.claim_draft_id) ELSE '{}'::jsonb END
 FROM app.assistant_own_leave_review r LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=r.id
 WHERE r.id=p_id AND r.action_kind IN ('notifications.email_preferences.save','ess.profile.request','claims.draft.save','performance.review.acknowledge','performance.onehr.plan.acknowledge');
$$;
REVOKE ALL ON FUNCTION app._assistant_module_action_review_json(uuid) FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.assistant_module_action_review_prepare(p_kind text,p_id uuid,p_person uuid,p_employment uuid,p_company uuid,
 p_intent_digest text,p_reviewed_digest text,p_kid text,p_wrapped_dek text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE at_time timestamptz;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF p_kind IS NULL OR p_kind NOT IN ('notifications.email_preferences.save','ess.profile.request','claims.draft.save','performance.review.acknowledge','performance.onehr.plan.acknowledge') THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
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
  (action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,intent_digest,reviewed_digest,state,created_at,expires_at)
 VALUES(p_kind,p_id,t,u,p_person,p_employment,p_company,
  p_intent_digest,p_reviewed_digest,'awaiting_confirmation',at_time,at_time+interval '10 minutes') ON CONFLICT(id) DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped_dek,p_ciphertext);
 RETURN app._assistant_module_action_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_module_action_review_prepare(text,uuid,uuid,uuid,uuid,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_module_action_review_prepare(text,uuid,uuid,uuid,uuid,text,text,text,text,text) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.assistant_module_action_review_subject(p_id uuid,p_kind text) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF p_kind IS NULL OR p_kind NOT IN ('notifications.email_preferences.save','ess.profile.request','claims.draft.save','performance.review.acknowledge','performance.onehr.plan.acknowledge') THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 IF t IS NULL OR u IS NULL THEN RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind=p_kind;
 IF NOT FOUND THEN RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_own_leave_review_identity(r.person_id,r.employment_id,r.company_id);
 RETURN r.employment_id;
END $$;
REVOKE ALL ON FUNCTION app.assistant_module_action_review_subject(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_module_action_review_subject(uuid,text) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.assistant_module_action_review_read(p_id uuid,p_kind text,p_discard boolean DEFAULT false,p_reviewed_digest text DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF p_kind IS NULL OR p_kind NOT IN ('notifications.email_preferences.save','ess.profile.request','claims.draft.save','performance.review.acknowledge','performance.onehr.plan.acknowledge') THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off' THEN
  RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind=p_kind FOR UPDATE;
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
 RETURN app._assistant_module_action_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_module_action_review_read(uuid,text,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_module_action_review_read(uuid,text,boolean,text) TO ai_hr_app;

--> statement-breakpoint

-- Source provenance remains the closed native adapter's responsibility. This SQL proves current
-- owner/digest/expiry and exact top-level source-row custody, not arbitrary SQL's canonical origin.
CREATE FUNCTION app.assistant_module_action_review_complete(p_id uuid,p_kind text,p_reviewed_digest text,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;d public.domain_event%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
 categories text[]:=ARRAY['attendance','claims','delegation','leave','notice','offboarding','payroll','onboarding','performance','profile','readiness','review','rewards','toil','employee_master_reports'];
BEGIN
 IF p_kind IS DISTINCT FROM 'notifications.email_preferences.save' OR t IS NULL OR u IS NULL
  OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN
  RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND action_kind=p_kind AND tenant_id=t AND user_id=u FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_own_leave_review_identity(r.person_id,r.employment_id,r.company_id);
 IF p_event IS NULL THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='completed' THEN
  IF r.notification_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
  IF p_reviewed_digest IS DISTINCT FROM r.reviewed_digest THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
  SELECT * INTO d FROM public.domain_event WHERE id=p_event AND tenant_id=t AND actor_type='user' AND actor_id=u
   AND aggregate_type='employment' AND aggregate_id=r.employment_id AND subject_employment_id=r.employment_id
   AND event_type='notification-email.consent-changed' AND xmin=pg_current_xact_id()::xid;
  IF NOT FOUND OR jsonb_typeof(d.payload->'enabledCategories') IS DISTINCT FROM 'array'
   OR (d.payload-'enabledCategories'-'locale')<>'{}'::jsonb
   OR d.payload->>'locale' IS NULL OR d.payload->>'locale' NOT IN ('en','ms','zh','vi','ta','th') THEN
   RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(d.payload->'enabledCategories') v
    WHERE jsonb_typeof(v)<>'string' OR NOT (v#>>'{}')=ANY(categories))
   OR jsonb_array_length(d.payload->'enabledCategories')<>(SELECT count(DISTINCT v) FROM jsonb_array_elements(d.payload->'enabledCategories') v)
   OR (SELECT count(*) FROM public.notification_pref p WHERE p.tenant_id=t AND p.recipient_employment_id=r.employment_id AND p.channel='email')<>cardinality(categories)
   OR EXISTS(SELECT 1 FROM public.notification_pref p WHERE p.tenant_id=t AND p.recipient_employment_id=r.employment_id AND p.channel='email'
    AND (NOT p.category=ANY(categories) OR p.xmin<>pg_current_xact_id()::xid
     OR p.enabled IS DISTINCT FROM ((d.payload->'enabledCategories') ? p.category)
     OR p.email_locale IS DISTINCT FROM d.payload->>'locale'
     OR (p.enabled AND p.email_consent_user_id IS DISTINCT FROM u))) THEN
   RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
  UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='completed',notification_event_id=p_event WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 ELSE RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 RETURN app._assistant_module_action_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_module_action_review_complete(uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_module_action_review_complete(uuid,text,text,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Discovery after lost preparation is metadata only, including after Assistant revocation.
CREATE FUNCTION app.assistant_module_action_reviews_index()
 RETURNS TABLE(action text,action_id uuid,state text,created_at timestamptz,expires_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();p uuid;at_time timestamptz;
BEGIN
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off' THEN
  RAISE EXCEPTION 'Own review index unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF app.principal_snapshot_current() IS NOT TRUE THEN RAISE EXCEPTION 'Own review index unavailable' USING ERRCODE='42501';END IF;
 SELECT a.person_id INTO p FROM public.app_user a JOIN public.person actual ON actual.id=a.person_id AND actual.tenant_id=a.tenant_id
 WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id);
 IF p IS NULL THEN RAISE EXCEPTION 'Own review index unavailable' USING ERRCODE='42501';END IF;
 at_time:=clock_timestamp();
 RETURN QUERY SELECT r.action_kind,r.id,r.state,r.created_at,r.expires_at FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=t AND r.user_id=u AND r.person_id=p AND r.action_kind='notifications.email_preferences.save'
   AND r.created_at>=at_time-interval '30 days' AND r.created_at<=at_time
  ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END $$;
REVOKE ALL ON FUNCTION app.assistant_module_action_reviews_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_module_action_reviews_index() TO ai_hr_app;

--> statement-breakpoint
-- ESS uses the SAME physical custody/lifecycle. Only canonical request/event REFERENCES survive
-- completion; no proposal, native source fingerprint or private fields enter terminal metadata.
CREATE FUNCTION app.assistant_profile_action_review_complete(p_id uuid,p_reviewed_digest text,p_request uuid,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND action_kind='ess.profile.request' AND tenant_id=t AND user_id=u FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_own_leave_review_identity(r.person_id,r.employment_id,r.company_id);
 IF p_request IS NULL OR p_event IS NULL THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='completed' THEN
  IF r.profile_request_id IS DISTINCT FROM p_request OR r.profile_requested_event_id IS DISTINCT FROM p_event THEN
   RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
  IF p_reviewed_digest IS DISTINCT FROM r.reviewed_digest THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.profile_change_request q JOIN public.employment e ON e.id=q.employment_id AND e.tenant_id=q.tenant_id
   JOIN public.domain_event d ON d.id=p_event AND d.tenant_id=q.tenant_id AND d.aggregate_type='profile-change' AND d.aggregate_id=q.id
    AND d.event_type='profile-change.requested' AND d.actor_type='user' AND d.actor_id=u AND d.subject_employment_id=q.employment_id
   WHERE q.id=p_request AND q.tenant_id=t AND q.person_id=r.person_id AND q.employment_id=r.employment_id AND q.status='pending'
    AND e.person_id=r.person_id AND e.company_id=r.company_id AND d.payload->>'employmentId'=r.employment_id::text
    AND jsonb_typeof(d.payload->'fields')='array' AND jsonb_array_length(d.payload->'fields') BETWEEN 1 AND 4224
    AND q.xmin=pg_current_xact_id()::xid AND d.xmin=pg_current_xact_id()::xid) THEN
   RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
  UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='completed',profile_request_id=p_request,profile_requested_event_id=p_event WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 ELSE RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 RETURN app._assistant_module_action_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_profile_action_review_complete(uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_profile_action_review_complete(uuid,text,uuid,uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.assistant_profile_action_reviews_index()
 RETURNS TABLE(action text,action_id uuid,state text,created_at timestamptz,expires_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();p uuid;at_time timestamptz;
BEGIN
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off' THEN
  RAISE EXCEPTION 'Own review index unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF app.principal_snapshot_current() IS NOT TRUE THEN RAISE EXCEPTION 'Own review index unavailable' USING ERRCODE='42501';END IF;
 SELECT a.person_id INTO p FROM public.app_user a JOIN public.person actual ON actual.id=a.person_id AND actual.tenant_id=a.tenant_id
 WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id);
 IF p IS NULL THEN RAISE EXCEPTION 'Own review index unavailable' USING ERRCODE='42501';END IF;
 at_time:=clock_timestamp();
 RETURN QUERY SELECT r.action_kind,r.id,r.state,r.created_at,r.expires_at FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=t AND r.user_id=u AND r.person_id=p AND r.action_kind='ess.profile.request'
   AND r.created_at>=at_time-interval '30 days' AND r.created_at<=at_time
  ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END $$;
REVOKE ALL ON FUNCTION app.assistant_profile_action_reviews_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_profile_action_reviews_index() TO ai_hr_app;

--> statement-breakpoint
-- Claims completion binds native draft/current-top-level save event, never a stored raw receipt.
CREATE FUNCTION app.assistant_claim_action_review_complete(p_id uuid,p_reviewed_digest text,p_request uuid,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND action_kind='claims.draft.save' AND tenant_id=t AND user_id=u FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_own_leave_review_identity(r.person_id,r.employment_id,r.company_id);
 IF p_request IS NULL OR p_event IS NULL THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='completed' THEN
  IF r.claim_draft_id IS DISTINCT FROM p_request OR r.claim_saved_event_id IS DISTINCT FROM p_event THEN
   RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
  IF p_reviewed_digest IS DISTINCT FROM r.reviewed_digest THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.claim_request q JOIN public.employment e ON e.id=q.employment_id AND e.tenant_id=q.tenant_id
   JOIN public.domain_event d ON d.id=p_event AND d.tenant_id=q.tenant_id AND d.aggregate_type='claim-request' AND d.aggregate_id=q.id
    AND d.event_type='claim-request.draft-saved' AND d.actor_type='user' AND d.actor_id=u AND d.subject_employment_id=q.employment_id
   WHERE q.id=p_request AND q.tenant_id=t AND q.employment_id=r.employment_id AND q.status='draft'
    AND e.person_id=r.person_id AND e.company_id=r.company_id AND d.payload->>'claimTypeId'=q.claim_type_id::text
    AND (d.payload->>'claimItemId') IS NOT DISTINCT FROM q.claim_item_id::text AND d.payload->>'incurredOn'=to_char(q.incurred_on,'YYYY-MM-DD')
    AND q.xmin=pg_current_xact_id()::xid AND d.xmin=pg_current_xact_id()::xid) THEN
   RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
  UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='completed',claim_draft_id=p_request,claim_saved_event_id=p_event WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 ELSE RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 RETURN app._assistant_module_action_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_claim_action_review_complete(uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_claim_action_review_complete(uuid,text,uuid,uuid) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.assistant_claim_action_reviews_index()
 RETURNS TABLE(action text,action_id uuid,state text,created_at timestamptz,expires_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();p uuid;at_time timestamptz;
BEGIN
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off' THEN
  RAISE EXCEPTION 'Own review index unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF app.principal_snapshot_current() IS NOT TRUE THEN RAISE EXCEPTION 'Own review index unavailable' USING ERRCODE='42501';END IF;
 SELECT a.person_id INTO p FROM public.app_user a JOIN public.person actual ON actual.id=a.person_id AND actual.tenant_id=a.tenant_id
 WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id);
 IF p IS NULL THEN RAISE EXCEPTION 'Own review index unavailable' USING ERRCODE='42501';END IF;
 at_time:=clock_timestamp();
 RETURN QUERY SELECT r.action_kind,r.id,r.state,r.created_at,r.expires_at FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=t AND r.user_id=u AND r.person_id=p AND r.action_kind='claims.draft.save'
   AND r.created_at>=at_time-interval '30 days' AND r.created_at<=at_time
  ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END $$;
REVOKE ALL ON FUNCTION app.assistant_claim_action_reviews_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_claim_action_reviews_index() TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.assistant_performance_action_reviews_index(p_kind text)
 RETURNS TABLE(action text,action_id uuid,state text,created_at timestamptz,expires_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();p uuid;at_time timestamptz;
BEGIN
 IF p_kind IS NULL OR p_kind NOT IN ('performance.review.acknowledge','performance.onehr.plan.acknowledge') THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501'; END IF;
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed'
  OR current_setting('transaction_read_only')<>'off' THEN
  RAISE EXCEPTION 'Own review index unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF app.principal_snapshot_current() IS NOT TRUE THEN RAISE EXCEPTION 'Own review index unavailable' USING ERRCODE='42501';END IF;
 SELECT a.person_id INTO p FROM public.app_user a JOIN public.person actual ON actual.id=a.person_id AND actual.tenant_id=a.tenant_id
 WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id);
 IF p IS NULL THEN RAISE EXCEPTION 'Own review index unavailable' USING ERRCODE='42501';END IF;
 at_time:=clock_timestamp();
 RETURN QUERY SELECT r.action_kind,r.id,r.state,r.created_at,r.expires_at FROM app.assistant_own_leave_review r
  WHERE r.tenant_id=t AND r.user_id=u AND r.person_id=p AND r.action_kind=p_kind
   AND r.created_at>=at_time-interval '30 days' AND r.created_at<=at_time
  ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END $$;
REVOKE ALL ON FUNCTION app.assistant_performance_action_reviews_index(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_performance_action_reviews_index(text) TO ai_hr_app;

--> statement-breakpoint
-- Performance completion is event-only; each closed kind validates its actual native engine and
-- exact current acknowledgement clock/revision. No rating or narrative is copied into custody.
CREATE FUNCTION app.assistant_performance_action_review_complete(p_id uuid,p_kind text,p_reviewed_digest text,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF t IS NULL OR u IS NULL OR p_kind IS NULL OR p_kind NOT IN ('performance.review.acknowledge','performance.onehr.plan.acknowledge') OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND action_kind=p_kind AND tenant_id=t AND user_id=u FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_own_leave_review_identity(r.person_id,r.employment_id,r.company_id);
 IF p_event IS NULL THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='completed' THEN
  IF r.performance_ack_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
  IF p_reviewed_digest IS DISTINCT FROM r.reviewed_digest THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
  IF p_kind='performance.review.acknowledge' THEN
   IF NOT EXISTS(SELECT 1 FROM public.performance_review q JOIN public.employment e ON e.id=q.employment_id AND e.tenant_id=q.tenant_id
    JOIN public.review_cycle c ON c.id=q.cycle_id AND c.tenant_id=q.tenant_id
    JOIN public.domain_event d ON d.id=p_event AND d.tenant_id=q.tenant_id AND d.aggregate_type='performance-review' AND d.aggregate_id=q.id
     AND d.event_type='performance-review.acknowledged' AND d.actor_type='user' AND d.actor_id=u AND d.subject_employment_id=q.employment_id AND d.payload IS NULL
    WHERE q.tenant_id=t AND q.employment_id=r.employment_id AND e.person_id=r.person_id AND e.company_id=r.company_id
     AND q.status='acknowledged' AND q.acknowledged_at IS NOT NULL AND c.released_at IS NOT NULL AND q.acknowledged_at=d.occurred_at
     AND NOT EXISTS(SELECT 1 FROM public.performance_onehr_cycle configured WHERE configured.cycle_id=q.cycle_id AND configured.tenant_id=q.tenant_id)
     AND q.xmin=pg_current_xact_id()::xid AND d.xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
  ELSE
   IF NOT EXISTS(SELECT 1 FROM public.performance_onehr_plan q JOIN public.employment e ON e.id=q.employment_id AND e.tenant_id=q.tenant_id
    JOIN public.domain_event d ON d.id=p_event AND d.tenant_id=q.tenant_id AND d.aggregate_type='onehr' AND d.aggregate_id=q.id
     AND d.event_type='onehr.plan-acknowledged' AND d.actor_type='user' AND d.actor_id=u AND d.subject_employment_id=q.employment_id
    WHERE q.tenant_id=t AND q.employment_id=r.employment_id AND e.person_id=r.person_id AND e.company_id=r.company_id AND q.status='closed' AND q.acknowledged_at IS NOT NULL
     AND d.payload=jsonb_build_object('version',1,'planRevision',q.revision,'acknowledgedAt',to_char(q.acknowledged_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
     AND q.xmin=pg_current_xact_id()::xid AND d.xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
  END IF;
  UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='completed',performance_ack_event_id=p_event WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 ELSE RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 RETURN app._assistant_module_action_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_performance_action_review_complete(uuid,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_performance_action_review_complete(uuid,text,text,uuid) TO ai_hr_app;

--> statement-breakpoint
-- Closed USER-scoped Testing custody. No person/employment is manufactured for standalone testers.
-- Current original login and NULL-safe actual person binding still gate private pending content.
CREATE FUNCTION app._assistant_testing_review_identity(p_person uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF app.principal_snapshot_current() IS NOT TRUE OR app.testing_live_principal() IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.person_id IS NOT DISTINCT FROM p_person AND (p_person IS NULL OR EXISTS(SELECT 1 FROM public.person p WHERE p.id=p_person AND p.tenant_id=t))) THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_testing_review_identity(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_testing_action_review_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',jsonb_build_object('actionId',r.id,'action',r.action_kind,'contractVersion',1,
 'binding',jsonb_build_object('tenantId',r.tenant_id,'userId',r.user_id,'personId',r.person_id,'employmentId',r.employment_id,'companyId',r.company_id,'executionId',r.testing_execution_id),
 'intentDigest',r.intent_digest,'reviewedDigest',r.reviewed_digest,'state',r.state,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 'sealed',CASE WHEN r.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN jsonb_build_object('formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,
 'runId',r.testing_run_id,'eventId',r.testing_event_id)
 FROM app.assistant_own_leave_review r LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=r.id WHERE r.id=p_id AND r.action_kind='system_testing.execution.save';
$$;
REVOKE ALL ON FUNCTION app._assistant_testing_action_review_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_testing_action_review_prepare(p_id uuid,p_person uuid,p_execution uuid,
 p_intent_digest text,p_reviewed_digest text,p_kid text,p_wrapped_dek text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE at_time timestamptz;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 PERFORM app._assistant_testing_review_identity(p_person);
 IF NOT EXISTS(SELECT 1 FROM public.test_execution e WHERE e.id=p_execution AND e.tenant_id=t AND e.tester_user_id=u) THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 -- A preparation in the same privacy-erasure transaction must not create new uncaptured private text.
 IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id()
  AND i.tenant_id=t AND i.person_id=p_person)
  OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id()
   AND i.tenant_id=t AND i.person_id=p_person) THEN
  RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 IF p_id IS NULL OR p_intent_digest IS NULL OR p_intent_digest !~ '^[a-f0-9]{64}$'
  OR p_reviewed_digest IS NULL OR p_reviewed_digest !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$'
  OR p_wrapped_dek IS NULL OR length(p_wrapped_dek) NOT BETWEEN 1 AND 512
  OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 819200 THEN
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
  (action_kind,id,tenant_id,user_id,person_id,testing_execution_id,intent_digest,reviewed_digest,state,created_at,expires_at)
 VALUES('system_testing.execution.save',p_id,t,u,p_person,p_execution,
  p_intent_digest,p_reviewed_digest,'awaiting_confirmation',at_time,at_time+interval '10 minutes') ON CONFLICT(id) DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped_dek,p_ciphertext);
 RETURN app._assistant_testing_action_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_testing_action_review_prepare(uuid,uuid,uuid,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_testing_action_review_prepare(uuid,uuid,uuid,text,text,text,text,text) TO ai_hr_app;

--> statement-breakpoint
-- Nomination only: no custody row lock or private body before canonical source ownership.
CREATE FUNCTION app.assistant_testing_action_review_subject(p_id uuid) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF t IS NULL OR u IS NULL THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='system_testing.execution.save';
 IF NOT FOUND THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_testing_review_identity(r.person_id);RETURN r.testing_execution_id;
END $$;
REVOKE ALL ON FUNCTION app.assistant_testing_action_review_subject(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_testing_action_review_subject(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_testing_action_review_read(p_id uuid,p_discard boolean DEFAULT false,p_reviewed_digest text DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();actual_person uuid;
BEGIN
 SELECT person_id INTO actual_person FROM public.app_user WHERE id=u AND tenant_id=t;
 PERFORM app._assistant_testing_review_identity(actual_person);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='system_testing.execution.save' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 -- A relinked/revoked caller may only discard, never receive a decrypted pending report.
 IF p_discard IS NOT TRUE THEN PERFORM app._assistant_testing_review_identity(r.person_id);END IF;
 IF p_discard IS TRUE AND r.state='awaiting_confirmation' AND p_reviewed_digest IS DISTINCT FROM r.reviewed_digest THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' THEN
  IF clock_timestamp()>=r.expires_at THEN UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='expired' WHERE id=r.id;
  ELSIF p_discard IS TRUE THEN UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='discarded' WHERE id=r.id;END IF;
 END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review a WHERE c.action_id=a.id AND a.id=r.id AND a.state<>'awaiting_confirmation';
 RETURN app._assistant_testing_action_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_testing_action_review_read(uuid,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_testing_action_review_read(uuid,boolean,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_testing_action_review_complete(p_id uuid,p_reviewed_digest text,p_run uuid,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();actual_person uuid;
BEGIN
 SELECT person_id INTO actual_person FROM public.app_user WHERE id=u AND tenant_id=t;
 PERFORM app._assistant_testing_review_identity(actual_person);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='system_testing.execution.save' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_testing_review_identity(r.person_id);
 IF p_run IS NULL OR p_event IS NULL THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='completed' THEN
  IF r.testing_run_id IS DISTINCT FROM p_run OR r.testing_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
  IF p_reviewed_digest IS DISTINCT FROM r.reviewed_digest THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
  -- Exact current original-actor native run/event and head must have been written by THIS top-level
  -- transaction. Child-savepoint and previously committed rows cannot be laundered as completion.
  -- xmin is custody proof, not proof arbitrary SQL used the trusted canonical command.
  IF NOT EXISTS(SELECT 1 FROM app.testing_own_execution_event_source(p_run,p_event) source
   JOIN public.test_run n ON n.id=source.run_id AND n.tenant_id=t
   JOIN public.test_execution e ON e.id=source.execution_id AND e.tenant_id=t
   JOIN public.domain_event d ON d.id=source.event_id AND d.tenant_id=t
   WHERE source.execution_id=r.testing_execution_id AND n.xmin=pg_current_xact_id()::xid AND e.xmin=pg_current_xact_id()::xid AND d.xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
  UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='completed',testing_run_id=p_run,testing_event_id=p_event WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 ELSE RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 RETURN app._assistant_testing_action_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_testing_action_review_complete(uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_testing_action_review_complete(uuid,text,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_testing_action_reviews_index()
 RETURNS TABLE(action text,action_id uuid,state text,created_at timestamptz,expires_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();actual_person uuid;
BEGIN
 SELECT person_id INTO actual_person FROM public.app_user WHERE id=u AND tenant_id=t;PERFORM app._assistant_testing_review_identity(actual_person);
 RETURN QUERY SELECT r.action_kind,r.id,r.state,r.created_at,r.expires_at FROM app.assistant_own_leave_review r
 WHERE r.tenant_id=t AND r.user_id=u AND r.person_id IS NOT DISTINCT FROM actual_person AND r.action_kind='system_testing.execution.save'
 ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END $$;
REVOKE ALL ON FUNCTION app.assistant_testing_action_reviews_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_testing_action_reviews_index() TO ai_hr_app;

--> statement-breakpoint
-- Existing human claim DRAFT submission shares the exact same custody, admission and retirement.
CREATE FUNCTION app._assistant_claim_submission_review_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',jsonb_build_object('actionId',r.id,'action',r.action_kind,'contractVersion',1,
 'binding',jsonb_build_object('tenantId',r.tenant_id,'userId',r.user_id,'personId',r.person_id,'employmentId',r.employment_id,'companyId',r.company_id),
 'intentDigest',r.intent_digest,'reviewedDigest',r.reviewed_digest,'state',r.state,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 'sealed',CASE WHEN r.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN jsonb_build_object('formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,
 'claimId',r.claim_submission_id,'eventId',r.claim_submitted_event_id)
 FROM app.assistant_own_leave_review r LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=r.id WHERE r.id=p_id AND r.action_kind='claims.submit';
$$;
REVOKE ALL ON FUNCTION app._assistant_claim_submission_review_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_claim_submission_review_prepare(p_id uuid,p_person uuid,p_employment uuid,p_company uuid,p_claim uuid,
 p_intent_digest text,p_reviewed_digest text,p_kid text,p_wrapped_dek text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE at_time timestamptz;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 PERFORM app._assistant_own_leave_review_identity(p_person,p_employment,p_company);
 IF NOT EXISTS(SELECT 1 FROM public.claim_request q WHERE q.id=p_claim AND q.tenant_id=t AND q.employment_id=p_employment AND q.status='draft') THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
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
  (action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,claim_submission_id,intent_digest,reviewed_digest,state,created_at,expires_at)
 VALUES('claims.submit',p_id,t,u,p_person,p_employment,p_company,p_claim,
  p_intent_digest,p_reviewed_digest,'awaiting_confirmation',at_time,at_time+interval '10 minutes') ON CONFLICT(id) DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped_dek,p_ciphertext);
 RETURN app._assistant_claim_submission_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_claim_submission_review_prepare(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_claim_submission_review_prepare(uuid,uuid,uuid,uuid,uuid,text,text,text,text,text) TO ai_hr_app;

--> statement-breakpoint
-- Nomination only; native claimLimit TRY ownership must precede custody-row locks in the command.
CREATE FUNCTION app.assistant_claim_submission_review_subject(p_id uuid) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF t IS NULL OR u IS NULL THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='claims.submit';
 IF NOT FOUND THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_own_leave_review_identity(r.person_id,r.employment_id,r.company_id);RETURN r.claim_submission_id;
END $$;
REVOKE ALL ON FUNCTION app.assistant_claim_submission_review_subject(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_claim_submission_review_subject(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_claim_submission_review_read(p_id uuid,p_discard boolean DEFAULT false,p_reviewed_digest text DEFAULT NULL) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='claims.submit' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_own_leave_review_identity(r.person_id,r.employment_id,r.company_id);
 IF p_discard IS TRUE AND r.state='awaiting_confirmation' AND p_reviewed_digest IS DISTINCT FROM r.reviewed_digest THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' THEN
  IF clock_timestamp()>=r.expires_at THEN UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='expired' WHERE id=r.id;
  ELSIF p_discard IS TRUE THEN UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='discarded' WHERE id=r.id;END IF;
 END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review a WHERE c.action_id=a.id AND a.id=r.id AND a.state<>'awaiting_confirmation';
 RETURN app._assistant_claim_submission_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_claim_submission_review_read(uuid,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_claim_submission_review_read(uuid,boolean,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_claim_submission_review_complete(p_id uuid,p_reviewed_digest text,p_claim uuid,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='claims.submit' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_own_leave_review_identity(r.person_id,r.employment_id,r.company_id);
 IF p_claim IS NULL OR p_claim IS DISTINCT FROM r.claim_submission_id OR p_event IS NULL THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='completed' THEN
  IF r.claim_submitted_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
  IF p_reviewed_digest IS DISTINCT FROM r.reviewed_digest THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
  -- Native canonical command owns provenance; these row versions reject old/child source writes.
  IF NOT EXISTS(SELECT 1 FROM public.claim_request q JOIN public.employment e ON e.id=q.employment_id AND e.tenant_id=q.tenant_id
   JOIN public.domain_event d ON d.id=p_event AND d.tenant_id=q.tenant_id AND d.aggregate_type='claim-request' AND d.aggregate_id=q.id
    AND d.event_type='claim-request.submitted' AND d.actor_type='user' AND d.actor_id=u AND d.subject_employment_id=q.employment_id
   WHERE q.id=p_claim AND q.tenant_id=t AND q.employment_id=r.employment_id AND e.person_id=r.person_id AND e.company_id=r.company_id AND q.status='pending'
    AND d.payload=jsonb_build_object('claimTypeId',q.claim_type_id,'claimItemId',q.claim_item_id,'incurredOn',q.incurred_on,'taxable',q.taxable,'fromDraft',true)
    AND q.xmin=pg_current_xact_id()::xid AND d.xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
  UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='completed',claim_submitted_event_id=p_event WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 ELSE RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 RETURN app._assistant_claim_submission_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_claim_submission_review_complete(uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_claim_submission_review_complete(uuid,text,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_claim_submission_reviews_index()
 RETURNS TABLE(action text,action_id uuid,state text,created_at timestamptz,expires_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();p uuid;
BEGIN
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 SELECT a.person_id INTO p FROM public.app_user a JOIN public.person actual ON actual.id=a.person_id AND actual.tenant_id=a.tenant_id WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id);
 IF p IS NULL OR app.principal_snapshot_current() IS NOT TRUE THEN RAISE EXCEPTION 'Module review unavailable' USING ERRCODE='42501';END IF;
 RETURN QUERY SELECT r.action_kind,r.id,r.state,r.created_at,r.expires_at FROM app.assistant_own_leave_review r WHERE r.tenant_id=t AND r.user_id=u AND r.person_id=p AND r.action_kind='claims.submit' ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END $$;
REVOKE ALL ON FUNCTION app.assistant_claim_submission_reviews_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_claim_submission_reviews_index() TO ai_hr_app;

--> statement-breakpoint
-- Closed non-own Org custody. No owner-only table grants, synthetic employee or generic effect RPC.
CREATE FUNCTION app._assistant_org_review_identity(p_person uuid,p_bind_actor boolean DEFAULT true) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'Org review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app.access_workforce_write_lock();
 IF app.principal_snapshot_current() IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t
  AND a.archived_at IS NULL AND NOT app.login_blocked(a.id)
  AND (p_bind_actor IS NOT TRUE OR a.person_id IS NOT DISTINCT FROM p_person)
  AND (a.person_id IS NULL OR EXISTS(SELECT 1 FROM public.person p WHERE p.id=a.person_id AND p.tenant_id=t))) THEN RAISE EXCEPTION 'Org review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_org_review_identity(uuid,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_org_review_source(p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_org_review_identity(p_person);
 IF NOT pg_try_advisory_xact_lock(hashtextextended('leave-dependency-configuration:'||app.current_tenant_id()::text,0)) THEN RAISE EXCEPTION 'Org review unavailable' USING ERRCODE='55P03';END IF;
 IF app.access_workforce_employment(p_employment,'workforce.maintain') IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND e.company_id=p_company AND e.person_id=p_subject_person) THEN RAISE EXCEPTION 'Org review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_org_review_source(uuid,uuid,uuid,uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_org_review_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',jsonb_build_object('actionId',r.id,'action',r.action_kind,
 'binding',jsonb_build_object('tenantId',r.tenant_id,'userId',r.user_id,'personId',r.person_id,'employmentId',r.employment_id,'companyId',r.company_id,'subjectPersonId',r.org_subject_person_id),
 'managerPersonId',r.org_manager_person_id,'previousManagerPersonId',r.org_previous_manager_person_id,'intentDigest',r.intent_digest,'reviewedDigest',r.reviewed_digest,'state',r.state,
 'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 'sealed',CASE WHEN r.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN jsonb_build_object('formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,
 'reportingLineId',r.reporting_line_id,'setEventId',r.reporting_set_event_id)
 FROM app.assistant_own_leave_review r LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=r.id WHERE r.id=p_id AND r.action_kind='org.reporting.change';
$$;
REVOKE ALL ON FUNCTION app._assistant_org_review_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_org_review_prepare(p_id uuid,p_person uuid,p_employment uuid,p_company uuid,p_subject_person uuid,p_manager uuid,p_previous_manager uuid,p_line_type text,p_intent_digest text,p_reviewed_digest text,p_kid text,p_wrapped_dek text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();at_time timestamptz;manager_person uuid;previous_person uuid;actual_previous uuid;people uuid[];
BEGIN
 PERFORM app._assistant_org_review_source(p_person,p_employment,p_company,p_subject_person);
 IF p_line_type IS NULL OR p_line_type NOT IN ('administrative','functional') OR app.access_workforce_employment(p_manager,'workforce.view') IS NOT TRUE THEN RAISE EXCEPTION 'Org review unavailable' USING ERRCODE='42501';END IF;
 SELECT e.person_id INTO manager_person FROM public.employment e WHERE e.tenant_id=t AND e.id=p_manager;
 IF (SELECT count(*) FROM public.reporting_line r WHERE r.tenant_id=t AND r.subordinate_employment_id=p_employment AND r.line_type=p_line_type AND r.valid_to IS NULL AND r.superseded_at IS NULL)>1 THEN RAISE EXCEPTION 'Org review unavailable' USING ERRCODE='42501';END IF;
 SELECT r.manager_employment_id INTO actual_previous FROM public.reporting_line r WHERE r.tenant_id=t AND r.subordinate_employment_id=p_employment AND r.line_type=p_line_type AND r.valid_to IS NULL AND r.superseded_at IS NULL;
 IF actual_previous IS DISTINCT FROM p_previous_manager OR manager_person IS NULL THEN RAISE EXCEPTION 'Org review unavailable' USING ERRCODE='42501';END IF;
 IF actual_previous IS NOT NULL THEN
  IF app.access_workforce_employment(actual_previous,'workforce.view') IS NOT TRUE THEN RAISE EXCEPTION 'Org review unavailable' USING ERRCODE='42501';END IF;
  SELECT e.person_id INTO previous_person FROM public.employment e WHERE e.id=actual_previous AND e.tenant_id=t;
  IF previous_person IS NULL THEN RAISE EXCEPTION 'Org review unavailable' USING ERRCODE='42501';END IF;
 END IF;
 people:=ARRAY[p_person,p_subject_person,manager_person,previous_person];
 IF EXISTS(SELECT 1 FROM app.home_greeting_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=ANY(people)) OR EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=t AND i.person_id=ANY(people)) THEN RAISE EXCEPTION 'Org review unavailable' USING ERRCODE='42501';END IF;
 IF p_id IS NULL OR p_intent_digest IS NULL OR p_intent_digest !~ '^[a-f0-9]{64}$' OR p_reviewed_digest IS NULL OR p_reviewed_digest !~ '^[a-f0-9]{64}$' OR p_kid IS NULL OR p_kid !~ '^[a-f0-9]{16}$' OR p_wrapped_dek IS NULL OR length(p_wrapped_dek) NOT BETWEEN 1 AND 512 OR p_ciphertext IS NULL OR octet_length(p_ciphertext) NOT BETWEEN 1 AND 65536 THEN RAISE EXCEPTION 'Org review unavailable' USING ERRCODE='22023';END IF;
 at_time:=clock_timestamp();
 IF (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND state='awaiting_confirmation' AND expires_at>at_time)>=5 OR (SELECT count(*) FROM app.assistant_own_leave_review WHERE tenant_id=t AND user_id=u AND created_at>at_time-interval '10 minutes')>=20 THEN RAISE EXCEPTION 'Org review unavailable' USING ERRCODE='54000';END IF;
 INSERT INTO app.assistant_own_leave_review(action_kind,id,tenant_id,user_id,person_id,employment_id,company_id,org_subject_person_id,org_manager_person_id,org_previous_manager_person_id,intent_digest,reviewed_digest,state,created_at,expires_at)
 VALUES('org.reporting.change',p_id,t,u,p_person,p_employment,p_company,p_subject_person,manager_person,previous_person,p_intent_digest,p_reviewed_digest,'awaiting_confirmation',at_time,at_time+interval '10 minutes') ON CONFLICT(id) DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'Org review unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped_dek,p_ciphertext);RETURN app._assistant_org_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_org_review_prepare(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_org_review_prepare(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,text,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_org_review_subject(p_id uuid) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_org_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='org.reporting.change';
 IF NOT FOUND THEN RAISE EXCEPTION 'Org review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_org_review_source(r.person_id,r.employment_id,r.company_id,r.org_subject_person_id);RETURN r.employment_id;
END $$;
REVOKE ALL ON FUNCTION app.assistant_org_review_subject(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_org_review_subject(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_org_review_read(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app.assistant_org_review_subject(p_id);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='org.reporting.change' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Org review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at THEN
  UPDATE app.assistant_own_leave_review SET state='expired',intent_digest=NULL,reviewed_digest=NULL,org_manager_person_id=NULL,org_previous_manager_person_id=NULL WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 END IF;
 RETURN app._assistant_org_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_org_review_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_org_review_read(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Top-level versions reject older/savepoint evidence; they do not establish arbitrary SQL used
-- the canonical graph engine. The trusted source command remains the native provenance owner.
CREATE FUNCTION app.assistant_org_review_complete(p_id uuid,p_digest text,p_line uuid,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;q public.reporting_line%ROWTYPE;d public.domain_event%ROWTYPE;
BEGIN
 PERFORM app.assistant_org_review_read(p_id);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='org.reporting.change' FOR UPDATE NOWAIT;
 IF NOT FOUND OR p_line IS NULL OR p_event IS NULL THEN RAISE EXCEPTION 'Org review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='completed' THEN
  IF r.reporting_line_id IS DISTINCT FROM p_line OR r.reporting_set_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Org review unavailable' USING ERRCODE='42501';END IF;
 ELSE
  IF r.state<>'awaiting_confirmation' OR p_digest IS NULL OR r.reviewed_digest IS DISTINCT FROM p_digest OR clock_timestamp()>=r.expires_at THEN RAISE EXCEPTION 'Org review unavailable' USING ERRCODE='42501';END IF;
  SELECT * INTO q FROM public.reporting_line WHERE id=p_line AND tenant_id=r.tenant_id AND subordinate_employment_id=r.employment_id AND line_type IN ('administrative','functional') AND valid_to IS NULL AND superseded_at IS NULL AND xmin=pg_current_xact_id()::xid;
  IF NOT FOUND OR app.access_workforce_employment(q.manager_employment_id,'workforce.view') IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=q.manager_employment_id AND e.tenant_id=r.tenant_id AND e.person_id=r.org_manager_person_id) THEN RAISE EXCEPTION 'Org review unavailable' USING ERRCODE='42501';END IF;
  SELECT * INTO d FROM public.domain_event WHERE id=p_event AND tenant_id=r.tenant_id AND aggregate_type='reporting-line' AND aggregate_id=p_line AND event_type='reporting-line.set' AND actor_type='user' AND actor_id=r.user_id AND subject_employment_id=r.employment_id AND xmin=pg_current_xact_id()::xid;
  IF NOT FOUND OR d.payload->>'subordinateEmploymentId' IS DISTINCT FROM q.subordinate_employment_id::text OR d.payload->>'managerEmploymentId' IS DISTINCT FROM q.manager_employment_id::text OR d.payload->>'lineType' IS DISTINCT FROM q.line_type::text OR d.payload->>'validFrom' IS DISTINCT FROM q.valid_from::text OR d.payload->'movement'->>'type' IS DISTINCT FROM 'reportingLineChange' OR coalesce(d.payload->'movement'->>'groupId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN RAISE EXCEPTION 'Org review unavailable' USING ERRCODE='42501';END IF;
  UPDATE app.assistant_own_leave_review SET state='completed',intent_digest=NULL,reviewed_digest=NULL,org_manager_person_id=NULL,org_previous_manager_person_id=NULL,reporting_line_id=p_line,reporting_set_event_id=p_event WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 END IF;
 RETURN app._assistant_org_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_org_review_complete(uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_org_review_complete(uuid,text,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Current-login-only privacy retirement. Deliberately returns no target IDs/body/digest/native refs.
CREATE FUNCTION app.assistant_org_review_discard(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;
BEGIN
 PERFORM app._assistant_org_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=app.current_tenant_id() AND user_id=app.current_user_id() AND action_kind='org.reporting.change' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Org review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' THEN
  UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL,org_manager_person_id=NULL,org_previous_manager_person_id=NULL WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 END IF;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id;
 RETURN jsonb_build_object('action','org.reporting.change','contractVersion',1,'actionId',r.id,'state',r.state);
END $$;
REVOKE ALL ON FUNCTION app.assistant_org_review_discard(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_org_review_discard(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_org_reviews_index() RETURNS TABLE("actionId" uuid,state text,"createdAt" text,"expiresAt" text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_org_review_identity(NULL,false);
 RETURN QUERY SELECT r.id,r.state,to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM app.assistant_own_leave_review r WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.action_kind='org.reporting.change' AND r.created_at>=clock_timestamp()-interval '30 days' ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END $$;
REVOKE ALL ON FUNCTION app.assistant_org_reviews_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_org_reviews_index() TO ai_hr_app;

--> statement-breakpoint
-- Knowledge article custody uses the actual admin LOGIN and nullable actor person. It never creates
-- a dummy employment/company or turns a current metadata receipt into an original-body assertion.
CREATE FUNCTION app._assistant_knowledge_review_identity(p_person uuid,p_bind_actor boolean DEFAULT true) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 IF t IS NULL OR u IS NULL OR current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN RAISE EXCEPTION 'Article review unavailable' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('access-configuration:'||t::text,0));
 IF app.principal_snapshot_current() IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.app_user a WHERE a.id=u AND a.tenant_id=t AND a.archived_at IS NULL AND NOT app.login_blocked(a.id)
  AND (p_bind_actor IS NOT TRUE OR a.person_id IS NOT DISTINCT FROM p_person)
  AND (a.person_id IS NULL OR EXISTS(SELECT 1 FROM public.person p WHERE p.id=a.person_id AND p.tenant_id=t))) THEN RAISE EXCEPTION 'Article review unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION app._assistant_knowledge_review_identity(uuid,boolean) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app._assistant_knowledge_article_review_json(p_id uuid) RETURNS jsonb
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT jsonb_build_object('metadata',jsonb_build_object('actionId',r.id,'action',r.action_kind,'contractVersion',1,
 'binding',jsonb_build_object('tenantId',r.tenant_id,'userId',r.user_id,'personId',r.person_id,'employmentId',r.employment_id,'companyId',r.company_id),
 'intentDigest',r.intent_digest,'reviewedDigest',r.reviewed_digest,'state',r.state,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'expiresAt',to_char(r.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
 'sealed',CASE WHEN r.state='awaiting_confirmation' AND c.action_id IS NOT NULL THEN jsonb_build_object('formatVersion',1,'kid',c.kid,'wrappedDek',c.wrapped_dek,'ciphertext',c.ciphertext) ELSE NULL END,
 'articleId',r.knowledge_article_id,'eventId',r.knowledge_created_event_id)
 FROM app.assistant_own_leave_review r LEFT JOIN app.assistant_own_leave_review_content c ON c.action_id=r.id WHERE r.id=p_id AND r.action_kind='knowledge_base.article.create';
$$;
REVOKE ALL ON FUNCTION app._assistant_knowledge_article_review_json(uuid) FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_knowledge_article_review_prepare(p_id uuid,p_person uuid,
 p_intent_digest text,p_reviewed_digest text,p_kid text,p_wrapped_dek text,p_ciphertext text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE at_time timestamptz;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 PERFORM app._assistant_knowledge_review_identity(p_person);
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
  (action_kind,id,tenant_id,user_id,person_id,intent_digest,reviewed_digest,state,created_at,expires_at)
 VALUES('knowledge_base.article.create',p_id,t,u,p_person,
  p_intent_digest,p_reviewed_digest,'awaiting_confirmation',at_time,at_time+interval '10 minutes') ON CONFLICT(id) DO NOTHING;
 IF NOT FOUND THEN RAISE EXCEPTION 'Own-leave review unavailable' USING ERRCODE='42501';END IF;
 INSERT INTO app.assistant_own_leave_review_content VALUES(p_id,p_kid,p_wrapped_dek,p_ciphertext);
 RETURN app._assistant_knowledge_article_review_json(p_id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_knowledge_article_review_prepare(uuid,uuid,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_knowledge_article_review_prepare(uuid,uuid,text,text,text,text,text) TO ai_hr_app;

--> statement-breakpoint
CREATE FUNCTION app.assistant_knowledge_article_review_read(p_id uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 PERFORM app._assistant_knowledge_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='knowledge_base.article.create' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Article review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_knowledge_review_identity(r.person_id);
 IF r.state='awaiting_confirmation' AND clock_timestamp()>=r.expires_at THEN UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='expired' WHERE id=r.id;END IF;
 DELETE FROM app.assistant_own_leave_review_content c USING app.assistant_own_leave_review a WHERE c.action_id=a.id AND a.id=r.id AND a.state<>'awaiting_confirmation';
 RETURN app._assistant_knowledge_article_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_knowledge_article_review_read(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_knowledge_article_review_read(uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_knowledge_article_review_complete(p_id uuid,p_reviewed_digest text,p_article uuid,p_event uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 PERFORM app._assistant_knowledge_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='knowledge_base.article.create' FOR UPDATE NOWAIT;
 IF NOT FOUND THEN RAISE EXCEPTION 'Article review unavailable' USING ERRCODE='42501';END IF;
 PERFORM app._assistant_knowledge_review_identity(r.person_id);
 IF p_article IS NULL OR p_event IS NULL THEN RAISE EXCEPTION 'Article review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='completed' THEN
  IF r.knowledge_article_id IS DISTINCT FROM p_article OR r.knowledge_created_event_id IS DISTINCT FROM p_event THEN RAISE EXCEPTION 'Article review unavailable' USING ERRCODE='42501';END IF;
 ELSIF r.state='awaiting_confirmation' AND clock_timestamp()<r.expires_at THEN
  IF p_reviewed_digest IS DISTINCT FROM r.reviewed_digest THEN RAISE EXCEPTION 'Article review unavailable' USING ERRCODE='42501';END IF;
  -- Exact original-actor native creation in THIS top-level transaction. Row versions reject old or
  -- child-savepoint evidence; trusted source ownership, not xmin alone, proves canonical provenance.
  IF NOT EXISTS(SELECT 1 FROM public.kb_document q JOIN public.domain_event d ON d.id=p_event AND d.tenant_id=q.tenant_id
   AND d.aggregate_type='kb-document' AND d.aggregate_id=q.id AND d.event_type='kb.document.created' AND d.actor_type='user' AND d.actor_id=u AND d.subject_employment_id IS NULL
   WHERE q.id=p_article AND q.tenant_id=t AND q.kind='article' AND q.created_by_user_id=u AND q.archived_at IS NULL
    AND d.payload=jsonb_build_object('kind','article','title',q.title,'category',q.category,'audience',q.audience)
    AND q.xmin=pg_current_xact_id()::xid AND d.xmin=pg_current_xact_id()::xid) THEN RAISE EXCEPTION 'Article review unavailable' USING ERRCODE='42501';END IF;
  UPDATE app.assistant_own_leave_review SET intent_digest=NULL,reviewed_digest=NULL,state='completed',knowledge_article_id=p_article,knowledge_created_event_id=p_event WHERE id=r.id;
  DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 ELSE RAISE EXCEPTION 'Article review unavailable' USING ERRCODE='42501';END IF;
 RETURN app._assistant_knowledge_article_review_json(r.id);
END $$;
REVOKE ALL ON FUNCTION app.assistant_knowledge_article_review_complete(uuid,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_knowledge_article_review_complete(uuid,text,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- Login-only metadata/discard after module/grant/author revocation or person relinking. No article
-- references, title, audience or human content are projected; completed effects cannot be discarded.
CREATE FUNCTION app.assistant_knowledge_article_review_discard(p_id uuid,p_reviewed_digest text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE r app.assistant_own_leave_review%ROWTYPE;t uuid:=app.current_tenant_id();u uuid:=app.current_user_id();
BEGIN
 PERFORM app._assistant_knowledge_review_identity(NULL,false);
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=p_id AND tenant_id=t AND user_id=u AND action_kind='knowledge_base.article.create' FOR UPDATE NOWAIT;
 IF NOT FOUND OR r.state='completed' THEN RAISE EXCEPTION 'Article review unavailable' USING ERRCODE='42501';END IF;
 IF r.state='awaiting_confirmation' THEN
  IF r.reviewed_digest IS DISTINCT FROM p_reviewed_digest THEN RAISE EXCEPTION 'Article review unavailable' USING ERRCODE='42501';END IF;
  UPDATE app.assistant_own_leave_review SET state=CASE WHEN clock_timestamp()>=r.expires_at THEN 'expired' ELSE 'discarded' END,intent_digest=NULL,reviewed_digest=NULL WHERE id=r.id;
 END IF;
 DELETE FROM app.assistant_own_leave_review_content WHERE action_id=r.id;
 SELECT * INTO r FROM app.assistant_own_leave_review WHERE id=r.id;
 RETURN jsonb_build_object('action','knowledge_base.article.create','contractVersion',1,'actionId',r.id,'state',r.state);
END $$;
REVOKE ALL ON FUNCTION app.assistant_knowledge_article_review_discard(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_knowledge_article_review_discard(uuid,text) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.assistant_knowledge_article_reviews_index()
 RETURNS TABLE(action text,action_id uuid,state text,created_at timestamptz,expires_at timestamptz)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM app._assistant_knowledge_review_identity(NULL,false);
 RETURN QUERY SELECT r.action_kind,r.id,r.state,r.created_at,r.expires_at FROM app.assistant_own_leave_review r
 WHERE r.tenant_id=app.current_tenant_id() AND r.user_id=app.current_user_id() AND r.action_kind='knowledge_base.article.create' ORDER BY r.created_at DESC,r.id DESC LIMIT 25;
END $$;
REVOKE ALL ON FUNCTION app.assistant_knowledge_article_reviews_index() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.assistant_knowledge_article_reviews_index() TO ai_hr_app;
