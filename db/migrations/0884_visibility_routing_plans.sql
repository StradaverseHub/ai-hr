-- Development reservation only. Same live predicates; cache query plans, never permission results.
-- Security definer, volatility and search paths preserved; CREATE OR REPLACE preserves owner/ACLs.

CREATE OR REPLACE FUNCTION app.can_see_employment(emp_id uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $routing_plan$
BEGIN
 RETURN (
SELECT EXISTS (
      SELECT 1 FROM employment e
      WHERE e.id = emp_id AND e.tenant_id = app.current_tenant_id() AND app.is_admin_for(e.company_id)
    )
    OR EXISTS (
      SELECT 1 FROM employment e JOIN app_user u ON u.person_id = e.person_id
      WHERE e.id = emp_id AND e.tenant_id = app.current_tenant_id() AND u.id = app.current_user_id()
    )
    OR EXISTS (
      -- Recursive administrative-manager branch (direct + indirect reports), over all caller employments.
      SELECT 1 FROM employment me
        JOIN app_user u ON u.person_id = me.person_id
      WHERE u.id = app.current_user_id()
        AND me.tenant_id = app.current_tenant_id()
        AND me.terminated_on IS NULL
        AND app.is_admin_report_of(emp_id, me.id)
    )
    OR EXISTS (
      -- HOD department-tree branch, over all caller employments.
      SELECT 1 FROM employment me
        JOIN app_user u ON u.person_id = me.person_id
      WHERE u.id = app.current_user_id()
        AND me.tenant_id = app.current_tenant_id()
        AND me.terminated_on IS NULL
        AND app.heads_department_of(emp_id, me.id)
    )
 );
END;
$routing_plan$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.is_admin_report_of(subject_emp uuid, manager_emp uuid)
  RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $routing_plan$
BEGIN
 RETURN (
WITH RECURSIVE mgr AS (
    SELECT company_id AS root_company FROM employment WHERE id = manager_emp
  ),
  down AS (
    -- Seed: direct reports of the manager (depth 1).
    SELECT rl.subordinate_employment_id AS emp, 1 AS depth
    FROM reporting_line rl
    JOIN employment sub ON sub.id = rl.subordinate_employment_id
    JOIN mgr ON true
    WHERE rl.manager_employment_id = manager_emp
      AND rl.line_type = 'administrative'
      AND rl.superseded_at IS NULL
      AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      AND sub.terminated_on IS NULL
      AND app.is_company_descendant(sub.company_id, mgr.root_company)
    UNION
    -- Recurse: reports of any reachable (non-terminated) intermediate manager.
    SELECT rl.subordinate_employment_id, d.depth + 1
    FROM reporting_line rl
    JOIN employment mid ON mid.id = rl.manager_employment_id
    JOIN employment sub ON sub.id = rl.subordinate_employment_id
    JOIN down d ON d.emp = rl.manager_employment_id
    JOIN mgr ON true
    WHERE rl.line_type = 'administrative'
      AND rl.superseded_at IS NULL
      AND rl.valid_from <= current_date AND (rl.valid_to IS NULL OR rl.valid_to > current_date)
      AND mid.terminated_on IS NULL
      AND sub.terminated_on IS NULL
      AND d.depth < 64
      AND app.is_company_descendant(sub.company_id, mgr.root_company)
  )
  SELECT EXISTS (SELECT 1 FROM down WHERE emp = subject_emp)
 );
END;
$routing_plan$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.can_decide_via_delegation_from(p_delegator uuid,subject_emp uuid,p_module text,p_task_type text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $routing_plan$
BEGIN
 RETURN (
SELECT EXISTS(SELECT 1 FROM public.reporting_line d WHERE d.subordinate_employment_id=p_delegator AND d.tenant_id=app.current_tenant_id()
  AND EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id WHERE e.id=d.manager_employment_id AND e.tenant_id=d.tenant_id AND u.id=app.current_user_id() AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
  AND app.delegation_line_covers(d.id,subject_emp,p_module,p_task_type))
 );
END;
$routing_plan$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_effective(wanted_request uuid,wanted_stage integer) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $routing_plan$
BEGIN
 RETURN (
SELECT coalesce(jsonb_agg(coalesce((SELECT r.assigned FROM public.attendance_workflow_participant_reassignment r
  WHERE r.tenant_id=w.tenant_id AND r.request_id=w.id AND r.stage_index=wanted_stage AND r.participant_slot=a.actor->>'slot'
  ORDER BY r.occurred_at DESC,r.id DESC LIMIT 1),a.actor) ORDER BY a.ordinality),'[]')
 FROM public.attendance_workflow_request w
 CROSS JOIN LATERAL jsonb_array_elements(w.stages->wanted_stage->'approvers') WITH ORDINALITY a(actor,ordinality)
 WHERE w.id=wanted_request AND w.tenant_id=app.current_tenant_id() AND w.routing_version IN (3,4)
 );
END;
$routing_plan$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_actor(wanted_request uuid,wanted_stage integer,wanted_slot text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $routing_plan$
BEGIN
 RETURN (
SELECT CASE WHEN wanted_slot=wanted_stage::text||':hr' AND w.stages->wanted_stage->>'hrAlternative'='true'
  AND ((w.routing_version=3 AND w.stages->wanted_stage->'source'->>'kind'='direct_manager') OR (w.routing_version=4 AND jsonb_array_length(w.stages->wanted_stage->'sources')=1 AND w.stages->wanted_stage->'sources'->0->>'kind'='direct_manager'))
  THEN jsonb_build_object('slot',wanted_slot,'kind','hr_admin','employmentId',NULL,'name','HR administrators')
  ELSE (SELECT a FROM jsonb_array_elements(app.attendance_workflow_v3_effective(w.id,wanted_stage)) a WHERE a->>'slot'=wanted_slot) END
 FROM public.attendance_workflow_request w WHERE w.id=wanted_request AND w.tenant_id=app.current_tenant_id()
  AND w.routing_version IN (3,4) AND wanted_stage BETWEEN 0 AND jsonb_array_length(w.stages)-1
 );
END;
$routing_plan$;
