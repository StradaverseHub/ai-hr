-- fc776376 — one pagination contract for list tables.
--
-- /approvals/history was one of the five screens that hand-rolled its own paging, and the only one that
-- decided "is there a next page?" by fetching limit+1 instead of counting. The shared pager shows a real
-- position ("26-50 of 312"), so this read model needs a matching COUNT — and it must apply EXACTLY the
-- same visibility and filter predicates as the row query, or the counter would promise rows the reader can
-- never reach.
--
-- Rather than duplicate the 100-line visibility walk into a second function (two copies drift), the count
-- runs OVER app.approval_history itself. That needs the row function to be able to return more than its
-- old hard-coded 500-row cap, so the upper clamp moves out to the caller: core/read.ts clamps to the
-- shared ALL_ROW_CEILING, and the count passes an unbounded limit. The function body is otherwise
-- byte-identical to 0288 — only the LIMIT line changed.

CREATE OR REPLACE FUNCTION app.approval_history(
  p_from timestamptz,
  p_to timestamptz,
  p_aggregate_types text[],
  p_action text,
  p_decider_employment_id uuid,
  p_limit int,
  p_offset int
)
  RETURNS TABLE (
    id uuid,
    aggregate_type text,
    aggregate_id uuid,
    event_type text,
    occurred_at timestamptz,
    subject_employment_id uuid,
    subject_name text,
    decider_name text,
    is_auto boolean,
    on_behalf_of_employment_id uuid,
    on_behalf_of_name text,
    payload jsonb
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH RECURSIVE caller_emp AS (
    -- Every employment of the calling principal (a person can hold concurrent employments).
    SELECT e.id, e.company_id, e.terminated_on
    FROM employment e
    JOIN app_user u ON u.person_id = e.person_id
    WHERE u.id = app.current_user_id()
      AND e.tenant_id = app.current_tenant_id()
  ),
  down AS (
    -- Recursive administrative down-walk from each ACTIVE caller employment (mirror of
    -- app.is_admin_report_of: active edges, live intermediates, company-subtree clamp, depth cap).
    SELECT rl.subordinate_employment_id AS emp, me.company_id AS root, 1 AS depth
    FROM reporting_line rl
    JOIN caller_emp me ON me.id = rl.manager_employment_id AND me.terminated_on IS NULL
    JOIN employment sub ON sub.id = rl.subordinate_employment_id
    WHERE rl.line_type = 'administrative'
      AND rl.superseded_at IS NULL
      AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      AND sub.terminated_on IS NULL
      AND app.is_company_descendant(sub.company_id, me.company_id)
    UNION
    SELECT rl.subordinate_employment_id, d.root, d.depth + 1
    FROM reporting_line rl
    JOIN down d ON d.emp = rl.manager_employment_id
    JOIN employment mid ON mid.id = rl.manager_employment_id AND mid.terminated_on IS NULL
    JOIN employment sub ON sub.id = rl.subordinate_employment_id AND sub.terminated_on IS NULL
    WHERE rl.line_type = 'administrative'
      AND rl.superseded_at IS NULL
      AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      AND d.depth < 64
      AND app.is_company_descendant(sub.company_id, d.root)
  ),
  ev AS (
    SELECT de.id, de.aggregate_type, de.aggregate_id, de.event_type, de.occurred_at, de.sequence,
           de.subject_employment_id, de.actor_id, de.payload, de.tenant_id
    FROM domain_event de
    WHERE de.tenant_id = app.current_tenant_id()
      -- The closed set of decision events this history covers (resignation uses accepted, not approved;
      -- employment-review.decided carries confirm/extend/terminate).
      AND de.event_type IN (
        'leave-request.approved', 'leave-request.rejected', 'leave-request.step.approved',
        'leave-request.date.decided', 'leave-cancellation.approved', 'leave-cancellation.rejected',
        'attendance-correction.approved', 'attendance-correction.rejected',
        'claim-request.approved', 'claim-request.rejected',
        'travel-request.approved', 'travel-request.rejected',
        'resignation.accepted', 'resignation.rejected',
        'profile-change.approved', 'profile-change.rejected',
        'employment-review.decided'
      )
      AND de.subject_employment_id IS NOT NULL
      -- Self rows never appear: the tab is about the viewer's TEAM.
      AND de.subject_employment_id NOT IN (SELECT ce.id FROM caller_emp ce)
      AND (app.is_admin() OR de.subject_employment_id IN (SELECT d.emp FROM down d))
      AND (p_from IS NULL OR de.occurred_at >= p_from)
      AND (p_to IS NULL OR de.occurred_at < p_to)
      AND (p_aggregate_types IS NULL OR cardinality(p_aggregate_types) = 0
           OR de.aggregate_type = ANY (p_aggregate_types))
      -- Action filter: Approved / Rejected / Other. Step rows ride '%.approved'; per-day rows group by
      -- their payload outcome; review decisions (confirm/extend/terminate) fall under Other.
      AND (p_action IS NULL
        OR (p_action = 'approved' AND (
              (de.event_type LIKE '%.approved' OR de.event_type = 'resignation.accepted')
              OR (de.event_type = 'leave-request.date.decided' AND de.payload->>'decision' = 'approved')))
        OR (p_action = 'rejected' AND (
              de.event_type LIKE '%.rejected'
              OR (de.event_type = 'leave-request.date.decided' AND de.payload->>'decision' = 'rejected')))
        OR (p_action = 'other' AND de.event_type = 'employment-review.decided'))
      -- Decider filter: an EMPLOYMENT id, mapped to the actor's app_user id(s) via person (server-side —
      -- the viewer may not be able to read the delegate's employment under RLS).
      AND (p_decider_employment_id IS NULL OR de.actor_id IN (
            SELECT u2.id
            FROM employment de2
            JOIN app_user u2 ON u2.person_id = de2.person_id
            WHERE de2.id = p_decider_employment_id
          ))
    ORDER BY de.occurred_at DESC, de.sequence DESC
    LIMIT GREATEST(COALESCE(p_limit, 50), 1)
    OFFSET GREATEST(COALESCE(p_offset, 0), 0)
  )
  SELECT
    e.id,
    e.aggregate_type,
    e.aggregate_id,
    e.event_type,
    e.occurred_at,
    e.subject_employment_id,
    subj_p.full_name,
    actor_p.full_name,
    COALESCE((e.payload->>'auto')::boolean, false),
    ob.delegator_employment_id,
    ob.delegator_name,
    e.payload
  FROM ev e
  LEFT JOIN employment subj_e ON subj_e.id = e.subject_employment_id
  LEFT JOIN person subj_p ON subj_p.id = subj_e.person_id
  LEFT JOIN app_user actor_u ON actor_u.id = e.actor_id
  LEFT JOIN person actor_p ON actor_p.id = actor_u.person_id
  LEFT JOIN LATERAL (
    SELECT del.subordinate_employment_id AS delegator_employment_id, dp.full_name AS delegator_name
    FROM reporting_line del
    JOIN employment del_emp ON del_emp.id = del.manager_employment_id   -- the delegate slot = the actor
    JOIN employment deleg_e ON deleg_e.id = del.subordinate_employment_id -- the delegator
    JOIN person dp ON dp.id = deleg_e.person_id
    WHERE del.line_type::text = 'delegate'
      AND del.tenant_id = e.tenant_id
      AND del_emp.person_id = actor_u.person_id
      AND del.valid_from <= ((e.occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
      AND (del.valid_to IS NULL OR del.valid_to > ((e.occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date))
      AND (del.superseded_at IS NULL OR del.superseded_at > e.occurred_at)
      AND EXISTS (
        SELECT 1 FROM reporting_line adm
        WHERE adm.subordinate_employment_id = e.subject_employment_id
          AND adm.line_type = 'administrative'
          AND adm.manager_employment_id = del.subordinate_employment_id
          AND adm.valid_from <= ((e.occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
          AND (adm.valid_to IS NULL OR adm.valid_to > ((e.occurred_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date))
          AND (adm.superseded_at IS NULL OR adm.superseded_at > e.occurred_at)
      )
    ORDER BY del.valid_from, del.id
    LIMIT 1
  ) ob ON true
  ORDER BY e.occurred_at DESC, e.sequence DESC;
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.approval_history(timestamptz, timestamptz, text[], text, uuid, int, int) TO ai_hr_app;
--> statement-breakpoint
-- The pager's total: how many history rows this viewer can reach under the current filters, ignoring
-- limit/offset. Definer like the row function (it delegates to it) and takes the same filter arguments.
CREATE OR REPLACE FUNCTION app.approval_history_count(
  p_from timestamptz,
  p_to timestamptz,
  p_aggregate_types text[],
  p_action text,
  p_decider_employment_id uuid
)
  RETURNS int
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*)::int
  FROM app.approval_history(
    p_from, p_to, p_aggregate_types, p_action, p_decider_employment_id, 2147483647, 0
  );
$$;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.approval_history_count(timestamptz, timestamptz, text[], text, uuid) TO ai_hr_app;
