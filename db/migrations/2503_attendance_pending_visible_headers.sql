-- Compare the real policy predicates with PostgreSQL's canonical rendering
-- of their reviewed equivalents before installing the new read path.
CREATE TEMP TABLE attendance_header_policy_reference (
 tenant_id uuid, employment_id uuid, id uuid
) ON COMMIT DROP;
CREATE POLICY attendance_correction_rls ON attendance_header_policy_reference FOR ALL
 USING (tenant_id=app.current_tenant_id() AND employment_id=ANY((SELECT app.visible_employment_ids())::uuid[]));
CREATE POLICY attendance_workflow_delegate_read ON attendance_header_policy_reference FOR SELECT
 USING (tenant_id=app.current_tenant_id() AND app.attendance_workflow_delegate_request(id));
CREATE POLICY attendance_workflow_v2_correction_read ON attendance_header_policy_reference FOR SELECT
 USING (tenant_id=app.current_tenant_id() AND app.attendance_workflow_v2_read(id));
CREATE POLICY attendance_workflow_v3_correction_read ON attendance_header_policy_reference FOR SELECT
 USING (tenant_id=app.current_tenant_id() AND app.attendance_workflow_v3_read(id));
CREATE POLICY attendance_unrouted_delegate_read ON attendance_header_policy_reference FOR SELECT TO ai_hr_app
 USING (tenant_id=app.current_tenant_id() AND app.unrouted_attendance_delegate(id));

DO $verify$
DECLARE target record; policy_drift jsonb;
BEGIN
 SELECT c.relrowsecurity, c.relforcerowsecurity, pg_catalog.pg_get_userbyid(c.relowner) AS owner
 INTO STRICT target FROM pg_catalog.pg_class c WHERE c.oid='public.attendance_correction'::regclass;
 IF NOT target.relrowsecurity OR target.relforcerowsecurity OR target.owner<>current_user THEN
  RAISE EXCEPTION 'Unexpected Attendance correction table ownership or RLS mode'
   USING ERRCODE='55000', DETAIL=format('Owner %s, migration role %s, RLS %s, forced RLS %s',
    target.owner,current_user,target.relrowsecurity,target.relforcerowsecurity);
 END IF;
 SELECT jsonb_agg(to_jsonb(difference)) INTO policy_drift FROM (
  WITH actual AS (
   SELECT polname,polcmd,polpermissive,polroles,pg_catalog.pg_get_expr(polqual,polrelid) AS predicate
   FROM pg_catalog.pg_policy WHERE polrelid='public.attendance_correction'::regclass AND polcmd IN ('r','*')
  ), expected AS (
   SELECT polname,polcmd,polpermissive,polroles,pg_catalog.pg_get_expr(polqual,polrelid) AS predicate
   FROM pg_catalog.pg_policy WHERE polrelid='pg_temp.attendance_header_policy_reference'::regclass
  )
  (SELECT * FROM actual EXCEPT ALL SELECT * FROM expected)
  UNION ALL
  (SELECT * FROM expected EXCEPT ALL SELECT * FROM actual)
) difference;
 IF policy_drift IS NOT NULL THEN
  RAISE EXCEPTION 'Attendance correction read policies differ from the reviewed source'
   USING ERRCODE='55000', DETAIL=policy_drift::text;
 END IF;
END;
$verify$;

DROP TABLE pg_temp.attendance_header_policy_reference;

CREATE FUNCTION app.attendance_pending_visible_headers(wanted uuid)
RETURNS TABLE(id uuid, employment_id uuid, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $headers$
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
 END
$headers$;
REVOKE ALL ON FUNCTION app.attendance_pending_visible_headers(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.attendance_pending_visible_headers(uuid) TO ai_hr_app;
