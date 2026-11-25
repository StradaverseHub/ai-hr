-- ADR 0181 decision 5 (Phase 4): Approval History pages by key and caps its total.
--
-- app.approval_history(..., p_limit, p_offset) (0818) pages with OFFSET, so every page re-reads every newer decision,
-- and app.approval_history_count (0320) counts by calling it with an unbounded limit: the names, the delegate
-- LATERAL and the down-walk projection were built for every decision the viewer can reach on every page view.
--
-- Two new definer functions, side by side with the old ones (which stay for their existing callers):
--  * app.approval_history_page(filters, p_anchor, p_backwards, p_limit): the same visibility, filters, rows and order
--    (newest first, ties by sequence), continuing after (or, backwards, before) the anchor decision. The anchor is
--    looked up among the decisions this viewer may see under these filters only, so an event the viewer cannot see
--    never positions a page: it yields no rows and the caller serves the first page.
--  * app.approval_history_count_capped(filters, p_cap): how many decisions match, counted up to p_cap + 1 rows of
--    the event filter alone (no names, no delegate lookup). The caller shows "p_cap+" above the cap and asks for
--    p_cap = 2147483646 for "Count exactly".
-- The visibility and filter predicates are the 0818 body's, unchanged; test/approval-history-keyset.test.ts proves
-- the rows, order and counts equal to app.approval_history / app.approval_history_count for every role.
CREATE FUNCTION app.approval_history_events(
  p_from timestamptz,
  p_to timestamptz,
  p_aggregate_types text[],
  p_action text,
  p_decider_employment_id uuid,
  p_anchor uuid,
  p_backwards boolean,
  p_limit int
)
  RETURNS TABLE (
    id uuid, aggregate_type text, aggregate_id uuid, event_type text, occurred_at timestamptz, sequence bigint,
    subject_employment_id uuid, actor_id uuid, payload jsonb, tenant_id uuid
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH RECURSIVE caller_emp AS (
    SELECT e.id, e.company_id, e.terminated_on
    FROM employment e
    JOIN app_user u ON u.person_id = e.person_id
    WHERE u.id = app.current_user_id()
      AND e.tenant_id = app.current_tenant_id()
  ),
  down AS (
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
  visible AS NOT MATERIALIZED (
    SELECT de.id, de.aggregate_type, de.aggregate_id, de.event_type, de.occurred_at, de.sequence,
           de.subject_employment_id, de.actor_id, de.payload, de.tenant_id
    FROM domain_event de
    WHERE de.tenant_id = app.current_tenant_id()
      AND de.event_type IN (
        'leave-request.approved', 'leave-request.rejected', 'leave-request.step.approved',
        'leave-request.date.decided', 'leave-cancellation.approved', 'leave-cancellation.rejected',
        'attendance-correction.approved', 'attendance-correction.rejected',
        'claim-request.approved', 'claim-request.rejected',
        'replacement-leave-request.approved', 'replacement-leave-request.rejected',
        'attendance-workflow.stage.decided',
        'travel-request.approved', 'travel-request.rejected',
        'resignation.accepted', 'resignation.rejected',
        'profile-change.approved', 'profile-change.rejected',
        'employment-review.decided'
      )
      AND (de.event_type NOT IN ('attendance-workflow.stage.decided') OR de.payload->>'resultingStatus'='pending')
      AND de.subject_employment_id IS NOT NULL
      AND de.subject_employment_id NOT IN (SELECT ce.id FROM caller_emp ce)
      AND (EXISTS(SELECT 1 FROM public.employment scoped_subject WHERE scoped_subject.id=de.subject_employment_id AND scoped_subject.tenant_id=de.tenant_id AND app.is_admin_for(scoped_subject.company_id)) OR de.subject_employment_id IN (SELECT d.emp FROM down d))
      AND (p_from IS NULL OR de.occurred_at >= p_from)
      AND (p_to IS NULL OR de.occurred_at < p_to)
      AND (p_aggregate_types IS NULL OR cardinality(p_aggregate_types) = 0
           OR de.aggregate_type = ANY (p_aggregate_types))
      AND (p_action IS NULL
        OR (p_action = 'approved' AND (
              (de.event_type LIKE '%.approved' OR de.event_type = 'resignation.accepted')
              OR (de.event_type IN ('leave-request.date.decided','attendance-workflow.stage.decided') AND de.payload->>'decision' = 'approved')))
        OR (p_action = 'rejected' AND (
              de.event_type LIKE '%.rejected'
              OR (de.event_type IN ('leave-request.date.decided','attendance-workflow.stage.decided') AND de.payload->>'decision' = 'rejected')))
        OR (p_action = 'other' AND de.event_type = 'employment-review.decided'))
      AND (p_decider_employment_id IS NULL OR de.actor_id IN (
            SELECT u2.id
            FROM employment de2
            JOIN app_user u2 ON u2.person_id = de2.person_id
            WHERE de2.id = p_decider_employment_id
          ))
  ),
  anchor AS MATERIALIZED (
    SELECT v.occurred_at, v.sequence FROM visible v WHERE v.id = p_anchor
  )
  SELECT v.id, v.aggregate_type, v.aggregate_id, v.event_type, v.occurred_at, v.sequence,
         v.subject_employment_id, v.actor_id, v.payload, v.tenant_id
  FROM visible v
  WHERE p_anchor IS NULL
     OR (NOT COALESCE(p_backwards, false) AND (v.occurred_at, v.sequence) < (SELECT a.occurred_at, a.sequence FROM anchor a))
     OR (COALESCE(p_backwards, false) AND (v.occurred_at, v.sequence) > (SELECT a.occurred_at, a.sequence FROM anchor a))
  ORDER BY
    CASE WHEN COALESCE(p_backwards, false) THEN v.occurred_at END ASC,
    CASE WHEN COALESCE(p_backwards, false) THEN v.sequence END ASC,
    CASE WHEN NOT COALESCE(p_backwards, false) THEN v.occurred_at END DESC,
    CASE WHEN NOT COALESCE(p_backwards, false) THEN v.sequence END DESC
  LIMIT GREATEST(COALESCE(p_limit, 50), 1)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.approval_history_events(timestamptz, timestamptz, text[], text, uuid, uuid, boolean, int) FROM PUBLIC;
--> statement-breakpoint
-- The page: one keyset slice of the event filter above, with the 0818 projection (names under definer privileges,
-- "on behalf of" derived from delegate edges) built for that slice only.
CREATE FUNCTION app.approval_history_page(
  p_from timestamptz,
  p_to timestamptz,
  p_aggregate_types text[],
  p_action text,
  p_decider_employment_id uuid,
  p_anchor uuid,
  p_backwards boolean,
  p_limit int
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
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
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
  FROM app.approval_history_events(p_from, p_to, p_aggregate_types, p_action, p_decider_employment_id,
         p_anchor, p_backwards, p_limit) e
  LEFT JOIN employment subj_e ON subj_e.id = e.subject_employment_id
  LEFT JOIN person subj_p ON subj_p.id = subj_e.person_id
  LEFT JOIN app_user actor_u ON actor_u.id = e.actor_id
  LEFT JOIN person actor_p ON actor_p.id = actor_u.person_id
  LEFT JOIN LATERAL (
    SELECT del.subordinate_employment_id AS delegator_employment_id, dp.full_name AS delegator_name
    FROM reporting_line del
    JOIN employment del_emp ON del_emp.id = del.manager_employment_id
    JOIN employment deleg_e ON deleg_e.id = del.subordinate_employment_id
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
  ORDER BY
    CASE WHEN COALESCE(p_backwards, false) THEN e.occurred_at END ASC,
    CASE WHEN COALESCE(p_backwards, false) THEN e.sequence END ASC,
    CASE WHEN NOT COALESCE(p_backwards, false) THEN e.occurred_at END DESC,
    CASE WHEN NOT COALESCE(p_backwards, false) THEN e.sequence END DESC;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.approval_history_page(timestamptz, timestamptz, text[], text, uuid, uuid, boolean, int) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.approval_history_page(timestamptz, timestamptz, text[], text, uuid, uuid, boolean, int) TO ai_hr_app;
--> statement-breakpoint
CREATE FUNCTION app.approval_history_count_capped(
  p_from timestamptz,
  p_to timestamptz,
  p_aggregate_types text[],
  p_action text,
  p_decider_employment_id uuid,
  p_cap int
)
  RETURNS int
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT count(*)::int
  FROM app.approval_history_events(p_from, p_to, p_aggregate_types, p_action, p_decider_employment_id,
         NULL, false, LEAST(GREATEST(COALESCE(p_cap, 1000), 1), 2147483646) + 1);
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.approval_history_count_capped(timestamptz, timestamptz, text[], text, uuid, int) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.approval_history_count_capped(timestamptz, timestamptz, text[], text, uuid, int) TO ai_hr_app;
