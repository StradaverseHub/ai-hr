-- AI v2 Phase 2 hardening, payroll loops (4 November 2026). Source allocation 2011 / when1793330001411 in the AI Centre block
-- 2000-2019 (docs/MIGRATION-ALLOCATION.md), after 2004-2010. It grants no installation. Production is held.
--
-- Owner goal: "capture exception, ensure data is in and payroll is processed correctly, with the most minimal time and
-- effort by human". Owner input 17: some flags are legitimate business setups. Owner rulings 18 (the Pre-salary loop sends
-- cut-off reminders automatically) and 19 ("expected" acknowledgements hide warnings; for blocks they only pre-fill the
-- one-tap resolve).
--  1. The payroll close circuit compares a run with the PRIOR CYCLE OF THE SAME RUN TYPE: a bonus run with the last bonus
--     run, an off-cycle run with the last off-cycle run, a regular run with the last regular run (until now the latest
--     earlier month of any type, so a bonus run was measured against a salary month and tripped, and a salary month that
--     followed a bonus-only month was measured against the bonus). app.payroll_close_circuit_inputs selects it, and
--     app.payroll_close_source_people accepts only such a prior; the ordinary evaluation (core/payroll-anomaly.ts) selects
--     the same row, so the two stay equal. Same company, earlier pay month, latest month first, then the highest run
--     sequence. Nothing else in either function changes (CREATE OR REPLACE keeps their owner and grants).
--  2. payroll_check_acknowledgement: a payroll administrator's standing "expected, not an exception" for ONE check, scoped
--     to one person (employment), one group (department) or the whole company, with a reason, an optional review date,
--     who and when. It changes no calculation, pay or record: a warning it covers leaves the to-do and repeat-issue counts
--     but stays listed (the Audit loop page and pack); a block is never suppressed, its one-tap resolve is only pre-filled.
--     Never rewritten: only revoked, once (who and when). Nobody acknowledges a check about themselves. A standing rule
--     proposed by the learning step (5 or more dispositions of the same check and person running, at least 80% expected)
--     becomes an acknowledgement only by a group administrator's approval (source `proposal`).
--  3. payroll_check_rule_decision: a group administrator's approval, or an administrator's rejection, of such a proposal,
--     with its evidence (counts only). Append-only. A rejected proposal is not offered again while its evidence is the same.
--  4. teras_cut_off_reminder: the Pre-salary loop's automatic cut-off reminders (owner ruling 18): one row per recipient,
--     cut-off date and lead (5, 2 or 1 days before), with only the counts of the recipient's own pending items; no pay
--     figure, no name. The unique key is the rate limit: one reminder per recipient, cut-off and lead, ever. Written by the
--     agent principal only while the Pre-salary loop may write for the company (switched on, tenant not stopped, company not
--     paused); the reminder itself is a `teras-loop.cut-off-reminder` domain event about the recipient's own employment,
--     appended by a SECURITY DEFINER trigger from the row just inserted (the agent principal's own event inserts are closed
--     shapes, migration 0819), which core/notifications.ts turns into the recipient's in-app notice. It changes no record.
-- Who reads and writes (FORCE row-level security on the three new tables):
--  - acknowledgements and rule decisions: payroll administrators of the company and the tenant's agent principal read;
--    an auditor with a current grant reads the acknowledgements (they are listed in the Audit loop and its pack);
--  - reminders: the agent principal reads and writes; payroll administrators of the company read.
-- Grants: every privilege a table must not have is revoked, not merely left ungranted.
--
-- Writers reviewed before each constraint: core/payroll-anomaly.ts and core/payroll.ts read the two close functions and
-- write nothing through them; the three tables are new, written only by core/loops/acknowledgements.ts (acknowledgements and
-- rule decisions) and core/loops/cut-off-reminders.ts (reminders).

-- 1. The close circuit's prior cycle, by run type.
CREATE OR REPLACE FUNCTION app.payroll_close_circuit_inputs(p_batch uuid)
 RETURNS TABLE(batch_id uuid,company_id uuid,prior_batch_id uuid,current_net float8,prior_net float8,source_version text,inputs_visible boolean)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH target AS (
  SELECT b.id,b.company_id,b.pay_period,b.run_type,b.xmin::text AS version FROM public.payroll_batch b
  WHERE b.id=p_batch AND b.tenant_id=app.current_tenant_id() AND app.current_user_id() IS NOT NULL
   AND app.principal_snapshot_current() AND app.can_admin_payroll_for(b.company_id)
   AND EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id()
    AND u.tenant_id=b.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
 ), selected AS (
  SELECT t.*,p.id AS prior_id,p.xmin::text AS prior_version FROM target t
  LEFT JOIN LATERAL (SELECT b.id,b.xmin FROM public.payroll_batch b
   WHERE b.company_id=t.company_id AND b.run_type=t.run_type AND b.pay_period<t.pay_period
   ORDER BY b.pay_period DESC,b.run_seq DESC,b.id DESC LIMIT 1) p ON true
 )
 SELECT s.id,s.company_id,s.prior_id,
  (SELECT coalesce(sum(p.net_pay),0)::float8 FROM public.payslip p WHERE p.batch_id=s.id),
  (SELECT coalesce(sum(p.net_pay),0)::float8 FROM public.payslip p WHERE p.batch_id=s.prior_id),
  md5(s.version||':'||coalesce(s.prior_version,'')||':'||coalesce(s.prior_id::text,'')||':'||
   coalesce((SELECT string_agg(p.id::text||':'||p.xmin::text,',' ORDER BY p.id) FROM public.payslip p WHERE p.batch_id=s.id OR p.batch_id=s.prior_id),'')),
  NOT EXISTS(SELECT 1 FROM public.payslip p WHERE (p.batch_id=s.id OR p.batch_id=s.prior_id)
   AND (app.can_admin_payroll_employment(p.employment_id) OR EXISTS(SELECT 1 FROM public.employment e
     WHERE e.id=p.employment_id AND app.is_self_person(e.person_id))) IS NOT TRUE)
 FROM selected s
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.payroll_close_source_people(p_batch uuid,p_prior uuid,p_coverage uuid[]) RETURNS uuid[]
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE b public.payroll_batch%ROWTYPE;ids uuid[];sources uuid[];
BEGIN
 SELECT * INTO b FROM public.payroll_batch WHERE id=p_batch AND tenant_id=app.current_tenant_id();
 IF NOT FOUND OR app.current_user_id() IS NULL OR app.principal_snapshot_current() IS NOT TRUE
  OR app.can_admin_payroll_for(b.company_id) IS NOT TRUE OR NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=b.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) THEN RAISE EXCEPTION 'Payroll source unavailable' USING ERRCODE='42501';END IF;
 IF p_coverage IS NULL OR array_position(p_coverage,NULL) IS NOT NULL OR
  coalesce((SELECT array_agg(DISTINCT q ORDER BY q) FROM unnest(p_coverage) q),'{}'::uuid[]) IS DISTINCT FROM p_coverage
 THEN RAISE EXCEPTION 'Payroll source unavailable' USING ERRCODE='42501';END IF;
 IF p_prior IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.payroll_batch prior
  WHERE prior.id=p_prior AND prior.tenant_id=b.tenant_id AND prior.company_id=b.company_id AND prior.run_type=b.run_type AND prior.pay_period<b.pay_period
   AND NOT EXISTS(SELECT 1 FROM public.payroll_batch newer WHERE newer.company_id=b.company_id AND newer.run_type=b.run_type AND newer.pay_period<b.pay_period AND newer.pay_period>prior.pay_period))
 THEN RAISE EXCEPTION 'Payroll source unavailable' USING ERRCODE='42501';END IF;
 IF EXISTS(SELECT 1 FROM unnest(p_coverage) selected(id) LEFT JOIN public.employment e ON e.id=selected.id AND e.tenant_id=b.tenant_id
  WHERE e.id IS NULL OR NOT(EXISTS(SELECT 1 FROM public.payslip slip WHERE slip.batch_id=b.id AND slip.employment_id=e.id AND slip.tenant_id=b.tenant_id)
   OR (b.run_type='regular' AND e.hired_on<=((b.pay_period||'-01')::date+interval '1 month' - interval '1 day')::date AND (e.terminated_on IS NULL OR e.terminated_on>=(b.pay_period||'-01')::date)
    -- Membership assertion only, matching entityChangedDuring/employedByCompanyDuring in
    -- core/employment-company.ts and the unchanged closeOwed tenure predicate. No new nomination.
    AND EXISTS(SELECT 1 FROM public.assignment changed WHERE changed.employment_id=e.id AND changed.tenant_id=b.tenant_id AND changed.superseded_at IS NULL AND changed.company_id IS NOT NULL AND changed.company_id<>e.company_id AND changed.valid_from<=((b.pay_period||'-01')::date+interval '1 month' - interval '1 day')::date AND (changed.valid_to IS NULL OR changed.valid_to>(b.pay_period||'-01')::date))
    AND (e.company_id=b.company_id OR EXISTS(SELECT 1 FROM public.assignment a WHERE a.employment_id=e.id AND a.tenant_id=b.tenant_id AND a.company_id=b.company_id AND a.superseded_at IS NULL AND a.valid_from<=((b.pay_period||'-01')::date+interval '1 month' - interval '1 day')::date AND (a.valid_to IS NULL OR a.valid_to>(b.pay_period||'-01')::date))))))
 THEN RAISE EXCEPTION 'Payroll source unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}'::uuid[]) INTO sources FROM (
  SELECT slip.employment_id AS id FROM public.payslip slip WHERE slip.batch_id IN (p_batch,p_prior) AND slip.tenant_id=b.tenant_id
  UNION ALL SELECT unnest(p_coverage)
 ) q;
 IF EXISTS(SELECT 1 FROM unnest(sources) q(id) LEFT JOIN public.employment e ON e.id=q.id AND e.tenant_id=b.tenant_id LEFT JOIN public.person p ON p.id=e.person_id AND p.tenant_id=b.tenant_id WHERE e.id IS NULL OR p.id IS NULL)
 THEN RAISE EXCEPTION 'Payroll source unavailable' USING ERRCODE='42501';END IF;
 SELECT coalesce(array_agg(DISTINCT e.person_id ORDER BY e.person_id),'{}'::uuid[]) INTO ids FROM public.employment e WHERE e.id=ANY(sources) AND e.tenant_id=b.tenant_id;
 RETURN ids;
END $$;
--> statement-breakpoint
-- 2. Standing acknowledgements. check_id is a closed key: audit:<control>, anomaly:<detector> or swing:net_swing.
CREATE TABLE public.payroll_check_acknowledgement (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 check_id text NOT NULL CHECK (check_id ~ '^(audit|anomaly|swing):[a-z0-9_-]{1,60}$'),
 scope text NOT NULL CHECK (scope IN ('person','group','company')),
 employment_id uuid REFERENCES public.employment(id) ON DELETE CASCADE,
 department_id uuid REFERENCES public.department(id) ON DELETE CASCADE,
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
 review_on date,
 source text NOT NULL DEFAULT 'person' CHECK (source IN ('person','proposal')),
 decision_id uuid,
 created_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 revoked_by_user_id uuid REFERENCES public.app_user(id),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 UNIQUE (tenant_id,id),
 CHECK ((scope='person')=(employment_id IS NOT NULL)),
 CHECK ((scope='group')=(department_id IS NOT NULL)),
 CHECK ((source='proposal')=(decision_id IS NOT NULL)),
 CHECK ((revoked_at IS NULL)=(revoked_by_user_id IS NULL)),
 CHECK (revoked_at IS NULL OR revoked_at>=created_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX payroll_check_acknowledgement_current_uq ON public.payroll_check_acknowledgement
 (tenant_id,company_id,check_id,scope,coalesce(employment_id,department_id,company_id)) WHERE revoked_at IS NULL;
--> statement-breakpoint
CREATE INDEX payroll_check_acknowledgement_company_idx ON public.payroll_check_acknowledgement(tenant_id,company_id,created_at DESC);
--> statement-breakpoint
-- An acknowledgement is never rewritten or deleted by the application: only its revocation is added, once.
CREATE FUNCTION app.payroll_check_acknowledgement_revoke_only() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  RAISE EXCEPTION 'An acknowledgement is only ever revoked, never deleted' USING ERRCODE='42501';
 END IF;
 IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL
  OR (NEW.id,NEW.tenant_id,NEW.company_id,NEW.check_id,NEW.scope,NEW.employment_id,NEW.department_id,NEW.reason,NEW.review_on,NEW.source,NEW.decision_id,
   NEW.created_by_user_id,NEW.created_at)
   IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.company_id,OLD.check_id,OLD.scope,OLD.employment_id,OLD.department_id,OLD.reason,OLD.review_on,OLD.source,OLD.decision_id,
   OLD.created_by_user_id,OLD.created_at) THEN
  RAISE EXCEPTION 'An acknowledgement is only ever revoked, once' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_check_acknowledgement_revoke_only() FROM PUBLIC;
--> statement-breakpoint
-- Deleted only by cascade with its employment or department (the application holds no DELETE privilege).
CREATE TRIGGER payroll_check_acknowledgement_revoke_only BEFORE UPDATE ON public.payroll_check_acknowledgement
 FOR EACH ROW EXECUTE FUNCTION app.payroll_check_acknowledgement_revoke_only();
--> statement-breakpoint
-- 3. Decisions on proposed standing rules (the learning step).
CREATE TABLE public.payroll_check_rule_decision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 proposal_key text NOT NULL CHECK (proposal_key ~ '^[0-9a-f]{64}$'),
 check_id text NOT NULL CHECK (check_id ~ '^(audit|anomaly|swing):[a-z0-9_-]{1,60}$'),
 employment_id uuid NOT NULL REFERENCES public.employment(id) ON DELETE CASCADE,
 evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=2048),
 decision text NOT NULL CHECK (decision IN ('approved','rejected')),
 decided_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 decided_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 UNIQUE (tenant_id,id)
);
--> statement-breakpoint
CREATE INDEX payroll_check_rule_decision_company_idx ON public.payroll_check_rule_decision(tenant_id,company_id,decided_at DESC);
--> statement-breakpoint
CREATE TRIGGER payroll_check_rule_decision_append_only BEFORE UPDATE ON public.payroll_check_rule_decision
 FOR EACH ROW EXECUTE FUNCTION app.teras_outcome_append_only();
--> statement-breakpoint
ALTER TABLE public.payroll_check_acknowledgement ADD CONSTRAINT payroll_check_acknowledgement_decision_fk
 FOREIGN KEY (tenant_id,decision_id) REFERENCES public.payroll_check_rule_decision(tenant_id,id);
--> statement-breakpoint
-- 4. The Pre-salary loop's cut-off reminders (the ledger is the rate limit and the record).
CREATE TABLE public.teras_cut_off_reminder (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 pay_period text NOT NULL CHECK (pay_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 cut_off date NOT NULL,
 lead_days smallint NOT NULL CHECK (lead_days IN (5,2,1)),
 recipient_employment_id uuid NOT NULL REFERENCES public.employment(id) ON DELETE CASCADE,
 audience text NOT NULL CHECK (audience IN ('employee','approver','both')),
 own_items integer NOT NULL DEFAULT 0 CHECK (own_items BETWEEN 0 AND 10000),
 approvals integer NOT NULL DEFAULT 0 CHECK (approvals BETWEEN 0 AND 10000),
 run_id uuid,
 agent_principal_id uuid NOT NULL,
 sent_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 UNIQUE (tenant_id,recipient_employment_id,cut_off,lead_days),
 CHECK (own_items+approvals>0)
);
--> statement-breakpoint
CREATE INDEX teras_cut_off_reminder_company_idx ON public.teras_cut_off_reminder(tenant_id,company_id,cut_off);
--> statement-breakpoint
-- Never updated; deleted only by cascade with the recipient's employment (the application holds no DELETE privilege).
CREATE TRIGGER teras_cut_off_reminder_append_only BEFORE UPDATE ON public.teras_cut_off_reminder
 FOR EACH ROW EXECUTE FUNCTION app.teras_outcome_append_only();
--> statement-breakpoint
-- The reminder itself: one domain event about the recipient's own employment, from the row just inserted and nothing a
-- caller supplies. SECURITY DEFINER for the same reason as 2006's audit anchor (the agent's own event shapes are closed).
CREATE FUNCTION app.teras_cut_off_reminder_event_tg() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 INSERT INTO public.domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,subject_employment_id,payload)
  VALUES (NEW.tenant_id,'teras-loop-reminder',NEW.id,'teras-loop.cut-off-reminder','agent'::public.actor_type,NEW.agent_principal_id,
   NEW.recipient_employment_id,jsonb_build_object('companyId',NEW.company_id,'payPeriod',NEW.pay_period,'cutOff',NEW.cut_off::text,
    'leadDays',NEW.lead_days,'audience',NEW.audience,'ownItems',NEW.own_items,'approvals',NEW.approvals,'workerId','loop_payroll_inputs'));
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_cut_off_reminder_event_tg() FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
CREATE TRIGGER teras_cut_off_reminder_event AFTER INSERT ON public.teras_cut_off_reminder
 FOR EACH ROW EXECUTE FUNCTION app.teras_cut_off_reminder_event_tg();
--> statement-breakpoint
-- ── RLS: forced on every new table ──
ALTER TABLE public.payroll_check_acknowledgement ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_check_acknowledgement FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_check_rule_decision ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_check_rule_decision FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_cut_off_reminder ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_cut_off_reminder FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payroll_check_acknowledgement_agent_read ON public.payroll_check_acknowledgement FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL);
--> statement-breakpoint
-- Payroll administrators of the company, and an auditor with a current grant (app.payroll_audit_can_read covers both).
CREATE POLICY payroll_check_acknowledgement_read ON public.payroll_check_acknowledgement FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.payroll_audit_can_read(company_id) IS TRUE);
--> statement-breakpoint
-- A payroll administrator of the company, under their own current login, attributed to them; for one person only one
-- they administer and who is not themselves; a proposal-sourced one only by a group administrator who approved it.
CREATE POLICY payroll_check_acknowledgement_insert ON public.payroll_check_acknowledgement FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.can_admin_payroll_for(company_id) IS TRUE AND created_by_user_id=app.current_user_id() AND revoked_at IS NULL
  AND (employment_id IS NULL OR (app.can_admin_employment(employment_id) IS TRUE AND EXISTS (SELECT 1 FROM public.employment e
   WHERE e.id=payroll_check_acknowledgement.employment_id AND e.tenant_id=app.current_tenant_id() AND e.company_id=payroll_check_acknowledgement.company_id
   AND app.is_self_person(e.person_id) IS NOT TRUE)))
  AND (department_id IS NULL OR EXISTS (SELECT 1 FROM public.department d WHERE d.id=payroll_check_acknowledgement.department_id
   AND d.tenant_id=app.current_tenant_id() AND d.company_id=payroll_check_acknowledgement.company_id))
  AND (source='person' OR (app.is_group_admin() IS TRUE AND EXISTS (SELECT 1 FROM public.payroll_check_rule_decision r
   WHERE r.tenant_id=payroll_check_acknowledgement.tenant_id AND r.id=payroll_check_acknowledgement.decision_id
    AND r.company_id=payroll_check_acknowledgement.company_id AND r.decision='approved' AND r.decided_by_user_id=app.current_user_id()))));
--> statement-breakpoint
CREATE POLICY payroll_check_acknowledgement_revoke ON public.payroll_check_acknowledgement FOR UPDATE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.can_admin_payroll_for(company_id) IS TRUE)
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.can_admin_payroll_for(company_id) IS TRUE AND revoked_by_user_id=app.current_user_id());
--> statement-breakpoint
CREATE POLICY payroll_check_rule_decision_agent_read ON public.payroll_check_rule_decision FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY payroll_check_rule_decision_read ON public.payroll_check_rule_decision FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.current_user_id() IS NOT NULL
  AND app.can_admin_payroll_for(company_id) IS TRUE);
--> statement-breakpoint
-- An approval is a group administrator's; a rejection any payroll administrator of the company's. Never the person the
-- rule would be about.
CREATE POLICY payroll_check_rule_decision_insert ON public.payroll_check_rule_decision FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.can_admin_payroll_for(company_id) IS TRUE AND decided_by_user_id=app.current_user_id()
  AND EXISTS (SELECT 1 FROM public.employment e WHERE e.id=payroll_check_rule_decision.employment_id AND e.tenant_id=app.current_tenant_id()
   AND e.company_id=payroll_check_rule_decision.company_id AND app.is_self_person(e.person_id) IS NOT TRUE)
  AND (decision='rejected' OR app.is_group_admin() IS TRUE));
--> statement-breakpoint
CREATE POLICY teras_cut_off_reminder_agent_read ON public.teras_cut_off_reminder FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY teras_cut_off_reminder_agent_insert ON public.teras_cut_off_reminder FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND agent_principal_id=app.current_agent_principal()
  AND app.teras_loop_may_write('loop_payroll_inputs',company_id) IS TRUE
  AND EXISTS (SELECT 1 FROM public.employment e WHERE e.id=teras_cut_off_reminder.recipient_employment_id AND e.tenant_id=app.current_tenant_id()));
--> statement-breakpoint
CREATE POLICY teras_cut_off_reminder_read ON public.teras_cut_off_reminder FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.current_user_id() IS NOT NULL
  AND app.can_admin_payroll_for(company_id) IS TRUE);
--> statement-breakpoint
-- ── Grants: exactly what each table needs, everything else revoked ──
REVOKE ALL ON public.payroll_check_acknowledgement,public.payroll_check_rule_decision,public.teras_cut_off_reminder FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON public.payroll_check_acknowledgement TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON public.payroll_check_rule_decision,public.teras_cut_off_reminder TO ai_hr_app;
