-- Unapplied performance guards. Existing decision and privacy owners remain authoritative.
-- A reporting edge is necessary, never sufficient, for the existing reports-derived Home role.
-- For an unassigned employee, avoid evaluating visibility across unrelated employment/person rows.
-- If any eligible edge exists, retain the complete original visibility query and every native guard.
-- Function language, volatility, definer, search path, owner and execute ACLs are unchanged.
CREATE OR REPLACE FUNCTION app.own_home_dashboard_role(p_employment uuid) RETURNS text
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 SELECT CASE WHEN app.is_admin_for(proof.company_id) THEN 'hr_admin'
  WHEN app.has_role_for('manager',proof.company_id) OR CASE WHEN EXISTS(
   SELECT 1 FROM public.reporting_line pending_edge
   WHERE pending_edge.manager_employment_id=e.id AND pending_edge.tenant_id=e.tenant_id
    AND pending_edge.valid_to IS NULL AND pending_edge.superseded_at IS NULL
    AND pending_edge.line_type::text<>'delegate'
  ) THEN EXISTS(
   SELECT 1 FROM public.reporting_line r JOIN public.employment report ON report.id=r.subordinate_employment_id
    JOIN public.person subject ON subject.id=report.person_id
   WHERE r.manager_employment_id=e.id AND r.tenant_id=e.tenant_id AND report.tenant_id=e.tenant_id
    AND subject.tenant_id=e.tenant_id AND r.valid_to IS NULL AND r.superseded_at IS NULL
    AND r.line_type::text<>'delegate' AND app.can_see_employment(report.id) AND app.can_see_person(subject.id)
  ) ELSE false END THEN 'manager' ELSE 'employee' END
 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
 CROSS JOIN LATERAL app.proven_company_date_points(jsonb_build_array(jsonb_build_object(
  'employmentId',e.id,'date',(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date))) proof
 WHERE e.id=p_employment AND e.tenant_id=app.current_tenant_id() AND u.id=app.current_user_id()
  AND app.principal_snapshot_current() AND app.is_self_person(e.person_id);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.visible_employment_ids()
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
 RETURN (
  WITH RECURSIVE
  -- The caller's employments that can_see_employment's manager and HOD arms iterate over:
  -- `employment me JOIN app_user u ON u.person_id = me.person_id WHERE u.id = app.current_user_id()
  --  AND me.tenant_id = app.current_tenant_id() AND me.terminated_on IS NULL`.
  me AS (
    SELECT e.id, e.company_id
    FROM employment e
    JOIN app_user u ON u.person_id = e.person_id
    WHERE u.id = app.current_user_id()
      AND e.tenant_id = app.current_tenant_id()
      AND e.terminated_on IS NULL
  ),
  -- (a) ADMIN arm: `e.tenant_id = app.current_tenant_id() AND app.is_admin_for(e.company_id)`.
  -- is_admin_for depends only on the company id and the session's grants, so it is evaluated once per
  -- DISTINCT company of the tenant's employments instead of once per employment.
  -- An optimization fence is necessary: without it PostgreSQL pushes is_admin_for below
  -- DISTINCT and repeats the same grant check for every employment in a company.
  tenant_company AS MATERIALIZED (
    SELECT DISTINCT e.company_id FROM employment e WHERE e.tenant_id = app.current_tenant_id()
  ),
  admin_company AS MATERIALIZED (
    SELECT c.company_id
    FROM tenant_company c
    WHERE app.is_admin_for(c.company_id)
  ),
  -- (c) MANAGER arm: app.is_admin_report_of(subject, me.id) for every caller employment `me`, as ONE
  -- recursive walk seeded from all of them. Each path carries the company of the seed employment it
  -- started from (is_admin_report_of's `mgr.root_company`), so the company clamp on every hop is the
  -- clamp of THAT path's root — never another of the caller's employments'. UNION over
  -- (root_company, emp, depth) yields, per root company, exactly the union of the per-manager sets.
  down AS (
    SELECT m.company_id AS root_company, rl.subordinate_employment_id AS emp, 1 AS depth
    FROM me m
    JOIN reporting_line rl ON rl.manager_employment_id = m.id
    JOIN employment sub ON sub.id = rl.subordinate_employment_id
    WHERE rl.line_type = 'administrative'
      AND rl.superseded_at IS NULL
      AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      AND sub.terminated_on IS NULL
      AND app.is_company_descendant(sub.company_id, m.company_id)
    UNION
    SELECT d.root_company, rl.subordinate_employment_id, d.depth + 1
    FROM down d
    JOIN reporting_line rl ON rl.manager_employment_id = d.emp
    JOIN employment mid ON mid.id = rl.manager_employment_id
    JOIN employment sub ON sub.id = rl.subordinate_employment_id
    WHERE rl.line_type = 'administrative'
      AND rl.superseded_at IS NULL
      AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      AND mid.terminated_on IS NULL
      AND sub.terminated_on IS NULL
      AND d.depth < 64
      AND app.is_company_descendant(sub.company_id, d.root_company)
  ),
  -- (d) HOD arm: app.heads_department_of(subject, me.id) (0121) for every caller employment `me`.
  -- caller_dept = heads_department_of's caller_dept per caller (current assignment, department set;
  -- `e.terminated_on IS NULL` is already in `me`), kept only for a caller that ALSO manages at least one
  -- current administrative reporting line — heads_department_of's second EXISTS, which depends on the
  -- caller alone, so filtering that caller's rows here is the same condition.
  caller_dept AS (
    SELECT m.id AS caller, a.department_id AS dept, d.company_id AS company
    FROM me m
    JOIN assignment a ON a.employment_id = m.id
    JOIN department d ON d.id = a.department_id
    WHERE a.valid_to IS NULL AND a.superseded_at IS NULL
      AND a.department_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM reporting_line rl
        WHERE rl.manager_employment_id = m.id
          AND rl.line_type = 'administrative'
          AND rl.superseded_at IS NULL
          AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      )
  ),
  -- The department subtree per caller (inclusive). A hop is admitted when the child department's company
  -- descends from the company of ANY of THAT caller's departments — heads_department_of's
  -- `JOIN caller_dept cd ON true WHERE app.is_company_descendant(d.company_id, cd.company)`, whose
  -- caller_dept holds one caller's rows only. depth < 64 as there. UNION (not UNION ALL) only removes
  -- duplicate rows; the set of reachable departments is the same.
  dept_down AS (
    SELECT cd.caller, cd.dept AS id, 0 AS depth
    FROM caller_dept cd
    UNION
    SELECT dd.caller, d.id, dd.depth + 1
    FROM dept_down dd
    JOIN department d ON d.parent_department_id = dd.id
    JOIN caller_dept cd ON cd.caller = dd.caller
    WHERE app.is_company_descendant(d.company_id, cd.company)
      AND dd.depth < 64
  ),
  -- heads_department_of's subject_dept: the subject's current assignment lies in the subtree.
  hod AS (
    SELECT a.employment_id
    FROM assignment a
    WHERE a.valid_to IS NULL AND a.superseded_at IS NULL
      AND a.department_id IS NOT NULL
      AND a.department_id IN (SELECT dd.id FROM dept_down dd)
  ),
  visible AS (
    SELECT e.id
    FROM employment e
    WHERE e.tenant_id = app.current_tenant_id()
      AND e.company_id IN (SELECT ac.company_id FROM admin_company ac)
    UNION
    -- (b) SELF arm: `e.tenant_id = app.current_tenant_id() AND u.id = app.current_user_id()`.
    SELECT e.id
    FROM employment e
    JOIN app_user u ON u.person_id = e.person_id
    WHERE e.tenant_id = app.current_tenant_id()
      AND u.id = app.current_user_id()
    UNION
    SELECT d.emp FROM down d
    UNION
    SELECT h.employment_id FROM hod h
  )
  SELECT coalesce(array_agg(v.id ORDER BY v.id), '{}'::uuid[]) FROM visible v WHERE v.id IS NOT NULL
 );
END;
$$;
--> statement-breakpoint
-- Necessary-only task discovery precheck, never an authorization grant or cached permission.
-- Historical assignments and reporting lines are deliberately included; false positives use
-- the complete existing reader. Caller validation remains at the native application boundary.
CREATE FUNCTION app.attendance_frozen_actor_identity_keys(payload jsonb,shape text) RETURNS uuid[]
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog,pg_temp AS $keys$
DECLARE result uuid[];
BEGIN
 IF shape='stages' THEN
  SELECT array_agg(DISTINCT v.id::uuid) FILTER(WHERE v.id IS NOT NULL) INTO result
  FROM jsonb_array_elements(payload)stage(value)
  CROSS JOIN LATERAL jsonb_array_elements(stage.value->'approvers')actor(value)
  CROSS JOIN LATERAL(VALUES(actor.value->>'userId'),(actor.value->>'personId'))v(id);
 ELSIF shape='actors' THEN
  SELECT array_agg(DISTINCT v.id::uuid) FILTER(WHERE v.id IS NOT NULL) INTO result
  FROM jsonb_array_elements(payload)actor(value)
  CROSS JOIN LATERAL(VALUES(actor.value->>'userId'),(actor.value->>'personId'))v(id);
 ELSIF shape='actor' THEN
  SELECT array_agg(DISTINCT v.id::uuid) FILTER(WHERE v.id IS NOT NULL) INTO result
  FROM(VALUES(payload->>'userId'),(payload->>'personId'))v(id);
 ELSE RAISE EXCEPTION 'Unknown frozen actor shape'; END IF;
 RETURN coalesce(result,'{}'::uuid[]);
END;
$keys$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.attendance_frozen_actor_identity_keys(jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_frozen_actor_identity_keys(jsonb,text) TO ai_hr_app;
--> statement-breakpoint
CREATE INDEX attendance_workflow_frozen_actor_keys_idx ON public.attendance_workflow_request
 USING gin(app.attendance_frozen_actor_identity_keys(stages,'stages')) WHERE routing_version IN(2,3,4);
--> statement-breakpoint
CREATE INDEX attendance_workflow_reassignment_actor_keys_idx ON public.attendance_workflow_reassignment
 USING gin(app.attendance_frozen_actor_identity_keys(approvers,'actors'));
--> statement-breakpoint
CREATE INDEX attendance_workflow_participant_actor_keys_idx ON public.attendance_workflow_participant_reassignment
 USING gin(app.attendance_frozen_actor_identity_keys(assigned,'actor'));
--> statement-breakpoint
-- Expression statistics prevent unknown-selectivity plans after index installation.
ANALYZE public.attendance_workflow_request;
ANALYZE public.attendance_workflow_reassignment;
ANALYZE public.attendance_workflow_participant_reassignment;
--> statement-breakpoint
CREATE FUNCTION app.may_have_attendance_task_metadata() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $possible$
DECLARE caller record;
BEGIN
 SELECT u.id,u.tenant_id,u.person_id INTO caller FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL;
 -- Unknown identity/configuration always falls through to the original authoritative reader.
 IF NOT FOUND OR caller.person_id IS NULL OR NOT app.principal_snapshot_current() THEN RETURN true; END IF;
 IF EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=caller.tenant_id AND r.app_user_id=caller.id AND r.role::text IN ('hr_admin','super_admin')) THEN RETURN true; END IF;
 -- Include historical, inactive and every line kind. False positives are deliberately harmless.
 IF EXISTS(SELECT 1 FROM public.reporting_line r JOIN public.employment e ON e.id=r.manager_employment_id AND e.tenant_id=r.tenant_id
  WHERE r.tenant_id=caller.tenant_id AND e.person_id=caller.person_id) THEN RETURN true; END IF;
 -- Materialize the candidate access path within this statement. Otherwise EXISTS/LIMIT can
 -- prefer an assumed early sequential match and scan all history when no actor is assigned.
 IF EXISTS(WITH matches AS MATERIALIZED(
  SELECT 1 FROM public.attendance_workflow_request w WHERE w.tenant_id=caller.tenant_id AND w.routing_version IN (2,3,4)
   AND app.attendance_frozen_actor_identity_keys(w.stages,'stages') && ARRAY[caller.id,caller.person_id]) SELECT 1 FROM matches) THEN RETURN true; END IF;
 IF EXISTS(WITH matches AS MATERIALIZED(
  SELECT 1 FROM public.attendance_workflow_reassignment r WHERE r.tenant_id=caller.tenant_id
   AND app.attendance_frozen_actor_identity_keys(r.approvers,'actors') && ARRAY[caller.id,caller.person_id]) SELECT 1 FROM matches) THEN RETURN true; END IF;
 IF EXISTS(WITH matches AS MATERIALIZED(
  SELECT 1 FROM public.attendance_workflow_participant_reassignment r WHERE r.tenant_id=caller.tenant_id
   AND app.attendance_frozen_actor_identity_keys(r.assigned,'actor') && ARRAY[caller.id,caller.person_id]) SELECT 1 FROM matches) THEN RETURN true; END IF;
 RETURN false;
END;
$possible$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.may_have_attendance_task_metadata() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.may_have_attendance_task_metadata() TO ai_hr_app;
