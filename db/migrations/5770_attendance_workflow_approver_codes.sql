-- Board 237c31e6 (docs/MIGRATION-ALLOCATION.md): 5697_attendance_workflow_approver_codes, idx 5097, when 1793330005397.
-- Attendance approval progress shows each approver as "Name · Employee ID" on every screen that shows the panel. The
-- approvers frozen on a request (or the route a submission would freeze) can sit in other companies of the tenant
-- (5140), so the caller's row security cannot always read their employee codes. Two request-bound readers return
-- codes only, only for identities the caller is already entitled to see, and are called once per page with the
-- page's ids (docs/SCALE-AND-RELEASE-RULES.md rule 2). They decide nothing: routing, decisions, escalation and skip
-- logic are unchanged. No table, policy, row or existing function changes; EXECUTE for ai_hr_app only.
--
-- Codes of the identities frozen on the given requests: the frozen stage approvers, HR reassignments (both sides),
-- participant reassignments (both sides) and the recorded actual decision makers. A request contributes only when
-- the caller can already read it, the same predicate as the SELECT policies of attendance_workflow_request (0533
-- employee visibility and delegation, 0548 version 2 participants, 0570/0592 attendance_workflow_v3_read): the
-- employee's own request, an administrator of its company, a manager who can see the employee, or a frozen
-- participant. Another employee's request ids and a non-participant's call return nothing.
CREATE FUNCTION app.attendance_workflow_approver_codes(p_correction_ids uuid[])
RETURNS TABLE(correction_id uuid, employment_id uuid, employee_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
 WITH visible AS (
  SELECT w.id,w.correction_id,w.tenant_id,w.stages FROM public.attendance_workflow_request w
  WHERE w.tenant_id=app.current_tenant_id() AND w.correction_id=ANY(coalesce(p_correction_ids,'{}'::uuid[]))
   AND (app.can_see_employment(w.employment_id)
    OR app.can_decide_via_delegation(w.employment_id,'attendance','attendance.correction')
    OR (w.routing_version=2 AND app.attendance_workflow_v2_read(w.correction_id))
    OR (w.routing_version IN (3,4) AND app.attendance_workflow_v3_read(w.correction_id)))
 ), named(correction_id,emp) AS (
  SELECT v.correction_id,a.actor->>'employmentId' FROM visible v
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(v.stages)='array' THEN v.stages ELSE '[]'::jsonb END) s(stage)
   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.stage->'approvers')='array' THEN s.stage->'approvers' ELSE '[]'::jsonb END) a(actor)
  UNION
  SELECT v.correction_id,x.actor->>'employmentId' FROM visible v
   JOIN public.attendance_workflow_reassignment r ON r.request_id=v.id AND r.tenant_id=v.tenant_id
   CROSS JOIN LATERAL jsonb_array_elements(
    (CASE WHEN jsonb_typeof(r.approvers)='array' THEN r.approvers ELSE '[]'::jsonb END)
    ||(CASE WHEN jsonb_typeof(r.previous_approvers)='array' THEN r.previous_approvers ELSE '[]'::jsonb END)) x(actor)
  UNION
  SELECT v.correction_id,x.actor->>'employmentId' FROM visible v
   JOIN public.attendance_workflow_participant_reassignment r ON r.request_id=v.id AND r.tenant_id=v.tenant_id
   CROSS JOIN LATERAL (VALUES (r.assigned),(r.previous_assigned)) x(actor)
  UNION
  SELECT v.correction_id,d.actual_employment_id::text FROM visible v
   JOIN public.attendance_workflow_decision d ON d.request_id=v.id AND d.tenant_id=v.tenant_id
  UNION
  SELECT v.correction_id,d.actual_employment_id::text FROM visible v
   JOIN public.attendance_workflow_participant_decision d ON d.request_id=v.id AND d.tenant_id=v.tenant_id
 ), ids AS (
  SELECT n.correction_id,CASE WHEN n.emp ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN n.emp::uuid END AS emp FROM named n
 )
 SELECT i.correction_id,e.id,e.employee_code FROM ids i
 JOIN public.employment e ON e.id=i.emp AND e.tenant_id=app.current_tenant_id()
 ORDER BY i.correction_id,e.id;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.attendance_workflow_approver_codes(uuid[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.attendance_workflow_approver_codes(uuid[]) TO ai_hr_app;

--> statement-breakpoint
-- Codes of the approvers the existing resolver produces for this subject and this saved template, for the approval
-- progress shown before Submit. Only the subject themselves, an administrator of the subject's company or a manager
-- above the subject in their own reporting line (the database half of Request On Behalf, as
-- app.attendance_workflow_on_behalf_allowed proves it; the permission key is checked by core/attendance-on-behalf.ts
-- before this is called) receives anything, and only for a current template that applies to the subject's company.
-- The route is resolved by the same functions submission uses (resolve_v4/v3/v2, or the version 1 manager); a route
-- that does not resolve returns nothing.
CREATE FUNCTION app.attendance_workflow_route_approver_codes(p_subject uuid, p_template uuid)
RETURNS TABLE(employment_id uuid, employee_code text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE subject public.employment; t public.attendance_workflow_template; caller_person uuid; resolved jsonb; manager_ids uuid[];
BEGIN
 IF p_subject IS NULL OR p_template IS NULL THEN RETURN; END IF;
 SELECT e.* INTO subject FROM public.employment e WHERE e.id=p_subject AND e.tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN RETURN; END IF;
 SELECT u.person_id INTO caller_person FROM public.app_user u
 WHERE u.id=app.current_user_id() AND u.tenant_id=subject.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF caller_person IS NULL THEN RETURN; END IF;
 IF caller_person IS DISTINCT FROM subject.person_id AND NOT (app.can_see_employment(subject.id) AND (app.is_admin_for(subject.company_id)
  OR EXISTS(SELECT 1 FROM public.employment me WHERE me.person_id=caller_person AND me.tenant_id=subject.tenant_id
   AND me.terminated_on IS NULL AND app.is_admin_report_of(subject.id,me.id)))) THEN RETURN; END IF;
 SELECT w.* INTO t FROM public.attendance_workflow_template w
 WHERE w.id=p_template AND w.tenant_id=subject.tenant_id AND w.active AND w.superseded_at IS NULL AND w.retired_at IS NULL
  AND app.attendance_workflow_applies(w.id,subject.company_id);
 IF NOT FOUND THEN RETURN; END IF;
 IF t.routing_version=4 THEN
  resolved:=app.attendance_workflow_resolve_v4(subject.id,t.stages,coalesce(t.cc,'[]'::jsonb));
  IF resolved->>'ok' IS DISTINCT FROM 'true' THEN RETURN; END IF;
  resolved:=resolved->'stages';
 ELSIF t.routing_version=3 THEN
  resolved:=app.attendance_workflow_resolve_v3(subject.id,t.stages);
  IF resolved->>'ok' IS DISTINCT FROM 'true' THEN RETURN; END IF;
  resolved:=resolved->'stages';
 ELSIF t.routing_version=2 THEN
  BEGIN
   resolved:=app.attendance_workflow_resolve_v2(subject.id,t.stages);
  EXCEPTION WHEN OTHERS THEN RETURN;
  END;
 ELSE
  -- Version 1 names the subject's one direct manager, and only when a configured level asks for one.
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.stages)='array' THEN t.stages ELSE '[]'::jsonb END) s(stage)
   CROSS JOIN LATERAL (SELECT s.stage->'level' AS lvl UNION ALL
    SELECT x.alt FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.stage->'level'->'alternates')='array' THEN s.stage->'level'->'alternates' ELSE '[]'::jsonb END) x(alt)) k
   WHERE k.lvl->>'kind'='direct_manager' OR (jsonb_typeof(k.lvl)='string' AND k.lvl#>>'{}'='direct_manager')) THEN RETURN; END IF;
  SELECT array_agg(m.employment_id) INTO manager_ids FROM app.attendance_workflow_manager(subject.id) m;
  IF coalesce(cardinality(manager_ids),0)<>1 THEN RETURN; END IF;
  resolved:=jsonb_build_array(jsonb_build_object('approvers',jsonb_build_array(jsonb_build_object('employmentId',manager_ids[1]))));
 END IF;
 IF jsonb_typeof(resolved) IS DISTINCT FROM 'array' THEN RETURN; END IF;
 RETURN QUERY
 SELECT DISTINCT e.id,e.employee_code FROM jsonb_array_elements(resolved) s(stage)
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(s.stage->'approvers')='array' THEN s.stage->'approvers' ELSE '[]'::jsonb END) a(actor)
  JOIN public.employment e ON e.tenant_id=subject.tenant_id
   AND e.id=CASE WHEN a.actor->>'employmentId' ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN (a.actor->>'employmentId')::uuid END
 ORDER BY e.id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.attendance_workflow_route_approver_codes(uuid,uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.attendance_workflow_route_approver_codes(uuid,uuid) TO ai_hr_app;
