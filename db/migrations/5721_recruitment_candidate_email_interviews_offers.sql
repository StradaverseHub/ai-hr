-- Recruitment slice 20 (docs/recruitment-reconstruction/specification.md "Slice 20"; D-063, D-065): candidate e-mail for interviews
-- and offers — an invitation a person ticks when scheduling (previewed), an automatic reminder before an invited interview, a
-- cancellation e-mail a person ticks when cancelling (previewed), and an offer e-mail a person sends for an Approved offer (previewed;
-- only the offer fields the company marks "include in e-mail", as people entered them). Builds on 5720; delivery is 5720's sweep.
--
-- Who:
--   invitation, reminder — queued only in the transaction that schedules the interview, by the person scheduling it (an operator of the
--                          job); the reminder only with an invitation, at exactly the interview's start minus the company's reminder
--                          hours (2–72, default 24; reminders on by default), and only while that time is still ahead.
--   cancellation         — queued only in the transaction in which the person sending it cancelled the interview. The automatic
--                          cancellation when an application closes (5719, ./interview-closing) never queues one.
--   offer                — queued only in the transaction that records the offer as sent by e-mail, by that person, for an Approved
--                          offer with no candidate decision yet (sent_at = now(), channel e-mail).
--   withdrawal           — cancelling an interview (by a person or because its application closed) withdraws its invitation and
--                          reminder that are still waiting (queued or due to retry), in the same statement, as the owner (trigger).
--   the sweep            — 5720's functions; the target is restated: an invitation or reminder is not sent once its interview is
--                          cancelled, moved or its application no longer active (or a reminder whose interview has started); an offer
--                          e-mail is not sent once the offer was re-issued (its sent time changed) or decided.
--
-- What this installs:
--   1. recruitment_candidate_email_setting: reminder_enabled (default true) and reminder_hours (2–72, default 24).
--   2. recruitment_offer_field: include_in_email (default false): administrators mark the fields an offer e-mail states.
--   3. The kinds interview_invitation, interview_reminder, interview_cancelled and offer: template and delivery CHECKs, the placeholder
--      allowlist restated (app.recruitment_candidate_email_placeholders_ok), and on each delivery the interview (with its start, frozen)
--      or the offer it is about. At most one invitation, one reminder and one cancellation per interview; one offer e-mail per send of
--      an offer.
--   4. The address's https map link (5719) may appear in an invitation or reminder: frozen on the row (map_url) and checked against the
--      interview's address when queued. It is the ONE link a candidate e-mail may carry (D-065): the frozen text with exactly that link
--      removed must still be link-free; subjects never carry it; templates still carry none.
--   5. The state 'withdrawn' (final; its content purged after 90 days like the others).
--   6. app.recruitment_guard_candidate_email and app.recruitment_check_candidate_email_queue restated (5720 bodies plus the new kinds),
--      app.recruitment_candidate_email_finish restated (a held reminder fails once its interview has started),
--      app.recruitment_candidate_email_target and app.recruitment_candidate_email_purge restated, and owner-only worker read policies on
--      recruitment_application, recruitment_interview and recruitment_offer (keyed by 5720's context table, as for the candidate).
--   7. A statement trigger on recruitment_interview that withdraws a cancelled interview's waiting invitation and reminder.
--
-- 5720's removal and company-delete functions already delete every row of the delivery table by candidate and by company; nothing
-- else is restated. Nothing here calls a model or decides anything about a candidate: people schedule, cancel and send.
--
-- PRECONDITION: applies after 5720 (it alters 5720's tables and restates its functions).

-- ── 1. Reminder settings ───────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.recruitment_candidate_email_setting
 ADD COLUMN reminder_enabled boolean NOT NULL DEFAULT true,
 ADD COLUMN reminder_hours integer NOT NULL DEFAULT 24 CONSTRAINT recruitment_candidate_email_setting_reminder_hours_ck CHECK (reminder_hours BETWEEN 2 AND 72);
--> statement-breakpoint

-- ── 2. Offer fields an offer e-mail states ─────────────────────────────────────────────────────────────────
ALTER TABLE public.recruitment_offer_field ADD COLUMN include_in_email boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- ── 3. Kinds and placeholders ──────────────────────────────────────────────────────────────────────────────
-- 5720's function restated with every kind's allowlist (packs/recruitment/candidate-email-model.ts CANDIDATE_EMAIL_PLACEHOLDERS; a test
-- compares them).
CREATE OR REPLACE FUNCTION app.recruitment_candidate_email_placeholders_ok(p_kind text, p_text text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT p_text IS NOT NULL
  AND p_kind IN ('application_received','rejection','interview_invitation','interview_reminder','interview_cancelled','offer')
  AND NOT EXISTS (SELECT 1 FROM regexp_matches(p_text, '\{([^{}]*)\}', 'g') AS m(x)
   WHERE NOT (m.x[1] = ANY (CASE p_kind
    WHEN 'interview_invitation' THEN ARRAY['candidateName','jobTitle','companyName','senderName','interviewRound','interviewType','interviewDate',
     'interviewTime','interviewDuration','interviewPlace']
    WHEN 'interview_reminder' THEN ARRAY['candidateName','jobTitle','companyName','senderName','interviewRound','interviewType','interviewDate',
     'interviewTime','interviewDuration','interviewPlace']
    WHEN 'interview_cancelled' THEN ARRAY['candidateName','jobTitle','companyName','senderName','interviewRound','interviewType','interviewDate',
     'interviewTime']
    WHEN 'offer' THEN ARRAY['candidateName','jobTitle','companyName','senderName','offerDetails']
    ELSE ARRAY['candidateName','jobTitle','companyName','senderName'] END)))
  AND regexp_replace(p_text, '\{[^{}]*\}', '', 'g') !~ '[{}]';
$$;
REVOKE ALL ON FUNCTION app.recruitment_candidate_email_placeholders_ok(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_candidate_email_placeholders_ok(text, text) TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE public.recruitment_candidate_email_template DROP CONSTRAINT recruitment_candidate_email_template_kind_check;
ALTER TABLE public.recruitment_candidate_email_template ADD CONSTRAINT recruitment_candidate_email_template_kind_check
 CHECK (kind IN ('application_received','rejection','interview_invitation','interview_reminder','interview_cancelled','offer'));
--> statement-breakpoint

-- ── 4. Deliveries: kinds, what they are about, the map link and 'withdrawn' ───────────────────────────────
-- PRECONDITION (header): 5720 is applied; its rows (if any) are receipts and rejections, which satisfy every constraint below.
ALTER TABLE public.recruitment_candidate_email
 DROP CONSTRAINT recruitment_candidate_email_kind_check,
 DROP CONSTRAINT recruitment_candidate_email_status_check,
 DROP CONSTRAINT recruitment_candidate_email_body_text_check,
 DROP CONSTRAINT recruitment_candidate_email_content_ck,
 DROP CONSTRAINT recruitment_candidate_email_final_ck,
 ADD COLUMN interview_id uuid,
 ADD COLUMN interview_starts_at timestamptz,
 ADD COLUMN offer_id uuid,
 -- The interview address's https map link (5719's rule), frozen with the content; NULL once purged.
 ADD COLUMN map_url text CONSTRAINT recruitment_candidate_email_map_url_ck CHECK (map_url IS NULL OR (char_length(map_url) <= 2000
  AND map_url ~ '^https://[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+(:[0-9]{1,5})?([/?#][^[:space:][:cntrl:]"<>\\`]*)?$')),
 ADD CONSTRAINT recruitment_candidate_email_kind_check
  CHECK (kind IN ('application_received','rejection','interview_invitation','interview_reminder','interview_cancelled','offer')),
 ADD CONSTRAINT recruitment_candidate_email_status_check
  CHECK (status IN ('queued','leased','sending','sent','retry','failed','uncertain','withdrawn')),
 -- No link- or domain-like text, except — in an invitation or reminder — exactly the frozen map link (removed before the check).
 ADD CONSTRAINT recruitment_candidate_email_body_text_check CHECK (body_text IS NULL OR (char_length(body_text) BETWEEN 1 AND 20000
  AND NOT app.recruitment_candidate_email_linkish(CASE WHEN map_url IS NULL THEN body_text ELSE replace(body_text, map_url, ' ') END))),
 ADD CONSTRAINT recruitment_candidate_email_content_ck CHECK (
  (content_purged_at IS NULL AND recipient IS NOT NULL AND subject IS NOT NULL AND body_text IS NOT NULL AND body_html IS NOT NULL)
  OR (content_purged_at IS NOT NULL AND recipient IS NULL AND subject IS NULL AND body_text IS NULL AND body_html IS NULL AND map_url IS NULL
   AND status IN ('sent','failed','uncertain','withdrawn'))),
 ADD CONSTRAINT recruitment_candidate_email_final_ck CHECK (status NOT IN ('sent','failed','uncertain','withdrawn') OR completed_at IS NOT NULL),
 -- What each kind is about: an interview (with its start, frozen) for the interview kinds, an offer for an offer e-mail, nothing else
 -- for receipts and rejections. A map link only in an invitation or reminder.
 ADD CONSTRAINT recruitment_candidate_email_subject_ck CHECK (
  (kind IN ('interview_invitation','interview_reminder','interview_cancelled')) = (interview_id IS NOT NULL)
  AND (interview_id IS NULL) = (interview_starts_at IS NULL)
  AND (kind = 'offer') = (offer_id IS NOT NULL)
  AND (map_url IS NULL OR kind IN ('interview_invitation','interview_reminder'))),
 ADD CONSTRAINT recruitment_candidate_email_interview_fk FOREIGN KEY (interview_id, application_id, job_id, company_id, tenant_id)
  REFERENCES public.recruitment_interview(id, application_id, job_id, company_id, tenant_id),
 ADD CONSTRAINT recruitment_candidate_email_offer_fk FOREIGN KEY (offer_id, job_id, company_id, tenant_id)
  REFERENCES public.recruitment_offer(id, job_id, company_id, tenant_id);
-- One invitation, one reminder and one cancellation per interview; one offer e-mail per send of an offer (an offer that changes after
-- it was sent is re-issued and may be sent again: its queue time is its new sent time).
CREATE UNIQUE INDEX recruitment_candidate_email_interview_uq ON public.recruitment_candidate_email (interview_id, kind) WHERE interview_id IS NOT NULL;
CREATE UNIQUE INDEX recruitment_candidate_email_offer_uq ON public.recruitment_candidate_email (offer_id, queued_at) WHERE offer_id IS NOT NULL;
CREATE INDEX recruitment_candidate_email_offer_idx ON public.recruitment_candidate_email (offer_id) WHERE offer_id IS NOT NULL;
-- 5720's purge index restated for the new final state.
DROP INDEX public.recruitment_candidate_email_purge_idx;
CREATE INDEX recruitment_candidate_email_purge_idx ON public.recruitment_candidate_email (tenant_id, completed_at)
 WHERE content_purged_at IS NULL AND status IN ('sent','failed','uncertain','withdrawn');
--> statement-breakpoint

-- ── 5. The sweep reads what an e-mail is about (owner only, inside its functions for the tenant they set) ─────
-- New owner-only policies on existing tables, keyed by 5720's context table exactly as recruitment_candidate_email_worker_read; the app
-- role never satisfies them. No index or constraint is added to these tables.
CREATE POLICY recruitment_application_email_worker_read ON public.recruitment_application FOR SELECT USING (
 current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_application'::regclass))
 AND app.recruitment_email_context_open('worker', tenant_id));
CREATE POLICY recruitment_interview_email_worker_read ON public.recruitment_interview FOR SELECT USING (
 current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_interview'::regclass))
 AND app.recruitment_email_context_open('worker', tenant_id));
CREATE POLICY recruitment_offer_email_worker_read ON public.recruitment_offer FOR SELECT USING (
 current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_offer'::regclass))
 AND app.recruitment_email_context_open('worker', tenant_id));
--> statement-breakpoint

-- ── 6. Guards restated ─────────────────────────────────────────────────────────────────────────────────────
-- 5720's row guard, its body plus: a reminder is sent later (its exact time is checked per statement, below); the new frozen columns
-- (interview, its start, offer) never change, and the map link is content (it only goes, with the rest, on purge).
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
 IF (NEW.recipient, NEW.subject, NEW.body_text, NEW.body_html, NEW.map_url) IS DISTINCT FROM (OLD.recipient, OLD.subject, OLD.body_text, OLD.body_html, OLD.map_url)
  AND NOT (NEW.recipient IS NULL AND NEW.subject IS NULL AND NEW.body_text IS NULL AND NEW.body_html IS NULL AND NEW.map_url IS NULL
   AND NEW.content_purged_at IS NOT NULL) THEN
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
 -- Slice 20: a retried reminder is sent at once, not at its original time (which may have passed): no change here — 5720's reset of
 -- next_attempt_at to now() below already does that.
 NEW.retried_at := now(); NEW.retry_count := OLD.retry_count + 1; NEW.attempts := 0; NEW.error_code := NULL; NEW.next_attempt_at := now();
 NEW.lease_token := NULL; NEW.lease_until := NULL; NEW.started_at := NULL; NEW.completed_at := NULL; NEW.relay_revision := NULL;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_candidate_email() FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- 5720's statement check, its body plus the new kinds:
--   invitation, reminder — the interview is the inserted row's, of its application, scheduled in THIS transaction by the current user
--                          (created_at = now()), not cancelled, its start as frozen, the application active; the map link is the
--                          interview address's current one (NULL without an address or link). A reminder also needs an invitation for
--                          the same interview, the company's reminders on, and is due at exactly the start minus the company's hours.
--   cancellation         — the interview was cancelled in THIS transaction by the current user (cancelled_at = now()), its start as
--                          frozen, no map link.
--   offer                — the offer is the application's, Approved, sent in THIS transaction by the current user by e-mail
--                          (sent_at = now()), with no candidate decision; the application active.
-- Runs as the caller; the owner (tests and maintenance only) is not checked.
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

-- ── 7. The sweep: target and purge restated ────────────────────────────────────────────────────────────────
-- 5720's target, its body plus: an invitation or reminder is not eligible once its interview is cancelled or its start differs from
-- the frozen one, or its application is no longer active (a reminder also once the interview has started); a cancellation once the
-- interview is no longer cancelled (never: cancelled is final); an offer e-mail once the offer was re-issued (its sent time is no
-- longer this e-mail's queue time), no longer sent by e-mail, or decided.
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
  END IF;
 END IF;
 DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
 IF e.id IS NULL THEN RETURN NULL; END IF;
 IF v_enabled IS NOT TRUE OR v_current IS NOT TRUE OR v_about IS NOT TRUE THEN RETURN jsonb_build_object('eligible', false); END IF;
 RETURN jsonb_build_object('eligible', true, 'recipient', e.recipient, 'subject', e.subject, 'text', e.body_text, 'html', e.body_html,
  'senderName', e.sender_name, 'replyTo', e.reply_to);
END $$;
REVOKE ALL ON FUNCTION app.recruitment_candidate_email_target(uuid, uuid) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- 5720's finish, its body with one change: a held reminder fails as relay unavailable once its interview has started, instead of 7 days
-- after it was queued (queued weeks before an interview, it would otherwise fail the first time it is held; a late reminder is none).
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
 IF p_outcome = 'held' AND CASE WHEN e.kind = 'interview_reminder' THEN e.interview_starts_at <= now()
   ELSE greatest(e.queued_at, coalesce(e.retried_at, e.queued_at)) < now() - interval '7 days' END THEN
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
--> statement-breakpoint
-- 5720's purge, its body plus the map link and the final state 'withdrawn'.
CREATE OR REPLACE FUNCTION app.recruitment_candidate_email_purge(p_limit integer) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_tenant uuid := app.current_tenant_id(); n integer;
BEGIN
 IF NOT app.recruitment_candidate_email_worker_ok() OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000 THEN
  RAISE EXCEPTION 'Candidate e-mail delivery runs as the sweep' USING ERRCODE = '42501';
 END IF;
 INSERT INTO app.recruitment_candidate_email_context (txid, purpose, scope_id) VALUES (txid_current(), 'worker', v_tenant) ON CONFLICT DO NOTHING;
 UPDATE public.recruitment_candidate_email e SET recipient = NULL, subject = NULL, body_text = NULL, body_html = NULL, map_url = NULL, content_purged_at = now()
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

-- ── 8. Cancelling an interview withdraws its waiting invitation and reminder ───────────────────────────────
-- One statement trigger over the updated interviews (a closing application cancels its future interviews in one statement): for every
-- interview cancelled by the statement, its invitation and reminder still queued or due to retry become 'withdrawn' (final, never
-- sent), with one domain event each (no address or content). One leased right now is not touched: the sweep's target sees the
-- cancelled interview and does not send it. Runs as the owner for the tenants of the cancelled interviews only (5720's context table,
-- written and deleted inside this function); indexed by interview.
CREATE FUNCTION app.recruitment_withdraw_interview_emails() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_ids uuid[]; v_tenants uuid[];
BEGIN
 SELECT coalesce(array_agg(n.id), '{}'), coalesce(array_agg(DISTINCT n.tenant_id), '{}') INTO v_ids, v_tenants
  FROM new_rows n JOIN old_rows o ON o.id = n.id WHERE o.cancelled_at IS NULL AND n.cancelled_at IS NOT NULL;
 IF cardinality(v_ids) = 0 THEN RETURN NULL; END IF;
 INSERT INTO app.recruitment_candidate_email_context (txid, purpose, scope_id) SELECT txid_current(), 'worker', t FROM unnest(v_tenants) t ON CONFLICT DO NOTHING;
 WITH withdrawn AS (
  UPDATE public.recruitment_candidate_email e SET status = 'withdrawn', completed_at = now(), error_code = NULL
  WHERE e.interview_id = ANY (v_ids) AND e.kind IN ('interview_invitation','interview_reminder') AND e.status IN ('queued','retry')
  RETURNING e.id, e.tenant_id, e.company_id, e.application_id, e.kind)
 INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
  SELECT w.tenant_id, 'recruitment-application', w.application_id, 'recruitment-candidate-email.withdrawn',
   CASE WHEN app.current_user_id() IS NULL THEN 'system' ELSE 'user' END, app.current_user_id(),
   jsonb_build_object('companyId', w.company_id, 'emailId', w.id, 'kind', w.kind, 'reason', 'interview_cancelled')
  FROM withdrawn w;
 DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker' AND scope_id = ANY (v_tenants);
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_withdraw_interview_emails() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_interview_withdraw_emails AFTER UPDATE ON public.recruitment_interview
 REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION app.recruitment_withdraw_interview_emails();
