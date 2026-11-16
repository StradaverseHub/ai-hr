-- Recruitment slice 25 (docs/recruitment-reconstruction/specification.md "Slice 25"; D-036, D-063, D-070): the agency portal.
--
-- The owner decided (D-063) that agencies get a portal last, reusing the applicant verification design (slice 21a): no accounts.
-- An agency consultant (slice 10's contact record) signs in on the company's careers address with a one-time code sent to the
-- consultant's recorded e-mail, sees the jobs released to their contracts, submits candidates and follows a coarse status of
-- their own submissions. A portal submission is NOT a slice 10 submission: it waits in HR's inbox, and the job's recruiter,
-- assistants or an administrator records it through slice 10's own path (duplicates, protection, repeats, the daily cap) or
-- declines it. Nothing here creates a candidate or an application.
--
-- Who (anonymous on the careers pool, through definers; a call inside a signed-in session is refused):
--   issue a code    — app.recruitment_agency_portal_issue_code: for a published careers address whose company has the portal on
--                     and can send candidate e-mail (5720's switch); 10 codes an hour per client hash; 3 an hour and 10 a Kuala
--                     Lumpur day per company and address. A code is issued only for an address of an Active consultant on a
--                     contract usable today; the visitor's page is the same either way.
--   check a code    — app.recruitment_agency_portal_check_code: 30 checks an hour per client hash; 10 minutes; 5 wrong entries;
--                     a right one opens a session (a token's keyed hash) for 8 hours.
--   the portal      — app.recruitment_agency_portal_view: the company, the consultant's contracts, their open jobs and the
--                     consultant's submissions with a coarse status; refreshes nothing, but ends the session when no Active
--                     consultant with this address remains on a usable contract.
--   submit          — app.recruitment_agency_portal_submit: into the inbox; 20 a Kuala Lumpur day per company and address,
--                     30 an hour per client hash; the same person (normalised e-mail or mobile) waiting for the same job from
--                     the same contract is refused.
--   sign out        — app.recruitment_agency_portal_sign_out.
-- HR (the app role under row security): the job's operators read the inbox and decide a waiting row once: 'recorded' with the
-- slice 10 submission created in the same transaction for the same job, contract and consultant, or 'declined' with a reason.
-- Deciding clears the e-mail, mobile, comments and résumé from the inbox row; recording clears the name too (the slice 10
-- submission holds it now, and slice 5's removal clears it there). A declined row keeps only the name for the agency's list
-- until it is pruned 180 days after the decision.
--
-- What this installs:
--   1. recruitment_company_setting.agency_portal_enabled (default false; administrators only, by the table's policies).
--   2. Owner-only app tables: codes, checks, sessions, and the per-transaction portal context.
--   3. Owner SELECT policies, open only inside the portal context of one company, on the slice 10 tables, jobs, applications and
--      the company setting the definers read.
--   4. public.recruitment_agency_portal_submission (the inbox): forced row security, the job's operators read and decide; no
--      INSERT or DELETE for the app role (only the definers write rows; the prune deletes).
--   5. The definers above.
-- Codes, checks and sessions keep only hashes; nothing here stores an address in clear except the inbox's typed candidate e-mail.
--
-- PRECONDITION: applies after 5726.

-- ── 1. The company switch ────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.recruitment_company_setting ADD COLUMN agency_portal_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- ── 2. Owner-only tables ─────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE app.recruitment_agency_portal_code (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 company_id uuid NOT NULL,
 email_digest text NOT NULL CHECK (email_digest ~ '^[0-9a-f]{64}$'),
 code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
 client_hash text NOT NULL CHECK (client_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 wrong_entries integer NOT NULL DEFAULT 0 CHECK (wrong_entries BETWEEN 0 AND 5),
 spent_at timestamptz
);
CREATE INDEX recruitment_agency_portal_code_address_idx ON app.recruitment_agency_portal_code (company_id, email_digest, created_at);
CREATE INDEX recruitment_agency_portal_code_client_idx ON app.recruitment_agency_portal_code (client_hash, created_at);
CREATE INDEX recruitment_agency_portal_code_created_idx ON app.recruitment_agency_portal_code (created_at);
CREATE TABLE app.recruitment_agency_portal_check (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 client_hash text NOT NULL CHECK (client_hash ~ '^[0-9a-f]{64}$'),
 checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recruitment_agency_portal_check_client_idx ON app.recruitment_agency_portal_check (client_hash, checked_at);
CREATE INDEX recruitment_agency_portal_check_checked_idx ON app.recruitment_agency_portal_check (checked_at);
CREATE TABLE app.recruitment_agency_portal_session (
 token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
 tenant_id uuid NOT NULL,
 company_id uuid NOT NULL,
 email_digest text NOT NULL CHECK (email_digest ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 ended_at timestamptz
);
CREATE INDEX recruitment_agency_portal_session_expires_idx ON app.recruitment_agency_portal_session (expires_at);
CREATE TABLE app.recruitment_agency_portal_context (
 txid bigint NOT NULL,
 tenant_id uuid NOT NULL,
 company_id uuid NOT NULL,
 PRIMARY KEY (txid, company_id)
);
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_agency_portal_code','recruitment_agency_portal_check','recruitment_agency_portal_session','recruitment_agency_portal_context'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC, ai_hr_app', t);
  EXECUTE format('CREATE POLICY %I ON app.%I FOR ALL USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass)))'
   ' WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass)))',
   t || '_owner', t, 'app.' || t, 'app.' || t);
 END LOOP;
END $$;
--> statement-breakpoint
-- True only while a portal definer runs for THIS company of THIS tenant in THIS transaction (as 5708's careers context).
CREATE FUNCTION app.recruitment_agency_portal_open(p_tenant uuid, p_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
 SELECT p_tenant IS NOT NULL AND p_company IS NOT NULL AND EXISTS (SELECT 1 FROM app.recruitment_agency_portal_context m
  WHERE m.txid = txid_current_if_assigned() AND m.company_id = p_company AND m.tenant_id = p_tenant);
$$;
REVOKE ALL ON FUNCTION app.recruitment_agency_portal_open(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_agency_portal_open(uuid, uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 3. Owner reads inside the portal context ─────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_agency','recruitment_agency_contract','recruitment_agency_consultant','recruitment_job_agency_contract',
  'recruitment_job_opening','recruitment_agency_submission','recruitment_application','recruitment_company_setting'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c'
   ' WHERE c.oid = %L::regclass)) AND app.recruitment_agency_portal_open(tenant_id, company_id))', t || '_agency_portal', t, 'public.' || t);
 END LOOP;
END $$;
--> statement-breakpoint

-- ── 4. The inbox ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.recruitment_agency_portal_submission (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 contract_id uuid NOT NULL,
 consultant_id uuid NOT NULL,
 full_name text CHECK (full_name IS NULL OR char_length(full_name) BETWEEN 1 AND 200),
 email text CHECK (email IS NULL OR char_length(email) BETWEEN 3 AND 254),
 mobile text CHECK (mobile IS NULL OR char_length(mobile) BETWEEN 1 AND 40),
 comments text CHECK (comments IS NULL OR char_length(comments) <= 2000),
 resume_name text CHECK (resume_name IS NULL OR char_length(resume_name) BETWEEN 1 AND 200),
 resume_mime text,
 resume_size integer CHECK (resume_size IS NULL OR resume_size BETWEEN 1 AND 10485760),
 resume_content bytea,
 permission_confirmed boolean NOT NULL DEFAULT false,
 email_digest text NOT NULL CHECK (email_digest ~ '^[0-9a-f]{64}$'),
 received_at timestamptz NOT NULL DEFAULT now(),
 state text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'recorded', 'declined')),
 decided_at timestamptz,
 decided_by_user_id uuid,
 decline_reason text CHECK (decline_reason IS NULL OR char_length(decline_reason) BETWEEN 1 AND 500),
 submission_id uuid,
 CONSTRAINT recruitment_agency_portal_submission_contact_ck CHECK (state <> 'waiting' OR email IS NOT NULL OR mobile IS NOT NULL),
 CONSTRAINT recruitment_agency_portal_submission_resume_ck CHECK ((resume_content IS NULL) = (resume_name IS NULL)
  AND (resume_content IS NULL) = (resume_mime IS NULL) AND (resume_content IS NULL) = (resume_size IS NULL)
  AND (resume_content IS NULL OR permission_confirmed)),
 CONSTRAINT recruitment_agency_portal_submission_decided_ck CHECK (
  (state = 'waiting' AND decided_at IS NULL AND decided_by_user_id IS NULL AND decline_reason IS NULL AND submission_id IS NULL)
  OR (state = 'recorded' AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL AND decline_reason IS NULL AND submission_id IS NOT NULL)
  OR (state = 'declined' AND decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL AND decline_reason IS NOT NULL AND submission_id IS NULL)),
 CONSTRAINT recruitment_agency_portal_submission_cleared_ck CHECK (state = 'waiting'
  OR (email IS NULL AND mobile IS NULL AND comments IS NULL AND resume_content IS NULL AND (state = 'declined' OR full_name IS NULL))),
 CONSTRAINT recruitment_agency_portal_submission_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_agency_portal_submission_job_fk FOREIGN KEY (job_id, company_id, tenant_id) REFERENCES public.recruitment_job_opening(id, company_id, tenant_id),
 CONSTRAINT recruitment_agency_portal_submission_contract_fk FOREIGN KEY (contract_id, company_id, tenant_id) REFERENCES public.recruitment_agency_contract(id, company_id, tenant_id),
 CONSTRAINT recruitment_agency_portal_submission_consultant_fk FOREIGN KEY (consultant_id, contract_id, company_id, tenant_id) REFERENCES public.recruitment_agency_consultant(id, contract_id, company_id, tenant_id),
 CONSTRAINT recruitment_agency_portal_submission_decider_fk FOREIGN KEY (decided_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_agency_portal_submission_submission_fk FOREIGN KEY (submission_id) REFERENCES public.recruitment_agency_submission(id)
);
CREATE INDEX recruitment_agency_portal_submission_job_idx ON public.recruitment_agency_portal_submission (job_id, received_at);
CREATE INDEX recruitment_agency_portal_submission_company_idx ON public.recruitment_agency_portal_submission (company_id, state, received_at);
CREATE INDEX recruitment_agency_portal_submission_address_idx ON public.recruitment_agency_portal_submission (company_id, email_digest, received_at);
CREATE INDEX recruitment_agency_portal_submission_consultant_idx ON public.recruitment_agency_portal_submission (consultant_id);
CREATE INDEX recruitment_agency_portal_submission_contract_idx ON public.recruitment_agency_portal_submission (contract_id);
CREATE INDEX recruitment_agency_portal_submission_submission_idx ON public.recruitment_agency_portal_submission (submission_id) WHERE submission_id IS NOT NULL;
CREATE INDEX recruitment_agency_portal_submission_decided_idx ON public.recruitment_agency_portal_submission (decided_at) WHERE decided_at IS NOT NULL;
ALTER TABLE public.recruitment_agency_portal_submission ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recruitment_agency_portal_submission FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.recruitment_agency_portal_submission FROM PUBLIC, ai_hr_app;
GRANT SELECT ON public.recruitment_agency_portal_submission TO ai_hr_app;
GRANT UPDATE (state, decided_at, decided_by_user_id, decline_reason, submission_id, full_name, email, mobile, comments, resume_name, resume_mime, resume_size,
 resume_content, permission_confirmed) ON public.recruitment_agency_portal_submission TO ai_hr_app;
-- HR: the job's operators (recruiter, assistants) and the company's administrators.
CREATE POLICY recruitment_agency_portal_submission_operate_read ON public.recruitment_agency_portal_submission FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id));
CREATE POLICY recruitment_agency_portal_submission_operate_decide ON public.recruitment_agency_portal_submission FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id));
-- The portal definers (owner) write and read inside the portal context of the row's company.
CREATE POLICY recruitment_agency_portal_submission_portal ON public.recruitment_agency_portal_submission FOR ALL
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_agency_portal_submission'::regclass))
  AND app.recruitment_agency_portal_open(tenant_id, company_id))
 WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_agency_portal_submission'::regclass))
  AND app.recruitment_agency_portal_open(tenant_id, company_id));
--> statement-breakpoint
-- A decision is made once, by the caller, now; 'recorded' names a slice 10 submission of the same job, contract and consultant that
-- the caller created in THIS transaction; the personal columns are cleared with it (the CHECK above). Nothing else may change.
CREATE FUNCTION app.recruitment_guard_agency_portal_submission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF app.recruitment_agency_portal_open(OLD.tenant_id, OLD.company_id) THEN RETURN NEW; END IF;
 IF OLD.state <> 'waiting' THEN RAISE EXCEPTION 'This agency submission was already decided' USING ERRCODE = '23514'; END IF;
 IF NEW.state = 'waiting' THEN RAISE EXCEPTION 'An agency submission changes only by a decision' USING ERRCODE = '23514'; END IF;
 IF NEW.decided_by_user_id IS DISTINCT FROM app.current_user_id() OR NEW.decided_at IS DISTINCT FROM now() THEN
  RAISE EXCEPTION 'A decision is recorded by its maker, now' USING ERRCODE = '23514';
 END IF;
 IF (NEW.state = 'declined' AND NEW.full_name IS DISTINCT FROM OLD.full_name) OR NEW.permission_confirmed IS DISTINCT FROM OLD.permission_confirmed THEN
  RAISE EXCEPTION 'A declined agency submission keeps its name' USING ERRCODE = '23514';
 END IF;
 IF NEW.state = 'recorded' AND NOT EXISTS (SELECT 1 FROM public.recruitment_agency_submission s
   WHERE s.id = NEW.submission_id AND s.tenant_id = OLD.tenant_id AND s.company_id = OLD.company_id AND s.job_id = OLD.job_id
    AND s.contract_id = OLD.contract_id AND s.consultant_id = OLD.consultant_id AND s.created_by_user_id = app.current_user_id()
    AND s.created_at = now()) THEN
  RAISE EXCEPTION 'Recording names the submission made for it now' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_agency_portal_submission() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_agency_portal_submission_guard BEFORE UPDATE ON public.recruitment_agency_portal_submission
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_agency_portal_submission();
--> statement-breakpoint

-- ── 5. The portal ────────────────────────────────────────────────────────────────────────────────────────────
-- The company behind a published careers address whose portal is on and whose candidate e-mail can be sent; NULL otherwise.
-- Opens the portal context for that company in this transaction (the caller closes it).
CREATE FUNCTION app.recruitment_agency_portal_site(p_address text) RETURNS public.recruitment_careers_site
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
DECLARE s public.recruitment_careers_site%ROWTYPE; v_on boolean;
BEGIN
 s := app.recruitment_careers_site_at(p_address);
 IF s.company_id IS NULL THEN RETURN NULL; END IF;
 INSERT INTO app.recruitment_agency_portal_context (txid, tenant_id, company_id) VALUES (txid_current(), s.tenant_id, s.company_id) ON CONFLICT DO NOTHING;
 SELECT coalesce(bool_or(cs.agency_portal_enabled), false) INTO v_on FROM public.recruitment_company_setting cs
  WHERE cs.company_id = s.company_id AND cs.tenant_id = s.tenant_id;
 IF NOT v_on OR NOT app.recruitment_careers_verification_required(s.tenant_id, s.company_id) THEN
  DELETE FROM app.recruitment_agency_portal_context WHERE txid = txid_current();
  RETURN NULL;
 END IF;
 RETURN s;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_agency_portal_site(text) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- The Active consultants with this address on a contract of the company that is Enabled and within its period on today's Kuala
-- Lumpur date (inside the portal context). A Restricted contract's user list governs HR users only, not its own consultants.
CREATE FUNCTION app.recruitment_agency_portal_consultants(p_tenant uuid, p_company uuid, p_digest text)
RETURNS TABLE (consultant_id uuid, contract_id uuid, agency_id uuid, consultant_name text, contract_name text, agency_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
 SELECT DISTINCT ON (k.contract_id) k.id, k.contract_id, c.agency_id, k.name, c.name, a.name
 FROM public.recruitment_agency_consultant k
 JOIN public.recruitment_agency_contract c ON c.id = k.contract_id AND c.tenant_id = k.tenant_id AND c.company_id = k.company_id
 JOIN public.recruitment_agency a ON a.id = c.agency_id AND a.tenant_id = c.tenant_id
 WHERE k.tenant_id = p_tenant AND k.company_id = p_company AND k.status = 'active' AND k.email IS NOT NULL
  AND app.recruitment_careers_email_digest(k.email) = p_digest
  AND c.status = 'enabled' AND (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date BETWEEN c.starts_on AND c.ends_on
 ORDER BY k.contract_id, k.created_at, k.id;
$$;
REVOKE ALL ON FUNCTION app.recruitment_agency_portal_consultants(uuid, uuid, text) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- Old rows go when a portal call touches the company: codes, checks and ended or expired sessions after 2 days; decided inbox rows
-- 180 days after their decision.
CREATE FUNCTION app.recruitment_agency_portal_prune(p_tenant uuid, p_company uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
BEGIN
 DELETE FROM app.recruitment_agency_portal_code WHERE created_at < now() - interval '2 days';
 DELETE FROM app.recruitment_agency_portal_check WHERE checked_at < now() - interval '2 days';
 DELETE FROM app.recruitment_agency_portal_session WHERE expires_at < now() - interval '2 days';
 DELETE FROM public.recruitment_agency_portal_submission p
  WHERE p.tenant_id = p_tenant AND p.company_id = p_company AND p.state <> 'waiting' AND p.decided_at < now() - interval '180 days';
END $$;
REVOKE ALL ON FUNCTION app.recruitment_agency_portal_prune(uuid, uuid) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.recruitment_agency_portal_anonymous() RETURNS void
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, app, pg_temp AS $$
BEGIN
 IF app.current_user_id() IS NOT NULL OR app.current_tenant_id() IS NOT NULL THEN
  RAISE EXCEPTION 'The agency portal serves visitors who are not signed in to AI HR' USING ERRCODE = '42501';
 END IF;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_agency_portal_anonymous() FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- Record a code the server is about to send. Status: 'issued' (send it: the address is an Active consultant's on a usable contract),
-- 'quiet' (send nothing: not a consultant, or the address's limit; the visitor sees the same page), 'client_limited' (429) or
-- 'not_found' (no portal at this address). The result names the company and language the server needs to write the e-mail.
CREATE FUNCTION app.recruitment_agency_portal_issue_code(p_address text, p_client_hash text, p_email text, p_code_hash text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on SET lock_timeout = '3s' AS $$
DECLARE s public.recruitment_careers_site%ROWTYPE; v_digest text := app.recruitment_careers_email_digest(p_email);
 v_today date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date; v_known boolean;
BEGIN
 PERFORM app.recruitment_agency_portal_anonymous();
 IF p_client_hash IS NULL OR p_client_hash !~ '^[0-9a-f]{64}$' OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$'
  OR v_digest IS NULL OR char_length(btrim(p_email)) > 254 THEN
  RAISE EXCEPTION 'A code needs a well-formed address' USING ERRCODE = '22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('recruitment-agency-portal-client:' || p_client_hash, 0));
 IF (SELECT count(*) FROM app.recruitment_agency_portal_code c WHERE c.client_hash = p_client_hash AND c.created_at > now() - interval '1 hour') >= 10 THEN
  RETURN jsonb_build_object('status', 'client_limited');
 END IF;
 s := app.recruitment_agency_portal_site(p_address);
 IF s.company_id IS NULL THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
 PERFORM app.recruitment_agency_portal_prune(s.tenant_id, s.company_id);
 v_known := EXISTS (SELECT 1 FROM app.recruitment_agency_portal_consultants(s.tenant_id, s.company_id, v_digest));
 PERFORM pg_advisory_xact_lock(hashtextextended('recruitment-agency-portal-address:' || s.company_id::text || ':' || v_digest, 0));
 IF NOT v_known
  OR (SELECT count(*) FROM app.recruitment_agency_portal_code c WHERE c.company_id = s.company_id AND c.email_digest = v_digest
     AND c.created_at > now() - interval '1 hour') >= 3
  OR (SELECT count(*) FROM app.recruitment_agency_portal_code c WHERE c.company_id = s.company_id AND c.email_digest = v_digest
     AND c.created_at >= (v_today::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')) >= 10 THEN
  DELETE FROM app.recruitment_agency_portal_context WHERE txid = txid_current();
  RETURN jsonb_build_object('status', 'quiet');
 END IF;
 UPDATE app.recruitment_agency_portal_code c SET spent_at = now() WHERE c.company_id = s.company_id AND c.email_digest = v_digest AND c.spent_at IS NULL;
 INSERT INTO app.recruitment_agency_portal_code (tenant_id, company_id, email_digest, code_hash, client_hash, expires_at)
  VALUES (s.tenant_id, s.company_id, v_digest, p_code_hash, p_client_hash, now() + interval '10 minutes');
 DELETE FROM app.recruitment_agency_portal_context WHERE txid = txid_current();
 RETURN jsonb_build_object('status', 'issued', 'tenantId', s.tenant_id, 'companyId', s.company_id);
END $$;
REVOKE ALL ON FUNCTION app.recruitment_agency_portal_issue_code(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_agency_portal_issue_code(text, text, text, text) TO ai_hr_app;
--> statement-breakpoint
-- Check a code. 'signed_in' (the token's hash opens a session for 8 hours), 'wrong' (one of 5 entries; the fifth spends the code),
-- 'expired' (no live code), 'client_limited' (30 checks an hour) or 'not_found'. Every check counts against the client.
CREATE FUNCTION app.recruitment_agency_portal_check_code(p_address text, p_client_hash text, p_email text, p_code_hash text, p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on SET lock_timeout = '3s' AS $$
DECLARE s public.recruitment_careers_site%ROWTYPE; v_digest text := app.recruitment_careers_email_digest(p_email); c app.recruitment_agency_portal_code%ROWTYPE;
BEGIN
 PERFORM app.recruitment_agency_portal_anonymous();
 IF p_client_hash IS NULL OR p_client_hash !~ '^[0-9a-f]{64}$' OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$'
  OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR v_digest IS NULL THEN
  RAISE EXCEPTION 'A code check needs a well-formed address, code and token' USING ERRCODE = '22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('recruitment-agency-portal-client:' || p_client_hash, 0));
 IF (SELECT count(*) FROM app.recruitment_agency_portal_check k WHERE k.client_hash = p_client_hash AND k.checked_at > now() - interval '1 hour') >= 30 THEN
  RETURN jsonb_build_object('status', 'client_limited');
 END IF;
 INSERT INTO app.recruitment_agency_portal_check (client_hash) VALUES (p_client_hash);
 s := app.recruitment_agency_portal_site(p_address);
 IF s.company_id IS NULL THEN RETURN jsonb_build_object('status', 'not_found'); END IF;
 SELECT * INTO c FROM app.recruitment_agency_portal_code x
  WHERE x.company_id = s.company_id AND x.email_digest = v_digest AND x.spent_at IS NULL AND x.expires_at > now()
  ORDER BY x.created_at DESC LIMIT 1 FOR UPDATE;
 IF c.id IS NULL THEN
  DELETE FROM app.recruitment_agency_portal_context WHERE txid = txid_current();
  RETURN jsonb_build_object('status', 'expired');
 END IF;
 IF c.code_hash <> p_code_hash THEN
  UPDATE app.recruitment_agency_portal_code x SET wrong_entries = x.wrong_entries + 1, spent_at = CASE WHEN x.wrong_entries + 1 >= 5 THEN now() END
   WHERE x.id = c.id;
  DELETE FROM app.recruitment_agency_portal_context WHERE txid = txid_current();
  RETURN jsonb_build_object('status', 'wrong');
 END IF;
 UPDATE app.recruitment_agency_portal_code x SET spent_at = now() WHERE x.id = c.id;
 IF NOT EXISTS (SELECT 1 FROM app.recruitment_agency_portal_consultants(s.tenant_id, s.company_id, v_digest)) THEN
  DELETE FROM app.recruitment_agency_portal_context WHERE txid = txid_current();
  RETURN jsonb_build_object('status', 'expired');
 END IF;
 INSERT INTO app.recruitment_agency_portal_session (token_hash, tenant_id, company_id, email_digest, expires_at)
  VALUES (p_token_hash, s.tenant_id, s.company_id, v_digest, now() + interval '8 hours');
 INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
  VALUES (s.tenant_id, 'recruitment-agency-portal', s.company_id, 'recruitment-agency-portal.signed-in', 'external', NULL,
   jsonb_build_object('companyId', s.company_id, 'consultantIds',
    (SELECT jsonb_agg(k.consultant_id ORDER BY k.consultant_id) FROM app.recruitment_agency_portal_consultants(s.tenant_id, s.company_id, v_digest) k)));
 DELETE FROM app.recruitment_agency_portal_context WHERE txid = txid_current();
 RETURN jsonb_build_object('status', 'signed_in');
END $$;
REVOKE ALL ON FUNCTION app.recruitment_agency_portal_check_code(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_agency_portal_check_code(text, text, text, text, text) TO ai_hr_app;
--> statement-breakpoint
-- The live session behind a token at this address, or NULL. Ends a session whose address no longer has an Active consultant on a
-- usable contract. Leaves the portal context open for the caller (who closes it).
CREATE FUNCTION app.recruitment_agency_portal_session_at(p_address text, p_token_hash text) RETURNS app.recruitment_agency_portal_session
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
DECLARE s public.recruitment_careers_site%ROWTYPE; v app.recruitment_agency_portal_session%ROWTYPE;
BEGIN
 IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
 s := app.recruitment_agency_portal_site(p_address);
 IF s.company_id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO v FROM app.recruitment_agency_portal_session x
  WHERE x.token_hash = p_token_hash AND x.company_id = s.company_id AND x.tenant_id = s.tenant_id AND x.ended_at IS NULL AND x.expires_at > now();
 IF v.token_hash IS NULL THEN RETURN NULL; END IF;
 IF NOT EXISTS (SELECT 1 FROM app.recruitment_agency_portal_consultants(v.tenant_id, v.company_id, v.email_digest)) THEN
  UPDATE app.recruitment_agency_portal_session x SET ended_at = now() WHERE x.token_hash = v.token_hash;
  RETURN NULL;
 END IF;
 RETURN v;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_agency_portal_session_at(text, text) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- The portal page: the company, the consultant's contracts, the open jobs released to them (title, place, type, description and the
-- agency requirements) and their submissions (portal inbox and HR-recorded ones for these consultants), newest first, at most 200,
-- each with a coarse status: received, in_process, hired or not_progressed. NULL for no live session (the caller signs out).
CREATE FUNCTION app.recruitment_agency_portal_view(p_address text, p_token_hash text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on SET lock_timeout = '3s' AS $$
DECLARE v app.recruitment_agency_portal_session%ROWTYPE; r jsonb;
BEGIN
 PERFORM app.recruitment_agency_portal_anonymous();
 v := app.recruitment_agency_portal_session_at(p_address, p_token_hash);
 IF v.token_hash IS NULL THEN
  DELETE FROM app.recruitment_agency_portal_context WHERE txid = txid_current();
  RETURN NULL;
 END IF;
 WITH mine AS (SELECT * FROM app.recruitment_agency_portal_consultants(v.tenant_id, v.company_id, v.email_digest)),
 jobs AS (
  SELECT j.id, j.title, j.work_location, j.employment_type, j.description, x.requirements, x.contract_id, m.contract_name, m.agency_name
  FROM public.recruitment_job_agency_contract x
  JOIN mine m ON m.contract_id = x.contract_id
  JOIN public.recruitment_job_opening j ON j.id = x.job_id AND j.tenant_id = x.tenant_id AND j.company_id = x.company_id AND j.status = 'open'
  WHERE x.tenant_id = v.tenant_id AND x.company_id = v.company_id),
 subs AS (
  SELECT p.received_at AS at, coalesce(s.full_name, p.full_name) AS full_name, jo.title AS job_title,
   CASE WHEN p.state = 'waiting' THEN 'received'
    WHEN p.state = 'declined' THEN 'not_progressed'
    ELSE app.recruitment_agency_portal_status(s.outcome, ap.state) END AS status
  FROM public.recruitment_agency_portal_submission p
  JOIN public.recruitment_job_opening jo ON jo.id = p.job_id AND jo.tenant_id = p.tenant_id
  LEFT JOIN public.recruitment_agency_submission s ON s.id = p.submission_id AND s.tenant_id = p.tenant_id
  LEFT JOIN public.recruitment_application ap ON ap.id = s.application_id AND ap.tenant_id = s.tenant_id
  WHERE p.tenant_id = v.tenant_id AND p.company_id = v.company_id AND p.consultant_id IN (SELECT consultant_id FROM mine)
  UNION ALL
  SELECT s.created_at, s.full_name, jo.title, app.recruitment_agency_portal_status(s.outcome, ap.state)
  FROM public.recruitment_agency_submission s
  JOIN public.recruitment_job_opening jo ON jo.id = s.job_id AND jo.tenant_id = s.tenant_id
  LEFT JOIN public.recruitment_application ap ON ap.id = s.application_id AND ap.tenant_id = s.tenant_id
  WHERE s.tenant_id = v.tenant_id AND s.company_id = v.company_id AND s.consultant_id IN (SELECT consultant_id FROM mine)
   AND NOT EXISTS (SELECT 1 FROM public.recruitment_agency_portal_submission p WHERE p.submission_id = s.id))
 SELECT jsonb_build_object(
  'companyName', (SELECT co.legal_name FROM public.company co WHERE co.id = v.company_id AND co.tenant_id = v.tenant_id),
  'contracts', coalesce((SELECT jsonb_agg(jsonb_build_object('contractId', m.contract_id, 'contractName', m.contract_name, 'agencyName', m.agency_name,
    'consultantName', m.consultant_name) ORDER BY m.agency_name, m.contract_name, m.contract_id) FROM mine m), '[]'::jsonb),
  'jobs', coalesce((SELECT jsonb_agg(jsonb_build_object('jobId', j.id, 'title', j.title, 'workLocation', j.work_location, 'employmentType', j.employment_type,
    'description', j.description, 'requirements', j.requirements, 'contractId', j.contract_id, 'contractName', j.contract_name, 'agencyName', j.agency_name)
    ORDER BY j.title, j.id, j.contract_id) FROM jobs j), '[]'::jsonb),
  'submissions', coalesce((SELECT jsonb_agg(jsonb_build_object('receivedAt', b.at, 'fullName', b.full_name, 'jobTitle', b.job_title, 'status', b.status)
    ORDER BY b.at DESC) FROM (SELECT * FROM subs ORDER BY at DESC LIMIT 200) b), '[]'::jsonb),
  'expiresAt', v.expires_at)
 INTO r;
 DELETE FROM app.recruitment_agency_portal_context WHERE txid = txid_current();
 RETURN r;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_agency_portal_view(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_agency_portal_view(text, text) TO ai_hr_app;
--> statement-breakpoint
-- A slice 10 submission's coarse status for the agency: never which earlier application or channel protected a person.
CREATE FUNCTION app.recruitment_agency_portal_status(p_outcome text, p_application_state text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
 SELECT CASE
  WHEN p_outcome = 'waiting' THEN 'received'
  WHEN p_outcome = 'accepted' AND p_application_state = 'active' THEN 'in_process'
  WHEN p_outcome = 'accepted' AND p_application_state = 'hired' THEN 'hired'
  ELSE 'not_progressed' END;
$$;
REVOKE ALL ON FUNCTION app.recruitment_agency_portal_status(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_agency_portal_status(text, text) TO ai_hr_app;
--> statement-breakpoint
-- Submit a candidate into HR's inbox. Status: 'received', 'signed_out' (no live session), 'not_available' (the job is not open or
-- not released to one of this address's contracts), 'repeat' (the same person, by normalised e-mail or mobile, is already waiting
-- for this job from this contract), 'daily_limit' (20 a Kuala Lumpur day for this address at this company) or 'client_limited'
-- (30 an hour). The server validates the fields; the table's CHECKs hold the limits.
CREATE FUNCTION app.recruitment_agency_portal_submit(p_address text, p_token_hash text, p_client_hash text, p_job uuid, p_contract uuid,
 p_full_name text, p_email text, p_mobile text, p_comments text,
 p_file_name text DEFAULT NULL, p_file_mime text DEFAULT NULL, p_file_content bytea DEFAULT NULL, p_permission boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on SET lock_timeout = '3s' AS $$
DECLARE v app.recruitment_agency_portal_session%ROWTYPE; v_consultant uuid; v_today date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date; v_id uuid;
BEGIN
 PERFORM app.recruitment_agency_portal_anonymous();
 IF p_client_hash IS NULL OR p_client_hash !~ '^[0-9a-f]{64}$' OR p_job IS NULL OR p_contract IS NULL THEN
  RAISE EXCEPTION 'A portal submission needs a client, a job and a contract' USING ERRCODE = '22023';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('recruitment-agency-portal-client:' || p_client_hash, 0));
 IF (SELECT count(*) FROM app.recruitment_agency_portal_check k WHERE k.client_hash = p_client_hash AND k.checked_at > now() - interval '1 hour') >= 30 THEN
  RETURN jsonb_build_object('status', 'client_limited');
 END IF;
 INSERT INTO app.recruitment_agency_portal_check (client_hash) VALUES (p_client_hash);
 v := app.recruitment_agency_portal_session_at(p_address, p_token_hash);
 IF v.token_hash IS NULL THEN
  DELETE FROM app.recruitment_agency_portal_context WHERE txid = txid_current();
  RETURN jsonb_build_object('status', 'signed_out');
 END IF;
 SELECT m.consultant_id INTO v_consultant FROM app.recruitment_agency_portal_consultants(v.tenant_id, v.company_id, v.email_digest) m
  WHERE m.contract_id = p_contract
   AND EXISTS (SELECT 1 FROM public.recruitment_job_agency_contract x JOIN public.recruitment_job_opening j ON j.id = x.job_id AND j.tenant_id = x.tenant_id
    WHERE x.job_id = p_job AND x.contract_id = m.contract_id AND x.tenant_id = v.tenant_id AND x.company_id = v.company_id AND j.status = 'open');
 IF v_consultant IS NULL THEN
  DELETE FROM app.recruitment_agency_portal_context WHERE txid = txid_current();
  RETURN jsonb_build_object('status', 'not_available');
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('recruitment-agency-portal-address:' || v.company_id::text || ':' || v.email_digest, 0));
 IF (SELECT count(*) FROM public.recruitment_agency_portal_submission p WHERE p.company_id = v.company_id AND p.tenant_id = v.tenant_id
     AND p.email_digest = v.email_digest AND p.received_at >= (v_today::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur')) >= 20 THEN
  DELETE FROM app.recruitment_agency_portal_context WHERE txid = txid_current();
  RETURN jsonb_build_object('status', 'daily_limit');
 END IF;
 IF EXISTS (SELECT 1 FROM public.recruitment_agency_portal_submission p
   WHERE p.tenant_id = v.tenant_id AND p.company_id = v.company_id AND p.job_id = p_job AND p.contract_id = p_contract AND p.state = 'waiting'
    AND ((p_email IS NOT NULL AND app.recruitment_norm_email(p.email) = app.recruitment_norm_email(p_email))
     OR (p_mobile IS NOT NULL AND app.recruitment_norm_mobile(p.mobile) = app.recruitment_norm_mobile(p_mobile)))) THEN
  DELETE FROM app.recruitment_agency_portal_context WHERE txid = txid_current();
  RETURN jsonb_build_object('status', 'repeat');
 END IF;
 INSERT INTO public.recruitment_agency_portal_submission (tenant_id, company_id, job_id, contract_id, consultant_id, full_name, email, mobile, comments,
   resume_name, resume_mime, resume_size, resume_content, permission_confirmed, email_digest)
  VALUES (v.tenant_id, v.company_id, p_job, p_contract, v_consultant, p_full_name, p_email, p_mobile, p_comments,
   p_file_name, p_file_mime, CASE WHEN p_file_content IS NULL THEN NULL ELSE octet_length(p_file_content) END, p_file_content,
   coalesce(p_permission, false), v.email_digest)
  RETURNING id INTO v_id;
 INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
  VALUES (v.tenant_id, 'recruitment-agency-portal-submission', v_id, 'recruitment-agency-portal.submitted', 'external', NULL,
   jsonb_build_object('companyId', v.company_id, 'jobId', p_job, 'contractId', p_contract, 'consultantId', v_consultant));
 DELETE FROM app.recruitment_agency_portal_context WHERE txid = txid_current();
 RETURN jsonb_build_object('status', 'received');
END $$;
REVOKE ALL ON FUNCTION app.recruitment_agency_portal_submit(text, text, text, uuid, uuid, text, text, text, text, text, text, bytea, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_agency_portal_submit(text, text, text, uuid, uuid, text, text, text, text, text, text, bytea, boolean) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.recruitment_agency_portal_sign_out(p_token_hash text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
BEGIN
 PERFORM app.recruitment_agency_portal_anonymous();
 IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;
 UPDATE app.recruitment_agency_portal_session x SET ended_at = now() WHERE x.token_hash = p_token_hash AND x.ended_at IS NULL;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_agency_portal_sign_out(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_agency_portal_sign_out(text) TO ai_hr_app;
--> statement-breakpoint
-- What the server needs to write a code e-mail: the company's name, sender name, reply-to and language (as 5722's context).
CREATE FUNCTION app.recruitment_agency_portal_email_context(p_address text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on SET lock_timeout = '3s' AS $$
DECLARE s public.recruitment_careers_site%ROWTYPE; r jsonb;
BEGIN
 PERFORM app.recruitment_agency_portal_anonymous();
 s := app.recruitment_agency_portal_site(p_address);
 IF s.company_id IS NULL THEN RETURN NULL; END IF;
 DELETE FROM app.recruitment_agency_portal_context WHERE txid = txid_current();
 INSERT INTO app.recruitment_candidate_email_context (txid, purpose, scope_id) VALUES (txid_current(), 'worker', s.tenant_id) ON CONFLICT DO NOTHING;
 SELECT jsonb_build_object('tenantId', s.tenant_id, 'companyId', s.company_id, 'companyName', co.legal_name,
   'senderName', app.recruitment_candidate_email_sender(st.sender_name, co.legal_name), 'replyTo', st.reply_to, 'locale', coalesce(st.locale, 'en'))
  INTO r
  FROM public.company co LEFT JOIN public.recruitment_candidate_email_setting st ON st.company_id = co.id AND st.tenant_id = co.tenant_id
  WHERE co.id = s.company_id AND co.tenant_id = s.tenant_id;
 DELETE FROM app.recruitment_candidate_email_context WHERE txid = txid_current() AND purpose = 'worker';
 RETURN r;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_agency_portal_email_context(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_agency_portal_email_context(text) TO ai_hr_app;
