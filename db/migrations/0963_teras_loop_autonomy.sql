-- AI v2 Phase 2, P2-1: the autonomy ladder, limits, undo windows and automatic demotion for the loops (owner-approved
-- Phase 2 plan and mock-ups Main and Promote, 3 November 2026).
-- Provisional DEVELOPMENT source allocation 0963 / when1793330000363 (docs/MIGRATION-ALLOCATION.md), reserved for P2-1
-- by the AI v2 coordinator. A scan of every origin ref and registered worktree on 3 November 2026 found file claims
-- through 0961 / when1793330000361 (0962 is held for the renumbered 0952 at release; 0966 by the parallel P2-4 task).
-- It grants no installation, and the journal position is re-frozen at integration. Production is held.
--
-- A loop's level for one company: 0 Watch, 1 Prepare (the Phase 1 behaviour, and the level with no row), 2 Act within
-- limits, 3 Act and audit. Above Prepare a loop changes an HR record itself, through the record's own owner service,
-- inside the company's limits, tells the person, and every change can be undone for a set window.
--  1. teras_loop_level: the current level and limits per loop and company. Written by a group administrator under
--     their own login (promote one level at a time, or move down at any time), or by the loop itself, which may only
--     move itself back down to Prepare (automatic demotion). The cap is in the database as well as in code: only the
--     missed clock-outs and missing employee data loops can ever stand above Prepare. Pay, employment status, access,
--     discipline and statutory filing loops cannot, in any company, whatever is configured.
--  2. teras_loop_level_change: the append-only history of every level change, with who (or that it was automatic),
--     the limits and the evidence: the promotion certificate, or the corrections that triggered a demotion.
--  3. teras_loop_action: one row per automatic action the loop attempted on one of its cases, at most one per case:
--     applying, then applied (with the owner's own record of the change and the undo deadline) or not applied (with
--     the condition or owner refusal that stopped it). Written by the agent principal only; never deleted.
--  4. teras_loop_action_undo: the undo of an applied action, recorded as its own row with the owner's compensating
--     record: never a delete and never an edit of the action. At most one per action, only before its deadline, only
--     by a person who may administer the employment (HR, or the loop's sponsor acting on the employee's own request).
-- Who reads (FORCE row-level security on the four new tables):
--  - levels: everyone in the tenant (like the loop switches and pauses: a card of a company at Watch is not shown);
--  - level history: the agent principal and administrators of the company;
--  - actions and undos: the agent principal, administrators of the employment, and the employee their own.
-- Grants: every privilege a table must not have is revoked, not merely left ungranted. No model is called by any loop.
--
-- Writers reviewed before each constraint: core/loops/levels.ts is the only writer of teras_loop_level and
-- teras_loop_level_change (an administrator's change, and the agent's automatic demotion); core/loops/act.ts and
-- core/loops/act-clock-outs.ts of teras_loop_action; core/loops/undo.ts of teras_loop_action_undo. All four tables are
-- new. Nothing here changes a Phase 1 table, policy or function.

-- 1. Levels and limits.
CREATE TABLE public.teras_loop_level (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 worker_id text NOT NULL CHECK (worker_id ~ '^loop_[a-z0-9_]{1,60}$'),
 company_id uuid NOT NULL,
 level smallint NOT NULL CHECK (level BETWEEN 0 AND 3),
 max_actions_per_night integer NOT NULL DEFAULT 50 CHECK (max_actions_per_night BETWEEN 1 AND 200),
 undo_days smallint NOT NULL DEFAULT 3 CHECK (undo_days IN (3,7)),
 act_condition text NOT NULL DEFAULT 'roster_and_site_exit' CHECK (act_condition IN ('roster_and_site_exit','roster_end')),
 version integer NOT NULL DEFAULT 1 CHECK (version>=1),
 changed_by text NOT NULL CHECK (changed_by IN ('administrator','automatic')),
 changed_by_user_id uuid REFERENCES public.app_user(id),
 changed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,worker_id,company_id),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 CONSTRAINT teras_loop_level_cap CHECK (level<=1 OR worker_id IN ('loop_missed_clock_outs','loop_missing_employee_data')),
 CHECK ((changed_by='administrator')=(changed_by_user_id IS NOT NULL)),
 CHECK (changed_by<>'automatic' OR level=1)
);
--> statement-breakpoint
-- A loop moves itself only from above Prepare down to Prepare, with its limits unchanged; an administrator moves it up
-- one level at a time (the certificate is checked by core/loops/levels.ts in the same transaction). Identity is fixed.
CREATE FUNCTION app.teras_loop_level_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous smallint:=CASE WHEN TG_OP='UPDATE' THEN OLD.level ELSE 1 END;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.tenant_id,NEW.worker_id,NEW.company_id) IS DISTINCT FROM (OLD.tenant_id,OLD.worker_id,OLD.company_id) THEN
  RAISE EXCEPTION 'A loop level keeps its loop and company' USING ERRCODE='42501';
 END IF;
 IF NEW.changed_by='automatic' THEN
  IF TG_OP<>'UPDATE' OR OLD.level<=1 OR NEW.level<>1 OR NEW.max_actions_per_night<>OLD.max_actions_per_night
   OR NEW.undo_days<>OLD.undo_days OR NEW.act_condition<>OLD.act_condition THEN
   RAISE EXCEPTION 'A loop moves itself only down to Prepare' USING ERRCODE='42501';
  END IF;
 ELSIF NEW.level>previous+1 THEN
  RAISE EXCEPTION 'A loop moves up one level at a time' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_loop_level_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_loop_level_guard BEFORE INSERT OR UPDATE ON public.teras_loop_level
 FOR EACH ROW EXECUTE FUNCTION app.teras_loop_level_guard();
--> statement-breakpoint
CREATE TRIGGER teras_loop_level_version BEFORE UPDATE ON public.teras_loop_level
 FOR EACH ROW EXECUTE FUNCTION app.teras_bump_version('version');
--> statement-breakpoint
-- 2. Level history: append-only.
CREATE TABLE public.teras_loop_level_change (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 worker_id text NOT NULL CHECK (worker_id ~ '^loop_[a-z0-9_]{1,60}$'),
 company_id uuid NOT NULL,
 from_level smallint NOT NULL CHECK (from_level BETWEEN 0 AND 3),
 to_level smallint NOT NULL CHECK (to_level BETWEEN 0 AND 3),
 kind text NOT NULL CHECK (kind IN ('promoted','moved_down','demoted_auto')),
 changed_by text NOT NULL CHECK (changed_by IN ('administrator','automatic')),
 changed_by_user_id uuid REFERENCES public.app_user(id),
 run_id uuid,
 limits jsonb NOT NULL CHECK (jsonb_typeof(limits)='object' AND octet_length(limits::text)<=1024),
 evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=16384),
 changed_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 CHECK (from_level<>to_level),
 CHECK ((kind='promoted')=(to_level>from_level)),
 CHECK ((kind='demoted_auto')=(changed_by='automatic')),
 CHECK (kind<>'demoted_auto' OR (to_level=1 AND from_level>1 AND run_id IS NOT NULL)),
 CHECK ((changed_by='administrator')=(changed_by_user_id IS NOT NULL)),
 CONSTRAINT teras_loop_level_change_cap CHECK (to_level<=1 OR worker_id IN ('loop_missed_clock_outs','loop_missing_employee_data'))
);
--> statement-breakpoint
CREATE INDEX teras_loop_level_change_latest_idx ON public.teras_loop_level_change(tenant_id,worker_id,company_id,changed_at DESC);
--> statement-breakpoint
CREATE TRIGGER teras_loop_level_change_append_only BEFORE UPDATE OR DELETE ON public.teras_loop_level_change
 FOR EACH ROW EXECUTE FUNCTION app.teras_outcome_append_only();
--> statement-breakpoint
-- 3. Automatic actions. owner_ref is the owner's own record of the change (for missed clock-outs, the approved
--    attendance correction). facts holds dates, clock times and keys only, never a name, number or free text.
CREATE TABLE public.teras_loop_action (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 worker_id text NOT NULL CHECK (worker_id IN ('loop_missed_clock_outs','loop_missing_employee_data')),
 company_id uuid NOT NULL,
 case_id uuid NOT NULL REFERENCES public.teras_loop_case(id) ON DELETE CASCADE,
 employment_id uuid NOT NULL REFERENCES public.employment(id) ON DELETE CASCADE,
 run_id uuid NOT NULL,
 level smallint NOT NULL CHECK (level IN (2,3)),
 state text NOT NULL CHECK (state IN ('applying','applied','not_applied')),
 reason text CHECK (reason ~ '^[a-z_]{1,40}$'),
 rule_version text NOT NULL CHECK (rule_version ~ '^[a-z0-9_.:@-]{1,80}$'),
 sponsor_user_id uuid NOT NULL REFERENCES public.app_user(id),
 checks jsonb NOT NULL CHECK (jsonb_typeof(checks)='array' AND octet_length(checks::text)<=8192),
 facts jsonb NOT NULL CHECK (jsonb_typeof(facts)='object' AND octet_length(facts::text)<=4096),
 owner_ref uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 applied_at timestamptz,
 undo_until timestamptz NOT NULL,
 people_changed_at timestamptz,
 UNIQUE (tenant_id,case_id),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 CHECK ((state='not_applied')=(reason IS NOT NULL)),
 CHECK ((state='applied')=(owner_ref IS NOT NULL)),
 CHECK ((state='applied')=(applied_at IS NOT NULL)),
 CHECK (people_changed_at IS NULL OR state='applied'),
 CHECK (undo_until>created_at)
);
--> statement-breakpoint
CREATE INDEX teras_loop_action_company_idx ON public.teras_loop_action(tenant_id,worker_id,company_id,created_at DESC);
--> statement-breakpoint
CREATE INDEX teras_loop_action_employment_idx ON public.teras_loop_action(tenant_id,employment_id);
--> statement-breakpoint
-- An action moves applying -> applied or not_applied once; an applied action may only be marked, once, as changed by
-- a person afterwards. Nothing else about an action ever changes.
CREATE FUNCTION app.teras_loop_action_guard() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF (NEW.id,NEW.tenant_id,NEW.worker_id,NEW.company_id,NEW.case_id,NEW.employment_id,NEW.run_id,NEW.level,NEW.rule_version,
  NEW.sponsor_user_id,NEW.created_at,NEW.undo_until) IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.worker_id,OLD.company_id,OLD.case_id,
  OLD.employment_id,OLD.run_id,OLD.level,OLD.rule_version,OLD.sponsor_user_id,OLD.created_at,OLD.undo_until) THEN
  RAISE EXCEPTION 'A loop action keeps its identity' USING ERRCODE='42501';
 END IF;
 IF OLD.state='applying' AND NEW.state IN ('applied','not_applied') AND NEW.people_changed_at IS NULL THEN RETURN NEW; END IF;
 IF OLD.state='applied' AND NEW.state='applied' AND OLD.people_changed_at IS NULL AND NEW.people_changed_at IS NOT NULL
  AND NEW.owner_ref=OLD.owner_ref AND NEW.applied_at=OLD.applied_at AND NEW.checks=OLD.checks THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'A loop action moves forward once' USING ERRCODE='42501';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_loop_action_guard() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_loop_action_guard BEFORE UPDATE ON public.teras_loop_action
 FOR EACH ROW EXECUTE FUNCTION app.teras_loop_action_guard();
--> statement-breakpoint
CREATE TRIGGER teras_loop_action_no_delete BEFORE DELETE ON public.teras_loop_action
 FOR EACH ROW EXECUTE FUNCTION app.teras_outcome_append_only();
--> statement-breakpoint
-- 4. Undo: its own append-only row, linked to the owner's compensating record.
CREATE TABLE public.teras_loop_action_undo (
 action_id uuid PRIMARY KEY REFERENCES public.teras_loop_action(id) ON DELETE CASCADE,
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 undone_by text NOT NULL CHECK (undone_by IN ('employee','hr')),
 undone_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 compensation_ref uuid NOT NULL,
 undone_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TRIGGER teras_loop_action_undo_append_only BEFORE UPDATE OR DELETE ON public.teras_loop_action_undo
 FOR EACH ROW EXECUTE FUNCTION app.teras_outcome_append_only();
--> statement-breakpoint
-- A loop's level for a company now; no row is Prepare. Invoker rights: levels are readable in the tenant.
CREATE FUNCTION app.teras_loop_level_of(p_worker text,p_company uuid) RETURNS smallint
 LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT l.level FROM public.teras_loop_level l WHERE l.tenant_id=app.current_tenant_id()
  AND l.worker_id=p_worker AND l.company_id=p_company),1::smallint)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_loop_level_of(text,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.teras_loop_level_of(text,uuid) TO ai_hr_app;
--> statement-breakpoint
-- ── RLS: forced on every new table ──
ALTER TABLE public.teras_loop_level ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_loop_level FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_loop_level_change ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_loop_level_change FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_loop_action ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_loop_action FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_loop_action_undo ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_loop_action_undo FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Levels: readable in the tenant; an administrator change only by a group administrator under their own current login,
-- attributed to them; the agent principal only lowers a level above Prepare back to Prepare.
CREATE POLICY teras_loop_level_read ON public.teras_loop_level FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id());
--> statement-breakpoint
CREATE POLICY teras_loop_level_admin_insert ON public.teras_loop_level FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.is_group_admin()
  AND app.principal_snapshot_current() IS TRUE AND changed_by='administrator' AND changed_by_user_id=app.current_user_id());
--> statement-breakpoint
CREATE POLICY teras_loop_level_admin_update ON public.teras_loop_level FOR UPDATE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.is_group_admin() AND app.principal_snapshot_current() IS TRUE)
 WITH CHECK (tenant_id=app.current_tenant_id() AND changed_by='administrator' AND changed_by_user_id=app.current_user_id());
--> statement-breakpoint
CREATE POLICY teras_loop_level_agent_demote ON public.teras_loop_level FOR UPDATE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL AND level>1)
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL AND changed_by='automatic'
  AND changed_by_user_id IS NULL AND level=1);
--> statement-breakpoint
-- Level history: administrators of the company and the agent read it; each writer appends only its own kind.
CREATE POLICY teras_loop_level_change_agent_read ON public.teras_loop_level_change FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY teras_loop_level_change_admin_read ON public.teras_loop_level_change FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.current_user_id() IS NOT NULL
  AND app.is_admin_for(company_id));
--> statement-breakpoint
CREATE POLICY teras_loop_level_change_admin_insert ON public.teras_loop_level_change FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.is_group_admin()
  AND app.principal_snapshot_current() IS TRUE AND kind IN ('promoted','moved_down') AND changed_by='administrator'
  AND changed_by_user_id=app.current_user_id());
--> statement-breakpoint
CREATE POLICY teras_loop_level_change_agent_insert ON public.teras_loop_level_change FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL AND kind='demoted_auto'
  AND changed_by='automatic' AND changed_by_user_id IS NULL);
--> statement-breakpoint
-- Actions: the agent principal records them, only while the loop may write for the company (switched on, not
-- stopped, not paused) and the company is above Prepare, for its own case; it records the outcome afterwards.
CREATE POLICY teras_loop_action_agent_read ON public.teras_loop_action FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY teras_loop_action_agent_insert ON public.teras_loop_action FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL
  AND app.teras_loop_may_write(worker_id,company_id) IS TRUE AND app.teras_loop_level_of(worker_id,company_id)>=2
  AND level=app.teras_loop_level_of(worker_id,company_id)
  AND EXISTS (SELECT 1 FROM public.teras_loop_case c WHERE c.id=teras_loop_action.case_id AND c.tenant_id=app.current_tenant_id()
   AND c.worker_id=teras_loop_action.worker_id AND c.company_id=teras_loop_action.company_id AND c.employment_id=teras_loop_action.employment_id));
--> statement-breakpoint
CREATE POLICY teras_loop_action_agent_update ON public.teras_loop_action FOR UPDATE TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL)
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY teras_loop_action_admin_read ON public.teras_loop_action FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.current_user_id() IS NOT NULL
  AND app.can_admin_employment(employment_id));
--> statement-breakpoint
CREATE POLICY teras_loop_action_own_read ON public.teras_loop_action FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.current_user_id() IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.employment e WHERE e.id=teras_loop_action.employment_id AND e.tenant_id=app.current_tenant_id()
   AND app.is_self_person(e.person_id)));
--> statement-breakpoint
-- Undo: readable by whoever may read the action. Written by a person under their own current login who administers
-- the employment, only for an applied action before its deadline: HR in their own name, or (the employee's own undo)
-- the loop's sponsor's authority recording the employee who asked, whose login must be the employment's person.
CREATE POLICY teras_loop_action_undo_read ON public.teras_loop_action_undo FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND EXISTS (SELECT 1 FROM public.teras_loop_action a WHERE a.id=teras_loop_action_undo.action_id));
--> statement-breakpoint
CREATE POLICY teras_loop_action_undo_insert ON public.teras_loop_action_undo FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.current_user_id() IS NOT NULL
  AND app.principal_snapshot_current() IS TRUE
  AND EXISTS (SELECT 1 FROM public.teras_loop_action a WHERE a.id=teras_loop_action_undo.action_id AND a.tenant_id=app.current_tenant_id()
   AND a.state='applied' AND now()<=a.undo_until AND app.can_admin_employment(a.employment_id)
   AND ((teras_loop_action_undo.undone_by='hr' AND teras_loop_action_undo.undone_by_user_id=app.current_user_id())
    OR (teras_loop_action_undo.undone_by='employee' AND EXISTS (SELECT 1 FROM app.principal(teras_loop_action_undo.undone_by_user_id) p
     JOIN public.employment e ON e.person_id=p.person_id WHERE e.id=a.employment_id AND p.tenant_id=app.current_tenant_id())))));
--> statement-breakpoint
-- ── Grants: exactly what each table needs, everything else revoked ──
REVOKE ALL ON public.teras_loop_level,public.teras_loop_level_change,public.teras_loop_action,public.teras_loop_action_undo FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT,UPDATE ON public.teras_loop_level,public.teras_loop_action TO ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON public.teras_loop_level_change,public.teras_loop_action_undo TO ai_hr_app;
