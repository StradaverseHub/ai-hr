-- Recruitment slice 4 (docs/recruitment-reconstruction/specification.md "Slice 4"): job requisitions with an optional
-- ordered approval flow, and the many-jobs-to-one-requisition association. The talent pool needs no table: it is the
-- company's archived applications (4401), read by the pack.
--
-- What this installs:
--   1. recruitment_requisition, numbered HC + 6 digits per company by the guard below. Stored statuses are Draft, Not
--      started, In progress, Paused, Completed and Cancelled. Expired is never stored: it is a non-terminal requisition
--      whose target on-board date has passed (Kuala Lumpur calendar day), and the guard then allows only Completed or
--      Cancelled. Completed and Cancelled are terminal.
--   2. Approval as for offers (4403): the requisition row carries the round's ordered approvers (copied from the
--      company's 'requisition' flow) and the pending position; recruitment_requisition_approval is the decision log,
--      one row per decided step, written by that step's own approver — never by the requisition's creator.
--   3. recruitment_requisition_job: a job opening belongs to at most one requisition; a requisition has many jobs.
-- Requisitions are administered by recruitment administrators (HR administrators and Recruiting Partners); an
-- approver reads the requisition they are asked to approve. Vacancy counts are deterministic count queries.

-- ── 1. Tables ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.recruitment_requisition (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 req_number text NOT NULL CHECK (req_number ~ '^HC[0-9]{6}$'),
 title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
 description text CHECK (description IS NULL OR length(description) <= 20000),
 vacancies integer NOT NULL CHECK (vacancies BETWEEN 1 AND 10000),
 job_grade_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(job_grade_ids) <= 50),
 hiring_manager_user_id uuid,
 partner_user_id uuid,
 recruiter_user_id uuid,
 work_location text NOT NULL CHECK (length(btrim(work_location)) BETWEEN 1 AND 200),
 employment_type text NOT NULL CHECK (employment_type IN ('full_time','part_time','contract','intern')),
 recruitment_type text NOT NULL CHECK (recruitment_type IN ('budgeted','unbudgeted','replacement')),
 replaced_employment_id uuid,
 department_id uuid REFERENCES public.department(id),
 date_opened date,
 target_onboard_date date,
 years_experience integer CHECK (years_experience BETWEEN 0 AND 60),
 education text CHECK (education IS NULL OR length(btrim(education)) BETWEEN 1 AND 200),
 salary_min numeric(18,2) CHECK (salary_min IS NULL OR salary_min >= 0),
 salary_max numeric(18,2) CHECK (salary_max IS NULL OR salary_max >= 0),
 salary_currency text CHECK (salary_currency IS NULL OR salary_currency ~ '^[A-Z]{3}$'),
 working_days text CHECK (working_days IS NULL OR length(btrim(working_days)) BETWEEN 1 AND 200),
 working_hours text CHECK (working_hours IS NULL OR length(btrim(working_hours)) BETWEEN 1 AND 200),
 mandatory_skills text CHECK (mandatory_skills IS NULL OR length(mandatory_skills) <= 4000),
 preferred_skills text CHECK (preferred_skills IS NULL OR length(preferred_skills) <= 4000),
 benefits text CHECK (benefits IS NULL OR length(benefits) <= 4000),
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','not_started','in_progress','paused','completed','cancelled')),
 approval_status text NOT NULL DEFAULT 'not_submitted' CHECK (approval_status IN ('not_submitted','pending','approved','rejected','not_required')),
 approval_round integer NOT NULL DEFAULT 0 CHECK (approval_round BETWEEN 0 AND 1000),
 approver_user_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(approver_user_ids) <= 20),
 pending_position integer CHECK (pending_position BETWEEN 1 AND 20),
 status_changed_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_requisition_pending_ck CHECK ((approval_status = 'pending') = (pending_position IS NOT NULL)
  AND (pending_position IS NULL OR pending_position <= cardinality(approver_user_ids))),
 CONSTRAINT recruitment_requisition_salary_ck CHECK ((salary_min IS NULL OR salary_max IS NULL OR salary_min <= salary_max)
  AND ((salary_min IS NULL AND salary_max IS NULL) = (salary_currency IS NULL))),
 CONSTRAINT recruitment_requisition_dates_ck CHECK (date_opened IS NULL OR target_onboard_date IS NULL OR date_opened <= target_onboard_date),
 CONSTRAINT recruitment_requisition_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_requisition_replaced_fk FOREIGN KEY (replaced_employment_id, tenant_id) REFERENCES public.employment(id, tenant_id),
 CONSTRAINT recruitment_requisition_hiring_manager_fk FOREIGN KEY (hiring_manager_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_requisition_partner_fk FOREIGN KEY (partner_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_requisition_recruiter_fk FOREIGN KEY (recruiter_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_requisition_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_requisition_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_requisition_number_uq UNIQUE (tenant_id, company_id, req_number),
 CONSTRAINT recruitment_requisition_scope_uq UNIQUE (id, company_id, tenant_id)
);
CREATE INDEX recruitment_requisition_status_idx ON public.recruitment_requisition (tenant_id, company_id, status);
CREATE INDEX recruitment_requisition_department_idx ON public.recruitment_requisition (department_id) WHERE department_id IS NOT NULL;
--> statement-breakpoint

CREATE TABLE public.recruitment_requisition_approval (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 requisition_id uuid NOT NULL,
 round integer NOT NULL CHECK (round BETWEEN 1 AND 1000),
 position integer NOT NULL CHECK (position BETWEEN 1 AND 20),
 approver_user_id uuid NOT NULL,
 decision text NOT NULL CHECK (decision IN ('approved','rejected')),
 comment text CHECK (comment IS NULL OR length(comment) <= 2000),
 acted_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT recruitment_requisition_approval_comment_ck CHECK (decision = 'approved' OR comment IS NOT NULL),
 CONSTRAINT recruitment_requisition_approval_requisition_fk FOREIGN KEY (requisition_id, company_id, tenant_id)
  REFERENCES public.recruitment_requisition(id, company_id, tenant_id),
 CONSTRAINT recruitment_requisition_approval_approver_fk FOREIGN KEY (approver_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_requisition_approval_step_uq UNIQUE (requisition_id, round, position)
);
CREATE INDEX recruitment_requisition_approval_approver_idx ON public.recruitment_requisition_approval (approver_user_id);
--> statement-breakpoint

CREATE TABLE public.recruitment_requisition_job (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 requisition_id uuid NOT NULL,
 job_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_requisition_job_requisition_fk FOREIGN KEY (requisition_id, company_id, tenant_id)
  REFERENCES public.recruitment_requisition(id, company_id, tenant_id),
 CONSTRAINT recruitment_requisition_job_job_fk FOREIGN KEY (job_id, company_id, tenant_id) REFERENCES public.recruitment_job_opening(id, company_id, tenant_id),
 CONSTRAINT recruitment_requisition_job_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_requisition_job_one_uq UNIQUE (job_id)
);
CREATE INDEX recruitment_requisition_job_requisition_idx ON public.recruitment_requisition_job (requisition_id);
--> statement-breakpoint

-- ── 2. Row security ───────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_requisition','recruitment_requisition_approval','recruitment_requisition_job'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, ai_hr_app', t);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE POLICY recruitment_requisition_admin ON public.recruitment_requisition FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
CREATE POLICY recruitment_requisition_approver_read ON public.recruitment_requisition FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.current_user_id() = ANY (approver_user_ids));
CREATE POLICY recruitment_requisition_approver_update ON public.recruitment_requisition FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND approval_status = 'pending' AND approver_user_ids[pending_position] = app.current_user_id())
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.current_user_id() = ANY (approver_user_ids));
CREATE POLICY recruitment_requisition_approval_read ON public.recruitment_requisition_approval FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND (app.can_admin_recruitment_for(company_id) OR approver_user_id = app.current_user_id()
  OR EXISTS (SELECT 1 FROM public.recruitment_requisition r WHERE r.id = recruitment_requisition_approval.requisition_id AND r.tenant_id = recruitment_requisition_approval.tenant_id)));
CREATE POLICY recruitment_requisition_approval_insert ON public.recruitment_requisition_approval FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND approver_user_id = app.current_user_id());
CREATE POLICY recruitment_requisition_job_admin ON public.recruitment_requisition_job FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.recruitment_requisition TO ai_hr_app;
GRANT SELECT, INSERT ON public.recruitment_requisition_approval TO ai_hr_app;
GRANT SELECT, INSERT, DELETE ON public.recruitment_requisition_job TO ai_hr_app;
--> statement-breakpoint

-- ── 3. Guards ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TRIGGER recruitment_requisition_job_identity BEFORE UPDATE ON public.recruitment_requisition_job
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_identity();
--> statement-breakpoint
-- Requisitions: number allocation, the status machine, terminal statuses, expiry by date and approval.
--   manual moves: not_started ↔ in_progress ↔ paused; any non-terminal → completed / cancelled;
--   draft → not_started only once approval is approved or not required (submission);
--   expired (non-terminal and target on-board date before today in Kuala Lumpur) → completed / cancelled only.
CREATE FUNCTION app.recruitment_guard_requisition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE next_number integer; today date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date; v_admin boolean; v_flow uuid[]; v_ok boolean;
BEGIN
 IF NEW.department_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM public.department d WHERE d.id = NEW.department_id AND d.tenant_id = NEW.tenant_id
   AND (d.company_id = NEW.company_id OR d.is_global)) THEN
  RAISE EXCEPTION 'Choose a department of this company' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'INSERT' THEN
  IF NEW.status <> 'draft' OR NEW.approval_status <> 'not_submitted' OR NEW.approval_round <> 0
   OR NEW.created_by_user_id IS DISTINCT FROM app.current_user_id() THEN
   RAISE EXCEPTION 'A new requisition starts as a draft by the current user' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('recruitment-requisition-number:' || NEW.tenant_id::text || ':' || NEW.company_id::text, 0));
  SELECT coalesce(max(substr(r.req_number, 3)::integer), 0) + 1 INTO next_number
   FROM public.recruitment_requisition r WHERE r.tenant_id = NEW.tenant_id AND r.company_id = NEW.company_id;
  IF next_number > 999999 THEN RAISE EXCEPTION 'Requisition numbers for this company are exhausted' USING ERRCODE = '23514'; END IF;
  NEW.req_number := 'HC' || lpad(next_number::text, 6, '0');
  NEW.status_changed_at := now();
  RETURN NEW;
 END IF;
 IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.company_id IS DISTINCT FROM OLD.company_id
  OR NEW.req_number IS DISTINCT FROM OLD.req_number OR NEW.created_at IS DISTINCT FROM OLD.created_at
  OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
  RAISE EXCEPTION 'A requisition keeps its company and number' USING ERRCODE = '23514';
 END IF;
 IF OLD.status IN ('completed','cancelled') THEN
  RAISE EXCEPTION 'A completed or cancelled requisition cannot be changed' USING ERRCODE = '23514';
 END IF;
 IF NEW.approval_round < OLD.approval_round THEN
  RAISE EXCEPTION 'The approval round only moves forward' USING ERRCODE = '23514';
 END IF;
 -- The approval state (approval status, round, approvers, pending step) moves ONLY along the service's transitions,
 -- for every caller, so no direct write can approve a requisition without its approvers:
 --   start a round  (administrator): → pending, round + 1, step 1, approvers = the company's requisition flow
 --                  (also restarts a pending or approved round when a required field changes);
 --   empty flow     (administrator): not submitted / rejected → not required, no approvers, when the flow is empty;
 --   decide         (the pending step's approver, after logging their own decision on it): approved → next step, or
 --                  approved after the last; rejected → rejected;
 --   withdraw       (administrator): pending → not submitted, same round and approvers.
 v_admin := app.can_admin_recruitment_for(NEW.company_id);
 IF (NEW.approval_status, NEW.approval_round, NEW.approver_user_ids, NEW.pending_position)
    IS DISTINCT FROM (OLD.approval_status, OLD.approval_round, OLD.approver_user_ids, OLD.pending_position) THEN
  SELECT coalesce(array_agg(st.approver_user_id ORDER BY st.position), '{}') INTO v_flow FROM public.recruitment_approval_step st
   WHERE st.tenant_id = NEW.tenant_id AND st.company_id = NEW.company_id AND st.flow_kind = 'requisition';
  IF NEW.approval_status = 'pending' AND NEW.approval_round = OLD.approval_round + 1 THEN
   v_ok := v_admin AND NEW.pending_position = 1 AND NEW.approver_user_ids = v_flow AND cardinality(v_flow) > 0
    AND NOT (NEW.created_by_user_id = ANY (NEW.approver_user_ids));
  ELSIF NEW.approval_status = 'not_required' AND OLD.approval_status IN ('not_submitted','rejected') THEN
   v_ok := v_admin AND cardinality(v_flow) = 0 AND cardinality(NEW.approver_user_ids) = 0 AND NEW.approval_round = OLD.approval_round;
  ELSIF OLD.approval_status = 'pending' AND NEW.approval_round = OLD.approval_round AND NEW.approver_user_ids = OLD.approver_user_ids
   AND OLD.approver_user_ids[OLD.pending_position] = app.current_user_id() AND EXISTS (
    SELECT 1 FROM public.recruitment_requisition_approval d WHERE d.requisition_id = OLD.id AND d.tenant_id = OLD.tenant_id
     AND d.round = OLD.approval_round AND d.position = OLD.pending_position AND d.approver_user_id = app.current_user_id()
     AND ((d.decision = 'approved' AND ((NEW.approval_status = 'pending' AND NEW.pending_position = OLD.pending_position + 1)
       OR (NEW.approval_status = 'approved' AND OLD.pending_position = cardinality(OLD.approver_user_ids))))
      OR (d.decision = 'rejected' AND NEW.approval_status = 'rejected'))) THEN
   v_ok := true;
  ELSIF NEW.approval_status = 'not_submitted' AND OLD.approval_status = 'pending' THEN
   v_ok := v_admin AND NEW.approval_round = OLD.approval_round AND NEW.approver_user_ids = OLD.approver_user_ids;
  ELSE
   v_ok := false;
  END IF;
  IF NOT v_ok THEN
   RAISE EXCEPTION 'Requisition approval cannot move from % to %', OLD.approval_status, NEW.approval_status USING ERRCODE = '42501';
  END IF;
 END IF;
 -- An approver who does not administer the company's recruitment changes nothing but the approval state, and the
 -- status only from Draft to Not started on the last approval.
 IF NOT v_admin AND ((to_jsonb(NEW) - ARRAY['status','approval_status','pending_position','status_changed_at','updated_at','updated_by_user_id'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','approval_status','pending_position','status_changed_at','updated_at','updated_by_user_id'])
   OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (OLD.status = 'draft' AND NEW.status = 'not_started' AND NEW.approval_status = 'approved'))) THEN
  RAISE EXCEPTION 'An approver only decides their own step' USING ERRCODE = '42501';
 END IF;
 IF NEW.status IS DISTINCT FROM OLD.status THEN
  IF OLD.target_onboard_date IS NOT NULL AND OLD.target_onboard_date < today AND NEW.status NOT IN ('completed','cancelled') THEN
   RAISE EXCEPTION 'An expired requisition can only be completed or cancelled' USING ERRCODE = '23514';
  END IF;
  IF NOT ((OLD.status, NEW.status) IN (('draft','not_started'),('not_started','in_progress'),('in_progress','not_started'),
   ('in_progress','paused'),('paused','in_progress')) OR NEW.status IN ('completed','cancelled')) THEN
   RAISE EXCEPTION 'Requisition status cannot move from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'draft' AND NEW.status = 'not_started' AND NEW.approval_status NOT IN ('approved','not_required') THEN
   RAISE EXCEPTION 'A requisition leaves Draft once its approval is complete' USING ERRCODE = '23514';
  END IF;
  NEW.status_changed_at := now();
 END IF;
 NEW.updated_by_user_id := coalesce(app.current_user_id(), NEW.updated_by_user_id);
 NEW.updated_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_requisition() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_requisition_guard BEFORE INSERT OR UPDATE ON public.recruitment_requisition
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_requisition();
--> statement-breakpoint
-- Requisition decisions: the same rules as offer decisions (4403).
CREATE FUNCTION app.recruitment_guard_requisition_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE r public.recruitment_requisition%ROWTYPE;
BEGIN
 IF TG_OP <> 'INSERT' THEN
  RAISE EXCEPTION 'An approval decision is final' USING ERRCODE = '23514';
 END IF;
 SELECT * INTO r FROM public.recruitment_requisition WHERE id = NEW.requisition_id AND tenant_id = NEW.tenant_id;
 IF NOT FOUND OR r.approval_status <> 'pending' OR NEW.round <> r.approval_round OR NEW.position IS DISTINCT FROM r.pending_position
  OR NEW.approver_user_id IS DISTINCT FROM r.approver_user_ids[r.pending_position] OR NEW.approver_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'Only the approver of the pending step may decide it' USING ERRCODE = '42501';
 END IF;
 IF r.created_by_user_id = app.current_user_id() THEN
  RAISE EXCEPTION 'The creator of a requisition cannot approve it' USING ERRCODE = '42501';
 END IF;
 NEW.acted_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_requisition_approval() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_requisition_approval_guard BEFORE INSERT OR UPDATE OR DELETE ON public.recruitment_requisition_approval
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_requisition_approval();
--> statement-breakpoint

-- ── 4. Deleting a company (core/company-refs.ts) ──────────────────────────────────────────────────────────
-- A requisition is hiring history like a job opening: a company with one refuses the delete.
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
