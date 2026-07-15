-- R44 delegation (Phase 2) — per-module / per-task SCOPE + a reason on a delegation.
--
-- Today a `delegate` edge on reporting_line is whole-scope: it hands over ALL of the delegator's approvals
-- for the window. Phase 2 lets the delegator narrow the hand-over to specific modules/tasks and record why.
--
-- Model (cleaner than widening reporting_line): a child table reporting_line_scope holds zero-or-more
-- (module, task_type) rows per delegate edge, plus a nullable `reason` column on the edge itself.
--   • ZERO scope rows  = "all approvals" — the exact back-compat behaviour of every existing row.
--   • a row (module, NULL task_type) = the WHOLE module.
--   • a row (module, task_type)      = just that approval task.
-- Enforcement is an OVERLOAD of app.can_decide_via_delegation(subject, module, task_type): the 1-arg form
-- (used by the RLS visibility policies in 0109) is untouched, so a scoped delegate still SEES routed rows;
-- the decide guard (core/approvals.ts assertCanDecide) calls the 3-arg form so a scoped delegation only
-- AUTHORISES the matching module/task. Additive + idempotent (IF NOT EXISTS / OR REPLACE); a re-run is safe.

ALTER TABLE reporting_line ADD COLUMN IF NOT EXISTS reason text;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "reporting_line_scope" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"reporting_line_id" uuid NOT NULL,
	"module" text NOT NULL,
	"task_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "reporting_line_scope" ADD CONSTRAINT "reporting_line_scope_line_fk" FOREIGN KEY ("reporting_line_id") REFERENCES "public"."reporting_line"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reporting_line_scope_line_idx" ON "reporting_line_scope" ("reporting_line_id");--> statement-breakpoint

ALTER TABLE "reporting_line_scope" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "reporting_line_scope" TO ai_hr_app;--> statement-breakpoint
-- Read: tenant-only, mirroring reporting_line's own SELECT scope (module/task strings are not sensitive).
-- Write: admin OR the SELF-SERVICE delegator — the caller may write a scope row only when its parent is a
-- `delegate` edge whose delegator (subordinate) is one of the caller's own employments. This mirrors the
-- widened reporting_line WITH CHECK (0196) so a non-admin manager can scope their OWN delegation; it never
-- lets them scope anyone else's. Written in the same tx as the parent edge, under the caller's RLS context.
DROP POLICY IF EXISTS reporting_line_scope_rls ON "reporting_line_scope";--> statement-breakpoint
CREATE POLICY reporting_line_scope_rls ON "reporting_line_scope" FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (
      app.is_admin()
      OR EXISTS (
        SELECT 1
        FROM reporting_line rl
        JOIN employment e ON e.id = rl.subordinate_employment_id
        JOIN app_user u ON u.person_id = e.person_id
        WHERE rl.id = reporting_line_id
          AND rl.line_type::text = 'delegate'
          AND u.id = app.current_user_id()
      )
    )
  );--> statement-breakpoint

-- Scope-aware decision helper (3-arg OVERLOAD). Same delegate→admin-manager→caller resolution as the 1-arg
-- form (0109), plus a scope gate: a delegation with NO scope rows authorises everything (back-compat); one
-- with scope rows authorises only a matching (module, task_type) — task_type NULL on a scope row = the whole
-- module. SECURITY DEFINER so it resolves the delegator's employment the caller can't see under RLS.
CREATE OR REPLACE FUNCTION app.can_decide_via_delegation(subject_emp uuid, p_module text, p_task_type text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM reporting_line del
    JOIN reporting_line adm
      ON adm.subordinate_employment_id = subject_emp
     AND adm.line_type = 'administrative'
     AND adm.manager_employment_id = del.subordinate_employment_id
     AND adm.valid_from <= current_date AND (adm.valid_to IS NULL OR adm.valid_to > current_date)
     AND adm.superseded_at IS NULL
    JOIN employment adm_mgr ON adm_mgr.id = adm.manager_employment_id AND adm_mgr.terminated_on IS NULL
    JOIN employment del_emp ON del_emp.id = del.manager_employment_id
    JOIN app_user u ON u.person_id = del_emp.person_id
    WHERE del.line_type::text = 'delegate'
      AND del.tenant_id = app.current_tenant_id()
      AND del.valid_from <= current_date AND (del.valid_to IS NULL OR del.valid_to > current_date)
      AND del.superseded_at IS NULL
      AND u.id = app.current_user_id()
      AND (
        NOT EXISTS (SELECT 1 FROM reporting_line_scope s WHERE s.reporting_line_id = del.id)
        OR EXISTS (
          SELECT 1 FROM reporting_line_scope s
          WHERE s.reporting_line_id = del.id
            AND s.module = p_module
            AND (s.task_type IS NULL OR s.task_type = p_task_type)
        )
      )
  );
$$;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.can_decide_via_delegation(uuid, text, text) TO ai_hr_app;
