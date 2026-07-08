-- Payroll Status Control + Selective Reprocessing (feedback 9bc442bc).
-- Closes the reporter's remaining gaps on top of the reset/reprocess work:
--   • OCC version column on payslip (row-level optimistic concurrency)
--   • dedicated audit tables (status history + per-employee result history) with before/after
--   • queue/idempotency table for background reprocessing (double-submit safety + poll-able status)
--   • per-company/tenant granular RBAC permission grants (payroll.rollback/unlock/reprocess.selective/close)
--   • step-up (OTP) challenge table for the high-risk Unlock action
--   • an Unlock escape-hatch in the 0011 closed-immutability trigger (transaction-local GUC only)

-- ── 1. Optimistic concurrency control on employee payroll records (payslip) ──
ALTER TABLE "payslip" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;--> statement-breakpoint

-- ── 2. Status-transition audit history (rollback / unlock / close / reprocess) ──
CREATE TABLE IF NOT EXISTS "payroll_status_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"reason" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "payroll_status_history" ADD CONSTRAINT "payroll_status_history_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_status_history" ADD CONSTRAINT "payroll_status_history_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."payroll_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_status_history_batch_idx" ON "payroll_status_history" USING btree ("batch_id");--> statement-breakpoint

-- ── 3. Per-employee result history (before/after snapshot for every reprocess) ──
CREATE TABLE IF NOT EXISTS "payroll_employee_result_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"reason" text,
	"version_before" integer,
	"version_after" integer,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "payroll_employee_result_history" ADD CONSTRAINT "payroll_employee_result_history_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_employee_result_history" ADD CONSTRAINT "payroll_employee_result_history_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."payroll_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_employee_result_history" ADD CONSTRAINT "payroll_employee_result_history_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_emp_result_history_batch_idx" ON "payroll_employee_result_history" USING btree ("batch_id");--> statement-breakpoint

-- ── 4. Queue-based reprocess job (idempotency key + poll-able status) ──
CREATE TABLE IF NOT EXISTS "payroll_reprocess_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL DEFAULT 'queued',
	"employment_ids" jsonb NOT NULL,
	"reason" text,
	"requested_by" uuid,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "payroll_reprocess_job" ADD CONSTRAINT "payroll_reprocess_job_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_reprocess_job" ADD CONSTRAINT "payroll_reprocess_job_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."payroll_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_reprocess_job_idem_uq" ON "payroll_reprocess_job" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint

-- ── 5. Granular payroll permission grants (per company/tenant RBAC overrides) ──
-- Rows OVERRIDE the code defaults for a (permission_key, role) pair. company_id NULL = tenant-wide.
CREATE TABLE IF NOT EXISTS "payroll_permission_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid,
	"permission_key" text NOT NULL,
	"role" text NOT NULL,
	"allowed" boolean NOT NULL DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "payroll_permission_grant" ADD CONSTRAINT "payroll_permission_grant_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_permission_grant" ADD CONSTRAINT "payroll_permission_grant_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "payroll_permission_grant_uq" ON "payroll_permission_grant" USING btree ("tenant_id", COALESCE("company_id", '00000000-0000-0000-0000-000000000000'::uuid), "permission_key", "role");--> statement-breakpoint

-- ── 6. Step-up (OTP) challenge for the high-risk Unlock action ──
CREATE TABLE IF NOT EXISTS "payroll_step_up_challenge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"code_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "payroll_step_up_challenge" ADD CONSTRAINT "payroll_step_up_challenge_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_step_up_challenge" ADD CONSTRAINT "payroll_step_up_challenge_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."payroll_batch"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_step_up_challenge_lookup_idx" ON "payroll_step_up_challenge" USING btree ("batch_id","user_id","purpose");--> statement-breakpoint

-- ── RLS: tenant-scoped, admin-writable (mirrors payroll_policy / 0002 pattern) ──
ALTER TABLE "payroll_status_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_status_history" TO ai_hr_app;--> statement-breakpoint
CREATE POLICY "payroll_status_history_rls" ON "payroll_status_history" FOR ALL
	USING (tenant_id = app.current_tenant_id() AND app.is_admin())
	WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

ALTER TABLE "payroll_employee_result_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_employee_result_history" TO ai_hr_app;--> statement-breakpoint
CREATE POLICY "payroll_employee_result_history_rls" ON "payroll_employee_result_history" FOR ALL
	USING (tenant_id = app.current_tenant_id() AND app.is_admin())
	WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

ALTER TABLE "payroll_reprocess_job" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_reprocess_job" TO ai_hr_app;--> statement-breakpoint
CREATE POLICY "payroll_reprocess_job_rls" ON "payroll_reprocess_job" FOR ALL
	USING (tenant_id = app.current_tenant_id() AND app.is_admin())
	WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

ALTER TABLE "payroll_permission_grant" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_permission_grant" TO ai_hr_app;--> statement-breakpoint
-- Readable tenant-wide so the payroll kernel can resolve a caller's permission under any session; writable admin-only.
CREATE POLICY "payroll_permission_grant_read" ON "payroll_permission_grant" FOR SELECT
	USING (tenant_id = app.current_tenant_id());--> statement-breakpoint
CREATE POLICY "payroll_permission_grant_write" ON "payroll_permission_grant" FOR ALL
	USING (tenant_id = app.current_tenant_id() AND app.is_admin())
	WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

ALTER TABLE "payroll_step_up_challenge" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "payroll_step_up_challenge" TO ai_hr_app;--> statement-breakpoint
CREATE POLICY "payroll_step_up_challenge_rls" ON "payroll_step_up_challenge" FOR ALL
	USING (tenant_id = app.current_tenant_id() AND app.is_admin())
	WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

-- ── 7. Unlock escape-hatch in the closed-immutability trigger (0011) ──
-- The batch guard now permits an UPDATE of a closed row IFF a transaction-local GUC names this exact
-- batch id (set only inside unlockClosedBatch, cleared at COMMIT). Everything else — DELETEs, any touch
-- of a closed row without the GUC, and every payslip write — stays frozen exactly as 0011 established.
CREATE OR REPLACE FUNCTION app.guard_closed_batch() RETURNS trigger
	LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status = 'closed' THEN
		IF TG_OP = 'UPDATE' AND current_setting('app.unlock_batch', true) = OLD.id::text THEN
			RETURN NEW; -- controlled unlock (see core/payroll.ts unlockClosedBatch)
		END IF;
		RAISE EXCEPTION 'payroll batch % is closed and immutable', OLD.id
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
