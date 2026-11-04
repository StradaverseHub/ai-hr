-- Payroll history learning, phase P1 (4 November 2026; design RESUME/research/payroll-history-learning-design-20261104.md).
-- Source allocation 2012 / when1793330001412 / idx812 in the AI Centre block 2000-2019 (docs/MIGRATION-ALLOCATION.md), the
-- next number after 2011. It grants no installation. Production is held.
--
-- Owner rules: nothing learned does money maths through a model (the service computes deterministic statistics in integer
-- sen; a model only ever words bands); learning never changes calculation code, permissions or disclosure rules; nothing
-- crosses tenants; every applied change is a person's, versioned and reversible; a block is never downgraded. Owner decisions
-- of 4 November 2026: evidence lines from 3 clean closed runs, a learned "normal" may hide a flag only from a stable baseline
-- of 6 or more (phase P4, not here), and a leaver's learned baseline is deleted 3 months after their final pay closes
-- (payslips are unaffected).
--
--  1. payroll_learning_mode: the company's learning mode, off (the default: no row), evidence (evidence lines) or classify
--     (phase P4, reached only by an approved proposal, which phase P3 adds: no writer may set it here). One APPEND-ONLY row per
--     change; the company's mode is its highest version, so every change is kept and is undone by setting the earlier mode
--     again. Set by a payroll administrator of the company, attributed to them; the tenant's agent principal reads it (the
--     payroll tick decides which companies to learn for, and the administrator who set the mode sponsors that learning).
--  2. payroll_learned_baseline: one APPEND-ONLY row per employment, basis (regular, month_total, bonus), as-of month and
--     version. A row is built ONLY from the person's effective payslips of CLOSED runs of months before as_of_period (no
--     look-ahead), with the excluded months left out (core/payroll-learning/history.ts), and holds integer-sen statistics
--     per pay line and pay item (core/payroll-learning/baseline-math.ts): n, median, P10, P90, the non-zero count, a month
--     mask and a fixed flag, plus the status (none, provisional, stable, rebasing, contradicted). A new version is appended
--     only when the result changes. Read by payroll administrators of the company only, under their own current login:
--     NEVER by the agent principal and never by the person. Written only under the authority of the payroll administrator
--     who switched learning on for the company (the sponsor), re-read from the database at every run, while the company's
--     mode is not off. Removed only by: the employment's own deletion (cascade); person erasure
--     (app.payroll_learned_baseline_redact, under the admitted, audited erasure of core/pdpa.ts); and the leaver retention
--     purge (app.payroll_learned_baseline_purge: 3 months after the leaver's final pay closed, payslips untouched).
--  3. payroll_learning_run: one APPEND-ONLY row per company and learning run (the 15-minute payroll tick after a run was
--     closed, unlocked or reset or a payroll-history import was confirmed or reverted, and the nightly sweep as the backstop):
--     its status, sponsor, as-of month and counts only (people, rows appended, each status, rows purged). Written by the
--     agent principal; read by it (the tick's "changed since the last run" check) and by payroll administrators.
-- Who reads and writes (FORCE row-level security on all three tables; every privilege a table must not have is revoked):
--  - modes: payroll administrators of the company read and append; the agent principal reads.
--  - baselines: payroll administrators of the company read; the sponsor appends; the table owner deletes only inside the two
--    SECURITY DEFINER functions below (no application DELETE privilege, no UPDATE at all).
--  - runs: the agent principal reads and appends; payroll administrators of the company read.
--
-- Writers reviewed before each constraint: the three tables are new. core/payroll-learning/mode.ts setPayrollLearningMode is
-- the only writer of payroll_learning_mode; core/payroll-learning/recompute.ts is the only writer of payroll_learned_baseline
-- and payroll_learning_run; core/pdpa.ts and core/payroll-learning/recompute.ts are the only callers of the two deleting
-- functions.

-- 1. The company's learning mode.
CREATE TABLE public.payroll_learning_mode (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 version integer NOT NULL CHECK (version>=1),
 mode text NOT NULL CHECK (mode IN ('off','evidence','classify')),
 source text NOT NULL DEFAULT 'admin' CHECK (source IN ('admin','proposal')),
 set_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 set_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 UNIQUE (tenant_id,company_id,version),
 -- Classification (P4) is reached only through an approved proposal (P3), never set directly.
 CHECK (mode<>'classify' OR source='proposal')
);
--> statement-breakpoint
CREATE INDEX payroll_learning_mode_company_idx ON public.payroll_learning_mode(tenant_id,company_id,version DESC);
--> statement-breakpoint
-- The version is the company's next number, under a per-company lock; the writer's own read decides it (invoker rights).
CREATE FUNCTION app.payroll_learning_mode_stamp() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('payroll-learning-mode:'||NEW.tenant_id::text||':'||NEW.company_id::text,0));
 NEW.version:=coalesce((SELECT max(m.version) FROM public.payroll_learning_mode m WHERE m.tenant_id=NEW.tenant_id AND m.company_id=NEW.company_id),0)+1;
 NEW.set_at:=now();
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_learning_mode_stamp() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER payroll_learning_mode_stamp BEFORE INSERT ON public.payroll_learning_mode
 FOR EACH ROW EXECUTE FUNCTION app.payroll_learning_mode_stamp();
--> statement-breakpoint
CREATE TRIGGER payroll_learning_mode_append_only BEFORE UPDATE OR DELETE ON public.payroll_learning_mode
 FOR EACH ROW EXECUTE FUNCTION app.teras_outcome_append_only();
--> statement-breakpoint
-- The company's mode as the caller may read it (invoker rights): its highest version, or off.
CREATE FUNCTION app.payroll_learning_mode_of(p_company uuid) RETURNS text
 LANGUAGE sql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT coalesce((SELECT m.mode FROM public.payroll_learning_mode m WHERE m.tenant_id=app.current_tenant_id() AND m.company_id=p_company
  ORDER BY m.version DESC LIMIT 1),'off')
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_learning_mode_of(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_learning_mode_of(uuid) TO ai_hr_app;
--> statement-breakpoint
-- 2. The learned baselines.
CREATE TABLE public.payroll_learned_baseline (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 employment_id uuid NOT NULL REFERENCES public.employment(id) ON DELETE CASCADE,
 basis text NOT NULL CHECK (basis IN ('regular','month_total','bonus')),
 as_of_period text NOT NULL CHECK (as_of_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 version integer NOT NULL CHECK (version>=1),
 status text NOT NULL CHECK (status IN ('none','provisional','stable','rebasing','contradicted')),
 runs integer NOT NULL CHECK (runs BETWEEN 0 AND 60),
 excluded integer NOT NULL CHECK (excluded BETWEEN 0 AND 60),
 through_period text CHECK (through_period IS NULL OR (through_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND through_period<as_of_period)),
 components jsonb NOT NULL CHECK (jsonb_typeof(components)='object' AND octet_length(components::text)<=16384),
 input_digest text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
 method text NOT NULL CHECK (method ~ '^[a-z_]{1,40}@v[0-9]{1,4}$'),
 sponsor_user_id uuid NOT NULL REFERENCES public.app_user(id),
 computed_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 UNIQUE (tenant_id,employment_id,basis,version),
 CHECK ((runs=0)=(through_period IS NULL)),
 -- The status follows the clean closed runs it rests on: fewer than 3 is none (or rebasing after a salary change), 3 to 5
 -- provisional, 6 or more stable; contradicted needs 5 (3 before the two latest).
 CHECK (CASE status WHEN 'none' THEN runs<3 WHEN 'rebasing' THEN runs<3 WHEN 'provisional' THEN runs BETWEEN 3 AND 5
  WHEN 'stable' THEN runs>=6 ELSE runs>=5 END)
);
--> statement-breakpoint
CREATE INDEX payroll_learned_baseline_company_idx ON public.payroll_learned_baseline(tenant_id,company_id,as_of_period,employment_id,basis,version DESC);
--> statement-breakpoint
CREATE INDEX payroll_learned_baseline_employment_idx ON public.payroll_learned_baseline(tenant_id,employment_id);
--> statement-breakpoint
-- The employment belongs to the row's company and tenant (definer rights: an identity check that returns a boolean only).
CREATE FUNCTION app._payroll_learned_baseline_identity(p_tenant uuid,p_company uuid,p_employment uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=p_tenant AND e.company_id=p_company)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._payroll_learned_baseline_identity(uuid,uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
-- EXECUTE because the stamp trigger below runs with the writer's rights.
GRANT EXECUTE ON FUNCTION app._payroll_learned_baseline_identity(uuid,uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
-- The version is the employment and basis's next number, under a per-employment lock; the writer's own read decides it.
CREATE FUNCTION app.payroll_learned_baseline_stamp() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
 IF app._payroll_learned_baseline_identity(NEW.tenant_id,NEW.company_id,NEW.employment_id) IS NOT TRUE THEN
  RAISE EXCEPTION 'A learned baseline names an employment of another company' USING ERRCODE='42501';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('payroll-learned-baseline:'||NEW.tenant_id::text||':'||NEW.employment_id::text||':'||NEW.basis,0));
 NEW.version:=coalesce((SELECT max(b.version) FROM public.payroll_learned_baseline b
  WHERE b.tenant_id=NEW.tenant_id AND b.employment_id=NEW.employment_id AND b.basis=NEW.basis),0)+1;
 NEW.computed_at:=now();
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_learned_baseline_stamp() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER payroll_learned_baseline_stamp BEFORE INSERT ON public.payroll_learned_baseline
 FOR EACH ROW EXECUTE FUNCTION app.payroll_learned_baseline_stamp();
--> statement-breakpoint
-- Never rewritten. A row leaves only by its employment's cascade or the two deleting functions below (the application holds
-- no DELETE privilege, and their policies admit the table owner only).
CREATE TRIGGER payroll_learned_baseline_append_only BEFORE UPDATE ON public.payroll_learned_baseline
 FOR EACH ROW EXECUTE FUNCTION app.teras_outcome_append_only();
--> statement-breakpoint
-- A leaver whose learned baseline is due to go: their employment ended, no run with a payslip of theirs is still open, and
-- their final pay (the latest closed run with an effective payslip of theirs) closed 3 months ago or more. Payslips are
-- never touched. Definer rights: a boolean about one employment of the caller's tenant only.
CREATE FUNCTION app._payroll_learning_leaver_due(p_employment uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id()
   AND e.terminated_on IS NOT NULL AND e.terminated_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
  AND NOT EXISTS(SELECT 1 FROM public.payslip s JOIN public.payroll_batch b ON b.id=s.batch_id AND b.tenant_id=s.tenant_id
   WHERE s.employment_id=p_employment AND s.tenant_id=app.current_tenant_id() AND b.status<>'closed')
  AND coalesce((SELECT max(coalesce(b.closed_at,b.created_at)) FROM public.payslip s JOIN public.payroll_batch b ON b.id=s.batch_id AND b.tenant_id=s.tenant_id
   WHERE s.employment_id=p_employment AND s.tenant_id=app.current_tenant_id() AND b.status='closed' AND app.payroll_history_effective(s.id)),
   '-infinity'::timestamptz)+interval '3 months'<=now()
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._payroll_learning_leaver_due(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app._payroll_learning_leaver_due(uuid) TO ai_hr_app;
--> statement-breakpoint
-- Person erasure: the admitted, audited erasure of this transaction (core/pdpa.ts records the intent before this runs) names
-- the person; every employment of theirs goes. Answers only for the caller's own transaction.
CREATE FUNCTION app._payroll_learned_baseline_erasure_subject(p_tenant uuid,p_employment uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM app.assistant_review_erasure_intent i
  WHERE i.xact_id=pg_current_xact_id() AND i.tenant_id=p_tenant AND i.user_id=app.current_user_id()
   AND (i.employment_id=p_employment OR EXISTS(SELECT 1 FROM public.employment e WHERE e.id=p_employment AND e.tenant_id=p_tenant AND e.person_id=i.person_id)))
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app._payroll_learned_baseline_erasure_subject(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
-- EXECUTE only so an application query's policy check can be planned; the policies below also require the table owner.
GRANT EXECUTE ON FUNCTION app._payroll_learned_baseline_erasure_subject(uuid,uuid) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.payroll_learned_baseline_redact(subject_employment uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE i app.assistant_review_erasure_intent%ROWTYPE;n integer;
BEGIN
 SELECT * INTO i FROM app.assistant_review_erasure_intent WHERE xact_id=pg_current_xact_id() AND tenant_id=app.current_tenant_id()
  AND user_id=app.current_user_id() AND employment_id=subject_employment;
 IF NOT FOUND OR app.principal_snapshot_current() IS NOT TRUE OR app.can_admin_employment(subject_employment) IS NOT TRUE THEN
  RAISE EXCEPTION 'Learned baseline erasure admission unavailable' USING ERRCODE='42501';END IF;
 DELETE FROM public.payroll_learned_baseline b WHERE b.tenant_id=i.tenant_id AND app._payroll_learned_baseline_erasure_subject(b.tenant_id,b.employment_id);
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_learned_baseline_redact(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_learned_baseline_redact(uuid) TO ai_hr_app;
--> statement-breakpoint
-- The leaver retention purge for one company of the caller's tenant: the agent principal (the tick and the nightly sweep) or
-- a payroll administrator of the company. It deletes only the baselines of leavers who are due (above); idempotent. The
-- transaction-local marker scopes the owner's delete policy to this tenant and company.
CREATE FUNCTION app.payroll_learned_baseline_purge(p_company uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();n integer;
BEGIN
 IF t IS NULL OR NOT EXISTS(SELECT 1 FROM public.company c WHERE c.id=p_company AND c.tenant_id=t)
  OR NOT (app.current_agent_principal() IS NOT NULL
   OR (app.current_user_id() IS NOT NULL AND app.principal_snapshot_current() IS TRUE AND app.can_admin_payroll_for(p_company) IS TRUE)) THEN
  RAISE EXCEPTION 'Learned baseline retention unavailable' USING ERRCODE='42501';END IF;
 PERFORM set_config('app.payroll_learning_purge',t::text||':'||p_company::text,true);
 DELETE FROM public.payroll_learned_baseline b WHERE b.tenant_id=t AND b.company_id=p_company AND app._payroll_learning_leaver_due(b.employment_id) IS TRUE;
 GET DIAGNOSTICS n=ROW_COUNT;
 PERFORM set_config('app.payroll_learning_purge','',true);
 RETURN n;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.payroll_learned_baseline_purge(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.payroll_learned_baseline_purge(uuid) TO ai_hr_app;
--> statement-breakpoint
-- 3. The learning runs.
CREATE TABLE public.payroll_learning_run (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 run_id uuid NOT NULL,
 run_trigger text NOT NULL CHECK (run_trigger IN ('tick','sweep')),
 status text NOT NULL CHECK (status IN ('ran','sponsor_lost','failed')),
 as_of_period text CHECK (as_of_period IS NULL OR as_of_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
 sponsor_user_id uuid REFERENCES public.app_user(id),
 agent_principal_id uuid NOT NULL,
 method text NOT NULL CHECK (method ~ '^[a-z_]{1,40}@v[0-9]{1,4}$'),
 counts jsonb NOT NULL CHECK (jsonb_typeof(counts)='object' AND octet_length(counts::text)<=1024),
 started_at timestamptz NOT NULL,
 finished_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 UNIQUE (tenant_id,run_id,company_id),
 CHECK (finished_at>=started_at)
);
--> statement-breakpoint
CREATE INDEX payroll_learning_run_company_idx ON public.payroll_learning_run(tenant_id,company_id,started_at DESC);
--> statement-breakpoint
CREATE TRIGGER payroll_learning_run_append_only BEFORE UPDATE OR DELETE ON public.payroll_learning_run
 FOR EACH ROW EXECUTE FUNCTION app.teras_outcome_append_only();
--> statement-breakpoint
-- ── RLS: forced on every table ──
ALTER TABLE public.payroll_learning_mode ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_learning_mode FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_learned_baseline ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_learned_baseline FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_learning_run ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.payroll_learning_run FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Modes: payroll administrators of the company, under their own current login; and the tenant's agent principal.
CREATE POLICY payroll_learning_mode_read ON public.payroll_learning_mode FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.current_user_id() IS NOT NULL
  AND app.can_admin_payroll_for(company_id) IS TRUE);
--> statement-breakpoint
CREATE POLICY payroll_learning_mode_agent_read ON public.payroll_learning_mode FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL);
--> statement-breakpoint
-- An administrator sets off or evidence directly, as themself; classify only ever comes from an approved proposal (P3).
CREATE POLICY payroll_learning_mode_insert ON public.payroll_learning_mode FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.can_admin_payroll_for(company_id) IS TRUE AND set_by_user_id=app.current_user_id() AND source='admin' AND mode IN ('off','evidence'));
--> statement-breakpoint
-- Baselines: payroll administrators of the company only. Never the agent principal, never the person (unless they are a
-- payroll administrator of the company, who reads payslips anyway).
CREATE POLICY payroll_learned_baseline_read ON public.payroll_learned_baseline FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.current_user_id() IS NOT NULL
  AND app.principal_snapshot_current() IS TRUE AND app.can_admin_payroll_for(company_id) IS TRUE);
--> statement-breakpoint
-- The sponsor appends, as themself, while learning is on for the company, and never for a leaver who is due to go.
CREATE POLICY payroll_learned_baseline_insert ON public.payroll_learned_baseline FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.can_admin_payroll_for(company_id) IS TRUE AND sponsor_user_id=app.current_user_id()
  AND app.payroll_learning_mode_of(company_id) IN ('evidence','classify') AND app._payroll_learning_leaver_due(employment_id) IS NOT TRUE);
--> statement-breakpoint
-- Person erasure: only the table owner as current user (app.payroll_learned_baseline_redact), only the admitted subject.
CREATE POLICY payroll_learned_baseline_erasure_read ON public.payroll_learned_baseline FOR SELECT TO PUBLIC
 USING (current_user<>'ai_hr_app'
  AND current_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.payroll_learned_baseline'::regclass))
  AND app._payroll_learned_baseline_erasure_subject(tenant_id,employment_id));
--> statement-breakpoint
CREATE POLICY payroll_learned_baseline_erasure_delete ON public.payroll_learned_baseline FOR DELETE TO PUBLIC
 USING (current_user<>'ai_hr_app'
  AND current_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.payroll_learned_baseline'::regclass))
  AND app._payroll_learned_baseline_erasure_subject(tenant_id,employment_id));
--> statement-breakpoint
-- Leaver retention: only the table owner as current user (app.payroll_learned_baseline_purge), only the tenant and company
-- this transaction's purge names, only leavers who are due.
CREATE POLICY payroll_learned_baseline_purge_read ON public.payroll_learned_baseline FOR SELECT TO PUBLIC
 USING (current_user<>'ai_hr_app'
  AND current_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.payroll_learned_baseline'::regclass))
  AND tenant_id::text||':'||company_id::text=current_setting('app.payroll_learning_purge',true)
  AND app._payroll_learning_leaver_due(employment_id) IS TRUE);
--> statement-breakpoint
CREATE POLICY payroll_learned_baseline_purge_delete ON public.payroll_learned_baseline FOR DELETE TO PUBLIC
 USING (current_user<>'ai_hr_app'
  AND current_user=pg_catalog.pg_get_userbyid((SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid='public.payroll_learned_baseline'::regclass))
  AND tenant_id::text||':'||company_id::text=current_setting('app.payroll_learning_purge',true)
  AND app._payroll_learning_leaver_due(employment_id) IS TRUE);
--> statement-breakpoint
-- Runs: the agent principal appends and reads; payroll administrators of the company read.
CREATE POLICY payroll_learning_run_agent_read ON public.payroll_learning_run FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NOT NULL);
--> statement-breakpoint
CREATE POLICY payroll_learning_run_agent_insert ON public.payroll_learning_run FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND agent_principal_id=app.current_agent_principal());
--> statement-breakpoint
CREATE POLICY payroll_learning_run_read ON public.payroll_learning_run FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.current_user_id() IS NOT NULL
  AND app.can_admin_payroll_for(company_id) IS TRUE);
--> statement-breakpoint
-- ── Grants: read and append only; everything else revoked ──
REVOKE ALL ON public.payroll_learning_mode,public.payroll_learned_baseline,public.payroll_learning_run FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON public.payroll_learning_mode,public.payroll_learned_baseline,public.payroll_learning_run TO ai_hr_app;
