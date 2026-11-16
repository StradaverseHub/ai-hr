-- Real email for shared workflow steps (lane F1 of the Probation Confirmation build; ADR
-- docs/adr/2026-11-15-probation-shared-automation.md, decision 2 and build step 4; handoff A1/B4).
-- Tag 5754 / idx 5154 / when 1793330005454, assigned by the build coordinator.
--
-- A Probation "Send an email" or "Notify someone" step already leaves an in-app notice (5753). It now also records a
-- durable email intent in the same transaction as the command that raised the event, and the existing out-of-band
-- delivery pattern of On/Off Boarding V9 (0714: lease, private capability read, start marker committed before SMTP,
-- receipt) sends it later. No external I/O happens under a business lock and a started message is never replayed.
--  1. automation_email_delivery: one row per message (at most eight To recipients; the CC list rides on the first
--     message of a step), idempotent on (tenant, mail key = run:step:chunk). Owner-only under forced row security;
--     the payload (frozen subject, body and recipient user ids) is immutable and a start marker can never be cleared.
--  2. app.automation_email_queue(module, subject, key, to, cc, subject line, body): the runner's write path, authorized
--     by app.automation_can_run(module, subject) and taken under the shared workforce barrier. Only active logins with
--     a live internal sign-in identity of the tenant are addressed; the others are returned so the run records them.
--     Records an automation.email-queued domain event.
--  3. app.automation_email_target / _start / _finish: the private sender's capability reads and receipts, with the
--     same contract as app.lc_v9_email_target / _start / _finish (live lease, canonical https origin, recipient
--     bindings to the installation's issuer, start committed before SMTP, a lost finish becomes uncertain).
-- New, empty table without a company column (the subject is the module's case): no backfill and no company key.
-- No existing table, row, grant or purpose-role object changes.
CREATE TABLE public.automation_email_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  module text NOT NULL CHECK (module IN ('probation')),
  subject_id uuid NOT NULL,
  mail_key text NOT NULL CHECK (length(mail_key) BETWEEN 1 AND 320),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','leased','sending','sent','retry','failed','uncertain','cancelled')),
  lease_token uuid, lease_until timestamptz, started_at timestamptz, completed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 1000),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  error_code text CHECK (error_code IS NULL OR error_code IN ('relayUnavailable','recipientUnavailable','recipientChanged','notEligible','smtpTemporary','smtpRejected','smtpAuthentication','smtpTls','uncertain')),
  recipient_proof jsonb,
  created_by uuid REFERENCES public.app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, mail_key),
  CHECK ((status NOT IN ('leased','sending')) OR (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK (status <> 'sending' OR started_at IS NOT NULL),
  CHECK (status <> 'sent' OR completed_at IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX automation_email_due ON public.automation_email_delivery (tenant_id, next_attempt_at, id) WHERE status IN ('queued','leased','sending');
--> statement-breakpoint
CREATE INDEX automation_email_subject ON public.automation_email_delivery (tenant_id, module, subject_id);
--> statement-breakpoint
ALTER TABLE public.automation_email_delivery ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.automation_email_delivery FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY automation_email_delivery_owner ON public.automation_email_delivery FOR ALL TO ai_hr_owner USING (app.acting_as_owner()) WITH CHECK (app.acting_as_owner());
--> statement-breakpoint
REVOKE ALL ON public.automation_email_delivery FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.automation_email_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.module, NEW.subject_id, NEW.mail_key, NEW.payload, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.module, OLD.subject_id, OLD.mail_key, OLD.payload, OLD.created_by, OLD.created_at)
  THEN RAISE EXCEPTION 'A queued workflow email is immutable'; END IF;
  IF OLD.started_at IS NOT NULL AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'A started workflow email cannot be replayed';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_email_immutable() FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER automation_email_immutable BEFORE UPDATE ON public.automation_email_delivery FOR EACH ROW EXECUTE FUNCTION app.automation_email_immutable();
--> statement-breakpoint
-- The runner's write path. To and CC are user ids the module resolved (routings and groups reach everyone matched);
-- each list is de-duplicated in order, CC never repeats a To recipient, and a step with no addressable To recipient
-- sends to its CC list instead. Returns the number of messages queued now and the users who have no sign-in email.
CREATE FUNCTION app.automation_email_queue(p_module text, p_subject uuid, p_key text, p_to uuid[], p_cc uuid[], p_subject_line text, p_body text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid := app.current_tenant_id(); to_ids uuid[]; cc_ids uuid[]; unreachable uuid[]; queued integer := 0; v_employment uuid; link text;
BEGIN
  IF app.automation_can_run(p_module, p_subject) IS NOT TRUE THEN RAISE EXCEPTION 'This workflow runner is not permitted here' USING ERRCODE = '42501'; END IF;
  PERFORM app.access_workforce_write_lock();
  IF length(coalesce(p_key, '')) NOT BETWEEN 1 AND 300 OR length(coalesce(p_subject_line, '')) NOT BETWEEN 1 AND 500 OR length(coalesce(p_body, '')) > 20000
     OR coalesce(cardinality(p_to), 0) > 200 OR coalesce(cardinality(p_cc), 0) > 200 OR coalesce(cardinality(p_to), 0) + coalesce(cardinality(p_cc), 0) = 0
  THEN RAISE EXCEPTION 'Invalid workflow email' USING ERRCODE = '22023'; END IF;
  IF p_module = 'probation' THEN
    SELECT c.employment_id INTO v_employment FROM public.probation_case c WHERE c.id = p_subject AND c.tenant_id = t;
    IF v_employment IS NULL THEN RAISE EXCEPTION 'Probation case unavailable'; END IF;
    link := '/lifecycle/probation/' || p_subject::text;
  ELSE RAISE EXCEPTION 'Invalid workflow email' USING ERRCODE = '22023'; END IF;
  WITH input AS (
    SELECT DISTINCT ON (x.id) x.id, x.n, x.list FROM (
      SELECT id, n, 1 AS list FROM unnest(coalesce(p_to, '{}'::uuid[])) WITH ORDINALITY a(id, n)
      UNION ALL SELECT id, n, 2 AS list FROM unnest(coalesce(p_cc, '{}'::uuid[])) WITH ORDINALITY b(id, n)) x
    WHERE x.id IS NOT NULL ORDER BY x.id, x.list, x.n
  ), checked AS (
    SELECT i.id, i.n, i.list, EXISTS(
      SELECT 1 FROM public.app_user u JOIN public.app_external_identity identity ON identity.app_user_id = u.id AND identity.revoked_at IS NULL AND identity.issuer LIKE '%/auth/' || t::text
      WHERE u.id = i.id AND u.tenant_id = t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) AS reachable
    FROM input i
  )
  SELECT coalesce(array_agg(id ORDER BY n) FILTER (WHERE reachable AND list = 1), '{}'),
         coalesce(array_agg(id ORDER BY n) FILTER (WHERE reachable AND list = 2), '{}'),
         coalesce(array_agg(id ORDER BY list, n) FILTER (WHERE NOT reachable), '{}')
    INTO to_ids, cc_ids, unreachable FROM checked;
  IF cardinality(to_ids) = 0 THEN to_ids := cc_ids; cc_ids := '{}'; END IF;
  IF cardinality(to_ids) > 0 THEN
    WITH inserted AS (
      INSERT INTO public.automation_email_delivery (tenant_id, module, subject_id, mail_key, payload, created_by)
      SELECT t, p_module, p_subject, p_key || ':' || g::text,
        jsonb_build_object('version', 1, 'module', p_module, 'subjectId', p_subject, 'linkPath', link, 'mail', jsonb_build_object(
          'id', p_key || ':' || g::text, 'to', to_jsonb(to_ids[g * 8 + 1 : g * 8 + 8]), 'cc', CASE WHEN g = 0 THEN to_jsonb(cc_ids) ELSE '[]'::jsonb END,
          'subject', p_subject_line, 'body', coalesce(p_body, ''),
          'delivery', jsonb_build_object('version', 1, 'sender', 'noreply', 'pdfDocumentIds', '[]'::jsonb, 'linkDocumentIds', '[]'::jsonb, 'assets', '[]'::jsonb))),
        app.current_user_id()
      FROM generate_series(0, (cardinality(to_ids) - 1) / 8) g
      ON CONFLICT (tenant_id, mail_key) DO NOTHING RETURNING 1)
    SELECT count(*) INTO queued FROM inserted;
  END IF;
  IF queued > 0 THEN
    INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, subject_employment_id, payload)
    VALUES (t, 'automation-email', p_subject, 'automation.email-queued', CASE WHEN app.current_user_id() IS NULL THEN 'system'::actor_type ELSE 'user'::actor_type END,
      app.current_user_id(), v_employment, jsonb_build_object('module', p_module, 'subjectId', p_subject, 'key', p_key, 'messages', queued,
      'recipients', cardinality(to_ids) + cardinality(cc_ids), 'withoutEmail', cardinality(unreachable)));
  END IF;
  RETURN jsonb_build_object('queued', queued, 'to', to_jsonb(to_ids), 'cc', to_jsonb(cc_ids), 'unreachable', to_jsonb(unreachable));
END $$;
--> statement-breakpoint
-- The private sender's capability read: a live lease on an unstarted message, the canonical https installation origin
-- and a live binding of every recipient to that installation's issuer. The sender still verifies each credential.
CREATE FUNCTION app.automation_email_target(p_id uuid, p_token uuid, p_origin text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE job public.automation_email_delivery%ROWTYPE; recipients jsonb; bindings jsonb; total integer;
BEGIN
  IF p_origin IS NULL OR p_origin !~ '^https://[^/@?#[:space:]]+(:[0-9]+)?$' THEN RETURN NULL; END IF;
  SELECT * INTO job FROM public.automation_email_delivery WHERE id = p_id AND lease_token = p_token
    AND status = 'leased' AND started_at IS NULL AND lease_until > clock_timestamp();
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF job.module = 'probation' AND NOT EXISTS(SELECT 1 FROM public.probation_case c WHERE c.id = job.subject_id AND c.tenant_id = job.tenant_id) THEN RETURN NULL; END IF;
  recipients := coalesce(job.payload->'mail'->'to', '[]'::jsonb) || coalesce(job.payload->'mail'->'cc', '[]'::jsonb);
  SELECT count(*) INTO total FROM jsonb_array_elements_text(recipients);
  SELECT jsonb_agg(jsonb_build_object('userId', r.uid, 'subject', identity.subject, 'issuer', identity.issuer) ORDER BY r.ordinality)
    INTO bindings
    FROM jsonb_array_elements_text(recipients) WITH ORDINALITY r(uid, ordinality)
    JOIN public.app_user u ON u.id::text = r.uid AND u.tenant_id = job.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
    JOIN public.app_external_identity identity ON identity.app_user_id = u.id AND identity.issuer = p_origin || '/auth/' || job.tenant_id::text AND identity.revoked_at IS NULL;
  bindings := coalesce(bindings, '[]'::jsonb);
  IF total < 1 OR jsonb_array_length(bindings) <> total OR (SELECT count(DISTINCT b->>'userId') FROM jsonb_array_elements(bindings) b) <> total THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('id', job.id, 'tenantId', job.tenant_id, 'module', job.module, 'subjectId', job.subject_id, 'payload', job.payload, 'bindings', bindings);
END $$;
--> statement-breakpoint
-- Commits before SMTP starts. A crash after this boundary becomes uncertain and is never re-sent automatically.
CREATE FUNCTION app.automation_email_start(p_id uuid, p_token uuid, p_origin text, p_proof jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target jsonb;
BEGIN
  PERFORM 1 FROM public.automation_email_delivery WHERE id = p_id AND lease_token = p_token FOR UPDATE;
  target := app.automation_email_target(p_id, p_token, p_origin);
  IF target IS NULL OR jsonb_typeof(p_proof) IS DISTINCT FROM 'object' OR p_proof->'bindings' IS DISTINCT FROM target->'bindings' THEN RETURN false; END IF;
  IF jsonb_typeof(p_proof->'addresses') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(p_proof->'addresses') <> jsonb_array_length(target->'bindings') OR coalesce(p_proof->>'relayRevision', '') = '' THEN RETURN false; END IF;
  UPDATE public.automation_email_delivery SET status = 'sending', started_at = clock_timestamp(), recipient_proof = p_proof, updated_at = now()
    WHERE id = p_id AND lease_token = p_token AND status = 'leased' AND started_at IS NULL;
  RETURN FOUND;
END $$;
--> statement-breakpoint
CREATE FUNCTION app.automation_email_finish(p_id uuid, p_token uuid, p_outcome text, p_error text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF p_outcome IS NULL OR p_outcome NOT IN ('sent','retry','failed','uncertain') THEN RETURN false; END IF;
  IF p_error IS NOT NULL AND p_error NOT IN ('smtpTemporary','smtpRejected','smtpAuthentication','smtpTls','uncertain') THEN RETURN false; END IF;
  IF (p_outcome = 'sent') <> (p_error IS NULL) THEN RETURN false; END IF;
  UPDATE public.automation_email_delivery SET status = p_outcome, completed_at = clock_timestamp(), error_code = p_error, updated_at = now()
    WHERE id = p_id AND lease_token = p_token AND (status = 'sending' OR status = 'uncertain' AND error_code = 'uncertain') AND started_at IS NOT NULL;
  RETURN FOUND;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.automation_email_queue(text,uuid,text,uuid[],uuid[],text,text), app.automation_email_target(uuid,uuid,text),
  app.automation_email_start(uuid,uuid,text,jsonb), app.automation_email_finish(uuid,uuid,text,text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.automation_email_queue(text,uuid,text,uuid[],uuid[],text,text), app.automation_email_target(uuid,uuid,text),
  app.automation_email_start(uuid,uuid,text,jsonb), app.automation_email_finish(uuid,uuid,text,text) TO ai_hr_app
