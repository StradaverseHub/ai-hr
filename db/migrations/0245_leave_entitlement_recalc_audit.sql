-- R45 7527ea5f — Automatic Leave Entitlement Recalculation on profile / eligibility change.
--
-- Today entitlement only recalculates when HR edits the leave POLICY (updateLeavePolicy →
-- reprojectEntitlementForPolicy). This build adds a PROFILE-triggered recompute: when an employee's grade,
-- grade group, employment type, confirmation status or hire date changes, the current cycle is re-projected
-- and a compensating `adjustment` ledger row (reason sys:profile_recalc:*) is posted on top of the current
-- balance (see reprojectEntitlementForEmployment in core/leave.ts). The ledger already carries the numbers;
-- this table is the human-readable AUDIT HISTORY of each recalculation (previous / new entitlement, the
-- profile field that changed, and the effective date).
--
-- Additive + backward compatible: a fresh table, no change to any existing column. IF NOT EXISTS keeps a
-- re-run idempotent. RLS mirrors leave_year_config / job_grade / leave_policy — tenant-read, admin-write.
CREATE TABLE IF NOT EXISTS "leave_entitlement_recalc_audit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "employment_id" uuid NOT NULL REFERENCES "employment"("id"),
  "leave_type_id" uuid NOT NULL REFERENCES "leave_type"("id"),
  "previous_entitlement" numeric(6, 2) NOT NULL,
  "new_entitlement" numeric(6, 2) NOT NULL,
  "delta" numeric(6, 2) NOT NULL,
  "reason" text NOT NULL,
  "effective_on" date NOT NULL,
  "ledger_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leave_entitlement_recalc_audit_employment_idx"
  ON "leave_entitlement_recalc_audit" ("employment_id", "leave_type_id");--> statement-breakpoint
ALTER TABLE "leave_entitlement_recalc_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "leave_entitlement_recalc_audit" TO ai_hr_app;--> statement-breakpoint
DROP POLICY IF EXISTS leave_entitlement_recalc_audit_rls ON "leave_entitlement_recalc_audit";--> statement-breakpoint
CREATE POLICY leave_entitlement_recalc_audit_rls ON "leave_entitlement_recalc_audit" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());
