-- r302 (board 6c9802c9, "My Leave dashboard") — THE NAMES OF THE PEOPLE WHO DECIDE YOUR OWN LEAVE, AND NOTHING ELSE.
--
-- WHY A FUNCTION AND NOT A POLICY. The approved plan: "Employees will see the names of the people who approve
-- their own requests, and nothing else about them." Today they cannot see even that — person RLS (0001, 0029,
-- 0099: app.can_see_person) admits self, admins and people whose EMPLOYMENT the caller may see, and a manager's
-- employment is not visible to the manager's report. Verified, not assumed: test/r302-my-leave-approver-names
-- .test.ts reads the shared history projection as ai_hr_app with an employee session and gets NULL for
-- currentApproverName and decidedByName while the manager and HR get the name.
--
-- Widening person RLS would hand every employee every column of every approver's person row (address, IC,
-- birth date, contacts…) through every read in the product. So person RLS is NOT touched. Instead two
-- SECURITY DEFINER functions return display NAMES ONLY, for leave requests the CALLER OWNS:
--
--   app.own_leave_request_approvals(uuid[])
--     one row per owned request with step_index NULL — the request's final decision (status, decided-by name,
--     decided_at), plus, for a PENDING request with no step rows (a single-level chain, decided by the direct
--     manager through assertCanDecide), the direct manager's name;
--     and one row per leave_approval_step — step_index, approver_kind, status, decided-by name, decided_at, and,
--     ONLY WHILE THAT STEP IS STILL PENDING, the name of the person it is routed to (and the names of any
--     any-one alternates that resolve to a person). Role kinds (hr_admin, hr_manager, payroll, custom_role)
--     resolve to a SET of people and are never named — the screen prints the kind's label, exactly as the
--     approvals inbox does.
--
--   app.own_leave_request_cancellations(uuid[])
--     for an owned request whose status is 'cancelled': when it was cancelled, the display name of who
--     cancelled it (the employee, the HR administrator, or the approver who approved the employee's
--     cancellation request), whether the system approved it automatically, when the cancellation was asked
--     for, and the reason on record.
--
-- OWNERSHIP: employment.person_id of the request = app_user.person_id of app.current_user_id(), everything
-- constrained to app.current_tenant_id(). Anything else — a colleague's request, a report's request viewed by
-- their manager, an id from another tenant, no session at all — returns NO ROWS, never an error, so the
-- function cannot be used to probe which ids exist. There is deliberately NO admin branch: an administrator
-- already reads names through RLS, and this read exists for the one audience that cannot.
--
-- WHO RESOLVES WHAT, mirroring the decide gate in core/leave.ts (assertCanDecideAsApprover):
--   direct_manager     the subject's current ADMINISTRATIVE line (the app.can_see_employment predicate:
--                      valid today, not superseded)
--   manager_manager    that manager's own current administrative line
--   department_head /  app.subject_head (0286) — the subject's current assignment's department / BU head
--   business_unit_head
--   specific_employee  the step's own approver_employment_id snapshot (0467)
--   anything else      NULL (a role, not a person)
--
-- EXECUTE: revoked from PUBLIC (a new function is executable by PUBLIC by default) and granted to ai_hr_app.
-- No helper function is created: a helper that takes an employment id and returns a name would be exactly the
-- directory lookup this migration exists not to publish.
--
-- ⚠️ NUMBERING. 0472, allocated centrally (journal max idx 471 on the base, build/r301-cancelapproved + main r301).
--
-- Rollback:
--   DROP FUNCTION app.own_leave_request_approvals(uuid[]);
--   DROP FUNCTION app.own_leave_request_cancellations(uuid[]);

CREATE OR REPLACE FUNCTION app.own_leave_request_approvals(p_leave_request_ids uuid[])
  RETURNS TABLE(
    leave_request_id uuid,
    step_index integer,
    approver_kind text,
    approver_name text,
    alternate_names text[],
    status text,
    decided_by_name text,
    decided_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH owned AS (
    SELECT lr.id, lr.employment_id, lr.status::text AS status, lr.decided_by_employment_id, lr.decided_at
    FROM leave_request lr
    JOIN employment e ON e.id = lr.employment_id AND e.tenant_id = lr.tenant_id
    WHERE lr.id = ANY(p_leave_request_ids)
      AND lr.tenant_id = app.current_tenant_id()
      AND EXISTS (
        SELECT 1 FROM app_user u
        WHERE u.id = app.current_user_id() AND u.tenant_id = lr.tenant_id AND u.person_id = e.person_id
      )
  ),
  steps AS (
    SELECT s.id, s.leave_request_id, s.subject_employment_id, s.step_index, s.approver_kind,
           s.approver_employment_id, s.approver_alternates, s.status::text AS status,
           s.decided_by_employment_id, s.decided_at, o.status AS request_status
    FROM leave_approval_step s
    JOIN owned o ON o.id = s.leave_request_id
    WHERE s.tenant_id = app.current_tenant_id()
  ),
  -- Every approver of a still-pending step: the primary (ord 0) and each any-one alternate (ord 1..n), in the
  -- vocabulary the template stores (a bare kind string, or {kind, employmentId} for a named person).
  approvers AS (
    SELECT st.id AS step_id, 0::bigint AS ord, st.approver_kind AS kind, st.approver_employment_id AS emp_id,
           st.subject_employment_id AS subject
    FROM steps st
    WHERE st.status = 'pending' AND st.request_status = 'pending'
    UNION ALL
    SELECT st.id, a.ord,
           CASE WHEN jsonb_typeof(a.el) = 'string' THEN a.el #>> '{}' ELSE a.el ->> 'kind' END,
           CASE WHEN jsonb_typeof(a.el) = 'object'
                 AND (a.el ->> 'employmentId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                THEN (a.el ->> 'employmentId')::uuid END,
           st.subject_employment_id
    FROM steps st
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(st.approver_alternates) = 'array' THEN st.approver_alternates ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS a(el, ord)
    WHERE st.status = 'pending' AND st.request_status = 'pending'
  ),
  resolved AS (
    SELECT ap.step_id, ap.ord,
      (SELECT p.full_name
         FROM employment ae
         JOIN person p ON p.id = ae.person_id AND p.tenant_id = ae.tenant_id
        WHERE ae.tenant_id = app.current_tenant_id()
          AND ae.id = CASE ap.kind
            WHEN 'specific_employee' THEN ap.emp_id
            WHEN 'direct_manager' THEN (
              SELECT rl.manager_employment_id FROM reporting_line rl
              WHERE rl.subordinate_employment_id = ap.subject AND rl.line_type = 'administrative'
                AND rl.tenant_id = app.current_tenant_id()
                AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
                AND rl.superseded_at IS NULL
              ORDER BY rl.valid_from DESC LIMIT 1)
            WHEN 'manager_manager' THEN (
              SELECT rl2.manager_employment_id FROM reporting_line rl2
              WHERE rl2.subordinate_employment_id = (
                  SELECT rl.manager_employment_id FROM reporting_line rl
                  WHERE rl.subordinate_employment_id = ap.subject AND rl.line_type = 'administrative'
                    AND rl.tenant_id = app.current_tenant_id()
                    AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
                    AND rl.superseded_at IS NULL
                  ORDER BY rl.valid_from DESC LIMIT 1)
                AND rl2.line_type = 'administrative'
                AND rl2.tenant_id = app.current_tenant_id()
                AND rl2.valid_from <= current_date AND (rl2.valid_to IS NULL OR rl2.valid_to > current_date)
                AND rl2.superseded_at IS NULL
                AND rl2.manager_employment_id <> ap.subject
              ORDER BY rl2.valid_from DESC LIMIT 1)
            WHEN 'department_head' THEN app.subject_head(ap.subject, 'department_head')
            WHEN 'business_unit_head' THEN app.subject_head(ap.subject, 'business_unit_head')
            ELSE NULL
          END
        LIMIT 1) AS name
    FROM approvers ap
  )
  -- The request's own row: its final decision, and the direct manager of a pending single-level request.
  SELECT o.id, NULL::integer, NULL::text,
         CASE WHEN o.status = 'pending' AND NOT EXISTS (SELECT 1 FROM steps st WHERE st.leave_request_id = o.id)
           THEN (SELECT p.full_name
                   FROM reporting_line rl
                   JOIN employment me ON me.id = rl.manager_employment_id AND me.tenant_id = rl.tenant_id
                   JOIN person p ON p.id = me.person_id AND p.tenant_id = me.tenant_id
                  WHERE rl.subordinate_employment_id = o.employment_id AND rl.line_type = 'administrative'
                    AND rl.tenant_id = app.current_tenant_id()
                    AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
                    AND rl.superseded_at IS NULL
                  ORDER BY rl.valid_from DESC LIMIT 1)
         END,
         NULL::text[],
         o.status,
         (SELECT p.full_name FROM employment de JOIN person p ON p.id = de.person_id AND p.tenant_id = de.tenant_id
           WHERE de.id = o.decided_by_employment_id AND de.tenant_id = app.current_tenant_id()),
         o.decided_at
  FROM owned o
  UNION ALL
  SELECT st.leave_request_id, st.step_index, st.approver_kind,
         (SELECT r.name FROM resolved r WHERE r.step_id = st.id AND r.ord = 0),
         (SELECT array_agg(r.name ORDER BY r.ord) FROM resolved r WHERE r.step_id = st.id AND r.ord > 0 AND r.name IS NOT NULL),
         st.status,
         (SELECT p.full_name FROM employment de JOIN person p ON p.id = de.person_id AND p.tenant_id = de.tenant_id
           WHERE de.id = st.decided_by_employment_id AND de.tenant_id = app.current_tenant_id()),
         st.decided_at
  FROM steps st;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.own_leave_request_approvals(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.own_leave_request_approvals(uuid[]) TO ai_hr_app;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.own_leave_request_cancellations(p_leave_request_ids uuid[])
  RETURNS TABLE(
    leave_request_id uuid,
    cancelled_at timestamptz,
    cancelled_by_name text,
    cancelled_automatically boolean,
    requested_at timestamptz,
    reason text
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH owned AS (
    SELECT lr.id
    FROM leave_request lr
    JOIN employment e ON e.id = lr.employment_id AND e.tenant_id = lr.tenant_id
    WHERE lr.id = ANY(p_leave_request_ids)
      AND lr.tenant_id = app.current_tenant_id()
      AND lr.status = 'cancelled'
      AND EXISTS (
        SELECT 1 FROM app_user u
        WHERE u.id = app.current_user_id() AND u.tenant_id = lr.tenant_id AND u.person_id = e.person_id
      )
  ),
  -- The event that cancelled the row: the employee withdrawing a pending request, HR cancelling on the
  -- employee's behalf, or the split that applied an approved cancellation request. Newest wins.
  ev AS (
    SELECT o.id AS leave_request_id, x.event_type, x.actor_type::text AS actor_type, x.actor_id, x.payload, x.occurred_at
    FROM owned o
    CROSS JOIN LATERAL (
      SELECT d.event_type, d.actor_type, d.actor_id, d.payload, d.occurred_at
      FROM domain_event d
      WHERE d.tenant_id = app.current_tenant_id()
        AND d.aggregate_id = o.id
        AND d.event_type IN ('leave-request.self-cancelled', 'leave-request.admin-cancelled', 'leave-request.cancelled')
      ORDER BY d.sequence DESC
      LIMIT 1
    ) x
  ),
  -- For a split-applied cancellation, the employee's cancellation request that produced it.
  cr AS (
    SELECT ev.leave_request_id, c.reason, c.created_at, c.decided_by_employment_id
    FROM ev
    CROSS JOIN LATERAL (
      SELECT lcr.reason, lcr.created_at, lcr.decided_by_employment_id
      FROM domain_event a
      JOIN leave_cancellation_request lcr ON lcr.id = a.aggregate_id AND lcr.tenant_id = a.tenant_id
      WHERE ev.event_type = 'leave-request.cancelled'
        AND a.tenant_id = app.current_tenant_id()
        AND a.event_type = 'leave-cancellation.approved'
        AND (a.payload -> 'cancelledRowIds') ? ev.leave_request_id::text
      ORDER BY a.sequence DESC
      LIMIT 1
    ) c
  )
  SELECT o.id,
         ev.occurred_at,
         COALESCE(
           CASE
             WHEN ev.event_type = 'leave-request.admin-cancelled'
              AND (ev.payload ->> 'cancelledByEmploymentId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               THEN (SELECT p.full_name FROM employment de JOIN person p ON p.id = de.person_id AND p.tenant_id = de.tenant_id
                      WHERE de.id = (ev.payload ->> 'cancelledByEmploymentId')::uuid AND de.tenant_id = app.current_tenant_id())
             WHEN ev.event_type = 'leave-request.cancelled'
               THEN (SELECT p.full_name FROM employment de JOIN person p ON p.id = de.person_id AND p.tenant_id = de.tenant_id
                      WHERE de.id = cr.decided_by_employment_id AND de.tenant_id = app.current_tenant_id())
           END,
           CASE WHEN ev.actor_type = 'user'
             THEN (SELECT p.full_name FROM app_user au JOIN person p ON p.id = au.person_id AND p.tenant_id = au.tenant_id
                    WHERE au.id = ev.actor_id AND au.tenant_id = app.current_tenant_id())
           END
         ),
         COALESCE(ev.actor_type = 'system', false),
         cr.created_at,
         CASE
           WHEN ev.event_type = 'leave-request.admin-cancelled' THEN NULLIF(btrim(ev.payload ->> 'reason'), '')
           WHEN ev.event_type = 'leave-request.cancelled' THEN NULLIF(btrim(cr.reason), '')
         END
  FROM owned o
  LEFT JOIN ev ON ev.leave_request_id = o.id
  LEFT JOIN cr ON cr.leave_request_id = o.id;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.own_leave_request_cancellations(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.own_leave_request_cancellations(uuid[]) TO ai_hr_app;
