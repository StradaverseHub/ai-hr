-- AI v2 Phase 2, P2-2a: the Pre-salary loop and the Salary payroll loop (owner decisions, payroll-cycle loops, items 1-7,
-- 3 November 2026). Provisional DEVELOPMENT source allocation 0964 / when1793330000364 (docs/MIGRATION-ALLOCATION.md),
-- the number the AI v2 coordinator reserved for this task. It grants no installation; the journal position is re-frozen
-- at integration. Production is held.
--
-- The Pre-salary loop is the Phase 1 payroll inputs loop (loop_payroll_inputs, 0960), absorbed: it keeps its id, its
-- switch, its sponsor and its cases, and widens what it checks (core/loops/payroll-inputs.ts). No new id is needed.
-- The Salary payroll loop is new and stays at Prepare in every company: it checks and prepares, a person runs, approves
-- and closes payroll (no second approver, owner decision 2).
--  1. The Salary payroll loop joins the closed loop lists of 0960 (switch, pause, case, run). The lists only grow.
--  2. teras_payroll_loop_setting: per company, the Pre-salary check interval (hourly, twice daily or daily; no row means
--     daily) and the Salary payroll loop's net-swing threshold (no row means 15%, owner decision 5) with the pay patterns
--     excluded from it. Versioned and append-only: every change is a new row, attributed to the administrator who made
--     it, either directly (source admin) or by approving a threshold proposal (source proposal). Nothing is ever loosened
--     without such a row; the loop itself never writes a setting.
--  3. teras_payroll_threshold_decision: an administrator's decision on a threshold proposal (approve or reject), with the
--     evidence the proposal was derived from (counts only). Append-only.
--  4. teras_payroll_swing_disposition: payroll HR's disposition of one net-swing flag (a Salary payroll loop case of kind
--     swing): expected, or a real problem. The flag's period, pattern, swing and threshold are copied from the case so
--     the proposals read one table. Append-only; one disposition per flag.
-- No column holds a name, an amount, an account number or free text: swings and thresholds are ratios in basis points
-- and patterns are closed keys (cause:<kind>) or a pay item's code (item:<code>).
-- Who reads and writes (FORCE row-level security on the three new tables):
--  - settings: administrators of the company and the tenant's agent principal read; an administrator of the company
--    writes under their own current login, attributed to them;
--  - decisions: administrators of the company read and write, attributed to themselves;
--  - dispositions: the agent principal and payroll administrators of the employment's company read; a payroll
--    administrator who administers the employment writes, attributed to themselves, and only for a swing case of the
--    Salary payroll loop for that same company and employment.
-- Grants: every privilege a table must not have is revoked, not merely left ungranted.
--
-- Writers reviewed before each constraint: core/agent-registry/controls.ts setWorkerSwitch is the only application writer
-- of teras_worker_control; core/loops/controls.ts of teras_loop_pause; core/loops/run.ts of teras_loop_case and
-- teras_loop_run. The widened lists only add a value, so every existing row and writer still passes. The three new
-- tables are written only by core/loops/payroll-loop-settings.ts (settings and decisions) and
-- core/loops/salary-swing-service.ts (dispositions).

-- 1. The Salary payroll loop in the closed loop lists.
ALTER TABLE public.teras_worker_control DROP CONSTRAINT teras_worker_control_worker_id_check;
--> statement-breakpoint
ALTER TABLE public.teras_worker_control ADD CONSTRAINT teras_worker_control_worker_id_check
 CHECK (worker_id IN ('approver_recommendation','explainers','conversation',
  'loop_probation_ending','loop_payroll_inputs','loop_missing_employee_data','loop_missed_clock_outs','loop_document_expiry',
  'loop_salary_payroll'));
--> statement-breakpoint
ALTER TABLE public.teras_loop_pause DROP CONSTRAINT teras_loop_pause_worker_id_check;
--> statement-breakpoint
ALTER TABLE public.teras_loop_pause ADD CONSTRAINT teras_loop_pause_worker_id_check
 CHECK (worker_id IN ('loop_probation_ending','loop_payroll_inputs','loop_missing_employee_data','loop_missed_clock_outs','loop_document_expiry',
  'loop_salary_payroll'));
--> statement-breakpoint
ALTER TABLE public.teras_loop_case DROP CONSTRAINT teras_loop_case_worker_id_check;
--> statement-breakpoint
ALTER TABLE public.teras_loop_case ADD CONSTRAINT teras_loop_case_worker_id_check
 CHECK (worker_id IN ('loop_probation_ending','loop_payroll_inputs','loop_missing_employee_data','loop_missed_clock_outs','loop_document_expiry',
  'loop_salary_payroll'));
--> statement-breakpoint
ALTER TABLE public.teras_loop_run DROP CONSTRAINT teras_loop_run_worker_id_check;
--> statement-breakpoint
ALTER TABLE public.teras_loop_run ADD CONSTRAINT teras_loop_run_worker_id_check
 CHECK (worker_id IN ('loop_probation_ending','loop_payroll_inputs','loop_missing_employee_data','loop_missed_clock_outs','loop_document_expiry',
  'loop_salary_payroll'));
--> statement-breakpoint
-- A pay pattern key: a closed cause (cause:<kind>) or a pay item's code (item:<code>). Immutable, so CHECKs may call it.
CREATE FUNCTION app.teras_swing_pattern_valid(p text) RETURNS boolean
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT p IS NOT NULL AND p ~ '^(cause:[a-z_]{1,40}|item:[A-Za-z0-9_.-]{1,40})$'
$$;
--> statement-breakpoint
CREATE FUNCTION app.teras_swing_patterns_valid(p text[]) RETURNS boolean
 LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,app AS $$
 SELECT p IS NOT NULL AND cardinality(p)<=20 AND coalesce((SELECT bool_and(app.teras_swing_pattern_valid(x)) FROM unnest(p) x),true)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_swing_pattern_valid(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_swing_patterns_valid(text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.teras_swing_pattern_valid(text) TO ai_hr_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.teras_swing_patterns_valid(text[]) TO ai_hr_app;
--> statement-breakpoint
-- 3. Decisions on threshold proposals (created before the settings, which reference an approved one).
CREATE TABLE public.teras_payroll_threshold_decision (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 proposal_key text NOT NULL CHECK (proposal_key ~ '^[0-9a-f]{64}$'),
 kind text NOT NULL CHECK (kind IN ('threshold','exclusion')),
 from_threshold_bp integer NOT NULL CHECK (from_threshold_bp BETWEEN 100 AND 10000),
 to_threshold_bp integer CHECK (to_threshold_bp BETWEEN 100 AND 10000),
 pattern text CHECK (pattern IS NULL OR app.teras_swing_pattern_valid(pattern)),
 evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=2048),
 decision text NOT NULL CHECK (decision IN ('approved','rejected')),
 decided_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 decided_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 UNIQUE (tenant_id,id),
 CHECK ((kind='threshold')=(to_threshold_bp IS NOT NULL)),
 CHECK ((kind='exclusion')=(pattern IS NOT NULL)),
 CHECK (kind<>'threshold' OR to_threshold_bp>from_threshold_bp)
);
--> statement-breakpoint
CREATE INDEX teras_payroll_threshold_decision_company_idx ON public.teras_payroll_threshold_decision(tenant_id,company_id,decided_at DESC);
--> statement-breakpoint
CREATE TRIGGER teras_payroll_threshold_decision_append_only BEFORE UPDATE OR DELETE ON public.teras_payroll_threshold_decision
 FOR EACH ROW EXECUTE FUNCTION app.teras_outcome_append_only();
--> statement-breakpoint
-- 2. Settings: one row per version and company; the highest version is in force.
CREATE TABLE public.teras_payroll_loop_setting (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 version integer NOT NULL CHECK (version>=1),
 check_interval text NOT NULL CHECK (check_interval IN ('hourly','twice_daily','daily')),
 swing_threshold_bp integer NOT NULL CHECK (swing_threshold_bp BETWEEN 100 AND 10000),
 swing_exclusions text[] NOT NULL DEFAULT '{}' CHECK (app.teras_swing_patterns_valid(swing_exclusions)),
 source text NOT NULL CHECK (source IN ('admin','proposal')),
 decision_id uuid,
 changed_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 changed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,company_id,version),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 FOREIGN KEY (tenant_id,decision_id) REFERENCES public.teras_payroll_threshold_decision(tenant_id,id),
 CHECK ((source='proposal')=(decision_id IS NOT NULL))
);
--> statement-breakpoint
CREATE TRIGGER teras_payroll_loop_setting_append_only BEFORE UPDATE OR DELETE ON public.teras_payroll_loop_setting
 FOR EACH ROW EXECUTE FUNCTION app.teras_outcome_append_only();
--> statement-breakpoint
-- 4. Dispositions of net-swing flags. Deleted only by cascade with the employment or its case (never by the application:
--    no DELETE privilege), so an employment that is removed takes its flags with it.
CREATE TABLE public.teras_payroll_swing_disposition (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 case_id uuid NOT NULL REFERENCES public.teras_loop_case(id) ON DELETE CASCADE,
 company_id uuid NOT NULL,
 employment_id uuid NOT NULL REFERENCES public.employment(id) ON DELETE CASCADE,
 pay_period text NOT NULL CHECK (pay_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 pattern text NOT NULL CHECK (app.teras_swing_pattern_valid(pattern)),
 swing_bp integer NOT NULL CHECK (swing_bp BETWEEN 0 AND 10000000),
 threshold_bp integer NOT NULL CHECK (threshold_bp BETWEEN 100 AND 10000),
 disposition text NOT NULL CHECK (disposition IN ('expected','problem')),
 decided_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 decided_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id,case_id),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id)
);
--> statement-breakpoint
CREATE INDEX teras_payroll_swing_disposition_company_idx ON public.teras_payroll_swing_disposition(tenant_id,company_id,decided_at DESC);
--> statement-breakpoint
CREATE TRIGGER teras_payroll_swing_disposition_append_only BEFORE UPDATE ON public.teras_payroll_swing_disposition
 FOR EACH ROW EXECUTE FUNCTION app.teras_outcome_append_only();
--> statement-breakpoint
-- ── RLS: forced on every new table ──
ALTER TABLE public.teras_payroll_threshold_decision ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_payroll_threshold_decision FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_payroll_loop_setting ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_payroll_loop_setting FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_payroll_swing_disposition ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_payroll_swing_disposition FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY teras_payroll_threshold_decision_admin_read ON public.teras_payroll_threshold_decision FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.current_user_id() IS NOT NULL
  AND app.is_admin_for(company_id));
--> statement-breakpoint
CREATE POLICY teras_payroll_threshold_decision_admin_insert ON public.teras_payroll_threshold_decision FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.is_admin_for(company_id) AND decided_by_user_id=app.current_user_id());
--> statement-breakpoint
CREATE POLICY teras_payroll_loop_setting_read ON public.teras_payroll_loop_setting FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND (app.current_agent_principal() IS NOT NULL
  OR (app.current_user_id() IS NOT NULL AND app.is_admin_for(company_id))));
--> statement-breakpoint
-- A proposal-sourced row must point at this administrator's own approval of that company's proposal.
CREATE POLICY teras_payroll_loop_setting_admin_insert ON public.teras_payroll_loop_setting FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.is_admin_for(company_id) AND changed_by_user_id=app.current_user_id()
  AND (source='admin' OR EXISTS (SELECT 1 FROM public.teras_payroll_threshold_decision d WHERE d.tenant_id=teras_payroll_loop_setting.tenant_id
   AND d.id=teras_payroll_loop_setting.decision_id AND d.company_id=teras_payroll_loop_setting.company_id AND d.decision='approved'
   AND d.decided_by_user_id=app.current_user_id())));
--> statement-breakpoint
CREATE POLICY teras_payroll_swing_disposition_agent_read ON public.teras_payroll_swing_disposition FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY teras_payroll_swing_disposition_payroll_read ON public.teras_payroll_swing_disposition FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.current_user_id() IS NOT NULL
  AND app.can_admin_payroll_for(company_id) AND app.can_admin_employment(employment_id));
--> statement-breakpoint
CREATE POLICY teras_payroll_swing_disposition_payroll_insert ON public.teras_payroll_swing_disposition FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.can_admin_payroll_for(company_id) AND app.can_admin_employment(employment_id) AND decided_by_user_id=app.current_user_id()
  AND EXISTS (SELECT 1 FROM public.teras_loop_case c WHERE c.id=teras_payroll_swing_disposition.case_id
   AND c.tenant_id=teras_payroll_swing_disposition.tenant_id AND c.worker_id='loop_salary_payroll' AND c.subject_key LIKE 'swing:%'
   AND c.company_id=teras_payroll_swing_disposition.company_id AND c.employment_id=teras_payroll_swing_disposition.employment_id));
--> statement-breakpoint
-- ── Grants: exactly what each table needs, everything else revoked ──
REVOKE ALL ON public.teras_payroll_threshold_decision,public.teras_payroll_loop_setting,public.teras_payroll_swing_disposition FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON public.teras_payroll_threshold_decision,public.teras_payroll_loop_setting,public.teras_payroll_swing_disposition TO ai_hr_app;
