-- Performance Phase B — goals RLS (ADR-0022, slice 1).
--
-- performance_goal: employment-scoped — visible/writable to the subject employee, their active
--   administrative manager, and admins (the same app.can_see_employment rule as leave_request /
--   performance_review). Goals are co-owned (subject + manager + admin all read/write); the SERVICE
--   enforces lifecycle (status transitions) and that a goal is reference-only (never writes pay).
-- review_goal: a join with no employment_id of its own — scoped to the visibility of its parent
--   review (can_see_employment on performance_review.employment_id). The service enforces that only
--   the manager/admin links goals onto a review (during the manager-review step).

ALTER TABLE performance_goal ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE review_goal ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON performance_goal TO ai_hr_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON review_goal TO ai_hr_app;--> statement-breakpoint

CREATE POLICY performance_goal_rls ON performance_goal FOR ALL
  USING (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id))
  WITH CHECK (tenant_id = app.current_tenant_id() AND app.can_see_employment(employment_id));--> statement-breakpoint

CREATE POLICY review_goal_rls ON review_goal FOR ALL
  USING (
    tenant_id = app.current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM performance_review pr
      WHERE pr.id = review_goal.review_id AND app.can_see_employment(pr.employment_id)
    )
  )
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM performance_review pr
      WHERE pr.id = review_goal.review_id AND app.can_see_employment(pr.employment_id)
    )
  );
