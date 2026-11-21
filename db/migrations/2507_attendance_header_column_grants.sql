-- Keep the existing authorization predicates, function owner and EXECUTE grants.
DO $guard$
DECLARE predecessor pg_catalog.pg_proc%ROWTYPE;
BEGIN
 SELECT * INTO STRICT predecessor FROM pg_catalog.pg_proc
 WHERE oid='app.attendance_pending_visible_headers(uuid)'::regprocedure;
 IF pg_catalog.md5(predecessor.prosrc) IS DISTINCT FROM '111a7d8c0ee9f18794ea018c5225da2e'
    OR NOT predecessor.prosecdef OR predecessor.provolatile <> 's'
    OR predecessor.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
 THEN
  RAISE EXCEPTION 'Unexpected Attendance header reader predecessor' USING ERRCODE='55000';
 END IF;
END;
$guard$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.attendance_pending_visible_headers(wanted uuid)
RETURNS TABLE(id uuid, employment_id uuid, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $headers$
BEGIN
 -- The original invoker query requires only these columns. Preserve that
 -- narrow grant and refuse when any of the five privileges is revoked.
 IF EXISTS (
  SELECT 1 FROM unnest(ARRAY['id','tenant_id','employment_id','status','created_at']) AS required(column_name)
  WHERE NOT pg_catalog.has_column_privilege(
   'ai_hr_app','public.attendance_correction',required.column_name,'SELECT'
  )
 ) THEN
  RAISE EXCEPTION 'Attendance correction read privilege is unavailable' USING ERRCODE='42501';
 END IF;
 RETURN QUERY
 WITH actor AS MATERIALIZED (
  SELECT app.current_tenant_id() AS tenant_id
  WHERE app.current_user_id() IS NOT NULL AND app.principal_snapshot_current()
 ), visibility AS MATERIALIZED (
  SELECT tenant_id,app.visible_employment_ids() AS ids FROM actor
 )
 SELECT q.id,q.employment_id,q.created_at
 FROM public.attendance_correction q JOIN visibility v ON q.tenant_id=v.tenant_id
 WHERE q.status='pending' AND (wanted IS NULL OR q.id=wanted)
 AND CASE WHEN q.employment_id=ANY(v.ids) THEN true ELSE
  app.attendance_workflow_delegate_request(q.id)
  OR app.attendance_workflow_v2_read(q.id)
  OR app.attendance_workflow_v3_read(q.id)
  OR app.unrouted_attendance_delegate(q.id)
 END;
END;
$headers$;
