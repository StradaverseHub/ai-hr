-- Unallocated read-only migration draft. Rehearse this file as the restricted runtime owner.
-- Preserve the established API, grants and live company, Workforce and approver authorization.
DO $guard$
DECLARE
 existing pg_catalog.pg_proc%ROWTYPE;
 dependency record;
BEGIN
 SELECT * INTO STRICT existing FROM pg_catalog.pg_proc
 WHERE oid='app.attendance_workflow_v3_approver_options(uuid[])'::regprocedure;
 IF md5(existing.prosrc) <> 'db08941be2cb88ad411f77e2e89b0cd6'
  OR existing.proowner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
  OR existing.prolang <> (SELECT oid FROM pg_catalog.pg_language WHERE lanname='sql')
  OR existing.provolatile <> 's' OR NOT existing.prosecdef OR NOT existing.proretset
  OR existing.proargnames IS DISTINCT FROM ARRAY['wanted_companies','id','name','employee_code']::text[]
  OR pg_catalog.pg_get_function_result(existing.oid) <> 'TABLE(id uuid, name text, employee_code text)'
  OR existing.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, app','row_security=on']::text[]
 THEN
  RAISE EXCEPTION 'Unexpected Attendance approver reader contract' USING ERRCODE='55000';
 END IF;
 FOR dependency IN SELECT * FROM (VALUES
  ('app.attendance_selected_approver_eligible(uuid,uuid)','1e59af65efaf32491df7a36f443e3f6c'),
  ('app.access_workforce_employment(uuid,text)','dcdb6797287dc5c3339ffab3873fd892'),
  ('app.access_workforce_permitted_companies(text)','6eb803690169338c1a8480d4c488d6c1'),
  ('app.access_workforce_employment_permitted(uuid,uuid,timestamptz,uuid,uuid[])','4dcea99560326ecaba91f1f7942d402c'),
  ('app.import_marker_released(uuid)','e494ebf66f1e0e7e031738300e39166d')
 ) AS expected(signature,body_md5) LOOP
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid=pg_catalog.to_regprocedure(dependency.signature))
     IS DISTINCT FROM dependency.body_md5 THEN
   RAISE EXCEPTION 'Unexpected Attendance approver reader dependency: %',dependency.signature USING ERRCODE='55000';
  END IF;
 END LOOP;
END;
$guard$;

--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.attendance_workflow_v3_approver_options(wanted_companies uuid[])
RETURNS TABLE(id uuid,name text,employee_code text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app SET row_security=on AS $$
 WITH request AS MATERIALIZED (
  SELECT DISTINCT company_id FROM unnest(wanted_companies) AS wanted(company_id)
 ), valid_scope AS MATERIALIZED (
  SELECT first_company.company_id
  FROM request first_company
  WHERE app.principal_snapshot_current()
   AND NOT EXISTS (
    SELECT 1
    FROM request r
    LEFT JOIN public.company c ON c.id=r.company_id AND c.tenant_id=app.current_tenant_id()
    WHERE c.id IS NULL OR NOT app.is_admin_for(c.id)
   )
  ORDER BY first_company.company_id
  LIMIT 1
 )
 SELECT e.id,p.full_name,e.employee_code FROM valid_scope s
 JOIN public.employment e ON e.tenant_id=app.current_tenant_id()
 JOIN public.person p ON p.id=e.person_id AND p.tenant_id=e.tenant_id
 WHERE app.access_workforce_employment_permitted(
   e.tenant_id,e.company_id,e.voided_at,e.import_pending_attempt_id,
   (SELECT app.access_workforce_permitted_companies('workforce.view'))
  )
  AND app.attendance_selected_approver_eligible(s.company_id,e.id)
 ORDER BY p.full_name,e.employee_code,e.id
$$;
