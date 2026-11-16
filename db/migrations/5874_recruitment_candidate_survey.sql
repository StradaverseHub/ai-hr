-- Recruitment slice 22 (docs/recruitment-reconstruction/specification.md "Slice 22"; D-063, D-067): an optional, anonymous candidate
-- survey after a hire or a rejection. A seventh candidate e-mail kind, 'survey', queued in the transaction that hired the application
-- or queued its rejection e-mail, due 1–14 days later. The link is NOT frozen: the e-mail HR can read holds the placeholder
-- {surveyLink}; the sweep makes a fresh random token for each send (app.recruitment_survey_issue), stores only its sha256, and puts
-- the link in the outgoing message. Nobody in the company can open a candidate's survey, see whether they answered, or answer for them.
--
-- Who:
--   settings       — recruitment administrators (5870's setting table and policies): after hire, after rejection, send after N days.
--   queue a survey — the person who hires or rejects (with a rejection e-mail), in that transaction; 5870's guard and statement check
--                    (restated) pin the time, the outcome and the placeholder.
--   issue a link   — the sweep (owner-only definer), for a leased, unstarted survey e-mail.
--   view, answer   — anonymous visitors, by the token's sha256 (definers); 20 answers an hour per client hash, shared with 5873.
--   read answers   — the company's recruitment administrators (row security on the answer table); nobody writes them but the answer
--                    definer, and nobody but the owner deletes them (24-month prune).
--
-- Anonymity: an answer row holds the tenant, the company, the outcome, the Kuala Lumpur month and the answers — no application,
-- candidate, job, e-mail, link or time. The link's row (app.recruitment_survey_invitation: digest, e-mail id, company, outcome, expiry)
-- is deleted when it is answered. It names the e-mail by id without a foreign key (the e-mail goes with candidate removal and company
-- delete, which this migration does not restate); a link whose e-mail is gone no longer opens. No domain event is written for an answer.
--
-- What this installs:
--   1. recruitment_candidate_email_setting.survey_hired, survey_rejected (off) and survey_delay_days (1–14, default 3).
--   2. The kind 'survey' in the template and e-mail CHECKs; placeholders restated (5873's plus 'survey': the four base values and
--      {surveyLink}); recruitment_candidate_email.survey_outcome (hired or rejected, exactly for a survey); one survey per application.
--   3. app.recruitment_survey_invitation (owner-only) and public.recruitment_candidate_survey_response (administrators read).
--   4. Definers: app.recruitment_survey_issue (sweep), app.recruitment_survey_view and app.recruitment_survey_answer (anonymous), and
--      the owner-only app.recruitment_survey_prune (expired links, answers older than 24 months; bounded).
--   5. Restated: 5873's guard and statement check, 5871's target and finish (each body byte for byte plus the survey steps).
--
-- Nothing here calls a model, scores a candidate or decides anything about an application.
--
-- PRECONDITION: applies after 5873.

-- ── 1. Survey settings ──────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.recruitment_candidate_email_setting
 ADD COLUMN survey_hired boolean NOT NULL DEFAULT false,
 ADD COLUMN survey_rejected boolean NOT NULL DEFAULT false,
 ADD COLUMN survey_delay_days integer NOT NULL DEFAULT 3 CONSTRAINT recruitment_candidate_email_setting_survey_delay_ck CHECK (survey_delay_days BETWEEN 1 AND 14);
--> statement-breakpoint

-- ── 2. The kind, its placeholders and what a survey is about ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.recruitment_candidate_email_placeholders_ok(p_kind text, p_text text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT p_text IS NOT NULL
  AND p_kind IN ('application_received','rejection','interview_invitation','interview_reminder','interview_cancelled','offer','survey')
  AND NOT EXISTS (SELECT 1 FROM regexp_matches(p_text, '\{([^{}]*)\}', 'g') AS m(x)
   WHERE NOT (m.x[1] = ANY (CASE p_kind
    WHEN 'interview_invitation' THEN ARRAY['candidateName','jobTitle','companyName','senderName','interviewRound','interviewType','interviewDate',
     'interviewTime','interviewDuration','interviewPlace','responseLink']
    WHEN 'interview_reminder' THEN ARRAY['candidateName','jobTitle','companyName','senderName','interviewRound','interviewType','interviewDate',
     'interviewTime','interviewDuration','interviewPlace']
    WHEN 'interview_cancelled' THEN ARRAY['candidateName','jobTitle','companyName','senderName','interviewRound','interviewType','interviewDate',
     'interviewTime']
    WHEN 'offer' THEN ARRAY['candidateName','jobTitle','companyName','senderName','offerDetails','responseLink']
    WHEN 'survey' THEN ARRAY['candidateName','jobTitle','companyName','senderName','surveyLink']
    ELSE ARRAY['candidateName','jobTitle','companyName','senderName'] END)))
  AND regexp_replace(p_text, '\{[^{}]*\}', '', 'g') !~ '[{}]';
$$;
REVOKE ALL ON FUNCTION app.recruitment_candidate_email_placeholders_ok(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_candidate_email_placeholders_ok(text, text) TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE public.recruitment_candidate_email_template DROP CONSTRAINT recruitment_candidate_email_template_kind_check;
ALTER TABLE public.recruitment_candidate_email_template ADD CONSTRAINT recruitment_candidate_email_template_kind_check
 CHECK (kind IN ('application_received','rejection','interview_invitation','interview_reminder','interview_cancelled','offer','survey'));
--> statement-breakpoint
ALTER TABLE public.recruitment_candidate_email
 DROP CONSTRAINT recruitment_candidate_email_kind_check,
 ADD CONSTRAINT recruitment_candidate_email_kind_check
  CHECK (kind IN ('application_received','rejection','interview_invitation','interview_reminder','interview_cancelled','offer','survey')),
 -- The outcome a survey follows; nothing else has one.
 ADD COLUMN survey_outcome text CONSTRAINT recruitment_candidate_email_survey_outcome_ck CHECK (survey_outcome IS NULL OR survey_outcome IN ('hired','rejected')),
 ADD CONSTRAINT recruitment_candidate_email_survey_ck CHECK ((kind = 'survey') = (survey_outcome IS NOT NULL));
-- One survey per application (an application is hired or rejected once; no reopen exists).
CREATE UNIQUE INDEX recruitment_candidate_email_survey_uq ON public.recruitment_candidate_email (application_id) WHERE kind = 'survey';
--> statement-breakpoint

-- ── 3. Links and answers ────────────────────────────────────────────────────────────────────────────────────
-- The current link of a survey e-mail (one at a time: a retried send replaces it). Owner-only, forced row security, no grant.
CREATE TABLE app.recruitment_survey_invitation (
 token_digest text PRIMARY KEY CHECK (token_digest ~ '^[0-9a-f]{64}$'),
 email_id uuid NOT NULL UNIQUE,
 tenant_id uuid NOT NULL,
 company_id uuid NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('hired','rejected')),
 expires_at timestamptz NOT NULL
);
CREATE INDEX recruitment_survey_invitation_expires_idx ON app.recruitment_survey_invitation (expires_at);
ALTER TABLE app.recruitment_survey_invitation ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.recruitment_survey_invitation FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.recruitment_survey_invitation FROM PUBLIC, ai_hr_app;
CREATE POLICY recruitment_survey_invitation_owner ON app.recruitment_survey_invitation FOR ALL
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'app.recruitment_survey_invitation'::regclass)))
 WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'app.recruitment_survey_invitation'::regclass)));
--> statement-breakpoint
-- An answer: the company, the outcome, the Kuala Lumpur month and the answers. Nothing names a person, an application, a job or a time.
CREATE TABLE public.recruitment_candidate_survey_response (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 outcome text NOT NULL CHECK (outcome IN ('hired','rejected')),
 answered_month date NOT NULL CHECK (extract(day FROM answered_month) = 1),
 overall smallint NOT NULL CHECK (overall BETWEEN 1 AND 5),
 communication smallint CHECK (communication IS NULL OR communication BETWEEN 1 AND 5),
 respect smallint CHECK (respect IS NULL OR respect BETWEEN 1 AND 5),
 process smallint CHECK (process IS NULL OR process BETWEEN 1 AND 5),
 recommend text CHECK (recommend IS NULL OR recommend IN ('yes','no','unsure')),
 comment text CHECK (comment IS NULL OR (char_length(comment) BETWEEN 1 AND 1000 AND comment !~ '[\x01-\x09\x0b-\x1f\x7f-\x9f]')),
 CONSTRAINT recruitment_candidate_survey_response_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id)
);
CREATE INDEX recruitment_candidate_survey_response_company_idx ON public.recruitment_candidate_survey_response (tenant_id, company_id, answered_month);
CREATE INDEX recruitment_candidate_survey_response_month_idx ON public.recruitment_candidate_survey_response (answered_month);
ALTER TABLE public.recruitment_candidate_survey_response ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recruitment_candidate_survey_response FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.recruitment_candidate_survey_response FROM PUBLIC, ai_hr_app;
GRANT SELECT ON public.recruitment_candidate_survey_response TO ai_hr_app;
CREATE POLICY recruitment_candidate_survey_response_admin_read ON public.recruitment_candidate_survey_response FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
CREATE POLICY recruitment_candidate_survey_response_owner ON public.recruitment_candidate_survey_response FOR ALL
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_candidate_survey_response'::regclass)))
 WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_candidate_survey_response'::regclass)));
--> statement-breakpoint

-- ── 4. Issuing, viewing and answering ───────────────────────────────────────────────────────────────────────
-- Expired links and answers older than 24 months go, at most 500 of each per call (owner only; called by issue and answer).
CREATE FUNCTION app.recruitment_survey_prune() RETURNS integer
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE n integer; m integer;
BEGIN
 DELETE FROM app.recruitment_survey_invitation x WHERE x.token_digest IN (SELECT y.token_digest FROM app.recruitment_survey_invitation y
  WHERE y.expires_at < now() ORDER BY y.expires_at LIMIT 500);
 GET DIAGNOSTICS n = ROW_COUNT;
 DELETE FROM public.recruitment_candidate_survey_response r WHERE r.id IN (SELECT z.id FROM public.recruitment_candidate_survey_response z
  WHERE z.answered_month < (date_trunc('month', now() AT TIME ZONE 'Asia/Kuala_Lumpur') - interval '24 months')::date ORDER BY z.answered_month LIMIT 500);
 GET DIAGNOSTICS m = ROW_COUNT;
 RETURN n + m;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_survey_prune() FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- The sweep, for a survey e-mail it has leased and not started: a new link (the token's sha256), valid 30 days, replacing any earlier
-- link of this e-mail. False when the lease is not live or the e-mail is not a survey.
CREATE FUNCTION app.recruitment_survey_issue(p_id uuid, p_token uuid, p_token_digest text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE e record;
BEGIN
 IF NOT app.recruitment_candidate_email_worker_ok() THEN
  RAISE EXCEPTION 'Candidate e-mail delivery runs as the sweep' USING ERRCODE = '42501';
 END IF;
 IF p_id IS NULL OR p_token IS NULL OR p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
 INSERT INTO app.recruitment_candidate_email_context (txid, purpose, scope_id) VALUES (txid_current(), 'worker', app.current_tenant_id()) ON CONFLICT DO NOTHING;
 SELECT x.id, x.tenant_id, x.company_id, x.survey_outcome INTO e FROM public.recruitment_candidate_email x
  WHERE x.id = p_id AND x.lease_token = p_token AND x.status = 'leased' AND x.started_at IS NULL AND x.lease_until > clock_timestamp()
   AND x.kind = 'survey';
 DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
 IF e.id IS NULL THEN RETURN false; END IF;
 DELETE FROM app.recruitment_survey_invitation x WHERE x.email_id = e.id;
 INSERT INTO app.recruitment_survey_invitation (token_digest, email_id, tenant_id, company_id, outcome, expires_at)
  VALUES (p_token_digest, e.id, e.tenant_id, e.company_id, e.survey_outcome, now() + interval '30 days');
 PERFORM app.recruitment_survey_prune();
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_survey_issue(uuid, uuid, text) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- The live link of a token: not expired, and its e-mail still kept (candidate removal deletes the e-mail). NULL otherwise. Owner only.
CREATE FUNCTION app.recruitment_survey_live(p_token_digest text) RETURNS app.recruitment_survey_invitation
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE l app.recruitment_survey_invitation%ROWTYPE; v_kept boolean;
BEGIN
 SELECT * INTO l FROM app.recruitment_survey_invitation x WHERE x.token_digest = p_token_digest AND x.expires_at > now() FOR UPDATE;
 IF l.token_digest IS NULL THEN RETURN NULL; END IF;
 INSERT INTO app.recruitment_candidate_email_context (txid, purpose, scope_id) VALUES (txid_current(), 'worker', l.tenant_id) ON CONFLICT DO NOTHING;
 SELECT EXISTS (SELECT 1 FROM public.recruitment_candidate_email e WHERE e.id = l.email_id AND e.tenant_id = l.tenant_id AND e.kind = 'survey') INTO v_kept;
 DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
 IF NOT v_kept THEN RETURN NULL; END IF;
 RETURN l;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_survey_live(text) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- What the survey page shows: the company's name. NULL for an unknown, used or expired link (the page says the same for each).
CREATE FUNCTION app.recruitment_survey_view(p_token_digest text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET lock_timeout = '3s' AS $$
DECLARE l app.recruitment_survey_invitation%ROWTYPE; v_company text;
BEGIN
 IF app.current_user_id() IS NOT NULL OR app.current_tenant_id() IS NOT NULL THEN
  RAISE EXCEPTION 'A survey link serves visitors who are not signed in' USING ERRCODE = '42501';
 END IF;
 IF p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
 l := app.recruitment_survey_live(p_token_digest);
 IF l.token_digest IS NULL THEN RETURN NULL; END IF;
 SELECT co.legal_name INTO v_company FROM public.company co WHERE co.id = l.company_id AND co.tenant_id = l.tenant_id;
 RETURN jsonb_build_object('companyName', v_company);
END $$;
REVOKE ALL ON FUNCTION app.recruitment_survey_view(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_survey_view(text) TO ai_hr_app;
--> statement-breakpoint
-- Answer once. Status: 'answered', 'closed' (unknown, used or expired: one answer for all three) or 'limited' (20 an hour per client,
-- counted with 5873's answers). The answers are checked again by the table's CHECKs; a malformed set is refused (22023).
CREATE FUNCTION app.recruitment_survey_answer(p_token_digest text, p_answers jsonb, p_client_hash text) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET lock_timeout = '3s' AS $$
DECLARE l app.recruitment_survey_invitation%ROWTYPE; v_comment text;
BEGIN
 IF app.current_user_id() IS NOT NULL OR app.current_tenant_id() IS NOT NULL THEN
  RAISE EXCEPTION 'A survey link serves visitors who are not signed in' USING ERRCODE = '42501';
 END IF;
 IF p_token_digest IS NULL OR p_token_digest !~ '^[0-9a-f]{64}$' OR p_client_hash IS NULL OR p_client_hash !~ '^[0-9a-f]{64}$'
  OR p_answers IS NULL OR jsonb_typeof(p_answers) <> 'object'
  OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_answers) k WHERE k NOT IN ('overall','communication','respect','process','recommend','comment'))
  OR jsonb_typeof(p_answers->'overall') IS DISTINCT FROM 'number'
  OR EXISTS (SELECT 1 FROM unnest(ARRAY['overall','communication','respect','process']) q
   WHERE p_answers ? q AND (jsonb_typeof(p_answers->q) <> 'number' OR (p_answers->>q) !~ '^[1-5]$'))
  OR (p_answers ? 'recommend' AND jsonb_typeof(p_answers->'recommend') <> 'string')
  OR (p_answers ? 'comment' AND jsonb_typeof(p_answers->'comment') <> 'string') THEN
  RAISE EXCEPTION 'A survey answer needs a link, an overall rating of 1 to 5 and a client' USING ERRCODE = '22023';
 END IF;
 v_comment := nullif(btrim(p_answers->>'comment'), '');
 PERFORM pg_advisory_xact_lock(hashtextextended('recruitment-response-client:' || p_client_hash, 0));
 DELETE FROM app.recruitment_response_attempt WHERE attempted_at < now() - interval '2 days';
 IF (SELECT count(*) FROM app.recruitment_response_attempt a WHERE a.client_hash = p_client_hash AND a.attempted_at > now() - interval '1 hour') >= 20 THEN
  RETURN 'limited';
 END IF;
 INSERT INTO app.recruitment_response_attempt (client_hash) VALUES (p_client_hash);
 l := app.recruitment_survey_live(p_token_digest);
 IF l.token_digest IS NULL THEN RETURN 'closed'; END IF;
 INSERT INTO public.recruitment_candidate_survey_response (tenant_id, company_id, outcome, answered_month, overall, communication, respect, process,
   recommend, comment)
  VALUES (l.tenant_id, l.company_id, l.outcome, date_trunc('month', now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date, (p_answers->>'overall')::smallint,
   (p_answers->>'communication')::smallint, (p_answers->>'respect')::smallint, (p_answers->>'process')::smallint, p_answers->>'recommend', v_comment);
 -- The link's record goes with the answer: nothing joins an answer to an e-mail.
 DELETE FROM app.recruitment_survey_invitation x WHERE x.token_digest = l.token_digest;
 PERFORM app.recruitment_survey_prune();
 RETURN 'answered';
END $$;
REVOKE ALL ON FUNCTION app.recruitment_survey_answer(text, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_survey_answer(text, jsonb, text) TO ai_hr_app;
--> statement-breakpoint

-- ── 5. Restated: 5873's guard (a survey's time window; its outcome is frozen) and statement check (a survey goes with the hire or the
-- rejection e-mail of this transaction, at the company's survey time, with {surveyLink} once in its text and HTML and never in its
-- subject); 5871's target (a survey goes only while its outcome still stands and, after a rejection, the rejection e-mail was sent;
-- the kind is returned so the sweep knows to issue a link) and finish (a held survey fails 24 days after it was queued, not 7) ──────
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
  ELSIF NEW.kind = 'survey' THEN
   -- Slice 22: a survey is due 1–14 days after the hire, or after its rejection e-mail (itself at most three days later); the
   -- statement check pins the exact time.
   IF NEW.next_attempt_at IS NULL OR NEW.next_attempt_at < now() + interval '1 day' OR NEW.next_attempt_at > now() + interval '17 days 1 minute' THEN
    RAISE EXCEPTION 'A survey is sent 1 to 14 days after the decision' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_candidate_email_survey';
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
     NEW.reply_to, NEW.queued_at, NEW.queued_by_user_id, NEW.interview_id, NEW.interview_starts_at, NEW.offer_id, NEW.survey_outcome)
  IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.company_id, OLD.job_id, OLD.application_id, OLD.candidate_id, OLD.kind, OLD.locale,
     OLD.sender_name, OLD.reply_to, OLD.queued_at, OLD.queued_by_user_id, OLD.interview_id, OLD.interview_starts_at, OLD.offer_id, OLD.survey_outcome) THEN
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
 -- Slice 22: a survey goes with a hire made in this transaction, or with the rejection e-mail queued in it by the current user, at the
 -- company's survey time after it, while the company's survey for that outcome is on; {surveyLink} once in its text and HTML, never in
 -- its subject (the sweep puts the link in at send time).
 IF EXISTS (SELECT 1 FROM inserted n
   JOIN public.recruitment_application a ON a.id = n.application_id AND a.tenant_id = n.tenant_id
   LEFT JOIN public.recruitment_candidate_email_setting st ON st.company_id = n.company_id AND st.tenant_id = n.tenant_id
   LEFT JOIN public.recruitment_candidate_email r ON r.application_id = n.application_id AND r.tenant_id = n.tenant_id AND r.kind = 'rejection'
   WHERE n.kind = 'survey' AND (
    (n.survey_outcome = 'hired' AND (st.survey_hired IS NOT TRUE OR a.state <> 'hired' OR a.state_changed_at <> now()
     OR n.next_attempt_at IS DISTINCT FROM now() + make_interval(days => st.survey_delay_days)))
    OR (n.survey_outcome = 'rejected' AND (st.survey_rejected IS NOT TRUE OR a.state <> 'archived' OR a.state_changed_at <> now()
     OR r.id IS NULL OR r.queued_at <> now() OR r.queued_by_user_id IS DISTINCT FROM app.current_user_id()
     OR n.next_attempt_at IS DISTINCT FROM r.next_attempt_at + make_interval(days => st.survey_delay_days)))
    OR strpos(n.subject, '{surveyLink}') > 0
    OR char_length(n.body_text) - char_length(replace(n.body_text, '{surveyLink}', '')) <> 12
    OR char_length(n.body_html) - char_length(replace(n.body_html, '{surveyLink}', '')) <> 12)) THEN
  RAISE EXCEPTION 'A survey goes with the hire or the rejection e-mail, at the company''s survey time' USING ERRCODE = '23514',
   CONSTRAINT = 'recruitment_candidate_email_survey';
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
CREATE OR REPLACE FUNCTION app.recruitment_candidate_email_target(p_id uuid, p_token uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE e public.recruitment_candidate_email%ROWTYPE; v_enabled boolean; v_current boolean; v_about boolean := true;
BEGIN
 IF NOT app.recruitment_candidate_email_worker_ok() THEN
  RAISE EXCEPTION 'Candidate e-mail delivery runs as the sweep' USING ERRCODE = '42501';
 END IF;
 INSERT INTO app.recruitment_candidate_email_context (txid, purpose, scope_id) VALUES (txid_current(), 'worker', app.current_tenant_id()) ON CONFLICT DO NOTHING;
 SELECT * INTO e FROM public.recruitment_candidate_email x
  WHERE x.id = p_id AND x.lease_token = p_token AND x.status = 'leased' AND x.started_at IS NULL AND x.lease_until > clock_timestamp();
 IF e.id IS NOT NULL THEN
  SELECT s.enabled INTO v_enabled FROM public.recruitment_candidate_email_setting s WHERE s.company_id = e.company_id AND s.tenant_id = e.tenant_id;
  -- Still the candidate's recorded address, and the candidate not removed (a changed address is not sent to: not eligible).
  SELECT c.destroyed_at IS NULL AND c.email IS NOT DISTINCT FROM e.recipient INTO v_current FROM public.recruitment_candidate c
   WHERE c.id = e.candidate_id AND c.tenant_id = e.tenant_id;
  -- Slice 20: what the e-mail is about is still as it was.
  IF e.kind IN ('interview_invitation','interview_reminder') THEN
   SELECT coalesce(bool_and(i.cancelled_at IS NULL AND i.starts_at = e.interview_starts_at AND a.state = 'active'
     AND (e.kind <> 'interview_reminder' OR i.starts_at > clock_timestamp())), false) INTO v_about
    FROM public.recruitment_interview i JOIN public.recruitment_application a ON a.id = i.application_id AND a.tenant_id = i.tenant_id
    WHERE i.id = e.interview_id AND i.tenant_id = e.tenant_id;
  ELSIF e.kind = 'interview_cancelled' THEN
   SELECT coalesce(bool_and(i.cancelled_at IS NOT NULL), false) INTO v_about FROM public.recruitment_interview i
    WHERE i.id = e.interview_id AND i.tenant_id = e.tenant_id;
  ELSIF e.kind = 'offer' THEN
   SELECT coalesce(bool_and(o.status = 'approved' AND o.sent_at = e.queued_at AND o.sent_channel = 'email' AND o.candidate_decision = 'pending'), false)
    INTO v_about FROM public.recruitment_offer o WHERE o.id = e.offer_id AND o.tenant_id = e.tenant_id;
  ELSIF e.kind = 'survey' THEN
   -- Slice 22: the outcome still stands and the company still surveys it; after a rejection, the rejection e-mail was sent.
   SELECT coalesce(bool_and(CASE WHEN e.survey_outcome = 'hired' THEN a.state = 'hired' AND st.survey_hired
     ELSE a.state = 'archived' AND st.survey_rejected AND EXISTS (SELECT 1 FROM public.recruitment_candidate_email r
      WHERE r.application_id = e.application_id AND r.tenant_id = e.tenant_id AND r.kind = 'rejection' AND r.status = 'sent') END), false)
    INTO v_about FROM public.recruitment_application a
    JOIN public.recruitment_candidate_email_setting st ON st.company_id = a.company_id AND st.tenant_id = a.tenant_id
    WHERE a.id = e.application_id AND a.tenant_id = e.tenant_id;
  END IF;
 END IF;
 DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
 IF e.id IS NULL THEN RETURN NULL; END IF;
 IF v_enabled IS NOT TRUE OR v_current IS NOT TRUE OR v_about IS NOT TRUE THEN RETURN jsonb_build_object('eligible', false); END IF;
 RETURN jsonb_build_object('eligible', true, 'recipient', e.recipient, 'subject', e.subject, 'text', e.body_text, 'html', e.body_html,
  'senderName', e.sender_name, 'replyTo', e.reply_to, 'kind', e.kind);
END $$;
REVOKE ALL ON FUNCTION app.recruitment_candidate_email_target(uuid, uuid) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.recruitment_candidate_email_finish(p_id uuid, p_token uuid, p_outcome text, p_error text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE e public.recruitment_candidate_email%ROWTYPE; v_status text; v_error text := p_error;
BEGIN
 IF NOT app.recruitment_candidate_email_worker_ok() THEN
  RAISE EXCEPTION 'Candidate e-mail delivery runs as the sweep' USING ERRCODE = '42501';
 END IF;
 IF p_outcome IS NULL OR p_outcome NOT IN ('sent','retry','failed','uncertain','held','skipped')
  OR (p_outcome = 'sent' AND p_error IS NOT NULL)
  OR (p_outcome = 'retry' AND p_error IS DISTINCT FROM 'smtpTemporary')
  OR (p_outcome = 'failed' AND p_error NOT IN ('smtpRejected','smtpAuthentication','smtpTls','invalidMessage','relayPreparation'))
  OR (p_outcome = 'uncertain' AND p_error IS DISTINCT FROM 'uncertain')
  OR (p_outcome = 'held' AND p_error IS DISTINCT FROM 'relayUnavailable')
  OR (p_outcome = 'skipped' AND p_error IS DISTINCT FROM 'notEligible') THEN
  RETURN false;
 END IF;
 INSERT INTO app.recruitment_candidate_email_context (txid, purpose, scope_id) VALUES (txid_current(), 'worker', app.current_tenant_id()) ON CONFLICT DO NOTHING;
 SELECT * INTO e FROM public.recruitment_candidate_email x WHERE x.id = p_id AND x.lease_token = p_token FOR UPDATE;
 IF e.id IS NULL OR (p_outcome IN ('held','skipped') AND (e.status <> 'leased' OR e.started_at IS NOT NULL))
  OR (p_outcome NOT IN ('held','skipped') AND (e.status <> 'sending' OR e.started_at IS NULL)) THEN
  DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
  RETURN false;
 END IF;
 -- Held for at most 7 days since it was queued (or retried): then it fails as relay unavailable, final, so the purge applies. A
 -- reminder instead fails once its interview has started (it is held at most 72 hours before that; its queue time may be weeks old).
 IF p_outcome = 'held' AND (CASE WHEN e.kind = 'interview_reminder' THEN e.interview_starts_at <= now()
   WHEN e.kind = 'survey' AND e.retried_at IS NULL THEN e.queued_at < now() - interval '24 days'
   ELSE greatest(e.queued_at, coalesce(e.retried_at, e.queued_at)) < now() - interval '7 days' END) THEN
  p_outcome := 'failed';
 END IF;
 IF p_outcome = 'held' THEN
  UPDATE public.recruitment_candidate_email x SET status = CASE WHEN x.attempts > 1 THEN 'retry' ELSE 'queued' END,
   attempts = greatest(x.attempts - 1, 0), error_code = 'relayUnavailable', next_attempt_at = now() + interval '5 minutes',
   lease_token = NULL, lease_until = NULL
   WHERE x.id = e.id;
  DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
  RETURN true;
 END IF;
 v_status := CASE p_outcome WHEN 'skipped' THEN 'failed' WHEN 'retry' THEN CASE WHEN e.attempts >= 5 THEN 'failed' ELSE 'retry' END ELSE p_outcome END;
 UPDATE public.recruitment_candidate_email x SET status = v_status, error_code = v_error, lease_token = NULL, lease_until = NULL,
  started_at = CASE WHEN v_status = 'retry' THEN NULL ELSE x.started_at END,
  completed_at = CASE WHEN v_status = 'retry' THEN NULL ELSE clock_timestamp() END,
  next_attempt_at = CASE WHEN v_status = 'retry' THEN now() + make_interval(secs => least(3600, 60 * power(2, x.attempts))) ELSE x.next_attempt_at END
  WHERE x.id = e.id;
 DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
 INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
  VALUES (e.tenant_id, 'recruitment-application', e.application_id, 'recruitment-candidate-email.' || v_status, 'system', NULL,
   jsonb_build_object('companyId', e.company_id, 'emailId', e.id, 'kind', e.kind, 'error', v_error, 'attempts', e.attempts));
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_candidate_email_finish(uuid, uuid, text, text) FROM PUBLIC, ai_hr_app;
