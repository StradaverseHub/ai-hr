-- AI v2 Phase 2, P2-4: the HR capacity ledger's baseline (owner-approved plan and Ledger mock-up, 3 November 2026).
-- Provisional DEVELOPMENT source allocation 0966 / when1793330000366 (docs/MIGRATION-ALLOCATION.md, reserved for P2-4 by
-- the AI v2 coordinator). It grants no installation, and the journal position is re-frozen at integration.
--
-- WHY A TABLE. The ledger reports HR time freed as work done x the company's OWN manual time per item, measured before
-- Autopilot started, minus the time people spent reviewing. Staff minutes are recorded nowhere in the event log
-- (core/process-assessment.ts), so the baseline is part measurement (the event log's cases and staff actions per case in
-- the baseline period) and part an administrator's own minutes. Both, and the period they describe, must be recorded
-- once, attributed, and kept as history: a ledger figure has to stay explicable by the baseline in force when it was
-- read. No existing store fits: tenant_setting is tenant-wide and written only by a group administrator, while a
-- baseline is per company and set by that company's HR administrators.
--
-- teras_capacity_baseline: one APPEND-ONLY row per baseline a company's administrator sets. The current baseline is the
-- company's highest version; earlier versions are kept, never changed or deleted. It holds dates, minutes, counts and
-- closed-vocabulary item keys only: no name, no amount, no free text.
--  - period_from / period_to: the baseline period (calendar days in Malaysia, period_to exclusive), ending when Autopilot
--    started for the company (its first loop card), or on the day it was set if no loop has started there.
--  - minutes_per_staff_action: the administrator's minutes for one staff action, used with the event log's measure.
--  - items: {<item key>: {minutes, basis: event_log|entered, process?, cases?, completed?, staffActions?}}; validated by
--    core/capacity/baseline.ts, bounded here in shape and size.
-- Who reads and writes (FORCE row-level security):
--  - administrators of the company (app.is_admin_for), under their own current login; group administrators therefore
--    see every company. Nobody else, and never an agent principal.
--  - insert only, attributed to the writer (set_by_user_id = the current user). No update, no delete: a trigger refuses
--    both, and neither is granted.
--
-- Writers reviewed: the table is new; core/capacity/baseline.ts setCapacityBaseline is its only writer.

CREATE TABLE public.teras_capacity_baseline (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 company_id uuid NOT NULL,
 version integer NOT NULL CHECK (version>=1),
 period_from date NOT NULL,
 period_to date NOT NULL,
 minutes_per_staff_action numeric(6,1) CHECK (minutes_per_staff_action IS NULL OR (minutes_per_staff_action>=0 AND minutes_per_staff_action<=240)),
 items jsonb NOT NULL CHECK (jsonb_typeof(items)='object' AND items<>'{}'::jsonb AND octet_length(items::text)<=4096),
 set_by_user_id uuid NOT NULL REFERENCES public.app_user(id),
 set_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id,company_id,version),
 FOREIGN KEY (company_id,tenant_id) REFERENCES public.company(id,tenant_id),
 CHECK (period_to>period_from AND period_to-period_from<=366)
);
--> statement-breakpoint
CREATE FUNCTION app.teras_capacity_baseline_append_only() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'A capacity baseline is append-only' USING ERRCODE='42501'; END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.teras_capacity_baseline_append_only() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER teras_capacity_baseline_append_only BEFORE UPDATE OR DELETE ON public.teras_capacity_baseline
 FOR EACH ROW EXECUTE FUNCTION app.teras_capacity_baseline_append_only();
--> statement-breakpoint
-- ── RLS: forced ──
ALTER TABLE public.teras_capacity_baseline ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.teras_capacity_baseline FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY teras_capacity_baseline_admin_read ON public.teras_capacity_baseline FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.current_user_id() IS NOT NULL
  AND app.is_admin_for(company_id));
--> statement-breakpoint
CREATE POLICY teras_capacity_baseline_admin_insert ON public.teras_capacity_baseline FOR INSERT TO ai_hr_app
 WITH CHECK (tenant_id=app.current_tenant_id() AND app.current_agent_principal() IS NULL AND app.principal_snapshot_current() IS TRUE
  AND app.is_admin_for(company_id) AND set_by_user_id=app.current_user_id());
--> statement-breakpoint
-- ── Grants: read and insert only; everything else revoked ──
REVOKE ALL ON public.teras_capacity_baseline FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON public.teras_capacity_baseline TO ai_hr_app;
