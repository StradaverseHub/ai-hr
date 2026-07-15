-- Approval Workflow Configuration Enhancement (feedback 72800eda) — grade-GROUP scoping.
--
-- The leave approval rule matrix (leave_approval_policy) already scopes by an INDIVIDUAL job grade
-- (grade_id). HR asked to scope a workflow by GRADE GROUP — the benefit-scheme grade bands (grade_group)
-- configured under Leave → Entitlements — so one rule can cover "Grade H / Permanent" as a band rather than
-- every grade one by one. This adds a nullable/wildcard grade_group_id dimension. Resolution maps the
-- requester's grade → its group (grade_group_member) at submit time; individual grade_id scoping keeps
-- working unchanged, and a rule may set either, both, or neither.
--
-- Additive + backward compatible: the new column defaults NULL (wildcard), so every existing rule resolves
-- exactly as before. FK is RESTRICT (a referenced group can never be deleted out from under a live rule).
-- No RLS change — leave_approval_policy already has tenant-read + admin-write policies the column inherits.
ALTER TABLE leave_approval_policy ADD COLUMN IF NOT EXISTS grade_group_id uuid REFERENCES grade_group(id);
--> statement-breakpoint
-- The "company default" is the fully-wildcard singleton per (company, leave-type). grade_group_id is a new
-- scoping dimension, so it must be excluded from that wildcard bucket: a grade-group-scoped rule (every other
-- dim null but grade_group_id set) is NOT the company default and must coexist with it. Recreate the partial
-- unique index to also require grade_group_id IS NULL.
DROP INDEX IF EXISTS leave_approval_policy_wildcard_uq;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS leave_approval_policy_wildcard_uq
  ON leave_approval_policy (company_id, coalesce(leave_type_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE business_unit_id is null and department_id is null and position_id is null and grade_id is null and grade_group_id is null and employment_type is null and min_days is null and max_days is null;
