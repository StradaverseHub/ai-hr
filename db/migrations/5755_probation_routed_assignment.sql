-- Routed Probation steps: assignment, delegation and form approval choices (lane F2-F4 of the Probation Confirmation
-- build; ADR docs/adr/2026-11-15-probation-shared-automation.md decisions 2 and 7; handoff A2, A3, B3).
-- Tag 5755 / idx 5155 / when 1793330005455, assigned by the build coordinator.
--
-- 1. app.probation_assignment_facts(case, groups, people) (F2): what the V9 assignment owner (lib/lifecycle-v9-model.ts
--    `assign`) needs to choose one person for a routed Review, Approve or Sign step: each named assignment group's
--    name, open-task limit and active members in member order, and for every candidate (group members and named people
--    still active) the open load (unfinished steps they hold on open Probation documents), the last time a routing,
--    group or named-people step was assigned to them, and whether approved leave covers today. Availability only: no
--    leave reason is returned. Authorized by app.automation_can_run('probation', case); bounded (50 groups, 200
--    people, 500 members a group, the latest 2000 Probation documents).
-- No table, row, grant or purpose-owned object changes; the new function is granted to ai_hr_app.
CREATE FUNCTION app.probation_assignment_facts(p_case uuid, p_groups text[], p_people uuid[]) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE t uuid := app.current_tenant_id(); day date := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date; v_groups jsonb; candidates uuid[]; users jsonb;
BEGIN
  IF app.automation_can_run('probation', p_case) IS NOT TRUE THEN RAISE EXCEPTION 'This workflow runner is not permitted here' USING ERRCODE = '42501'; END IF;
  IF coalesce(cardinality(p_groups), 0) > 50 OR coalesce(cardinality(p_people), 0) > 200 THEN RAISE EXCEPTION 'Invalid assignment request' USING ERRCODE = '22023'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', g->>'id', 'name', coalesce(nullif(g->>'name', ''), g->>'id'),
      'limit', CASE WHEN jsonb_typeof(g->'limit') = 'number' THEN greatest(floor((g->>'limit')::numeric), 0)::integer ELSE 0 END,
      'members', coalesce((
        SELECT jsonb_agg(u.id ORDER BY m.n) FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(g->'members') = 'array' THEN g->'members' ELSE '[]'::jsonb END) WITH ORDINALITY m(id, n)
        JOIN public.app_user u ON u.id::text = m.id AND u.tenant_id = t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
        WHERE m.n <= 500), '[]'::jsonb))), '[]'::jsonb)
    INTO v_groups
    FROM public.lc_v9_config v CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v.data->'groups') = 'array' THEN v.data->'groups' ELSE '[]'::jsonb END) g
    WHERE v.tenant_id = t AND g->>'id' = ANY(coalesce(p_groups, '{}'::text[]));
  SELECT coalesce(array_agg(DISTINCT x.id), '{}'::uuid[]) INTO candidates FROM (
    SELECT (m.id)::uuid AS id FROM jsonb_array_elements(v_groups) g CROSS JOIN LATERAL jsonb_array_elements_text(g->'members') m(id)
    UNION ALL
    SELECT u.id FROM public.app_user u WHERE u.id = ANY(coalesce(p_people, '{}'::uuid[])) AND u.tenant_id = t AND u.person_id IS NOT NULL AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)) x;
  WITH recent AS MATERIALIZED (
    SELECT d.data, d.created_at, p.data->>'state' AS part_state FROM public.document_signing_document d
    JOIN public.probation_part p ON p.id = d.subject_id AND p.tenant_id = d.tenant_id
    WHERE d.tenant_id = t AND d.subject_type = 'probation' ORDER BY d.created_at DESC, d.id DESC LIMIT 2000
  ), held AS MATERIALIZED (
    SELECT st->>'holderId' AS holder, r.created_at,
      r.part_state IN ('pending_ack','pending_approval','returned') AND NOT app.document_signing_step_fulfilled(r.data, st) AS open,
      (st->>'role' LIKE 'routing:%' OR st->>'role' LIKE 'group:%' OR st->>'role' = 'people') AS routed
    FROM recent r CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.data->'route'->'steps') = 'array' THEN r.data->'route'->'steps' ELSE '[]'::jsonb END) st
    WHERE st->>'holderId' = ANY(candidates::text[])
  ), away AS MATERIALIZED (
    SELECT DISTINCT u.id FROM public.app_user u
    JOIN public.employment e ON e.person_id = u.person_id AND e.tenant_id = u.tenant_id
    JOIN public.leave_request lr ON lr.employment_id = e.id AND lr.tenant_id = e.tenant_id
    WHERE u.id = ANY(candidates) AND u.tenant_id = t AND (
      EXISTS(SELECT 1 FROM public.leave_request_date ld WHERE ld.leave_request_id = lr.id AND ld.leave_date = day AND ld.status = 'approved')
      OR (lr.status = 'approved' AND day BETWEEN lr.start_date AND lr.end_date AND NOT EXISTS(SELECT 1 FROM public.leave_request_date ld WHERE ld.leave_request_id = lr.id)))
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id,
      'load', (SELECT count(*) FROM held h WHERE h.holder = c.id::text AND h.open),
      'lastAssigned', (SELECT max(h.created_at) FROM held h WHERE h.holder = c.id::text AND h.routed),
      'onLeave', EXISTS(SELECT 1 FROM away a WHERE a.id = c.id)) ORDER BY c.id), '[]'::jsonb)
    INTO users FROM unnest(candidates) c(id);
  RETURN jsonb_build_object('today', day, 'groups', v_groups, 'users', users);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.probation_assignment_facts(uuid,text[],uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.probation_assignment_facts(uuid,text[],uuid[]) TO ai_hr_app
