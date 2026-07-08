-- 6fadb036 (R17, gap-close) — the reporter's full approver-step vocabulary. The approval-step editor now
-- offers the 7 selectable roles the request lists: Direct Manager, Department Head, Business Unit Head, HR,
-- HR Manager, Payroll, Custom Role (see core/leave-approval-policy.ts LEVEL_KINDS). Department-head and
-- business-unit-head steps route to an org-chart HEAD, so we add a nullable head pointer to each. The head
-- is an employment in the same company; a head step is DROPPED at generation when unset (no dead step),
-- mirroring the direct-manager drop. HR / HR Manager / Payroll / Custom Role steps resolve to role
-- authority (hr_admin/super_admin, payroll_partner) and need no new column.

ALTER TABLE "department" ADD COLUMN IF NOT EXISTS "head_employment_id" uuid;--> statement-breakpoint
ALTER TABLE "department" ADD CONSTRAINT "department_head_employment_id_employment_id_fk"
  FOREIGN KEY ("head_employment_id") REFERENCES "public"."employment"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "business_unit" ADD COLUMN IF NOT EXISTS "head_employment_id" uuid;--> statement-breakpoint
ALTER TABLE "business_unit" ADD CONSTRAINT "business_unit_head_employment_id_employment_id_fk"
  FOREIGN KEY ("head_employment_id") REFERENCES "public"."employment"("id") ON DELETE set null ON UPDATE no action;
