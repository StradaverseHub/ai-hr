-- AI v2 Phase 1, slice 3, W8: the first five loops at the Prepare level (owner-approved plan, 3 November 2026).
-- Source allocation 2002 / when1793330001402 in the AI Centre block 2000-2019 (docs/MIGRATION-ALLOCATION.md), renumbered
-- from the never-applied 0960 / when1793330000360 at the Phase 1 release integration (3 November 2026). It grants no
-- installation. Production is held.
--
-- A loop watches one part of HR work, prepares a card for the right person and checks on its next run whether the
-- work is done. At the Prepare level nothing changes without a person's Confirm on the owning service's own page:
-- these tables hold the loop's switches, its per-company pause, its cases and its run records, never an HR value.
--  1. Switches: the five loops join the closed worker list of teras_worker_control (0895). Off by default (no row);
--     only a group administrator under their own login writes a row, through the same 0895 policies. The
--     administrator who switched a loop on is its sponsor: the loop reads through the native owners under that
--     person's CURRENT authority, re-resolved every run, and stops when they lose it.
--  2. teras_loop_pause: an administrator of a company pauses (or resumes) one loop for that company.
--  3. teras_loop_case: one row per subject a loop prepared a card for (an employment, a day, a company's pay period).
--     It holds references, dates, counts and closed-vocabulary keys only (facts), never a name, number or free text.
--     States: open (waiting for the person), waiting (the person acted; the owner's usual approval is pending),
--     closed (done, inactive, superseded or expired). A recurrence reopens the same row and counts it.
--  4. teras_loop_run: the loop's outcome record, one append-only row per run and company: under whose authority
--     (the sponsor), which checks ran with their versions, which owners were read and what changed. No model is
--     called by any loop, so there is no model, provider or spend column.
-- Who reads (FORCE row-level security on the three new tables):
--  - the tenant's agent principal: switches, pauses, its cases and runs (it writes cases and runs, never pauses);
--  - administrators of the company (cases by employment through app.can_admin_employment, company cases and runs
--    through app.is_admin_for); group administrators therefore see every company;
--  - the employee, their own cases addressed to them; nobody else.
-- The agent principal writes a case only while the loop's switch is on, the tenant is not stopped and the company is
-- not paused; it never deletes. Grants: every privilege a table must not have is revoked, not merely left ungranted.
--
-- Writers reviewed before each constraint: core/agent-registry/controls.ts setWorkerSwitch is the only application
-- writer of teras_worker_control (the operator path writes the conversation row only, unchanged); the widened list
-- only adds values. core/loops/controls.ts is the only writer of teras_loop_pause and core/loops/run.ts of
-- teras_loop_case and teras_loop_run. All three tables are new.

-- 1. The loop switches.
ALTER TABLE public.teras_worker_control DROP CONSTRAINT teras_worker_control_worker_id_check;
--> statement-breakpoint
ALTER TABLE public.teras_worker_control ADD CONSTRAINT teras_worker_control_worker_id_check
 CHECK (worker_id IN ('approver_recommendation','explainers','conversation',
  'loop_probation_ending','loop_payroll_inputs','loop_missing_employee_data','loop_missed_clock_outs','loop_document_expiry'));
--> statement-breakpoint
-- 2. Per-company pause. No row, or paused=false, means the loop runs for that company while it is switched on.
CREATE TABLE public.teras_loop_pause (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 worker_id text NOT NULL CHECK (worker_id IN ('loop_probation_ending','loop_payroll_inputs','loop_missing_employee_data','loop_missed_clock_outs','loop_document_expiry')),
 company_id uuid NOT NULL,
 paused boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK (version>=1),
 changed_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 changed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,worker_id,company_id),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id)
);
--> statement-breakpoint
CREATE TRIGGER teras_loop_pause_version BEFORE UPDATE ON public.teras_loop_pause
 FOR EACH ROW EXECUTE FUNCTION app.teras_bump_version('version');
--> statement-breakpoint
-- 3. Cases. subject_key names the subject: `<kind>:<employment or company id>` with a calendar day or pay period
--    where one subject recurs (a missed clock-out per day, payroll inputs per pay period).
CREATE TABLE public.teras_loop_case (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 worker_id text NOT NULL CHECK (worker_id IN ('loop_probation_ending','loop_payroll_inputs','loop_missing_employee_data','loop_missed_clock_outs','loop_document_expiry')),
 company_id uuid NOT NULL,
 employment_id uuid REFERENCES public.employment(id) ON DELETE CASCADE,
 subject_key text NOT NULL CHECK (subject_key ~ '^[a-z]+:[0-9a-f-]{36}(:[0-9]{4}-[0-9]{2}(-[0-9]{2})?)?$'),
 recipient text NOT NULL CHECK (recipient IN ('hr','payroll','employee')),
 state text NOT NULL CHECK (state IN ('open','waiting','closed')),
 close_reason text CHECK (close_reason IN ('done','inactive','superseded','expired')),
 resolution text CHECK (resolution IN ('as_prepared','changed','completed')),
 facts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(facts)='object' AND octet_length(facts::text)<=4096),
 first_opened_at timestamptz NOT NULL DEFAULT now(),
 opened_at timestamptz NOT NULL DEFAULT now(),
 checked_at timestamptz NOT NULL DEFAULT now(),
 closed_at timestamptz,
 reopen_count integer NOT NULL DEFAULT 0 CHECK (reopen_count>=0),
 opened_run_id uuid NOT NULL,
 checked_run_id uuid NOT NULL,
 UNIQUE (tenant_id,worker_id,subject_key),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 CHECK ((state='closed')=(closed_at IS NOT NULL) AND (state='closed')=(close_reason IS NOT NULL)),
 CHECK (resolution IS NULL OR (state='closed' AND close_reason='done')),
 CHECK ((recipient='payroll')=(employment_id IS NULL)),
 CHECK (opened_at>=first_opened_at)
);
--> statement-breakpoint
CREATE INDEX teras_loop_case_open_idx ON public.teras_loop_case(tenant_id,worker_id,state,company_id);
--> statement-breakpoint
CREATE INDEX teras_loop_case_employment_idx ON public.teras_loop_case(tenant_id,employment_id) WHERE employment_id IS NOT NULL;
--> statement-breakpoint
-- 4. Runs: the loop's outcome record. company_id is null only for a run that reached no company (its sponsor had lost
--    their authority, or its owner read failed before any company was observed).
CREATE TABLE public.teras_loop_run (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 run_id uuid NOT NULL,
 worker_id text NOT NULL CHECK (worker_id IN ('loop_probation_ending','loop_payroll_inputs','loop_missing_employee_data','loop_missed_clock_outs','loop_document_expiry')),
 company_id uuid,
 status text NOT NULL CHECK (status IN ('ran','sponsor_lost','failed')),
 sponsor_user_id uuid REFERENCES public.app_user(id),
 loop_version text NOT NULL CHECK (loop_version ~ '^[a-z0-9_.:@-]{1,80}$'),
 started_at timestamptz NOT NULL,
 finished_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT now(),
 observed integer NOT NULL DEFAULT 0 CHECK (observed>=0),
 opened integer NOT NULL DEFAULT 0 CHECK (opened>=0),
 reopened integer NOT NULL DEFAULT 0 CHECK (reopened>=0),
 closed integer NOT NULL DEFAULT 0 CHECK (closed>=0),
 open_now integer NOT NULL DEFAULT 0 CHECK (open_now>=0),
 waiting_now integer NOT NULL DEFAULT 0 CHECK (waiting_now>=0),
 capped boolean NOT NULL DEFAULT false,
 checks jsonb NOT NULL CHECK (jsonb_typeof(checks)='array' AND octet_length(checks::text)<=8192),
 reads jsonb NOT NULL CHECK (jsonb_typeof(reads)='array' AND octet_length(reads::text)<=8192),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 CHECK (finished_at>=started_at),
 CHECK (status<>'ran' OR (company_id IS NOT NULL AND sponsor_user_id IS NOT NULL)),
 CHECK (status<>'sponsor_lost' OR company_id IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX teras_loop_run_identity ON public.teras_loop_run(tenant_id,run_id,coalesce(company_id,'00000000-0000-0000-0000-000000000000'::uuid));
--> statement-breakpoint
CREATE INDEX teras_loop_run_latest_idx ON public.teras_loop_run(tenant_id,worker_id,started_at DESC);
--> statement-breakpoint
CREATE TRIGGER teras_loop_run_append_only BEFORE UPDATE OR DELETE ON public.teras_loop_run
 FOR EACH ROW EXECUTE FUNCTION app.teras_outcome_append_only();
--> statement-breakpoint
-- Whether a loop may write for a company now: switched on, the tenant not stopped, the company not paused. The
-- agent's write policies below call it, so a run that lost its switch mid-way can write nothing. Invoker rights: the
-- agent principal reads all three under their own tenant policies (a definer would be the owner of a FORCE table).
CREATE FUNCTION app.teras_loop_may_write(p_worker text,p_company uuid) RETURNS boolean
 LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT app.current_agent_principal() IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.teras_worker_control w WHERE w.tenant_id=app.current_tenant_id() AND w.worker_id=p_worker AND w.enabled)
  AND NOT EXISTS (SELECT 1 FROM public.teras_mandate_control c WHERE c.tenant_id=app.current_tenant_id() AND c.stopped)
  AND NOT EXISTS (SELECT 1 FROM public.teras_loop_pause p WHERE p.tenant_id=app.current_tenant_id() AND p.worker_id=p_worker
   AND p.company_id=p_company AND p.paused)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_loop_may_write(text,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.teras_loop_may_write(text,uuid) TO ai_hr_app;
--> statement-breakpoint
-- ── RLS: forced on every new table ──
ALTER TABLE public.teras_loop_pause ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_loop_pause FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_loop_case ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_loop_case FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_loop_run ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_loop_run FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Pauses: readable in the tenant (like the switches themselves, so a card of a paused company is not shown);
-- written only by an administrator of the company under their own current login, attributed to them.
CREATE POLICY teras_loop_pause_read ON public.teras_loop_pause FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY teras_loop_pause_admin_insert ON public.teras_loop_pause FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.is_admin_for(company_id) AND changed_by_user_id=app.current_user_id());
--> statement-breakpoint
CREATE POLICY teras_loop_pause_admin_update ON public.teras_loop_pause FOR UPDATE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.is_admin_for(company_id))
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.is_admin_for(company_id) AND changed_by_user_id=app.current_user_id());
--> statement-breakpoint
-- Cases: the agent principal reads and writes them (never deletes); administrators read those of employments and
-- companies they administer; an employee reads their own cases addressed to them.
CREATE POLICY teras_loop_case_agent_read ON public.teras_loop_case FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY teras_loop_case_agent_insert ON public.teras_loop_case FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.teras_loop_may_write(worker_id,company_id) IS TRUE
  AND (employment_id IS NULL OR EXISTS (SELECT 1 FROM public.employment e WHERE e.id=teras_loop_case.employment_id AND e.tenant_id=app.current_tenant_id())));
--> statement-breakpoint
CREATE POLICY teras_loop_case_agent_update ON public.teras_loop_case FOR UPDATE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL)
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.teras_loop_may_write(worker_id,company_id) IS TRUE
  AND (employment_id IS NULL OR EXISTS (SELECT 1 FROM public.employment e WHERE e.id=teras_loop_case.employment_id AND e.tenant_id=app.current_tenant_id())));
--> statement-breakpoint
CREATE POLICY teras_loop_case_admin_read ON public.teras_loop_case FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.current_user_id() IS NOT NULL
  AND ((employment_id IS NOT NULL AND app.can_admin_employment(employment_id)) OR (employment_id IS NULL AND app.is_admin_for(company_id))));
--> statement-breakpoint
CREATE POLICY teras_loop_case_own_read ON public.teras_loop_case FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.current_user_id() IS NOT NULL
  AND recipient='employee' AND employment_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.employment e WHERE e.id=teras_loop_case.employment_id AND e.tenant_id=app.current_tenant_id()
   AND app.is_self_person(e.person_id)));
--> statement-breakpoint
-- Runs: the agent principal records and reads them; administrators read the runs of companies they administer, and
-- every administrator reads the company-less record of a run that reached no company (it names no company).
CREATE POLICY teras_loop_run_agent_insert ON public.teras_loop_run FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL
  AND (status<>'ran' OR app.teras_loop_may_write(worker_id,company_id) IS TRUE));
--> statement-breakpoint
CREATE POLICY teras_loop_run_agent_read ON public.teras_loop_run FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY teras_loop_run_admin_read ON public.teras_loop_run FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.current_user_id() IS NOT NULL
  AND ((company_id IS NOT NULL AND app.is_admin_for(company_id)) OR (company_id IS NULL AND app.is_admin())));
--> statement-breakpoint
-- ── Grants: exactly what each table needs, everything else revoked ──
REVOKE ALL ON public.teras_loop_pause,public.teras_loop_case,public.teras_loop_run FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON public.teras_loop_pause,public.teras_loop_case TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON public.teras_loop_run TO ai_hr_app;
