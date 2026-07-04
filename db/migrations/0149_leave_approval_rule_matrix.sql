-- ADR-0071: Leave-approval rule matrix. Extends the ADR-0039 configurable approval chain from a
-- (company_id, leave_type_id) routing key to a scoped, multi-rule matrix. Each leave_approval_policy row
-- becomes a RULE: still company + optional leave-type, now additionally scoped by business_unit, department,
-- position, job_grade, employment_type and a min/max leave-day range. All scoping dimensions are
-- nullable/wildcard. Resolution is "most-specific matching rule wins" (score = count of matched non-null
-- dimensions), with a deterministic tie-break (narrower day-range → most-recently-created). A row with every
-- dimension null IS the company default; no matching rule falls through to the built-in [direct_manager,
-- hr_admin] chain. Additive: existing rows (default + type-specific) keep working unchanged.
--
-- RLS is UNCHANGED (tenant-wide read, admin-for-company write) — mirrors 0086/0136 precedent exactly.

ALTER TABLE "leave_approval_policy" ADD COLUMN "rule_name" text;--> statement-breakpoint
ALTER TABLE "leave_approval_policy" ADD COLUMN "business_unit_id" uuid;--> statement-breakpoint
ALTER TABLE "leave_approval_policy" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "leave_approval_policy" ADD COLUMN "position_id" uuid;--> statement-breakpoint
ALTER TABLE "leave_approval_policy" ADD COLUMN "grade_id" uuid;--> statement-breakpoint
ALTER TABLE "leave_approval_policy" ADD COLUMN "employment_type" employment_type;--> statement-breakpoint
ALTER TABLE "leave_approval_policy" ADD COLUMN "min_days" integer;--> statement-breakpoint
ALTER TABLE "leave_approval_policy" ADD COLUMN "max_days" integer;--> statement-breakpoint
ALTER TABLE "leave_approval_policy" ADD COLUMN "active" boolean NOT NULL DEFAULT true;--> statement-breakpoint

ALTER TABLE "leave_approval_policy" ADD CONSTRAINT "leave_approval_policy_business_unit_id_business_unit_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_unit"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_approval_policy" ADD CONSTRAINT "leave_approval_policy_department_id_department_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."department"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_approval_policy" ADD CONSTRAINT "leave_approval_policy_position_id_position_id_fk" FOREIGN KEY ("position_id") REFERENCES "public"."position"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_approval_policy" ADD CONSTRAINT "leave_approval_policy_grade_id_job_grade_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."job_grade"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- min_days ≤ max_days when both are set. The CHECK does NOT catch two functionally-identical rules — the
-- service enforces a full-tuple duplicate guard on create/update (see core/leave-approval-policy.ts).
ALTER TABLE "leave_approval_policy" ADD CONSTRAINT "leave_approval_policy_day_range_ck" CHECK ("min_days" IS NULL OR "max_days" IS NULL OR "min_days" <= "max_days");--> statement-breakpoint

-- Drop the old two-level uniqueness. Multiple partially-specific rules per (company, leave-type) are now
-- allowed; only two FULLY-wildcard rows for the same company + leave-type stay forbidden (the company
-- default is a singleton). NOTE: a NULL leave_type_id column-value groups as one bucket under this index,
-- so a company can have exactly one company-default (all dims null, leave_type_id null) row plus one
-- fully-wildcard-per-type row per leave type — matching the prior default/type split, now relaxed for
-- partially-specific rules.
DROP INDEX IF EXISTS "leave_approval_policy_company_default_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "leave_approval_policy_company_type_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "leave_approval_policy_wildcard_uq" ON "leave_approval_policy" ("company_id", COALESCE("leave_type_id", '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE "business_unit_id" IS NULL AND "department_id" IS NULL AND "position_id" IS NULL AND "grade_id" IS NULL AND "employment_type" IS NULL AND "min_days" IS NULL AND "max_days" IS NULL;
