-- Avoid full named-actor validation for a caller who cannot match that actor or a recipient.
-- Existing principal, live actor, dates, roles, scope and request-grained delegation proofs remain.
CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_assigned_allowed(wanted_request uuid,wanted_stage integer,wanted_slot text,acting text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE w public.attendance_workflow_request; caller public.app_user; actor jsonb; subject_person uuid;
BEGIN
 SELECT r.* INTO w FROM public.attendance_workflow_request r WHERE r.id=wanted_request AND r.tenant_id=app.current_tenant_id() AND r.routing_version IN (3,4);
 IF NOT FOUND OR NOT app.principal_snapshot_current() THEN RETURN false; END IF;
 SELECT u.* INTO caller FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=w.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id);
 IF NOT FOUND OR caller.person_id IS NULL THEN RETURN false; END IF;
 SELECT e.person_id INTO subject_person FROM public.employment e WHERE e.id=w.employment_id AND e.tenant_id=w.tenant_id;
 IF caller.person_id=subject_person THEN RETURN false; END IF;
 actor:=app.attendance_workflow_v3_actor(w.id,wanted_stage,wanted_slot);
 IF actor IS NULL THEN RETURN false; END IF;
 IF actor->>'kind'='hr_admin' THEN
  RETURN acting='assigned' AND app.is_admin_for(w.company_id) AND EXISTS(SELECT 1 FROM public.role_assignment r
   WHERE r.app_user_id=caller.id AND r.tenant_id=w.tenant_id AND r.role::text IN ('hr_admin','super_admin')
    AND (r.company_id IS NULL OR r.company_id=w.company_id OR app.is_company_descendant(w.company_id,r.company_id)));
 END IF;
 IF actor->>'kind' NOT IN ('direct_manager','specific_employee') OR acting NOT IN ('assigned','delegate') THEN RETURN false; END IF;

 -- Necessary false-only gates. Every positive decision still passes the complete live proof below.
 IF acting='assigned' AND (caller.id<>(actor->>'userId')::uuid OR caller.person_id<>(actor->>'personId')::uuid) THEN RETURN false; END IF;
 IF acting='delegate' AND NOT EXISTS(SELECT 1 FROM public.reporting_line d JOIN public.employment recipient ON recipient.id=d.manager_employment_id AND recipient.tenant_id=d.tenant_id
  WHERE d.tenant_id=w.tenant_id AND d.subordinate_employment_id=(actor->>'employmentId')::uuid AND recipient.person_id=caller.person_id) THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.employment e JOIN public.app_user u ON u.person_id=e.person_id AND u.tenant_id=e.tenant_id
  WHERE e.id=(actor->>'employmentId')::uuid AND e.person_id=(actor->>'personId')::uuid AND e.tenant_id=w.tenant_id
   AND u.id=(actor->>'userId')::uuid AND u.archived_at IS NULL AND NOT app.login_blocked(u.id)
   AND e.person_id<>subject_person AND e.blacklisted_at IS NULL AND e.hired_on<=(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date
   AND (e.terminated_on IS NULL OR e.terminated_on>(now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date)
   AND app.is_company_descendant(w.company_id,e.company_id)
   AND EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.app_user_id=u.id AND r.tenant_id=w.tenant_id
    AND r.role::text IN ('employee','manager','hr_admin','super_admin')
    AND (r.company_id IS NULL OR r.company_id=w.company_id OR app.is_company_descendant(w.company_id,r.company_id)))) THEN RETURN false; END IF;
 IF acting='assigned' THEN RETURN caller.id=(actor->>'userId')::uuid AND caller.person_id=(actor->>'personId')::uuid; END IF;
 RETURN app.can_decide_via_delegation_from((actor->>'employmentId')::uuid,w.employment_id,'attendance','attendance.correction');
END $$;
