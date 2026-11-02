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
DECLARE caller public.app_user;
BEGIN
 SELECT u.* INTO caller FROM public.app_user u WHERE u.id=app.current_user_id() AND u.tenant_id=app.current_tenant_id() AND u.archived_at IS NULL;
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
