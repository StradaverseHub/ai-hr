-- Recruitment slice 23 — referral rewards and agency fees (owner D-063, 2026-11-14; reconstruction D-068).
--
-- A referral reward is a fixed amount per job, frozen on the referral when it is made, payable once the hire has passed
-- probation, approved by a recruitment administrator of the job's company and sent to payroll by a payroll administrator of
-- the receiving employment's company as ONE one-off earning (payroll_individual_txn, source 'system', source_ref
-- 'recruitment-referral-reward:<id>'). An agency fee is recorded from the agency's invoice and approved by a second
-- administrator; it never reaches payroll. Nothing here calls a model or calculates an amount: every amount is typed by a person.
--
--   1. recruitment_job_opening.referral_reward          the job's reward (administrators only, audited by the service)
--      recruitment_referral.reward_amount/_currency     frozen from the job at insert; the 5707 guard keeps them unchanged
--   2. app.recruitment_reward_employment_active(e)      the repository's active-employment rule (5707), for one employment
--      app.recruitment_reward_facts(application)        the hire's employment (through the completed employee draft) and
--                                                        the referrer's active employments; administrators of the job only
--   3. public.recruitment_referral_reward               one row per decided reward; inserted by an administrator, checked
--                                                        here; its payroll columns written once with the matching txn
--   4. public.recruitment_agency_fee                    one row per hired agency application; four-eyes decision
--   5. definers for the portal's rewards, the referrer's own reward states and a payroll administrator's queue
--
-- PRECONDITION: applies after 5724 (and so after 5707, 5710 and the payroll ledger's 0432 source columns).
-- Rollback (unapplied anywhere but throwaway and CI databases): drop the two tables, the functions and triggers below, and the
-- three columns.

-- ── 1. The job's reward and the referral's frozen amount ─────────────────────────────────────────────────────────────────
ALTER TABLE public.recruitment_job_opening ADD COLUMN referral_reward numeric(12,2)
 CONSTRAINT recruitment_job_opening_referral_reward_ck CHECK (referral_reward IS NULL OR (referral_reward > 0 AND referral_reward <= 1000000));
--> statement-breakpoint
ALTER TABLE public.recruitment_referral ADD COLUMN reward_amount numeric(12,2), ADD COLUMN reward_currency text,
 ADD CONSTRAINT recruitment_referral_reward_ck CHECK ((reward_amount IS NULL AND reward_currency IS NULL)
  OR (reward_amount > 0 AND reward_amount <= 1000000 AND reward_currency ~ '^[A-Z]{3}$'));
GRANT SELECT (reward_amount, reward_currency) ON public.recruitment_referral TO ai_hr_app;
--> statement-breakpoint
-- The reward is changed only by a recruitment administrator of the job's company (like the portal setting, 5707).
CREATE FUNCTION app.recruitment_guard_job_referral_reward() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
BEGIN
 IF (TG_OP = 'INSERT' AND NEW.referral_reward IS NOT NULL)
  OR (TG_OP = 'UPDATE' AND NEW.referral_reward IS DISTINCT FROM OLD.referral_reward) THEN
  IF NOT app.can_admin_recruitment_for(NEW.company_id) THEN
   RAISE EXCEPTION 'Only a recruitment administrator changes the referral reward' USING ERRCODE = '42501';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_job_referral_reward() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_job_opening_referral_reward_guard BEFORE INSERT OR UPDATE OF referral_reward ON public.recruitment_job_opening
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_job_referral_reward();
--> statement-breakpoint
-- Frozen at insert from the job (whatever the inserter supplied) and the job company's currency. Fires after
-- recruitment_referral_guard (trigger names sort), which already refuses every later change but the removal's reason clear.
-- The insert runs inside app.recruitment_submit_referral, whose marker lets the owner read the job.
CREATE FUNCTION app.recruitment_referral_freeze_reward() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_reward numeric(12,2); v_currency text;
BEGIN
 SELECT j.referral_reward, c.currency INTO v_reward, v_currency
  FROM public.recruitment_job_opening j JOIN public.company c ON c.id = j.company_id AND c.tenant_id = j.tenant_id
  WHERE j.id = NEW.job_id AND j.tenant_id = NEW.tenant_id AND j.company_id = NEW.company_id;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'A referral belongs to a job of its company' USING ERRCODE = '23514';
 END IF;
 NEW.reward_amount := v_reward;
 NEW.reward_currency := CASE WHEN v_reward IS NULL THEN NULL ELSE v_currency END;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_referral_freeze_reward() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_referral_reward_freeze BEFORE INSERT ON public.recruitment_referral
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_referral_freeze_reward();
--> statement-breakpoint

-- ── 2. Employment facts ───────────────────────────────────────────────────────────────────────────────────────────────────
-- 5707's active rule for one employment: not voided or blacklisted, started on or before today (Kuala Lumpur) and not ended
-- (the earliest of resignation, last working date and termination).
CREATE FUNCTION app.recruitment_reward_employment_active(p_employment uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
 SELECT EXISTS (SELECT 1 FROM public.employment e
  JOIN public.company c ON c.id = e.company_id AND c.tenant_id = e.tenant_id AND c.archived_at IS NULL
  WHERE e.id = p_employment AND e.tenant_id = app.current_tenant_id()
   AND e.voided_at IS NULL AND e.blacklisted_at IS NULL
   AND coalesce(e.join_date, e.hired_on) <= (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   AND (LEAST(e.resignation_date, e.last_working_date, e.terminated_on) IS NULL
    OR (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date <= LEAST(e.resignation_date, e.last_working_date, e.terminated_on)));
$$;
REVOKE ALL ON FUNCTION app.recruitment_reward_employment_active(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_reward_employment_active(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The facts a reward decision rests on, for a recruitment administrator of the application's company only (NULL otherwise,
-- and NULL when the application has no referral). The hire's employment is the one the hand-off's employee draft became
-- (the 'employee-draft.completed' event names it); the due day is the confirmation date, else the day after the probation
-- end (the employment's own, else the provisional end of a current full-time assignment), else the start date with
-- noProbationDate. Read as the owner: the hand-off and referral are still filtered by their policies for the caller.
CREATE FUNCTION app.recruitment_reward_facts(p_application uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE
 v_tenant uuid := app.current_tenant_id();
 v_today date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
 r record; v_draft uuid; v_hire uuid; e record; v_probation_end date; v_due date; v_ended date; v_active boolean;
 v_payees jsonb;
BEGIN
 IF v_tenant IS NULL OR app.current_user_id() IS NULL OR p_application IS NULL THEN RETURN NULL; END IF;
 SELECT f.id, f.company_id, f.job_id, f.referrer_person_id, f.reward_amount, f.reward_currency, a.state INTO r
  FROM public.recruitment_referral f
  JOIN public.recruitment_application a ON a.id = f.application_id AND a.tenant_id = f.tenant_id
  WHERE f.application_id = p_application AND f.tenant_id = v_tenant;
 IF NOT FOUND OR NOT app.can_admin_recruitment_for(r.company_id) THEN RETURN NULL; END IF;
 SELECT h.employee_draft_id INTO v_draft FROM public.recruitment_hire_handoff h
  WHERE h.application_id = p_application AND h.tenant_id = v_tenant AND h.company_id = r.company_id;
 IF v_draft IS NOT NULL THEN
  SELECT d.subject_employment_id INTO v_hire FROM public.domain_event d
   WHERE d.tenant_id = v_tenant AND d.aggregate_type = 'employee-draft' AND d.aggregate_id = v_draft
    AND d.event_type = 'employee-draft.completed' AND d.subject_employment_id IS NOT NULL
   ORDER BY d.occurred_at DESC LIMIT 1;
 END IF;
 IF v_hire IS NOT NULL THEN
  SELECT x.id, x.person_id, coalesce(x.join_date, x.hired_on) AS start_on, x.final_confirmation_date, x.probation_end_date,
   x.provisional_end_on, LEAST(x.resignation_date, x.last_working_date, x.terminated_on) AS ended_on,
   (SELECT s.employment_type::text FROM public.assignment s WHERE s.employment_id = x.id AND s.tenant_id = x.tenant_id
     AND s.valid_from <= v_today AND (s.valid_to IS NULL OR s.valid_to >= v_today) ORDER BY s.valid_from DESC LIMIT 1) AS employment_type
   INTO e FROM public.employment x WHERE x.id = v_hire AND x.tenant_id = v_tenant;
  v_probation_end := coalesce(e.probation_end_date, CASE WHEN e.employment_type = 'full_time' THEN e.provisional_end_on END);
  v_due := coalesce(e.final_confirmation_date, v_probation_end + 1, e.start_on);
  v_ended := e.ended_on;
  v_active := app.recruitment_reward_employment_active(v_hire);
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('employmentId', x.id, 'companyId', x.company_id, 'companyName', c.legal_name,
   'currency', c.currency, 'employeeCode', x.employee_code) ORDER BY c.legal_name, x.id), '[]'::jsonb) INTO v_payees
  FROM public.employment x JOIN public.company c ON c.id = x.company_id AND c.tenant_id = x.tenant_id
  WHERE x.tenant_id = v_tenant AND x.person_id = r.referrer_person_id AND app.recruitment_reward_employment_active(x.id);
 RETURN jsonb_build_object(
  'referralId', r.id, 'companyId', r.company_id, 'jobId', r.job_id, 'referrerPersonId', r.referrer_person_id,
  'amount', r.reward_amount, 'currency', r.reward_currency, 'applicationState', r.state,
  'hire', CASE WHEN v_hire IS NULL THEN NULL ELSE jsonb_build_object('employmentId', v_hire, 'personId', e.person_id,
   'startOn', e.start_on, 'confirmationOn', e.final_confirmation_date, 'probationEndOn', v_probation_end, 'dueOn', v_due,
   'noProbationDate', e.final_confirmation_date IS NULL AND v_probation_end IS NULL, 'endedOn', v_ended, 'active', v_active) END,
  'payees', v_payees, 'today', v_today);
END $$;
REVOKE ALL ON FUNCTION app.recruitment_reward_facts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_reward_facts(uuid) TO ai_hr_app;
--> statement-breakpoint

-- ── 3. Decided referral rewards ──────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.recruitment_referral_reward (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 referral_id uuid NOT NULL REFERENCES public.recruitment_referral(id),
 amount numeric(12,2) NOT NULL CHECK (amount > 0 AND amount <= 1000000),
 currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 decision text NOT NULL CHECK (decision IN ('approved', 'declined')),
 reason text CHECK (reason IS NULL OR char_length(btrim(reason)) BETWEEN 1 AND 500),
 hire_employment_id uuid REFERENCES public.employment(id),
 payee_employment_id uuid REFERENCES public.employment(id),
 payee_company_id uuid REFERENCES public.company(id),
 decided_by_user_id uuid NOT NULL,
 decided_at timestamptz NOT NULL DEFAULT now(),
 -- The payroll transaction it was sent as. No foreign key: changing or removing it afterwards is payroll's own work.
 txn_id uuid,
 pay_period text CHECK (pay_period IS NULL OR pay_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 sent_by_user_id uuid,
 sent_at timestamptz,
 CONSTRAINT recruitment_referral_reward_referral_uq UNIQUE (referral_id),
 CONSTRAINT recruitment_referral_reward_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_referral_reward_decided_by_fk FOREIGN KEY (decided_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_referral_reward_sent_by_fk FOREIGN KEY (sent_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_referral_reward_decision_ck CHECK (
  (decision = 'approved' AND reason IS NULL AND hire_employment_id IS NOT NULL AND payee_employment_id IS NOT NULL AND payee_company_id IS NOT NULL)
  OR (decision = 'declined' AND reason IS NOT NULL AND payee_employment_id IS NULL AND payee_company_id IS NULL AND txn_id IS NULL)),
 CONSTRAINT recruitment_referral_reward_sent_ck CHECK (
  (txn_id IS NULL AND pay_period IS NULL AND sent_by_user_id IS NULL AND sent_at IS NULL)
  OR (txn_id IS NOT NULL AND pay_period IS NOT NULL AND sent_by_user_id IS NOT NULL AND sent_at IS NOT NULL))
);
CREATE INDEX recruitment_referral_reward_company_idx ON public.recruitment_referral_reward (tenant_id, company_id, decided_at);
CREATE INDEX recruitment_referral_reward_payroll_idx ON public.recruitment_referral_reward (tenant_id, payee_company_id)
 WHERE decision = 'approved' AND txn_id IS NULL;
CREATE INDEX recruitment_referral_reward_hire_idx ON public.recruitment_referral_reward (hire_employment_id);
CREATE INDEX recruitment_referral_reward_payee_idx ON public.recruitment_referral_reward (payee_employment_id);
CREATE INDEX recruitment_referral_reward_payee_company_idx ON public.recruitment_referral_reward (payee_company_id);
CREATE INDEX recruitment_referral_reward_decided_by_idx ON public.recruitment_referral_reward (decided_by_user_id);
CREATE INDEX recruitment_referral_reward_sent_by_idx ON public.recruitment_referral_reward (sent_by_user_id);
--> statement-breakpoint
ALTER TABLE public.recruitment_referral_reward ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recruitment_referral_reward FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.recruitment_referral_reward FROM PUBLIC, ai_hr_app;
-- INSERT on the table (the service's insert names every column, defaults included); the guard empties the payroll columns and
-- stamps the decision time. UPDATE only on the payroll columns.
GRANT SELECT, INSERT ON public.recruitment_referral_reward TO ai_hr_app;
GRANT UPDATE (txn_id, pay_period, sent_by_user_id, sent_at) ON public.recruitment_referral_reward TO ai_hr_app;
-- Administrators of the job's company read and decide; payroll administrators of the receiving company read approved rewards
-- and send them; the owner-run definers below read all (the referrer's own states, the payroll queue).
CREATE POLICY recruitment_referral_reward_admin_read ON public.recruitment_referral_reward FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
CREATE POLICY recruitment_referral_reward_payroll_read ON public.recruitment_referral_reward FOR SELECT
 USING (tenant_id = app.current_tenant_id() AND decision = 'approved' AND app.can_admin_payroll_for(payee_company_id));
CREATE POLICY recruitment_referral_reward_decide ON public.recruitment_referral_reward FOR INSERT
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id) AND decided_by_user_id = app.current_user_id());
CREATE POLICY recruitment_referral_reward_send ON public.recruitment_referral_reward FOR UPDATE
 USING (tenant_id = app.current_tenant_id() AND decision = 'approved' AND txn_id IS NULL AND app.can_admin_payroll_for(payee_company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_payroll_for(payee_company_id) AND sent_by_user_id = app.current_user_id());
CREATE POLICY recruitment_referral_reward_owner ON public.recruitment_referral_reward FOR SELECT
 USING (current_user = pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.recruitment_referral_reward'::regclass)));
--> statement-breakpoint
-- A decision is checked against the facts, never trusted from the caller; sending writes only the payroll columns, once,
-- naming the earning row this same transaction recorded for the receiving employment; nothing is ever deleted.
CREATE FUNCTION app.recruitment_guard_referral_reward() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE
 f jsonb; v_person uuid; v_payee jsonb; v_payee_person uuid;
 v_send_cols text[] := ARRAY['txn_id', 'pay_period', 'sent_by_user_id', 'sent_at'];
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'A reward decision is kept' USING ERRCODE = '23514';
 END IF;
 SELECT u.person_id INTO v_person FROM public.app_user u WHERE u.id = app.current_user_id() AND u.tenant_id = NEW.tenant_id;
 IF TG_OP = 'UPDATE' THEN
  IF OLD.txn_id IS NOT NULL OR OLD.decision <> 'approved' OR NEW.txn_id IS NULL
   OR (to_jsonb(NEW) - v_send_cols) IS DISTINCT FROM (to_jsonb(OLD) - v_send_cols) THEN
   RAISE EXCEPTION 'An approved reward is sent to payroll once and otherwise kept as decided' USING ERRCODE = '42501';
  END IF;
  NEW.sent_at := now();
  SELECT x.person_id INTO v_payee_person FROM public.employment x WHERE x.id = NEW.payee_employment_id AND x.tenant_id = NEW.tenant_id;
  IF NEW.sent_by_user_id IS DISTINCT FROM app.current_user_id() OR v_person IS NULL OR v_person = v_payee_person THEN
   RAISE EXCEPTION 'A reward is sent by a payroll administrator who is not its receiver' USING ERRCODE = '42501';
  END IF;
  IF NOT app.recruitment_reward_employment_active(NEW.payee_employment_id) THEN
   RAISE EXCEPTION 'The receiving employment is no longer active' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.payroll_individual_txn t WHERE t.id = NEW.txn_id AND t.tenant_id = NEW.tenant_id
   AND t.employment_id = NEW.payee_employment_id AND t.company_id = NEW.payee_company_id AND t.pay_period = NEW.pay_period
   AND t.kind = 'earning' AND t.amount = NEW.amount AND t.source = 'system'
   AND t.source_ref = 'recruitment-referral-reward:' || NEW.id::text AND t.created_at = now()) THEN
   RAISE EXCEPTION 'A sent reward names the earning recorded for it in this transaction' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
 END IF;
 -- INSERT: one decision, by the current administrator, on the facts as they are now.
 NEW.decided_at := now();
 NEW.txn_id := NULL; NEW.pay_period := NULL; NEW.sent_by_user_id := NULL; NEW.sent_at := NULL;
 SELECT app.recruitment_reward_facts(f2.application_id) INTO f FROM public.recruitment_referral f2
  WHERE f2.id = NEW.referral_id AND f2.tenant_id = NEW.tenant_id;
 IF f IS NULL OR (f->>'companyId')::uuid IS DISTINCT FROM NEW.company_id THEN
  RAISE EXCEPTION 'Only a recruitment administrator of the job''s company decides its rewards' USING ERRCODE = '42501';
 END IF;
 IF f->>'applicationState' <> 'hired' OR f->>'amount' IS NULL
  OR (f->>'amount')::numeric IS DISTINCT FROM NEW.amount OR f->>'currency' IS DISTINCT FROM NEW.currency THEN
  RAISE EXCEPTION 'A reward is the frozen amount of a hired referral' USING ERRCODE = '23514';
 END IF;
 IF NEW.decided_by_user_id IS DISTINCT FROM app.current_user_id() OR v_person IS NULL
  OR v_person = (f->>'referrerPersonId')::uuid OR v_person = (f->'hire'->>'personId')::uuid THEN
  RAISE EXCEPTION 'A reward is decided by an administrator who is neither the referrer nor the hire' USING ERRCODE = '42501';
 END IF;
 IF NEW.decision = 'declined' THEN
  NEW.hire_employment_id := (f->'hire'->>'employmentId')::uuid;
  RETURN NEW;
 END IF;
 IF f->'hire' IS NULL OR jsonb_typeof(f->'hire') <> 'object' OR (f->'hire'->>'employmentId')::uuid IS DISTINCT FROM NEW.hire_employment_id
  OR (f->'hire'->>'active')::boolean IS NOT TRUE OR (f->'hire'->>'dueOn')::date > (f->>'today')::date THEN
  RAISE EXCEPTION 'A reward is approved once the hire''s probation is over and the hire is still employed' USING ERRCODE = '23514';
 END IF;
 SELECT p INTO v_payee FROM jsonb_array_elements(f->'payees') p WHERE (p->>'employmentId')::uuid = NEW.payee_employment_id;
 IF v_payee IS NULL OR (v_payee->>'companyId')::uuid IS DISTINCT FROM NEW.payee_company_id OR v_payee->>'currency' IS DISTINCT FROM NEW.currency THEN
  RAISE EXCEPTION 'A reward is paid to an active employment of the referrer in the reward''s currency' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_referral_reward() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_referral_reward_guard BEFORE INSERT OR UPDATE OR DELETE ON public.recruitment_referral_reward
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_referral_reward();
--> statement-breakpoint

-- ── 4. Agency fees ───────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.recruitment_agency_fee (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 application_id uuid NOT NULL,
 submission_id uuid NOT NULL REFERENCES public.recruitment_agency_submission(id),
 amount numeric(14,2) NOT NULL CHECK (amount > 0 AND amount <= 100000000),
 currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 invoice_ref text CHECK (invoice_ref IS NULL OR char_length(btrim(invoice_ref)) BETWEEN 1 AND 100),
 note text CHECK (note IS NULL OR char_length(btrim(note)) BETWEEN 1 AND 500),
 -- The last person who recorded or corrected it; the decider must be someone else.
 recorded_by_user_id uuid NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 decision text CHECK (decision IN ('approved', 'declined')),
 decision_reason text CHECK (decision_reason IS NULL OR char_length(btrim(decision_reason)) BETWEEN 1 AND 500),
 decided_by_user_id uuid,
 decided_at timestamptz,
 CONSTRAINT recruitment_agency_fee_application_uq UNIQUE (application_id),
 CONSTRAINT recruitment_agency_fee_application_fk FOREIGN KEY (application_id, company_id, tenant_id)
  REFERENCES public.recruitment_application(id, company_id, tenant_id),
 CONSTRAINT recruitment_agency_fee_company_fk FOREIGN KEY (company_id, tenant_id) REFERENCES public.company(id, tenant_id),
 CONSTRAINT recruitment_agency_fee_recorded_by_fk FOREIGN KEY (recorded_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_agency_fee_decided_by_fk FOREIGN KEY (decided_by_user_id, tenant_id) REFERENCES public.app_user(id, tenant_id),
 CONSTRAINT recruitment_agency_fee_decision_ck CHECK (
  (decision IS NULL AND decision_reason IS NULL AND decided_by_user_id IS NULL AND decided_at IS NULL)
  OR (decision = 'approved' AND decision_reason IS NULL AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL)
  OR (decision = 'declined' AND decision_reason IS NOT NULL AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE INDEX recruitment_agency_fee_company_idx ON public.recruitment_agency_fee (tenant_id, company_id, recorded_at);
CREATE INDEX recruitment_agency_fee_submission_idx ON public.recruitment_agency_fee (submission_id);
CREATE INDEX recruitment_agency_fee_recorded_by_idx ON public.recruitment_agency_fee (recorded_by_user_id);
CREATE INDEX recruitment_agency_fee_decided_by_idx ON public.recruitment_agency_fee (decided_by_user_id);
--> statement-breakpoint
ALTER TABLE public.recruitment_agency_fee ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recruitment_agency_fee FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.recruitment_agency_fee FROM PUBLIC, ai_hr_app;
GRANT SELECT, INSERT, UPDATE ON public.recruitment_agency_fee TO ai_hr_app;
CREATE POLICY recruitment_agency_fee_admin ON public.recruitment_agency_fee FOR ALL
 USING (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id))
 WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_admin_recruitment_for(company_id));
--> statement-breakpoint
CREATE FUNCTION app.recruitment_guard_agency_fee() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, app, pg_temp AS $$
DECLARE v_record_cols text[] := ARRAY['amount', 'currency', 'invoice_ref', 'note', 'recorded_by_user_id', 'recorded_at'];
 v_decision_cols text[] := ARRAY['decision', 'decision_reason', 'decided_by_user_id', 'decided_at'];
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'An agency fee record is kept' USING ERRCODE = '23514';
 END IF;
 IF TG_OP = 'INSERT' THEN
  IF NEW.decision IS NOT NULL OR NEW.recorded_by_user_id IS DISTINCT FROM app.current_user_id() THEN
   RAISE EXCEPTION 'An agency fee is recorded undecided by the current user' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.recruitment_agency_submission s
    JOIN public.recruitment_application a ON a.id = s.application_id AND a.tenant_id = s.tenant_id
    WHERE s.id = NEW.submission_id AND s.tenant_id = NEW.tenant_id AND s.company_id = NEW.company_id
     AND s.application_id = NEW.application_id AND s.outcome = 'accepted' AND a.state = 'hired') THEN
   RAISE EXCEPTION 'An agency fee belongs to a hired application from an accepted agency submission' USING ERRCODE = '23514';
  END IF;
  NEW.recorded_at := now();
  RETURN NEW;
 END IF;
 IF OLD.decision IS NOT NULL THEN
  RAISE EXCEPTION 'A decided agency fee is kept as decided' USING ERRCODE = '42501';
 END IF;
 IF (to_jsonb(NEW) - v_record_cols - v_decision_cols) IS DISTINCT FROM (to_jsonb(OLD) - v_record_cols - v_decision_cols) THEN
  RAISE EXCEPTION 'An agency fee keeps its company, application and submission' USING ERRCODE = '23514';
 END IF;
 IF NEW.decision IS NULL THEN
  -- A correction: the corrector becomes the last recorder.
  IF NEW.recorded_by_user_id IS DISTINCT FROM app.current_user_id() OR NEW.decision_reason IS NOT NULL
   OR NEW.decided_by_user_id IS NOT NULL OR NEW.decided_at IS NOT NULL THEN
   RAISE EXCEPTION 'An agency fee is corrected by the current user' USING ERRCODE = '42501';
  END IF;
  NEW.recorded_at := now();
  RETURN NEW;
 END IF;
 IF (to_jsonb(NEW) - v_decision_cols) IS DISTINCT FROM (to_jsonb(OLD) - v_decision_cols) THEN
  RAISE EXCEPTION 'A decision changes nothing else' USING ERRCODE = '23514';
 END IF;
 IF NEW.decided_by_user_id IS DISTINCT FROM app.current_user_id() OR NEW.decided_by_user_id = OLD.recorded_by_user_id THEN
  RAISE EXCEPTION 'An agency fee is decided by an administrator other than the one who last recorded it' USING ERRCODE = '42501';
 END IF;
 NEW.decided_at := now();
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.recruitment_guard_agency_fee() FROM PUBLIC, ai_hr_app;
CREATE TRIGGER recruitment_agency_fee_guard BEFORE INSERT OR UPDATE OR DELETE ON public.recruitment_agency_fee
 FOR EACH ROW EXECUTE FUNCTION app.recruitment_guard_agency_fee();
--> statement-breakpoint

-- ── 5. The portal's rewards, the referrer's own states and the payroll queue ─────────────────────────────────────────────
-- The reward of each job on the caller's portal (one job with p_job): the portal function decides which jobs, and its
-- marker lets the owner read them.
CREATE FUNCTION app.recruitment_referral_portal_rewards(p_job uuid DEFAULT NULL)
RETURNS TABLE(job_id uuid, amount numeric, currency text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
 SELECT p.job_id, j.referral_reward, c.currency
 FROM app.recruitment_referral_portal(p_job) p
 JOIN public.recruitment_job_opening j ON j.id = p.job_id AND j.tenant_id = app.current_tenant_id()
 JOIN public.company c ON c.id = j.company_id AND c.tenant_id = j.tenant_id
 WHERE j.referral_reward IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION app.recruitment_referral_portal_rewards(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_referral_portal_rewards(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The caller's own referrals' frozen rewards and decisions: the decision and the payroll month only, never the reason, the
-- deciding or sending person, or the receiving employment.
CREATE FUNCTION app.recruitment_my_referral_rewards()
RETURNS TABLE(referral_id uuid, amount numeric, currency text, decision text, pay_period text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
 SELECT f.id, f.reward_amount, f.reward_currency, w.decision, w.pay_period
 FROM public.recruitment_referral f
 LEFT JOIN public.recruitment_referral_reward w ON w.referral_id = f.id AND w.tenant_id = f.tenant_id
 WHERE f.tenant_id = app.current_tenant_id() AND app.current_user_id() IS NOT NULL
  AND f.referrer_person_id = app.recruitment_current_person() AND f.reward_amount IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION app.recruitment_my_referral_rewards() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_my_referral_rewards() TO ai_hr_app;
--> statement-breakpoint
-- A payroll administrator's queue for one company: approved rewards not yet sent, with the receiving employee and who
-- approved them. Nothing about the hire, the candidate or the job.
CREATE FUNCTION app.recruitment_reward_payroll_queue(p_company uuid)
RETURNS TABLE(id uuid, amount numeric, currency text, payee_employment_id uuid, payee_name text, payee_code text,
 approved_by text, approved_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, app, pg_temp AS $$
 SELECT w.id, w.amount, w.currency, w.payee_employment_id, pp.full_name::text, x.employee_code::text, ap.full_name::text, w.decided_at
 FROM public.recruitment_referral_reward w
 JOIN public.employment x ON x.id = w.payee_employment_id AND x.tenant_id = w.tenant_id
 JOIN public.person pp ON pp.id = x.person_id AND pp.tenant_id = x.tenant_id
 LEFT JOIN public.app_user au ON au.id = w.decided_by_user_id AND au.tenant_id = w.tenant_id
 LEFT JOIN public.person ap ON ap.id = au.person_id AND ap.tenant_id = au.tenant_id
 WHERE w.tenant_id = app.current_tenant_id() AND w.payee_company_id = p_company AND w.decision = 'approved' AND w.txn_id IS NULL
  AND app.current_user_id() IS NOT NULL AND app.can_admin_payroll_for(p_company)
 ORDER BY w.decided_at, w.id
 LIMIT 500;
$$;
REVOKE ALL ON FUNCTION app.recruitment_reward_payroll_queue(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.recruitment_reward_payroll_queue(uuid) TO ai_hr_app;
