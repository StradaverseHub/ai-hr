-- Necessary-only task precheck refinement; every positive retains the complete reader.
-- Preserve owner/ACL/security attributes and the original immutable actor-key indexes.
CREATE OR REPLACE FUNCTION app.may_have_attendance_task_metadata() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $possible$
DECLARE caller public.app_user;
BEGIN
 SELECT u.* INTO caller FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL;
 -- Unknown identity/configuration always falls through to the original authoritative reader.
 IF NOT FOUND OR caller.person_id IS NULL OR NOT app.principal_snapshot_current() THEN RETURN true; END IF;
 IF EXISTS(SELECT 1 FROM public.role_assignment r WHERE r.tenant_id=caller.tenant_id AND r.app_user_id=caller.id AND r.role::text IN ('hr_admin','super_admin')) THEN RETURN true; END IF;
 -- Historical delegate recipients always remain possible. Administrative managers need
 -- the legacy fallback while any pending unversioned request exists; frozen actor keys
 -- below retain versioned assignments after reporting-line changes.
 IF EXISTS(SELECT 1 FROM public.reporting_line r JOIN public.employment e ON e.id=r.manager_employment_id AND e.tenant_id=r.tenant_id
  WHERE r.tenant_id=caller.tenant_id AND e.person_id=caller.person_id
 AND (
  r.line_type='delegate' OR (
   r.line_type='administrative' AND EXISTS(
    SELECT 1 FROM public.attendance_correction c
    WHERE c.tenant_id=caller.tenant_id AND c.status='pending'
    AND NOT EXISTS(
     SELECT 1 FROM public.attendance_workflow_request w
     WHERE w.correction_id=c.id AND w.tenant_id=c.tenant_id AND w.routing_version IN(2,3,4)
    )
   )
  )
 )
) THEN RETURN true; END IF;
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
