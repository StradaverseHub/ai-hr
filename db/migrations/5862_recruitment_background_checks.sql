-- Recruitment slice 12 (docs/recruitment-reconstruction/specification.md "Slice 12"): background checks.
--
-- HR records background checks that a provider runs OUTSIDE AI HR (no provider connection, D-043). A check starts as
-- Awaiting authorisation and moves to In progress only after the candidate's written authorisation is recorded (D-044); it
-- ends Completed (with a structured outcome: Clear, Concerns found or Could not verify) or Cancelled (with a reason), and
-- both are final (a new check can be added). The summary, provider, provider reference, authorisation, cancellation reason
-- and files are for the people who run the check only; the job's hiring managers see each check's types, status, outcome
-- and dates (D-045). Offers and the hire hand-off do not wait for checks, and nothing is copied to an employee (D-046).
--
-- What this installs:
--   1. Five tables, each with tenant_id + company_id, ENABLE + FORCE row security, explicit GRANTs to ai_hr_app and none to
--      PUBLIC:
--        recruitment_background_check_type       the company's check types (administrators write; the company's job teams
--                                                read the names). A type in use cannot be deleted (the link's foreign key
--                                                refuses); it can be disabled.
--        recruitment_background_check            one check on one application: status, outcome, who recorded it and the
--                                                status dates. Readable by the job's reviewers (administrators, recruiter,
--                                                assistants, hiring managers); written by its operators and administrators.
--        recruitment_background_check_type_link  the types of a check, fixed when it is added (same readers as the check).
--        recruitment_background_check_detail     RESTRICTED, one row per check: provider, provider reference, the
--                                                authorisation (date, method, who recorded it and when), the summary and the
--                                                cancellation reason. Its ONLY non-owner policies admit the job's operators
--                                                and administrators, so a hiring manager's, interviewer's or anybody else's
--                                                direct SELECT returns no row.
--        recruitment_background_check_file       RESTRICTED: the authorisation file and the report (bytes, name, type, size,
--                                                the uploader's confirmation), at most one of each per check; same policies.
--   2. Guards (run as the caller): writers are the current user; ids, application and recorder never change. A check is
--      added Awaiting authorisation by an operator or administrator of the job, only on an ACTIVE application whose current
--      stage passes app.recruitment_background_check_stage_ok (an Offer-type stage; at or after the first Offer-type stage of
--      the job's process; or the company's seeded Background check stage, by its seed key — never by an editable name). Its types are attached in the
--      same transaction by the same user, enabled ones only. Status moves only Awaiting authorisation → In progress (needs the
--      recorded authorisation) → Completed (needs an outcome), or → Cancelled (needs the reason) from either open state;
--      Completed and Cancelled are final, and so are their details and files. The authorisation is recorded once, while
--      awaiting, dated no later than today in Kuala Lumpur; the authorisation file only while awaiting, the report only while
--      in progress. A cancellation reason is given only in the transaction that cancels, and every check has its detail row
--      (two deferred constraint triggers, checked at commit). Nothing is written for a candidate whose personal data was
--      removed (serialised against the removal by the 4405 candidate lock). Status dates are the database's own clock.
--   3. app.recruitment_destroy_candidate restated (4411 body byte for byte) plus one step: the person's OPEN checks are cancelled
--      by the system (system_cancel_reason 'candidate_removed', a fixed code in the check row — no personal data), then the
--      details (summary, provider, reference, authorisation, cancellation reason) and files of all their checks are deleted
--      (owner-bound, marker-bound policies); each check keeps its types, status, outcome and dates. app.recruitment_delete_company_setup
--      restated (4411 body byte for byte) plus the five tables (types are real company setup; the others only exist with an
--      application, whose job opening refuses the delete first).
--
-- Nothing here calls a model, contacts a provider, scores a result or blocks an offer or a hire.

-- ── 1. Tables ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.recruitment_background_check_type (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
 description text CHECK (description IS NULL OR char_length(btrim(description)) BETWEEN 1 AND 500),
 enabled boolean NOT NULL DEFAULT true,
 -- The default a company added from the offered list (D: editable once added; behaviour never keys off it).
 seed_key text CHECK (seed_key ~ '^[a-z_]{1,40}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_background_check_type_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_background_check_type_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_background_check_type_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_background_check_type_scope_uq UNIQUE (id, company_id, tenant_id)
);
CREATE UNIQUE INDEX recruitment_background_check_type_name_uq ON public.recruitment_background_check_type (tenant_id, company_id, lower(btrim(name)));
CREATE UNIQUE INDEX recruitment_background_check_type_seed_uq ON public.recruitment_background_check_type (tenant_id, company_id, seed_key) WHERE seed_key IS NOT NULL;
CREATE INDEX recruitment_background_check_type_created_by_idx ON public.recruitment_background_check_type (created_by_user_id);
CREATE INDEX recruitment_background_check_type_updated_by_idx ON public.recruitment_background_check_type (updated_by_user_id);
--> statement-breakpoint
CREATE TABLE public.recruitment_background_check (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 application_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'awaiting_authorisation' CHECK (status IN ('awaiting_authorisation','in_progress','completed','cancelled')),
 outcome text CHECK (outcome IN ('clear','concerns_found','could_not_verify')),
 -- The recorder: the operator or administrator who added the check (their to-dos follow it).
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 started_at timestamptz,
 completed_at timestamptz,
 cancelled_at timestamptz,
 status_changed_at timestamptz NOT NULL DEFAULT now(),
 status_changed_by_user_id uuid NOT NULL,
 -- Set only when the removal of the candidate's personal data cancelled an open check (a fixed code, never personal data).
 system_cancel_reason text CHECK (system_cancel_reason IS NULL OR system_cancel_reason = 'candidate_removed'),
 CONSTRAINT recruitment_background_check_system_cancel_ck CHECK (system_cancel_reason IS NULL OR status = 'cancelled'),
 CONSTRAINT recruitment_background_check_state_ck CHECK ((status = 'completed') = (outcome IS NOT NULL)
  AND (status = 'completed') = (completed_at IS NOT NULL) AND (status = 'cancelled') = (cancelled_at IS NOT NULL)
  AND (status NOT IN ('in_progress','completed') OR started_at IS NOT NULL) AND (status <> 'awaiting_authorisation' OR started_at IS NULL)),
 CONSTRAINT recruitment_background_check_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_background_check_application_fk FOREIGN KEY (application_id, job_id, company_id, tenant_id)
  REFERENCES public.recruitment_application(id, job_id, company_id, tenant_id),
 CONSTRAINT recruitment_background_check_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_background_check_changed_by_fk FOREIGN KEY (status_changed_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_background_check_scope_uq UNIQUE (id, application_id, job_id, company_id, tenant_id)
);
CREATE INDEX recruitment_background_check_application_idx ON public.recruitment_background_check (application_id, created_at);
CREATE INDEX recruitment_background_check_job_idx ON public.recruitment_background_check (job_id);
-- Counts by status per company (the reports).
CREATE INDEX recruitment_background_check_company_idx ON public.recruitment_background_check (tenant_id, company_id, status);
-- The recorder's to-dos (the bell): their checks awaiting authorisation, newest first, and theirs in progress by start time.
CREATE INDEX recruitment_background_check_awaiting_idx ON public.recruitment_background_check (tenant_id, created_by_user_id, created_at DESC)
 WHERE status = 'awaiting_authorisation';
CREATE INDEX recruitment_background_check_in_progress_idx ON public.recruitment_background_check (tenant_id, created_by_user_id, started_at)
 WHERE status = 'in_progress';
CREATE INDEX recruitment_background_check_created_by_idx ON public.recruitment_background_check (created_by_user_id);
CREATE INDEX recruitment_background_check_changed_by_idx ON public.recruitment_background_check (status_changed_by_user_id);
--> statement-breakpoint
CREATE TABLE public.recruitment_background_check_type_link (
 check_id uuid NOT NULL,
 type_id uuid NOT NULL,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 application_id uuid NOT NULL,
 CONSTRAINT recruitment_background_check_type_link_pk PRIMARY KEY (check_id, type_id),
 CONSTRAINT recruitment_background_check_type_link_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_background_check_type_link_check_fk FOREIGN KEY (check_id, application_id, job_id, company_id, tenant_id)
  REFERENCES public.recruitment_background_check(id, application_id, job_id, company_id, tenant_id),
 CONSTRAINT recruitment_background_check_type_link_type_fk FOREIGN KEY (type_id, company_id, tenant_id)
  REFERENCES public.recruitment_background_check_type(id, company_id, tenant_id)
);
CREATE INDEX recruitment_background_check_type_link_type_idx ON public.recruitment_background_check_type_link (type_id);
CREATE INDEX recruitment_background_check_type_link_application_idx ON public.recruitment_background_check_type_link (application_id);
CREATE INDEX recruitment_background_check_type_link_company_idx ON public.recruitment_background_check_type_link (tenant_id, company_id);
--> statement-breakpoint
CREATE TABLE public.recruitment_background_check_detail (
 check_id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 application_id uuid NOT NULL,
 provider text NOT NULL CHECK (char_length(btrim(provider)) BETWEEN 1 AND 120),
 provider_reference text CHECK (provider_reference IS NULL OR char_length(btrim(provider_reference)) BETWEEN 1 AND 120),
 authorised_on date,
 authorisation_method text CHECK (authorisation_method IN ('signed_form','email','online_form')),
 authorisation_recorded_at timestamptz,
 authorisation_recorded_by_user_id uuid,
 summary text CHECK (summary IS NULL OR char_length(btrim(summary)) BETWEEN 1 AND 2000),
 cancel_reason text CHECK (cancel_reason IS NULL OR char_length(btrim(cancel_reason)) BETWEEN 1 AND 500),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_background_check_detail_authorisation_ck CHECK (
  num_nulls(authorised_on, authorisation_method, authorisation_recorded_at, authorisation_recorded_by_user_id) IN (0, 4)),
 CONSTRAINT recruitment_background_check_detail_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_background_check_detail_check_fk FOREIGN KEY (check_id, application_id, job_id, company_id, tenant_id)
  REFERENCES public.recruitment_background_check(id, application_id, job_id, company_id, tenant_id),
 CONSTRAINT recruitment_background_check_detail_recorded_by_fk FOREIGN KEY (authorisation_recorded_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_background_check_detail_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
CREATE INDEX recruitment_background_check_detail_application_idx ON public.recruitment_background_check_detail (application_id);
CREATE INDEX recruitment_background_check_detail_company_idx ON public.recruitment_background_check_detail (tenant_id, company_id);
CREATE INDEX recruitment_background_check_detail_recorded_by_idx ON public.recruitment_background_check_detail (authorisation_recorded_by_user_id)
 WHERE authorisation_recorded_by_user_id IS NOT NULL;
CREATE INDEX recruitment_background_check_detail_updated_by_idx ON public.recruitment_background_check_detail (updated_by_user_id);
--> statement-breakpoint
-- The authorisation file (slice 5 rules: PDF, Word or image) and the report (PDF or Word), at most 10 MB each, with the
-- uploader's confirmation that the candidate permitted storing it. Bytes never leave this table except to an audited download.
CREATE TABLE public.recruitment_background_check_file (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 application_id uuid NOT NULL,
 check_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('authorisation','report')),
 file_name text NOT NULL CHECK (char_length(btrim(file_name)) BETWEEN 1 AND 200),
 mime_type text NOT NULL,
 size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 10485760),
 content bytea NOT NULL,
 permission_confirmed boolean NOT NULL CHECK (permission_confirmed),
 uploaded_at timestamptz NOT NULL DEFAULT now(),
 uploaded_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_background_check_file_size_ck CHECK (octet_length(content) = size_bytes),
 CONSTRAINT recruitment_background_check_file_mime_ck CHECK (mime_type IN ('application/pdf','application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document') OR (kind = 'authorisation' AND mime_type IN ('image/jpeg','image/png'))),
 CONSTRAINT recruitment_background_check_file_kind_uq UNIQUE (check_id, kind),
 CONSTRAINT recruitment_background_check_file_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_background_check_file_check_fk FOREIGN KEY (check_id, application_id, job_id, company_id, tenant_id)
  REFERENCES public.recruitment_background_check(id, application_id, job_id, company_id, tenant_id),
 CONSTRAINT recruitment_background_check_file_uploaded_by_fk FOREIGN KEY (uploaded_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
CREATE INDEX recruitment_background_check_file_application_idx ON public.recruitment_background_check_file (application_id);
CREATE INDEX recruitment_background_check_file_company_idx ON public.recruitment_background_check_file (tenant_id, company_id);
CREATE INDEX recruitment_background_check_file_uploaded_by_idx ON public.recruitment_background_check_file (uploaded_by_user_id);
--> statement-breakpoint

-- ── 2. The stage rule ──────────────────────────────────────────────────────────────────────────────────────
-- May a check be added to the application at its current stage? (packs/recruitment/background-check-model.ts
-- checkStageAllowed is the same rule.) True when the current stage is an Offer-type stage; or its position in the job's
-- process is at or after the FIRST Offer-type stage of that process (disabled stages keep their positions); or it is the
-- company's seeded Background check stage (seed_key 'background_check', whatever it is renamed to). Behaviour never keys
-- off an editable name. Invoker: it reads what the caller may read (an operator reads the job, its
-- process and the company's stages); false when the application cannot be read.
CREATE FUNCTION app.recruitment_background_check_stage_ok(p_application uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path = pg_catalog, public, app, pg_temp AS $$
 SELECT coalesce((
  SELECT st.stage_type = 'offer' OR st.seed_key IS NOT DISTINCT FROM 'background_check'
   OR coalesce(ps.position >= (SELECT min(p2.position) FROM public.recruitment_process_stage p2
     JOIN public.recruitment_stage s2 ON s2.id = p2.stage_id AND s2.stage_type = 'offer' WHERE p2.process_id = j.process_id), false)
  FROM public.recruitment_application a
  JOIN public.recruitment_job_opening j ON j.id = a.job_id AND j.tenant_id = a.tenant_id
  JOIN public.recruitment_stage st ON st.id = a.current_stage_id AND st.tenant_id = a.tenant_id
  LEFT JOIN public.recruitment_process_stage ps ON ps.process_id = j.process_id AND ps.stage_id = a.current_stage_id
  WHERE a.id = p_application AND a.tenant_id = app.current_tenant_id()), false);
$$;
REVOKE ALL ON FUNCTION app.recruitment_background_check_stage_ok(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_background_check_stage_ok(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 3. Row security and grants ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_background_check_type','recruitment_background_check','recruitment_background_check_type_link',
  'recruitment_background_check_detail','recruitment_background_check_file'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, ai_hr_app', t);
 END LOOP;
END $$;
--> statement-breakpoint
-- Types: administrators manage them (and, as the owner inside the company delete, remove them); the company's job teams
-- read the names (a hiring manager reads the types of a check). The catalogue carries no candidate data.
CREATE POLICY recruitment_background_check_type_admin ON public.recruitment_background_check_type FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
CREATE POLICY recruitment_background_check_type_team ON public.recruitment_background_check_type FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_team_in_company(company_id));
-- Checks and their types: the job's reviewers read them (hiring managers: type, status, outcome and dates — nothing else is
-- in these tables); the job's operators and administrators add and change them.
CREATE POLICY recruitment_background_check_read ON public.recruitment_background_check FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.can_review_recruitment_job(company_id, job_id));
CREATE POLICY recruitment_background_check_insert ON public.recruitment_background_check FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id));
CREATE POLICY recruitment_background_check_update ON public.recruitment_background_check FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id));
CREATE POLICY recruitment_background_check_type_link_read ON public.recruitment_background_check_type_link FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.can_review_recruitment_job(company_id, job_id));
CREATE POLICY recruitment_background_check_type_link_insert ON public.recruitment_background_check_type_link FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id));
-- The restricted tables: the job's operators and administrators only. No other non-owner policy exists on them.
CREATE POLICY recruitment_background_check_detail_read ON public.recruitment_background_check_detail FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id));
CREATE POLICY recruitment_background_check_detail_insert ON public.recruitment_background_check_detail FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id));
CREATE POLICY recruitment_background_check_detail_update ON public.recruitment_background_check_detail FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id));
CREATE POLICY recruitment_background_check_file_read ON public.recruitment_background_check_file FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id));
CREATE POLICY recruitment_background_check_file_insert ON public.recruitment_background_check_file FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id));
--> statement-breakpoint
-- Owner-bound maintenance. The app role never satisfies these (current_user is ai_hr_app, never the owner); the owner does
-- only inside app.recruitment_destroy_candidate for the candidate whose 4405 marker THIS transaction holds (cancelling the
-- open checks, deleting the restricted details and files), and inside app.recruitment_delete_company_setup for the company it
-- is deleting.
CREATE POLICY recruitment_background_check_destroy_read ON public.recruitment_background_check FOR SELECT
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_background_check'::regclass))
  AND tenant_id = app.current_tenant_id() AND app.recruitment_destroying_application(application_id));
CREATE POLICY recruitment_background_check_destroy ON public.recruitment_background_check FOR UPDATE
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_background_check'::regclass))
  AND tenant_id = app.current_tenant_id() AND app.recruitment_destroying_application(application_id))
 WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_background_check'::regclass))
  AND tenant_id = app.current_tenant_id() AND app.recruitment_destroying_application(application_id));
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_background_check_detail','recruitment_background_check_file'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND app.recruitment_destroying_application(application_id))', t || '_destroy_read', t, 'public.' || t);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND app.recruitment_destroying_application(application_id))', t || '_destroy', t, 'public.' || t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['recruitment_background_check','recruitment_background_check_type_link','recruitment_background_check_detail',
  'recruitment_background_check_file'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND current_setting(''app.recruitment_company_delete'', true) = company_id::text)', t || '_company_delete_read', t, 'public.' || t);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND current_setting(''app.recruitment_company_delete'', true) = company_id::text)', t || '_company_delete', t, 'public.' || t);
 END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recruitment_background_check_type TO ai_hr_app;
GRANT SELECT, INSERT, UPDATE ON public.recruitment_background_check, public.recruitment_background_check_detail TO ai_hr_app;
GRANT SELECT, INSERT ON public.recruitment_background_check_type_link, public.recruitment_background_check_file TO ai_hr_app;
--> statement-breakpoint

-- ── 4. Guards ─────────────────────────────────────────────────────────────────────────────────────────────
-- Types: written as the current user; a type keeps its company, seed key and creation record.
CREATE FUNCTION app.recruitment_guard_background_check_type() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id()
   OR NEW.updated_by_user_id IS DISTINCT FROM app.current_user_id() THEN
   RAISE EXCEPTION 'A background check type is recorded by the current user' USING ERRCODE = '42501';
  END IF;
  NEW.created_at := now(); NEW.updated_at := now();
  RETURN NEW;
 END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
  OR NEW.seed_key IS DISTINCT FROM OLD.seed_key OR NEW.created_at IS DISTINCT FROM OLD.created_at
  OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
  RAISE EXCEPTION 'A background check type keeps its company and creation record' USING ERRCODE = '23514';
 END IF;
 NEW.updated_by_user_id := app.current_user_id(); NEW.updated_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_background_check_type() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_background_check_type_guard BEFORE INSERT OR UPDATE ON public.recruitment_background_check_type
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_background_check_type();
--> statement-breakpoint
-- The application's candidate, locked SHARED against the 4405 removal (which takes the same key exclusively), and refused
-- once their personal data has been removed. Invoker, called from the guards below as the caller (hence the app role's
-- EXECUTE): it returns nothing and reads only the application and candidate rows the caller may already read.
CREATE FUNCTION app.recruitment_background_check_candidate_open(p_tenant uuid, p_application uuid) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_candidate uuid;
BEGIN
 SELECT a.candidate_id INTO v_candidate FROM public.recruitment_application a WHERE a.id = p_application AND a.tenant_id = p_tenant;
 IF v_candidate IS NULL THEN
  RAISE EXCEPTION 'A background check belongs to an application the caller operates' USING ERRCODE = '42501';
 END IF;
 PERFORM pg_advisory_xact_lock_shared(app.recruitment_candidate_lock_key(p_tenant, v_candidate));
 IF EXISTS (SELECT 1 FROM public.recruitment_candidate c WHERE c.id = v_candidate AND c.destroyed_at IS NOT NULL) THEN
  RAISE EXCEPTION 'This candidate''s personal data has been removed' USING ERRCODE = '23514';
 END IF;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_background_check_candidate_open(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_background_check_candidate_open(uuid, uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.recruitment_guard_background_check() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE a_state text;
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF current_setting('app.recruitment_company_delete', true) IS DISTINCT FROM OLD.company_id::text THEN
   RAISE EXCEPTION 'A background check is never deleted; cancel it instead' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP = 'INSERT' THEN
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id()
   OR NEW.status IS DISTINCT FROM 'awaiting_authorisation' OR NEW.outcome IS NOT NULL
   OR num_nonnulls(NEW.started_at, NEW.completed_at, NEW.cancelled_at, NEW.system_cancel_reason) > 0 THEN
   RAISE EXCEPTION 'A background check is added awaiting authorisation, by the current user' USING ERRCODE = '42501';
  END IF;
  IF NOT app.can_operate_recruitment_job(NEW.company_id, NEW.job_id) THEN
   RAISE EXCEPTION 'Only the job''s recruiter, assistants and recruitment administrators add background checks' USING ERRCODE = '42501';
  END IF;
  PERFORM app.recruitment_background_check_candidate_open(NEW.tenant_id, NEW.application_id);
  SELECT a.state INTO a_state FROM public.recruitment_application a WHERE a.id = NEW.application_id AND a.tenant_id = NEW.tenant_id FOR SHARE;
  IF a_state IS DISTINCT FROM 'active' THEN
   RAISE EXCEPTION 'Background checks are added to active applications' USING ERRCODE = '23514',
    CONSTRAINT = 'recruitment_background_check_application_active';
  END IF;
  IF NOT app.recruitment_background_check_stage_ok(NEW.application_id) THEN
   RAISE EXCEPTION 'Background checks are added at or after the job''s Offer stage, or at a background-check stage' USING ERRCODE = '23514',
    CONSTRAINT = 'recruitment_background_check_stage';
  END IF;
  NEW.created_at := now(); NEW.status_changed_at := now(); NEW.status_changed_by_user_id := app.current_user_id();
  RETURN NEW;
 END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
  OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.application_id IS DISTINCT FROM OLD.application_id
  OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
  RAISE EXCEPTION 'A background check keeps its application and recorder' USING ERRCODE = '23514';
 END IF;
 -- Removing the candidate's personal data cancels each OPEN check by itself (and changes nothing else); a final one is untouched.
 IF app.recruitment_destroying_application(OLD.application_id) THEN
  IF OLD.status NOT IN ('awaiting_authorisation','in_progress') OR NEW.status IS DISTINCT FROM 'cancelled' OR NEW.outcome IS NOT NULL
   OR NEW.system_cancel_reason IS DISTINCT FROM 'candidate_removed' THEN
   RAISE EXCEPTION 'Removing a candidate''s personal data only cancels their open background checks' USING ERRCODE = '42501';
  END IF;
  NEW.started_at := OLD.started_at; NEW.completed_at := NULL; NEW.cancelled_at := now();
  NEW.status_changed_at := now(); NEW.status_changed_by_user_id := app.current_user_id();
  RETURN NEW;
 END IF;
 IF NEW.system_cancel_reason IS NOT NULL THEN
  RAISE EXCEPTION 'Only the removal of the candidate''s personal data cancels a check by itself' USING ERRCODE = '42501';
 END IF;
 IF OLD.status IN ('completed','cancelled') THEN
  RAISE EXCEPTION 'A completed or cancelled background check is final; add a new check instead' USING ERRCODE = '23514',
   CONSTRAINT = 'recruitment_background_check_final';
 END IF;
 PERFORM app.recruitment_background_check_candidate_open(OLD.tenant_id, OLD.application_id);
 IF NOT ((OLD.status = 'awaiting_authorisation' AND NEW.status IN ('in_progress','cancelled'))
  OR (OLD.status = 'in_progress' AND NEW.status IN ('completed','cancelled'))) THEN
  RAISE EXCEPTION 'A background check moves from awaiting authorisation to in progress to completed, or to cancelled' USING ERRCODE = '23514',
   CONSTRAINT = 'recruitment_background_check_transition';
 END IF;
 IF NEW.status = 'in_progress' AND NOT EXISTS (SELECT 1 FROM public.recruitment_background_check_detail d
  WHERE d.check_id = OLD.id AND d.tenant_id = OLD.tenant_id AND d.authorised_on IS NOT NULL) THEN
  RAISE EXCEPTION 'Record the candidate''s written authorisation before the check starts' USING ERRCODE = '23514',
   CONSTRAINT = 'recruitment_background_check_authorisation';
 END IF;
 IF NEW.status = 'completed' AND NEW.outcome IS NULL THEN
  RAISE EXCEPTION 'A completed background check has an outcome' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_background_check_outcome';
 END IF;
 IF NEW.status <> 'completed' AND NEW.outcome IS NOT NULL THEN
  RAISE EXCEPTION 'Only a completed background check has an outcome' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_background_check_outcome';
 END IF;
 IF NEW.status = 'cancelled' AND NOT EXISTS (SELECT 1 FROM public.recruitment_background_check_detail d
  WHERE d.check_id = OLD.id AND d.tenant_id = OLD.tenant_id AND d.cancel_reason IS NOT NULL) THEN
  RAISE EXCEPTION 'A cancelled background check has a reason' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_background_check_cancel_reason';
 END IF;
 -- The database's own clock and the current user, whatever the caller sent.
 NEW.started_at := CASE WHEN NEW.status = 'in_progress' THEN now() ELSE OLD.started_at END;
 NEW.completed_at := CASE WHEN NEW.status = 'completed' THEN now() END;
 NEW.cancelled_at := CASE WHEN NEW.status = 'cancelled' THEN now() END;
 NEW.status_changed_at := now(); NEW.status_changed_by_user_id := app.current_user_id();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_background_check() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_background_check_guard BEFORE INSERT OR UPDATE OR DELETE ON public.recruitment_background_check
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_background_check();
--> statement-breakpoint
-- A check's types are attached once, by its recorder, in the transaction that added it (created_at = now()), enabled ones only.
CREATE FUNCTION app.recruitment_guard_background_check_type_link() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF current_setting('app.recruitment_company_delete', true) IS DISTINCT FROM OLD.company_id::text THEN
   RAISE EXCEPTION 'A background check keeps its types' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP = 'UPDATE' THEN
  RAISE EXCEPTION 'A background check keeps its types' USING ERRCODE = '23514';
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT EXISTS (SELECT 1 FROM public.recruitment_background_check b
  WHERE b.id = NEW.check_id AND b.tenant_id = NEW.tenant_id AND b.status = 'awaiting_authorisation' AND b.created_at = now()
   AND b.created_by_user_id = app.current_user_id()) THEN
  RAISE EXCEPTION 'A background check''s types are chosen when it is added' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_background_check_types_fixed';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.recruitment_background_check_type t WHERE t.id = NEW.type_id AND t.tenant_id = NEW.tenant_id AND t.enabled) THEN
  RAISE EXCEPTION 'Choose an enabled background check type' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_background_check_type_enabled';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_background_check_type_link() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_background_check_type_link_guard BEFORE INSERT OR UPDATE OR DELETE ON public.recruitment_background_check_type_link
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_background_check_type_link();
--> statement-breakpoint
-- The restricted details. Inserted with the check (same transaction, same user); then: the provider never changes; the
-- reference may change while the check is open; the authorisation is recorded once, while awaiting, dated no later than today
-- in Kuala Lumpur; the summary is written while in progress; the cancellation reason while open. All of it is final with the
-- check. Deleted only by the removal (marker-bound) and the company delete.
CREATE FUNCTION app.recruitment_guard_background_check_detail() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE b public.recruitment_background_check%ROWTYPE;
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF NOT app.recruitment_destroying_application(OLD.application_id)
   AND current_setting('app.recruitment_company_delete', true) IS DISTINCT FROM OLD.company_id::text THEN
   RAISE EXCEPTION 'Background check details are removed only with the candidate''s personal data' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
 END IF;
 NEW.updated_by_user_id := app.current_user_id(); NEW.updated_at := now();
 IF TG_OP = 'INSERT' THEN
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NOT EXISTS (SELECT 1 FROM public.recruitment_background_check x
   WHERE x.id = NEW.check_id AND x.tenant_id = NEW.tenant_id AND x.status = 'awaiting_authorisation' AND x.created_at = now()
    AND x.created_by_user_id = app.current_user_id()) THEN
   RAISE EXCEPTION 'A background check''s details are recorded when it is added' USING ERRCODE = '42501';
  END IF;
  IF num_nonnulls(NEW.authorised_on, NEW.authorisation_method, NEW.authorisation_recorded_at, NEW.authorisation_recorded_by_user_id,
   NEW.summary, NEW.cancel_reason) > 0 THEN
   RAISE EXCEPTION 'A new background check has no authorisation, summary or cancellation yet' USING ERRCODE = '23514';
  END IF;
  PERFORM app.recruitment_background_check_candidate_open(NEW.tenant_id, NEW.application_id);
  RETURN NEW;
 END IF;
 IF NEW.check_id IS DISTINCT FROM OLD.check_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
  OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.application_id IS DISTINCT FROM OLD.application_id OR NEW.provider IS DISTINCT FROM OLD.provider THEN
  RAISE EXCEPTION 'A background check keeps its application and provider' USING ERRCODE = '23514';
 END IF;
 PERFORM app.recruitment_background_check_candidate_open(OLD.tenant_id, OLD.application_id);
 -- The check row, locked against a concurrent status change.
 SELECT * INTO b FROM public.recruitment_background_check WHERE id = OLD.check_id AND tenant_id = OLD.tenant_id FOR SHARE;
 IF NOT FOUND OR b.status IN ('completed','cancelled') THEN
  RAISE EXCEPTION 'A completed or cancelled background check is final; add a new check instead' USING ERRCODE = '23514',
   CONSTRAINT = 'recruitment_background_check_final';
 END IF;
 IF (NEW.authorised_on, NEW.authorisation_method, NEW.authorisation_recorded_by_user_id)
  IS DISTINCT FROM (OLD.authorised_on, OLD.authorisation_method, OLD.authorisation_recorded_by_user_id) THEN
  IF OLD.authorised_on IS NOT NULL OR b.status <> 'awaiting_authorisation' THEN
   RAISE EXCEPTION 'The candidate''s authorisation is recorded once, before the check starts' USING ERRCODE = '23514',
    CONSTRAINT = 'recruitment_background_check_authorisation_once';
  END IF;
  IF NEW.authorised_on IS NULL OR NEW.authorisation_method IS NULL OR NEW.authorisation_recorded_by_user_id IS DISTINCT FROM app.current_user_id() THEN
   RAISE EXCEPTION 'The authorisation names its date and method, recorded by the current user' USING ERRCODE = '42501';
  END IF;
  IF NEW.authorised_on > (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date THEN
   RAISE EXCEPTION 'An authorisation date cannot be in the future' USING ERRCODE = '23514', CONSTRAINT = 'recruitment_background_check_authorisation_date';
  END IF;
  NEW.authorisation_recorded_at := now();
 ELSE
  NEW.authorisation_recorded_at := OLD.authorisation_recorded_at;
 END IF;
 IF NEW.summary IS DISTINCT FROM OLD.summary AND b.status <> 'in_progress' THEN
  RAISE EXCEPTION 'The summary is written while the check is in progress' USING ERRCODE = '23514';
 END IF;
 IF NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason AND (OLD.cancel_reason IS NOT NULL OR NEW.cancel_reason IS NULL) THEN
  RAISE EXCEPTION 'A cancellation reason is given once' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_background_check_detail() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_background_check_detail_guard BEFORE INSERT OR UPDATE OR DELETE ON public.recruitment_background_check_detail
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_background_check_detail();
--> statement-breakpoint
-- At commit (deferred constraint triggers, run as the caller): a cancellation reason exists only on a check cancelled in the
-- same transaction (the reason is set once and Cancelled is final, so a reason written without the cancellation cannot
-- commit, and the status guard needs the reason before it cancels); and every check has its detail row.
CREATE FUNCTION app.recruitment_background_check_cancel_reason_settled() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.recruitment_background_check b WHERE b.id = NEW.check_id AND b.tenant_id = NEW.tenant_id AND b.status = 'cancelled') THEN
  RAISE EXCEPTION 'A cancellation reason is given only when the check is cancelled' USING ERRCODE = '23514',
   CONSTRAINT = 'recruitment_background_check_cancel_reason_with_cancel';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_background_check_cancel_reason_settled() FROM PUBLIC, ai_hr_app;
CREATE CONSTRAINT TRIGGER recruitment_background_check_detail_cancel_reason AFTER INSERT OR UPDATE OF cancel_reason
 ON public.recruitment_background_check_detail DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW WHEN (NEW.cancel_reason IS NOT NULL) EXECUTE FUNCTION app.recruitment_background_check_cancel_reason_settled();
--> statement-breakpoint
CREATE FUNCTION app.recruitment_background_check_has_detail() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.recruitment_background_check_detail d WHERE d.check_id = NEW.id AND d.tenant_id = NEW.tenant_id) THEN
  RAISE EXCEPTION 'A background check is added with its provider details' USING ERRCODE = '23514',
   CONSTRAINT = 'recruitment_background_check_detail_required';
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_background_check_has_detail() FROM PUBLIC, ai_hr_app;
CREATE CONSTRAINT TRIGGER recruitment_background_check_detail_required AFTER INSERT ON public.recruitment_background_check
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION app.recruitment_background_check_has_detail();
--> statement-breakpoint
-- Files: uploaded by the current user — the authorisation file while the check awaits authorisation, the report while it is
-- in progress; never changed; deleted only by the removal (marker-bound) and the company delete.
CREATE FUNCTION app.recruitment_guard_background_check_file() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_status text;
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF NOT app.recruitment_destroying_application(OLD.application_id)
   AND current_setting('app.recruitment_company_delete', true) IS DISTINCT FROM OLD.company_id::text THEN
   RAISE EXCEPTION 'Background check files are removed only with the candidate''s personal data' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP = 'UPDATE' THEN
  RAISE EXCEPTION 'A background check file is kept as uploaded' USING ERRCODE = '23514';
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.uploaded_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'Uploaded by the current user' USING ERRCODE = '42501';
 END IF;
 PERFORM app.recruitment_background_check_candidate_open(NEW.tenant_id, NEW.application_id);
 SELECT b.status INTO v_status FROM public.recruitment_background_check b WHERE b.id = NEW.check_id AND b.tenant_id = NEW.tenant_id FOR SHARE;
 IF v_status IS DISTINCT FROM (CASE NEW.kind WHEN 'authorisation' THEN 'awaiting_authorisation' ELSE 'in_progress' END) THEN
  RAISE EXCEPTION 'The authorisation file is added before the check starts, the report while it is in progress' USING ERRCODE = '23514',
   CONSTRAINT = 'recruitment_background_check_file_status';
 END IF;
 NEW.uploaded_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_background_check_file() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_background_check_file_guard BEFORE INSERT OR UPDATE OR DELETE ON public.recruitment_background_check_file
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_background_check_file();
--> statement-breakpoint

-- ── 5. Removal: 4411's app.recruitment_destroy_candidate, byte for byte, plus the background check details and files ──
-- (The new step follows the screening comments, before the candidate row is cleared.)
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

-- ── 6. Deleting a company (core/company-refs.ts): 4411's body plus the background check tables ─────────────────────
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
 -- Slice 9: the users' read markers for the company's recruitment tasks (no candidate data).
 DELETE FROM public.recruitment_task_read_marker WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 10: the agency setup, children first. Assignments and submissions need a job opening, which refuses above. A
 -- contract's terms and listed users go with it (ON DELETE CASCADE). The administrator policies admit the owner here
 -- because the caller administers the company (app.is_admin_for implies app.can_admin_recruitment_for).
 DELETE FROM public.recruitment_agency_tag_link WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_agency_consultant WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_agency_contract WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_agency WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_agency_tag WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 11: screening feedback, then the requests it answers. Both need an application, whose job opening refuses the delete
 -- above; they are listed so the remover covers every company table (owner-bound policies on the company being deleted).
 DELETE FROM public.recruitment_screening_answer WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_screening_request WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 -- Slice 12: background checks, children first (files, details, types of a check, checks), then the company's check types.
 -- Checks need an application, whose job opening refuses the delete above (owner-bound policies on the company being
 -- deleted); the types are company setup (the administrator policy admits the owner here, as for the agency tables).
 DELETE FROM public.recruitment_background_check_file WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_background_check_detail WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_background_check_type_link WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_background_check WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 DELETE FROM public.recruitment_background_check_type WHERE tenant_id = app.current_tenant_id() AND company_id = p_company;
 GET DIAGNOSTICS n = ROW_COUNT; removed := removed + n;
 PERFORM set_config('app.recruitment_company_delete', '', true);
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_delete_company_setup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_delete_company_setup(uuid) TO ai_hr_app;
