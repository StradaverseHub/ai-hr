-- Global Delegation (Phase 1) — enable SELF-SERVICE delegation at the RLS layer, additively.
--
-- The delegation ENGINE (reporting_line `delegate` edges, honoured at decision time by
-- app.can_decide_via_delegation) already exists. What it lacked was a way for a NON-admin manager to hand
-- over their OWN approver duty: reporting_line's write policy is WITH CHECK app.is_admin(), so only HR could
-- create/revoke delegations, and the name-joins for the /delegations listing are visibility-gated (a
-- stand-in cannot see the delegator's employment under RLS).
--
-- This migration is purely ADDITIVE and backward-compatible:
--   1. Widen reporting_line WITH CHECK so a caller may write a `delegate` edge WHERE THEY are the delegator
--      (subordinate_employment_id maps to their own person). Admin access is unchanged (is_admin() short-
--      circuits); structural line writes by non-admins stay blocked; a non-admin still cannot delegate on
--      anyone else's behalf. Covers both INSERT (create) and UPDATE (revoke sets valid_to on the same row,
--      which still passes the self-check).
--   2. Add SECURITY-DEFINER helper app.self_delegations() returning the caller's own delegations (as
--      delegator OR delegate) WITH both names — the same vetted-boundary pattern as
--      app.can_decide_via_delegation: the function's WHERE clause is the scope, so no broader employment /
--      person visibility is granted to the caller.
-- No table/column change (drizzle schema is unchanged).

DROP POLICY reporting_line_rls ON reporting_line;
--> statement-breakpoint
CREATE POLICY reporting_line_rls ON reporting_line FOR ALL
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (
    tenant_id = app.current_tenant_id()
    AND (
      app.is_admin()
      OR (
        -- Self-service: a caller may write ONLY a `delegate` edge whose delegator (subordinate) is one of
        -- their own employments. ::text avoids any enum-value guard; parity with 0109/0138 delegate reads.
        line_type::text = 'delegate'
        AND EXISTS (
          SELECT 1
          FROM employment e
          JOIN app_user u ON u.person_id = e.person_id
          WHERE e.id = subordinate_employment_id
            AND u.id = app.current_user_id()
        )
      )
    )
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.self_delegations()
  RETURNS TABLE (
    id uuid,
    delegator_employment_id uuid,
    delegator_name text,
    delegate_employment_id uuid,
    delegate_name text,
    valid_from date,
    valid_to date,
    superseded_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT rl.id,
           rl.subordinate_employment_id,
           dp.full_name,
           rl.manager_employment_id,
           gp.full_name,
           rl.valid_from,
           rl.valid_to,
           rl.superseded_at
    FROM reporting_line rl
    JOIN employment de ON de.id = rl.subordinate_employment_id
    JOIN person dp ON dp.id = de.person_id
    JOIN employment ge ON ge.id = rl.manager_employment_id
    JOIN person gp ON gp.id = ge.person_id
    WHERE rl.line_type::text = 'delegate'
      AND rl.tenant_id = app.current_tenant_id()
      AND EXISTS (
        SELECT 1
        FROM employment me
        JOIN app_user u ON u.person_id = me.person_id
        WHERE u.id = app.current_user_id()
          AND me.id IN (rl.subordinate_employment_id, rl.manager_employment_id)
      );
  $$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.self_delegations() TO ai_hr_app;
