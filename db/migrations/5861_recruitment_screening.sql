-- Recruitment slice 11 (docs/recruitment-reconstruction/specification.md "Slice 11"): resume screening by hiring managers.
--
-- A job's recruiter, its assistants or a recruitment administrator sends an application to one or more of the job's hiring
-- managers for screening; each named reviewer answers Advance, Reject or Pending (one fixed company form, D-040), with an
-- optional comment. Pending keeps the request open and may be followed by another answer; Advance or Reject closes it. An
-- answer never moves or rejects the application by itself: the recruiter acts on it through the slice 1 moves. Reviewers
-- are the job's hiring managers only (D-041).
--
-- What this installs:
--   1. Two tables, each with tenant_id + company_id, ENABLE + FORCE row security, explicit GRANTs to ai_hr_app and none to
--      PUBLIC:
--        recruitment_screening_request   one reviewer asked about one application: who sent it and when, an optional note,
--                                        and how it closed — answered (Advance or Reject), withdrawn, or closed by itself
--                                        because the application was archived or hired (application_closed) or the reviewer
--                                        stopped being a hiring manager of the job (reviewer_removed). At most one OPEN
--                                        request per application and reviewer (partial unique index).
--        recruitment_screening_answer    the reviewer's answers to their request, append-only: result, optional comment,
--                                        when and by whom.
--   2. Row security. Requests: the job's operators (recruiter, assistants) and recruitment administrators read every request
--      on the job and send, reassign and withdraw; a reviewer reads only their OWN requests, and only while they are still a
--      hiring manager of the job. Answers: read like scorecards (4402) by the job's reviewers — operators, administrators
--      and its hiring managers — so another hiring manager of the job sees the answers on an application; written only by
--      the current user as themselves. Interviewers, approvers, other jobs' teams, other companies and tenants see nothing.
--   3. Guards (run as the caller): a request is sent open by the current user, by an operator of the job or an administrator,
--      for an ACTIVE application, to a CURRENT hiring manager of the job; it keeps its application, reviewer, sender, time
--      and note; it is closed once — withdrawn by an operator or administrator, answered by its reviewer after their own
--      Advance or Reject, or closed by itself (5) — and never deleted. An answer is given by the named reviewer, still a
--      hiring manager of the job, on their own OPEN request of an ACTIVE application; it is never changed or deleted.
--   4. app.recruitment_job_hiring_managers(job) (STABLE SECURITY DEFINER, writes nothing): the user ids of a job's hiring
--      managers, to an operator or administrator of that job only (the reviewer choice and the send guard). A team member
--      reads only their own membership row (4402), so the definer reads the others' rows through an owner-only policy on
--      recruitment_job_member that admits hiring-manager rows of the ONE job named in a transaction-local setting, which
--      this function sets only after checking the caller operates or administers that job and which its own SET clause
--      restores on return. The app role never satisfies that policy (current_user is never the owner); the only owner-run
--      code reading recruitment_job_member is this function (test/recruitment-screening.test.ts pins the list).
--   5. Requests close by themselves, in the same transaction and without an answer, when the application leaves Active
--      (archived or hired) and when the reviewer stops being a hiring manager of the job (removed from the team or given
--      another role): two owner-run triggers (a hiring manager may archive, and cannot update other reviewers' requests),
--      admitted by owner-only policies bound to the one application or (job, reviewer) they are closing (D-042).
--   6. app.recruitment_destroy_candidate restated (4410 body byte for byte) plus one step: screening notes and feedback
--      comments of the person's applications are cleared (owner-bound, marker-bound policies admit exactly those rows).
--      app.recruitment_delete_company_setup restated (4410 body byte for byte) plus the two new tables, which can only hold
--      rows with an application — whose job opening refuses the delete first.
--
-- Nothing here calls a model, scores a résumé, sends a message or moves an application.

-- ── 1. Tables ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.recruitment_screening_request (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 application_id uuid NOT NULL,
 reviewer_user_id uuid NOT NULL,
 sent_by_user_id uuid NOT NULL,
 sent_at timestamptz NOT NULL DEFAULT now(),
 note text CHECK (note IS NULL OR char_length(btrim(note)) BETWEEN 1 AND 1000),
 closed_at timestamptz,
 closed_reason text CHECK (closed_reason IN ('answered','withdrawn','application_closed','reviewer_removed')),
 -- Who closed it: the reviewer (answered), the operator (withdrawn), or whoever archived, hired or changed the team (closed by
 -- itself; none when no user was signed in).
 closed_by_user_id uuid,
 CONSTRAINT recruitment_screening_request_closed_ck CHECK ((closed_at IS NULL) = (closed_reason IS NULL)
  AND (closed_at IS NOT NULL OR closed_by_user_id IS NULL)
  AND (closed_reason NOT IN ('answered','withdrawn') OR closed_by_user_id IS NOT NULL)),
 CONSTRAINT recruitment_screening_request_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_screening_request_application_fk FOREIGN KEY (application_id, job_id, company_id, tenant_id)
  REFERENCES public.recruitment_application(id, job_id, company_id, tenant_id),
 CONSTRAINT recruitment_screening_request_reviewer_fk FOREIGN KEY (reviewer_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_screening_request_sent_by_fk FOREIGN KEY (sent_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_screening_request_closed_by_fk FOREIGN KEY (closed_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_screening_request_scope_uq UNIQUE (id, application_id, job_id, company_id, tenant_id)
);
-- A reviewer is not asked twice while a request is open.
CREATE UNIQUE INDEX recruitment_screening_request_open_uq ON public.recruitment_screening_request (application_id, reviewer_user_id) WHERE closed_at IS NULL;
CREATE INDEX recruitment_screening_request_application_idx ON public.recruitment_screening_request (application_id, sent_at);
-- The reviewer's open requests (the bell, the To screen list), newest first.
CREATE INDEX recruitment_screening_request_reviewer_open_idx ON public.recruitment_screening_request (tenant_id, reviewer_user_id, sent_at DESC) WHERE closed_at IS NULL;
CREATE INDEX recruitment_screening_request_job_idx ON public.recruitment_screening_request (job_id);
CREATE INDEX recruitment_screening_request_company_idx ON public.recruitment_screening_request (tenant_id, company_id);
CREATE INDEX recruitment_screening_request_reviewer_idx ON public.recruitment_screening_request (reviewer_user_id);
CREATE INDEX recruitment_screening_request_sent_by_idx ON public.recruitment_screening_request (sent_by_user_id);
CREATE INDEX recruitment_screening_request_closed_by_idx ON public.recruitment_screening_request (closed_by_user_id) WHERE closed_by_user_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE public.recruitment_screening_answer (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 application_id uuid NOT NULL,
 request_id uuid NOT NULL,
 result text NOT NULL CHECK (result IN ('advance','reject','pending')),
 comment text CHECK (comment IS NULL OR char_length(btrim(comment)) BETWEEN 1 AND 2000),
 answered_at timestamptz NOT NULL DEFAULT now(),
 answered_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_screening_answer_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_screening_answer_request_fk FOREIGN KEY (request_id, application_id, job_id, company_id, tenant_id)
  REFERENCES public.recruitment_screening_request(id, application_id, job_id, company_id, tenant_id),
 CONSTRAINT recruitment_screening_answer_answered_by_fk FOREIGN KEY (answered_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id)
);
CREATE INDEX recruitment_screening_answer_request_idx ON public.recruitment_screening_answer (request_id, answered_at);
-- The latest answer of an application (its assignment status) and the job's answers newest first (the Applications updates).
CREATE INDEX recruitment_screening_answer_application_idx ON public.recruitment_screening_answer (application_id, answered_at DESC, id DESC);
CREATE INDEX recruitment_screening_answer_job_idx ON public.recruitment_screening_answer (job_id, answered_at DESC, id DESC);
CREATE INDEX recruitment_screening_answer_company_idx ON public.recruitment_screening_answer (tenant_id, company_id);
CREATE INDEX recruitment_screening_answer_answered_by_idx ON public.recruitment_screening_answer (answered_by_user_id);
--> statement-breakpoint

-- ── 2. The job's hiring managers ──────────────────────────────────────────────────────────────────────────
-- Owner-only: the hiring-manager rows of the ONE job named in the transaction-local setting app.recruitment_screening_job.
-- Only app.recruitment_job_hiring_managers sets it, after checking that the session user operates or administers that job,
-- and its SET clause restores the previous value when it returns. A setting is not a write, so the read works in a read-only
-- transaction. The policy calls no function that reads recruitment_job_member, so it cannot recurse. A value the app role sets
-- itself opens nothing to it (current_user is never the owner), and no other owner-run code reads recruitment_job_member
-- (pinned by test/recruitment-screening.test.ts): the invoker predicates (app.recruitment_has_job_role and friends) read only
-- the session user's own rows.
CREATE POLICY recruitment_job_member_screening_read ON public.recruitment_job_member FOR SELECT
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_job_member'::regclass))
  AND tenant_id = app.current_tenant_id() AND member_role = 'hiring_manager'
  AND job_id::text = current_setting('app.recruitment_screening_job', true));
--> statement-breakpoint
-- The user ids of the job's hiring managers, oldest membership first, for an operator (recruiter, assistant) or administrator
-- of the job; nothing for anybody else. Ids only: names come from app.recruitment_people_labels like every other picker.
-- STABLE and write-free (no transaction id, works in read-only transactions and on replicas).
CREATE FUNCTION app.recruitment_job_hiring_managers(p_job uuid) RETURNS TABLE(app_user_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on
 SET app.recruitment_screening_job = '' AS $$
DECLARE v_company uuid; v_tenant uuid;
BEGIN
 IF p_job IS NULL OR app.current_tenant_id() IS NULL OR app.current_user_id() IS NULL THEN RETURN; END IF;
 SELECT j.company_id, j.tenant_id INTO v_company, v_tenant FROM public.recruitment_job_opening j
  WHERE j.id = p_job AND j.tenant_id = app.current_tenant_id();
 IF NOT FOUND OR NOT app.can_operate_recruitment_job(v_company, p_job) THEN RETURN; END IF;
 PERFORM set_config('app.recruitment_screening_job', p_job::text, true);
 RETURN QUERY SELECT m.app_user_id FROM public.recruitment_job_member m
  WHERE m.job_id = p_job AND m.tenant_id = v_tenant AND m.member_role = 'hiring_manager' ORDER BY m.created_at, m.app_user_id;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_job_hiring_managers(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_job_hiring_managers(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 3. Row security and grants ──────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_screening_request','recruitment_screening_answer'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, ai_hr_app', t);
 END LOOP;
END $$;
--> statement-breakpoint
-- Requests: the job's operators and administrators read, send, reassign and withdraw every request on the job.
CREATE POLICY recruitment_screening_request_operate_read ON public.recruitment_screening_request FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id));
CREATE POLICY recruitment_screening_request_insert ON public.recruitment_screening_request FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id));
CREATE POLICY recruitment_screening_request_operate_update ON public.recruitment_screening_request FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id));
-- A reviewer reads their own requests while they are a hiring manager of the job, and closes an open one as answered (the
-- guard admits nothing else: only after their own Advance or Reject).
CREATE POLICY recruitment_screening_request_own_read ON public.recruitment_screening_request FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND reviewer_user_id = app.current_user_id()
  AND app.recruitment_has_job_role(job_id, ARRAY['hiring_manager']));
CREATE POLICY recruitment_screening_request_own_update ON public.recruitment_screening_request FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND reviewer_user_id = app.current_user_id() AND closed_at IS NULL)
 WITH CHECK (tenant_id = app.current_tenant_id() AND reviewer_user_id = app.current_user_id());
-- Answers: the job's reviewers (operators, administrators and its hiring managers) read them, like scorecards; the current
-- user writes only as themselves (the guard requires the named reviewer of an open request).
CREATE POLICY recruitment_screening_answer_read ON public.recruitment_screening_answer FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.can_review_recruitment_job(company_id, job_id));
CREATE POLICY recruitment_screening_answer_insert ON public.recruitment_screening_answer FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND answered_by_user_id = app.current_user_id());
--> statement-breakpoint
-- Owner-bound maintenance. The app role never satisfies these (current_user is ai_hr_app, never the owner); the owner does
-- only inside app.recruitment_destroy_candidate for the candidate whose 4405 marker THIS transaction holds (clearing notes and
-- comments), and inside app.recruitment_delete_company_setup for the company it is deleting.
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_screening_request','recruitment_screening_answer'] LOOP
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND app.recruitment_destroying_application(application_id))', t || '_destroy_read', t, 'public.' || t);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND app.recruitment_destroying_application(application_id))
   WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND app.recruitment_destroying_application(application_id))', t || '_destroy', t, 'public.' || t, 'public.' || t);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND current_setting(''app.recruitment_company_delete'', true) = company_id::text)', t || '_company_delete_read', t, 'public.' || t);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE USING (
   current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = %L::regclass))
   AND tenant_id = app.current_tenant_id() AND current_setting(''app.recruitment_company_delete'', true) = company_id::text)', t || '_company_delete', t, 'public.' || t);
 END LOOP;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.recruitment_screening_request TO ai_hr_app;
GRANT SELECT, INSERT ON public.recruitment_screening_answer TO ai_hr_app;
--> statement-breakpoint

-- ── 4. Guards ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION app.recruitment_guard_screening_request() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE a_state text; closing text;
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF current_setting('app.recruitment_company_delete', true) IS DISTINCT FROM OLD.company_id::text THEN
   RAISE EXCEPTION 'A screening request is never deleted; withdraw it instead' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP = 'UPDATE' AND app.recruitment_destroying_application(OLD.application_id) THEN
  -- Removing the candidate's personal data clears the note; reviewer, sender, times and closing stay.
  IF (to_jsonb(NEW) - 'note') IS DISTINCT FROM (to_jsonb(OLD) - 'note') OR NEW.note IS NOT NULL THEN
   RAISE EXCEPTION 'Removing a candidate''s personal data clears the screening note only' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
 END IF;
 IF TG_OP = 'INSERT' THEN
  IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.sent_by_user_id IS DISTINCT FROM app.current_user_id()
   OR NEW.closed_at IS NOT NULL OR NEW.closed_reason IS NOT NULL OR NEW.closed_by_user_id IS NOT NULL THEN
   RAISE EXCEPTION 'A screening request is sent open, by the current user' USING ERRCODE = '42501';
  END IF;
  IF NOT app.can_operate_recruitment_job(NEW.company_id, NEW.job_id) THEN
   RAISE EXCEPTION 'Only the job''s recruiter, assistants and recruitment administrators send screening requests' USING ERRCODE = '42501';
  END IF;
  SELECT a.state INTO a_state FROM public.recruitment_application a WHERE a.id = NEW.application_id AND a.tenant_id = NEW.tenant_id FOR SHARE;
  IF a_state IS DISTINCT FROM 'active' THEN
   RAISE EXCEPTION 'Archived and hired applications are not sent for screening' USING ERRCODE = '23514',
    CONSTRAINT = 'recruitment_screening_request_application_active';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app.recruitment_job_hiring_managers(NEW.job_id) h WHERE h.app_user_id = NEW.reviewer_user_id) THEN
   RAISE EXCEPTION 'A screening reviewer is a hiring manager of the job' USING ERRCODE = '23514',
    CONSTRAINT = 'recruitment_screening_request_reviewer_hiring_manager';
  END IF;
  NEW.sent_at := now();
  RETURN NEW;
 END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
  OR NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.application_id IS DISTINCT FROM OLD.application_id
  OR NEW.reviewer_user_id IS DISTINCT FROM OLD.reviewer_user_id OR NEW.sent_by_user_id IS DISTINCT FROM OLD.sent_by_user_id
  OR NEW.sent_at IS DISTINCT FROM OLD.sent_at OR NEW.note IS DISTINCT FROM OLD.note THEN
  RAISE EXCEPTION 'A screening request keeps its application, reviewer, sender and note' USING ERRCODE = '23514';
 END IF;
 IF OLD.closed_at IS NOT NULL THEN
  RAISE EXCEPTION 'A closed screening request is final' USING ERRCODE = '23514';
 END IF;
 IF NEW.closed_at IS NULL THEN
  IF NEW.closed_reason IS NOT NULL OR NEW.closed_by_user_id IS NOT NULL THEN
   RAISE EXCEPTION 'An open screening request has no closing' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
 END IF;
 -- Closed by itself (5): only owner-run code, and only for the one application or (job, reviewer) it is closing.
 IF NEW.closed_reason IN ('application_closed','reviewer_removed') THEN
  closing := CASE NEW.closed_reason WHEN 'application_closed' THEN 'application:' || OLD.application_id::text
   ELSE 'reviewer:' || OLD.job_id::text || ':' || OLD.reviewer_user_id::text END;
  IF current_user IS DISTINCT FROM pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_screening_request'::regclass))
   OR current_setting('app.recruitment_screening_closing', true) IS DISTINCT FROM closing THEN
   RAISE EXCEPTION 'A screening request closes by itself only when its application or its reviewer leaves' USING ERRCODE = '42501';
  END IF;
  NEW.closed_at := now();
  NEW.closed_by_user_id := app.current_user_id();
  RETURN NEW;
 END IF;
 IF NEW.closed_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'Closing a screening request records the current user' USING ERRCODE = '42501';
 END IF;
 IF NEW.closed_reason = 'withdrawn' AND NOT app.can_operate_recruitment_job(NEW.company_id, NEW.job_id) THEN
  RAISE EXCEPTION 'Only the job''s recruiter, assistants and recruitment administrators withdraw screening requests' USING ERRCODE = '42501';
 END IF;
 IF NEW.closed_reason = 'answered' AND (NEW.reviewer_user_id IS DISTINCT FROM app.current_user_id() OR NOT EXISTS (
  SELECT 1 FROM public.recruitment_screening_answer x WHERE x.request_id = OLD.id AND x.tenant_id = OLD.tenant_id
   AND x.answered_by_user_id = app.current_user_id() AND x.result IN ('advance','reject'))) THEN
  RAISE EXCEPTION 'A screening request is answered by its reviewer''s own Advance or Reject' USING ERRCODE = '42501';
 END IF;
 NEW.closed_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_screening_request() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_screening_request_guard BEFORE INSERT OR UPDATE OR DELETE ON public.recruitment_screening_request
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_screening_request();
--> statement-breakpoint
CREATE FUNCTION app.recruitment_guard_screening_answer() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE q public.recruitment_screening_request%ROWTYPE;
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF current_setting('app.recruitment_company_delete', true) IS DISTINCT FROM OLD.company_id::text THEN
   RAISE EXCEPTION 'Screening feedback is never deleted' USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP = 'UPDATE' THEN
  IF app.recruitment_destroying_application(OLD.application_id) THEN
   -- Removing the candidate's personal data clears the comment; the result, reviewer and time stay.
   IF (to_jsonb(NEW) - 'comment') IS DISTINCT FROM (to_jsonb(OLD) - 'comment') OR NEW.comment IS NOT NULL THEN
    RAISE EXCEPTION 'Removing a candidate''s personal data clears the screening comment only' USING ERRCODE = '42501';
   END IF;
   RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Screening feedback is kept as given; answer again instead' USING ERRCODE = '23514';
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM app.current_tenant_id() OR NEW.answered_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'Screening feedback is given by the current user' USING ERRCODE = '42501';
 END IF;
 SELECT * INTO q FROM public.recruitment_screening_request WHERE id = NEW.request_id AND tenant_id = NEW.tenant_id;
 IF NOT FOUND OR q.reviewer_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'Only the named reviewer answers their own screening request' USING ERRCODE = '42501';
 END IF;
 IF NOT app.recruitment_has_job_role(q.job_id, ARRAY['hiring_manager']) THEN
  RAISE EXCEPTION 'A screening reviewer is a hiring manager of the job' USING ERRCODE = '42501';
 END IF;
 IF q.closed_at IS NOT NULL THEN
  RAISE EXCEPTION 'A withdrawn or answered screening request cannot be answered' USING ERRCODE = '23514';
 END IF;
 -- The open request row is locked: two answers to one request, or an answer and a withdrawal, take turns; one that finds
 -- the request closed meanwhile gets nothing back here and is refused.
 PERFORM 1 FROM public.recruitment_screening_request WHERE id = q.id AND tenant_id = q.tenant_id AND closed_at IS NULL FOR UPDATE;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'A withdrawn or answered screening request cannot be answered' USING ERRCODE = '23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.recruitment_application a WHERE a.id = q.application_id AND a.tenant_id = q.tenant_id AND a.state = 'active') THEN
  RAISE EXCEPTION 'Screening feedback is given on active applications' USING ERRCODE = '23514';
 END IF;
 -- The statement clock, so two answers in one transaction keep their order ("latest" is the most recent answer).
 NEW.answered_at := clock_timestamp();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_screening_answer() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_screening_answer_guard BEFORE INSERT OR UPDATE OR DELETE ON public.recruitment_screening_answer
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_screening_answer();
--> statement-breakpoint
-- Advance or Reject closes the request as answered, as the reviewer (their own-request update policy; the request guard
-- checks the answer exists). Pending leaves it open for another answer.
CREATE FUNCTION app.recruitment_screening_answered() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF NEW.result IN ('advance','reject') THEN
  UPDATE public.recruitment_screening_request SET closed_at = now(), closed_reason = 'answered', closed_by_user_id = app.current_user_id()
   WHERE id = NEW.request_id AND tenant_id = NEW.tenant_id AND closed_at IS NULL;
  IF NOT FOUND THEN
   RAISE EXCEPTION 'A withdrawn or answered screening request cannot be answered' USING ERRCODE = '23514';
  END IF;
 END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_screening_answered() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_screening_answer_closes AFTER INSERT ON public.recruitment_screening_answer
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_screening_answered();
--> statement-breakpoint

-- ── 4b. Requests close by themselves (D-042) ────────────────────────────────────────────────────────────────
-- Owner-only, bound to the ONE application or (job, reviewer) the closing triggers below name in the transaction-local setting
-- app.recruitment_screening_closing (their SET clauses restore it on return). The app role never satisfies these; the guard
-- admits the two automatic reasons only from the owner with the matching setting.
CREATE POLICY recruitment_screening_request_auto_close_read ON public.recruitment_screening_request FOR SELECT
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_screening_request'::regclass))
  AND tenant_id = app.current_tenant_id() AND closed_at IS NULL
  AND current_setting('app.recruitment_screening_closing', true) IN ('application:' || application_id::text, 'reviewer:' || job_id::text || ':' || reviewer_user_id::text));
CREATE POLICY recruitment_screening_request_auto_close ON public.recruitment_screening_request FOR UPDATE
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_screening_request'::regclass))
  AND tenant_id = app.current_tenant_id() AND closed_at IS NULL
  AND current_setting('app.recruitment_screening_closing', true) IN ('application:' || application_id::text, 'reviewer:' || job_id::text || ':' || reviewer_user_id::text))
 WITH CHECK (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_screening_request'::regclass))
  AND tenant_id = app.current_tenant_id()
  AND current_setting('app.recruitment_screening_closing', true) IN ('application:' || application_id::text, 'reviewer:' || job_id::text || ':' || reviewer_user_id::text));
--> statement-breakpoint
-- The application left Active (archived or hired): its open requests close, whoever did it (a hiring manager may archive).
CREATE FUNCTION app.recruitment_screening_close_for_application() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on
 SET app.recruitment_screening_closing = '' AS $$
BEGIN
 PERFORM set_config('app.recruitment_screening_closing', 'application:' || NEW.id::text, true);
 UPDATE public.recruitment_screening_request SET closed_at = now(), closed_reason = 'application_closed', closed_by_user_id = app.current_user_id()
  WHERE application_id = NEW.id AND tenant_id = NEW.tenant_id AND closed_at IS NULL;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_screening_close_for_application() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_application_screening_close AFTER UPDATE OF state ON public.recruitment_application
 FOR EACH ROW WHEN (OLD.state = 'active' AND NEW.state <> 'active') EXECUTE FUNCTION app.recruitment_screening_close_for_application();
--> statement-breakpoint
-- The reviewer stopped being a hiring manager of the job (their membership row removed, or changed to another role or job):
-- their open requests on the job close.
CREATE FUNCTION app.recruitment_screening_close_for_reviewer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp SET row_security = on
 SET app.recruitment_screening_closing = '' AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND NEW.member_role = 'hiring_manager' AND NEW.job_id = OLD.job_id AND NEW.app_user_id = OLD.app_user_id THEN
  RETURN NULL;
 END IF;
 PERFORM set_config('app.recruitment_screening_closing', 'reviewer:' || OLD.job_id::text || ':' || OLD.app_user_id::text, true);
 UPDATE public.recruitment_screening_request SET closed_at = now(), closed_reason = 'reviewer_removed', closed_by_user_id = app.current_user_id()
  WHERE job_id = OLD.job_id AND reviewer_user_id = OLD.app_user_id AND tenant_id = OLD.tenant_id AND closed_at IS NULL;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_screening_close_for_reviewer() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_job_member_screening_close AFTER DELETE OR UPDATE ON public.recruitment_job_member
 FOR EACH ROW WHEN (OLD.member_role = 'hiring_manager') EXECUTE FUNCTION app.recruitment_screening_close_for_reviewer();
--> statement-breakpoint

-- ── 5. Removal: 4410's app.recruitment_destroy_candidate, byte for byte, plus screening notes and comments ─────────
-- (The new step follows the careers message, before the candidate row is cleared.)
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

-- ── 6. Deleting a company (core/company-refs.ts): 4410's body plus the screening tables ─────────────────────────
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
 PERFORM set_config('app.recruitment_company_delete', '', true);
 RETURN removed;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_delete_company_setup(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_delete_company_setup(uuid) TO ai_hr_app;
