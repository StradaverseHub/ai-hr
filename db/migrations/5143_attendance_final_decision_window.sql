-- Owner decision 2026-11-12 on board daa76ed4 (cross-company final approval). Draft reservation 5143 @ idx 4543 /
-- when 1793330004843 (unapplied). A legitimately assigned approver in another company of the tenant gives the final
-- approval (or an OT-bearing final rejection) themselves. Personnel visibility is NOT widened in general: the
-- visibility owner admits exactly one employment, the subject of exactly one correction, only inside a request-bound
-- read window that the database proves from this transaction's own final decision rows. Outside it nothing changes,
-- and with no effect hint installed the extra branch costs one transaction-local setting read.

-- The window. Open only when ALL hold, re-proved on every call:
--  * the request-bound effect hint (app.attendance_workflow_effect) names a v3/v4 correction of the current tenant;
--  * the live caller wrote, in this very transaction (active write; dies at commit and at a released or rolled-back
--    savepoint), the participant decision that ends the request: an approval at the final frozen level or a rejection;
--  * the request is at that level with no completion row yet (the completion row's own guards are running), or has
--    advanced past the final level by the caller's same-transaction completion row with the same outcome;
--  * the correction is still pending, or was decided by this transaction.
-- The hint is untrusted: a forged hint without those rows yields NULL. The participant rows themselves are written only
-- through the participant guard (frozen assignment, delegation or on-behalf authority). Re-entry (the participant
-- table's own read policy asks the visibility owner) is answered NULL, so the proof never recurses.
CREATE FUNCTION app.attendance_effect_window_employment() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE hint text:=current_setting('app.attendance_workflow_effect',true); caller uuid; w public.attendance_workflow_request; final_index integer; ok boolean:=false;
BEGIN
 IF coalesce(hint,'')='' OR hint !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
 IF coalesce(current_setting('app.attendance_effect_window_probe',true),'')='1' THEN RETURN NULL; END IF;
 caller:=app.current_user_id();
 IF caller IS NULL OR app.current_tenant_id() IS NULL THEN RETURN NULL; END IF;
 SELECT r.* INTO w FROM public.attendance_workflow_request r WHERE r.correction_id=hint::uuid AND r.tenant_id=app.current_tenant_id() AND r.routing_version IN (3,4);
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.app_user u WHERE u.id=caller AND u.tenant_id=w.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))
  OR NOT EXISTS(SELECT 1 FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id AND c.employment_id=w.employment_id
   AND (c.status='pending' OR app.attendance_workflow_active_write(c.xmin))) THEN RETURN NULL; END IF;
 final_index:=jsonb_array_length(w.stages)-1;
 PERFORM set_config('app.attendance_effect_window_probe','1',true);
 SELECT EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision p
  WHERE p.request_id=w.id AND p.tenant_id=w.tenant_id AND p.employment_id=w.employment_id AND p.actual_user_id=caller
   AND app.attendance_workflow_active_write(p.xmin) AND (p.decision='rejected' OR p.stage_index=final_index)
   AND ((w.current_stage=p.stage_index AND NOT EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND d.stage_index=p.stage_index))
    OR (w.current_stage=jsonb_array_length(w.stages) AND EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id
     AND d.stage_index=p.stage_index AND d.decision=p.decision AND d.actual_user_id=caller::text AND app.attendance_workflow_active_write(d.xmin))))) INTO ok;
 PERFORM set_config('app.attendance_effect_window_probe','',true);
 RETURN CASE WHEN ok THEN w.employment_id END;
END $$;
REVOKE ALL ON FUNCTION app.attendance_effect_window_employment() FROM PUBLIC,ai_hr_app;

--> statement-breakpoint
-- The decision path's setter: installs the request hint for this correction only when the window it opens is proven,
-- and otherwise leaves the previous hint exactly as it was. Returns whether the window is open.
CREATE FUNCTION app.attendance_workflow_open_final_window(correction uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE previous text:=coalesce(current_setting('app.attendance_workflow_effect',true),'');
BEGIN
 IF correction IS NULL OR (previous<>'' AND previous<>correction::text) THEN RETURN false; END IF;
 PERFORM set_config('app.attendance_workflow_effect',correction::text,true);
 IF app.attendance_effect_window_employment() IS NOT NULL THEN RETURN true; END IF;
 PERFORM set_config('app.attendance_workflow_effect',previous,true);
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION app.attendance_workflow_open_final_window(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_open_final_window(uuid) TO ai_hr_app;

--> statement-breakpoint
-- Replaces 0109: one leading branch for the proven window; every other arm is byte-for-byte the 0109 body.
CREATE OR REPLACE FUNCTION app.can_see_employment(emp_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT coalesce(coalesce(current_setting('app.attendance_workflow_effect', true), '') <> ''
      AND emp_id = app.attendance_effect_window_employment(), false)
    OR EXISTS (
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
    );
$$;

--> statement-breakpoint
-- Replaces 2105: the same set-based reader with the proven window's single subject merged into its result.
CREATE OR REPLACE FUNCTION app.visible_employment_ids()
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE possible_admin boolean;
BEGIN
 -- Normalize the exact current grant shape once for this invocation. The employment
 -- existence guard preserves the original empty-tenant course, including malformed inputs.
 SELECT EXISTS(
  SELECT 1 FROM (
   SELECT jsonb_agg(jsonb_build_object('role',g.role,'companyId',g.company_id)) AS grants
   FROM app.current_grants() g
   WHERE EXISTS(SELECT 1 FROM public.employment e WHERE e.tenant_id=app.current_tenant_id())
  ) normalized CROSS JOIN LATERAL jsonb_array_elements(normalized.grants) payload(value)
  WHERE payload.value->>'role' IN ('hr_admin','super_admin')
 ) INTO possible_admin;
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
    SELECT DISTINCT e.company_id FROM employment e WHERE e.tenant_id = app.current_tenant_id() AND possible_admin
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
  SELECT coalesce(array_agg(v.id ORDER BY v.id), '{}'::uuid[]) FROM (
   SELECT visible.id FROM visible
   UNION
   -- 5143: the one request-bound final-decision subject, only while its window is proven (NULL otherwise).
   SELECT app.attendance_effect_window_employment() WHERE coalesce(current_setting('app.attendance_workflow_effect', true), '') <> ''
  ) v WHERE v.id IS NOT NULL
 );
END;
$$;
