-- UNALLOCATED DRAFT on branch claude/bulkjob-payroll-20261110 (payroll wizard runs as background processing jobs):
-- not a reservation, not an installation allocation. The journal position (idx 9952, when 1793330099952) exists
-- only so this branch's schema is executable and reviewable; the integration owner assigns the final tag/idx/when
-- after the freshly verified ledger, per docs/MIGRATION-ALLOCATION.md.
--
-- The Payroll Process wizard's terminal actions (a resumed draft, and the run of one, several or all companies)
-- used to generate every run synchronously inside the request and carry the finished outcomes on the redirect.
-- Each company's run is now a payroll_process bulk job (9951), so the outcomes exist only when the jobs finish.
-- This row is the run group the result screen reads while they run: who started it, the month, every company's
-- outcome (a finished one, or the processing job it waits for) and, once every job has finished, the result and
-- the run-group audit event. Only its creator reads or changes it, while their captured grants stay current.
CREATE TABLE payroll_run_group (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenant(id),
 created_by uuid NOT NULL REFERENCES app_user(id),
 -- 'run': the multi-company run (records payroll-run-group.completed); 'resume': one resumed draft (no event).
 kind text NOT NULL CHECK(kind IN ('run','resume')),
 pay_period text NOT NULL CHECK(pay_period ~ '^\d{4}-\d{2}$'),
 started_at timestamptz NOT NULL,
 company_ids uuid[] NOT NULL DEFAULT '{}',
 outcomes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(outcomes)='array'),
 -- Every company's outcome is recorded (no further job will join the group).
 sealed_at timestamptz,
 ended_at timestamptz,
 result jsonb,
 event_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((result IS NULL)=(ended_at IS NULL)),
 CHECK(ended_at IS NULL OR sealed_at IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX payroll_run_group_creator ON payroll_run_group(tenant_id, created_by, created_at DESC);
--> statement-breakpoint
-- A finishing processing job finds the open groups that wait for it.
CREATE INDEX payroll_run_group_open ON payroll_run_group USING gin(outcomes jsonb_path_ops) WHERE ended_at IS NULL;
--> statement-breakpoint
GRANT SELECT,INSERT ON payroll_run_group TO ai_hr_app;
--> statement-breakpoint
GRANT UPDATE(outcomes,sealed_at,ended_at,result,event_id) ON payroll_run_group TO ai_hr_app;
--> statement-breakpoint
ALTER TABLE payroll_run_group ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY payroll_run_group_read ON payroll_run_group FOR SELECT
 USING(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.principal_snapshot_current());
--> statement-breakpoint
CREATE POLICY payroll_run_group_insert ON payroll_run_group FOR INSERT
 WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.principal_snapshot_current());
--> statement-breakpoint
CREATE POLICY payroll_run_group_update ON payroll_run_group FOR UPDATE
 USING(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.principal_snapshot_current())
 WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.principal_snapshot_current());
