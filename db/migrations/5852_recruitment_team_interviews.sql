-- Recruitment slice 2 (docs/recruitment-reconstruction/specification.md "Slice 2"): per-job team access, interviews,
-- evaluation forms and scorecards.
--
-- What this installs:
--   1. Four company-scoped tables: company settings (one row per company), evaluation forms, interviews with their
--      interviewers, and scorecards. Each carries tenant_id + company_id, ENABLE + FORCE row security, explicit
--      GRANTs to ai_hr_app and policies on the tenant and the recruitment predicates below.
--   2. Per-job team predicates. A job's team (4401 recruitment_job_member) now confers access to THAT job:
--        recruiter, assistant   → operate the job's applications (app.can_operate_recruitment_job);
--        hiring manager         → also read, move forward, reject and see every scorecard (app.can_review_recruitment_job);
--        interviewer            → read only the applications they are scheduled to interview, write only their own
--                                 feedback (app.recruitment_interviews_application).
--      HR administrators and Recruiting Partners keep company-wide access (app.can_admin_recruitment_for, 4401).
--   3. Additional PERMISSIVE policies on the 4401 tables for team members. The 4401 administrator policies are not
--      touched. No policy reads the table it protects, so no policy recursion is possible: job_member admits a
--      member's own rows only; the interviewer table admits its own rows and reviewers of the job.
--   4. Guards: interviews keep their application and stage; a scorecard is written only by its own interviewer, is
--      never deleted and follows the company feedback edit-lock setting; a used evaluation form keeps its questions.
--
-- Nothing here calls a model. Section totals are sums of whole-number ratings computed by deterministic code.

-- ── 1. Tables ─────────────────────────────────────────────────────────────────────────────────────────────
-- The interview keys below carry (application_id, job_id, company_id, tenant_id), so an interview can only belong to
-- an application of its own job and company.
ALTER TABLE public.recruitment_application
 ADD CONSTRAINT recruitment_application_job_scope_uq UNIQUE (id, job_id, company_id, tenant_id);
--> statement-breakpoint

-- Company recruitment settings: one row per company, written when an administrator first opens Recruitment. A
-- missing row reads as the defaults below (scorecards private, edit lock "until the stage is left", result required).
CREATE TABLE public.recruitment_company_setting (
 company_id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 scorecards_private boolean NOT NULL DEFAULT true,
 feedback_edit_lock text NOT NULL DEFAULT 'until_stage_left' CHECK (feedback_edit_lock IN ('any_stage','until_stage_left','until_archived')),
 result_required boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_company_setting_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_company_setting_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_company_setting_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
--> statement-breakpoint

-- Evaluation forms. `definition` is {"sections":[{"key","title","criteria":[{"key","label","question"?}]}]}; the pack
-- validates its shape. One default form per company. A form some scorecard used keeps its definition (guard below).
CREATE TABLE public.recruitment_evaluation_form (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
 definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object' AND jsonb_typeof(definition -> 'sections') = 'array'
  AND jsonb_array_length(definition -> 'sections') BETWEEN 1 AND 20),
 is_default boolean NOT NULL DEFAULT false,
 enabled boolean NOT NULL DEFAULT true,
 seed_key text CHECK (seed_key ~ '^[a-z_]{1,40}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_evaluation_form_default_ck CHECK (NOT is_default OR enabled),
 CONSTRAINT recruitment_evaluation_form_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_evaluation_form_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_evaluation_form_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_evaluation_form_scope_uq UNIQUE (id, company_id, tenant_id)
);
CREATE UNIQUE INDEX recruitment_evaluation_form_name_uq ON public.recruitment_evaluation_form (tenant_id, company_id, lower(btrim(name)));
CREATE UNIQUE INDEX recruitment_evaluation_form_default_uq ON public.recruitment_evaluation_form (tenant_id, company_id) WHERE is_default;
CREATE UNIQUE INDEX recruitment_evaluation_form_seed_uq ON public.recruitment_evaluation_form (tenant_id, company_id, seed_key) WHERE seed_key IS NOT NULL;
--> statement-breakpoint

-- An interview of one application. `stage_id` is the stage the application was in when it was scheduled; the
-- feedback edit lock compares the application's later stage with it. Status is DERIVED (pack rules), never stored:
-- Scheduled before its start, Awaiting feedback after its end while an interviewer has not submitted, Feedback
-- complete, or Cancelled.
CREATE TABLE public.recruitment_interview (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 application_id uuid NOT NULL,
 stage_id uuid NOT NULL,
 round_no integer NOT NULL CHECK (round_no BETWEEN 1 AND 20),
 interview_type text NOT NULL CHECK (interview_type IN ('onsite','video','phone')),
 starts_at timestamptz NOT NULL,
 duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 720),
 site text CHECK (site IS NULL OR length(btrim(site)) BETWEEN 1 AND 200),
 meeting_room text CHECK (meeting_room IS NULL OR length(btrim(meeting_room)) BETWEEN 1 AND 120),
 evaluation_form_id uuid NOT NULL,
 candidate_response text NOT NULL DEFAULT 'pending' CHECK (candidate_response IN ('pending','accepted','declined')),
 cancelled_at timestamptz,
 cancelled_by_user_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_interview_cancel_ck CHECK ((cancelled_at IS NULL) = (cancelled_by_user_id IS NULL)),
 CONSTRAINT recruitment_interview_application_fk FOREIGN KEY (application_id, job_id, company_id, tenant_id)
  REFERENCES public.recruitment_application(id, job_id, company_id, tenant_id),
 CONSTRAINT recruitment_interview_stage_fk FOREIGN KEY (stage_id, company_id, tenant_id) REFERENCES public.recruitment_stage(id, company_id, tenant_id),
 CONSTRAINT recruitment_interview_form_fk FOREIGN KEY (evaluation_form_id, company_id, tenant_id) REFERENCES public.recruitment_evaluation_form(id, company_id, tenant_id),
 CONSTRAINT recruitment_interview_cancelled_by_fk FOREIGN KEY (cancelled_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_interview_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_interview_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_interview_scope_uq UNIQUE (id, application_id, job_id, company_id, tenant_id)
);
CREATE INDEX recruitment_interview_application_idx ON public.recruitment_interview (application_id, starts_at);
CREATE INDEX recruitment_interview_company_start_idx ON public.recruitment_interview (tenant_id, company_id, starts_at);
CREATE INDEX recruitment_interview_job_idx ON public.recruitment_interview (job_id);
CREATE INDEX recruitment_interview_stage_idx ON public.recruitment_interview (stage_id);
CREATE INDEX recruitment_interview_form_idx ON public.recruitment_interview (evaluation_form_id);
--> statement-breakpoint

-- The people who interview. Being named here is what lets an interviewer read that one application.
CREATE TABLE public.recruitment_interview_interviewer (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 application_id uuid NOT NULL,
 interview_id uuid NOT NULL,
 app_user_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_interview_interviewer_interview_fk FOREIGN KEY (interview_id, application_id, job_id, company_id, tenant_id)
  REFERENCES public.recruitment_interview(id, application_id, job_id, company_id, tenant_id),
 CONSTRAINT recruitment_interview_interviewer_user_fk FOREIGN KEY (app_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_interview_interviewer_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_interview_interviewer_uq UNIQUE (interview_id, app_user_id)
);
CREATE INDEX recruitment_interview_interviewer_user_idx ON public.recruitment_interview_interviewer (app_user_id, application_id);
CREATE INDEX recruitment_interview_interviewer_application_idx ON public.recruitment_interview_interviewer (application_id);
--> statement-breakpoint

-- One scorecard per interviewer per interview: 1–5 ratings with optional notes per criterion (`ratings` is
-- {"<criterion key>":{"rating":1..5,"notes":"…"}}), an overall result and an overview. Submitted when saved.
CREATE TABLE public.recruitment_scorecard (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 application_id uuid NOT NULL,
 interview_id uuid NOT NULL,
 interviewer_user_id uuid NOT NULL,
 evaluation_form_id uuid NOT NULL,
 ratings jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(ratings) = 'object'),
 result text CHECK (result IN ('recommended','keep_in_view','not_suitable')),
 overview text CHECK (overview IS NULL OR length(overview) <= 5000),
 submitted_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT recruitment_scorecard_interview_fk FOREIGN KEY (interview_id, application_id, job_id, company_id, tenant_id)
  REFERENCES public.recruitment_interview(id, application_id, job_id, company_id, tenant_id),
 CONSTRAINT recruitment_scorecard_interviewer_fk FOREIGN KEY (interview_id, interviewer_user_id)
  REFERENCES public.recruitment_interview_interviewer(interview_id, app_user_id),
 CONSTRAINT recruitment_scorecard_form_fk FOREIGN KEY (evaluation_form_id, company_id, tenant_id) REFERENCES public.recruitment_evaluation_form(id, company_id, tenant_id),
 CONSTRAINT recruitment_scorecard_user_fk FOREIGN KEY (interviewer_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_scorecard_uq UNIQUE (interview_id, interviewer_user_id)
);
CREATE INDEX recruitment_scorecard_application_idx ON public.recruitment_scorecard (application_id);
CREATE INDEX recruitment_scorecard_form_idx ON public.recruitment_scorecard (evaluation_form_id);
--> statement-breakpoint

-- ── 2. Team predicates ────────────────────────────────────────────────────────────────────────────────────
-- Plain STABLE SQL run as the caller: every read below sees only what the caller's row security admits, and the
-- membership and interviewer tables admit a member's own rows, so these answer for the caller and nobody else.
CREATE FUNCTION app.recruitment_has_job_role(p_job uuid, p_roles text[]) RETURNS boolean
 LANGUAGE sql STABLE AS $$
 SELECT EXISTS (SELECT 1 FROM public.recruitment_job_member m
  WHERE m.job_id = p_job AND m.tenant_id = app.current_tenant_id() AND m.app_user_id = app.current_user_id()
   AND m.member_role = ANY (p_roles));
$$;
--> statement-breakpoint
-- Recruiter and recruitment assistant: full operation on the job's applications.
CREATE FUNCTION app.can_operate_recruitment_job(p_company uuid, p_job uuid) RETURNS boolean
 LANGUAGE sql STABLE AS $$
 SELECT app.can_admin_recruitment_for(p_company) OR app.recruitment_has_job_role(p_job, ARRAY['recruiter','assistant']);
$$;
--> statement-breakpoint
-- Also the hiring manager: read the job's applications, move forward or reject, see every scorecard on the job.
CREATE FUNCTION app.can_review_recruitment_job(p_company uuid, p_job uuid) RETURNS boolean
 LANGUAGE sql STABLE AS $$
 SELECT app.can_admin_recruitment_for(p_company) OR app.recruitment_has_job_role(p_job, ARRAY['recruiter','assistant','hiring_manager']);
$$;
--> statement-breakpoint
-- An interviewer named on any interview of the application.
CREATE FUNCTION app.recruitment_interviews_application(p_application uuid) RETURNS boolean
 LANGUAGE sql STABLE AS $$
 SELECT EXISTS (SELECT 1 FROM public.recruitment_interview_interviewer i
  WHERE i.application_id = p_application AND i.tenant_id = app.current_tenant_id() AND i.app_user_id = app.current_user_id());
$$;
--> statement-breakpoint
CREATE FUNCTION app.can_read_recruitment_application(p_company uuid, p_job uuid, p_application uuid) RETURNS boolean
 LANGUAGE sql STABLE AS $$
 SELECT app.can_review_recruitment_job(p_company, p_job) OR app.recruitment_interviews_application(p_application);
$$;
--> statement-breakpoint
-- The caller is on some job team of the company, or interviews for it.
CREATE FUNCTION app.recruitment_team_in_company(p_company uuid) RETURNS boolean
 LANGUAGE sql STABLE AS $$
 SELECT EXISTS (SELECT 1 FROM public.recruitment_job_member m
   WHERE m.company_id = p_company AND m.tenant_id = app.current_tenant_id() AND m.app_user_id = app.current_user_id())
  OR EXISTS (SELECT 1 FROM public.recruitment_interview_interviewer i
   WHERE i.company_id = p_company AND i.tenant_id = app.current_tenant_id() AND i.app_user_id = app.current_user_id());
$$;
--> statement-breakpoint
-- The caller operates (recruiter or assistant on) some job of the company: may add candidates there.
CREATE FUNCTION app.recruitment_operates_in_company(p_company uuid) RETURNS boolean
 LANGUAGE sql STABLE AS $$
 SELECT app.can_admin_recruitment_for(p_company) OR EXISTS (SELECT 1 FROM public.recruitment_job_member m
  WHERE m.company_id = p_company AND m.tenant_id = app.current_tenant_id() AND m.app_user_id = app.current_user_id()
   AND m.member_role IN ('recruiter','assistant'));
$$;
--> statement-breakpoint
CREATE FUNCTION app.can_see_recruitment_company(p_company uuid) RETURNS boolean
 LANGUAGE sql STABLE AS $$
 SELECT app.can_admin_recruitment_for(p_company) OR app.recruitment_team_in_company(p_company);
$$;
--> statement-breakpoint
-- A missing settings row reads as the defaults.
CREATE FUNCTION app.recruitment_scorecards_private(p_company uuid) RETURNS boolean
 LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT s.scorecards_private FROM public.recruitment_company_setting s
  WHERE s.company_id = p_company AND s.tenant_id = app.current_tenant_id()), true);
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.recruitment_has_job_role(uuid, text[]), app.can_operate_recruitment_job(uuid, uuid),
 app.can_review_recruitment_job(uuid, uuid), app.recruitment_interviews_application(uuid),
 app.can_read_recruitment_application(uuid, uuid, uuid), app.recruitment_team_in_company(uuid),
 app.recruitment_operates_in_company(uuid), app.can_see_recruitment_company(uuid), app.recruitment_scorecards_private(uuid) TO ai_hr_app;
--> statement-breakpoint

-- People labels for team members. Same population and the same single column as app.recruitment_user_labels (4401):
-- people employed by the company and recruitment administrators whose grant covers this company (group-wide or
-- this company; another company's partner is not offered as an approver or team member). It admits a caller who
-- administers recruitment for the company OR is on one of its job teams / interviews for it; nobody else gets a row.
CREATE FUNCTION app.recruitment_people_labels(p_company uuid) RETURNS TABLE(app_user_id uuid, full_name text, active boolean, employed boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT u.id, p.full_name, u.archived_at IS NULL,
  EXISTS (SELECT 1 FROM employment e WHERE e.tenant_id = u.tenant_id AND e.person_id = u.person_id AND e.company_id = p_company)
 FROM app_user u JOIN person p ON p.id = u.person_id AND p.tenant_id = u.tenant_id
 WHERE u.tenant_id = app.current_tenant_id() AND app.can_see_recruitment_company(p_company)
  AND (EXISTS (SELECT 1 FROM employment e WHERE e.tenant_id = u.tenant_id AND e.person_id = u.person_id AND e.company_id = p_company)
   OR EXISTS (SELECT 1 FROM role_assignment r WHERE r.tenant_id = u.tenant_id AND r.app_user_id = u.id
    AND (r.company_id IS NULL OR r.company_id = p_company)
    AND r.role::text IN ('hr_admin', 'super_admin', 'recruiting_partner')))
$$;
REVOKE ALL ON FUNCTION app.recruitment_people_labels(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_people_labels(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 3. Row security on the new tables ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_company_setting','recruitment_evaluation_form','recruitment_interview',
  'recruitment_interview_interviewer','recruitment_scorecard'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, ai_hr_app', t);
 END LOOP;
END $$;
--> statement-breakpoint
-- Settings and forms: administrators write; team members read their company's.
CREATE POLICY recruitment_company_setting_admin ON public.recruitment_company_setting FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
CREATE POLICY recruitment_company_setting_team ON public.recruitment_company_setting FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_team_in_company(company_id));
CREATE POLICY recruitment_evaluation_form_admin ON public.recruitment_evaluation_form FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
CREATE POLICY recruitment_evaluation_form_team ON public.recruitment_evaluation_form FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_team_in_company(company_id));
--> statement-breakpoint
-- Interviews: anyone who may read the application reads its interviews; operators schedule and change them.
CREATE POLICY recruitment_interview_read ON public.recruitment_interview FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.can_read_recruitment_application(company_id, job_id, application_id));
CREATE POLICY recruitment_interview_insert ON public.recruitment_interview FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id));
CREATE POLICY recruitment_interview_update ON public.recruitment_interview FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id));
--> statement-breakpoint
-- Interviewers: an interviewer sees their own rows; the job's reviewers and administrators see all. This policy
-- must never read this table (app.recruitment_interviews_application does), so it does not.
CREATE POLICY recruitment_interview_interviewer_read ON public.recruitment_interview_interviewer FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND (app_user_id = app.current_user_id() OR app.can_review_recruitment_job(company_id, job_id)));
CREATE POLICY recruitment_interview_interviewer_insert ON public.recruitment_interview_interviewer FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id));
CREATE POLICY recruitment_interview_interviewer_delete ON public.recruitment_interview_interviewer FOR DELETE
 USING (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id));
--> statement-breakpoint
-- Scorecards: the interviewer reads and writes their own; the job's reviewers (recruiter, assistant, hiring manager)
-- and administrators read all; other interviewers of the application read them only when the company setting makes
-- scorecards shared. Nobody writes another person's feedback, administrators included.
CREATE POLICY recruitment_scorecard_read ON public.recruitment_scorecard FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND (interviewer_user_id = app.current_user_id()
  OR app.can_review_recruitment_job(company_id, job_id)
  OR (NOT app.recruitment_scorecards_private(company_id) AND app.recruitment_interviews_application(application_id))));
CREATE POLICY recruitment_scorecard_insert ON public.recruitment_scorecard FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND interviewer_user_id = app.current_user_id());
CREATE POLICY recruitment_scorecard_update ON public.recruitment_scorecard FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND interviewer_user_id = app.current_user_id())
 WITH CHECK (tenant_id = app.current_tenant_id() AND interviewer_user_id = app.current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.recruitment_company_setting, public.recruitment_evaluation_form,
 public.recruitment_interview, public.recruitment_scorecard TO ai_hr_app;
GRANT SELECT, INSERT, DELETE ON public.recruitment_interview_interviewer TO ai_hr_app;
--> statement-breakpoint

-- ── 4. Team policies on the 4401 tables (added beside the administrator policies, which stay as they are) ───
CREATE POLICY recruitment_job_member_self ON public.recruitment_job_member FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app_user_id = app.current_user_id());
CREATE POLICY recruitment_job_opening_team ON public.recruitment_job_opening FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND (
  app.recruitment_has_job_role(id, ARRAY['recruiter','assistant','hiring_manager','interviewer'])
  OR EXISTS (SELECT 1 FROM public.recruitment_interview_interviewer i
   WHERE i.job_id = recruitment_job_opening.id AND i.tenant_id = recruitment_job_opening.tenant_id AND i.app_user_id = app.current_user_id())));
CREATE POLICY recruitment_stage_team ON public.recruitment_stage FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_team_in_company(company_id));
CREATE POLICY recruitment_process_team ON public.recruitment_process FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_team_in_company(company_id));
CREATE POLICY recruitment_process_stage_team ON public.recruitment_process_stage FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_team_in_company(company_id));
CREATE POLICY recruitment_archive_reason_team ON public.recruitment_archive_reason FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_team_in_company(company_id));
--> statement-breakpoint
-- Applications: readers per app.can_read_recruitment_application; operators add; reviewers move and reject.
CREATE POLICY recruitment_application_team_read ON public.recruitment_application FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.can_read_recruitment_application(company_id, job_id, id));
CREATE POLICY recruitment_application_team_insert ON public.recruitment_application FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id));
CREATE POLICY recruitment_application_team_update ON public.recruitment_application FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND app.can_review_recruitment_job(company_id, job_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_review_recruitment_job(company_id, job_id));
--> statement-breakpoint
-- Candidates: visible through an application the caller may read; operators of a job in the company add them.
CREATE POLICY recruitment_candidate_team_read ON public.recruitment_candidate FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND EXISTS (SELECT 1 FROM public.recruitment_application a
  WHERE a.candidate_id = recruitment_candidate.id AND a.tenant_id = recruitment_candidate.tenant_id));
CREATE POLICY recruitment_candidate_team_insert ON public.recruitment_candidate FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.recruitment_operates_in_company(company_id));
--> statement-breakpoint
-- Application history: readable with the application; appended by whoever may move it.
CREATE POLICY recruitment_application_event_team_read ON public.recruitment_application_event FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND EXISTS (SELECT 1 FROM public.recruitment_application a
  WHERE a.id = recruitment_application_event.application_id AND a.tenant_id = recruitment_application_event.tenant_id));
CREATE POLICY recruitment_application_event_team_insert ON public.recruitment_application_event FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND EXISTS (SELECT 1 FROM public.recruitment_application a
  WHERE a.id = recruitment_application_event.application_id AND a.tenant_id = recruitment_application_event.tenant_id
   AND app.can_review_recruitment_job(a.company_id, a.job_id)));
--> statement-breakpoint

-- ── 5. Guards ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TRIGGER recruitment_company_setting_identity BEFORE UPDATE ON public.recruitment_company_setting
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_identity();
CREATE TRIGGER recruitment_interview_interviewer_identity BEFORE UPDATE ON public.recruitment_interview_interviewer
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_identity();
--> statement-breakpoint

-- Evaluation forms: a form some scorecard or interview uses keeps its definition; the seed identity never moves.
CREATE FUNCTION app.recruitment_guard_evaluation_form() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.seed_key IS DISTINCT FROM OLD.seed_key THEN
  RAISE EXCEPTION 'An evaluation form keeps its company' USING ERRCODE = '23514';
 END IF;
 IF NEW.definition IS DISTINCT FROM OLD.definition AND EXISTS (
  SELECT 1 FROM public.recruitment_interview i WHERE i.evaluation_form_id = OLD.id AND i.tenant_id = OLD.tenant_id) THEN
  RAISE EXCEPTION 'An evaluation form in use keeps its questions; create a new form instead' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_evaluation_form() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_evaluation_form_guard BEFORE UPDATE ON public.recruitment_evaluation_form
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_evaluation_form();
--> statement-breakpoint

-- Interviews: scheduled for an active application at its current stage by the current user; they keep their
-- application, stage and scheduler; a cancelled interview is closed; the form is fixed once feedback exists.
CREATE FUNCTION app.recruitment_guard_interview() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE a public.recruitment_application%ROWTYPE;
BEGIN
 IF TG_OP = 'INSERT' THEN
  SELECT * INTO a FROM public.recruitment_application WHERE id = NEW.application_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR a.state <> 'active' THEN
   RAISE EXCEPTION 'Interviews are scheduled for active applications only' USING ERRCODE = '23514';
  END IF;
  IF NEW.stage_id IS DISTINCT FROM a.current_stage_id THEN
   RAISE EXCEPTION 'An interview records the application''s current stage' USING ERRCODE = '23514';
  END IF;
  IF NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() OR NEW.cancelled_at IS NOT NULL THEN
   RAISE EXCEPTION 'An interview is scheduled by the current user' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.recruitment_evaluation_form f WHERE f.id = NEW.evaluation_form_id AND f.enabled) THEN
   RAISE EXCEPTION 'Choose an enabled evaluation form' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
  OR NEW.application_id IS DISTINCT FROM OLD.application_id OR NEW.stage_id IS DISTINCT FROM OLD.stage_id
  OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
  RAISE EXCEPTION 'An interview keeps its application and stage' USING ERRCODE = '23514';
 END IF;
 IF OLD.cancelled_at IS NOT NULL THEN
  RAISE EXCEPTION 'A cancelled interview is closed' USING ERRCODE = '23514';
 END IF;
 IF NEW.cancelled_at IS NOT NULL AND NEW.cancelled_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'A cancellation records the current user' USING ERRCODE = '42501';
 END IF;
 IF NEW.evaluation_form_id IS DISTINCT FROM OLD.evaluation_form_id AND EXISTS (
  SELECT 1 FROM public.recruitment_scorecard s WHERE s.interview_id = OLD.id) THEN
  RAISE EXCEPTION 'The evaluation form is fixed once feedback exists' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_interview() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_interview_guard BEFORE INSERT OR UPDATE ON public.recruitment_interview
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_interview();
--> statement-breakpoint

-- Interviewers: added only to an open interview; removed only while they have no feedback (the scorecard key refuses).
CREATE FUNCTION app.recruitment_guard_interviewer() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM public.recruitment_interview i
  WHERE i.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.interview_id ELSE NEW.interview_id END AND i.cancelled_at IS NOT NULL) THEN
  RAISE EXCEPTION 'A cancelled interview is closed' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_interviewer() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_interview_interviewer_guard BEFORE INSERT OR DELETE ON public.recruitment_interview_interviewer
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_interviewer();
--> statement-breakpoint

-- Scorecards: the interviewer's own, on an open interview, on the interview's form, never deleted, and — when
-- edited — only while the company's feedback edit lock allows it:
--   any_stage         always;
--   until_stage_left  while the application is active and not at a later stage than the interview's (default);
--   until_archived    while the application is not archived.
CREATE FUNCTION app.recruitment_guard_scorecard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE i public.recruitment_interview%ROWTYPE; a public.recruitment_application%ROWTYPE; lock text; cur integer; was integer;
BEGIN
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
REVOKE ALL ON FUNCTION app.recruitment_guard_scorecard() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_scorecard_guard BEFORE INSERT OR UPDATE OR DELETE ON public.recruitment_scorecard
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_scorecard();
--> statement-breakpoint

-- ── 6. Deleting a company (core/company-refs.ts) ──────────────────────────────────────────────────────────
-- The 4401 remover, restated with the two new setup tables (settings and evaluation forms) removed first. Forms are
-- referenced only by interviews and scorecards, which need a job opening — and a job opening refuses the delete.
CREATE OR REPLACE FUNCTION app.recruitment_delete_company_setup(p_company uuid) RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE removed integer := 0; n integer;
BEGIN
 IF p_company IS NULL OR app.current_tenant_id() IS NULL OR NOT app.is_admin_for(p_company) THEN
  RAISE EXCEPTION 'Deleting a company''s recruitment setup needs its administrator' USING ERRCODE = '42501';
 END IF;
 IF EXISTS (SELECT 1 FROM public.recruitment_job_opening WHERE tenant_id = app.current_tenant_id() AND company_id = p_company)
  OR EXISTS (SELECT 1 FROM public.recruitment_candidate WHERE tenant_id = app.current_tenant_id() AND company_id = p_company) THEN
  RAISE EXCEPTION 'The company has recruitment history' USING ERRCODE = '23503';
 END IF;
 PERFORM set_config('app.recruitment_company_delete', p_company::text, true);
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
