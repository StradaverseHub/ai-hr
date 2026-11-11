-- Recruitment slice 8 (docs/recruitment-reconstruction/specification.md "Slice 8"): the public careers page and online
-- applications.
--
-- One plain careers page per company (D-025). Visitors are anonymous: no session, account, cookie or e-mail code (D-026).
-- Everything they read or write goes through the three SECURITY DEFINER functions below, which take the page address
-- and a job id (plus the form values), return only the fields the spec lists, and answer every unavailable case with the
-- same "not found". The app role gains no grant or policy that a visitor could use directly.
--
-- What this installs:
--   1. public.recruitment_careers_site: one row per company — published (default off), address (3–40 lowercase letters,
--      digits and hyphens, not starting or ending with a hyphen, unique in the installation), display name, headline and
--      introduction. Publishing needs an address, a display name and a privacy notice (CHECK + guard). Only a recruitment
--      administrator of the company writes it (row security, and the guard refuses anybody else again).
--   2. public.recruitment_careers_notice: the privacy notice, one immutable row per version (1, 2, …) per company. A new
--      text is a new version; no row is ever updated, and none is deleted except with the company's recruitment setup.
--      The current notice is the highest version (one owner: no separate "current version" column).
--   3. recruitment_job_opening.show_on_careers_page (default off) and careers_posted_at (the moment it was put on the page,
--      set by the database, cleared when taken off). Only a recruitment administrator of the job's company changes it.
--      A job is public only while the company page is published, the job is Open and the flag is on.
--   4. public.recruitment_careers_application: one row per stored careers application — the job, the candidate, the
--      applicant's optional message and when it arrived. HR's mark that the application came through the careers page.
--      Reviewers and administrators of the job read it; the slice 5 removal clears the message.
--      recruitment_candidate_consent.careers_notice_version: the notice version the applicant agreed to.
--   5. Rows written by an anonymous visitor have no signed-in author: the author columns of the candidate, application,
--      application history, candidate file and consent tables become nullable, and a guard admits a NULL author ONLY while
--      the careers submission runs (the context marker below). Every other writer still records its signed-in user (the
--      earlier guards compare the author with app.current_user_id(), and an HR session always has one). Audit events of
--      the careers channel use actor_type 'external' with no actor id.
--   6. Reads need no marker and write nothing: owner-only policies admit exactly what is public — published sites, the
--      Open jobs flagged for a published page (app.recruitment_careers_published) and the notices of a published page.
--      Every existing owner-run function that reads job openings filters by tenant and company itself, so these policies
--      give them nothing new to return. The SUBMISSION uses app.recruitment_careers_context, the per-transaction context
--      marker, like 4407's — written only by the submission, deleted before it returns, no grant to anybody. Owner-only
--      policies bound to it open the job, process, settings, notice, candidate and application rows of THAT company to the
--      submission, only for that transaction; a GUC or session value cannot open them.
--   7. app.recruitment_careers_attempt: the private submission log for the limits (D-027) — a keyed hash of the client
--      address (never the address), the company and whether the submission was stored. No candidate data, no link to a
--      candidate, kept two days: the submission prunes as it goes, and app.recruitment_careers_prune (owner-only, run by
--      the scheduled aihr-recruitment-careers-prune unit in deploy/internal-auth) deletes old rows even when nothing is
--      submitted. app.recruitment_careers_client_limited answers, read-only, whether a client hash has used its hourly
--      submissions, so the server refuses before reading a request body.
--   8. app.recruitment_careers_page / _careers_job (STABLE, no writes) and _careers_submit (see each function). Each pins
--      lock_timeout; the anonymous connection pool also bounds every statement (packs/recruitment/careers.ts).
--   9. app.recruitment_destroy_candidate restated (4407 body byte for byte) plus one step: the careers message is cleared.
--      app.recruitment_delete_company_setup restated (4405 body) plus the careers notices and site.
--
-- Nothing here sends e-mail or notifications (D-029), calls a model or scores a candidate.

-- ── 1. The careers site ──────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.recruitment_careers_site (
 company_id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 published boolean NOT NULL DEFAULT false,
 address text CHECK (address IS NULL OR (char_length(address) BETWEEN 3 AND 40 AND address ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$')),
 display_name text CHECK (display_name IS NULL OR char_length(btrim(display_name)) BETWEEN 1 AND 120),
 headline text CHECK (headline IS NULL OR char_length(btrim(headline)) BETWEEN 1 AND 160),
 introduction text CHECK (introduction IS NULL OR char_length(btrim(introduction)) BETWEEN 1 AND 4000),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_careers_site_publish_ck CHECK (NOT published OR (address IS NOT NULL AND display_name IS NOT NULL)),
 CONSTRAINT recruitment_careers_site_address_uq UNIQUE (address),
 CONSTRAINT recruitment_careers_site_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_careers_site_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_careers_site_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
CREATE INDEX recruitment_careers_site_tenant_idx ON public.recruitment_careers_site (tenant_id);
CREATE INDEX recruitment_careers_site_created_by_idx ON public.recruitment_careers_site (created_by_user_id);
CREATE INDEX recruitment_careers_site_updated_by_idx ON public.recruitment_careers_site (updated_by_user_id);
--> statement-breakpoint
-- The privacy notice, one row per version. Immutable.
CREATE TABLE public.recruitment_careers_notice (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 version integer NOT NULL CHECK (version >= 1),
 body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 20000),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_careers_notice_version_uq UNIQUE (company_id, version),
 CONSTRAINT recruitment_careers_notice_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_careers_notice_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
CREATE INDEX recruitment_careers_notice_tenant_idx ON public.recruitment_careers_notice (tenant_id, company_id);
CREATE INDEX recruitment_careers_notice_created_by_idx ON public.recruitment_careers_notice (created_by_user_id);
--> statement-breakpoint

-- ── 2. The job flag, the careers application and the consent's notice version ─────────────────────────────────
ALTER TABLE public.recruitment_job_opening
 ADD COLUMN show_on_careers_page boolean NOT NULL DEFAULT false,
 ADD COLUMN careers_posted_at timestamptz,
 ADD CONSTRAINT recruitment_job_opening_careers_posted_ck CHECK (show_on_careers_page = (careers_posted_at IS NOT NULL));
CREATE INDEX recruitment_job_opening_careers_idx ON public.recruitment_job_opening (tenant_id, company_id, careers_posted_at DESC)
 WHERE show_on_careers_page AND status = 'open';
--> statement-breakpoint
CREATE TABLE public.recruitment_careers_application (
 application_id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 candidate_id uuid NOT NULL,
 -- The applicant's own words; cleared (NULL) by the candidate's removal.
 message text CHECK (message IS NULL OR char_length(btrim(message)) BETWEEN 1 AND 1000),
 received_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT recruitment_careers_application_application_fk FOREIGN KEY (application_id, company_id, tenant_id) REFERENCES public.recruitment_application(id, company_id, tenant_id),
 CONSTRAINT recruitment_careers_application_job_fk FOREIGN KEY (job_id, company_id, tenant_id) REFERENCES public.recruitment_job_opening(id, company_id, tenant_id),
 CONSTRAINT recruitment_careers_application_candidate_fk FOREIGN KEY (candidate_id, company_id, tenant_id) REFERENCES public.recruitment_candidate(id, company_id, tenant_id)
);
CREATE INDEX recruitment_careers_application_job_idx ON public.recruitment_careers_application (job_id);
CREATE INDEX recruitment_careers_application_candidate_idx ON public.recruitment_careers_application (candidate_id);
CREATE INDEX recruitment_careers_application_company_idx ON public.recruitment_careers_application (tenant_id, company_id, received_at);
--> statement-breakpoint
ALTER TABLE public.recruitment_candidate_consent
 ADD COLUMN careers_notice_version integer,
 ADD CONSTRAINT recruitment_candidate_consent_careers_notice_fk FOREIGN KEY (company_id, careers_notice_version)
  REFERENCES public.recruitment_careers_notice (company_id, version);
CREATE INDEX recruitment_candidate_consent_careers_notice_idx ON public.recruitment_candidate_consent (company_id, careers_notice_version)
 WHERE careers_notice_version IS NOT NULL;
--> statement-breakpoint
-- Rows the anonymous careers channel writes have no signed-in author (section 5 of the header).
ALTER TABLE public.recruitment_candidate ALTER COLUMN created_by_user_id DROP NOT NULL, ALTER COLUMN updated_by_user_id DROP NOT NULL;
ALTER TABLE public.recruitment_application ALTER COLUMN created_by_user_id DROP NOT NULL, ALTER COLUMN updated_by_user_id DROP NOT NULL;
ALTER TABLE public.recruitment_application_event ALTER COLUMN actor_user_id DROP NOT NULL;
ALTER TABLE public.recruitment_candidate_file ALTER COLUMN uploaded_by_user_id DROP NOT NULL;
ALTER TABLE public.recruitment_candidate_consent ALTER COLUMN recorded_by_user_id DROP NOT NULL;
--> statement-breakpoint

-- ── 3. The context marker, the attempt log and their predicate ─────────────────────────────────────────────────
CREATE TABLE app.recruitment_careers_context (
 txid bigint NOT NULL,
 company_id uuid NOT NULL,
 tenant_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (txid, company_id)
);
ALTER TABLE app.recruitment_careers_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.recruitment_careers_context FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.recruitment_careers_context FROM PUBLIC, ai_hr_app;
CREATE POLICY recruitment_careers_context_owner ON app.recruitment_careers_context FOR ALL
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'app.recruitment_careers_context'::regclass)))
 WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'app.recruitment_careers_context'::regclass)));
--> statement-breakpoint
-- Every well-formed submission that passed the per-client limit: the keyed client hash (HMAC-SHA-256 computed by the
-- server; the address itself never reaches the database), the company when the page resolved, and whether it was stored.
CREATE TABLE app.recruitment_careers_attempt (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 client_hash text NOT NULL CHECK (client_hash ~ '^[0-9a-f]{64}$'),
 tenant_id uuid,
 company_id uuid,
 attempted_at timestamptz NOT NULL DEFAULT now(),
 accepted boolean NOT NULL DEFAULT false
);
CREATE INDEX recruitment_careers_attempt_client_idx ON app.recruitment_careers_attempt (client_hash, attempted_at);
CREATE INDEX recruitment_careers_attempt_company_idx ON app.recruitment_careers_attempt (company_id, attempted_at) WHERE accepted;
CREATE INDEX recruitment_careers_attempt_age_idx ON app.recruitment_careers_attempt (attempted_at);
ALTER TABLE app.recruitment_careers_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.recruitment_careers_attempt FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.recruitment_careers_attempt FROM PUBLIC, ai_hr_app;
CREATE POLICY recruitment_careers_attempt_owner ON app.recruitment_careers_attempt FOR ALL
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'app.recruitment_careers_attempt'::regclass)))
 WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'app.recruitment_careers_attempt'::regclass)));
--> statement-breakpoint
-- True only while a careers function is running for THIS company of THIS tenant in THIS transaction.
-- txid_current_if_assigned never assigns a transaction id, so evaluating it has no side effect.
CREATE FUNCTION app.recruitment_careers_open(p_tenant uuid, p_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
 SELECT p_tenant IS NOT NULL AND p_company IS NOT NULL AND EXISTS (SELECT 1 FROM app.recruitment_careers_context m
  WHERE m.txid = txid_current_if_assigned() AND m.company_id = p_company AND m.tenant_id = p_tenant);
$$;
REVOKE ALL ON FUNCTION app.recruitment_careers_open(uuid, uuid) FROM PUBLIC;
-- The app role evaluates it inside the author guard (section 6) on its own HR writes; it can never make it true.
GRANT EXECUTE ON FUNCTION app.recruitment_careers_open(uuid, uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 4. Row security and grants ─────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_careers_site','recruitment_careers_notice','recruitment_careers_application'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, ai_hr_app', t);
 END LOOP;
END $$;
--> statement-breakpoint
-- HR: the company's recruitment administrators read and write the site and add notice versions.
CREATE POLICY recruitment_careers_site_admin ON public.recruitment_careers_site FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
CREATE POLICY recruitment_careers_notice_admin_read ON public.recruitment_careers_notice FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
CREATE POLICY recruitment_careers_notice_admin_insert ON public.recruitment_careers_notice FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
-- Only app.recruitment_delete_company_setup deletes a notice (the app role has no DELETE grant; the guard admits the
-- delete only while that function removes this company's setup).
CREATE POLICY recruitment_careers_notice_company_delete ON public.recruitment_careers_notice FOR DELETE
 USING (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id)
  AND current_setting('app.recruitment_company_delete', true) = company_id::text);
-- The careers application: the job's reviewers and administrators (the message is the applicant's own words).
CREATE POLICY recruitment_careers_application_read ON public.recruitment_careers_application FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.can_review_recruitment_job(company_id, job_id));
-- Removal clears the message, which nobody else may rewrite.
CREATE POLICY recruitment_careers_application_destroy ON public.recruitment_careers_application FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_destroying(candidate_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.recruitment_destroying(candidate_id));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.recruitment_careers_site TO ai_hr_app;
GRANT SELECT, INSERT ON public.recruitment_careers_notice TO ai_hr_app;
GRANT SELECT ON public.recruitment_careers_application TO ai_hr_app;
--> statement-breakpoint
-- The careers functions (owner-run). A published site is public by design: the owner resolves an address without a
-- marker, and sees nothing of an unpublished one. The app role never satisfies these (it is never the owner).
CREATE POLICY recruitment_careers_site_public ON public.recruitment_careers_site FOR SELECT
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_careers_site'::regclass))
  AND published);
--> statement-breakpoint
-- Is this company's careers page published? Public by design. The app role may evaluate it (row security evaluates every
-- permissive policy expression on its own reads) but it answers only this.
CREATE FUNCTION app.recruitment_careers_published(p_tenant uuid, p_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT p_tenant IS NOT NULL AND p_company IS NOT NULL AND EXISTS (SELECT 1 FROM public.recruitment_careers_site s
  WHERE s.company_id = p_company AND s.tenant_id = p_tenant AND s.published);
$$;
REVOKE ALL ON FUNCTION app.recruitment_careers_published(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_careers_published(uuid, uuid) TO ai_hr_app;
--> statement-breakpoint
-- The public reads, without a marker: exactly the public rows, to the owner-run careers functions only.
CREATE POLICY recruitment_job_opening_careers_public ON public.recruitment_job_opening FOR SELECT
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_job_opening'::regclass))
  AND status = 'open' AND show_on_careers_page AND app.recruitment_careers_published(tenant_id, company_id));
CREATE POLICY recruitment_careers_notice_public ON public.recruitment_careers_notice FOR SELECT
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_careers_notice'::regclass))
  AND app.recruitment_careers_published(tenant_id, company_id));
-- Marker-bound, owner-only: no policy below reads a table whose own policy reads it back, so none can recurse.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_job_opening','recruitment_process_stage','recruitment_stage','recruitment_candidate',
  'recruitment_application','recruitment_company_setting','recruitment_careers_notice'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND app.recruitment_careers_open(tenant_id, company_id))', t || '_careers_read', t, 'public.' || t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['recruitment_candidate','recruitment_application','recruitment_application_event','recruitment_candidate_file',
  'recruitment_candidate_consent','recruitment_careers_application'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND app.recruitment_careers_open(tenant_id, company_id))', t || '_careers_insert', t, 'public.' || t);
 END LOOP;
END $$;
--> statement-breakpoint
-- The job row is locked FOR SHARE by the submission (a concurrent close or switch-off waits for it). A row lock needs an
-- UPDATE policy; this one admits the lock and no write (WITH CHECK false).
CREATE POLICY recruitment_job_opening_careers_lock ON public.recruitment_job_opening FOR UPDATE
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_job_opening'::regclass))
  AND app.recruitment_careers_open(tenant_id, company_id))
 WITH CHECK (false);
--> statement-breakpoint

-- ── 5. Guards ────────────────────────────────────────────────────────────────────────────────────────────────
-- The site: written only by a recruitment administrator of the company; published only with a privacy notice.
CREATE FUNCTION app.recruitment_guard_careers_site() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF NOT app.can_admin_recruitment_for(NEW.company_id) THEN
  RAISE EXCEPTION 'Only a recruitment administrator changes the careers page' USING ERRCODE = '42501';
 END IF;
 IF TG_OP = 'UPDATE' THEN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
   OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
   RAISE EXCEPTION 'A careers page keeps its company and creation record' USING ERRCODE = '23514';
  END IF;
 ELSE
  IF NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() THEN
   RAISE EXCEPTION 'Recorded by the current user' USING ERRCODE = '42501';
  END IF;
  NEW.created_at := now();
 END IF;
 IF NEW.updated_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'Recorded by the current user' USING ERRCODE = '42501';
 END IF;
 IF NEW.published AND NOT EXISTS (SELECT 1 FROM public.recruitment_careers_notice n
   WHERE n.company_id = NEW.company_id AND n.tenant_id = NEW.tenant_id) THEN
  RAISE EXCEPTION 'A careers page is published with a privacy notice' USING ERRCODE = '23514';
 END IF;
 NEW.updated_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_careers_site() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_careers_site_guard BEFORE INSERT OR UPDATE ON public.recruitment_careers_site
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_careers_site();
--> statement-breakpoint
-- A notice version: added by a recruitment administrator, numbered by the database, never changed; deleted only with the
-- company's recruitment setup (app.recruitment_delete_company_setup).
CREATE FUNCTION app.recruitment_guard_careers_notice() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF current_setting('app.recruitment_company_delete', true) IS DISTINCT FROM OLD.company_id::text THEN
   RAISE EXCEPTION 'A privacy notice version is kept unchanged' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP = 'UPDATE' THEN
  RAISE EXCEPTION 'A privacy notice version is kept unchanged' USING ERRCODE = '23514';
 END IF;
 IF NOT app.can_admin_recruitment_for(NEW.company_id) OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'Only a recruitment administrator changes the privacy notice' USING ERRCODE = '42501';
 END IF;
 -- One writer per company at a time: the next number is read after the lock, so two saves never collide.
 PERFORM pg_advisory_xact_lock(hashtextextended('recruitment-careers-notice:' || NEW.tenant_id::text || ':' || NEW.company_id::text, 0));
 NEW.version := coalesce((SELECT max(n.version) FROM public.recruitment_careers_notice n
  WHERE n.company_id = NEW.company_id AND n.tenant_id = NEW.tenant_id), 0) + 1;
 NEW.created_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_careers_notice() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_careers_notice_guard BEFORE INSERT OR UPDATE OR DELETE ON public.recruitment_careers_notice
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_careers_notice();
--> statement-breakpoint
-- The job flag: set or changed only by a recruitment administrator of the job's company. The posted moment follows the
-- flag (now when it is turned on, cleared when it is turned off) and is never written directly.
CREATE FUNCTION app.recruitment_guard_job_careers_page() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.show_on_careers_page AND NOT app.can_admin_recruitment_for(NEW.company_id) THEN
   RAISE EXCEPTION 'Only a recruitment administrator changes the careers page setting' USING ERRCODE = '42501';
  END IF;
  NEW.careers_posted_at := CASE WHEN NEW.show_on_careers_page THEN now() END;
  RETURN NEW;
 END IF;
 IF NEW.show_on_careers_page IS DISTINCT FROM OLD.show_on_careers_page THEN
  IF NOT app.can_admin_recruitment_for(NEW.company_id) THEN
   RAISE EXCEPTION 'Only a recruitment administrator changes the careers page setting' USING ERRCODE = '42501';
  END IF;
  NEW.careers_posted_at := CASE WHEN NEW.show_on_careers_page THEN now() END;
 ELSIF NEW.careers_posted_at IS DISTINCT FROM OLD.careers_posted_at THEN
  RAISE EXCEPTION 'The careers page date follows the careers page setting' USING ERRCODE = '42501';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_job_careers_page() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_job_opening_careers_page_guard BEFORE INSERT OR UPDATE OF show_on_careers_page, careers_posted_at
 ON public.recruitment_job_opening FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_job_careers_page();
--> statement-breakpoint
-- The careers application: written once by the submission; never deleted; changed only by the candidate's removal, and
-- then only to clear the message.
CREATE FUNCTION app.recruitment_guard_careers_application() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'A careers application record is kept' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'UPDATE' THEN
  IF app.recruitment_destroying(OLD.candidate_id) AND NEW.message IS NULL
   AND (to_jsonb(NEW) - 'message') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'message') THEN
   RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A careers application record is kept as it was received' USING ERRCODE = '42501';
 END IF;
 IF NOT app.recruitment_careers_open(NEW.tenant_id, NEW.company_id) THEN
  RAISE EXCEPTION 'Only the careers page records a careers application' USING ERRCODE = '42501';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.recruitment_application a WHERE a.id = NEW.application_id AND a.tenant_id = NEW.tenant_id
  AND a.job_id = NEW.job_id AND a.candidate_id = NEW.candidate_id) THEN
  RAISE EXCEPTION 'A careers application belongs to its application''s job and candidate' USING ERRCODE = '23514';
 END IF;
 NEW.received_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_careers_application() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_careers_application_guard BEFORE INSERT OR UPDATE OR DELETE ON public.recruitment_careers_application
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_careers_application();
--> statement-breakpoint
-- ── 6. The author guard: a row without a signed-in author is written only by the careers submission ──────────────
-- The author columns became nullable for the careers channel alone. Any other insert with a NULL author (or a careers
-- notice version on a consent) is refused; an update may not blank an author that was recorded.
CREATE FUNCTION app.recruitment_guard_careers_author() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE j jsonb := to_jsonb(NEW); anonymous boolean;
BEGIN
 IF TG_OP = 'UPDATE' THEN
  IF j->>'updated_by_user_id' IS NULL AND to_jsonb(OLD)->>'updated_by_user_id' IS NOT NULL THEN
   RAISE EXCEPTION 'A change records the signed-in user' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
 END IF;
 anonymous := CASE TG_TABLE_NAME
  WHEN 'recruitment_candidate' THEN j->>'created_by_user_id' IS NULL OR j->>'updated_by_user_id' IS NULL
  WHEN 'recruitment_application' THEN j->>'created_by_user_id' IS NULL OR j->>'updated_by_user_id' IS NULL
  WHEN 'recruitment_application_event' THEN j->>'actor_user_id' IS NULL
  WHEN 'recruitment_candidate_file' THEN j->>'uploaded_by_user_id' IS NULL
  WHEN 'recruitment_candidate_consent' THEN j->>'recorded_by_user_id' IS NULL OR j->>'careers_notice_version' IS NOT NULL
  ELSE true END;
 IF anonymous AND NOT app.recruitment_careers_open(NEW.tenant_id, NEW.company_id) THEN
  RAISE EXCEPTION 'Only the careers page records an application without a signed-in author' USING ERRCODE = '42501';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_careers_author() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_candidate_careers_author BEFORE INSERT OR UPDATE ON public.recruitment_candidate
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_careers_author();
CREATE TRIGGER recruitment_application_careers_author BEFORE INSERT OR UPDATE ON public.recruitment_application
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_careers_author();
CREATE TRIGGER recruitment_application_event_careers_author BEFORE INSERT ON public.recruitment_application_event
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_careers_author();
CREATE TRIGGER recruitment_candidate_file_careers_author BEFORE INSERT ON public.recruitment_candidate_file
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_careers_author();
CREATE TRIGGER recruitment_candidate_consent_careers_author BEFORE INSERT ON public.recruitment_candidate_consent
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_careers_author();
--> statement-breakpoint

-- ── 7. The public reads ──────────────────────────────────────────────────────────────────────────────────────────
-- The published site for an address, when its tenant has Recruitment (a tenant-wide grant, as for every HR screen) and
-- its company is not archived. Internal: only the careers functions call it.
CREATE FUNCTION app.recruitment_careers_site_at(p_address text) RETURNS public.recruitment_careers_site
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
DECLARE s public.recruitment_careers_site%ROWTYPE;
BEGIN
 IF p_address IS NULL OR char_length(p_address) NOT BETWEEN 3 AND 40 OR p_address !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' THEN RETURN NULL; END IF;
 SELECT * INTO s FROM public.recruitment_careers_site WHERE address = p_address AND published;
 IF NOT FOUND OR NOT app.recruitment_enabled_for(s.tenant_id)
  OR NOT EXISTS (SELECT 1 FROM public.company c WHERE c.id = s.company_id AND c.tenant_id = s.tenant_id AND c.archived_at IS NULL) THEN
  RETURN NULL;
 END IF;
 RETURN s;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_careers_site_at(text) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- The careers page: the company's own text, the filter choices, the matching count and one page of 30 jobs (newest put
-- on the page first). Search is a case-insensitive title substring; location and employment type are exact choices.
-- NULL for an unknown address, an unpublished page or a tenant without Recruitment — the caller shows one Not found.
CREATE FUNCTION app.recruitment_careers_page(p_address text, p_query text DEFAULT NULL, p_location text DEFAULT NULL,
 p_employment_type text DEFAULT NULL, p_page integer DEFAULT 1)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on SET lock_timeout = '3s' AS $$
DECLARE
 s public.recruitment_careers_site%ROWTYPE := app.recruitment_careers_site_at(p_address);
 v_query text := left(nullif(btrim(coalesce(p_query, '')), ''), 100);
 v_location text := left(nullif(btrim(coalesce(p_location, '')), ''), 200);
 v_type text := left(nullif(btrim(coalesce(p_employment_type, '')), ''), 40);
 v_page integer := greatest(1, least(coalesce(p_page, 1), 10000));
 result jsonb;
BEGIN
 IF s.company_id IS NULL THEN RETURN NULL; END IF;
 WITH public_jobs AS (
   SELECT j.id, j.title, j.job_number, j.employment_type, j.work_location, j.careers_posted_at FROM public.recruitment_job_opening j
   WHERE j.tenant_id = s.tenant_id AND j.company_id = s.company_id AND j.status = 'open' AND j.show_on_careers_page),
  matched AS (
   SELECT p.* FROM public_jobs p
   WHERE (v_query IS NULL OR strpos(lower(p.title), lower(v_query)) > 0)
    AND (v_location IS NULL OR p.work_location = v_location) AND (v_type IS NULL OR p.employment_type = v_type))
 SELECT jsonb_build_object(
   'displayName', s.display_name, 'headline', s.headline, 'introduction', s.introduction,
   'locations', coalesce((SELECT jsonb_agg(x.v ORDER BY x.v) FROM (SELECT DISTINCT p.work_location AS v FROM public_jobs p) x), '[]'::jsonb),
   'employmentTypes', coalesce((SELECT jsonb_agg(x.v ORDER BY x.v) FROM (SELECT DISTINCT p.employment_type AS v FROM public_jobs p) x), '[]'::jsonb),
   'total', (SELECT count(*) FROM matched), 'page', v_page, 'pageSize', 30,
   'jobs', coalesce((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'title', m.title, 'jobNumber', m.job_number, 'employmentType', m.employment_type,
     'workLocation', m.work_location, 'postedAt', m.careers_posted_at) ORDER BY m.careers_posted_at DESC, m.id)
    FROM (SELECT * FROM matched ORDER BY careers_posted_at DESC, id LIMIT 30 OFFSET (v_page - 1) * 30) m), '[]'::jsonb))
 INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_careers_page(text, text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_careers_page(text, text, text, text, integer) TO ai_hr_app;
--> statement-breakpoint
-- One public job: the company's display name, the job's public fields and description, and the current privacy notice
-- (version and text). NULL when the page or the job is not public (unknown, unpublished, hidden, not Open, another
-- company's) — the caller shows the same Not found for every one.
CREATE FUNCTION app.recruitment_careers_job(p_address text, p_job uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on SET lock_timeout = '3s' AS $$
DECLARE s public.recruitment_careers_site%ROWTYPE := app.recruitment_careers_site_at(p_address); result jsonb;
BEGIN
 IF s.company_id IS NULL OR p_job IS NULL THEN RETURN NULL; END IF;
 SELECT jsonb_build_object('displayName', s.display_name,
   'job', jsonb_build_object('id', j.id, 'title', j.title, 'jobNumber', j.job_number, 'employmentType', j.employment_type,
    'workLocation', j.work_location, 'postedAt', j.careers_posted_at, 'description', j.description),
   'notice', jsonb_build_object('version', n.version, 'body', n.body))
  INTO result
  FROM public.recruitment_job_opening j
  CROSS JOIN LATERAL (SELECT x.version, x.body FROM public.recruitment_careers_notice x
   WHERE x.company_id = s.company_id AND x.tenant_id = s.tenant_id ORDER BY x.version DESC LIMIT 1) n
  WHERE j.id = p_job AND j.tenant_id = s.tenant_id AND j.company_id = s.company_id AND j.status = 'open' AND j.show_on_careers_page;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_careers_job(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_careers_job(text, uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 8. The submission ────────────────────────────────────────────────────────────────────────────────────────────
-- One transaction. Returns {status}: 'received' (stored, a filled honeypot, or a repeated application — the visitor sees
-- the same thank-you for all three; the audit event names which for HR), 'not_found' (the page or job is not public),
-- 'notice_changed' (the consent was given to a notice version that is no longer the current one: nothing is stored and
-- the visitor must read the current notice and tick again), 'rate_limited' (5 submissions in the last hour from this
-- client hash) or 'company_limit' (300 stored today, Kuala Lumpur calendar, for the company). Malformed input — including
-- control characters other than line breaks in the message — raises 22023 (the server validates first). Only for an
-- anonymous request: a call inside a signed-in session is refused.
CREATE FUNCTION app.recruitment_careers_submit(p_address text, p_job uuid, p_client_hash text, p_full_name text, p_email text,
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
 RETURN jsonb_build_object('status', 'received');
END $$;
REVOKE ALL ON FUNCTION app.recruitment_careers_submit(text, uuid, text, text, text, text, text, integer, boolean, text, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_careers_submit(text, uuid, text, text, text, text, text, integer, boolean, text, text, bytea) TO ai_hr_app;
--> statement-breakpoint

-- The scheduled prune (deploy/internal-auth/aihr-recruitment-careers-prune.service, run as the owner): attempts older than two
-- days, so the client hashes go even when nobody submits. Returns how many were deleted. Owner-only.
CREATE FUNCTION app.recruitment_careers_prune() RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp SET lock_timeout = '10s' AS $$
DECLARE n integer;
BEGIN
 DELETE FROM app.recruitment_careers_attempt WHERE attempted_at < now() - interval '2 days';
 GET DIAGNOSTICS n = ROW_COUNT;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_careers_prune() FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- Has this client hash already made 5 submissions in the last hour? Read-only (the same count the submission makes), so
-- the server can answer 429 before it reads a request body. Takes a hash only; answers a boolean only.
CREATE FUNCTION app.recruitment_careers_client_limited(p_client_hash text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp SET lock_timeout = '3s' AS $$
 SELECT p_client_hash IS NOT NULL AND p_client_hash ~ '^[0-9a-f]{64}$' AND (SELECT count(*) FROM app.recruitment_careers_attempt a
  WHERE a.client_hash = p_client_hash AND a.attempted_at > now() - interval '1 hour') >= 5;
$$;
REVOKE ALL ON FUNCTION app.recruitment_careers_client_limited(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_careers_client_limited(text) TO ai_hr_app;
--> statement-breakpoint

-- ── 9. Removal: 4407's app.recruitment_destroy_candidate, byte for byte, plus the careers message ─────────────────
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
 SELECT coalesce(array_agg(o.id), '{}') INTO v_offers FROM public.recruitment_offer o WHERE o.application_id = ANY (v_apps) AND o.tenant_id = c.tenant_id;
 INSERT INTO app.recruitment_destroy_marker (txid, candidate_id, tenant_id) VALUES (txid_current(), c.id, c.tenant_id);

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
--> statement-breakpoint

-- ── 10. Deleting a company (core/company-refs.ts): 4405's body plus the careers notices and site ─────────────────
CREATE OR REPLACE FUNCTION app.recruitment_delete_company_setup(p_company uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE removed integer := 0; n integer;
BEGIN
 IF p_company IS NULL OR app.current_tenant_id() IS NULL OR NOT app.is_admin_for(p_company) THEN
  RAISE EXCEPTION 'Deleting a company''s recruitment setup needs its administrator' USING ERRCODE = '42501';
 END IF;
 IF EXISTS (SELECT 1 FROM public.recruitment_job_opening WHERE tenant_id = app.current_tenant_id() AND company_id = p_company)
  OR EXISTS (SELECT 1 FROM public.recruitment_candidate WHERE tenant_id = app.current_tenant_id() AND company_id = p_company)
  OR EXISTS (SELECT 1 FROM public.recruitment_requisition WHERE tenant_id = app.current_tenant_id() AND company_id = p_company) THEN
  RAISE EXCEPTION 'The company has recruitment history' USING ERRCODE = '23503';
 END IF;
 PERFORM set_config('app.recruitment_company_delete', p_company::text, true);
 DELETE FROM public.recruitment_tag WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_tag_group WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_approval_step WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_offer_field WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_company_setting WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 8: the careers page and its privacy notice versions (a consent that names a version needs a candidate, which
 -- refuses the delete as retained history above).
 DELETE FROM public.recruitment_careers_site WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_careers_notice WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_evaluation_form WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_archive_reason WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_process WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_stage WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 PERFORM set_config('app.recruitment_company_delete', '', true);
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_delete_company_setup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_delete_company_setup(uuid) TO ai_hr_app;
