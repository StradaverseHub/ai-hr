-- Board 8cff7fef: protect issued payroll before an employment-history correction, including former employers.
CREATE OR REPLACE FUNCTION app.payroll_input_lock_keys(p_employments uuid[], p_person uuid DEFAULT NULL)
RETURNS SETOF text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO pg_catalog,public,pg_temp AS $$
DECLARE t uuid:=app.current_tenant_id();
BEGIN
 IF t IS NULL THEN RAISE EXCEPTION 'Payroll inputs unavailable' USING ERRCODE='42501'; END IF;
 RETURN QUERY
 WITH subjects AS MATERIALIZED (
  SELECT e.id,e.company_id FROM public.employment e WHERE e.tenant_id=t
   AND (e.id=ANY(coalesce(p_employments,'{}'::uuid[])) OR (p_person IS NOT NULL AND e.person_id=p_person))
 ), companies AS (
  SELECT s.company_id FROM subjects s
  UNION SELECT a.company_id FROM public.assignment a JOIN subjects s ON s.id=a.employment_id
   WHERE a.tenant_id=t AND a.company_id IS NOT NULL AND a.superseded_at IS NULL
  UNION SELECT b.company_id FROM public.payslip p JOIN subjects s ON s.id=p.employment_id
   JOIN public.payroll_batch b ON b.id=p.batch_id AND b.tenant_id=t WHERE p.tenant_id=t
 ) SELECT 'payroll-inputs:'||t::text||':'||c.company_id::text FROM companies c ORDER BY 1;
END $$;
--> statement-breakpoint
-- Delete is independently delegable. Existing System Administrators retain recovery access;
-- HR maintenance alone does not acquire this permission. Future defaults use the live catalogue.
INSERT INTO public.access_capability(id,scope,supported,bindings) VALUES
 ('workforce.movement.delete','company',true,
 '[{"owner":"core/movement.ts:reverseMovementEvent","operation":"delete"},{"owner":"core/movement.ts:reverseMovementForImportTx","operation":"import-delete-revert"},{"owner":"app/admin/personnel/[employmentId]/movement-history-actions.tsx","operation":"delete-affordance"}]');
--> statement-breakpoint
INSERT INTO public.access_group_grant(tenant_id,group_id,capability_id)
 SELECT g.tenant_id,g.id,'workforce.movement.delete' FROM public.access_group g
 WHERE g.legacy_key='system_administrator' AND g.retired_at IS NULL;
--> statement-breakpoint
CREATE FUNCTION app.access_movement_delete_employment(wanted uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO pg_catalog,public,pg_temp AS $$
 SELECT app.access_workforce_employment(wanted,'workforce.maintain') AND EXISTS(
  SELECT 1 FROM public.employment e WHERE e.id=wanted AND e.tenant_id=app.current_tenant_id()
   AND app.access_capability_allowed('workforce.movement.delete',e.company_id)
 );
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.access_movement_delete_employment(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.access_movement_delete_employment(uuid) TO ai_hr_app;
