-- Recruitment slice 21a (docs/recruitment-reconstruction/specification.md "Slice 21"; D-026, D-063, D-064, D-066): verified careers
-- applicants and careers receipts. While a company's candidate e-mail is on (5870's switch), a careers application is stored only
-- with a verification the same e-mail earned for the same job by a one-time code in the last 30 minutes, used once; and a verified
-- application gets the company's "Application received" e-mail automatically, queued as by the applicant. Companies with candidate
-- e-mail off keep slice 8's unverified form and get no receipt (D-066).
--
-- Who (all anonymous, through definers on the careers pool; a call inside a signed-in session is refused):
--   issue a code   — app.recruitment_careers_issue_code: for a public job of a page whose company has candidate e-mail on; the
--                    server sends the code itself (the database never sees it, only its keyed hash). Limits: 10 codes an hour per
--                    client hash; 3 an hour and 10 a Kuala Lumpur day per company and address. An earlier unused code for the
--                    same address and job is spent.
--   check a code   — app.recruitment_careers_check_code: 30 checks an hour per client hash; a code expires after 10 minutes and is
--                    spent after 5 wrong entries; a right one is spent and yields a verification (a token's hash) valid 30 minutes
--                    for that address and job.
--   apply          — app.recruitment_careers_apply, the ONLY careers submission granted to the app role now: while the company's
--                    candidate e-mail is on it requires an unused, unexpired verification of this address for this job and consumes
--                    it; then it calls 5858's submission (restated below with the new application's id in its result).
--   queue receipt  — app.recruitment_careers_queue_receipt: the rendered receipt of an application created from a verification
--                    in THIS transaction's last 10 minutes, to the candidate's recorded (verified) address, with the company's
--                    current sender, reply-to and language; at most one per application (5870's key); within 5870's hourly cap.
-- Addresses are never stored: codes, checks and verifications keep sha256 of the normalised address (to match the application)
-- and keyed hashes of the code and the token. Everything here is pruned after 2 days by app.recruitment_careers_prune (restated).
-- Candidate removal deletes the person's verifications (app.recruitment_destroy_candidate restated).
--
-- What this installs:
--   1. app.recruitment_careers_code, app.recruitment_careers_code_check, app.recruitment_careers_verification (owner-only).
--   2. recruitment_candidate_email.queued_by_user_id may be empty for an application receipt only (the careers receipt).
--   3. The definers above; 5858's app.recruitment_careers_submit restated (byte for byte, its final RETURN also names the
--      application) and its EXECUTE revoked from the app role; app.recruitment_careers_prune and app.recruitment_destroy_candidate
--      restated with added steps only.
--
-- PRECONDITION: applies after 5871.

-- ── 1. Codes, checks and verifications (owner-only) ─────────────────────────────────────────────────────────
CREATE TABLE app.recruitment_careers_code (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 email_digest text NOT NULL CHECK (email_digest ~ '^[0-9a-f]{64}$'),
 code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
 client_hash text NOT NULL CHECK (client_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 wrong_entries integer NOT NULL DEFAULT 0 CHECK (wrong_entries BETWEEN 0 AND 5),
 spent_at timestamptz
);
CREATE INDEX recruitment_careers_code_address_idx ON app.recruitment_careers_code (company_id, email_digest, created_at);
CREATE INDEX recruitment_careers_code_client_idx ON app.recruitment_careers_code (client_hash, created_at);
CREATE INDEX recruitment_careers_code_created_idx ON app.recruitment_careers_code (created_at);
CREATE TABLE app.recruitment_careers_code_check (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 client_hash text NOT NULL CHECK (client_hash ~ '^[0-9a-f]{64}$'),
 checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recruitment_careers_code_check_client_idx ON app.recruitment_careers_code_check (client_hash, checked_at);
CREATE INDEX recruitment_careers_code_check_checked_idx ON app.recruitment_careers_code_check (checked_at);
CREATE TABLE app.recruitment_careers_verification (
 token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
 tenant_id uuid NOT NULL,
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 email_digest text NOT NULL CHECK (email_digest ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 application_id uuid,
 candidate_id uuid,
 CONSTRAINT recruitment_careers_verification_used_ck CHECK (application_id IS NULL OR used_at IS NOT NULL)
);
CREATE INDEX recruitment_careers_verification_created_idx ON app.recruitment_careers_verification (created_at);
CREATE INDEX recruitment_careers_verification_candidate_idx ON app.recruitment_careers_verification (candidate_id) WHERE candidate_id IS NOT NULL;
CREATE INDEX recruitment_careers_verification_application_idx ON app.recruitment_careers_verification (application_id) WHERE application_id IS NOT NULL;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_careers_code','recruitment_careers_code_check','recruitment_careers_verification'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC, ai_hr_app', t);
  EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass)))'
   ' WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass)))',
   t || '_owner', t, 'app.' || t, 'app.' || t);
 END LOOP;
END $$;
--> statement-breakpoint

-- ── 2. A careers receipt has no person behind it ─────────────────────────────────────────────────────────────
ALTER TABLE public.recruitment_candidate_email
 ALTER COLUMN queued_by_user_id DROP NOT NULL,
 ADD CONSTRAINT recruitment_candidate_email_queued_by_ck CHECK (queued_by_user_id IS NOT NULL OR kind = 'application_received');
--> statement-breakpoint

-- ── 3. Shared pieces ─────────────────────────────────────────────────────────────────────────────────────────
-- sha256 of the normalised address (5851's app.recruitment_norm_email), hex. The address itself is never stored here.
CREATE FUNCTION app.recruitment_careers_email_digest(p_email text) RETURNS text
LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp AS $$
 SELECT CASE WHEN app.recruitment_norm_email(p_email) IS NULL THEN NULL
  ELSE encode(sha256(convert_to(app.recruitment_norm_email(p_email), 'UTF8')), 'hex') END;
$$;
REVOKE ALL ON FUNCTION app.recruitment_careers_email_digest(text) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- Whether the company's careers applications need a verified address: its candidate e-mail switch is on (5870). Owner-only; read
-- under 5870's worker context for the company's tenant (the setting's owner policy), opened and closed here.
CREATE FUNCTION app.recruitment_careers_verification_required(p_tenant uuid, p_company uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v boolean;
BEGIN
 INSERT INTO app.recruitment_candidate_email_context (txid, purpose, scope_id) VALUES (txid_current(), 'worker', p_tenant) ON CONFLICT DO NOTHING;
 SELECT coalesce(bool_or(s.enabled AND s.reply_to IS NOT NULL), false) INTO v FROM public.recruitment_candidate_email_setting s
  WHERE s.company_id = p_company AND s.tenant_id = p_tenant;
 DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker' AND scope_id = p_tenant;
 RETURN v;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_careers_verification_required(uuid, uuid) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- The owner reads a company's templates only inside 5870's worker context for its tenant (as it reads the setting): a new owner-only
-- policy on a 5870 table; the app role never satisfies it.
CREATE POLICY recruitment_candidate_email_template_worker_read ON public.recruitment_candidate_email_template FOR SELECT USING (
 current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_candidate_email_template'::regclass))
 AND app.recruitment_email_context_open('worker', tenant_id));
--> statement-breakpoint
-- What the careers server needs to write to an applicant of a public job: the tenant and company (to ask whether this installation
-- can send), whether verification applies, the job title, the company's effective sender name, reply-to and language, its name,
-- and its own wording of the receipt in that language (NULL: the code-owned default). NULL when the page or job is not public.
CREATE FUNCTION app.recruitment_careers_email_context(p_address text, p_job uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET lock_timeout = '3s' AS $$
DECLARE s public.recruitment_careers_site%ROWTYPE; v_title text; r jsonb;
BEGIN
 IF app.current_user_id() IS NOT NULL OR app.current_tenant_id() IS NOT NULL THEN
  RAISE EXCEPTION 'The careers page serves visitors who are not signed in' USING ERRCODE = '42501';
 END IF;
 IF p_job IS NULL THEN RETURN NULL; END IF;
 s := app.recruitment_careers_site_at(p_address);
 IF s.company_id IS NULL THEN RETURN NULL; END IF;
 INSERT INTO app.recruitment_careers_context (txid, company_id, tenant_id) VALUES (txid_current(), s.company_id, s.tenant_id) ON CONFLICT DO NOTHING;
 SELECT j.title INTO v_title FROM public.recruitment_job_opening j
  WHERE j.id = p_job AND j.tenant_id = s.tenant_id AND j.company_id = s.company_id AND j.status = 'open' AND j.show_on_careers_page;
 DELETE FROM app.recruitment_careers_context WHERE txid = txid_current();
 IF v_title IS NULL THEN RETURN NULL; END IF;
 INSERT INTO app.recruitment_candidate_email_context (txid, purpose, scope_id) VALUES (txid_current(), 'worker', s.tenant_id) ON CONFLICT DO NOTHING;
 SELECT jsonb_build_object('tenantId', s.tenant_id, 'companyId', s.company_id, 'jobTitle', v_title, 'companyName', co.legal_name,
   'required', coalesce(st.enabled AND st.reply_to IS NOT NULL, false),
   'senderName', app.recruitment_candidate_email_sender(st.sender_name, co.legal_name), 'replyTo', st.reply_to, 'locale', coalesce(st.locale, 'en'),
   -- The company's own receipt wording in its language; NULL: the code-owned default.
   'receipt', (SELECT jsonb_build_object('subject', t.subject, 'body', t.body) FROM public.recruitment_candidate_email_template t
     WHERE t.company_id = co.id AND t.tenant_id = co.tenant_id AND t.kind = 'application_received' AND t.locale = coalesce(st.locale, 'en')))
  INTO r
  FROM public.company co LEFT JOIN public.recruitment_candidate_email_setting st ON st.company_id = co.id AND st.tenant_id = co.tenant_id
  WHERE co.id = s.company_id AND co.tenant_id = s.tenant_id;
 DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
 RETURN r;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_careers_email_context(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_careers_email_context(text, uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 4. Codes ─────────────────────────────────────────────────────────────────────────────────────────────────
-- Record a code the server is about to send. Status: 'issued' (send it), 'address_limited' (send nothing; the visitor sees the same
-- page), 'client_limited' (429), 'not_required' (the company's candidate e-mail is off: slice 8's form) or 'not_found' (the page or
-- job is not public). Malformed input raises 22023.
CREATE FUNCTION app.recruitment_careers_issue_code(p_address text, p_job uuid, p_client_hash text, p_email text, p_code_hash text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on SET lock_timeout = '3s' AS $$
DECLARE s public.recruitment_careers_site%ROWTYPE; v_digest text := app.recruitment_careers_email_digest(p_email); v_open boolean;
 v_today date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 IF app.current_user_id() IS NOT NULL OR app.current_tenant_id() IS NOT NULL THEN
  RAISE EXCEPTION 'The careers page serves visitors who are not signed in' USING ERRCODE = '42501';
 END IF;
 IF p_job IS NULL OR p_client_hash IS NULL OR p_client_hash !~ '^[0-9a-f]{64}$' OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$'
  OR v_digest IS NULL OR char_length(btrim(p_email)) > 254 THEN
  RAISE EXCEPTION 'A code needs a well-formed address' USING ERRCODE = '22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('recruitment-careers-code-client:' || p_client_hash, 0));
 IF (SELECT count(*) FROM app.recruitment_careers_code c WHERE c.client_hash = p_client_hash AND c.created_at > now() - interval '1 hour') >= 10 THEN
  RETURN jsonb_build_object('status', 'client_limited');
 END IF;
 s := app.recruitment_careers_site_at(p_address);
 IF s.company_id IS NULL THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
 INSERT INTO app.recruitment_careers_context (txid, company_id, tenant_id) VALUES (txid_current(), s.company_id, s.tenant_id) ON CONFLICT DO NOTHING;
 v_open := EXISTS (SELECT 1 FROM public.recruitment_job_opening j
  WHERE j.id = p_job AND j.tenant_id = s.tenant_id AND j.company_id = s.company_id AND j.status = 'open' AND j.show_on_careers_page);
 DELETE FROM app.recruitment_careers_context WHERE txid = txid_current();
 IF NOT v_open THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
 IF NOT app.recruitment_careers_verification_required(s.tenant_id, s.company_id) THEN RETURN jsonb_build_object('status', 'not_required'); END IF;
 -- One address of one company at a time.
 PERFORM pg_advisory_xact_lock(hashtextextended('recruitment-careers-code-address:' || s.company_id::text || ':' || v_digest, 0));
 IF (SELECT count(*) FROM app.recruitment_careers_code c WHERE c.company_id = s.company_id AND c.email_digest = v_digest
     AND c.created_at > now() - interval '1 hour') >= 3
  OR (SELECT count(*) FROM app.recruitment_careers_code c WHERE c.company_id = s.company_id AND c.email_digest = v_digest
     AND c.created_at >= (v_today::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')) >= 10 THEN
  RETURN jsonb_build_object('status', 'address_limited');
 END IF;
 UPDATE app.recruitment_careers_code c SET spent_at = now()
  WHERE c.company_id = s.company_id AND c.job_id = p_job AND c.email_digest = v_digest AND c.spent_at IS NULL;
 INSERT INTO app.recruitment_careers_code (tenant_id, company_id, job_id, email_digest, code_hash, client_hash, expires_at)
  VALUES (s.tenant_id, s.company_id, p_job, v_digest, p_code_hash, p_client_hash, now() + interval '10 minutes');
 RETURN jsonb_build_object('status', 'issued');
END $$;
REVOKE ALL ON FUNCTION app.recruitment_careers_issue_code(text, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_careers_issue_code(text, uuid, text, text, text) TO ai_hr_app;
--> statement-breakpoint
-- Check a code. Status: 'verified' (the token's hash is recorded: valid 30 minutes for this address and job), 'wrong' (one of 5
-- entries used; the fifth spends the code), 'expired' (no live code for this address and job), 'client_limited' (30 checks an hour)
-- or 'not_found'. Every check counts against the client, right or wrong.
CREATE FUNCTION app.recruitment_careers_check_code(p_address text, p_job uuid, p_client_hash text, p_email text, p_code_hash text, p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on SET lock_timeout = '3s' AS $$
DECLARE s public.recruitment_careers_site%ROWTYPE; v_digest text := app.recruitment_careers_email_digest(p_email); c app.recruitment_careers_code%ROWTYPE;
BEGIN
 IF app.current_user_id() IS NOT NULL OR app.current_tenant_id() IS NOT NULL THEN
  RAISE EXCEPTION 'The careers page serves visitors who are not signed in' USING ERRCODE = '42501';
 END IF;
 IF p_job IS NULL OR p_client_hash IS NULL OR p_client_hash !~ '^[0-9a-f]{64}$' OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$'
  OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR v_digest IS NULL THEN
  RAISE EXCEPTION 'A code check needs a well-formed address, code and token' USING ERRCODE = '22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('recruitment-careers-code-client:' || p_client_hash, 0));
 IF (SELECT count(*) FROM app.recruitment_careers_code_check k WHERE k.client_hash = p_client_hash AND k.checked_at > now() - interval '1 hour') >= 30 THEN
  RETURN jsonb_build_object('status', 'client_limited');
 END IF;
 INSERT INTO app.recruitment_careers_code_check (client_hash) VALUES (p_client_hash);
 s := app.recruitment_careers_site_at(p_address);
 IF s.company_id IS NULL THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
 SELECT * INTO c FROM app.recruitment_careers_code x
  WHERE x.company_id = s.company_id AND x.job_id = p_job AND x.email_digest = v_digest AND x.spent_at IS NULL AND x.expires_at > now()
  ORDER BY x.created_at DESC LIMIT 1 FOR UPDATE;
 IF c.id IS NULL THEN RETURN jsonb_build_object('status', 'expired'); END IF;
 IF c.code_hash <> p_code_hash THEN
  UPDATE app.recruitment_careers_code x SET wrong_entries = x.wrong_entries + 1, spent_at = CASE WHEN x.wrong_entries + 1 >= 5 THEN now() END
   WHERE x.id = c.id;
  RETURN jsonb_build_object('status', 'wrong');
 END IF;
 UPDATE app.recruitment_careers_code x SET spent_at = now() WHERE x.id = c.id;
 INSERT INTO app.recruitment_careers_verification (token_hash, tenant_id, company_id, job_id, email_digest, expires_at)
  VALUES (p_token_hash, s.tenant_id, s.company_id, p_job, v_digest, now() + interval '30 minutes');
 RETURN jsonb_build_object('status', 'verified');
END $$;
REVOKE ALL ON FUNCTION app.recruitment_careers_check_code(text, uuid, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_careers_check_code(text, uuid, text, text, text, text) TO ai_hr_app;
--> statement-breakpoint

-- ── 5. Applying ──────────────────────────────────────────────────────────────────────────────────────────────
-- The careers submission the app role may call. While the company's candidate e-mail is on: an unused, unexpired verification of
-- THIS address for THIS job (by its token's hash) is required ('unverified' otherwise, nothing stored) and is consumed by this call
-- whatever the submission's outcome; then 5858's submission decides everything else. The result is 5858's, with `verified` and,
-- for a stored application, its id (the server queues the receipt with it in the next call).
CREATE FUNCTION app.recruitment_careers_apply(p_token_hash text, p_address text, p_job uuid, p_client_hash text, p_full_name text, p_email text,
 p_mobile text, p_message text, p_notice_version integer, p_honeypot boolean,
 p_file_name text DEFAULT NULL, p_file_mime text DEFAULT NULL, p_file_content bytea DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on SET lock_timeout = '3s' AS $$
DECLARE s public.recruitment_careers_site%ROWTYPE; v app.recruitment_careers_verification%ROWTYPE; r jsonb; v_required boolean := false;
BEGIN
 IF app.current_user_id() IS NOT NULL OR app.current_tenant_id() IS NOT NULL THEN
  RAISE EXCEPTION 'The careers page takes applications only from visitors who are not signed in' USING ERRCODE = '42501';
 END IF;
 s := app.recruitment_careers_site_at(p_address);
 IF s.company_id IS NOT NULL THEN v_required := app.recruitment_careers_verification_required(s.tenant_id, s.company_id); END IF;
 IF v_required THEN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RETURN jsonb_build_object('status', 'unverified'); END IF;
  SELECT * INTO v FROM app.recruitment_careers_verification x
   WHERE x.token_hash = p_token_hash AND x.company_id = s.company_id AND x.job_id = p_job AND x.used_at IS NULL AND x.expires_at > now()
    AND x.email_digest = app.recruitment_careers_email_digest(p_email)
   FOR UPDATE;
  IF v.token_hash IS NULL THEN RETURN jsonb_build_object('status', 'unverified'); END IF;
  UPDATE app.recruitment_careers_verification x SET used_at = now() WHERE x.token_hash = v.token_hash;
 END IF;
 r := app.recruitment_careers_submit(p_address, p_job, p_client_hash, p_full_name, p_email, p_mobile, p_message, p_notice_version, p_honeypot,
  p_file_name, p_file_mime, p_file_content);
 IF v_required AND r->>'status' = 'received' AND r ? 'applicationId' THEN
  UPDATE app.recruitment_careers_verification x SET application_id = (r->>'applicationId')::uuid, candidate_id = (r->>'candidateId')::uuid
   WHERE x.token_hash = v.token_hash;
 END IF;
 -- A stored application is named only when it came from a verification (it is then the receipt's key); never otherwise.
 RETURN CASE WHEN v_required THEN r - 'candidateId' || jsonb_build_object('verified', true)
  ELSE (r - 'applicationId' - 'candidateId') || jsonb_build_object('verified', false) END;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_careers_apply(text, text, uuid, text, text, text, text, text, integer, boolean, text, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_careers_apply(text, text, uuid, text, text, text, text, text, integer, boolean, text, text, bytea) TO ai_hr_app;
--> statement-breakpoint
-- The careers receipt of an application created in the last 10 minutes from a verification (by its token's hash), to the
-- candidate's recorded address, with the company's CURRENT sender name, reply-to and language (frozen as 5870 freezes them) and the
-- subject, text and HTML the server rendered with 5870's renderer (5870's CHECKs hold them to the renderer's grammar and no links).
-- Status: 'queued', 'skipped' (the company's candidate e-mail is off now, the candidate was removed or has no address, or the
-- verification does not name this application) or 'limited' (5870's hourly cap). At most one per application (5870's key).
CREATE FUNCTION app.recruitment_careers_queue_receipt(p_token_hash text, p_application uuid, p_subject text, p_text text, p_html text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on SET lock_timeout = '3s' AS $$
DECLARE v app.recruitment_careers_verification%ROWTYPE; a record; v_email text; v_sender text; v_reply text; v_locale text; v_id uuid;
BEGIN
 IF app.current_user_id() IS NOT NULL OR app.current_tenant_id() IS NOT NULL THEN
  RAISE EXCEPTION 'The careers page serves visitors who are not signed in' USING ERRCODE = '42501';
 END IF;
 IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_application IS NULL THEN
  RAISE EXCEPTION 'A careers receipt needs a verification and an application' USING ERRCODE = '22023';
 END IF;
 SELECT * INTO v FROM app.recruitment_careers_verification x
  WHERE x.token_hash = p_token_hash AND x.application_id = p_application AND x.used_at > now() - interval '10 minutes';
 IF v.token_hash IS NULL THEN RETURN jsonb_build_object('status', 'skipped'); END IF;
 INSERT INTO app.recruitment_candidate_email_context (txid, purpose, scope_id) VALUES (txid_current(), 'worker', v.tenant_id) ON CONFLICT DO NOTHING;
 SELECT ap.id, ap.job_id, ap.company_id, ap.candidate_id INTO a FROM public.recruitment_application ap
  WHERE ap.id = p_application AND ap.tenant_id = v.tenant_id AND ap.company_id = v.company_id AND ap.job_id = v.job_id AND ap.candidate_id = v.candidate_id;
 SELECT c.email INTO v_email FROM public.recruitment_candidate c
  WHERE c.id = v.candidate_id AND c.tenant_id = v.tenant_id AND c.destroyed_at IS NULL AND app.recruitment_careers_email_digest(c.email) = v.email_digest;
 SELECT app.recruitment_candidate_email_sender(st.sender_name, co.legal_name), st.reply_to, st.locale INTO v_sender, v_reply, v_locale
  FROM public.recruitment_candidate_email_setting st JOIN public.company co ON co.id = st.company_id AND co.tenant_id = st.tenant_id
  WHERE st.company_id = v.company_id AND st.tenant_id = v.tenant_id AND st.enabled AND st.reply_to IS NOT NULL;
 IF a.id IS NULL OR v_email IS NULL OR v_sender IS NULL OR v_sender = '' THEN
  DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
  RETURN jsonb_build_object('status', 'skipped');
 END IF;
 DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
 IF app.recruitment_candidate_email_hour_count_owner(v.tenant_id, v.company_id) >= 500 THEN
  RETURN jsonb_build_object('status', 'limited');
 END IF;
 INSERT INTO app.recruitment_candidate_email_context (txid, purpose, scope_id) VALUES (txid_current(), 'worker', v.tenant_id) ON CONFLICT DO NOTHING;
 INSERT INTO public.recruitment_candidate_email (tenant_id, company_id, job_id, application_id, candidate_id, kind, locale, recipient, subject, body_text,
   body_html, sender_name, reply_to, queued_by_user_id)
  VALUES (v.tenant_id, v.company_id, a.job_id, a.id, a.candidate_id, 'application_received', v_locale, v_email, p_subject, p_text, p_html,
   v_sender, v_reply, NULL)
  ON CONFLICT DO NOTHING RETURNING id INTO v_id;
 DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
 IF v_id IS NULL THEN RETURN jsonb_build_object('status', 'skipped'); END IF;
 INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
  VALUES (v.tenant_id, 'recruitment-application', a.id, 'recruitment-candidate-email.queued', 'external', NULL,
   jsonb_build_object('companyId', v.company_id, 'emailId', v_id, 'kind', 'application_received', 'via', 'careers_page'));
 RETURN jsonb_build_object('status', 'queued');
END $$;
REVOKE ALL ON FUNCTION app.recruitment_careers_queue_receipt(text, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_careers_queue_receipt(text, uuid, text, text, text) TO ai_hr_app;
--> statement-breakpoint

-- ── 6. 5858's submission, byte for byte, with the new application and candidate named in its result; no longer granted ─────
-- to the app role (app.recruitment_careers_apply, above, calls it as the owner).
CREATE OR REPLACE FUNCTION app.recruitment_careers_submit(p_address text, p_job uuid, p_client_hash text, p_full_name text, p_email text,
 p_mobile text, p_message text, p_notice_version integer, p_honeypot boolean,
 p_file_name text DEFAULT NULL, p_file_mime text DEFAULT NULL, p_file_content bytea DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on SET lock_timeout = '3s' AS $$
DECLARE
 v_name text := nullif(btrim(coalesce(p_full_name, '')), '');
 v_email_text text := nullif(btrim(coalesce(p_email, '')), '');
 v_email text := app.recruitment_norm_email(p_email);
 v_mobile_text text := nullif(btrim(coalesce(p_mobile, '')), '');
 v_mobile text := app.recruitment_norm_mobile(p_mobile);
 v_message text := nullif(btrim(coalesce(p_message, '')), '');
 v_today date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
 s public.recruitment_careers_site%ROWTYPE; j public.recruitment_job_opening%ROWTYPE;
 v_attempts integer; v_accepted integer; v_attempt uuid; v_stage uuid; v_months integer; v_candidate uuid; v_application uuid; v_matches integer;
 v_current integer;
BEGIN
 IF app.current_user_id() IS NOT NULL OR app.current_tenant_id() IS NOT NULL THEN
  RAISE EXCEPTION 'The careers page takes applications only from visitors who are not signed in' USING ERRCODE = '42501';
 END IF;
 IF p_client_hash IS NULL OR p_client_hash !~ '^[0-9a-f]{64}$' OR p_job IS NULL OR p_honeypot IS NULL
  OR v_name IS NULL OR char_length(v_name) > 120 OR v_name ~ '[\x01-\x1f\x7f-\x9f]'
  OR v_email_text IS NULL OR char_length(v_email_text) > 254 OR v_email_text !~ '^[^[:space:]@]+@[^[:space:]@.]+(\.[^[:space:]@.]+)+$'
  OR v_email_text ~ '[\x01-\x1f\x7f-\x9f]'
  OR (v_mobile_text IS NOT NULL AND (char_length(v_mobile_text) > 40 OR v_mobile_text !~ '^[0-9 +()-]+$' OR v_mobile IS NULL
   OR char_length(v_mobile) NOT BETWEEN 7 AND 20))
  OR (v_message IS NOT NULL AND (char_length(v_message) > 1000 OR v_message ~ '[\x01-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]'))
  OR p_notice_version IS NULL
  OR (p_file_content IS NOT NULL AND (nullif(btrim(coalesce(p_file_name, '')), '') IS NULL OR char_length(btrim(p_file_name)) > 200
   OR p_file_name ~ '[\x01-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069/\\]'
   OR p_file_mime IS NULL OR octet_length(p_file_content) NOT BETWEEN 1 AND 10485760
   OR p_file_mime NOT IN ('application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/jpeg','image/png'))) THEN
  RAISE EXCEPTION 'A careers application needs a name, a valid e-mail and well-formed optional details' USING ERRCODE = '22023';
 END IF;

 -- One client hash at a time; then the per-client limit (refused submissions above it are not recorded).
 PERFORM pg_advisory_xact_lock(hashtextextended('recruitment-careers-client:' || p_client_hash, 0));
 DELETE FROM app.recruitment_careers_attempt WHERE attempted_at < now() - interval '2 days';
 SELECT count(*)::integer INTO v_attempts FROM app.recruitment_careers_attempt a
  WHERE a.client_hash = p_client_hash AND a.attempted_at > now() - interval '1 hour';
 IF v_attempts >= 5 THEN
  RETURN jsonb_build_object('status', 'rate_limited');
 END IF;

 s := app.recruitment_careers_site_at(p_address);
 IF s.company_id IS NULL THEN
  INSERT INTO app.recruitment_careers_attempt (client_hash) VALUES (p_client_hash);
  RETURN jsonb_build_object('status', 'not_found');
 END IF;
 INSERT INTO app.recruitment_careers_context (txid, company_id, tenant_id) VALUES (txid_current(), s.company_id, s.tenant_id) ON CONFLICT DO NOTHING;
 INSERT INTO app.recruitment_careers_attempt (client_hash, tenant_id, company_id) VALUES (p_client_hash, s.tenant_id, s.company_id)
  RETURNING id INTO v_attempt;
 -- The job, locked FOR SHARE: a concurrent close or switch-off waits for this submission (or this one sees it).
 SELECT * INTO j FROM public.recruitment_job_opening
  WHERE id = p_job AND tenant_id = s.tenant_id AND company_id = s.company_id AND status = 'open' AND show_on_careers_page FOR SHARE;
 IF FOUND THEN
  SELECT ps.stage_id INTO v_stage FROM public.recruitment_process_stage ps
   JOIN public.recruitment_stage st ON st.id = ps.stage_id AND st.tenant_id = ps.tenant_id
   WHERE ps.process_id = j.process_id AND ps.tenant_id = s.tenant_id AND st.enabled ORDER BY ps.position LIMIT 1;
 END IF;
 v_current := (SELECT max(n.version) FROM public.recruitment_careers_notice n WHERE n.company_id = s.company_id AND n.tenant_id = s.tenant_id);
 IF j.id IS NULL OR v_stage IS NULL OR v_current IS NULL THEN
  DELETE FROM app.recruitment_careers_context WHERE txid = txid_current();
  RETURN jsonb_build_object('status', 'not_found');
 END IF;
 -- Consent counts only for the notice the page shows now.
 IF p_notice_version <> v_current THEN
  DELETE FROM app.recruitment_careers_context WHERE txid = txid_current();
  RETURN jsonb_build_object('status', 'notice_changed');
 END IF;

 -- The company's daily ceiling, counted on stored submissions within today's Kuala Lumpur date (an index range on the
 -- instant, 00:00 to 24:00 in Kuala Lumpur). One submission per company at a time decides it.
 PERFORM pg_advisory_xact_lock(hashtextextended('recruitment-careers-company:' || s.tenant_id::text || ':' || s.company_id::text, 0));
 SELECT count(*)::integer INTO v_accepted FROM app.recruitment_careers_attempt a
  WHERE a.company_id = s.company_id AND a.accepted
   AND a.attempted_at >= (v_today::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur') AND a.attempted_at < ((v_today + 1)::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur');
 IF v_accepted >= 300 THEN
  DELETE FROM app.recruitment_careers_context WHERE txid = txid_current();
  RETURN jsonb_build_object('status', 'company_limit');
 END IF;

 IF p_honeypot THEN
  DELETE FROM app.recruitment_careers_context WHERE txid = txid_current();
  INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
   VALUES (s.tenant_id, 'recruitment-job', j.id, 'recruitment-careers.application-not-stored', 'external', NULL,
    jsonb_build_object('companyId', s.company_id, 'jobId', j.id, 'reason', 'honeypot'));
  RETURN jsonb_build_object('status', 'received');
 END IF;

 -- Company + normalised e-mail, the same key 4407's referrals take: a careers application, a referral and a second
 -- careers application of the same person serialise, so two identical submissions store exactly one.
 PERFORM pg_advisory_xact_lock(hashtextextended('recruitment-referral:' || s.tenant_id::text || ':' || s.company_id::text || ':email:' || v_email, 0));
 -- Slice 5's repeated-application rule on the normalised e-mail: an application to this job that is active, or closed
 -- within the company's window (Kuala Lumpur calendar months, month-end clamped; 0 switches the closed part off).
 v_months := coalesce((SELECT cs.repeat_window_months FROM public.recruitment_company_setting cs
  WHERE cs.company_id = s.company_id AND cs.tenant_id = s.tenant_id), 3);
 IF EXISTS (SELECT 1 FROM public.recruitment_candidate c JOIN public.recruitment_application a ON a.candidate_id = c.id AND a.tenant_id = c.tenant_id
   WHERE c.tenant_id = s.tenant_id AND c.company_id = s.company_id AND c.email IS NOT NULL AND app.recruitment_norm_email(c.email) = v_email
    AND c.destroyed_at IS NULL AND a.job_id = j.id
    AND (a.state = 'active' OR (v_months > 0
     AND ((a.state_changed_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date + make_interval(months => v_months))::date > v_today))) THEN
  DELETE FROM app.recruitment_careers_context WHERE txid = txid_current();
  INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
   VALUES (s.tenant_id, 'recruitment-job', j.id, 'recruitment-careers.application-not-stored', 'external', NULL,
    jsonb_build_object('companyId', s.company_id, 'jobId', j.id, 'reason', 'repeated_application'));
  RETURN jsonb_build_object('status', 'received');
 END IF;

 -- Always a NEW candidate: an unverified e-mail never writes into an existing record (D-026).
 v_candidate := gen_random_uuid();
 INSERT INTO public.recruitment_candidate (id, tenant_id, company_id, full_name, email, phone, source, created_by_user_id, updated_by_user_id)
  VALUES (v_candidate, s.tenant_id, s.company_id, v_name, translate(v_email_text, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),
   v_mobile_text, 'career_page', NULL, NULL);
 INSERT INTO public.recruitment_application (tenant_id, company_id, job_id, candidate_id, current_stage_id, source, created_by_user_id, updated_by_user_id)
  VALUES (s.tenant_id, s.company_id, j.id, v_candidate, v_stage, 'career_page', NULL, NULL) RETURNING id INTO v_application;
 INSERT INTO public.recruitment_application_event (tenant_id, company_id, application_id, kind, to_stage_id, to_state, actor_user_id)
  VALUES (s.tenant_id, s.company_id, v_application, 'applied', v_stage, 'active', NULL);
 INSERT INTO public.recruitment_careers_application (application_id, tenant_id, company_id, job_id, candidate_id, message)
  VALUES (v_application, s.tenant_id, s.company_id, j.id, v_candidate, v_message);
 IF p_file_content IS NOT NULL THEN
  -- The applicant uploads their own resume: the permission confirmation is theirs.
  INSERT INTO public.recruitment_candidate_file (tenant_id, company_id, candidate_id, kind, file_name, mime_type, size_bytes, content,
   permission_confirmed, uploaded_by_user_id)
   VALUES (s.tenant_id, s.company_id, v_candidate, 'resume', btrim(p_file_name), p_file_mime, octet_length(p_file_content), p_file_content, true, NULL);
 END IF;
 INSERT INTO public.recruitment_candidate_consent (tenant_id, company_id, candidate_id, status, effective_on, method, notice_reference,
  careers_notice_version, recorded_by_user_id)
  VALUES (s.tenant_id, s.company_id, v_candidate, 'consented', v_today, 'online_form', 'Careers page notice version ' || p_notice_version,
   p_notice_version, NULL);
 -- Slice 5's duplicate rule, as for every new application: two of name, e-mail and mobile against the company's other
 -- live candidates. A match is flagged for HR (a count only); nothing is attached.
 SELECT count(*)::integer INTO v_matches FROM (
  SELECT h.candidate_id FROM (
    SELECT c.id AS candidate_id, 'email'::text AS kind FROM public.recruitment_candidate c
     WHERE c.tenant_id = s.tenant_id AND c.company_id = s.company_id AND c.email IS NOT NULL AND app.recruitment_norm_email(c.email) = v_email
    UNION ALL
    SELECT c.id, 'name' FROM public.recruitment_candidate c
     WHERE c.tenant_id = s.tenant_id AND c.company_id = s.company_id AND app.recruitment_norm_name(c.full_name) = app.recruitment_norm_name(v_name)
    UNION ALL
    SELECT c.id, 'mobile' FROM public.recruitment_candidate c
     WHERE v_mobile IS NOT NULL AND c.tenant_id = s.tenant_id AND c.company_id = s.company_id AND c.phone IS NOT NULL
      AND app.recruitment_norm_mobile(c.phone) = v_mobile
   ) h
   JOIN public.recruitment_candidate x ON x.id = h.candidate_id AND x.destroyed_at IS NULL AND x.id <> v_candidate
   GROUP BY h.candidate_id HAVING count(DISTINCT h.kind) >= 2) matched;
 UPDATE app.recruitment_careers_attempt SET accepted = true WHERE id = v_attempt;
 DELETE FROM app.recruitment_careers_context WHERE txid = txid_current();
 IF v_matches > 0 THEN
  INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
   VALUES (s.tenant_id, 'recruitment-job', j.id, 'recruitment-candidate.duplicate-flagged', 'external', NULL,
    jsonb_build_object('companyId', s.company_id, 'jobId', j.id, 'matches', v_matches, 'via', 'careers_page'));
 END IF;
 INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
  VALUES (s.tenant_id, 'recruitment-application', v_application, 'recruitment-careers.application-received', 'external', NULL,
   jsonb_build_object('companyId', s.company_id, 'jobId', j.id, 'candidateId', v_candidate, 'resume', p_file_content IS NOT NULL,
    'noticeVersion', p_notice_version));
 RETURN jsonb_build_object('status', 'received', 'applicationId', v_application, 'candidateId', v_candidate);
END $$;
REVOKE ALL ON FUNCTION app.recruitment_careers_submit(text, uuid, text, text, text, text, text, integer, boolean, text, text, bytea) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- ── 7. 5858's prune plus the slice 21a tables ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app.recruitment_careers_prune() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp SET lock_timeout = '10s' AS $$
DECLARE n integer; m integer;
BEGIN
 DELETE FROM app.recruitment_careers_attempt WHERE attempted_at < now() - interval '2 days';
 GET DIAGNOSTICS n = ROW_COUNT;
 -- Slice 21a: codes, checks and verifications go after two days as well (counted with the attempts).
 DELETE FROM app.recruitment_careers_code WHERE created_at < now() - interval '2 days';
 GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
 DELETE FROM app.recruitment_careers_code_check WHERE checked_at < now() - interval '2 days';
 GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
 DELETE FROM app.recruitment_careers_verification WHERE created_at < now() - interval '2 days';
 GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_careers_prune() FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- ── 8. Removal: 5870's app.recruitment_destroy_candidate, byte for byte, plus the person's careers verifications ─────────
CREATE OR REPLACE FUNCTION app.recruitment_destroy_candidate(p_candidate uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
DECLARE c public.recruitment_candidate%ROWTYPE; v_apps uuid[]; v_offers uuid[]; n integer; result jsonb := '{}'::jsonb;
BEGIN
 IF p_candidate IS NULL OR app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL THEN
  RAISE EXCEPTION 'Removing a candidate''s personal data needs a recruitment administrator' USING ERRCODE = '42501';
 END IF;
 -- Before anything else: no concurrent write to this candidate's record may interleave with the removal.
 PERFORM pg_advisory_xact_lock(app.recruitment_candidate_lock_key(app.current_tenant_id(), p_candidate));
 SELECT * INTO c FROM public.recruitment_candidate WHERE id = p_candidate AND tenant_id = app.current_tenant_id() FOR UPDATE;
 IF NOT FOUND OR NOT app.can_admin_recruitment_for(c.company_id) THEN
  RAISE EXCEPTION 'Removing a candidate''s personal data needs a recruitment administrator' USING ERRCODE = '42501';
 END IF;
 IF c.destroyed_at IS NOT NULL THEN
  RAISE EXCEPTION 'This candidate''s personal data has already been removed' USING ERRCODE = '23514';
 END IF;
 SELECT coalesce(array_agg(a.id), '{}') INTO v_apps FROM public.recruitment_application a WHERE a.candidate_id = c.id AND a.tenant_id = c.tenant_id;
 IF EXISTS (SELECT 1 FROM public.recruitment_application a WHERE a.id = ANY (v_apps) AND a.state IN ('active','hired')) THEN
  RAISE EXCEPTION 'A candidate with an active or hired application keeps their record' USING ERRCODE = '23514';
 END IF;
 -- Slice 13: for a person with a blocked-list entry only (stable here: this removal holds the candidate's lock exclusively and
 -- adding an entry needs it), the company's blocked-list lock (after the candidate's: candidate, then company — the order
 -- every writer here takes), so matching never marks against an entry this removal is deleting, and this removal sees every
 -- mark committed before it. A listed person whose entry still holds an open mark on ANOTHER candidate's active application
 -- keeps their record until an administrator resolves that mark (no hold is lifted without a decision).
 IF EXISTS (SELECT 1 FROM public.recruitment_blocked_entry e WHERE e.candidate_id = c.id AND e.tenant_id = c.tenant_id) THEN
  PERFORM pg_advisory_xact_lock(app.recruitment_blocked_lock_key(c.tenant_id, c.company_id));
  IF EXISTS (SELECT 1 FROM public.recruitment_blocked_entry e
    JOIN public.recruitment_application_review_mark m ON m.entry_id = e.id AND m.cleared_at IS NULL AND m.candidate_id <> c.id
    JOIN public.recruitment_application a ON a.id = m.application_id AND a.state = 'active'
    WHERE e.candidate_id = c.id AND e.tenant_id = c.tenant_id) THEN
   RAISE EXCEPTION 'Resolve the reviews this person''s blocked-list entry holds on other candidates first' USING ERRCODE = '23514',
    CONSTRAINT = 'recruitment_blocked_entry_has_open_marks';
  END IF;
 END IF;
 SELECT coalesce(array_agg(o.id), '{}') INTO v_offers FROM public.recruitment_offer o WHERE o.application_id = ANY (v_apps) AND o.tenant_id = c.tenant_id;
 INSERT INTO app.recruitment_destroy_marker (txid, candidate_id, tenant_id) VALUES (txid_current(), c.id, c.tenant_id);

 -- Slice 10: agency submissions about this person lose their personal data — the one accepted onto this candidate, and those
 -- no candidate links (refused, rejected or still waiting) whose ONLY recorded match is this candidate as a Duplicate (the
 -- same ID number, or the same name with the same e-mail or mobile); one still waiting is closed as rejected. A submission
 -- that matched this candidate only as Suspected, or matched others too, is about someone else: it only loses its link.
 -- Indexed lookups only (by candidate, and the link table by candidate). Each row keeps job, contract, consultant, dates.
 UPDATE public.recruitment_agency_submission s SET full_name = NULL, email = NULL, mobile = NULL, id_type = NULL, id_number = NULL,
  current_salary_amount = NULL, current_salary_currency = NULL, expected_salary_amount = NULL, expected_salary_currency = NULL, comments = NULL,
  review_reason = NULL, resume_name = NULL, resume_mime = NULL, resume_size = NULL, resume_content = NULL, personal_data_removed_at = now()
  WHERE s.candidate_id = c.id AND s.tenant_id = c.tenant_id AND s.personal_data_removed_at IS NULL;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('agencySubmissions', n);
 UPDATE public.recruitment_agency_submission s SET full_name = NULL, email = NULL, mobile = NULL, id_type = NULL, id_number = NULL,
  current_salary_amount = NULL, current_salary_currency = NULL, expected_salary_amount = NULL, expected_salary_currency = NULL, comments = NULL,
  review_reason = NULL, resume_name = NULL, resume_mime = NULL, resume_size = NULL, resume_content = NULL,
  outcome = CASE WHEN s.outcome = 'waiting' THEN 'rejected' ELSE s.outcome END, personal_data_removed_at = now()
  WHERE s.id IN (SELECT m.submission_id FROM app.recruitment_agency_submission_match m
    WHERE m.candidate_id = c.id AND m.tenant_id = c.tenant_id AND m.duplicate
     AND NOT EXISTS (SELECT 1 FROM app.recruitment_agency_submission_match o WHERE o.submission_id = m.submission_id AND o.candidate_id <> c.id))
   AND s.candidate_id IS NULL AND s.personal_data_removed_at IS NULL
   -- Two ID numbers that differ are two people, however alike name and contacts are: only the link goes.
   AND NOT EXISTS (SELECT 1 FROM public.recruitment_candidate_restricted r WHERE r.candidate_id = c.id AND r.tenant_id = c.tenant_id
    AND r.id_number IS NOT NULL AND s.id_number IS NOT NULL AND app.recruitment_norm_id(r.id_number) <> app.recruitment_norm_id(s.id_number));
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('agencyMatchedSubmissions', n);
 DELETE FROM app.recruitment_agency_submission_match WHERE candidate_id = c.id;
 DELETE FROM public.recruitment_candidate_file WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('files', n);
 DELETE FROM public.recruitment_candidate_restricted WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('restricted', n);
 DELETE FROM public.recruitment_candidate_entry WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('entries', n);
 DELETE FROM public.recruitment_candidate_tag WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('tags', n);
 DELETE FROM public.recruitment_candidate_consent WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('consents', n);
 -- Feedback: the 1–5 ratings stay (they carry no personal data); every note and the overview go.
 UPDATE public.recruitment_scorecard s SET overview = NULL,
  ratings = (SELECT coalesce(jsonb_object_agg(e.key, CASE WHEN jsonb_typeof(e.value) = 'object' THEN e.value - 'notes' ELSE e.value END), '{}'::jsonb)
   FROM jsonb_each(s.ratings) e)
  WHERE s.application_id = ANY (v_apps) AND s.tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('scorecards', n);
 -- Offers: values and rejection comments go; the offer skeleton (status, rounds, decision) stays.
 DELETE FROM public.recruitment_offer_value WHERE offer_id = ANY (v_offers) AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('offerValues', n);
 UPDATE public.recruitment_offer SET last_rejection_comment = NULL
  WHERE id = ANY (v_offers) AND tenant_id = c.tenant_id AND last_rejection_comment IS NOT NULL;
 UPDATE public.recruitment_offer_approval SET comment = CASE WHEN decision = 'rejected' THEN '—' ELSE NULL END
  WHERE offer_id = ANY (v_offers) AND tenant_id = c.tenant_id AND comment IS NOT NULL;
 -- The application keeps its skeleton; a free-text source (it may name a referrer) goes.
 UPDATE public.recruitment_application SET source = NULL WHERE id = ANY (v_apps) AND source IS NOT NULL;
 -- Slice 7: a referral keeps its job, date and referrer; the referrer's reason (it describes the candidate) goes.
 UPDATE public.recruitment_referral SET reason = NULL WHERE candidate_id = c.id AND tenant_id = c.tenant_id AND reason IS NOT NULL;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('referrals', n);
 -- Slice 8: a careers application keeps its job and date; the applicant's message goes.
 UPDATE public.recruitment_careers_application SET message = NULL WHERE candidate_id = c.id AND tenant_id = c.tenant_id AND message IS NOT NULL;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('careersMessages', n);
 -- Slice 11: screening notes and feedback comments go (they describe the candidate); each request keeps its reviewer, sender,
 -- times and closing, and each answer its result, reviewer and time. Indexed by application.
 UPDATE public.recruitment_screening_request SET note = NULL WHERE application_id = ANY (v_apps) AND tenant_id = c.tenant_id AND note IS NOT NULL;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('screeningNotes', n);
 UPDATE public.recruitment_screening_answer SET comment = NULL WHERE application_id = ANY (v_apps) AND tenant_id = c.tenant_id AND comment IS NOT NULL;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('screeningComments', n);
 -- Slice 12: the person's OPEN background checks are cancelled by the system (a fixed code, so they no longer show as open
 -- or count as the recorder's to-dos); every check keeps its types, status, outcome and dates; the restricted details
 -- (provider, reference, authorisation, summary, cancellation reason) and every file (authorisation and report) go. Indexed
 -- by application.
 UPDATE public.recruitment_background_check SET status = 'cancelled', system_cancel_reason = 'candidate_removed',
  status_changed_by_user_id = app.current_user_id()
  WHERE application_id = ANY (v_apps) AND tenant_id = c.tenant_id AND status IN ('awaiting_authorisation','in_progress');
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('backgroundChecksCancelled', n);
 DELETE FROM public.recruitment_background_check_file WHERE application_id = ANY (v_apps) AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('backgroundCheckFiles', n);
 DELETE FROM public.recruitment_background_check_detail WHERE application_id = ANY (v_apps) AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('backgroundCheckDetails', n);
 -- Slice 13: the person's pool memberships go (the remover administers the company, so the ordinary membership policy admits
 -- the delete). Their blocked-list entries go with the restricted values (reason, removal reason, identity values), the
 -- history, and every mark those entries made on anyone's application (such a mark has no basis once its entry is gone;
 -- marker-bound owner policies). A mark that SOMEONE ELSE's entry made on this person's applications stays (ids only).
 -- Indexed by candidate and by entry.
 DELETE FROM public.recruitment_talent_pool_member WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('poolMemberships', n);
 DELETE FROM public.recruitment_application_review_mark WHERE entry_id IN (SELECT e.id FROM public.recruitment_blocked_entry e
  WHERE e.candidate_id = c.id AND e.tenant_id = c.tenant_id) AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('blockedMarks', n);
 DELETE FROM public.recruitment_blocked_history WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 DELETE FROM public.recruitment_blocked_entry_restricted WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 DELETE FROM public.recruitment_blocked_entry WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('blockedEntries', n);
 -- Slice 14: every custom value of the person goes, open and restricted (typed values of company-defined fields; the
 -- definitions are company setup and stay). Indexed by candidate. Marker-bound owner policies (and the remover administers
 -- the company).
 DELETE FROM public.recruitment_candidate_custom_value WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('customValues', n);
 DELETE FROM public.recruitment_candidate_custom_restricted WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('customRestrictedValues', n);
 -- Slice 16: the person's To assign marker (it holds the job title as written in their import file) and their import note go.
 -- Their import rows stay with ids, outcomes and codes only (no personal data). Indexed by candidate. Marker-bound owner policies.
 DELETE FROM public.recruitment_to_assign WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('toAssign', n);
 DELETE FROM public.recruitment_candidate_import_note WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('importNotes', n);
 -- Slice 19: the person's candidate e-mails go — queued, sent or failed, with their frozen address and content and the metadata (a
 -- queued, unsent rejection is withdrawn by this). Indexed by candidate. Marker-bound owner policies.
 DELETE FROM public.recruitment_candidate_email WHERE candidate_id = c.id AND tenant_id = c.tenant_id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('candidateEmails', n);
 -- Slice 21a: the person's careers verifications (a hash of their address and the application they made) go. Indexed by candidate.
 -- Owner-only table: this definer is its owner.
 DELETE FROM app.recruitment_careers_verification WHERE candidate_id = c.id;
 GET DIAGNOSTICS n = ROW_COUNT; result := result || jsonb_build_object('careersVerifications', n);
 UPDATE public.recruitment_candidate SET
  full_name = 'Removed candidate ' || upper(substr(replace(c.id::text, '-', ''), 1, 8)), email = NULL, phone = NULL, location = NULL,
  current_company = NULL, current_title = NULL, highest_education = NULL, notice_period = NULL, source = NULL,
  destroyed_at = now(), destroyed_by_user_id = app.current_user_id(), updated_at = now(), updated_by_user_id = app.current_user_id()
  WHERE id = c.id;
 DELETE FROM app.recruitment_destroy_marker WHERE txid = txid_current() AND candidate_id = c.id;
 RETURN result || jsonb_build_object('applications', cardinality(v_apps), 'offers', cardinality(v_offers));
END $$;
REVOKE ALL ON FUNCTION app.recruitment_destroy_candidate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_destroy_candidate(uuid) TO ai_hr_app;
