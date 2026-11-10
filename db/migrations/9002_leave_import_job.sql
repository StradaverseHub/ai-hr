-- Durable leave ledger import job (bulk job plan step 1, the proof conversion).
-- DRAFT allocation: renumber through docs/MIGRATION-ALLOCATION.md before integration.
-- The worker writes ledger rows with the app role under the creator's authority; the
-- job row is only the checkpoint and the visible progress.
CREATE TABLE leave_import_job (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenant(id),created_by uuid NOT NULL REFERENCES app_user(id),
 context jsonb NOT NULL,records jsonb NOT NULL CHECK(jsonb_typeof(records)='array'),source jsonb,plan jsonb NOT NULL DEFAULT '[]'::jsonb,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','importing','completed','failed')),
 batch_id uuid NOT NULL DEFAULT gen_random_uuid(),total integer NOT NULL DEFAULT 0 CHECK(total>=0),next_index integer NOT NULL DEFAULT 0 CHECK(next_index>=0),
 imported integer NOT NULL DEFAULT 0 CHECK(imported>=0),skipped integer NOT NULL DEFAULT 0 CHECK(skipped>=0),failed jsonb NOT NULL DEFAULT '[]'::jsonb,
 retries integer NOT NULL DEFAULT 0 CHECK(retries>=0),error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX leave_import_job_queue ON leave_import_job(updated_at) WHERE state IN ('queued','importing');
--> statement-breakpoint
-- One running import per person, so a second click rejoins it instead of doubling the work.
CREATE UNIQUE INDEX leave_import_job_one_active ON leave_import_job(tenant_id,created_by) WHERE state IN ('queued','importing');
--> statement-breakpoint
-- Captures the real session on insert, the same owner the Bank & Statutory job uses.
CREATE TRIGGER leave_import_job_context BEFORE INSERT ON leave_import_job FOR EACH ROW EXECUTE FUNCTION app.bank_import_job_context();
--> statement-breakpoint
ALTER TABLE leave_import_job ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY leave_import_job_read ON leave_import_job FOR SELECT USING(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.bank_import_context_current(context));
--> statement-breakpoint
CREATE POLICY leave_import_job_insert ON leave_import_job FOR INSERT WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.principal_snapshot_current());
--> statement-breakpoint
CREATE POLICY leave_import_job_update ON leave_import_job FOR UPDATE USING(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id() AND app.bank_import_context_current(context)) WITH CHECK(tenant_id=app.current_tenant_id() AND created_by=app.current_user_id());
--> statement-breakpoint
REVOKE ALL ON leave_import_job FROM PUBLIC,ai_hr_app;
--> statement-breakpoint
GRANT SELECT,INSERT ON leave_import_job TO ai_hr_app;
--> statement-breakpoint
GRANT UPDATE(plan,state,total,next_index,imported,skipped,failed,retries,error,updated_at) ON leave_import_job TO ai_hr_app;
