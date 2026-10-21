-- Read-only, request-bound review of the frozen route. No decision policy is changed.
-- Creation-time approver catalogues are not live authority (notably after login changes).
-- Only actual scoped HR can read codes of the request's saved participants; no directory API.
CREATE FUNCTION app.attendance_workflow_review_participants(p_correction uuid)
RETURNS TABLE(participant_slot text,employment_id uuid,employee_code text,kind text,eligible boolean,acting_mode text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
 w public.attendance_workflow_request; request_status text; subject_person uuid;
 actors jsonb; actor jsonb; candidate_emp uuid; candidate_person uuid; candidate_user uuid;
 candidate_slot text; candidate_kind text; candidate_code text; candidate_ok boolean;
 hr_ok boolean; any_eligible boolean:=false; has_actor boolean:=false; ordinal integer:=0;
BEGIN
 SELECT r.* INTO w FROM public.attendance_workflow_request r
 WHERE r.correction_id=p_correction AND r.tenant_id=app.current_tenant_id();
 IF NOT FOUND THEN RETURN; END IF;
 SELECT c.status::text INTO request_status FROM public.attendance_correction c WHERE c.id=w.correction_id AND c.tenant_id=w.tenant_id;
 IF request_status IS DISTINCT FROM 'pending' OR w.current_stage>=jsonb_array_length(w.stages) THEN RETURN; END IF;
 IF NOT app.is_admin_for(w.company_id) OR NOT EXISTS(
  SELECT 1 FROM public.app_user u JOIN public.role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
  WHERE u.id=app.current_user_id() AND u.tenant_id=w.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND r.role::text IN ('hr_admin','super_admin') AND (r.company_id IS NULL OR r.company_id=w.company_id OR app.is_company_descendant(w.company_id,r.company_id)))
 THEN RETURN; END IF;
 SELECT e.person_id INTO subject_person FROM public.employment e WHERE e.id=w.employment_id AND e.tenant_id=w.tenant_id;
 SELECT EXISTS(SELECT 1 FROM public.app_user u JOIN public.role_assignment r ON r.app_user_id=u.id AND r.tenant_id=u.tenant_id
  WHERE u.tenant_id=w.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND u.person_id IS DISTINCT FROM subject_person AND (w.routing_version<>3 OR u.person_id IS NOT NULL)
   AND r.role::text IN ('hr_admin','super_admin') AND (r.company_id IS NULL OR r.company_id=w.company_id OR app.is_company_descendant(w.company_id,r.company_id))
   AND (w.routing_version=1 OR NOT EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND (d.actual_user_id=u.id::text OR d.actual_person_id=u.person_id)))
   AND (w.routing_version<>3 OR NOT EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND (d.actual_user_id=u.id OR d.actual_person_id=u.person_id)))) INTO hr_ok;
 IF w.routing_version=3 THEN
  actors:=app.attendance_workflow_v3_effective(w.id,w.current_stage);
  actor:=app.attendance_workflow_v3_actor(w.id,w.current_stage,w.current_stage::text||':hr');
  IF actor IS NOT NULL THEN actors:=actors||jsonb_build_array(actor); END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.stage_index=w.current_stage) THEN RETURN; END IF;
  actors:=app.attendance_workflow_effective_approvers(w.id,w.current_stage);
 END IF;
 IF jsonb_typeof(actors) IS DISTINCT FROM 'array' THEN RETURN; END IF;
 FOR actor IN SELECT value FROM jsonb_array_elements(actors) LOOP
  candidate_kind:=actor->>'kind'; candidate_code:=NULL; candidate_emp:=NULL; candidate_person:=NULL; candidate_user:=NULL;
  candidate_slot:=coalesce(actor->>'slot',w.current_stage::text||':'||ordinal::text); ordinal:=ordinal+1;
  IF candidate_kind IS NULL OR candidate_kind NOT IN ('direct_manager','specific_employee','hr_admin') THEN CONTINUE; END IF;
  has_actor:=true;
  IF w.routing_version=3 AND NOT app.attendance_workflow_v3_outstanding(w.id,w.current_stage,candidate_slot) THEN CONTINUE; END IF;
  IF candidate_kind='hr_admin' THEN
   candidate_ok:=hr_ok;
  ELSE
   IF coalesce(actor->>'employmentId','') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN candidate_emp:=(actor->>'employmentId')::uuid; END IF;
   IF coalesce(actor->>'personId','') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN candidate_person:=(actor->>'personId')::uuid; END IF;
   IF coalesce(actor->>'userId','') ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN candidate_user:=(actor->>'userId')::uuid; END IF;
   SELECT e.employee_code INTO candidate_code FROM public.employment e WHERE e.id=candidate_emp AND e.tenant_id=w.tenant_id;
   -- Mirrors the live identity/grant preconditions of frozen v2/v3 assigned authority. The
   -- request's saved user/person are checked directly; additional live logins do not replace them.
   SELECT EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
    WHERE e.id=candidate_emp AND e.tenant_id=w.tenant_id AND e.person_id<>subject_person
     AND (w.routing_version=1 OR (e.person_id=candidate_person AND u.id=candidate_user))
     AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
     AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
     AND u.archived_at IS NULL AND NOT app.login_blocked(u.id) AND app.is_company_descendant(w.company_id,e.company_id)
     AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=u.id AND r.tenant_id=w.tenant_id AND r.role::text IN ('employee','manager','hr_admin','super_admin')
      AND (r.company_id IS NULL OR r.company_id=w.company_id OR app.is_company_descendant(w.company_id,r.company_id)))
     AND (w.routing_version=1 OR NOT EXISTS(SELECT 1 FROM public.attendance_workflow_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND (d.actual_user_id=u.id::text OR d.actual_person_id=u.person_id)))
     AND (w.routing_version<>3 OR NOT EXISTS(SELECT 1 FROM public.attendance_workflow_participant_decision d WHERE d.request_id=w.id AND d.tenant_id=w.tenant_id AND (d.actual_user_id=u.id OR d.actual_person_id=u.person_id)))
     AND (w.routing_version<>1 OR EXISTS(SELECT 1 FROM app.attendance_workflow_manager(w.employment_id) m WHERE m.employment_id=e.id))) INTO candidate_ok;
  END IF;
  any_eligible:=any_eligible OR coalesce(candidate_ok,false);
  RETURN QUERY SELECT candidate_slot,candidate_emp,candidate_code,candidate_kind,coalesce(candidate_ok,false),'assigned'::text;
 END LOOP;
 -- Legacy routes allow a reasoned scoped-HR decision on behalf; do not pretend HR was an
 -- individually frozen assignment. New v3 routes instead require their recorded HR alternative.
 IF w.routing_version IN (1,2) AND has_actor AND NOT any_eligible AND hr_ok THEN
  RETURN QUERY SELECT NULL::text,NULL::uuid,NULL::text,'hr_admin'::text,true,'administrator'::text;
 END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.attendance_workflow_review_participants(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_workflow_review_participants(uuid) TO ai_hr_app;
