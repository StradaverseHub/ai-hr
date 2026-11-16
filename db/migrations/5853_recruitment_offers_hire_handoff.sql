-- Recruitment slice 3 (docs/recruitment-reconstruction/specification.md "Slice 3"): offers with an ordered approval
-- flow, and the hire hand-off to the existing personnel draft.
--
-- What this installs:
--   1. Company offer settings (validity days, optional accept/decline automation — off by default) on the slice 2
--      settings row.
--   2. The company offer-field set (type, required, needs approval, private), the company approval flows (an ordered
--      list of approver users per kind; 'requisition' is used by slice 4), one current offer per application, its
--      field values (money as a decimal with a currency, entered by people — nothing computes pay) and its approval
--      steps per submission round.
--   3. The hire hand-off link: application → the employee draft HR saved through the existing personnel writers.
--      Recruitment never creates a person, employee or employment; the link only records which draft HR started.
--
-- Private offer values are visible only to recruitment administrators, the job's recruiter and the offer's creator,
-- enforced by row security on the value table. An approver acts only on their own pending step, and never on an
-- offer they created.
--
-- Approval state lives ON THE OFFER ROW: the round's ordered approver list (copied from the company flow when the
-- offer is submitted) and the position of the pending step. The approval table is the decision log — one row per
-- decided step, written by that step's own approver. This keeps every policy free of self-reference: an approver
-- reads the offer because they are in its approver list, and never needs to read or write another approver's row.

-- ── 1. Settings ───────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.recruitment_company_setting
 ADD COLUMN offer_valid_days integer NOT NULL DEFAULT 15 CHECK (offer_valid_days BETWEEN 1 AND 365),
 ADD COLUMN offer_accept_moves_forward boolean NOT NULL DEFAULT false,
 ADD COLUMN offer_decline_archives boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- ── 2. Tables ─────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.recruitment_offer_field (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
 field_type text NOT NULL CHECK (field_type IN ('text','number','date','single_choice','money')),
 choices text[] NOT NULL DEFAULT '{}',
 required boolean NOT NULL DEFAULT false,
 needs_approval boolean NOT NULL DEFAULT false,
 private boolean NOT NULL DEFAULT false,
 enabled boolean NOT NULL DEFAULT true,
 position integer NOT NULL DEFAULT 1000 CHECK (position BETWEEN 1 AND 10000),
 seed_key text CHECK (seed_key ~ '^[a-z_]{1,40}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_offer_field_choices_ck CHECK ((field_type = 'single_choice') = (cardinality(choices) BETWEEN 1 AND 50)),
 CONSTRAINT recruitment_offer_field_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_offer_field_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_offer_field_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_offer_field_scope_uq UNIQUE (id, company_id, tenant_id)
);
CREATE UNIQUE INDEX recruitment_offer_field_seed_uq ON public.recruitment_offer_field (tenant_id, company_id, seed_key) WHERE seed_key IS NOT NULL;
CREATE UNIQUE INDEX recruitment_offer_field_label_uq ON public.recruitment_offer_field (tenant_id, company_id, lower(btrim(label)));
--> statement-breakpoint

-- A company approval flow: one approver per step, in order. Replaced as a whole by the settings screen.
CREATE TABLE public.recruitment_approval_step (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 flow_kind text NOT NULL CHECK (flow_kind IN ('offer','requisition')),
 position integer NOT NULL CHECK (position BETWEEN 1 AND 20),
 approver_user_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_approval_step_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_approval_step_approver_fk FOREIGN KEY (approver_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_approval_step_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_approval_step_position_uq UNIQUE (tenant_id, company_id, flow_kind, position),
 CONSTRAINT recruitment_approval_step_approver_uq UNIQUE (tenant_id, company_id, flow_kind, approver_user_id)
);
--> statement-breakpoint

-- One current offer per application. Status: draft → pending (approval running) → approved; a rejected step or a
-- withdrawal returns it to draft. Sending is recorded by a person ("Mark as sent"), as is the candidate decision.
CREATE TABLE public.recruitment_offer (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 application_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending','approved')),
 approval_round integer NOT NULL DEFAULT 0 CHECK (approval_round BETWEEN 0 AND 1000),
 approver_user_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(approver_user_ids) <= 20),
 pending_position integer CHECK (pending_position BETWEEN 1 AND 20),
 last_rejection_comment text CHECK (last_rejection_comment IS NULL OR length(last_rejection_comment) <= 2000),
 sent_at timestamptz,
 sent_channel text CHECK (sent_channel IN ('email','sms','other')),
 sent_by_user_id uuid,
 valid_days integer CHECK (valid_days BETWEEN 1 AND 365),
 candidate_decision text NOT NULL DEFAULT 'pending' CHECK (candidate_decision IN ('pending','accepted','declined')),
 decided_at timestamptz,
 decided_by_user_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 created_by_user_id uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_offer_pending_ck CHECK ((status = 'pending') = (pending_position IS NOT NULL)
  AND (pending_position IS NULL OR pending_position <= cardinality(approver_user_ids))),
 CONSTRAINT recruitment_offer_sent_ck CHECK ((sent_at IS NULL) = (sent_channel IS NULL) AND (sent_at IS NULL) = (sent_by_user_id IS NULL)
  AND (sent_at IS NULL) = (valid_days IS NULL) AND (sent_at IS NULL OR status = 'approved')),
 CONSTRAINT recruitment_offer_decision_ck CHECK ((candidate_decision = 'pending') = (decided_at IS NULL)
  AND (decided_at IS NULL) = (decided_by_user_id IS NULL) AND (candidate_decision = 'pending' OR sent_at IS NOT NULL)),
 CONSTRAINT recruitment_offer_application_fk FOREIGN KEY (application_id, job_id, company_id, tenant_id)
  REFERENCES public.recruitment_application(id, job_id, company_id, tenant_id),
 CONSTRAINT recruitment_offer_sent_by_fk FOREIGN KEY (sent_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_offer_decided_by_fk FOREIGN KEY (decided_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_offer_created_by_fk FOREIGN KEY (created_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_offer_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_offer_application_uq UNIQUE (application_id),
 CONSTRAINT recruitment_offer_scope_uq UNIQUE (id, job_id, company_id, tenant_id)
);
CREATE INDEX recruitment_offer_job_idx ON public.recruitment_offer (job_id);
--> statement-breakpoint

-- The offer's values. Exactly one value column is used, by the field's type; money is amount + ISO currency.
CREATE TABLE public.recruitment_offer_value (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 offer_id uuid NOT NULL,
 field_id uuid NOT NULL,
 value_text text CHECK (value_text IS NULL OR length(value_text) BETWEEN 1 AND 2000),
 value_number numeric(16,4),
 value_date date,
 value_amount numeric(18,2) CHECK (value_amount IS NULL OR value_amount >= 0),
 currency text CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
 updated_at timestamptz NOT NULL DEFAULT now(),
 updated_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_offer_value_money_ck CHECK ((value_amount IS NULL) = (currency IS NULL)),
 CONSTRAINT recruitment_offer_value_one_ck CHECK (num_nonnulls(value_text, value_number, value_date, value_amount) = 1),
 CONSTRAINT recruitment_offer_value_offer_fk FOREIGN KEY (offer_id, job_id, company_id, tenant_id)
  REFERENCES public.recruitment_offer(id, job_id, company_id, tenant_id) ON DELETE CASCADE,
 CONSTRAINT recruitment_offer_value_field_fk FOREIGN KEY (field_id, company_id, tenant_id) REFERENCES public.recruitment_offer_field(id, company_id, tenant_id),
 CONSTRAINT recruitment_offer_value_updated_by_fk FOREIGN KEY (updated_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_offer_value_uq UNIQUE (offer_id, field_id)
);
CREATE INDEX recruitment_offer_value_field_idx ON public.recruitment_offer_value (field_id);
--> statement-breakpoint

-- The approval decision log: one row per decided step of a round, written by that step's approver.
CREATE TABLE public.recruitment_offer_approval (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 offer_id uuid NOT NULL,
 round integer NOT NULL CHECK (round BETWEEN 1 AND 1000),
 position integer NOT NULL CHECK (position BETWEEN 1 AND 20),
 approver_user_id uuid NOT NULL,
 decision text NOT NULL CHECK (decision IN ('approved','rejected')),
 comment text CHECK (comment IS NULL OR length(comment) <= 2000),
 acted_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT recruitment_offer_approval_comment_ck CHECK (decision = 'approved' OR comment IS NOT NULL),
 CONSTRAINT recruitment_offer_approval_offer_fk FOREIGN KEY (offer_id, job_id, company_id, tenant_id)
  REFERENCES public.recruitment_offer(id, job_id, company_id, tenant_id),
 CONSTRAINT recruitment_offer_approval_approver_fk FOREIGN KEY (approver_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_offer_approval_step_uq UNIQUE (offer_id, round, position)
);
CREATE INDEX recruitment_offer_approval_approver_idx ON public.recruitment_offer_approval (approver_user_id);
--> statement-breakpoint

-- The hire hand-off link. No foreign key to employee_draft: a draft is discarded or becomes an employment, and the
-- link stays as the record of which draft HR started from this application.
CREATE TABLE public.recruitment_hire_handoff (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 job_id uuid NOT NULL,
 application_id uuid NOT NULL,
 employee_draft_id uuid NOT NULL,
 reserved_employee_code text CHECK (reserved_employee_code IS NULL OR length(reserved_employee_code) BETWEEN 1 AND 60),
 linked_at timestamptz NOT NULL DEFAULT now(),
 linked_by_user_id uuid NOT NULL,
 CONSTRAINT recruitment_hire_handoff_application_fk FOREIGN KEY (application_id, job_id, company_id, tenant_id)
  REFERENCES public.recruitment_application(id, job_id, company_id, tenant_id),
 CONSTRAINT recruitment_hire_handoff_linked_by_fk FOREIGN KEY (linked_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_hire_handoff_application_uq UNIQUE (application_id),
 CONSTRAINT recruitment_hire_handoff_draft_uq UNIQUE (tenant_id, employee_draft_id)
);
--> statement-breakpoint

-- ── 3. Row security ───────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_offer_field','recruitment_approval_step','recruitment_offer','recruitment_offer_value',
  'recruitment_offer_approval','recruitment_hire_handoff'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, ai_hr_app', t);
 END LOOP;
END $$;
--> statement-breakpoint
CREATE POLICY recruitment_offer_field_admin ON public.recruitment_offer_field FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
CREATE POLICY recruitment_offer_field_team ON public.recruitment_offer_field FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND (app.recruitment_team_in_company(company_id) OR EXISTS (
  SELECT 1 FROM public.recruitment_offer o WHERE o.company_id = recruitment_offer_field.company_id
   AND o.tenant_id = recruitment_offer_field.tenant_id AND app.current_user_id() = ANY (o.approver_user_ids))));
CREATE POLICY recruitment_approval_step_admin ON public.recruitment_approval_step FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
CREATE POLICY recruitment_approval_step_team ON public.recruitment_approval_step FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_operates_in_company(company_id));
--> statement-breakpoint
-- Offers: the job's reviewers (which include its operators, and so a creator still on the team), administrators and
-- the current round's approvers read it;
-- operators write it; the approver of the pending step may move it on (the guard below allows them nothing else).
CREATE POLICY recruitment_offer_read ON public.recruitment_offer FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND (app.can_review_recruitment_job(company_id, job_id)
  OR app.current_user_id() = ANY (approver_user_ids)));
CREATE POLICY recruitment_offer_insert ON public.recruitment_offer FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id));
CREATE POLICY recruitment_offer_update ON public.recruitment_offer FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND (app.can_operate_recruitment_job(company_id, job_id)
  OR (status = 'pending' AND approver_user_ids[pending_position] = app.current_user_id())))
 WITH CHECK (tenant_id = app.current_tenant_id() AND (app.can_operate_recruitment_job(company_id, job_id)
  OR app.current_user_id() = ANY (approver_user_ids)));
--> statement-breakpoint
-- Offer values: readable with the offer; a PRIVATE field's value only by administrators, the job's recruiter and
-- the offer's creator while they still operate the job. Written by the job's operators, with the same private-field condition.
CREATE FUNCTION app.recruitment_offer_value_visible(p_company uuid, p_job uuid, p_offer uuid, p_field uuid) RETURNS boolean
 LANGUAGE sql STABLE AS $$
 SELECT EXISTS (SELECT 1 FROM public.recruitment_offer o WHERE o.id = p_offer AND o.tenant_id = app.current_tenant_id())
  AND (app.can_admin_recruitment_for(p_company)
   OR NOT coalesce((SELECT f.private FROM public.recruitment_offer_field f WHERE f.id = p_field AND f.tenant_id = app.current_tenant_id()), true)
   OR app.recruitment_has_job_role(p_job, ARRAY['recruiter'])
   OR (app.can_operate_recruitment_job(p_company, p_job) AND EXISTS (SELECT 1 FROM public.recruitment_offer o
    WHERE o.id = p_offer AND o.tenant_id = app.current_tenant_id() AND o.created_by_user_id = app.current_user_id())));
$$;
GRANT EXECUTE ON FUNCTION app.recruitment_offer_value_visible(uuid, uuid, uuid, uuid) TO ai_hr_app;
CREATE POLICY recruitment_offer_value_read ON public.recruitment_offer_value FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.recruitment_offer_value_visible(company_id, job_id, offer_id, field_id));
CREATE POLICY recruitment_offer_value_write ON public.recruitment_offer_value FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id)
  AND app.recruitment_offer_value_visible(company_id, job_id, offer_id, field_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_operate_recruitment_job(company_id, job_id)
  AND app.recruitment_offer_value_visible(company_id, job_id, offer_id, field_id));
--> statement-breakpoint
-- Decisions: readable by their approver, the job's reviewers and administrators, and the offer's other approvers
-- through the offer (never by reading this table from its own policy); written only by the deciding approver.
CREATE POLICY recruitment_offer_approval_read ON public.recruitment_offer_approval FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND (approver_user_id = app.current_user_id() OR app.can_review_recruitment_job(company_id, job_id)
  OR EXISTS (SELECT 1 FROM public.recruitment_offer o WHERE o.id = recruitment_offer_approval.offer_id AND o.tenant_id = recruitment_offer_approval.tenant_id)));
CREATE POLICY recruitment_offer_approval_insert ON public.recruitment_offer_approval FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND approver_user_id = app.current_user_id());
--> statement-breakpoint
-- The hand-off: the job's reviewers read it; only an HR administrator of the company links a draft.
CREATE POLICY recruitment_hire_handoff_read ON public.recruitment_hire_handoff FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.can_review_recruitment_job(company_id, job_id));
CREATE POLICY recruitment_hire_handoff_insert ON public.recruitment_hire_handoff FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON public.recruitment_offer_field, public.recruitment_offer TO ai_hr_app;
GRANT SELECT, INSERT ON public.recruitment_offer_approval TO ai_hr_app;
GRANT SELECT, INSERT, DELETE ON public.recruitment_approval_step TO ai_hr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recruitment_offer_value TO ai_hr_app;
GRANT SELECT, INSERT ON public.recruitment_hire_handoff TO ai_hr_app;
--> statement-breakpoint

-- ── 4. Guards ─────────────────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['recruitment_offer_field','recruitment_offer_value'] LOOP
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_identity()', t || '_identity', t);
 END LOOP;
END $$;
--> statement-breakpoint
-- Offer fields: the type and seed identity never move (stored values are typed by them).
CREATE FUNCTION app.recruitment_guard_offer_field() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF NEW.field_type IS DISTINCT FROM OLD.field_type OR NEW.seed_key IS DISTINCT FROM OLD.seed_key THEN
  RAISE EXCEPTION 'An offer field keeps its type' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_offer_field() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_offer_field_guard BEFORE UPDATE ON public.recruitment_offer_field
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_offer_field();
--> statement-breakpoint

-- Offers: created as a draft by the current user for an active application; keep their application and creator;
-- move only along draft → pending → approved (pending → draft on rejection or withdrawal; approved → draft or
-- pending when an approval field changes; draft → approved only with an empty approval flow); sent only when
-- approved; decided only when sent; a decided offer is closed.
CREATE FUNCTION app.recruitment_guard_offer() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_operator boolean; v_flow uuid[]; v_ok boolean;
BEGIN
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
REVOKE ALL ON FUNCTION app.recruitment_guard_offer() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_offer_guard BEFORE INSERT OR UPDATE ON public.recruitment_offer
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_offer();
--> statement-breakpoint

-- Offer values change only while the offer is open (no candidate decision yet).
CREATE FUNCTION app.recruitment_guard_offer_value() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_offer uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.offer_id ELSE NEW.offer_id END;
BEGIN
 IF EXISTS (SELECT 1 FROM public.recruitment_offer o WHERE o.id = v_offer AND o.candidate_decision <> 'pending') THEN
  RAISE EXCEPTION 'The candidate has decided; the offer is closed' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
 NEW.updated_by_user_id := app.current_user_id();
 NEW.updated_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_offer_value() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_offer_value_guard BEFORE INSERT OR UPDATE OR DELETE ON public.recruitment_offer_value
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_offer_value();
--> statement-breakpoint

-- Decisions: only the approver of the offer's PENDING step, in the current round and position, never the offer's
-- creator. A logged decision is final (no UPDATE or DELETE grant; the trigger refuses them too).
CREATE FUNCTION app.recruitment_guard_offer_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE o public.recruitment_offer%ROWTYPE;
BEGIN
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
REVOKE ALL ON FUNCTION app.recruitment_guard_offer_approval() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_offer_approval_guard BEFORE INSERT OR UPDATE OR DELETE ON public.recruitment_offer_approval
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_offer_approval();
--> statement-breakpoint

-- The hand-off: by the current user, for an application at Onboarding or hired, to a draft of the same company.
CREATE FUNCTION app.recruitment_guard_hire_handoff() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF NEW.linked_by_user_id IS DISTINCT FROM app.current_user_id() THEN
  RAISE EXCEPTION 'The hand-off records the current user' USING ERRCODE = '42501';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.recruitment_application a JOIN public.recruitment_stage st ON st.id = a.current_stage_id
  WHERE a.id = NEW.application_id AND (a.state = 'hired' OR (a.state = 'active' AND st.system_key = 'onboarding'))) THEN
  RAISE EXCEPTION 'A new hire starts from an application at Onboarding or hired' USING ERRCODE = '23514';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.employee_draft d WHERE d.id = NEW.employee_draft_id AND d.tenant_id = NEW.tenant_id AND d.company_id = NEW.company_id) THEN
  RAISE EXCEPTION 'Link a draft of the application''s company' USING ERRCODE = '23514';
 END IF;
 NEW.linked_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_hire_handoff() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_hire_handoff_guard BEFORE INSERT ON public.recruitment_hire_handoff
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_hire_handoff();
--> statement-breakpoint

-- ── 5. Deleting a company (core/company-refs.ts) ──────────────────────────────────────────────────────────
-- Restated with the offer-field set and the approval flows. Offer values reference fields only through an offer,
-- which needs an application and therefore a job opening — which refuses the delete first.
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
