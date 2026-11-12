-- Recruitment slice 5 (docs/recruitment-reconstruction/specification.md "Slice 5"): candidate records and privacy —
-- a fuller candidate profile, restricted values, resume files, duplicate detection, repeated-application control,
-- manual tags, and PDPA consent, retention and destruction.
--
-- What this installs:
--   1. Candidate profile columns (location, current company and title, highest education, notice period, source) and
--      the removal marker (destroyed_at / destroyed_by_user_id). Company settings: retention months without and with
--      consent (6 / 24) and the repeated-application window (3 months; 0 = off).
--   2. Seven company-scoped tables, each with tenant_id + company_id, ENABLE + FORCE row security, explicit GRANTs to
--      ai_hr_app and none to PUBLIC:
--        recruitment_candidate_restricted  salaries and the ID number, apart from the candidate row;
--        recruitment_candidate_entry       work experience and education entries;
--        recruitment_candidate_file        resumes and attachments (bytes in this side table, as employee_document);
--        recruitment_tag_group, recruitment_tag, recruitment_candidate_tag   manual tags;
--        recruitment_candidate_consent     the consent history, append-only.
--   3. Candidate predicates (plain STABLE SQL run as the caller):
--        app.recruitment_reads_candidate     — the caller may read one of the candidate's applications;
--        app.recruitment_reviews_candidate   — administrator, or reviewer (recruiter, assistant, hiring manager) of one of
--                                              the candidate's jobs;
--        app.recruitment_operates_candidate  — administrator, or operator (recruiter, assistant) of one of the candidate's
--                                              jobs. Restricted values, attachments and consent follow this one, so
--                                              hiring managers, interviewers, approvers and other companies never see them.
--   4. Duplicate detection without disclosure: app.recruitment_candidate_duplicate_count returns a COUNT only — the
--      caller learns that a possible duplicate exists, never who. Administrators read the matches through normal row
--      security. Match: the same ID number, or any two of email (case-insensitive), name (spacing and case normalised)
--      and mobile (digits only). The normalisers are ASCII case-folding so the answer never depends on the database
--      locale; packs/recruitment/privacy-model.ts mirrors them.
--   5. Repeated applications: 4401's one-application-per-job key is replaced by a guard that refuses a new application
--      to the same job while an earlier one is active, or closed within the company's window (Kuala Lumpur calendar).
--   6. Destruction: app.recruitment_destroy_candidate (SECURITY DEFINER, recruitment administrator only) removes the
--      candidate's personal data and keeps the application skeleton, so counts do not change. The guards that protect
--      feedback, offers and history are NOT loosened for anybody else: their one new branch admits only a write made
--      while app.recruitment_destroy_marker holds a row for THIS transaction and candidate — a private table only the
--      destroy function writes (no grant to the app role or PUBLIC) — and only to clear text. A candidate-level advisory
--      lock serialises the destruction against concurrent writes (exclusive) and the guards that read destroyed_at
--      (shared). Nothing is destroyed automatically.
--
-- Nothing here calls a model, parses a resume or infers anything about a candidate.

-- ── 1. Columns ────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.recruitment_candidate
 ADD COLUMN location text CHECK (location IS NULL OR length(btrim(location)) BETWEEN 1 AND 200),
 ADD COLUMN current_company text CHECK (current_company IS NULL OR length(btrim(current_company)) BETWEEN 1 AND 200),
 ADD COLUMN current_title text CHECK (current_title IS NULL OR length(btrim(current_title)) BETWEEN 1 AND 200),
 ADD COLUMN highest_education text CHECK (highest_education IN ('secondary','certificate','diploma','bachelor','master','doctorate','professional','other')),
 ADD COLUMN notice_period text CHECK (notice_period IS NULL OR length(btrim(notice_period)) BETWEEN 1 AND 60),
 ADD COLUMN source text CHECK (source IN ('referral','job_board','career_page','agency','walk_in','other')),
 ADD COLUMN destroyed_at timestamptz,
 ADD COLUMN destroyed_by_user_id uuid,
 ADD CONSTRAINT recruitment_candidate_destroyed_ck CHECK ((destroyed_at IS NULL) = (destroyed_by_user_id IS NULL)),
 ADD CONSTRAINT recruitment_candidate_destroyed_by_fk FOREIGN KEY (destroyed_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id);
--> statement-breakpoint
ALTER TABLE public.recruitment_company_setting
 ADD COLUMN retention_months_without_consent integer NOT NULL DEFAULT 6 CHECK (retention_months_without_consent BETWEEN 1 AND 120),
 ADD COLUMN retention_months_with_consent integer NOT NULL DEFAULT 24 CHECK (retention_months_with_consent BETWEEN 1 AND 120),
 ADD COLUMN repeat_window_months integer NOT NULL DEFAULT 3 CHECK (repeat_window_months IN (0, 1, 3, 6, 12));
--> statement-breakpoint
-- The repeated-application guard below replaces the one-application-per-job key.
ALTER TABLE public.recruitment_application DROP CONSTRAINT recruitment_application_once_uq;
CREATE INDEX recruitment_application_job_candidate_idx ON public.recruitment_application (job_id, candidate_id);
--> statement-breakpoint

-- ── 2. Normalisers (pure; ASCII case folding, independent of the database locale) ─────────────────────────
CREATE FUNCTION app.recruitment_norm_name(p text) RETURNS text
 LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
 SELECT nullif(translate(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g'), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '');
$$;
CREATE FUNCTION app.recruitment_norm_email(p text) RETURNS text
 LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
 SELECT nullif(translate(btrim(coalesce(p, '')), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '');
$$;
CREATE FUNCTION app.recruitment_norm_mobile(p text) RETURNS text
 LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
 SELECT nullif(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), '');
$$;
CREATE FUNCTION app.recruitment_norm_id(p text) RETURNS text
 LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
 SELECT nullif(translate(regexp_replace(coalesce(p, ''), '[^0-9A-Za-z]', '', 'g'), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), '');
$$;
GRANT EXECUTE ON FUNCTION app.recruitment_norm_name(text), app.recruitment_norm_email(text), app.recruitment_norm_mobile(text),
 app.recruitment_norm_id(text) TO ai_hr_app;
--> statement-breakpoint
CREATE INDEX recruitment_candidate_email_norm_idx ON public.recruitment_candidate (tenant_id, company_id, app.recruitment_norm_email(email)) WHERE email IS NOT NULL;
CREATE INDEX recruitment_candidate_mobile_norm_idx ON public.recruitment_candidate (tenant_id, company_id, app.recruitment_norm_mobile(phone)) WHERE phone IS NOT NULL;
CREATE INDEX recruitment_candidate_name_norm_idx ON public.recruitment_candidate (tenant_id, company_id, app.recruitment_norm_name(full_name));
--> statement-breakpoint

-- ── 3. Tables ─────────────────────────────────────────────────────────────────────────────────────────────
-- Restricted values: typed by people, never computed. One row per candidate.
CREATE TABLE public.recruitment_candidate_restricted (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 candidate_id uuid NOT NULL,
 current_salary_amount numeric(18,2) CHECK (current_salary_amount IS NULL OR current_salary_amount >= 0),
 current_salary_currency text CHECK (current_salary_currency IS NULL OR current_salary_currency ~ '^[A-Z]{3}$'),
 expected_salary_amount numeric(18,2) CHECK (expected_salary_amount IS NULL OR expected_salary_amount >= 0),
 expected_salary_currency text CHECK (expected_salary_currency IS NULL OR expected_salary_currency ~ '^[A-Z]{3}$'),
 id_type text CHECK (id_type IN ('nric','passport')),
 id_number text CHECK (id_number IS NULL OR length(btrim(id_number)) BETWEEN 1 AND 40),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_candidate_restricted_current_ck CHECK ((current_salary_amount IS NULL) = (current_salary_currency IS NULL)),
 CONSTRAINT recruitment_candidate_restricted_expected_ck CHECK ((expected_salary_amount IS NULL) = (expected_salary_currency IS NULL)),
 CONSTRAINT recruitment_candidate_restricted_id_ck CHECK ((id_number IS NULL) = (id_type IS NULL)),
 CONSTRAINT recruitment_candidate_restricted_candidate_fk FOREIGN KEY (candidate_id, company_id, tenant_id) REFERENCES public.recruitment_candidate(id, company_id, tenant_id),
 CONSTRAINT recruitment_candidate_restricted_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_candidate_restricted_candidate_uq UNIQUE (candidate_id)
);
CREATE INDEX recruitment_candidate_restricted_id_norm_idx ON public.recruitment_candidate_restricted (tenant_id, company_id, app.recruitment_norm_id(id_number)) WHERE id_number IS NOT NULL;
--> statement-breakpoint

-- Work experience and education. Months are stored as the first day of the month.
CREATE TABLE public.recruitment_candidate_entry (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 candidate_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('work','education')),
 organisation text NOT NULL CHECK (length(btrim(organisation)) BETWEEN 1 AND 200),
 title text CHECK (title IS NULL OR length(btrim(title)) BETWEEN 1 AND 200),
 from_month date CHECK (from_month IS NULL OR extract(day FROM from_month) = 1),
 to_month date CHECK (to_month IS NULL OR extract(day FROM to_month) = 1),
 is_current boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_candidate_entry_current_ck CHECK (NOT is_current OR (kind = 'work' AND to_month IS NULL)),
 CONSTRAINT recruitment_candidate_entry_range_ck CHECK (from_month IS NULL OR to_month IS NULL OR from_month <= to_month),
 CONSTRAINT recruitment_candidate_entry_candidate_fk FOREIGN KEY (candidate_id, company_id, tenant_id) REFERENCES public.recruitment_candidate(id, company_id, tenant_id),
 CONSTRAINT recruitment_candidate_entry_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
CREATE INDEX recruitment_candidate_entry_candidate_idx ON public.recruitment_candidate_entry (candidate_id, kind);
--> statement-breakpoint

-- Resumes and attachments: PDF, Word or image, at most 10 MB, with the uploader's confirmation that the candidate
-- permitted storing it. Bytes never leave this table except to an authorised download.
CREATE TABLE public.recruitment_candidate_file (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 candidate_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('resume','attachment')),
 file_name text NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 200),
 mime_type text NOT NULL CHECK (mime_type IN ('application/pdf','application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/jpeg','image/png')),
 size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
 content bytea NOT NULL,
 permission_confirmed boolean NOT NULL CHECK (permission_confirmed),
 uploaded_at timestamptz NOT NULL DEFAULT now(),
 uploaded_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_candidate_file_size_ck CHECK (octet_length(content) = size_bytes),
 CONSTRAINT recruitment_candidate_file_candidate_fk FOREIGN KEY (candidate_id, company_id, tenant_id) REFERENCES public.recruitment_candidate(id, company_id, tenant_id),
 CONSTRAINT recruitment_candidate_file_uploaded_by_fk FOREIGN KEY (uploaded_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
CREATE INDEX recruitment_candidate_file_candidate_idx ON public.recruitment_candidate_file (candidate_id, kind);
--> statement-breakpoint

-- Manual tags: company groups, tags unique within a group. A disabled tag stays on candidates but is not offered.
CREATE TABLE public.recruitment_tag_group (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
 enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_tag_group_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_tag_group_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_tag_group_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_tag_group_scope_uq UNIQUE (id, company_id, tenant_id)
);
CREATE UNIQUE INDEX recruitment_tag_group_name_uq ON public.recruitment_tag_group (tenant_id, company_id, lower(btrim(name)));
--> statement-breakpoint
CREATE TABLE public.recruitment_tag (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 group_id uuid NOT NULL,
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
 enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_tag_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_tag_group_fk FOREIGN KEY (group_id, company_id, tenant_id) REFERENCES public.recruitment_tag_group(id, company_id, tenant_id),
 CONSTRAINT recruitment_tag_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_tag_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_tag_scope_uq UNIQUE (id, company_id, tenant_id)
);
CREATE UNIQUE INDEX recruitment_tag_name_uq ON public.recruitment_tag (group_id, lower(btrim(name)));
CREATE INDEX recruitment_tag_company_idx ON public.recruitment_tag (tenant_id, company_id);
--> statement-breakpoint
CREATE TABLE public.recruitment_candidate_tag (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 candidate_id uuid NOT NULL,
 tag_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_candidate_tag_candidate_fk FOREIGN KEY (candidate_id, company_id, tenant_id) REFERENCES public.recruitment_candidate(id, company_id, tenant_id),
 CONSTRAINT recruitment_candidate_tag_tag_fk FOREIGN KEY (tag_id, company_id, tenant_id) REFERENCES public.recruitment_tag(id, company_id, tenant_id),
 CONSTRAINT recruitment_candidate_tag_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_candidate_tag_uq UNIQUE (candidate_id, tag_id)
);
CREATE INDEX recruitment_candidate_tag_tag_idx ON public.recruitment_candidate_tag (tag_id);
--> statement-breakpoint

-- Consent history, entered by a person. Append-only: the latest entry (by date, then recording time) is current.
CREATE TABLE public.recruitment_candidate_consent (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 candidate_id uuid NOT NULL,
 status text NOT NULL CHECK (status IN ('consented','withdrawn')),
 effective_on date NOT NULL,
 method text NOT NULL CHECK (method IN ('written_form','email','online_form','verbal')),
 notice_reference text CHECK (notice_reference IS NULL OR length(btrim(notice_reference)) BETWEEN 1 AND 200),
 recorded_at timestamptz NOT NULL DEFAULT now(),
 recorded_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_candidate_consent_candidate_fk FOREIGN KEY (candidate_id, company_id, tenant_id) REFERENCES public.recruitment_candidate(id, company_id, tenant_id),
 CONSTRAINT recruitment_candidate_consent_recorded_by_fk FOREIGN KEY (recorded_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
CREATE INDEX recruitment_candidate_consent_candidate_idx ON public.recruitment_candidate_consent (candidate_id, effective_on DESC, recorded_at DESC);
--> statement-breakpoint

-- ── 4. Candidate predicates ───────────────────────────────────────────────────────────────────────────────
-- Each reads recruitment_application under the caller's own row security, so it answers for the caller and nobody
-- else. No application policy reads a candidate table, so no policy below can recurse.
CREATE FUNCTION app.recruitment_reads_candidate(p_candidate uuid) RETURNS boolean
 LANGUAGE sql STABLE AS $$
 SELECT EXISTS (SELECT 1 FROM public.recruitment_application a WHERE a.candidate_id = p_candidate AND a.tenant_id = app.current_tenant_id());
$$;
--> statement-breakpoint
CREATE FUNCTION app.recruitment_reviews_candidate(p_company uuid, p_candidate uuid) RETURNS boolean
 LANGUAGE sql STABLE AS $$
 SELECT app.can_admin_recruitment_for(p_company) OR EXISTS (SELECT 1 FROM public.recruitment_application a
  WHERE a.candidate_id = p_candidate AND a.tenant_id = app.current_tenant_id()
   AND app.recruitment_has_job_role(a.job_id, ARRAY['recruiter','assistant','hiring_manager']));
$$;
--> statement-breakpoint
CREATE FUNCTION app.recruitment_operates_candidate(p_company uuid, p_candidate uuid) RETURNS boolean
 LANGUAGE sql STABLE AS $$
 SELECT app.can_admin_recruitment_for(p_company) OR EXISTS (SELECT 1 FROM public.recruitment_application a
  WHERE a.candidate_id = p_candidate AND a.tenant_id = app.current_tenant_id()
   AND app.recruitment_has_job_role(a.job_id, ARRAY['recruiter','assistant']));
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.recruitment_reads_candidate(uuid), app.recruitment_reviews_candidate(uuid, uuid),
 app.recruitment_operates_candidate(uuid, uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 5. Destruction ───────────────────────────────────────────────────────────────────────────────────────
-- The destroy marker: one row per (transaction, candidate) while app.recruitment_destroy_candidate runs, deleted before
-- it returns. No grant to ai_hr_app or PUBLIC, so the app role can neither write nor read it; row security is forced
-- and its only policy admits the table owner, the role the destroy function and app.recruitment_destroying run as.
-- Setting a GUC or any session value cannot open the destroy branches below: only a marker row can.
CREATE TABLE app.recruitment_destroy_marker (
 txid bigint NOT NULL,
 candidate_id uuid NOT NULL,
 tenant_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (txid, candidate_id)
);
ALTER TABLE app.recruitment_destroy_marker ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.recruitment_destroy_marker FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.recruitment_destroy_marker FROM PUBLIC, ai_hr_app;
CREATE POLICY recruitment_destroy_marker_owner ON app.recruitment_destroy_marker FOR ALL
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'app.recruitment_destroy_marker'::regclass)))
 WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'app.recruitment_destroy_marker'::regclass)));
--> statement-breakpoint
-- The candidate-level lock key: the destruction holds it exclusively; every guard that reads destroyed_at takes it
-- shared first, so a write racing a destruction either finishes before it (and is seen by its checks) or waits and
-- then finds the record removed.
CREATE FUNCTION app.recruitment_candidate_lock_key(p_tenant uuid, p_candidate uuid) RETURNS bigint
 LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog AS $$
 SELECT hashtextextended('recruitment-candidate:' || p_tenant::text || ':' || p_candidate::text, 0);
$$;
GRANT EXECUTE ON FUNCTION app.recruitment_candidate_lock_key(uuid, uuid) TO ai_hr_app;
--> statement-breakpoint
-- True only while app.recruitment_destroy_candidate is removing THIS candidate in THIS transaction.
CREATE FUNCTION app.recruitment_destroying(p_candidate uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
 SELECT p_candidate IS NOT NULL AND EXISTS (SELECT 1 FROM app.recruitment_destroy_marker m
  WHERE m.txid = txid_current() AND m.candidate_id = p_candidate);
$$;
REVOKE ALL ON FUNCTION app.recruitment_destroying(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_destroying(uuid) TO ai_hr_app;
CREATE FUNCTION app.recruitment_destroying_application(p_application uuid) RETURNS boolean
 LANGUAGE sql STABLE AS $$
 SELECT app.recruitment_destroying((SELECT a.candidate_id FROM public.recruitment_application a WHERE a.id = p_application));
$$;
GRANT EXECUTE ON FUNCTION app.recruitment_destroying_application(uuid) TO ai_hr_app;
--> statement-breakpoint

-- An administrator removes a due candidate's personal data. Refused for an active or hired application. The
-- application skeleton (job, stages, dates, state, archive reason) stays, so every count is unchanged. Returns
-- counts only. The caller (packs/recruitment) re-checks retention and appends the one domain event, which carries no
-- personal data. Runs as the owner with row security ON: each write still answers to the caller's recruitment
-- administration through the policies, plus the destroy-context policies below for feedback and approval text.
CREATE FUNCTION app.recruitment_destroy_candidate(p_candidate uuid) RETURNS jsonb
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

-- ── 6. Row security on the new tables ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_candidate_restricted','recruitment_candidate_entry','recruitment_candidate_file','recruitment_tag_group',
  'recruitment_tag','recruitment_candidate_tag','recruitment_candidate_consent'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, ai_hr_app', t);
 END LOOP;
END $$;
--> statement-breakpoint
-- Restricted values: administrators and the operators of one of the candidate's jobs; nobody else, ever.
CREATE POLICY recruitment_candidate_restricted_operator ON public.recruitment_candidate_restricted FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_operates_candidate(company_id, candidate_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.recruitment_operates_candidate(company_id, candidate_id));
-- Profile entries: read with the candidate; written by administrators and operators.
CREATE POLICY recruitment_candidate_entry_read ON public.recruitment_candidate_entry FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_reads_candidate(candidate_id));
CREATE POLICY recruitment_candidate_entry_write ON public.recruitment_candidate_entry FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_operates_candidate(company_id, candidate_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.recruitment_operates_candidate(company_id, candidate_id));
-- Files: the resume for anyone who may read one of the candidate's applications; other attachments for administrators
-- and operators. Uploaded and deleted by administrators and operators.
CREATE POLICY recruitment_candidate_file_read ON public.recruitment_candidate_file FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND ((kind = 'resume' AND app.recruitment_reads_candidate(candidate_id))
  OR app.recruitment_operates_candidate(company_id, candidate_id)));
CREATE POLICY recruitment_candidate_file_insert ON public.recruitment_candidate_file FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.recruitment_operates_candidate(company_id, candidate_id));
CREATE POLICY recruitment_candidate_file_delete ON public.recruitment_candidate_file FOR DELETE
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_operates_candidate(company_id, candidate_id));
-- Tags: administrators manage the catalogue; the company's job teams read it. A candidate's tags: reviewers read
-- them (hiring managers included, interviewers not); operators add and remove them.
CREATE POLICY recruitment_tag_group_admin ON public.recruitment_tag_group FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
CREATE POLICY recruitment_tag_group_team ON public.recruitment_tag_group FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_team_in_company(company_id));
CREATE POLICY recruitment_tag_admin ON public.recruitment_tag FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
CREATE POLICY recruitment_tag_team ON public.recruitment_tag FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_team_in_company(company_id));
CREATE POLICY recruitment_candidate_tag_read ON public.recruitment_candidate_tag FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_reviews_candidate(company_id, candidate_id));
CREATE POLICY recruitment_candidate_tag_insert ON public.recruitment_candidate_tag FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.recruitment_operates_candidate(company_id, candidate_id));
CREATE POLICY recruitment_candidate_tag_delete ON public.recruitment_candidate_tag FOR DELETE
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_operates_candidate(company_id, candidate_id));
-- Consent: administrators and operators read and record it; only the destruction removes it.
CREATE POLICY recruitment_candidate_consent_read ON public.recruitment_candidate_consent FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_operates_candidate(company_id, candidate_id));
CREATE POLICY recruitment_candidate_consent_insert ON public.recruitment_candidate_consent FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.recruitment_operates_candidate(company_id, candidate_id));
CREATE POLICY recruitment_candidate_consent_destroy ON public.recruitment_candidate_consent FOR DELETE
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_destroying(candidate_id));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.recruitment_candidate_restricted, public.recruitment_tag_group, public.recruitment_tag TO ai_hr_app;
GRANT SELECT, INSERT, DELETE ON public.recruitment_candidate_entry, public.recruitment_candidate_file, public.recruitment_candidate_tag TO ai_hr_app;
GRANT SELECT, INSERT ON public.recruitment_candidate_consent TO ai_hr_app;
--> statement-breakpoint

-- ── 7. Policies added to earlier tables ───────────────────────────────────────────────────────────────────
-- Operators of one of the candidate's jobs edit the candidate's profile (administrators already may, 4401).
CREATE POLICY recruitment_candidate_operator_update ON public.recruitment_candidate FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_operates_candidate(company_id, id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.recruitment_operates_candidate(company_id, id));
-- Duplicate detection reads across the company only inside its definer (the table owner), for a caller who adds
-- candidates there. The definer returns a count, never a row. Why a policy and not a bypass: both tables FORCE row
-- security, which binds the owner too, so without this policy the definer would see only what the caller already sees
-- and could not tell an operator that a match exists elsewhere in the company. The app role never satisfies it
-- (current_user is ai_hr_app, never the owner); the only owner-run code reading these tables is
-- app.recruitment_candidate_duplicate_count (a count) and app.recruitment_destroy_candidate (an administrator's own
-- company). A per-call marker is not possible here: the count is a read-only STABLE function and writes nothing.
CREATE POLICY recruitment_candidate_duplicate_probe ON public.recruitment_candidate FOR SELECT
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_candidate'::regclass))
  AND tenant_id = app.current_tenant_id() AND app.recruitment_operates_in_company(company_id));
CREATE POLICY recruitment_candidate_restricted_duplicate_probe ON public.recruitment_candidate_restricted FOR SELECT
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_candidate_restricted'::regclass))
  AND tenant_id = app.current_tenant_id() AND app.recruitment_operates_in_company(company_id));
-- Destruction clears feedback text and approval comments, which nobody else may rewrite.
CREATE POLICY recruitment_scorecard_destroy ON public.recruitment_scorecard FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_destroying_application(application_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.recruitment_destroying_application(application_id));
CREATE POLICY recruitment_offer_approval_destroy ON public.recruitment_offer_approval FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_destroying_application(
  (SELECT o.application_id FROM public.recruitment_offer o WHERE o.id = recruitment_offer_approval.offer_id)))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.recruitment_destroying_application(
  (SELECT o.application_id FROM public.recruitment_offer o WHERE o.id = recruitment_offer_approval.offer_id)));
--> statement-breakpoint

-- ── 8. Duplicate detection without disclosure ─────────────────────────────────────────────────────────────
-- How many live candidates of the company match: the same ID number, or at least two of email, name and mobile.
-- Only for a caller who may add candidates there (an administrator or a job operator); the answer is a number.
CREATE FUNCTION app.recruitment_candidate_duplicate_count(p_company uuid, p_full_name text, p_email text, p_mobile text, p_id_number text, p_exclude uuid)
RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
DECLARE n integer; v_name text := app.recruitment_norm_name(p_full_name); v_email text := app.recruitment_norm_email(p_email);
 v_mobile text := app.recruitment_norm_mobile(p_mobile); v_id text := app.recruitment_norm_id(p_id_number);
BEGIN
 IF p_company IS NULL OR app.current_tenant_id() IS NULL OR NOT app.recruitment_operates_in_company(p_company) THEN
  RAISE EXCEPTION 'Checking for duplicate candidates needs recruitment access to the company' USING ERRCODE = '42501';
 END IF;
 -- Indexed equality lookups only (one per item, each on its own expression index), never a company-wide scan.
 SELECT count(*)::integer INTO n FROM (
  SELECT h.candidate_id FROM (
    SELECT r.candidate_id, 'id'::text AS kind FROM public.recruitment_candidate_restricted r
     WHERE v_id IS NOT NULL AND r.tenant_id = app.current_tenant_id() AND r.company_id = p_company AND r.id_number IS NOT NULL
      AND app.recruitment_norm_id(r.id_number) = v_id
    UNION ALL
    SELECT c.id, 'email' FROM public.recruitment_candidate c
     WHERE v_email IS NOT NULL AND c.tenant_id = app.current_tenant_id() AND c.company_id = p_company AND c.email IS NOT NULL
      AND app.recruitment_norm_email(c.email) = v_email
    UNION ALL
    SELECT c.id, 'name' FROM public.recruitment_candidate c
     WHERE v_name IS NOT NULL AND c.tenant_id = app.current_tenant_id() AND c.company_id = p_company
      AND app.recruitment_norm_name(c.full_name) = v_name
    UNION ALL
    SELECT c.id, 'mobile' FROM public.recruitment_candidate c
     WHERE v_mobile IS NOT NULL AND c.tenant_id = app.current_tenant_id() AND c.company_id = p_company AND c.phone IS NOT NULL
      AND app.recruitment_norm_mobile(c.phone) = v_mobile
   ) h
   JOIN public.recruitment_candidate x ON x.id = h.candidate_id AND x.destroyed_at IS NULL AND (p_exclude IS NULL OR x.id <> p_exclude)
   GROUP BY h.candidate_id
   HAVING bool_or(h.kind = 'id') OR count(DISTINCT h.kind) >= 2) matched;
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_candidate_duplicate_count(uuid, text, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_candidate_duplicate_count(uuid, text, text, text, text, uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 9. Guards on the new tables ───────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_candidate_restricted','recruitment_tag_group','recruitment_tag'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_identity()', t || '_identity', t);
 END LOOP;
END $$;
--> statement-breakpoint
-- A removed candidate's record is closed: nothing new is attached to it. Writers are recorded as the current user.
CREATE FUNCTION app.recruitment_guard_candidate_child() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF TG_TABLE_NAME = 'recruitment_candidate_consent' AND NOT app.recruitment_destroying(OLD.candidate_id) THEN
   RAISE EXCEPTION 'The consent history is kept' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'recruitment_candidate_consent' THEN
  RAISE EXCEPTION 'The consent history is kept' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'UPDATE' AND NEW.candidate_id IS DISTINCT FROM OLD.candidate_id THEN
  RAISE EXCEPTION 'A candidate record keeps its candidate' USING ERRCODE = '23514';
 END IF;
 PERFORM pg_advisory_xact_lock_shared(app.recruitment_candidate_lock_key(NEW.tenant_id, NEW.candidate_id));
 IF EXISTS (SELECT 1 FROM public.recruitment_candidate c WHERE c.id = NEW.candidate_id AND c.destroyed_at IS NOT NULL) THEN
  RAISE EXCEPTION 'This candidate''s personal data has been removed' USING ERRCODE = '23514';
 END IF;
 v_user := app.current_user_id();
 IF TG_TABLE_NAME = 'recruitment_candidate_restricted' THEN
  NEW.updated_by_user_id := v_user; NEW.updated_at := now();
 ELSIF TG_TABLE_NAME = 'recruitment_candidate_entry' THEN
  IF NEW.created_by_user_id IS DISTINCT FROM v_user THEN RAISE EXCEPTION 'Recorded by the current user' USING ERRCODE = '42501'; END IF;
 ELSIF TG_TABLE_NAME = 'recruitment_candidate_file' THEN
  IF NEW.uploaded_by_user_id IS DISTINCT FROM v_user THEN RAISE EXCEPTION 'Uploaded by the current user' USING ERRCODE = '42501'; END IF;
  NEW.uploaded_at := now();
 ELSIF TG_TABLE_NAME = 'recruitment_candidate_tag' THEN
  IF NEW.created_by_user_id IS DISTINCT FROM v_user THEN RAISE EXCEPTION 'Recorded by the current user' USING ERRCODE = '42501'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.recruitment_tag g WHERE g.id = NEW.tag_id AND g.enabled
   AND EXISTS (SELECT 1 FROM public.recruitment_tag_group p WHERE p.id = g.group_id AND p.enabled)) THEN
   RAISE EXCEPTION 'Choose an enabled tag' USING ERRCODE = '23514';
  END IF;
 ELSIF TG_TABLE_NAME = 'recruitment_candidate_consent' THEN
  IF NEW.recorded_by_user_id IS DISTINCT FROM v_user THEN RAISE EXCEPTION 'Recorded by the current user' USING ERRCODE = '42501'; END IF;
  IF NEW.effective_on > (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN
   RAISE EXCEPTION 'A consent date cannot be in the future' USING ERRCODE = '23514';
  END IF;
  NEW.recorded_at := clock_timestamp();
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_candidate_child() FROM PUBLIC, ai_hr_app;
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_candidate_restricted','recruitment_candidate_entry','recruitment_candidate_file','recruitment_candidate_tag',
  'recruitment_candidate_consent'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_candidate_child()', t || '_guard', t);
 END LOOP;
END $$;
--> statement-breakpoint
-- The candidate row: a removed record is closed, and only the destruction marks one removed.
CREATE FUNCTION app.recruitment_guard_candidate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF app.recruitment_destroying(OLD.id) THEN
  -- Clear-only: personal columns blanked, the neutral label, the removal stamp; nothing else moves.
  IF (to_jsonb(NEW) - ARRAY['full_name','email','phone','location','current_company','current_title','highest_education','notice_period',
       'source','destroyed_at','destroyed_by_user_id','updated_at','updated_by_user_id'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['full_name','email','phone','location','current_company','current_title','highest_education',
       'notice_period','source','destroyed_at','destroyed_by_user_id','updated_at','updated_by_user_id'])
   OR num_nonnulls(NEW.email, NEW.phone, NEW.location, NEW.current_company, NEW.current_title, NEW.highest_education, NEW.notice_period, NEW.source) > 0
   OR NEW.full_name IS DISTINCT FROM 'Removed candidate ' || upper(substr(replace(OLD.id::text, '-', ''), 1, 8))
   OR NEW.destroyed_at IS NULL OR NEW.destroyed_by_user_id IS DISTINCT FROM app.current_user_id() OR OLD.destroyed_at IS NOT NULL THEN
   RAISE EXCEPTION 'Removing a candidate''s personal data only clears it' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
 END IF;
 PERFORM pg_advisory_xact_lock_shared(app.recruitment_candidate_lock_key(OLD.tenant_id, OLD.id));
 IF OLD.destroyed_at IS NOT NULL THEN
  RAISE EXCEPTION 'This candidate''s personal data has been removed' USING ERRCODE = '23514';
 END IF;
 IF NEW.destroyed_at IS NOT NULL OR NEW.destroyed_by_user_id IS NOT NULL THEN
  RAISE EXCEPTION 'Only the removal service removes a candidate''s personal data' USING ERRCODE = '42501';
 END IF;
 IF NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
  RAISE EXCEPTION 'A candidate keeps their creation record' USING ERRCODE = '23514';
 END IF;
 NEW.updated_by_user_id := coalesce(app.current_user_id(), NEW.updated_by_user_id);
 NEW.updated_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_candidate() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_candidate_guard BEFORE UPDATE ON public.recruitment_candidate
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_candidate();
--> statement-breakpoint
-- Repeated applications: a new application by the same candidate to the same job is refused while an earlier one is
-- active, or closed (archived or hired) within the company's window — Kuala Lumpur calendar months, month-end clamped
-- like lib/hr-date addCalendarMonths. A window of 0 switches the closed-application rule off. HIRED counts as closed on
-- purpose: someone hired for the job should not re-apply to that same job within the window. A removed candidate takes
-- no new application. Serialised per candidate and job, and against the candidate's destruction.
CREATE FUNCTION app.recruitment_guard_repeat_application() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE months integer; today date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
 PERFORM pg_advisory_xact_lock_shared(app.recruitment_candidate_lock_key(NEW.tenant_id, NEW.candidate_id));
 IF EXISTS (SELECT 1 FROM public.recruitment_candidate c WHERE c.id = NEW.candidate_id AND c.destroyed_at IS NOT NULL) THEN
  RAISE EXCEPTION 'This candidate''s personal data has been removed' USING ERRCODE = '23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('recruitment-application:' || NEW.tenant_id::text || ':' || NEW.candidate_id::text || ':' || NEW.job_id::text, 0));
 months := coalesce((SELECT s.repeat_window_months FROM public.recruitment_company_setting s
  WHERE s.company_id = NEW.company_id AND s.tenant_id = NEW.tenant_id), 3);
 IF EXISTS (SELECT 1 FROM public.recruitment_application a
  WHERE a.tenant_id = NEW.tenant_id AND a.candidate_id = NEW.candidate_id AND a.job_id = NEW.job_id AND a.id <> NEW.id
   AND (a.state = 'active' OR (months > 0
    AND ((a.state_changed_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date + make_interval(months => months))::date > today))) THEN
  RAISE EXCEPTION 'The candidate has a current or recent application to this job' USING ERRCODE = '23505';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_repeat_application() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_application_repeat_guard BEFORE INSERT ON public.recruitment_application
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_repeat_application();
--> statement-breakpoint
-- Tags: a group and a tag keep their company and group.
CREATE FUNCTION app.recruitment_guard_tag() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME = 'recruitment_tag' AND NEW.group_id IS DISTINCT FROM OLD.group_id THEN
  RAISE EXCEPTION 'A tag keeps its group' USING ERRCODE = '23514';
 END IF;
 IF NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
  RAISE EXCEPTION 'A tag keeps its creation record' USING ERRCODE = '23514';
 END IF;
 NEW.updated_by_user_id := coalesce(app.current_user_id(), NEW.updated_by_user_id);
 NEW.updated_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_tag() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_tag_group_guard BEFORE UPDATE ON public.recruitment_tag_group FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_tag();
CREATE TRIGGER recruitment_tag_guard BEFORE UPDATE ON public.recruitment_tag FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_tag();
--> statement-breakpoint

-- ── 10. Earlier guards, restated with ONE destroy-context branch each ─────────────────────────────────────
-- Each body below is its latest definition (4401 / 4402 / 4403) byte for byte, plus a first branch that admits only
-- app.recruitment_destroy_candidate (app.recruitment_destroying: a marker row for this transaction and candidate, which
-- only that function can write) and only to CLEAR text. Every other caller meets exactly the guard it met before.

-- 4401 application guard + clearing a closed application's free-text source.
CREATE OR REPLACE FUNCTION app.recruitment_guard_application() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND app.recruitment_destroying(OLD.candidate_id) THEN
  IF (to_jsonb(NEW) - 'source') IS DISTINCT FROM (to_jsonb(OLD) - 'source') OR NEW.source IS NOT NULL THEN
   RAISE EXCEPTION 'Removing a candidate''s personal data keeps the application skeleton' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
 END IF;
 IF NOT EXISTS (
  SELECT 1 FROM public.recruitment_job_opening j
  JOIN public.recruitment_process_stage ps ON ps.process_id = j.process_id AND ps.tenant_id = j.tenant_id
  WHERE j.id = NEW.job_id AND j.tenant_id = NEW.tenant_id AND ps.stage_id = NEW.current_stage_id) THEN
  RAISE EXCEPTION 'The stage is not part of this job''s recruitment process' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'INSERT' THEN
  IF NEW.state <> 'active' THEN RAISE EXCEPTION 'A new application starts active' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
  OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.candidate_id IS DISTINCT FROM OLD.candidate_id
  OR NEW.applied_at IS DISTINCT FROM OLD.applied_at OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
  RAISE EXCEPTION 'An application keeps its job, candidate and company' USING ERRCODE = '23514';
 END IF;
 IF OLD.state <> 'active' THEN
  RAISE EXCEPTION 'A hired or archived application is closed' USING ERRCODE = '23514';
 END IF;
 IF NEW.state = 'archived' AND NEW.stage_left_at_archive IS DISTINCT FROM OLD.current_stage_id THEN
  RAISE EXCEPTION 'An archived application records the stage it left' USING ERRCODE = '23514';
 END IF;
 IF NEW.state <> 'active' AND NEW.current_stage_id IS DISTINCT FROM OLD.current_stage_id THEN
  RAISE EXCEPTION 'Hiring or archiving keeps the current stage' USING ERRCODE = '23514';
 END IF;
 IF NEW.state IS DISTINCT FROM OLD.state THEN NEW.state_changed_at := now(); END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
-- 4402 scorecard guard + clearing notes and the overview (ratings stay).
CREATE OR REPLACE FUNCTION app.recruitment_guard_scorecard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE i public.recruitment_interview%ROWTYPE; a public.recruitment_application%ROWTYPE; lock text; cur integer; was integer;
BEGIN
 IF TG_OP = 'UPDATE' AND app.recruitment_destroying_application(OLD.application_id) THEN
  -- Only notes and the overview are cleared: every rating and the result stay exactly as given.
  IF (to_jsonb(NEW) - ARRAY['ratings','overview']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['ratings','overview']) OR NEW.overview IS NOT NULL
   OR NEW.ratings IS DISTINCT FROM (SELECT coalesce(jsonb_object_agg(e.key, CASE WHEN jsonb_typeof(e.value) = 'object' THEN e.value - 'notes' ELSE e.value END), '{}'::jsonb)
    FROM jsonb_each(OLD.ratings) e) THEN
   RAISE EXCEPTION 'Removing a candidate''s personal data clears feedback text only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'Interview feedback is never deleted' USING ERRCODE = '23514';
 END IF;
 IF NEW.interviewer_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'Only the interviewer writes their own feedback' USING ERRCODE = '42501';
 END IF;
 SELECT * INTO i FROM public.recruitment_interview WHERE id = NEW.interview_id AND tenant_id = NEW.tenant_id;
 IF NOT FOUND OR i.cancelled_at IS NOT NULL THEN
  RAISE EXCEPTION 'Feedback is given on an open interview' USING ERRCODE = '23514';
 END IF;
 IF NEW.evaluation_form_id IS DISTINCT FROM i.evaluation_form_id THEN
  RAISE EXCEPTION 'Feedback uses the interview''s evaluation form' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'INSERT' THEN
  NEW.submitted_at := now(); NEW.updated_at := now();
  RETURN NEW;
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
  OR NEW.application_id IS DISTINCT FROM OLD.application_id OR NEW.interview_id IS DISTINCT FROM OLD.interview_id
  OR NEW.interviewer_user_id IS DISTINCT FROM OLD.interviewer_user_id OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
  RAISE EXCEPTION 'Feedback keeps its interview and interviewer' USING ERRCODE = '23514';
 END IF;
 SELECT * INTO a FROM public.recruitment_application WHERE id = NEW.application_id AND tenant_id = NEW.tenant_id;
 lock := coalesce((SELECT s.feedback_edit_lock FROM public.recruitment_company_setting s WHERE s.company_id = NEW.company_id), 'until_stage_left');
 IF lock = 'until_archived' AND a.state = 'archived' THEN
  RAISE EXCEPTION 'Feedback is locked once the application is archived' USING ERRCODE = '23514';
 END IF;
 IF lock = 'until_stage_left' THEN
  SELECT ps.position INTO cur FROM public.recruitment_job_opening j JOIN public.recruitment_process_stage ps ON ps.process_id = j.process_id
   WHERE j.id = a.job_id AND ps.stage_id = a.current_stage_id;
  SELECT ps.position INTO was FROM public.recruitment_job_opening j JOIN public.recruitment_process_stage ps ON ps.process_id = j.process_id
   WHERE j.id = a.job_id AND ps.stage_id = i.stage_id;
  IF a.state <> 'active' OR (a.current_stage_id IS DISTINCT FROM i.stage_id AND (cur IS NULL OR was IS NULL OR cur > was)) THEN
   RAISE EXCEPTION 'Feedback is locked once the application leaves the interview''s stage' USING ERRCODE = '23514';
  END IF;
 END IF;
 NEW.updated_at := now();
 RETURN NEW;
END $$;
--> statement-breakpoint
-- 4403 offer guard + clearing the last rejection comment of a closed offer.
CREATE OR REPLACE FUNCTION app.recruitment_guard_offer() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_operator boolean; v_flow uuid[]; v_ok boolean;
BEGIN
 IF TG_OP = 'UPDATE' AND app.recruitment_destroying_application(OLD.application_id) THEN
  IF (to_jsonb(NEW) - 'last_rejection_comment') IS DISTINCT FROM (to_jsonb(OLD) - 'last_rejection_comment') OR NEW.last_rejection_comment IS NOT NULL THEN
   RAISE EXCEPTION 'Removing a candidate''s personal data clears offer text only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP = 'INSERT' THEN
  IF NEW.status <> 'draft' OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() OR NEW.sent_at IS NOT NULL
   OR NEW.candidate_decision <> 'pending' OR NEW.approval_round <> 0 THEN
   RAISE EXCEPTION 'An offer starts as a draft by the current user' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.recruitment_application a WHERE a.id = NEW.application_id AND a.state = 'active') THEN
   RAISE EXCEPTION 'Offers are made to active applications only' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
  OR NEW.application_id IS DISTINCT FROM OLD.application_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
  OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
  RAISE EXCEPTION 'An offer keeps its application and creator' USING ERRCODE = '23514';
 END IF;
 IF OLD.candidate_decision <> 'pending' THEN
  RAISE EXCEPTION 'The candidate has decided; the offer is closed' USING ERRCODE = '23514';
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT ((OLD.status, NEW.status) IN
  (('draft','pending'),('pending','approved'),('pending','draft'),('approved','draft'),('approved','pending'),('draft','approved'))) THEN
  RAISE EXCEPTION 'Offer status cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
 END IF;
 -- The approval state (status, round, approvers, pending step) moves ONLY along the service's own transitions, for
 -- every caller, so no direct write can approve an offer without its approvers:
 --   start a round  (operator): draft/approved → pending, round + 1, step 1, approvers = the company's offer flow;
 --   empty flow     (operator): draft → approved with no approvers, when the company's offer flow is empty;
 --   decide         (the pending step's approver, after logging their own decision on it): approved → next step, or
 --                  approved after the last; rejected → draft;
 --   withdraw / re-approval reset (operator): pending/approved → draft, same round and approvers.
 v_operator := app.can_operate_recruitment_job(NEW.company_id, NEW.job_id);
 IF (NEW.status, NEW.approval_round, NEW.approver_user_ids, NEW.pending_position)
    IS DISTINCT FROM (OLD.status, OLD.approval_round, OLD.approver_user_ids, OLD.pending_position) THEN
  SELECT coalesce(array_agg(st.approver_user_id ORDER BY st.position), '{}') INTO v_flow FROM public.recruitment_approval_step st
   WHERE st.tenant_id = NEW.tenant_id AND st.company_id = NEW.company_id AND st.flow_kind = 'offer';
  IF NEW.status = 'pending' AND OLD.status IN ('draft','approved') THEN
   v_ok := v_operator AND NEW.approval_round = OLD.approval_round + 1 AND NEW.pending_position = 1
    AND NEW.approver_user_ids = v_flow AND cardinality(v_flow) > 0 AND NOT (NEW.created_by_user_id = ANY (NEW.approver_user_ids));
  ELSIF NEW.status = 'approved' AND OLD.status = 'draft' THEN
   v_ok := v_operator AND cardinality(v_flow) = 0 AND cardinality(NEW.approver_user_ids) = 0 AND NEW.approval_round = OLD.approval_round;
  ELSIF OLD.status = 'pending' AND NEW.approval_round = OLD.approval_round AND NEW.approver_user_ids = OLD.approver_user_ids
   AND OLD.approver_user_ids[OLD.pending_position] = app.current_user_id() AND EXISTS (
    SELECT 1 FROM public.recruitment_offer_approval d WHERE d.offer_id = OLD.id AND d.tenant_id = OLD.tenant_id
     AND d.round = OLD.approval_round AND d.position = OLD.pending_position AND d.approver_user_id = app.current_user_id()
     AND ((d.decision = 'approved' AND ((NEW.status = 'pending' AND NEW.pending_position = OLD.pending_position + 1)
       OR (NEW.status = 'approved' AND OLD.pending_position = cardinality(OLD.approver_user_ids))))
      OR (d.decision = 'rejected' AND NEW.status = 'draft'))) THEN
   v_ok := true;
  ELSIF NEW.status = 'draft' AND OLD.status IN ('pending','approved') THEN
   v_ok := v_operator AND NEW.approval_round = OLD.approval_round AND NEW.approver_user_ids = OLD.approver_user_ids;
  ELSE
   v_ok := false;
  END IF;
  IF NOT v_ok THEN
   RAISE EXCEPTION 'Offer approval cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '42501';
  END IF;
 END IF;
 -- An approver who does not operate the job changes nothing but the approval state and the rejection comment.
 IF NOT v_operator AND (to_jsonb(NEW) - ARRAY['status','pending_position','last_rejection_comment','updated_at','updated_by_user_id'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','pending_position','last_rejection_comment','updated_at','updated_by_user_id']) THEN
  RAISE EXCEPTION 'An approver only decides their own step' USING ERRCODE = '42501';
 END IF;
 IF NEW.approval_round < OLD.approval_round THEN
  RAISE EXCEPTION 'The approval round only moves forward' USING ERRCODE = '23514';
 END IF;
 IF NEW.sent_at IS NOT NULL AND OLD.sent_at IS NULL AND NEW.sent_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'Sending is recorded by the current user' USING ERRCODE = '42501';
 END IF;
 IF NEW.candidate_decision <> 'pending' AND NEW.decided_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'The candidate decision is recorded by the current user' USING ERRCODE = '42501';
 END IF;
 NEW.updated_by_user_id := coalesce(app.current_user_id(), NEW.updated_by_user_id);
 NEW.updated_at := now();
 RETURN NEW;
END $$;
--> statement-breakpoint
-- 4403 offer value guard + deleting a closed offer's values.
CREATE OR REPLACE FUNCTION app.recruitment_guard_offer_value() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_offer uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.offer_id ELSE NEW.offer_id END;
BEGIN
 IF TG_OP = 'DELETE' AND app.recruitment_destroying_application((SELECT o.application_id FROM public.recruitment_offer o WHERE o.id = OLD.offer_id)) THEN
  RETURN OLD;
 END IF;
 IF EXISTS (SELECT 1 FROM public.recruitment_offer o WHERE o.id = v_offer AND o.candidate_decision <> 'pending') THEN
  RAISE EXCEPTION 'The candidate has decided; the offer is closed' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 NEW.updated_by_user_id := app.current_user_id();
 NEW.updated_at := now();
 RETURN NEW;
END $$;
--> statement-breakpoint
-- 4403 offer decision guard + replacing a decided step's comment with a neutral mark (a rejection keeps one).
CREATE OR REPLACE FUNCTION app.recruitment_guard_offer_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE o public.recruitment_offer%ROWTYPE;
BEGIN
 IF TG_OP = 'UPDATE' AND app.recruitment_destroying_application((SELECT x.application_id FROM public.recruitment_offer x WHERE x.id = OLD.offer_id)) THEN
  IF (to_jsonb(NEW) - 'comment') IS DISTINCT FROM (to_jsonb(OLD) - 'comment')
   OR NEW.comment IS DISTINCT FROM (CASE WHEN OLD.decision = 'rejected' THEN '—' ELSE NULL END) THEN
   RAISE EXCEPTION 'Removing a candidate''s personal data clears approval comments only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP <> 'INSERT' THEN
  RAISE EXCEPTION 'An approval decision is final' USING ERRCODE = '23514';
 END IF;
 SELECT * INTO o FROM public.recruitment_offer WHERE id = NEW.offer_id AND tenant_id = NEW.tenant_id;
 IF NOT FOUND OR o.status <> 'pending' OR NEW.round <> o.approval_round OR NEW.position IS DISTINCT FROM o.pending_position
  OR NEW.approver_user_id IS DISTINCT FROM o.approver_user_ids[o.pending_position] OR NEW.approver_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'Only the approver of the pending step may decide it' USING ERRCODE = '42501';
 END IF;
 IF o.created_by_user_id = app.current_user_id() THEN
  RAISE EXCEPTION 'The creator of an offer cannot approve it' USING ERRCODE = '42501';
 END IF;
 NEW.acted_at := now();
 RETURN NEW;
END $$;
--> statement-breakpoint

-- ── 11. Deleting a company (core/company-refs.ts) ─────────────────────────────────────────────────────────
-- Restated with the tag catalogue removed first (tags before their groups). A candidate's tags need a candidate, which
-- refuses the delete as retained history before this runs.
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
