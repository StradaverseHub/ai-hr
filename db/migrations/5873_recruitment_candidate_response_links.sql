-- Recruitment slice 21b (docs/recruitment-reconstruction/specification.md "Slice 21"; D-063, D-066): signed accept links. An interview
-- invitation and an offer e-mail may carry ONE link on the installation's own careers host, `/careers/r/<token>`: a random token whose
-- sha256 is stored, for one interview or one offer. Opening it shows what it is about and changes nothing; the candidate's Accept or
-- Decline (a POST) answers. An interview answer sets the interview's candidate response (a person may still change it); an offer
-- answer is recorded as the candidate's reply for HR, who records the decision (a link never moves or archives an application).
--
-- Who:
--   issue a link   — app.recruitment_response_link_issue, by the person queueing the e-mail, in the same transaction that scheduled
--                    the interview (created_at = now(), by them) or sent the offer by e-mail (sent_at = now(), by them).
--   view, answer   — app.recruitment_response_view and app.recruitment_response_answer, anonymous only, by the token's sha256; the
--                    answer is limited to 20 an hour per client hash. A link answers only while its interview is open, not started,
--                    at the start it was issued for and its application active; or while its offer is approved, sent at the time it
--                    was issued for, undecided and not past its validity. An answer can be changed while that holds.
--   HR reads       — app.recruitment_offer_candidate_reply, for the job's reviewers.
-- The e-mail row freezes the link (response_url) as it freezes the map link (5871): the frozen text with exactly these links removed
-- must still be link-free; the statement check confirms the link was issued in this transaction for this interview or offer.
--
-- What this installs:
--   1. app.recruitment_response_link and app.recruitment_response_attempt (owner-only).
--   2. recruitment_candidate_email.response_url (invitations and offer e-mails only), the body-text and content CHECKs restated with it.
--   3. The placeholder {responseLink} for invitations and offers (app.recruitment_candidate_email_placeholders_ok restated).
--   4. 5871's guard, statement check and purge restated with the link; the definers above; one owner-only UPDATE policy on
--      recruitment_interview for the answer; 5869's app.recruitment_guard_interview_place restated (its body, plus: the owner inside
--      an answer may change only the candidate response).
--
-- PRECONDITION: applies after 5872.

-- ── 1. Links and answer attempts (owner-only) ───────────────────────────────────────────────────────────────
CREATE TABLE app.recruitment_response_link (
 token_digest text PRIMARY KEY CHECK (token_digest ~ '^[0-9a-f]{64}$'),
 tenant_id uuid NOT NULL,
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 application_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('interview','offer')),
 interview_id uuid,
 interview_starts_at timestamptz,
 offer_id uuid,
 offer_sent_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 answer text CHECK (answer IS NULL OR answer IN ('accepted','declined')),
 answered_at timestamptz,
 CONSTRAINT recruitment_response_link_kind_ck CHECK ((kind = 'interview') = (interview_id IS NOT NULL AND interview_starts_at IS NOT NULL)
  AND (kind = 'offer') = (offer_id IS NOT NULL AND offer_sent_at IS NOT NULL)),
 CONSTRAINT recruitment_response_link_answer_ck CHECK ((answer IS NULL) = (answered_at IS NULL))
);
CREATE INDEX recruitment_response_link_interview_idx ON app.recruitment_response_link (interview_id) WHERE interview_id IS NOT NULL;
CREATE INDEX recruitment_response_link_offer_idx ON app.recruitment_response_link (offer_id, offer_sent_at) WHERE offer_id IS NOT NULL;
CREATE TABLE app.recruitment_response_attempt (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 client_hash text NOT NULL CHECK (client_hash ~ '^[0-9a-f]{64}$'),
 attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recruitment_response_attempt_client_idx ON app.recruitment_response_attempt (client_hash, attempted_at);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_response_link','recruitment_response_attempt'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC, ai_hr_app', t);
  EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass)))'
   ' WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass)))',
   t || '_owner', t, 'app.' || t, 'app.' || t);
 END LOOP;
END $$;
--> statement-breakpoint

-- ── 2. The frozen link on an e-mail ──────────────────────────────────────────────────────────────────────────
-- The token's sha256 of a frozen link (NULL for anything that is not exactly an https careers response link).
CREATE FUNCTION app.recruitment_response_url_digest(p_url text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT CASE WHEN p_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/careers/r/[A-Za-z0-9_-]{43}$'
  THEN encode(sha256(convert_to(substring(p_url from '/careers/r/([A-Za-z0-9_-]{43})$'), 'UTF8')), 'hex') END;
$$;
REVOKE ALL ON FUNCTION app.recruitment_response_url_digest(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_response_url_digest(text) TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE public.recruitment_candidate_email
 DROP CONSTRAINT recruitment_candidate_email_body_text_check,
 DROP CONSTRAINT recruitment_candidate_email_content_ck,
 ADD COLUMN response_url text CONSTRAINT recruitment_candidate_email_response_url_ck
  CHECK (response_url IS NULL OR (char_length(response_url) <= 400 AND app.recruitment_response_url_digest(response_url) IS NOT NULL)),
 ADD CONSTRAINT recruitment_candidate_email_response_kind_ck CHECK (response_url IS NULL OR kind IN ('interview_invitation','offer')),
 -- No link- or domain-like text, except exactly the frozen map link (5871) and response link, removed before the check.
 ADD CONSTRAINT recruitment_candidate_email_body_text_check CHECK (body_text IS NULL OR (char_length(body_text) BETWEEN 1 AND 20000
  AND NOT app.recruitment_candidate_email_linkish(replace(replace(body_text, coalesce(map_url, chr(1)), ' '), coalesce(response_url, chr(1)), ' ')))),
 ADD CONSTRAINT recruitment_candidate_email_content_ck CHECK (
  (content_purged_at IS NULL AND recipient IS NOT NULL AND subject IS NOT NULL AND body_text IS NOT NULL AND body_html IS NOT NULL)
  OR (content_purged_at IS NOT NULL AND recipient IS NULL AND subject IS NULL AND body_text IS NULL AND body_html IS NULL AND map_url IS NULL
   AND response_url IS NULL AND status IN ('sent','failed','uncertain','withdrawn')));
--> statement-breakpoint

-- ── 3. Issuing a link ────────────────────────────────────────────────────────────────────────────────────────
-- By the person queueing the e-mail, in the transaction that scheduled the interview or sent the offer by e-mail (as 5871 checks the
-- e-mail itself). The interview link expires when the interview starts; the offer link when the offer's validity ends.
CREATE FUNCTION app.recruitment_response_link_issue(p_kind text, p_target uuid, p_token_digest text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_user uuid := app.current_user_id(); v_tenant uuid := app.current_tenant_id(); i record; o record;
BEGIN
 IF v_user IS NULL OR v_tenant IS NULL OR p_target IS NULL OR p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$' OR p_kind NOT IN ('interview','offer') THEN
  RAISE EXCEPTION 'A response link is issued by the person sending the e-mail' USING ERRCODE = '42501';
 END IF;
 INSERT INTO app.recruitment_candidate_email_context (txid, purpose, scope_id) VALUES (txid_current(), 'worker', v_tenant) ON CONFLICT DO NOTHING;
 IF p_kind = 'interview' THEN
  SELECT x.* INTO i FROM public.recruitment_interview x WHERE x.id = p_target AND x.tenant_id = v_tenant;
 ELSE
  SELECT x.* INTO o FROM public.recruitment_offer x WHERE x.id = p_target AND x.tenant_id = v_tenant;
 END IF;
 DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
 IF p_kind = 'interview' THEN
  IF i.id IS NULL OR i.cancelled_at IS NOT NULL OR i.created_at <> now() OR i.created_by_user_id IS DISTINCT FROM v_user
   OR NOT app.can_operate_recruitment_job(i.company_id, i.job_id) THEN
   RAISE EXCEPTION 'A response link is issued with the interview it answers' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_response_link_issue';
  END IF;
  INSERT INTO app.recruitment_response_link (token_digest, tenant_id, company_id, job_id, application_id, kind, interview_id, interview_starts_at, created_by_user_id)
   VALUES (p_token_digest, v_tenant, i.company_id, i.job_id, i.application_id, 'interview', i.id, i.starts_at, v_user);
 ELSE
  IF o.id IS NULL OR o.status <> 'approved' OR o.candidate_decision <> 'pending' OR o.sent_at IS DISTINCT FROM now() OR o.sent_channel IS DISTINCT FROM 'email'
   OR o.sent_by_user_id IS DISTINCT FROM v_user OR NOT app.can_operate_recruitment_job(o.company_id, o.job_id) THEN
   RAISE EXCEPTION 'A response link is issued with the offer it answers' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_response_link_issue';
  END IF;
  INSERT INTO app.recruitment_response_link (token_digest, tenant_id, company_id, job_id, application_id, kind, offer_id, offer_sent_at, created_by_user_id)
   VALUES (p_token_digest, v_tenant, o.company_id, o.job_id, o.application_id, 'offer', o.id, o.sent_at, v_user);
 END IF;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_response_link_issue(text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_response_link_issue(text, uuid, text) TO ai_hr_app;
--> statement-breakpoint
-- Does a frozen link name a link issued in THIS transaction for this interview or offer? Owner-only reader for the statement check
-- (which runs as the caller, who cannot read the link table).
CREATE FUNCTION app.recruitment_response_link_matches(p_url text, p_interview uuid, p_offer uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
 SELECT EXISTS (SELECT 1 FROM app.recruitment_response_link l
  WHERE l.token_digest = app.recruitment_response_url_digest(p_url) AND l.created_at = now() AND l.created_by_user_id = app.current_user_id()
   AND ((l.kind = 'interview' AND l.interview_id = p_interview) OR (l.kind = 'offer' AND l.offer_id = p_offer)));
$$;
REVOKE ALL ON FUNCTION app.recruitment_response_link_matches(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_response_link_matches(text, uuid, uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 4. Answering ─────────────────────────────────────────────────────────────────────────────────────────────
-- The link's current state as a candidate may see it (no personal data beyond the job title and the company's careers name or legal
-- name): {kind, jobTitle, companyName, open, answer, interview: {startsAt, durationMinutes, type, roundNo}}. NULL for an unknown token.
CREATE FUNCTION app.recruitment_response_state(l app.recruitment_response_link) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE r jsonb; v_open boolean := false; v_title text; v_company text; i record; o record;
BEGIN
 INSERT INTO app.recruitment_candidate_email_context (txid, purpose, scope_id) VALUES (txid_current(), 'worker', l.tenant_id) ON CONFLICT DO NOTHING;
 SELECT j.title, co.legal_name INTO v_title, v_company FROM public.recruitment_job_opening j JOIN public.company co ON co.id = j.company_id AND co.tenant_id = j.tenant_id
  WHERE j.id = l.job_id AND j.tenant_id = l.tenant_id;
 IF l.kind = 'interview' THEN
  SELECT x.starts_at, x.duration_minutes, x.interview_type, x.round_no, x.cancelled_at, a.state INTO i FROM public.recruitment_interview x
   JOIN public.recruitment_application a ON a.id = x.application_id AND a.tenant_id = x.tenant_id WHERE x.id = l.interview_id AND x.tenant_id = l.tenant_id;
  v_open := i.cancelled_at IS NULL AND i.state = 'active' AND i.starts_at = l.interview_starts_at AND i.starts_at > now();
  r := jsonb_build_object('interview', jsonb_build_object('startsAt', i.starts_at, 'durationMinutes', i.duration_minutes, 'type', i.interview_type, 'roundNo', i.round_no));
 ELSE
  SELECT x.status, x.sent_at, x.valid_days, x.candidate_decision, a.state INTO o FROM public.recruitment_offer x
   JOIN public.recruitment_application a ON a.id = x.application_id AND a.tenant_id = x.tenant_id WHERE x.id = l.offer_id AND x.tenant_id = l.tenant_id;
  v_open := o.status = 'approved' AND o.sent_at = l.offer_sent_at AND o.candidate_decision = 'pending' AND o.state = 'active'
   AND now() < o.sent_at + make_interval(days => coalesce(o.valid_days, 0));
  r := '{}'::jsonb;
 END IF;
 DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
 RETURN r || jsonb_build_object('kind', l.kind, 'jobTitle', v_title, 'companyName', v_company, 'open', coalesce(v_open, false), 'answer', l.answer);
END $$;
REVOKE ALL ON FUNCTION app.recruitment_response_state(app.recruitment_response_link) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.recruitment_response_view(p_token_digest text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET lock_timeout = '3s' AS $$
DECLARE l app.recruitment_response_link%ROWTYPE;
BEGIN
 IF app.current_user_id() IS NOT NULL OR app.current_tenant_id() IS NOT NULL THEN
  RAISE EXCEPTION 'A response link serves visitors who are not signed in' USING ERRCODE = '42501';
 END IF;
 IF p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
 SELECT * INTO l FROM app.recruitment_response_link x WHERE x.token_digest = p_token_digest;
 IF l.token_digest IS NULL THEN RETURN NULL; END IF;
 RETURN app.recruitment_response_state(l);
END $$;
REVOKE ALL ON FUNCTION app.recruitment_response_view(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_response_view(text) TO ai_hr_app;
--> statement-breakpoint
-- Answer. Status: 'answered' (with the state), 'closed' (the link no longer answers), 'limited' (20 an hour per client) or 'not_found'.
CREATE FUNCTION app.recruitment_response_answer(p_token_digest text, p_answer text, p_client_hash text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET lock_timeout = '3s' AS $$
DECLARE l app.recruitment_response_link%ROWTYPE; s jsonb;
BEGIN
 IF app.current_user_id() IS NOT NULL OR app.current_tenant_id() IS NOT NULL THEN
  RAISE EXCEPTION 'A response link serves visitors who are not signed in' USING ERRCODE = '42501';
 END IF;
 IF p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$' OR p_answer NOT IN ('accepted','declined')
  OR p_client_hash IS NULL OR p_client_hash !~ '^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION 'An answer needs a link, accepted or declined, and a client' USING ERRCODE = '22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('recruitment-response-client:' || p_client_hash, 0));
 DELETE FROM app.recruitment_response_attempt WHERE attempted_at < now() - interval '2 days';
 IF (SELECT count(*) FROM app.recruitment_response_attempt a WHERE a.client_hash = p_client_hash AND a.attempted_at > now() - interval '1 hour') >= 20 THEN
  RETURN jsonb_build_object('status', 'limited');
 END IF;
 INSERT INTO app.recruitment_response_attempt (client_hash) VALUES (p_client_hash);
 SELECT * INTO l FROM app.recruitment_response_link x WHERE x.token_digest = p_token_digest FOR UPDATE;
 IF l.token_digest IS NULL THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
 s := app.recruitment_response_state(l);
 IF NOT (s->>'open')::boolean THEN RETURN jsonb_build_object('status', 'closed', 'state', s); END IF;
 UPDATE app.recruitment_response_link x SET answer = p_answer, answered_at = now() WHERE x.token_digest = l.token_digest;
 IF l.kind = 'interview' THEN
  -- The interview's candidate response, as the candidate's own (5869's place guard admits exactly this inside the worker context).
  INSERT INTO app.recruitment_candidate_email_context (txid, purpose, scope_id) VALUES (txid_current(), 'worker', l.tenant_id) ON CONFLICT DO NOTHING;
  UPDATE public.recruitment_interview x SET candidate_response = p_answer, updated_at = now()
   WHERE x.id = l.interview_id AND x.tenant_id = l.tenant_id AND x.cancelled_at IS NULL;
  DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
 END IF;
 INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
  VALUES (l.tenant_id, 'recruitment-application', l.application_id, 'recruitment-candidate.responded', 'external', NULL,
   jsonb_build_object('companyId', l.company_id, 'kind', l.kind, 'interviewId', l.interview_id, 'offerId', l.offer_id, 'answer', p_answer));
 RETURN jsonb_build_object('status', 'answered', 'state', s || jsonb_build_object('answer', p_answer));
END $$;
REVOKE ALL ON FUNCTION app.recruitment_response_answer(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_response_answer(text, text, text) TO ai_hr_app;
--> statement-breakpoint
-- HR: the candidate's latest reply to an offer by link, for the job's reviewers (the offer's current send only).
CREATE FUNCTION app.recruitment_offer_candidate_reply(p_offer uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE o record; r jsonb;
BEGIN
 SELECT x.id, x.company_id, x.job_id, x.sent_at INTO o FROM public.recruitment_offer x WHERE x.id = p_offer AND x.tenant_id = app.current_tenant_id()
  AND app.can_review_recruitment_job(x.company_id, x.job_id);
 IF o.id IS NULL OR o.sent_at IS NULL THEN RETURN NULL; END IF;
 SELECT jsonb_build_object('answer', l.answer, 'answeredAt', l.answered_at) INTO r FROM app.recruitment_response_link l
  WHERE l.offer_id = o.id AND l.offer_sent_at = o.sent_at AND l.answer IS NOT NULL ORDER BY l.answered_at DESC LIMIT 1;
 RETURN r;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_offer_candidate_reply(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_offer_candidate_reply(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The owner may update an interview only inside an answer (5870's worker context for its tenant); 5869's place guard (restated below)
-- then admits only the candidate response.
CREATE POLICY recruitment_interview_response_worker ON public.recruitment_interview FOR UPDATE USING (
 current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_interview'::regclass))
 AND app.recruitment_email_context_open('worker', tenant_id))
 WITH CHECK (
 current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_interview'::regclass))
 AND app.recruitment_email_context_open('worker', tenant_id));
--> statement-breakpoint
-- The answer page names the job: the owner reads a job opening only inside 5870's worker context for its tenant (owner-only policy).
CREATE POLICY recruitment_job_opening_response_worker_read ON public.recruitment_job_opening FOR SELECT USING (
 current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_job_opening'::regclass))
 AND app.recruitment_email_context_open('worker', tenant_id));
--> statement-breakpoint

-- ── 5. Restated: 5871's placeholders (plus {responseLink}), guard (the link is frozen content), statement check (the link is the one
-- issued), purge (the link goes with the content); 5869's interview place guard (plus the owner's answer) ──────────────────────
CREATE OR REPLACE FUNCTION app.recruitment_candidate_email_placeholders_ok(p_kind text, p_text text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT p_text IS NOT NULL
  AND p_kind IN ('application_received','rejection','interview_invitation','interview_reminder','interview_cancelled','offer')
  AND NOT EXISTS (SELECT 1 FROM regexp_matches(p_text, '\{([^{}]*)\}', 'g') AS m(x)
   WHERE NOT (m.x[1] = ANY (CASE p_kind
    WHEN 'interview_invitation' THEN ARRAY['candidateName','jobTitle','companyName','senderName','interviewRound','interviewType','interviewDate',
     'interviewTime','interviewDuration','interviewPlace','responseLink']
    WHEN 'interview_reminder' THEN ARRAY['candidateName','jobTitle','companyName','senderName','interviewRound','interviewType','interviewDate',
     'interviewTime','interviewDuration','interviewPlace']
    WHEN 'interview_cancelled' THEN ARRAY['candidateName','jobTitle','companyName','senderName','interviewRound','interviewType','interviewDate',
     'interviewTime']
    WHEN 'offer' THEN ARRAY['candidateName','jobTitle','companyName','senderName','offerDetails','responseLink']
    ELSE ARRAY['candidateName','jobTitle','companyName','senderName'] END)))
  AND regexp_replace(p_text, '\{[^{}]*\}', '', 'g') !~ '[{}]';
$$;
REVOKE ALL ON FUNCTION app.recruitment_candidate_email_placeholders_ok(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_candidate_email_placeholders_ok(text, text) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.recruitment_guard_candidate_email() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE
 owner_call boolean := current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID));
BEGIN
 IF TG_OP = 'INSERT' THEN
  -- Row work is in-memory only; the set is checked once per statement (app.recruitment_check_candidate_email_queue, below).
  NEW.status := 'queued'; NEW.error_code := NULL; NEW.attempts := 0; NEW.queued_at := now(); NEW.lease_token := NULL; NEW.lease_until := NULL;
  NEW.started_at := NULL; NEW.completed_at := NULL; NEW.relay_revision := NULL; NEW.retried_at := NULL; NEW.retried_by_user_id := NULL;
  NEW.retry_count := 0; NEW.content_purged_at := NULL;
  IF NEW.kind = 'interview_reminder' THEN
   -- Slice 20: a reminder is due before its interview; the statement check pins the exact time.
   IF NEW.next_attempt_at IS NULL OR NEW.next_attempt_at <= now() THEN
    RAISE EXCEPTION 'A reminder is sent before its interview' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_candidate_email_reminder_time';
   END IF;
  ELSIF NEW.kind <> 'rejection' OR NEW.next_attempt_at IS NULL OR NEW.next_attempt_at < now() THEN
   NEW.next_attempt_at := now();
  ELSIF NEW.next_attempt_at > now() + interval '3 days 1 minute' THEN
   RAISE EXCEPTION 'A rejection e-mail is sent at most three days later' USING ERRCODE = '23514';
  END IF;
  IF NOT owner_call AND (NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.queued_by_user_id IS NULL
   OR NEW.queued_by_user_id IS DISTINCT FROM app.current_user_id()) THEN
   RAISE EXCEPTION 'A candidate e-mail is queued by the current user' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
 END IF;
 -- UPDATE: frozen columns never change; content only goes, all at once (the purge).
 IF (NEW.id, NEW.tenant_id, NEW.company_id, NEW.job_id, NEW.application_id, NEW.candidate_id, NEW.kind, NEW.locale, NEW.sender_name,
     NEW.reply_to, NEW.queued_at, NEW.queued_by_user_id, NEW.interview_id, NEW.interview_starts_at, NEW.offer_id)
  IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.company_id, OLD.job_id, OLD.application_id, OLD.candidate_id, OLD.kind, OLD.locale,
     OLD.sender_name, OLD.reply_to, OLD.queued_at, OLD.queued_by_user_id, OLD.interview_id, OLD.interview_starts_at, OLD.offer_id) THEN
  RAISE EXCEPTION 'A queued candidate e-mail is immutable' USING ERRCODE = '23514';
 END IF;
 IF (NEW.recipient, NEW.subject, NEW.body_text, NEW.body_html, NEW.map_url, NEW.response_url)
   IS DISTINCT FROM (OLD.recipient, OLD.subject, OLD.body_text, OLD.body_html, OLD.map_url, OLD.response_url)
  AND NOT (NEW.recipient IS NULL AND NEW.subject IS NULL AND NEW.body_text IS NULL AND NEW.body_html IS NULL AND NEW.map_url IS NULL
   AND NEW.response_url IS NULL AND NEW.content_purged_at IS NOT NULL) THEN
  RAISE EXCEPTION 'A queued candidate e-mail keeps its frozen content' USING ERRCODE = '23514';
 END IF;
 IF OLD.content_purged_at IS NOT NULL AND NEW.content_purged_at IS DISTINCT FROM OLD.content_purged_at THEN
  RAISE EXCEPTION 'A purged candidate e-mail stays purged' USING ERRCODE = '23514';
 END IF;
 IF owner_call THEN
  RETURN NEW;
 END IF;
 -- A person (an administrator, by policy) changes a row only to retry a failed or uncertain e-mail whose content is kept.
 IF OLD.status NOT IN ('failed','uncertain') OR NEW.status <> 'queued' OR OLD.content_purged_at IS NOT NULL OR NEW.content_purged_at IS NOT NULL
  OR NEW.retried_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'Only a failed or uncertain e-mail can be retried, by an administrator' USING ERRCODE = '23514',
   CONSTRAINT = 'recruitment_candidate_email_retry';
 END IF;
 -- Slice 20: a retried reminder is sent at once, not at its original time (which may have passed): no change here — 5870's reset of
 -- next_attempt_at to now() below already does that.
 NEW.retried_at := now(); NEW.retry_count := OLD.retry_count + 1; NEW.attempts := 0; NEW.error_code := NULL; NEW.next_attempt_at := now();
 NEW.lease_token := NULL; NEW.lease_until := NULL; NEW.started_at := NULL; NEW.completed_at := NULL; NEW.relay_revision := NULL;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_candidate_email() FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.recruitment_check_candidate_email_queue() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID)) THEN RETURN NULL; END IF;
 IF EXISTS (SELECT 1 FROM inserted n LEFT JOIN public.recruitment_application a ON a.id = n.application_id AND a.tenant_id = n.tenant_id
   WHERE a.id IS NULL OR a.job_id IS DISTINCT FROM n.job_id OR a.company_id IS DISTINCT FROM n.company_id OR a.candidate_id IS DISTINCT FROM n.candidate_id) THEN
  RAISE EXCEPTION 'A candidate e-mail names its application, job and candidate' USING ERRCODE = '23514';
 END IF;
 IF EXISTS (SELECT 1 FROM inserted n JOIN public.recruitment_application a ON a.id = n.application_id AND a.tenant_id = n.tenant_id
   WHERE (n.kind = 'rejection' AND (a.state <> 'archived' OR a.state_changed_at <> now()))
    OR (n.kind = 'application_received' AND (a.state <> 'active' OR a.applied_at <> now()))
    OR (n.kind IN ('interview_invitation','interview_reminder','offer') AND a.state <> 'active')) THEN
  RAISE EXCEPTION 'A rejection e-mail is queued when the application is rejected, a receipt when it is created' USING ERRCODE = '23514',
   CONSTRAINT = 'recruitment_candidate_email_state';
 END IF;
 -- Slice 20: interviews.
 IF EXISTS (SELECT 1 FROM inserted n
   LEFT JOIN public.recruitment_interview i ON i.id = n.interview_id AND i.tenant_id = n.tenant_id AND i.application_id = n.application_id
   LEFT JOIN public.recruitment_interview_address ad ON ad.id = i.address_id AND ad.tenant_id = i.tenant_id
   WHERE n.kind IN ('interview_invitation','interview_reminder','interview_cancelled')
    AND (i.id IS NULL OR n.interview_starts_at IS DISTINCT FROM i.starts_at
     OR (n.kind IN ('interview_invitation','interview_reminder') AND (i.cancelled_at IS NOT NULL OR i.created_at <> now()
      OR i.created_by_user_id IS DISTINCT FROM app.current_user_id()
      OR n.map_url IS DISTINCT FROM CASE WHEN i.interview_type = 'onsite' THEN ad.map_url END))
     OR (n.kind = 'interview_cancelled' AND (i.cancelled_at IS DISTINCT FROM now() OR i.cancelled_by_user_id IS DISTINCT FROM app.current_user_id()
      OR n.map_url IS NOT NULL)))) THEN
  RAISE EXCEPTION 'An interview e-mail is queued when the interview is scheduled or cancelled, as it is' USING ERRCODE = '23514',
   CONSTRAINT = 'recruitment_candidate_email_interview';
 END IF;
 IF EXISTS (SELECT 1 FROM inserted n
   JOIN public.recruitment_interview i ON i.id = n.interview_id AND i.tenant_id = n.tenant_id
   LEFT JOIN public.recruitment_candidate_email_setting st ON st.company_id = n.company_id AND st.tenant_id = n.tenant_id
   WHERE n.kind = 'interview_reminder'
    AND (st.reminder_enabled IS NOT TRUE OR n.next_attempt_at IS DISTINCT FROM i.starts_at - make_interval(hours => st.reminder_hours)
     OR n.next_attempt_at <= now()
     OR NOT EXISTS (SELECT 1 FROM public.recruitment_candidate_email v WHERE v.interview_id = n.interview_id AND v.kind = 'interview_invitation'))) THEN
  RAISE EXCEPTION 'A reminder goes with an invitation, at the company''s reminder time' USING ERRCODE = '23514',
   CONSTRAINT = 'recruitment_candidate_email_reminder_time';
 END IF;
 -- Slice 21b: a frozen response link is one issued in THIS transaction by the current user for this interview or offer.
 IF EXISTS (SELECT 1 FROM inserted n WHERE n.response_url IS NOT NULL
   AND NOT app.recruitment_response_link_matches(n.response_url, n.interview_id, n.offer_id)) THEN
  RAISE EXCEPTION 'A response link is the one issued with this e-mail' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_candidate_email_response_link';
 END IF;
 -- Slice 20: offers.
 IF EXISTS (SELECT 1 FROM inserted n
   LEFT JOIN public.recruitment_offer o ON o.id = n.offer_id AND o.tenant_id = n.tenant_id AND o.application_id = n.application_id
   WHERE n.kind = 'offer' AND (o.id IS NULL OR o.status <> 'approved' OR o.candidate_decision <> 'pending' OR o.sent_at IS DISTINCT FROM now()
    OR o.sent_channel IS DISTINCT FROM 'email' OR o.sent_by_user_id IS DISTINCT FROM app.current_user_id())) THEN
  RAISE EXCEPTION 'An offer e-mail is sent for an approved offer, when a person sends it' USING ERRCODE = '23514',
   CONSTRAINT = 'recruitment_candidate_email_offer';
 END IF;
 IF EXISTS (SELECT 1 FROM inserted n LEFT JOIN public.recruitment_candidate c ON c.id = n.candidate_id AND c.tenant_id = n.tenant_id
   WHERE c.id IS NULL OR c.destroyed_at IS NOT NULL OR c.email IS NULL OR c.email IS DISTINCT FROM n.recipient) THEN
  RAISE EXCEPTION 'A candidate e-mail goes only to the candidate''s recorded e-mail' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_candidate_email_recipient';
 END IF;
 IF EXISTS (SELECT 1 FROM inserted n
   LEFT JOIN public.recruitment_candidate_email_setting st ON st.company_id = n.company_id AND st.tenant_id = n.tenant_id
   LEFT JOIN public.company co ON co.id = n.company_id AND co.tenant_id = n.tenant_id
   WHERE st.enabled IS NOT TRUE OR n.reply_to IS DISTINCT FROM st.reply_to OR n.locale IS DISTINCT FROM st.locale
    OR n.sender_name IS DISTINCT FROM app.recruitment_candidate_email_sender(st.sender_name, co.legal_name)) THEN
  RAISE EXCEPTION 'Candidate e-mail is off for this company, or its sender settings changed' USING ERRCODE = '23514',
   CONSTRAINT = 'recruitment_candidate_email_settings';
 END IF;
 IF EXISTS (SELECT 1 FROM (SELECT DISTINCT n.company_id FROM inserted n) x WHERE app.recruitment_candidate_email_hour_count(x.company_id) > 500) THEN
  RAISE EXCEPTION 'This company has queued 500 candidate e-mails in the last hour' USING ERRCODE = '23514',
   CONSTRAINT = 'recruitment_candidate_email_hourly_limit';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_check_candidate_email_queue() FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.recruitment_candidate_email_purge(p_limit integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_tenant uuid := app.current_tenant_id(); n integer;
BEGIN
 IF NOT app.recruitment_candidate_email_worker_ok() OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000 THEN
  RAISE EXCEPTION 'Candidate e-mail delivery runs as the sweep' USING ERRCODE = '42501';
 END IF;
 INSERT INTO app.recruitment_candidate_email_context (txid, purpose, scope_id) VALUES (txid_current(), 'worker', v_tenant) ON CONFLICT DO NOTHING;
 UPDATE public.recruitment_candidate_email e SET recipient = NULL, subject = NULL, body_text = NULL, body_html = NULL, map_url = NULL, response_url = NULL, content_purged_at = now()
  FROM (SELECT d.id FROM public.recruitment_candidate_email d
    WHERE d.tenant_id = v_tenant AND d.content_purged_at IS NULL AND d.status IN ('sent','failed','uncertain','withdrawn')
     AND d.completed_at < now() - interval '90 days'
    ORDER BY d.completed_at LIMIT p_limit FOR UPDATE SKIP LOCKED) old
  WHERE e.id = old.id;
 GET DIAGNOSTICS n = ROW_COUNT;
 DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_candidate_email_purge(integer) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.recruitment_guard_interview_place() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 -- Slice 21b: the owner inside a candidate's answer (5873's app.recruitment_response_answer, in 5870's worker context for the tenant)
 -- may change only the candidate response (and the update time).
 IF TG_OP = 'UPDATE' AND current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID))
  AND app.recruitment_email_context_open('worker', NEW.tenant_id) THEN
  IF (to_jsonb(NEW) - ARRAY['candidate_response','updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['candidate_response','updated_at']) THEN
   RAISE EXCEPTION 'A candidate''s answer changes only the candidate response' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP = 'UPDATE' AND NOT app.can_operate_recruitment_job(NEW.company_id, NEW.job_id) THEN
  IF OLD.cancelled_at IS NOT NULL OR NEW.cancelled_at IS NULL OR OLD.starts_at <= now()
   OR (to_jsonb(NEW) - ARRAY['cancelled_at','cancelled_by_user_id','updated_at','updated_by_user_id'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['cancelled_at','cancelled_by_user_id','updated_at','updated_by_user_id'])
   OR NOT EXISTS (SELECT 1 FROM public.recruitment_application a WHERE a.id = NEW.application_id AND a.tenant_id = NEW.tenant_id AND a.state <> 'active') THEN
   RAISE EXCEPTION 'Only the job''s operators change an interview' USING ERRCODE = '42501';
  END IF;
  -- The audit values are the database's, not the caller's (the cancelling user is checked by 5852's interview guard).
  NEW.cancelled_at := now(); NEW.updated_at := now(); NEW.updated_by_user_id := app.current_user_id();
 END IF;
 IF NEW.room_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.room_id IS DISTINCT FROM OLD.room_id)
  AND NOT EXISTS (SELECT 1 FROM public.recruitment_interview_room r WHERE r.id = NEW.room_id AND r.tenant_id = NEW.tenant_id AND r.enabled) THEN
  RAISE EXCEPTION 'Choose an enabled meeting room' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_interview_room_enabled';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_interview_place() FROM PUBLIC, ai_hr_app;
