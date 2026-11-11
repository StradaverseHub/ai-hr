-- Recruitment slice 7 (docs/recruitment-reconstruction/specification.md "Slice 7"): employee referrals.
--
-- An employee whose person has an active employment in a company with Recruitment refers a candidate to an Open job that
-- a recruitment administrator has put on the referral portal. Rewards, notifications, posters and sharing links are not
-- built (D-021, D-022). The referrer gains no other Recruitment access: they never hold a grant or a policy on a
-- recruitment table; every read and write they make goes through the four SECURITY DEFINER functions below, which
-- return only what the spec allows.
--
-- What this installs:
--   1. recruitment_job_opening.show_on_referral_portal (default off; only a recruitment administrator of the job's
--      company may set or change it — row security already admits only them, and a guard refuses anybody else again)
--      and recruitment_company_setting.referral_protection_days (0–730, default 180; 0 switches the rule off).
--   2. recruitment_referral: one row per referred application — tenant, company, job, application, candidate link,
--      referrer person and login, the referrer's reason, the confirmation time and the creation time. It holds no
--      candidate personal data of its own: name, e-mail, mobile and resume live on the candidate (slice 5). FORCE row
--      security; a column SELECT grant to ai_hr_app that leaves out the reason (HR reads the reason only through
--      app.recruitment_application_referral, reviewers only); no write grant to anybody.
--   3. The referral context marker (app.recruitment_referral_context): one row per (transaction, company) while a referral
--      function runs, deleted before it returns. Like 4405's destroy marker it has no grant to ai_hr_app or PUBLIC, so
--      only the definer functions write it, and the owner-only policies below open recruitment rows to those functions
--      for exactly those companies and only for that transaction. A GUC or session value cannot open them.
--   4. app.recruitment_submit_referral — one transaction: same tenant; the caller's person has an active employment
--      (the canonical rule: not voided, not blacklisted, started on or before the Kuala Lumpur date and not ended — the
--      login rule of app.login_blocked_on) in the job's company; Recruitment is enabled for the tenant (a tenant-wide
--      grant, the same rule as every HR screen); the job is Open and on the portal (its row locked FOR SHARE, so a
--      concurrent close or portal switch-off serialises with the referral); at most 20 ATTEMPTS by the person on the
--      Kuala Lumpur date, accepted or refused (D-024; capping attempts bounds probing for whether someone already applied,
--      D-023); no application that is not archived for the same job by the same normalised e-mail or mobile (slice 5
--      normalisers); no referral of the same e-mail or mobile by ANOTHER person in the company within the protection
--      period. An advisory lock on the referrer, then on company + each normalised identity (in key order), serialises
--      concurrent referrals so two referrals of the same person yield exactly one. Creates the candidate (source
--      referral), the application at the job's first enabled stage (source referral), its "applied" history row, the
--      optional resume and the referral, then counts possible duplicates (slice 5 rule: two of name, e-mail and mobile)
--      and flags them for HR. A refusal returns {ok:false, reason} and appends recruitment-referral.refused naming the
--      reason; the service shows the referrer one generic message (D-023). Every attempt is logged (outcome only) in
--      app.recruitment_referral_attempt, a private table kept two days, for the attempt limit.
--   5. app.recruitment_referral_portal / app.recruitment_my_referrals / app.recruitment_referral_eligible: the portal
--      (title, number, company, location, employment and recruitment type, job levels, description — never salary,
--      team or counts) and the referrer's own referrals (job, date, name as entered unless removed, and the application
--      state, stage type and process positions the service turns into a coarse status — never a stage name).
--      app.recruitment_application_referral: the referral on an application for its readers (name, date; reason for
--      reviewers).
--   6. app.recruitment_destroy_candidate restated (4405 body byte for byte) plus one step: the referral's reason is
--      cleared, so removing a candidate leaves no referral personal data; the referral row stays (job, date, referrer)
--      pointing at the candidate skeleton, so nothing is orphaned.
--
-- Nothing here calls a model, scores a candidate or calculates a reward.

-- ── 1. Columns ────────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.recruitment_job_opening ADD COLUMN show_on_referral_portal boolean NOT NULL DEFAULT false;
CREATE INDEX recruitment_job_opening_referral_portal_idx ON public.recruitment_job_opening (tenant_id, company_id)
 WHERE show_on_referral_portal AND status = 'open';
--> statement-breakpoint
ALTER TABLE public.recruitment_company_setting
 ADD COLUMN referral_protection_days integer NOT NULL DEFAULT 180 CHECK (referral_protection_days BETWEEN 0 AND 730);
--> statement-breakpoint

-- ── 2. The referral record ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.recruitment_referral (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 application_id uuid NOT NULL,
 candidate_id uuid NOT NULL,
 referrer_person_id uuid NOT NULL REFERENCES public.person(id),
 referrer_user_id uuid NOT NULL,
 -- The referrer's own words; cleared (NULL) only by the candidate's removal.
 reason text CHECK (reason IS NULL OR char_length(btrim(reason)) BETWEEN 1 AND 1000),
 confirmed_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT recruitment_referral_job_fk FOREIGN KEY (job_id, company_id, tenant_id) REFERENCES public.recruitment_job_opening(id, company_id, tenant_id),
 CONSTRAINT recruitment_referral_application_fk FOREIGN KEY (application_id, company_id, tenant_id) REFERENCES public.recruitment_application(id, company_id, tenant_id),
 CONSTRAINT recruitment_referral_candidate_fk FOREIGN KEY (candidate_id, company_id, tenant_id) REFERENCES public.recruitment_candidate(id, company_id, tenant_id),
 CONSTRAINT recruitment_referral_user_fk FOREIGN KEY (referrer_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_referral_application_uq UNIQUE (application_id)
);
CREATE INDEX recruitment_referral_referrer_idx ON public.recruitment_referral (tenant_id, referrer_person_id, created_at);
CREATE INDEX recruitment_referral_company_idx ON public.recruitment_referral (tenant_id, company_id, created_at);
CREATE INDEX recruitment_referral_job_idx ON public.recruitment_referral (job_id);
CREATE INDEX recruitment_referral_candidate_idx ON public.recruitment_referral (candidate_id);
CREATE INDEX recruitment_referral_user_idx ON public.recruitment_referral (referrer_user_id);
--> statement-breakpoint
ALTER TABLE public.recruitment_referral ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recruitment_referral FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.recruitment_referral FROM PUBLIC, ai_hr_app;
-- Every column but the reason: nobody reads the reason directly (interviewers must not read it by any path).
GRANT SELECT (id, tenant_id, company_id, job_id, application_id, candidate_id, referrer_person_id, referrer_user_id, confirmed_at, created_at)
 ON public.recruitment_referral TO ai_hr_app;
--> statement-breakpoint
-- Every referral attempt (accepted or refused) by a person, for the daily limit: the limit counts attempts so a refusal
-- cannot be used to probe without bound. Kept two days; no candidate data; no grant to anybody.
CREATE TABLE app.recruitment_referral_attempt (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 person_id uuid NOT NULL,
 attempted_at timestamptz NOT NULL DEFAULT now(),
 outcome text NOT NULL CHECK (outcome IN ('accepted','not_eligible','job_unavailable','daily_limit','similar_application','already_referred'))
);
CREATE INDEX recruitment_referral_attempt_person_idx ON app.recruitment_referral_attempt (tenant_id, person_id, attempted_at);
ALTER TABLE app.recruitment_referral_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.recruitment_referral_attempt FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.recruitment_referral_attempt FROM PUBLIC, ai_hr_app;
CREATE POLICY recruitment_referral_attempt_owner ON app.recruitment_referral_attempt FOR ALL
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'app.recruitment_referral_attempt'::regclass)))
 WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'app.recruitment_referral_attempt'::regclass)));
--> statement-breakpoint

-- ── 3. The referral context marker and its predicates ────────────────────────────────────────────────────
CREATE TABLE app.recruitment_referral_context (
 txid bigint NOT NULL,
 company_id uuid NOT NULL,
 tenant_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (txid, company_id)
);
ALTER TABLE app.recruitment_referral_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.recruitment_referral_context FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.recruitment_referral_context FROM PUBLIC, ai_hr_app;
CREATE POLICY recruitment_referral_context_owner ON app.recruitment_referral_context FOR ALL
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'app.recruitment_referral_context'::regclass)))
 WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'app.recruitment_referral_context'::regclass)));
--> statement-breakpoint
-- True only while a referral function is running for THIS company in THIS transaction. txid_current_if_assigned never
-- assigns a transaction id, so evaluating it (for instance inside a read-only transaction) has no side effect.
CREATE FUNCTION app.recruitment_referral_open(p_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp AS $$
 SELECT p_company IS NOT NULL AND EXISTS (SELECT 1 FROM app.recruitment_referral_context m
  WHERE m.txid = txid_current_if_assigned() AND m.company_id = p_company);
$$;
REVOKE ALL ON FUNCTION app.recruitment_referral_open(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_referral_open(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The caller's person, from their own login (never from anything the caller sends).
CREATE FUNCTION app.recruitment_current_person() RETURNS uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT u.person_id FROM public.app_user u
 WHERE u.id = app.current_user_id() AND u.tenant_id = app.current_tenant_id() AND u.archived_at IS NULL;
$$;
REVOKE ALL ON FUNCTION app.recruitment_current_person() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_current_person() TO ai_hr_app;
--> statement-breakpoint
-- Recruitment is enabled for the tenant: in good standing with a live TENANT-WIDE Recruitment grant — the same rows,
-- statuses and tenant-wide rule as core/entitlements.ts and core/module-gate.ts withRecruitmentTenant, so a referral can
-- only land where HR can see, switch off and remove it. A company-scoped grant does not open referrals (nor any HR screen).
CREATE FUNCTION app.recruitment_enabled_for(p_tenant uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT EXISTS (SELECT 1 FROM public.tenant t WHERE t.id = p_tenant AND t.status IN ('active','trial'))
  AND EXISTS (SELECT 1 FROM public.tenant_module m WHERE m.tenant_id = p_tenant AND m.module_code = 'recruitment'
   AND m.status IN ('active','trial') AND (m.expires_at IS NULL OR m.expires_at > now()) AND m.company_id IS NULL);
$$;
REVOKE ALL ON FUNCTION app.recruitment_enabled_for(uuid) FROM PUBLIC, ai_hr_app;
--> statement-breakpoint
-- The companies where the caller's person has an ACTIVE employment today (Kuala Lumpur), and whether Recruitment is
-- enabled. Active is the canonical rule: not voided (0676), not blacklisted, started (join date, else group join date)
-- on or before today, and not ended — ended is the earliest of resignation, last working and termination dates, and the
-- employment still counts ON that day, exactly as app.login_blocked_on (0579) keeps the login and
-- core/employment-status.ts isEmploymentEnded agrees (today > ended). Internal: only the definer functions call it.
CREATE FUNCTION app.recruitment_referrer_companies() RETURNS TABLE(company_id uuid, enabled boolean)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT DISTINCT e.company_id, app.recruitment_enabled_for(e.tenant_id)
 FROM public.app_user u
 JOIN public.employment e ON e.person_id = u.person_id AND e.tenant_id = u.tenant_id
 JOIN public.company c ON c.id = e.company_id AND c.tenant_id = e.tenant_id AND c.archived_at IS NULL
 WHERE u.id = app.current_user_id() AND u.tenant_id = app.current_tenant_id() AND u.archived_at IS NULL AND u.person_id IS NOT NULL
  AND e.voided_at IS NULL AND e.blacklisted_at IS NULL
  AND coalesce(e.join_date, e.hired_on) <= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
  AND (LEAST(e.resignation_date, e.last_working_date, e.terminated_on) IS NULL
   OR (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date <= LEAST(e.resignation_date, e.last_working_date, e.terminated_on));
$$;
REVOKE ALL ON FUNCTION app.recruitment_referrer_companies() FROM PUBLIC, ai_hr_app;
--> statement-breakpoint

-- ── 4. Row security for the referral functions and for HR ────────────────────────────────────────────────
-- Owner-only, marker-bound policies: the app role never satisfies them (current_user is ai_hr_app, never the owner), and
-- the owner satisfies them only for a company whose marker row THIS transaction holds — written solely by the referral
-- definer functions. No policy below reads a table whose own policy reads it back, so none can recurse.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_job_opening','recruitment_process_stage','recruitment_stage','recruitment_candidate',
  'recruitment_application','recruitment_company_setting','recruitment_referral'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND app.recruitment_referral_open(company_id))', t || '_referral_read', t, 'public.' || t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['recruitment_candidate','recruitment_application','recruitment_application_event','recruitment_candidate_file',
  'recruitment_referral'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND app.recruitment_referral_open(company_id))', t || '_referral_insert', t, 'public.' || t);
 END LOOP;
END $$;
--> statement-breakpoint
-- The job row is locked FOR SHARE by the submission (a concurrent close or portal switch-off waits for it). A row lock
-- needs an UPDATE policy; this one admits the lock and no write (WITH CHECK false).
CREATE POLICY recruitment_job_opening_referral_lock ON public.recruitment_job_opening FOR UPDATE
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_job_opening'::regclass))
  AND tenant_id = app.current_tenant_id() AND app.recruitment_referral_open(company_id))
 WITH CHECK (false);
-- The referrer's own referrals, to the owner-run functions only (My referrals spans companies).
CREATE POLICY recruitment_referral_own ON public.recruitment_referral FOR SELECT
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_referral'::regclass))
  AND tenant_id = app.current_tenant_id() AND referrer_person_id = app.recruitment_current_person());
-- HR: whoever may read the application reads its referral (administrators, the job team, its interviewers).
CREATE POLICY recruitment_referral_read ON public.recruitment_referral FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.can_read_recruitment_application(company_id, job_id, application_id));
-- Removal clears the reason, which nobody else may rewrite.
CREATE POLICY recruitment_referral_destroy ON public.recruitment_referral FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_destroying(candidate_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.recruitment_destroying(candidate_id));
--> statement-breakpoint

-- ── 5. Guards ─────────────────────────────────────────────────────────────────────────────────────────────
-- The portal setting: set or changed only by a recruitment administrator of the job's company.
CREATE FUNCTION app.recruitment_guard_job_referral_portal() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF (TG_OP = 'INSERT' AND NEW.show_on_referral_portal)
  OR (TG_OP = 'UPDATE' AND NEW.show_on_referral_portal IS DISTINCT FROM OLD.show_on_referral_portal) THEN
  IF NOT app.can_admin_recruitment_for(NEW.company_id) THEN
   RAISE EXCEPTION 'Only a recruitment administrator changes the referral portal setting' USING ERRCODE = '42501';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_job_referral_portal() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_job_opening_referral_portal_guard BEFORE INSERT OR UPDATE OF show_on_referral_portal ON public.recruitment_job_opening
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_job_referral_portal();
--> statement-breakpoint
-- The referral: written once by the submission (the current login, its own person, an application of that job and
-- candidate); never deleted; changed only by the candidate's removal, and then only to clear the reason.
CREATE FUNCTION app.recruitment_guard_referral() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'A referral record is kept' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'UPDATE' THEN
  IF app.recruitment_destroying(OLD.candidate_id) AND NEW.reason IS NULL
   AND (to_jsonb(NEW) - 'reason') IS NOT DISTINCT FROM (to_jsonb(OLD) - 'reason') THEN
   RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A referral record is kept as it was given' USING ERRCODE = '42501';
 END IF;
 IF NEW.referrer_user_id IS DISTINCT FROM app.current_user_id() OR NOT EXISTS (SELECT 1 FROM public.app_user u
  WHERE u.id = NEW.referrer_user_id AND u.tenant_id = NEW.tenant_id AND u.person_id = NEW.referrer_person_id) THEN
  RAISE EXCEPTION 'A referral is made by the current user''s own person' USING ERRCODE = '42501';
 END IF;
 IF NEW.reason IS NULL THEN
  RAISE EXCEPTION 'A referral gives a reason' USING ERRCODE = '23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.recruitment_application a WHERE a.id = NEW.application_id AND a.tenant_id = NEW.tenant_id
  AND a.job_id = NEW.job_id AND a.candidate_id = NEW.candidate_id) THEN
  RAISE EXCEPTION 'A referral belongs to its application''s job and candidate' USING ERRCODE = '23514';
 END IF;
 NEW.created_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_referral() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_referral_guard BEFORE INSERT OR UPDATE OR DELETE ON public.recruitment_referral
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_referral();
--> statement-breakpoint

-- ── 6. Eligibility, the portal and My referrals ──────────────────────────────────────────────────────────
-- Does the caller have at least one company where they may refer (the menu question)?
CREATE FUNCTION app.recruitment_referral_eligible() RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
 SELECT EXISTS (SELECT 1 FROM app.recruitment_referrer_companies() rc WHERE rc.enabled);
$$;
REVOKE ALL ON FUNCTION app.recruitment_referral_eligible() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_referral_eligible() TO ai_hr_app;
--> statement-breakpoint
-- The Open jobs on the portal in the caller's eligible companies (one job with p_job). Only the portal fields.
CREATE FUNCTION app.recruitment_referral_portal(p_job uuid DEFAULT NULL)
RETURNS TABLE(job_id uuid, company_id uuid, company_name text, title text, job_number text, work_location text, employment_type text,
 recruitment_type text, job_levels text[], description text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
#variable_conflict use_column
DECLARE v_tenant uuid := app.current_tenant_id();
BEGIN
 IF v_tenant IS NULL OR app.current_user_id() IS NULL THEN RETURN; END IF;
 INSERT INTO app.recruitment_referral_context (txid, company_id, tenant_id)
  SELECT txid_current(), rc.company_id, v_tenant FROM app.recruitment_referrer_companies() rc WHERE rc.enabled
  ON CONFLICT DO NOTHING;
 RETURN QUERY
  SELECT j.id, j.company_id, co.legal_name::text, j.title, j.job_number, j.work_location, j.employment_type, j.recruitment_type,
   coalesce((SELECT array_agg(g.name::text ORDER BY g.rank NULLS LAST, g.name) FROM public.job_grade g
    WHERE g.id = ANY (j.job_grade_ids) AND g.tenant_id = j.tenant_id), '{}'::text[]),
   j.description
  FROM public.recruitment_job_opening j
  JOIN public.company co ON co.id = j.company_id AND co.tenant_id = j.tenant_id
  WHERE j.tenant_id = v_tenant AND j.status = 'open' AND j.show_on_referral_portal AND (p_job IS NULL OR j.id = p_job)
   AND EXISTS (SELECT 1 FROM app.recruitment_referral_context m WHERE m.txid = txid_current() AND m.company_id = j.company_id)
  ORDER BY co.legal_name, j.created_at DESC, j.id;
 DELETE FROM app.recruitment_referral_context WHERE txid = txid_current();
END $$;
REVOKE ALL ON FUNCTION app.recruitment_referral_portal(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_referral_portal(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The caller's own referrals: job, date, the candidate's name as entered (none once removed), and the application's state,
-- current stage type and process positions (current, first interview, first offer) for the service's coarse status.
CREATE FUNCTION app.recruitment_my_referrals()
RETURNS TABLE(referral_id uuid, company_name text, job_title text, job_number text, referred_at timestamptz, candidate_name text, removed boolean,
 state text, stage_type text, stage_position integer, interview_position integer, offer_position integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
#variable_conflict use_column
DECLARE v_tenant uuid := app.current_tenant_id(); v_person uuid := app.recruitment_current_person();
BEGIN
 IF v_tenant IS NULL OR v_person IS NULL THEN RETURN; END IF;
 INSERT INTO app.recruitment_referral_context (txid, company_id, tenant_id)
  SELECT DISTINCT txid_current(), r.company_id, v_tenant FROM public.recruitment_referral r
  WHERE r.tenant_id = v_tenant AND r.referrer_person_id = v_person
  ON CONFLICT DO NOTHING;
 RETURN QUERY
  SELECT r.id, co.legal_name::text, j.title, j.job_number, r.created_at,
   CASE WHEN c.destroyed_at IS NULL THEN c.full_name END, c.destroyed_at IS NOT NULL, a.state, st.stage_type,
   (SELECT ps.position FROM public.recruitment_process_stage ps WHERE ps.process_id = j.process_id AND ps.stage_id = a.current_stage_id),
   (SELECT min(ps.position) FROM public.recruitment_process_stage ps JOIN public.recruitment_stage s2 ON s2.id = ps.stage_id
     WHERE ps.process_id = j.process_id AND s2.stage_type = 'interview'),
   (SELECT min(ps.position) FROM public.recruitment_process_stage ps JOIN public.recruitment_stage s2 ON s2.id = ps.stage_id
     WHERE ps.process_id = j.process_id AND s2.stage_type = 'offer')
  FROM public.recruitment_referral r
  JOIN public.recruitment_application a ON a.id = r.application_id AND a.tenant_id = r.tenant_id
  JOIN public.recruitment_job_opening j ON j.id = r.job_id AND j.tenant_id = r.tenant_id
  JOIN public.recruitment_candidate c ON c.id = r.candidate_id AND c.tenant_id = r.tenant_id
  JOIN public.recruitment_stage st ON st.id = a.current_stage_id
  JOIN public.company co ON co.id = r.company_id AND co.tenant_id = r.tenant_id
  WHERE r.tenant_id = v_tenant AND r.referrer_person_id = v_person
  ORDER BY r.created_at DESC, r.id;
 DELETE FROM app.recruitment_referral_context WHERE txid = txid_current();
END $$;
REVOKE ALL ON FUNCTION app.recruitment_my_referrals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_my_referrals() TO ai_hr_app;
--> statement-breakpoint
-- The referral on an application, for a caller who may read the application: the referrer's name and the date; the
-- reason only for the job's reviewers and administrators. Nothing for anybody else.
CREATE FUNCTION app.recruitment_application_referral(p_application uuid)
RETURNS TABLE(referral_id uuid, referrer_name text, referred_at timestamptz, reason text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
 SELECT r.id, p.full_name::text, r.created_at, CASE WHEN app.can_review_recruitment_job(r.company_id, r.job_id) THEN r.reason END
 FROM public.recruitment_referral r
 JOIN public.person p ON p.id = r.referrer_person_id AND p.tenant_id = r.tenant_id
 WHERE r.application_id = p_application AND r.tenant_id = app.current_tenant_id()
  AND app.can_read_recruitment_application(r.company_id, r.job_id, r.application_id);
$$;
REVOKE ALL ON FUNCTION app.recruitment_application_referral(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_application_referral(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 7. Submission ────────────────────────────────────────────────────────────────────────────────────────
-- Refusal reasons (in the audit event and the attempt log only): not_eligible (no active employment in the job's
-- company, no tenant-wide Recruitment, or no such job), job_unavailable, daily_limit, similar_application,
-- already_referred. Malformed input raises 22023 (the service validates first).
CREATE FUNCTION app.recruitment_submit_referral(p_job uuid, p_full_name text, p_email text, p_mobile text, p_reason text, p_confirmed boolean,
 p_file_name text DEFAULT NULL, p_file_mime text DEFAULT NULL, p_file_content bytea DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on AS $$
DECLARE
 v_tenant uuid := app.current_tenant_id(); v_user uuid := app.current_user_id(); v_person uuid;
 v_today date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
 v_name text := nullif(btrim(coalesce(p_full_name, '')), '');
 v_email text := app.recruitment_norm_email(p_email); v_mobile text := app.recruitment_norm_mobile(p_mobile);
 v_reason_text text := nullif(btrim(coalesce(p_reason, '')), '');
 j public.recruitment_job_opening%ROWTYPE; v_reason text; v_days integer; v_since timestamptz; v_stage uuid; v_candidate uuid;
 v_application uuid; v_referral uuid; v_matches integer; v_key bigint; v_attempts integer;
BEGIN
 IF v_tenant IS NULL OR v_user IS NULL THEN
  RAISE EXCEPTION 'Referring a candidate needs a signed-in employee' USING ERRCODE = '42501';
 END IF;
 IF p_job IS NULL OR v_name IS NULL OR char_length(v_name) > 200 OR (v_email IS NULL AND v_mobile IS NULL)
  OR v_reason_text IS NULL OR char_length(v_reason_text) > 1000 OR p_confirmed IS NOT TRUE
  OR (p_file_content IS NOT NULL AND (p_file_name IS NULL OR p_file_mime IS NULL)) THEN
  RAISE EXCEPTION 'A referral needs a name, an e-mail or mobile, a reason and the candidate''s agreement' USING ERRCODE = '22023';
 END IF;
 v_person := app.recruitment_current_person();
 IF v_person IS NULL THEN
  v_reason := 'not_eligible';
 ELSE
  -- One referrer at a time (the attempt limit), then only the companies where they may refer become readable.
  PERFORM pg_advisory_xact_lock(hashtextextended('recruitment-referrer:' || v_tenant::text || ':' || v_person::text, 0));
  DELETE FROM app.recruitment_referral_attempt WHERE tenant_id = v_tenant AND person_id = v_person AND attempted_at < now() - interval '2 days';
  -- Attempts on today's Kuala Lumpur date, as an index range on the instant (00:00 to 24:00 in Kuala Lumpur).
  SELECT count(*)::integer INTO v_attempts FROM app.recruitment_referral_attempt a
   WHERE a.tenant_id = v_tenant AND a.person_id = v_person
    AND a.attempted_at >= (v_today::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur') AND a.attempted_at < ((v_today + 1)::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur');
  INSERT INTO app.recruitment_referral_context (txid, company_id, tenant_id)
   SELECT txid_current(), rc.company_id, v_tenant FROM app.recruitment_referrer_companies() rc WHERE rc.enabled ON CONFLICT DO NOTHING;
  IF v_attempts >= 20 THEN
   v_reason := 'daily_limit';
  ELSE
   -- The job, locked FOR SHARE: a concurrent close or portal switch-off waits for this referral (or this one sees it).
   SELECT * INTO j FROM public.recruitment_job_opening WHERE id = p_job AND tenant_id = v_tenant FOR SHARE;
   IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM app.recruitment_referrer_companies() rc WHERE rc.company_id = j.company_id AND rc.enabled) THEN
    -- Explicit, whoever owns the tables: the caller must actively work for the job's company, with Recruitment on.
    v_reason := 'not_eligible';
   ELSIF j.status <> 'open' OR NOT j.show_on_referral_portal THEN
    v_reason := 'job_unavailable';
   ELSE
    -- Company + each normalised identity, in key order: two referrals of the same person never both pass the checks.
    FOR v_key IN SELECT k FROM unnest(ARRAY[
      CASE WHEN v_email IS NOT NULL THEN hashtextextended('recruitment-referral:' || v_tenant::text || ':' || j.company_id::text || ':email:' || v_email, 0) END,
      CASE WHEN v_mobile IS NOT NULL THEN hashtextextended('recruitment-referral:' || v_tenant::text || ':' || j.company_id::text || ':mobile:' || v_mobile, 0) END
     ]) AS k WHERE k IS NOT NULL ORDER BY k LOOP
     PERFORM pg_advisory_xact_lock(v_key);
    END LOOP;
    -- Each identity on its own slice 5 expression index (company + normalised value), then the candidate's applications.
    IF EXISTS (SELECT 1 FROM public.recruitment_candidate c JOIN public.recruitment_application a ON a.candidate_id = c.id AND a.tenant_id = c.tenant_id
       WHERE v_email IS NOT NULL AND c.tenant_id = v_tenant AND c.company_id = j.company_id AND c.email IS NOT NULL
        AND app.recruitment_norm_email(c.email) = v_email AND c.destroyed_at IS NULL AND a.job_id = j.id AND a.state <> 'archived')
     OR EXISTS (SELECT 1 FROM public.recruitment_candidate c JOIN public.recruitment_application a ON a.candidate_id = c.id AND a.tenant_id = c.tenant_id
       WHERE v_mobile IS NOT NULL AND c.tenant_id = v_tenant AND c.company_id = j.company_id AND c.phone IS NOT NULL
        AND app.recruitment_norm_mobile(c.phone) = v_mobile AND c.destroyed_at IS NULL AND a.job_id = j.id AND a.state <> 'archived') THEN
     v_reason := 'similar_application';
    ELSE
     v_days := coalesce((SELECT s.referral_protection_days FROM public.recruitment_company_setting s
      WHERE s.company_id = j.company_id AND s.tenant_id = v_tenant), 180);
     -- Within the period = referred on or after the Kuala Lumpur day (today - days + 1), as an instant bound.
     v_since := ((v_today - v_days + 1)::timestamp AT TIME ZONE 'Asia/Kuala_Lumpur');
     IF v_days > 0 AND (EXISTS (SELECT 1 FROM public.recruitment_candidate c JOIN public.recruitment_referral r ON r.candidate_id = c.id AND r.tenant_id = c.tenant_id
        WHERE v_email IS NOT NULL AND c.tenant_id = v_tenant AND c.company_id = j.company_id AND c.email IS NOT NULL
         AND app.recruitment_norm_email(c.email) = v_email AND c.destroyed_at IS NULL AND r.referrer_person_id <> v_person AND r.created_at >= v_since)
      OR EXISTS (SELECT 1 FROM public.recruitment_candidate c JOIN public.recruitment_referral r ON r.candidate_id = c.id AND r.tenant_id = c.tenant_id
        WHERE v_mobile IS NOT NULL AND c.tenant_id = v_tenant AND c.company_id = j.company_id AND c.phone IS NOT NULL
         AND app.recruitment_norm_mobile(c.phone) = v_mobile AND c.destroyed_at IS NULL AND r.referrer_person_id <> v_person AND r.created_at >= v_since)) THEN
      v_reason := 'already_referred';
     ELSE
      SELECT ps.stage_id INTO v_stage FROM public.recruitment_process_stage ps
       JOIN public.recruitment_stage st ON st.id = ps.stage_id AND st.tenant_id = ps.tenant_id
       WHERE ps.process_id = j.process_id AND ps.tenant_id = v_tenant AND st.enabled ORDER BY ps.position LIMIT 1;
      IF v_stage IS NULL THEN
       v_reason := 'job_unavailable';
      END IF;
     END IF;
    END IF;
   END IF;
  END IF;
 END IF;

 IF v_person IS NOT NULL THEN
  INSERT INTO app.recruitment_referral_attempt (tenant_id, person_id, outcome) VALUES (v_tenant, v_person, coalesce(v_reason, 'accepted'));
 END IF;
 IF v_reason IS NOT NULL THEN
  DELETE FROM app.recruitment_referral_context WHERE txid = txid_current();
  INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
   VALUES (v_tenant, 'recruitment-job', p_job, 'recruitment-referral.refused', 'user', v_user,
    jsonb_build_object('companyId', CASE WHEN v_reason = 'not_eligible' THEN NULL ELSE j.company_id END, 'jobId', p_job, 'reason', v_reason));
  RETURN jsonb_build_object('ok', false, 'reason', v_reason);
 END IF;

 v_candidate := gen_random_uuid();
 INSERT INTO public.recruitment_candidate (id, tenant_id, company_id, full_name, email, phone, source, created_by_user_id, updated_by_user_id)
  VALUES (v_candidate, v_tenant, j.company_id, v_name, nullif(btrim(coalesce(p_email, '')), ''), nullif(btrim(coalesce(p_mobile, '')), ''),
   'referral', v_user, v_user);
 INSERT INTO public.recruitment_application (tenant_id, company_id, job_id, candidate_id, current_stage_id, source, created_by_user_id, updated_by_user_id)
  VALUES (v_tenant, j.company_id, j.id, v_candidate, v_stage, 'referral', v_user, v_user) RETURNING id INTO v_application;
 INSERT INTO public.recruitment_application_event (tenant_id, company_id, application_id, kind, to_stage_id, to_state, actor_user_id)
  VALUES (v_tenant, j.company_id, v_application, 'applied', v_stage, 'active', v_user);
 IF p_file_content IS NOT NULL THEN
  INSERT INTO public.recruitment_candidate_file (tenant_id, company_id, candidate_id, kind, file_name, mime_type, size_bytes, content,
   permission_confirmed, uploaded_by_user_id)
   VALUES (v_tenant, j.company_id, v_candidate, 'resume', btrim(p_file_name), p_file_mime, octet_length(p_file_content), p_file_content, true, v_user);
 END IF;
 INSERT INTO public.recruitment_referral (tenant_id, company_id, job_id, application_id, candidate_id, referrer_person_id, referrer_user_id,
  reason, confirmed_at)
  VALUES (v_tenant, j.company_id, j.id, v_application, v_candidate, v_person, v_user, v_reason_text, now()) RETURNING id INTO v_referral;
 -- Slice 5's duplicate rule, as for every new application: two of name, e-mail and mobile against the company's other
 -- live candidates. A match is flagged for HR (a count only); the referral stands.
 SELECT count(*)::integer INTO v_matches FROM (
  SELECT h.candidate_id FROM (
    SELECT c.id AS candidate_id, 'email'::text AS kind FROM public.recruitment_candidate c
     WHERE v_email IS NOT NULL AND c.tenant_id = v_tenant AND c.company_id = j.company_id AND c.email IS NOT NULL
      AND app.recruitment_norm_email(c.email) = v_email
    UNION ALL
    SELECT c.id, 'name' FROM public.recruitment_candidate c
     WHERE c.tenant_id = v_tenant AND c.company_id = j.company_id AND app.recruitment_norm_name(c.full_name) = app.recruitment_norm_name(v_name)
    UNION ALL
    SELECT c.id, 'mobile' FROM public.recruitment_candidate c
     WHERE v_mobile IS NOT NULL AND c.tenant_id = v_tenant AND c.company_id = j.company_id AND c.phone IS NOT NULL
      AND app.recruitment_norm_mobile(c.phone) = v_mobile
   ) h
   JOIN public.recruitment_candidate x ON x.id = h.candidate_id AND x.destroyed_at IS NULL AND x.id <> v_candidate
   GROUP BY h.candidate_id HAVING count(DISTINCT h.kind) >= 2) matched;
 DELETE FROM app.recruitment_referral_context WHERE txid = txid_current();
 IF v_matches > 0 THEN
  INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
   VALUES (v_tenant, 'recruitment-job', j.id, 'recruitment-candidate.duplicate-flagged', 'user', v_user,
    jsonb_build_object('companyId', j.company_id, 'jobId', j.id, 'matches', v_matches, 'via', 'referral'));
 END IF;
 INSERT INTO public.domain_event (tenant_id, aggregate_type, aggregate_id, event_type, actor_type, actor_id, payload)
  VALUES (v_tenant, 'recruitment-application', v_application, 'recruitment-referral.submitted', 'user', v_user,
   jsonb_build_object('companyId', j.company_id, 'jobId', j.id, 'referralId', v_referral, 'candidateId', v_candidate,
    'resume', p_file_content IS NOT NULL));
 RETURN jsonb_build_object('ok', true, 'referralId', v_referral);
END $$;
REVOKE ALL ON FUNCTION app.recruitment_submit_referral(uuid, text, text, text, text, boolean, text, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_submit_referral(uuid, text, text, text, text, boolean, text, text, bytea) TO ai_hr_app;
--> statement-breakpoint

-- ── 8. Removal: 4405's app.recruitment_destroy_candidate, byte for byte, plus the referral's reason ───────
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
