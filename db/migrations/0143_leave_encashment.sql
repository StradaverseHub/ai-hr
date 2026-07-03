-- ADR-0069: Leave Encashment (leave-side only). Freeze + calculate + expose to payroll — no salary math, no
-- RM conversion, no payroll logic here; payroll's existing encashmentDivisor stays untouched.
--
-- (a) leave_encashment_policy — ONE ROW PER COMPANY (0086/toil_policy pattern). No eligible-types column
--     (Annual is resolved by leaveType.code = 'ANNUAL', same as the existing leaverAdvisory); no rounding
--     column (the rule is a code constant — core/leave-encashment.ts computeEncashableDays). RLS mirrors
--     0086 leave_approval_policy: tenant-scoped read/write, WITH CHECK additionally requires
--     app.is_admin_for(company_id) — company-scoped HR admins manage their own company, matching who
--     decides resignations.
--
-- (b) leave_encashment_snapshot — one row per (resignation, leave type). RLS mirrors 0117 employee_cp38:
--     USING can_see_employment (subject self-READ — needed because the freeze trigger and the requestLeave
--     pre-check both evaluate under the EMPLOYEE's own session, not a SECURITY DEFINER context; trigger
--     functions in this product are never SECURITY DEFINER, per 0011), WITH CHECK is_admin (writes stay
--     admin/system-only). A partial unique index enforces "at most one ACTIVE (status='frozen') snapshot
--     per (employment, leave_type)" — the freeze trigger below reads exactly that invariant.
--
-- (c) app.guard_frozen_leave_balance() — ONE DB trigger (0011 payroll-immutability shape) replaces every
--     per-call-site THROW guard a naive implementation would need in core/leave.ts + core/toil.ts: it fires
--     BEFORE INSERT ON leave_ledger and rejects any new ledger row for an (employment_id, leave_type_id)
--     that currently has an ACTIVE frozen snapshot. leave_ledger is append-only, so INSERT-only coverage is
--     sufficient, and unfreezing (status -> 'unfrozen') re-opens ledger writes automatically because the
--     EXISTS predicate no longer matches.
--
-- Both new tables: ENABLE ROW LEVEL SECURITY + explicit GRANT to ai_hr_app (new tables do NOT inherit prior
-- grants — 0137:20) — the app role is NOSUPERUSER/NOBYPASSRLS, so RLS is enforced and a missing policy
-- fails CLOSED (ADR-0002).

CREATE TABLE "leave_encashment_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"auto_freeze" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "leave_encashment_policy" ADD CONSTRAINT "leave_encashment_policy_company_id_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."company"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "leave_encashment_policy_company_uq" ON "leave_encashment_policy" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE leave_encashment_policy ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON leave_encashment_policy TO ai_hr_app;--> statement-breakpoint
CREATE POLICY leave_encashment_policy_rls ON leave_encashment_policy FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin_for(company_id));--> statement-breakpoint

CREATE TYPE "leave_encashment_status" AS ENUM ('frozen', 'unfrozen');--> statement-breakpoint
CREATE TABLE "leave_encashment_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"resignation_request_id" uuid NOT NULL,
	"leave_type_id" uuid NOT NULL,
	"balance_days" numeric(6, 2) NOT NULL,
	"encashable_days" numeric(6, 2) NOT NULL,
	"calculated_as_of" date NOT NULL,
	"status" "leave_encashment_status" DEFAULT 'frozen' NOT NULL,
	"override_days" numeric(6, 2),
	"override_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "leave_encashment_snapshot" ADD CONSTRAINT "leave_encashment_snapshot_employment_id_employment_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_encashment_snapshot" ADD CONSTRAINT "leave_encashment_snapshot_resignation_request_id_resignation_request_id_fk" FOREIGN KEY ("resignation_request_id") REFERENCES "public"."resignation_request"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_encashment_snapshot" ADD CONSTRAINT "leave_encashment_snapshot_leave_type_id_leave_type_id_fk" FOREIGN KEY ("leave_type_id") REFERENCES "public"."leave_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "leave_encashment_snapshot_resignation_type_uq" ON "leave_encashment_snapshot" USING btree ("resignation_request_id","leave_type_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leave_encashment_snapshot_active_uq" ON "leave_encashment_snapshot" USING btree ("employment_id","leave_type_id") WHERE status = 'frozen';--> statement-breakpoint
ALTER TABLE leave_encashment_snapshot ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON leave_encashment_snapshot TO ai_hr_app;--> statement-breakpoint
CREATE POLICY leave_encashment_snapshot_rls ON leave_encashment_snapshot FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.is_admin());--> statement-breakpoint

-- The freeze invariant, unforgeable even under direct SQL / admin sessions (0011 shape). Ledger is
-- append-only, so an INSERT-only trigger is sufficient — there is no UPDATE/DELETE path to guard.
CREATE OR REPLACE FUNCTION app.guard_frozen_leave_balance() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM leave_encashment_snapshot s
    WHERE s.employment_id = NEW.employment_id
      AND s.leave_type_id = NEW.leave_type_id
      AND s.status = 'frozen'
  ) THEN
    RAISE EXCEPTION 'LEAVE_BALANCE_FROZEN: leave balance for employment % / type % is frozen for encashment', NEW.employment_id, NEW.leave_type_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER leave_ledger_frozen_guard
  BEFORE INSERT ON leave_ledger
  FOR EACH ROW EXECUTE FUNCTION app.guard_frozen_leave_balance();
